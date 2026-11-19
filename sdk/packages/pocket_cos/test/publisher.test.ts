import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PublishedVersion } from "../../../editor/version_store.ts";
import {
  generateDevKey,
  packageArtifacts,
  packPak,
  pocketReleaseDirectory,
} from "../../../scripts/package_update.ts";
import { createCosClient } from "../src/client.ts";
import {
  IMMUTABLE_CACHE_CONTROL,
  MUTABLE_CACHE_CONTROL,
  publishReleaseDirectoryToCos,
  publishStudioVersionToCos,
  verifyLocalPackageDirectory,
} from "../src/publisher.ts";
import type { CosCredentials } from "../src/types.ts";

const TEST_CREDS: CosCredentials = {
  secretId: "AKID_PUB_TEST_12345678",
  secretKey: "SK_PUB_TEST_SECRET_87654321",
};

test("publisher: two-phase atomic upload, Phase 1 failure aborts before latest.json, build-2 deduplication via HEAD, Cache-Control, and Studio version index publishing", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pocket-cos-publisher-test-"));

  type StoredObj = {
    bytes: Uint8Array;
    sha256?: string;
    cacheControl?: string;
    contentType?: string;
  };
  const objects = new Map<string, StoredObj>();
  const putOrder: string[] = [];
  let failOnKeySubstring: string | null = null;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const key = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const method = req.method.toUpperCase();

      if (method === "HEAD" && (url.pathname === "/" || key === "")) {
        return new Response(null, { status: 200 });
      }

      if (method === "HEAD") {
        const existing = objects.get(key);
        if (!existing) return new Response(null, { status: 404 });
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": String(existing.bytes.byteLength),
            ...(existing.sha256 ? { "x-cos-meta-sha256": existing.sha256 } : {}),
            ...(existing.cacheControl ? { "cache-control": existing.cacheControl } : {}),
            ...(existing.contentType ? { "content-type": existing.contentType } : {}),
          },
        });
      }

      if (method === "PUT") {
        if (failOnKeySubstring && key.includes(failOnKeySubstring)) {
          return new Response(
            `<Error><Code>InternalError</Code><Message>Simulated Phase 1 failure</Message></Error>`,
            { status: 500, headers: { "content-type": "application/xml" } },
          );
        }
        const bytes = new Uint8Array(await req.arrayBuffer());
        const etag = createHash("md5").update(bytes).digest("hex");
        putOrder.push(key);
        objects.set(key, {
          bytes,
          sha256: req.headers.get("x-cos-meta-sha256") ?? undefined,
          cacheControl: req.headers.get("cache-control") ?? undefined,
          contentType: req.headers.get("content-type") ?? undefined,
        });
        return new Response(null, {
          status: 200,
          headers: { ETag: `"${etag}"` },
        });
      }

      return new Response(null, { status: 405 });
    },
  });

  try {
    const keyFile = join(tempRoot, "dev-key.json");
    const devKey = generateDevKey(keyFile, "cos-pub-test-key");

    const srcDir = join(tempRoot, "src");
    const assetsDir = join(srcDir, "assets");
    mkdirSync(assetsDir, { recursive: true });

    const jsV1 = join(srcDir, "app-v1.js");
    const jsV2 = join(srcDir, "app-v2.js");
    writeFileSync(jsV1, 'globalThis.frame = () => "v1";\n');
    writeFileSync(jsV2, 'globalThis.frame = () => "v2-updated";\n');

    const pakPath = join(srcDir, "app.pak");
    const pakBytes = packPak([
      {
        key: "ui:img.hero",
        dtype: 0,
        data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      },
      {
        key: "ui:img.bg",
        dtype: 0,
        data: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]),
      },
    ]);
    writeFileSync(pakPath, pakBytes);

    writeFileSync(join(assetsDir, "intro.txt"), "welcome to pocket cos");
    writeFileSync(join(assetsDir, "remote.bin"), new Uint8Array([9, 9, 9, 9, 9]));

    const deployRootV1 = join(tempRoot, "deploy-v1");
    const outDirV1 = pocketReleaseDirectory(
      deployRootV1,
      "0.1.0",
      "pocket.host.demo",
      "1.0.0",
    );
    const pkgV1 = packageArtifacts({
      appId: "pocket.host.demo",
      version: "1.0.0",
      build: 1,
      jsPath: jsV1,
      pakPath,
      assetDir: assetsDir,
      assetPrefix: "assets",
      networkPakKeys: ["ui:img.bg"],
      networkAssets: ["assets/remote.bin"],
      outDir: outDirV1,
      keyFile,
    });

    // Verify local package directory with Ed25519 public key
    const verifiedV1 = verifyLocalPackageDirectory(outDirV1, devKey.publicKeyBase64);
    expect(verifiedV1.payload.appId).toBe("pocket.host.demo");
    expect(verifiedV1.payload.bundle?.blobs).toBeDefined();

    const endpoint = `http://127.0.0.1:${server.port}`;
    const client = createCosClient({
      target: {
        bucket: "pub-1250000000",
        region: "ap-guangzhou",
        endpoint,
        keyPrefix: "cdn",
        allowInsecureHttpForTesting: true,
      },
      credentials: TEST_CREDS,
      maxRetries: 0,
    });

    // 1. Test Phase 1 failure aborts BEFORE any Phase 2 mutable file (like latest.json) is written
    // Use one worker so the next scenario can reset the fake bucket after the rejection.
    failOnKeySubstring = "blobs/";
    await expect(
      publishReleaseDirectoryToCos({
        client,
        deployRoot: deployRootV1,
        publicKey: devKey.publicKeyPem,
        concurrency: 1,
      }),
    ).rejects.toThrow(/Simulated Phase 1 failure/);

    expect(
      [...objects.keys()].some(
        (k) =>
          k.endsWith("/latest.json") ||
          k.endsWith("/payload.json") ||
          k.endsWith("/signed-manifest.json"),
      ),
    ).toBe(false);
    failOnKeySubstring = null;
    objects.clear();
    putOrder.length = 0;

    // 2. Full publish of Build 1: Phase 1 strictly before Phase 2, latest.json strictly last
    const resV1 = await publishReleaseDirectoryToCos({
      client,
      deployRoot: deployRootV1,
      publicKey: devKey.publicKeyPem,
    });
    expect(resV1.uploadedFiles).toBeGreaterThan(0);
    expect(resV1.skippedFiles).toBe(0);

    const latestKey = "cdn/pocket/0.1.0/pocket.host.demo/1.0.0/latest.json";
    expect(putOrder.at(-1)).toBe(latestKey);

    const firstMutableIdx = putOrder.findIndex(
      (k) =>
        k.endsWith("/bundle.7z") ||
        k.endsWith("/payload.json") ||
        k.endsWith("/signed-manifest.json") ||
        k.endsWith("/latest.json"),
    );
    const lastImmutableIdx = putOrder.reduce(
      (acc, k, idx) => (k.includes("/blobs/") || k.includes("/bundles/") ? idx : acc),
      -1,
    );
    expect(lastImmutableIdx).toBeLessThan(firstMutableIdx);

    // Check Cache-Control headers
    for (const [k, obj] of objects.entries()) {
      if (k.includes("/blobs/") || k.includes("/bundles/bundle-")) {
        expect(obj.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
      } else if (k.endsWith("/latest.json") || k.endsWith("/payload.json")) {
        expect(obj.cacheControl).toBe(MUTABLE_CACHE_CONTROL);
      }
    }

    // 3. Build 2 (only JS code changed, PAK & assets identical) -> unchanged blobs deduplicated via HEAD!
    const deployRootV2 = join(tempRoot, "deploy-v2");
    const outDirV2 = pocketReleaseDirectory(
      deployRootV2,
      "0.1.0",
      "pocket.host.demo",
      "1.0.0",
    );
    packageArtifacts({
      appId: "pocket.host.demo",
      version: "1.0.0",
      build: 2,
      jsPath: jsV2,
      pakPath,
      assetDir: assetsDir,
      assetPrefix: "assets",
      networkPakKeys: ["ui:img.bg"],
      networkAssets: ["assets/remote.bin"],
      outDir: outDirV2,
      keyFile,
    });

    const resV2 = await publishReleaseDirectoryToCos({
      client,
      deployRoot: deployRootV2,
      publicKey: devKey.publicKeyPem,
    });
    expect(resV2.skippedFiles).toBe(pkgV1.payload.files.length - 1);
    expect(resV2.uploadedFiles).toBeGreaterThan(0);

    // 4. Test publishStudioVersionToCos (rebased host.json + static package index)
    const updatesDir = join(tempRoot, "updates");
    const releaseId = "demo-test-rel1";
    const studioPkgDir = pocketReleaseDirectory(
      join(updatesDir, ".history", "demo", releaseId),
      "0.1.0",
      "pocket.host.demo",
      releaseId,
    );
    mkdirSync(join(studioPkgDir, "bootstrap"), { recursive: true });
    const studioPkg = packageArtifacts({
      appId: "pocket.host.demo",
      version: "1.0.0-test.1",
      build: 1,
      jsPath: jsV1,
      pakPath,
      outDir: studioPkgDir,
      keyFile,
    });
    writeFileSync(
      join(studioPkgDir, "bootstrap", "app.bytecode.json"),
      JSON.stringify({ entryFormat: "quickjs-bytecode" }),
    );
    writeFileSync(
      join(studioPkgDir, "host.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "pocket-editor-app-host",
        systemUI: "pocket.host.demo",
        POCKET_UPDATE_BASE_URL: "http://192.168.1.50:8791/test",
        POCKET_UPDATE_DEBUG_HTTP_HOST: "192.168.1.50",
        updates: {
          baseUrl: "http://192.168.1.50:8791/test",
          hostVersion: "0.1.0",
          packageVersion: "1.0.0",
          debugHttpHosts: ["192.168.1.50"],
        },
        applications: {
          "pocket.host.demo": {
            id: "pocket.host.demo",
            appId: "pocket.host.demo",
            manifestUrl: `http://192.168.1.50:8791/pocket/0.1.0/pocket.host.demo/${releaseId}/latest.json`,
            hostConfigUrl: `http://192.168.1.50:8791/pocket/0.1.0/pocket.host.demo/${releaseId}/host.json`,
            bootstrapAssets: {
              "assets/apps/pocket.host.demo/app.bytecode.json": {
                url: `http://192.168.1.50:8791/pocket/0.1.0/pocket.host.demo/${releaseId}/bootstrap/app.bytecode.json`,
                sha256: "0".repeat(64),
                size: 34,
              },
            },
          },
        },
      }),
    );

    const entry: PublishedVersion = {
      id: releaseId,
      releaseId,
      slot: "test",
      channel: "test",
      version: "1.0.0-test.1",
      build: 1,
      compatVersion: "1.0.0",
      routeVersion: "1.0.0-test.1",
      revision: 1,
      publishedAt: new Date().toISOString(),
      hostVersion: "0.1.0",
      packageVersion: releaseId,
      keyId: devKey.keyId,
      runtimeAbi: "qjs-test",
      payloadSha256: createHash("sha256").update(studioPkg.payloadBytes).digest("hex"),
      archivePath: `.history/demo/${releaseId}.tar.gz`,
      packages: [
        {
          id: "pocket.host.demo",
          version: "1.0.0-test.1",
          build: 1,
          artifactRoot: `.history/demo/${releaseId}/pocket/0.1.0/pocket.host.demo/${releaseId}`,
        },
      ],
    };

    const httpsClient = createCosClient({
      target: {
        bucket: "pub-1250000000",
        region: "ap-guangzhou",
        endpoint,
        keyPrefix: "cdn",
        publicBaseUrl: "https://cdn.example.com/cos",
        allowInsecureHttpForTesting: true,
      },
      credentials: TEST_CREDS,
    });

    const summary = await publishStudioVersionToCos({
      client: httpsClient,
      updatesDir,
      projectId: "demo",
      rootAppId: "pocket.host.demo",
      entry,
      publicKey: devKey.publicKeyBase64,
    });

    expect(summary.appConfigUrl).toBe(
      "https://cdn.example.com/cos/test/pocket/0.1.0/pocket.host.demo/latest.json",
    );
    expect(summary.hostConfigUrl).toBe(
      `https://cdn.example.com/cos/pocket/0.1.0/pocket.host.demo/${releaseId}/host.json`,
    );

    const indexObj = objects.get("cdn/test/pocket/0.1.0/pocket.host.demo/latest.json");
    expect(indexObj).toBeDefined();
    expect(indexObj!.cacheControl).toBe(MUTABLE_CACHE_CONTROL);
    const parsedIndex = JSON.parse(new TextDecoder().decode(indexObj!.bytes));
    expect(parsedIndex.kind).toBe("pocket-editor-package-index");
    expect(parsedIndex.latest.hostConfigUrl).toBe(
      `../../../../pocket/0.1.0/pocket.host.demo/${releaseId}/host.json`,
    );
    expect(parsedIndex.latest.manifestUrl).toBe(
      `../../../../pocket/0.1.0/pocket.host.demo/${releaseId}/latest.json`,
    );
    expect(parsedIndex.latest.archiveUrl).toBeNull();
    expect(new URL(parsedIndex.latest.hostConfigUrl, summary.appConfigUrl).href).toBe(
      summary.hostConfigUrl,
    );
    expect(new URL(parsedIndex.latest.manifestUrl, summary.appConfigUrl).href).toBe(
      `https://cdn.example.com/cos/pocket/0.1.0/pocket.host.demo/${releaseId}/latest.json`,
    );

    // Also verify unprefixed Studio COS publish URL resolution
    const unprefixedClient = createCosClient({
      target: {
        bucket: "pub-1250000000",
        region: "ap-guangzhou",
        endpoint,
        keyPrefix: "",
        publicBaseUrl: "https://cdn.example.com",
        allowInsecureHttpForTesting: true,
      },
      credentials: TEST_CREDS,
    });
    const unprefixedSummary = await publishStudioVersionToCos({
      client: unprefixedClient,
      updatesDir,
      projectId: "demo",
      rootAppId: "pocket.host.demo",
      entry,
      publicKey: devKey.publicKeyBase64,
    });
    const unprefixedIndexObj = objects.get("test/pocket/0.1.0/pocket.host.demo/latest.json");
    expect(unprefixedIndexObj).toBeDefined();
    const unprefixedParsedIndex = JSON.parse(
      new TextDecoder().decode(unprefixedIndexObj!.bytes),
    );
    expect(
      new URL(unprefixedParsedIndex.latest.hostConfigUrl, unprefixedSummary.appConfigUrl).href,
    ).toBe(unprefixedSummary.hostConfigUrl);
    expect(
      new URL(unprefixedParsedIndex.latest.manifestUrl, unprefixedSummary.appConfigUrl).href,
    ).toBe(
      `https://cdn.example.com/pocket/0.1.0/pocket.host.demo/${releaseId}/latest.json`,
    );

    // Verify path-containment check rejects artifactRoot escaping updatesDir
    await expect(
      publishStudioVersionToCos({
        client: httpsClient,
        updatesDir,
        projectId: "demo",
        rootAppId: "pocket.host.demo",
        entry: {
          ...entry,
          packages: [
            {
              id: "pocket.host.demo",
              version: "1.0.0-test.1",
              build: 1,
              artifactRoot: "../escaped",
            },
          ],
        },
        publicKey: devKey.publicKeyBase64,
      }),
    ).rejects.toThrow("Invalid package artifactRoot outside updatesDir");

    const hostObj = objects.get(
      `cdn/pocket/0.1.0/pocket.host.demo/${releaseId}/host.json`,
    );
    expect(hostObj).toBeDefined();
    expect(hostObj!.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
    const parsedHost = JSON.parse(new TextDecoder().decode(hostObj!.bytes));
    expect(parsedHost.POCKET_UPDATE_BASE_URL).toBe("https://cdn.example.com/cos/test");
    expect(parsedHost.POCKET_UPDATE_DEBUG_HTTP_HOST).toBeUndefined();
    expect(parsedHost.updates.baseUrl).toBe("https://cdn.example.com/cos/test");
    expect(parsedHost.updates.debugHttpHosts).toBeUndefined();
    expect(
      parsedHost.applications["pocket.host.demo"].bootstrapAssets[
        "assets/apps/pocket.host.demo/app.bytecode.json"
      ].url,
    ).toBe(
      `https://cdn.example.com/cos/pocket/0.1.0/pocket.host.demo/${releaseId}/bootstrap/app.bytecode.json`,
    );
  } finally {
    server.stop(true);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
