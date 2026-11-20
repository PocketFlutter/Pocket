import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const consumerPath = process.argv[2];
if (!consumerPath) throw new Error("Usage: bun sdk/scripts/verify_github_packages.ts <consumer-dir>");
const consumer = await realpath(resolve(consumerPath));
const packages = ["diagnostics", "ui", "arc", "liquid_glass", "looseleaf", "sync", "spine", "cos", "cloudflare", "vn", "live2d"];

for (const slug of packages) {
  const installedPath = join(consumer, "node_modules", "@pocket", slug);
  const installed = await realpath(installedPath);
  strictEqual(installed, installedPath, `Expected an installed package directory for @pocket/${slug}`);
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  strictEqual(manifest.name, `@pocketflutter/${slug}`);
  if (slug === "vn") {
    strictEqual(manifest.dependencies["@pocket/live2d"], undefined);
    strictEqual(manifest.exports["./live2d"], undefined);
    ok(!(await readdir(join(installed, "src"))).includes("live2d.ts"));
  }
  if (slug === "live2d") {
    deepStrictEqual((await readdir(join(installed, "src"))).sort(), ["index.ts", "interaction.ts", "manifest.ts", "motion.ts", "transport.ts"]);
  }
  ok(manifest.exports["."], `Missing root export for ${manifest.name}`);
  for (const subpath of Object.keys(manifest.exports)) {
    const specifier = `@pocket/${slug}${subpath.slice(1)}`;
    const entry = await realpath(Bun.resolveSync(specifier, consumer));
    const file = relative(installed, entry);
    ok(file && !file.startsWith("..") && !isAbsolute(file), `${specifier} resolved outside the installed package`);
  }
}

function load(specifier: string) {
  return import(pathToFileURL(Bun.resolveSync(specifier, consumer)).href);
}

const { createDiagnosticsCollector } = await load("@pocket/diagnostics");
const { createFileDiagnostics } = await load("@pocket/diagnostics/node");
const diagnostics = createDiagnosticsCollector();
await diagnostics.recordLog("registry smoke log");
strictEqual((await diagnostics.listLogs())[0]?.message, "registry smoke log");
await diagnostics.close();

const journal = await mkdtemp(join(consumer, ".diagnostics-"));
try {
  const file = createFileDiagnostics({ directory: journal });
  const log = await file.recordLog("persisted registry log");
  const crash = await file.recordCrash(new Error("persisted registry crash"));
  await file.close();

  const reopened = createFileDiagnostics({ directory: journal });
  try {
    strictEqual((await reopened.listCrashes())[0]?.error.message, "persisted registry crash");
    strictEqual((await reopened.getCrashRecentLogs(crash.id))[0]?.id, log.id);
  } finally {
    await reopened.close();
  }
} finally {
  await rm(journal, { force: true, recursive: true });
}

const { utf8ToBytes, bytesToUtf8 } = await load("@pocket/ui/bytes");
strictEqual(bytesToUtf8(utf8ToBytes("Pocket 渲染 🧪")), "Pocket 渲染 🧪");

const { concentricInnerRadius } = await load("@pocket/arc/tokens");
strictEqual(concentricInnerRadius(16, 6), 10);
const { hexToArgb } = await load("@pocket/liquid_glass/tokens");
strictEqual(hexToArgb("#007aff"), 0xff007aff);
const { densityHitHeight } = await load("@pocket/looseleaf/tokens");
strictEqual(densityHitHeight("compact"), 34);

const { sha256Hex, InMemorySyncServerNode, createSyncMeshStore } = await load("@pocket/sync");
strictEqual(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
strictEqual(typeof InMemorySyncServerNode, "function");
strictEqual(typeof createSyncMeshStore, "function");

const { getSpineAtlasPages } = await load("@pocket/spine");
deepStrictEqual(getSpineAtlasPages("page.png\nsize: 16,16\nfilter: Linear,Linear\n"), ["page.png"]);

const { sha1Hex, verifyLocalPackageDirectory } = await load("@pocket/cos");
strictEqual(sha1Hex("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
strictEqual(typeof verifyLocalPackageDirectory, "function");

const { createNovelEngine } = await load("@pocket/vn");
const story = createNovelEngine({
  id: "registry-smoke", version: 1, start: "start",
  script: { start: [{ type: "ending", id: "completed" }] },
});
story.start();
strictEqual(story.getSnapshot().active?.kind, "ending");
story.dispose();

const { parseCubismModel3, createPocketLive2dClient } = await load("@pocket/live2d");
strictEqual(parseCubismModel3({ Version: 3, FileReferences: { Moc: "model.moc3", Textures: ["atlas.png"] } }).moc, "model.moc3");
strictEqual(typeof createPocketLive2dClient, "function");

console.log(`Verified exports and exercised installed packages: ${packages.join(", ")}`);
