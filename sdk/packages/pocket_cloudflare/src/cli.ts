import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createR2Client, type R2Client } from "./client.ts";
import {
  inspectLocalCloudflareEnvironment,
  removeWorkspaceCloudflareProfile,
  resolveLocalCloudflareCredentials,
  upsertWorkspaceCloudflareProfile,
} from "./local_config.ts";
import {
  deployWebToCloudflarePages,
  deployWebToCloudflareWorkersAssets,
  deployWebToR2Site,
} from "./pages.ts";
import {
  publishNativeInstallersToCloudflare,
  publishToCloudflareMatrix,
} from "./publisher.ts";
import {
  buildPlatformEndpointsDocument,
  normalizeCloudflarePlatforms,
  resolveCloudflareTarget,
  type CloudflareConcretePlatform,
  type EditorProjectCloudflareConfig,
  type NativeInstallerInput,
  type ResolvedCloudflareTarget,
} from "./types.ts";

const BOOLEAN_FLAGS = new Set([
  "dry-run",
  "allow-insecure-http",
  "json",
  "no-purge",
  "set-default",
]);

function usage(): never {
  throw new Error(
    [
      "usage:",
      "  bun packages/pocket_cloudflare/src/cli.ts inspect [--workspace-keys-dir DIR] [--json]",
      "  bun packages/pocket_cloudflare/src/cli.ts auth-set --workspace-keys-dir DIR --profile PROFILE --account-id HEX32 --access-key-id AK --secret-access-key SK [--api-token TOKEN] [--label NAME] [--set-default]",
      "  bun packages/pocket_cloudflare/src/cli.ts auth-remove --workspace-keys-dir DIR --profile PROFILE",
      "  bun packages/pocket_cloudflare/src/cli.ts check [--project DIR] [--profile PROFILE] [--account-id HEX32] [--bucket BUCKET] [--prefix PREFIX] [--public-base-url URL]",
      "  bun packages/pocket_cloudflare/src/cli.ts publish (--deploy-root DIR | --dir DIR) [--project DIR] [--profile PROFILE] [--account-id HEX32] [--bucket BUCKET] [--platforms ios,android,*] [--public-base-url URL] [--zone-id HEX32] [--slot test|stable] [--write-endpoints FILE] [--no-purge] [--dry-run]",
      "  bun packages/pocket_cloudflare/src/cli.ts publish-installers --project DIR --app-id ID --installers platform:version:build:path[,...] [--channel stable|test] [--signing-key FILE] [--dry-run]",
      "  bun packages/pocket_cloudflare/src/cli.ts deploy-web --web-dir DIR [--mode pages|workers-assets|r2-site] [--project DIR] [--profile PROFILE] [--account-id HEX32] [--pages-project NAME | --worker-script NAME | --bucket BUCKET] [--dry-run]",
      "  bun packages/pocket_cloudflare/src/cli.ts endpoints --project DIR --app-id ID --host-version VER [--slot stable|test] [--out FILE]",
    ].join("\n"),
  );
}

function parseCliArgs(argv: string[]): {
  command: string;
  flags: Map<string, string>;
  booleans: Set<string>;
} {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) {
    usage();
  }
  const command = args[0] && !args[0].startsWith("--") ? args.shift()! : "inspect";
  const flags = new Map<string, string>();
  const booleans = new Set<string>();

  while (args.length > 0) {
    const arg = args.shift()!;
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const eqIndex = arg.indexOf("=");
    if (eqIndex >= 0) {
      const k = arg.slice(2, eqIndex);
      const v = arg.slice(eqIndex + 1);
      if (v === "" && BOOLEAN_FLAGS.has(k)) {
        booleans.add(k);
      } else {
        flags.set(k, v);
      }
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      booleans.add(name);
    } else {
      const val = args.shift();
      if (val === undefined || val.startsWith("--")) {
        throw new Error(`Missing value for --${name}`);
      }
      flags.set(name, val);
    }
  }

  return { command, flags, booleans };
}

function readProjectCloudflareConfig(
  projectDir: string,
): EditorProjectCloudflareConfig | undefined {
  const root = resolve(projectDir);
  for (const filename of ["pocket.json", "editor.json"]) {
    const p = join(root, filename);
    if (!existsSync(p)) continue;
    const doc = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    if (doc.cloudflare && typeof doc.cloudflare === "object") {
      return doc.cloudflare as EditorProjectCloudflareConfig;
    }
  }
  return undefined;
}

function buildClientsFromFlagsOrProject(
  flags: Map<string, string>,
  booleans: Set<string>,
  options: { dryRun: boolean; workspaceKeysDir?: string },
): R2Client[] {
  const allowInsecure = booleans.has("allow-insecure-http");
  const projectDir = flags.get("project");
  const projectCfg = projectDir ? readProjectCloudflareConfig(projectDir) : undefined;

  if (projectCfg && Array.isArray(projectCfg.targets) && projectCfg.targets.length > 0) {
    return projectCfg.targets.map((route) => {
      const credResolved = options.dryRun
        ? (() => {
            try {
              return resolveLocalCloudflareCredentials(
                { profileId: route.profileId, accountId: route.accountId },
                { workspaceKeysDir: options.workspaceKeysDir },
              );
            } catch {
              return {
                profileId: route.profileId,
                credentials: {
                  accountId: route.accountId ?? "0".repeat(32),
                  accessKeyId: "DRY_RUN_AK",
                  secretAccessKey: "DRY_RUN_SK",
                },
              };
            }
          })()
        : resolveLocalCloudflareCredentials(
            { profileId: route.profileId, accountId: route.accountId },
            { workspaceKeysDir: options.workspaceKeysDir },
          );

      const target = resolveCloudflareTarget({
        profileId: route.profileId,
        accountId: route.accountId ?? credResolved.credentials.accountId,
        bucket: route.bucket,
        endpoint: route.endpoint,
        keyPrefix: route.keyPrefix,
        publicBaseUrl: route.publicBaseUrl,
        platforms: route.platforms,
        role: route.role,
        zoneId: route.zoneId,
        pagesProjectName: route.pagesProjectName,
        workerScriptName: route.workerScriptName,
        allowInsecureHttpForTesting:
          route.allowInsecureHttpForTesting ?? allowInsecure,
      });
      return createR2Client({ target, credentials: credResolved.credentials });
    });
  }

  const profileId = flags.get("profile");
  const flagAccountId = flags.get("account-id");
  const bucket = flags.get("bucket") ?? process.env.POCKET_CF_BUCKET ?? process.env.R2_BUCKET;
  if (!bucket) {
    throw new Error(
      "Either --project (with cloudflare.targets in pocket.json) or --bucket is required",
    );
  }

  const credResolved = options.dryRun
    ? (() => {
        try {
          return resolveLocalCloudflareCredentials(
            { profileId, accountId: flagAccountId },
            { workspaceKeysDir: options.workspaceKeysDir },
          );
        } catch {
          return {
            profileId: profileId ?? "default",
            credentials: {
              accountId: flagAccountId ?? "0".repeat(32),
              accessKeyId: "DRY_RUN_AK",
              secretAccessKey: "DRY_RUN_SK",
            },
          };
        }
      })()
    : resolveLocalCloudflareCredentials(
        { profileId, accountId: flagAccountId },
        { workspaceKeysDir: options.workspaceKeysDir },
      );

  const platforms = flags.has("platforms")
    ? normalizeCloudflarePlatforms(flags.get("platforms"))
    : (["*"] as const);

  const target: ResolvedCloudflareTarget = resolveCloudflareTarget({
    profileId: credResolved.profileId,
    accountId: flagAccountId ?? credResolved.credentials.accountId,
    bucket,
    endpoint: flags.get("endpoint"),
    keyPrefix: flags.get("prefix"),
    publicBaseUrl: flags.get("public-base-url"),
    platforms,
    role: (flags.get("role") as "primary" | "fallback" | undefined) ?? "primary",
    zoneId: flags.get("zone-id"),
    allowInsecureHttpForTesting: allowInsecure,
  });

  return [createR2Client({ target, credentials: credResolved.credentials })];
}

export async function runCloudflareCli(
  argv: string[] = process.argv.slice(2),
): Promise<unknown> {
  const { command, flags, booleans } = parseCliArgs(argv);
  const workspaceKeysDir = flags.get("workspace-keys-dir");

  if (command === "inspect") {
    return inspectLocalCloudflareEnvironment({
      ...(workspaceKeysDir ? { workspaceKeysDir } : {}),
    });
  }

  if (command === "auth-set") {
    if (!workspaceKeysDir) {
      throw new Error("auth-set requires --workspace-keys-dir");
    }
    const profileId = flags.get("profile");
    const accountId = flags.get("account-id");
    const accessKeyId = flags.get("access-key-id");
    const secretAccessKey = flags.get("secret-access-key");
    if (!profileId || !accountId || !accessKeyId || !secretAccessKey) {
      throw new Error(
        "auth-set requires --profile, --account-id, --access-key-id, and --secret-access-key",
      );
    }
    return upsertWorkspaceCloudflareProfile(workspaceKeysDir, {
      profileId,
      accountId,
      accessKeyId,
      secretAccessKey,
      sessionToken: flags.get("session-token"),
      apiToken: flags.get("api-token"),
      label: flags.get("label"),
      setDefault: booleans.has("set-default"),
    });
  }

  if (command === "auth-remove") {
    if (!workspaceKeysDir) {
      throw new Error("auth-remove requires --workspace-keys-dir");
    }
    const profileId = flags.get("profile");
    if (!profileId) {
      throw new Error("auth-remove requires --profile");
    }
    const removed = removeWorkspaceCloudflareProfile(workspaceKeysDir, profileId);
    return { ok: true, profileId, removed };
  }

  if (command === "check") {
    const clients = buildClientsFromFlagsOrProject(flags, booleans, {
      dryRun: false,
      workspaceKeysDir,
    });
    const checks = await Promise.all(
      clients.map(async (client) => {
        const access = await client.checkAccess();
        return {
          ok: access.ok,
          status: access.status,
          profileId: client.target.profileId,
          accountId: client.target.accountId,
          bucket: client.target.bucket,
          platforms: client.target.platforms,
          role: client.target.role,
          publicBaseUrl: client.target.publicBaseUrl,
        };
      }),
    );
    return { ok: true, targets: checks };
  }

  if (command === "publish") {
    const deployRoot = flags.get("deploy-root");
    const packageDir = flags.get("dir");
    if (!deployRoot && !packageDir) {
      throw new Error("publish requires either --deploy-root or --dir");
    }
    const dryRun = booleans.has("dry-run");
    const clients = buildClientsFromFlagsOrProject(flags, booleans, {
      dryRun,
      workspaceKeysDir,
    });

    if (!dryRun) {
      await Promise.all(clients.map((c) => c.checkAccess()));
    }

    const keyFile = flags.get("key-file") ?? flags.get("public-key-file");
    const publicKey = keyFile ? readFileSync(resolve(keyFile), "utf8") : undefined;
    const slotRaw = flags.get("slot");
    if (slotRaw && slotRaw !== "test" && slotRaw !== "stable") {
      throw new Error("--slot must be test or stable");
    }
    const filterPlatforms = flags.has("filter-platforms")
      ? (normalizeCloudflarePlatforms(flags.get("filter-platforms")).filter(
          (p) => p !== "*",
        ) as CloudflareConcretePlatform[])
      : undefined;

    return await publishToCloudflareMatrix({
      clients,
      deployRoot,
      packageDir,
      slot: slotRaw as "test" | "stable" | undefined,
      appId: flags.get("app-id"),
      hostVersion: flags.get("host-version"),
      publicKey,
      filterPlatforms,
      purgeCache: !booleans.has("no-purge"),
      writeEndpointsPath: flags.get("write-endpoints"),
      dryRun,
    });
  }

  if (command === "publish-installers") {
    const appId = flags.get("app-id");
    const rawSpecs = flags.get("installers");
    if (!appId || !rawSpecs) {
      throw new Error("publish-installers requires --app-id and --installers");
    }
    const dryRun = booleans.has("dry-run");
    const clients = buildClientsFromFlagsOrProject(flags, booleans, {
      dryRun,
      workspaceKeysDir,
    });
    const installers: NativeInstallerInput[] = rawSpecs.split(",").map((spec) => {
      const parts = spec.trim().split(":");
      if (parts.length < 4) {
        throw new Error(
          `Invalid installer spec "${spec}" (expected platform:version:build:filePath)`,
        );
      }
      const [platformRaw, version, buildStr, ...pathParts] = parts;
      const platforms = normalizeCloudflarePlatforms(platformRaw);
      if (platforms.length !== 1 || platforms[0] === "*") {
        throw new Error(`Invalid concrete platform in installer spec "${spec}"`);
      }
      return {
        platform: platforms[0] as CloudflareConcretePlatform,
        version: version!,
        build: Number(buildStr),
        filePath: pathParts.join(":"),
      };
    });

    const channel = (flags.get("channel") as "test" | "stable" | undefined) ?? "stable";
    return await publishNativeInstallersToCloudflare({
      clients,
      appId,
      channel,
      installers,
      signingKeyFile: flags.get("signing-key"),
      purgeCache: !booleans.has("no-purge"),
      dryRun,
    });
  }

  if (command === "deploy-web") {
    const webDir = flags.get("web-dir");
    if (!webDir) {
      throw new Error("deploy-web requires --web-dir");
    }
    const mode =
      (flags.get("mode") as "pages" | "workers-assets" | "r2-site" | undefined) ??
      (flags.has("worker-script")
        ? "workers-assets"
        : flags.has("pages-project")
          ? "pages"
          : "r2-site");
    const dryRun = booleans.has("dry-run");

    if (mode === "r2-site") {
      const clients = buildClientsFromFlagsOrProject(flags, booleans, {
        dryRun,
        workspaceKeysDir,
      });
      const webClient =
        clients.find((c) => c.target.platforms.includes("web")) ??
        clients.find((c) => c.target.platforms.includes("*")) ??
        clients[0]!;
      return await deployWebToR2Site({
        client: webClient,
        webDir,
        routePrefix: flags.get("route-prefix") ?? "web",
        purgeCache: !booleans.has("no-purge"),
        dryRun,
      });
    }

    const credResolved = dryRun
      ? (() => {
          try {
            return resolveLocalCloudflareCredentials(
              {
                profileId: flags.get("profile"),
                accountId: flags.get("account-id"),
              },
              { workspaceKeysDir },
            );
          } catch {
            return {
              profileId: "default",
              credentials: {
                accountId: flags.get("account-id") ?? "0".repeat(32),
                accessKeyId: "DRY_RUN_AK",
                secretAccessKey: "DRY_RUN_SK",
                apiToken: "DRY_RUN_TOKEN",
              },
            };
          }
        })()
      : resolveLocalCloudflareCredentials(
          {
            profileId: flags.get("profile"),
            accountId: flags.get("account-id"),
          },
          { workspaceKeysDir },
        );

    const apiToken =
      flags.get("api-token") ?? credResolved.credentials.apiToken ?? "";

    if (mode === "pages") {
      const projectName = flags.get("pages-project");
      if (!projectName) {
        throw new Error("deploy-web --mode=pages requires --pages-project");
      }
      return await deployWebToCloudflarePages({
        accountId: flags.get("account-id") ?? credResolved.credentials.accountId,
        projectName,
        apiToken,
        webDir,
        branch: flags.get("branch"),
        dryRun,
      });
    }

    const scriptName = flags.get("worker-script");
    if (!scriptName) {
      throw new Error("deploy-web --mode=workers-assets requires --worker-script");
    }
    return await deployWebToCloudflareWorkersAssets({
      accountId: flags.get("account-id") ?? credResolved.credentials.accountId,
      scriptName,
      apiToken,
      webDir,
      dryRun,
    });
  }

  if (command === "endpoints") {
    const appId = flags.get("app-id");
    const hostVersion = flags.get("host-version");
    if (!appId || !hostVersion) {
      throw new Error("endpoints requires --app-id and --host-version");
    }
    const clients = buildClientsFromFlagsOrProject(flags, booleans, {
      dryRun: true,
      workspaceKeysDir,
    });
    const doc = buildPlatformEndpointsDocument({
      targets: clients.map((c) => c.target),
      appId,
      hostVersion,
      packageVersion: flags.get("package-version"),
      slot: flags.get("slot") as "test" | "stable" | undefined,
      keyId: flags.get("key-id"),
      publicKey: flags.get("public-key"),
    });
    const outPath = flags.get("out");
    if (outPath) {
      const fs = await import("node:fs");
      const pathMod = await import("node:path");
      const resolvedOut = pathMod.resolve(outPath);
      fs.mkdirSync(pathMod.dirname(resolvedOut), { recursive: true });
      fs.writeFileSync(resolvedOut, JSON.stringify(doc, null, 2) + "\n");
    }
    return doc;
  }

  usage();
}

if (import.meta.main) {
  try {
    const result = await runCloudflareCli(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
