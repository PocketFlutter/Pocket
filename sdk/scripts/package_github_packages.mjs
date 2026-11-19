import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [outOption, outputPath] = process.argv.slice(2);
if (outOption !== "--out" || !outputPath || process.argv.length !== 4) {
  throw new Error("Usage: node sdk/scripts/package_github_packages.mjs --out <new-directory>");
}

const sdkRoot = fileURLToPath(new URL("../", import.meta.url));
const stageRoot = resolve(outputPath);
if (existsSync(stageRoot)) {
  throw new Error(`Output directory already exists: ${stageRoot}`);
}

// Publish dependency packages before the packages that consume them.
const packageSlugs = [
  "diagnostics", "ui", "spine", "sync", "arc", "liquid_glass", "looseleaf", "cos",
];
const workspaces = new Map(packageSlugs.map((slug) => {
  const directory = join(sdkRoot, "packages", `pocket_${slug}`);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (manifest.name !== `@pocket/${slug}`) throw new Error(`Unexpected workspace name: ${manifest.name}`);
  return [manifest.name, { slug, directory, manifest }];
}));
const sdkManifest = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));

function stageCos(stageDir) {
  const internalDir = join(stageDir, "src", "internal");
  mkdirSync(internalDir);
  cpSync(join(sdkRoot, "scripts", "package_update.ts"), join(internalDir, "package_update.ts"));

  // Carry the editor's release record contract without bringing its storage implementation.
  const versionStore = readFileSync(join(sdkRoot, "editor", "version_store.ts"), "utf8");
  const versionTypes = versionStore.match(/export type VersionSlot = [\s\S]+?(?=export type VersionHistory = )/);
  if (!versionTypes) throw new Error("Missing COS release record source types");
  writeFileSync(join(internalDir, "version_types.ts"), versionTypes[0].trimEnd() + "\n");

  const publisherPath = join(stageDir, "src", "publisher.ts");
  let publisher = readFileSync(publisherPath, "utf8");
  for (const [source, destination] of [
    ["../../../editor/version_store.ts", "./internal/version_types.ts"],
    ["../../../scripts/package_update.ts", "./internal/package_update.ts"],
  ]) {
    if (!publisher.includes(source)) throw new Error(`Missing COS staging import: ${source}`);
    publisher = publisher.replace(source, destination);
  }
  writeFileSync(publisherPath, publisher);
}

const published = [];
for (const { slug, directory, manifest: workspaceManifest } of workspaces.values()) {
  const { private: workspacePrivate, scripts: workspaceScripts, ...publishManifest } = workspaceManifest;
  const name = `@pocketflutter/${slug}`;
  const stageDir = join(stageRoot, slug);
  const files = ["src", "LICENSE"];
  const manifest = {
    ...publishManifest,
    name,
    files,
    repository: {
      type: "git",
      url: "https://github.com/PocketFlutter/Pocket.git",
      directory: `sdk/packages/pocket_${slug}`,
    },
    publishConfig: {
      registry: "https://npm.pkg.github.com",
      // Preserve the integrity of the pilot version already in the registry.
      ...(slug === "diagnostics" && workspaceManifest.version === "0.1.0" ? { access: "restricted" } : {}),
    },
  };

  const dependencies = { ...workspaceManifest.dependencies };
  if (slug === "sync") {
    dependencies["@pocket/ui"] = workspaces.get("@pocket/ui").manifest.version;
    dependencies["solid-js"] = sdkManifest.devDependencies["solid-js"];
  }
  for (const [dependency, version] of Object.entries(dependencies)) {
    if (!dependency.startsWith("@pocket/")) continue;
    const target = workspaces.get(dependency);
    if (!target || target.manifest.version !== version) {
      throw new Error(`Unresolved workspace dependency: ${name} requires ${dependency}@${version}`);
    }
    dependencies[dependency] = `npm:@pocketflutter/${target.slug}@${version}`;
  }
  if (Object.keys(dependencies).length) manifest.dependencies = dependencies;

  mkdirSync(stageDir, { recursive: true });
  cpSync(join(directory, "src"), join(stageDir, "src"), { recursive: true });
  const localLicense = join(directory, "LICENSE");
  cpSync(existsSync(localLicense) ? localLicense : join(sdkRoot, "..", "LICENSE"), join(stageDir, "LICENSE"));
  if (workspaceManifest.files?.includes("README.md")) {
    cpSync(join(directory, "README.md"), join(stageDir, "README.md"));
    files.push("README.md");
  }
  if (slug === "cos") stageCos(stageDir);
  writeFileSync(join(stageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  published.push({ name, version: manifest.version, directory: stageDir });
}

process.stdout.write(`${JSON.stringify(published)}\n`);
