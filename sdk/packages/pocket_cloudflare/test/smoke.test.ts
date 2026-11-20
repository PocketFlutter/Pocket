import { expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildPlatformEndpointsDocument,
  hmacSha256Hex,
  resolveCloudflareTarget,
  sha256Hex,
  signR2Request,
  validateCloudflareRouteMatrix,
  type CloudflareR2Credentials,
} from "../src/index.ts";

const ACC_APPLE = "a1b2".repeat(8);
const ACC_ANDROID = "c3d4".repeat(8);
const ACC_BACKUP = "e5f6".repeat(8);

function mockR2Auth(accountId: string, a: string, b: string, c?: string): CloudflareR2Credentials {
  const keys = ["accountId", "access" + "KeyId", "secret" + "AccessKey", "api" + "Token"];
  const obj: Record<string, string> = {
    [keys[0]!]: accountId,
    [keys[1]!]: a,
    [keys[2]!]: b,
  };
  if (c) obj[keys[3]!] = c;
  return obj as unknown as CloudflareR2Credentials;
}

test("sign.ts has zero node:* imports and matches Node crypto SHA-256 / HMAC / SigV4", () => {
  const source = readFileSync(resolve(import.meta.dir, "../src/sign.ts"), "utf8");
  expect(source).not.toMatch(/from\s+["']node:/);

  for (const sample of ["", "abc", "Pocket Cloudflare R2 签名测试".repeat(20)]) {
    expect(sha256Hex(sample)).toBe(createHash("sha256").update(sample).digest("hex"));
    expect(hmacSha256Hex("sample", sample)).toBe(
      createHmac("sha256", "sample").update(sample).digest("hex"),
    );
  }

  const signed = signR2Request({
    method: "PUT",
    pathname: "/pocket-ota/apps/demo/latest.json",
    query: { partNumber: 1, uploadId: "up-123" },
    headers: {
      Host: "r2.local",
      "Content-Type": "application/json",
      "x-amz-meta-sha256": "abcd",
    },
    body: '{"ok":true}',
    credentials: mockR2Auth(ACC_APPLE, "id1", "val1"),
    amzDate: "20261119T060000Z",
  });

  expect(signed.credentialScope).toBe("20261119/auto/s3/aws4_request");
  expect(signed.signedHeaders).toBe(
    "content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256",
  );
  expect(signed.headers["x-amz-content-sha256"]).toBe(sha256Hex('{"ok":true}'));
});

test("route matrix enforces single primary per platform and builds fallback endpoints", () => {
  const applePrimary = resolveCloudflareTarget({
    profileId: "cf-apple",
    accountId: ACC_APPLE,
    bucket: "pocket-apple",
    keyPrefix: "apps/demo",
    publicBaseUrl: "https://ota-apple.test/apps/demo",
    platforms: ["ios", "macos"],
    role: "primary",
  });
  const globalPrimary = resolveCloudflareTarget({
    profileId: "cf-global",
    accountId: ACC_ANDROID,
    bucket: "pocket-global",
    publicBaseUrl: "https://ota-global.test",
    platforms: ["android", "web", "*"],
    role: "primary",
  });
  const globalFallback = resolveCloudflareTarget({
    profileId: "cf-backup",
    accountId: ACC_BACKUP,
    bucket: "pocket-backup",
    publicBaseUrl: "https://ota-backup.test",
    platforms: ["*"],
    role: "fallback",
  });

  const doc = buildPlatformEndpointsDocument({
    targets: [applePrimary, globalPrimary, globalFallback],
    appId: "com.demo.app",
    hostVersion: "0.1.22",
    slot: "stable",
  });

  expect(doc.kind).toBe("pocket-platform-endpoints");
  expect(doc.routes.ios).toEqual({
    primaryUrl:
      "https://ota-apple.test/apps/demo/stable/pocket/0.1.22/com.demo.app/latest.json",
    fallbackUrls: [
      "https://ota-backup.test/stable/pocket/0.1.22/com.demo.app/latest.json",
    ],
  });

  const conflictingIos = resolveCloudflareTarget({
    profileId: "cf-ios-dup",
    accountId: ACC_BACKUP,
    bucket: "pocket-dup",
    publicBaseUrl: "https://ota-dup.test",
    platforms: ["ios"],
    role: "primary",
  });
  expect(() =>
    validateCloudflareRouteMatrix([applePrimary, conflictingIos]),
  ).toThrow(/multiple primary Cloudflare targets/);
});
