/**
 * On-demand Pocket package resolver, dual-origin (Cloudflare R2 + GitHub)
 * verified tarball downloader, `pocket-lock.json` manager, and non-destructive
 * `flutter/lib/pocket_plugins.g.dart` host wiring engine.
 */

import { createHash, createPublicKey, randomUUID, verify as cryptoVerify } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { extractSafeTarGz } from "./install_studio.mjs";
import { SDK_VERSION } from "./prebuilt_tools.mjs";
import { POCKET_OFFICIAL_REGISTRY_PUBLIC_KEY_PEM } from "./registry_catalog.ts";
import {
  buildPackageRegistry,
  DEFAULT_GITHUB_REGISTRY_ORIGIN,
  DEFAULT_R2_REGISTRY_ORIGIN,
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
    if (existsSync(signedPath) && options.publicKeyPem) {
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
    options.publicKeyPem ??
    process.env.POCKET_REGISTRY_PUBLIC_KEY_PEM?.trim() ??
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

  if (!options.registry && options.sdkRoot && existsSync(join(options.sdkRoot, "packages"))) {
    const localBuildOut = join(options.sdkRoot, ".pocket-build", "local-registry");
    const built = buildPackageRegistry({
      sdkRoot: options.sdkRoot,
      outDir: localBuildOut,
    });
    return {
      index: built.index,
      baseLocation: localBuildOut,
      isLocalDirectory: true,
    };
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
    const localPath = join(source.baseLocation, entry.tarballPath);
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

export function readProjectLockfile(projectDir: string): PocketLockfile {
  const lockPath = join(projectDir, "pocket-lock.json");
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
  if (parsed.kind !== "pocket-package-lock") {
    throw new Error(`Invalid pocket-lock.json in ${projectDir}`);
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
): { generatedDartFile?: string; updatedHostFiles: string[] } {
  const flutterDir = join(projectDir, "flutter");
  if (!existsSync(join(flutterDir, "pubspec.yaml"))) {
    return { updatedHostFiles: [] };
  }

  const updatedHostFiles: string[] = [];
  const pubspecPath = join(flutterDir, "pubspec.yaml");
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
      realpathSync(flutterDir),
      realpathSync(join(projectDir, lockEntry.flutterPackagePath)),
    ).replaceAll("\\", "/");

    const existingDepRe = new RegExp(
      `(^  ${depName}:\\n    path:\\s*)([^\\n]+)`,
      "m",
    );
    if (existingDepRe.test(pubspecText)) {
      pubspecText = pubspecText.replace(existingDepRe, `$1${relFromFlutter}`);
    } else if (!new RegExp(`^  ${depName}:`, "m").test(pubspecText)) {
      pubspecText = pubspecText.replace(
        /(^dependencies:\n(?:  [^\n]+\n(?:    [^\n]+\n)*)*)/m,
        `$1  ${depName}:\n    path: ${relFromFlutter}\n`,
      );
    }

    const pluginJsonPath = join(
      projectDir,
      lockEntry.flutterPackagePath,
      "pocket-plugin.json",
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

  writeFileSync(pubspecPath, pubspecText);
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
  const generatedDartAbs = join(projectDir, generatedDartRel);
  mkdirSync(dirname(generatedDartAbs), { recursive: true });
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
  writeFileSync(generatedDartAbs, generatedSource);
  updatedHostFiles.push(generatedDartRel);

  const mainDartPath = join(flutterDir, "lib/main.dart");
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
      writeFileSync(mainDartPath, mainDart);
      updatedHostFiles.push("flutter/lib/main.dart");
    }
  }

  const prevManagedCaps = new Set(lock.managedCapabilities ?? []);
  const prevManagedPerms = new Set(lock.managedPermissions ?? []);
  lock.managedCapabilities = [...allCapabilities].sort();
  lock.managedPermissions = [...allPermissions].sort();

  const manifestPath = join(projectDir, "manifest.json");
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
    manifestDoc.permissions = {
      ...permsObj,
      optional: [...new Set([...userOptPerms, ...allPermissions])].sort(),
    };
    writeFileSync(manifestPath, JSON.stringify(manifestDoc, null, 2) + "\n");
    updatedHostFiles.push("manifest.json");
  }

  const androidManifestPath = join(
    flutterDir,
    "android/app/src/main/AndroidManifest.xml",
  );
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
      writeFileSync(androidManifestPath, xml);
      updatedHostFiles.push("flutter/android/app/src/main/AndroidManifest.xml");
    }
  }

  const iosPlistPath = join(flutterDir, "ios/Runner/Info.plist");
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
      writeFileSync(iosPlistPath, plist);
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
  const projectDir = resolve(options.projectDir);
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

  const cacheRoot = resolve(
    options.cacheDir ??
      process.env.POCKET_PACKAGE_CACHE_DIR ??
      join(projectDir, ".pocket-build", "package-cache"),
  );
  mkdirSync(cacheRoot, { recursive: true });

  const lock = readProjectLockfile(projectDir);
  const pkgJsonPath = join(projectDir, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<
    string,
    unknown
  >;
  const dependencies =
    pkgJson.dependencies && typeof pkgJson.dependencies === "object"
      ? (pkgJson.dependencies as Record<string, string>)
      : {};
  const hasFlutterHost = existsSync(join(projectDir, "flutter/pubspec.yaml"));
  const updatedFiles = new Set<string>();
  const newlyInstalled: PocketLockPackageEntry[] = [];

  for (const entry of resolvedClosure) {
    const cacheKey = `${entry.slug}-${entry.version}-${entry.tarballSha256.slice(0, 12)}`;
    const cachedPkgDir = join(cacheRoot, cacheKey);
    let resolvedFrom = loadedRegistry.baseLocation;

    if (!existsSync(join(cachedPkgDir, "provenance.json"))) {
      const downloaded = await fetchVerifiedPackageTarball(
        entry,
        loadedRegistry,
        fetchImpl,
      );
      resolvedFrom = downloaded.resolvedFrom;
      const stageDir = join(cacheRoot, `.stage-${cacheKey}-${randomUUID()}`);
      try {
        extractSafeTarGz(downloaded.bytes, stageDir);
        rmSync(cachedPkgDir, { recursive: true, force: true });
        renameSync(stageDir, cachedPkgDir);
      } finally {
        rmSync(stageDir, { recursive: true, force: true });
      }
    }

    let vendorRelPath: string | undefined;
    if (entry.jsPackageName) {
      const vendorDirName = entry.slug.replaceAll("_", "-");
      vendorRelPath = `vendor/${vendorDirName}`;
      const vendorAbs = join(projectDir, vendorRelPath);
      rmSync(vendorAbs, { recursive: true, force: true });
      mkdirSync(dirname(vendorAbs), { recursive: true });
      cpSync(cachedPkgDir, vendorAbs, { recursive: true, force: true });
      dependencies[entry.jsPackageName] = `file:${vendorRelPath}`;
      updatedFiles.add("package.json");
      updatedFiles.add(vendorRelPath);
    }

    let flutterPackageRelPath: string | undefined;
    if (entry.dartPackageName && hasFlutterHost) {
      // Rewrite intra-SDK ../pocket_* relative path dependencies inside extracted pubspec.yaml
      // so installed vendor_packages/<slug> resolves sibling vendor_packages/<dep> cleanly.
      flutterPackageRelPath = `flutter/vendor_packages/${entry.slug}`;
      const flutterPkgAbs = join(projectDir, flutterPackageRelPath);
      rmSync(flutterPkgAbs, { recursive: true, force: true });
      mkdirSync(dirname(flutterPkgAbs), { recursive: true });
      cpSync(cachedPkgDir, flutterPkgAbs, { recursive: true, force: true });

      const extractedPubspec = join(flutterPkgAbs, "pubspec.yaml");
      if (existsSync(extractedPubspec) && options.sdkRoot) {
        const sdkAbs = resolve(options.sdkRoot);
        let psText = readFileSync(extractedPubspec, "utf8");
        psText = psText.replace(
          /path:\s*\.\.\/(pocket_[a-z0-9_]+)/g,
          (_m, siblingSlug: string) => {
            const siblingVendor = join(
              projectDir,
              "flutter/vendor_packages",
              siblingSlug,
            );
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

      updatedFiles.add(flutterPackageRelPath);
    }

    const lockEntry: PocketLockPackageEntry = {
      slug: entry.slug,
      version: entry.version,
      kind: entry.kind,
      ...(entry.jsPackageName ? { jsPackageName: entry.jsPackageName } : {}),
      ...(entry.dartPackageName ? { dartPackageName: entry.dartPackageName } : {}),
      ...(vendorRelPath ? { vendorPath: vendorRelPath } : {}),
      ...(flutterPackageRelPath ? { flutterPackagePath: flutterPackageRelPath } : {}),
      tarballSha256: entry.tarballSha256,
      resolvedFrom,
      requiresHostRebuild: entry.requiresHostRebuild,
      direct: directRequestedSlugs.has(entry.slug) || lock.packages[entry.slug]?.direct === true,
      dependencies: [...entry.dependencies],
      ...(entry.hostWiring ? { hostWiring: entry.hostWiring } : {}),
    };

    lock.packages[entry.slug] = lockEntry;
    newlyInstalled.push(lockEntry);
  }

  pkgJson.dependencies = dependencies;
  writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");

  const hostSync = syncFlutterHostFromInstalledPackages(
    projectDir,
    lock,
    indexBySlug,
  );
  for (const f of hostSync.updatedHostFiles) updatedFiles.add(f);

  lock.sdkVersion = SDK_VERSION;
  lock.updatedAt = new Date().toISOString();
  const lockfilePath = join(projectDir, "pocket-lock.json");
  writeFileSync(lockfilePath, JSON.stringify(lock, null, 2) + "\n");
  updatedFiles.add("pocket-lock.json");

  return {
    installed: newlyInstalled,
    requiresHostRebuild: newlyInstalled.some((p) => p.requiresHostRebuild),
    lockfilePath,
    ...(hostSync.generatedDartFile
      ? { generatedDartFile: hostSync.generatedDartFile }
      : {}),
    updatedFiles: [...updatedFiles].sort(),
  };
}

export function removeProjectPackages(options: {
  projectDir: string;
  packages: readonly string[];
}): {
  removed: string[];
  updatedFiles: string[];
} {
  const projectDir = resolve(options.projectDir);
  const lock = readProjectLockfile(projectDir);
  const pkgJsonPath = join(projectDir, "package.json");
  const pkgJson = existsSync(pkgJsonPath)
    ? (JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<string, unknown>)
    : undefined;
  const dependencies =
    pkgJson?.dependencies && typeof pkgJson.dependencies === "object"
      ? (pkgJson.dependencies as Record<string, string>)
      : {};

  const removed: string[] = [];
  const updatedFiles = new Set<string>();

  const purgeSingleLockEntry = (matchSlug: string) => {
    const entry = lock.packages[matchSlug]!;
    if (entry.vendorPath) {
      rmSync(join(projectDir, entry.vendorPath), { recursive: true, force: true });
    }
    if (entry.jsPackageName && dependencies[entry.jsPackageName]) {
      delete dependencies[entry.jsPackageName];
      updatedFiles.add("package.json");
    }
    if (entry.flutterPackagePath) {
      rmSync(join(projectDir, entry.flutterPackagePath), {
        recursive: true,
        force: true,
      });
    }
    if (entry.dartPackageName) {
      const pubspecPath = join(projectDir, "flutter/pubspec.yaml");
      if (existsSync(pubspecPath)) {
        const cleaned = readFileSync(pubspecPath, "utf8").replace(
          new RegExp(`^  ${entry.dartPackageName}:\\n    path: [^\\n]+\\n`, "m"),
          "",
        );
        writeFileSync(pubspecPath, cleaned);
        updatedFiles.add("flutter/pubspec.yaml");
      }
    }
    delete lock.packages[matchSlug];
    removed.push(matchSlug);
  };

  for (const rawName of options.packages) {
    const q = rawName.trim().toLowerCase();
    const matchSlug = Object.keys(lock.packages).find((slug) => {
      const item = lock.packages[slug]!;
      return (
        slug.toLowerCase() === q ||
        item.jsPackageName?.toLowerCase() === q ||
        item.dartPackageName?.toLowerCase() === q ||
        slug.replace(/^pocket_/, "").toLowerCase() === q
      );
    });
    if (!matchSlug) continue;
    const entry = lock.packages[matchSlug]!;
    if (entry.slug === "pocket_ui") {
      throw new Error("Core @pocket/ui package cannot be removed from a Pocket project");
    }
    purgeSingleLockEntry(matchSlug);
  }

  // Prune transitive (direct === false) orphan packages no longer reachable from direct roots
  const reachable = new Set<string>();
  const walkReachable = (slug: string) => {
    if (reachable.has(slug)) return;
    const node = lock.packages[slug];
    if (!node) return;
    reachable.add(slug);
    for (const dep of node.dependencies ?? []) {
      walkReachable(dep);
    }
  };
  for (const [slug, item] of Object.entries(lock.packages)) {
    if (item.direct !== false) {
      walkReachable(slug);
    }
  }
  for (const slug of Object.keys(lock.packages)) {
    if (!reachable.has(slug) && lock.packages[slug]?.direct === false && slug !== "pocket_ui") {
      purgeSingleLockEntry(slug);
    }
  }

  if (pkgJson && updatedFiles.has("package.json")) {
    pkgJson.dependencies = dependencies;
    writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
  }

  const hostSync = syncFlutterHostFromInstalledPackages(
    projectDir,
    lock,
    new Map(),
  );
  for (const f of hostSync.updatedHostFiles) updatedFiles.add(f);

  lock.updatedAt = new Date().toISOString();
  writeFileSync(
    join(projectDir, "pocket-lock.json"),
    JSON.stringify(lock, null, 2) + "\n",
  );
  updatedFiles.add("pocket-lock.json");

  return { removed, updatedFiles: [...updatedFiles].sort() };
}
