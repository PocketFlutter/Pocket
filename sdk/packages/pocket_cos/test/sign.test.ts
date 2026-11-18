import { expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  camSafeUrlEncode,
  createCosPresignedUrl,
  encodeCosObjectPath,
  hmacSha1Hex,
  sha1Hex,
  signCosRequest,
} from "../src/sign.ts";
import {
  normalizeCosKeyPrefix,
  resolveCosTarget,
  validateCosBucket,
  validateCosRegion,
} from "../src/types.ts";

test("sign.ts has zero node:* imports so it works in Browser/Worker/QuickJS", () => {
  const source = readFileSync(resolve(import.meta.dir, "../src/sign.ts"), "utf8");
  expect(source).not.toMatch(/from\s+["']node:/);
  expect(source).not.toMatch(/require\(\s*["']node:/);
});

test("sha1Hex and hmacSha1Hex match RFC 3174 / RFC 2104 vectors and node:crypto", () => {
  const vectors = [
    "",
    "abc",
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "a".repeat(1000),
    "中文路径/测试文件!()*'.json",
  ];
  for (const input of vectors) {
    const expected = createHash("sha1").update(input, "utf8").digest("hex");
    expect(sha1Hex(input)).toBe(expected);
  }

  const keys = ["key", "secretKey1234567890", "k".repeat(100)];
  for (const key of keys) {
    for (const msg of vectors) {
      const expected = createHmac("sha1", key).update(msg, "utf8").digest("hex");
      expect(hmacSha1Hex(key, msg)).toBe(expected);
    }
  }
});

test("camSafeUrlEncode and encodeCosObjectPath handle RFC 3986 special chars and UTF-8 Chinese keys", () => {
  expect(camSafeUrlEncode("!'()*")).toBe("%21%27%28%29%2A");
  expect(camSafeUrlEncode("hello world")).toBe("hello%20world");
  expect(camSafeUrlEncode("中文/测试")).toBe("%E4%B8%AD%E6%96%87%2F%E6%B5%8B%E8%AF%95");

  expect(encodeCosObjectPath("")).toBe("/");
  expect(encodeCosObjectPath("/")).toBe("/");
  expect(encodeCosObjectPath("pocket/0.1.0/my app!('test')*/中文.json")).toBe(
    "/pocket/0.1.0/my%20app%21%28%27test%27%29%2A/%E4%B8%AD%E6%96%87.json",
  );
});

test("signCosRequest enforces lowercase HTTP method, valueless ?uploads, x-cos-security-token, and COS XML v5 vector", () => {
  const credentials = {
    secretId: "AKIDQjz3ltompVjB15LitkWHFl9243",
    secretKey: "BQYIM75p8x0iWVFSIgqEKwFprpRSVH",
  };
  const keyTime = "1557902800;1557909900";
  const signed = signCosRequest({
    method: "PUT",
    objectKey: "exampleobject",
    query: {
      uploads: "",
      PartNumber: 1,
      uploadId: "1557902800",
    },
    headers: {
      Host: "examplebucket-1250000000.cos.ap-beijing.myqcloud.com",
      "Content-Type": "application/octet-stream",
      "Content-MD5": "ZzD2/1234==",
      "x-cos-meta-sha256": "abcdef0123456789",
      "X-Ignored-Header": "should-not-be-signed",
    },
    credentials,
    keyTime,
  });

  expect(signed.httpString.startsWith("put\n/exampleobject\n")).toBe(true);
  expect(signed.httpString).toContain("partnumber=1&uploadid=1557902800&uploads=");
  expect(signed.authorization).toContain("q-url-param-list=partnumber;uploadid;uploads");
  expect(signed.authorization).toContain(
    "q-header-list=content-md5;content-type;host;x-cos-meta-sha256",
  );

  // Verify exact COS v5 calculation steps
  const expectedSignKey = hmacSha1Hex(credentials.secretKey, keyTime);
  const expectedStringToSign = `sha1\n${keyTime}\n${sha1Hex(signed.httpString)}\n`;
  const expectedSignature = hmacSha1Hex(expectedSignKey, expectedStringToSign);
  expect(signed.signature).toBe(expectedSignature);
  expect(signed.authorization).toBe(
    `q-sign-algorithm=sha1&q-ak=${credentials.secretId}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=content-md5;content-type;host;x-cos-meta-sha256&q-url-param-list=partnumber;uploadid;uploads&q-signature=${expectedSignature}`,
  );

  // Security token inclusion
  const withToken = signCosRequest({
    method: "HEAD",
    objectKey: "/pocket/latest.json",
    headers: { Host: "demo-1250000000.cos.ap-guangzhou.myqcloud.com" },
    credentials: {
      ...credentials,
      securityToken: "tmp-token-xyz!()",
    },
    keyTime,
  });
  expect(withToken.headers["x-cos-security-token"]).toBe("tmp-token-xyz!()");
  expect(withToken.authorization).toContain("q-header-list=host;x-cos-security-token");
  expect(withToken.httpString).toContain("x-cos-security-token=tmp-token-xyz%21%28%29");

  // Presigned URL generation
  const presigned = createCosPresignedUrl({
    endpointOrigin: "https://demo-1250000000.cos.ap-guangzhou.myqcloud.com",
    objectKey: "pocket/中文!(test).json",
    credentials: {
      ...credentials,
      securityToken: "tok123",
    },
    nowSeconds: 1700000000,
    expiresSeconds: 600,
  });
  expect(presigned).toContain(
    "https://demo-1250000000.cos.ap-guangzhou.myqcloud.com/pocket/%E4%B8%AD%E6%96%87%21%28test%29.json?",
  );
  expect(presigned).toContain("q-sign-algorithm=sha1");
  expect(presigned).toContain("x-cos-security-token=tok123");
});

test("types.ts validators enforce bucket, region, keyPrefix, and publicBaseUrl rules", () => {
  expect(validateCosBucket("my-bucket-1250000000")).toBe("my-bucket-1250000000");
  expect(() => validateCosBucket("invalid_bucket")).toThrow(/Invalid COS bucket/);
  expect(() => validateCosBucket("missing-appid-123")).toThrow(/Invalid COS bucket/);

  expect(validateCosRegion("ap-guangzhou")).toBe("ap-guangzhou");
  expect(() => validateCosRegion("AP_GUANGZHOU")).toThrow(/Invalid COS region/);

  expect(normalizeCosKeyPrefix(undefined)).toBe("");
  expect(normalizeCosKeyPrefix("  /prod/releases/  ")).toBe("prod/releases");
  expect(() => normalizeCosKeyPrefix("a/../b")).toThrow(/\.\./);
  expect(() => normalizeCosKeyPrefix("a\\b")).toThrow(/backslash/);
  expect(() => normalizeCosKeyPrefix("a%2Fb")).toThrow(/percent/);
  expect(() => normalizeCosKeyPrefix("a//b")).toThrow(/empty/);
  expect(() => normalizeCosKeyPrefix("apps/pocket/releases")).toThrow(/pocket/);
  expect(normalizeCosKeyPrefix("apps/pocket-releases")).toBe("apps/pocket-releases");

  const target = resolveCosTarget({
    bucket: "my-bucket-1250000000",
    region: "ap-shanghai",
    keyPrefix: "/app/updates/",
  });
  expect(target.endpointOrigin).toBe("https://my-bucket-1250000000.cos.ap-shanghai.myqcloud.com");
  expect(target.publicBaseUrl).toBe(
    "https://my-bucket-1250000000.cos.ap-shanghai.myqcloud.com/app/updates",
  );

  expect(() =>
    resolveCosTarget({
      bucket: "my-bucket-1250000000",
      region: "ap-shanghai",
      publicBaseUrl: "https://cdn.example.com/apps/pocket/v1",
    }),
  ).toThrow(/pocket/);

  expect(() =>
    resolveCosTarget({
      bucket: "my-bucket-1250000000",
      region: "ap-shanghai",
      publicBaseUrl: "http://insecure.example.com",
    }),
  ).toThrow(/https:\/\//);

  const testHttpTarget = resolveCosTarget({
    bucket: "my-bucket-1250000000",
    region: "ap-shanghai",
    publicBaseUrl: "http://127.0.0.1:9000/custom/",
    allowInsecureHttpForTesting: true,
  });
  expect(testHttpTarget.publicBaseUrl).toBe("http://127.0.0.1:9000/custom");
});
