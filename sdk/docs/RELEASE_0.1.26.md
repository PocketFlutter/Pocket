# Pocket Web SDK 0.1.26

## Added

- **Pluggable 23-slot `@pocket/ui` Skin System & `PocketAppShell`**: Complete `UI_SKIN_KIT_SLOTS` (23 slots), `defaultSkinAdapter`, `defineUiSkin`, `PocketAppShell` Back/IME integration (`SkinBackButton`, `usePocketBackHandler`, `deliverTextInputEvent`), and aligned `@pocket/looseleaf`, `@pocket/arc`, and `@pocket/liquid_glass` companion skin packages (`5b597a9`). [JS API](JS_API.md) · [Framework Guide](FRAMEWORK_GUIDE.md) · [Liquid Glass package](LIQUID_GLASS_PACKAGE.md)
- **Liquid Glass Renderer, Transitions & Showcase UIKit Gallery**: Persistent fading/morphing Liquid Glass surfaces, shared backdrop capture across non-interfering glass, `ScrollEdgeEffect`, chromatic Siri glow, and the Showcase UIKit Gallery (`b94d8ba`, `2e3ff15`, `8f3bffd`, `0a2521e`, `25d2e32`, `39b0656`). [Apple Glass](APPLE_GLASS.md) · [Liquid Glass package](LIQUID_GLASS_PACKAGE.md)
- **Standalone Project CLI & Strict Guest Convention Gate**: `create_project.mjs` (`npm run create`), `check_project.mjs` (`npm run check`), `--sync-agents` (`npm run sync:agents`), managed `AGENTS.md` / `CLAUDE.md` framework rules, and the strict `buildGuest` guest framework convention gate (`8d0f38f`). [Tooling API](TOOLING_API.md) · [Project templates](PROJECT_TEMPLATES.md)
- **`PocketLazyPlugin` & `PocketDioWorkerHttpBridge`**: Deferred Flutter plugin instantiation via `PocketLazyPlugin` and native Worker HTTP-to-Dio FFI bridging via `PocketDioWorkerHttpBridge` (`76f3b7d`, `2f25492`). [Flutter API](FLUTTER_API.md) · [Optional plugins](OPTIONAL_PLUGINS.md) · [Dio Worker bridge](DIO_WORKER.md)

## Changed

- **Unified Dio Update Transport & Optional Plugin Decoupling**: Unified signed OTA package downloads onto `DioPocketUpdateTransport`, removed Rust `ureq`/`rustls` from static native archives, and decoupled optional `pocket_archive` 7z extraction behind `MethodChannel` (`76f3b7d`, `2f25492`). [Optional plugins](OPTIONAL_PLUGINS.md) · [Native archive integration](NATIVE_ARCHIVE_INTEGRATION.md)

## Fixed

- **Liquid Glass Alert & Gallery Parallax Polish**: Matched iOS 26 alert presentation and retained iOS `-30%` parallax push/pop transitions with smooth Siri glow (`ba64648`, `d5ee22b`). [Apple Glass](APPLE_GLASS.md)
- **Session Performance Init, Dio Test Client & `alert()` Convention Check**: Restored concurrent `PerformanceHistory.initialize()` during `PocketSession` bootstrap, forwarded `HttpClient` configuration properties in loopback LAN HTTP tests, included `back-navigation.ts` in isolated `mobile_ui` tests, and prevented false-positive browser-global errors on SolidJS `alert()` signal accessors (`9ba87db`).
- **Windows Toolchain Stack Size & Smoke Diagnostics**: Reserved an 8 MiB stack for `pocket_probe` and `pocketjs_bytecode` to match QuickJS's 4 MiB stack guard on Windows MSVC, and surfaced HTTP error payloads in `platform_package_smoke.mjs` (`cd350d3`). [Windows build](WINDOWS_BUILD.md)

## Compatibility

Pinned PocketJS revision (`99924de47c62fa36f526a8791055d91cbbdb3836`) and QuickJS bytecode ABI (`quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021`) remain unchanged from `0.1.25` (`6db751a`). Separate verified macOS arm64 and Windows x64 archives are published on GitHub Releases. [0.1.25 distribution notes](RELEASE_0.1.25.md) · [Install Studio](INSTALL_STUDIO.md)
