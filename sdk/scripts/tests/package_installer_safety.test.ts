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

test("recovers a killed installer before the next project operation", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pocket-interrupted-install-"));
  try {
    const registry = join(temp, "registry");
    const projectDir = join(temp, "app");
    mkdirSync(projectDir);
    const pkg = join(projectDir, "package.json");
    writeFileSync(pkg, '{ "name": "example" }\n');
    buildPackageRegistry({ sdkRoot, outDir: registry });

    const driver = join(temp, "interrupt.ts");
    writeFileSync(driver, `
      import { mock } from "bun:test";
      import * as fs from "node:fs";
      const rename = fs.renameSync;
      mock.module("node:fs", () => ({
        ...fs,
        renameSync(from: string, to: string) {
          rename(from, to);
          if (to === ${JSON.stringify(pkg)}) process.kill(process.pid, "SIGKILL");
        },
      }));
      const { installProjectPackages } = await import(${JSON.stringify(resolve(import.meta.dir, "../package_installer.ts"))});
      await installProjectPackages(${JSON.stringify({ projectDir, registry, packages: ["looseleaf"] })});
    `);
    const child = Bun.spawn([process.execPath, driver], { stdout: "ignore", stderr: "pipe" });
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    expect(readFileSync(pkg, "utf8")).toContain("file:vendor/pocket-looseleaf");
    expect(existsSync(join(projectDir, "vendor/pocket-looseleaf"))).toBe(true);
    expect(existsSync(join(projectDir, "pocket-lock.json"))).toBe(false);

    const next = removeProjectPackages({ projectDir, packages: ["looseleaf"] });
    expect(next.removed).toEqual([]);
    expect(readFileSync(pkg, "utf8")).toBe('{ "name": "example" }\n');
    expect(existsSync(join(projectDir, "vendor"))).toBe(false);
    expect(Object.keys(readProjectLockfile(projectDir).packages)).toEqual([]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("leaves an active package operation and its project untouched", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pocket-live-install-"));
  try {
    const active = join(
      projectDir,
      ".pocket-build/package-operations",
      `op-${process.pid}-00000000-0000-4000-8000-000000000000`,
    );
    mkdirSync(active, { recursive: true });
    writeFileSync(join(active, "marker"), "active");
    expect(() => removeProjectPackages({ projectDir, packages: ["looseleaf"] }))
      .toThrow("A Pocket package operation is already active");
    expect(readFileSync(join(active, "marker"), "utf8")).toBe("active");
    expect(existsSync(join(projectDir, "pocket-lock.json"))).toBe(false);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("accepts a local registry directory from the environment and gives explicit options precedence", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pocket-local-registry-"));
  const previous = process.env.POCKET_REGISTRY_PATH;
  try {
    const registry = join(temp, "registry");
    buildPackageRegistry({ sdkRoot, outDir: registry });
    process.env.POCKET_REGISTRY_PATH = registry;
    expect((await loadRegistryIndex({})).baseLocation).toBe(registry);
    process.env.POCKET_REGISTRY_PATH = "https://invalid.example";
    await expect(loadRegistryIndex({})).rejects.toThrow("must be a local registry directory");
    expect((await loadRegistryIndex({ registry })).baseLocation).toBe(registry);
  } finally {
    if (previous === undefined) delete process.env.POCKET_REGISTRY_PATH;
    else process.env.POCKET_REGISTRY_PATH = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});
