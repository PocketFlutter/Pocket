# Pocket Studio macOS checklist (Apple Silicon build & smoke-launch verified 2026-11-17; interactive GUI/IME & distribution checks remain manual)

Status (updated 2026-11-17, owner decision D4 in `sdk/docs/DECISIONS.md`): on 2026-11-17 (Apple Silicon macOS), the native static library (`bash sdk/scripts/build_native.sh macos` -> `libpocket_flutter.a`), the macOS debug app bundle (`flutter build macos --debug` -> `pocket_studio_app.app`), Impeller MetalSDF smoke launch (`PocketStudioService` spawning live editor service via `POCKET_STUDIO_BUN`, passing `/health` with `service: pocket-editor`, and staying running cleanly), and the full automated test gates (`studio/test` 10/10, `studio/js` `test_guest.sh` 129 unit + 70 probe, `pocket_studio` 94/94 with `POCKET_REQUIRE_REAL=1`, `pocket_clipboard` 13/13, `pocket_file_picker` 9/9) were verified. `bun sdk/pocket.ts editor [<project>]` now defaults to Pocket Studio on macOS when `studio/` is present in the repo checkout (`--web` or `POCKET_EDITOR_UI=web` selects the web Studio). Interactive live GUI/IME candidate-window checks, profile-build frame timings, live COS cloud upload with real credentials, and Apple Developer ID codesigning/notarisation remain manual release/distribution checks below.

Everything below needs a Mac (Apple Silicon) and cannot be proven in the Linux container where M0-M7 were originally built. The automated
suites (`ARCHITECTURE.md` "Tests", `README.md` "Tests") run the guest, host plugins and service on the real native
library; interactive items below cover live human GUI/IME inspection, profile frame timings and signed distribution.
Tick each item with the date, the Mac model, the commit and the numbers.

Prerequisites: Xcode, Flutter (the SDK's pinned channel; `sdk/scripts/pocket_studio_launcher.ts` auto-detects `<repoRoot>/.fvm/flutter_sdk/bin/flutter`), `bun`, `cargo` with the `aarch64-apple-darwin` target.
Build the guest first: `cd studio/js && bun install && bun run build`.

- [x] Linux/macOS gate (verified 2026-11-17 on Apple Silicon macOS): `cd studio && POCKET_REQUIRE_REAL=1 flutter test --no-pub` reports 0 skipped (10/10 passed; `pocket_studio` 94/94 with `POCKET_REQUIRE_REAL=1`, `pocket_clipboard` 13/13, `pocket_file_picker` 9/9, `studio/js` `test_guest.sh` 129 unit + 70 probe).

## 1. Launcher, build and smoke launch
- [x] Native static archive & macOS app bundle build + smoke launch (verified 2026-11-17 on Apple Silicon macOS): `bash sdk/scripts/build_native.sh macos` -> `libpocket_flutter.a`; `cd studio && flutter build macos --debug` -> `pocket_studio_app.app` launched via Impeller MetalSDF, started the live editor service via `PocketStudioService` (`POCKET_STUDIO_BUN`), passed `/health` (`service: pocket-editor`), and stayed running cleanly.
- [x] `bun sdk/pocket.ts editor [<project>]` defaults to Pocket Studio on macOS when `studio/` is present in the repo checkout (`--pocket` also accepted; `--web` or `POCKET_EDITOR_UI=web` selects web Studio), writes `<workspace>/pocket-studio-host.config.json`, auto-detects `<repoRoot>/.fvm/flutter_sdk/bin/flutter`, attaches to or starts the service, opens the Studio window.
- [x] Re-running with the service already up attaches (no second service); closing the window stops a service the host started (verified in `real_service_test.dart` & macOS smoke launch, 2026-11-17).
- [x] On Linux/Windows (or when `--web` / `POCKET_EDITOR_UI=web` / service-only flags / standalone export without `studio/` is used) the CLI uses the web Studio, and explicit `--pocket` on non-macOS prints the macOS-only error (covered by `sdk/scripts/tests/pocket_studio_launcher.test.ts`, verified 2026-11-17).

### Linux substitutes (config text only)
- `sdk/scripts/tests/pocket_studio_macos_config.test.ts` checks, as text only: the entitlements files, the pbxproj entitlement references and deployment target, the Info.plist keys, and the launcher dart-defines read by the host.
- It cannot substitute for: building, linking, signing, notarising or the hardened runtime (the pbxproj sets no `ENABLE_HARDENED_RUNTIME`); IME (candidate window, marked text, dead keys); the Flutter macOS menu swallowing Cmd+W/P/B; on-screen `CompositorSurface` compositing; profile-build frame timings; `NSPasteboard`; the window replacing itself on self-update; and `flutter run -d macos` end to end.

## 2. Spike A: IME and raw key checklist (sdk/docs/STUDIO_TEXT_INPUT.md, "Spike A", 12 items)
- [ ] Pinyin, Japanese, dead keys, composition cancel, selection replace, Cmd+S/Cmd+Z/Shift+Arrow modifiers, key policy, InputField/raw replacement, held-key pairing, AltGr/Option layers, Enter policy, gate toggles.
- [ ] Studio shortcut map on a real keyboard (the Linux tests inject `input.text` batches): Cmd+S, Cmd+F, Cmd+B, Cmd+Shift+B, Cmd+P, Cmd+W, Cmd+Shift+[ and ], Cmd+1..9, Cmd+Shift+P, Esc, while the code view has the keyboard and while it does not. Confirm macOS menu key equivalents do not swallow Cmd+W/Cmd+P/Cmd+B (Flutter's default macOS menu) and that the host reports Cmd+Shift+[ as `Shift+Meta+{` (US layout) or `Shift+Meta+[`; both are mapped.
- [ ] Quick-open: Cmd+P focuses the field (autoFocus) and the IME candidate window appears at the field.

## 3. Spike B: profile-build frame timings (sdk/docs/CODE_VIEW.md, PERFORMANCE.md)
- [ ] `flutter run --profile -d macos` with a 5,000-line file: open, wheel scroll, typing 100 keys, build, publish. Record UI build p95 / raster p95 / over-budget frames against the 16.67 ms budget (DevTools or `FlutterFrameMonitor`).
- [ ] Layout cache: capacity 2048 versus 256 (`studioSystemUI` sets 2048): hit rate and evictions (`PocketViewController.textLayoutCacheStats`).
- [ ] Guest turn budget 250 ms is not exceeded on the release native library with the largest supported file (4 MiB).
- [ ] Compare with the Linux debug numbers in `PERFORMANCE.md`; the Linux numbers are regression bounds, not frame budgets.

## 4. Spike C: compositing and latency
- [ ] The signed preview child composited by `CompositorSurface` beside the editor (Source dock) and on the Preview page: first visible frame, reload without flicker, correct clipping when the split handle moves.
- [ ] Save-to-preview latency (`STUDIO_SAVE_TO_PREVIEW_LATENCY` printed by `studio_preview_loop_test.dart`, Linux) measured on screen with auto-build on.
- [ ] Focus and health promotion of the preview child; pointer input reaches the child, keyboard input stays with the Studio.

## 5. Self-update on screen
- [ ] Settings -> check -> apply replaces the running Studio window content from the signed test channel; page and open project survive (handoff); a deliberately broken build rolls back (Linux: `studio_self_update_test.dart`).
- [ ] `POCKET_STUDIO_UPDATE_CHANNEL=stable` path against a stable slot.

## 6. Entitlements and codesign
(Note: the pbxproj currently sets no hardened runtime, so the hardened-runtime items below are not yet configured.)
- [ ] `studio/macos/Runner/*.entitlements`: the app runs without the App Sandbox (it spawns `bun` and reads the trusted workspace). With the sandbox off, the `com.apple.security.network.*` entitlements are inert (they only apply inside the sandbox); loopback networking is not governed by them. Decide the distribution model (developer tool outside the Mac App Store) and sign with a Developer ID, hardened runtime.
- [ ] `com.apple.security.cs.allow-jit`: the Release entitlements already omit it (QuickJS bytecode, no JIT); only `DebugProfile.entitlements` grants it. Verify the Release build still starts with hardened runtime and no JIT entitlement.
- [ ] Accepted residual risk (developer tool): a QuickJS memory-safety bug in the preview child would run with the user's privileges, because the sandbox is off. This is accepted for a developer tool distributed outside the Mac App Store; revisit if distribution changes.
- [ ] Notarisation and Gatekeeper first launch; `bun` located through the configured path, not `PATH` of the launching shell.
- [ ] Release build (`flutter build macos --release`) links the static native archive (arm64 only).

## 7. Other macOS-only observations
- [ ] Clipboard plugin on `NSPasteboard` (Linux uses a mocked platform channel).
- [ ] Window resize, full screen, and display scale changes: split handle limits, tree and dock widths persisted in `system.storage`.
- [ ] Memory: Activity Monitor RSS after the M7 scenarios stays within the Linux table (`PERFORMANCE.md`) plus the Flutter engine baseline.

## Owner-scoped exclusions (not release blockers)
Visual novel editor, WeChat preview, Noble Bluetooth and Codex stay in the web Studio by owner decision (`PARITY.md`).
Live Tencent Cloud COS upload with real cloud credentials remains a manual check (COS config/redaction/check/publish routes are covered by automated fake/loopback tests).
