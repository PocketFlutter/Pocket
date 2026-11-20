import { expect, test } from "bun:test";
import { createPublicKey, randomUUID, verify as cryptoVerify } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  generateDevKey,
  packPak,
  packageArtifacts,
  pocketReleaseDirectory,
} from "../../../scripts/package_update.ts";
import type { PublishedVersion } from "../../../editor/version_store.ts";
import { runCloudflareCli } from "../src/cli.ts";
import {
  createR2Client,
  deployWebToCloudflarePages,
  deployWebToCloudflareWorkersAssets,
  deployWebToR2Site,
  inspectLocalCloudflareEnvironment,
  publishNativeInstallersToCloudflare,
  publishStudioVersionToCloudflareMatrix,
  publishToCloudflareMatrix,
  removeWorkspaceCloudflareProfile,
  resolveLocalCloudflareCredentials,
  sha256Hex,
  upsertWorkspaceCloudflareProfile,
  validateCloudflareRouteMatrix,
  type CloudflareR2Credentials,
  type UpsertWorkspaceCloudflareProfileInput,
} from "../src/index.ts";

const ACC_APPLE = "a1b2".repeat(8);
const ACC_ANDROID = "c3d4".repeat(8);
const ACC_BACKUP = "e5f6".repeat(8);
const ZONE_APPLE = "1122".repeat(8);

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

function makeTempDir(): string {
  const base = resolve(import.meta.dir, "../../../.pocket-build/cf-tests", randomUUID());
  mkdirSync(base, { recursive: true });
  return base;
}

test("multi-account credential vault enforces 0o600 permissions and redacts values", async () => {
  const dir = makeTempDir();
  try {
    const keysDir = join(dir, "keys");
    const savedA = upsertWorkspaceCloudflareProfile(keysDir, {
      ...(mockR2Auth(ACC_APPLE, "R2ID_APPLE_1234", "PRIVATE_APPLE_VAL", "PRIVATE_ZONE_VAL") as unknown as UpsertWorkspaceCloudflareProfileInput),
      profileId: "cf-apple",
      label: "Apple Production",
      buckets: [{ bucket: "pocket-apple", publicBaseUrl: "https://ota-apple.test" }],
      setDefault: true,
    });
    expect(savedA.profile.maskedAccessKeyId).toBe("R2ID****1234");
    expect(JSON.stringify(savedA.profile)).not.toContain("PRIVATE_APPLE_VAL");
    expect(JSON.stringify(savedA.profile)).not.toContain("PRIVATE_ZONE_VAL");

    upsertWorkspaceCloudflareProfile(keysDir, {
      ...(mockR2Auth(ACC_ANDROID, "R2ID_ANDR_5678", "PRIVATE_ANDR_VAL") as unknown as UpsertWorkspaceCloudflareProfileInput),
      profileId: "cf-android",
    });

    expect(lstatSync(savedA.path).mode & 0o777).toBe(0o600);

    const inspection = inspectLocalCloudflareEnvironment({
      env: {},
      workspaceKeysDir: keysDir,
      homeDir: dir,
    });
    expect(inspection.available).toBe(true);
    expect(inspection.source).toBe("workspace");
    expect(inspection.defaultProfileId).toBe("cf-apple");
    expect(inspection.profiles).toHaveLength(2);

    const resolvedAndroid = resolveLocalCloudflareCredentials(
      { profileId: "cf-android" },
      { env: {}, workspaceKeysDir: keysDir, homeDir: dir },
    );
    expect(resolvedAndroid.credentials.accountId).toBe(ACC_ANDROID);

    const cliOut = (await runCloudflareCli([
      "inspect",
      "--workspace-keys-dir",
      keysDir,
      "--json",
    ])) as { profiles: unknown[] };
    expect(cliOut.profiles.length).toBeGreaterThanOrEqual(2);

    expect(removeWorkspaceCloudflareProfile(keysDir, "cf-apple")).toBe(true);
    const afterRemove = inspectLocalCloudflareEnvironment({
      env: {},
      workspaceKeysDir: keysDir,
      homeDir: dir,
    });
    expect(afterRemove.profiles).toHaveLength(1);
    expect(afterRemove.defaultProfileId).toBe("cf-android");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createMockCloudflareCloud() {
  const objects = new Map<
    string,
    {
      bytes: Uint8Array;
      contentType: string;
      cacheControl: string;
      sha256: string;
      etag: string;
    }
  >();
  const multipartUploads = new Map<string, Map<number, Uint8Array>>();
  const purgedByZone = new Map<string, string[][]>();
  const operationLog: string[] = [];
  let failBucketPut: string | null = null;
  let uploadSeq = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();

    const purgeMatch = url.pathname.match(/^\/client\/v4\/zones\/([a-f0-9]{32})\/purge_cache$/i);
    if (purgeMatch && method === "POST") {
      const zoneId = purgeMatch[1]!.toLowerCase();
      const bodyJson = JSON.parse(String(init?.body ?? "{}")) as { files?: string[] };
      const list = purgedByZone.get(zoneId) ?? [];
      list.push(bodyJson.files ?? []);
      purgedByZone.set(zoneId, list);
      operationLog.push(`PURGE:${zoneId}:${(bodyJson.files ?? []).length}`);
      return new Response(JSON.stringify({ success: true, result: { id: zoneId } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const bucket = segments[0] ?? "";
    const objectKey = segments.slice(1).join("/");
    const storeKey = `${url.host}/${bucket}/${objectKey}`;
    const headers = new Headers(init?.headers);

    if (!headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 ")) {
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    }

    if (!objectKey && method === "HEAD") {
      return new Response(null, { status: 200 });
    }

    if (method === "HEAD") {
      const found = objects.get(storeKey);
      if (!found) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: {
          "content-length": String(found.bytes.byteLength),
          etag: `"${found.etag}"`,
          "x-amz-meta-sha256": found.sha256,
          "content-type": found.contentType,
          "cache-control": found.cacheControl,
        },
      });
    }

    if (method === "POST" && url.searchParams.has("uploads")) {
      const uploadId = `mp-${++uploadSeq}`;
      multipartUploads.set(`${storeKey}#${uploadId}`, new Map());
      return new Response(
        `<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
        { status: 200 },
      );
    }

    if (method === "PUT" && url.searchParams.has("uploadId")) {
      if (failBucketPut === bucket) {
        return new Response("<Error><Code>InternalError</Code><Message>Simulated failure</Message></Error>", {
          status: 500,
        });
      }
      const uploadId = url.searchParams.get("uploadId")!;
      const partNo = Number(url.searchParams.get("partNumber")!);
      const rawBody = init?.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : new Uint8Array(0);
      multipartUploads.get(`${storeKey}#${uploadId}`)?.set(partNo, rawBody);
      return new Response(null, {
        status: 200,
        headers: { etag: `"part-${partNo}-${sha256Hex(rawBody).slice(0, 8)}"` },
      });
    }

    if (method === "DELETE" && url.searchParams.has("uploadId")) {
      const uploadId = url.searchParams.get("uploadId")!;
      multipartUploads.delete(`${storeKey}#${uploadId}`);
      operationLog.push(`ABORT_MP:${bucket}:${objectKey}`);
      return new Response(null, { status: 204 });
    }

    if (method === "POST" && url.searchParams.has("uploadId")) {
      const uploadId = url.searchParams.get("uploadId")!;
      const partsMap = multipartUploads.get(`${storeKey}#${uploadId}`);
      if (!partsMap) return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 });
      const ordered = [...partsMap.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
      const total = ordered.reduce((s, b) => s + b.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const b of ordered) {
        merged.set(b, offset);
        offset += b.byteLength;
      }
      multipartUploads.delete(`${storeKey}#${uploadId}`);
      const sha = sha256Hex(merged);
      objects.set(storeKey, {
        bytes: merged,
        contentType: "application/octet-stream",
        cacheControl: "",
        sha256: sha,
        etag: sha.slice(0, 16),
      });
      operationLog.push(`PUT_MP:${bucket}:${objectKey}`);
      return new Response(`<CompleteMultipartUploadResult><ETag>"${sha.slice(0, 16)}"</ETag></CompleteMultipartUploadResult>`, {
        status: 200,
      });
    }

    if (method === "PUT") {
      if (failBucketPut === bucket) {
        return new Response("<Error><Code>InternalError</Code><Message>Simulated failure</Message></Error>", {
          status: 500,
        });
      }
      const rawBody = init?.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : new Uint8Array(0);
      const sha = headers.get("x-amz-meta-sha256") ?? sha256Hex(rawBody);
      objects.set(storeKey, {
        bytes: rawBody,
        contentType: headers.get("content-type") ?? "application/octet-stream",
        cacheControl: headers.get("cache-control") ?? "",
        sha256: sha,
        etag: sha.slice(0, 16),
      });
      operationLog.push(`PUT:${bucket}:${objectKey}`);
      return new Response(null, {
        status: 200,
        headers: { etag: `"${sha.slice(0, 16)}"` },
      });
    }

    return new Response("Not Found", { status: 404 });
  };

  return {
    objects,
    purgedByZone,
    operationLog,
    setFailBucketPut(bucket: string | null) {
      failBucketPut = bucket;
    },
    fetchImpl,
  };
}

test("cross-account two-phase OTA publish deduplicates blobs, rebases per-account host.json, purges cache, and aborts all Phase 2 on any Phase 1 failure", async () => {
  const dir = makeTempDir();
  try {
    const keyPath = join(dir, "release-key.json");
    const key = generateDevKey(keyPath, "cf-release-key");

    const jsPath = join(dir, "app.js");
    const pakPath = join(dir, "app.pak");
    writeFileSync(jsPath, "globalThis.frame=()=>1;\n");
    writeFileSync(
      pakPath,
      packPak([{ key: "ui:img.logo", dtype: 0, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }]),
    );

    const deployRoot = join(dir, "deploy");
    const pkgOut = pocketReleaseDirectory(deployRoot, "0.1.22", "com.demo.app", "1.0.0");
    packageArtifacts({
      appId: "com.demo.app",
      version: "1.0.0",
      build: 1,
      jsPath,
      pakPath,
      outDir: pkgOut,
      keyFile: keyPath,
      bundleFormat: "zip",
    });

    writeFileSync(
      join(pkgOut, "host.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "pocket-editor-app-host",
        updates: {
          baseUrl: "http://localhost:8791/stable",
          hostVersion: "0.1.22",
          packageVersion: "1.0.0",
          keyId: key.keyId,
          publicKey: key.publicKeyBase64,
          debugHttpHosts: ["localhost"],
        },
        release: { routeVersion: "1.0.0" },
        systemUI: "com.demo.app",
        applications: {
          "com.demo.app": {
            appId: "com.demo.app",
            bootstrapAssets: {
              "app.bytecode.json": {
                url: "http://localhost:8791/pocket/0.1.22/com.demo.app/1.0.0/bootstrap/app.bytecode.json",
                sha256: "a".repeat(64),
                size: 12,
              },
            },
          },
        },
      }),
    );

    const cloud = createMockCloudflareCloud();

    const makeClients = () => {
      const appleClient = createR2Client({
        target: {
          profileId: "cf-apple",
          accountId: ACC_APPLE,
          bucket: "pocket-apple",
          endpoint: "https://r2-apple.test",
          keyPrefix: "apps/demo",
          publicBaseUrl: "https://ota-apple.test/apps/demo",
          platforms: ["ios", "macos"],
          role: "primary",
          zoneId: ZONE_APPLE,
          apiBaseOrigin: "https://cf-api.test",
        },
        credentials: mockR2Auth(ACC_APPLE, "apple", "appleVal", "appleZone"),
        fetchImpl: cloud.fetchImpl,
        maxRetries: 0,
      });

      const androidClient = createR2Client({
        target: {
          profileId: "cf-android",
          accountId: ACC_ANDROID,
          bucket: "pocket-android",
          endpoint: "https://r2-android.test",
          publicBaseUrl: "https://ota-android.test",
          platforms: ["android", "web", "*"],
          role: "primary",
          apiBaseOrigin: "https://cf-api.test",
        },
        credentials: mockR2Auth(ACC_ANDROID, "andr", "andrVal"),
        fetchImpl: cloud.fetchImpl,
        maxRetries: 0,
      });

      return [appleClient, androidClient];
    };

    cloud.setFailBucketPut("pocket-android");
    await expect(
      publishToCloudflareMatrix({
        clients: makeClients(),
        deployRoot,
        slot: "stable",
        publicKey: key.publicKeyPem,
      }),
    ).rejects.toThrow(/Simulated failure/);

    expect(
      [...cloud.objects.keys()].some((k) => k.endsWith("latest.json")),
    ).toBe(false);

    cloud.setFailBucketPut(null);
    cloud.objects.clear();
    cloud.operationLog.length = 0;

    const endpointsPath = join(dir, "flutter/assets/pocket-endpoints.json");
    const result = await publishToCloudflareMatrix({
      clients: makeClients(),
      deployRoot,
      slot: "stable",
      publicKey: key.publicKeyPem,
      publicKeyBase64: key.publicKeyBase64,
      writeEndpointsPath: endpointsPath,
    });

    expect(result.targets).toHaveLength(2);
    expect(result.targets[0]!.cachePurge?.zoneId).toBe(ZONE_APPLE);
    expect(result.targets[0]!.cachePurge!.purgedUrls.some((u) => u.endsWith("/latest.json"))).toBe(true);

    const appleHostBytes = cloud.objects.get(
      `r2-apple.test/pocket-apple/apps/demo/pocket/0.1.22/com.demo.app/1.0.0/host.json`,
    )?.bytes;
    const androidHostBytes = cloud.objects.get(
      `r2-android.test/pocket-android/pocket/0.1.22/com.demo.app/1.0.0/host.json`,
    )?.bytes;
    expect(appleHostBytes).toBeDefined();
    expect(androidHostBytes).toBeDefined();

    const appleHost = JSON.parse(new TextDecoder().decode(appleHostBytes!));
    const androidHost = JSON.parse(new TextDecoder().decode(androidHostBytes!));
    expect(appleHost.updates.baseUrl).toBe("https://ota-apple.test/apps/demo/stable");
    expect(appleHost.updates.debugHttpHosts).toBeUndefined();
    expect(androidHost.updates.baseUrl).toBe("https://ota-android.test/stable");

    const applePutOps = cloud.operationLog.filter((op) => op.startsWith("PUT:pocket-apple:"));
    expect(applePutOps.at(-1)).toContain("latest.json");

    const savedEndpoints = JSON.parse(readFileSync(endpointsPath, "utf8"));
    expect(savedEndpoints.routes.ios.primaryUrl).toBe(
      "https://ota-apple.test/apps/demo/stable/pocket/0.1.22/com.demo.app/latest.json",
    );
    expect(savedEndpoints.routes.android.primaryUrl).toBe(
      "https://ota-android.test/stable/pocket/0.1.22/com.demo.app/latest.json",
    );

    const second = await publishToCloudflareMatrix({
      clients: makeClients(),
      deployRoot,
      slot: "stable",
      publicKey: key.publicKeyPem,
    });
    expect(second.targets[0]!.skippedFiles).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multipart upload splits large archives and native installers publish platform-scoped signed download manifests", async () => {
  const dir = makeTempDir();
  try {
    const keyPath = join(dir, "installer-key.json");
    const key = generateDevKey(keyPath, "installer-ed25519");
    const cloud = createMockCloudflareCloud();

    const appleClient = createR2Client({
      target: {
        profileId: "cf-apple",
        accountId: ACC_APPLE,
        bucket: "pocket-apple",
        endpoint: "https://r2-apple.test",
        publicBaseUrl: "https://dl-apple.test",
        platforms: ["ios", "macos"],
        role: "primary",
        zoneId: ZONE_APPLE,
        apiBaseOrigin: "https://cf-api.test",
      },
      credentials: mockR2Auth(ACC_APPLE, "apple", "appleVal", "appleZone"),
      fetchImpl: cloud.fetchImpl,
      multipartThresholdBytes: 1024,
      partSizeBytes: 512,
    });

    const androidClient = createR2Client({
      target: {
        profileId: "cf-android",
        accountId: ACC_ANDROID,
        bucket: "pocket-android",
        endpoint: "https://r2-android.test",
        publicBaseUrl: "https://dl-android.test",
        platforms: ["android"],
        role: "primary",
        apiBaseOrigin: "https://cf-api.test",
      },
      credentials: mockR2Auth(ACC_ANDROID, "andr", "andrVal"),
      fetchImpl: cloud.fetchImpl,
      multipartThresholdBytes: 1024,
      partSizeBytes: 512,
    });

    const backupClient = createR2Client({
      target: {
        profileId: "cf-backup",
        accountId: ACC_BACKUP,
        bucket: "pocket-backup",
        endpoint: "https://r2-backup.test",
        publicBaseUrl: "https://dl-backup.test",
        platforms: ["*"],
        role: "fallback",
        apiBaseOrigin: "https://cf-api.test",
      },
      credentials: mockR2Auth(ACC_BACKUP, "bak", "bakVal"),
      fetchImpl: cloud.fetchImpl,
      multipartThresholdBytes: 1024,
      partSizeBytes: 512,
    });

    const ipaPath = join(dir, "PocketDemo-1.0.0.ipa");
    const apkPath = join(dir, "PocketDemo-1.0.0.apk");
    writeFileSync(ipaPath, Buffer.alloc(2600, 0x41));
    writeFileSync(apkPath, Buffer.alloc(600, 0x42));

    const published = await publishNativeInstallersToCloudflare({
      clients: [appleClient, androidClient, backupClient],
      appId: "com.demo.app",
      channel: "stable",
      signingKeyFile: keyPath,
      installers: [
        { platform: "ios", version: "1.0.0", build: 10, filePath: ipaPath },
        { platform: "android", version: "1.0.0", build: 10, filePath: apkPath },
      ],
    });

    expect(
      cloud.operationLog.some((op) =>
        op.startsWith("PUT_MP:pocket-apple:releases/native/stable/ios/"),
      ),
    ).toBe(true);
    expect(
      cloud.operationLog.some((op) =>
        op.startsWith("PUT_MP:pocket-android:releases/native/stable/ios/"),
      ),
    ).toBe(false);

    expect(published.manifest.keyId).toBe("installer-ed25519");
    const pubKey = createPublicKey(key.publicKeyPem);
    const verifiedSig = cryptoVerify(
      null,
      Buffer.from(published.manifest.payload, "base64"),
      pubKey,
      Buffer.from(published.manifest.signature!, "base64"),
    );
    expect(verifiedSig).toBe(true);

    expect(published.manifest.decoded.platforms.ios?.downloadUrl).toBe(
      "https://dl-apple.test/releases/native/stable/ios/1.0.0/PocketDemo-1.0.0.ipa",
    );
    expect(published.manifest.decoded.platforms.ios?.fallbackDownloadUrls).toEqual([
      "https://dl-backup.test/releases/native/stable/ios/1.0.0/PocketDemo-1.0.0.ipa",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Cloudflare Pages Direct Upload, Workers Static Assets, and R2 Web Site deploy web artifacts cleanly", async () => {
  const dir = makeTempDir();
  try {
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "engine"), { recursive: true });
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Pocket</title>");
    writeFileSync(join(webDir, "pocket-web.js"), "console.log('pocket');");
    writeFileSync(join(webDir, "engine/pocketjs.wasm"), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

    const mockPagesAndWorkersFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());

      if (url.pathname.endsWith("/upload-token")) {
        return Response.json({ success: true, result: { jwt: "pages-upload-session" } });
      }
      if (url.pathname === "/client/v4/pages/assets/check-missing") {
        const body = JSON.parse(String(init?.body)) as { hashes: string[] };
        return Response.json({ success: true, result: body.hashes.slice(0, 1) });
      }
      if (url.pathname === "/client/v4/pages/assets/upload") {
        return Response.json({ success: true, result: {} });
      }
      if (url.pathname === "/client/v4/pages/assets/upsert-hashes") {
        return Response.json({ success: true, result: {} });
      }
      if (url.pathname.endsWith("/deployments")) {
        return Response.json({
          success: true,
          result: { id: "dep-123", url: "https://pocket-demo.pages.test" },
        });
      }
      if (url.pathname.endsWith("/assets-upload-session")) {
        const body = JSON.parse(String(init?.body)) as {
          manifest: Record<string, { hash: string; size: number }>;
        };
        const firstHash = Object.values(body.manifest)[0]!.hash;
        return Response.json({
          success: true,
          result: { jwt: "workers-session", buckets: [[firstHash]] },
        });
      }
      if (url.pathname === `/client/v4/accounts/${ACC_APPLE}/workers/assets/upload`) {
        return Response.json({
          success: true,
          result: { jwt: "workers-done" },
        });
      }
      if (url.pathname === `/client/v4/accounts/${ACC_APPLE}/workers/scripts/pocket-web-worker`) {
        return Response.json({
          success: true,
          result: { id: "pocket-web-worker" },
        });
      }
      return Response.json({ success: false }, { status: 404 });
    };

    const auth = mockR2Auth(ACC_APPLE, "p", "q", "pages");
    const pagesRes = await deployWebToCloudflarePages({
      accountId: ACC_APPLE,
      projectName: "pocket-demo",
      ...(auth as { apiToken: string }),
      webDir,
      branch: "main",
      apiBaseOrigin: "https://cf-api.test",
      fetchImpl: mockPagesAndWorkersFetch,
    });
    expect(pagesRes.mode).toBe("pages");
    expect(pagesRes.url).toBe("https://pocket-demo.pages.test");
    expect(pagesRes.totalFiles).toBe(3);
    expect(pagesRes.uploadedFiles).toBe(1);
    expect(pagesRes.skippedFiles).toBe(2);

    const workersRes = await deployWebToCloudflareWorkersAssets({
      accountId: ACC_APPLE,
      scriptName: "pocket-web-worker",
      ...(auth as { apiToken: string }),
      webDir,
      apiBaseOrigin: "https://cf-api.test",
      fetchImpl: mockPagesAndWorkersFetch,
    });
    expect(workersRes.mode).toBe("workers-assets");
    expect(workersRes.deploymentId).toBe("pocket-web-worker");
    expect(workersRes.uploadedFiles).toBe(1);

    const r2Cloud = createMockCloudflareCloud();
    const r2Client = createR2Client({
      target: {
        accountId: ACC_APPLE,
        bucket: "pocket-web-r2",
        endpoint: "https://r2-web.test",
        publicBaseUrl: "https://web.test",
        zoneId: ZONE_APPLE,
        apiBaseOrigin: "https://cf-api.test",
      },
      credentials: mockR2Auth(ACC_APPLE, "w", "wVal", "wZone"),
      fetchImpl: r2Cloud.fetchImpl,
    });
    const r2WebRes = await deployWebToR2Site({
      client: r2Client,
      webDir,
      routePrefix: "site",
    });
    expect(r2WebRes.mode).toBe("r2-site");
    expect(r2WebRes.url).toBe("https://web.test/site/index.html");
    expect(r2Cloud.purgedByZone.get(ZONE_APPLE)?.[0]).toContain(
      "https://web.test/site/index.html",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uploadFile streams multipart slices via file descriptor and rejects symlink sources", async () => {
  const dir = makeTempDir();
  try {
    const cloud = createMockCloudflareCloud();
    const client = createR2Client({
      target: {
        accountId: ACC_APPLE,
        bucket: "pocket-stream",
        endpoint: "https://r2-stream.test",
        publicBaseUrl: "https://stream.test",
        apiBaseOrigin: "https://cf-api.test",
      },
      credentials: mockR2Auth(ACC_APPLE, "st", "stVal"),
      fetchImpl: cloud.fetchImpl,
      multipartThresholdBytes: 1024,
      partSizeBytes: 512,
      concurrency: 3,
    });

    const payload = new Uint8Array(3300);
    for (let i = 0; i < payload.byteLength; i += 1) {
      payload[i] = (i * 31 + 7) & 0xff;
    }
    const diskPath = join(dir, "large-installer.dmg");
    writeFileSync(diskPath, payload);

    const partsSeen: number[] = [];
    const uploaded = await client.uploadFile("installers/large-installer.dmg", diskPath, {
      onPartUploaded(info) {
        partsSeen.push(info.partNumber);
      },
    });
    expect(uploaded.multipart).toBe(true);
    expect(uploaded.size).toBe(3300);
    expect(uploaded.sha256).toBe(sha256Hex(payload));
    expect(partsSeen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const stored = cloud.objects.get("r2-stream.test/pocket-stream/installers/large-installer.dmg");
    expect(stored).toBeDefined();
    expect(stored!.sha256).toBe(sha256Hex(payload));
    expect(stored!.bytes.byteLength).toBe(3300);

    const linkPath = join(dir, "symlink-installer.dmg");
    symlinkSync(diskPath, linkPath);
    await expect(
      client.uploadFile("installers/symlink-installer.dmg", linkPath),
    ).rejects.toThrow(/Refusing to upload non-regular or symlink file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("standalone moving index selects the highest signed build and keeps signed blobs relative to the immutable manifest", async () => {
  const dir = makeTempDir();
  try {
    const keyPath = join(dir, "key.json");
    const key = generateDevKey(keyPath, "release");
    const jsPath = join(dir, "app.js");
    const pakPath = join(dir, "app.pak");
    const deployRoot = join(dir, "deploy");
    writeFileSync(pakPath, packPak([]));
    for (const [version, build] of [["1.9.0", 9], ["1.10.0", 10]] as const) {
      writeFileSync(jsPath, `globalThis.frame=()=>${build};\n`);
      packageArtifacts({
        appId: "pocket.demo", version, build, jsPath, pakPath, keyFile: keyPath,
        outDir: pocketReleaseDirectory(deployRoot, "0.2.0", "pocket.demo", version),
        bundleFormat: "zip",
      });
    }
    const cloud = createMockCloudflareCloud();
    const client = createR2Client({
      target: {
        accountId: ACC_APPLE, bucket: "pocket-demo", endpoint: "https://r2-demo.test",
        publicBaseUrl: "https://ota-demo.test/mirror",
      },
      credentials: mockR2Auth(ACC_APPLE, "mock-key", "mock-secret"),
      fetchImpl: cloud.fetchImpl,
    });
    const out = join(dir, "endpoints.json");
    writeFileSync(out, "stable");
    const link = join(dir, "endpoints-link.json");
    symlinkSync(out, link);
    const options = { clients: [client], deployRoot, publicKey: key.publicKeyPem, routePrefix: "app" };
    await expect(publishToCloudflareMatrix({ ...options, writeEndpointsPath: link })).rejects.toThrow(/Invalid endpoint asset path/);
    expect(cloud.objects.size).toBe(0);

    const result = await publishToCloudflareMatrix({ ...options, slot: "test", writeEndpointsPath: out });
    expect(readFileSync(out, "utf8")).toBe("stable");
    const indexUrl = result.platformEndpoints!.routes["*"]!.primaryUrl;
    expect(indexUrl).toBe("https://ota-demo.test/mirror/app/test/pocket/0.2.0/pocket.demo/latest.json");
    const getBytes = (url: string) => cloud.objects.get(
      `r2-demo.test/pocket-demo/${new URL(url).pathname.slice("/mirror/".length)}`,
    )?.bytes;
    const index = JSON.parse(Buffer.from(getBytes(indexUrl)!).toString("utf8"));
    expect(index.latest.version).toBe("1.10.0");
    const manifestUrl = new URL(index.latest.manifestUrl, indexUrl).href;
    const envelope = JSON.parse(Buffer.from(getBytes(manifestUrl)!).toString("utf8"));
    const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    expect(payload.build).toBe(10);
    for (const file of payload.files) {
      const bytes = getBytes(new URL(file.url, manifestUrl).href);
      expect(sha256Hex(bytes!)).toBe(file.sha256);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Studio catalogs only advertise history verified on each target and leave a reused owner's index intact", async () => {
  const dir = makeTempDir();
  try {
    const keyPath = join(dir, "key.json");
    const key = generateDevKey(keyPath, "release");
    const jsPath = join(dir, "app.js");
    const pakPath = join(dir, "app.pak");
    writeFileSync(pakPath, packPak([]));
    const release = (appId: string, releaseId: string, build: number): PublishedVersion => {
      const artifactRoot = `packages/${releaseId}`;
      const outDir = join(dir, artifactRoot);
      const version = `1.0.${build}`;
      writeFileSync(jsPath, `globalThis.frame=()=>${build};\n`);
      const signed = packageArtifacts({
        appId, version, build, jsPath, pakPath, keyFile: keyPath, outDir, bundleFormat: "zip",
      });
      const payloadSha256 = sha256Hex(readFileSync(join(outDir, "payload.json")));
      writeFileSync(join(outDir, "host.json"), JSON.stringify({
        schemaVersion: 1, kind: "pocket-editor-app-host", systemUI: appId, rootPayloadSha256: payloadSha256,
      }));
      return {
        id: releaseId, releaseId, slot: "stable", channel: "release", version, build,
        routeVersion: version, compatVersion: version, revision: build, publishedAt: "2026-01-01T00:00:00.000Z",
        hostVersion: "0.2.0", packageVersion: version, keyId: key.keyId, runtimeAbi: signed.payload.runtimeAbi ?? "",
        payloadSha256, archivePath: "", packages: [{ id: appId, version, build, artifactRoot }],
      };
    };
    const cloud = createMockCloudflareCloud();
    const target = (accountId: string, bucket: string, role: "primary" | "fallback") => createR2Client({
      target: { accountId, bucket, role, endpoint: "https://r2-demo.test", publicBaseUrl: `https://${bucket}.test` },
      credentials: mockR2Auth(accountId, "mock-key", "mock-secret"),
      fetchImpl: cloud.fetchImpl,
    });
    const first = target(ACC_APPLE, "pocket-first", "primary");
    const second = target(ACC_BACKUP, "pocket-second", "fallback");
    expect(() => validateCloudflareRouteMatrix([
      first.target, { ...first.target, role: "fallback", publicBaseUrl: "https://different.test" },
    ])).toThrow(/Duplicate Cloudflare R2 destination/);
    const prior = release("pocket.root", "root-old", 1);
    const current = release("pocket.root", "root-new", 2);
    const reused = release("pocket.owner", "owner-old", 1);
    const newerOwner = release("pocket.owner", "owner-new", 2);
    current.reusedPackages = [{ id: "pocket.owner", ownerProjectId: "owner", releaseId: reused.releaseId, version: reused.version, build: reused.build }];
    const common = { updatesDir: dir, publicKey: key.publicKeyPem, purgeCache: false };
    await publishStudioVersionToCloudflareMatrix({
      ...common, clients: [first], projectId: "root", rootAppId: "pocket.root", entry: prior,
    });
    await publishStudioVersionToCloudflareMatrix({
      ...common, clients: [first, second], projectId: "owner", rootAppId: "pocket.owner", entry: newerOwner,
    });
    const object = (bucket: string, appId: string) => cloud.objects.get(
      `r2-demo.test/${bucket}/stable/pocket/0.2.0/${appId}/latest.json`,
    )?.bytes;
    const ownerBefore = object("pocket-first", "pocket.owner");
    expect(ownerBefore).toBeDefined();
    await publishStudioVersionToCloudflareMatrix({
      ...common, clients: [first, second], projectId: "root", rootAppId: "pocket.root",
      entry: current, previouslyPublishedEntries: [prior], reusedEntries: [{ ownerProjectId: "owner", entry: reused }],
    });
    expect(object("pocket-first", "pocket.owner")).toEqual(ownerBefore);
    const catalog = (bucket: string) => JSON.parse(Buffer.from(object(bucket, "pocket.root")!).toString("utf8"));
    expect(catalog("pocket-first").versions.map((record: { releaseId: string }) => record.releaseId)).toEqual(["root-new", "root-old"]);
    expect(catalog("pocket-second").versions.map((record: { releaseId: string }) => record.releaseId)).toEqual(["root-new"]);
    expect(cloud.objects.has("r2-demo.test/pocket-second/pocket/0.2.0/pocket.owner/owner-old/latest.json")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
