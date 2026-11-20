import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { installProjectPackages, loadRegistryIndex, readProjectLockfile, removeProjectPackages } from "../package_installer.ts";
import { buildPackageRegistry } from "../registry_builder.ts";

const sdkRoot = resolve(import.meta.dir, "../..");

test("revalidates cached archives and preserves project vendoring and dependency edits", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pocket-installer-"));
  try {
    const registry = join(temp, "registry");
    const cacheDir = join(temp, "cache");
    const projectDir = join(temp, "app");
    mkdirSync(projectDir);
    const pkg = join(projectDir, "package.json");
    writeFileSync(pkg, "{}\n");
    buildPackageRegistry({ sdkRoot, outDir: registry });
    const options = { projectDir, registry, cacheDir, packages: ["looseleaf"] };
    await installProjectPackages(options);

    const entry = readProjectLockfile(projectDir).packages.pocket_looseleaf!;
    const archive = join(cacheDir, `${entry.tarballSha256}.tar.gz`);
    const verified = readFileSync(archive);
    writeFileSync(archive, Buffer.alloc(verified.length));
    const custom = join(projectDir, entry.vendorPath!, "project-notes.txt");
    writeFileSync(custom, "Project customization\n");
    const dependencies = JSON.parse(readFileSync(pkg, "utf8")).dependencies;
    dependencies[entry.jsPackageName!] = "workspace:*";
    writeFileSync(pkg, JSON.stringify({ dependencies }));

    await installProjectPackages(options);
    expect(createHash("sha256").update(readFileSync(archive)).digest("hex")).toBe(entry.tarballSha256);
    expect(readdirSync(cacheDir).every((path) => path.endsWith(".tar.gz"))).toBe(true);
    expect(readFileSync(custom, "utf8")).toBe("Project customization\n");
    removeProjectPackages({ projectDir, packages: ["looseleaf"] });
    expect(readFileSync(custom, "utf8")).toBe("Project customization\n");
    expect(JSON.parse(readFileSync(pkg, "utf8")).dependencies[entry.jsPackageName!]).toBe("workspace:*");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("keeps required packages and rolls back a failed host update", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pocket-installer-"));
  try {
    const registry = join(temp, "registry");
    const projectDir = join(temp, "app");
    mkdirSync(join(projectDir, "flutter"), { recursive: true });
    const pkg = join(projectDir, "package.json");
    const pubspec = join(projectDir, "flutter/pubspec.yaml");
    writeFileSync(pkg, "{}\n");
    writeFileSync(pubspec, "name: example\ndependencies:\n");
    writeFileSync(join(projectDir, "manifest.json"), "{\n");
    buildPackageRegistry({ sdkRoot, outDir: registry });
    const options = { projectDir, registry, packages: ["camera", "services"] };
    await expect(installProjectPackages(options)).rejects.toThrow();
    expect(readFileSync(pkg, "utf8")).toBe("{}\n");
    expect(readFileSync(pubspec, "utf8")).toBe("name: example\ndependencies:\n");
    expect(existsSync(join(projectDir, "vendor"))).toBe(false);
    expect(existsSync(join(projectDir, "flutter/lib"))).toBe(false);
    expect(existsSync(join(projectDir, "pocket-lock.json"))).toBe(false);

    writeFileSync(join(projectDir, "manifest.json"), "{}\n");
    await installProjectPackages(options);
    const before = readFileSync(join(projectDir, "pocket-lock.json"), "utf8");
    expect(() => removeProjectPackages({ projectDir, packages: ["services"] }))
      .toThrow("required by pocket_camera");
    expect(readFileSync(join(projectDir, "pocket-lock.json"), "utf8")).toBe(before);
    expect(removeProjectPackages(options).removed).toContain("pocket_services");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("keeps the remote registry error when a partial SDK has no local source fallback", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pocket-partial-sdk-"));
  try {
    mkdirSync(join(temp, "packages/pocket_ui"), { recursive: true });
    await expect(loadRegistryIndex({
      sdkRoot: temp,
      fetchImpl: (async () => new Response("", { status: 503 })) as typeof fetch,
    })).rejects.toThrow(/Failed to load PocketFlutter package registry: HTTP 503/);
    expect(existsSync(join(temp, ".pocket-build"))).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
