import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [outOption, outputPath] = process.argv.slice(2);
if (outOption !== "--out" || !outputPath || process.argv.length !== 4) {
  throw new Error("Usage: node sdk/scripts/package_github_diagnostics.mjs --out <new-directory>");
}

const diagnosticsDir = fileURLToPath(new URL("../packages/pocket_diagnostics/", import.meta.url));
const licensePath = fileURLToPath(new URL("../../LICENSE", import.meta.url));
const stageDir = resolve(outputPath);

if (existsSync(stageDir)) {
  throw new Error(`Output directory already exists: ${stageDir}`);
}

const workspaceManifest = JSON.parse(readFileSync(join(diagnosticsDir, "package.json"), "utf8"));
const { private: workspacePrivate, scripts: workspaceScripts, ...publishManifest } = workspaceManifest;
const manifest = {
  ...publishManifest,
  name: "@pocketflutter/diagnostics",
  files: ["src", "LICENSE"],
  repository: {
    type: "git",
    url: "https://github.com/PocketFlutter/Pocket.git",
    directory: "sdk/packages/pocket_diagnostics",
  },
  publishConfig: {
    registry: "https://npm.pkg.github.com",
    access: "restricted",
  },
};

mkdirSync(stageDir, { recursive: true });
cpSync(join(diagnosticsDir, "src"), join(stageDir, "src"), { recursive: true });
cpSync(licensePath, join(stageDir, "LICENSE"));
writeFileSync(join(stageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
