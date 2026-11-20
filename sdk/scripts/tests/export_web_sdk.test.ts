import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { SDK_VERSION } from "../prebuilt_tools.mjs";

const repository = resolve(import.meta.dir, "../../..");
const sourceWorkspaceVersion = (slug: string): string =>
  JSON.parse(readFileSync(join(repository, "sdk/packages", `pocket_${slug}`, "package.json"), "utf8")).version;
const sdkBuild = join(repository, "sdk", ".pocket-build");
const output = mkdtempSync(join(tmpdir(), "pocket-web-sdk-export-test-"));
const darwinOutput = mkdtempSync(join(tmpdir(), "pocket-web-sdk-export-darwin-test-"));
const windowsOutput = mkdtempSync(join(tmpdir(), "pocket-web-sdk-export-windows-test-"));
const missingPlatformOutput = mkdtempSync(join(tmpdir(), "pocket-web-sdk-export-missing-test-"));
const registryOutput = mkdtempSync(join(tmpdir(), "pocket-web-sdk-export-registry-test-"));

function packFixture(source: string, destination: string): string {
  const result = spawnSync("npm", [
    "pack", "--ignore-scripts", "--pack-destination", destination, "--json",
  ], { cwd: source, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  const [{ filename }] = JSON.parse(result.stdout);
  return join(destination, filename);
}

function withPlatformArchiveFixtures<T>(run: (fixtures: ReadonlyMap<string, Buffer>) => T): T {
  const buildDirectoryExisted = existsSync(sdkBuild);
  mkdirSync(sdkBuild, { recursive: true });
  const originals = new Map<string, Buffer | undefined>();
  const fixtures = new Map<string, Buffer>();
  for (const platform of ["darwin-arm64", "win32-x64"]) {
    const name = `pocket-tools-${platform}-${SDK_VERSION}.tgz`;
    const path = join(sdkBuild, name);
    originals.set(name, existsSync(path) ? readFileSync(path) : undefined);
    // A sentinel file verifies the exporter copies the selected archive. It is
    // deliberately not a valid package and does not stand in for a real build.
    const bytes = Buffer.from(`export-test fixture: ${name}`);
    fixtures.set(name, bytes);
    writeFileSync(path, bytes);
  }
  try {
    return run(fixtures);
  } finally {
    for (const [name, original] of originals) {
      const path = join(sdkBuild, name);
      if (original === undefined) rmSync(path, { force: true });
      else writeFileSync(path, original);
    }
    if (!buildDirectoryExisted && readdirSync(sdkBuild).length === 0) {
      rmSync(sdkBuild, { recursive: true, force: true });
    }
  }
}

afterAll(() => {
  for (const path of [output, darwinOutput, windowsOutput, missingPlatformOutput, registryOutput]) rmSync(path, { recursive: true, force: true });
});

test("export_web_sdk creates a Flutter-free toolchain repo with Editor and the QJBC Web target", () => {
  const result = spawnSync("bun", ["sdk/scripts/export_web_sdk.ts", "--out", output], {
    cwd: repository,
    encoding: "utf8",
  });
  expect(`${result.stdout}${result.stderr}`).toContain("export_web_sdk: generated");
  expect(result.status).toBe(0);

  for (const path of [
    "LICENSE",
    "LICENSING.md",
    "LICENSES/PocketJS-MIT.txt",
    "editor/server.ts",
    "editor/diagnostics.ts",
    "packages/pocket_diagnostics/src/node.ts",
    "packages/pocket_cos/src/index.ts",
    "packages/pocket_cos/README.md",
    "scripts/project_templates.ts",
    "scripts/project_scaffold.ts",
    "scripts/project_commands.mjs",
    "scripts/editor_service.mjs",
    "scripts/studio_upgrade.mjs",
    "scripts/install_studio.mjs",
    "docs/STUDIO_UPGRADE.md",
    "docs/API.md",
    "docs/JS_API.md",
    "docs/TOOLING_API.md",
    "docs/FLUTTER_API.md",
    "docs/HYBRID_HOST_API.md",
    "docs/HYBRID_FLUTTER_TAB_HOST.md",
    "docs/API_SURFACE.json",
    "scripts/toolchain.mjs",
    "scripts/prebuilt_tools.mjs",
    "templates/app/app.tsx",
    "templates/game/app.tsx",
    "docs/PROJECT_TEMPLATES.md",
    "docs/NPM_TOOLCHAIN.md",
    "docs/GAME_INPUT_IMPLEMENTATION.md",
    "docs/WEB_WORKER_IMPLEMENTATION.md",
    "docs/LARGE_IMAGE_IMPLEMENTATION.md",
    "editor/native/noble-bluetooth.mjs",
    "editor/client/index.html",
    "native/src/bin/pocket_probe.rs",
    "scripts/build_guest.ts",
    "scripts/project_fonts.ts",
    "scripts/build_web.ts",
    "scripts/build_wechat.ts",
    "scripts/prepare_upstream.py",
    "targets/web/browser_runtime.js",
    "targets/wechat/template/wechat-host.js",
    "packages/pocket_ui/src/index.ts",
    "packages/pocket_vn/src/engine.ts",
    "packages/pocket_vn/src/asset-references.ts",
    "packages/pocket_vn/src/collections.ts",
    "packages/pocket_live2d/src/index.ts",
    "packages/pocket_live2d/LICENSE",
    "docs/WEB_LIVE2D.md",
    "docs/EDITOR_LIVE2D.md",
    "packages/pocket_live2d/scripts/bootstrap_cubism_web_core.sh",
    "packages/pocket_spine/src/index.ts",
    "packages/pocket_flutter/shaders/liquid_glass.frag",
  ]) expect(existsSync(join(output, path)), path).toBe(true);

  expect(existsSync(join(output, "native/target"))).toBe(false);
  expect(existsSync(join(output, ".cache"))).toBe(false);
  expect(existsSync(join(output, "editor/test"))).toBe(false);
  expect(existsSync(join(output, "packages/pocket_tftc"))).toBe(false);
  expect(existsSync(join(output, "packages/pocket_cos/test"))).toBe(false);
  expect(existsSync(join(output, "packages/pocket_cos/node_modules"))).toBe(false);
  expect(existsSync(join(output, "packages/pocket_vn/test"))).toBe(false);
  expect(existsSync(join(output, "packages/pocket_spine/test"))).toBe(false);
  expect(existsSync(join(output, "packages/pocket_spine/node_modules"))).toBe(false);
  for (const path of [
    "packages/pocket_live2d/native",
    "packages/pocket_live2d/ios",
    "packages/pocket_live2d/macos",
    "packages/pocket_live2d/android",
    "packages/pocket_live2d/windows",
    "packages/pocket_live2d/test",
    "packages/pocket_live2d/node_modules",
  ]) expect(existsSync(join(output, path)), path).toBe(false);

  const manifest = JSON.parse(readFileSync(join(output, "package.json"), "utf8"));
  expect(manifest.version).toBe(SDK_VERSION);
  expect(manifest.license).toBe("MIT");
  expect(manifest.workspaces).not.toContain("packages/pocket_tftc");
  expect(manifest.workspaces).toContain("packages/pocket_ui");

  const registryCli = spawnSync("bun", ["pocket.ts", "packages", "."], { cwd: output, encoding: "utf8" });
  expect(registryCli.stderr).toBe("");
  expect(registryCli.status).toBe(0);

  // Exercise the exported scaffold boundary, including its Python URL helper.
  const consumer = mkdtempSync(join(tmpdir(), "pocket-export-surfaces-"));
  try {
    const main = join(consumer, "android/app/src/main");
    mkdirSync(main, { recursive: true });
    writeFileSync(join(main, "AndroidManifest.xml"), '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name=".MainActivity"><intent-filter><action android:name="android.intent.action.MAIN"/></intent-filter></activity></application></manifest>');
    const scaffold = spawnSync(process.execPath, ["--eval", `import {syncNativeEcosystemProject} from ${JSON.stringify(join(output, "scripts/native_surface_scaffold.ts"))}; syncNativeEcosystemProject(${JSON.stringify(consumer)}, {modules:["android-devices"],deepLinkScheme:"pocketsurface"});`], { encoding: "utf8" });
    expect(scaffold.status, scaffold.stderr).toBe(0);
    const xml = readFileSync(join(main, "AndroidManifest.xml"), "utf8");
    expect(xml).toContain("android.intent.action.VIEW");
    expect(xml).toContain('android:scheme="pocketsurface"');
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }

  for (const name of ["pocket_looseleaf", "pocket_arc", "pocket_liquid_glass"]) {
    expect(manifest.workspaces).toContain(`packages/${name}`);
    expect(existsSync(join(output, `packages/${name}/src/index.ts`))).toBe(true);
    expect(existsSync(join(output, `packages/${name}/test`))).toBe(false);
  }
  expect(manifest.workspaces).toContain("packages/pocket_spine");
  expect(manifest.workspaces).toContain("packages/pocket_live2d");
  expect(manifest.workspaces).toContain("packages/pocket_cos");
  expect(manifest.scripts.cos).toBe("node scripts/toolchain.mjs run packages/pocket_cos/src/cli.ts");
  expect(manifest.dependencies?.["@pocket/spine"]).toBe(sourceWorkspaceVersion("spine"));
  expect(manifest.dependencies?.["@pocket/live2d"]).toBe(sourceWorkspaceVersion("live2d"));
  expect(manifest.dependencies?.["@pocket/ui"]).toBeUndefined();
  expect(manifest.dependencies?.["find-process"]).toBe("2.1.1");
  expect(manifest.dependencies?.["tree-kill"]).toBe("1.2.2");
  expect(manifest.devDependencies?.["@open-wxa/wxa-runner-core"]).toBe("0.12.3");
  expect(manifest.scripts["build:web"]).toBe("node scripts/toolchain.mjs run scripts/build_web.ts");
  expect(manifest.dependencies.bun).toBe("1.3.9");
  expect(manifest.scripts.setup).toBe("node scripts/toolchain.mjs setup");
  expect(manifest.scripts.bootstrap).toBe("node scripts/toolchain.mjs bootstrap");
  expect(manifest.scripts["build:guest"]).toBe("node scripts/toolchain.mjs build:guest");
  expect(manifest.scripts["build:probe"]).toBe("node scripts/toolchain.mjs build:probe");
  expect(manifest.scripts.editor).toContain("scripts/editor_service.mjs");
  expect(manifest.scripts.setup).not.toContain("flutter");
  expect(manifest.dependencies?.["@abandonware/noble"]).toBeUndefined();
  expect(manifest.optionalDependencies?.["@abandonware/noble"]).toBe("1.9.2-26");
  for (const workspace of manifest.workspaces as string[]) {
    const workspaceManifest = JSON.parse(readFileSync(join(output, workspace, "package.json"), "utf8"));
    expect(workspaceManifest.license).toBe(
      workspace === "packages/pocket_live2d" ? "SEE LICENSE IN LICENSE" : "MIT",
    );
  }
  const spineManifest = JSON.parse(readFileSync(join(output, "packages/pocket_spine/package.json"), "utf8"));
  expect(spineManifest.name).toBe("@pocket/spine");
  expect(spineManifest.dependencies?.["@esotericsoftware/spine-core"]).toBe("4.3.13");
  const live2dManifest = JSON.parse(readFileSync(join(output, "packages/pocket_live2d/package.json"), "utf8"));
  expect(live2dManifest.name).toBe("@pocket/live2d");
  expect(live2dManifest.license).toBe("SEE LICENSE IN LICENSE");
  expect(live2dManifest.files).toEqual(["src", "LICENSE"]);
  expect(live2dManifest.dependencies).toBeUndefined();
  expect(readFileSync(join(output, "packages/pocket_live2d/LICENSE"))).toEqual(
    readFileSync(join(repository, "sdk/packages/pocket_live2d/LICENSE")),
  );
  const live2dLicense = readFileSync(join(output, "packages/pocket_live2d/LICENSE"), "utf8");
  expect(live2dLicense).toContain("MIT License");
  expect(live2dLicense).toContain("src/cubism-web/LICENSE.md");
  expect(live2dLicense.endsWith(readFileSync(join(repository, "LICENSE"), "utf8"))).toBe(true);
  expect(readFileSync(join(output, "packages/pocket_live2d/src/cubism-web/LICENSE.md"))).toEqual(
    readFileSync(join(repository, "sdk/packages/pocket_live2d/src/cubism-web/LICENSE.md")),
  );
  for (const target of Object.values(live2dManifest.exports as Record<string, string>)) {
    expect(existsSync(join(output, "packages/pocket_live2d", target.replace(/^\.\//, "")))).toBe(true);
  }
  const installRoot = mkdtempSync(join(tmpdir(), "pocket-web-live2d-install-test-"));
  try {
    mkdirSync(join(installRoot, "packages"), { recursive: true });
    cpSync(join(output, "packages/pocket_live2d"), join(installRoot, "packages/pocket_live2d"), { recursive: true });
    writeFileSync(join(installRoot, "package.json"), JSON.stringify({
      name: "pocket-web-live2d-install-test",
      private: true,
      workspaces: ["packages/pocket_live2d"],
      dependencies: { "@pocket/live2d": sourceWorkspaceVersion("live2d") },
    }));
    const install = spawnSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: installRoot,
      encoding: "utf8",
    });
    expect(install.status).toBe(0);
    expect(realpathSync(join(installRoot, "node_modules/@pocket/live2d"))).toBe(realpathSync(join(installRoot, "packages/pocket_live2d")));
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
  const readme = readFileSync(join(output, "README.md"), "utf8");
  const sourceCommit = JSON.parse(readFileSync(join(output, "provenance.json"), "utf8")).sourceCommit as string;
  expect(readme).toContain("[MIT License](LICENSE)");
  expect(readme).toContain("[LICENSING.md](LICENSING.md)");
  expect(readme).toContain("[LICENSES/PocketJS-MIT.txt](LICENSES/PocketJS-MIT.txt)");
  expect(readme).toContain("No separate commercial authorization is required");
  expect(readme).toContain("Third-party code and assets");
  expect(readme).toContain("QJBC");
  expect(readme).toContain("[Pocket API overview](docs/API.md)");
  expect(readme).toContain("does not contain the Flutter/Dart runtime or native Flutter plugins");
  expect(readme).toContain("docs/GAME_INPUT_IMPLEMENTATION.md");
  expect(readme).toContain("docs/WEB_WORKER_IMPLEMENTATION.md");
  expect(readme).toContain("docs/LARGE_IMAGE_IMPLEMENTATION.md");
  expect(readme).toContain("docs/WEB_LIVE2D.md");

  expect(readFileSync(join(output, "LICENSE"))).toEqual(readFileSync(join(repository, "LICENSE")));
  expect(readFileSync(join(output, "LICENSES/PocketJS-MIT.txt"))).toEqual(
    readFileSync(join(repository, "LICENSES/PocketJS-MIT.txt")),
  );
  const licensing = readFileSync(join(output, "LICENSING.md"), "utf8");
  expect(licensing).toContain("(docs/PROVENANCE.md)");
  expect(licensing).toContain(`https://github.com/PocketFlutter/Pocket/blob/${sourceCommit}/sdk/packages/pocket_archive/LICENSE`);
  expect(licensing).toContain(`https://github.com/PocketFlutter/Pocket/blob/${sourceCommit}/sdk/packages/pocket_flutter/LICENSE`);
  expect(licensing).toContain("(editor/NOTICE.md)");
  expect(licensing).not.toContain("(sdk/docs/PROVENANCE.md)");
  expect(licensing).not.toContain("(sdk/editor/NOTICE.md)");
  const localLicensingTargets = [...licensing.matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1]!)
    .filter((target) => !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) && !target.startsWith("#"));
  for (const target of localLicensingTargets) expect(existsSync(join(output, target)), target).toBe(true);

  const sourceDocs = readdirSync(join(repository, "sdk/docs")).filter((file) => file.endsWith(".md")).sort();
  const exportedDocs = readdirSync(join(output, "docs")).filter((file) => file.endsWith(".md")).sort();
  expect(exportedDocs).toEqual(sourceDocs);
  const api = readFileSync(join(output, "docs/API.md"), "utf8");
  for (const page of ["FLUTTER_API.md", "HYBRID_HOST_API.md", "HYBRID_FLUTTER_TAB_HOST.md", "JS_API.md", "TOOLING_API.md"]) {
    expect(api).toContain(`(${page})`);
  }
  expect(api).toContain(`https://github.com/PocketFlutter/Pocket/blob/${sourceCommit}/AGENTS.md`);
  expect(api).toContain(`https://github.com/PocketFlutter/Pocket/blob/${sourceCommit}/.github/pull_request_template.md`);
  const jsApi = readFileSync(join(output, "docs/JS_API.md"), "utf8");
  expect(jsApi).toContain("../packages/pocket_ui/src/platform.ts");
  const flutterApi = readFileSync(join(output, "docs/FLUTTER_API.md"), "utf8");
  expect(flutterApi).toContain(`https://github.com/PocketFlutter/Pocket/blob/${sourceCommit}/sdk/lib/src/pocket_config.dart`);
  expect(existsSync(join(output, "lib/pocket_sdk.dart"))).toBe(false);
}, 30_000);

test("export_web_sdk packages only the requested platform archive and fails closed when it is absent", () => {
  withPlatformArchiveFixtures((fixtures) => {
    for (const [platform, target, os, cpu] of [
      ["darwin-arm64", darwinOutput, "darwin", "arm64"],
      ["win32-x64", windowsOutput, "win32", "x64"],
    ] as const) {
      const result = spawnSync("bun", ["sdk/scripts/export_web_sdk.ts", "--out", target, "--platform", platform], {
        cwd: repository,
        encoding: "utf8",
      });
      expect(`${result.stdout}${result.stderr}`).toContain("export_web_sdk: generated");
      expect(result.status).toBe(0);
      const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
      expect(manifest.version).toBe(SDK_VERSION);
      expect(manifest.license).toBe("MIT");
      expect(manifest.name).toBe(`@pocket/web-sdk-tools-${platform}`);
      expect(manifest.os).toEqual([os]);
      expect(manifest.cpu).toEqual([cpu]);
      expect(
        Object.keys(manifest.optionalDependencies).filter((name) => name.startsWith("@pocket/tools-")),
      ).toEqual([`@pocket/tools-${platform}`]);
      const archiveName = `pocket-tools-${platform}-${SDK_VERSION}.tgz`;
      expect(readFileSync(join(target, "prebuilt", archiveName))).toEqual(fixtures.get(archiveName));
      const readme = readFileSync(join(target, "README.md"), "utf8");
      expect(readme).toContain(`# Pocket Web SDK (${platform})`);
      expect(readme).toContain("[MIT License](LICENSE)");
      expect(existsSync(join(target, "LICENSING.md"))).toBe(true);
      expect(existsSync(join(target, "LICENSES/PocketJS-MIT.txt"))).toBe(true);
    }

    const archiveName = `pocket-tools-win32-x64-${SDK_VERSION}.tgz`;
    const archive = join(sdkBuild, archiveName);
    rmSync(archive);
    try {
      const result = spawnSync("bun", [
        "sdk/scripts/export_web_sdk.ts",
        "--out",
        missingPlatformOutput,
        "--platform",
        "win32-x64",
      ], { cwd: repository, encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("missing win32-x64 prebuilt archive");
    } finally {
      writeFileSync(archive, fixtures.get(archiveName)!);
    }
  });
}, 30_000);

test("export_web_sdk consumes verified GitHub Packages tarballs, preserves VN/Live2D/COS adaptations, and rejects version drift", () => {
  const stageRoot = mkdtempSync(join(tmpdir(), "pocket-github-packages-stage-"));
  const tarballsDir = mkdtempSync(join(tmpdir(), "pocket-github-packages-tarballs-"));
  const mismatchOutput = mkdtempSync(join(tmpdir(), "pocket-web-sdk-export-mismatch-test-"));
  try {
    const stagedDir = join(stageRoot, "packages");
    const stageRes = spawnSync(
      process.execPath,
      ["sdk/scripts/package_github_packages.mjs", "--out", stagedDir],
      { cwd: repository, encoding: "utf8" },
    );
    expect(stageRes.status, `${stageRes.stdout}\n${stageRes.stderr}`).toBe(0);
    const catalog = JSON.parse(stageRes.stdout) as Array<{ name: string; version: string; directory: string }>;
    const { workspaces } = JSON.parse(readFileSync(join(repository, "sdk/package.json"), "utf8")) as { workspaces: string[] };
    const slugs = workspaces.map((workspace) => workspace.replace(/^packages\/pocket_/, ""));
    expect(catalog.map((item) => item.name).sort()).toEqual(slugs.map((slug) => `@pocketflutter/${slug}`).sort());

    for (const item of catalog) packFixture(item.directory, tarballsDir);

    const result = spawnSync(
      "bun",
      ["sdk/scripts/export_web_sdk.ts", "--out", registryOutput, "--registry-packages", `--registry-tarballs-dir=${tarballsDir}`],
      { cwd: repository, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("export_web_sdk: generated");

    const provenance = JSON.parse(readFileSync(join(registryOutput, "provenance.json"), "utf8")) as {
      packageSource: string;
      registryPackages: Array<{ package: string; workspace: string; version: string; sha256: string }>;
    };
    expect(provenance.packageSource).toBe("github-packages");
    expect(Array.isArray(provenance.registryPackages)).toBe(true);
    expect(provenance.registryPackages).toHaveLength(slugs.length);
    for (const slug of slugs) {
      const entry = provenance.registryPackages.find((item) => item.package === `@pocketflutter/${slug}`)!;
      expect(entry, slug).toBeDefined();
      expect(entry.workspace).toBe(`@pocket/${slug}`);
      expect(entry.version).toBe(sourceWorkspaceVersion(slug));
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    }

    const rootManifest = JSON.parse(readFileSync(join(registryOutput, "package.json"), "utf8"));
    expect(rootManifest.workspaces).toContain("packages/pocket_vn");
    expect(rootManifest.workspaces).toContain("packages/pocket_live2d");
    expect(rootManifest.workspaces).toContain("packages/pocket_cos");
    for (const slug of ["spine", "live2d"]) {
      expect(rootManifest.dependencies[`@pocket/${slug}`]).toBe(sourceWorkspaceVersion(slug));
    }

    // Verify all 10 workspace manifests were normalized to @pocket/<slug> with token-free workspace dependencies
    for (const slug of slugs) {
      const pkgPath = join(registryOutput, "packages", `pocket_${slug}`, "package.json");
      expect(existsSync(pkgPath), slug).toBe(true);
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      expect(pkg.name).toBe(`@pocket/${slug}`);
      expect(pkg.publishConfig).toBeUndefined();
      expect(pkg.repository).toBeUndefined();
      expect(pkg.private).toBeUndefined();
      for (const depValue of Object.values((pkg.dependencies ?? {}) as Record<string, string>)) {
        expect(depValue).not.toContain("@pocketflutter/");
      }
    }

    // Verify COS bundled internal modules and README
    expect(existsSync(join(registryOutput, "packages/pocket_cos/README.md"))).toBe(true);
    expect(existsSync(join(registryOutput, "packages/pocket_cos/src/internal/package_update.ts"))).toBe(true);
    expect(existsSync(join(registryOutput, "packages/pocket_cos/src/internal/version_types.ts"))).toBe(true);

    // Verify VN overlaid Web Live2D adapter and dependency
    const vnManifest = JSON.parse(readFileSync(join(registryOutput, "packages/pocket_vn/package.json"), "utf8"));
    expect(vnManifest.exports["./live2d"]).toBe("./src/live2d.ts");
    expect(vnManifest.dependencies["@pocket/live2d"]).toBe(sourceWorkspaceVersion("live2d"));
    expect(vnManifest.dependencies["@pocket/spine"]).toBe(sourceWorkspaceVersion("spine"));
    expect(vnManifest.dependencies["@pocket/ui"]).toBe(sourceWorkspaceVersion("ui"));
    expect(existsSync(join(registryOutput, "packages/pocket_vn/src/live2d.ts"))).toBe(true);

    // Verify Live2D overlaid Cubism Web physics/pose, LICENSE, and bootstrap script
    const live2dManifest = JSON.parse(readFileSync(join(registryOutput, "packages/pocket_live2d/package.json"), "utf8"));
    expect(live2dManifest.license).toBe("SEE LICENSE IN LICENSE");
    expect(live2dManifest.exports["./physics"]).toBe("./src/physics.ts");
    expect(live2dManifest.exports["./pose"]).toBe("./src/pose.ts");
    expect(existsSync(join(registryOutput, "packages/pocket_live2d/src/physics.ts"))).toBe(true);
    expect(existsSync(join(registryOutput, "packages/pocket_live2d/src/pose.ts"))).toBe(true);
    expect(existsSync(join(registryOutput, "packages/pocket_live2d/src/cubism-web/LICENSE.md"))).toBe(true);
    expect(existsSync(join(registryOutput, "packages/pocket_live2d/scripts/bootstrap_cubism_web_core.sh"))).toBe(true);

    // Reject a tarball whose internal package.json version drifts from the source workspace version
    const badStage = join(stageRoot, "bad-ui");
    cpSync(join(stagedDir, "ui"), badStage, { recursive: true });
    const badUiManifestPath = join(badStage, "package.json");
    const badUiManifest = JSON.parse(readFileSync(badUiManifestPath, "utf8"));
    badUiManifest.version = `${Number(badUiManifest.version.split(".")[0]) + 1}.0.0`;
    writeFileSync(badUiManifestPath, JSON.stringify(badUiManifest, null, 2));
    cpSync(packFixture(badStage, tarballsDir), join(tarballsDir, `pocketflutter-ui-${sourceWorkspaceVersion("ui")}.tgz`));

    const mismatchRes = spawnSync(
      "bun",
      ["sdk/scripts/export_web_sdk.ts", "--out", mismatchOutput, `--registry-tarballs-dir=${tarballsDir}`],
      { cwd: repository, encoding: "utf8" },
    );
    expect(mismatchRes.status).not.toBe(0);
    expect(`${mismatchRes.stdout}${mismatchRes.stderr}`).toContain("registry tarball version mismatch for @pocketflutter/ui");
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
    rmSync(tarballsDir, { recursive: true, force: true });
    rmSync(mismatchOutput, { recursive: true, force: true });
  }
}, 30_000);
