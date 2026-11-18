# Pocket SDK source and runtime audit (`a5dd273`)

- **Repository** `/Volumes/ORICO/Development/Github/pocket` at `a5dd273`. The worktree was clean. The audit was read-only and left files and caches in place.
- **Legacy reference** `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding `pocket_host/`. Review compared source call paths without running or rebuilding it.
- **Audit date** 2026-11-02

---

## Overall assessment

At `a5dd273`, Pocket had a thin Flutter host, real Rust `rquickjs` precompiled bytecode (`PJSB` v2 envelope, SHA-256, and QuickJS engine ABI verification), `@pocket/ui` Solid/PocketJS primitives, Ed25519-signed hot updates, and native iOS/Android hardware plugins. The old Dart VDOM and pseudo-bytecode `.pjc` source packages are outside this architecture.

Review of production call paths found **two P0s** (production transport not connected and permission isolation/revocation defects), **five P1s** (bundled build always zero, ticker sleep freezing JS timers, per-frame full JSON, Editor origin validation, and iOS artifact overwrites), and **four P2s**.
1. The bidirectional lock-free SPSC channel in `duplex.rs` and `pocket_duplex.dart` passed standalone tests but had no production input or event wiring in `PocketView`, `PocketSession`, or Showcase. Pointer, text, safe area, and host messages all used `jsonEncode` → `pocket_send`.
2. Plugin permissions are aggregated across a plugin, and `hardware.permissions.request` declares an empty set `{}`. An undeclared optional hardware permission can revoke all of `HardwarePlugin` or abort guest startup. The permission prompt and weather coordinate lookup also lacked checks at their respective host boundaries.
3. The build reads `version` and `build` from `guest-manifest.json`, which contains only protocol and permissions. The build lives in `editor.json`, so `embeddedBuild` is always 0 for `demo/assets/app.bytecode.json` and CLI/Editor outputs.

---

## 1. Findings by priority

### P0-1. Lock-free SPSC duplex exists in runtime and tests and is disconnected from production `PocketView` input and events

- **Source locations**
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:204-214`（`PocketViewController.send`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:1246-1275`（`_PocketViewState._reportSafeArea`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:2349-2378`（`_PocketViewState._sendPointer`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart:273-306`（`FfiPocketRuntime._lookupDuplexBindings`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart:365-375`（`FfiPocketRuntime.openDuplex`）
  - `sdk/native/src/lib.rs:1491-1498` (`drain_duplex` in `build_frame`)
- **Conditions** Run a `PocketApp`, `PocketSession`, or `PocketView` consumer such as Showcase and interact with touch drag, gesture scroll, window resize, or host messages.
- **Impact**
  1. `sdk/native/src/duplex.rs:1-489`, `sdk/native/src/lib.rs:3276-3544`, and `sdk/packages/pocket_flutter/lib/src/pocket_duplex.dart:1-435` implement ABI v2 SPSC lock-free rings with `CachePadded<AtomicU32>`, generation isolation, and `NativeFinalizer`. Production has no `runtime.openDuplex()` caller.
  2. Every high-frequency `_sendPointer` and viewport event still allocates a Map, calls `jsonEncode`, copies UTF-8, passes through `pocket_send`, and calls Rust `serde_json::from_str`.
  3. FFI consistency: `_lookupDuplexEndpointBindings` at `pocket_runtime.dart:838-872` sets `isLeaf: true`. `FfiPocketRuntime._lookupDuplexBindings` at lines 273–306 omits it for `pocket_duplex_abi_version`, `pocket_duplex_message_size`, and `pocket_duplex_capacity`.
- **Evidence** Searching `sdk/` and `demo/` for `openDuplex` and `PocketDuplexChannel` finds callers only in `pocket_duplex_test.dart:15-180` and `pocket_duplex_ffi_test.dart:55-115`.
- **Proposed minimal fix**
  1. In `_PocketViewState._boot` (`pocket_view.dart:828-855`) and after successful reload, obtain a `PocketDuplexEndpoint` via `_runtime.openDuplex()`. Call `close()` on dispose and before reload.
  2. Publish high-frequency numeric events such as pointer move/down/up or numeric signals through `PocketDuplexEndpoint.publishIngress`. After each tick, call `drainEgress` to dispatch guest `__pocketEmitDuplex` events. Add `isLeaf: true` in `_lookupDuplexBindings`.

---

### P0-2. Plugin-level permission aggregation and missing per-method admission in permission prompts and weather

- **Source locations**
  - `sdk/packages/pocket_services/lib/src/pocket_plugin.dart:484-568`（`PocketPluginManager.activate`）
  - `sdk/packages/pocket_services/lib/src/pocket_host.dart:164-221`（`PocketHost.guestAvailability`、`revokeCapabilities`）
  - `sdk/lib/src/pocket_session.dart:188-243`（`PocketSession._configureBridge`）
  - `sdk/packages/pocket_hardware/lib/src/hardware_plugin.dart:136-271`（`HardwarePlugin`）
  - `sdk/packages/pocket_hardware/lib/src/hardware_plugin.dart:602-609`（`HardwarePlugin.weatherCurrent`）
- **Conditions**
  1. The guest manifest requires `hardware.permissions`, makes `hardware.camera.capture` optional, and declares only some permissions. A host may also allow location and omit camera through `PocketAppConfig.allowedPermissions`.
  2. The audit considered the dynamic target permission used by `hardware.permissions.request` and native coordinate resolution when `hardware.weather.current` receives no coordinates.
- **Impact**
  1. **Plugin-wide failure or revocation.** `PocketPluginManager.activate` at `pocket_plugin.dart:492-543` merges all `grantedMethods` permissions into `requiredPermissions` and computes `requiredCapability = names.any(availability.required.contains)`. A required method such as permission query plus an optional method lacking camera permission can fail guest startup with `permission_not_declared` or `plugin_permission_denied`. If all methods are optional, `granted.removeAll(names); host.revokeCapabilities(names)` revokes otherwise granted hardware methods too.
  2. **Missing permission checks.** `HardwareCapabilities.requestPermission` at `hardware_plugin.dart:187-190` declares `const <String>{}`. Its handler at 264–271 omits `_checkPermission(permission)`. `PocketSession._configureBridge` at `pocket_session.dart:188-192` constructs `HardwarePlugin` without `grantedPermissions`, leaving `_grantedPermissions` null and making `_checkPermission` at 159–166 ineffective in production. `weatherCurrent` at 251–255 declares only `HardwarePermissions.network`. Native location resolution at 602–609 lacks the corresponding `hardware.location` check.
  3. **Stale capability snapshot.** `PocketHost.revokeCapabilities` at `pocket_host.dart:217-221` removes `_handlers` entries without updating `_availability`. `host.capabilitiesJson()` still reports revoked capabilities as granted.
- **Evidence** `pocket_plugin.dart:489-559` and `pocket_session.dart:188-204` establish the call chain.
- **Proposed minimal fix**
  1. In `PocketPluginManager.activate`, validate `method.permissions ?? descriptor.permissions` for each `PocketPluginMethod`. Revoke only an optional capability whose permission is undeclared or disallowed. Skip `onActivate` only when every capability is revoked.
  2. Update `_availability` in `PocketHost.revokeCapabilities`.
  3. In `PocketSession._configureBridge`, pass the intersection of manifest and `config.allowedPermissions` to `HardwarePlugin(grantedPermissions: ...)`. Check target permissions in `requestPermission` and require `HardwarePermissions.location` in the coordinate-free `weatherCurrent` branch.

---

### P1-1. Build drops project `version` and `build` from `app.bytecode.json`, leaving `embeddedBuild` at 0

- **Source locations**
  - `sdk/scripts/build_guest.ts:404-424`
  - `sdk/pocket.ts:505-521`
  - `demo/assets/app.bytecode.json:1-13`
  - `demo/assets/guest-manifest.json:1-44`
  - `sdk/lib/src/pocket_session.dart:88-92`
  - `sdk/lib/src/pocket_session.dart:165-173`
- **Conditions** Build with `bun sdk/pocket.ts build`, `sdk/scripts/build_guest.ts`, or Editor, including `demo/`. Start `PocketSession` and inspect `runtime.info` or the update `minimumBuild`.
- **Impact**
  1. `build_guest.ts:404-424` reads `version` and `build` only from `manifest.json` (the input for `guest-manifest.json`). That file has `protocolVersion`, `capabilities`, and `permissions`. Project version and build live in `editor.json` or `pocket.json`.
  2. Generated `demo/assets/app.bytecode.json` therefore omits `version` and `build`.
  3. `PocketSession._initialize` at `pocket_session.dart:88-92` parses an `embeddedBuild` of zero. A fresh install admits an update with `minimumBuild == 0`, so it cannot reject older releases below the true bundled build. `PocketSession.status()` at 168–171 also hardcodes `'activeBuild': active?.build ?? 0` and `'build': 0`.
- **Evidence** `demo/assets/app.bytecode.json:1-13` contains only `entryFormat`, `kind`, `runtimeAbi`, `bindingGeneration`, `tickHz`, `bytecodeBytes`, `bytecodeSha256`, `pakBytes`, `pakSha256`, `contractSha256`, and `envelopeVersion`.
- **Proposed minimal fix** At `build_guest.ts:404-424`, use `editor.json` or `pocket.json` in the same directory if `manifest.json` lacks `version` or `build`, then write them to `app.bytecode.json`. Store `_embeddedBuild` in `PocketSession` and return `active?.build ?? _embeddedBuild` in `status()`.

---

### P1-2. `PocketView` stops the ticker after six unchanged frames and freezes QuickJS timers and delayed animations

- **Source locations**
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:324-336`（`_wakeTicker`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:886-891`（`_onTick`）
  - `sdk/native/src/lib.rs:1483-1522` (`build_frame` advances `__pocketAdvanceTime`)
- **Conditions** After input or a host response, the guest schedules `setTimeout`, `setInterval`, or a debounced update past roughly 100 ms (six frames at 60 Hz). Alternatively, it pushes messages through a separate `PocketDuplexEndpoint` without `PocketViewController.send`.
- **Impact**
  - QuickJS virtual time and timers advance only when each `pocket_frame_delta` invokes `__pocketAdvanceTime(dt)`.
  - After six unchanged DrawLists (`idleFrames >= 6`), `_onTick` at `pocket_view.dart:886-891` calls `_ticker?.stop()`. `pocket_frame_delta` stops until the next touch or active host bridge message. Longer timers, polling callbacks, and delayed animations remain pending without a wake.
- **Evidence** `pocket_view.dart:886-891` and `lib.rs:1483-1522` show that Rust exposes neither the next timer deadline nor active animation/timer state to the host.
- **Proposed minimal fix** Return active-animation state or the nearest timer's `nextTimerMs` from Rust `FrameResult`/delta or a lightweight FFI query. Keep the ticker for active animation. For a timer-only wake, stop the ticker and set a one-shot Dart `Timer(Duration(milliseconds: nextTimerMs), _wakeTicker)`.

---

### P1-3. Changed frames serialize the full DrawList and RGBA arrays to UTF-8 JSON across FFI

- **Source locations**
  - `sdk/native/src/lib.rs:1649-1696` (`FrameResult` and `FrameResource`)
  - `sdk/native/src/lib.rs:3219-3251`（`frame_delta_json_for_host`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart:195-210`（`FfiPocketRuntime.frameDeltaAt`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_model.dart:168-185`（`PocketFrameResource.fromJson`）
- **Conditions** Scroll a page, animate a 60 FPS route transition, run the 500-node stress test (1,761 DrawOps), or load a first frame containing font or atlas textures.
- **Impact**
  - `pocket_frame_delta` returns `{"unchanged":true}` only for byte-identical DrawLists with no events or new resources.
  - Any numeric or coordinate change, such as scroll or transition, makes Rust serialize the entire DrawList into a `String` and `CString`. The Dart UI thread calls `toDartString()` and `jsonDecode`, creating thousands of Maps.
  - `serde_json` serializes `FrameResource.pixels: Vec<u8>` at `lib.rs:1676` into decimal arrays such as `[255,0,128,...]`. Dart converts each `(item as num).toInt()` back into `Uint8List`.
- **Evidence** `native_guest_probe.ts:500-530` measured 1,761 JSON DrawOps in one 500-node frame. `lib.rs:1669-1677` and `pocket_model.dart:175-182` show JSON-array pixel transport.
- **Proposed minimal fix** Read `FrameResource.pixels` via an FFI binary pointer and length, or base64 as an interim representation. Encode the DrawOps as a compact binary buffer read through TypedData `Float32List`/`Uint32List` views. Events can use JSON or duplex.

---

### P1-4. Editor mutation endpoints accept requests that lack an Origin header

- **Source locations**
  - `sdk/editor/server.ts:732-748`（`validateRequestSecurity`）
  - `sdk/editor/server.ts:931-965`（`POST /api/projects/:id/assets`、`/build`、`/publish`）
- **Conditions** The local Editor at `127.0.0.1:4680` receives a cross-site request without an `Origin` header on its build, publish, or asset route.
- **Impact**
  - `validateRequestSecurity` at `server.ts:738-744` checks `Origin` only when `if (originHeader)` is true.
  - `/api/projects/:id/build` and `/api/projects/:id/publish` do not call `readJson()` and therefore bypass its `Content-Type: application/json` check. `/api/projects/:id/assets` accepts `multipart/form-data`. A missing Origin can leave state mutations admitted, including builds, signed update publishing with the local development key, or file uploads.
- **Evidence** `server.ts:738-744` and `server.ts:931-965`.
- **Proposed minimal fix** Require a valid Origin on every non-GET/HEAD mutation, or require a custom header such as `X-Pocket-Editor: 1` so cross-origin browser requests go through CORS preflight.

---

### P1-5. The SDK requires `pocket_hardware`, and iOS device and simulator builds overwrite the same archive

- **Source locations**
  - `sdk/pubspec.yaml:11-16`
  - `sdk/lib/pocket_sdk.dart:1-21`
  - `sdk/scripts/build_native.sh:33-50`
  - `sdk/pocket.ts:409-432`
- **Conditions**
  1. A consumer integrates `pocket_sdk` with `enableHardware: false` because it needs no camera, Bluetooth, location, or biometric libraries.
  2. A developer switches between iOS device (`ios`) and simulator (`ios-sim`), or multiple consumers share one `sdk/`.
- **Impact**
  1. `sdk/pubspec.yaml:11-16` unconditionally depends on `pocket_hardware`, so the Flutter plugin registry links camera, BLE, location, sensors, and other native code into every host.
  2. `build_native.sh:33-50` writes `aarch64-apple-ios` and `aarch64-apple-ios-sim` to the same `packages/pocket_flutter/ios/Frameworks/libpocket_flutter.a`. Switching targets overwrites the file because there is no XCFramework.
  3. `pocket.ts:414` writes the build stamp to `sdk/.pocket-build/sdk-native/current.json` in the shared SDK.
- **Evidence** `build_native.sh:33-50` and `sdk/pubspec.yaml:11-16`.
- **Proposed minimal fix** Make `pocket_hardware` an optional extension and keep the core on `pocket_flutter` and `pocket_services`. Generate `pocket_flutter.xcframework` with both `ios-arm64` and `ios-arm64_x86_64-simulator`.

---

### P2-1. Default `cargo test` or `bun test` fails without prerequisite environment variables

- **Source locations**
  - `sdk/native/src/lib.rs:3978-3992` (`smoke_tests` require `POCKET_TEST_ASSETS` and `POCKET_TEST_SOURCE`)
  - `sdk/packages/pocket_ui/test/flutter_widgets_native.test.ts:22-26` (requires `POCKET_WIDGET_FIXTURE_DIR`)
  - `sdk/package.json:13-21` (no top-level `"test"` script)
- **Conditions** Run `cargo test` in `sdk/native` or `bun test` / `bun run test` in `sdk/`.
- **Impact** Three default Cargo tests panic with `NotPresent`. One Bun test throws without `POCKET_WIDGET_FIXTURE_DIR`. `bun run test` exits because the script is absent.
- **Evidence** See the actual command output in section 5.
- **Proposed minimal fix** If `POCKET_WIDGET_FIXTURE_DIR` is absent, have `flutter_widgets_native.test.ts` compile `test/fixture` to a temporary directory through `build_guest.ts`. Add a top-level `"test"` script chaining the suite in `sdk/package.json`.

---

### P2-2. `@pocket/ui` graphics helpers emit unused legacy `line` and `arc` operations

- **Source locations**
  - `sdk/packages/pocket_ui/src/graphics.ts:1-200`
  - `sdk/packages/pocket_ui/src/index.ts:29-37`
- **Conditions** A consumer imports and calls `compute3dMechaFrame` or `compute2dParticleFrame` from `@pocket/ui`.
- **Impact** These helpers emit `{ op: "line", ... }` and `{ op: "arc", ... }`, matching legacy sandbox `OP_LINE` and `OP_ARC`. The current Rust `DrawOp` and Flutter `PocketCanvasPainter` (`pocket_view.dart:2796-3150`) have no corresponding primitives.
- **Evidence** No `"line"` or `"arc"` draw branch in `sdk/native` or `sdk/packages/pocket_flutter` and no consumer in `demo/js/`.
- **Proposed minimal fix** Remove both helpers from `@pocket/ui` or have them emit supported `View` or `CanvasBlock` nodes. Keep used icon specifications.

---

### P2-3. Camera `hostSurface` preview uses rectangular clipping only

- **Source locations**
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:1185-1203`（`_buildSurfaceOverlay`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:2762-2794`（`_splitCanvasBlocks`）
- **Conditions** Start camera preview (`hostSurface` → Flutter `Texture`) in a container with rounded corners or add multiple host surfaces.
- **Impact** `_splitCanvasBlocks` correctly draws later DrawOps above the Texture. Each `hostSurface` splits `CustomPaint` into separate `_CanvasBlock` widgets. The host surface clips with `ClipRect` and ignores the container radius.
- **Evidence** `pocket_view.dart:1187-1203` uses `ClipRect` only.
- **Proposed minimal fix** Carry container `radius` on the `hostSurface` DrawOp and use `ClipRRect` in `_buildSurfaceOverlay` when `radius > 0`.

---

### P2-4. iOS deep links require the CLI patch to `SceneDelegate.swift`

- **Source locations**
  - `sdk/pocket.ts:238-320`（`patchIosSceneDelegate`）
  - `sdk/packages/pocket_hardware/ios/Classes/PocketHardwarePlugin.swift:1-35`
- **Conditions** An existing Flutter consumer adds `pocket_sdk` through `flutter pub add` or `pubspec.yaml` without patching `ios/Runner/SceneDelegate.swift` through `bun pocket.ts init/build`.
- **Impact** iOS deep-link capture depends on an explicit `PocketHardwareManager.shared.handleIncomingDeepLink(url)` call in `SceneDelegate.swift`. Without the patch, links never invoke that callback.
- **Evidence** `PocketHardwarePlugin.swift:1-35` and `pocket.ts:238-320`.
- **Proposed minimal fix** Implement `FlutterApplicationLifeCycleDelegate`'s `application(_:open:options:)` and Universal Links callbacks in `PocketHardwarePlugin.swift`, register via `registrar.addApplicationDelegate(instance)`, and make the SceneDelegate patch optional.

---

## 2. Capability matrix

| Area | Public entry | Production path | iOS | Android | Test evidence | Remaining gaps |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1. SDK integration and scaffold** | `sdk/lib/pocket_sdk.dart` (`PocketApp`, `PocketGuest`, `PocketSession`) and CLI `sdk/pocket.ts` (`init`, `build`) | `PocketApp` → `PocketSession` → `PocketView` + `PocketHost` + `PocketPluginManager` + `PocketUpdateCoordinator` | Verified idempotent Podfile, Info.plist, and SceneDelegate patches. | Verified idempotent AndroidManifest permission and `minSdk` patches. | `check_architecture.py`, `tooling_scene.test.ts`, `android_scaffold.test.ts`, and `session_integration_test.dart` passed. | Required `pocket_hardware` dependency and no iOS XCFramework (P1-5). |
| **2. QuickJS bytecode and PAK** | `sdk/scripts/build_guest.ts`, `sdk/native/src/bin/pocketjs_bytecode.rs`, and `PocketBytecodeArtifact` | TS/TSX → two-stage PocketJS compiler → `app.pak` and `app.js` → `rquickjs` `Context::compile` emits `PJSB` v2 `app.qjbc` → `pocket_load_bytecode_files` checks magic, SHA-256, and ABI before executing. | Actual VM bytecode and no source fallback. | Actual VM bytecode and no source fallback. | Cargo tamper, truncation, and ABI refusal tests passed. `guest_ablation.ts` showed bytecode changes affect the first frame. | `build_guest.ts` omits `version` and `build` from `editor.json` in `app.bytecode.json` (P1-1). |
| **3. Hot updates and versions** | `PocketUpdateCoordinator`, `PocketPackageStore`, and `sdk/scripts/serve_updates.ts` | `checkAndDownload` → Ed25519 and AppId/channel/ABI/build admission → download and verify SHA-256 per entry → rebuild PAK → swap pointers (`current.json`/`previous.json`) → `reloadGuest` → `commitHealthy` after first frame, or `rollback` and blacklist the bad build. | Supported. | Supported. | All 10 `package_update.test.ts` tests plus `security_and_plugins_test.dart` and `plugin_admission_test.dart` passed. | P1-1 leaves bundled `embeddedBuild` and first-update `minimumBuild` at 0. |
| **4. External plugin registration and admission** | `PocketPlugin`, `PocketPluginManager` | `PocketAppConfig.plugins` → `PocketPluginManager.activate` → admit manifest capabilities and permissions against host `allowedPermissions` → register `PocketHost` handler. | Supported. | Supported. | `plugin_admission_test.dart` and `session_integration_test.dart` passed. | Plugin-wide permission aggregation and stale `host.guestAvailability` after revoke (P0-2). |
| **5. Camera, photo library, and QR** | JS `hardware.camera.previewStart` / `Stop` / `SwitchLens` / `Capture` / `QrScan`, `hardware.photos.save`, and `hardware.media.pickImages` | JS `requestHost` → `HardwarePlugin` → `pocket.dev/hardware` MethodChannel → native Texture registration and `authorizeSurface("hardware.camera", textureId)` → `PocketView` Texture. | Native `PocketHardwareManager.swift` uses `AVCaptureSession`, `FlutterTexture`, `VNDetectBarcodesRequest`, `PHPhotoLibrary`, and `PHPickerViewController`. | Native `CameraHardware.kt` uses `Camera2`, `SurfaceTextureEntry`, MLKit/ZXing scanning, `MediaStore`, and `PickMultipleVisualMedia`. | Twelve `hardware_plugin_test.dart` tests and `pocket_surface_test.dart` passed, including late texture rejection after deactivation. | Physical camera textures and permission prompts still need iPhone and Android device tests. `hostSurface` has rectangular `ClipRect` only (P2-3). |
| **6. Location, weather, sensors, BLE, biometrics, secure storage, audio** | JS `hardware.location.current`, `hardware.weather.current`, `hardware.sensors.sample`, `hardware.ble.scan`, `hardware.biometrics.authenticate`, `hardware.storage.*`, `hardware.audio.recordSample` | JS `requestHost` → `HardwarePlugin` → `pocket.dev/hardware`. Weather uses Dart `HttpClient` for Open-Meteo and combines native GPS and barometer facts. | Actual `CLLocationManager`, `CMMotionManager`/`CMAltimeter`, `CBCentralManager`, `LAContext`, Keychain, and `AVAudioRecorder`. Structured errors on unavailability. | Actual `LocationManager`, `SensorManager`, `BluetoothLeScanner`, `BiometricPrompt`, `EncryptedSharedPreferences`/Keystore, and `AudioRecord`. Structured errors on unavailability. | `hardware_plugin_test.dart` and `hardware_platform.test.ts` passed. | Dynamic OS permission and coordinate-free weather checks (P0-2). |
| **7. JS UI and Liquid Glass rendering** | `@pocket/ui` with 38 mobile components in `mobile.tsx`, `flutter-widgets.tsx`, and `theme.ts` | Solid JSX → `@pocketjs/framework` layout → Rust `DrawOp` (`rect`, `text`, `image`, `tileset`, `texQuad`, `filter`, `hostSurface`, `textInput`) → Flutter `PocketCanvasPainter`. | Supported through the shared renderer. | Supported through the shared renderer. | `mobile_ui.test.ts`, `flutter_widgets.test.ts`, `flutter_widgets_native.test.ts`, and `pocket_renderer_test.dart` passed. | `graphics.ts` mecha and particle operations have no renderer consumer (P2-2). |
| **8. System input and adaptive layout** | `<Input>` / `textInput` DrawOp → `_PocketViewState`. `DisplayGeometry` via `viewport.safeArea`. | Rust reports text input geometry and style → transparent Flutter `TextField` supplies system IME, CJK composition, selection, and clipboard → JS `input.change`/`input.submit`. `MediaQuery` safe area, hinge, and displayFeatures merge through `viewport.safeArea`. | Keyboard avoidance and composition protection, retaining focus when the keyboard opens. | Foldable hinge and adaptive two-pane layout. | Eight `pocket_view_test.dart` tests, including UTF-16, upstream affinity, composing and focus, plus `mobile_ui.test.ts` passed. | Physical rotation and dual-screen open/close smoothness need further load testing. |
| **9. Scheduling and performance telemetry** | `PocketPerformanceTracker`, `pocket_frame_delta` | Flutter `Ticker` → `pocket_frame_delta`, stopping after six unchanged frames. `SchedulerBinding.addTimingsCallback` distinguishes idle gaps from dropped frames. | Supported. | Supported. | `pocket_performance_test.dart` and `performance_history_test.dart` passed. | Missing wake for JS timers after stop (P1-2) and full JSON DrawList and pixels for changed frames (P1-3). |
| **10. Bidirectional lock-free SPSC** | Rust `duplex.rs`, Dart `PocketDuplexChannel` and `runtime.openDuplex()`, JS `__pocketOnDuplex`/`__pocketEmitDuplex` | `PocketDuplexEndpoint` → FFI `isLeaf: true` reserve/commit (`Acquire`/`Release`, `Arc`, generation isolation) → `build_frame` `drain_duplex` → QuickJS callback. | Native and FFI available. No production UI caller. | Native and FFI available. No production UI caller. | Six `duplex_layout.rs` concurrency, wrap, and race tests, five `lib.rs` duplex integration tests, and `pocket_duplex_test.dart` and `pocket_duplex_ffi_test.dart` passed. | Production `PocketView` input and event wiring (P0-1). |
| **11. Editor and update publishing** | `sdk/editor/server.ts` | Loopback HTTP → create or mount external projects → `build_guest.ts` compiles QJBC → `package_update.ts` Ed25519 publishing → serve `/updates/:channel/latest.json` and `/blobs/:sha256`. | Development host workflow verified. | Development host workflow verified. | Four end-to-end `editor_server.test.ts` tests passed. | Mutating routes accept requests with missing Origin (P1-4). |

---

## 3. Reused and missing legacy technology

### 3.1 Working production adaptations from the retained parent
1. **iOS hardware bridge (`PocketRealHardwareManager` → `PocketHardwareManager.swift` with Android parity)**
   - The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was inspected outside `pocket_host/`. Its hardware implementation lived in `ios/Runner/AppDelegate.swift` and `lib/core/real_hardware_bridge.dart:68-549` and covered iOS. Failure paths could silently report fake grants, e.g. `hwRequestPermission(..., grant: true)` at line 119.
   - The current SDK retained camera (`AVCaptureSession` and `FlutterTexture`), scanning, photo library, CoreLocation, CoreMotion/barometer, CoreBluetooth, LocalAuthentication, Keychain, AVAudioRecorder, and live Open-Meteo. Android gained Camera2, BLE, sensors, and biometrics. Failures return actual errors.
2. **Mobile design system, Liquid Glass recipe, and four transition models (`pocketjs_uikit.js` and `pocket_syslib_router.js` → `sdk/packages/pocket_ui/src/mobile.tsx`)**
   - Retained light/dark tokens, Liquid Glass highlights and refraction, and `ios_spring_parallax`, `shared_axis_z`, `liquid_glass_morph`, and `portal_expand`. JS directly drives the real PocketJS tree.
3. **On-demand rendering and measured frame timing (`perf_monitor.dart:29-130` → `pocket_performance.dart:1-210`)**
   - Retained `SchedulerBinding.addTimingsCallback` and idle sleep. Removed hard-coded promotional text and the prefilled fake 60.0 history.

### 3.2 Migrated modules without production wiring
1. **Lock-free SPSC duplex ring (legacy `pocket_runtime_multi.h:78-97` → `duplex.rs` and `pocket_duplex.dart`)**
   - Legacy `PocketSharedDuplexChannel` copied ordinary non-atomic structs. The SDK uses `CachePadded<AtomicU32>`, `Acquire`/`Release`, exclusive SPSC roles, and `Arc` lifetime, linked to `rquickjs` `__pocketOnDuplex` and `__pocketEmitDuplex`.
   - P0-1 remains. `PocketView` and Showcase do not call `runtime.openDuplex()` and production events use JSON.
2. **Graphics helpers and SVG specs (legacy `pocket_syslib_graphics.js` → `sdk/packages/pocket_ui/src/graphics.ts`)**
   - Under P2-2, only unit tests call `compute3dMechaFrame` and `compute2dParticleFrame`. Current Rust/Flutter renderers have no consumer for their `line` and `arc` output.

### 3.3 Useful legacy behaviors still missing or incomplete
1. **Compact binary DrawList protocol (`BinaryDrawCmd` in `pocket_runtime_multi.c:8-17`)**
   - The legacy C-to-Dart path used fixed-size binary draw records even though it lacked a real JS engine. The current SDK serializes changed DrawOps and texture pixels to UTF-8 JSON (P1-3). Binary DrawList and borrowed pixel views could reduce transport overhead on complex animated pages.
2. **Freeze-on-push and scroll position retention**
   - The retained host had page-stack freezing and scroll restoration. Current SDK leaves routing in JS. `@pocket/ui` lacks an out-of-the-box multi-level keep-alive retaining background page layout and `ScrollView` offset without diffing on every frame.

### 3.4 Excluded legacy simulation and duplicate layers
1. **Pseudo-bytecode compiler (`tools/compile_pocket_syslib_aot.py:41-125`)** stripped source comments with a regex, added a 52-byte PJCA header to source, and ran host Node.js at build time to produce static VDOM JSON (`syslib_flutter_ui_vdom.aot.json`). The SDK compiles actual QuickJS `PJSB`.
2. **C state-array sandbox (`native/pocket_runtime_multi.c:19-142`)** used global arrays to model nodes and sandbox state without linking QuickJS. The current SDK uses the actual engine.
3. **Duplicate Dart VDOM and 4,000-line business renderer (`lib/render/pocket_ui_components.dart`, `lib/core/pocketjs_bundle_runner.dart`)** hard-coded page blueprints and widget mappings in the host. The SDK keeps Flutter thin and enforces the architecture with `check_architecture.py`.
4. **Synthetic hardware and permission success (`lib/core/real_hardware_bridge.dart:119`)** returned `grant: true` and simulated data on errors or unsupported simulators. The SDK returns structured errors.

---

## 4. Redundancies and ablation checks

| No. | Redundancy | Evidence | Proposed change | Acceptance |
| :--- | :--- | :--- | :--- | :--- |
| **1** | `compute3dMechaFrame` and `compute2dParticleFrame` in `sdk/packages/pocket_ui/src/graphics.ts:88-200`, with matching `graphics.test.ts` assertions. | Copied from `pocket_syslib_graphics.js`. Neither Rust, `PocketCanvasPainter`, nor `demo/js` consumes the resulting `{ op: "line" }` and `{ op: "arc" }`. | Remove helpers and related exported types, or retain only `POCKET_SVG_ICON_SPECS`. | Compile `demo/js` via `bun sdk/scripts/build_guest.ts`. Run `bun test` and `native_guest_probe.ts --required`. Artifacts and rendered frames must remain identical. |
| **2** | Full `frameAt` / `pocket_frame` alongside `frameDeltaAt` / `pocket_frame_delta` in `FfiPocketRuntime` (`pocket_runtime.dart:186-194`). | Production `PocketView._onTick` (`pocket_view.dart:868`) only calls `pocketFrameDeltaAt`. Both FFI calls return the same full JSON for changed frames. | Wrap `frameDeltaAt` for `frameAt`, or use one native frame entry point with an unchanged-frame option. | Remove separate `pocket_frame` FFI wiring and run all `pocket_flutter`, `sdk`, and `demo` Flutter tests. |
| **3** | Scaffold's duplicate `editor.json` and `guest-manifest.json` at `sdk/pocket.ts:505-521`. | `editor.json` holds `version`, `build`, `appId`, `channel`. `guest-manifest.json` holds `capabilities` and `permissions`. `build_guest.ts` misses the build number (P1-1). | Use `guest-manifest.json` or a unified `pocket.json` as canonical metadata and read it from `build_guest.ts` and `package_update.ts`. | Run `bun test scripts/tests/package_update.test.ts` and `editor/test/editor_server.test.ts`. Check correct nonzero `build` and `version` in emitted `app.bytecode.json`. |

---

## 5. Executed checks and remaining coverage

The audit ran the following read-only checks in `/Volumes/ORICO/Development/Github/pocket` at `a5dd273`. Default runs, environment-configured runs, and skips are counted separately.

### 5.1 Commands and observed results

| Check | Command | Result | Notes |
| :--- | :--- | :--- | :--- |
| **Static architecture boundaries** | `cd sdk && python3 scripts/check_architecture.py` | **PASS** (exit 0) | Confirms no SDK dependency on `demo/` and no legacy business renderer. |
| **Rust native tests, default environment** | `cargo test --locked --manifest-path sdk/native/Cargo.toml` | **11 passed, 3 FAILED** (exit 101) | Three smoke tests panic without `POCKET_TEST_ASSETS` and `POCKET_TEST_SOURCE` (P2-1). |
| **Rust full native tests with actual artifacts** | `POCKET_TEST_ASSETS=$PWD/demo/assets POCKET_TEST_SOURCE=$PWD/demo/js/.pocket-build/app.js cargo test --locked --manifest-path sdk/native/Cargo.toml` | **20 passed, 0 failed, 1 ignored** (exit 0) | All 14 `lib.rs` tests passed, including bytecode tampering, no source fallback, and five duplex checks. Six `duplex_layout.rs` tests passed. `throughput_report_lock_free_vs_mutex_baseline` was ignored. |
| **SDK TS/Bun suite, default environment** | `cd sdk && bun test` | **16 pass, 1 FAIL** (exit 1) | `build_guest.test.ts` (2), `tooling_scene.test.ts`, `android_scaffold.test.ts`, `package_update.test.ts` (10), `editor_server.test.ts` (4), `flutter_widgets.test.ts`, and `graphics.test.ts` passed. `flutter_widgets_native.test.ts` failed for missing `POCKET_WIDGET_FIXTURE_DIR` (P2-1). |
| **SDK `@pocket/ui` native Widget probe with temporary build output** | `POCKET_WIDGET_FIXTURE_OUTDIR=$TMP bun packages/pocket_ui/test/flutter_widgets.test.ts && POCKET_WIDGET_FIXTURE_DIR=$TMP bun test packages/pocket_ui/test/flutter_widgets_native.test.ts` | **PASS** (exit 0) | `pocket_probe` executed actual QuickJS bytecode to verify pointer callbacks, disabled hit rejection, and selected styling. |
| **Showcase JS unit tests** | `cd demo/js && bun test` | **11 pass, 0 fail** (exit 0) | `mobile_ui.test.ts` (4), `hardware_platform.test.ts` (2), and `guest_state.test.ts` (5). |
| **Showcase native QuickJS probe and ablation** | `cd demo/js && bun tests/native_guest_probe.ts --required && bun tests/guest_ablation.ts --required` | **PASS** (exit 0) | Actual `demo/assets/app.qjbc` and `app.pak` exercised first frame, pointer, text input, and 100/500-node stress. Bytecode changes altered the first frame. |
| **`pocket_flutter` default suite** | `cd sdk/packages/pocket_flutter && flutter test` | **36 passed, 1 SKIPPED** (exit 0) | Without `POCKET_NATIVE_LIBRARY`, `pocket_duplex_ffi_test.dart` was skipped. |
| **`pocket_flutter` native Duplex FFI with explicit dylib** | `cd sdk/packages/pocket_flutter && POCKET_NATIVE_LIBRARY=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/debug/libpocket_flutter.dylib flutter test test/pocket_duplex_ffi_test.dart` | **1 passed, 0 skipped** (exit 0) | Loaded actual `libpocket_flutter.dylib` and verified Dart FFI leaf calls plus Rust ABI v2 SPSC publish, consume, and close end-to-end. |
| **`pocket_services` unit tests** | `cd sdk/packages/pocket_services && flutter test` | **18 passed, 0 skipped** (exit 0) | Signature, concurrent `prepare`, downgrade refusal, bad package blacklist and rollback, path traversal defense, and plugin admission. |
| **Top-level `sdk` session integration** | `cd sdk && flutter test` | **4 passed, 0 skipped** (exit 0) | External plugins in `PocketSession`, lifecycle close, and retention through widget rebuilds. |
| **`demo` host and plugin tests** | `cd demo && flutter test` | **17 passed, 0 skipped** (exit 0) | `hardware_plugin_test.dart` (12) and `performance_history_test.dart` (5). |

### 5.2 Unverified areas

1. **Physical iOS and Android end-to-end acceptance was outside this read-only command-line run.**
   - Source review verified real OS calls in `PocketHardwareManager.swift`, `PocketHardwarePlugin.kt`, and `CameraHardware.kt`. Actual camera `FlutterTexture`/`SurfaceTextureEntry` cadence, CoreBluetooth and Android BLE advertisements, FaceID/BiometricPrompt UI, and iPhone physical keyboard opening animation still require connected devices.
2. **Full macOS host hot-update integration (`demo/integration_test/update_lifecycle_test.dart`).**
   - `demo/js/scripts/test_updates.ts` runs `dev_updates.ts setup`, rewrites artifacts in `demo/.pocket-updates`, and launches `flutter test -d macos`. The read-only audit skipped that workspace-writing script. `package_update.test.ts` and `plugin_admission_test.dart` verified the core update state machine and local HTTP service without workspace changes.
3. **Manual throughput benchmark.**
   - `throughput_report_lock_free_vs_mutex_baseline` at `sdk/native/tests/duplex_layout.rs:216-218` has `#[ignore = "manual throughput comparison"]` and did not run by default.
