import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [outOption, outputPath, versionsOption, versionsPath, ...extra] = process.argv.slice(2);
if (outOption !== "--out" || !outputPath || extra.length ||
    (versionsOption !== undefined && (versionsOption !== "--versions" || !versionsPath))) {
  throw new Error("Usage: node sdk/scripts/package_github_packages.mjs --out <new-directory> [--versions <json>]");
}
const versions = versionsPath ? JSON.parse(readFileSync(versionsPath, "utf8")) : {};

const sdkRoot = fileURLToPath(new URL("../", import.meta.url));
const stageRoot = resolve(outputPath);
if (existsSync(stageRoot)) {
  throw new Error(`Output directory already exists: ${stageRoot}`);
}

// Publish dependency packages before the packages that consume them.
const packageSlugs = [
  "diagnostics", "ui", "spine", "sync", "arc", "liquid_glass", "looseleaf", "cos", "cloudflare", "vn", "live2d",
];
const live2dExports = [".", "./manifest", "./motion", "./interaction", "./transport"];
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
    version: versions[name] ?? workspaceManifest.version,
    files,
    repository: {
      type: "git",
      url: "https://github.com/PocketFlutter/Pocket.git",
      directory: `sdk/packages/pocket_${slug}`,
    },
    publishConfig: {
      registry: "https://npm.pkg.github.com",
      // Preserve the integrity of the pilot version already in the registry.
      ...(slug === "diagnostics" && (versions[name] ?? workspaceManifest.version) === "0.1.0" ? { access: "restricted" } : {}),
    },
  };

  const dependencies = { ...workspaceManifest.dependencies };
  if (slug === "vn") {
    delete dependencies["@pocket/live2d"];
    dependencies["@pocket/ui"] = workspaces.get("@pocket/ui").manifest.version;
    manifest.exports = { ...manifest.exports };
    delete manifest.exports["./live2d"];
  }
  if (slug === "live2d") {
    manifest.license = "MIT";
    manifest.exports = Object.fromEntries(live2dExports.map((entry) => {
      const source = workspaceManifest.exports[entry];
      if (typeof source !== "string") throw new Error(`Missing Live2D export: ${entry}`);
      return [entry, source];
    }));
  }
  if (slug === "sync") {
    dependencies["@pocket/ui"] = workspaces.get("@pocket/ui").manifest.version;
    dependencies["solid-js"] = sdkManifest.devDependencies["solid-js"];
  }
  for (const [dependency, version] of Object.entries(dependencies)) {
    if (!dependency.startsWith("@pocket/")) continue;
    const target = workspaces.get(dependency);
    if (!target || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
      throw new Error(`Unresolved workspace dependency: ${name} requires ${dependency}@${version}`);
    }
    dependencies[dependency] = `npm:@pocketflutter/${target.slug}@${versions[`@pocketflutter/${target.slug}`] ?? target.manifest.version}`;
  }
  if (Object.keys(dependencies).length) manifest.dependencies = dependencies;

  mkdirSync(stageDir, { recursive: true });
  if (slug === "live2d") {
    const sourceDir = join(stageDir, "src");
    mkdirSync(sourceDir);
    const files = live2dExports.slice(1).map((entry) => manifest.exports[entry]);
    for (const file of files) cpSync(join(directory, file), join(stageDir, file));
    const index = files.map((file) => `export * from "${file.replace("./src/", "./")}";\n`).join("");
    writeFileSync(join(stageDir, manifest.exports["."]), index);
  } else {
    cpSync(join(directory, "src"), join(stageDir, "src"), {
      recursive: true,
      filter: (source) => slug !== "vn" || source !== join(directory, "src/live2d.ts"),
    });
  }
  const localLicense = join(directory, "LICENSE");
  cpSync(slug !== "live2d" && existsSync(localLicense) ? localLicense : join(sdkRoot, "..", "LICENSE"), join(stageDir, "LICENSE"));
  if (workspaceManifest.files?.includes("README.md")) {
    cpSync(join(directory, "README.md"), join(stageDir, "README.md"));
    files.push("README.md");
  }
  if (slug === "cos" || slug === "cloudflare") stageCos(stageDir);
  writeFileSync(join(stageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  published.push({ name, version: manifest.version, directory: stageDir });
}

process.stdout.write(`${JSON.stringify(published)}\n`);
