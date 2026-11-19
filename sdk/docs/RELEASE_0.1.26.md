# Pocket Web SDK 0.1.26

`@pocket/ui` introduces the pluggable 23-slot `UiSkinKit`, `defaultSkinAdapter`, and `defineUiSkin`, along with `PocketAppShell` Back/IME integration and companion `@pocket/looseleaf`, `@pocket/arc`, and `@pocket/liquid_glass` skin alignment. [JS API](JS_API.md) · [Framework Guide](FRAMEWORK_GUIDE.md) · [Liquid Glass package](LIQUID_GLASS_PACKAGE.md)

The native and Web Liquid Glass shader renderer integrates `GlassSurface` with the `backdrop_blur` and `liquid_glass` shaders and adds the Showcase UIKit Gallery. [Apple Glass](APPLE_GLASS.md) · [Liquid Glass package](LIQUID_GLASS_PACKAGE.md)

Standalone project creation and validation add `create_project.mjs`, `check_project.mjs`, `--sync-agents`, and the strict `buildGuest` guest framework convention gate. [Tooling API](TOOLING_API.md) · [Project templates](PROJECT_TEMPLATES.md)

Flutter host and plugin updates add `PocketLazyPlugin`, `PocketDioWorkerHttpBridge`, `DioPocketUpdateTransport`, and decoupled optional `pocket_archive` via MethodChannel. [Flutter API](FLUTTER_API.md) · [Optional plugins](OPTIONAL_PLUGINS.md) · [Dio Worker bridge](DIO_WORKER.md) · [Native archive integration](NATIVE_ARCHIVE_INTEGRATION.md)

The pinned PocketJS revision and QuickJS bytecode ABI remain unchanged from 0.1.25. Separate macOS arm64 and Windows x64 archives are available on GitHub Releases. [0.1.25 distribution notes](RELEASE_0.1.25.md) · [Install Studio](INSTALL_STUDIO.md)
