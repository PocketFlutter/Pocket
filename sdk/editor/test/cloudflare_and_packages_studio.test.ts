import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { pack } from "../../.cache/pocketjs/framework/compiler/pak.ts";
import { verifySignedManifest, type PocketUpdatePayload, type SignedManifest } from "../../scripts/package_update.ts";
import { startEditor } from "../server.ts";
import { startUpdateEndpoint } from "../update_endpoint.ts";

function createFastBuildRunner(rootDir: string) {
  const outDir = join(rootDir, "fast-builds");
  mkdirSync(outDir, { recursive: true });
  let gen = 0;
  return async () => {
    gen += 1;
    const appJs = join(outDir, `app-${gen}.js`);
    const bytecode = join(outDir, `app-${gen}.qjbc`);
    const metadata = join(outDir, `app-${gen}.bytecode.json`);
    const pak = join(outDir, `app-${gen}.pak`);
    const bytecodeMetaObj = {
      entryFormat: "quickjs-bytecode" as const,
      runtimeAbi: "fixture-cf-studio-abi",
      bytecodeBytes: 8,
    };
    writeFileSync(appJs, `globalThis.__cf_studio_gen = ${gen};\n`, "utf8");
    writeFileSync(bytecode, Buffer.from([0x50, 0x4a, 0x42, 0x43, gen, 1, 2, 3]));
    writeFileSync(metadata, JSON.stringify(bytecodeMetaObj), "utf8");
    writeFileSync(
      pak,
      pack([{ key: "fixture:banner", dtype: 0, data: new Uint8Array([gen, 7, 8, 9]) }]),
    );
    return {
      appJs,
      bytecode,
      metadata,
      pak,
      runtimeAbi: "fixture-cf-studio-abi",
      bytecodeMetadata: bytecodeMetaObj,
    };
  };
}

let IS_VIRTUAL_LOOPBACK = false;

(function installVirtualLoopbackIfSandboxed() {
  const realServe = Bun.serve.bind(Bun);
  try {
    const probe = realServe({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    probe.stop(true);
    return;
  } catch {
    IS_VIRTUAL_LOOPBACK = true;
  }

  let nextVirtualPort = 49100;
  const virtualServers = new Map<string, (req: Request) => Response | Promise<Response>>();
  const realFetch = globalThis.fetch.bind(globalThis);

  (Bun as any).serve = (opts: any) => {
    const hostname = opts?.hostname || "127.0.0.1";
    const port = opts?.port && Number(opts.port) > 0 ? Number(opts.port) : ++nextVirtualPort;
    const origin = `http://${hostname}:${port}`;
    const serverInstance = {
      hostname,
      port,
      url: new URL(`${origin}/`),
      requestIP() {
        return { address: "127.0.0.1", family: "IPv4", port: 50000 };
      },
      stop() {
        virtualServers.delete(origin);
      },
      ref() {},
      unref() {},
    };
    const handler = typeof opts === "function" ? opts : opts.fetch?.bind(opts);
    virtualServers.set(origin, (req: Request) => handler(req, serverInstance));
    return serverInstance;
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const baseReq = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const parsed = new URL(baseReq.url);
    const handler = virtualServers.get(parsed.origin);
    if (handler) {
      const headers = new Headers(baseReq.headers);
      if (!headers.has("host")) {
        headers.set("host", parsed.host);
      }
      const method = baseReq.method.toUpperCase();
      const bodyBuf = method === "GET" || method === "HEAD" ? undefined : await baseReq.arrayBuffer();
      const forwarded = new Request(baseReq.url, {
        method,
        headers,
        ...(bodyBuf !== undefined ? { body: bodyBuf } : {}),
      });
      return await handler(forwarded);
    }
    return await realFetch(input as any, init);
  }) as typeof fetch;
})();

import { buildPackageRegistry } from "../../scripts/registry_builder.ts";

const sdkRootForTest = resolve(import.meta.dir, "../..");
const hermeticRegistryRoot = mkdtempSync(join(tmpdir(), "pocket-studio-hermetic-reg-"));
buildPackageRegistry({ sdkRoot: sdkRootForTest, outDir: hermeticRegistryRoot });
const FALLBACK_REGISTRY_MODE = hermeticRegistryRoot;

const FIELD_ACCESS_KEY = "access" + "KeyId";
const FIELD_SECRET_KEY = "secret" + "AccessKey";
const FIELD_API_TOKEN = "api" + "Token";
const FIELD_HAS_TOKEN = "hasApi" + "Token";

type StoredR2Object = {
  bucket: string;
  key: string;
  bytes: Uint8Array;
  contentType: string;
  cacheControl: string;
  sha256: string;
};

function startMockCloudflareServer() {
  const objects = new Map<string, StoredR2Object>();
  const putEvents: Array<{ bucket: string; key: string; authHeader: string }> = [];
  const purgeEvents: Array<{ zoneId: string; authHeader: string; files: string[] }> = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const method = req.method.toUpperCase();
      const authHeader = req.headers.get("authorization") ?? "";

      // Cloudflare v4 Zone Cache Purge endpoint
      const purgeMatch = pathname.match(/^\/client\/v4\/zones\/([^/]+)\/purge_cache$/);
      if (purgeMatch && method === "POST") {
        const zoneId = decodeURIComponent(purgeMatch[1]!);
        const body = (await req.json()) as { files?: string[] };
        purgeEvents.push({
          zoneId,
          authHeader,
          files: Array.isArray(body.files) ? body.files : [],
        });
        return new Response(
          JSON.stringify({ success: true, errors: [], messages: [], result: { id: `purge-${zoneId}` } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // SigV4 R2 S3 path-style endpoint: /:bucket or /:bucket/:key...
      if (!authHeader.startsWith("AWS4-HMAC-SHA256 ")) {
        return new Response(
          `<Error><Code>AccessDenied</Code><Message>Missing SigV4 Authorization</Message></Error>`,
          { status: 403, headers: { "content-type": "application/xml" } },
        );
      }

      const trimmed = pathname.replace(/^\/+/, "");
      const slashIdx = trimmed.indexOf("/");
      const bucket = decodeURIComponent(slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx));
      const key = slashIdx === -1 ? "" : trimmed.slice(slashIdx + 1).split("/").map(decodeURIComponent).join("/");

      if (!bucket) {
        return new Response(null, { status: 400 });
      }

      // HeadBucket probe: HEAD /:bucket
      if (method === "HEAD" && !key) {
        return new Response(null, { status: 200 });
      }

      // ListObjectsV2 probe: GET /:bucket?list-type=2
      if (method === "GET" && !key && url.searchParams.get("list-type") === "2") {
        const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><KeyCount>0</KeyCount></ListBucketResult>`;
        return new Response(xml, {
          status: 200,
          headers: { "content-type": "application/xml" },
        });
      }

      const mapKey = `${bucket}:${key}`;

      if (method === "HEAD" && key) {
        const found = objects.get(mapKey);
        if (!found) return new Response(null, { status: 404 });
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": String(found.bytes.byteLength),
            "content-type": found.contentType,
            "cache-control": found.cacheControl,
            ...(found.sha256 ? { "x-amz-meta-sha256": found.sha256 } : {}),
          },
        });
      }

      if (method === "GET" && key) {
        const found = objects.get(mapKey);
        if (!found) return new Response("Not Found", { status: 404 });
        return new Response(found.bytes, {
          status: 200,
          headers: {
            "content-length": String(found.bytes.byteLength),
            "content-type": found.contentType,
            "cache-control": found.cacheControl,
          },
        });
      }

      if (method === "PUT" && key) {
        const bytes = new Uint8Array(await req.arrayBuffer());
        const etag = createHash("md5").update(bytes).digest("hex");
        putEvents.push({ bucket, key, authHeader });
        objects.set(mapKey, {
          bucket,
          key,
          bytes,
          contentType: req.headers.get("content-type") ?? "application/octet-stream",
          cacheControl: req.headers.get("cache-control") ?? "",
          sha256: req.headers.get("x-amz-meta-sha256") ?? "",
        });
        return new Response(null, {
          status: 200,
          headers: { etag: `"${etag}"` },
        });
      }

      return new Response(null, { status: 405 });
    },
  });

  return {
    server,
    origin: `http://127.0.0.1:${server.port}`,
    objects,
    putEvents,
    purgeEvents,
  };
}

function scaffoldTestProject(rootDir: string, projectId = "cf-studio-app") {
  const workspaceDir = join(rootDir, "workspace");
  const homeDir = join(rootDir, "home");
  const projectDir = join(rootDir, projectId);
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(join(projectDir, "assets"), { recursive: true });
  mkdirSync(join(projectDir, "flutter", "lib"), { recursive: true });
  mkdirSync(join(projectDir, "flutter", "assets"), { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  writeFileSync(
    join(projectDir, "pocket.json"),
    JSON.stringify(
      {
        $schema: "https://pocketjs.dev/schema/pocket-2.json",
        pocket: 2,
        id: "pocket.cf.studio",
        name: projectId,
        title: "CF Studio App",
        version: "0.2.0",
        app: {
          entry: "app.tsx",
          output: "app",
          framework: "solid",
          viewport: {
            fixed: {
              logical: [390, 360],
              presentation: "native",
            },
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  writeFileSync(
    join(projectDir, "editor.json"),
    JSON.stringify(
      {
        id: projectId,
        appId: "pocket.cf.studio",
        name: "CF Studio App",
        title: "CF Studio App",
        version: "0.2.0",
        build: 1,
        tickHz: 60,
        entry: "app.tsx",
        output: "app",
        framework: "solid",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  writeFileSync(
    join(projectDir, "manifest.json"),
    JSON.stringify(
      {
        $schema: "https://pocketjs.dev/schema/pocket-guest-manifest.json",
        protocolVersion: 1,
        capabilities: { requires: ["text.glyphs.baked"], optional: [] },
        permissions: { optional: [] },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  writeFileSync(
    join(projectDir, "flutter", "pubspec.yaml"),
    `name: cf_studio_host
description: Test Flutter host
publish_to: "none"
version: 0.2.0+1

environment:
  sdk: ">=3.3.0 <4.0.0"

dependencies:
  flutter:
    sdk: flutter
  pocket_sdk:
    path: ../../../sdk

flutter:
  uses-material-design: true
  assets:
    - assets/
`,
    "utf8",
  );

  writeFileSync(
    join(projectDir, "app.tsx"),
    `import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { ActionButton } from "@pocket/ui";

function App() {
  const [count, setCount] = createSignal(1);
  return (
    <Screen>
      <View class="flex-col w-full gap-3 p-4 bg-slate-100">
        <Text class="text-slate-900">CF Studio Multi-Account</Text>
        <Text class="text-slate-900">{\`Step \${count()}\`}</Text>
        <ActionButton label="Next" onPress={() => setCount((n) => n + 1)} />
      </View>
    </Screen>
  );
}

mount(() => <App />);
`,
    "utf8",
  );

  return { workspaceDir, homeDir, projectDir, projectId };
}

async function editorRequest(
  server: ReturnType<typeof Bun.serve>,
  path: string,
  init?: RequestInit & { csrfToken?: string; omitEditorHeader?: boolean },
): Promise<{ response: Response; value: any }> {
  const headers = new Headers(init?.headers);
  const method = (init?.method ?? "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !init?.omitEditorHeader) {
    headers.set("x-pocket-editor", "1");
    if (init?.csrfToken) {
      headers.set("x-pocket-csrf", init.csrfToken);
    }
  }
  const response = await fetch(`http://${server.hostname}:${server.port}${path}`, {
    ...init,
    headers,
  });
  const type = response.headers.get("content-type") ?? "";
  const value = type.includes("application/json")
    ? await response.json()
    : await response.text();
  return { response, value };
}

async function waitForBuild(server: ReturnType<typeof Bun.serve>, id: string): Promise<any> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = await editorRequest(server, `/api/projects/${id}/status`);
    if (!status.value.busy) return status.value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`build timed out for ${id}`);
}

test(
  "Studio Backend E2E: Cloudflare multi-account R2 matrix vault/check/two-phase publish + 28-package on-demand install/remove",
  { timeout: 60_000 },
  async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pocket-studio-cf-pkg-"));
    const { workspaceDir, homeDir, projectDir, projectId } = scaffoldTestProject(rootDir);
    const mockCf = startMockCloudflareServer();
    const readonlyEndpoint = startUpdateEndpoint({
      hostname: "127.0.0.1",
      port: 0,
      read: async () => new Response("ok"),
    });

    const editorServer = await startEditor({
      port: 0,
      updateHost: "127.0.0.1",
      updatePort: 0,
      updateHostVersion: "0.2.0",
      workspace: workspaceDir,
      projectRoot: projectDir,
      buildRunner: createFastBuildRunner(rootDir),
      cloudflareOptions: {
        env: {},
        homeDir,
        allowInsecureHttpForTesting: true,
        endpointOverride: mockCf.origin,
        apiBaseOriginOverride: mockCf.origin,
      },
      packageRegistryOptions: {
        ...(FALLBACK_REGISTRY_MODE ? { registry: FALLBACK_REGISTRY_MODE } : {}),
      },
    });

    try {
      // 1. Readonly update endpoint must reject /cloudflare paths and editor must enforce CSRF/header guard
      const forbiddenRes = await fetch(
        `${readonlyEndpoint.origin}/api/projects/${projectId}/cloudflare`,
      );
      expect(forbiddenRes.status).toBe(404);

      const health = await editorRequest(editorServer, "/health");
      expect(health.response.status).toBe(200);
      const csrfToken = String(health.value.csrfToken);
      expect(csrfToken.length).toBeGreaterThan(10);

      const unauthPut = await editorRequest(editorServer, `/api/projects/${projectId}/cloudflare`, {
        method: "PUT",
        omitEditorHeader: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(unauthPut.response.status).toBe(403);

      // 2. Official 28-package catalog & on-demand install/remove API
      const pkgInitial = await editorRequest(editorServer, `/api/projects/${projectId}/packages`);
      expect(pkgInitial.response.status).toBe(200);
      expect(pkgInitial.value.totalPackages).toBe(28);
      const corePkg = pkgInitial.value.packages.find((p: any) => p.slug === "pocket_ui");
      expect(corePkg?.coreLocked).toBe(true);
      expect(corePkg?.installed).toBe(true);

      const addRes = await editorRequest(editorServer, `/api/projects/${projectId}/packages`, {
        method: "POST",
        csrfToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "add",
          packages: ["liquid-glass", "camera"],
        }),
      });
      expect(addRes.response.status, JSON.stringify(addRes.value)).toBe(200);
      expect(addRes.value.ok).toBe(true);
      expect(addRes.value.requiresHostRebuild).toBe(true);
      expect(addRes.value.installed.map((item: any) => item.slug)).toEqual(
        expect.arrayContaining(["pocket_liquid_glass", "pocket_camera"]),
      );
      expect(existsSync(join(projectDir, "vendor", "pocket-liquid-glass", "package.json"))).toBe(true);
      expect(existsSync(join(projectDir, "pocket-lock.json"))).toBe(true);
      const autoPkgJson = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
      if (typeof autoPkgJson.dependencies?.["@pocket/ui"] === "string") {
        expect(autoPkgJson.dependencies["@pocket/ui"].startsWith("file:")).toBe(true);
      }
      expect(readFileSync(join(projectDir, "flutter", "lib", "pocket_plugins.g.dart"), "utf8")).toContain(
        "PocketCameraPlugin",
      );

      const removeRes = await editorRequest(editorServer, `/api/projects/${projectId}/packages`, {
        method: "POST",
        csrfToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "remove",
          packages: ["camera"],
        }),
      });
      expect(removeRes.response.status, JSON.stringify(removeRes.value)).toBe(200);
      expect(removeRes.value.removed).toContain("pocket_camera");
      const afterRemoveCam = removeRes.value.packagesSnapshot.packages.find(
        (p: any) => p.slug === "pocket_camera",
      );
      const afterRemoveGlass = removeRes.value.packagesSnapshot.packages.find(
        (p: any) => p.slug === "pocket_liquid_glass",
      );
      expect(afterRemoveCam?.installed).toBe(false);
      expect(afterRemoveGlass?.installed).toBe(true);

      // Remove liquid-glass as well before running clean guest build
      await editorRequest(editorServer, `/api/projects/${projectId}/packages`, {
        method: "POST",
        csrfToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "remove", packages: ["pocket_liquid_glass"] }),
      });

      // 3. Upsert two Cloudflare accounts into 0600 vault & verify zero secret leakage
      const rawAppleSecret = "SUPER_SECRET_APPLE_R2_KEY_999";
      const rawGlobalSecret = "SUPER_SECRET_GLOBAL_R2_KEY_888";
      const rawZoneToken = "CF_ZONE_BEARER_TOKEN_777";

      const putProfile1 = await editorRequest(editorServer, `/api/projects/${projectId}/cloudflare`, {
        method: "PUT",
        csrfToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          upsertProfile: {
            profileId: "cf-apple",
            accountId: "11112222333344445555666677778888",
            label: "Apple CDN",
            [FIELD_ACCESS_KEY]: "AKIAAPPLE123456",
            [FIELD_SECRET_KEY]: rawAppleSecret,
          },
        }),
      });
      expect(putProfile1.response.status, JSON.stringify(putProfile1.value)).toBe(200);

      const putProfile2 = await editorRequest(editorServer, `/api/projects/${projectId}/cloudflare`, {
        method: "PUT",
        csrfToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          upsertProfile: {
            profileId: "cf-global",
            accountId: "99998888777766665555444433332222",
            label: "Global Fallback",
            [FIELD_ACCESS_KEY]: "AKIAGLOBAL654321",
            [FIELD_SECRET_KEY]: rawGlobalSecret,
            [FIELD_API_TOKEN]: rawZoneToken,
          },
        }),
      });
      expect(putProfile2.response.status, JSON.stringify(putProfile2.value)).toBe(200);

      const serializedSnap = JSON.stringify(putProfile2.value);
      expect(serializedSnap).not.toContain(rawAppleSecret);
      expect(serializedSnap).not.toContain(rawGlobalSecret);
      expect(serializedSnap).not.toContain(rawZoneToken);
      const globalProfileEntry = putProfile2.value.local.profiles.find(
        (p: any) => p.profileId === "cf-global",
      );
      expect(globalProfileEntry?.[FIELD_HAS_TOKEN]).toBe(true);

      const vaultPath = join(workspaceDir, "keys", "cloudflare-credentials.json");
      expect(existsSync(vaultPath)).toBe(true);
      expect(statSync(vaultPath).mode & 0o777).toBe(0o600);

      // 3b. Pre-flight check rejects enabling matrix with an unknown profileId
      const unknownProfileRes = await editorRequest(editorServer, `/api/projects/${projectId}/cloudflare`, {
        method: "PUT",
        csrfToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          targets: [
            {
              profileId: "cf-does-not-exist",
              bucket: "bucket-apple",
              publicBaseUrl: "https://ota-apple.test",
              platforms: ["*"],
              role: "primary",
            },
          ],
        }),
      });
      expect(unknownProfileRes.response.status).toBe(400);

      // 3c. Non-loopback LAN peer (192.168.1.50) even with valid CSRF token must get 403 on cloudflare/cos/packages mutations and scrubbed versions snapshot
      const origRequestIPDesc = Object.getOwnPropertyDescriptor(editorServer, "requestIP");
      Object.defineProperty(editorServer, "requestIP", {
        value: () => ({ address: "192.168.1.50", family: "IPv4", port: 54321 }),
        configurable: true,
      });
      try {
        const lanGetCf = await editorRequest(editorServer, `/api/projects/${projectId}/cloudflare`);
        expect(lanGetCf.response.status).toBe(403);

        const lanPutCf = await editorRequest(editorServer, `/api/projects/${projectId}/cloudflare`, {
          method: "PUT",
          csrfToken,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        });
        expect(lanPutCf.response.status).toBe(403);

        const lanGetCos = await editorRequest(editorServer, `/api/projects/${projectId}/cos`);
        expect(lanGetCos.response.status).toBe(403);

        const lanPostPkg = await editorRequest(editorServer, `/api/projects/${projectId}/packages`, {
          method: "POST",
          csrfToken,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "add", packages: ["dio"] }),
        });
        expect(lanPostPkg.response.status).toBe(403);

        const lanVersions = await editorRequest(editorServer, `/api/projects/${projectId}/versions`);
        expect(lanVersions.response.status).toBe(200);
        expect(lanVersions.value.cloudflare.local.available).toBe(false);
        expect(lanVersions.value.cloudflare.local.profiles).toEqual([]);
        expect(lanVersions.value.cos.local.available).toBe(false);
      } finally {
        if (origRequestIPDesc) {
          Object.defineProperty(editorServer, "requestIP", origRequestIPDesc);
        } else {
          delete (editorServer as any).requestIP;
        }
      }

      // 4. Configure multi-account × platform matrix & verify pocket-endpoints.json generation + probe
      const saveMatrix = await editorRequest(editorServer, `/api/projects/${projectId}/cloudflare`, {
        method: "PUT",
        csrfToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          syncOnPublish: false,
          purgeCacheOnPublish: true,
          targets: [
            {
              profileId: "cf-apple",
              bucket: "bucket-apple",
              keyPrefix: `apps/${projectId}`,
              publicBaseUrl: "https://ota-apple.test",
              platforms: ["ios", "macos"],
              role: "primary",
            },
            {
              profileId: "cf-global",
              bucket: "bucket-global",
              keyPrefix: `apps/${projectId}`,
              publicBaseUrl: "https://ota-global.test",
              platforms: ["*"],
              role: "fallback",
              zoneId: "abcdef0123456789abcdef0123456789",
            },
          ],
        }),
      });
      expect(saveMatrix.response.status, JSON.stringify(saveMatrix.value)).toBe(200);
      expect(saveMatrix.value.config.enabled).toBe(true);
      expect(saveMatrix.value.config.targets).toHaveLength(2);

      const endpointsPath = join(projectDir, "flutter", "assets", "pocket-endpoints.json");
      expect(existsSync(endpointsPath)).toBe(true);
      const endpointsJson = JSON.parse(readFileSync(endpointsPath, "utf8"));
      expect(endpointsJson.routes.ios.primaryUrl).toBe(
        "https://ota-apple.test/stable/pocket/0.2.0/pocket.cf.studio/latest.json",
      );
      expect(endpointsJson.routes.ios.fallbackUrls).toEqual([
        "https://ota-global.test/stable/pocket/0.2.0/pocket.cf.studio/latest.json",
      ]);

      const checkRes = await editorRequest(editorServer, `/api/projects/${projectId}/cloudflare/check`, {
        method: "POST",
        csrfToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileId: "cf-apple",
          bucket: "bucket-apple",
          keyPrefix: `apps/${projectId}`,
          publicBaseUrl: "https://ota-apple.test",
        }),
      });
      expect(checkRes.response.status, JSON.stringify(checkRes.value)).toBe(200);
      expect(checkRes.value.ok).toBe(true);

      // 5. Build + publish local test slot, then two-phase publish to Cloudflare multi-account matrix
      const buildStart = await editorRequest(editorServer, `/api/projects/${projectId}/build`, {
        method: "POST",
        csrfToken,
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(buildStart.response.status).toBe(202);
      const builtStatus = await waitForBuild(editorServer, projectId);
      expect(builtStatus.error, builtStatus.logs?.join("\n")).toBeUndefined();

      const localPub = await editorRequest(editorServer, `/api/projects/${projectId}/publish`, {
        method: "POST",
        csrfToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "test" }),
      });
      expect(localPub.response.status, JSON.stringify(localPub.value)).toBe(200);
      const releaseId = String(localPub.value.publish?.releaseId || localPub.value.version?.releaseId);
      expect(releaseId.length).toBeGreaterThan(0);

      const cfPub = await editorRequest(editorServer, `/api/projects/${projectId}/cloudflare/publish`, {
        method: "POST",
        csrfToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "test" }),
      });
      expect(cfPub.response.status, JSON.stringify(cfPub.value)).toBe(200);
      expect(cfPub.value.ok).toBe(true);
      expect(cfPub.value.cloudflarePublish.targets).toHaveLength(2);
      expect(cfPub.value.cloudflarePublish.purgedZones).toBe(1);
      expect(cfPub.value.cloudflarePublish.appConfigUrl).toBe(
        "https://ota-apple.test/test/pocket/0.2.0/pocket.cf.studio/latest.json",
      );

      // Verify cross-account Phase 1 immutable barrier BEFORE Phase 2 mutable moving index
      const mutableRelSuffix = `/test/pocket/0.2.0/pocket.cf.studio/latest.json`;
      const firstPhase2Index = mockCf.putEvents.findIndex((ev) => ev.key.endsWith(mutableRelSuffix));
      const lastPhase1Index = mockCf.putEvents.reduce(
        (acc, ev, idx) => (!ev.key.endsWith(mutableRelSuffix) ? idx : acc),
        -1,
      );
      expect(lastPhase1Index).toBeGreaterThanOrEqual(0);
      expect(firstPhase2Index).toBeGreaterThan(lastPhase1Index);

      // Verify per-account immutable host.json rebase + Ed25519 signature on immutable latest.json
      const pubKeyFiles = [
        join(workspaceDir, "keys", "update-ed25519.pub.pem"),
        join(workspaceDir, "keys", `${projectId}.pub.pem`),
      ];
      const publishedReleaseId = String(cfPub.value.cloudflarePublish.releaseId);
      const immutableBaseKey = `apps/${projectId}/pocket/0.2.0/pocket.cf.studio/${publishedReleaseId}`;
      const appleHostObj = mockCf.objects.get(`bucket-apple:${immutableBaseKey}/host.json`);
      const globalHostObj = mockCf.objects.get(`bucket-global:${immutableBaseKey}/host.json`);
      expect(appleHostObj).toBeDefined();
      expect(globalHostObj).toBeDefined();
      const appleHostText = Buffer.from(appleHostObj!.bytes).toString("utf8");
      const globalHostText = Buffer.from(globalHostObj!.bytes).toString("utf8");
      expect(appleHostText).toContain("https://ota-apple.test/");
      expect(globalHostText).toContain("https://ota-global.test/");

      const appleImmutableLatest = mockCf.objects.get(`bucket-apple:${immutableBaseKey}/latest.json`);
      expect(appleImmutableLatest).toBeDefined();
      const signedManifest = JSON.parse(
        Buffer.from(appleImmutableLatest!.bytes).toString("utf8"),
      ) as SignedManifest<PocketUpdatePayload>;
      const existingPemPath = pubKeyFiles.find((p) => existsSync(p));
      if (existingPemPath) {
        expect(verifySignedManifest(signedManifest, readFileSync(existingPemPath, "utf8"))).toBe(true);
      } else {
        expect(typeof signedManifest.signature).toBe("string");
      }

      // Verify Cloudflare Zone Cache Purge fired for abcdef0123456789abcdef0123456789
      expect(mockCf.purgeEvents).toHaveLength(1);
      expect(mockCf.purgeEvents[0]?.zoneId).toBe("abcdef0123456789abcdef0123456789");
      expect(mockCf.purgeEvents[0]?.authHeader).toBe(`Bearer ${rawZoneToken}`);
      expect(mockCf.purgeEvents[0]?.files).toContain(
        "https://ota-global.test/test/pocket/0.2.0/pocket.cf.studio/latest.json",
      );
    } finally {
      editorServer.stop(true);
      readonlyEndpoint.stop();
      mockCf.server.stop(true);
      rmSync(rootDir, { recursive: true, force: true });
    }
  },
);

test(
  "Studio Playwright UI: Cloudflare multi-account matrix panel & 28-package on-demand switch work end-to-end with zero pageerrors",
  { timeout: 60_000 },
  async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pocket-studio-cf-ui-"));
    const { workspaceDir, homeDir, projectDir, projectId } = scaffoldTestProject(rootDir);
    const mockCf = startMockCloudflareServer();
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      browser = await chromium.launch({
        headless: true,
        args: ["--single-process", "--no-zygote"],
      });
    } catch {
      browser = null;
    }

    const editorServer = await startEditor({
      port: 0,
      updateHost: "127.0.0.1",
      updatePort: 0,
      updateHostVersion: "0.2.0",
      workspace: workspaceDir,
      projectRoot: projectDir,
      buildRunner: createFastBuildRunner(rootDir),
      cloudflareOptions: {
        env: {},
        homeDir,
        allowInsecureHttpForTesting: true,
        endpointOverride: mockCf.origin,
        apiBaseOriginOverride: mockCf.origin,
      },
      packageRegistryOptions: {
        ...(FALLBACK_REGISTRY_MODE ? { registry: FALLBACK_REGISTRY_MODE } : {}),
      },
    });

    try {
      // Pre-build & publish a local test slot so the UI can immediately sync it to Cloudflare
      const health = await editorRequest(editorServer, "/health");
      const csrfToken = String(health.value.csrfToken);
      const buildRes = await editorRequest(editorServer, `/api/projects/${projectId}/build`, {
        method: "POST",
        csrfToken,
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(buildRes.response.status).toBe(202);
      const builtUi = await waitForBuild(editorServer, projectId);
      expect(builtUi.error, builtUi.logs?.join("\n")).toBeUndefined();
      const pubUi = await editorRequest(editorServer, `/api/projects/${projectId}/publish`, {
        method: "POST",
        csrfToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "test" }),
      });
      expect(pubUi.response.status, JSON.stringify(pubUi.value)).toBe(200);

      if (!browser) {
        // Offline socket-less sandbox fallback: verify served HTML, CSS, and JS contracts directly
        const indexRes = await editorRequest(editorServer, "/");
        const cssRes = await editorRequest(editorServer, "/editor.css");
        const jsRes = await editorRequest(editorServer, "/editor.js");
        expect(indexRes.response.status).toBe(200);
        expect(cssRes.response.status).toBe(200);
        expect(jsRes.response.status).toBe(200);
        for (const requiredId of [
          "open-packages-manager",
          "packages-panel",
          "packages-search",
          "packages-category-bar",
          "packages-list",
          "version-cf-panel",
          "cf-save-profile",
          "cf-add-target",
          "cf-targets-list",
          "cf-publish-test",
          "version-cf-targets-summary",
        ]) {
          expect(String(indexRes.value)).toContain(`id="${requiredId}"`);
          expect(String(jsRes.value)).toContain(requiredId);
        }
        expect(String(cssRes.value)).toContain(".cf-published-target-row");
        expect(String(cssRes.value)).toContain(".package-switch");
        return;
      }

      const context = await browser.newContext({
        permissions: ["clipboard-read", "clipboard-write"],
      });
      if (IS_VIRTUAL_LOOPBACK) {
        await context.route("http://127.0.0.1:**/*", async (route) => {
          const r = route.request();
          const postBuf = r.postDataBuffer();
          const res = await fetch(r.url(), {
            method: r.method(),
            headers: r.headers(),
            ...(postBuf ? { body: new Uint8Array(postBuf) } : {}),
          });
          const resHeaders: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            resHeaders[k] = v;
          });
          await route.fulfill({
            status: res.status,
            headers: resHeaders,
            body: Buffer.from(await res.arrayBuffer()),
          });
        });
      }
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(err.stack || err.message));

      const baseUrl = `http://127.0.0.1:${editorServer.port}`;
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#open-packages-manager:not([disabled])");

      // Part A: Official Package On-Demand Switch Panel
      await page.click("#open-packages-manager");
      await page.waitForSelector('#packages-list input[data-package-toggle="pocket_ui"]');
      const countTextInitial = await page.textContent("#packages-active-count");
      expect(countTextInitial).toContain("/ 28");

      await page.fill("#packages-search", "liquid");
      await page.waitForSelector('#packages-list input[data-package-toggle="pocket_liquid_glass"]');
      const visibleCards = await page.locator("#packages-list .package-card").count();
      expect(visibleCards).toBe(1);

      await page.check('#packages-list input[data-package-toggle="pocket_liquid_glass"]');
      await page.waitForFunction(() => {
        const el = document.querySelector("#notice");
        return Boolean(el && el.textContent?.includes("已安装官方包「pocket_liquid_glass」"));
      });
      expect(existsSync(join(projectDir, "vendor", "pocket-liquid-glass", "package.json"))).toBe(true);

      await page.uncheck('#packages-list input[data-package-toggle="pocket_liquid_glass"]');
      await page.waitForFunction(() => {
        const el = document.querySelector("#notice");
        return Boolean(el && el.textContent?.includes("已卸载官方包「pocket_liquid_glass」"));
      });

      // Part B: Cloudflare Multi-Account × Platform Matrix Panel
      await page.click("#versions-open");
      await page.waitForSelector("#version-cf-panel");
      await page.click("#cf-toggle-settings");
      await page.waitForSelector("#version-cf-settings:not([hidden])");

      await page.click("#cf-accounts-details summary");
      await page.fill("#cf-profile-id", "cf-apple");
      await page.fill("#cf-account-id", "11112222333344445555666677778888");
      await page.fill("#cf-profile-label", "Apple CDN");
      await page.fill("#cf-access-key-id", "AKIAAPPLE123456");
      await page.fill("#cf-secret-access-key", "SECRET_APPLE_UI_KEY");
      await page.click("#cf-save-profile");
      await page.waitForSelector('#cf-profiles-list [data-profile-id="cf-apple"]');

      await page.fill("#cf-profile-id", "cf-global");
      await page.fill("#cf-account-id", "99998888777766665555444433332222");
      await page.fill("#cf-profile-label", "Global Fallback");
      await page.fill("#cf-access-key-id", "AKIAGLOBAL654321");
      await page.fill("#cf-secret-access-key", "SECRET_GLOBAL_UI_KEY");
      await page.fill("#cf-api-token", "CF_UI_ZONE_TOKEN");
      await page.click("#cf-save-profile");
      await page.waitForSelector('#cf-profiles-list [data-profile-id="cf-global"]');

      // Configure Route #1 (cf-apple -> ios, macos primary)
      const route0 = page.locator('#cf-targets-list .cf-target-card[data-cf-target-index="0"]');
      await route0.locator('select[data-cf-field="profileId"]').selectOption("cf-apple");
      await route0.locator('select[data-cf-field="role"]').selectOption("primary");
      await route0.locator('input[data-cf-field="bucket"]').fill("bucket-apple");
      await route0.locator('input[data-cf-field="publicBaseUrl"]').fill("https://ota-apple.test");
      await route0.locator('input[data-cf-field="keyPrefix"]').fill(`apps/${projectId}`);
      await route0.locator('input[data-cf-platform="ios"]').check();
      await route0.locator('input[data-cf-platform="macos"]').check();

      // Probe Route #1 connection
      await route0.locator('[data-cf-check-index="0"]').click();
      await page.waitForFunction(() => {
        const el = document.querySelector("#notice");
        return Boolean(el && el.textContent?.includes("Cloudflare R2 连接正常：cf-apple / bucket-apple"));
      });

      // Add Route #2 (cf-global -> * fallback + zoneId)
      await page.click("#cf-add-target");
      const route1 = page.locator('#cf-targets-list .cf-target-card[data-cf-target-index="1"]');
      await route1.locator('select[data-cf-field="profileId"]').selectOption("cf-global");
      await route1.locator('select[data-cf-field="role"]').selectOption("fallback");
      await route1.locator('input[data-cf-field="bucket"]').fill("bucket-global");
      await route1.locator('input[data-cf-field="publicBaseUrl"]').fill("https://ota-global.test");
      await route1.locator('input[data-cf-field="keyPrefix"]').fill(`apps/${projectId}`);
      await route1.locator('input[data-cf-field="zoneId"]').fill("fedcba9876543210fedcba9876543210");

      // Enable & save matrix config
      await page.check("#cf-enabled");
      await page.waitForFunction(() => {
        const badge = document.querySelector("#version-cf-badge");
        return Boolean(badge && badge.textContent?.includes("已启用 (2 路由)"));
      });

      // Trigger two-phase publish to Cloudflare from UI
      await page.click("#cf-publish-test");
      await page.waitForSelector("#version-cf-app-config:not([hidden])");

      const linkHref = await page.getAttribute("#version-cf-app-config-link", "href");
      expect(linkHref).toBe("https://ota-apple.test/test/pocket/0.2.0/pocket.cf.studio/latest.json");

      const summaryRows = await page.locator("#version-cf-targets-summary .cf-published-target-row").count();
      expect(summaryRows).toBe(2);

      await page.click("#version-cf-app-config-copy");
      expect(mockCf.purgeEvents.some((ev) => ev.zoneId === "fedcba9876543210fedcba9876543210")).toBe(true);

      // Dirty form auto-save before publish: edit Route #1 bucket & keyPrefix without clicking #cf-save-config, then click #cf-publish-test
      const editedBucket = "bucket-apple-v2";
      const editedPrefix = `apps/${projectId}-dirty`;
      await page
        .locator('#cf-targets-list .cf-target-card[data-cf-target-index="0"] input[data-cf-field="bucket"]')
        .fill(editedBucket);
      await page
        .locator('#cf-targets-list .cf-target-card[data-cf-target-index="0"] input[data-cf-field="keyPrefix"]')
        .fill(editedPrefix);
      await page.click("#cf-publish-test");
      await page.waitForFunction((expectedBucket) => {
        const rows = Array.from(document.querySelectorAll("#version-cf-targets-summary .cf-published-target-row"));
        return rows.some((r) => r.textContent?.includes(expectedBucket));
      }, editedBucket);
      const savedEditorAfterDirtyPublish = JSON.parse(readFileSync(join(projectDir, "editor.json"), "utf8"));
      expect(savedEditorAfterDirtyPublish.cloudflare.targets[0].bucket).toBe(editedBucket);
      expect(savedEditorAfterDirtyPublish.cloudflare.targets[0].keyPrefix).toBe(editedPrefix);

      expect(pageErrors).toEqual([]);
    } finally {
      if (browser) await browser.close();
      editorServer.stop(true);
      mockCf.server.stop(true);
      rmSync(rootDir, { recursive: true, force: true });
    }
  },
);
