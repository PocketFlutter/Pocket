import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import { CloudflareError, redactCloudflareSecrets, type R2Client } from "./client.ts";
import { sha256Hex } from "./sign.ts";
import {
  CF_PROJECT_NAME_PATTERN,
  validateCloudflareAccountId,
} from "./types.ts";

const MAX_WEB_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_WEB_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_UPLOAD_BATCH_BYTES = 24 * 1024 * 1024;

export type CollectedWebAsset = {
  /** Leading-slash POSIX path (e.g. `/index.html`, `/engine/pocketjs.wasm`). */
  routePath: string;
  /** Relative POSIX path without leading slash. */
  relativePath: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
  /** 32-hex asset hash used by Cloudflare Pages / Workers Static Assets manifests. */
  assetHash32: string;
  contentType: string;
  immutable: boolean;
};

export function inferWebAssetContentType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function isImmutableWebAsset(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  if (lower === "index.html" || lower.endsWith("/index.html")) return false;
  if (lower.endsWith("pocket.config.json") || lower.endsWith("latest.json")) {
    return false;
  }
  return (
    lower.endsWith(".wasm") ||
    lower.endsWith(".pak") ||
    lower.endsWith(".qjbc") ||
    /[.-][0-9a-f]{8,64}\./i.test(lower)
  );
}

export function collectWebStaticAssets(webDir: string): CollectedWebAsset[] {
  const root = resolve(webDir);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) {
    throw new Error(`Web build directory must be a real non-symlink directory: ${root}`);
  }

  const assets: CollectedWebAsset[] = [];
  let totalBytes = 0;

  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name === ".DS_Store") continue;
      const fullPath = join(dir, entry.name);
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Web build directory must not contain symlinks: ${fullPath}`);
      }
      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_WEB_ASSET_BYTES) {
        throw new Error(
          `Web asset exceeds ${MAX_WEB_ASSET_BYTES} bytes limit: ${fullPath}`,
        );
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_WEB_TOTAL_BYTES) {
        throw new Error(
          `Web build exceeds ${MAX_WEB_TOTAL_BYTES} total bytes limit: ${root}`,
        );
      }
      const rel = relative(root, fullPath).replaceAll("\\", "/");
      if (!rel || rel.startsWith("..") || rel.includes("/../")) {
        throw new Error(`Unsafe web asset path: ${rel}`);
      }
      const bytes = new Uint8Array(readFileSync(fullPath));
      const contentType = inferWebAssetContentType(rel);
      const fullSha = sha256Hex(bytes);
      const base64Body = Buffer.from(bytes).toString("base64");
      const assetHash32 = sha256Hex(`${base64Body}${extForPagesHash(rel)}`).slice(0, 32);
      assets.push({
        routePath: `/${rel}`,
        relativePath: rel,
        bytes,
        size: bytes.byteLength,
        sha256: fullSha,
        assetHash32,
        contentType,
        immutable: isImmutableWebAsset(rel),
      });
    }
  };

  walk(root);
  if (assets.length === 0) {
    throw new Error(`Web build directory contains no files: ${root}`);
  }
  return assets;
}

function extForPagesHash(relativePath: string): string {
  return extname(relativePath).replace(/^\./, "").toLowerCase();
}

export type CloudflarePagesDeployOptions = {
  accountId: string;
  projectName: string;
  apiToken: string;
  webDir: string;
  branch?: string;
  commitHash?: string;
  commitMessage?: string;
  apiBaseOrigin?: string;
  fetchImpl?: typeof fetch;
  dryRun?: boolean;
  signal?: AbortSignal;
};

export type CloudflareWebDeployResult = {
  mode: "pages" | "workers-assets" | "r2-site";
  accountId: string;
  targetName: string;
  url?: string;
  deploymentId?: string;
  totalFiles: number;
  uploadedFiles: number;
  skippedFiles: number;
  totalBytes: number;
  dryRun: boolean;
  deployedAt: string;
};

async function cfJsonRequest<T>(input: {
  url: string;
  method: string;
  bearerToken: string;
  body?: BodyInit;
  headers?: Record<string, string>;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  redactTokens: string[];
  context: string;
}): Promise<T> {
  input.signal?.throwIfAborted?.();
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.bearerToken}`,
        ...(input.headers ?? {}),
      },
      body: input.body,
      signal: input.signal,
      redirect: "manual",
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    let msg = error instanceof Error ? error.message : String(error);
    for (const secret of input.redactTokens) {
      if (secret) msg = msg.split(secret).join("[REDACTED]");
    }
    throw new CloudflareError(`${input.context}: network error - ${msg}`, {
      status: 0,
      code: "NetworkError",
    });
  }

  const rawText = await response.text().catch(() => "");
  let parsed: {
    success?: boolean;
    result?: T;
    errors?: Array<{ code?: number; message?: string }>;
  } = {};
  try {
    parsed = JSON.parse(rawText) as typeof parsed;
  } catch {
    parsed = {};
  }

  if (!response.ok || parsed.success !== true || parsed.result === undefined) {
    let detail =
      parsed.errors?.map((e) => e.message ?? String(e.code ?? "")).join("; ") ||
      rawText.slice(0, 240) ||
      `HTTP ${response.status}`;
    for (const secret of input.redactTokens) {
      if (secret) detail = detail.split(secret).join("[REDACTED]");
    }
    throw new CloudflareError(`${input.context} failed (${response.status}): ${detail}`, {
      status: response.status,
      code: "CloudflareApiError",
      requestId: response.headers.get("cf-ray") ?? undefined,
    });
  }

  return parsed.result;
}

export async function deployWebToCloudflarePages(
  options: CloudflarePagesDeployOptions,
): Promise<CloudflareWebDeployResult> {
  const accountId = validateCloudflareAccountId(options.accountId);
  const projectName = options.projectName?.trim() ?? "";
  if (!CF_PROJECT_NAME_PATTERN.test(projectName)) {
    throw new Error(`Invalid Cloudflare Pages projectName "${options.projectName}"`);
  }
  const apiToken = options.apiToken?.trim() ?? "";
  const dryRun = options.dryRun === true;
  if (!dryRun && !apiToken) {
    throw new CloudflareError(
      "Cloudflare API token is required for Pages Direct Upload",
      { status: 401, code: "MissingApiToken" },
    );
  }

  const assets = collectWebStaticAssets(options.webDir);
  const totalBytes = assets.reduce((sum, a) => sum + a.size, 0);

  if (dryRun) {
    return {
      mode: "pages",
      accountId,
      targetName: projectName,
      totalFiles: assets.length,
      uploadedFiles: assets.length,
      skippedFiles: 0,
      totalBytes,
      dryRun: true,
      deployedAt: new Date().toISOString(),
    };
  }

  const apiBase = (options.apiBaseOrigin ?? "https://api.cloudflare.com").replace(
    /\/+$/g,
    "",
  );
  const fetchImpl = options.fetchImpl ?? fetch;

  const tokenResult = await cfJsonRequest<{ jwt: string }>({
    url: `${apiBase}/client/v4/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}/upload-token`,
    method: "GET",
    bearerToken: apiToken,
    fetchImpl,
    signal: options.signal,
    redactTokens: [apiToken],
    context: "PagesGetUploadToken",
  });
  const uploadJwt = tokenResult.jwt;
  const redactTokens = [apiToken, uploadJwt];

  const allHashes = [...new Set(assets.map((a) => a.assetHash32))];
  const missingHashes = await cfJsonRequest<string[]>({
    url: `${apiBase}/client/v4/pages/assets/check-missing`,
    method: "POST",
    bearerToken: uploadJwt,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hashes: allHashes }),
    fetchImpl,
    signal: options.signal,
    redactTokens,
    context: "PagesCheckMissingAssets",
  });

  const missingSet = new Set(missingHashes);
  const assetsToUpload = assets.filter((a) => missingSet.has(a.assetHash32));

  let batch: Array<{
    key: string;
    value: string;
    metadata: { contentType: string };
    base64: true;
  }> = [];
  let batchBytes = 0;

  const flushBatch = async () => {
    if (batch.length === 0) return;
    await cfJsonRequest<unknown>({
      url: `${apiBase}/client/v4/pages/assets/upload`,
      method: "POST",
      bearerToken: uploadJwt,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
      fetchImpl,
      signal: options.signal,
      redactTokens,
      context: "PagesUploadAssetBatch",
    });
    batch = [];
    batchBytes = 0;
  };

  const uploadedHashSeen = new Set<string>();
  for (const asset of assetsToUpload) {
    if (uploadedHashSeen.has(asset.assetHash32)) continue;
    uploadedHashSeen.add(asset.assetHash32);
    if (batch.length > 0 && batchBytes + asset.size > MAX_UPLOAD_BATCH_BYTES) {
      await flushBatch();
    }
    batch.push({
      key: asset.assetHash32,
      value: Buffer.from(asset.bytes).toString("base64"),
      metadata: { contentType: asset.contentType },
      base64: true,
    });
    batchBytes += asset.size;
  }
  await flushBatch();

  await cfJsonRequest<unknown>({
    url: `${apiBase}/client/v4/pages/assets/upsert-hashes`,
    method: "POST",
    bearerToken: uploadJwt,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hashes: allHashes }),
    fetchImpl,
    signal: options.signal,
    redactTokens,
    context: "PagesUpsertHashes",
  });

  const manifest: Record<string, string> = {};
  for (const asset of assets) {
    manifest[asset.routePath] = asset.assetHash32;
  }

  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));
  if (options.branch?.trim()) form.set("branch", options.branch.trim());
  if (options.commitHash?.trim()) form.set("commit_hash", options.commitHash.trim());
  if (options.commitMessage?.trim()) {
    form.set("commit_message", options.commitMessage.trim());
  }

  const deployment = await cfJsonRequest<{ id?: string; url?: string }>({
    url: `${apiBase}/client/v4/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}/deployments`,
    method: "POST",
    bearerToken: apiToken,
    body: form,
    fetchImpl,
    signal: options.signal,
    redactTokens,
    context: "PagesCreateDeployment",
  });

  return {
    mode: "pages",
    accountId,
    targetName: projectName,
    ...(deployment.url ? { url: deployment.url } : {}),
    ...(deployment.id ? { deploymentId: deployment.id } : {}),
    totalFiles: assets.length,
    uploadedFiles: uploadedHashSeen.size,
    skippedFiles: assets.length - uploadedHashSeen.size,
    totalBytes,
    dryRun: false,
    deployedAt: new Date().toISOString(),
  };
}

export type CloudflareWorkersAssetsDeployOptions = {
  accountId: string;
  scriptName: string;
  apiToken: string;
  webDir: string;
  compatibilityDate?: string;
  apiBaseOrigin?: string;
  fetchImpl?: typeof fetch;
  dryRun?: boolean;
  signal?: AbortSignal;
};

export async function deployWebToCloudflareWorkersAssets(
  options: CloudflareWorkersAssetsDeployOptions,
): Promise<CloudflareWebDeployResult> {
  const accountId = validateCloudflareAccountId(options.accountId);
  const scriptName = options.scriptName?.trim() ?? "";
  if (!CF_PROJECT_NAME_PATTERN.test(scriptName)) {
    throw new Error(`Invalid Cloudflare Worker scriptName "${options.scriptName}"`);
  }
  const apiToken = options.apiToken?.trim() ?? "";
  const dryRun = options.dryRun === true;
  if (!dryRun && !apiToken) {
    throw new CloudflareError(
      "Cloudflare API token is required for Workers Static Assets deployment",
      { status: 401, code: "MissingApiToken" },
    );
  }

  const assets = collectWebStaticAssets(options.webDir);
  const totalBytes = assets.reduce((sum, a) => sum + a.size, 0);

  if (dryRun) {
    return {
      mode: "workers-assets",
      accountId,
      targetName: scriptName,
      totalFiles: assets.length,
      uploadedFiles: assets.length,
      skippedFiles: 0,
      totalBytes,
      dryRun: true,
      deployedAt: new Date().toISOString(),
    };
  }

  const apiBase = (options.apiBaseOrigin ?? "https://api.cloudflare.com").replace(
    /\/+$/g,
    "",
  );
  const fetchImpl = options.fetchImpl ?? fetch;

  const manifestPayload: Record<string, { hash: string; size: number }> = {};
  const byHash = new Map<string, CollectedWebAsset>();
  for (const asset of assets) {
    manifestPayload[asset.routePath] = {
      hash: asset.assetHash32,
      size: asset.size,
    };
    byHash.set(asset.assetHash32, asset);
  }

  const session = await cfJsonRequest<{
    jwt: string;
    buckets?: string[][];
  }>({
    url: `${apiBase}/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/assets-upload-session`,
    method: "POST",
    bearerToken: apiToken,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifest: manifestPayload }),
    fetchImpl,
    signal: options.signal,
    redactTokens: [apiToken],
    context: "WorkersAssetsCreateSession",
  });

  let completionJwt = session.jwt;
  const redactTokens = [apiToken, session.jwt];
  let uploadedCount = 0;

  for (const bucket of session.buckets ?? []) {
    if (bucket.length === 0) continue;
    const form = new FormData();
    for (const hash of bucket) {
      const asset = byHash.get(hash);
      if (!asset) continue;
      form.set(
        hash,
        new Blob([Buffer.from(asset.bytes)], { type: asset.contentType }),
        hash,
      );
      uploadedCount += 1;
    }
    const bucketRes = await cfJsonRequest<{ jwt?: string }>({
      url: `${apiBase}/client/v4/accounts/${accountId}/workers/assets/upload?base64=false`,
      method: "POST",
      bearerToken: session.jwt,
      body: form,
      fetchImpl,
      signal: options.signal,
      redactTokens,
      context: "WorkersAssetsUploadBucket",
    });
    if (bucketRes.jwt) {
      completionJwt = bucketRes.jwt;
      redactTokens.push(bucketRes.jwt);
    }
  }

  const metadata = {
    compatibility_date: options.compatibilityDate ?? "2026-01-01",
    assets: {
      jwt: completionJwt,
      config: {
        not_found_handling: "single-page-application",
      },
    },
  };

  const deployForm = new FormData();
  deployForm.set(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );

  const deployed = await cfJsonRequest<{ id?: string }>({
    url: `${apiBase}/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`,
    method: "PUT",
    bearerToken: apiToken,
    body: deployForm,
    fetchImpl,
    signal: options.signal,
    redactTokens,
    context: "WorkersPutAssetsScript",
  });

  return {
    mode: "workers-assets",
    accountId,
    targetName: scriptName,
    ...(deployed.id ? { deploymentId: deployed.id } : {}),
    totalFiles: assets.length,
    uploadedFiles: uploadedCount,
    skippedFiles: Math.max(0, assets.length - uploadedCount),
    totalBytes,
    dryRun: false,
    deployedAt: new Date().toISOString(),
  };
}

export async function deployWebToR2Site(options: {
  client: R2Client;
  webDir: string;
  routePrefix?: string;
  apiToken?: string;
  purgeCache?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
}): Promise<CloudflareWebDeployResult> {
  const assets = collectWebStaticAssets(options.webDir);
  const totalBytes = assets.reduce((sum, a) => sum + a.size, 0);
  const prefix = (options.routePrefix ?? "web").replace(/^\/+|\/+$/g, "");
  const dryRun = options.dryRun === true;

  const immutable = assets.filter((a) => a.immutable);
  const mutable = assets.filter((a) => !a.immutable);

  let uploadedFiles = 0;
  let skippedFiles = 0;

  for (const asset of immutable) {
    const relKey = prefix ? `${prefix}/${asset.relativePath}` : asset.relativePath;
    if (!dryRun) {
      const head = await options.client.headObject(relKey, options.signal);
      if (
        head.exists &&
        head.size === asset.size &&
        (!head.sha256 || head.sha256.toLowerCase() === asset.sha256.toLowerCase())
      ) {
        skippedFiles += 1;
        continue;
      }
      await options.client.uploadFile(relKey, asset.bytes, {
        contentType: asset.contentType,
        cacheControl: "public, max-age=31536000, immutable",
        sha256: asset.sha256,
        signal: options.signal,
      });
    }
    uploadedFiles += 1;
  }

  const mutableUrls: string[] = [];
  for (const asset of mutable) {
    const relKey = prefix ? `${prefix}/${asset.relativePath}` : asset.relativePath;
    if (!dryRun) {
      await options.client.uploadFile(relKey, asset.bytes, {
        contentType: asset.contentType,
        cacheControl: "no-cache, no-store, must-revalidate",
        sha256: asset.sha256,
        signal: options.signal,
      });
      mutableUrls.push(options.client.resolvePublicUrl(relKey));
    }
    uploadedFiles += 1;
  }

  if (!dryRun && options.purgeCache !== false && mutableUrls.length > 0) {
    await options.client.purgeZoneCache(mutableUrls, {
      apiToken: options.apiToken,
      signal: options.signal,
    });
  }

  const indexRel = prefix ? `${prefix}/index.html` : "index.html";
  return {
    mode: "r2-site",
    accountId: options.client.target.accountId,
    targetName: options.client.target.bucket,
    url: options.client.resolvePublicUrl(indexRel),
    totalFiles: assets.length,
    uploadedFiles,
    skippedFiles,
    totalBytes,
    dryRun,
    deployedAt: new Date().toISOString(),
  };
}
