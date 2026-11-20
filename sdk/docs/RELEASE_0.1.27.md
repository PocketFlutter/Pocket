# Pocket Web SDK 0.1.27

## Added

- Cloudflare R2 publishing supports account and platform routing, stable and test channels, and signed native installer manifests. Studio exposes per-project configuration and local publishing controls (`2b74610`, `a21d691`). [Cloudflare publishing](CLOUDFLARE_PUBLISH.md) · [Tooling API](TOOLING_API.md)
- The package CLI and Studio can search a 28-package static catalog and install optional packages from a local registry or a signed HTTPS registry. The Web SDK archive includes the consumer package commands (`2b74610`, `a21d691`). [Package registry](PACKAGE_REGISTRY.md) · [Web SDK export](WEB_SDK_EXPORT.md)

## Changed

- Web SDK release archives assemble optional packages from pinned GitHub Packages versions. Studio supports an optional VN example and requests consent before installing missing packages (`ad29022`, `77e02bb`, `810f7ca`, `621b615`). [Web SDK export](WEB_SDK_EXPORT.md) · [Studio](EDITOR_STUDIO.md)
- Companion skins and Showcase navigation share the Pocket UI lifecycle and transition primitives (`ee96ed7`, `621b615`). [Framework guide](FRAMEWORK_GUIDE.md)

## Fixed

- Cloudflare release history includes verified artifacts for each target and keeps a reused package's owner index intact. Test publishing preserves the stable Flutter endpoint asset (`a21d691`). [Cloudflare publishing](CLOUDFLARE_PUBLISH.md) · [Integration notes](CLOUDFLARE_REGISTRY_INTEGRATION.md)
- Package mutations serialize per project, verify cached archives, recover interrupted writes, and preserve customized vendor copies. Registry archive URLs include their content digest, and install results list changed dependency manifests (`a21d691`, `ecd4f40`, `fb0afb3`). [Package registry](PACKAGE_REGISTRY.md)
- The Flutter IME bridge keeps overlay text scaling, selection geometry, and CJK composition in sync (`dbb334b`). [Flutter API](FLUTTER_API.md) · [Framework guide](FRAMEWORK_GUIDE.md)

## Compatibility

The pinned PocketJS revision and QuickJS bytecode ABI are unchanged from 0.1.26. The release targets macOS arm64 and Windows x64. Optional packages are resolved against a configured registry or a registry generated from a complete SDK source checkout. [0.1.26 distribution notes](RELEASE_0.1.26.md) · [Install Studio](INSTALL_STUDIO.md) · [Package registry](PACKAGE_REGISTRY.md)
