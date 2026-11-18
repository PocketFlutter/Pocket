# Pocket SDK

This directory is the entry point for integrating the SDK. It contains the public Flutter package, the JS UI library, the QuickJS and PocketJS runtime, the bytecode toolchain, hardware and services packages, the Editor, and the CLI. Showcase lives in the sibling `../demo`.

Start with the [API reference](docs/API.md).

The standalone Web SDK and Studio support [one-command installation](docs/INSTALL_STUDIO.md) with Node.js and npm. Subsequent tool upgrades require no Git checkout.

The public Flutter package is `pocket_sdk`, defined by this directory's `pubspec.yaml` and `lib/pocket_sdk.dart`. Lower-level implementations live in `packages/`. The CLI is [`pocket.ts`](pocket.ts).

The visual novel engine lives in `packages/pocket_vn`. JS owns story flow, menus, save policy, and autoplay. The Editor edits the same script, story links, variable declarations, assets, voice bindings, player input, and translation catalogs. It also backs up and restores whole projects. It uses the same `buildGuest` bytecode pipeline. See the Demo's The Last Letter of Mist Harbor for a complete example.

- [Engine](docs/VISUAL_NOVEL_ENGINE.md), [Editor](docs/VISUAL_NOVEL_EDITOR.md), [variable lifetimes](docs/VISUAL_NOVEL_VARIABLE_LIFETIMES.md), [project backups](docs/VISUAL_NOVEL_BACKUPS.md), and [drafts and editing history](docs/VISUAL_NOVEL_HISTORY.md).
- [Writing](docs/VISUAL_NOVEL_AUTHORING.md), [stage authoring](docs/VISUAL_NOVEL_STAGE_AUTHORING.md), [scene transforms](docs/VISUAL_NOVEL_SCENE_TRANSFORMS.md), [player input](docs/VISUAL_NOVEL_INPUT.md), [voice](docs/VISUAL_NOVEL_VOICE.md), [localization](docs/VISUAL_NOVEL_LOCALIZATION.md), and [platforms](docs/VISUAL_NOVEL_PLATFORMS.md).
- [Market parity gaps](docs/VISUAL_NOVEL_LETSGAL_PARITY.md) and [current goals and measurable acceptance criteria](docs/VISUAL_NOVEL_GOAL.md) for features, story, visuals, editing, platforms, and performance.

Create a standalone consumer project.

```sh
cd /Volumes/ORICO/Development/Github/pocket/sdk
npm run init -- /path/to/my-app --sdk-root "$PWD"
npm run build -- /path/to/my-app --sdk-root "$PWD" --platform=ios-sim
```

Choose either starter template. The default is `app`.

```sh
npm run init -- /path/to/my-app --template=app --sdk-root "$PWD"
npm run init -- /path/to/my-game --template=game --sdk-root "$PWD"
```

The App template is for screens, forms, and product UI. The Game template uses official `onFrame` for a starfield clicking game with drifting star cores, particle feedback on hits, and a 30-second score challenge. The templates provide distinct JS starting points and share pinned `buildGuest`, QuickJS bytecode/PAK, and the thin Flutter host. AI-assisted development with upstream net.http should configure a JS business Worker automatically. Dio uses the native plugin's separate I/O Worker isolate and retains dio.request. Heavy tasks such as game pathfinding, AI, and map generation also use business Workers, while UI and animation retain the JS frame model. The host starts business Workers from the descriptor. Network requests require explicit origin authorization. The render Worker defaults to off. See [generated files, Studio template selection, capability boundaries, and verification commands](docs/PROJECT_TEMPLATES.md).

- Enable hardware with `--hardware` and system UI or haptics with `--platform-experience`. Choose camera, Bluetooth, sensors, location, biometrics, and weather independently. System permissions use Flutter `permission_handler`. See [hardware modules](docs/HARDWARE_MODULES.md).
- Deep links default to off. Explicitly use `init ... --deep-link-scheme=pocketapp` to add the package dependency and native scheme.
- SDK publisher scripts generate TypeScript client types for registered plugins. Product developers use npm for build, Preview, and Studio.
- Dio HTTP is an independent optional package, `pocket_dio`, enabled with `init ... --dio`. Requests and response decoding run automatically in a separate I/O Worker. Configure a trusted origin allowlist. See [Dio Worker](docs/DIO_WORKER.md) and [optional plugins](docs/OPTIONAL_PLUGINS.md).

Generated Flutter projects use `PocketApp`. Existing Flutter projects can embed `PocketGuest`. JS pages import from `@pocket/ui`. The runtime loads actual QuickJS bytecode and PAK, checks signed updates before activation, and uses native plugins compiled into the host.

TFTC device control and real-time feedback use the standalone [`@pocket/tftc` JS package](packages/pocket_tftc/README.md), including Preview connections, Windows and macOS transports, field change notifications, and physical-device acceptance.

## Guides

- [Apple App Store](docs/APPLE_APP_STORE.md) covers Apple release boundaries, optional bundled code mode, and production recording exclusions. Remote loading remains the compatible default.
- [SDK integration](docs/SDK_INTEGRATION.md) covers public APIs, scaffold, updates, plugins, and iOS and Android configuration.
- [Overview](docs/OVERVIEW.md) maps SDK directories and runtime flow.
- [Framework guide](docs/FRAMEWORK_GUIDE.md) describes code ownership, capability boundaries, and sources.
- [Validation](docs/VALIDATION.md) records completed verification and platform limits.
- [Multi-app implementation](docs/MULTI_APP_IMPLEMENTATION.md) covers JS SystemUI, shared multi-app capabilities, and the thin host.
- [Recording and replay](docs/RECORDING_REPLAY.md) covers optional session recording, offline replay, export, import, and limitations.
- [Worker recording and replay](docs/WORKER_RECORDING_REPLAY_PLAN.md) covers scheduling, I/O facts, channels, and deterministic offload recording and replay.
- [PocketJS feature parity](docs/POCKETJS_FEATURE_PARITY.md) tracks integrated and pending upstream features.
- [Game input](docs/GAME_INPUT_IMPLEMENTATION.md) covers on-demand game keyboard input, external buttons, and dual sticks, including Flutter and web integration and acceptance.
- [Web Worker](docs/WEB_WORKER_IMPLEMENTATION.md) covers independent Web Worker QJBC, HTTP origin policy, and browser verification.
- [Web render Worker](docs/WEB_RENDER_WORKER.md) covers optional off-main-thread Web UI and drawing, including input and IME, packaging, diagnostics, and ablation.
- [Large images](docs/LARGE_IMAGE_IMPLEMENTATION.md) covers source art, runtime textures, existing preprocessing, and build limits.
- [Visual novel font rendering](docs/VISUAL_NOVEL_FONT_RENDERING.md) explains the relationship between font sources, PAK metrics, Flutter drawing, and IME.
- [Editor Studio](docs/EDITOR_STUDIO.md) covers project creation, template selection, and Preview.

## npm Toolchain

SDK builds require a project. For SDK 0.1.1, platform npm packages provide complete build sources, `@pocket/ui`, the compiler, bytecode tools, and the Preview probe. Routine development requires Node.js and npm. See [npm toolchain](docs/NPM_TOOLCHAIN.md).

```sh
# Run at the repository root with Node.js 22.22.2+ (Node.js 24 LTS recommended) and npm.
npm run setup
npm run build:guest -- --project-root=../demo/js --outdir=.pocket-build/npm-guest
```

`setup` installs npm-managed Bun and the prebuilt tool package for the current system, then verifies QuickJS ABI and file hashes. It requires no Rust, Python, `patch`, or C/C++ compilers, and selects binaries for the current platform. `build:guest` emits actual `app.qjbc`, `app.pak`, and bytecode metadata without Flutter. Flutter consumers can use `npm --prefix sdk run build -- /absolute/path/to/my-app`.

The local platform package is `sdk/.pocket-build/pocket-tools-darwin-arm64-0.1.1.tgz`. At the time of the 0.1.1 validation, prebuilt packages had yet to be published to the npm registry. Release CI builds Windows and Linux packages. Missing packages and ABI or hash mismatches produce explicit errors. SDK publishers use `npm run setup:source`, `npm run build:probe:source`, and `npm run package:tools` with a complete Rust/Python/C toolchain.

The 0.1.1 validation hid Rust, Python, patch, C/C++, and global Bun. npm setup, App/Game QJBC/PAK, and Native Preview passed on macOS arm64. Windows/Linux CI and registry publication were pending. Default Inter lacks Chinese glyphs, so Guest Web screenshots may show boxes for Chinese while Studio DOM text renders normally. Flutter devices and simulators require the consumer's Flutter and platform SDKs. The validation did not run a phone.

The final local export was `sdk/.pocket-build/pocket-web-sdk-tools-0.1.1.tgz`. Noble uses prebuilt macOS arm64 N-API, and `npm install --ignore-scripts` performs no native compilation. Validation discovered BLE devices without reconnecting DK-META2. Linux BLE was explicitly `unsupported` at this stage and had no generated, published, or validated Linux HCI prebuilt package or new loader. Users are not prompted to install Rust or other toolchains. The 0.1.0 logs are historical evidence.

Run `npm run setup` at the repository root, then `npm start` to start or restart the Chinese-language Studio at `http://127.0.0.1:8791`. Use `npm run status` to check it and `npm stop` to stop it. Windows, macOS, and Linux share the Node.js launcher. See [Editor Studio](docs/EDITOR_STUDIO.md).
