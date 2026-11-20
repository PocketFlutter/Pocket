import { createHash } from "node:crypto";
import { lstat, open, type FileHandle } from "node:fs/promises";

import { awsUriEncode, encodeR2ObjectPath, sha256Hex, signR2Request } from "./sign.ts";
import {
  resolveCloudflareTarget,
  validateCloudflareZoneId,
  type CloudflareCredentialProvider,
  type CloudflarePurgeSummary,
  type CloudflareR2Credentials,
  type CloudflareTargetConfig,
  type ResolvedCloudflareTarget,
} from "./types.ts";

export class CloudflareError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(
    message: string,
    options: { status?: number; code?: string; requestId?: string } = {},
  ) {
    super(message);
    this.name = "CloudflareError";
    this.status = options.status ?? 0;
    this.code = options.code ?? "CloudflareError";
    this.requestId = options.requestId;
  }
}

export type R2HeadObjectResult =
  | { exists: false }
  | {
      exists: true;
      size: number;
      etag?: string;
      sha256?: string;
      contentType?: string;
      cacheControl?: string;
    };

export type R2PutObjectOptions = {
  contentType?: string;
  cacheControl?: string;
  sha256?: string;
  metadata?: Record<string, string>;
  signal?: AbortSignal;
};

export type R2UploadFileOptions = R2PutObjectOptions & {
  onPartUploaded?: (info: {
    partNumber: number;
    totalParts: number;
    bytes: number;
  }) => void;
};

export type R2ClientOptions = {
  target: CloudflareTargetConfig | ResolvedCloudflareTarget;
  credentials: CloudflareCredentialProvider;
  fetchImpl?: typeof fetch;
  multipartThresholdBytes?: number;
  partSizeBytes?: number;
  concurrency?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
};

export type R2Client = {
  readonly target: ResolvedCloudflareTarget;
  resolveObjectKey(relativePath: string): string;
  resolvePublicUrl(relativePath: string): string;
  checkAccess(signal?: AbortSignal): Promise<{ ok: true; status: number }>;
  headObject(relativeKey: string, signal?: AbortSignal): Promise<R2HeadObjectResult>;
  putObject(
    relativeKey: string,
    bytes: Uint8Array,
    options?: R2PutObjectOptions,
  ): Promise<{ etag?: string; sha256: string; size: number }>;
  uploadFile(
    relativeKey: string,
    source: string | Uint8Array,
    options?: R2UploadFileOptions,
  ): Promise<{ etag?: string; sha256: string; size: number; multipart: boolean }>;
  purgeZoneCache(
    urls: readonly string[],
    options?: { apiToken?: string; signal?: AbortSignal },
  ): Promise<CloudflarePurgeSummary | undefined>;
};

const DEFAULT_MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;
const DEFAULT_PART_SIZE_BYTES = 5 * 1024 * 1024; // R2/S3 minimum non-final part is 5 MiB
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_RETRIES = 2;
const CF_PURGE_BATCH_LIMIT = 30;

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function validateRelativeR2ObjectPath(relativePath: string): string {
  if (typeof relativePath !== "string") {
    throw new Error("Cloudflare R2 relative object path must be a string");
  }
  if (hasControlChar(relativePath)) {
    throw new Error("Cloudflare R2 object path must not contain control characters");
  }
  if (relativePath.includes("\\")) {
    throw new Error("Cloudflare R2 object path must not contain backslashes");
  }
  if (relativePath.startsWith("/")) {
    throw new Error("Cloudflare R2 relative object path must not start with '/'");
  }
  const trimmed = relativePath.replace(/\/+$/g, "");
  if (!trimmed) {
    throw new Error("Cloudflare R2 relative object path must not be empty");
  }
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Unsafe Cloudflare R2 object path segment in "${relativePath}"`);
    }
  }
  return segments.join("/");
}

function md5Base64(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("base64");
}

function extractXmlTag(xml: string, tagName: string): string | undefined {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match?.[1]?.trim();
}

export function redactCloudflareSecrets(
  text: string,
  credentials?: Partial<CloudflareR2Credentials>,
): string {
  let out = text;
  if (!credentials) return out;
  for (const secret of [
    credentials.secretAccessKey,
    credentials.sessionToken,
    credentials.apiToken,
  ]) {
    if (secret && secret.trim()) {
      out = out.split(secret.trim()).join("[REDACTED]");
    }
  }
  if (credentials.accessKeyId?.trim()) {
    out = out.split(credentials.accessKeyId.trim()).join("[REDACTED_AK]");
  }
  return out;
}

function parseR2XmlError(
  status: number,
  bodyText: string,
  headers: Headers,
  credentials: CloudflareR2Credentials,
  context: string,
): CloudflareError {
  const code = extractXmlTag(bodyText, "Code") ?? `HTTP_${status}`;
  const rawMessage =
    extractXmlTag(bodyText, "Message") ??
    `Cloudflare R2 ${context} failed with HTTP ${status}`;
  const requestId =
    extractXmlTag(bodyText, "RequestId") ??
    headers.get("cf-ray") ??
    headers.get("x-amz-request-id") ??
    undefined;
  const safeMessage = redactCloudflareSecrets(
    `${context}: ${code} (${status}) - ${rawMessage}`,
    credentials,
  );
  return new CloudflareError(safeMessage, { status, code, requestId });
}

function buildQueryString(
  query?: Record<string, string | number | boolean | null | undefined>,
): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    parts.push(`${awsUriEncode(k)}=${awsUriEncode(v === null ? "" : String(v))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isResolvedTarget(
  target: CloudflareTargetConfig | ResolvedCloudflareTarget,
): target is ResolvedCloudflareTarget {
  return (
    typeof (target as ResolvedCloudflareTarget).endpointOrigin === "string" &&
    typeof (target as ResolvedCloudflareTarget).bucketPathPrefix === "string"
  );
}

export async function purgeCloudflareZoneCache(options: {
  zoneId: string;
  urls: readonly string[];
  apiToken: string;
  apiBaseOrigin?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<CloudflarePurgeSummary> {
  const zoneId = validateCloudflareZoneId(options.zoneId);
  const token = options.apiToken?.trim() ?? "";
  if (!token) {
    throw new CloudflareError(
      "Cloudflare API token is required for Zone Cache Purge",
      { status: 401, code: "MissingApiToken" },
    );
  }
  const uniqueUrls = [...new Set(options.urls.map((u) => u.trim()).filter(Boolean))];
  if (uniqueUrls.length === 0) {
    return { zoneId, purgedUrls: [], batches: 0 };
  }

  const apiBase = (options.apiBaseOrigin ?? "https://api.cloudflare.com").replace(
    /\/+$/g,
    "",
  );
  const endpoint = `${apiBase}/client/v4/zones/${zoneId}/purge_cache`;
  const fetchImpl = options.fetchImpl ?? fetch;

  let batches = 0;
  for (let i = 0; i < uniqueUrls.length; i += CF_PURGE_BATCH_LIMIT) {
    options.signal?.throwIfAborted?.();
    const chunk = uniqueUrls.slice(i, i + CF_PURGE_BATCH_LIMIT);
    batches += 1;

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files: chunk }),
        signal: options.signal,
        redirect: "manual",
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw new CloudflareError(
        redactCloudflareSecrets(`ZoneCachePurge network error: ${msg}`, {
          apiToken: token,
        }),
        { status: 0, code: "NetworkError" },
      );
    }

    const rawText = await response.text().catch(() => "");
    let parsed: { success?: boolean; errors?: Array<{ code?: number; message?: string }> } = {};
    try {
      parsed = JSON.parse(rawText) as typeof parsed;
    } catch {
      parsed = {};
    }

    if (!response.ok || parsed.success !== true) {
      const detail =
        parsed.errors?.map((e) => e.message ?? String(e.code ?? "")).join("; ") ||
        rawText.slice(0, 200) ||
        `HTTP ${response.status}`;
      throw new CloudflareError(
        redactCloudflareSecrets(
          `Cloudflare Zone Cache Purge failed (${response.status}): ${detail}`,
          { apiToken: token },
        ),
        {
          status: response.status,
          code: "PurgeFailed",
          requestId: response.headers.get("cf-ray") ?? undefined,
        },
      );
    }
  }

  return {
    zoneId,
    purgedUrls: uniqueUrls,
    batches,
  };
}

export function createR2Client(options: R2ClientOptions): R2Client {
  const target = isResolvedTarget(options.target)
    ? options.target
    : resolveCloudflareTarget(options.target);
  const fetchImpl = options.fetchImpl ?? fetch;
  const multipartThresholdBytes =
    options.multipartThresholdBytes ?? DEFAULT_MULTIPART_THRESHOLD_BYTES;
  const partSizeBytes = options.partSizeBytes ?? DEFAULT_PART_SIZE_BYTES;
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? DEFAULT_CONCURRENCY));
  const maxRetries = Math.max(0, Math.min(5, options.maxRetries ?? DEFAULT_MAX_RETRIES));
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 50;

  if (partSizeBytes <= 0 || !Number.isSafeInteger(partSizeBytes)) {
    throw new Error("partSizeBytes must be a positive integer");
  }
  if (multipartThresholdBytes <= 0 || !Number.isSafeInteger(multipartThresholdBytes)) {
    throw new Error("multipartThresholdBytes must be a positive integer");
  }

  const getCredentials = async (): Promise<CloudflareR2Credentials> => {
    const resolved =
      typeof options.credentials === "function"
        ? await options.credentials()
        : options.credentials;
    if (!resolved?.accessKeyId?.trim() || !resolved?.secretAccessKey?.trim()) {
      throw new CloudflareError(
        "Cloudflare R2 credentials are missing accessKeyId or secretAccessKey",
        { status: 401, code: "MissingCredentials" },
      );
    }
    return {
      accountId: (resolved.accountId ?? target.accountId).trim().toLowerCase(),
      accessKeyId: resolved.accessKeyId.trim(),
      secretAccessKey: resolved.secretAccessKey.trim(),
      ...(resolved.sessionToken?.trim()
        ? { sessionToken: resolved.sessionToken.trim() }
        : {}),
      ...(resolved.apiToken?.trim() ? { apiToken: resolved.apiToken.trim() } : {}),
    };
  };

  const resolveObjectKey = (relativePath: string): string => {
    const cleanRel = validateRelativeR2ObjectPath(relativePath);
    return target.keyPrefix ? `${target.keyPrefix}/${cleanRel}` : cleanRel;
  };

  const resolvePublicUrl = (relativePath: string): string => {
    const cleanRel = validateRelativeR2ObjectPath(relativePath);
    const encodedRel = cleanRel
      .split("/")
      .map((s) => awsUriEncode(s))
      .join("/");
    return `${target.publicBaseUrl}/${encodedRel}`;
  };

  const sendSignedRequest = async (input: {
    method: string;
    objectKey?: string;
    query?: Record<string, string | number | boolean | null | undefined>;
    headers?: Record<string, string | number | undefined>;
    body?: Uint8Array | string;
    payloadSha256?: string;
    idempotent: boolean;
    signal?: AbortSignal;
    context: string;
  }): Promise<{ response: Response; credentials: CloudflareR2Credentials }> => {
    const credentials = await getCredentials();
    const pathname = encodeR2ObjectPath(target.bucket, input.objectKey);
    const queryStr = buildQueryString(input.query);
    const url = `${target.endpointOrigin}${pathname}${queryStr}`;

    const bodyBytes =
      typeof input.body === "string"
        ? new TextEncoder().encode(input.body)
        : input.body;
    const payloadSha256 =
      input.payloadSha256 ??
      (bodyBytes !== undefined ? sha256Hex(bodyBytes) : sha256Hex(""));

    const baseHeaders: Record<string, string | number | undefined> = {
      Host: target.endpointHost,
      ...(bodyBytes !== undefined ? { "Content-Length": bodyBytes.byteLength } : {}),
      ...(input.headers ?? {}),
    };

    let attempt = 0;
    while (true) {
      input.signal?.throwIfAborted?.();
      const signed = signR2Request({
        method: input.method,
        pathname,
        query: input.query,
        headers: baseHeaders,
        payloadSha256,
        credentials,
      });

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: input.method.toUpperCase(),
          headers: signed.headers,
          body: bodyBytes
            ? Buffer.from(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength)
            : undefined,
          signal: input.signal,
          redirect: "manual",
        });
      } catch (error) {
        if (input.signal?.aborted) throw error;
        if (input.idempotent && attempt < maxRetries) {
          attempt += 1;
          await new Promise((r) => setTimeout(r, retryBaseDelayMs * attempt));
          continue;
        }
        const rawMsg = error instanceof Error ? error.message : String(error);
        throw new CloudflareError(
          redactCloudflareSecrets(`${input.context}: network error - ${rawMsg}`, credentials),
          { status: 0, code: "NetworkError" },
        );
      }

      if (input.idempotent && isRetryableStatus(response.status) && attempt < maxRetries) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, retryBaseDelayMs * attempt));
        continue;
      }

      return { response, credentials };
    }
  };

  const checkAccess = async (signal?: AbortSignal): Promise<{ ok: true; status: number }> => {
    const { response, credentials } = await sendSignedRequest({
      method: "HEAD",
      idempotent: true,
      signal,
      context: `HeadBucket(${target.bucket})`,
    });

    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }

    if (response.status === 403 && target.keyPrefix) {
      const probeKey = `${target.keyPrefix}/.pocket-r2-probe`;
      const probe = await sendSignedRequest({
        method: "HEAD",
        objectKey: probeKey,
        idempotent: true,
        signal,
        context: "HeadPrefixProbe",
      });
      if (probe.response.status === 200 || probe.response.status === 404) {
        return { ok: true, status: probe.response.status };
      }
      const probeBody = await probe.response.text().catch(() => "");
      throw parseR2XmlError(
        probe.response.status,
        probeBody,
        probe.response.headers,
        credentials,
        "HeadPrefixProbe",
      );
    }

    const bodyText = await response.text().catch(() => "");
    throw parseR2XmlError(
      response.status,
      bodyText,
      response.headers,
      credentials,
      `HeadBucket(${target.bucket})`,
    );
  };

  const headObject = async (
    relativeKey: string,
    signal?: AbortSignal,
  ): Promise<R2HeadObjectResult> => {
    const objectKey = resolveObjectKey(relativeKey);
    const { response, credentials } = await sendSignedRequest({
      method: "HEAD",
      objectKey,
      idempotent: true,
      signal,
      context: `HeadObject(${objectKey})`,
    });

    if (response.status === 404) {
      return { exists: false };
    }

    if (response.status >= 200 && response.status < 300) {
      const sizeHeader = response.headers.get("content-length");
      const size = sizeHeader !== null ? Number(sizeHeader) : 0;
      const rawEtag = response.headers.get("etag") ?? undefined;
      const etag = rawEtag ? rawEtag.replace(/^"|"$/g, "") : undefined;
      const sha256 = response.headers.get("x-amz-meta-sha256") ?? undefined;
      const contentType = response.headers.get("content-type") ?? undefined;
      const cacheControl = response.headers.get("cache-control") ?? undefined;
      return {
        exists: true,
        size: Number.isFinite(size) ? size : 0,
        ...(etag ? { etag } : {}),
        ...(sha256 ? { sha256 } : {}),
        ...(contentType ? { contentType } : {}),
        ...(cacheControl ? { cacheControl } : {}),
      };
    }

    const bodyText = await response.text().catch(() => "");
    throw parseR2XmlError(
      response.status,
      bodyText,
      response.headers,
      credentials,
      `HeadObject(${objectKey})`,
    );
  };

  const putObject = async (
    relativeKey: string,
    bytes: Uint8Array,
    putOptions: R2PutObjectOptions = {},
  ): Promise<{ etag?: string; sha256: string; size: number }> => {
    const objectKey = resolveObjectKey(relativeKey);
    const sha256 = putOptions.sha256 ?? sha256Hex(bytes);
    const contentMd5 = md5Base64(bytes);

    const headers: Record<string, string | number | undefined> = {
      "Content-Type": putOptions.contentType ?? "application/octet-stream",
      "Content-MD5": contentMd5,
      "x-amz-meta-sha256": sha256,
      ...(putOptions.cacheControl ? { "Cache-Control": putOptions.cacheControl } : {}),
    };
    if (putOptions.metadata) {
      for (const [k, v] of Object.entries(putOptions.metadata)) {
        const headerKey = k.toLowerCase().startsWith("x-amz-meta-")
          ? k.toLowerCase()
          : `x-amz-meta-${k.toLowerCase()}`;
        headers[headerKey] = v;
      }
    }

    const { response, credentials } = await sendSignedRequest({
      method: "PUT",
      objectKey,
      headers,
      body: bytes,
      payloadSha256: sha256,
      idempotent: true,
      signal: putOptions.signal,
      context: `PutObject(${objectKey})`,
    });

    if (response.status < 200 || response.status >= 300) {
      const bodyText = await response.text().catch(() => "");
      throw parseR2XmlError(
        response.status,
        bodyText,
        response.headers,
        credentials,
        `PutObject(${objectKey})`,
      );
    }

    const rawEtag = response.headers.get("etag") ?? undefined;
    const etag = rawEtag ? rawEtag.replace(/^"|"$/g, "") : undefined;
    return {
      ...(etag ? { etag } : {}),
      sha256,
      size: bytes.byteLength,
    };
  };

  const readFileSlice = async (
    handle: FileHandle,
    position: number,
    length: number,
  ): Promise<Uint8Array> => {
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(out, offset, length - offset, position + offset);
      if (bytesRead === 0) {
        throw new CloudflareError(
          `Unexpected EOF while reading upload slice at offset ${position + offset}`,
          { status: 400, code: "TruncatedSourceFile" },
        );
      }
      offset += bytesRead;
    }
    return out;
  };

  const streamFileSha256 = async (handle: FileHandle, totalSize: number): Promise<string> => {
    const hash = createHash("sha256");
    const chunkSize = Math.min(1024 * 1024, Math.max(totalSize, 1));
    const scratch = new Uint8Array(chunkSize);
    let offset = 0;
    while (offset < totalSize) {
      const toRead = Math.min(scratch.byteLength, totalSize - offset);
      const { bytesRead } = await handle.read(scratch, 0, toRead, offset);
      if (bytesRead === 0) {
        throw new CloudflareError(
          `Unexpected EOF while hashing upload source at offset ${offset}`,
          { status: 400, code: "TruncatedSourceFile" },
        );
      }
      hash.update(scratch.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return hash.digest("hex");
  };

  const uploadFile = async (
    relativeKey: string,
    source: string | Uint8Array,
    uploadOptions: R2UploadFileOptions = {},
  ): Promise<{ etag?: string; sha256: string; size: number; multipart: boolean }> => {
    let fileHandle: FileHandle | undefined;
    let totalSize: number;
    if (typeof source === "string") {
      const st = await lstat(source);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new CloudflareError(
          `Refusing to upload non-regular or symlink file: ${source}`,
          { status: 400, code: "UnsafeSourceFile" },
        );
      }
      totalSize = st.size;
      fileHandle = await open(source, "r");
    } else {
      totalSize = source.byteLength;
    }

    try {
      const sha256 =
        uploadOptions.sha256 ??
        (fileHandle
          ? await streamFileSha256(fileHandle, totalSize)
          : sha256Hex(source as Uint8Array));

      if (totalSize < multipartThresholdBytes) {
        const smallBytes = fileHandle
          ? await readFileSlice(fileHandle, 0, totalSize)
          : (source as Uint8Array);
        const res = await putObject(relativeKey, smallBytes, {
          ...uploadOptions,
          sha256,
        });
        return { ...res, multipart: false };
      }

      const objectKey = resolveObjectKey(relativeKey);
      const initHeaders: Record<string, string | number | undefined> = {
        "Content-Type": uploadOptions.contentType ?? "application/octet-stream",
        "x-amz-meta-sha256": sha256,
        ...(uploadOptions.cacheControl
          ? { "Cache-Control": uploadOptions.cacheControl }
          : {}),
      };
      if (uploadOptions.metadata) {
        for (const [k, v] of Object.entries(uploadOptions.metadata)) {
          const headerKey = k.toLowerCase().startsWith("x-amz-meta-")
            ? k.toLowerCase()
            : `x-amz-meta-${k.toLowerCase()}`;
          initHeaders[headerKey] = v;
        }
      }

      const initResult = await sendSignedRequest({
        method: "POST",
        objectKey,
        query: { uploads: "" },
        headers: initHeaders,
        idempotent: false,
        signal: uploadOptions.signal,
        context: `CreateMultipartUpload(${objectKey})`,
      });

      const initBody = await initResult.response.text().catch(() => "");
      if (initResult.response.status < 200 || initResult.response.status >= 300) {
        throw parseR2XmlError(
          initResult.response.status,
          initBody,
          initResult.response.headers,
          initResult.credentials,
          `CreateMultipartUpload(${objectKey})`,
        );
      }

      const uploadId = extractXmlTag(initBody, "UploadId");
      if (!uploadId) {
        throw new CloudflareError(
          `CreateMultipartUpload(${objectKey}) did not return an <UploadId>`,
          { status: initResult.response.status, code: "InvalidResponse" },
        );
      }

      const abortMultipart = async (): Promise<void> => {
        try {
          await sendSignedRequest({
            method: "DELETE",
            objectKey,
            query: { uploadId },
            idempotent: true,
            context: `AbortMultipartUpload(${objectKey})`,
          });
        } catch {
          // Best-effort abort cleanup before rethrowing the primary error.
        }
      };

      try {
        const totalParts = Math.ceil(totalSize / partSizeBytes);
        const completedParts: Array<{ partNumber: number; etag: string }> = new Array(
          totalParts,
        );
        let nextPartIndex = 0;

        const worker = async (): Promise<void> => {
          while (true) {
            uploadOptions.signal?.throwIfAborted?.();
            const currentIndex = nextPartIndex;
            if (currentIndex >= totalParts) return;
            nextPartIndex += 1;

            const partNumber = currentIndex + 1;
            const start = currentIndex * partSizeBytes;
            const end = Math.min(start + partSizeBytes, totalSize);
            const chunk = fileHandle
              ? await readFileSlice(fileHandle, start, end - start)
              : (source as Uint8Array).subarray(start, end);
            const partMd5 = md5Base64(chunk);
            const partSha = sha256Hex(chunk);

            const partResp = await sendSignedRequest({
              method: "PUT",
              objectKey,
              query: { partNumber, uploadId },
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-MD5": partMd5,
              },
              body: chunk,
              payloadSha256: partSha,
              idempotent: true,
              signal: uploadOptions.signal,
              context: `UploadPart(${objectKey}, part=${partNumber})`,
            });

            if (partResp.response.status < 200 || partResp.response.status >= 300) {
              const errBody = await partResp.response.text().catch(() => "");
              throw parseR2XmlError(
                partResp.response.status,
                errBody,
                partResp.response.headers,
                partResp.credentials,
                `UploadPart(${objectKey}, part=${partNumber})`,
              );
            }

            const rawEtag = partResp.response.headers.get("etag") ?? "";
            const cleanEtag = rawEtag.replace(/^"|"$/g, "");
            if (!cleanEtag) {
              throw new CloudflareError(
                `UploadPart(${objectKey}, part=${partNumber}) missing ETag response header`,
                { status: partResp.response.status, code: "MissingETag" },
              );
            }

            completedParts[currentIndex] = {
              partNumber,
              etag: `"${cleanEtag}"`,
            };
            uploadOptions.onPartUploaded?.({
              partNumber,
              totalParts,
              bytes: chunk.byteLength,
            });
          }
        };

        const workerCount = Math.min(concurrency, totalParts);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));

        const sortedParts = [...completedParts].sort(
          (a, b) => a.partNumber - b.partNumber,
        );
        const xmlLines = ["<CompleteMultipartUpload>"];
        for (const part of sortedParts) {
          xmlLines.push(
            `  <Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`,
          );
        }
        xmlLines.push("</CompleteMultipartUpload>");
        const completeXml = xmlLines.join("\n");

        const completeResp = await sendSignedRequest({
          method: "POST",
          objectKey,
          query: { uploadId },
          headers: { "Content-Type": "application/xml" },
          body: completeXml,
          idempotent: false,
          signal: uploadOptions.signal,
          context: `CompleteMultipartUpload(${objectKey})`,
        });

        const completeBody = await completeResp.response.text().catch(() => "");
        if (
          completeResp.response.status < 200 ||
          completeResp.response.status >= 300 ||
          /<Error[\s>]/i.test(completeBody)
        ) {
          throw parseR2XmlError(
            completeResp.response.status,
            completeBody,
            completeResp.response.headers,
            completeResp.credentials,
            `CompleteMultipartUpload(${objectKey})`,
          );
        }

        const rawEtag =
          extractXmlTag(completeBody, "ETag") ??
          completeResp.response.headers.get("etag") ??
          undefined;
        const etag = rawEtag ? rawEtag.replace(/^"|"$/g, "") : undefined;

        return {
          ...(etag ? { etag } : {}),
          sha256,
          size: totalSize,
          multipart: true,
        };
      } catch (error) {
        await abortMultipart();
        throw error;
      }
    } finally {
      if (fileHandle) {
        await fileHandle.close().catch(() => {});
      }
    }
  };

  const purgeZoneCache = async (
    urls: readonly string[],
    purgeOptions: { apiToken?: string; signal?: AbortSignal } = {},
  ): Promise<CloudflarePurgeSummary | undefined> => {
    if (!target.zoneId || urls.length === 0) return undefined;
    const creds = await getCredentials();
    const apiToken = purgeOptions.apiToken?.trim() || creds.apiToken?.trim();
    if (!apiToken) {
      return undefined;
    }
    return await purgeCloudflareZoneCache({
      zoneId: target.zoneId,
      urls,
      apiToken,
      apiBaseOrigin: target.apiBaseOrigin,
      fetchImpl,
      signal: purgeOptions.signal,
    });
  };

  return {
    target,
    resolveObjectKey,
    resolvePublicUrl,
    checkAccess,
    headObject,
    putObject,
    uploadFile,
    purgeZoneCache,
  };
}
