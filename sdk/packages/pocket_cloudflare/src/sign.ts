import type { CloudflareR2Credentials } from "./types.ts";

const utf8Encoder = new TextEncoder();

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === "string" ? utf8Encoder.encode(input) : input;
}

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Pure TypeScript SHA-256 (FIPS 180-4) returning a 32-byte digest.
 * Zero `node:*` imports so `@pocket/cloudflare/sign` runs identically in
 * Node.js, Bun, Browser, Web Worker, and QuickJS.
 */
export function sha256Bytes(input: string | Uint8Array): Uint8Array {
  const msg = toBytes(input);
  const ml = msg.byteLength;
  const bitLenHi = Math.floor((ml * 8) / 0x100000000) >>> 0;
  const bitLenLo = ((ml * 8) & 0xffffffff) >>> 0;

  const totalBlocks = (((ml + 8) >>> 6) + 1) << 4;
  const words = new Uint32Array(totalBlocks);

  for (let i = 0; i < ml; i += 1) {
    words[i >>> 2] |= msg[i]! << (24 - (i & 3) * 8);
  }
  words[ml >>> 2] |= 0x80 << (24 - (ml & 3) * 8);
  words[totalBlocks - 2] = bitLenHi;
  words[totalBlocks - 1] = bitLenLo;

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalBlocks; offset += 16) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = words[offset + i]! >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        (rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)) >>> 0;
      const s1 =
        (rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  view.setUint32(0, h0, false);
  view.setUint32(4, h1, false);
  view.setUint32(8, h2, false);
  view.setUint32(12, h3, false);
  view.setUint32(16, h4, false);
  view.setUint32(20, h5, false);
  view.setUint32(24, h6, false);
  view.setUint32(28, h7, false);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256Bytes(input));
}

export function hmacSha256Bytes(
  key: string | Uint8Array,
  message: string | Uint8Array,
): Uint8Array {
  const blockSize = 64;
  let keyBytes = toBytes(key);
  if (keyBytes.byteLength > blockSize) {
    keyBytes = sha256Bytes(keyBytes);
  }
  const paddedKey = new Uint8Array(blockSize);
  paddedKey.set(keyBytes);

  const oKeyPad = new Uint8Array(blockSize);
  const iKeyPad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i += 1) {
    oKeyPad[i] = paddedKey[i]! ^ 0x5c;
    iKeyPad[i] = paddedKey[i]! ^ 0x36;
  }

  const msgBytes = toBytes(message);
  const innerInput = new Uint8Array(blockSize + msgBytes.byteLength);
  innerInput.set(iKeyPad, 0);
  innerInput.set(msgBytes, blockSize);
  const innerDigest = sha256Bytes(innerInput);

  const outerInput = new Uint8Array(blockSize + innerDigest.byteLength);
  outerInput.set(oKeyPad, 0);
  outerInput.set(innerDigest, blockSize);
  return sha256Bytes(outerInput);
}

export function hmacSha256Hex(
  key: string | Uint8Array,
  message: string | Uint8Array,
): string {
  return bytesToHex(hmacSha256Bytes(key, message));
}

export function awsUriEncode(value: string, encodeSlash = true): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return encodeSlash ? encoded : encoded.replace(/%2F/gi, "/");
}

export function encodeR2ObjectPath(bucket: string, objectKey?: string): string {
  const cleanBucket = bucket.replace(/^\/+|\/+$/g, "");
  if (!cleanBucket) {
    throw new Error("R2 bucket name is required for path encoding");
  }
  const trimmedKey = (objectKey ?? "").replace(/^\/+/, "");
  if (!trimmedKey) {
    return `/${awsUriEncode(cleanBucket)}`;
  }
  const segments = trimmedKey.split("/").filter((s) => s.length > 0);
  return `/${awsUriEncode(cleanBucket)}/${segments.map((s) => awsUriEncode(s)).join("/")}`;
}

export function formatAmzTimestamps(now: Date = new Date()): {
  amzDate: string;
  dateStamp: string;
} {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const amzDate = `${iso.slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);
  return { amzDate, dateStamp };
}

function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Uint8Array {
  const kDate = hmacSha256Bytes(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256Bytes(kDate, region);
  const kService = hmacSha256Bytes(kRegion, service);
  return hmacSha256Bytes(kService, "aws4_request");
}

const SIGNED_HEADER_NAMES = new Set([
  "host",
  "content-type",
  "content-length",
  "content-md5",
  "cache-control",
]);

function shouldSignHeader(lowerName: string): boolean {
  return SIGNED_HEADER_NAMES.has(lowerName) || lowerName.startsWith("x-amz-");
}

export type SignR2RequestInput = {
  method: string;
  pathname: string;
  query?: Record<string, string | number | boolean | null | undefined> | URLSearchParams;
  headers?: Record<string, string | number | undefined>;
  payloadSha256?: string;
  body?: string | Uint8Array;
  credentials: Pick<
    CloudflareR2Credentials,
    "accessKeyId" | "secretAccessKey" | "sessionToken"
  >;
  region?: string;
  service?: string;
  now?: Date;
  amzDate?: string;
};

export type SignR2RequestResult = {
  authorization: string;
  headers: Record<string, string>;
  amzDate: string;
  dateStamp: string;
  credentialScope: string;
  signedHeaders: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  payloadSha256: string;
};

export function signR2Request(input: SignR2RequestInput): SignR2RequestResult {
  const { credentials } = input;
  if (!credentials?.accessKeyId?.trim() || !credentials?.secretAccessKey?.trim()) {
    throw new Error(
      "Cloudflare R2 credentials require non-empty accessKeyId and secretAccessKey",
    );
  }
  const method = input.method.trim().toUpperCase();
  if (!method) {
    throw new Error("HTTP method is required for Cloudflare R2 request signing");
  }

  const region = input.region ?? "auto";
  const service = input.service ?? "s3";
  const timestamps = input.amzDate
    ? { amzDate: input.amzDate, dateStamp: input.amzDate.slice(0, 8) }
    : formatAmzTimestamps(input.now ?? new Date());

  const payloadSha256 =
    input.payloadSha256 ??
    (input.body !== undefined ? sha256Hex(input.body) : sha256Hex(""));

  const outHeaders: Record<string, string> = {};
  if (input.headers) {
    for (const [k, v] of Object.entries(input.headers)) {
      if (v === undefined) continue;
      outHeaders[k] = String(v);
    }
  }

  const setHeaderIfMissing = (headerName: string, value: string) => {
    const existing = Object.keys(outHeaders).find(
      (k) => k.toLowerCase() === headerName.toLowerCase(),
    );
    if (!existing) {
      outHeaders[headerName] = value;
    }
  };

  setHeaderIfMissing("x-amz-date", timestamps.amzDate);
  setHeaderIfMissing("x-amz-content-sha256", payloadSha256);
  if (credentials.sessionToken?.trim()) {
    setHeaderIfMissing("x-amz-security-token", credentials.sessionToken.trim());
  }

  const hasHost = Object.keys(outHeaders).some((k) => k.toLowerCase() === "host");
  if (!hasHost) {
    throw new Error("Host header is required for AWS SigV4 R2 signing");
  }

  const canonicalUri = input.pathname.startsWith("/")
    ? input.pathname
    : `/${input.pathname}`;

  const queryPairs: Array<{ key: string; val: string }> = [];
  if (input.query instanceof URLSearchParams) {
    input.query.forEach((val, key) => {
      queryPairs.push({
        key: awsUriEncode(key),
        val: awsUriEncode(val ?? ""),
      });
    });
  } else if (input.query && typeof input.query === "object") {
    for (const [rawKey, rawVal] of Object.entries(input.query)) {
      if (rawVal === undefined) continue;
      queryPairs.push({
        key: awsUriEncode(rawKey),
        val: awsUriEncode(rawVal === null ? "" : String(rawVal)),
      });
    }
  }
  queryPairs.sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : a.val < b.val ? -1 : a.val > b.val ? 1 : 0,
  );
  const canonicalQueryString = queryPairs
    .map((item) => `${item.key}=${item.val}`)
    .join("&");

  const headerPairs: Array<{ key: string; val: string }> = [];
  for (const [rawKey, rawVal] of Object.entries(outHeaders)) {
    const lowerKey = rawKey.trim().toLowerCase();
    if (!shouldSignHeader(lowerKey)) continue;
    const normalizedVal = rawVal.trim().replace(/\s+/g, " ");
    headerPairs.push({ key: lowerKey, val: normalizedVal });
  }
  headerPairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const canonicalHeaders = headerPairs
    .map((item) => `${item.key}:${item.val}\n`)
    .join("");
  const signedHeaders = headerPairs.map((item) => item.key).join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadSha256,
  ].join("\n");

  const credentialScope = `${timestamps.dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamps.amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(
    credentials.secretAccessKey.trim(),
    timestamps.dateStamp,
    region,
    service,
  );
  const signature = hmacSha256Hex(signingKey, stringToSign);

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId.trim()}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  outHeaders.Authorization = authorization;

  return {
    authorization,
    headers: outHeaders,
    amzDate: timestamps.amzDate,
    dateStamp: timestamps.dateStamp,
    credentialScope,
    signedHeaders,
    canonicalRequest,
    stringToSign,
    signature,
    payloadSha256,
  };
}

export type CreateR2PresignedUrlInput = {
  endpointOrigin: string;
  bucket: string;
  objectKey: string;
  method?: string;
  expiresSeconds?: number;
  query?: Record<string, string | number | boolean | null | undefined>;
  credentials: Pick<
    CloudflareR2Credentials,
    "accessKeyId" | "secretAccessKey" | "sessionToken"
  >;
  region?: string;
  now?: Date;
  amzDate?: string;
};

export function createR2PresignedUrl(input: CreateR2PresignedUrlInput): string {
  const endpointUrl = new URL(input.endpointOrigin);
  const pathname = encodeR2ObjectPath(input.bucket, input.objectKey);
  const method = (input.method ?? "GET").trim().toUpperCase();
  const region = input.region ?? "auto";
  const expiresSeconds = Math.max(1, Math.min(604800, input.expiresSeconds ?? 900));
  const timestamps = input.amzDate
    ? { amzDate: input.amzDate, dateStamp: input.amzDate.slice(0, 8) }
    : formatAmzTimestamps(input.now ?? new Date());
  const credentialScope = `${timestamps.dateStamp}/${region}/s3/aws4_request`;

  const queryParams: Record<string, string> = {};
  if (input.query) {
    for (const [k, v] of Object.entries(input.query)) {
      if (v === undefined) continue;
      queryParams[k] = v === null ? "" : String(v);
    }
  }
  queryParams["X-Amz-Algorithm"] = "AWS4-HMAC-SHA256";
  queryParams["X-Amz-Credential"] =
    `${input.credentials.accessKeyId.trim()}/${credentialScope}`;
  queryParams["X-Amz-Date"] = timestamps.amzDate;
  queryParams["X-Amz-Expires"] = String(expiresSeconds);
  queryParams["X-Amz-SignedHeaders"] = "host";
  if (input.credentials.sessionToken?.trim()) {
    queryParams["X-Amz-Security-Token"] = input.credentials.sessionToken.trim();
  }

  const sortedQuery = Object.entries(queryParams)
    .map(([k, v]) => ({ key: awsUriEncode(k), val: awsUriEncode(v) }))
    .sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : a.val < b.val ? -1 : a.val > b.val ? 1 : 0,
    );
  const canonicalQuery = sortedQuery.map((p) => `${p.key}=${p.val}`).join("&");
  const canonicalHeaders = `host:${endpointUrl.host}\n`;
  const canonicalRequest = [
    method,
    pathname,
    canonicalQuery,
    canonicalHeaders,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamps.amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(
    input.credentials.secretAccessKey.trim(),
    timestamps.dateStamp,
    region,
    "s3",
  );
  const signature = hmacSha256Hex(signingKey, stringToSign);
  return `${endpointUrl.origin}${pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
