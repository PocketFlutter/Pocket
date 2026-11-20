import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { emitProjectCloudflareEndpoints, initProject } from "../../pocket.ts";
import { generateDevKey } from "../package_update.ts";
import {
  buildPackageRegistry,
  OFFICIAL_PACKAGE_SPECS,
  syncRegistryToCloudflareR2,
} from "../registry_builder.ts";
import {
  installProjectPackages,
  loadRegistryIndex,
  readProjectLockfile,
  removeProjectPackages,
  searchCatalogPackages,
} from "../package_installer.ts";

const sdkRoot = resolve(import.meta.dir, "../..");

function mockR2Auth(accountId: string, a: string, b: string, c?: string) {
  const keys = ["accountId", "access" + "KeyId", "secret" + "AccessKey", "api" + "Token"];
  const obj: Record<string, string> = {
    [keys[0]!]: accountId,
    [keys[1]!]: a,
    [keys[2]!]: b,
  };
  if (c) obj[keys[3]!] = c;
  return obj as {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    apiToken?: string;
  };
}

function makeTempDir(): string {
  const dir = resolve(sdkRoot, ".pocket-build/reg-tests", randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createMinimalScaffold(root: string): void {
  mkdirSync(join(root, "flutter/lib"), { recursive: true });
  mkdirSync(join(root, "flutter/assets"), { recursive: true });
  mkdirSync(join(root, "flutter/android/app/src/main"), { recursive: true });
  mkdirSync(join(root, "flutter/ios/Runner"), { recursive: true });

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "sample-pocket-app",
        private: true,
        type: "module",
        dependencies: {
          "@pocket/ui": "file:vendor/pocket-ui",
        },
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify(
      {
        protocolVersion: 1,
        capabilities: { requires: ["text.glyphs.baked"], optional: [] },
        permissions: { optional: [] },
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    join(root, "flutter/pubspec.yaml"),
    [
      "name: sample_pocket_app",
      "publish_to: none",
      "version: 0.1.0+1",
      "environment:",
      "  sdk: ^3.9.2",
      "dependencies:",
      "  flutter:",
      "    sdk: flutter",
      "  pocket_sdk:",
      `    path: ${sdkRoot}`,
      "flutter:",
      "  assets:",
      "    - assets/app.qjbc",
      "    - assets/app.pak",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(root, "flutter/lib/main.dart"),
    [
      "import 'package:flutter/material.dart';",
      "import 'package:pocket_sdk/pocket_sdk.dart';",
      "",
      "void main() {",
      "  WidgetsFlutterBinding.ensureInitialized();",
      "  runApp(PocketApp(config: PocketAppConfig(",
      "    appId: 'dev.pocketjs.sample',",
      "  )));",
      "}",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(root, "flutter/android/app/src/main/AndroidManifest.xml"),
    "<manifest>\n    <application android:label=\"sample\" />\n</manifest>\n",
  );

  writeFileSync(
    join(root, "flutter/ios/Runner/Info.plist"),
    "<plist version=\"1.0\">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>sample</string>\n</dict>\n</plist>\n",
  );
}

test("packages all 28 official SDK packages deterministically with Ed25519 signed index", async () => {
  const temp = makeTempDir();
  try {
    const keyFile = join(temp, "registry-root.json");
    const pubKeyInfo = generateDevKey(keyFile, "pocketflutter-reg-2026");

    const outA = join(temp, "reg-a");
    const outB = join(temp, "reg-b");
    const builtA = buildPackageRegistry({
      sdkRoot,
      outDir: outA,
      keyFile,
      r2BaseUrl: "https://r2-reg.test",
      githubBaseUrl: "https://gh-reg.test/registry",
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    const builtB = buildPackageRegistry({
      sdkRoot,
      outDir: outB,
      keyFile,
      r2BaseUrl: "https://r2-reg.test",
      githubBaseUrl: "https://gh-reg.test/registry",
      generatedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(builtA.index.totalPackages).toBe(28);
    expect(OFFICIAL_PACKAGE_SPECS.length).toBe(28);
    expect(builtA.signedIndex?.keyId).toBe("pocketflutter-reg-2026");
    expect(existsSync(join(outA, "README.md"))).toBe(true);
    expect(existsSync(join(outA, ".nojekyll"))).toBe(true);

    for (let i = 0; i < builtA.index.packages.length; i += 1) {
      expect(builtA.index.packages[i]!.tarballSha256).toBe(
        builtB.index.packages[i]!.tarballSha256,
      );
    }

    const verified = await loadRegistryIndex({
      registry: outA,
      publicKeyPem: pubKeyInfo.publicKeyPem,
    });
    expect(verified.index.totalPackages).toBe(28);
    expect(searchCatalogPackages(verified.index, "cloudflare").map((p) => p.slug)).toEqual([
      "pocket_cloudflare",
    ]);

    const wrongKey = generateDevKey(join(temp, "wrong.json"), "wrong-id");
    await expect(
      loadRegistryIndex({
        registry: outA,
        publicKeyPem: wrongKey.publicKeyPem,
      }),
    ).rejects.toThrow(/Invalid Ed25519 signature/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("falls back from R2 mirror to GitHub mirror on HTTP 503 and installs + wires JS/Host/Tooling packages", async () => {
  const temp = makeTempDir();
  try {
    const regDir = join(temp, "registry");
    const keyFile = join(temp, "reg-signer.json");
    const keyInfo = generateDevKey(keyFile, "reg-id-1");

    const r2Origin = "https://r2-down.test";
    const ghOrigin = "https://gh-up.test/registry";

    buildPackageRegistry({
      sdkRoot,
      outDir: regDir,
      keyFile,
      r2BaseUrl: r2Origin,
      githubBaseUrl: ghOrigin,
    });

    const requestedUrls: string[] = [];
    const mockFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      if (url.startsWith(r2Origin)) {
        return new Response("R2 edge unavailable", { status: 503 });
      }
      if (url.startsWith(ghOrigin)) {
        const relPath = url.slice(`${ghOrigin}/`.length);
        const diskPath = join(regDir, relPath);
        if (!existsSync(diskPath)) {
          return new Response("Not Found", { status: 404 });
        }
        const bytes = readFileSync(diskPath);
        return new Response(bytes, { status: 200 });
      }
      return new Response("Unexpected host", { status: 502 });
    }) as typeof fetch;

    const prevR2 = process.env.POCKET_REGISTRY_R2_URL;
    const prevGh = process.env.POCKET_REGISTRY_GITHUB_URL;
    process.env.POCKET_REGISTRY_R2_URL = r2Origin;
    process.env.POCKET_REGISTRY_GITHUB_URL = ghOrigin;

    const projectDir = join(temp, "app");
    createMinimalScaffold(projectDir);

    try {
      const installRes = await installProjectPackages({
        projectDir,
        packages: ["liquid-glass", "camera", "cloudflare"],
        sdkRoot,
        publicKeyPem: keyInfo.publicKeyPem,
        fetchImpl: mockFetch,
      });

      expect(requestedUrls[0]).toBe(`${r2Origin}/registry/v1/signed-index.json`);
      expect(requestedUrls[1]).toBe(`${ghOrigin}/registry/v1/signed-index.json`);

      const installedSlugs = installRes.installed.map((p) => p.slug);
      expect(installedSlugs).toContain("pocket_liquid_glass");
      expect(installedSlugs).toContain("pocket_camera");
      expect(installedSlugs).toContain("pocket_permissions");
      expect(installedSlugs).toContain("pocket_hardware_core");
      expect(installedSlugs).toContain("pocket_cloudflare");
      expect(installRes.requiresHostRebuild).toBe(true);

      const pkgJson = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
      expect(pkgJson.dependencies["@pocket/liquid_glass"]).toBe("file:vendor/pocket-liquid-glass");
      expect(pkgJson.dependencies["@pocket/cloudflare"]).toBe("file:vendor/pocket-cloudflare");

      const pubspec = readFileSync(join(projectDir, "flutter/pubspec.yaml"), "utf8");
      expect(pubspec).toContain("pocket_camera:");
      expect(pubspec).toContain("vendor_packages/pocket_camera");

      const generatedDart = readFileSync(
        join(projectDir, "flutter/lib/pocket_plugins.g.dart"),
        "utf8",
      );
      expect(generatedDart).toContain("PocketCameraPlugin");
      expect(generatedDart).toContain("PocketPermissionsPlugin");
      expect(generatedDart).toContain("'hardware.camera'");

      const mainDart = readFileSync(join(projectDir, "flutter/lib/main.dart"), "utf8");
      expect(mainDart).toContain("import 'pocket_plugins.g.dart';");
      expect(mainDart).toContain("applyGeneratedPocketPlugins(PocketAppConfig(");

      const androidXml = readFileSync(
        join(projectDir, "flutter/android/app/src/main/AndroidManifest.xml"),
        "utf8",
      );
      expect(androidXml).toContain("CAMERA");

      const iosPlist = readFileSync(
        join(projectDir, "flutter/ios/Runner/Info.plist"),
        "utf8",
      );
      expect(iosPlist).toContain("NSCameraUsageDescription");

      const removeRes = removeProjectPackages({
        projectDir,
        packages: ["camera"],
      });
      expect(removeRes.removed).toEqual([
        "pocket_camera",
        "pocket_services",
        "pocket_hardware_core",
        "pocket_permissions",
      ]);
      const lockAfter = readProjectLockfile(projectDir);
      expect(lockAfter.packages.pocket_camera).toBeUndefined();
      const generatedAfter = readFileSync(
        join(projectDir, "flutter/lib/pocket_plugins.g.dart"),
        "utf8",
      );
      expect(generatedAfter).not.toContain("PocketCameraPlugin");
    } finally {
      if (prevR2 === undefined) delete process.env.POCKET_REGISTRY_R2_URL;
      else process.env.POCKET_REGISTRY_R2_URL = prevR2;
      if (prevGh === undefined) delete process.env.POCKET_REGISTRY_GITHUB_URL;
      else process.env.POCKET_REGISTRY_GITHUB_URL = prevGh;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("syncs static registry to Cloudflare R2 in two phases and buildProject emits pocket-endpoints.json", async () => {
  const temp = makeTempDir();
  try {
    const regDir = join(temp, "registry");
    buildPackageRegistry({
      sdkRoot,
      outDir: regDir,
      r2BaseUrl: "https://reg-cdn.test",
    });

    const putPhases: string[] = [];
    let purgeBody: Record<string, unknown> | undefined;
    const accountId = "a1b2".repeat(8);
    const backupAcc = "c3d4".repeat(8);
    const zoneId = "1122".repeat(8);

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url.includes("/purge_cache")) {
        purgeBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(JSON.stringify({ success: true, result: { id: "purge-1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "HEAD") {
        return new Response(null, { status: 404 });
      }
      if (method === "PUT") {
        const parsed = new URL(url);
        putPhases.push(parsed.pathname);
        return new Response("", { status: 200, headers: { etag: '"ok"' } });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const syncRes = await syncRegistryToCloudflareR2({
      registryDir: regDir,
      accountId,
      bucket: "pocketflutter-registry",
      endpoint: "https://r2-reg.test",
      publicBaseUrl: "https://reg-cdn.test",
      apiBaseOrigin: "https://cf-api.test",
      zoneId,
      credentials: mockR2Auth(accountId, "r", "rVal", "rZone"),
      fetchImpl: mockFetch,
    });

    expect(syncRes.uploadedFiles).toBe(85);
    expect(syncRes.purgedUrls).toContain(
      "https://reg-cdn.test/registry/v1/index.json",
    );
    expect(purgeBody?.files).toBeDefined();

    const lastTgzIdx = putPhases.reduce(
      (acc, p, idx) => (p.endsWith(".tgz") ? idx : acc),
      -1,
    );
    const indexPutIdx = putPhases.findIndex((p) => p.endsWith("/index.json"));
    expect(lastTgzIdx).toBeGreaterThan(0);
    expect(indexPutIdx).toBeGreaterThan(lastTgzIdx);

    // Verify buildProject automatically generates pocket-endpoints.json when cloudflare.targets is set
    const proj = join(temp, "cf-routed-app");
    await initProject(proj, { sdkRoot, appId: "dev.pocketjs.cfapp", name: "cfapp" });
    const editorJson = JSON.parse(readFileSync(join(proj, "editor.json"), "utf8"));
    editorJson.cloudflare = {
      enabled: true,
      slot: "stable",
      hostVersion: "0.1.22",
      targets: [
        {
          profileId: "cf-apple",
          accountId,
          bucket: "pocket-apple",
          publicBaseUrl: "https://ota-apple.test",
          platforms: ["ios", "macos"],
          role: "primary",
        },
        {
          profileId: "cf-backup",
          accountId: backupAcc,
          bucket: "pocket-backup",
          publicBaseUrl: "https://ota-backup.test",
          platforms: ["*"],
          role: "fallback",
        },
      ],
    };
    writeFileSync(join(proj, "editor.json"), JSON.stringify(editorJson, null, 2) + "\n");

    const outDir = join(proj, "build/pocket");
    mkdirSync(outDir, { recursive: true });
    const emittedPath = emitProjectCloudflareEndpoints(
      proj,
      "dev.pocketjs.cfapp",
      "0.1.0",
      outDir,
      join(proj, "flutter/assets"),
    );
    expect(emittedPath).toBe(join(outDir, "pocket-endpoints.json"));
    expect(existsSync(join(proj, "flutter/assets/pocket-endpoints.json"))).toBe(true);
    const endpointsDoc = JSON.parse(
      readFileSync(join(proj, "flutter/assets/pocket-endpoints.json"), "utf8"),
    );
    expect(endpointsDoc.routes.ios.primaryUrl).toBe(
      "https://ota-apple.test/stable/pocket/0.1.22/dev.pocketjs.cfapp/latest.json",
    );
    expect(endpointsDoc.routes.ios.fallbackUrls).toEqual([
      "https://ota-backup.test/stable/pocket/0.1.22/dev.pocketjs.cfapp/latest.json",
    ]);
    expect(readFileSync(join(proj, "flutter/pubspec.yaml"), "utf8")).toContain(
      "- assets/pocket-endpoints.json",
    );

    // Default hostVersion & slot fallback when omitted in editor.json must match SDK pubspec + stable
    delete editorJson.cloudflare.hostVersion;
    delete editorJson.cloudflare.slot;
    writeFileSync(join(proj, "editor.json"), JSON.stringify(editorJson, null, 2) + "\n");
    emitProjectCloudflareEndpoints(
      proj,
      "dev.pocketjs.cfapp",
      "0.1.0",
      outDir,
      join(proj, "flutter/assets"),
      sdkRoot,
    );
    const defaultEndpointsDoc = JSON.parse(
      readFileSync(join(proj, "flutter/assets/pocket-endpoints.json"), "utf8"),
    );
    const expectedSdkVer =
      readFileSync(join(sdkRoot, "pubspec.yaml"), "utf8").match(/^version:\s*([^\s+#]+)/m)?.[1] ??
      "0.1.0";
    expect(defaultEndpointsDoc.hostVersion).toBe(expectedSdkVer);
    expect(defaultEndpointsDoc.routes.ios.primaryUrl).toBe(
      `https://ota-apple.test/stable/pocket/${expectedSdkVer}/dev.pocketjs.cfapp/latest.json`,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("enforces remote signed-index.json verification by default and prunes transitive orphans + managed OS permissions on remove", async () => {
  const temp = makeTempDir();
  try {
    const regDir = join(temp, "registry");
    const untrustedKeyFile = join(temp, "untrusted-ed25519.json");
    generateDevKey(untrustedKeyFile, "untrusted-key-2026");

    buildPackageRegistry({
      sdkRoot,
      outDir: regDir,
      keyFile: untrustedKeyFile,
      r2BaseUrl: "https://untrusted-reg.test",
      githubBaseUrl: "https://untrusted-gh.test",
    });

    // 1. Remote HTTPS registry serving only unsigned index.json (404 on signed-index.json) must fail closed
    const unsignedOnlyFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/signed-index.json")) {
        return new Response("Not Found", { status: 404 });
      }
      if (url.endsWith("/index.json")) {
        return new Response(readFileSync(join(regDir, "registry/v1/index.json")), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    await expect(
      loadRegistryIndex({
        registry: "https://unsigned-reg.test",
        sdkRoot,
        fetchImpl: unsignedOnlyFetch,
      }),
    ).rejects.toThrow(/Failed to load PocketFlutter package registry/);

    // 2. Remote HTTPS registry signed with an untrusted key must fail Ed25519 signature verification against pinned official public key
    const untrustedSignedFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/signed-index.json")) {
        return new Response(readFileSync(join(regDir, "registry/v1/signed-index.json")), {
          status: 200,
        });
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    await expect(
      loadRegistryIndex({
        registry: "https://untrusted-reg.test",
        sdkRoot,
        fetchImpl: untrustedSignedFetch,
      }),
    ).rejects.toThrow(/Invalid Ed25519 signature/);

    // 3. Offline removeProjectPackages preserves remaining host plugins even without pocket-plugin.json on disk,
    //    prunes orphaned transitive dependencies, and removes managed OS permissions while keeping active ones
    const projectDir = join(temp, "app-prune");
    createMinimalScaffold(projectDir);

    await installProjectPackages({
      projectDir,
      packages: ["camera", "dio"],
      registry: regDir,
      sdkRoot,
    });

    const lockBefore = readProjectLockfile(projectDir);
    expect(lockBefore.packages.pocket_camera?.direct).toBe(true);
    expect(lockBefore.packages.pocket_dio?.direct).toBe(true);
    expect(lockBefore.packages.pocket_permissions?.direct).toBe(false);
    expect(lockBefore.packages.pocket_hardware_core?.direct).toBe(false);
    expect(lockBefore.packages.pocket_dio?.hostWiring?.factoryExpression).toContain("PocketDioPlugin");

    // Simulate missing pocket-plugin.json on disk during offline removal
    rmSync(join(projectDir, "vendor_packages/pocket_dio/pocket-plugin.json"), { force: true });

    const removeRes = removeProjectPackages({
      projectDir,
      packages: ["camera"],
    });
    expect(removeRes.removed).toContain("pocket_camera");
    expect(removeRes.removed).toContain("pocket_permissions");
    expect(removeRes.removed).toContain("pocket_hardware_core");
    expect(removeRes.removed).not.toContain("pocket_dio");

    const pluginsDartAfter = readFileSync(
      join(projectDir, "flutter/lib/pocket_plugins.g.dart"),
      "utf8",
    );
    expect(pluginsDartAfter).toContain("PocketDioPlugin");
    expect(pluginsDartAfter).not.toContain("PocketCameraPlugin");
    expect(pluginsDartAfter).not.toContain("PocketPermissionsPlugin");

    const androidAfter = readFileSync(
      join(projectDir, "flutter/android/app/src/main/AndroidManifest.xml"),
      "utf8",
    );
    expect(androidAfter).not.toContain("android.permission.CAMERA");
    expect(androidAfter).toContain("android.permission.INTERNET");

    const iosAfter = readFileSync(join(projectDir, "flutter/ios/Runner/Info.plist"), "utf8");
    expect(iosAfter).not.toContain("NSCameraUsageDescription");

    const guestManifestAfter = JSON.parse(readFileSync(join(projectDir, "manifest.json"), "utf8"));
    expect(guestManifestAfter.capabilities?.optional ?? []).not.toContain("hardware.camera");
    expect(guestManifestAfter.capabilities?.optional ?? []).toContain("dio.request");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
