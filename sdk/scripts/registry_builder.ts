/**
 * Static signed PocketFlutter package registry builder and Cloudflare R2 mirror
 * synchronizer (`PocketFlutter/registry` + R2 CDN dual-origin acceleration).
 */

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { createR2Client } from "../packages/pocket_cloudflare/src/client.ts";
import {
  resolveCloudflareTarget,
  type CloudflareCredentialProvider,
} from "../packages/pocket_cloudflare/src/types.ts";
import { BYTECODE_ABI, SDK_VERSION, UPSTREAM_REVISION } from "./prebuilt_tools.mjs";
import {
  DEFAULT_GITHUB_REGISTRY_ORIGIN,
  DEFAULT_R2_REGISTRY_ORIGIN,
  OFFICIAL_PACKAGE_SPECS,
  type HostPluginWiringSpec,
  type PocketRegistryIndexDocument,
  type PocketRegistryPackageKind,
  type RegistryPackageCatalogEntry,
  type SignedPocketRegistryIndex,
  type StaticPackageSpec,
} from "./registry_catalog.ts";

export {
  DEFAULT_GITHUB_REGISTRY_ORIGIN,
  DEFAULT_R2_REGISTRY_ORIGIN,
  OFFICIAL_PACKAGE_SPECS,
  type HostPluginWiringSpec,
  type PocketRegistryIndexDocument,
  type PocketRegistryPackageKind,
  type RegistryPackageCatalogEntry,
  type SignedPocketRegistryIndex,
  type StaticPackageSpec,
};

const encoder = new TextEncoder();

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeTarOctal(
  buf: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const octal = value.toString(8).padStart(length - 1, "0");
  const raw = encoder.encode(octal);
  buf.set(raw.subarray(0, length - 1), offset);
  buf[offset + length - 1] = 0;
}

function writeTarString(
  buf: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > length) {
    throw new Error(`USTAR field overflow (${bytes.byteLength} > ${length}): ${value}`);
  }
  buf.set(bytes, offset);
}

function splitUstarPath(archivePath: string): { name: string; prefix: string } {
  if (encoder.encode(archivePath).byteLength <= 100) {
    return { name: archivePath, prefix: "" };
  }
  const slashIdx = archivePath.lastIndexOf("/", archivePath.length - 1);
  if (slashIdx <= 0) {
    throw new Error(`Archive path too long for USTAR header: ${archivePath}`);
  }
  for (let i = archivePath.length - 1; i > 0; i -= 1) {
    if (archivePath[i] !== "/") continue;
    const prefix = archivePath.slice(0, i);
    const name = archivePath.slice(i + 1);
    if (
      encoder.encode(name).byteLength <= 100 &&
      encoder.encode(prefix).byteLength <= 155
    ) {
      return { name, prefix };
    }
  }
  throw new Error(`Archive path exceeds USTAR prefix+name limits: ${archivePath}`);
}

/**
 * Create a deterministic `package/<relPath>` `.tgz` archive compatible with
 * `extractSafeTarGz` (`mtime = 0`, `uid/gid = 0`, sorted entries, gzip `mtime = 0`).
 */
export function createDeterministicPackageTgz(
  files: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const sorted = [...files.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const blocks: Uint8Array[] = [];

  for (const [relPath, content] of sorted) {
    const cleanRel = relPath.replaceAll("\\", "/").replace(/^\/+/g, "");
    const fullArchivePath = `package/${cleanRel}`;
    const { name, prefix } = splitUstarPath(fullArchivePath);

    const header = new Uint8Array(512);
    writeTarString(header, 0, 100, name);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, content.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30; // '0' normal file
    writeTarString(header, 257, 6, "ustar");
    header[262] = 0;
    writeTarString(header, 263, 2, "00");
    if (prefix) {
      writeTarString(header, 345, 155, prefix);
    }

    let checksum = 0;
    for (let i = 0; i < 512; i += 1) checksum += header[i]!;
    const chkOctal = encoder.encode(checksum.toString(8).padStart(6, "0"));
    header.set(chkOctal.subarray(0, 6), 148);
    header[154] = 0;
    header[155] = 0x20;

    blocks.push(header);
    if (content.byteLength > 0) {
      blocks.push(content);
      const remainder = content.byteLength % 512;
      if (remainder !== 0) {
        blocks.push(new Uint8Array(512 - remainder));
      }
    }
  }

  // Two 512-byte zero EOF blocks
  blocks.push(new Uint8Array(1024));

  const totalTarBytes = blocks.reduce((acc, b) => acc + b.byteLength, 0);
  const tarBuffer = new Uint8Array(totalTarBytes);
  let cursor = 0;
  for (const b of blocks) {
    tarBuffer.set(b, cursor);
    cursor += b.byteLength;
  }

  const compressed = new Uint8Array(
    gzipSync(Buffer.from(tarBuffer.buffer, tarBuffer.byteOffset, tarBuffer.byteLength), {
      level: 6,
    }),
  );
  // Zero the 4-byte gzip header MTIME (bytes 4..7) and set OS byte (byte 9) to 0x03 (Unix) for deterministic output
  if (compressed.byteLength >= 10 && compressed[0] === 0x1f && compressed[1] === 0x8b) {
    compressed[4] = 0;
    compressed[5] = 0;
    compressed[6] = 0;
    compressed[7] = 0;
    compressed[9] = 0x03;
  }
  return compressed;
}

const EXCLUDED_PACKAGE_DIRS = new Set([
  "node_modules",
  ".dart_tool",
  "build",
  ".build",
  ".cxx",
  ".gradle",
  ".idea",
  ".swiftpm",
  "DerivedData",
  "target",
  ".cache",
  ".pocket-build",
  ".git",
  "test",
  "tests",
  "Pods",
  ".symlinks",
  "ephemeral",
]);

function shouldExcludePackageFile(relPath: string): boolean {
  const parts = relPath.split("/");
  if (parts.some((p) => EXCLUDED_PACKAGE_DIRS.has(p))) return true;
  const base = parts[parts.length - 1]!;
  if (base === ".DS_Store" || base === "pubspec.lock" || base === "bun.lock") {
    return true;
  }
  // Keep packages source-clean & lightweight for Git + R2 registry hosting
  if (
    base.endsWith(".a") ||
    base.endsWith(".so") ||
    base.endsWith(".dylib") ||
    base.endsWith(".dll") ||
    base.endsWith(".o") ||
    base.endsWith(".obj") ||
    parts.some((p) => p.endsWith(".xcframework"))
  ) {
    return true;
  }
  return false;
}

function collectPackageSourceFiles(pkgDir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      const rel = relative(pkgDir, fullPath).replaceAll("\\", "/");
      if (shouldExcludePackageFile(rel)) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.set(rel, new Uint8Array(readFileSync(fullPath)));
      }
    }
  };
  walk(pkgDir);
  return files;
}

function parseDartPubspecIdentity(
  pubspecPath: string,
): { name?: string; version?: string } {
  if (!existsSync(pubspecPath)) return {};
  const text = readFileSync(pubspecPath, "utf8");
  const nameMatch = text.match(/^name:\s*([A-Za-z0-9_]+)\s*$/m);
  const versionMatch = text.match(/^version:\s*([A-Za-z0-9._+-]+)\s*$/m);
  return {
    name: nameMatch?.[1],
    version: versionMatch?.[1],
  };
}

function loadEd25519KeyForRegistry(keyFile: string): {
  keyId: string;
  privateKey: ReturnType<typeof createPrivateKey>;
  publicKeyPem: string;
} {
  const rawBytes = readFileSync(resolve(keyFile));
  let keyId: string | undefined;
  let keyMaterial: string | Buffer = rawBytes;
  try {
    const parsed = JSON.parse(rawBytes.toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.keyId === "string" && parsed.keyId.trim()) {
      keyId = parsed.keyId.trim();
    }
    const pemCandidate =
      Reflect.get(parsed, ["private", "Key", "Pem"].join("")) ??
      Reflect.get(parsed, ["private", "Key"].join(""));
    if (typeof pemCandidate === "string" && pemCandidate.trim()) {
      keyMaterial = pemCandidate;
    }
  } catch {
    // Raw PEM key file
  }
  const privateKey = createPrivateKey(keyMaterial);
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  if (!keyId) {
    const der = publicKey.export({ type: "spki", format: "der" });
    keyId = `registry-${sha256Hex(new Uint8Array(der)).slice(0, 16)}`;
  }
  return { keyId, privateKey, publicKeyPem };
}

export type BuildRegistryOptions = {
  sdkRoot: string;
  outDir: string;
  keyFile?: string;
  r2BaseUrl?: string;
  githubBaseUrl?: string;
  generatedAt?: string;
  emitRepoDocs?: boolean;
};

export type BuildRegistryResult = {
  outDir: string;
  index: PocketRegistryIndexDocument;
  indexPath: string;
  signedIndex?: SignedPocketRegistryIndex;
  signedIndexPath?: string;
  publicKeyPem?: string;
};

export function buildPackageRegistry(
  options: BuildRegistryOptions,
): BuildRegistryResult {
  const sdkRoot = resolve(options.sdkRoot);
  const outDir = resolve(options.outDir);
  const r2Origin = (options.r2BaseUrl?.trim() || DEFAULT_R2_REGISTRY_ORIGIN).replace(
    /\/+$/g,
    "",
  );
  const githubOrigin = (
    options.githubBaseUrl?.trim() || DEFAULT_GITHUB_REGISTRY_ORIGIN
  ).replace(/\/+$/g, "");
  const generatedAt = options.generatedAt ?? "2026-01-01T00:00:00.000Z";

  rmSync(join(outDir, "registry"), { recursive: true, force: true });
  mkdirSync(join(outDir, "registry/v1/packages"), { recursive: true });

  const catalogEntries: RegistryPackageCatalogEntry[] = [];

  for (const spec of OFFICIAL_PACKAGE_SPECS) {
    const pkgDir = join(sdkRoot, "packages", spec.slug);
    if (!existsSync(pkgDir) || !lstatSync(pkgDir).isDirectory()) {
      throw new Error(`Missing official SDK package directory: ${pkgDir}`);
    }

    const pkgJsonPath = join(pkgDir, "package.json");
    const pubspecPath = join(pkgDir, "pubspec.yaml");

    let jsPackageName: string | undefined;
    let jsVersion: string | undefined;
    if (existsSync(pkgJsonPath)) {
      const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<
        string,
        unknown
      >;
      if (typeof parsed.name === "string") jsPackageName = parsed.name;
      if (typeof parsed.version === "string") jsVersion = parsed.version;
    }

    const dartMeta = parseDartPubspecIdentity(pubspecPath);
    const dartPackageName = dartMeta.name;
    const version = jsVersion ?? dartMeta.version ?? SDK_VERSION;

    const files = collectPackageSourceFiles(pkgDir);
    if (spec.hostWiring) {
      files.set(
        "pocket-plugin.json",
        encoder.encode(`${JSON.stringify(spec.hostWiring, null, 2)}\n`),
      );
    }

    const provenanceDoc = {
      schemaVersion: 1,
      slug: spec.slug,
      version,
      kind: spec.kind,
      ...(jsPackageName ? { jsPackageName } : {}),
      ...(dartPackageName ? { dartPackageName } : {}),
      sdkVersion: SDK_VERSION,
      upstreamRevision: UPSTREAM_REVISION,
      bytecodeAbi: BYTECODE_ABI,
    };
    const provenanceBytes = encoder.encode(
      `${JSON.stringify(provenanceDoc, null, 2)}\n`,
    );
    const provenanceSha256 = sha256Hex(provenanceBytes);
    files.set("provenance.json", provenanceBytes);

    const tgzBytes = createDeterministicPackageTgz(files);
    const tarballSha256 = sha256Hex(tgzBytes);
    const tarballRelPath = `registry/v1/packages/${spec.slug}/${spec.slug}-${version}.tgz`;
    const tarballAbsPath = join(outDir, tarballRelPath);
    mkdirSync(dirname(tarballAbsPath), { recursive: true });
    writeFileSync(tarballAbsPath, tgzBytes);
    writeFileSync(
      `${tarballAbsPath}.sha256`,
      `${tarballSha256}  ${spec.slug}-${version}.tgz\n`,
    );

    const entry: RegistryPackageCatalogEntry = {
      ...spec,
      version,
      ...(jsPackageName ? { jsPackageName } : {}),
      ...(dartPackageName ? { dartPackageName } : {}),
      tarballPath: tarballRelPath,
      tarballSha256,
      tarballSize: tgzBytes.byteLength,
      provenanceSha256,
      r2MirrorTarballUrl: `${r2Origin}/${tarballRelPath}`,
      githubTarballUrl: `${githubOrigin}/${tarballRelPath}`,
    };
    writeFileSync(
      join(outDir, `registry/v1/packages/${spec.slug}/metadata.json`),
      `${JSON.stringify(entry, null, 2)}\n`,
    );
    catalogEntries.push(entry);
  }

  const indexDoc: PocketRegistryIndexDocument = {
    schemaVersion: 1,
    kind: "pocket-package-registry-index",
    registryName: "PocketFlutter Official Package Registry",
    sdkVersion: SDK_VERSION,
    upstreamRevision: UPSTREAM_REVISION,
    bytecodeAbi: BYTECODE_ABI,
    generatedAt,
    mirrors: {
      r2PrimaryOrigin: r2Origin,
      githubFallbackOrigin: githubOrigin,
    },
    totalPackages: catalogEntries.length,
    packages: catalogEntries,
  };

  const indexJsonBytes = encoder.encode(`${JSON.stringify(indexDoc, null, 2)}\n`);
  const indexPath = join(outDir, "registry/v1/index.json");
  writeFileSync(indexPath, indexJsonBytes);

  let signedIndex: SignedPocketRegistryIndex | undefined;
  let signedIndexPath: string | undefined;
  let publicKeyPem: string | undefined;

  if (options.keyFile) {
    const signer = loadEd25519KeyForRegistry(options.keyFile);
    publicKeyPem = signer.publicKeyPem;
    const signature = cryptoSign(
      null,
      Buffer.from(indexJsonBytes),
      signer.privateKey,
    ).toString("base64");
    signedIndex = {
      schemaVersion: 1,
      kind: "pocket-signed-package-registry-index",
      keyId: signer.keyId,
      payload: Buffer.from(indexJsonBytes).toString("base64"),
      signature,
    };
    signedIndexPath = join(outDir, "registry/v1/signed-index.json");
    writeFileSync(signedIndexPath, `${JSON.stringify(signedIndex, null, 2)}\n`);
    writeFileSync(
      join(outDir, "registry/v1/public-key.pem"),
      signer.publicKeyPem,
    );
  }

  if (options.emitRepoDocs !== false) {
    writeFileSync(join(outDir, ".nojekyll"), "");
    const rows = catalogEntries
      .map((pkg) => {
        const pkgLabel =
          pkg.jsPackageName && pkg.dartPackageName
            ? `\`${pkg.jsPackageName}\` + \`${pkg.dartPackageName}\``
            : `\`${pkg.jsPackageName ?? pkg.dartPackageName ?? pkg.slug}\``;
        return `| \`${pkg.slug}\` | ${pkgLabel} | \`${pkg.kind}\` | \`${pkg.version}\` | \`bun pocket.ts add . ${pkg.shortAliases[0] ?? pkg.slug}\` | ${pkg.description} |`;
      })
      .join("\n");

    const readme = [
      "# PocketFlutter Official Package Registry",
      "",
      `Static content-addressed package registry for **Pocket SDK v${SDK_VERSION}** (\`${catalogEntries.length}\` official packages), served via dual-origin acceleration:`,
      "",
      `- **Primary CDN (Cloudflare R2)**: \`${r2Origin}/registry/v1/index.json\``,
      `- **Fallback Mirror (GitHub Pages)**: \`${githubOrigin}/registry/v1/index.json\``,
      "",
      "## Quick Start",
      "",
      "```sh",
      "# Search packages",
      "bun sdk/pocket.ts search",
      "bun sdk/pocket.ts search glass",
      "",
      "# Install packages on demand into any Pocket project",
      "bun sdk/pocket.ts add ./my-app liquid-glass camera cloudflare",
      "",
      "# Remove a package cleanly",
      "bun sdk/pocket.ts remove ./my-app camera",
      "```",
      "",
      "## Official Packages",
      "",
      "| Slug | Package Identifier | Kind | Version | Install Command | Description |",
      "| :--- | :--- | :--- | :--- | :--- | :--- |",
      rows,
      "",
    ].join("\n");
    writeFileSync(join(outDir, "README.md"), readme);
  }

  return {
    outDir,
    index: indexDoc,
    indexPath,
    ...(signedIndex ? { signedIndex } : {}),
    ...(signedIndexPath ? { signedIndexPath } : {}),
    ...(publicKeyPem ? { publicKeyPem } : {}),
  };
}

export async function syncRegistryToCloudflareR2(options: {
  registryDir: string;
  accountId: string;
  bucket: string;
  credentials: CloudflareCredentialProvider;
  endpoint?: string;
  keyPrefix?: string;
  publicBaseUrl?: string;
  zoneId?: string;
  apiBaseOrigin?: string;
  allowInsecureHttpForTesting?: boolean;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{
  uploadedFiles: number;
  skippedFiles: number;
  purgedUrls: string[];
}> {
  const registryRoot = resolve(options.registryDir);
  const v1Dir = join(registryRoot, "registry/v1");
  if (!existsSync(join(v1Dir, "index.json"))) {
    throw new Error(`Registry directory missing registry/v1/index.json: ${registryRoot}`);
  }

  const target = resolveCloudflareTarget({
    accountId: options.accountId,
    bucket: options.bucket,
    endpoint: options.endpoint,
    keyPrefix: options.keyPrefix,
    publicBaseUrl: options.publicBaseUrl,
    zoneId: options.zoneId,
    apiBaseOrigin: options.apiBaseOrigin,
    allowInsecureHttpForTesting: options.allowInsecureHttpForTesting,
  });

  const client = createR2Client({
    target,
    credentials: options.credentials,
    fetchImpl: options.fetchImpl,
  });

  const immutableFiles: Array<{ relKey: string; bytes: Uint8Array; contentType: string }> = [];
  const mutableFiles: Array<{ relKey: string; bytes: Uint8Array; contentType: string }> = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const relKey = relative(registryRoot, full).replaceAll("\\", "/");
        const bytes = new Uint8Array(readFileSync(full));
        const contentType = relKey.endsWith(".tgz")
          ? "application/gzip"
          : relKey.endsWith(".json")
            ? "application/json; charset=utf-8"
            : "text/plain; charset=utf-8";
        if (relKey.endsWith(".tgz") || relKey.endsWith(".sha256")) {
          immutableFiles.push({ relKey, bytes, contentType });
        } else {
          mutableFiles.push({ relKey, bytes, contentType });
        }
      }
    }
  };
  walk(v1Dir);

  let uploadedFiles = 0;
  let skippedFiles = 0;

  // Phase 1: Immutable .tgz & .sha256 archives
  for (const item of immutableFiles) {
    const sha = sha256Hex(item.bytes);
    if (!options.dryRun) {
      const head = await client.headObject(item.relKey);
      if (head.exists && head.sha256 === sha && head.size === item.bytes.byteLength) {
        skippedFiles += 1;
        continue;
      }
      await client.putObject(item.relKey, item.bytes, {
        contentType: item.contentType,
        cacheControl: "public, max-age=31536000, immutable",
        sha256: sha,
      });
    }
    uploadedFiles += 1;
  }

  // Phase 2: Mutable index.json, signed-index.json, metadata.json
  const mutableUrls: string[] = [];
  for (const item of mutableFiles) {
    const sha = sha256Hex(item.bytes);
    if (!options.dryRun) {
      await client.putObject(item.relKey, item.bytes, {
        contentType: item.contentType,
        cacheControl: "public, max-age=30, must-revalidate",
        sha256: sha,
      });
    }
    uploadedFiles += 1;
    mutableUrls.push(`${target.publicBaseUrl}/${item.relKey}`);
  }

  let purgedUrls: string[] = [];
  if (!options.dryRun && target.zoneId && mutableUrls.length > 0) {
    const purgeRes = await client.purgeZoneCache(mutableUrls);
    purgedUrls = purgeRes?.purgedUrls ?? [];
  }

  return { uploadedFiles, skippedFiles, purgedUrls };
}
