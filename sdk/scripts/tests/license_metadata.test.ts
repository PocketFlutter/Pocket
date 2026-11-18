import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../../..");
const sdk = join(repository, "sdk");
const firstPartyPackages = [
  "pocket_arc",
  "pocket_cos",
  "pocket_diagnostics",
  "pocket_live2d",
  "pocket_looseleaf",
  "pocket_spine",
  "pocket_sync",
  "pocket_tftc",
  "pocket_ui",
  "pocket_vn",
];

test("Pocket workspace and first-party package metadata identify their license", () => {
  const rootManifest = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
  const sdkManifest = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(sdk, "package-lock.json"), "utf8"));

  expect(rootManifest.license).toBe("MIT");
  expect(sdkManifest.license).toBe("MIT");
  expect(lock.packages[""].license).toBe("MIT");

  for (const name of firstPartyPackages) {
    const manifest = JSON.parse(readFileSync(join(sdk, "packages", name, "package.json"), "utf8"));
    const expected = name === "pocket_live2d" ? "SEE LICENSE IN LICENSE" : "MIT";
    expect(manifest.license).toBe(expected);
    const lockedWorkspace = lock.packages["packages/" + name];
    if (lockedWorkspace) expect(lockedWorkspace.license).toBe(expected);
  }

  // Third-party dependency terms stay as recorded by npm.
  expect(lock.packages["node_modules/@abandonware/bluetooth-hci-socket"].license).toBe("MIT");
});

test("Pocket Flutter CocoaPods notice points to the exact MIT text and retains its package notice", () => {
  const podspec = readFileSync(join(sdk, "packages/pocket_flutter/macos/pocket_flutter.podspec"), "utf8");
  const packageLicense = readFileSync(join(sdk, "packages/pocket_flutter/LICENSE"));
  const rootLicense = readFileSync(join(repository, "LICENSE"));

  expect(podspec).toContain(":type => 'MIT', :file => '../LICENSE'");
  expect(packageLicense.toString("utf8")).toContain("Copyright (c) PocketJS contributors.");
  expect(packageLicense.toString("utf8")).toContain("Pocket Flutter first-party integration license");
  expect(packageLicense).toEqual(Buffer.concat([
    packageLicense.subarray(0, packageLicense.length - rootLicense.length),
    rootLicense,
  ]));
});

test("Live2D package license notice distinguishes its wrapper from independently licensed Cubism files", () => {
  const manifest = JSON.parse(readFileSync(join(sdk, "packages/pocket_live2d/package.json"), "utf8"));
  const license = readFileSync(join(sdk, "packages/pocket_live2d/LICENSE"), "utf8");
  const rootLicense = readFileSync(join(repository, "LICENSE"), "utf8");
  const cubismLicense = readFileSync(join(sdk, "packages/pocket_live2d/src/cubism-web/LICENSE.md"), "utf8");

  expect(manifest.license).toBe("SEE LICENSE IN LICENSE");
  expect(manifest.files).toContain("LICENSE");
  expect(license).toContain("first-party Pocket Live2D wrapper/API code");
  expect(license).toContain("src/cubism-web/LICENSE.md");
  expect(license).toContain("Cubism Core is separately licensed");
  expect(license.endsWith(rootLicense)).toBe(true);
  expect(cubismLicense).toContain("Live2D");
});
