/** Export and optionally publish the standalone Pocket Web SDK repository. */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";

import { SDK_VERSION } from "./prebuilt_tools.mjs";

const SDK_ROOT = resolve(import.meta.dir, "..");
const REPOSITORY_ROOT = resolve(SDK_ROOT, "..");
const DEFAULT_OUT = resolve(SDK_ROOT, ".pocket-build/web-sdk");
const DEFAULT_REPO = "PocketFlutter/pocket-web-sdk";
const PINNED_REVISION = "99924de47c62fa36f526a8791055d91cbbdb3836";

type Platform = "darwin-arm64" | "win32-x64";
type Options = { out: string; repo: string; publish: boolean; force: boolean; platform?: Platform };

function usage(exitCode = 0): never {
  console.log("usage: bun sdk/scripts/export_web_sdk.ts [--out PATH] [--platform darwin-arm64|win32-x64] [--repo OWNER/NAME] [--publish] [--force]");
  process.exit(exitCode);
}

function option(args: string[], name: string, fallback: string): string {
  const inline = args.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3) || usage(1);
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

function platformOption(args: string[]): Platform | undefined {
  const inline = args.find((value) => value.startsWith("--platform="));
  const index = args.indexOf("--platform");
  const raw = inline ? inline.slice("--platform=".length) : index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && (!raw || raw.startsWith("--"))) throw new Error("--platform requires a value");
  if (raw === undefined) return undefined;
  if (raw !== "darwin-arm64" && raw !== "win32-x64") {
    throw new Error(`--platform must be darwin-arm64 or win32-x64 (received ${raw})`);
  }
  return raw;
}

function run(command: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, inherit = false): string {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(`${command.join(" ")} failed (${result.status ?? 1})\n${output.trim()}`);
  return result.stdout ?? "";
}

function copyFile(source: string, target: string): void {
  if (!existsSync(source) || !lstatSync(source).isFile()) throw new Error(`missing required file: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { force: true });
}

function copyTree(source: string, target: string): void {
  if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new Error(`missing required directory: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    force: true,
    filter: (path) => !path.split(/[\\/]/).some((part) => part === "node_modules" || part === "target" || part === ".cache" || part === ".pocket-build" || part === ".git"),
  });
}

function copyWebLive2dPackage(out: string): void {
  const source = join(SDK_ROOT, "packages/pocket_live2d");
  const sourceManifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as Record<string, unknown>;
  if (sourceManifest.name !== "@pocket/live2d" || typeof sourceManifest.version !== "string" || sourceManifest.license !== "SEE LICENSE IN LICENSE" || !sourceManifest.exports || typeof sourceManifest.exports !== "object") {
    throw new Error("invalid @pocket/live2d package manifest");
  }
  const target = join(out, "packages/pocket_live2d");
  copyTree(join(source, "src"), join(target, "src"));
  copyFile(join(source, "LICENSE"), join(target, "LICENSE"));
  copyFile(join(source, "scripts/bootstrap_cubism_web_core.sh"), join(target, "scripts/bootstrap_cubism_web_core.sh"));
  write(join(target, "package.json"), `${JSON.stringify({
    name: sourceManifest.name,
    version: sourceManifest.version,
    license: sourceManifest.license,
    type: sourceManifest.type ?? "module",
    sideEffects: sourceManifest.sideEffects ?? false,
    exports: sourceManifest.exports,
    files: ["src", "LICENSE"],
  }, null, 2)}\n`);
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function clearOutput(out: string, force: boolean): void {
  if (!existsSync(out)) {
    mkdirSync(out, { recursive: true });
    return;
  }
  const entries = readdirSync(out);
  if (entries.length > 0 && !force) throw new Error(`output exists: ${out}; pass --force to replace its generated files`);
  for (const entry of entries) {
    if (entry === ".git") continue;
    rmSync(join(out, entry), { recursive: true, force: true });
  }
}

function exportPathForSource(out: string, sourcePath: string): string | null {
  const repoRelative = relative(REPOSITORY_ROOT, sourcePath).replaceAll("\\", "/");
  if (!repoRelative || repoRelative === ".." || repoRelative.startsWith("../") || repoRelative.startsWith("/")) return null;
  // The standalone root manifest is generated, not the repository's script
  // forwarding manifest. Do not redirect a source API link to another file
  // merely because both happen to be named package.json.
  if (repoRelative === "package.json" || repoRelative === "sdk/package.json") return null;
  // The source repository keeps reusable SDK files below sdk/, while the
  // standalone package exposes those files from its repository root.
  const exportRelative = repoRelative.startsWith("sdk/") ? repoRelative.slice("sdk/".length) : repoRelative;
  return resolve(out, exportRelative);
}

function encodePathSegments(path: string): string {
  return path.replaceAll("\\", "/").split("/").map((part) => encodeURIComponent(part)).join("/");
}

function rewriteUnavailableSourceLinks(
  markdown: string,
  sourceDocPath: string,
  exportedDocPath: string,
  out: string,
  sourceCommit: string,
): string {
  return markdown.replace(/(\]\()(<[^>\n]*>|[^)\s]+)([^)]*\))/g, (whole, open: string, wrappedTarget: string, close: string) => {
    const angleWrapped = wrappedTarget.startsWith("<") && wrappedTarget.endsWith(">");
    const target = angleWrapped ? wrappedTarget.slice(1, -1) : wrappedTarget;
    if (!target || target.startsWith("#") || target.startsWith("/") || target.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
      return whole;
    }

    const queryIndex = target.indexOf("?");
    const hashIndex = target.indexOf("#");
    const suffixIndex = [queryIndex, hashIndex].filter((index) => index >= 0).reduce((min, index) => Math.min(min, index), target.length);
    const pathPart = target.slice(0, suffixIndex);
    const suffix = target.slice(suffixIndex);
    if (!pathPart) return whole;

    let sourceTarget: string;
    try {
      sourceTarget = resolve(dirname(sourceDocPath), decodeURIComponent(pathPart.replaceAll("\\", "/")));
    } catch {
      return whole;
    }
    const repoRelative = relative(REPOSITORY_ROOT, sourceTarget).replaceAll("\\", "/");
    if (!repoRelative || repoRelative === ".." || repoRelative.startsWith("../") || repoRelative.startsWith("/")) return whole;
    if (!existsSync(sourceTarget)) return whole;

    const exportTarget = exportPathForSource(out, sourceTarget);
    const exportedTargetExists = exportTarget !== null && existsSync(exportTarget);

    let rewrittenPath: string;
    if (exportedTargetExists && exportTarget !== null) {
      const relativePath = relative(dirname(exportedDocPath), exportTarget);
      rewrittenPath = encodePathSegments(relativePath || ".");
    } else {
      let isDirectory = false;
      try { isDirectory = lstatSync(sourceTarget).isDirectory(); } catch { /* source file may disappear during export */ }
      rewrittenPath = `https://github.com/PocketFlutter/Pocket/${isDirectory ? "tree" : "blob"}/${sourceCommit}/${encodePathSegments(repoRelative)}`;
    }

    const rewrittenTarget = `${rewrittenPath}${suffix}`;
    return `${open}${angleWrapped ? `<${rewrittenTarget}>` : rewrittenTarget}${close}`;
  });
}

function copyDocs(out: string, sourceCommit: string): void {
  const sourceDocs = join(SDK_ROOT, "docs");
  const markdownFiles = readdirSync(sourceDocs)
    .filter((file) => file.endsWith(".md") && lstatSync(join(sourceDocs, file)).isFile())
    .sort();
  for (const file of [...markdownFiles, "API_SURFACE.json"]) {
    copyFile(join(sourceDocs, file), join(out, "docs", file));
  }
  for (const file of markdownFiles) {
    const source = join(sourceDocs, file);
    const target = join(out, "docs", file);
    const markdown = readFileSync(source, "utf8");
    write(target, rewriteUnavailableSourceLinks(markdown, source, target, out, sourceCommit));
  }
}

function copySources(out: string, sourceCommit: string): void {
  copyTree(join(SDK_ROOT, "templates"), join(out, "templates"));
  copyTree(join(SDK_ROOT, "editor"), join(out, "editor"));
  rmSync(join(out, "editor/test"), { recursive: true, force: true });

  for (const file of [
    "build_guest.ts",
    "project_fonts.ts",
    "prebuilt_tools.mjs",
    "toolchain.mjs",
    "package_toolchain.ts",
    "build_web_engine.ts",
    "build_system.ts",
    "build_web.ts",
    "build_wechat.ts",
    "flutter_target.ts",
    "native_probe_path.ts",
    "editor_service.mjs",
    "pocket_studio_launcher.ts",
    "studio_upgrade.mjs",
    "install_studio.mjs",
    "package_update.ts",
    "platform_scaffold.ts",
    "ecosystem_scaffold.ts",
    "native_surface_scaffold.ts",
    "patch_deep_links.py",
    "project_templates.ts",
    "project_scaffold.ts",
    "create_project.mjs",
    "check_project.mjs",
    "project_commands.mjs",
    "plugin_types.ts",
    "prepare_upstream.py",
    "preview_wechat.ts",
    "serve_updates.ts",
  ]) copyFile(join(SDK_ROOT, "scripts", file), join(out, "scripts", file));

  copyTree(join(SDK_ROOT, "targets/web"), join(out, "targets/web"));
  copyTree(join(SDK_ROOT, "targets/wechat"), join(out, "targets/wechat"));
  copyTree(join(SDK_ROOT, "native"), join(out, "native"));
  copyTree(join(SDK_ROOT, "packages/pocket_ui"), join(out, "packages/pocket_ui"));
  rmSync(join(out, "packages/pocket_ui/test"), { recursive: true, force: true });
  for (const name of ["pocket_looseleaf", "pocket_arc", "pocket_liquid_glass"]) {
    copyTree(join(SDK_ROOT, "packages", name), join(out, "packages", name));
    rmSync(join(out, "packages", name, "test"), { recursive: true, force: true });
  }
  copyTree(join(SDK_ROOT, "packages/pocket_vn"), join(out, "packages/pocket_vn"));
  rmSync(join(out, "packages/pocket_vn/test"), { recursive: true, force: true });
  copyTree(join(SDK_ROOT, "packages/pocket_spine"), join(out, "packages/pocket_spine"));
  rmSync(join(out, "packages/pocket_spine/test"), { recursive: true, force: true });
  // The Web consumer only needs the JS Live2D API. Flutter plugins, native
  // Core bindings and generated native caches remain source-SDK concerns.
  copyWebLive2dPackage(out);
  copyFile(join(SDK_ROOT, "packages/pocket_diagnostics/package.json"), join(out, "packages/pocket_diagnostics/package.json"));
  copyTree(join(SDK_ROOT, "packages/pocket_diagnostics/src"), join(out, "packages/pocket_diagnostics/src"));
  copyFile(join(SDK_ROOT, "packages/pocket_cos/package.json"), join(out, "packages/pocket_cos/package.json"));
  copyFile(join(SDK_ROOT, "packages/pocket_cos/README.md"), join(out, "packages/pocket_cos/README.md"));
  copyTree(join(SDK_ROOT, "packages/pocket_cos/src"), join(out, "packages/pocket_cos/src"));
  copyFile(join(SDK_ROOT, "packages/pocket_sync/package.json"), join(out, "packages/pocket_sync/package.json"));
  copyTree(join(SDK_ROOT, "packages/pocket_sync/src"), join(out, "packages/pocket_sync/src"));
  copyFile(
    join(SDK_ROOT, "packages/pocket_flutter/shaders/liquid_glass.frag"),
    join(out, "packages/pocket_flutter/shaders/liquid_glass.frag"),
  );

  copyFile(join(REPOSITORY_ROOT, "LICENSE"), join(out, "LICENSE"));
  copyTree(join(REPOSITORY_ROOT, "LICENSES"), join(out, "LICENSES"));
  copyDocs(out, sourceCommit);

  const licensingSource = join(REPOSITORY_ROOT, "LICENSING.md");
  const licensingTarget = join(out, "LICENSING.md");
  write(licensingTarget, rewriteUnavailableSourceLinks(
    readFileSync(licensingSource, "utf8"),
    licensingSource,
    licensingTarget,
    out,
    sourceCommit,
  ));
}

function writeRepositoryFiles(out: string, sourceCommit: string, platform?: Platform): void {
  const uiManifestPath = join(out, "packages/pocket_ui/package.json");
  const uiManifest = JSON.parse(readFileSync(uiManifestPath, "utf8")) as Record<string, unknown>;
  delete uiManifest.private;
  write(uiManifestPath, `${JSON.stringify(uiManifest, null, 2)}\n`);

  const packageJson = {
    name: platform ? `@pocket/web-sdk-tools-${platform}` : "@pocket/web-sdk-tools",
    version: SDK_VERSION,
    description: "Standalone PocketJS Web SDK and Editor; no Flutter environment required",
    private: false,
    type: "module",
    license: "MIT",
    engines: { node: ">=22.22.2" },
    workspaces: ["packages/pocket_ui", "packages/pocket_looseleaf", "packages/pocket_arc", "packages/pocket_liquid_glass", "packages/pocket_spine", "packages/pocket_live2d", "packages/pocket_diagnostics", "packages/pocket_cos", "packages/pocket_sync"],
    dependencies: {
      "@pocket/spine": "0.1.0",
      "@pocket/live2d": "0.1.0",
      bun: "1.3.9",
      "find-process": "2.1.1",
      "solid-js": "1.9.14",
      "tree-kill": "1.2.2",
      typescript: "5.9.3",
    },
    devDependencies: {
      "@open-wxa/wxa-runner-core": "0.12.3",
      "node-gyp": "12.3.0",
    },
    optionalDependencies: { "@abandonware/noble": "1.9.2-26" } as Record<string, string>,
    scripts: {
      create: "node scripts/create_project.mjs",
      "sync:agents": "node scripts/create_project.mjs --sync-agents",
      check: "node scripts/check_project.mjs",
      setup: "node scripts/toolchain.mjs setup",
      "setup:source": "node scripts/toolchain.mjs setup:source",
      "bootstrap:source": "node scripts/toolchain.mjs bootstrap:source",
      "build:probe:source": "node scripts/toolchain.mjs build:probe:source",
      bootstrap: "node scripts/toolchain.mjs bootstrap",
      doctor: "node scripts/toolchain.mjs doctor",
      "build:guest": "node scripts/toolchain.mjs build:guest",
      "build:probe": "node scripts/toolchain.mjs build:probe",
      "build:web": "node scripts/toolchain.mjs run scripts/build_web.ts",
      "build:wechat": "node scripts/toolchain.mjs run scripts/build_wechat.ts",
      cos: "node scripts/toolchain.mjs run packages/pocket_cos/src/cli.ts",
      start: "node scripts/editor_service.mjs start",
      stop: "node scripts/editor_service.mjs stop",
      status: "node scripts/editor_service.mjs status",
      editor: "node scripts/editor_service.mjs start",
      "editor:lan": "bun run editor",
    },
  };
  const archives = (existsSync(join(SDK_ROOT, '.pocket-build')) ? readdirSync(join(SDK_ROOT, '.pocket-build')) : []).filter(name => /^pocket-tools-(darwin|linux|win32)-(arm64|x64)-[0-9.]+\.tgz$/.test(name) && name.endsWith(`-${SDK_VERSION}.tgz`));
  const selectedArchives = platform
    ? archives.filter((name) => name === `pocket-tools-${platform}-${SDK_VERSION}.tgz`)
    : archives;
  if (platform && selectedArchives.length !== 1) {
    throw new Error(`missing ${platform} prebuilt archive: expected pocket-tools-${platform}-${SDK_VERSION}.tgz in ${join(SDK_ROOT, ".pocket-build")}`);
  }
  if (selectedArchives.length) {
    Object.assign(packageJson.optionalDependencies, Object.fromEntries(selectedArchives.map(name => {
      copyFile(join(SDK_ROOT, '.pocket-build', name), join(out, 'prebuilt', name));
      const suffix = name.slice('pocket-tools-'.length, -`-${SDK_VERSION}.tgz`.length);
      return [`@pocket/tools-${suffix}`, `file:prebuilt/${name}`];
    })));
  }
  if (platform) {
    const [os, cpu] = platform.split("-");
    Object.assign(packageJson, { os: [os], cpu: [cpu] });
  }
  write(join(out, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  write(join(out, ".gitignore"), [
    ".cache/", ".pocket-build/", "node_modules/", "native/target/", "target/", "dist/", ".DS_Store", "*.log", "*.pem", "*.key", "",
  ].join("\n"));

  write(join(out, "README.md"), `# Pocket Web SDK\n\nStandalone PocketJS Web SDK and Editor. Flutter, Dart, CocoaPods, Xcode and the Android SDK are not required for the Web toolchain.\n\nThe Web target uses the pinned PocketJS compiler, admitted QuickJS bytecode (QJBC), PAK resources and the real PocketJS runtime compiled to WebAssembly. The browser boundary is standard \`WebAssembly.instantiate\` + Canvas2D with Pointer, IME, resize and visibility lifecycle support. There is no mock runtime or source-evaluation fallback.\n\n## AI development: required reading\n\nRead the following guides in order before editing code. Reuse the existing runtime, layout system, and control behavior.\n\n| Order | Document | What to learn |\n| --- | --- | --- |\n| 1 | [AI_APP_DEVELOPMENT.md](docs/AI_APP_DEVELOPMENT.md) | Development workflow, JS/host boundaries, controls, Editor, resource packaging, publishing, and live updates. |\n| 2 | [COMPONENTS.md](docs/COMPONENTS.md) | Component contracts; custom skins must inherit interaction, focus, keyboard/gamepad, IME, accessibility, and lifecycle behavior. |\n| 3 | [EDITOR_STUDIO.md](docs/EDITOR_STUDIO.md) | Editor startup, real Preview, version backend, LAN publishing, and preview entry points. |\n| 4 | [EDITOR_TEST_PACKAGES.md](docs/EDITOR_TEST_PACKAGES.md) | Test/stable packages, signed artifacts, version management, and LAN live-update tests. |\n| 5 | [PACKAGE_UPDATE_MODES.md](docs/PACKAGE_UPDATE_MODES.md) | Initial full packages and subsequent fine-grained updates by resource/content hash. |\n| 6 | [HARDWARE_MODULES.md](docs/HARDWARE_MODULES.md) | Enable hardware and permissions as needed; register real application adapters for capabilities missing in browsers. |\n| 7 | [WEB_SDK_EXPORT.md](docs/WEB_SDK_EXPORT.md) | Web SDK provenance, retained implementation, required adaptations, ablation, and runtime evidence. |\n| 8 | [NPM_TOOLCHAIN.md](docs/NPM_TOOLCHAIN.md) | npm installation, cross-platform toolchain entry points, buildGuest/QJBC/PAK builds, and verification boundaries. |\n| 9 | [PROVENANCE.md](docs/PROVENANCE.md) | Pinned upstream version, provenance, and verification boundaries. |\n| 10 | [WECHAT_HOST_IMPLEMENTATION.md](docs/WECHAT_HOST_IMPLEMENTATION.md) | Read for WeChat targets: WXWebAssembly, Canvas2D, and platform limits. |\n\nBusiness UI, state, routing, and composition belong in JS. Declare hardware capabilities as needed; return unsupported/unconfigured for missing capabilities. New interfaces inherit existing controls. Web and Editor use the pinned buildGuest/QJBC/PAK pipeline without a mock runtime or source-evaluation fallback.\n\n## Install and build\n\n[One-command installation](docs/INSTALL_STUDIO.md) downloads and verifies the official standalone release.\n\nOnly Node.js 22.22.2+ (Node.js 24 LTS recommended) and npm are required. Bun is installed and managed by npm; compiler/probe binaries and the prepared pinned compiler are supplied by the platform package. Run:\n\n\`\`\`sh\nnpm run setup\n\`\`\`\n\n\`npm run setup\` installs npm dependencies and verifies the prebuilt tools (platform, SDK revision, QuickJS ABI and SHA-256). It does not invoke Rust/Cargo, Python or C/C++ tools, and will fail clearly if the platform package is unavailable. Source builds are maintainer-only commands ending in :source. No Flutter command is run by setup or by the Web build.\n\nA project root contains \`pocket.json\`, \`manifest.json\` and its JS/TS entry. Build the complete guest artifacts directly with npm:\n\n\`\`\`sh\nnpm run build:guest -- --project-root=/path/to/app --outdir=/path/to/app/dist\nnpm run build:web -- --project-root=/path/to/app --outdir=/path/to/web\n\`\`\`\n\nThe guest build invokes the pinned \`buildGuest\` implementation, emits \`app.qjbc\`, \`app.bytecode.json\` and \`app.pak\`, and includes the vendored \`@pocket/ui\` workspace package. It does not require Flutter. The Web build additionally emits \`pocket-web.js\`, \`engine/pocketjs.wasm\`, \`pocket.config.json\`, build metadata, types and usage instructions.\n\nThe bundle includes macOS arm64 and Windows x64 platform archives. Windows CI has verified clean npm setup/doctor, Noble WinRT addon loading, real App/Game QJBC/PAK builds and input-driven Preview frames, plus Studio start/health/status/stop on fixed port 8791. Windows physical BLE device connections/notifications and Linux native BLE remain unverified or unsupported as documented. The npm packages have not been published to a registry yet. See docs/NPM_TOOLCHAIN.md and docs/WINDOWS_BUILD.md for evidence and limits.\n\n## Editor\n\n\`\`\`sh\nnpm run editor\n# open http://127.0.0.1:8791\n\`\`\`\n\nThe Editor includes project management, real Guest preview, input/IME inspection, version management, signed packages and LAN test publishing. Device deployment remains an optional host integration and is not required for Web development.\n\n## UI ownership\n\nBusiness UI, state, routing and component composition belong in JS. Reuse the existing controls and inherit their focus, press/cancel, disabled, keyboard/gamepad, scrolling, IME, safe-area, accessibility, route and lifecycle behavior before changing skins or adding evidenced behavior. See [AI_APP_DEVELOPMENT.md](docs/AI_APP_DEVELOPMENT.md) and [COMPONENTS.md](docs/COMPONENTS.md).\n\n## Updates\n\nThe canonical update route is \`<root>/<optional-prefix>/pocket/<hostVersion>/<packageId>/<packageVersion>/latest.json\`. Initial install may fetch the complete PAK; subsequent releases can fetch only changed content-addressed resource parts. The Editor version backend can publish and test this layout on a LAN.\n`);

  const licensingSection = `\n## Licensing\n\nPocket and its first-party wrappers are licensed under the [MIT License](LICENSE). See [LICENSING.md](LICENSING.md) for component scope. No separate commercial authorization is required under the MIT terms.\n\nThe upstream PocketJS and MicroTS notice is preserved in [LICENSES/PocketJS-MIT.txt](LICENSES/PocketJS-MIT.txt). Third-party code and assets, including Cubism sources and Core, retain their independent terms and notices.\n`;
  const readmePath = join(out, "README.md");
  write(readmePath, `${readFileSync(readmePath, "utf8")}${licensingSection}`);

  const apiReference = `## API Reference\n\nStart with the [Pocket API overview](docs/API.md), then use its navigation for [JavaScript / TypeScript](docs/JS_API.md), [Tooling](docs/TOOLING_API.md), [Flutter API](docs/FLUTTER_API.md), [Hybrid Host API](docs/HYBRID_HOST_API.md), and [Hybrid Flutter Tab Host](docs/HYBRID_FLUTTER_TAB_HOST.md). The Flutter references describe integrating the source Pocket SDK into a Flutter app; this standalone Web package does not contain the Flutter/Dart runtime or native Flutter plugins. Source-only references link to the exact exported source commit.\n\n`;
  const initialReadmePath = join(out, "README.md");
  const initialReadme = readFileSync(initialReadmePath, "utf8");
  write(initialReadmePath, initialReadme.replace("## AI development: required reading\n\n", `${apiReference}## AI development: required reading\n\n`));

  const generatedReadmePath = join(out, "README.md");
  const generatedReadme = readFileSync(generatedReadmePath, "utf8");
  const navigationMarker = "| 7 | [WEB_SDK_EXPORT.md](docs/WEB_SDK_EXPORT.md) | Web SDK provenance, retained implementation, required adaptations, ablation, and runtime evidence. |\n";
  const renderWorkerRow = existsSync(join(out, "docs/WEB_RENDER_WORKER.md"))
    ? "| 7d | [WEB_RENDER_WORKER.md](docs/WEB_RENDER_WORKER.md) | Explicit render Worker opt-in, OffscreenCanvas, main-thread boundaries, and A/B verification. |\n"
    : "";
  const live2dRow = existsSync(join(out, "docs/WEB_LIVE2D.md"))
    ? "| 7e | [WEB_LIVE2D.md](docs/WEB_LIVE2D.md) | Web Live2D Moc allowlist, Cubism Core inputs, and export boundaries. |\n"
    : "";
  if (generatedReadme.includes(navigationMarker) && !generatedReadme.includes("docs/GAME_INPUT_IMPLEMENTATION.md")) {
    write(generatedReadmePath, generatedReadme.replace(navigationMarker, navigationMarker +
      "| 7a | [GAME_INPUT_IMPLEMENTATION.md](docs/GAME_INPUT_IMPLEMENTATION.md) | Opt-in keyboard, buttons, dual-stick controls, and merged input sources. |\n" +
      "| 7b | [WEB_WORKER_IMPLEMENTATION.md](docs/WEB_WORKER_IMPLEMENTATION.md) | Independent Worker QJBC, HTTP, channels, backpressure, and lifecycle. |\n" +
      "| 7c | [LARGE_IMAGE_IMPLEMENTATION.md](docs/LARGE_IMAGE_IMPLEMENTATION.md) | Large-image preprocessing, packaging, and runtime verification boundaries. |\n" +
      renderWorkerRow + live2dRow));
  }

  if (platform) {
    const readmePath = join(out, "README.md");
    const readme = readFileSync(readmePath, "utf8");
    write(readmePath, readme.replace("# Pocket Web SDK\n", `# Pocket Web SDK (${platform})\n\nThis package targets ${platform} and includes only the matching prebuilt native tool package. Install it on the matching operating system and CPU architecture.\n`));
  }
  write(join(out, "provenance.json"), `${JSON.stringify({
    sourceRepository: "PocketFlutter/Pocket",
    sourceCommit,
    pinnedPocketJsRevision: PINNED_REVISION,
    runtime: "QuickJS QJBC + PAK + PocketJS WebAssembly + Canvas2D",
  }, null, 2)}\n`);
  write(join(out, "AGENTS.md"), `# Pocket Web SDK — AI Agent Development Rules

## Creating, Syncing, and Verifying Guest Projects

- Always scaffold new standalone JS / Web / Studio projects with:
  \`\`\`sh
  npm run create -- /path/to/new-app --template=app --name="My App"
  \`\`\`
- Always synchronize framework-first AI agent rules into existing external projects with:
  \`\`\`sh
  npm run sync:agents -- /path/to/existing-project
  \`\`\`
- Always verify TypeScript types and framework conventions with:
  \`\`\`sh
  npm run check -- /path/to/project
  \`\`\`

## Guest App & Page Construction (Framework-First)

- Construct all navigation, shells, scrolling, IME inputs, and controls using Pocket's built-in framework primitives first:
  - Routing & app shell: \`@pocket/ui\` \`createPocketRouter\` + \`PocketAppShell\` (or retained \`RouteView\` + \`PocketRouteScope\` + \`createPocketBackNavigation\`), and \`usePocketBackHandler\`.
  - Scaffolds & bars: \`SkinScaffold\` / \`SafeAreaScaffold\`, \`SkinAppBar\` / \`MobileAppBar\`, \`SkinBackButton\` / \`MobileBackButton\`, \`SkinNavigationBar\` / \`NavigationBar\`.
  - Scrolling, inputs & controls: \`ScrollablePage\`, \`PocketVirtualList\`, \`InputField\` / \`SkinInput\`, \`SkinParagraph\`, \`Skin*\` / \`Mobile*\` / \`Shadcn*\` components, \`UiSkinProvider\` (with \`defineUiSkin\` / \`registerUiSkin\` or official \`@pocket/liquid_glass\`, \`@pocket/arc\`, \`@pocket/looseleaf\` skins), or \`@pocket/vn\` (\`createNovelEngine\` + \`NovelView\`) for visual novels.
  - Customize skin adapters, theme tokens, or low-level \`View\` / \`Text\` / \`Focusable\` styles only where built-in components do not satisfy specific visual needs.
- Never hand-roll \`<Show>\` page routers (which destroy inactive page state, scroll offsets, and IME sessions), HTML/DOM tags (\`<div>\`, \`<button>\`, \`<input>\`), browser globals (\`window\`, \`document\`, \`localStorage\`), fake \`<View>\` text inputs, or non-translation transforms (\`scale\` / \`rotate\`) on \`<View>\` ancestors containing \`<Text>\`.
`);
}

function codeEagleEnvironment(): NodeJS.ProcessEnv {
  const token = run(["gh", "auth", "token", "--user", "CodeEagle"], REPOSITORY_ROOT).trim();
  if (!token) throw new Error("CodeEagle GitHub token is unavailable; run `gh auth login` for CodeEagle");
  return { ...process.env, GH_TOKEN: token };
}

function publish(out: string, repo: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`invalid GitHub repository: ${repo}`);
  const ssh = `git@github.com:${repo}.git`;
  if (!existsSync(join(out, ".git"))) run(["git", "init", "-b", "main"], out, process.env, true);
  run(["git", "config", "user.name", "CodeEagle"], out);
  run(["git", "config", "user.email", "stasura@hotmail.com"], out);
  run(["git", "add", "-A"], out);
  const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: out, stdio: "ignore" });
  if (staged.status === 1) run(["git", "commit", "-m", "release: standalone Pocket Web SDK with Editor"], out, process.env, true);
  else if (staged.status !== 0) throw new Error("git diff --cached failed");

  const ghEnv = codeEagleEnvironment();
  const view = spawnSync("gh", ["repo", "view", repo], { cwd: out, env: ghEnv, stdio: "ignore" });
  if (view.status !== 0) run(["gh", "repo", "create", repo, "--public", "--description", "Standalone PocketJS Web SDK and Editor; no Flutter required"], out, ghEnv, true);
  const remotes = run(["git", "remote"], out).split(/\s+/).filter(Boolean);
  if (remotes.includes("origin")) run(["git", "remote", "set-url", "origin", ssh], out);
  else run(["git", "remote", "add", "origin", ssh], out);
  run(["git", "push", "--set-upstream", "origin", "main"], out, process.env, true);
  console.log(`export_web_sdk: published ${ssh}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) usage();
  const known = new Set(["--publish", "--force", "--help", "--out", "--repo", "--platform"]);
  for (const arg of args) {
    if (arg.startsWith("--out=") || arg.startsWith("--repo=") || arg.startsWith("--platform=")) continue;
    if (arg.startsWith("--") && !known.has(arg)) throw new Error(`unknown option: ${arg}`);
  }
  const options: Options = {
    out: resolve(option(args, "out", DEFAULT_OUT)),
    repo: option(args, "repo", DEFAULT_REPO),
    publish: args.includes("--publish"),
    force: args.includes("--force"),
    platform: platformOption(args),
  };
  if ([REPOSITORY_ROOT, SDK_ROOT, resolve(REPOSITORY_ROOT, "demo"), resolve(REPOSITORY_ROOT, "studio")].includes(options.out)) throw new Error("refusing to export over a source directory");
  clearOutput(options.out, options.force);
  const sourceCommit = run(["git", "rev-parse", "HEAD"], REPOSITORY_ROOT).trim();
  copySources(options.out, sourceCommit);
  writeRepositoryFiles(options.out, sourceCommit, options.platform);
  if (options.publish) publish(options.out, options.repo);
  console.log(`export_web_sdk: generated ${options.out}`);
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    console.error(`export_web_sdk: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
