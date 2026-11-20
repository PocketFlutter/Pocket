import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildGuest } from "../../../../sdk/scripts/build_guest.ts";
import { prepareWorkbenchGuest } from "./stage.ts";

const root = resolve(import.meta.dir, "../../../..");
const sdk = join(root, "sdk");
const packageRoot = join(sdk, "packages/pocket_live2d");
const project = join(root, ".pocket-build/live2d-workbench");
const host = join(project, "flutter");
const flutter = process.env.FLUTTER_BIN ?? "flutter";
const request = process.argv.slice(2);
if (request.length !== 1) {
  throw new Error("Usage: bun demo/js/apps/live2d-workbench/run.ts --prepare-only | <device-id>");
}

if (!existsSync(join(host, "pubspec.yaml"))) {
  execFileSync("npm", ["--prefix", sdk, "run", "init", "--", project], { cwd: root, stdio: "inherit" });
}
if (!existsSync(join(host, "ios/Runner.xcodeproj")) || !existsSync(join(host, "android/app"))) {
  throw new Error(`Flutter platforms were not generated in ${host}. Check the toolchain used by SDK init.`);
}

const { projectRoot } = prepareWorkbenchGuest(join(project, "guest"));
await buildGuest({
  projectRoot,
  outDir: join(project, "guest-build"),
  copyAssetsTo: join(host, "assets"),
  bakeFonts: true,
  rasterDensity: 2,
});

const pubspecPath = join(host, "pubspec.yaml");
const pubspec = readFileSync(pubspecPath, "utf8");
const dependency = relative(host, packageRoot);
if (!pubspec.includes("  pocket_live2d:")) {
  const updated = pubspec.replace("\ndev_dependencies:", `  pocket_live2d:\n    path: ${dependency}\n\ndev_dependencies:`);
  writeFileSync(pubspecPath, updated.replace("\n  assets:\n", "\n  assets:\n    - assets/novel.native-assets.json\n    - assets/native-models/\n"));
}

writeFileSync(join(host, "lib/main.dart"), `import 'package:flutter/widgets.dart';
import 'package:pocket_live2d/pocket_live2d.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(PocketApp(
    config: PocketAppConfig(
      appId: 'dev.pocketjs.live2dworkbench',
      pluginFactories: [
        (_) => PocketLive2dPlugin.fromBundledCatalog(
          catalogAsset: 'assets/novel.native-assets.json',
          assetPrefix: 'assets',
        ),
      ],
    ),
  ));
}
`);

if (request[0] !== "--prepare-only") {
  execFileSync(flutter, ["run", "--device-id", request[0]!], { cwd: host, stdio: "inherit" });
} else {
  console.log(`Prepared Pocket Live2D 看板娘 at ${host}`);
}
