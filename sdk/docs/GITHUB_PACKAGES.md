# Pocket SDK npm packages

Pocket publishes individual TypeScript packages under `@pocketflutter` on
[GitHub Packages](https://github.com/orgs/PocketFlutter/packages). The source
lives in the SDK workspace. GitHub Releases distributes the complete Web SDK,
Studio, and the pinned PocketJS compiler and platform tools.

| Registry package | Consumer use |
| --- | --- |
| `@pocketflutter/diagnostics` | Portable diagnostics and Bun file journals |
| `@pocketflutter/ui` | Pocket Guest UI and portable utilities |
| `@pocketflutter/arc` | Arc Guest skin |
| `@pocketflutter/liquid_glass` | Liquid Glass Guest skin |
| `@pocketflutter/looseleaf` | Looseleaf Guest skin |
| `@pocketflutter/sync` | Sync protocol, client, server controller, and Solid adapter |
| `@pocketflutter/spine` | Spine core adapter, with the upstream Spine runtime installed as a separate npm dependency |
| `@pocketflutter/cos` | COS client, release publishing helpers, and Bun CLI module |
| `@pocketflutter/vn` | Visual novel engine, Guest views, and Spine adapter |
| `@pocketflutter/live2d` | Pocket's model manifest, motion, interaction, and host transport APIs |

## Install a package

Set the registry scope in the consumer project's `.npmrc`.

```ini
@pocketflutter:registry=https://npm.pkg.github.com
```

Authenticate with an account token that has `read:packages`. GitHub Packages
requires authentication for public npm packages. Workflows can also use a
`GITHUB_TOKEN` where the repository has package access.

```sh
npm login --scope=@pocketflutter --registry=https://npm.pkg.github.com --auth-type=legacy
npm install --save-exact @pocketflutter/diagnostics@0.1.0
```

Bun and TypeScript-aware tooling can use the published TypeScript entry points.
See the [diagnostics guide](DIAGNOSTICS_PACKAGE.md) for a runnable example.

## Use registry packages in a Pocket Guest

Use npm aliases so the existing PocketJS compiler recognizes the same Guest
package names and compiles them with the SDK's pinned framework. Add each Guest
package you import as a dependency, using the same alias convention.

```sh
npm install --save-exact '@pocket/ui@npm:@pocketflutter/ui@latest' '@pocket/arc@npm:@pocketflutter/arc@latest'
```

```tsx
import { Button } from "@pocket/arc";
```

Run the install command from the Guest project directory. npm resolves
`latest` at install time and `--save-exact` records the resolved version in
`package.json` and `package-lock.json`. Commit both files. Run the same
command again when you want the project to pick up newer published versions.
Update packages used together in one install so their Pocket UI dependencies
stay aligned. If the project deliberately vendors a customized package in
`vendor/pocket-<name>`, the compiler continues using that copy. Move it aside
when switching that package to the registry.

Rebuild with `npm run build:web` in the scaffolded project, or open the project
in Studio and run Preview again. The new package code is compiled into the
Guest bytecode. Host-bound features require their documented host providers
and a compatible Web SDK. Dart/Flutter packages follow the
[Flutter integration](FLUTTER_API.md).

The registry VN package works without Live2D and keeps the `modelFactory`
extension point on `NovelView`. Its `./spine` export uses the published Spine
adapter. The registry Live2D package exports `./manifest`, `./motion`,
`./interaction`, and `./transport`. The source SDK's licensed integration
provides VN's `./live2d` adapter and Live2D's `./physics` and `./pose`.
To open the optional Lantern example, use the
[Studio example installer](EDITOR_STUDIO.md#optional-lantern-example).

## Release from the SDK workspace

Run the release script from the repository root with registry read access.

```sh
npm run release:packages
npm run release:packages -- --apply
```

The first command prints a plan. The second applies patch bumps and updates
the exact workspace dependency pins and the affected lockfiles. Review and
commit the resulting changes with the package source. For a minor or major
release, set the intended package version in its workspace manifest before
running the script.

The script compares the staged package contents with the published version.
Tests and source excluded from the tarball do not trigger a package release.
A package is also bumped if it needs a new exact version of a published
dependency. Existing published versions are immutable.

**Publish SDK Packages** runs on relevant pushes to `main` and supports
manual retries on `main`. It publishes pending versions in dependency order
and exercises a clean install from GitHub Packages. If a staged package has
changed at an already published version, apply the plan and commit the bump
before retrying. When adding a brand-new package, review its visibility in
GitHub Packages after the first publish.

The staging script copies the existing source, manifest exports, and licenses.
Cross-package dependencies use npm aliases so Guest imports and the pinned
build pipeline continue to work. The COS tarball also includes the existing
update implementation from `scripts/package_update.ts`. Its Studio release
record types derive from `editor/version_store.ts`, so COS can run independently
from the editor without adding a second implementation.

## Provenance and validation

The retained parent demo's `web_wasm_preview/index.html` simulates the browser
boundary. This integration reuses the SDK's pinned compiler and the existing
WebAssembly host that mounts real QJBC and PAK artifacts. The registry
supplies the TypeScript source for the same pipeline. The parent demo has no
standalone SDK npm release workflow.

A clean consumer install from GitHub Packages exercised all ten package
exports and their runtime smoke tests. A separate scaffolded Web project
installed the UI alias via `latest`. The locally installed Web SDK 0.1.26
compiled it to QJBC and PAK, and Chromium loaded the real WebAssembly host.
Clicking the theme button changed the canvas pixels without a browser error.

The release plan found all ten published `0.1.0` payloads current. A fixture
changed the UI package and selected versions explicitly for other packages.
The plan updated dependent packages and lockfile pins, and a second run
required no additional edits. The fixture also repacked the original package
contents with a different gzip level to verify that compression alone does
not cause a version bump.

On macOS arm64, a platform archive built from the ten registry tarballs
passed clean `setup` and `doctor` without a package token. Both templates
built real QJBC/PAK and changed their native Preview frames after input. A
separate fixture port exercised Studio start, health, status, and stop.
