# Pocket SDK Code and Runtime Evidence Audit (a5dd273)

- Audit checkout: `/Volumes/ORICO/Development/Github/pocket`, clean at HEAD `a5dd273`. The read-only audit changed or deleted no files or caches.
- Historical comparison: `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding `pocket_host/`. Comparison traced source only and did not run or rebuild the old project.

## Overall Assessment

At `a5dd273`, Pocket uses a thin Flutter host, real precompiled Rust rquickjs bytecode with PJSB v2 envelope, SHA-256, and QuickJS engine ABI checks, `@pocket/ui` Solid/PocketJS primitives, Ed25519-signed OTA, and native iOS/Android hardware plugins. The old Dart VDOM and pseudo-`.pjc` source packaging are absent.

Production path tracing found two P0 issues (duplex integration and permission isolation), five P1 issues (embedded build always zero, idle Ticker freezing JS timers, full-frame JSON serialization, Editor Origin/CSRF validation, and iOS single-slice overwrites), and four P2 issues.

1. The tested bidirectional lock-free SPSC channel (`duplex.rs` / `pocket_duplex.dart`) is absent from the PocketView, PocketSession, and Showcase production input and event loop. Pointer, text input, safe area, and host messages all still use JSON, from jsonEncode to pocket_send.
2. Plugin-level permission aggregation and an empty declaration for `hardware.permissions.request` can revoke an entire HardwarePlugin when an optional capability lacks permission and can even fail Guest startup. The same gaps let an unauthorized Guest trigger a system permission prompt or read GPS through weather without `hardware.location`.
3. The build pipeline reads build/version from guest-manifest.json, which holds only protocol and permissions. Build information is actually in editor.json. As a result, Demo metadata and CLI/Editor artifacts all load with embeddedBuild 0.

## 1. Findings by Priority

### P0-1: The lock-free SPSC channel remains outside production PocketView input and events

- Source locations
  - `pocket_view.dart:204-214` (`PocketViewController.send`)
  - `pocket_view.dart:1246-1275` (`_PocketViewState._reportSafeArea`)
  - `pocket_view.dart:2349-2378` (`_PocketViewState._sendPointer`)
  - `pocket_runtime.dart:273-306` (`FfiPocketRuntime._lookupDuplexBindings`)
  - `pocket_runtime.dart:365-375` (`FfiPocketRuntime.openDuplex`)
  - `lib.rs:1491-1498` (`drain_duplex` inside `build_frame`)
- Conditions — Run a PocketApp/PocketSession/PocketView app including Demo Showcase and drag, scroll, resize, or send host messages.
- Impact
  1. `duplex.rs:1-489`, `lib.rs:3276-3544`, and `pocket_duplex.dart:1-435` implement the ABI v2 `CachePadded<AtomicU32>` single-producer/single-consumer lock-free ring, generation isolation, and NativeFinalizer. No production call opens `runtime.openDuplex()`.
  2. Each high-frequency pointer (`_sendPointer`) and viewport event still allocates a Map, runs jsonEncode, copies UTF-8, calls pocket_send, and goes through Rust serde_json::from_str.
  3. `_lookupDuplexEndpointBindings` uses `isLeaf: true`. `FfiPocketRuntime._lookupDuplexBindings` omits it for `pocket_duplex_abi_version`, `pocket_duplex_message_size`, and `pocket_duplex_capacity`.
- Verification — Searching `sdk/` and `demo/` for openDuplex and PocketDuplexChannel found calls only at `pocket_duplex_test.dart:15-180` and `pocket_duplex_ffi_test.dart:55-115`.
- Proposed fix
  1. Call `_runtime.openDuplex()` after `_PocketViewState._boot` and successful reload, and call `close()` on the PocketDuplexEndpoint before dispose or reload.
  2. Use `PocketDuplexEndpoint.publishIngress` for high-frequency numeric signals such as pointer move/down/up. Run drainEgress after each tick to dispatch Guest `__pocketEmitDuplex` messages. Add `isLeaf: true` in `_lookupDuplexBindings`.

### P0-2: Aggregated plugin permissions can block an entire plugin and leave request and weather grants unenforced

- Source locations
  - `pocket_plugin.dart:484-568` (`PocketPluginManager.activate`)
  - `pocket_host.dart:164-221` (`PocketHost.guestAvailability`, `revokeCapabilities`)
  - `pocket_session.dart:188-243` (`PocketSession._configureBridge`)
  - `hardware_plugin.dart:136-271` (`HardwarePlugin`)
  - `hardware_plugin.dart:602-609` (`HardwarePlugin.weatherCurrent`)
- Conditions — The Guest declares required `hardware.permissions` and optional `hardware.camera.capture` in guest-manifest.json with incomplete permissions, or `PocketAppConfig.allowedPermissions` allows location and denies camera. The permission-request path lacks a target grant and the weather path reaches location when coordinates are absent.
- Impact
  1. `PocketPluginManager.activate` unions all grantedMethods permissions into requiredPermissions and checks `requiredCapability = names.any(availability.required.contains)`. A required capability such as permission-free `hardware.permissions` plus an optional camera without its grant fails Guest startup with `permission_not_declared` or `plugin_permission_denied`. With optional-only capabilities, `granted.removeAll(names); host.revokeCapabilities(names)` also revokes already-granted methods.
  2. `HardwareCapabilities.requestPermission` declares `const <String>{}` and requestPermission skips `_checkPermission(permission)`. `PocketSession._configureBridge` omits grantedPermissions when constructing HardwarePlugin, leaving `_grantedPermissions` null and disabling its production check. weatherCurrent declares only `HardwarePermissions.network`, yet invokes `_native('getCurrentLocation')` at lines 602-609 when coordinates are absent, bypassing the `hardware.location` gate.
  3. `PocketHost.revokeCapabilities` removes handlers from `_handlers` without updating `_availability`. `host.capabilitiesJson()` still reports the revoked capabilities as granted.
- Verification — Source tracing at `pocket_plugin.dart:489-559` and `pocket_session.dart:188-204` confirms the behavior.
- Proposed fix
  1. `PocketPluginManager.activate` checks `method.permissions ?? descriptor.permissions` for each PocketPluginMethod capability. Revoke only an optional capability lacking declarations or host admission. Skip plugin onActivate only if every capability is revoked.
  2. Update `_availability` in `PocketHost.revokeCapabilities`.
  3. Pass the intersection of manifest declarations and `config.allowedPermissions` as `HardwarePlugin(grantedPermissions: ...)` from `PocketSession._configureBridge`. Validate the target permission in requestPermission and require `HardwarePermissions.location` in weatherCurrent's no-coordinate branch.

### P1-1: Bytecode metadata omits project version and build, so embeddedBuild is always zero

- Source locations
  - `build_guest.ts:404-424`
  - `pocket.ts:505-521`
  - `app.bytecode.json:1-13`
  - `guest-manifest.json:1-44`
  - `pocket_session.dart:88-92`
  - `pocket_session.dart:165-173`
- Conditions — Build any project, including `demo/`, via `bun sdk/pocket.ts build`, `sdk/scripts/build_guest.ts`, or Editor. Start PocketSession and inspect runtime.info or the OTA minimumBuild gate.
- Impact
  1. `build_guest.ts:404-424` reads version and build only from manifest.json, written to guest-manifest.json. That manifest holds protocolVersion, capabilities, and permissions. editor.json / pocket.json hold the actual version and build.
  2. Generated `app.bytecode.json:1-13` contains neither version nor build.
  3. `PocketSession._initialize` parses embeddedBuild as 0. The first OTA on a fresh install has `minimumBuild == 0` and admits builds older than the embedded bundle. `PocketSession.status()` uses `'activeBuild': active?.build ?? 0` and `'build': 0`.
- Verification — `app.bytecode.json:1-13` contains entryFormat, kind, runtimeAbi, bindingGeneration, tickHz, bytecodeBytes, bytecodeSha256, pakBytes, pakSha256, contractSha256, and envelopeVersion.
- Proposed fix — If manifest.json lacks version/build, read editor.json / pocket.json in the same directory in `build_guest.ts:404-424` and emit both fields in app.bytecode.json. Store `_embeddedBuild` in PocketSession and use `active?.build ?? _embeddedBuild` in status().

### P1-2: Stopping Ticker after six unchanged frames freezes QuickJS timers and delayed animations

- Source locations
  - `pocket_view.dart:324-336` (`_wakeTicker`)
  - `pocket_view.dart:886-891` (`_onTick`)
  - `lib.rs:1483-1522` (`build_frame` advancing `__pocketAdvanceTime`)
- Conditions — After interaction or a host response, the Guest schedules setTimeout, setInterval, or debounced state for more than about 100ms (six frames at 60Hz). An independent PocketDuplexEndpoint send that bypasses PocketViewController.send can also miss a wakeup.
- Impact
  - QuickJS virtual time and timers depend on `__pocketAdvanceTime(dt)` inside each `pocket_frame_delta` call.
  - After six unchanged DrawLists (`idleFrames >= 6`), `_onTick` calls `_ticker?.stop()`. Until the next touch or active host bridge message, no `pocket_frame_delta` runs, leaving timers, polls, and delayed animations beyond 100ms suspended.
- Verification — `pocket_view.dart:886-891` and `lib.rs:1483-1522` expose neither the next timer deadline nor whether active animations or timers exist.
- Proposed fix — Report an active animation or time until the next timer as nextTimerMs in Rust FrameResult, delta, or a lightweight FFI getter. Keep Ticker on for active animations. When only a delayed timer remains, stop and schedule `Timer(Duration(milliseconds: nextTimerMs), _wakeTicker)` once.

### P1-3: Changed frames serialize the full DrawList and RGBA bytes as UTF-8 JSON

- Source locations
  - `lib.rs:1649-1696` (FrameResult and FrameResource)
  - `lib.rs:3219-3251` (frame_delta_json_for_host)
  - `pocket_runtime.dart:195-210` (FfiPocketRuntime.frameDeltaAt)
  - `pocket_model.dart:168-185` (PocketFrameResource.fromJson)
- Conditions — Scroll, animate routes at 60fps, render 500 stress nodes producing 1761 DrawOps, or load the first frame containing font or atlas textures.
- Impact
  - `pocket_frame_delta` returns `{"unchanged":true}` only when DrawList matches byte for byte and no events or new assets exist.
  - Changing one number or coordinate reserializes the full frame's DrawOps, allocating String then CString. The Dart UI thread calls `toDartString()` and `jsonDecode` to allocate thousands of Maps.
  - `serde_json` serializes `FrameResource.pixels: Vec<u8>` as decimal `[255,0,128,...]`. Dart converts each `(item as num).toInt()` back into Uint8List.
- Verification — `native_guest_probe.ts:500-530` measured 1761 JSON DrawOps for 500 nodes. `lib.rs:1669-1677` and `pocket_model.dart:175-182` confirm JSON pixel arrays.
- Proposed fix — Transfer pixels as an FFI binary pointer and length or base64, and move DrawOps to a compact binary buffer viewed through TypedData Float32List/Uint32List. Keep events on JSON or duplex.

### P1-4: Editor mutation endpoints accept requests without Origin validation

- Source locations
  - `server.ts:732-748` (validateRequestSecurity)
  - `server.ts:931-965` (POST /api/projects/:id/assets, /build, /publish)
- Conditions — A local Editor service is listening at 127.0.0.1:4680, and state-changing requests can arrive without an Origin header.
- Impact
  - `validateRequestSecurity` checks Origin only under `if (originHeader)`.
  - Build and publish routes do not call `readJson()` or enforce `Content-Type: application/json`. Asset upload accepts multipart/form-data. Without Origin, these routes can directly build, sign and publish with the local development key, or upload assets.
- Verification — Source trace at `server.ts:738-744` and `server.ts:931-965`.
- Proposed fix — Require a valid Origin for non-GET/HEAD mutations, or require a custom header such as `X-Pocket-Editor: 1` that forces a browser CORS preflight and Origin.

### P1-5: SDK requires hardware plugins, and iOS device and simulator libraries overwrite each other

- Source locations
  - `pubspec.yaml:11-16`
  - `pocket_sdk.dart:1-21`
  - `build_native.sh:33-50`
  - `pocket.ts:409-432`
- Conditions
  1. A Flutter consumer uses pocket_sdk with `enableHardware: false` and needs no camera, Bluetooth, location, or biometrics library.
  2. Switch between iOS device and simulator or share one `sdk/` across consumers.
- Impact
  1. `pubspec.yaml:11-16` unconditionally depends on pocket_hardware. Compile-time Flutter plugin registration then links camera, BLE, location, and sensors into every host.
  2. `build_native.sh:33-50` writes `aarch64-apple-ios` and `aarch64-apple-ios-sim` static archives to the same `packages/pocket_flutter/ios/Frameworks/libpocket_flutter.a`. Without XCFramework packaging, switching targets overwrites that file.
  3. `pocket.ts:414` writes the build stamp to shared `sdk/.pocket-build/sdk-native/current.json`.
- Verification — `build_native.sh:33-50` and `pubspec.yaml:11-16`.
- Proposed fix — Make pocket_hardware an optional extension or keep pocket_sdk dependent only on pocket_flutter and pocket_services. Build `pocket_flutter.xcframework` with ios-arm64 and ios-arm64_x86_64-simulator slices.

### P2-1: Cargo and Bun tests fail when environment prerequisites are absent

- Source locations
  - `lib.rs:3978-3992` (smoke_tests require POCKET_TEST_ASSETS and POCKET_TEST_SOURCE)
  - `flutter_widgets_native.test.ts:22-26` (requires POCKET_WIDGET_FIXTURE_DIR)
  - `package.json:13-21` (no top-level `"test"` script)
- Conditions — Run `cargo test` in `sdk/native` or `bun test` / `bun run test` in `sdk/`.
- Impact — Cargo fails three cases with a NotPresent panic. Bun fails one if POCKET_WIDGET_FIXTURE_DIR is unset. `bun run test` exits because the `"test"` script is missing.
- Verification — See actual outputs in section 5.
- Proposed fix — In `flutter_widgets_native.test.ts`, call `build_guest.ts` to build test/fixture into a temp directory when POCKET_WIDGET_FIXTURE_DIR is absent. Add a full-suite `"test"` script to `sdk/package.json`.

### P2-2: graphics.ts emits legacy line and arc operations disconnected from rendering

- Source locations
  - `graphics.ts:1-200`
  - `index.ts:29-37`
- Conditions — A consumer imports `compute3dMechaFrame` or `compute2dParticleFrame` from `@pocket/ui`.
- Impact — These functions return `{ op: "line", ... }` and `{ op: "arc", ... }` for the old C sandbox's OP_LINE/OP_ARC. Current Rust DrawOp and Flutter PocketCanvasPainter have no line or arc primitives, so the ops cannot render.
- Verification — Searches in `sdk/native` and `sdk/packages/pocket_flutter` found zero `"line"` or `"arc"` paint branches. `demo/js/` does not use the file.
- Proposed fix — Remove both functions from `@pocket/ui` or make them emit supported View/CanvasBlock nodes. Keep used icon definitions.

### P2-3: Camera preview hostSurface has rectangular clipping and limited overlapping composition

- Source locations
  - `pocket_view.dart:1185-1203` (_buildSurfaceOverlay)
  - `pocket_view.dart:2762-2794` (_splitCanvasBlocks)
- Conditions — A camera preview uses hostSurface → Flutter Texture. `_splitCanvasBlocks` places later DrawOps, such as a BottomSheet or modal, into CustomPaint layers above it.
- Impact — Ordering works, but each hostSurface splits CustomPaint into another `_CanvasBlock` widget. Multiple hostSurfaces create multiple full-size CustomPaints. The hostSurface clipRect uses rectangular ClipRect and lacks rounded ClipRRect.
- Verification — `pocket_view.dart:1187-1203` uses ClipRect only.
- Proposed fix — Carry container radius in the hostSurface DrawOp and use ClipRRect in `_buildSurfaceOverlay` when radius > 0.

### P2-4: iOS deep links require SceneDelegate patching instead of automatic plugin registration

- Source locations
  - `pocket.ts:238-320` (patchIosSceneDelegate)
  - `PocketHardwarePlugin.swift:1-35`
- Conditions — An existing Flutter project adds pocket_sdk through pubspec / `flutter pub add` without applying `bun pocket.ts init/build` patches to `ios/Runner/SceneDelegate.swift`.
- Impact — The iOS deep-link path requires SceneDelegate.swift to call `PocketHardwareManager.shared.handleIncomingDeepLink(url)`. Projects without the patch receive no links.
- Verification — `PocketHardwarePlugin.swift:1-35` and `pocket.ts:238-320`.
- Proposed fix — Implement `FlutterApplicationLifeCycleDelegate` `application(_:open:options:)` and Universal Links callbacks in `PocketHardwarePlugin.swift:1-35`, auto-register with `registrar.addApplicationDelegate(instance)`, and retain SceneDelegate patching as an optional enhancement.

## 2. Capability Matrix

| Capability | Public API | Production Path | iOS | Android | Test Evidence | Remaining Gaps |
| --- | --- | --- | --- | --- | --- | --- |
| 1. SDK integration and scaffolding | `pocket_sdk.dart:1-21` (PocketApp, PocketGuest, PocketSession), `pocket.ts:1-600` (init and build) | PocketApp → PocketSession → PocketView, PocketHost, PocketPluginManager, PocketUpdateCoordinator | Verified idempotent Podfile, Info.plist, and SceneDelegate patches | Verified idempotent AndroidManifest permission and minSdk patches | `check_architecture.py`, `tooling_scene.test.ts`, `android_scaffold.test.ts`, and `session_integration_test.dart` passed | Required pocket_hardware dependency and missing XCFramework packaging (P1-5) |
| 2. Precompiled QuickJS bytecode and PAK | `build_guest.ts:1-457`, `pocketjs_bytecode.rs:1-165`, PocketBytecodeArtifact | TS/TSX → two-stage PocketJS compilation → app.pak and app.js → rquickjs Context::compile → PJSB v2 app.qjbc → pocket_load_bytecode_files validates magic, SHA-256, and engine ABI before execution, with no JS source fallback | Real QuickJS bytecode, distinct from machine-code AOT and envelope-wrapped source | Same as iOS | Cargo rejects tampering, truncation, and ABI mismatch. `guest_ablation.ts` proved changing bytecode changes first-frame output. | `build_guest.ts` omits editor.json version/build from app.bytecode.json (P1-1) |
| 3. OTA and version control | PocketUpdateCoordinator, PocketPackageStore, `serve_updates.ts:1-120` | checkAndDownload → Ed25519 and AppId/Channel/ABI/Build admission → per-entry download and SHA-256 verification → reassemble PAK → atomically switch current.json/previous.json → reloadGuest → commitHealthy after first frame, or rollback and blacklist bad build | Supported | Supported | `package_update.test.ts` (10), `security_and_plugins_test.dart`, and `plugin_admission_test.dart` passed | P1-1 leaves initial embeddedBuild and first-update minimumBuild at 0 |
| 4. External plugins and permission admission | PocketPlugin, PocketPluginManager | PocketAppConfig.plugins → PocketPluginManager.activate → check guest-manifest.json capabilities/permissions and host allowedPermissions → register PocketHost handler | Supported | Supported | `plugin_admission_test.dart` and `session_integration_test.dart` passed | Aggregated permissions and stale host.guestAvailability after revokeCapabilities (P0-2) |
| 5. Camera, photos, and QR | `hardware.camera.previewStart`, Stop, SwitchLens, Capture, QrScan, `hardware.photos.save`, `hardware.media.pickImages` | JS requestHost → HardwarePlugin → MethodChannel pocket.dev/hardware → native texture registry and authorizeSurface("hardware.camera", textureId) → PocketView Texture | `PocketHardwareManager.swift:240-620` uses AVCaptureSession, FlutterTexture, VNDetectBarcodesRequest, PHPhotoLibrary, and PHPickerViewController | `CameraHardware.kt:1-695` uses Camera2, SurfaceTextureEntry, MLKit/ZXing scanning, MediaStore, and ActivityResultContracts.PickMultipleVisualMedia | `hardware_plugin_test.dart` (12) and `pocket_surface_test.dart` passed, including rejection of late textures after disable | Physical camera textures and prompts need iOS/Android tests. hostSurface clips rectangularly (P2-3). |
| 6. Location, weather, sensors, BLE, biometrics, secure storage, and audio | `hardware.location.current`, `hardware.weather.current`, `hardware.sensors.sample`, `hardware.ble.scan`, `hardware.biometrics.authenticate`, `hardware.storage.*`, `hardware.audio.recordSample` | JS requestHost → HardwarePlugin → MethodChannel pocket.dev/hardware. Dart HttpClient calls real Open-Meteo with native GPS/barometer as needed. | CLLocationManager, CMMotionManager/CMAltimeter, CBCentralManager, LAContext, Keychain, and AVAudioRecorder, with structured unsupported errors | LocationManager, SensorManager, BluetoothLeScanner, BiometricPrompt, EncryptedSharedPreferences/Keystore, and AudioRecord, with structured unsupported errors | `hardware_plugin_test.dart` and `hardware_platform.test.ts` passed | Missing target permission checks in hardware.permissions.request and location gate in coordinate-free weather.current (P0-2) |
| 7. JS UI and Liquid Glass | `@pocket/ui` (`mobile.tsx` has 38 mobile components, plus `flutter-widgets.tsx` and `theme.ts`) | Solid JSX → `@pocketjs/framework` layout → Rust DrawOp (rect, text, image, tileset, texQuad, filter, hostSurface, textInput) → Flutter PocketCanvasPainter | Supported without a second Dart VDOM | Same as iOS | `mobile_ui.test.ts`, `flutter_widgets.test.ts`, `flutter_widgets_native.test.ts`, and `pocket_renderer_test.dart` passed | graphics.ts mecha/particle functions emit ops disconnected from rendering (P2-2) |
| 8. System input and adaptive Duo/foldable geometry | `<Input>` through textInput DrawOp and `_PocketViewState`, DisplayGeometry via viewport.safeArea | Rust collects input geometry/style → transparent Flutter TextField accepts system IME, Chinese composing, selection, clipboard → input.change/input.submit return to JS. MediaQuery safeArea/hinge/displayFeatures merge into viewport.safeArea. | Keyboard avoidance and composing protection preserve focus | Foldable hinge and two-column adaptation | `pocket_view_test.dart` (8, including UTF-16, upstream affinity, composing, and focus during keyboard open) and `mobile_ui.test.ts` passed | Physical rotation and dual-screen opening/closing smoothness require load tests |
| 9. Scheduling and performance | PocketPerformanceTracker, pocket_frame_delta | Flutter Ticker → pocket_frame_delta, automatic stop after six unchanged frames. SchedulerBinding.addTimingsCallback samples actual frame timing and distinguishes idle gaps from missed frames. | Supported | Supported | `pocket_performance_test.dart` and `performance_history_test.dart` passed | No timer wake after stopping (P1-2). Changed frames still serialize full DrawList and pixels as JSON (P1-3). |
| 10. Bidirectional lock-free SPSC | Rust `duplex.rs:1-489`, Dart PocketDuplexChannel and runtime.openDuplex(), JS `__pocketOnDuplex` and `__pocketEmitDuplex` | PocketDuplexEndpoint → FFI isLeaf reserve/commit with Acquire/Release ordering, Arc lifetime, and generation isolation → drain_duplex in build_frame → QuickJS callback | Native and FFI ready, production UI disconnected | Same as iOS | `duplex_layout.rs` (6 concurrent/wraparound/race cases), `lib.rs` (5 duplex integrations), `pocket_duplex_test.dart`, and `pocket_duplex_ffi_test.dart` passed | No production PocketView input or event-loop integration (P0-1) |
| 11. Editor and OTA publishing | `server.ts:1-1007` | Loopback HTTP → project creation/registration of an external project → real build_guest.ts QJBC compile → package_update.ts Ed25519 signing and publication → serve /updates/:channel/latest.json and /blobs/:sha256 | Development service end-to-end | Same as iOS | `editor_server.test.ts` four end-to-end tests passed | Missing Origin validation permits cross-site build, publish, and asset mutations (P1-4) |

## 3. Reused and Missing Techniques from the Legacy Project

The comparison used `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` and excluded `pocket_host/`.

### 3.1 Reused in Production

1. **Native hardware bridge** — PocketRealHardwareManager → `PocketHardwareManager.swift:1-1103` and matching Android implementation.
   - The old project implemented iOS hardware in AppDelegate.swift and `real_hardware_bridge.dart:68-549`, with a silent granted fallback on error, such as `hwRequestPermission(..., grant: true)` at line 119.
   - The SDK reused AVCaptureSession/FlutterTexture camera, scanning, photos, CoreLocation, CoreMotion/barometer, CoreBluetooth, LocalAuthentication, Keychain, AVAudioRecorder, and live Open-Meteo weather. It added equivalent Android Camera2, BLE, sensors, and biometrics, and removed fabricated success.
2. **Mobile design system, Liquid Glass, and four transition curves** — `pocketjs_uikit.js` and `pocket_syslib_router.js` → `mobile.tsx:1-501`.
   - The SDK retained light/dark tokens, Liquid Glass highlight and refraction parameters, and ios_spring_parallax, shared_axis_z, liquid_glass_morph, and portal_expand. JS drives real PocketJS nodes directly without a Dart widget interpreter.
3. **Demand rendering and actual frame timing** — `perf_monitor.dart:29-130` → `pocket_performance.dart:1-210`.
   - The SDK kept SchedulerBinding.addTimingsCallback sampling and idle suspension and removed hardcoded promotional text and fabricated history initialized at 60.0.

### 3.2 Ported Interfaces Without Production Integration

1. **Bidirectional lock-free SPSC ring** — Legacy `pocket_runtime_multi.h:78-97` → current `duplex.rs:1-489` and `pocket_duplex.dart:1-435`.
   - Legacy PocketSharedDuplexChannel copied ordinary non-atomic structs. Rust implements a genuine ring with CachePadded<AtomicU32>, Acquire/Release ordering, exclusive SPSC roles, and Arc lifetime protection, connected to rquickjs `__pocketOnDuplex` and `__pocketEmitDuplex`.
   - P0-1 records that PocketView and Showcase do not call `runtime.openDuplex()`. Production events still use JSON.
2. **Graphics helpers and SVG definitions** — Legacy `pocket_syslib_graphics.js` → current `graphics.ts:1-200`.
   - P2-2 records that only unit tests call compute3dMechaFrame and compute2dParticleFrame. Rust/Flutter has no consumer for their line and arc outputs.

### 3.3 Legacy Techniques Still Missing or Incomplete

1. **Compact binary DrawList transport** — The legacy C-to-Dart path used fixed-size BinaryDrawCmd buffers in `pocket_runtime_multi.c:8-17` even without a real JS engine. Changed SDK frames still serialize full DrawOps and texture pixels as UTF-8 JSON (P1-3). A binary DrawList and zero-copy pixel view would remove that transport overhead on complex dynamic pages.
2. **Framework support for freeze-on-push and scroll retention** — The legacy host tracked frozen pages and restored scroll offsets. JS owns routing in Pocket, but `@pocket/ui` lacks a ready-to-use multi-level page stack that keeps background layout and ScrollView offset alive while excluding those pages from per-frame diff work.

### 3.4 Excluded Legacy Mocks and Duplicate Implementations

1. **Pseudo-`.pjc` compiler** — `compile_pocket_syslib_aot.py:41-125` removed JS comments with regex and prepended a 52-byte PJCA header. Build-time Node.js emitted static VDOM JSON in `syslib_flutter_ui_vdom.aot.json`. Real QuickJS PJSB compilation replaced it.
2. **C state-array sandbox** — `pocket_runtime_multi.c:19-142` linked no QuickJS and simulated nodes and sandbox state through global C arrays. The SDK excludes it.
3. **Second Dart VDOM and 4000-line host business renderer** — `pocket_ui_components.dart:1-120` and `pocketjs_bundle_runner.dart:1-120` hardcoded page blueprints and Flutter widget mapping in Dart, conflicting with the thin host. The SDK removed it and checks the boundary with `check_architecture.py`.
4. **Fabricated hardware grants** — `real_hardware_bridge.dart:119` returned `grant: true` and mock data after errors or unsupported simulator calls. The SDK returns structured errors.

## 4. Redundant Implementations and Ablation Tests

| No. | Location | Redundancy | Change | Acceptance |
| --- | --- | --- | --- | --- |
| 1 | `graphics.ts:88-200` compute3dMechaFrame and compute2dParticleFrame, plus `graphics.test.ts:1-40` | Ported from `pocket_syslib_graphics.js`. Rust and PocketCanvasPainter consume neither `{ op: "line" }` nor `{ op: "arc" }`. Demo JS does not use them. | Remove both helpers and their exported types, or keep only POCKET_SVG_ICON_SPECS. | Build `demo/js` with `bun sdk/scripts/build_guest.ts`, run `bun test` and `native_guest_probe.ts --required`, and verify identical build artifacts and rendered frames. |
| 2 | FfiPocketRuntime full frameAt/pocket_frame and frameDeltaAt/pocket_frame_delta | Production PocketView._onTick uses only pocketFrameDeltaAt. The two native calls return identical full JSON on changes. | Make frameAt a thin wrapper over frameDeltaAt or keep one FFI frame pull entry point and parameterize skipping unchanged frames. | Remove dedicated pocket_frame FFI binding and pass `flutter test` for pocket_flutter, sdk, and demo. |
| 3 | `pocket.ts:505-521` generates editor.json and guest-manifest.json | version/build/appId/channel belong to editor.json, while capabilities/permissions are in guest-manifest.json. The split causes P1-1 when build_guest.ts cannot find build. | Use guest-manifest.json or one pocket.json as the shared source of version/build and capabilities/permissions for build_guest.ts and package_update.ts. | Run `bun test scripts/tests/package_update.test.ts` and `editor/test/editor_server.test.ts`. Verify nonzero build and correct version in app.bytecode.json. |

## 5. Actual Checks, Results, and Coverage Gaps

The read-only audit ran in `/Volumes/ORICO/Development/Github/pocket` at `a5dd273`. Default runs, explicit environment runs, and skips are recorded separately. Skipped cases did not count as passes.

### 5.1 Executed Commands and Results

| Check | Command | Result | Evidence |
| --- | --- | --- | --- |
| Static architecture guard | `cd sdk && python3 scripts/check_architecture.py` | PASS (exit 0) | No SDK reverse dependency on demo/ or legacy business renderer. |
| Native Rust tests, default environment | `cargo test --locked --manifest-path sdk/native/Cargo.toml` | 11 passed, 3 failed (exit 101) | Three smoke tests panic without POCKET_TEST_ASSETS and POCKET_TEST_SOURCE (P2-1). |
| Native Rust tests, real artifact paths | `POCKET_TEST_ASSETS=$PWD/demo/assets POCKET_TEST_SOURCE=$PWD/demo/js/.pocket-build/app.js cargo test --locked --manifest-path sdk/native/Cargo.toml` | 20 passed, 0 failed, 1 ignored (exit 0) | All 14 lib.rs cases passed, including tamper resistance, no source fallback, and five duplex cases. Six duplex_layout.rs cases passed. Manual `throughput_report_lock_free_vs_mutex_baseline` was ignored. |
| SDK TS/Bun, default | `cd sdk && bun test` | 16 pass, 1 fail (exit 1) | Passing files: build_guest.test.ts (2), tooling_scene.test.ts, android_scaffold.test.ts, package_update.test.ts (10), editor_server.test.ts (4), flutter_widgets.test.ts, graphics.test.ts. flutter_widgets_native.test.ts failed for missing POCKET_WIDGET_FIXTURE_DIR (P2-1). |
| Native `@pocket/ui` widget probe, temporary fixture | `POCKET_WIDGET_FIXTURE_OUTDIR=$TMP bun packages/pocket_ui/test/flutter_widgets.test.ts && POCKET_WIDGET_FIXTURE_DIR=$TMP bun test packages/pocket_ui/test/flutter_widgets_native.test.ts` | PASS (exit 0) | Real QuickJS bytecode in pocket_probe verified pointer callbacks, disabled interception, and selected styles. |
| Showcase JS unit tests | `cd demo/js && bun test` | 11 pass, 0 fail (exit 0) | mobile_ui.test.ts (4), hardware_platform.test.ts (2), guest_state.test.ts (5). |
| Showcase native QuickJS probe and ablation | `cd demo/js && bun tests/native_guest_probe.ts --required && bun tests/guest_ablation.ts --required` | PASS (exit 0) | Loaded actual demo/assets/app.qjbc and app.pak, ran first frame, pointer, input, and 100/500-node stress. Modified bytecode changed first-frame output. |
| pocket_flutter tests, default | `cd sdk/packages/pocket_flutter && flutter test` | 36 passed, 1 skipped (exit 0) | pocket_duplex_ffi_test.dart skipped when POCKET_NATIVE_LIBRARY was unset. |
| pocket_flutter duplex FFI, explicit dylib | `cd sdk/packages/pocket_flutter && POCKET_NATIVE_LIBRARY=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/debug/libpocket_flutter.dylib flutter test test/pocket_duplex_ffi_test.dart` | 1 passed, 0 skipped (exit 0) | Loaded real libpocket_flutter.dylib. Dart FFI leaf call and Rust ABI v2 SPSC publish, consume, and close worked end to end. |
| pocket_services unit tests | `cd sdk/packages/pocket_services && flutter test` | 18 passed, 0 skipped (exit 0) | Signature validation, concurrent prepare, downgrade prevention, blacklist rollback, traversal rejection, plugin admission. |
| Top-level SDK session integration | `cd sdk && flutter test` | 4 passed, 0 skipped (exit 0) | External PocketSession plugins, lifecycle closure, and state retention across widget rebuild. |
| Demo host and hardware tests | `cd demo && flutter test` | 17 passed, 0 skipped (exit 0) | hardware_plugin_test.dart (12) and performance_history_test.dart (5). |

### 5.2 Coverage Gaps and Uncertainty

1. **Physical iOS and Android end to end** — Source tracing verified real OS APIs in `PocketHardwareManager.swift:1-1103`, `PocketHardwarePlugin.kt:1-1106`, and `CameraHardware.kt:1-695`. Connected iOS and Android hardware is still needed to accept FlutterTexture/SurfaceTextureEntry frame rates, CoreBluetooth/Android BLE advertisements, FaceID/BiometricPrompt, and iPhone keyboard animation.
2. **Full macOS OTA integration** — `demo/integration_test/update_lifecycle_test.dart` uses `test_updates.ts:38-52`, which calls `dev_updates.ts setup`, rewrites artifacts under `demo/.pocket-updates`, and runs `flutter test -d macos`. This read-only audit excluded the script because it would write into the workspace. Side-effect-free `package_update.test.ts` and `plugin_admission_test.dart` verified the OTA state machine and local HTTP update service.
3. **Manual throughput benchmark** — `throughput_report_lock_free_vs_mutex_baseline` at `duplex_layout.rs:216-218` is marked `#[ignore = "manual throughput comparison"]` and did not run by default.
