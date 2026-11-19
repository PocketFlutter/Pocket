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
npm install --save-exact '@pocket/ui@npm:@pocketflutter/ui@0.1.0' '@pocket/arc@npm:@pocketflutter/arc@0.1.0'
```

```tsx
import { Button } from "@pocket/arc";
```

Build and run with the [Pocket SDK toolchain](TOOLING_API.md). Host-bound
features require their documented host providers. Dart/Flutter packages follow
the [Flutter integration](FLUTTER_API.md).

The registry VN package works without Live2D and keeps the `modelFactory`
extension point on `NovelView`. Its `./spine` export uses the published Spine
adapter. The registry Live2D package exports `./manifest`, `./motion`,
`./interaction`, and `./transport`. The source SDK's licensed integration
provides VN's `./live2d` adapter and Live2D's `./physics` and `./pose`.
To open the optional Lantern example, use the
[Studio example installer](EDITOR_STUDIO.md#optional-lantern-example).

## Release from the SDK workspace

The manual **Publish SDK Packages** workflow packs the SDK source from
`main`, checks package integrity, publishes dependency packages first, and
installs the artifacts into an independent consumer. The registry packages keep
the workspace versions. Bump the workspace version before publishing modified
contents. GitHub creates new packages with private visibility. Release
maintainers can make each package public in its package settings after the
consumer test passes.

The staging script copies the existing source, manifest exports, and licenses.
Cross-package dependencies use npm aliases so Guest imports and the pinned
build pipeline continue to work. The COS tarball also includes the existing
update implementation from `scripts/package_update.ts`. Its Studio release
record types derive from `editor/version_store.ts`, so COS can run independently
from the editor without adding a second implementation.
