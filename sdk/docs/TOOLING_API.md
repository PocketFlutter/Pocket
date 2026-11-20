# Pocket CLI and toolchain reference

This reference covers repository npm scripts, `pocket.ts`, the Studio service, and release helpers. Definitions come from the root and SDK `package.json` files, script parsers and usage, and toolchain docs. Internal tests, benchmarks, and generated outputs are outside the consumer API.

## Entry points and prerequisites

Install standalone Web SDK and Studio with the [one-click installer](INSTALL_STUDIO.md). `node install_studio.mjs` accepts `--version=MAJOR.MINOR.PATCH`, `--dir=PATH`, `--project-root=PATH`, `--no-start`, and `--help`. By default it picks the latest stable platform release and installs to `~/.pocket/studio`. It requires Node.js ≥22.22.2 and npm. Git, Flutter, Python, and Rust are unnecessary. Existing managed installs are checked and launched. Their Studio updater handles later upgrades.

| Entry point | Use | Requirements |
| --- | --- | --- |
| Repository root `npm run ...` | Install/check tools, start Studio, build Guest and Web, and package tools. | Node.js **22.22.2+** and npm. Guest builds use npm-managed Bun and prebuilt tools for the current OS and CPU. |
| `npm --prefix sdk run ...` | Runs the SDK scripts from `sdk/`. | Same as above. |
| `bun sdk/pocket.ts ...` | Initializes projects, builds native hosts, generates plugin types, and runs foreground Editor. | Bun and a complete SDK checkout. Consumers normally use SDK npm scripts and project `npm run build`. |
| `node sdk/scripts/editor_service.mjs ...` | Manages background Studio start/restart/stop/status. | Node.js and installed SDK toolchain dependencies. Fixed port 8791. |

`npm run setup` uses Node and npm to install dependencies and the matching platform prebuilt tools. It verifies tool version, QuickJS ABI, and per-file SHA-256 and explicitly fails on missing or mismatched tools. Source release commands require Python 3, `patch`, Rust/Cargo **1.93+**, and local C/C++/LLVM tools. Run `npm run doctor` for the current checkout's actual package and validation status. See [NPM_TOOLCHAIN.md](NPM_TOOLCHAIN.md) and [PROVENANCE.md](PROVENANCE.md).

## Root npm scripts

The root [package.json](../../package.json) forwards common commands.

| Command | Behavior and output |
| --- | --- |
| `npm run setup` | Installs Node/npm dependencies, managed Bun, and prebuilt SDK tools for the current platform. |
| `npm run create -- DIRECTORY [options]` | Runs `node sdk/scripts/create_project.mjs` (`INIT_CWD`-aware, atomic cleanup on failure) to scaffold a standalone JS/Preview/Studio project (`--template=app\|game`, `--name`, `--id`, `--app-id`, `--version`, `--surfaces`, `--flutter`) and generates `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`), and `.pocket/tsconfig.json`. |
| `npm run sync:agents -- [DIRECTORY]` | Runs `node sdk/scripts/create_project.mjs --sync-agents` to write or update the managed `AGENTS.md` block, `@AGENTS.md` `CLAUDE.md`, `.pocket/tsconfig.json`, and managed `package.json` scripts (`check`, `typecheck`, `sync:agents`) while preserving custom notes outside the managed block. |
| `npm run check -- [DIRECTORY]` | Runs `node sdk/scripts/check_project.mjs` to refresh `.pocket/tsconfig.json`, perform project-scoped TypeScript pre-emit typechecking (`tsc`), and validate Pocket guest framework conventions. |
| `npm start` | Starts or resumes Studio with `demo/js` and Flutter root `demo` by default. URL `http://127.0.0.1:8791`. |
| `npm restart` / `npm stop` / `npm run status` | Restarts, stops, or checks the Studio service. |
| `npm run bootstrap` | Maintains source checkout bootstrap. Normal installation uses setup. |
| `npm run doctor` / `npm run build:probe` | Checks prebuilt tools and probe package. No local Rust compilation. |
| `npm run build:guest -- --project-root=DIR --outdir=DIR` | Runs pinned buildGuest and produces QuickJS bytecode and PAK. |
| `npm run build:web -- --project-root=DIR --outdir=DIR` | Builds browser runtime outputs. See flags below. |
| `npm run setup:source` / `npm run bootstrap:source` / `npm run package:tools` | Tool release workflow. |

## SDK npm scripts

See [sdk/package.json](../package.json) for the exact definitions.

| Area | `npm run` command | Behavior |
| --- | --- | --- |
| Project | `create -- DIRECTORY [options]`, `sync:agents -- [DIRECTORY]`, `check -- [DIRECTORY]`, `init -- DIRECTORY [options]`, `build -- DIRECTORY [options]` | `create` and `sync:agents` invoke `scripts/create_project.mjs`; `check` invokes `scripts/check_project.mjs` (generated projects also expose `npm run check` and `npm run typecheck` via `project_commands.mjs check\|typecheck`); `init` and `build` delegate to `pocket.ts init/build`. See [project templates](PROJECT_TEMPLATES.md). |
| JS compiler and targets | `build:guest -- [guest flags]`, `build:web -- [web flags]`, `export:web-sdk -- [export flags]`, `preview:wechat -- [target flags]` | Uses pinned Guest and QuickJS. See [Web SDK](WEB_SDK_EXPORT.md) and [WeChat host](WECHAT_HOST_IMPLEMENTATION.md) for target boundaries. |
| Studio | `editor`, `editor:start`, `editor:restart`, `editor:stop`, `editor:status` | Calls Node service start/restart/stop/status. Use `bun pocket.ts editor DIRECTORY [options]` for foreground Editor. See [Studio](EDITOR_STUDIO.md). |
| Toolchain | `setup`, `bootstrap`, `doctor`, `build:probe`, `setup:source`, `bootstrap:source`, `build:probe:source`, `build:engine:source`, `package:tools` | Prebuilt installation and validation and source release tools. See [NPM_TOOLCHAIN.md](NPM_TOOLCHAIN.md). |
| Package registry | `search -- [keyword]`, `add -- DIR PKG...`, `remove -- DIR PKG...`, `registry -- build\|sync-r2` | Search, on-demand install/remove, and static registry build/R2 sync across official SDK packages. See [Package registry](PACKAGE_REGISTRY.md). |
| Other CLI | `cos -- [cos args]`, `cf -- [cf args]`, `official-demos -- [demo args]` | COS and Cloudflare multi-account publishing and official sample builds. Credentials stay in local `0o600` vaults or env vars. |
| Architecture | `check:architecture` | Checks SDK and Showcase boundaries. |
| Test entry points | `test`, `test:demand`, `test:packages`, `test:editor`, `test:editor:live` | See manifest commands. Test results do not define the public contract. |

Run `create`, `sync:agents`, `check`, `build`, `init`, and `export:web-sdk` at the SDK root (or use `npm run create`, `npm run sync:agents`, and `npm run check` from the repository root or an exported Web SDK). Generated projects have their own `npm run check`, `npm run typecheck`, `npm run build`, `npm run build:web`, and `npm run sync:agents`. See [generated directories and commands](PROJECT_SCAFFOLD_AND_OPEN_20261114.md).

### `create_project.mjs` and `check_project.mjs`

[`scripts/create_project.mjs`](../scripts/create_project.mjs) and [`scripts/check_project.mjs`](../scripts/check_project.mjs) are standalone Node.js entry points available in both the source checkout and exported Web SDK packages.

```sh
npm run create -- /absolute/path/to/my-app --template=app --name="My App"
npm run sync:agents -- /absolute/path/to/existing-project
npm run check -- /absolute/path/to/my-app
```

- **Creation options (`npm run create -- <dir>`)**: `INIT_CWD`-aware relative path resolution, atomic target cleanup on failure, `--template=app|game` (default `app`), `--name=TITLE`, `--id=SLUG` (rejected when `--flutter` is passed), `--app-id=REVERSE_DNS`, `--version=SEMVER`, `--surfaces=MODULE_A,MODULE_B`, `--sdk-root=DIR`, and `--flutter` (delegates full Flutter companion scaffolding to `pocket.ts init` along with `--dio`, `--hardware`, `--clipboard`, `--bluetooth`, `--biometrics`, `--camera`, `--sensors`, `--location`, `--weather`, `--permissions`, `--platform-experience`, `--deep-link-scheme`, `--team-id`, `--use-xcodegen`, and `--embed-ios-extensions`).
- **Agent instruction files & `.pocket/tsconfig.json` (`npm run sync:agents -- [dir]`)**: Every newly created or synced project receives `AGENTS.md` (with a managed `<!-- pocket:framework-rules:start/end -->` block encoding the 23-slot `UiSkinProvider` + `Skin*` polymorphic skin contract, `createPocketRouter` + `PocketAppShell`, `usePocketBackHandler`, scrolling, and `SkinInput` / `InputField` rules), `CLAUDE.md` starting with `@AGENTS.md`, `.pocket/tsconfig.json` (plus `tsconfig.json` extending `./.pocket/tsconfig.json`), and `"check"`, `"typecheck"`, and `"sync:agents"` scripts in `package.json` (delegating to `project_commands.mjs check|typecheck|sync-agents`). First-layer Flutter checkouts (`pubspec.yaml` + `js/pocket.json`) automatically resolve into `js/`.
- **Managed `.pocket/tsconfig.json` generation**: Configures `target: "ES2023"`, `lib: ["ES2023"]`, `types: []` (excluding DOM types so HTML/DOM globals fail at typecheck time), explicit path mappings for all workspace `@pocket/*` exports, `solid-js`, and `@pocketjs/framework` / `@pocketjs/framework/solid/*` subpaths, and includes pinned `framework/src/jsx.d.ts` and `framework/compiler/app-globals.d.ts` via `files` (so consumer `tsconfig.json` overrides of `include` still inherit Pocket JSX and global declarations).
- **Project typechecking and convention checking (`check_project.mjs` / `npm run check` / `npm run typecheck`)**: `check_project.mjs` refreshes `.pocket/tsconfig.json`, runs project-scoped TypeScript `tsc` pre-emit diagnostics (`--typecheck-only` or `npm run typecheck`), and runs lexical guest convention inspection (`stripCommentsAndStrings` + `inspectGuestFrameworkConventionsDetailed`). By default (`editor.json#conventions` omitted or `"strict"`), HTML/DOM JSX tags (`<div>`, `<button>`, `<input>`, etc.) and browser globals (`window`, `document`, `localStorage`, `history`, `navigator`, `alert`) are blocking errors in both `npm run check` and `buildGuest`, while `<Show>`/`<Match>`/`<Dynamic>` page switching without `PocketAppShell`/`RouteView` and missing `AGENTS.md` managed blocks emit `[pocket-agent-hint]` warnings. Setting `"conventions": "warn"` (or `"off"`) in `editor.json` (or passing `--warn-only` to `check_project.mjs`) downgrades convention errors to non-blocking `[pocket-agent-hint]` warnings for legacy migrations.

## `pocket.ts` project CLI

See [pocket.ts usage and validation](../pocket.ts#L1095). Missing or invalid arguments print usage and exit with an error. Use `--name=value`.

### `init <directory>`

```sh
npm run init -- /absolute/path/to/app --sdk-root="$PWD" --template=app
```

| Option | Default and behavior |
| --- | --- |
| `--template=app\|game` | Defaults to `app`. Other values fail. |
| `--sdk-root=DIR` | SDK root. The tool can resolve a default from its own path. |
| `--app-id=ID`, `--name=NAME`, `--version=VERSION` | Set identity, display name, and initial version. |
| `--hardware` | Adds the combined hardware provider and explicit host registration. |
| `--camera`, `--bluetooth`, `--sensors`, `--location`, `--biometrics`, `--weather` | Select individual hardware modules. Require consumer permissions, native config, and actual providers. |
| `--permissions=POLICY_KEYS` | Restricts or declares permission policy keys. OS grants remain separate. |
| `--dio` | Adds optional `pocket_dio`. Requires a host origin allowlist. |
| `--platform-experience` | Adds system bar and haptic provider. |
| `--deep-link-scheme=SCHEME` | Generates an explicit custom URL scheme. Universal Links require separate integration. |
| `--surfaces=MODULES` | Adds selected external ecosystem surfaces. |

Choose an initializable destination. The scaffold creates a JS app, Pocket config and manifest, Flutter host, dependencies, and platform config according to selected modules. `pocket.json`, `manifest.json`, and host declarations are authoritative. See [SDK integration](SDK_INTEGRATION.md) and [templates](PROJECT_TEMPLATES.md).

### `surfaces [directory]`

```sh
npm --prefix sdk run init -- /path/to/app --sdk-root=/path/to/pocket/sdk
bun sdk/pocket.ts surfaces /path/to/app --add=MODULE_A,MODULE_B
bun sdk/pocket.ts surfaces /path/to/app --set=MODULE_A
bun sdk/pocket.ts surfaces --list
```

Use `--add=MODULES` to append or `--set=MODULES` to replace the selection. They are mutually exclusive. `--list` prints available/enabled modules and profiles without editing. Module names and profiles come from [ecosystem_scaffold.ts](../scripts/ecosystem_scaffold.ts). Unknown modules fail. Use `--xcodegen` to opt into a generated XcodeGen spec, `--embed-ios-extensions` to include the selected WidgetKit target, and `--run-xcodegen` to execute generation with `--xcodegen`. `--bundle-id=ID`, `--team-id=ID`, and `--deep-link-scheme=SCHEME` set native host identifiers and the custom URL scheme.

#### Native surface scaffold options

`scaffoldEcosystemModules(projectDir, selectedModules, options?)` updates the guest module selection and synchronizes a detected Flutter companion host by default. The programmatic options below are defined in [ecosystem_scaffold.ts](../scripts/ecosystem_scaffold.ts).

| Option | Default and effect |
| --- | --- |
| `mode` | Defaults to `"set"`. Use `"add"` to merge modules. |
| `appTitle` | Overrides the inferred display title used for generated templates. |
| `wireEntry` | Defaults to `true` for the supported guest mount shape. |
| `bundleId`, `teamId`, `deepLinkScheme` | Override the inferred host identity and link scheme. The App Group is derived as `group.<bundleId>`. |
| `syncNative` | Defaults to `true` when a Flutter host is detected and the selection, descriptor, or XcodeGen request triggers synchronization. Set `false` to skip native project synchronization. |
| `useXcodeGen` | Set `true` to create `ios/project.yml` and `ios/generate-xcodeproj.sh`. The scaffold preserves an existing consumer spec and script. |
| `embedIosExtensions` | Set `true` to include the selected WidgetKit extension and App Group entitlements in the XcodeGen spec. The environment setting `POCKET_EMBED_IOS_EXTENSIONS=1` also enables embedding. |
| `runXcodeGen` | Set `true` with `useXcodeGen` to attempt generation from a scaffold-owned spec. The result reports whether the command succeeded. |

The result includes the selected modules, enabled profile IDs, created and updated files, and whether the guest entry was wired. It can also include the detected Flutter root, bundle ID, App Group ID, and XcodeGen status. The native scaffolder emits Swift sources for selected Apple widget and activity modules, Android AppWidget provider sources and resources for `android-widgets`, and relevant host configuration. Native generated files are updated only while their content matches the `.pocket-native-surfaces.json` ownership record. Keep that record with the generated consumer project so later runs can identify unchanged scaffold-owned files. Existing consumer changes are preserved. Custom iOS scene delegates require manual URL forwarding. Review signing, permissions, and deployment requirements against the generated project. [Native surface bridge](OPTIONAL_PLUGINS.md#native-surface-bridge)

### `build <directory>`

```sh
npm run build -- /path/to/app --sdk-root=/path/to/pocket/sdk --platform=ios-sim
```

| Option | Behavior |
| --- | --- |
| `--sdk-root=DIR` | Source SDK root. |
| `--out=DIR` | Build output directory. |
| `--platform=ios-sim\|ios\|macos\|android` | Accepts those four values. See release and configuration docs for native requirements. |

Build uses the pinned Guest and QuickJS bytecode compilers. Invalid QJBC, PAK, or manifest fails.

### `types <descriptor.json> --out=plugin-types.ts`

### `search` / `packages` / `add` / `remove` / `registry`

```sh
bun sdk/pocket.ts search [keyword] [--registry=DIR_OR_URL]
bun sdk/pocket.ts packages [<directory>]
bun sdk/pocket.ts add <directory> <package...> [--registry=DIR_OR_URL] [--public-key=FILE]
bun sdk/pocket.ts remove <directory> <package...>
bun sdk/pocket.ts registry build [--out=DIR] [--key-file=FILE] [--r2-base-url=URL] [--github-base-url=URL]
bun sdk/pocket.ts registry sync-r2 --registry-dir=DIR --account-id=HEX32 --bucket=NAME [--profile=ID] [--workspace=DIR] [--public-base-url=URL] [--zone-id=HEX32] [--dry-run]
```

按需解析并安装官方 27 包（支持 Cloudflare R2 镜像优先与 GitHub 静态源自动回退、SHA-256 校验、`pocket-lock.json` 锁定与 `flutter/lib/pocket_plugins.g.dart` 无侵入自动装配）。完整说明见 [PACKAGE_REGISTRY.md](PACKAGE_REGISTRY.md)。

### `types <descriptor.json> --out=plugin-types.ts`

```sh
bun sdk/pocket.ts types plugins.json --out=plugin-types.ts
```

Reads actual `PocketPluginDescriptor` and host capability descriptors and generates TypeScript client types for registered capabilities only. Legacy capability types without schemas remain `unknown`. Input size is limited to 256 KiB. Install native plugins separately. See the [plugin type contract](PLUGIN_TYPES.md) and [plugin_types.ts](../scripts/plugin_types.ts#L598).

### `editor [--pocket|--web] [<directory>]`

```sh
bun sdk/pocket.ts editor /path/to/app --port=8795 --workspace=/path/to/workspace
bun sdk/pocket.ts editor --web /path/to/app --port=8791 --workspace=/path/to/workspace
```

On macOS with `studio/` (`../studio/pubspec.yaml`), defaults to desktop Pocket Studio via `flutter run -d macos` or `<repoRoot>/.fvm/flutter_sdk/bin/flutter`, port `8795`, and current directory when omitted. Selects Web Studio or the local service for `--web`, `POCKET_EDITOR_UI=web`, a standalone Web SDK without `studio/`, non-macOS, or service-only flags `--flutter-root`, `--update-host`, `--update-port`, `--update-host-version`, `--extra-project-root`, and `--provision-update-key`.

| Option or environment | Behavior |
| --- | --- |
| `--pocket` / `--web` | Selects desktop Pocket Studio or Web Studio/service. Mutually exclusive. |
| `POCKET_EDITOR_UI=pocket\|web` | Sets default mode. |
| `--port=N` | Desktop defaults to `8795`. Web and `editor_service.mjs` daemon default to fixed `8791`. |
| `--workspace=DIR` | Workspace root. |
| `--flutter-root=DIR` | Consumer Flutter root, Web/service only. |
| `--update-host=LAN_IP`, `--update-port=N`, `--update-host-version=VERSION` | LAN device update and preview broadcast address, port, and host version, Web/service only. |
| `--extra-project-root=DIR` | Adds an allowed root. Repeatable, Web/service only. |
| `--provision-update-key` | Generates and configures a local development update signing key, Web/service only. |

This CLI runs foreground Editor. `npm start` uses the `editor_service.mjs` manager for daemon, state, logs, and port ownership on 8791. See [EDITOR_STUDIO.md](EDITOR_STUDIO.md), [STUDIO_PROVIDER.md](STUDIO_PROVIDER.md), and [Editor project identity and configuration](EDITOR_PROJECT_CONFIGURATION.md).

During a Windows SDK upgrade, the service manager checks process creation time and command or executable identity before signaling the old Studio processes. If ownership or identity cannot be confirmed, the upgrade reports a retirement failure. See [Studio upgrades](STUDIO_UPGRADE.md).

## Guest and Web build options and outputs

### `build:guest`

```sh
npm run build:guest -- --project-root=/path/to/project --outdir=/path/to/build
```

Required: `--project-root=DIR` and `--outdir=DIR`. Optional: `--entry=FILE`, `--tick-hz=N`, `--density=1..4`, `--bake-fonts`/`--no-bake-fonts`, `--copy-assets-to=DIR`, and `--keep-source=FILE`. The root includes project config, manifest, and entry. The pinned platform tools supply QuickJS and PAK compilers. Standard outputs include `app.qjbc`, `app.bytecode.json`, `app.pak`, and `guest-manifest.json`. Application Workers add Worker QJBC, metadata, and admission descriptor. Flutter SDK is unnecessary.

### `build:web`

```sh
npm run build:web -- --project-root=/path/to/project --outdir=/path/to/web
```

Required: `--project-root` and `--outdir`. Optional: `--entry`, `--tick-hz`, `--density`, `--engine`, `--runtime`, `--live2d-core`, repeatable `--worker-http-origin=https://origin.example`, and `--render-worker`/`--no-render-worker`. Rendering defaults to the main thread. Render Worker requires a packaged Worker asset and browser `OffscreenCanvas` and CSP support. Live2D projects require a licensed local Cubism Core file via `--live2d-core` or `POCKET_CUBISM_WEB_CORE`. Outputs include `engine/pocketjs.wasm`, browser runtime, QJBC, PAK, config, types, and build metadata. See [Web SDK export](WEB_SDK_EXPORT.md).

### Other build and release scripts

| Command | Behavior |
| --- | --- |
| `export:web-sdk` | Exports a standalone Web SDK source tree. Use `--registry-packages` to bundle the workspace's published package versions. See [Web SDK export](WEB_SDK_EXPORT.md). |
| `release:packages` (repository root) | Plans npm workspace releases against GitHub Packages. See [package release operations](GITHUB_PACKAGES.md#release-from-the-sdk-workspace). |
| `preview:wechat` | Uses the retained WeChat host/preview pipeline. See [WeChat host](WECHAT_HOST_IMPLEMENTATION.md). |
| `build:probe` | Verifies installed prebuilt `pocket_probe`. |
| `build:probe:source` | Builds native preview probe from source and requires the publisher toolchain. |
| `build:engine:source` | Builds the Web engine from pinned native source. Ordinary development uses setup. |
| `package:tools` | Packages verified native and compiler tools and generates checksums. |
| `official-demos` | Compiles and benchmarks pinned samples. See [official_demos.ts](../scripts/official_demos.ts#L142) for flags. |

## Publisher update package CLI

Run `scripts/package_update.ts` with SDK-managed Bun. It has no same-name npm script. See [package_update.ts usage](../scripts/package_update.ts#L2771).

```sh
bun scripts/package_update.ts package --app-id ID --version VERSION --build N \
  --js app.js --pak app.pak --out DIR --key-file /secure/path/private-key.pem
bun scripts/package_update.ts patch --base-dir DIR --out DIR \
  --version VERSION --build N --key-file /secure/path/private-key.pem
bun scripts/package_update.ts generate-dev-key --out /secure/path/key.pem
```

`package` requires `--app-id`, `--version`, `--build`, `--pak`, and `--key-file`. Select one of `--js` and `--bytecode`, and one of `--out` and `--deploy-root`. `--deploy-root` also needs `--host-version` and accepts `--route-version`. For QJBC use matching `--entry-format quickjs-bytecode`, `--bytecode`, and `--runtime-abi`. `patch` requires `--base-dir`, version, build, signing key, and JS or bytecode entry. It supports `--pak-entry KEY=FILE`, `--asset NAME=FILE`, and `--remove-asset NAME`. See [AI app development](AI_APP_DEVELOPMENT.md), [package update modes](PACKAGE_UPDATE_MODES.md), and [release trust policy](RELEASE_TRUST_POLICY.md).

Provide private keys through a secure local file. Keep keys, COS secrets, API tokens, and actual CSRF values out of manifests, examples, and docs. `generate-dev-key` refuses to overwrite an existing key unless given `--force`.

## COS CLI

`npm run cos -- [inspect|check|publish] [options]` defaults to `inspect`. See [packages/pocket_cos/src/cli.ts](../packages/pocket_cos/src/cli.ts).

| Command | Options and result |
| --- | --- |
| `inspect [--workspace-keys-dir DIR] [--json]` | Shows redacted local COS configuration availability and bucket discovery. |
| `check --bucket BUCKET --region REGION [--prefix PREFIX] [--endpoint URL] [--public-base-url URL]` | Checks target access and reports status. Bucket and region can come from local config. |
| `publish (--deploy-root DIR \| --dir DIR) [target options] [--key-file FILE \| --public-key-file FILE] [--dry-run]` | Uploads a verified SDK release/package or Studio version. Supply one directory form. |

Target options also include `--bucket`, `--region`, `--prefix`, `--endpoint`, and `--public-base-url`. Tests can opt into `--allow-insecure-http`. `--json` and `--dry-run` are booleans. Credentials resolve from secure local config. See [COS publishing](COS_PUBLISH.md).

## Cloudflare CLI

`npm run cf -- [inspect|profile-set|profile-remove|check|publish|publish-installers|deploy-web|endpoints] [options]` defaults to `inspect`. See [packages/pocket_cloudflare/src/cli.ts](../packages/pocket_cloudflare/src/cli.ts) and [Cloudflare publishing](CLOUDFLARE_PUBLISH.md).

## Current Editor HTTP API

Studio routes are defined in [editor/server.ts](../editor/server.ts#L4285) and Preview transport in [editor/preview.ts](../editor/preview.ts#L5727). These local interfaces serve Studio UI. Consumers normally use CLI or UI, and cross-version HTTP compatibility is outside the public app API.

| HTTP | Current use |
| --- | --- |
| `GET /health` | Local health and runtime fields. Keep response CSRF values private. |
| `GET /api/examples/lantern` and `POST /api/examples/lantern` | Loopback-only example status and installation. GET reports missing Core/model inputs and license URLs without installing anything. POST uses the normal CSRF check and requires `acceptCubismTerms: true`; supply an absolute `cubismSdkDirectory` if the pinned sample is missing. Returns the new project with HTTP 201. Installation fails on missing, invalid, or unverified inputs. |
| `POST /api/projects/pick-directory` | Loopback-only macOS/Windows folder picker. Returns `{path: string \| null}` with null on cancel, times out after 120 seconds, and allows one picker at a time. Use localhost on the Studio machine. |
| `GET /api/projects`, `POST /api/projects`, `POST /api/projects/open` | List, create, and open local projects. List entries include `canRemove`. External absolute paths require a loopback peer. |
| `DELETE /api/projects/:id` | Loopback-only list removal. Returns `{removed: true, id, removedIds: string[]}`. A missing project returns 404. A protected project or conflicting operation returns 409. Source directories and published release files are preserved. Open the same directory to restore the entry. |
| `GET /api/preview/device`, `GET /api/preview/profiles`, `GET /api/ecosystem/modules` | Device presets, profiles, and ecosystem registries. |
| `GET /api/packages/catalog`, `GET\|POST /api/projects/:id/packages` | Official package registry catalog, project lockfile state, and on-demand package install (`add`) or removal (`remove`). |
| `GET\|PUT /api/projects/:id/cloudflare`, `POST .../cloudflare/check`, `POST .../cloudflare/publish` | Redacted multi-account Cloudflare credential vault, platform route matrix persistence, R2 connectivity check, and two-phase signed OTA publish. |
| `POST /api/projects/:id/build` or `/compile` | Compiles the project. Read status, logs, and files through `/status`, `/logs`, and `/artifacts/*`. |
| `GET /api/projects/:id/preview/status`, `snapshot`, `stream`. `POST /api/projects/:id/preview/input` | Preview state, snapshot, SSE frames, and input. `GET /media` and `GET /resource` read restricted resources. |
| `GET\|HEAD /updates/*`, `/pocket/*`, `/test/pocket/*`, `/stable/pocket/*`. `GET /releases/*` | Studio published and update artifacts. Other remote hosting requires a suitable server. |

An opted-in project can load a machine-local Preview adapter from the Studio workspace. Its `GET /api/projects/<id>/preview/status` response includes `hostConfig` with the values `disabled`, `ready`, and `invalid`. Preview routes and project mutations for configured projects require loopback access. See [Project-local Preview host adapter](EDITOR_PROJECT_CONFIGURATION.md#project-local-preview-host-adapter) for the opt-in, private profile schema, and startup precedence.

Editor routes enforce loopback/LAN, Origin, CSRF, and request validation. Keep this service local and retain private tokens, keys, and credentials. Linked source defines full behavior. Stabilizing the service API would require an explicit version and compatibility commitment.

## Versioning and documentation maintenance

Consumer setup uses Node/npm and matching prebuilt packages. Source release tools also require Python, Rust, and C/C++. npm workspace, Dart package, and native archive versions come from their own manifests, locks, and releases. See [SDK package](../package.json), [sdk/package.json](../package.json), and [toolchain.mjs](../scripts/toolchain.mjs).

Update this page, affected guides, and release notes when changing flags, defaults, dependencies, outputs, endpoints, or supported targets. See [API.md](API.md#maintenance-contract) for the export baseline and maintenance contract. Run:

```sh
python3 sdk/scripts/check_api_docs.py
```
