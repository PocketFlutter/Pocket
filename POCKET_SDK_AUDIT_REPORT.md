# Independent Pocket SDK Code and Runtime Evidence Audit

- **Audit scope** — `/Volumes/ORICO/Development/Github/pocket`, including `sdk/`, `demo/`, and `demo/js/`.
- **Audit date** — 2026-11-02.
- **Method** — Line-by-line source tracing, clean rebuilds with caches removed, integration with temporary consumer projects, targeted regression tests, and security probes. Production source and running services stayed intact, and the audit neither read nor exposed private keys or credentials.

---

## 1. Overall Assessment

### 1. Suitable Uses at the Time of Audit
- **Internal architecture verification and macOS/iOS Simulator prototyping**
  - The rendering pipeline is real. [`demo/lib/main.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/lib/main.dart#L1-L26) is a 26-line thin Flutter host. Showcase routing, state, component composition, animation, and theme execute in JS ([`demo/js/app.tsx`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/app.tsx#L1-L828) and [`demo/js/state.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/state.ts#L1-L654)), compile to real `.qjbc` bytecode with pinned `rquickjs 0.9.0` / QuickJS `2025-04-26` and bytecode version `26`, and produce a binary DrawList (`PJDL` v1) through Rust FFI, which Flutter paints with [`PocketCanvasPainter`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L1318-L1487).
  - CLI, Editor, and build scripts all reuse [`buildGuest`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/scripts/build_guest.ts#L316-L461). The audit found no separate bundlers.

### 2. Gaps Before Public SDK Reuse and Release
1. **Incomplete cross-platform build and integration (blocker)**
   - [`sdk/packages/pocket_flutter/android/build.gradle`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/android/build.gradle#L1-L19) is an unfinished stub missing the `com.android.library` plugin, the `android {}` block, and JNI artifacts. Consumer `flutter build apk` throws `NullPointerException`. [`sdk/pocket.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L307-L328) also lacks `--platform=android`.
   - Clean `build_native.sh macos` under Xcode 27.2 fails because the global `MACOSX_DEPLOYMENT_TARGET=12.0` setting reaches the host proc-macro and produces an unaligned LINKEDIT offset in `libserde_derive.dylib`. Prior local success reused `minos 11.0` `libserde_derive` from the `ios-sim` build.
   - [`README.md`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/README.md#L14) and [`sdk/README.md`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/README.md#L12-L13) document space-separated `--sdk-root <dir>`. [`pocket.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L69-L93) rejects it.
2. **Host lifecycle and hardware compliance coupling (blocker)**
   - [`PocketGuest`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_app.dart#L31-L34) uses `ValueKey(config)`. [`PocketAppConfig`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_config.dart#L38-L73) lacks `==` and `hashCode`. Rebuilding a consumer parent with `setState` and a non-`const` config immediately destroys and recreates the QuickJS runtime, losing page state.
   - [`sdk/pubspec.yaml`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pubspec.yaml#L15-L16) directly depends on and exports all of `pocket_hardware`. Even `enableHardware: false` links `AVFoundation`, `CoreBluetooth`, `CoreLocation`, `CoreMotion`, `Photos`, and `LocalAuthentication` into iOS binaries, triggering App Store static-scan rejection (ITMS-90683).
3. **OTA update lifecycle and versioning defects (blocker)**
   - No increasing `build` check prevents downgrade, no mechanism prefers a newer App Store embedded build over old OTA cache, and automatic fallback points `previous` to the broken package, allowing `rollback()` to reactivate it.
4. **High-frequency idle work and misleading performance metrics (high priority)**
   - [`PocketView`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L571-L576) keeps its `Ticker` running at 60/120Hz with a static page. Rust [`build_frame`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/native/src/lib.rs#L1361-L1475) always runs `relayout_outputs` and deep-copies the node tree and DrawList on every frame. This increases heat and power use and leads [`PocketPerformanceWindow`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_performance.dart#L24-L64) to count many `unchanged` idle ticks as 60 FPS.
5. **Missing local Editor service security boundaries (high priority)**
   - [`sdk/editor/server.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/editor/server.ts#L125-L136) skips Origin, CSRF, and Host validation and ignores `Content-Type`. A browser can make cross-site requests to create or overwrite projects, alter `POCKET_UPDATE_URL`, or trigger builds. Multiple endpoints also omit symlink containment checks.

---

## 2. Confirmed Defects by Severity

### P0 / Critical

#### 1. The unfinished Android plugin prevents building projects generated by `pocket init`
- **Source locations**
  - [`sdk/packages/pocket_flutter/android/build.gradle`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/android/build.gradle#L1-L19)
  - [`sdk/packages/pocket_flutter/pubspec.yaml`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/pubspec.yaml#L20-L24)
  - [`sdk/pocket.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L307-L328), [`sdk/pocket.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L516-L523)
  - [`sdk/scripts/build_native.sh`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/scripts/build_native.sh#L11-L40)
- **Conditions** — Run `flutter build apk` in any Flutter project initialized with `bun sdk/pocket.ts init`, or run `bun sdk/pocket.ts build --platform=android`.
- **Cause and impact**
  1. `pocket_flutter/pubspec.yaml` declares `android: ffiPlugin: true`, but `android/build.gradle` contains 19 lines of `group`, `version`, and `buildscript` with no `com.android.library` plugin or `android { namespace ... compileSdk ... }` block. Gradle throws `java.lang.NullPointerException` while configuring `:pocket_flutter`.
  2. `pocket_flutter/android/src/main/jniLibs` does not exist. `build_native.sh` and `pocket.ts` support only `macos | ios | ios-sim` and provide no Android NDK cross-compilation.
- **Verification**
  - `flutter build apk --debug` in a temporary project initialized under `/tmp/pocket-audit-sdk` returned:
    ```text
    FAILURE: Build failed with an exception.
    * What went wrong:
    A problem occurred configuring project ':pocket_flutter'.
    > java.lang.NullPointerException (no error message)
    ```
  - `bun sdk/pocket.ts build my-app --platform=android` returned `pocket: unsupported platform: android`.
- **Minimal proposed fix**
  - If Android support is deferred, remove the `android` declarations from [`sdk/packages/pocket_flutter/pubspec.yaml`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/pubspec.yaml#L22-L23) and [`sdk/packages/pocket_hardware/pubspec.yaml`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_hardware/pubspec.yaml#L18-L20) and document iOS/macOS support. For Android support, complete `android/build.gradle` with `com.android.library` and add `cargo-ndk` build scripts for `jniLibs`.

---

#### 2. Clean `build_native.sh macos` fails when `MACOSX_DEPLOYMENT_TARGET=12.0` reaches the host proc-macro
- **Source locations**
  - [`sdk/scripts/build_native.sh`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/scripts/build_native.sh#L16-L19)
  - [`sdk/pocket.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L318-L320)
- **Conditions** — Run `./scripts/build_native.sh macos` or `bun sdk/pocket.ts build <dir> --platform=macos` without a `native/target` cache, using macOS and Xcode 27.2 `ld`.
- **Cause and impact**
  - Line 17 of `build_native.sh` globally exports `MACOSX_DEPLOYMENT_TARGET=12.0`. When Cargo builds host `serde_derive` from scratch, `ld` combines `minos 12.0` with SDK `27.2` and produces a `__LINKEDIT` string pool with insufficient eight-byte alignment (`fileOffset=0x00240FC4`). `rustc` crashes in `dlopen(libserde_derive-*.dylib)`.
  - Existing caches hid the failure. An earlier `ios-sim` run left `MACOSX_DEPLOYMENT_TARGET` unset and compiled host `libserde_derive-*.dylib` at `minos 11.0` in `native/target/release/deps/`. The macOS build reused it.
- **Verification**
  - `MACOSX_DEPLOYMENT_TARGET=12.0 cargo build --locked --release --manifest-path native/Cargo.toml --target aarch64-apple-darwin` in a temporary checkout without `native/target` returned:
    ```text
    error: .../libserde_derive-c4b741ffcf03759b.dylib: mach-o file, but is an incompatible architecture (have 'arm64', need 'arm64e' or 'arm64'): mis-aligned LINKEDIT string pool, fileOffset=0x00240FC4
    ```
  - Removing the global `MACOSX_DEPLOYMENT_TARGET=12.0` or using target-only `CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS="-C link-arg=-mmacosx-version-min=12.0"` let a clean build complete in 11.1 seconds.
- **Minimal proposed fix**
  - In [`sdk/scripts/build_native.sh`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/scripts/build_native.sh#L17), replace the global export with target-specific `CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS` or `CARGO_TARGET_X86_64_APPLE_DARWIN_RUSTFLAGS`, or enable `resolver = "2"` in `Cargo.toml` to isolate host proc-macro and target environments.

---

#### 3. `PocketGuest` keys sessions by a config lacking value equality, so parent rebuilds destroy the JS runtime
- **Source locations**
  - [`sdk/lib/src/pocket_app.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_app.dart#L31-L34), [`sdk/lib/src/pocket_app.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_app.dart#L92-L100)
  - [`sdk/lib/src/pocket_config.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_config.dart#L9-L73)
- **Conditions** — A custom Flutter page embeds [`PocketGuest`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_app.dart#L22-L35) and passes a non-`const` `PocketAppConfig(...)` from `build()`. Examples include `capabilities: {'hardware.sensors'}`, `plugins: [...]`, and `PocketUpdateConfig` with runtime values. Parent `setState`, theme changes, or route animations cause a rebuild.
- **Cause and impact**
  - `PocketGuest.build` returns `_PocketGuestSession(key: ValueKey<PocketAppConfig>(config), config: config)`.
  - `PocketAppConfig` and `PocketUpdateConfig` use reference equality because neither overrides `operator ==` or `hashCode`. A new `PocketAppConfig` on each parent widget build changes the key. Flutter destroys old `_PocketGuestSessionState`, calls `session.dispose()` to destroy the QuickJS VM, initializes a new session, and loses all JS state.
- **Verification**
  - A minimal widget test pumped two field-identical non-`const` `PocketAppConfig(appId: 'dev.example.app')` values. `expect(identical(firstState, secondState), isTrue)` for the two `_PocketGuestSession` state instances failed with `Actual: <false>`.
- **Minimal proposed fix**
  - Remove `key: ValueKey<PocketAppConfig>(config)` in [`sdk/lib/src/pocket_app.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_app.dart#L32). In [`_PocketGuestSessionState.didUpdateWidget`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_app.dart#L92-L100), compare fields, using `setEquals` or `listEquals` for collections, to decide when to rebuild `PocketSession`.

---

#### 4. OTA can downgrade, override a newer App Store build, and reactivate failed packages during rollback
- **Source locations**
  - Missing downgrade protection. [`sdk/packages/pocket_services/lib/src/pocket_update.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_services/lib/src/pocket_update.dart#L210-L325) and [`sdk/packages/pocket_services/lib/src/pocket_package.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_services/lib/src/pocket_package.dart#L984-L1035)
  - Old OTA overrides a newly installed bundle. [`sdk/lib/src/pocket_session.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_session.dart#L114-L163)
  - The broken package remains at `previous`. [`sdk/lib/src/pocket_session.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_session.dart#L263-L268), [`sdk/lib/src/pocket_session.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_session.dart#L452-L460), and [`sdk/packages/pocket_services/lib/src/pocket_package.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_services/lib/src/pocket_package.dart#L738-L754)
- **Conditions**
  1. **Replay or downgrade** — The update origin, a reverted CDN cache, or replay of a historically valid signed package returns a signed manifest with a lower `build`.
  2. **Old OTA after an App Store upgrade** — The app previously updated OTA to `1.0.1+2`, and the user then upgrades through the App Store to `1.1.0+10`. `runtimeAbi` is unchanged and embedded `assets/app.qjbc` is new.
  3. **Manual rollback after automatic fallback** — Healthy `v1` upgrades to `v2` and clears the one-second health window (`active=v2, previous=v1`). A user interaction causes a runtime error in `v2`. `PocketView.onError` remounts `v1`, `commitHealthy(v1)` runs after one second, and the user then calls `rollback()`.
- **Cause and impact**
  1. `PocketUpdateCoordinator.prepare` checks signature, hash, `appId`, and `runtimeAbi`. It never compares `manifest.payload.build` with the active `build`, so older packages can replace newer ones.
  2. At startup, `PocketSession.initialize` always prefers `updates.lastGood()` (line 114). Embedded `assets/app.bytecode.json` has no `build`. As long as `runtimeAbi` matches, the newer App Store JS never activates.
  3. `commitHealthy(versionId)` calls `await _writePointer(_previousFile, currentActive)` whenever `currentActive != version.versionId`. During fallback from promoted broken `v2` to `v1`, `currentActive` is still `v2`. A second later `commitHealthy(v1)` stores broken `v2` as `previous`. A subsequent `rollback()` makes it both `active` and `lastGood`. [`pocket_package.dart:747-749`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_services/lib/src/pocket_package.dart#L747-L749)
- **Verification**
  - Three unit cases in an isolated test copy used `flutter test`: R1, R6, and R8.
    - **R1 (downgrade)** — Published and called `commitHealthy` for `1.0.2+2`, then supplied valid older signed package `1.0.1+1`. `lastGood.version` dropped to `'1.0.1'` with `build == 1`.
    - **R6 (fallback corrupts `previous`)** — Promoted `v2` from `v1` with `commitHealthy`, simulated a `v2` runtime error, returned to `v1` via `fallbackFor(v2)`, and called `commitHealthy(v1)`. `store.rollback()` returned `'1.0.2+2--...'`, the confirmed broken `v2`.
    - **R8 (old OTA overrides a newer embedded bundle)** — Cached an old OTA and updated host embedded resources. Startup continued to load the old OTA bytecode.
- **Minimal proposed fix**
  1. Require `manifest.payload.build > currentBuild` by default in `PocketUpdateCoordinator.prepare`, except explicit `allowDowngrade: true`.
  2. Record the embedded bundle's `build` and `payloadSha256` in `app.bytecode.json` or embedded `guest-manifest.json`. Clear or skip the old OTA pointer when a host upgrade raises embedded `build` above cached `lastGood.build`.
  3. On fallback from [`PocketSession._handleRuntimeError`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_session.dart#L263-L268), call `store.markBroken(failedVersionId)` or remove that version from `previous`. Prevent `commitHealthy(fallback)` from writing failed versions to `_previousFile`.

---

#### 5. Local Editor lacks Origin, CSRF, and Host checks and permits symlink escapes and build-time code execution
- **Source locations**
  - Missing Content-Type, Origin, and CSRF checks. [`sdk/editor/server.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/editor/server.ts#L125-L136) and [`sdk/editor/server.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/editor/server.ts#L676-L809)
  - Host header poisoning persisted to `host.json`. [`sdk/editor/server.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/editor/server.ts#L520) and [`sdk/editor/server.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/editor/server.ts#L796)
  - Out-of-tree reads and writes through symlinks. [`sdk/editor/server.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/editor/server.ts#L466), [`sdk/editor/server.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/editor/server.ts#L696-L749), and [`sdk/editor/server.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/editor/server.ts#L770-L786)
  - `Bun.build` compiles untrusted project source. [`sdk/scripts/build_guest.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/scripts/build_guest.ts#L345-L353)
- **Conditions** — A local Editor service is active, including the `KeepAlive=true` launch agent at `~/Library/LaunchAgents/dev.pocket.editor.plist` listening on `127.0.0.1:43110`, and a developer encounters a hostile third-party page or a project containing symlinks.
- **Cause and impact**
  1. **Cross-site request forgery (CSRF)** — `readBody()` passes `req.text()` directly to `JSON.parse()` without checking `Content-Type: application/json` or `Origin`. The original isolated reproduction used `<form enctype="text/plain">` or `fetch("http://127.0.0.1:43110/api/projects", { mode: "no-cors", body: JSON.stringify(...) })`. The missing checks allowed project creation on disk, arbitrary asset uploads through `multipart/form-data`, and requests to `/build` and `/publish`.
  2. **Host header poisoning and build-time execution** — `/api/projects/:id/publish` uses an unvalidated HTTP Host-derived `url.origin` to form `POCKET_UPDATE_URL` and saves it in `host.json`. The historical report combined DNS rebinding to `127.0.0.1` with `PUT /api/projects/:id/source` to write `app.tsx` containing a Bun macro (`import ... with { type: "macro" }`), followed by `POST /build`. At `Bun.build`, the macro ran in the host process with the current user's privileges. This describes the audited historical implementation and its isolated verification, not the security state of the current source.
  3. **Symlink escape** — Source, manifest, and asset handlers and `copyFileSync(projectManifest, ...)` in `buildProject` use `path.join` without checking symlinks or containment with `lstatSync` and `realpathSync`. A linked `app.tsx`, `manifest.json`, or `assets/sub` can expose or overwrite files outside the project.
- **Verification**
  - The audit used an isolated Editor instance and `curl` to confirm the boundary failures.
    1. A `POST /api/projects` with `Origin: https://evil.example` and `Content-Type: text/plain` returned `HTTP 201` and created a project on disk.
    2. A publish request with an unexpected Host persisted that Host in `POCKET_UPDATE_URL` inside generated `host.json`.
    3. An out-of-tree manifest symlink copied external JSON verbatim into `guest-manifest.json`. A separate source symlink let the source handler overwrite its out-of-tree target.
    4. A synthetic Bun macro in `app.tsx` executed in the host process during `Bun.build`.
- **Minimal proposed fix**
  1. At [`sdk/editor/server.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/editor/server.ts#L628), require `Host` to match `127.0.0.1:<port>` or `localhost:<port>`. For writes, require a local `Origin` and `Content-Type: application/json`, or a custom header such as `X-Pocket-CSRF: 1` that triggers CORS preflight.
  2. In [`safeProjectFile`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/editor/server.ts#L85-L93), reject symlinks at each path component using `lstatSync`, or require `realpathSync` for the target and parent to stay inside `projectDir`. Apply the same check to `source`, `manifest`, `assets`, and `buildProject`.

---

### P1 / High

#### 6. The documented space-separated `--sdk-root <dir>` syntax fails in `pocket.ts`
- **Source locations**
  - [`README.md`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/README.md#L14)
  - [`sdk/README.md`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/README.md#L12-L13)
  - [`sdk/docs/SDK_INTEGRATION.md`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/docs/SDK_INTEGRATION.md#L12)
  - [`sdk/pocket.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L69-L76), [`sdk/pocket.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L91-L93)
- **Conditions** — Run the documented `bun pocket.ts init /tmp/my_pocket_app --sdk-root "$PWD"`.
- **Cause and impact** — [`takeFlag`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L69-L76) parses only `${prefix}=`, such as `--sdk-root=/path`, and ignores the next space-separated token. [`ensureNoArgs`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L91-L93) rejects the remaining `--sdk-root`.
- **Verification**
  - Running `bun sdk/pocket.ts init /tmp/pocket-audit-sdk/my-app --sdk-root /tmp/pocket-audit-sdk/sdk` returned:
    ```text
    pocket: unknown option --sdk-root
    ```
    `--sdk-root=/tmp/pocket-audit-sdk/sdk` succeeded.
- **Minimal proposed fix** — Support `--flag=value` and `--flag value` in [`takeFlag`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L69-L76) by consuming `args[index]` and `args[index + 1]` when appropriate.

---

#### 7. Shared SDK native artifacts can go stale or be overwritten across iOS targets
- **Source locations**
  - [`sdk/pocket.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L309-L328)
  - [`sdk/scripts/build_native.sh`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/scripts/build_native.sh#L23-L35)
- **Conditions**
  1. Change `sdk/native/src/*.rs` and run `bun sdk/pocket.ts build <app> --platform=macos`.
  2. Build `--platform=ios` and `--platform=ios-sim` consecutively, or run `pocket.ts build` concurrently for two consumers.
- **Cause and impact**
  1. `prepareNative` checks only `stamp?.platform === platform && existsSync(archive)` and ignores `sdk/native/src` timestamps and hashes. The compiler is rebuilt by `newestMtimeMs`, leaving new compiler ABI and old host `libpocket_flutter.a` ABI out of sync. [`pocket.ts:316`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L316) and [`build_guest.ts:289`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/scripts/build_guest.ts#L289)
  2. `build_native.sh` writes both iOS device and simulator builds to `packages/pocket_flutter/ios/Frameworks/libpocket_flutter.a`. Each target can overwrite the other. Writing into the SDK tree also violates the read-only dependency model.
- **Verification**
  - After `touch native/src/lib.rs` under `/tmp/pocket-audit-sdk/sdk`, `bun sdk/pocket.ts build my-app --platform=macos` rebuilt `pocketjs_bytecode`. The mtime of `packages/pocket_flutter/macos/Frameworks/libpocket_flutter.a` stayed unchanged.
- **Minimal proposed fix**
  1. In [`prepareNative`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L315-L317), check `newestMtimeMs(path.join(sdkRoot, "native")) > statSync(archive).mtimeMs`.
  2. Package device arm64 and simulator builds in an `.xcframework` to avoid sharing one `.a`.

---

#### 8. The unconditional hardware dependency links all sensitive iOS frameworks
- **Source locations**
  - [`sdk/pubspec.yaml`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pubspec.yaml#L15-L16)
  - [`sdk/lib/pocket_sdk.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/pocket_sdk.dart#L4-L6)
  - [`sdk/packages/pocket_hardware/ios/pocket_hardware.podspec`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_hardware/ios/pocket_hardware.podspec#L17-L24)
- **Conditions** — Run `bun sdk/pocket.ts init my-app` with default arguments, without `--hardware`, and build iOS.
- **Cause and impact**
  - CocoaPods compiles `pocket_hardware.framework` into `Runner.app` because `pocket_sdk` depends on it in `pubspec.yaml`, even when `PocketAppConfig.enableHardware` is `false` and `Info.plist` has no `NS*UsageDescription`.
  - The binary references `AVFoundation`, `CoreBluetooth`, `CoreLocation`, `CoreMotion`, `LocalAuthentication`, and `Photos`. Apple's App Store static scan rejects binaries missing the corresponding privacy descriptions (ITMS-90683).
- **Verification**
  - `flutter build ios --simulator --debug` for `/tmp/pocket-audit-sdk/my-app` without `--hardware` produced no `UsageDescription` entries (count `0`). `otool -L` reported:
    ```text
    .../Runner.app/Frameworks/pocket_hardware.framework/pocket_hardware:
      /System/Library/Frameworks/AVFoundation.framework/AVFoundation
      /System/Library/Frameworks/CoreBluetooth.framework/CoreBluetooth
      /System/Library/Frameworks/CoreLocation.framework/CoreLocation
      /System/Library/Frameworks/CoreMotion.framework/CoreMotion
      /System/Library/Frameworks/LocalAuthentication.framework/LocalAuthentication
      /System/Library/Frameworks/Photos.framework/Photos
    ```
- **Minimal proposed fix**
  - Make `pocket_hardware` optional or have `--hardware` consumers explicitly depend on it and register `HardwarePlugin()`. The core should avoid unconditional links to sensitive system frameworks.

---

#### 9. Static pages keep ticking at 60/120Hz, deep-copy every frame in Rust, and inflate FPS
- **Source locations**
  - Continuous Ticker. [`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L571-L576) and [`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L810-L848)
  - Per-frame layout and deep copies. [`sdk/native/src/lib.rs`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/native/src/lib.rs#L1361-L1475) and [`sdk/native/src/lib.rs`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/native/src/lib.rs#L1562-L1630)
  - FPS includes idle ticks. [`sdk/packages/pocket_flutter/lib/src/pocket_performance.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_performance.dart#L24-L64)
- **Conditions** — Any static page without animation or interaction.
- **Cause and impact**
  1. On mount `PocketView` calls `_ticker?.start()` and continues ticking while visible.
  2. Each vsync `_onTick` calls `pocket_frame_delta_at` across FFI and enters Rust `build_frame`.
     - `guest.tick(now_ms)` runs JS frame callbacks in QuickJS, including `onFrame(sendRectUpdate)` in [`ui.tsx:673`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_ui/src/ui.tsx#L673).
     - Every node is passed to `relayout_outputs(&mut self.layout, &self.nodes)`. [`lib.rs:1416`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/native/src/lib.rs#L1416)
     - The runtime executes `let words = self.draw.words.clone();` and `let nodes = self.nodes.clone();`, compares all values with the previous frame, and allocates and returns `'{"unchanged":true}'` if identical. [`lib.rs:1417-1418`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/native/src/lib.rs#L1417-L1418)
  3. Even with `deltaJson == null`, no repaint, and no Flutter `setState`, Dart calls `_recordFrameMetrics` and records a frame in [`PocketPerformanceWindow.recordFrame`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_performance.dart#L24). Much of the shown `60 FPS` is idle Ticker work, which dilutes and can conceal actual rendering cost once frames do repaint.
- **Verification**
  - Source tracing shows `deltaJson == null` takes the old `_ops.length` for `opCount`, calls `_recordFrameMetrics(...)`, and returns. The next vsync repeats the process. [`pocket_view.dart:816-829`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L816-L829)
- **Minimal proposed fix**
  1. Track dirty state and active timers/animations in Rust. With no input, callbacks, animations, or timers requiring work, skip `relayout_outputs`, `words.clone()`, and `nodes.clone()` and tell the host to pause `_ticker`. Resume on input, timer expiry, or asynchronous messages.
  2. Distinguish `vsyncFps` from submitted `renderedFps` or report `unchangedFrameCount` in `PocketPerformanceMetrics`.

---

#### 10. Hardware permissions are all-or-nothing, and iOS hardcodes some grants
- **Source locations**
  - Coarse bundled checks. [`sdk/packages/pocket_hardware/lib/src/hardware_plugin.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_hardware/lib/src/hardware_plugin.dart#L287-L335) and [`sdk/packages/pocket_services/lib/src/pocket_plugin.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_services/lib/src/pocket_plugin.dart#L495-L505)
  - Hardcoded permission results. [`sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift#L256-L296)
- **Conditions**
  1. A consumer needs sensors (`hardware.sensors`) or network (`hardware.network`) and declares only those permissions in `manifest.json`.
  2. JS calls `hardware.permissionStatus("hardware.sensors")` or `hardware.requestPermission("hardware.biometrics")`.
- **Cause and impact**
  1. `HardwarePlugin` declares camera, photo library, Bluetooth, sensors, biometrics, location, microphone, and network in one descriptor. [`PocketPluginRegistry.invoke`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_services/lib/src/pocket_plugin.dart#L495-L505) requires `plugin.descriptor.permissions.difference(grantedPermissions)` to be empty before every method. Even `getWeather` or gyroscope reading requires all eight manifest and `PocketAppConfig` grants, or throws `PocketPluginException('permission_denied')`. [`hardware_plugin_test.dart:199-216`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/test/hardware_plugin_test.dart#L199-L216) enshrines this behavior in its assertions.
  2. `PocketHardwareManager.swift` has these hardcoded paths.
     - `permissionStatus(for: "hardware.sensors")` returns `granted: true` without `CMAltimeter.authorizationStatus()`.
     - `requestPermission` returns `permissionPayload(..., status: "granted", granted: true)` for `hardware.biometrics`, `hardware.sensors`, and `hardware.network` without consulting a system API.
- **Verification**
  - Source review confirmed the behavior. [`PocketHardwareManager.swift:256-295`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift#L256-L295) and [`pocket_plugin.dart:495-505`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_services/lib/src/pocket_plugin.dart#L495-L505)
- **Minimal proposed fix**
  1. Declare and validate required permissions on each `PocketPluginMethod`, avoiding eight mandatory permissions for every `HardwarePlugin` call.
  2. Use `CMAltimeter.authorizationStatus()` for the actual motion sensor authorization. For biometrics, call `LAContext.evaluatePolicy` or report that preauthorization is unsupported.

---

### P2 / Medium

#### 11. The simulator keyboard lifecycle test observes only one frame because idle Flutter does not repaint
- **Source locations**
  - [`demo/integration_test/system_keyboard_lifecycle_test.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/integration_test/system_keyboard_lifecycle_test.dart#L11-L71), [`demo/integration_test/system_keyboard_lifecycle_test.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/integration_test/system_keyboard_lifecycle_test.dart#L97-L115)
  - [`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L816-L830)
- **Conditions** — On running iPhone Duo simulator `4D366210-290E-46DB-8BC6-3C5233700409`, run `flutter test integration_test/system_keyboard_lifecycle_test.dart` or `flutter drive --driver=test_driver/integration_test.dart --target=integration_test/system_keyboard_lifecycle_test.dart`.
- **Cause and impact**
  - With `LiveTestWidgetsFlutterBindingFramePolicy.fullyLive`, the test uses `binding.addPersistentFrameCallback` to collect `keyboardAnchorFrames` while `tester.view.viewInsets.bottom > 0`. Line 111 asserts `expect(keyboardAnchorFrames.length, greaterThan(5))`.
  - The simulator keyboard updates `viewInsets.bottom` in one step. Over the remaining 60 `tester.pump(50ms)` calls, static JS returns `deltaJson == null` from `PocketView._onTick` without `setState()`. Flutter schedules no further rendered frames. The persistent callback runs once, consistently failing the test.
- **Verification**
  - Both `flutter test` and `flutter drive` failed on line 111 in the target simulator:
    ```text
    Expected: a value greater than <5>
      Actual: <1>
    Capture JS layout during the real keyboard resize
    ```
- **Minimal proposed fix**
  - Read `_guestTextRects(layoutAnchors)` directly inside the loop, or sample after `tester.binding.scheduleForcedFrame()`. Idle persistent callback counts do not establish available anchor samples. [`system_keyboard_lifecycle_test.dart:97-106`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/integration_test/system_keyboard_lifecycle_test.dart#L97-L106)

---

#### 12. Geometry-only IME updates change selection affinity, and stale echoes overwrite new input
- **Source locations**
  - Loss of `affinity` and `isDirectional`. [`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L1852-L1895) and [`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L2047-L2055)
  - Missing revision to reject stale echoes. [`sdk/packages/pocket_ui/src/ui.tsx`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_ui/src/ui.tsx#L528-L542) and [`sdk/packages/pocket_ui/src/ui.tsx`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_ui/src/ui.tsx#L663-L668)
- **Conditions**
  1. While composing Chinese with iOS IME or after moving the caret to `selection.affinity == TextAffinity.upstream`, a keyboard height change or scroll causes JS to send `textInput.update` with only `{ id, rect }`.
  2. While typing rapidly, for example from `"ab"` to `"abc"`, the JS `textInput.update` echo of the previous `"ab"` frame arrives late.
- **Cause and impact**
  1. For geometry-only updates without selection arguments, `_PocketTextInputState.fromJson` rebuilds `TextSelection(baseOffset: ..., extentOffset: ...)` and drops `fallback.selection.affinity` and `isDirectional`, resetting to downstream. `TextSelection.==` compares affinity, so `controller.value != nextValue` becomes true in `_syncTextController`. Flutter sends an extra `TextInput.setEditingState` to the system IME, potentially interrupting Chinese candidates during keyboard animation or scrolling.
  2. `textInput.edit` and `textInput.update` share no monotonic `revision`. A stale JS `createEffect` echo makes `_syncTextController` overwrite fresh text and clear `composing`.
- **Verification**
  - Targeted widget test `zz_audit_ime_test.dart` intercepted `SystemChannels.textInput`.
    - With composing and `TextAffinity.upstream`, geometry-only `textInput.update({'id': 'field-1', 'rect': ...})` called `TextInput.setEditingState` once and set affinity to `TextAffinity.downstream`.
    - After entering `"abc"` with composing `0..3`, a late `"ab"` echo reverted the controller to `"ab"` and set composing to `TextRange.empty`.
- **Minimal proposed fix**
  1. In [`pocket_view.dart:1879-1882`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L1879-L1882), preserve `fallback.selection` when `params['selectionBase'] == null && params['selectionExtent'] == null && fallback != null && selectionBase == fallback.selection.baseOffset && selectionExtent == fallback.selection.extentOffset`.
  2. Add an increasing `revision` to `textInput.edit`. JS `InputField` should send text and selection for explicit business changes or matching revisions only.

---

#### 13. Concurrent package preparation races, old versions accumulate, and status rehashes every version on the UI isolate
- **Source locations**
  - Concurrent `prepare` race. [`sdk/packages/pocket_services/lib/src/pocket_package.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_services/lib/src/pocket_package.dart#L626-L718) and [`sdk/packages/pocket_services/lib/src/pocket_package.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_services/lib/src/pocket_package.dart#L864-L882)
  - Unused `pruneInactiveVersions`. [`sdk/packages/pocket_services/lib/src/pocket_package.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_services/lib/src/pocket_package.dart#L829-L853)
  - Repeated full hashing in `listVersions`. [`sdk/packages/pocket_services/lib/src/pocket_package.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_services/lib/src/pocket_package.dart#L778-L826), [`sdk/lib/src/pocket_session.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_session.dart#L163), [`sdk/lib/src/pocket_session.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_session.dart#L274), and [`sdk/lib/src/pocket_session.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_session.dart#L306)
- **Conditions**
  1. Rapid update-check taps, or overlapping automatic and manual checks, call `updates.checkAndApply()` or `store.prepare()` concurrently.
  2. `session.status()` runs after multiple updates.
- **Cause and impact**
  1. `PocketPackageStore.prepare` lacks mutual exclusion. Two calls run `if (await versionDir.exists()) await versionDir.delete(recursive: true)` on the same `versions/<versionId>`. `_writeAtomic` deletes a target before rename. Concurrent writes in shared `blobs/` and `versions/` can throw `FileSystemException: Cannot delete file ... PathNotFoundException`.
  2. No production caller invokes `pruneInactiveVersions()`, so old versions and assets persist indefinitely.
  3. Every `PocketSession.status()` calls `store.listVersions()`. It calls `_loadVersion(id)` on every historical `versions/` entry, synchronously reads every `.qjbc`, `.pak`, and loose asset on the main isolate, and recomputes SHA-256. UI-thread time grows linearly with versions.
- **Verification**
  - In R3, `Future.wait([store.prepare(pkg), store.prepare(pkg)])` threw `PathNotFoundException` in all 20 runs.
  - Repository search found zero production calls to `pruneInactiveVersions` in `sdk/` or `demo/`, with only its definition and tests.
- **Minimal proposed fix**
  1. Serialize `prepare`, `activate`, `commitHealthy`, and `rollback` with an async lock or queue inside `PocketPackageStore`. In `_writeAtomic`, use `temp.rename(target.path)` for atomic POSIX replacement and give temporary names random suffixes to prevent same-microsecond collisions.
  2. Have `listVersions()` read only `manifest.json` metadata. Verify target SHA-256 from disk when `activate`, `active()`, or `lastGood()` calls `_loadVersion`. Call `pruneInactiveVersions(keep: 2)` after a successful `commitHealthy`.

---

#### 14. Absolute temp paths in QJBC make builds nondeterministic and expose build machine paths
- **Source locations**
  - [`sdk/pocket.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L456-L458)
  - [`sdk/editor/server.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/editor/server.ts#L421)
  - [`sdk/scripts/build_guest.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/scripts/build_guest.ts#L397-L398)
  - [`sdk/native/src/bin/pocketjs_bytecode.rs`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/native/src/bin/pocketjs_bytecode.rs#L109), [`sdk/native/src/bin/pocketjs_bytecode.rs`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/native/src/bin/pocketjs_bytecode.rs#L144)
- **Conditions** — Build the same project twice with `bun sdk/pocket.ts build` or Editor.
- **Cause and impact**
  - `pocket.ts` and `editor/server.ts` create a randomly suffixed directory with `mkdtempSync(path.join(tmpdir(), "pocket-cli-build-"))` per build. `build_guest.ts` passes `--input <workDir>/app.js` to `pocketjs_bytecode`. `pocketjs_bytecode.rs` passes that absolute path to `JS_Eval` as the module name through `CString::new(input_label)`.
  - QuickJS keeps module filenames in its bytecode atom table even with `JS_WRITE_OBJ_STRIP_DEBUG`.
    1. Identical sources produce different `app.qjbc` bytes and `payloadSha256`, breaking reproducible builds and content-addressed caching.
    2. Released `.qjbc` binaries expose plain-text build machine paths under `/var/folders/...` or `/tmp/...`.
- **Verification**
  - Two builds of the same project with distinct `--work-dir` values produced identical `app.js` SHA-256 (`2fd9eb61...`) but different `app.qjbc` SHA-256 (`8c3d79ee...` vs `3d7b3859...`). The binary diff matched the embedded temp directory string.
- **Minimal proposed fix**
  - In [`sdk/native/src/bin/pocketjs_bytecode.rs`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/native/src/bin/pocketjs_bytecode.rs#L144), pass a fixed logical `"app.js"` label to `compile_bytecode`, or add `--module-name app.js`, and use `--input` only to read the disk file.

---

#### 15. iOS hardware leaks pending location callbacks, camera state, and BLE connections
- **Source locations**
  - Permanent location `hardware_busy`. [`sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift#L928-L947) and [`sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift#L1217-L1232)
  - `switchCameraLens` desynchronization and texture leak. [`sdk/packages/pocket_hardware/lib/src/hardware_plugin.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_hardware/lib/src/hardware_plugin.dart#L451-L456) and [`sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift#L563-L576)
  - `stopCameraPreview` drops a pending photo callback. [`sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift#L559)
  - `disposeSession` leaves BLE peripherals connected. [`sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift#L127-L149)
  - Demo camera phase remains `"ready"` after stop. [`demo/js/state.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/state.ts#L288-L315)
- **Conditions**
  1. `getCurrentLocation` runs with `.notDetermined` permission, and the user leaves the system alert unanswered for 30 seconds or the system omits `locationManagerDidChangeAuthorization`.
  2. Call `switchCameraLens` after stopping preview or while `startCameraPreview` is pending.
  3. Hot-reload the host or destroy `PocketSession` after connecting a BLE peripheral.
- **Cause and impact**
  1. The `.notDetermined` branch of `getCurrentLocation` saves `pendingLocationResult = result` and calls `requestWhenInUseAuthorization()` without starting the `locationWorkItem` timeout. If Dart times out first after 30 seconds, Swift never clears `pendingLocationResult`. Subsequent requests return `hardware_busy`.
  2. `HardwarePlugin.switchCameraLens` calls native `switchCameraLens`, which internally calls `startCameraPreview` and registers a new texture. Dart checks neither `_stopped` nor updates `_textureId` and `_previewEpoch`.
  3. `stopCameraPreview` sets `pendingPhotoResult = nil` without invoking it, so the waiting future stalls until timeout. `disposeSession` cancels `pendingConnections` but does not call `centralManager.cancelPeripheralConnection` on connected `discoveredPeripherals`.
  4. Demo sets `cameraPreview.phase` to `"ready"` when `cameraStop` returns `{ stopped: true }`. The disabled `"Preview on"` button and last texture frame remain. [`state.ts:292`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/state.ts#L292)
- **Verification**
  - Source tracing confirmed these paths. The `if (action.operation === "cameraStop")` branch returns `{ phase: "ready", ... }`. [`demo/js/state.ts:288-315`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/state.ts#L288-L315)
- **Minimal proposed fix**
  1. Schedule the timeout `DispatchWorkItem` for the `.notDetermined` location branch too.
  2. Reuse `startCameraPreview` updates to `_previewEpoch` and `_textureId` for lens switching. In `stopCameraPreview`, complete non-nil `pendingPhotoResult` with `FlutterError(code: "cancelled", ...)`. In `disposeSession`, disconnect every connected peripheral through `cancelPeripheralConnection`.
  3. On `cameraStop` success, set phase to `"idle"` and clear `surfaceId`. [`demo/js/state.ts:292`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/state.ts#L292)

---

#### 16. Source fallback remains available, and the SDK exports around 108 internal types
- **Source locations**
  - JS source execution fallback. [`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L115), [`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L544-L552), [`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L616-L629), [`sdk/packages/pocket_flutter/lib/src/pocket_package.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_package.dart#L10), and [`sdk/packages/pocket_services/lib/src/pocket_package.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_services/lib/src/pocket_package.dart#L195)
  - The public barrel exports implementation details. [`sdk/lib/pocket_sdk.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/pocket_sdk.dart#L1-L12)
- **Conditions**
  1. Use `PocketView(script: ...)` or construct `PocketPackageLoader` / `PocketPackageManifest` without `requireBytecode: true`. The default is `entryFormat = 'javascript'`.
  2. A consumer uses `import 'package:pocket_sdk/pocket_sdk.dart';`.
- **Cause and impact**
  1. `PocketSession` passes `requireBytecode: true`, but `PocketView`, `FfiPocketRuntime`, and `PocketPackageManifest` retain full `pocket_eval`, `pocket_load`, and `pocket_load_files` source branches. Default `entryFormat` remains `'javascript'`, inconsistent with the bytecode-only production design.
  2. `pocket_sdk.dart` uses unfiltered exports such as `export 'package:pocket_flutter/pocket_flutter.dart'`. It exposes around 108 low-level internal classes and draw instruction structures, including `PocketCanvasPainter`, `PocketTextLayoutCache`, `FfiPocketRuntime`, and `PocketPakImage`.
- **Minimal proposed fix**
  1. Use `export ... show ...` in [`sdk/lib/pocket_sdk.dart`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/pocket_sdk.dart#L4-L6) for integration types such as `PocketApp`, `PocketGuest`, `PocketAppConfig`, `PocketUpdateConfig`, `PocketSession`, and `PocketPlugin`. Move debugging types under `package:pocket_sdk/testing.dart` or `internal.dart`.
  2. Make `PocketView.requireBytecode` and `PocketPackageManifest.entryFormat` default to bytecode-only behavior.

---

#### 17. Bun registers zero Demo JS tests, and architecture checking misses extra Dart files
- **Source locations**
  - `bun test` reports zero cases. [`demo/js/tests/guest_state.test.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/tests/guest_state.test.ts#L1-L245) and [`demo/js/tests/mobile_ui.test.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/tests/mobile_ui.test.ts#L1-L249)
  - Source-string assertions. [`demo/js/tests/guest_state.test.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/tests/guest_state.test.ts#L198-L243) and [`demo/js/tests/mobile_ui.test.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/tests/mobile_ui.test.ts#L186-L248)
  - Architecture script reads only `main.dart`. [`sdk/scripts/check_architecture.py`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/scripts/check_architecture.py#L72-L83)
  - Scaffold's placeholder test. [`sdk/pocket.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L361-L369)
- **Conditions**
  1. Run normal `bun test` under `demo/js`.
  2. Add a business page such as `demo/lib/extra_page.dart` with `Navigator.push` and `StatefulWidget`, then run `python3 sdk/scripts/check_architecture.py`.
- **Cause and impact**
  1. `guest_state.test.ts` and `mobile_ui.test.ts` use only top-level `assert(...)` and never register cases with `bun:test` `test()` or `describe()`. `bun test` reports `0 pass, 0 fail, Ran 0 tests across 2 files`. The files also end with roughly 100 lines of `readFileSync` substring assertions, including a requirement to keep the two-line stub `demo/js/components.tsx`.
  2. Line 72 of `check_architecture.py` hardcodes `demo/lib/main.dart` and matches four regex terms. It misses every other Dart file under `demo/lib/`.
  3. The `test/widget_test.dart` generated by `pocket.ts init` only asserts `expect(tester, isNotNull)` and never mounts `PocketApp`.
- **Verification**
  - `bun test` under `demo/js` reported `0 pass / 0 fail / Ran 0 tests across 2 files`.
  - Adding `StatefulWidget` and `Navigator.push` to `/tmp/pocket-audit-arch/archcheck/demo/lib/extra_page.dart` still produced `OK: Pocket architecture boundary holds` from `check_architecture.py` with exit code `0`.
- **Minimal proposed fix**
  1. Register behavioral assertions in `guest_state.test.ts` and `mobile_ui.test.ts` via `import { test, expect } from "bun:test"`, and remove `readFileSync` substring checks.
  2. Check all `demo/lib/**/*.dart` files and enforce limits on total files and lines. [`sdk/scripts/check_architecture.py`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/scripts/check_architecture.py#L72-L83)

---

### P3 / Low

#### 18. Upstream patch idempotency checks only the first target, and the cache has unrecorded drift
- **Source location** — [`sdk/scripts/prepare_upstream.py`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/scripts/prepare_upstream.py#L106-L119)
- **Conditions** — An upstream patch is partially applied or context has shifted, so `git apply --reverse --check` fails and the script falls back to text checks.
- **Cause and impact** — When `git apply --check` and `--reverse --check` both fail, line 108 extracts the first `+++ b/` path only. For example, `rgba-tileset.patch` starts with `Cargo.lock`. The script compares added lines from later `src/*.rs` files against `Cargo.lock` and falsely fails. Comparing pristine upstream `pocketjs` with `sdk/.cache/pocketjs` also found unrecorded `assets/fonts/NotoSansCJKsc-Regular.otf` (16.4MB), `.poc-revision`, `AGENTS.md`, and `crates/pocketjs-core/src/lib.rs.orig`, and a missing upstream `tools/build/`.
- **Minimal proposed fix** — Check the additions within each `+++ b/` block against that file. Ignore all of `sdk/.cache/` and remove stale files.

#### 19. Glass ignores registration failure, transitions assume 16ms, and stress timing measures array construction only
- **Source locations**
  - `GlassSurface`: [`sdk/packages/pocket_ui/src/mobile.tsx`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_ui/src/mobile.tsx#L419-L431)
  - Fixed transition step and stress timing. [`demo/js/app.tsx`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/app.tsx#L403) and [`demo/js/app.tsx`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/app.tsx#L459-L464)
- **Conditions** — The host lacks the native surface, a route changes on a 120Hz screen, or the user runs Stress Benchmark in Showcase.
- **Cause and impact**
  1. `GlassSurface` calls `host.registerSurface(surfaceId, ...)` and unconditionally sets `setRegistered(true)`.
  2. `app.tsx:403` hardcodes `const next = transition.elapsedMs + 16;` in `onFrame`, halving transition time on 120Hz ProMotion devices.
  3. `runStress` at `app.tsx:459-464` calls `nowMs()` before and after `dispatch({ type: "runStress" })`, which constructs the JS array. It excludes subsequent layout and DrawList generation.
- **Minimal proposed fix** — Use `setRegistered(host.registerSurface(...) !== false)`, advance transitions from real frame timestamp deltas, and record stress duration after layout on the next `onFrame`.

#### 20. Docs reference obsolete paths and bytecode/tooling versions are hardcoded
- **Source locations**
  - Obsolete documentation. [`sdk/docs/VALIDATION.md`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/docs/VALIDATION.md#L9), [`sdk/docs/VALIDATION.md`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/docs/VALIDATION.md#L113-L116), [`sdk/docs/FRAMEWORK_GUIDE.md`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/docs/FRAMEWORK_GUIDE.md#L79-L83), and [`sdk/docs/UI_REUSE.md`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/docs/UI_REUSE.md#L40)
  - Hardcoded `QUICKJS_BYTECODE_VERSION: u8 = 26` and `"--binding-generation", "12"`. [`sdk/native/src/bytecode.rs`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/native/src/bytecode.rs#L11) and [`sdk/scripts/build_guest.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/scripts/build_guest.ts#L402)
- **Cause and impact** — `VALIDATION.md` calls out missing `./scripts/test_guest.sh`, `packages/pocket_sdk`, and `host/test` paths. `QUICKJS_BYTECODE_VERSION` hardcodes `26` instead of reading the `rquickjs` binding.
- **Minimal proposed fix** — Update directory structures and commands across `sdk/docs/*.md`, and give binding generation and bytecode version a single source.

---

## 3. Unverified Risks and Optional Improvements

### 1. Risks Requiring Physical Devices or Special Environments
1. **Physical iOS and Android performance and 120Hz ProMotion**
   - The audit ran only on macOS and the iOS Simulator. Given verified continuous vsync in [`PocketView`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L810-L848) and per-frame Rust node and DrawList copies, measure sustained CPU usage, thermal throttling, and frame-time jitter at 120Hz on physical devices in Profile mode. Simulator 60 FPS cannot establish device targets.
2. **Physical iOS camera, BLE disconnect, barometer/magnetometer, and fast Chinese IME**
   - Simulator lacks physical camera, Bluetooth peripherals, and sensor hardware. [`PocketHardwareManager.swift`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift) uses fallback behavior there. Camera recovery after backgrounding, interruptions from permission prompts, and rapid Chinese nine-key or full-keyboard candidate commits need physical iOS testing.
3. **Recovery from a native OTA crash after the one-second health window**
   - [`PocketSession`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_session.dart#L452-L460) promotes a trial package to `lastGood` one second after mount. A native C/Rust SIGSEGV or QuickJS abort after 1.5 seconds or on a later tap terminates the process before Dart `onError`. A later cold start can repeatedly load that broken `lastGood`. Verify whether a startup crash counter could roll back after N abnormal exits.

### 2. Optional Engineering and Maintainability Improvements
1. **Rotating update signing keys and signature coverage of custom fields**
   - [`PocketUpdateConfig`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_config.dart#L10-L20) accepts a single `keyId` and `publicKey`. A `Map<String, String> trustedKeys` could support rotation. Preserve or reject unknown top-level fields in [`PocketManifestPayload.canonicalPayload`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_services/lib/src/pocket_package.dart#L298-L320) so signed extension metadata cannot escape hashing. R9 showed that adding extra top-level fields to signed `latest.json` leaves `contentHash` unchanged.
2. **Configurable default `PocketApp` Scaffold keyboard policy**
   - [`PocketApp`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_app.dart#L18) uses `Scaffold(resizeToAvoidBottomInset: true)`. Each keyboard animation frame changes `PocketView`'s `LayoutBuilder` constraints and causes two `display.viewport` events. Coalesce notifications per frame. [`pocket_view.dart:445`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L445) and [`pocket_view.dart:490`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L490)
3. **Reject `".."` path segments in `_readPointerId`**
   - [`PocketPackageStore._readPointerId`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_services/lib/src/pocket_package.dart#L859) rejects slash and backslash only. R10 showed that `".."` resolves a version lookup to its parent directory. Reuse `_requireSafeToken`.

---

## 4. Executed Tests, Outcomes, and Coverage Gaps

### 1. Executed Tests and Verification

| Category | Executed Command or Target | Result | Evidence |
| :--- | :--- | :--- | :--- |
| **SDK static analysis** | `flutter analyze` in `sdk/` | **PASS** (0 issues) | Static type analysis passed. |
| **SDK integration** | `flutter test test/session_integration_test.dart` in an isolated `sdk/` copy | **PASS** (3/3) | Basic `PocketSession` and `PocketGuest` mount. |
| **Flutter host unit tests** | `flutter test` in `sdk/packages/pocket_flutter` | **PASS** (26/26) | DrawList parsing, Canvas painting, and basic TextInput. |
| **Service and OTA unit tests** | `flutter test` in `sdk/packages/pocket_services` | **PASS** (14/14) | `PocketPackageStore`, `PocketUpdateCoordinator`, and `PocketPluginRegistry`. |
| **Update packaging unit tests** | `bun test scripts/tests/package_update.test.ts` in `sdk/` | **PASS** (10/10, 92 assertions) | Ed25519 signing, manifest generation, and tamper detection. |
| **Editor service unit tests** | `bun test editor/test/editor_server.test.ts` in `sdk/` | **PASS** (3/3, 57 assertions) | Basic CRUD, build, and publish. |
| **Demo host unit tests** | `flutter test` in `demo/test/` | **PASS** (13/13) | `hardware_plugin_test`, `performance_history_test`, and `widget_test`. |
| **JS native bridge probe** | `bun tests/native_guest_probe.ts --required` in `demo/js/` | **PASS** | 100/500-node stress and layout consistency with real `libpocket_flutter.dylib`. |
| **JS state and components** | `bun tests/guest_state.test.ts` and `bun tests/mobile_ui.test.ts` | **PASS** (direct execution)<br>**WARN** (`bun test` runs zero) | `bun <file>` passes. Without registered `test()` cases, `bun test` reports `Ran 0 tests`. |
| **Architecture checker** | `python3 sdk/scripts/check_architecture.py` | **PASS** (coverage gap) | Exits 0 for the existing tree, but ablation shows it misses additional `.dart` files under `demo/lib/`. |
| **Temporary project end-to-end** | `bun sdk/pocket.ts init` → `build` → `flutter build ios --simulator --debug` | **PASS** | Clean `/tmp/pocket-audit-sdk` produced `.qjbc`, `.pak`, and iOS Simulator `Runner.app`. |
| **Temporary Android build** | `flutter build apk --debug` in a project generated by `pocket init` | **FAIL** | `:pocket_flutter` `android/build.gradle` throws `NullPointerException`. |
| **Clean upstream and Rust rebuild** | Remove `.cache`, `node_modules`, `target`, and `Frameworks/*.a`, then run `prepare_upstream.py` and `build_native.sh` | **FAIL** with `MACOSX_DEPLOYMENT_TARGET=12.0`<br>**PASS** in 11.1s without it | Earlier local `macos` success reused `libserde_derive.dylib` cached by `ios-sim`. |
| **Malformed bytecode defense** | Feed eight malformed `.qjbc` fixtures (`bad_magic`, `flip_body`, `forged_digest`, `forged_trunc`, `oversize_len`, `short`, `truncated`, `wrong_abi`) into `pocket_probe` | **PASS** (all 8 rejected safely) | Magic, version, ABI, header length, SHA-256, and QuickJS reader checks reject without crashes. |
| **Targeted OTA regression cases** | `audit_repro_test.dart`, 12 cases R1–R12 | **12/12 executed** | Confirmed downgrade (R1), concurrent `prepare` throwing `PathNotFoundException` (R3), fallback corrupting `previous` so rollback restores a broken package (R6), stale OTA overriding a new embedded package (R8), extra fields excluded from hashing (R9), and `..` pointer escaping the version directory (R10). |
| **Targeted IME regression cases** | `zz_audit_ime_test.dart`, four cases | **4/4 executed** | Confirmed geometry-only `textInput.update` losing `TextAffinity.upstream` during composition, redundant `setEditingState`, and stale echoes overwriting fresh input. |
| **Targeted `PocketGuest` rebuild case** | `key_test.dart` | **CONFIRMED FAIL** | Parent rebuild with a new but field-identical non-`const` `PocketAppConfig` disposes and recreates the session. |
| **Targeted Editor security probes** | Isolated Editor checks for cross-origin plain-text requests, Host header poisoning, symlink escape, and Bun macro execution | **CONFIRMED VULNERABLE** | Confirmed CSRF in project creation, upload, build, and publish, Host-derived `POCKET_UPDATE_URL`, and external filesystem reads and writes through symlinks. |
| **iOS Simulator keyboard integration** | `system_keyboard_lifecycle_test.dart` on iPhone Duo (`4D366210-290E-46DB-8BC6-3C5233700409`) | **FAIL** (`Actual: <1>, Expected: > 5`) | Both `flutter test` and `flutter drive` failed at line 111. |

### 2. Coverage Gaps and Blockers
1. **Physical iOS and Android** — No physical device was connected and no Apple Developer device signing certificate was configured. Physical camera, Bluetooth, sensors, and GPU/CPU power stayed outside scope.
2. **Android runtime** — The unfinished `:pocket_flutter` Gradle plugin and missing Android JNI `.so` build prevented execution on emulator or hardware.

---

## 5. Highest-Priority Fixes and Ablation Candidates

### 1. Five Highest-Priority Fixes

1. **Secure OTA lifecycle: protect against downgrade, prefer newer store builds, clear bad pointers, and serialize writes**
   - Require `manifest.payload.build > currentBuild` in [`PocketUpdateCoordinator.prepare`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_services/lib/src/pocket_update.dart#L210-L325). Compare embedded and cached OTA build numbers in [`PocketSession.initialize`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_session.dart#L114-L163). Clear the failed version during fallback in [`PocketSession._handleRuntimeError`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_session.dart#L263-L268) and prevent `commitHealthy(fallback)` from writing it to `previous`. Add asynchronous mutual exclusion to `PocketPackageStore`.
2. **Enforce Editor CSRF, Host, and symlink boundaries**
   - Require local `Host` and `Origin` and JSON content type for writes. Enforce `lstatSync` / `realpathSync` containment for `source`, `manifest`, `assets`, and `buildProject`. [`sdk/editor/server.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/editor/server.ts#L628)
3. **Keep the JS runtime alive on parent rebuilds and make hardware optional**
   - Remove `ValueKey(config)` from [`PocketGuest`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/lib/src/pocket_app.dart#L32) or add complete value equality to `PocketAppConfig` and `PocketUpdateConfig`. Make `pocket_hardware` opt-in, with permission checks per method.
4. **Remove 60/120Hz idle ticking and per-frame copies**
   - Add dirty state and demand wakeups to [`sdk/native/src/lib.rs`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/native/src/lib.rs#L1361-L1475) and [`PocketView`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L810-L848). Skip `relayout_outputs` and `words`/`nodes` copies in idle frames and pause Ticker. Exclude idle `unchanged` frames from render FPS in [`PocketPerformanceWindow`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/packages/pocket_flutter/lib/src/pocket_performance.dart#L24-L64).
5. **Repair cross-platform builds and make bytecode output reproducible**
   - Fix the clean-build break from global `MACOSX_DEPLOYMENT_TARGET=12.0` in [`sdk/scripts/build_native.sh`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/scripts/build_native.sh#L17). Allow space-separated `--sdk-root <dir>` and check native source mtime in [`pocket.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/pocket.ts#L69-L76). Use the logical module name `"app.js"` instead of a temporary absolute path in [`pocketjs_bytecode.rs`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/native/src/bin/pocketjs_bytecode.rs#L144). Complete or remove unfinished Android plugin declarations.

---

### 2. Candidates for Removal Through Ablation

| No. | Candidate Files or Directories | Redundancy | Ablation | Acceptance |
| :--- | :--- | :--- | :--- | :--- |
| **1** | [`demo/js/ui/index.tsx`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/ui/index.tsx#L1-L6) (6 lines)<br>[`demo/js/ui/mobile.tsx`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/ui/mobile.tsx#L1-L2) (2 lines)<br>[`demo/js/legacy.ts`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/legacy.ts#L1-L2) (2 lines)<br>[`demo/js/components.tsx`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/components.tsx#L1-L2) (2 lines) | Old migration shims only re-export `@pocket/ui...`. No runtime code uses them. [`guest_state.test.ts:207`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/tests/guest_state.test.ts#L207) uses `readFileSync` to check the `components.tsx` text. | 1. Remove the `guest_state.test.ts:207` file assertion and the four shims.<br>2. Run `bun sdk/pocket.ts build demo/js --flutter-dir=demo`.<br>3. Run `bun demo/js/tests/native_guest_probe.ts --required` and `flutter test` in `demo/`. | Generated `demo/assets/app.js` is byte-identical with the same SHA-256, and all tests pass. |
| **2** | [`sdk/migrations/pocket_flutter_poc-source-20261102.tar.gz`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/sdk/migrations/pocket_flutter_poc-source-20261102.tar.gz) (60 MB)<br>and `sdk/migrations/*.json` (about 3,900 lines) | The historical PoC source archive and snapshot manifests added 60 MB to the public `sdk/` tree without build or runtime references. | 1. Move `sdk/migrations/` outside the workspace.<br>2. Run `prepare_upstream.py`, `pocket.ts init`, `pocket.ts build`, and all Dart/Bun suites. | Build and test results match, and SDK shrinks by 60 MB. |
| **3** | `sdk/.pocket-build/`, including a 407KB `app.js` and `editor-workspace/`, and 16.4 MB `sdk/.cache/pocketjs/assets/fonts/NotoSansCJKsc-Regular.otf` | Local transient build outputs and a font unreferenced by upstream patches or scripts. | 1. Remove `sdk/.pocket-build/` and the `.otf` file.<br>2. Run `python3 sdk/scripts/prepare_upstream.py` and `bun sdk/pocket.ts build demo/js --flutter-dir=demo`. | Upstream checks pass, and `.qjbc` / `.pak` contents stay identical. |
| **4** | Generated `demo/assets/` outputs including [`demo/assets/guest-manifest.json`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/assets/guest-manifest.json#L1-L44) and duplicate source tracking in [`demo/js/manifest.json`](https://github.com/CodeEagle/pocket/blob/0a3927705120f6aab26bba7d04e4c5df86da8abf/demo/js/manifest.json#L1-L44) | `build_guest.ts` regenerates `demo/assets/guest-manifest.json`, `app.qjbc`, `app.pak`, and `app.bytecode.json` from `demo/js/`. Both manifests have the same SHA-256 (`36009b65...`). | 1. Remove `demo/assets/{app.qjbc,app.pak,app.bytecode.json,guest-manifest.json}`.<br>2. Run `bun sdk/pocket.ts build demo/js --flutter-dir=demo` after fixing temporary module naming. | All four files regenerate from `demo/js/` alone and all `flutter test` cases under `demo/` pass. |
