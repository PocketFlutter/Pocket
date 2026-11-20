import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { isMissingNpmPackage, releaseSdkPackages } from "../release_sdk_packages.mjs";

const repository = resolve(import.meta.dir, "../../..");
const loadJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function execute(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout);
}

test("recognizes missing registry versions in npm JSON and text diagnostics only", () => {
  const missing = JSON.stringify({ error: { code: "ETARGET" } });
  expect(isMissingNpmPackage({ stdout: missing, stderr: "" })).toBe(true);
  expect(isMissingNpmPackage({ stdout: "", stderr: missing })).toBe(true);
  expect(isMissingNpmPackage({ stdout: "", stderr: "npm ERR! code E404\n" })).toBe(true);
  expect(isMissingNpmPackage({ stdout: '{"error":{"code":"E403"}}', stderr: "" })).toBe(false);
  expect(isMissingNpmPackage({ stdout: '{"error":{"code":"E401","summary":"ETARGET"}}', stderr: "" })).toBe(false);
});

test("compares packed payloads and cascades versions while retaining pending and source-only adapters", () => {
  const fixture = mkdtempSync(join(tmpdir(), "pocket-release-plan-test-"));
  try {
    const root = join(fixture, "sdk");
    for (const path of [
      "LICENSE", "sdk/package.json", "sdk/package-lock.json", "sdk/bun.lock", "sdk/packages",
      "sdk/editor/version_store.ts", "sdk/scripts/package_update.ts", "sdk/scripts/package_github_packages.mjs",
      "sdk/scripts/standalone_publisher_files.mjs",
      "demo/js/package.json", "demo/js/bun.lock", "demo/js/apps/lantern/package.json", "demo/js/apps/lantern/bun.lock",
    ]) {
      const target = join(fixture, path);
      mkdirSync(resolve(target, ".."), { recursive: true });
      cpSync(join(repository, path), target, { recursive: true, filter: (entry) => basename(entry) !== "node_modules" });
    }

    const stage: { name: string; version: string; directory: string }[] = execute(process.execPath, [
      join(root, "scripts", "package_github_packages.mjs"), "--out", join(fixture, "official"),
    ], fixture);
    const published = new Map(stage.map(({ name, version, directory }) => {
      const [{ filename }] = execute("npm", ["pack", "--ignore-scripts", "--json"], directory);
      const archive = join(directory, filename);
      // Different npm/Node builds can produce different compressed bytes for the same tar.
      const compressed = readFileSync(archive);
      const recompressed = gzipSync(gunzipSync(compressed), { level: 0 });
      expect(recompressed.equals(compressed)).toBe(false);
      writeFileSync(archive, recompressed);
      return [`${name}@${version}`, archive];
    }));
    const fetchPublished = (name: string, version: string) => published.get(`${name}@${version}`);
    appendFileSync(join(root, "packages/pocket_vn/src/live2d.ts"), "\n// Web-only adapter change.\n");
    appendFileSync(join(root, "packages/pocket_live2d/src/physics.ts"), "\n// Licensed integration change.\n");
    const baseline = releaseSdkPackages({ root, fetchPublished });
    expect(baseline.manifests).toEqual([]);
    expect(baseline.packages.every((entry) => entry.status === "published")).toBe(true);

    appendFileSync(join(root, "packages/pocket_ui/src/index.ts"), "\n// Fixture package change.\n");
    const manifestPath = (slug: string) => join(root, `packages/pocket_${slug}/package.json`);
    const writeVersion = (slug: string, version: string) => {
      const path = manifestPath(slug);
      writeFileSync(path, JSON.stringify({ ...loadJson(path), version }, null, 2));
    };
    const nextMinor = (slug: string) => {
      const [major, minor] = loadJson(manifestPath(slug)).version.split(".");
      const version = `${major}.${Number(minor) + 1}.0`;
      writeVersion(slug, version);
      return version;
    };
    const arcVersion = nextMinor("arc");
    const live2dVersion = nextMinor("live2d");
    const spineVersion = nextMinor("spine");
    const originalUi = stage.find((entry) => entry.name === "@pocketflutter/ui")!.version;
    const [major, minor, patch] = originalUi.split(".");
    const plan = releaseSdkPackages({ root, fetchPublished });
    expect(loadJson(manifestPath("ui")).version).toBe(originalUi);
    expect(plan.packages.filter((entry) => entry.status === "pending").map((entry) => entry.name)).toEqual([
      "@pocketflutter/ui", "@pocketflutter/spine", "@pocketflutter/sync", "@pocketflutter/arc",
      "@pocketflutter/liquid_glass", "@pocketflutter/looseleaf", "@pocketflutter/vn", "@pocketflutter/live2d",
    ]);

    expect(releaseSdkPackages({ root, mode: "apply", fetchPublished })).toEqual(plan);
    const ui = plan.packages.find((entry) => entry.name === "@pocketflutter/ui")!;
    expect(ui.version).toBe(`${major}.${minor}.${Number(patch) + 1}`);
    expect(loadJson(manifestPath("arc"))).toMatchObject({ version: arcVersion, dependencies: { "@pocket/ui": ui.version } });
    expect(loadJson(manifestPath("vn")).dependencies).toEqual({ "@pocket/spine": spineVersion, "@pocket/live2d": live2dVersion });
    expect(loadJson(join(root, "package.json"))).toMatchObject({
      dependencies: { "@pocket/ui": ui.version }, devDependencies: { "@pocket/spine": spineVersion },
    });
    expect(loadJson(join(root, "package-lock.json")).packages).toMatchObject({
      "": { dependencies: { "@pocket/ui": ui.version }, devDependencies: { "@pocket/spine": spineVersion } },
      "packages/pocket_arc": { version: arcVersion, dependencies: { "@pocket/ui": ui.version } },
      "packages/pocket_vn": { dependencies: { "@pocket/spine": spineVersion, "@pocket/live2d": live2dVersion } },
    });
    expect(readFileSync(join(fixture, "demo/js/bun.lock"), "utf8")).toContain(`"@pocket/ui": "${ui.version}"`);
    expect(readFileSync(join(fixture, "demo/js/apps/lantern/bun.lock"), "utf8")).toContain(
      `"@pocket/live2d": "${live2dVersion}", "@pocket/spine": "${spineVersion}"`,
    );
    expect(readFileSync(join(root, "bun.lock"), "utf8")).toContain(`"name": "@pocket/ui",\n      "version": "${ui.version}"`);
    for (const cwd of [root, join(fixture, "demo/js"), join(fixture, "demo/js/apps/lantern")]) {
      const installed = spawnSync("bun", ["install", "--frozen-lockfile", "--lockfile-only", "--ignore-scripts"], {
        cwd,
        encoding: "utf8",
      });
      if (installed.status !== 0) throw new Error(installed.error?.message ?? installed.stderr);
    }
    expect(releaseSdkPackages({ root, fetchPublished }).manifests).toEqual([]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 90_000);
