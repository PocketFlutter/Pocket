import { createPrivateKey, createPublicKey, randomUUID, sign as cryptoSign } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";

import type { PublishedVersion } from "../../../editor/version_store.ts";
import {
  verifySignedManifest,
  type PocketUpdatePayload,
  type SignedManifest,
} from "../../../scripts/package_update.ts";
import type { R2Client } from "./client.ts";
import { sha256Hex } from "./sign.ts";
import {
  buildPlatformEndpointsDocument,
  targetMatchesPlatform,
  validateCloudflareRouteMatrix,
  type CloudflareConcretePlatform,
  type CloudflareMatrixPublishResult,
  type CloudflarePublishFileRecord,
  type CloudflarePurgeSummary,
  type CloudflareStudioPublishSummary,
  type CloudflareStudioTargetSummary,
  type CloudflareTargetPublishResult,
  type CloudflareUploadProgress,
  type NativeDownloadManifestPayload,
  type NativeInstallerInput,
  type NativeInstallerRecord,
  type PlatformEndpointsDocument,
  type SignedNativeDownloadManifest,
} from "./types.ts";

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const MUTABLE_CACHE_CONTROL = "no-cache, no-store, must-revalidate";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function normalizePublicKeyPem(publicKey: string | Buffer): string | Buffer {
  if (Buffer.isBuffer(publicKey)) return publicKey;
  const trimmed = publicKey.trim();
  if (trimmed.startsWith("-----BEGIN")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as {
      publicKeyPem?: unknown;
      publicKeyBase64?: unknown;
    };
    if (typeof parsed.publicKeyPem === "string" && parsed.publicKeyPem.trim()) {
      return parsed.publicKeyPem.trim();
    }
    if (typeof parsed.publicKeyBase64 === "string" && parsed.publicKeyBase64.trim()) {
      const raw = Buffer.from(parsed.publicKeyBase64.trim(), "base64");
      if (raw.byteLength === 32) {
        return createPublicKey({
          key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
          format: "der",
          type: "spki",
        })
          .export({ format: "pem", type: "spki" })
          .toString();
      }
    }
  } catch {
    // Check raw 32-byte base64 public key next.
  }
  const raw = Buffer.from(trimmed, "base64");
  if (raw.byteLength === 32) {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    })
      .export({ format: "pem", type: "spki" })
      .toString();
  }
  return trimmed;
}

function readVerifiedRegularFile(filePath: string, label: string): Uint8Array {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new Error(`Missing required file (${label}): ${filePath}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`File must be a regular non-symlink file (${label}): ${filePath}`);
  }
  return new Uint8Array(readFileSync(filePath));
}

function checkEndpointsOutputPath(path: string): void {
  let current = path;
  while (true) {
    try {
      const stat = lstatSync(current);
      if (current === path ? !stat.isFile() : !stat.isDirectory()) {
        throw new Error(`Invalid endpoint asset path: ${current} must be a regular non-symlink ${current === path ? "file" : "directory"}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function writeEndpointsDocument(path: string, document: PlatformEndpointsDocument): void {
  checkEndpointsOutputPath(path);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.pocket-endpoints-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, JSON.stringify(document, null, 2) + "\n", { flag: "wx" });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function relativePublicObjectUrl(indexKey: string, objectKey: string): string {
  return posix.relative(posix.dirname(indexKey), objectKey)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

function inferContentType(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".7z")) return "application/x-7z-compressed";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".apk")) return "application/vnd.android.package-archive";
  if (lower.endsWith(".ipa")) return "application/octet-stream";
  if (lower.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (lower.endsWith(".msix")) return "application/msix";
  if (lower.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  return "application/octet-stream";
}

export type VerifiedCloudflarePackage = {
  packageDir: string;
  envelope: SignedManifest;
  envelopeBytes: Uint8Array;
  payload: PocketUpdatePayload;
  payloadBytes: Uint8Array;
  payloadSha256: string;
  rawHostDescriptor?: Record<string, unknown>;
  immutableFiles: Array<{
    relativePath: string;
    filePath: string;
    bytes: Uint8Array;
    size: number;
    sha256: string;
    contentType: string;
    deduplicate: boolean;
  }>;
  mutableFiles: Array<{
    relativePath: string;
    filePath: string;
    bytes: Uint8Array;
    size: number;
    sha256: string;
    contentType: string;
  }>;
};

export function verifyLocalPackageForCloudflare(
  packageDir: string,
  publicKey?: string | Buffer,
): VerifiedCloudflarePackage {
  const resolvedDir = resolve(packageDir);
  let dirStat: ReturnType<typeof lstatSync>;
  try {
    dirStat = lstatSync(resolvedDir);
  } catch {
    throw new Error(`Package directory does not exist: ${resolvedDir}`);
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(
      `Package directory must be a real non-symlink directory: ${resolvedDir}`,
    );
  }

  const latestPath = join(resolvedDir, "latest.json");
  const latestBytes = readVerifiedRegularFile(latestPath, "latest.json");
  let envelope: SignedManifest;
  try {
    envelope = JSON.parse(new TextDecoder().decode(latestBytes)) as SignedManifest;
  } catch {
    throw new Error(`Invalid JSON in latest.json: ${latestPath}`);
  }
  if (
    !envelope ||
    typeof envelope.keyId !== "string" ||
    !envelope.keyId ||
    typeof envelope.payload !== "string" ||
    !envelope.payload ||
    typeof envelope.signature !== "string" ||
    !envelope.signature
  ) {
    throw new Error(`Malformed signed manifest envelope in ${latestPath}`);
  }

  const envelopePayloadBytes = new Uint8Array(Buffer.from(envelope.payload, "base64"));
  if (publicKey !== undefined) {
    verifySignedManifest(envelope, normalizePublicKeyPem(publicKey));
  }

  const payloadPath = join(resolvedDir, "payload.json");
  const payloadBytes = existsSync(payloadPath)
    ? readVerifiedRegularFile(payloadPath, "payload.json")
    : envelopePayloadBytes;

  if (
    payloadBytes.byteLength !== envelopePayloadBytes.byteLength ||
    sha256Hex(payloadBytes) !== sha256Hex(envelopePayloadBytes)
  ) {
    throw new Error("payload.json bytes do not match signed latest.json envelope payload");
  }

  const signedManifestPath = join(resolvedDir, "signed-manifest.json");
  if (existsSync(signedManifestPath)) {
    const smBytes = readVerifiedRegularFile(signedManifestPath, "signed-manifest.json");
    const smEnvelope = JSON.parse(
      new TextDecoder().decode(smBytes),
    ) as SignedManifest;
    if (
      smEnvelope.payload !== envelope.payload ||
      smEnvelope.signature !== envelope.signature ||
      smEnvelope.keyId !== envelope.keyId
    ) {
      throw new Error("signed-manifest.json does not match latest.json");
    }
  }

  let payload: PocketUpdatePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as PocketUpdatePayload;
  } catch {
    throw new Error(`Invalid payload JSON in ${resolvedDir}`);
  }
  if (
    !payload ||
    payload.schemaVersion !== 1 ||
    typeof payload.appId !== "string" ||
    !Array.isArray(payload.files)
  ) {
    throw new Error(`Invalid PocketUpdatePayload in ${resolvedDir}`);
  }

  const blobsDir = join(resolvedDir, "blobs");
  if (existsSync(blobsDir) && lstatSync(blobsDir).isSymbolicLink()) {
    throw new Error(`Package blobs directory must not be a symlink: ${blobsDir}`);
  }

  const immutableFiles: VerifiedCloudflarePackage["immutableFiles"] = [];
  for (const file of payload.files) {
    if (
      !file ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      typeof file.url !== "string" ||
      file.url !== `blobs/${file.sha256}` ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      throw new Error(`Invalid content file entry in payload: ${JSON.stringify(file)}`);
    }
    const blobPath = join(resolvedDir, file.url);
    const bytes = readVerifiedRegularFile(blobPath, file.url);
    if (bytes.byteLength !== file.size) {
      throw new Error(
        `Blob size mismatch for ${file.url}: expected ${file.size}, got ${bytes.byteLength}`,
      );
    }
    const actualSha = sha256Hex(bytes);
    if (actualSha !== file.sha256) {
      throw new Error(
        `Blob SHA-256 mismatch for ${file.url}: expected ${file.sha256}, got ${actualSha}`,
      );
    }
    immutableFiles.push({
      relativePath: file.url,
      filePath: blobPath,
      bytes,
      size: bytes.byteLength,
      sha256: actualSha,
      contentType: "application/octet-stream",
      deduplicate: true,
    });
  }

  if (payload.bundle) {
    const b = payload.bundle;
    const expectedUrl = `bundles/bundle-${b.sha256}.${b.format}`;
    if (
      (b.format !== "7z" && b.format !== "zip") ||
      !/^[0-9a-f]{64}$/.test(b.sha256) ||
      b.url !== expectedUrl ||
      !Number.isSafeInteger(b.size) ||
      b.size <= 0
    ) {
      throw new Error(`Invalid bundle descriptor in payload: ${JSON.stringify(b)}`);
    }
    const bundlesDir = join(resolvedDir, "bundles");
    if (existsSync(bundlesDir) && lstatSync(bundlesDir).isSymbolicLink()) {
      throw new Error(`Package bundles directory must not be a symlink: ${bundlesDir}`);
    }
    const bundlePath = join(resolvedDir, b.url);
    const bytes = readVerifiedRegularFile(bundlePath, b.url);
    if (bytes.byteLength !== b.size || sha256Hex(bytes) !== b.sha256) {
      throw new Error(`Bundle integrity mismatch for ${b.url}`);
    }
    immutableFiles.push({
      relativePath: b.url,
      filePath: bundlePath,
      bytes,
      size: bytes.byteLength,
      sha256: b.sha256,
      contentType: inferContentType(b.url),
      deduplicate: true,
    });
  }

  const bootstrapDir = join(resolvedDir, "bootstrap");
  if (existsSync(bootstrapDir)) {
    const bStat = lstatSync(bootstrapDir);
    if (bStat.isSymbolicLink() || !bStat.isDirectory()) {
      throw new Error(`Package bootstrap path must be a regular directory: ${bootstrapDir}`);
    }
    const entries = readdirSync(bootstrapDir).sort();
    for (const name of entries) {
      const rel = `bootstrap/${name}`;
      const fp = join(bootstrapDir, name);
      const bytes = readVerifiedRegularFile(fp, rel);
      immutableFiles.push({
        relativePath: rel,
        filePath: fp,
        bytes,
        size: bytes.byteLength,
        sha256: sha256Hex(bytes),
        contentType: inferContentType(rel),
        deduplicate: false,
      });
    }
  }

  const mutableFiles: VerifiedCloudflarePackage["mutableFiles"] = [];
  for (const bundleAlias of ["bundle.7z", "bundle.zip"]) {
    const aliasPath = join(resolvedDir, bundleAlias);
    if (existsSync(aliasPath)) {
      const bytes = readVerifiedRegularFile(aliasPath, bundleAlias);
      if (payload.bundle && bundleAlias === `bundle.${payload.bundle.format}`) {
        if (
          bytes.byteLength !== payload.bundle.size ||
          sha256Hex(bytes) !== payload.bundle.sha256
        ) {
          throw new Error(`${bundleAlias} does not match payload.bundle hash`);
        }
      }
      mutableFiles.push({
        relativePath: bundleAlias,
        filePath: aliasPath,
        bytes,
        size: bytes.byteLength,
        sha256: sha256Hex(bytes),
        contentType: inferContentType(bundleAlias),
      });
    }
  }

  if (existsSync(payloadPath)) {
    mutableFiles.push({
      relativePath: "payload.json",
      filePath: payloadPath,
      bytes: payloadBytes,
      size: payloadBytes.byteLength,
      sha256: sha256Hex(payloadBytes),
      contentType: "application/json; charset=utf-8",
    });
  }

  if (existsSync(signedManifestPath)) {
    const smBytes = readVerifiedRegularFile(signedManifestPath, "signed-manifest.json");
    mutableFiles.push({
      relativePath: "signed-manifest.json",
      filePath: signedManifestPath,
      bytes: smBytes,
      size: smBytes.byteLength,
      sha256: sha256Hex(smBytes),
      contentType: "application/json; charset=utf-8",
    });
  }

  let rawHostDescriptor: Record<string, unknown> | undefined;
  const hostPath = join(resolvedDir, "host.json");
  if (existsSync(hostPath)) {
    const hostBytes = readVerifiedRegularFile(hostPath, "host.json");
    rawHostDescriptor = JSON.parse(
      new TextDecoder().decode(hostBytes),
    ) as Record<string, unknown>;
    mutableFiles.push({
      relativePath: "host.json",
      filePath: hostPath,
      bytes: hostBytes,
      size: hostBytes.byteLength,
      sha256: sha256Hex(hostBytes),
      contentType: "application/json; charset=utf-8",
    });
  }

  // latest.json MUST always be the final mutable file in Phase 2.
  mutableFiles.push({
    relativePath: "latest.json",
    filePath: latestPath,
    bytes: latestBytes,
    size: latestBytes.byteLength,
    sha256: sha256Hex(latestBytes),
    contentType: "application/json; charset=utf-8",
  });

  return {
    packageDir: resolvedDir,
    envelope,
    envelopeBytes: latestBytes,
    payload,
    payloadBytes,
    payloadSha256: sha256Hex(payloadBytes),
    ...(rawHostDescriptor ? { rawHostDescriptor } : {}),
    immutableFiles,
    mutableFiles,
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function rebaseHostDescriptorForCloudflare(
  descriptor: Record<string, unknown>,
  publicBaseUrl: string,
  slot?: "test" | "stable",
): Record<string, unknown> {
  const cleanBase = publicBaseUrl.replace(/\/+$/g, "");
  const channelBaseUrl = slot ? `${cleanBase}/${slot}` : cleanBase;
  const isHttps = cleanBase.toLowerCase().startsWith("https://");

  const replaceUrlValue = (value: unknown): unknown => {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      try {
        const parsed = new URL(value);
        if (
          /^(?:\/(?:test|stable))?\/pocket\//.test(parsed.pathname) ||
          /^\/(?:test|stable)(?:\/)?$/.test(parsed.pathname) ||
          /^\/updates\//.test(parsed.pathname) ||
          /^\/releases\//.test(parsed.pathname)
        ) {
          return `${cleanBase}${parsed.pathname}${parsed.search}${parsed.hash}`;
        }
      } catch {
        return value;
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(replaceUrlValue);
    }
    if (isObjectRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (
          isHttps &&
          (k === "POCKET_UPDATE_DEBUG_HTTP_HOST" || k === "debugHttpHosts")
        ) {
          continue;
        }
        out[k] = replaceUrlValue(v);
      }
      return out;
    }
    return value;
  };

  const rebased = replaceUrlValue(structuredClone(descriptor)) as Record<string, unknown>;
  if (typeof rebased.POCKET_UPDATE_BASE_URL === "string") {
    rebased.POCKET_UPDATE_BASE_URL = channelBaseUrl;
  }
  if (isObjectRecord(rebased.updates)) {
    rebased.updates.baseUrl = channelBaseUrl;
    if (isHttps) {
      delete rebased.updates.debugHttpHosts;
    }
  }
  if (isObjectRecord(rebased.config) && isObjectRecord(rebased.config.updates)) {
    rebased.config.updates.baseUrl = channelBaseUrl;
    if (isHttps) {
      delete rebased.config.updates.debugHttpHosts;
    }
  }
  if (isObjectRecord(rebased.applications)) {
    for (const app of Object.values(rebased.applications)) {
      if (!isObjectRecord(app)) continue;
      if (isObjectRecord(app.config) && isObjectRecord(app.config.updates)) {
        app.config.updates.baseUrl = channelBaseUrl;
        if (isHttps) {
          delete app.config.updates.debugHttpHosts;
        }
      }
    }
  }
  if (isHttps) {
    delete rebased.POCKET_UPDATE_DEBUG_HTTP_HOST;
  }
  return rebased;
}

type DiscoveredPackageTarget = {
  packageDir: string;
  routePrefix: string;
  hostVersion?: string;
  packageId?: string;
  routeVersion?: string;
};

function discoverReleasePackages(options: {
  packageDir?: string;
  deployRoot?: string;
  routePrefix?: string;
}): DiscoveredPackageTarget[] {
  if (options.packageDir && options.deployRoot) {
    throw new Error("Specify either packageDir or deployRoot, not both");
  }
  if (options.packageDir) {
    const cleanPrefix = (options.routePrefix ?? "").replace(/^\/+|\/+$/g, "");
    return [{ packageDir: resolve(options.packageDir), routePrefix: cleanPrefix }];
  }
  if (!options.deployRoot) {
    throw new Error("Either packageDir or deployRoot is required");
  }
  const rootDir = resolve(options.deployRoot);
  if (
    !existsSync(rootDir) ||
    lstatSync(rootDir).isSymbolicLink() ||
    !lstatSync(rootDir).isDirectory()
  ) {
    throw new Error(`Deploy root must be a real non-symlink directory: ${rootDir}`);
  }

  if (existsSync(join(rootDir, "latest.json"))) {
    const cleanPrefix = (options.routePrefix ?? "").replace(/^\/+|\/+$/g, "");
    return [{ packageDir: rootDir, routePrefix: cleanPrefix }];
  }

  const pocketDir = join(rootDir, "pocket");
  if (
    !existsSync(pocketDir) ||
    lstatSync(pocketDir).isSymbolicLink() ||
    !lstatSync(pocketDir).isDirectory()
  ) {
    throw new Error(
      `Deploy root does not contain pocket/<hostVersion>/<packageId>/<packageVersion>: ${rootDir}`,
    );
  }

  const targets: DiscoveredPackageTarget[] = [];
  const hostVersions = readdirSync(pocketDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const hostEntry of hostVersions) {
    if (hostEntry.isSymbolicLink() || !hostEntry.isDirectory()) continue;
    const hostPath = join(pocketDir, hostEntry.name);
    const pkgEntries = readdirSync(hostPath, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const pkgEntry of pkgEntries) {
      if (pkgEntry.isSymbolicLink() || !pkgEntry.isDirectory()) continue;
      const pkgPath = join(hostPath, pkgEntry.name);
      const verEntries = readdirSync(pkgPath, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const verEntry of verEntries) {
        if (verEntry.isSymbolicLink() || !verEntry.isDirectory()) continue;
        const verPath = join(pkgPath, verEntry.name);
        if (existsSync(join(verPath, "latest.json"))) {
          const relPrefix = `pocket/${hostEntry.name}/${pkgEntry.name}/${verEntry.name}`;
          targets.push({
            packageDir: verPath,
            routePrefix: options.routePrefix
              ? `${options.routePrefix.replace(/^\/+|\/+$/g, "")}/${relPrefix}`
              : relPrefix,
            hostVersion: hostEntry.name,
            packageId: pkgEntry.name,
            routeVersion: verEntry.name,
          });
        }
      }
    }
  }

  if (targets.length === 0) {
    throw new Error(`No signed Pocket release directories found under ${rootDir}`);
  }
  return targets;
}

export type PublishToCloudflareMatrixOptions = {
  clients: readonly R2Client[];
  packageDir?: string;
  deployRoot?: string;
  routePrefix?: string;
  slot?: "test" | "stable";
  hostVersion?: string;
  appId?: string;
  packageVersion?: string;
  publicKey?: string | Buffer;
  keyId?: string;
  publicKeyBase64?: string;
  filterPlatforms?: readonly CloudflareConcretePlatform[];
  purgeCache?: boolean;
  apiTokensByProfile?: ReadonlyMap<string, string>;
  writeEndpointsPath?: string;
  dryRun?: boolean;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: CloudflareUploadProgress) => void;
};

/**
 * Multi-Account × Platform Two-Phase Atomic OTA Publisher.
 *
 * Cross-account safety invariant:
 * - Phase 1 (immutable content-addressed blobs & bundles) runs across ALL
 *   matched Cloudflare account targets first.
 * - If ANY target fails Phase 1, Phase 2 never starts on ANY account, preventing
 *   cross-account or primary/fallback version drift.
 * - Phase 2 rebases `host.json` to each target's own `publicBaseUrl`, writes
 *   `latest.json` strictly last, and triggers Cloudflare Zone Cache Purge on
 *   all updated mutable URLs.
 */
export async function publishToCloudflareMatrix(
  options: PublishToCloudflareMatrixOptions,
): Promise<CloudflareMatrixPublishResult> {
  if (!options.clients || options.clients.length === 0) {
    throw new Error("At least one R2Client is required to publish to Cloudflare");
  }
  const allTargets = options.clients.map((c) => c.target);
  validateCloudflareRouteMatrix(allTargets);

  const activeClients =
    options.filterPlatforms && options.filterPlatforms.length > 0
      ? options.clients.filter((client) =>
          options.filterPlatforms!.some((p) => targetMatchesPlatform(client.target, p)),
        )
      : [...options.clients];

  if (activeClients.length === 0) {
    throw new Error(
      `No Cloudflare account targets match filterPlatforms: ${options.filterPlatforms?.join(", ")}`,
    );
  }

  const dryRun = options.dryRun === true;
  const endpointsPath = !dryRun && options.slot !== "test" && options.writeEndpointsPath
    ? resolve(options.writeEndpointsPath)
    : undefined;
  if (endpointsPath) checkEndpointsOutputPath(endpointsPath);
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 4));
  const discovered = discoverReleasePackages({
    packageDir: options.packageDir,
    deployRoot: options.deployRoot,
    routePrefix: options.routePrefix,
  });

  const verifiedList = discovered.map((item) => ({
    ...item,
    verified: verifyLocalPackageForCloudflare(item.packageDir, options.publicKey),
  }));

  const movingIndexes = new Map<string, (typeof verifiedList)[number]>();
  for (const item of verifiedList) {
    if (!item.hostVersion || !item.packageId || !item.routeVersion) continue;
    if (item.packageId !== item.verified.payload.appId) {
      throw new Error(`Release directory app ID "${item.packageId}" does not match signed app ID "${item.verified.payload.appId}"`);
    }
    if (options.packageVersion &&
        item.routeVersion !== options.packageVersion &&
        item.verified.payload.version !== options.packageVersion) continue;
    const routeBase = options.routePrefix?.replace(/^\/+|\/+$/g, "");
    const indexKey = [routeBase, options.slot, "pocket", item.hostVersion, item.packageId, "latest.json"]
      .filter(Boolean).join("/");
    const previous = movingIndexes.get(indexKey);
    const build = item.verified.payload.build;
    if (!Number.isSafeInteger(build) || build < 0) {
      throw new Error(`Invalid signed build for release ${item.routePrefix}`);
    }
    if (previous?.verified.payload.build === build &&
        previous.verified.payloadSha256 !== item.verified.payloadSha256) {
      throw new Error(`Ambiguous signed build ${build} for ${indexKey}`);
    }
    if (!previous || build > previous.verified.payload.build) {
      movingIndexes.set(indexKey, item);
    }
  }
  if (options.packageVersion && verifiedList.some((item) => item.routeVersion) &&
      movingIndexes.size === 0) {
    throw new Error(`No signed Pocket release matches packageVersion "${options.packageVersion}"`);
  }

  type TargetPlan = {
    client: R2Client;
    targetKey: string;
    phase1Tasks: Array<{
      relativeKey: string;
      bytes: Uint8Array;
      size: number;
      sha256: string;
      contentType: string;
      cacheControl: string;
      deduplicate: boolean;
    }>;
    phase2Tasks: Array<{
      relativeKey: string;
      bytes: Uint8Array;
      size: number;
      sha256: string;
      contentType: string;
      cacheControl: string;
    }>;
    records: CloudflarePublishFileRecord[];
    uploadedFiles: number;
    skippedFiles: number;
    uploadedBytes: number;
    skippedBytes: number;
    completedFiles: number;
    totalFiles: number;
  };

  const plans: TargetPlan[] = activeClients.map((client) => {
    const targetKey = client.target.profileId ?? `${client.target.accountId.slice(0, 8)}:${client.target.bucket}`;
    const phase1Tasks: TargetPlan["phase1Tasks"] = [];
    const phase2Tasks: TargetPlan["phase2Tasks"] = [];

    for (const { routePrefix, verified } of verifiedList) {
      const prefix = routePrefix ? `${routePrefix}/` : "";
      for (const file of verified.immutableFiles) {
        phase1Tasks.push({
          relativeKey: `${prefix}${file.relativePath}`,
          bytes: file.bytes,
          size: file.size,
          sha256: file.sha256,
          contentType: file.contentType,
          cacheControl: IMMUTABLE_CACHE_CONTROL,
          deduplicate: file.deduplicate,
        });
      }
      for (const file of verified.mutableFiles) {
        if (file.relativePath === "host.json" && verified.rawHostDescriptor) {
          const rebased = rebaseHostDescriptorForCloudflare(
            verified.rawHostDescriptor,
            client.target.publicBaseUrl,
            options.slot,
          );
          const rebasedBytes = new TextEncoder().encode(
            JSON.stringify(rebased, null, 2) + "\n",
          );
          phase2Tasks.push({
            relativeKey: `${prefix}host.json`,
            bytes: rebasedBytes,
            size: rebasedBytes.byteLength,
            sha256: sha256Hex(rebasedBytes),
            contentType: "application/json; charset=utf-8",
            cacheControl: MUTABLE_CACHE_CONTROL,
          });
          continue;
        }
        phase2Tasks.push({
          relativeKey: `${prefix}${file.relativePath}`,
          bytes: file.bytes,
          size: file.size,
          sha256: file.sha256,
          contentType: file.contentType,
          cacheControl: MUTABLE_CACHE_CONTROL,
        });
      }

    }

    for (const [indexKey, item] of movingIndexes) {
      const envelopeKey = `${item.routePrefix}/latest.json`;
      const latest = {
        id: item.verified.payload.appId,
        version: item.verified.payload.version,
        build: item.verified.payload.build,
        payloadSha256: item.verified.payloadSha256,
        manifestUrl: relativePublicObjectUrl(indexKey, envelopeKey),
        ...(item.verified.rawHostDescriptor
          ? { hostConfigUrl: relativePublicObjectUrl(indexKey, `${item.routePrefix}/host.json`) }
          : {}),
      };
      const bytes = new TextEncoder().encode(JSON.stringify({
        schemaVersion: 1,
        kind: "pocket-editor-package-index",
        packageId: latest.id,
        latest,
        versions: [latest],
      }, null, 2) + "\n");
      phase2Tasks.push({
        relativeKey: indexKey,
        bytes,
        size: bytes.byteLength,
        sha256: sha256Hex(bytes),
        contentType: "application/json; charset=utf-8",
        cacheControl: MUTABLE_CACHE_CONTROL,
      });
    }

    return {
      client,
      targetKey,
      phase1Tasks,
      phase2Tasks,
      records: [],
      uploadedFiles: 0,
      skippedFiles: 0,
      uploadedBytes: 0,
      skippedBytes: 0,
      completedFiles: 0,
      totalFiles: phase1Tasks.length + phase2Tasks.length,
    };
  });

  // === GLOBAL PHASE 1 across all active account targets ===
  await Promise.all(
    plans.map(async (plan) => {
      let nextIdx = 0;
      const runWorker = async (): Promise<void> => {
        while (true) {
          options.signal?.throwIfAborted?.();
          const idx = nextIdx;
          if (idx >= plan.phase1Tasks.length) return;
          nextIdx += 1;
          const task = plan.phase1Tasks[idx]!;
          const objectKey = plan.client.resolveObjectKey(task.relativeKey);
          let action: "uploaded" | "skipped" = "uploaded";

          if (!dryRun) {
            if (task.deduplicate) {
              const head = await plan.client.headObject(task.relativeKey, options.signal);
              if (
                head.exists &&
                head.size === task.size &&
                (!head.sha256 || head.sha256.toLowerCase() === task.sha256.toLowerCase())
              ) {
                action = "skipped";
              }
            }
            if (action === "uploaded") {
              await plan.client.uploadFile(task.relativeKey, task.bytes, {
                contentType: task.contentType,
                cacheControl: task.cacheControl,
                sha256: task.sha256,
                signal: options.signal,
              });
            }
          }

          plan.completedFiles += 1;
          if (action === "skipped") {
            plan.skippedFiles += 1;
            plan.skippedBytes += task.size;
          } else {
            plan.uploadedFiles += 1;
            plan.uploadedBytes += task.size;
          }

          plan.records.push({
            relativeKey: task.relativeKey,
            objectKey,
            size: task.size,
            sha256: task.sha256,
            cacheControl: task.cacheControl,
            contentType: task.contentType,
            phase: "phase1",
            action,
          });

          options.onProgress?.({
            targetKey: plan.targetKey,
            profileId: plan.client.target.profileId,
            bucket: plan.client.target.bucket,
            phase: "phase1",
            relativeKey: task.relativeKey,
            objectKey,
            action,
            bytes: task.size,
            completedFiles: plan.completedFiles,
            totalFiles: plan.totalFiles,
          });
        }
      };

      const workerCount = Math.min(concurrency, Math.max(1, plan.phase1Tasks.length));
      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    }),
  );

  // === GLOBAL PHASE 2 + Zone Cache Purge per target ===
  const targetResults: CloudflareTargetPublishResult[] = [];

  for (const plan of plans) {
    const mutablePublicUrls: string[] = [];
    for (const task of plan.phase2Tasks) {
      options.signal?.throwIfAborted?.();
      const objectKey = plan.client.resolveObjectKey(task.relativeKey);
      if (!dryRun) {
        await plan.client.uploadFile(task.relativeKey, task.bytes, {
          contentType: task.contentType,
          cacheControl: task.cacheControl,
          sha256: task.sha256,
          signal: options.signal,
        });
      }
      plan.completedFiles += 1;
      plan.uploadedFiles += 1;
      plan.uploadedBytes += task.size;

      const pubUrl = plan.client.resolvePublicUrl(task.relativeKey);
      mutablePublicUrls.push(pubUrl);

      plan.records.push({
        relativeKey: task.relativeKey,
        objectKey,
        size: task.size,
        sha256: task.sha256,
        cacheControl: task.cacheControl,
        contentType: task.contentType,
        phase: "phase2",
        action: "uploaded",
      });

      options.onProgress?.({
        targetKey: plan.targetKey,
        profileId: plan.client.target.profileId,
        bucket: plan.client.target.bucket,
        phase: "phase2",
        relativeKey: task.relativeKey,
        objectKey,
        action: "uploaded",
        bytes: task.size,
        completedFiles: plan.completedFiles,
        totalFiles: plan.totalFiles,
      });
    }

    let cachePurge: CloudflarePurgeSummary | undefined;
    if (!dryRun && options.purgeCache !== false && mutablePublicUrls.length > 0) {
      const explicitToken = plan.client.target.profileId
        ? options.apiTokensByProfile?.get(plan.client.target.profileId)
        : undefined;
      cachePurge = await plan.client.purgeZoneCache(mutablePublicUrls, {
        apiToken: explicitToken,
        signal: options.signal,
      });
      if (cachePurge) {
        options.onProgress?.({
          targetKey: plan.targetKey,
          profileId: plan.client.target.profileId,
          bucket: plan.client.target.bucket,
          phase: "purge",
          relativeKey: "purge_cache",
          objectKey: cachePurge.zoneId,
          action: "purged",
          bytes: 0,
          completedFiles: plan.completedFiles,
          totalFiles: plan.totalFiles,
        });
      }
    }

    const manifestUrls = verifiedList.map(({ routePrefix }) => {
      const rel = routePrefix ? `${routePrefix}/latest.json` : "latest.json";
      return plan.client.resolvePublicUrl(rel);
    });

    targetResults.push({
      ...(plan.client.target.profileId ? { profileId: plan.client.target.profileId } : {}),
      accountId: plan.client.target.accountId,
      bucket: plan.client.target.bucket,
      keyPrefix: plan.client.target.keyPrefix,
      publicBaseUrl: plan.client.target.publicBaseUrl,
      platforms: plan.client.target.platforms,
      role: plan.client.target.role,
      dryRun,
      uploadedFiles: plan.uploadedFiles,
      skippedFiles: plan.skippedFiles,
      uploadedBytes: plan.uploadedBytes,
      skippedBytes: plan.skippedBytes,
      files: plan.records,
      manifestUrls,
      mutablePublicUrls,
      ...(cachePurge ? { cachePurge } : {}),
      publishedAt: new Date().toISOString(),
    });
  }

  const firstRelease = [...movingIndexes.values()].find((item) =>
    (!options.appId || item.packageId === options.appId) &&
    (!options.hostVersion || item.hostVersion === options.hostVersion),
  ) ?? verifiedList[0];
  const firstVerified = firstRelease?.verified;
  const inferredAppId = options.appId ?? firstVerified?.payload.appId;
  const inferredHostVersion =
    options.hostVersion ?? firstRelease?.hostVersion ?? "0.1.0";
  const inferredPackageVersion =
    options.packageVersion ??
    firstRelease?.routeVersion ??
    firstVerified?.payload.version;
  const inferredKeyId = options.keyId ?? firstVerified?.envelope.keyId;

  let platformEndpoints: PlatformEndpointsDocument | undefined;
  if (inferredAppId && inferredHostVersion) {
    platformEndpoints = buildPlatformEndpointsDocument({
      targets: options.routePrefix && movingIndexes.size > 0
        ? allTargets.map((target) => ({
            ...target,
            publicBaseUrl: `${target.publicBaseUrl}/${options.routePrefix!.replace(/^\/+|\/+$/g, "").split("/").map(encodeURIComponent).join("/")}`,
          }))
        : allTargets,
      appId: inferredAppId,
      hostVersion: inferredHostVersion,
      packageVersion: inferredPackageVersion,
      slot: options.slot,
      keyId: inferredKeyId,
      publicKey: options.publicKeyBase64,
    });

    if (endpointsPath) writeEndpointsDocument(endpointsPath, platformEndpoints);
  }

  return {
    dryRun,
    targets: targetResults,
    ...(platformEndpoints ? { platformEndpoints } : {}),
    publishedAt: new Date().toISOString(),
  };
}

function parseSigningKeyJson(signingKeyFile: string): {
  keyId: string;
  privateKeyPem: string;
} {
  const raw = new TextDecoder().decode(
    readVerifiedRegularFile(resolve(signingKeyFile), "signingKeyFile"),
  );
  const parsed = JSON.parse(raw) as {
    keyId?: string;
    privateKeyPem?: string;
  };
  if (!parsed?.keyId || !parsed?.privateKeyPem) {
    throw new Error(
      `Signing key file must contain keyId and privateKeyPem: ${signingKeyFile}`,
    );
  }
  return { keyId: parsed.keyId, privateKeyPem: parsed.privateKeyPem };
}

export type PublishNativeInstallersOptions = {
  clients: readonly R2Client[];
  appId: string;
  channel?: "test" | "stable";
  installers: readonly NativeInstallerInput[];
  signingKeyFile?: string;
  purgeCache?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
};

export type PublishNativeInstallersResult = {
  appId: string;
  channel: "test" | "stable";
  dryRun: boolean;
  manifest: SignedNativeDownloadManifest;
  targetManifestUrls: Array<{
    profileId?: string;
    bucket: string;
    role: "primary" | "fallback";
    manifestUrl: string;
    cachePurge?: CloudflarePurgeSummary;
  }>;
  publishedAt: string;
};

export async function publishNativeInstallersToCloudflare(
  options: PublishNativeInstallersOptions,
): Promise<PublishNativeInstallersResult> {
  if (!options.clients || options.clients.length === 0) {
    throw new Error("At least one R2Client is required to publish native installers");
  }
  if (!options.appId?.trim()) {
    throw new Error("appId is required to publish native installers");
  }
  if (!options.installers || options.installers.length === 0) {
    throw new Error("At least one installer input is required");
  }

  const allTargets = options.clients.map((c) => c.target);
  validateCloudflareRouteMatrix(allTargets);

  const channel = options.channel ?? "stable";
  const dryRun = options.dryRun === true;
  const nowIso = new Date().toISOString();

  const preparedInstallers = options.installers.map((item) => {
    const absPath = resolve(item.filePath);
    const bytes = readVerifiedRegularFile(absPath, `installer(${item.platform})`);
    const rawName = (item.fileName ?? basename(absPath)).trim();
    if (!rawName || rawName.includes("/") || rawName.includes("\\") || rawName === "..") {
      throw new Error(`Invalid installer fileName: ${rawName}`);
    }
    if (!Number.isSafeInteger(item.build) || item.build < 1) {
      throw new Error(`Installer build must be a positive integer for ${item.platform}`);
    }
    const sha256 = sha256Hex(bytes);
    const relativeBinaryKey = `releases/native/${channel}/${item.platform}/${encodeURIComponent(item.version)}/${rawName}`;
    return {
      ...item,
      bytes,
      fileName: rawName,
      size: bytes.byteLength,
      sha256,
      contentType: inferContentType(rawName),
      relativeBinaryKey,
    };
  });

  // Phase 1: Upload installer binaries ONLY to accounts whose platforms cover that OS
  const platformRecords: Partial<
    Record<CloudflareConcretePlatform, NativeInstallerRecord>
  > = {};

  for (const inst of preparedInstallers) {
    const matchingClients = options.clients.filter((c) =>
      targetMatchesPlatform(c.target, inst.platform),
    );
    if (matchingClients.length === 0) {
      throw new Error(
        `No Cloudflare account target covers installer platform "${inst.platform}"`,
      );
    }

    const exactPrimary = matchingClients.find(
      (c) => c.target.role === "primary" && c.target.platforms.includes(inst.platform),
    );
    const wildcardPrimary = matchingClients.find(
      (c) => c.target.role === "primary" && c.target.platforms.includes("*"),
    );
    const primaryClient = exactPrimary ?? wildcardPrimary;
    if (!primaryClient) {
      throw new Error(
        `No primary Cloudflare account target covers installer platform "${inst.platform}"`,
      );
    }

    for (const client of matchingClients) {
      options.signal?.throwIfAborted?.();
      if (!dryRun) {
        const head = await client.headObject(inst.relativeBinaryKey, options.signal);
        if (
          !head.exists ||
          head.size !== inst.size ||
          (head.sha256 && head.sha256.toLowerCase() !== inst.sha256.toLowerCase())
        ) {
          await client.uploadFile(inst.relativeBinaryKey, inst.bytes, {
            contentType: inst.contentType,
            cacheControl: IMMUTABLE_CACHE_CONTROL,
            sha256: inst.sha256,
            signal: options.signal,
          });
        }
      }
    }

    const downloadUrl = primaryClient.resolvePublicUrl(inst.relativeBinaryKey);
    const fallbackDownloadUrls = matchingClients
      .filter((c) => c !== primaryClient)
      .map((c) => c.resolvePublicUrl(inst.relativeBinaryKey));

    platformRecords[inst.platform] = {
      platform: inst.platform,
      version: inst.version,
      build: inst.build,
      fileName: inst.fileName,
      size: inst.size,
      sha256: inst.sha256,
      contentType: inst.contentType,
      downloadUrl,
      fallbackDownloadUrls,
      ...(inst.releaseNotes ? { releaseNotes: inst.releaseNotes } : {}),
      ...(inst.minimumOsVersion ? { minimumOsVersion: inst.minimumOsVersion } : {}),
      publishedAt: nowIso,
    };
  }

  const payloadObj: NativeDownloadManifestPayload = {
    schemaVersion: 1,
    kind: "pocket-native-download-manifest",
    appId: options.appId.trim(),
    channel,
    publishedAt: nowIso,
    platforms: platformRecords,
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
  const payloadBase64 = Buffer.from(payloadBytes).toString("base64");

  let keyId: string | undefined;
  let signature: string | undefined;
  if (options.signingKeyFile) {
    const keyInfo = parseSigningKeyJson(options.signingKeyFile);
    const privKey = createPrivateKey(keyInfo.privateKeyPem);
    keyId = keyInfo.keyId;
    signature = cryptoSign(null, Buffer.from(payloadBytes), privKey).toString("base64");
  }

  const signedManifest: SignedNativeDownloadManifest = {
    schemaVersion: 1,
    kind: "pocket-signed-native-download-manifest",
    ...(keyId ? { keyId } : {}),
    ...(signature ? { signature } : {}),
    payload: payloadBase64,
    decoded: payloadObj,
  };

  const manifestBytes = new TextEncoder().encode(
    JSON.stringify(signedManifest, null, 2) + "\n",
  );
  const manifestRelKey = `releases/native/${channel}/download-manifest.json`;

  // Phase 2: Upload mutable per-platform latest.json + global download-manifest.json + Purge Cache
  const targetManifestUrls: PublishNativeInstallersResult["targetManifestUrls"] = [];

  for (const client of options.clients) {
    const mutableUrls: string[] = [];

    for (const [platform, record] of Object.entries(platformRecords) as Array<
      [CloudflareConcretePlatform, NativeInstallerRecord]
    >) {
      if (!targetMatchesPlatform(client.target, platform)) continue;
      const platRelKey = `releases/native/${channel}/${platform}/latest.json`;
      const platBytes = new TextEncoder().encode(JSON.stringify(record, null, 2) + "\n");
      if (!dryRun) {
        await client.uploadFile(platRelKey, platBytes, {
          contentType: "application/json; charset=utf-8",
          cacheControl: MUTABLE_CACHE_CONTROL,
          sha256: sha256Hex(platBytes),
          signal: options.signal,
        });
      }
      mutableUrls.push(client.resolvePublicUrl(platRelKey));
    }

    if (!dryRun) {
      await client.uploadFile(manifestRelKey, manifestBytes, {
        contentType: "application/json; charset=utf-8",
        cacheControl: MUTABLE_CACHE_CONTROL,
        sha256: sha256Hex(manifestBytes),
        signal: options.signal,
      });
    }
    const manifestUrl = client.resolvePublicUrl(manifestRelKey);
    mutableUrls.push(manifestUrl);

    let cachePurge: CloudflarePurgeSummary | undefined;
    if (!dryRun && options.purgeCache !== false && mutableUrls.length > 0) {
      cachePurge = await client.purgeZoneCache(mutableUrls, {
        signal: options.signal,
      });
    }

    targetManifestUrls.push({
      ...(client.target.profileId ? { profileId: client.target.profileId } : {}),
      bucket: client.target.bucket,
      role: client.target.role,
      manifestUrl,
      ...(cachePurge ? { cachePurge } : {}),
    });
  }

  return {
    appId: options.appId.trim(),
    channel,
    dryRun,
    manifest: signedManifest,
    targetManifestUrls,
    publishedAt: nowIso,
  };
}

export type PublishStudioVersionToCloudflareOptions = {
  clients: readonly R2Client[];
  updatesDir: string;
  projectId: string;
  rootAppId: string;
  entry: PublishedVersion;
  reusedEntries?: Array<{ ownerProjectId: string; entry: PublishedVersion }>;
  previouslyPublishedEntries?: PublishedVersion[];
  publicKey?: string | Buffer;
  publicKeyBase64?: string;
  keyId?: string;
  purgeCache?: boolean;
  writeEndpointsPath?: string;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: CloudflareUploadProgress) => void;
};

export async function publishStudioVersionToCloudflareMatrix(
  options: PublishStudioVersionToCloudflareOptions,
): Promise<CloudflareStudioPublishSummary> {
  if (!options.clients || options.clients.length === 0) {
    throw new Error("At least one Cloudflare R2 client is required");
  }
  const allTargets = options.clients.map((c) => c.target);
  validateCloudflareRouteMatrix(allTargets);

  const updatesDir = resolve(options.updatesDir);
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 4));
  const { entry } = options;
  const slot = entry.slot;
  const channel = entry.channel;
  const hostVersion = entry.hostVersion;
  const endpointsPath = slot === "stable" && options.writeEndpointsPath
    ? resolve(options.writeEndpointsPath)
    : undefined;
  if (endpointsPath) checkEndpointsOutputPath(endpointsPath);

  type PackageToUpload = {
    releaseEntry: PublishedVersion;
    pkgId: string;
    version: string;
    build: number;
    verified: VerifiedCloudflarePackage;
  };

  const packagesToUpload: PackageToUpload[] = [];
  const seenReleasePkg = new Set<string>();

  const verifyEntryPackage = (
    releaseEntry: PublishedVersion,
    pkg: PublishedVersion["packages"][number],
  ): PackageToUpload => {
    if (!pkg.artifactRoot || isAbsolute(pkg.artifactRoot)) {
      throw new Error(`Invalid package artifactRoot outside updatesDir: ${pkg.artifactRoot}`);
    }
    const packageDir = resolve(updatesDir, pkg.artifactRoot);
    const relPackageDir = relative(updatesDir, packageDir);
    if (
      !relPackageDir ||
      relPackageDir.startsWith("..") ||
      isAbsolute(relPackageDir) ||
      relPackageDir.split(/[\\/]+/).includes("..")
    ) {
      throw new Error(`Invalid package artifactRoot outside updatesDir: ${pkg.artifactRoot}`);
    }
    const verified = verifyLocalPackageForCloudflare(packageDir, options.publicKey);
    if (verified.payload.appId !== pkg.id ||
        verified.payload.version !== pkg.version ||
        verified.payload.build !== pkg.build) {
      throw new Error(`Published package metadata does not match signed manifest: ${pkg.id}`);
    }
    return {
      releaseEntry,
      pkgId: pkg.id,
      version: pkg.version,
      build: pkg.build,
      verified,
    };
  };

  const addEntryPackages = (
    releaseEntry: PublishedVersion,
    filterPackageIds?: Set<string>,
  ) => {
    for (const pkg of releaseEntry.packages) {
      if (filterPackageIds && !filterPackageIds.has(pkg.id)) continue;
      const key = `${releaseEntry.hostVersion}/${pkg.id}/${releaseEntry.releaseId}`;
      if (seenReleasePkg.has(key)) continue;
      seenReleasePkg.add(key);

      packagesToUpload.push(verifyEntryPackage(releaseEntry, pkg));
    }
  };

  addEntryPackages(entry);
  const rootPackage = packagesToUpload.find((item) => item.pkgId === options.rootAppId);
  if (!rootPackage || rootPackage.verified.payloadSha256 !== entry.payloadSha256) {
    throw new Error(`Release ${entry.releaseId} has no verified root package`);
  }
  for (const item of packagesToUpload) {
    if (!item.verified.rawHostDescriptor) {
      throw new Error(`Release ${entry.releaseId} is missing host.json for ${item.pkgId}`);
    }
  }

  if (options.reusedEntries && entry.reusedPackages) {
    const reusedMap = new Map<string, Set<string>>();
    for (const rp of entry.reusedPackages) {
      const k = `${rp.ownerProjectId}\n${rp.releaseId}`;
      const set = reusedMap.get(k) ?? new Set<string>();
      set.add(rp.id);
      reusedMap.set(k, set);
    }
    for (const reused of options.reusedEntries) {
      const k = `${reused.ownerProjectId}\n${reused.entry.releaseId}`;
      const filter = reusedMap.get(k);
      if (filter) addEntryPackages(reused.entry, filter);
    }
  }

  const allHistoryEntries: PublishedVersion[] = [entry];
  for (const prior of options.previouslyPublishedEntries ?? []) {
    if (
      prior.hostVersion === hostVersion &&
      prior.slot === slot &&
      !allHistoryEntries.some((e) => e.releaseId === prior.releaseId)
    ) {
      allHistoryEntries.push(prior);
    }
  }

  const orderedIndexPackages = packagesToUpload.filter((item) => item.releaseEntry === entry).sort((a, b) => {
    const aIsRoot = a.pkgId === options.rootAppId ? 1 : 0;
    const bIsRoot = b.pkgId === options.rootAppId ? 1 : 0;
    if (aIsRoot !== bIsRoot) return aIsRoot - bIsRoot;
    return a.pkgId.localeCompare(b.pkgId);
  });

  type UploadItem = {
    phase: "phase1" | "phase2";
    relativeKey: string;
    bytes: Uint8Array;
    size: number;
    sha256: string;
    contentType: string;
    cacheControl: string;
    deduplicate: boolean;
  };

  const historyByPackage = new Map<string, PackageToUpload[]>();
  for (const item of orderedIndexPackages) {
    const history = [item];
    for (const prior of allHistoryEntries.slice(1)) {
      const pkg = prior.packages.find((candidate) => candidate.id === item.pkgId);
      if (!pkg) continue;
      try {
        const historical = verifyEntryPackage(prior, pkg);
        if (historical.verified.rawHostDescriptor &&
            (item.pkgId !== options.rootAppId || historical.verified.payloadSha256 === prior.payloadSha256)) {
          history.push(historical);
        }
      } catch {
        // A local release without verifiable artifacts cannot enter the catalog.
      }
    }
    historyByPackage.set(item.pkgId, history);
  }

  const immutableItems = (item: PackageToUpload, client: R2Client): UploadItem[] => {
    const items: UploadItem[] = [];
    const immutablePrefix = `pocket/${item.releaseEntry.hostVersion}/${item.pkgId}/${item.releaseEntry.releaseId}`;
    for (const file of item.verified.immutableFiles) {
      items.push({
        phase: "phase1",
        relativeKey: `${immutablePrefix}/${file.relativePath}`,
        bytes: file.bytes,
        size: file.size,
        sha256: file.sha256,
        contentType: file.contentType,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        deduplicate: file.deduplicate,
      });
    }
    for (const file of item.verified.mutableFiles) {
      if (file.relativePath === "host.json") continue;
      items.push({
        phase: "phase1",
        relativeKey: `${immutablePrefix}/${file.relativePath}`,
        bytes: file.bytes,
        size: file.size,
        sha256: file.sha256,
        contentType: file.contentType,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        deduplicate: false,
      });
    }
    if (item.verified.rawHostDescriptor) {
      const rebasedHost = rebaseHostDescriptorForCloudflare(
        item.verified.rawHostDescriptor,
        client.target.publicBaseUrl,
        item.releaseEntry.slot,
      );
      const rebasedBytes = new TextEncoder().encode(
        JSON.stringify(rebasedHost, null, 2) + "\n",
      );
      items.push({
        phase: "phase1",
        relativeKey: `${immutablePrefix}/host.json`,
        bytes: rebasedBytes,
        size: rebasedBytes.byteLength,
        sha256: sha256Hex(rebasedBytes),
        contentType: "application/json; charset=utf-8",
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        deduplicate: false,
      });
    }
    return items;
  };
  const targetPlans = options.clients.map((client) => {
    const targetKey =
      client.target.profileId ?? `${client.target.accountId.slice(0, 8)}:${client.target.bucket}`;
    const phase1Items = packagesToUpload.flatMap((item) => immutableItems(item, client));
    return {
      client,
      targetKey,
      phase1Items,
      completedFiles: 0,
      totalFiles: phase1Items.length + orderedIndexPackages.length,
      uploadedFiles: 0,
      skippedFiles: 0,
      uploadedBytes: 0,
      skippedBytes: 0,
    };
  });

  // === GLOBAL PHASE 1 across all Cloudflare accounts ===
  await Promise.all(
    targetPlans.map(async (plan) => {
      let nextIdx = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          options.signal?.throwIfAborted?.();
          const idx = nextIdx;
          if (idx >= plan.phase1Items.length) return;
          nextIdx += 1;
          const task = plan.phase1Items[idx]!;
          const objectKey = plan.client.resolveObjectKey(task.relativeKey);
          let action: "uploaded" | "skipped" = "uploaded";
          if (task.deduplicate) {
            const head = await plan.client.headObject(task.relativeKey, options.signal);
            if (
              head.exists &&
              head.size === task.size &&
              head.sha256?.toLowerCase() === task.sha256.toLowerCase()
            ) {
              action = "skipped";
            }
          }
          if (action === "uploaded") {
            await plan.client.uploadFile(task.relativeKey, task.bytes, {
              contentType: task.contentType,
              cacheControl: task.cacheControl,
              sha256: task.sha256,
              signal: options.signal,
            });
          }
          plan.completedFiles += 1;
          if (action === "skipped") {
            plan.skippedFiles += 1;
            plan.skippedBytes += task.size;
          } else {
            plan.uploadedFiles += 1;
            plan.uploadedBytes += task.size;
          }
          options.onProgress?.({
            targetKey: plan.targetKey,
            profileId: plan.client.target.profileId,
            bucket: plan.client.target.bucket,
            phase: "phase1",
            relativeKey: task.relativeKey,
            objectKey,
            action,
            bytes: task.size,
            completedFiles: plan.completedFiles,
            totalFiles: plan.totalFiles,
          });
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(concurrency, Math.max(1, plan.phase1Items.length)) },
          () => worker(),
        ),
      );
    }),
  );

  // Resolve every target's catalog before changing any moving index.
  const phase2Plans = await Promise.all(targetPlans.map(async (plan) => {
    const items: UploadItem[] = [];
    for (const item of orderedIndexPackages) {
      const indexKey = `${slot}/pocket/${hostVersion}/${item.pkgId}/latest.json`;
      const records = [];
      for (const historical of historyByPackage.get(item.pkgId) ?? []) {
        const release = historical.releaseEntry;
        if (historical !== item) {
          let available = true;
          for (const file of immutableItems(historical, plan.client)) {
            const head = await plan.client.headObject(file.relativeKey, options.signal);
            if (!head.exists || head.size !== file.size ||
                head.sha256?.toLowerCase() !== file.sha256) {
              available = false;
              break;
            }
          }
          if (!available) continue;
        }
        const releasePrefix = `pocket/${release.hostVersion}/${item.pkgId}/${release.releaseId}`;
        records.push({
          id: item.pkgId,
          version: historical.version,
          build: historical.build,
          releaseId: release.releaseId,
          channel: release.channel,
          slot: release.slot,
          compatVersion: release.compatVersion ?? release.version,
          routeVersion: release.routeVersion ?? release.version,
          packageVersion: release.packageVersion,
          publishedAt: release.publishedAt,
          manifestUrl: relativePublicObjectUrl(indexKey, `${releasePrefix}/latest.json`),
          hostConfigUrl: relativePublicObjectUrl(indexKey, `${releasePrefix}/host.json`),
          archiveUrl: null,
          payloadSha256: historical.verified.payloadSha256,
          rootPayloadSha256: release.payloadSha256,
        });
      }
      const indexDoc = {
        schemaVersion: 1,
        kind: "pocket-editor-package-index",
        projectId: options.projectId,
        hostVersion,
        rootAppId: options.rootAppId,
        systemUI: options.rootAppId,
        packageId: item.pkgId,
        slot,
        channel,
        compatVersion: entry.compatVersion ?? entry.version,
        latest: records[0],
        versions: records,
      };
      const bytes = new TextEncoder().encode(JSON.stringify(indexDoc, null, 2) + "\n");
      items.push({
        phase: "phase2",
        relativeKey: indexKey,
        bytes,
        size: bytes.byteLength,
        sha256: sha256Hex(bytes),
        contentType: "application/json; charset=utf-8",
        cacheControl: MUTABLE_CACHE_CONTROL,
        deduplicate: false,
      });
    }
    return { ...plan, phase2Items: items };
  }));

  // === GLOBAL PHASE 2 + Zone Cache Purge ===
  const targetSummaries: CloudflareStudioTargetSummary[] = [];
  let totalUploadedFiles = 0;
  let totalSkippedFiles = 0;
  let totalUploadedBytes = 0;
  let totalSkippedBytes = 0;

  for (const plan of phase2Plans) {
    const mutableUrls: string[] = [];
    for (const task of plan.phase2Items) {
      options.signal?.throwIfAborted?.();
      const objectKey = plan.client.resolveObjectKey(task.relativeKey);
      await plan.client.uploadFile(task.relativeKey, task.bytes, {
        contentType: task.contentType,
        cacheControl: task.cacheControl,
        sha256: task.sha256,
        signal: options.signal,
      });
      plan.completedFiles += 1;
      plan.uploadedFiles += 1;
      plan.uploadedBytes += task.size;
      mutableUrls.push(plan.client.resolvePublicUrl(task.relativeKey));
      options.onProgress?.({
        targetKey: plan.targetKey,
        profileId: plan.client.target.profileId,
        bucket: plan.client.target.bucket,
        phase: "phase2",
        relativeKey: task.relativeKey,
        objectKey,
        action: "uploaded",
        bytes: task.size,
        completedFiles: plan.completedFiles,
        totalFiles: plan.totalFiles,
      });
    }

    let purgedUrlsCount: number | undefined;
    if (options.purgeCache !== false && mutableUrls.length > 0) {
      const purgeRes = await plan.client.purgeZoneCache(mutableUrls, {
        signal: options.signal,
      });
      if (purgeRes) {
        purgedUrlsCount = purgeRes.purgedUrls.length;
      }
    }

    const targetAppConfigUrl = plan.client.resolvePublicUrl(
      `${slot}/pocket/${hostVersion}/${options.rootAppId}/latest.json`,
    );
    const targetHostConfigUrl = plan.client.resolvePublicUrl(
      `pocket/${hostVersion}/${options.rootAppId}/${entry.releaseId}/host.json`,
    );

    totalUploadedFiles += plan.uploadedFiles;
    totalSkippedFiles += plan.skippedFiles;
    totalUploadedBytes += plan.uploadedBytes;
    totalSkippedBytes += plan.skippedBytes;

    targetSummaries.push({
      ...(plan.client.target.profileId ? { profileId: plan.client.target.profileId } : {}),
      accountId: plan.client.target.accountId,
      bucket: plan.client.target.bucket,
      keyPrefix: plan.client.target.keyPrefix,
      publicBaseUrl: plan.client.target.publicBaseUrl,
      platforms: plan.client.target.platforms,
      role: plan.client.target.role,
      appConfigUrl: targetAppConfigUrl,
      hostConfigUrl: targetHostConfigUrl,
      uploadedFiles: plan.uploadedFiles,
      skippedFiles: plan.skippedFiles,
      uploadedBytes: plan.uploadedBytes,
      skippedBytes: plan.skippedBytes,
      ...(purgedUrlsCount !== undefined ? { purgedUrls: purgedUrlsCount } : {}),
    });
  }

  const platformEndpoints = buildPlatformEndpointsDocument({
    targets: allTargets,
    appId: options.rootAppId,
    hostVersion,
    packageVersion: entry.compatVersion ?? entry.version,
    slot,
    keyId: options.keyId ?? rootPackage.verified.envelope.keyId,
    publicKey: options.publicKeyBase64,
  });

  if (endpointsPath) writeEndpointsDocument(endpointsPath, platformEndpoints);

  const primaryTarget =
    targetSummaries.find((t) => t.role === "primary") ?? targetSummaries[0]!;

  return {
    appConfigUrl: primaryTarget.appConfigUrl,
    hostConfigUrl: primaryTarget.hostConfigUrl,
    slot,
    channel,
    releaseId: entry.releaseId,
    version: entry.version,
    build: entry.build,
    uploadedFiles: totalUploadedFiles,
    skippedFiles: totalSkippedFiles,
    uploadedBytes: totalUploadedBytes,
    skippedBytes: totalSkippedBytes,
    purgedZones: targetSummaries.filter((t) => (t.purgedUrls ?? 0) > 0).length,
    targets: targetSummaries,
    platformEndpoints,
    publishedAt: new Date().toISOString(),
  };
}
