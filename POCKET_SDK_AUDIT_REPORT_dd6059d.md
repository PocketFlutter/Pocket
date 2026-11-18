# Pocket SDK Code and Runtime Evidence Audit: `dd6059d`

- Repository: `/Volumes/ORICO/Development/Github/pocket` at `dd6059d6d1ef95bc957a0b539ffe4e1e230e1961`. Review was read-only.
- Scope: target snapshot, changes in `c35a3fe..dd6059d`, and closure of prior `5b5f58d` and `a5dd273` blockers in `dbc924d..dd6059d`.
- Audit date: 2026-11-03.

## Overall Assessment

**`dd6059d`, including `c35a3fe`, resolved all P0 build and integration blockers and P1 security, lifecycle, and permission blockers reported for `5b5f58d` and `a5dd273`.** Full Rust, Dart, and TS unit suites, actual FFI, QuickJS bytecode ablation, and architecture checks passed.

The main paths for keyboard-triggered page scroll synchronization, input field viewport clipping, and release identity precedence (`editor.json` > `pocket.json` > `manifest.json`) passed their regressions. Four P2 defects remained. There were no P0 or P1 blockers.

1. `PocketView._sendPointer` ignores `_textInputClipRect` when hit testing the text field. An input partly outside a `ScrollablePage` can swallow Guest pointer input in the clipped area, including header and navigation overlap.
2. `viewportLayout` allows zero width and bypasses `measureViewport` split-pane protection. A zero-width Duo `viewportNode` can fall back to full `ui.__viewport.w` and overwrite `lastViewportRect`. `syncViewportResize` also leaves `previousOffset` stale after `ensureVisible` scrolls.
3. `_scheduleIdleWake` overwrites `_idleStartedAt` across 100 ms idle cycles and runs six frames per wake. Earlier idle time enters the first active FPS denominator. Timer probes keep about 50% ticker duty cycle.
4. `sdk/pocket.ts` `projectConfig` still falls back per field for `version` and `build`. `PocketSession` lacks restart integration coverage for a host upgrade superseding stale OTA.

## 1. Remaining Findings in `dd6059d`

| Severity | Location | Trigger, cause, and evidence | Suggested fix |
|---|---|---|---|
| **P2**, new interaction edge case | `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:2708-2733`, `2844-2851`, `3615-3638` | The new `_textInputClipRect` clips the TextField using ClipRect as it scrolls behind Header or NavigationBar. `_sendPointer` still uses `_textInputRect!.contains(Offset(rawX, rawY))`. In the clipped-out area, RenderClipRect misses the TextField but `_sendPointer` returns false, suppressing Guest buttons, navigation, and outside dismissal. | Calculate the effective visible rectangle by intersecting the input rect with `_textInputClipRect` when available. Treat width or height ≤0 as a miss. Use this consistently for down filtering and up outside dismissal. |
| **P2**, new boundary mismatch | `sdk/packages/pocket_ui/src/ui.tsx:427-439`, `855-880`, `918-932` | `measureViewport` at 855–880 limits fallback to `Math.min(fallback.width, liveWidth - fallback.x)` to avoid crossing the Duo hinge. `viewportLayout` at 428 uses `committedLayout(node, true)` and can replace a zero-width rect with full `liveWidth`, overwriting `lastViewportRect`. If `liveWidth` is undefined, it can return `width: 0`, making Dart `_textInputRectFromRaw` set `clip` to null. Separately, `syncViewportResize` at 939–950 calls `ensureVisible` and `scroller.scrollBy` without updating `previousOffset`. The next frame treats the automatic scroll as user input and may call `input.close()` when the field remains partly outside a short viewport. | Use `committedLayout(node, false)` for viewport and keep true for `contentNode` height. Route zero-width viewport through the last split-pane bounds. After programmatic scrolling, update `previousOffset = scroller.offset()`. |
| **P2**, idle timing and duty cycle | `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:973-981`, `1022-1034`, `1142-1148` | `_scheduleIdleWake` at 975 unconditionally sets `_idleStartedAt = _lastSchedulerTimestamp;`. Over two or more idle cycles without output, `next == null` bypasses `_recordPerformanceTick` and earlier idle segments are lost. `_performanceWindowStart` deducts only the last cycle, inflating `durationMs` and lowering first-window FPS. The 100 ms timer calls `_wakeTicker()`, resets `_idleTicks` to 0, and can run six frames (about 100 ms) before sleeping. | Use `_idleStartedAt ??= _lastSchedulerTimestamp;` until consumed by a performance tick or reset. Keep `_idleTicks = 5` or use a one-frame probe flag for timer wakeups, then sleep again on `next == null`. Keep external input and message wakeups separate. |
| **P2**, release identity and upgrade regression | `sdk/pocket.ts:569-584`, `sdk/lib/src/pocket_session.dart:90-92`, `sdk/test/session_integration_test.dart` | `build_guest.ts` `releaseIdentity` chooses the whole object by editor, pocket, then manifest precedence and rejects invalid or nonpositive integer builds. `projectConfig` still resolves `version` and `build` independently, including `typeof editor.build === "number" ? editor.build : (typeof pocket.build === "number" ? pocket.build : 1)`. Missing or invalid editor build can mix sources. `PocketSession._initialize` defaults missing embedded build to 0. The restart path from old cached OTA through a newer `embeddedBuild` and `resetToEmbedded()` lacks an integration test. | Resolve identity atomically and surface invalid `editor.build`. Test restart with a newer `embeddedBuild` superseding cached OTA in `session_integration_test.dart`. |

## 2. Recheck of Earlier Findings from `5b5f58d` and `a5dd273`

| ID | Prior finding | Status at `dd6059d` | Evidence |
|---|---|---|---|
| P0-1 | Missing FFI binding fields prevented `pocket_runtime.dart` compilation | Fixed | `PocketDuplexEndpointNative` and `PocketDuplexEndpoint` have `abiVersion`, `messageSize`, and `capacity`, marked `isLeaf: true`. Analysis and tests passed in sdk, pocket_flutter, and demo. |
| P1-1 | Out-of-order promotion and same-build replacement in `pocket_update.dart`/`pocket_package.dart` | Fixed | `PocketUpdateCoordinator.prepare` and locked `PocketPackageStore.activate`/`commitHealthy` validate the highest build across `minimumBuild`, `active`, and `lastGood`, and equal-build `versionId` consistency. All 26 service tests passed. |
| P1-2 | Embedded `build` metadata and Editor identity precedence | Mostly fixed, P2 remains | Demo `app.bytecode.json` and `guest-manifest.json` contain `"version": "0.1.0", "build": 1`. `build_guest.ts` and `editor/server.ts` use authoritative `editor.json` and synchronize generated manifests. CLI per-field fallback and Session restart coverage remain. |
| P1-3 | Inconsistent public path and pointer name validation | Fixed | `fallbackFor`, `rollback`, `readPointerId`, `_pointer`, and `_loadVersion` apply `_requireSafeToken` and `_allowedPointerNames` before IO. Out-of-bounds sentinel-directory test passed. |
| P1-4 | Hostname-only Origin checking and cross-origin multipart writes in Editor | Fixed | Compares scheme, host, and port, checks `Sec-Fetch-Site`/`Sec-Fetch-Mode`, and requires CSRF token or `x-pocket-editor: 1` for all writes including multipart `/assets/upload`. Four Editor tests and 98 assertions passed. |
| P1-5 | Editor artifact route symlink escape | Fixed | `safeArtifactFile` rejects symlinks per segment with `lstatSync` and verifies `realpathSync` bounds on `/updates/`, `/releases/`, and `/artifacts/`. |
| P1-6 | Six-frame idle cutoff stranded work awaiting future ticks | Partial, P2 accounting remains | 100 ms `_idleWakeInterval` and scheduler timestamp deltas passed `pocket_view_timer_ffi_test.dart`. Multiple cycles overwrite `_idleStartedAt` and run six frames per wake. |
| P1-7 | Per-method plugin permission negotiation and dynamic declarations | Fixed | Supports per-method negotiation, revocation, and `optionalPermissions`, resolving Duo's startup `hardware.microphone` blocker. `PocketPluginManager.invoke` and HardwarePlugin, including coordinate-free weather location, check the `grantedPermissions` intersection. |
| P1-8 | Delayed old echo for the same ID overwrote newer input | Fixed | Monotonic `revision` and `jsRevision` in both directions reject stale echoes and preserve controlled `force: true` updates. |
| P1-9 | Swift camera callback race between queues | Fixed | `pendingPhotoResult` reads and writes run on `cameraQueue` and bind `photoCaptureGeneration`. |
| P1-10 | CLI rejected Android and lacked isolated native cache | Fixed | `--platform=android` supported. `.pocket-build/sdk-native/${platform}.json` records source, `Cargo.lock`, patches, and build-script fingerprints per platform. |
| P2-1 | Set equality and hashCode mismatch | Fixed | `Object.hashAllUnordered` with `Set.unmodifiable`, verified by `config_value_test.dart`. |
| P2-2 | Keyboard page scroll and input geometry/line-height synchronization | Mostly fixed, P2 clip hit testing remains | Added `display.viewport` synchronous onChange measurement and ensureVisible, `_textInputLineHeight` matching `ceil(fontSize * 1.2)`, `gapPadding: 0`, `_textInputClipRect`, and corrected fallback pointer-up order. `_sendPointer` still intercepts outside the clipped bounds. |

## 3. Executed Validation for `dd6059d`

| Scope | Command | Observed result |
|---|---|---|
| Rust Runtime and Duplex | `cd sdk/native && cargo test --locked` | **23 passed** (17 from `lib.rs` and 6 from `duplex_layout.rs`), 0 failed, 1 manual benchmark ignored |
| SDK root package | `cd sdk && flutter analyze && flutter test` | Analysis: **0 issues**. Unit tests: **5 passed**. |
| `pocket_flutter`, including real FFI | `cd sdk/packages/pocket_flutter && flutter analyze && POCKET_NATIVE_LIBRARY="$PWD/../../native/target/debug/libpocket_flutter.dylib" flutter test` | Analysis: **0 issues**. Unit and FFI integration: **51 passed**, 0 skipped. |
| `pocket_services` | `cd sdk/packages/pocket_services && flutter analyze && flutter test` | Analysis: **0 issues**. Unit tests: **26 passed**. |
| `pocket_hardware` | `cd sdk/packages/pocket_hardware && flutter analyze` | Analysis: **0 issues**. |
| Showcase `demo` | `cd demo && flutter analyze && flutter test` | Analysis: **0 issues**. Unit tests: **18 passed**, including `showcase_admission_test.dart`. |
| SDK Bun build, package, Editor, and UI | `cd sdk && TMPDIR=/tmp bun test` | **19 passed**, 0 failed, 258 assertions. |
| Showcase JS, bytecode ablation, and native probe | `cd demo/js && bun test && bash scripts/test_guest.sh` | **11 Bun tests passed**. `test_guest.sh` passed reproducible builds, bytecode ablation, and 100/500-node native probe load. |
| Architecture boundaries | `python3 sdk/scripts/check_architecture.py` | **Passed**. |
