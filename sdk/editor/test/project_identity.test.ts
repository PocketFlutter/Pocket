import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { renameProjectAppIdentity } from "../project_identity.ts";

const oldRootId = "acme.host";
const newRootId = "new.host";
const profileId = "vendor.profile";
const nestedId = "acme.host.navigation.more";
const externalId = "publisher.shared";

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function packageManifest(id: string, output: string, withSystemUi = false): Record<string, unknown> {
  return {
    "$schema": "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id,
    name: id.replaceAll(".", "-"),
    title: id,
    version: "0.1.0",
    engine: { capabilities: { requires: withSystemUi ? ["text.glyphs.baked", "ui.compositor-surfaces"] : ["text.glyphs.baked"], enhances: [] } },
    app: {
      entry: "app.tsx",
      output,
      framework: "solid",
      viewport: { fixed: { logical: [360, 640], presentation: "native" } },
    },
  };
}

function createFixture(options: { externalCollision?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "pocket-editor-project-identity-"));
  const chosenExternalId = options.externalCollision ? `${newRootId}.profile` : externalId;
  writeJson(join(root, "pocket.json"), packageManifest(oldRootId, "root-app", true));
  writeJson(join(root, "editor.json"), {
    id: "identity-fixture",
    appId: oldRootId,
    name: "Identity fixture",
    version: "0.1.0",
    build: 1,
    reusePublishedPackages: [chosenExternalId],
  });
  writeJson(join(root, "manifest.json"), {
    "$schema": "https://pocketjs.dev/schema/pocket-guest-manifest.json",
    protocolVersion: 1,
    capabilities: { requires: ["text.glyphs.baked", "ui.compositor-surfaces"], optional: [] },
    permissions: { optional: [] },
  });
  writeFileSync(join(root, "app.tsx"), [
    `const profile = "${profileId}";`,
    `const profileUrl = 'pocket://app/${profileId}/page?from=system';`,
    `const nested = \`${nestedId}\`;`,
    `const longer = "x${profileId}";`,
    `// Keep documentation/comment identity ${profileId}.`,
    `const jsx = <div>${profileId}</div>;`,
    "",
  ].join("\n"));

  for (const [folder, id, output] of [
    ["profile", profileId, "profile-app"],
    ["navigation", nestedId, "navigation-app"],
    ["shared", chosenExternalId, "shared-app"],
  ]) {
    const directory = join(root, "apps", folder);
    writeJson(join(directory, "pocket.json"), packageManifest(id, output));
    writeJson(join(directory, "editor.json"), { id: folder, appId: id, name: folder, version: "0.1.0", build: 1 });
    writeFileSync(join(directory, "app.tsx"), `const appIdentity = "${profileId}";\nconst packageId = "${id}";\n`);
  }

  writeJson(join(root, "pocket.system.json"), {
    "$schema": "https://pocketjs.dev/schema/pocket-system-1.json",
    pocketSystem: 1,
    id: "independent.system.identity",
    name: "identity-fixture",
    title: "Identity fixture",
    version: "0.1.0",
    roles: { systemUI: oldRootId },
    applications: {
      installPolicy: { model: "managed", mutable: false },
      backgroundExecution: "suspend",
      catalog: [
        { package: oldRootId, manifest: "pocket.json", required: true },
        { package: profileId, manifest: "apps/profile/pocket.json", required: true },
        { package: nestedId, manifest: "apps/navigation/pocket.json", required: true },
        { package: chosenExternalId, manifest: "apps/shared/pocket.json", required: true },
      ],
    },
    installation: { installedPackages: [oldRootId, profileId, nestedId, chosenExternalId] },
  });
  writeJson(join(root, "pocket.resources.json"), {
    version: 1,
    packages: {
      [oldRootId]: { network: ["pak:root:logo"] },
      [profileId]: { network: ["pak:profile:avatar"] },
      [nestedId]: { network: [] },
      [chosenExternalId]: { network: ["pak:shared:logo"] },
    },
  });
  writeJson(join(root, "generated/compositor-surfaces.json"), {
    schemaVersion: 1,
    surfaces: { [profileId]: 2, [nestedId]: 3, [chosenExternalId]: 4 },
    applications: {
      [profileId]: { title: "Profile", assetDirectory: "apps/profile/dist" },
      [chosenExternalId]: { title: "Shared", assetDirectory: "apps/shared/dist" },
    },
  });
  writeJson(join(root, "release-history/history.json"), { oldPackage: profileId, message: "preserve history" });
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets/runtime.js"), `const outputPackageId = "${profileId}";\n`);
  mkdirSync(join(root, ".pocket-ui-backup-Ab1234"), { recursive: true });
  writeFileSync(join(root, ".pocket-ui-backup-Ab1234/source.ts"), `const backupPackageId = "${profileId}";\n`);
  mkdirSync(join(root, "apps/profile/.pocket-build"), { recursive: true });
  writeFileSync(join(root, "apps/profile/.pocket-build/app.js"), `const generated = "${profileId}";\n`);
  return root;
}

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function updateRootConfig(root: string, id: string): Promise<void> {
  const editor = json(join(root, "editor.json"));
  editor.appId = id;
  writeJson(join(root, "editor.json"), editor);
  const pocket = json(join(root, "pocket.json"));
  pocket.id = id;
  writeJson(join(root, "pocket.json"), pocket);
}

test("app identity renames managed catalog ids and exact source references, preserving external/history/cache identities", async () => {
  const root = createFixture();
  const externalBefore = readFileSync(join(root, "apps/shared/pocket.json"));
  const externalSourceBefore = readFileSync(join(root, "apps/shared/app.tsx"));
  const cacheBefore = readFileSync(join(root, "apps/profile/.pocket-build/app.js"));
  const assetSourceBefore = readFileSync(join(root, "assets/runtime.js"));
  const backupSourceBefore = readFileSync(join(root, ".pocket-ui-backup-Ab1234/source.ts"));
  try {
    await renameProjectAppIdentity(root, oldRootId, newRootId, () => updateRootConfig(root, newRootId));
    const system = json(join(root, "pocket.system.json"));
    assert.equal(system.id, "independent.system.identity");
    assert.equal(system.roles.systemUI, newRootId);
    assert.deepEqual(system.applications.catalog.map((entry: any) => entry.package), [newRootId, `${newRootId}.profile`, `${newRootId}.navigation.more`, externalId]);
    assert.deepEqual(system.installation.installedPackages, [newRootId, `${newRootId}.profile`, `${newRootId}.navigation.more`, externalId]);

    assert.equal(json(join(root, "apps/profile/pocket.json")).id, `${newRootId}.profile`);
    assert.equal(json(join(root, "apps/profile/editor.json")).appId, `${newRootId}.profile`);
    assert.equal(json(join(root, "apps/navigation/pocket.json")).id, `${newRootId}.navigation.more`);
    assert.equal(json(join(root, "apps/navigation/editor.json")).appId, `${newRootId}.navigation.more`);
    assert.deepEqual(json(join(root, "apps/shared/pocket.json")), JSON.parse(externalBefore.toString("utf8")));
    assert.deepEqual(readFileSync(join(root, "apps/shared/app.tsx")), externalSourceBefore);

    const rootSource = readFileSync(join(root, "app.tsx"), "utf8");
    assert.ok(rootSource.includes(`const profile = "${newRootId}.profile";`));
    assert.ok(rootSource.includes(`const profileUrl = 'pocket://app/${newRootId}.profile/page?from=system';`));
    assert.ok(rootSource.includes(`const nested = \`${newRootId}.navigation.more\`;`));
    assert.ok(rootSource.includes(`const longer = "x${profileId}";`));
    assert.ok(rootSource.includes(`// Keep documentation/comment identity ${profileId}.`));
    assert.ok(rootSource.includes(`<div>${profileId}</div>`));

    const resources = json(join(root, "pocket.resources.json"));
    assert.deepEqual(Object.keys(resources.packages), [newRootId, `${newRootId}.profile`, `${newRootId}.navigation.more`, externalId]);
    const generated = json(join(root, "generated/compositor-surfaces.json"));
    assert.equal(generated.surfaces[`${newRootId}.profile`], 2);
    assert.equal(generated.surfaces[`${newRootId}.navigation.more`], 3);
    assert.equal(generated.surfaces[externalId], 4);
    assert.ok(generated.applications[`${newRootId}.profile`]);
    assert.ok(generated.applications[externalId]);
    assert.deepEqual(readFileSync(join(root, "apps/profile/.pocket-build/app.js")), cacheBefore);
    assert.deepEqual(readFileSync(join(root, "assets/runtime.js")), assetSourceBefore);
    assert.deepEqual(readFileSync(join(root, ".pocket-ui-backup-Ab1234/source.ts")), backupSourceBefore);
    assert.equal(json(join(root, "release-history/history.json")).oldPackage, profileId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("app identity skips dependency symlinks without modifying their targets", async () => {
  const root = createFixture();
  const dependencyTarget = mkdtempSync(join(tmpdir(), "pocket-editor-project-identity-deps-"));
  const targetSource = join(dependencyTarget, "index.ts");
  writeFileSync(targetSource, `export const linkedPackage = "${profileId}";\n`);
  mkdirSync(join(root, "vendor"), { recursive: true });
  symlinkSync(dependencyTarget, join(root, "node_modules"), "dir");
  for (const packageName of ["pocket-ui", "pocket-looseleaf", "pocket-arc"]) {
    symlinkSync(dependencyTarget, join(root, "vendor", packageName), "dir");
  }
  const targetBefore = readFileSync(targetSource);
  try {
    await renameProjectAppIdentity(root, oldRootId, newRootId, () => updateRootConfig(root, newRootId));
    assert.deepEqual(readFileSync(targetSource), targetBefore);
    assert.equal(json(join(root, "pocket.system.json")).roles.systemUI, newRootId);
    assert.equal(json(join(root, "apps/profile/pocket.json")).id, `${newRootId}.profile`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dependencyTarget, { recursive: true, force: true });
  }
});

test("app identity rejects an unrelated source symlink before writing", async () => {
  const root = createFixture();
  const outsideSource = mkdtempSync(join(tmpdir(), "pocket-editor-project-identity-source-link-"));
  const linkedSource = join(outsideSource, "linked.ts");
  writeFileSync(linkedSource, `export const packageId = "${profileId}";\n`);
  symlinkSync(linkedSource, join(root, "linked.ts"), "file");
  const targetBefore = readFileSync(linkedSource);
  const originalRootSource = readFileSync(join(root, "app.tsx"));
  const originalSystem = readFileSync(join(root, "pocket.system.json"));
  let rootConfigCommitted = false;
  try {
    await assert.rejects(
      renameProjectAppIdentity(root, oldRootId, newRootId, async () => { rootConfigCommitted = true; }),
      /source tree contains a symlink: linked\.ts/,
    );
    assert.equal(rootConfigCommitted, false);
    assert.deepEqual(readFileSync(join(root, "app.tsx")), originalRootSource);
    assert.deepEqual(readFileSync(join(root, "pocket.system.json")), originalSystem);
    assert.deepEqual(readFileSync(linkedSource), targetBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideSource, { recursive: true, force: true });
  }
});

test("app identity collision is rejected before any project write", async () => {
  const root = createFixture({ externalCollision: true });
  const before = new Map<string, Buffer>();
  for (const relativePath of ["editor.json", "pocket.json", "pocket.system.json", "app.tsx", "apps/profile/pocket.json", "apps/profile/app.tsx"]) {
    before.set(relativePath, readFileSync(join(root, relativePath)));
  }
  let committed = false;
  try {
    await assert.rejects(
      renameProjectAppIdentity(root, oldRootId, newRootId, async () => { committed = true; }),
      /conflicts with an externally reused package/,
    );
    assert.equal(committed, false);
    for (const [relativePath, bytes] of before) assert.deepEqual(readFileSync(join(root, relativePath)), bytes, relativePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("root config callback failure restores the complete identity transaction", async () => {
  const root = createFixture();
  const paths = [
    "editor.json", "pocket.json", "pocket.system.json", "pocket.resources.json", "generated/compositor-surfaces.json",
    "app.tsx", "apps/profile/pocket.json", "apps/profile/editor.json", "apps/profile/app.tsx", "apps/navigation/pocket.json",
  ];
  const before = new Map(paths.map((path) => [path, readFileSync(join(root, path))]));
  try {
    await assert.rejects(renameProjectAppIdentity(root, oldRootId, newRootId, async () => {
      await updateRootConfig(root, newRootId);
      throw new Error("simulated root config write failure");
    }), /simulated root config write failure/);
    for (const [path, bytes] of before) assert.deepEqual(readFileSync(join(root, path)), bytes, path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
