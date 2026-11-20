import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseCubismModel3 } from "../../../../sdk/packages/pocket_live2d/src/manifest.ts";

const sdk = resolve(import.meta.dir, "../../../../sdk");
const cubismPackage = join(sdk, "packages/pocket_live2d");
const resourceRoot = "live2d/Mao";
const source = `${resourceRoot}/Mao.model3.json`;
const animations = ["Idle:0", "TapBody:0", "TapBody:1"];

export function prepareWorkbenchGuest(directory: string): { projectRoot: string } {
  const projectRoot = resolve(directory);
  const cubism = resolve(process.env.CUBISM_SDK_ROOT ??
    join(cubismPackage, ".cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5"));
  const origin = join(cubism, "Samples/Resources/Mao");
  const model = join(origin, "Mao.model3.json");
  if (!existsSync(model)) {
    throw new Error("Mao sample missing. Set CUBISM_SDK_ROOT to the local pinned Cubism SDK Native 5-r.5.");
  }
  const font = resolve(process.env.POCKET_WORKBENCH_CJK_FONT ??
    join(import.meta.dir, "../lantern/.pocket-build/font-source/NotoSansCJKsc-Regular.otf"));
  if (!existsSync(font)) {
    throw new Error("CJK font missing. Set POCKET_WORKBENCH_CJK_FONT to a local NotoSansCJKsc-Regular.otf.");
  }

  const manifest = parseCubismModel3(readFileSync(model, "utf8"));
  for (const animation of animations) {
    const [group, index] = animation.split(":") as [string, string];
    if (!manifest.motions[group]?.[Number(index)]) throw new Error(`Mao motion missing: ${animation}`);
  }
  const destination = join(projectRoot, resourceRoot);
  mkdirSync(destination, { recursive: true });
  copyFileSync(model, join(projectRoot, source));
  const files = new Set([
    manifest.moc,
    ...Object.values(manifest.motions).flatMap(group => group.map(motion => motion.file)),
    ...manifest.expressions.map(expression => expression.file),
  ]);
  for (const file of [manifest.physics, manifest.pose, manifest.userData, manifest.displayInfo]) {
    if (file) files.add(file);
  }
  for (const file of files) {
    const output = join(destination, file);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(join(origin, file), output);
  }
  const textures = Object.fromEntries(manifest.textures.map(file => {
    const output = join(destination, file);
    mkdirSync(dirname(output), { recursive: true });
    execFileSync("sips", ["-Z", "512", join(origin, file), "--out", output], { stdio: "ignore" });
    return [file, `${resourceRoot}/${file}`];
  }));
  for (const file of ["app.tsx", "pocket.json", "manifest.json"]) {
    copyFileSync(join(import.meta.dir, file), join(projectRoot, file));
  }
  const writeJson = (file: string, document: unknown) =>
    writeFileSync(join(projectRoot, file), JSON.stringify(document, null, 2) + "\n");
  writeJson("novel.assets.json", {
    backgrounds: {}, characters: {}, cgs: {},
    models: { mao: { kind: "live2d", source, interactive: true, textures, animations } },
  });
  writeJson("package.json", {
    name: "pocket-live2d-workbench",
    private: true,
    type: "module",
    dependencies: Object.fromEntries(Object.entries({
      "@pocket/ui": "pocket_ui",
      "@pocket/vn": "pocket_vn",
      "@pocket/spine": "pocket_spine",
      "@pocket/live2d": "pocket_live2d",
    }).map(([name, folder]) => [name, `file:${relative(projectRoot, join(sdk, "packages", folder))}`])),
  });
  mkdirSync(join(projectRoot, "fonts"), { recursive: true });
  copyFileSync(font, join(projectRoot, "fonts/NotoSansCJKsc-Regular.otf"));
  writeJson("fonts.json", {
    fallback: ["fonts/NotoSansCJKsc-Regular.otf"],
    characterFiles: ["app.tsx"],
  });
  return { projectRoot };
}

function prepareEditorWorkspace(directory: string): void {
  if (existsSync(directory)) {
    if (!existsSync(join(directory, "pocket.json"))) {
      throw new Error(`The destination already exists without pocket.json: ${directory}`);
    }
    console.log("Reusing the existing workbench workspace.");
  } else {
    mkdirSync(dirname(directory), { recursive: true });
    const temporary = mkdtempSync(join(dirname(directory), ".editor-stage-"));
    try {
      prepareWorkbenchGuest(temporary);
      renameSync(temporary, directory);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  console.log(`Open this folder in Pocket Editor:\n${directory}`);
}

if (import.meta.main) {
  const [directory, extra] = process.argv.slice(2);
  if (extra !== undefined || directory?.startsWith("-")) {
    throw new Error("Usage: bun demo/js/apps/live2d-workbench/stage.ts [editor-directory]");
  }
  prepareEditorWorkspace(resolve(directory ?? join(sdk, "../.pocket-build/live2d-workbench/editor-costumes")));
}
