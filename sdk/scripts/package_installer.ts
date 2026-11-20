/**
 * On-demand Pocket package resolver, dual-origin (Cloudflare R2 + GitHub)
 * verified tarball downloader, `pocket-lock.json` manager, and non-destructive
 * `flutter/lib/pocket_plugins.g.dart` host wiring engine.
 */

import { createHash, createPublicKey, randomUUID, verify as cryptoVerify } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  statSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { extractSafeTarGz } from "./install_studio.mjs";
import { SDK_VERSION } from "./prebuilt_tools.mjs";
import { POCKET_OFFICIAL_REGISTRY_PUBLIC_KEY_PEM } from "./registry_catalog.ts";
import {
  buildPackageRegistry,
  DEFAULT_GITHUB_REGISTRY_ORIGIN,
  DEFAULT_R2_REGISTRY_ORIGIN,
  OFFICIAL_PACKAGE_SPECS,
  type HostPluginWiringSpec,
  type PocketRegistryIndexDocument,
  type PocketRegistryPackageKind,
  type RegistryPackageCatalogEntry,
  type SignedPocketRegistryIndex,
} from "./registry_builder.ts";

export type PocketLockPackageEntry = {
  slug: string;
  version: string;
  kind: PocketRegistryPackageKind;
  jsPackageName?: string;
  dartPackageName?: string;
  vendorPath?: string;
  flutterPackagePath?: string;
  vendorTreeSha256?: string;
  flutterTreeSha256?: string;
  managedJsDependency?: boolean;
  managedDartDependency?: boolean;
  tarballSha256: string;
  resolvedFrom: string;
  requiresHostRebuild: boolean;
  direct?: boolean;
  dependencies?: string[];
  hostWiring?: HostPluginWiringSpec;
};

export type PocketLockfile = {
  schemaVersion: 1;
  kind: "pocket-package-lock";
  sdkVersion: string;
  updatedAt: string;
  packages: Record<string, PocketLockPackageEntry>;
  managedCapabilities?: string[];
  managedPermissions?: string[];
};

export type LoadedRegistrySource = {
  index: PocketRegistryIndexDocument;
  baseLocation: string;
  isLocalDirectory: boolean;
};

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function loadRegistryIndex(options: {
  registry?: string;
  sdkRoot?: string;
  publicKeyPem?: string;
  allowUnsignedRemoteIndex?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<LoadedRegistrySource> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const verifySignedEnvelope = (
    signedEnvelope: SignedPocketRegistryIndex,
    effectiveKeyPem?: string,
  ): PocketRegistryIndexDocument => {
    const payloadBytes = Buffer.from(signedEnvelope.payload, "base64");
    if (effectiveKeyPem) {
      const pub = createPublicKey(effectiveKeyPem);
      const ok = cryptoVerify(
        null,
        payloadBytes,
        pub,
        Buffer.from(signedEnvelope.signature, "base64"),
      );
      if (!ok) {
        throw new Error("Invalid Ed25519 signature on PocketFlutter registry index");
      }
    }
    return JSON.parse(payloadBytes.toString("utf8")) as PocketRegistryIndexDocument;
  };

  if (options.registry && !/^https?:\/\//i.test(options.registry.trim())) {
    const localDir = resolve(options.registry.trim());
    const signedPath = join(localDir, "registry/v1/signed-index.json");
    const indexPath = join(localDir, "registry/v1/index.json");
    if (options.publicKeyPem) {
      if (!existsSync(signedPath)) {
        throw new Error(`Local registry directory missing registry/v1/signed-index.json: ${localDir}`);
      }
      const signed = JSON.parse(
        readFileSync(signedPath, "utf8"),
      ) as SignedPocketRegistryIndex;
      return {
        index: verifySignedEnvelope(signed, options.publicKeyPem),
        baseLocation: localDir,
        isLocalDirectory: true,
      };
    }
    if (existsSync(indexPath)) {
      return {
        index: JSON.parse(
          readFileSync(indexPath, "utf8"),
        ) as PocketRegistryIndexDocument,
        baseLocation: localDir,
        isLocalDirectory: true,
      };
    }
    throw new Error(`Local registry directory missing registry/v1/index.json: ${localDir}`);
  }

  const candidateBases = options.registry
    ? [options.registry.trim().replace(/\/+$/g, "")]
    : [
        process.env.POCKET_REGISTRY_R2_URL?.trim() || DEFAULT_R2_REGISTRY_ORIGIN,
        process.env.POCKET_REGISTRY_GITHUB_URL?.trim() ||
          DEFAULT_GITHUB_REGISTRY_ORIGIN,
      ].map((u) => u.replace(/\/+$/g, ""));

  const remotePublicKeyPem =
    (options.publicKeyPem?.trim() ||
      process.env.POCKET_REGISTRY_PUBLIC_KEY_PEM?.trim()) ||
    (options.allowUnsignedRemoteIndex ? undefined : POCKET_OFFICIAL_REGISTRY_PUBLIC_KEY_PEM);

  let lastError: unknown;
  for (const base of candidateBases) {
    try {
      const indexUrl = remotePublicKeyPem
        ? `${base}/registry/v1/signed-index.json`
        : `${base}/registry/v1/index.json`;
      const resp = await fetchImpl(indexUrl, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} from ${indexUrl}`);
      }
      const rawJson = (await resp.json()) as Record<string, unknown>;
      if (rawJson.kind === "pocket-signed-package-registry-index") {
        return {
          index: verifySignedEnvelope(
            rawJson as unknown as SignedPocketRegistryIndex,
            remotePublicKeyPem,
          ),
          baseLocation: base,
          isLocalDirectory: false,
        };
      }
      if (rawJson.kind === "pocket-package-registry-index") {
        if (remotePublicKeyPem) {
          throw new Error(`Refusing unsigned remote registry index at ${indexUrl}`);
        }
        return {
          index: rawJson as unknown as PocketRegistryIndexDocument,
          baseLocation: base,
          isLocalDirectory: false,
        };
      }
      throw new Error(`Unexpected registry index document kind at ${indexUrl}`);
    } catch (error) {
      lastError = error;
    }
  }

  if (!options.registry && options.sdkRoot) {
    const sdkRoot = resolve(options.sdkRoot);
    const hasSource = OFFICIAL_PACKAGE_SPECS.every(({ slug }) =>
      lstatSync(join(sdkRoot, "packages", slug), { throwIfNoEntry: false })?.isDirectory(),
    );
    if (hasSource) {
      const localRegistry = checkedPath(realpathSync(sdkRoot), ".pocket-build/local-registry", "directory");
      mkdirSync(localRegistry, { recursive: true });
      const stage = mkdtempSync(join(localRegistry, ".stage-"));
      try {
        const { index } = buildPackageRegistry({ sdkRoot, outDir: stage });
        const key = sha256Hex(JSON.stringify(index));
        const baseLocation = checkedPath(localRegistry, key, "directory");
        try {
          renameSync(stage, baseLocation);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if ((code !== "EEXIST" && code !== "ENOTEMPTY")
            || !statSync(baseLocation, { throwIfNoEntry: false })?.isDirectory()) {
            throw error;
          }
        }
        return { index, baseLocation, isLocalDirectory: true };
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
  }

  throw new Error(
    `Failed to load PocketFlutter package registry: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export function resolvePackageInCatalog(
  index: PocketRegistryIndexDocument,
  queryName: string,
): RegistryPackageCatalogEntry | undefined {
  const q = queryName.trim().toLowerCase();
  if (!q) return undefined;
  return index.packages.find(
    (pkg) =>
      pkg.slug.toLowerCase() === q ||
      pkg.jsPackageName?.toLowerCase() === q ||
      pkg.dartPackageName?.toLowerCase() === q ||
      pkg.shortAliases.some((a) => a.toLowerCase() === q),
  );
}

export function searchCatalogPackages(
  index: PocketRegistryIndexDocument,
  keyword?: string,
): RegistryPackageCatalogEntry[] {
  if (!keyword || !keyword.trim()) return [...index.packages];
  const q = keyword.trim().toLowerCase();
  return index.packages.filter(
    (pkg) =>
      pkg.slug.toLowerCase().includes(q) ||
      (pkg.jsPackageName?.toLowerCase().includes(q) ?? false) ||
      (pkg.dartPackageName?.toLowerCase().includes(q) ?? false) ||
      pkg.category.toLowerCase().includes(q) ||
      pkg.kind.toLowerCase().includes(q) ||
      pkg.description.toLowerCase().includes(q) ||
      pkg.shortAliases.some((a) => a.toLowerCase().includes(q)),
  );
}

function resolveDependencyClosure(
  index: PocketRegistryIndexDocument,
  requestedSpecs: readonly string[],
): RegistryPackageCatalogEntry[] {
  const ordered: RegistryPackageCatalogEntry[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (spec: string) => {
    const entry = resolvePackageInCatalog(index, spec);
    if (!entry) {
      throw new Error(
        `Unknown Pocket package "${spec}". Run "bun pocket.ts search" to list available packages.`,
      );
    }
    if (visited.has(entry.slug)) return;
    if (visiting.has(entry.slug)) {
      throw new Error(`Circular package dependency involving "${entry.slug}"`);
    }
    visiting.add(entry.slug);
    for (const dep of entry.dependencies) {
      visit(dep);
    }
    visiting.delete(entry.slug);
    visited.add(entry.slug);
    ordered.push(entry);
  };

  for (const spec of requestedSpecs) {
    visit(spec);
  }
  return ordered;
}

async function fetchVerifiedPackageTarball(
  entry: RegistryPackageCatalogEntry,
  source: LoadedRegistrySource,
  fetchImpl: typeof fetch,
): Promise<{ bytes: Uint8Array; resolvedFrom: string }> {
  if (source.isLocalDirectory) {
    const localPath = checkedPath(realpathSync(source.baseLocation), entry.tarballPath, "file");
    const bytes = new Uint8Array(readFileSync(localPath));
    if (
      bytes.byteLength !== entry.tarballSize ||
      sha256Hex(bytes) !== entry.tarballSha256
    ) {
      throw new Error(`Tarball integrity mismatch for ${entry.slug} at ${localPath}`);
    }
    return { bytes, resolvedFrom: `local:${entry.tarballPath}` };
  }

  const candidateUrls = [
    `${source.baseLocation}/${entry.tarballPath}`,
    entry.r2MirrorTarballUrl,
    entry.githubTarballUrl,
  ].filter((u): u is string => Boolean(u));

  let lastErr: unknown;
  for (const url of new Set(candidateUrls)) {
    try {
      const resp = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.byteLength !== entry.tarballSize) {
        throw new Error(
          `Size mismatch (${bytes.byteLength} != ${entry.tarballSize})`,
        );
      }
      const actualSha = sha256Hex(bytes);
      if (actualSha !== entry.tarballSha256) {
        throw new Error(
          `SHA-256 mismatch (${actualSha} != ${entry.tarballSha256})`,
        );
      }
      return { bytes, resolvedFrom: url };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Failed to download verified tarball for ${entry.slug}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

function checkedPath(root: string, rel: string, kind: "file" | "directory"): string {
  const target = resolve(root, rel);
  const inside = relative(root, target);
  if (!inside || isAbsolute(inside) || inside.split(sep)[0] === "..") {
    throw new Error(`Path must stay inside ${root}: ${rel}`);
  }
  let current = root;
  for (const part of inside.split(sep)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !(current !== target || kind === "directory"
      ? stat.isDirectory()
      : stat.isFile())) {
      throw new Error(`Unexpected file type at ${current}`);
    }
  }
  return target;
}

function managedPackagePaths(slug: string, entry: {
  jsPackageName?: string;
  dartPackageName?: string;
}) {
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(slug)
    || (entry.jsPackageName !== undefined && !/^@pocket\/[a-z0-9_-]+$/.test(entry.jsPackageName))
    || (entry.dartPackageName !== undefined && !/^[a-z][a-z0-9_]*$/.test(entry.dartPackageName))) {
    throw new Error(`Invalid managed package identity: ${slug}`);
  }
  return {
    vendor: entry.jsPackageName ? `vendor/${slug.replaceAll("_", "-")}` : undefined,
    flutter: entry.dartPackageName ? `flutter/vendor_packages/${slug}` : undefined,
  };
}

function treeDigest(root: string): string | undefined {
  const hash = createHash("sha256");
  function visit(directory: string, prefix: string): boolean {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = prefix + name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        hash.update(JSON.stringify([rel, "directory", stat.mode & 0o777]));
        if (!visit(path, rel + "/")) return false;
      } else if (stat.isFile() && stat.nlink === 1) {
        hash.update(JSON.stringify([rel, "file", stat.mode & 0o777, sha256Hex(readFileSync(path))]));
      } else {
        return false;
      }
    }
    return true;
  }
  return visit(root, "") ? hash.digest("hex") : undefined;
}

function beginProjectChange(projectDir: string) {
  const mutex = join(projectDir, ".pocket-package-operation");
  try {
    mkdirSync(mutex, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`A Pocket package operation is already active in ${projectDir}`);
    }
    throw error;
  }
  const undo: Array<() => void> = [];

  function replace(target: string, source?: string) {
    const parent = dirname(target);
    function createParents(directory: string) {
      if (existsSync(directory)) return;
      createParents(dirname(directory));
      mkdirSync(directory);
      undo.push(() => rmdirSync(directory));
    }
    createParents(parent);
    const backup = join(mutex, randomUUID());
    const previous = lstatSync(target, { throwIfNoEntry: false });
    if (previous) renameSync(target, backup);
    undo.push(() => {
      rmSync(target, { recursive: true, force: true });
      if (previous) renameSync(backup, target);
    });
    if (source) renameSync(source, target);
  }

  return {
    mutex,
    replace,
    write(target: string, contents: string) {
      const source = join(mutex, randomUUID());
      const mode = lstatSync(target, { throwIfNoEntry: false })?.mode;
      writeFileSync(source, contents, { mode });
      replace(target, source);
    },
    finish(committed: boolean) {
      if (!committed) {
        const errors: unknown[] = [];
        for (const restore of undo.reverse()) {
          try {
            restore();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, `Package rollback failed. Backups are in ${mutex}`);
        }
      }
      rmSync(mutex, { recursive: true });
    },
  };
}

export function readProjectLockfile(projectDir: string): PocketLockfile {
  const lockPath = checkedPath(realpathSync(projectDir), "pocket-lock.json", "file");
  if (!existsSync(lockPath)) {
    return {
      schemaVersion: 1,
      kind: "pocket-package-lock",
      sdkVersion: SDK_VERSION,
      updatedAt: new Date().toISOString(),
      packages: {},
    };
  }
  const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as PocketLockfile;
  if (parsed.kind !== "pocket-package-lock" || parsed.schemaVersion !== 1
    || !parsed.packages || typeof parsed.packages !== "object" || Array.isArray(parsed.packages)) {
    throw new Error(`Invalid pocket-lock.json in ${projectDir}`);
  }
  for (const [slug, entry] of Object.entries(parsed.packages)) {
    if (!entry || typeof entry !== "object" || entry.slug !== slug) {
      throw new Error(`Invalid package lock entry: ${slug}`);
    }
    const managed = managedPackagePaths(slug, entry);
    if ((entry.vendorPath !== undefined && entry.vendorPath !== managed.vendor)
      || (entry.flutterPackagePath !== undefined && entry.flutterPackagePath !== managed.flutter)
      || (entry.dependencies && (!Array.isArray(entry.dependencies)
        || entry.dependencies.some((dep) => typeof dep !== "string")))) {
      throw new Error(`Invalid managed package metadata: ${slug}`);
    }
  }
  return parsed;
}

const IOS_USAGE_TEXTS: Record<string, string> = {
  NSBluetoothAlwaysUsageDescription:
    "This app uses Bluetooth only after the guest requests a nearby-device capability.",
  NSBluetoothPeripheralUsageDescription:
    "This app uses Bluetooth only after the guest requests a nearby-device capability.",
  NSCameraUsageDescription:
    "This app uses the camera only after the guest requests a camera capability.",
  NSPhotoLibraryAddUsageDescription:
    "This app saves guest-captured photos only after you allow photo access.",
  NSPhotoLibraryUsageDescription:
    "This app lists guest-captured photos only after you allow photo access.",
  NSMicrophoneUsageDescription:
    "This app uses the microphone only after the guest requests that capability.",
  NSLocationWhenInUseUsageDescription:
    "This app uses location only after the guest requests location or weather data.",
  NSFaceIDUsageDescription:
    "This app uses Face ID only after the guest requests biometric authentication.",
  NSMotionUsageDescription:
    "This app reads motion and barometer sensors only after the guest requests them.",
};

function syncFlutterHostFromInstalledPackages(
  projectDir: string,
  lock: PocketLockfile,
  indexBySlug: ReadonlyMap<string, RegistryPackageCatalogEntry>,
  change: ReturnType<typeof beginProjectChange>,
): { generatedDartFile?: string; updatedHostFiles: string[] } {
  const flutterDir = join(projectDir, "flutter");
  const pubspecPath = checkedPath(projectDir, "flutter/pubspec.yaml", "file");
  if (!existsSync(pubspecPath)) {
    return { updatedHostFiles: [] };
  }

  const updatedHostFiles: string[] = [];
  let pubspecText = readFileSync(pubspecPath, "utf8");

  const activeHostEntries: Array<{
    lockEntry: PocketLockPackageEntry;
    wiring: HostPluginWiringSpec;
  }> = [];

  for (const slug of Object.keys(lock.packages).sort()) {
    const lockEntry = lock.packages[slug]!;
    if (!lockEntry.dartPackageName || !lockEntry.flutterPackagePath) continue;

    const depName = lockEntry.dartPackageName;
    const relFromFlutter = relative(
      flutterDir,
      checkedPath(projectDir, lockEntry.flutterPackagePath, "directory"),
    ).replaceAll("\\", "/");

    if (!new RegExp(`^  ${depName}:`, "m").test(pubspecText)) {
      const before = pubspecText;
      pubspecText = pubspecText.replace(
        /(^dependencies:\n(?:  [^\n]+\n(?:    [^\n]+\n)*)*)/m,
        `$1  ${depName}:\n    path: ${relFromFlutter}\n`,
      );
      lockEntry.managedDartDependency = pubspecText !== before;
    } else if (lockEntry.managedDartDependency === undefined && lockEntry.flutterTreeSha256) {
      lockEntry.managedDartDependency = false;
    }

    const pluginJsonPath = checkedPath(
      projectDir,
      `${lockEntry.flutterPackagePath}/pocket-plugin.json`,
      "file",
    );
    let wiring: HostPluginWiringSpec | undefined;
    if (existsSync(pluginJsonPath)) {
      wiring = JSON.parse(
        readFileSync(pluginJsonPath, "utf8"),
      ) as HostPluginWiringSpec;
    } else {
      wiring = lockEntry.hostWiring ?? indexBySlug.get(slug)?.hostWiring;
    }
    if (wiring) {
      activeHostEntries.push({ lockEntry, wiring });
    }
  }

  change.write(pubspecPath, pubspecText);
  updatedHostFiles.push("flutter/pubspec.yaml");

  const imports = new Set<string>([
    "import 'package:pocket_sdk/pocket_sdk.dart';",
  ]);
  const factoryLines: string[] = [];
  const allPermissions = new Set<string>();
  const runtimePermissions = new Set<string>();
  const allCapabilities = new Set<string>();
  const androidPermNames = new Set<string>();
  const iosUsageKeys = new Set<string>();

  for (const { wiring } of activeHostEntries) {
    for (const p of wiring.permissions) allPermissions.add(p);
    for (const rp of wiring.runtimePermissions) runtimePermissions.add(rp);
    for (const c of wiring.capabilities) allCapabilities.add(c);
    for (const ap of wiring.androidPermissions) androidPermNames.add(ap);
    for (const ik of wiring.iosUsageKeys) iosUsageKeys.add(ik);
    if (wiring.factoryExpression) {
      imports.add(`import '${wiring.dartImport}';`);
      factoryLines.push(`  ${wiring.factoryExpression},`);
    }
  }

  const generatedDartRel = "flutter/lib/pocket_plugins.g.dart";
  const generatedDartAbs = checkedPath(projectDir, generatedDartRel, "file");
  const generatedSource = [
    "// GENERATED CODE - DO NOT MODIFY BY HAND.",
    "// Maintained automatically by `pocket add` / `pocket remove` from `pocket-lock.json`.",
    "",
    ...[...imports].sort(),
    "",
    `const Set<String> generatedPocketRuntimePermissions = <String>{${[...runtimePermissions].sort().map((p) => `'${p}'`).join(", ")}};`,
    "",
    `const Set<String> generatedPocketAllowedPermissions = <String>{${[...allPermissions].sort().map((p) => `'${p}'`).join(", ")}};`,
    "",
    `const Set<String> generatedPocketCapabilities = <String>{${[...allCapabilities].sort().map((c) => `'${c}'`).join(", ")}};`,
    "",
    `final List<PocketPluginFactory> generatedPocketPluginFactories = <PocketPluginFactory>[`,
    ...factoryLines,
    "];",
    "",
    "PocketAppConfig applyGeneratedPocketPlugins(PocketAppConfig config) {",
    "  return PocketAppConfig(",
    "    appId: config.appId,",
    "    bytecodeAsset: config.bytecodeAsset,",
    "    pakAsset: config.pakAsset,",
    "    metadataAsset: config.metadataAsset,",
    "    manifestAsset: config.manifestAsset,",
    "    updates: config.updates,",
    "    downloadOnOpen: config.downloadOnOpen,",
    "    showFps: config.showFps,",
    "    fontFamilyFallback: config.fontFamilyFallback,",
    "    keyboardInputEnabled: config.keyboardInputEnabled,",
    "    keyboardAutofocus: config.keyboardAutofocus,",
    "    keyboardButtonMap: config.keyboardButtonMap,",
    "    allowedPermissions: <String>{...config.allowedPermissions, ...generatedPocketAllowedPermissions},",
    "    pluginFactories: <PocketPluginFactory>[...config.pluginFactories, ...generatedPocketPluginFactories],",
    "    additionalCapabilities: config.additionalCapabilities,",
    "    recordingFactory: config.recordingFactory,",
    "    diagnostics: config.diagnostics,",
    "    compositorSurfaces: config.compositorSurfaces,",
    "    workerHttpOrigins: config.workerHttpOrigins,",
    "    offloadProviderFactory: config.offloadProviderFactory,",
    "    memoryLimits: config.memoryLimits,",
    "    bootstrapMetadataJson: config.bootstrapMetadataJson,",
    "    bootstrapManifestJson: config.bootstrapManifestJson,",
    "  );",
    "}",
    "",
  ].join("\n");
  change.write(generatedDartAbs, generatedSource);
  updatedHostFiles.push(generatedDartRel);

  const mainDartPath = checkedPath(projectDir, "flutter/lib/main.dart", "file");
  if (existsSync(mainDartPath)) {
    let mainDart = readFileSync(mainDartPath, "utf8");
    if (
      !mainDart.includes("pocket_plugins.g.dart") &&
      mainDart.includes("runApp(PocketApp(config: PocketAppConfig(")
    ) {
      mainDart = `import 'pocket_plugins.g.dart';\n${mainDart}`.replace(
        /runApp\(PocketApp\(config:\s*PocketAppConfig\(([\s\S]*?)\)\)\);/,
        "runApp(PocketApp(config: applyGeneratedPocketPlugins(PocketAppConfig($1))));",
      );
      change.write(mainDartPath, mainDart);
      updatedHostFiles.push("flutter/lib/main.dart");
    }
  }

  const prevManagedCaps = new Set(lock.managedCapabilities ?? []);
  const prevManagedPerms = new Set(lock.managedPermissions ?? []);
  lock.managedCapabilities = [];
  lock.managedPermissions = [];

  const manifestPath = checkedPath(projectDir, "manifest.json", "file");
  if (existsSync(manifestPath)) {
    const manifestDoc = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const capsObj =
      manifestDoc.capabilities && typeof manifestDoc.capabilities === "object"
        ? (manifestDoc.capabilities as Record<string, unknown>)
        : {};
    const userOptCaps = (Array.isArray(capsObj.optional)
      ? (capsObj.optional as string[])
      : []
    ).filter((c) => !prevManagedCaps.has(c));
    lock.managedCapabilities = [...allCapabilities].filter((c) => !userOptCaps.includes(c)).sort();
    manifestDoc.capabilities = {
      ...capsObj,
      optional: [...new Set([...userOptCaps, ...allCapabilities])].sort(),
    };

    const permsObj =
      manifestDoc.permissions && typeof manifestDoc.permissions === "object"
        ? (manifestDoc.permissions as Record<string, unknown>)
        : {};
    const userOptPerms = (Array.isArray(permsObj.optional)
      ? (permsObj.optional as string[])
      : []
    ).filter((p) => !prevManagedPerms.has(p));
    lock.managedPermissions = [...allPermissions].filter((p) => !userOptPerms.includes(p)).sort();
    manifestDoc.permissions = {
      ...permsObj,
      optional: [...new Set([...userOptPerms, ...allPermissions])].sort(),
    };
    change.write(manifestPath, JSON.stringify(manifestDoc, null, 2) + "\n");
    updatedHostFiles.push("manifest.json");
  }

  const androidManifestPath = checkedPath(projectDir, "flutter/android/app/src/main/AndroidManifest.xml", "file");
  if (existsSync(androidManifestPath)) {
    const origXml = readFileSync(androidManifestPath, "utf8");
    let xml = origXml.replace(
      /\r?\n?[ \t]*<!-- pocket:managed-permissions:start -->[\s\S]*?<!-- pocket:managed-permissions:end -->\r?\n?/g,
      "\n",
    );
    const additions = [...androidPermNames]
      .sort()
      .filter(
        (name) =>
          !new RegExp(`android:name=["']${name.replaceAll(".", "\\.")}['"]`).test(
            xml,
          ),
      );
    if (additions.length > 0) {
      const body = [
        "    <!-- pocket:managed-permissions:start -->",
        ...additions.map((name) => `    <uses-permission android:name="${name}" />`),
        "    <!-- pocket:managed-permissions:end -->",
      ].join("\n");
      xml = xml.replace(/\r?\n?\s*<\/manifest>\s*$/i, `\n${body}\n</manifest>\n`);
    } else {
      xml = xml.replace(/\r?\n?\s*<\/manifest>\s*$/i, "\n</manifest>\n");
    }
    if (xml !== origXml) {
      change.write(androidManifestPath, xml);
      updatedHostFiles.push("flutter/android/app/src/main/AndroidManifest.xml");
    }
  }

  const iosPlistPath = checkedPath(projectDir, "flutter/ios/Runner/Info.plist", "file");
  if (existsSync(iosPlistPath)) {
    const origPlist = readFileSync(iosPlistPath, "utf8");
    let plist = origPlist.replace(
      /\r?\n?[ \t]*<!-- pocket:managed-ios-usage:start -->[\s\S]*?<!-- pocket:managed-ios-usage:end -->\r?\n?/g,
      "\n",
    );
    const lines: string[] = [];
    for (const key of [...iosUsageKeys].sort()) {
      const desc = IOS_USAGE_TEXTS[key];
      if (!desc || new RegExp(`<key>${key}</key>`).test(plist)) continue;
      lines.push(`\t<key>${key}</key>\n\t<string>${desc}</string>`);
    }
    if (lines.length > 0) {
      const block = [
        "\t<!-- pocket:managed-ios-usage:start -->",
        ...lines,
        "\t<!-- pocket:managed-ios-usage:end -->",
      ].join("\n");
      plist = plist.replace(
        /\s*<\/dict>\s*<\/plist>\s*$/s,
        `\n${block}\n</dict>\n</plist>\n`,
      );
    } else {
      plist = plist.replace(/\s*<\/dict>\s*<\/plist>\s*$/s, "\n</dict>\n</plist>\n");
    }
    if (plist !== origPlist) {
      change.write(iosPlistPath, plist);
      updatedHostFiles.push("flutter/ios/Runner/Info.plist");
    }
  }

  return { generatedDartFile: generatedDartRel, updatedHostFiles };
}

export async function installProjectPackages(options: {
  projectDir: string;
  packages: readonly string[];
  registry?: string;
  sdkRoot?: string;
  cacheDir?: string;
  publicKeyPem?: string;
  allowUnsignedRemoteIndex?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{
  installed: PocketLockPackageEntry[];
  requiresHostRebuild: boolean;
  lockfilePath: string;
  generatedDartFile?: string;
  updatedFiles: string[];
}> {
  const projectDir = realpathSync(options.projectDir);
  if (!existsSync(join(projectDir, "package.json"))) {
    throw new Error(`Target directory has no package.json: ${projectDir}`);
  }
  if (options.packages.length === 0) {
    throw new Error("Specify at least one package name to install");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const loadedRegistry = await loadRegistryIndex({
    registry: options.registry,
    sdkRoot: options.sdkRoot,
    publicKeyPem: options.publicKeyPem,
    allowUnsignedRemoteIndex: options.allowUnsignedRemoteIndex,
    fetchImpl,
  });
  const directRequestedSlugs = new Set(
    options.packages
      .map((spec) => resolvePackageInCatalog(loadedRegistry.index, spec)?.slug)
      .filter((s): s is string => Boolean(s)),
  );

  const resolvedClosure = resolveDependencyClosure(
    loadedRegistry.index,
    options.packages,
  );
  const indexBySlug = new Map(
    loadedRegistry.index.packages.map((p) => [p.slug, p]),
  );

  const configuredCache = options.cacheDir ?? process.env.POCKET_PACKAGE_CACHE_DIR;
  const cacheRoot = configuredCache
    ? resolve(configuredCache)
    : checkedPath(projectDir, ".pocket-build/package-cache", "directory");
  const cacheStat = lstatSync(cacheRoot, { throwIfNoEntry: false });
  if (cacheStat && !cacheStat.isDirectory()) {
    throw new Error(`Invalid Pocket package cache directory: ${cacheRoot}`);
  }
  mkdirSync(cacheRoot, { recursive: true });
  const canonicalCacheRoot = realpathSync(cacheRoot);

  const change = beginProjectChange(projectDir);
  let committed = false;
  try {
    const lock = readProjectLockfile(projectDir);
    const pkgJsonPath = checkedPath(projectDir, "package.json", "file");
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    const dependencies =
      pkgJson.dependencies && typeof pkgJson.dependencies === "object"
        ? (pkgJson.dependencies as Record<string, string>)
        : {};
    const hasFlutterHost = existsSync(checkedPath(projectDir, "flutter/pubspec.yaml", "file"));
    const updatedFiles = new Set<string>();
    const newlyInstalled: PocketLockPackageEntry[] = [];
    const prepared: Array<{
      entry: RegistryPackageCatalogEntry;
      paths: ReturnType<typeof managedPackagePaths>;
      stageDir: string;
      resolvedFrom: string;
    }> = [];

    for (const entry of resolvedClosure) {
      const paths = managedPackagePaths(entry.slug, entry);
      if (!/^[a-f0-9]{64}$/.test(entry.tarballSha256)) {
        throw new Error(`Invalid archive digest for ${entry.slug}`);
      }
      const cachedArchive = checkedPath(canonicalCacheRoot, `${entry.tarballSha256}.tar.gz`, "file");
      let bytes: Uint8Array | undefined;
      let resolvedFrom = lock.packages[entry.slug]?.resolvedFrom ?? loadedRegistry.baseLocation;
      const cachedStat = lstatSync(cachedArchive, { throwIfNoEntry: false });
      if (cachedStat?.size === entry.tarballSize) {
        const cachedBytes = readFileSync(cachedArchive);
        if (sha256Hex(cachedBytes) === entry.tarballSha256) bytes = cachedBytes;
      }
      const cacheHit = bytes !== undefined;
      if (!bytes) {
        const downloaded = await fetchVerifiedPackageTarball(entry, loadedRegistry, fetchImpl);
        bytes = downloaded.bytes;
        resolvedFrom = downloaded.resolvedFrom;
      }

      const stageDir = mkdtempSync(join(change.mutex, "package-"));
      extractSafeTarGz(bytes, stageDir);
      if (!cacheHit) {
        const stageArchive = join(canonicalCacheRoot, `.${randomUUID()}.tar.gz`);
        try {
          writeFileSync(stageArchive, bytes, { flag: "wx" });
          renameSync(stageArchive, cachedArchive);
        } finally {
          rmSync(stageArchive, { force: true });
        }
      }

      prepared.push({ entry, paths, stageDir, resolvedFrom });
    }

    for (const { entry, paths, stageDir, resolvedFrom } of prepared) {
      const previous = lock.packages[entry.slug];
      function installTree(rel: string, source: string, previouslyOwnedDigest?: string) {
        const target = checkedPath(projectDir, rel, "directory");
        const incomingDigest = treeDigest(source);
        if (existsSync(target)) {
          const currentDigest = treeDigest(target);
          if (currentDigest && currentDigest === incomingDigest) {
            return previouslyOwnedDigest === currentDigest ? currentDigest : undefined;
          }
          if (!currentDigest || !previouslyOwnedDigest || currentDigest !== previouslyOwnedDigest) {
            if (previous?.tarballSha256 === entry.tarballSha256) return previouslyOwnedDigest;
            throw new Error(`Preserving existing package files in ${rel}; move them before installing ${entry.slug}`);
          }
        }
        change.replace(target, source);
        updatedFiles.add(rel);
        return incomingDigest;
      }

      const vendorRelPath = paths.vendor;
      let vendorTreeSha256: string | undefined;
      let managedJsDependency = previous?.managedJsDependency;
      if (vendorRelPath && entry.jsPackageName) {
        const vendorStage = join(change.mutex, randomUUID());
        cpSync(stageDir, vendorStage, { recursive: true });
        vendorTreeSha256 = installTree(vendorRelPath, vendorStage, previous?.vendorTreeSha256);
        if (dependencies[entry.jsPackageName] === undefined) {
          dependencies[entry.jsPackageName] = `file:${vendorRelPath}`;
          managedJsDependency = true;
        } else if (!previous?.vendorPath) {
          managedJsDependency = false;
        }
      }

      const flutterPackageRelPath = hasFlutterHost ? paths.flutter : undefined;
      let flutterTreeSha256: string | undefined;
      if (flutterPackageRelPath) {
        const flutterPkgAbs = checkedPath(projectDir, flutterPackageRelPath, "directory");
        const extractedPubspec = checkedPath(stageDir, "pubspec.yaml", "file");
        if (existsSync(extractedPubspec) && options.sdkRoot) {
          const sdkAbs = resolve(options.sdkRoot);
          const psText = readFileSync(extractedPubspec, "utf8").replace(
            /path:\s*\.\.\/(pocket_[a-z0-9_]+)/g,
            (_m, siblingSlug: string) => {
              const siblingVendor = checkedPath(projectDir, `flutter/vendor_packages/${siblingSlug}`, "directory");
              if (existsSync(siblingVendor) || resolvedClosure.some((r) => r.slug === siblingSlug)) {
                return `path: ../${siblingSlug}`;
              }
              const sdkPkg = join(sdkAbs, "packages", siblingSlug);
              if (existsSync(sdkPkg)) {
                return `path: ${relative(flutterPkgAbs, sdkPkg).replaceAll("\\", "/")}`;
              }
              return `path: ../${siblingSlug}`;
            },
          );
          writeFileSync(extractedPubspec, psText);
        }
        flutterTreeSha256 = installTree(flutterPackageRelPath, stageDir, previous?.flutterTreeSha256);
      }

      const lockEntry: PocketLockPackageEntry = {
        slug: entry.slug,
        version: entry.version,
        kind: entry.kind,
        ...(entry.jsPackageName ? { jsPackageName: entry.jsPackageName } : {}),
        ...(entry.dartPackageName ? { dartPackageName: entry.dartPackageName } : {}),
        ...(vendorRelPath ? { vendorPath: vendorRelPath } : {}),
        ...(flutterPackageRelPath ? { flutterPackagePath: flutterPackageRelPath } : {}),
        ...(vendorTreeSha256 ? { vendorTreeSha256 } : {}),
        ...(managedJsDependency !== undefined ? { managedJsDependency } : {}),
        ...(previous?.managedDartDependency !== undefined
          ? { managedDartDependency: previous.managedDartDependency }
          : {}),
        ...(flutterTreeSha256 ? { flutterTreeSha256 } : {}),
        tarballSha256: entry.tarballSha256,
        resolvedFrom,
        requiresHostRebuild: entry.requiresHostRebuild,
        direct: directRequestedSlugs.has(entry.slug) || lock.packages[entry.slug]?.direct === true,
        dependencies: entry.dependencies.map((spec) => resolvePackageInCatalog(loadedRegistry.index, spec)!.slug),
        ...(entry.hostWiring ? { hostWiring: entry.hostWiring } : {}),
      };

      lock.packages[entry.slug] = lockEntry;
      newlyInstalled.push(lockEntry);
    }

    pkgJson.dependencies = dependencies;
    change.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");

    const hostSync = syncFlutterHostFromInstalledPackages(
      projectDir,
      lock,
      indexBySlug,
      change,
    );
    for (const f of hostSync.updatedHostFiles) updatedFiles.add(f);

    lock.sdkVersion = SDK_VERSION;
    lock.updatedAt = new Date().toISOString();
    const lockfilePath = checkedPath(projectDir, "pocket-lock.json", "file");
    change.write(lockfilePath, JSON.stringify(lock, null, 2) + "\n");
    updatedFiles.add("pocket-lock.json");

    committed = true;
    return {
      installed: newlyInstalled,
      requiresHostRebuild: newlyInstalled.some((p) => p.requiresHostRebuild),
      lockfilePath,
      ...(hostSync.generatedDartFile
        ? { generatedDartFile: hostSync.generatedDartFile }
        : {}),
      updatedFiles: [...updatedFiles].sort(),
    };
  } finally {
    change.finish(committed);
  }
}

export function removeProjectPackages(options: {
  projectDir: string;
  packages: readonly string[];
}): {
  removed: string[];
  updatedFiles: string[];
} {
  const projectDir = realpathSync(options.projectDir);
  const change = beginProjectChange(projectDir);
  let committed = false;
  try {
    const lock = readProjectLockfile(projectDir);
    const pkgJsonPath = checkedPath(projectDir, "package.json", "file");
    const pkgJson = existsSync(pkgJsonPath)
      ? (JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<string, unknown>)
      : undefined;
    const dependencies =
      pkgJson?.dependencies && typeof pkgJson.dependencies === "object"
        ? (pkgJson.dependencies as Record<string, string>)
        : {};

    const removed: string[] = [];
    const updatedFiles = new Set<string>();

    const resolveInstalledSlug = (rawName: string) => {
      const q = rawName.trim().toLowerCase();
      return Object.keys(lock.packages).find((slug) => {
        const item = lock.packages[slug]!;
        return slug === q || item.jsPackageName?.toLowerCase() === q
          || item.dartPackageName?.toLowerCase() === q || slug.replace(/^pocket_/, "") === q;
      });
    };

    const requested = new Set<string>();
    for (const name of options.packages) {
      const slug = resolveInstalledSlug(name);
      if (!slug) continue;
      if (slug === "pocket_ui") {
        throw new Error("Core @pocket/ui package cannot be removed from a Pocket project");
      }
      requested.add(slug);
    }
    const reachable = new Set<string>();
    function visit(slug: string, root: string) {
      if (requested.has(slug)) {
        throw new Error(`Cannot remove ${slug}; it is required by ${root}`);
      }
      if (reachable.has(slug)) return;
      reachable.add(slug);
      for (const dependency of lock.packages[slug]!.dependencies ?? []) {
        const canonical = resolveInstalledSlug(dependency);
        if (canonical) visit(canonical, root);
      }
    }
    for (const [slug, item] of Object.entries(lock.packages)) {
      if (!requested.has(slug) && (item.direct !== false || slug === "pocket_ui")) visit(slug, slug);
    }
    const purge = new Set([
      ...requested,
      ...Object.keys(lock.packages).filter((slug) => !reachable.has(slug)),
    ]);

    function removeOwnedTree(rel: string, expectedDigest?: string) {
      const target = checkedPath(projectDir, rel, "directory");
      if (expectedDigest && existsSync(target) && treeDigest(target) === expectedDigest) {
        change.replace(target);
        updatedFiles.add(rel);
      }
    }

    for (const slug of purge) {
      const entry = lock.packages[slug]!;
      const paths = managedPackagePaths(slug, entry);
      if (entry.vendorPath && paths.vendor) {
        if (entry.managedJsDependency !== false) removeOwnedTree(paths.vendor, entry.vendorTreeSha256);
        if (entry.managedJsDependency !== false && entry.jsPackageName
          && dependencies[entry.jsPackageName] === `file:${paths.vendor}`) {
          delete dependencies[entry.jsPackageName];
          updatedFiles.add("package.json");
        }
      }
      if (entry.flutterPackagePath && paths.flutter && entry.dartPackageName) {
        if (entry.managedDartDependency !== false) removeOwnedTree(paths.flutter, entry.flutterTreeSha256);
        const pubspecPath = checkedPath(projectDir, "flutter/pubspec.yaml", "file");
        if (entry.managedDartDependency !== false && existsSync(pubspecPath)) {
          const pathFromFlutter = paths.flutter.slice("flutter/".length);
          const before = readFileSync(pubspecPath, "utf8");
          const managedDependency = new RegExp(`^  ${entry.dartPackageName}:\\r?\\n    path: ${pathFromFlutter}\\r?\\n`, "m");
          const cleaned = before.replace(managedDependency, "");
          if (cleaned !== before) {
            change.write(pubspecPath, cleaned);
            updatedFiles.add("flutter/pubspec.yaml");
          }
        }
      }
      delete lock.packages[slug];
      removed.push(slug);
    }

    if (pkgJson && updatedFiles.has("package.json")) {
      pkgJson.dependencies = dependencies;
      change.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
    }

    const hostSync = syncFlutterHostFromInstalledPackages(projectDir, lock, new Map(), change);
    for (const f of hostSync.updatedHostFiles) updatedFiles.add(f);

    lock.updatedAt = new Date().toISOString();
    change.write(
      checkedPath(projectDir, "pocket-lock.json", "file"),
      JSON.stringify(lock, null, 2) + "\n",
    );
    updatedFiles.add("pocket-lock.json");

    committed = true;
    return { removed, updatedFiles: [...updatedFiles].sort() };
  } finally {
    change.finish(committed);
  }
}
