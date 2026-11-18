import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { CosError, createCosClient } from "../src/client.ts";
import { camSafeUrlEncode, hmacSha1Hex, sha1Hex } from "../src/sign.ts";
import type { CosCredentials } from "../src/types.ts";

const TEST_CREDENTIALS: CosCredentials = {
  secretId: "AKID_MOCK_SERVER_123456",
  secretKey: "SK_MOCK_SERVER_SECRET_987654",
  securityToken: "SESSION_TOK_MOCK_111",
};

function verifyIncomingCosSignature(req: Request, credentials: CosCredentials): boolean {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("q-sign-algorithm=sha1&")) return false;
  const params = new Map<string, string>();
  for (const part of auth.split("&")) {
    const eq = part.indexOf("=");
    if (eq > 0) params.set(part.slice(0, eq), part.slice(eq + 1));
  }
  if (params.get("q-ak") !== credentials.secretId) return false;
  const signTime = params.get("q-sign-time") ?? "";
  const keyTime = params.get("q-key-time") ?? "";
  const headerList = (params.get("q-header-list") ?? "").split(";").filter(Boolean);
  const urlParamList = (params.get("q-url-param-list") ?? "").split(";").filter(Boolean);
  const signature = params.get("q-signature") ?? "";

  if (credentials.securityToken) {
    if (req.headers.get("x-cos-security-token") !== credentials.securityToken) {
      return false;
    }
    if (!headerList.includes("x-cos-security-token")) return false;
  }

  const url = new URL(req.url);
  const rawQueryPairs: Array<{ k: string; v: string }> = [];
  const rawSearch = url.search.startsWith("?") ? url.search.slice(1) : "";
  if (rawSearch) {
    for (const seg of rawSearch.split("&")) {
      const eq = seg.indexOf("=");
      const k = eq >= 0 ? decodeURIComponent(seg.slice(0, eq)) : decodeURIComponent(seg);
      const v = eq >= 0 ? decodeURIComponent(seg.slice(eq + 1)) : "";
      rawQueryPairs.push({
        k: camSafeUrlEncode(k.toLowerCase()),
        v: camSafeUrlEncode(v),
      });
    }
  }
  rawQueryPairs.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.v.localeCompare(b.v)));
  if (rawQueryPairs.map((p) => p.k).join(";") !== urlParamList.join(";")) return false;

  const httpParams = rawQueryPairs.map((p) => `${p.k}=${p.v}`).join("&");
  const httpHeaders = headerList
    .map((hk) => {
      const rawVal = req.headers.get(hk) ?? "";
      return `${hk}=${camSafeUrlEncode(rawVal.trim())}`;
    })
    .join("&");

  const httpString = `${req.method.toLowerCase()}\n${url.pathname}\n${httpParams}\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${signTime}\n${sha1Hex(httpString)}\n`;
  const signKey = hmacSha1Hex(credentials.secretKey, keyTime);
  const expectedSig = hmacSha1Hex(signKey, stringToSign);
  return expectedSig === signature;
}

test("COS XML v5 client: checkAccess (200 & 403+prefix probe), headObject, putObject, Multipart Upload, 200 OK <Error> rejection, and AbortMultipartUpload on failure", async () => {
  type StoredObject = {
    bytes: Uint8Array;
    etag: string;
    sha256?: string;
    contentType?: string;
    cacheControl?: string;
  };

  const objects = new Map<string, StoredObject>();
  const uploads = new Map<
    string,
    {
      objectKey: string;
      sha256?: string;
      contentType?: string;
      cacheControl?: string;
      parts: Map<number, { bytes: Uint8Array; etag: string }>;
    }
  >();
  const abortedUploadIds: string[] = [];

  let denyHeadBucketRoot = false;
  let failPartNumber: number | null = null;
  let return200ErrorOnComplete = false;
  let uploadCounter = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (!verifyIncomingCosSignature(req, TEST_CREDENTIALS)) {
        return new Response(
          `<Error><Code>SignatureDoesNotMatch</Code><Message>The Signature you specified is invalid.</Message></Error>`,
          { status: 403, headers: { "content-type": "application/xml" } },
        );
      }

      const url = new URL(req.url);
      const pathname = decodeURIComponent(url.pathname);
      const method = req.method.toUpperCase();

      // HeadBucket
      if (method === "HEAD" && pathname === "/") {
        if (denyHeadBucketRoot) {
          return new Response(null, { status: 403 });
        }
        return new Response(null, { status: 200 });
      }

      const objectKey = pathname.replace(/^\/+/, "");

      // Multipart Initiate: POST ?uploads
      if (method === "POST" && url.searchParams.has("uploads")) {
        uploadCounter += 1;
        const uploadId = `upload-${uploadCounter}`;
        uploads.set(uploadId, {
          objectKey,
          sha256: req.headers.get("x-cos-meta-sha256") ?? undefined,
          contentType: req.headers.get("content-type") ?? undefined,
          cacheControl: req.headers.get("cache-control") ?? undefined,
          parts: new Map(),
        });
        return new Response(
          `<InitiateMultipartUploadResult><Bucket>test-1250000000</Bucket><Key>${objectKey}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      }

      // Multipart UploadPart: PUT ?partNumber=N&uploadId=...
      if (
        method === "PUT" &&
        url.searchParams.has("partNumber") &&
        url.searchParams.has("uploadId")
      ) {
        const partNumber = Number(url.searchParams.get("partNumber"));
        const uploadId = url.searchParams.get("uploadId")!;
        const state = uploads.get(uploadId);
        if (!state) {
          return new Response(`<Error><Code>NoSuchUpload</Code></Error>`, { status: 404 });
        }
        if (failPartNumber === partNumber) {
          return new Response(
            `<Error><Code>AccessDenied</Code><Message>Simulated part failure</Message></Error>`,
            { status: 403, headers: { "content-type": "application/xml" } },
          );
        }
        const bytes = new Uint8Array(await req.arrayBuffer());
        const expectedMd5 = createHash("md5").update(bytes).digest("base64");
        if (req.headers.get("content-md5") !== expectedMd5) {
          return new Response(`<Error><Code>BadDigest</Code></Error>`, { status: 400 });
        }
        const etag = createHash("md5").update(bytes).digest("hex");
        state.parts.set(partNumber, { bytes, etag });
        return new Response(null, {
          status: 200,
          headers: { ETag: `"${etag}"` },
        });
      }

      // Multipart Complete: POST ?uploadId=...
      if (method === "POST" && url.searchParams.has("uploadId")) {
        const uploadId = url.searchParams.get("uploadId")!;
        const state = uploads.get(uploadId);
        if (!state) {
          return new Response(`<Error><Code>NoSuchUpload</Code></Error>`, { status: 404 });
        }
        if (return200ErrorOnComplete) {
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>Async complete failure</Message><RequestId>req-200-err</RequestId></Error>`,
            { status: 200, headers: { "content-type": "application/xml" } },
          );
        }
        const xmlBody = await req.text();
        const partMatches = [
          ...xmlBody.matchAll(
            /<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*<ETag>"?([^"<]+)"?<\/ETag>\s*<\/Part>/g,
          ),
        ];
        const chunks: Uint8Array[] = [];
        for (const m of partMatches) {
          const pn = Number(m[1]);
          const part = state.parts.get(pn);
          if (!part || part.etag !== m[2]) {
            return new Response(`<Error><Code>InvalidPart</Code></Error>`, { status: 400 });
          }
          chunks.push(part.bytes);
        }
        const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
        const combined = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          combined.set(c, offset);
          offset += c.byteLength;
        }
        const finalEtag = `${createHash("md5").update(combined).digest("hex")}-${partMatches.length}`;
        objects.set(objectKey, {
          bytes: combined,
          etag: finalEtag,
          sha256: state.sha256,
          contentType: state.contentType,
          cacheControl: state.cacheControl,
        });
        uploads.delete(uploadId);
        return new Response(
          `<CompleteMultipartUploadResult><Location>${url.origin}/${objectKey}</Location><Key>${objectKey}</Key><ETag>"${finalEtag}"</ETag></CompleteMultipartUploadResult>`,
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      }

      // Multipart Abort: DELETE ?uploadId=...
      if (method === "DELETE" && url.searchParams.has("uploadId")) {
        const uploadId = url.searchParams.get("uploadId")!;
        abortedUploadIds.push(uploadId);
        uploads.delete(uploadId);
        return new Response(null, { status: 204 });
      }

      // Single PutObject
      if (method === "PUT") {
        const bytes = new Uint8Array(await req.arrayBuffer());
        const expectedMd5 = createHash("md5").update(bytes).digest("base64");
        if (req.headers.get("content-md5") !== expectedMd5) {
          return new Response(`<Error><Code>BadDigest</Code></Error>`, { status: 400 });
        }
        const etag = createHash("md5").update(bytes).digest("hex");
        objects.set(objectKey, {
          bytes,
          etag,
          sha256: req.headers.get("x-cos-meta-sha256") ?? undefined,
          contentType: req.headers.get("content-type") ?? undefined,
          cacheControl: req.headers.get("cache-control") ?? undefined,
        });
        return new Response(null, {
          status: 200,
          headers: { ETag: `"${etag}"` },
        });
      }

      // HeadObject
      if (method === "HEAD") {
        const existing = objects.get(objectKey);
        if (!existing) {
          return new Response(null, { status: 404 });
        }
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": String(existing.bytes.byteLength),
            etag: `"${existing.etag}"`,
            ...(existing.sha256 ? { "x-cos-meta-sha256": existing.sha256 } : {}),
            ...(existing.contentType ? { "content-type": existing.contentType } : {}),
            ...(existing.cacheControl ? { "cache-control": existing.cacheControl } : {}),
          },
        });
      }

      return new Response(null, { status: 405 });
    },
  });

  try {
    const endpoint = `http://127.0.0.1:${server.port}`;
    const client = createCosClient({
      target: {
        bucket: "test-1250000000",
        region: "ap-guangzhou",
        endpoint,
        keyPrefix: "prod/app",
        allowInsecureHttpForTesting: true,
      },
      credentials: TEST_CREDENTIALS,
      multipartThresholdBytes: 1024,
      partSizeBytes: 400,
      concurrency: 3,
    });

    // 1. checkAccess 200
    const access1 = await client.checkAccess();
    expect(access1).toEqual({ ok: true, status: 200 });

    // 2. checkAccess 403 on root + prefix probe 404 -> succeeds
    denyHeadBucketRoot = true;
    const access2 = await client.checkAccess();
    expect(access2).toEqual({ ok: true, status: 404 });
    denyHeadBucketRoot = false;

    // 3. headObject missing -> exists: false
    expect(await client.headObject("blobs/missing")).toEqual({ exists: false });

    // 4. putObject + headObject
    const smallPayload = new TextEncoder().encode('{"hello":"cos"}');
    const putRes = await client.putObject("latest.json", smallPayload, {
      contentType: "application/json; charset=utf-8",
      cacheControl: "no-cache, no-store, must-revalidate",
    });
    expect(putRes.size).toBe(smallPayload.byteLength);

    const headRes = await client.headObject("latest.json");
    expect(headRes).toEqual({
      exists: true,
      size: smallPayload.byteLength,
      etag: putRes.etag,
      sha256: putRes.sha256,
      contentType: "application/json; charset=utf-8",
      cacheControl: "no-cache, no-store, must-revalidate",
    });

    // 5. Multipart Upload (Initiate -> concurrent UploadPart -> Complete)
    const largeBytes = new Uint8Array(1500);
    for (let i = 0; i < largeBytes.byteLength; i += 1) {
      largeBytes[i] = (i * 31) & 0xff;
    }
    const uploadedParts: number[] = [];
    const multiRes = await client.uploadFile("bundles/bundle-abc.7z", largeBytes, {
      contentType: "application/x-7z-compressed",
      cacheControl: "public, max-age=31536000, immutable",
      onPartUploaded: ({ partNumber }) => uploadedParts.push(partNumber),
    });
    expect(multiRes.multipart).toBe(true);
    expect(multiRes.size).toBe(1500);
    expect(uploadedParts.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);

    const storedMulti = objects.get("prod/app/bundles/bundle-abc.7z");
    expect(storedMulti).toBeDefined();
    expect([...storedMulti!.bytes]).toEqual([...largeBytes]);

    // 6. CompleteMultipartUpload returning HTTP 200 with <Error> must throw and trigger AbortMultipartUpload
    return200ErrorOnComplete = true;
    await expect(
      client.uploadFile("bundles/bundle-200-err.7z", largeBytes),
    ).rejects.toThrow(CosError);
    expect(abortedUploadIds.length).toBe(1);
    return200ErrorOnComplete = false;

    // 7. Part upload failure must trigger AbortMultipartUpload and never leak credentials
    failPartNumber = 2;
    let caughtError: unknown;
    try {
      await client.uploadFile("bundles/bundle-part-fail.7z", largeBytes);
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(CosError);
    expect(String(caughtError)).not.toContain(TEST_CREDENTIALS.secretKey);
    expect(String(caughtError)).not.toContain(TEST_CREDENTIALS.securityToken!);
    expect(abortedUploadIds.length).toBe(2);
    failPartNumber = null;
  } finally {
    server.stop(true);
  }
});
