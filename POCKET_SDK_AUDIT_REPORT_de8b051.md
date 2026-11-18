# Pocket independent regression review (`bee700ebce1d` → `de8b051d3d87`)

- **Target commit** `de8b051d3d87829ce25f50c021b74c0a11b7d6c8`
- **Baseline commit** `bee700ebce1d044cfa27ad31c39e7e0f05bca149`
- **Scope** Entire commit, 173 changed files and `+40,371 / -992` lines.
- **Method** Full source review plus actual builds, tests, probes, and WASM rebuild. The review was read-only for production source and preserved concurrent workspace edits.

---

## 1. Merge decision and blockers

### NO-GO

### Primary blockers

1. **[P0] Showcase SystemUI's declared host capabilities diverge from the kernel in `de8b051d`, and `demo/test/showcase_admission_test.dart` failed**
   - In the target commit, [`PocketSystemHost`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L42-L52) and [`PocketSystemKernel.awaitFirstFrame`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_ui/src/system.ts#L1656-L1661) replaced `"system.runtime.present"` with `"system.runtime.awaitFirstFrame"`. [demo/js/manifest.json](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/js/manifest.json#L48-L53) and [demo/assets/guest-manifest.json](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/assets/guest-manifest.json#L48-L53) still declare the previous name. [`PocketPluginManager.activate`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_services/lib/src/pocket_plugin.dart#L684) revokes plugin capabilities absent from the Guest manifest, so `openApp` receives `capability_denied` for `system.runtime.awaitFirstFrame`.
   - [demo/assets/guest-manifest.json](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/assets/guest-manifest.json#L5-L8) also lists `"ui.compositor-surfaces"` in `requires`. [`showcaseConfig`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/lib/main.dart#L18-L28) omits `additionalCapabilities: {'ui.compositor-surfaces'}` because [`_ensureSystemCaps`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L1392-L1415) injects it internally. The actual `flutter test` run failed in [showcase_admission_test.dart](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/test/showcase_admission_test.dart#L65-L68) with `Bad state: Missing capabilities: ui.compositor-surfaces`.
2. **[P0] CLI (`sdk/pocket.ts`) and Editor (`sdk/editor/server.ts`) drop Worker artifacts and overwrite `guest-manifest.json` during build and publish**
   - [`buildGuest`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/scripts/build_guest.ts#L494-L612) generates `app.worker.qjbc` and `app.worker.bytecode.json` and injects `domains.worker`, the `worker` descriptor, and required `"runtime.worker"` into `guest-manifest.json`. [`buildProject` (sdk/pocket.ts)](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/pocket.ts#L624-L644) and [`buildProject` (sdk/editor/server.ts)](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/editor/server.ts#L742-L758) copy only the four main package files and overwrite `guest-manifest.json` with the input `manifest.json`. Consumer projects with a Worker can lose bytecode or fail outright in CLI build or Editor publishing.
3. **[P1] Deterministic replay can incorrectly return `matched: true` after truncation of trailing Worker events**
   - [`WorkerTrace::finish_batch`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker_trace.rs#L604-L672), [`replay::set_mode`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/replay.rs#L420-L445), and [`PocketReplayRunner._validateReplayEvidence`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L2935-L2975) do not check `state.active_turns.is_empty()` at replay completion. A recording can produce `matched: true` despite a truncated final Worker turn missing its `turn.facts`, `channel.publish`, `clock.scalar`, and `turn.end` after `turn.begin`, with matching `bytes` metadata.
4. **[P1] The WeChat on-demand scheduler advances idle frames too early, and resize breaks the `this.scale` invariant**
   - [`PocketWechatHost.schedule`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/targets/wechat/template/wechat-host.js#L246-L258) immediately calls `web_wechat_skip_idle_frames(host, frames - 1)` at `t = 0` when registering `setTimeout(delay)`. A touch, `host.response`, or keyboard event before the delay sees a clock already fast-forwarded and fires the timer prematurely.
   - [`PocketWechatHost.resize`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/targets/wechat/template/wechat-host.js#L140-L159) can reduce `this.scale` when window or keyboard height changes. WASM [`web_resize`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/.cache/pocketjs/programs/web/wasm/src/lib.rs#L269-L294) retains boot scale, so `web_pixels_len` and `this.imageData.data.length` stay out of sync. [`draw()`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/targets/wechat/template/wechat-host.js#L214) returns silently, leaving a black or frozen screen.
5. **[P1] An offstage pre-mount frame completes multi-app `awaitFirstFrame` early, and `isPresented` conflicts with the integration test**
   - [`PocketSystemHost._create`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L307-L311) adds a new child instance to `hostSurfaceResidents` immediately. [`PocketView._buildSurface`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L4061-L4089) completes the first frame under `Offstage(offstage: true)` and calls [`_onFirstFrame`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L1158-L1167). This satisfies [`_awaitFirstFrame`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L727-L743) while the child surface still has `compositorVisible == false`.

---

## 2. Confirmed findings by priority

### P0 build, admission, and core workflow blockers

#### [P0-1] Showcase manifest omits `system.runtime.awaitFirstFrame` and `showcase_admission_test.dart` fails admission for `ui.compositor-surfaces` in `de8b051d`
- **Source locations**
  - [demo/js/manifest.json:48-53](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/js/manifest.json#L48-L53) (target snapshot `de8b051d`)
  - [demo/assets/guest-manifest.json:5-8,48-53](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/assets/guest-manifest.json#L5-L8) (target snapshot `de8b051d`)
  - [demo/lib/main.dart:18-28](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/lib/main.dart#L18-L28)
  - [demo/test/showcase_admission_test.dart:65-68](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/test/showcase_admission_test.dart#L65-L68)
  - [sdk/lib/src/pocket_session.dart:301-308,343-348](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_session.dart#L301-L308)
  - [sdk/lib/src/pocket_system_host.dart:42-52,1392-1415](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L42-L52)
- **Conditions**
  1. Run `flutter test` in `demo/` to run `showcase_admission_test.dart`.
  2. Run Showcase at `de8b051d` and open a child app to exercise `system.runtime.awaitFirstFrame`.
- **Cause**
  1. `de8b051d` renamed the first-frame compositor capability to `system.runtime.awaitFirstFrame` in [`_systemRequestCapabilities`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L45) and [`PocketSystemKernel.awaitFirstFrame`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_ui/src/system.ts#L1656). Line 50 in both `demo/js/manifest.json` and `demo/assets/guest-manifest.json` still lists `"system.runtime.present"`, so negotiation revokes `system.runtime.awaitFirstFrame`.
  2. `demo/assets/guest-manifest.json` requires `"ui.compositor-surfaces"`. [`PocketSession._configureBridgeUnlocked`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_session.dart#L306-L307) registers it only when `config.additionalCapabilities.contains('ui.compositor-surfaces')`. `showcaseConfig` in `demo/lib/main.dart` sets `compositorSurfaces` and omits `additionalCapabilities: {'ui.compositor-surfaces'}`. The direct `PocketSession(config: showcase.showcaseConfig)` admission test therefore fails consistently.
- **Observed evidence**
  - Line 50 of `git show de8b051d3d87829ce25f50c021b74c0a11b7d6c8:demo/js/manifest.json` is `"system.runtime.present"`.
  - Actual output of `cd demo && flutter test --no-pub --concurrency=1 --reporter expanded` follows.
    ```text
    00:27 +19 -1: /Volumes/ORICO/Development/Github/pocket/demo/test/showcase_admission_test.dart: showcase assets and real plugins pass session admission [E]
      Bad state: Missing capabilities: ui.compositor-surfaces
      package:pocket_sdk/src/pocket_session.dart 354:7  PocketSession._configureBridgeUnlocked
    ```
- **Proposed minimal fix**
  1. Replace `"system.runtime.present"` with `"system.runtime.awaitFirstFrame"` in `demo/js/manifest.json` and regenerate `demo/assets/guest-manifest.json`.
  2. Explicitly declare `additionalCapabilities: {'ui.compositor-surfaces'}` in `showcaseConfig` in [`demo/lib/main.dart`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/lib/main.dart#L18-L28), or construct the test `PocketSession` via `PocketSystemHost` admission configuration. Preserve the boundary that child configuration cannot self-grant `ui.compositor-surfaces`.

---

#### [P0-2] CLI (`sdk/pocket.ts`) and Editor (`sdk/editor/server.ts`) discard Worker output and overwrite `guest-manifest.json`
- **Source locations**
  - [sdk/pocket.ts:493-497,624-644](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/pocket.ts#L624-L644)
  - [sdk/editor/server.ts:700-758,825-867](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/editor/server.ts#L700-L758)
  - [sdk/scripts/build_guest.ts:552-566](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/scripts/build_guest.ts#L552-L566)
- **Conditions**
  - Build a project declaring `domains.worker` with `bun sdk/pocket.ts build <dir>` or build and publish it through Pocket Studio Editor.
- **Cause**
  1. [`buildGuest`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/scripts/build_guest.ts#L494-L612) emits `app.worker.qjbc` and `app.worker.bytecode.json` in the temporary `staging` directory. It adds `domains.worker`, the `worker` descriptor, and `"runtime.worker"` in `capabilities.requires` to `staging/guest-manifest.json`.
  2. [`sdk/pocket.ts:625-643`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/pocket.ts#L625-L643) and [`sdk/editor/server.ts:743-758`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/editor/server.ts#L743-L758) copy only `["app.js", "app.pak", "app.qjbc", "app.bytecode.json"]` from `staging`. They drop `app.worker.qjbc` and `app.worker.bytecode.json`, then overwrite output `guest-manifest.json` from the input `manifest.json`, removing the generated `worker` metadata and `"runtime.worker"` requirement.
  3. When Editor calls [`publishProject`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/editor/server.ts#L841-L867) → [`packageArtifacts`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/scripts/package_update.ts#L435-L438), it throws because `app.bytecode.json` contains `worker`, `guest-manifest.json` lacks `"runtime.worker"`, and `buildDir/app.worker.qjbc` is missing.
  4. [`sdk/scripts/build_guest.ts:553-565`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/scripts/build_guest.ts#L553-L565) initializes `metadataModified` to `false` after assigning `metadataObj.worker = workerDescriptor`. If `metadataObj.version` and `metadataObj.build` already match, it never writes `metadataObj.worker` back to `app.bytecode.json`.
- **Observed evidence**
  - [sdk/pocket.ts:633-638](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/pocket.ts#L633-L638)：`const guestManifest = { ...readJson(join(project, "manifest.json")), version: config.version, build: config.build }; writeJson(join(output, "guest-manifest.json"), guestManifest);`。
  - [sdk/editor/server.ts:752-758](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/editor/server.ts#L752-L758) and [sdk/editor/server.ts:828](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/editor/server.ts#L828) also omit `app.worker.qjbc` and `app.worker.bytecode.json`.
- **Proposed minimal fix**
  - In `sdk/pocket.ts` and `sdk/editor/server.ts`, merge `version` and `build` into the `guest-manifest.json` generated by `buildGuest` in `staging`. When `built.worker` exists, copy both Worker artifacts into build output and `flutter/assets` and include them in the `readArtifact` allowlist and scaffold `pubspec.yaml`.
  - Change [sdk/scripts/build_guest.ts:555](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/scripts/build_guest.ts#L555) to `let metadataModified = workerDescriptor !== undefined;`.

---

### P1 correctness, replay integrity, multi-app lifecycle, and WeChat defects

#### [P1-1] Replay can falsely match a recording with an open Worker turn
- **Source locations**
  - [sdk/native/src/worker_trace.rs:604-672,725-740](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker_trace.rs#L604-L672)
  - [sdk/native/src/replay.rs:420-445](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/replay.rs#L420-L445)
  - [sdk/native/src/lib.rs:734-747](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/lib.rs#L734-L747)
  - [sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart:2935-2975](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L2935-L2975)
- **Conditions**
  - Replay can receive valid-looking v2 Worker data whose final Worker-bearing transaction, such as `frame` or `captureStop`, contains only the partial `turn.begin` in `workerEvents`, with accounting in the top-level `bytes` field consistent with the data passed to [`PocketReplayRunner.run`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L2391-L2532).
- **Cause**
  1. [`pocketValidateTraceClockEnvelope`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_recording.dart#L821-L890) and [`_validateReplayEvidence`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L2935-L2975) do not require a corresponding `turn.end` or `worker.exit` for every `turn.begin`.
  2. The Worker consumes `turn.begin` and inserts `session` into `state.active_turns`. It then waits for `turn.facts`. With no remaining `state.replay_events`, [`wait_for_session`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker_trace.rs#L725-L781) waits for the next batch without setting `state.failure`.
  3. Host [`WorkerTrace::finish_batch`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker_trace.rs#L607) waits only for `state.replay_events.front()` to become `None`. It does not check `state.active_turns.is_empty()`. The returned `consumed_events` is `[turn.begin]`, which matches the incomplete `traceClock`.
  4. `captureStop` then calls `_setTraceClockMode(0)` → [`replay::set_mode(host, 0)`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/replay.rs#L420-L445). `lane.set_live()` clears `active_turns` and `failure` and wakes `wait_for_session` to return `Ok(())`. [`stop_worker_checked`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/lib.rs#L734-L747) omits `runtime.last_error()`, so the replay returns `PocketReplayResult(matched: true)`.
- **Observed evidence**
  - [sdk/native/src/worker_trace.rs:172-187](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker_trace.rs#L172-L187) clears `state.active_turns` and sets `state.failure = None` in `set_live()`. [sdk/native/src/replay.rs:428-436](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/replay.rs#L428-L436) calls `lane.set_live()` at `finalize_offline` before checking either field.
- **Proposed minimal fix**
  1. Add `verify_replay_complete(&self) -> Result<(), String>` to [`WorkerTrace`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker_trace.rs) to check `Self::check_failure(&state)?`, `state.replay_events.is_empty()`, and `state.active_turns.is_empty()`. Call it in [`replay::set_mode`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/replay.rs#L421) under `finalize_offline` before `set_live()`.
  2. Check `runtime.last_error()` in [`stop_worker_checked`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/lib.rs#L734-L747).
  3. In [`PocketReplayRunner._validateReplayEvidence`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L2935-L2975), track pairing of `turn.begin` with `turn.end` or `worker.exit` across transactions and reject open turns.

---

#### [P1-2] Live `captureStop` switches from `Mode::Record` to `Mode::Live` before the current Worker turn ends, truncating the recording
- **Source locations**
  - [sdk/native/src/worker_trace.rs:580-673](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker_trace.rs#L580-L673)
  - [sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart:1705-1726](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L1705-L1726)
- **Conditions**
  - The user stops live recording through the panel, invoking [`FfiPocketRuntime._captureStopBoundary`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L1680-L1727), after `turn.begin` is logged and `state.active_turns` is nonempty and before the Worker reaches `turn.facts` or `turn.end`.
- **Cause**
  - `_captureStopBoundary()` calls `_traceTransactionBegin()` and `_traceTransactionEnd()` in sequence ([`WorkerTrace::finish_batch`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker_trace.rs#L580-L673)), then invokes `_setTraceClockMode(0)` (`lane.set_live()`) in `finally`.
  - In `Mode::Record`, `finish_batch()` moves `pending_events` to `batch_events` and returns immediately, even with active turns. `lane.set_live()` switches to `Mode::Live` and the final `turn.facts` and `turn.end` no longer get recorded. The turn is cut off after `turn.begin`.
- **Observed evidence**
  - [sdk/native/src/worker_trace.rs:604-672](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker_trace.rs#L604-L672) loops on `wait_timeout` only in `Mode::Replay`. `Mode::Record` has no wait for `state.active_turns`.
- **Proposed minimal fix**
  - Before closing the `captureStop` batch in `Mode::Record` or switching to `Mode::Live` in `replay::set_mode(host, 0)`, wait on `self.changed.wait_timeout` for active Worker turns when `!state.active_turns.is_empty() && state.incomplete.is_none()`. Bound the wait by `CUT_WAIT_TIMEOUT` and `turn_budget_micros`, then call `mark_incomplete` on timeout.

---

#### [P1-3] WeChat `PocketWechatHost.schedule()` fast-forwards at timer registration, and `resize()` breaks `this.scale`, permanently stopping Canvas2D drawing
- **Source locations**
  - [sdk/targets/wechat/template/wechat-host.js:140-159,210-217,225-261](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/targets/wechat/template/wechat-host.js#L140-L261)
  - [sdk/.cache/pocketjs/programs/web/wasm/src/lib.rs:269-294](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/.cache/pocketjs/programs/web/wasm/src/lib.rs#L269-L294)
- **Conditions**
  1. **Early clock advancement.** A Guest timer for 5000 ms (`framesUntilTimer = 300`) registers `setTimeout(..., 5000)`. At 10 ms a tap, `host.response`, or keyboard event arrives.
  2. **Frozen screen after resize.** A short startup viewport, small window, or landscape orientation yields `this.scale = 2`, for example `390x600` gives `Math.floor(1365 / 600) = 2`. When the keyboard closes or the window expands to `390x844`, `Math.floor(1365 / 844) = 1`.
- **Cause**
  1. In [`PocketWechatHost.schedule()`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/targets/wechat/template/wechat-host.js#L246-L258):
     ```js
     this.running = true;
     this.exports.web_wechat_skip_idle_frames(this.host, Math.max(0, frames - 1));
     const delay = Math.max(1, Math.ceil(frames * 1000 / Math.max(1, Number(state.simulationHz) || 60)));
     this.timer = setTimeout(() => { ... }, delay);
     ```
     `web_wechat_skip_idle_frames` executes as `setTimeout` is registered at `t = 0`, irrespective of time elapsed. If input at 10 ms calls `stopScheduled()` and `advance()`, the guest frame counter already advanced `frames - 1`, so its 5000 ms timer fires at 10 ms. Also, `resize()` at line 157 calls `this.schedule()` without first calling `this.stopScheduled()`. If `this.running` remains true while the old `this.timer` waits, line 227 returns early and leaves the old timer.
  2. [`PocketWechatHost.resize()`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/targets/wechat/template/wechat-host.js#L144-L155) updates `this.scale` to `nextScale`, e.g. from 2 to 1, and reconstructs `this.imageData` at length `nextWidth * nextHeight * 4`. WASM [`web_resize`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/.cache/pocketjs/programs/web/wasm/src/lib.rs#L275-L278) calculates `let scale = physical[0] / old[0];` and retains boot scale 2 with length `nextWidth * nextHeight * 16`. Every following frame hits `if (!pointer || length !== this.imageData.data.length) return;` in [`draw()`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/targets/wechat/template/wechat-host.js#L214), freezing the screen.
- **Observed evidence**
  - Compare [wechat-host.js:144-155](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/targets/wechat/template/wechat-host.js#L144-L155), [wechat-host.js:214](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/targets/wechat/template/wechat-host.js#L214), [wechat-host.js:249-258](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/targets/wechat/template/wechat-host.js#L249-L258), and [programs/web/wasm/src/lib.rs:273-278](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/.cache/pocketjs/programs/web/wasm/src/lib.rs#L273-L278).
- **Proposed minimal fix**
  1. Record `this.timerStartedAt = Date.now()` and `this.scheduledHz` in `PocketWechatHost.schedule()`. On the timeout callback, call `web_wechat_skip_idle_frames(this.host, Math.max(0, frames - 1))`. For an earlier `stopScheduled()`, advance by `Math.min(frames - 1, Math.floor((Date.now() - this.timerStartedAt) * this.scheduledHz / 1000))`. In `resize()`, call `this.stopScheduled()` before `this.schedule()`.
  2. Keep `this.scale` immutable after `web_wechat_boot`. Clamp logical width and height in `resize(width, height)` to `Math.floor(MAX_CANVAS_DIMENSION / this.scale)`.

---

#### [P1-4] An offstage pre-mount frame resolves multi-app `system.runtime.awaitFirstFrame` early, and `SystemUI.isPresented` breaks integration assertions
- **Source locations**
  - [sdk/lib/src/pocket_system_host.dart:307-311,337-360,679,727-743,1158-1167,1336](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L307-L360)
  - [sdk/packages/pocket_flutter/lib/src/pocket_view.dart:4061-4089](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L4061-L4089)
  - [demo/integration_test/multi_app_test.dart:92-95](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/integration_test/multi_app_test.dart#L92-L95)
  - [demo/integration_test/guest_interaction_test.dart:51-75,98](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/integration_test/guest_interaction_test.dart#L51-L98)
- **Conditions**
  1. Prewarm a child with `prewarmApp` and call `openApp`, or cold-start a child whose `Offstage` pre-mount finishes its first frame before `awaitFirstFrame`.
  2. Run [demo/integration_test/multi_app_test.dart](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/integration_test/multi_app_test.dart#L92-L95).
- **Cause**
  1. [`PocketSystemHost._create`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L662-L679) adds the child to `_applications` and `hostSurfaceResidents` at lines 307–311. [`PocketView._buildSurface`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L4061-L4089) mounts resident children absent from `SURFACE_QUAD` beneath `Offstage(offstage: true)`. The child's initial frame invokes [`_onFirstFrame`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L1158-L1167) and sets `instance.firstFrameReady` to `true`.
  2. [`_awaitFirstFrame`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L727-L743) checks only `if (!instance.firstFrameReady)`, so it can return before SystemUI submits the child's `SURFACE_QUAD`, while `compositorVisible` and `session.foreground` are still false.
  3. [`PocketSystemHost._publishFacts`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L1336) publishes `isPresented` as `instance.isSystemUI || instance.compositorVisible`, so `_showcase` (SystemUI) remains presented when a full-screen child is open. This breaks `expect(host.instances.singleWhere((e) => e.appId == _showcase).isPresented, isFalse)` in [demo/integration_test/multi_app_test.dart:92-95](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/integration_test/multi_app_test.dart#L92-L95). Meanwhile [guest_interaction_test.dart:98](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/integration_test/guest_interaction_test.dart#L98) uses `tester.renderObject<RenderBox>(find.byType(PocketView))`. With parent and child mounted, scrolling can match several `PocketView`s and throw `StateError`.
- **Observed evidence**
  - [sdk/lib/src/pocket_system_host.dart:727](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L727), [sdk/lib/src/pocket_system_host.dart:1336](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L1336), and [demo/integration_test/multi_app_test.dart:92-95](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/integration_test/multi_app_test.dart#L92-L95).
- **Proposed minimal fix**
  1. Require `instance.firstFrameReady && instance.compositorVisible` in `_awaitFirstFrame`. Complete the waiter once `_observeCompositorSlot` observes `visible == true` and `firstFrameReady == true`.
  2. Align the definition of SystemUI `isPresented` in `PocketSystemHost._publishFacts` and `multi_app_test.dart`. Scope `find.byType(PocketView)` and `painters(tester)` in `guest_interaction_test.dart` to the active focused `PocketView`.

---

#### [P1-5] The shared notification batch limit and unconditional clearing of `wake_pending` can strand offload requests or cancellations
- **Source locations**
  - [sdk/packages/pocket_flutter/lib/src/pocket_offload_binding.dart:162-197](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_offload_binding.dart#L162-L197)
  - [sdk/native/src/offload.rs:475-508](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/offload.rs#L475-L508)
- **Conditions**
  1. One notification batch has more than eight accumulated cancellations plus new requests, for example eight cancellations from `set_session` or timeouts while a new request arrives.
  2. During `_onNativeNotify`'s `cancel: false` stage, synchronous request validation fails and `_completeFailure` → `OffloadHost::complete` sets `wake_pending` to true. A concurrent timeout in `deadline_loop` queues a cancellation and coalesces its `notify()` into the pending wake. The next `_takeRecord(cancel: false)` → `take_request()` then unconditionally clears `wake_pending` through `self.inner.rearm_wake()`.
- **Cause**
  - [`_onNativeNotify`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_offload_binding.dart#L162-L197) shares the same `var drained = 0` and `_pocketOffloadBatchLimit = 8` across its `cancel: true` and `cancel: false` loops. Reaching the limit does not schedule another drain. [`OffloadHost::take_request`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/offload.rs#L476) and [`OffloadHost::take_cancellation`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/offload.rs#L498) call `self.inner.rearm_wake()` unconditionally before locking, setting `wake_pending = false` and leaving no notification for queued records.
- **Observed evidence**
  - Both loops in [pocket_offload_binding.dart:166,182](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_offload_binding.dart#L166-L197) use `while (drained < _pocketOffloadBatchLimit)`. [offload.rs:476,498](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/offload.rs#L476-L508) calls `self.inner.rearm_wake()` outside the lock.
- **Proposed minimal fix**
  - Clear `wake_pending` in `OffloadHost::take_request` and `take_cancellation` only once `state.request_queue.is_empty() && state.cancellations.is_empty() && state.replies.is_empty()`. Drain the `cancel: true` and `cancel: false` queues independently in `_onNativeNotify`, then recheck cancellations created during request draining.

---

#### [P1-6] On-demand snapshot and zero-tick frames omit `axis_deltas`, `motion`, and `analog`. Retained `elapsed_credit_ms` stalls virtual time after a 0 ms frame
- **Source locations**
  - [sdk/native/src/demand.rs:101-124,180-182,268-278](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/demand.rs#L101-L124)
  - [sdk/native/src/lib.rs:2207-2215](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/lib.rs#L2207-L2215)
  - [sdk/packages/pocket_flutter/lib/src/pocket_view.dart:908-918](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L908-L918)
  - [sdk/native/patches/demand-scheduler.patch:789](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/patches/demand-scheduler.patch#L789)
- **Conditions**
  1. A guest idle or on a half-step `remaining_ticks == 0` frame (60 Hz guest on 120 Hz display) receives wheel or trackpad scroll (`input.axis` or duplex scroll), gyro (`input.motion`), or stick (`analog`) input and executes a zero-tick frame.
  2. After $T\text{ ms}$ idle, window or keyboard resize makes [`PocketView._resizeRuntime`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L908-L918) call `resizeViewport` and immediately `deltaFn(runtime, 0)`.
  3. A Solid guest releases a D-pad press while the `bindDpadScroll` scroller remains in the `"chase"` animation state.
- **Cause**
  1. With `remaining_ticks == 0`, [`run_virtual_frames`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/lib.rs#L2207-L2215) checks only `!host.pending_text.is_empty() || host.external_work_pending`. [`demand::capture`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/demand.rs#L101-L107) also omits `!host.axis_deltas.is_empty() || host.motion.is_some() || host.analog != 0x8080 || host.right_analog != 0x8080`. The zero-tick frame leaves `axis_deltas` and `motion` unconsumed and returns `Work::Idle` (`-1.0`), stopping scheduling.
  2. [`demand::before_external`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/demand.rs#L268-L278) adds idle interval $T$ to `host.demand.elapsed_credit_ms`. When `_resizeRuntime` calls `pocket_frame_delta(handle, 0.0)`, [`ticks_for_delta(host, 0.0)`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/demand.rs#L180-L182) debits only `0.0`. [`demand::capture`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/demand.rs#L118) reanchors `idle_anchor = Some(Instant::now())` and retains `elapsed_credit_ms == T`. Later active-frame `delta_ms` keeps getting debited until the $T\text{ ms}$ credit runs out.
  3. Solid [`kinetics.ts:48`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/patches/demand-scheduler.patch#L789) registers `bindDpadScroll` with `{ continuous: () => hasScrollInput }`. Vue Vapor at line 811 also checks `|| s.state() !== "idle"`.
- **Observed evidence**
  - Compare [demand.rs:101-124](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/demand.rs#L101-L124), [demand.rs:180-182](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/demand.rs#L180-L182), [lib.rs:2207-2215](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/lib.rs#L2207-L2215), and [demand-scheduler.patch:789,811](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/patches/demand-scheduler.patch#L789-L811).
- **Proposed minimal fix**
  1. Check `!host.axis_deltas.is_empty()`, `host.motion.is_some()`, and non-neutral `analog`/`right_analog` in `demand::capture` and `run_virtual_frames`.
  2. Update `_lastSchedulerTimestamp` after `PocketView._resizeRuntime` completes `deltaFn(runtime, 0)`. Clear unused `elapsed_credit_ms` when `demand::capture` reanchors `idle_anchor`.
  3. Use `{ continuous: () => hasScrollInput || s.state() !== "idle" }` in Solid `kinetics.ts:48`.

---

### P2 edge cases, protocol consistency, and recovery

#### [P2-1] Interleaving `io.fact` with other actors in offline `asyncStop` replay can deadlock or report an event ordering error
- **Source locations**
  - [sdk/native/src/worker.rs:2011-2022,2794-2804](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker.rs#L2011-L2022)
  - [sdk/native/src/worker_trace.rs:879-884](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker_trace.rs#L879-L884)
- **Conditions**
  - An `asyncStop` replay batch has `draining_stopped_turn == true` while the Worker drains its final active turn. A non-Worker event such as `scheduler.stop` or `offload.shutdown` appears before that Worker's `io.fact` and `turn.end` or `worker.exit`.
- **Cause**
  1. In the `draining_stopped_turn` branch, [`await_replay_event`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker.rs#L2011-L2022) returns `trace.await_turn(actor, session, kind)` at line 2020 if the front event is something other than `io.fact`. Once the non-Worker event is consumed, the front becomes `io.fact` (owned by `TraceActor::Worker` in Replay). `await_turn` then fails because `expected.kind == "io.fact" != kind`.
  2. [`trace_worker_exit`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker.rs#L2794-L2804) calls `inject_replay_io_facts` only once before `observe("worker.exit")`.
  3. [`wait_for_advance_timeout`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker_trace.rs#L879-L884) checks `if state.stopped_sessions.contains(&event.session)` without testing `!stopped_event_allowed(...)`, which conflicts with lines 130–137 admitting stopped-session `"io.fact"` injection.
- **Proposed minimal fix**
  - At line 879 of `wait_for_advance_timeout`, add `&& !stopped_event_allowed(&state, TraceActor::for_event(Mode::Replay, event), &event.session, &event.kind)`. In `draining_stopped_turn` and `trace_worker_exit`, repeatedly let other actors advance and re-run `inject_replay_io_facts` until the target event reaches the front.

---

#### [P2-2] Multi-app kernel `system.ts` can evict split-screen residents, retain stale presentation IDs, reject caller cancellation, or strand a nested SystemUI promise
- **Source locations**
  - [sdk/packages/pocket_ui/src/system.ts:624-677,1222-1268,1317-1332,1397-1401,1670-1695,1779-1788](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_ui/src/system.ts#L1222-L1401)
  - [sdk/packages/pocket_ui/src/platform.ts:78-88](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_ui/src/platform.ts#L78-L88)
- **Conditions**
  1. Use [`presentSurfaces`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_ui/src/system.ts#L624-L677) to show the stack-top app and a prewarmed companion in split-screen. Create another instance to trigger [`ensureCapacity`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_ui/src/system.ts#L1222-L1248), or let the companion crash and trigger [`handleRuntimeTermination`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_ui/src/system.ts#L1691-L1694).
  2. Child app `A` calls `const launch = await platform.launchApp(B)`, then `launch.cancel()`.
  3. SystemUI opens `A`, then calls `openApp(B)` from its control domain, pushing `call_B: caller = system-ui`. A crash or generation change in `A` triggers `cancelStackFrom(1)` or `abandonStackFrom(1)`.
- **Cause**
  1. `ensureCapacity` at lines 1222–1248 excludes `stackInstances` and `callInstances`, but includes `this.presentedInstanceIds`. `destroyRuntime` at 1250–1268 and the `index < 0` branch of `handleRuntimeTermination` at 1691–1694 leave destroyed IDs in `this.presentedInstanceIds`.
  2. [`cancelApp`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_ui/src/system.ts#L1318-L1331) invokes `authorizeForeground`, which rejects caller A while B is on top, then checks `source.instanceId !== call.targetInstanceId`. Only target B or SystemUI can cancel. Caller `call.callerInstanceId` is rejected despite owning the `launch.cancel()` handle.
  3. [`cancelStackFrom`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_ui/src/system.ts#L1397-L1401) and [`abandonStackFrom`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_ui/src/system.ts#L1779-L1788) directly call `this.calls.delete(nestedCall.requestId)`. When the nested caller is still alive, such as `system-ui`, it receives no `platform.result` with `cancelled: true`, leaving `launch.result` unresolved.
- **Proposed minimal fix**
  1. Protect `this.presentedInstanceIds` in `ensureCapacity`. Clear the IDs in `destroyRuntime` and notify `presentationListeners`.
  2. Use `authorizeRuntime` in `cancelApp` and permit `source.instanceId === call.callerInstanceId && source.generation === call.callerGeneration`.
  3. In `cancelStackFrom` and `abandonStackFrom`, send `{ cancelled: true, value: null, reason }` for removed calls whose caller remains alive in the same generation.

---

#### [P2-3] `PocketOffloadHttpRuntime._runHttp` races with cancellation, overrides custom Content-Type, and mishandles redirects. Worker HTTP `ureq` does not shrink each hop's timeout against the overall deadline
- **Source locations**
  - [sdk/packages/pocket_flutter/lib/src/pocket_offload_runtime.dart:321-368](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_offload_runtime.dart#L321-L368)
  - [sdk/native/src/worker.rs:3325-3347](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker.rs#L3325-L3347)
- **Conditions**
  1. An Offload HTTP request receives native cancellation or times out during `await _client.openUrl(currentMethod, uri)`.
  2. Offload sends a POST with `Content-Type: application/json` and sees 301/302/303, or a HEAD sees 303.
  3. Worker HTTP follows multiple redirects, up to five, each near `descriptor.timeout` for connecting or reading.
- **Cause**
  1. [pocket_offload_runtime.dart:321-323](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_offload_runtime.dart#L321-L323) does not recheck `active.cancellation.isCancelled` after `await _client.openUrl(...)` returns and assigns `active.request = req`. Cancellation during the wait therefore cannot abort the request.
  2. Lines 336–338 always assign `req.headers.contentType = ContentType.text` with a nonempty `currentBody`, overriding line 334's caller header. Lines 362–368 convert POST to GET without removing `content-type` and `content-length` from `requestHeaders`, and convert HEAD to GET on 303.
  3. [worker.rs:3325-3330](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/worker.rs#L3325-L3330) builds one `ureq::Agent` for the request with fixed `.timeout_connect(descriptor.timeout).timeout_read(descriptor.timeout)`. Individual redirects ignore the remaining `deadline.saturating_duration_since(Instant::now())`.
- **Proposed minimal fix**
  - After `active.request = req;`, run `if (active.cancellation.isCancelled) { req.abort(); active.cancellation.throwIfCancelled(); }`. Default to `ContentType.text` only when `requestHeaders` omits `content-type`. Remove `content-type` and `content-length` on redirect to GET, and preserve HEAD. In `worker.rs`, set the `ureq` timeout from the remaining deadline at each hop.

---

#### [P2-4] OTA `PocketSession.runtimeInfo()` omits `worker`, and Worker verification reads `tickHz` and `bindingGeneration` from bundled `_metadata`
- **Source locations**
  - [sdk/lib/src/pocket_session.dart:237-254,379-388](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_session.dart#L237-L254)
- **Conditions**
  - Activate a signed Worker update through OTA (`active != null`) and call `runtime.info` or verify Worker artifacts.
- **Cause**
  - [`runtimeInfo()`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_session.dart#L239) spreads `..._metadata` only when `active == null`, with no mapping of `active!.package.manifest.payload.worker` when active. Lines 382–386 pass `expectedTickHz: tickHz` to `PocketWorkerArtifact.verify` from bundled `_metadata['tickHz']` even when the active package has its own `worker['tickHz']`.
- **Proposed minimal fix**
  - In `runtimeInfo()`, emit `'worker': active!.package.manifest.payload.worker` when `active != null && active!.package.manifest.payload.worker != null`. Use the active package's `tickHz` in `PocketWorkerArtifact.verify`.

---

#### [P2-5] WeChat `cancelPending()` and `dispose()` are not exception-safe, and the index page loses resizes during WASM instantiation
- **Source locations**
  - [sdk/targets/wechat/template/wechat-host.js:598-622](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/targets/wechat/template/wechat-host.js#L598-L622)
  - [sdk/targets/wechat/template/pages/index/index.js:18-37,79-81](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/targets/wechat/template/pages/index/index.js#L79-L81)
- **Conditions**
  1. `dispose()` or `hide()` calls `cancelPending()` with async capability requests pending, and `this.respond()` throws or a Guest `.catch()` makes a synchronous new request.
  2. `wx.onWindowResize` or `wx.onKeyboardHeightChange` fires while `this._host.start(...)` awaits `WXWebAssembly.instantiate`.
- **Cause**
  1. [`cancelPending`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/targets/wechat/template/wechat-host.js#L598-L607) iterates `this.pending.values()` and calls `this.respond(...)` without protection before `this.pending.clear()`. If `web_wechat_deliver` throws, `dispose()` exits before `this.exports.web_destroy(this.host)` at line 615, leaking the WASM instance and remaining timers.
  2. [`index.js:79-81`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/targets/wechat/template/pages/index/index.js#L79-L81) does not sync dimensions updated during instantiation, `this._width` and `this._height - this._keyboardHeight`, via `this._host.resize(...)` once `start()` resolves.
- **Proposed minimal fix**
  - Snapshot and clear `this.pending` and clear all timers and AbortControllers in `cancelPending()`. Then, when `!this.disposed`, wrap `this.respond()` in `try/catch`. Ensure `web_destroy` executes through `try/finally` in `dispose()`. In `index.js` under `start().then(...)`, call `this._host.resize(this._width, Math.max(1, this._height - this._keyboardHeight))`.

---

#### [P2-6] A fixed `viewport: slot.bounds.size` disables child `PocketView.automaticViewport`, causing a one-frame scale jump during keyboard and layout changes
- **Source locations**
  - [sdk/lib/src/pocket_system_host.dart:327-334](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L327-L334)
  - [sdk/packages/pocket_flutter/lib/src/pocket_view.dart:1656-1673,1775-1779,3630-3653](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L3630-L3653)
- **Conditions**
  - A child in `PocketSystemHost` relayouts as the keyboard opens or closes or the parent `<CompositorSurface>` changes size.
- **Cause**
  - [`PocketView._buildSurface`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L3999-L4005) sizes the child using `Positioned(width: op.width * scaleX, height: op.height * scaleY)`. [`PocketSystemHost._buildCompositorSurface`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L332) additionally sets `viewport: slot.bounds.size`. The child's `automaticViewport` condition (`widget.runtime == null && widget.viewport == null && !_resizeUnavailable`) is then permanently false. In the frame before the native post-frame resize returns, it falls back to `_fitSurfaceSize` and `Center`, causing a scale and centering jump.
- **Proposed minimal fix**
  - Omit `viewport: slot.bounds.size` in [`PocketSystemHost._buildCompositorSurface`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L327-L334) so the enclosing `Positioned` constraints drive the child's `automaticViewport`.

---

### P3 minor defects, build coverage, and documentation discrepancies

#### [P3-1] `PocketView._applyFrame` focus detection includes clipped application surfaces. `PocketOp.fromJson` omits the `0..2` range check for `align`
- **Source locations**
  - [sdk/packages/pocket_flutter/lib/src/pocket_view.dart:1617-1632](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L1617-L1632)
  - [sdk/packages/pocket_flutter/lib/src/pocket_model.dart:127,682-683](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_model.dart#L127)
- **Conditions and cause**
  1. `focusedApplication` in `_applyFrame` checks only `op.kind == 'application' && op.focused`. `_buildSurface` at lines 3860–3878 checks `visible.isEmpty`. When a fully offscreen `focused: true` child surface scrolls into view, `previousFocus == nextFocus`, so the parent leaves its ongoing gesture and input field active.
  2. At lines 682–683, `PocketFrame.fromBinary` throws `FormatException` for a text op with `align > 2`. `PocketOp.fromJson` at line 127 lacks type and range validation for `0..2`.
- **Proposed minimal fix**
  - Share `_effectiveFocusedApplicationHandle(PocketFrame frame)` across `_applyFrame` and `_buildSurface`, including a nonempty viewport/clip intersection. Validate `align` within `0..2` in `PocketOp.fromJson`.

#### [P3-2] Mini App build skips Flutter-specific `validateSystemFile` checks, and `SYSTEM_COMPOSITOR_IMPLEMENTATION.md` understates Worker support
- **Source locations**
  - [demo/js/scripts/build_mini_apps.ts:12](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/js/scripts/build_mini_apps.ts#L12)
  - [sdk/scripts/build_system.ts:471-474](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/scripts/build_system.ts#L471-L474)
  - [sdk/docs/SYSTEM_COMPOSITOR_IMPLEMENTATION.md:87-88](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/docs/SYSTEM_COMPOSITOR_IMPLEMENTATION.md#L87-L88)
- **Conditions and cause**
  1. `build_mini_apps.ts:12` calls `validateSystemFile(resolve(scriptRoot, "../pocket.system.json"))` without `{ target: "pocket-flutter" }`. [`validateSystem`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/scripts/build_system.ts#L471-L474) skips `validateAndResolveSystemPlan` and `deriveCompositorSurfaceRegistry`.
  2. `sdk/docs/SYSTEM_COMPOSITOR_IMPLEMENTATION.md:87-88` says the `pocket-flutter` target omits Worker capability, but [`FLUTTER_TARGET_CAPABILITIES`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/scripts/flutter_target.ts#L14) contains `"runtime.worker"`.
- **Proposed minimal fix**
  - Pass `{ target: "pocket-flutter" }` at `build_mini_apps.ts:12` and update `SYSTEM_COMPOSITOR_IMPLEMENTATION.md:87-88`.

---

## 3. Commands, test counts, and environment limits

> [!NOTE]
> At audit start, the shared workspace included uncommitted edits from other sessions to `demo/js/manifest.json`, `demo/assets/guest-manifest.json`, `performance_history.dart`, `pocket_performance.dart`, `pocket_view.dart`, and new tests. All commands ran under the read-only workspace constraint without reverting those edits. The table distinguishes observed runs from the exact `de8b051d` target snapshot.

| No. | Command executed | Result | Passed / failed / skipped | Evidence and baseline |
|---|---|---|---|---|
| 1 | `python3 sdk/scripts/check_architecture.py` | **PASS** | 1 / 0 / 0 | Architecture dependency and layering checks passed. |
| 2 | `cargo test --locked --manifest-path sdk/native/Cargo.toml` | **PASS** | **74 passed / 0 failed / 1 ignored** | `src/lib.rs` unit tests: 68 passed, 0 failed, 0 ignored. `tests/duplex_layout.rs`: 6 passed, 0 failed, 1 ignored. The ignored test is the 10-second `bench_10s_60fps_duplex_and_layout` benchmark. |
| 3 | `cargo build --locked --manifest-path sdk/native/Cargo.toml --lib --bin pocket_probe --bin pocket_worker_probe` | **PASS** | Build succeeded | Built fresh `sdk/native/target/debug/libpocket_flutter.dylib`, `pocket_probe`, and `pocket_worker_probe`. |
| 4 | `bun sdk/scripts/tests/worker_recording_fixture.ts /tmp/pocket-audit-de8b051-worker-fixture` | **PASS** | Generation succeeded | Generated actual `app.qjbc`, `app.pak`, `app.worker.qjbc`, `app.bytecode.json`, and `guest-manifest.json`. |
| 5 | `cd sdk && TMPDIR=/tmp bun test --timeout 120000` | **PASS** | **67 passed / 0 failed / 0 skipped** (18 files, 30.06s) | Includes `system_kernel.test.ts`, `build_system.test.ts`, `worker_build_package.test.ts`, and `wechat_build.test.ts`. |
| 6 | `cd demo/js && TMPDIR=/tmp bun test --timeout 120000` | **PASS** | **12 passed / 0 failed / 0 skipped** (3 files. Baseline `de8b051d`: 2 files and **8 passed**.) | Includes `guest_state.test.ts` and `hardware_platform.test.ts`. |
| 7 | `cd demo/js && POCKET_BUILD_GUEST=0 POCKET_NATIVE_PROBE=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/debug/pocket_probe bash scripts/test_guest.sh` | **PASS** | All passed | `guest_ablation.ts` and `native_guest_probe.ts` drove `pocket_probe` against the actual `demo/assets/app.qjbc`. |
| 8 | `cd sdk/packages/pocket_services && flutter analyze --no-pub && flutter test --no-pub --reporter expanded` | **PASS** | Analyze: 0 issues. Test: **27 passed / 0 failed / 0 skipped** | Includes OTA downgrade rejection, concurrent prepare, path traversal defense, permission intersection, and plugin revocation. |
| 9 | `cd sdk/packages/pocket_hardware && flutter analyze --no-pub` | **PASS** | Analyze: 0 issues | This package has no separate `test/`. Hardware plugin tests are in `demo/test/hardware_plugin_test.dart`. |
| 10 | `cd sdk/packages/pocket_flutter && flutter analyze --no-pub && POCKET_NATIVE_LIBRARY=.../libpocket_flutter.dylib flutter test --no-pub --concurrency=1 --reporter expanded` | **PASS** | Analyze: 0 issues. Test: **104 passed / 0 failed / 0 skipped** (baseline `de8b051d`: **102 passed**) | All FFI tests actually ran with zero skips: binary frames, duplex, timer wake, offload bindings, and recording/replay. |
| 11 | `cd sdk && flutter analyze --no-pub && POCKET_NATIVE_LIBRARY=.../libpocket_flutter.dylib POCKET_RECORDING_WORKER_FIXTURE_DIR=/tmp/pocket-audit-de8b051-worker-fixture flutter test --no-pub --concurrency=1 --reporter expanded` | **PASS** | Analyze: 0 issues. Test: **59 passed / 0 failed / 0 skipped** (baseline `de8b051d`: **56 passed**) | Two `recording_worker_ffi_test.dart` tests and one `recording_worker_session_test.dart` test ran actual Worker QJBC and local HTTP recording and offline replay after shutdown, with no skips. |
| 12 | `cd demo && flutter analyze --no-pub && POCKET_NATIVE_LIBRARY=.../libpocket_flutter.dylib flutter test --no-pub --concurrency=1 --reporter expanded` | **FAIL** | Analyze: 0 issues. Test: **19 passed / 1 failed / 0 skipped** | `demo/test/showcase_admission_test.dart` failed with `Bad state: Missing capabilities: ui.compositor-surfaces` (see **[P0-1]**). The 20-pass count in `VALIDATION.md` was stale. |
| 13 | `rm -rf /tmp/pocket-audit-de8b051-wechat-lobby && RUSTUP_TOOLCHAIN=1.98.1 bun sdk/scripts/build_wechat.ts --project-root=demo/js/apps/lobby --outdir=/tmp/pocket-audit-de8b051-wechat-lobby && node sdk/targets/wechat/tests/qjbc_pointer.mjs /tmp/pocket-audit-de8b051-wechat-lobby` | **PASS** | 1 / 0 / 0 | Built actual wasm32-unknown-unknown + QuickJS 0.12.2 + 161,360-byte Lobby `app.qjbc`. Node WebAssembly verified tap-driven pixel changes from 0 to 1 and `host.response`. |

### Environment and omitted runs
1. **WeChat DevTools and physical device.** This CLI environment ran `qjbc_pointer.mjs` in Node WebAssembly against generated `.wasm.br` and QJBC/PAK. WeChat DevTools and devices require separate acceptance. Source inspection also identified the `schedule()` and `resize()` defects in `wechat-host.js` under **[P1-3]**.
2. **Physical Flutter and simulator integration (`demo/integration_test/*`).** The read-only review did not launch an external iOS Simulator or macOS host or modify existing daemons. Source comparison confirmed the `isPresented` mismatch between `demo/integration_test/multi_app_test.dart:92-95` and `PocketSystemHost._publishFacts` under **[P1-4]**.

---

## 4. Feature acceptance matrix

| Module or capability | Status | Evidence |
|---|---|---|
| **1. JS multi-app platform.** Cross-app opens and results, shared storage ACL, messaging, prewarm and failure cleanup, generation isolation, and permission boundaries. | **Partially verified** | `system_kernel.test.ts`, `platform_data_test.dart`, and `platform_session_test.dart` verify the call stack, ACLs, and foreground/background plugin revocation. Open findings include **[P0-1]** (missing `system.runtime.awaitFirstFrame` in the `de8b051d` manifest), **[P1-4]** (offstage early completion and always-true `SystemUI.isPresented`), and **[P2-2]** (LRU eviction of `presentSurfaces`, rejected child cancellation, and unresolved nested SystemUI promises). |
| **2. Official System composition and input.** `SURFACE_QUAD`, surface handles, clipping/Z order, focus, coordinates, `GLYPH_RUN` release, IME, and scroll tracking. | **Partially verified** | `pocket_compositor_view_test.dart`, `pocket_glyph_render_test.dart`, `pocket_view_input_test.dart`, and `pocket_frame_binary_ffi_test.dart` verify composition, T8 glyph-page cleanup, JSON/PFB1 parity, single delivery of raw text and IME, and input field scroll tracking. Open findings are **[P0-1]** (`showcaseConfig` missing `ui.compositor-surfaces`), **[P2-6]** (fixed child `viewport` disables `automaticViewport`), and **[P3-1]**. |
| **3. On-demand scheduling and performance.** Timers, Promise, `host.response`, Worker, IO, keyboard, route wakes, FPS beyond 60, and no polling. | **Partially verified** | `pocket_view_timer_ffi_test.dart`, `pocket_view_test.dart`, and `performance_history_test.dart` verify idle stop, timer wake, no polling, and FPS telemetry up to 1000 Hz. **[P1-6]** covers omitted `axis_deltas`/`motion`/`analog` in demand and zero-tick frames, virtual time stalled by retained `elapsed_credit_ms` after a 0 ms frame, and Solid `bindDpadScroll` missing `s.state() !== "idle"`. |
| **4. Worker, IO, and Offload.** Actual QJBC, ABI/hash/declaration checks, HTTP origin authorization, redirects/timeouts/cancellation, streaming backpressure, FFI lifecycle, and lock order. | **Partially verified** | `worker.rs` (68 Rust tests), `pocket_worker_test.dart`, `pocket_offload_runtime_test.dart`, and `pocket_offload_binding_ffi_test.dart` verify QJBC admission, origin policy, backpressure, and safe `NativeCallable` release. Open findings are **[P1-5]** (shared drain limit and lost wakes) and **[P2-3]** (openUrl cancellation, redirect method and headers, and per-hop ureq timeout). |
| **5. Deterministic recording and offline replay.** Global `seq`, transactions, time/random scalars, channel publish/latch, IO facts, offline replay after instance and HTTP shutdown, quotas, and v1 compatibility. | **Partially verified** | `recording_worker_ffi_test.dart`, `recording_worker_session_test.dart`, `pocket_recording_ffi_test.dart`, and `pocket_recording_test.dart` verify real Worker and HTTP recording, new-instance offline replay after shutdown, CPU budgets excluding trace waits, quota overflow marked `incomplete`, and v1 compatibility. Open findings are **[P1-1]** (false match with a truncated Worker turn), **[P1-2]** (capture stop skips an active turn's end), and **[P2-1]** (interleaved `io.fact` in `asyncStop`). |
| **6. Builds, updates, and permissions.** Worker packaging and OTA admission, idempotent pinned patches, and `backgroundSafe` permission lifecycle. | **Partially verified** | `worker_build_package.test.ts`, `pocket_package_update_test.dart`, and `platform_session_test.dart` verify `buildGuest` with `packageArtifacts`, patch idempotence, and `backgroundSafe` hardware revocation. Open findings are **[P0-2]** (CLI/Editor drop Worker artifacts and overwrite `guest-manifest.json`) and **[P2-4]** (OTA `runtimeInfo()` omits `worker`). |
| **7. WeChat single Guest.** Real QuickJS WASM + QJBC/PAK, input-driven rendering, `host.response`, and Node WebAssembly probe. | **Partially verified in Node** | `build_wechat.ts` and `qjbc_pointer.mjs` verify actual WASM + QJBC/PAK and tap-driven pixel changes under Node. Open WeChat host findings are **[P1-3]** (early idle fast-forward and broken resize scale) and **[P2-5]**. WeChat DevTools and device remain unverified. |
| **7b. WeChat DevTools and physical-device acceptance** | **Unverified** | Neither environment was available to the CLI. The Node probe establishes only Node execution. |
| **7c. Multi-app System, Worker, and Offload in WeChat** | **Unsupported** | `build_wechat.ts:292-360` and `wechat_build.test.ts` reject System manifests, `<CompositorSurface>`, Worker, and `io.offload` during build. |
| **8. Blaze build toolchain replacement** | **Evaluation only** | `sdk/docs/BLAZE_BUILD_EVALUATION.md` records feasibility. The default toolchain stays in use and the evaluation makes no runtime FPS claim. |

---

## 5. Redundancy identified by ablation

1. **Unused duplicate C shim [sdk/targets/wechat/wasm-shim.c](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/targets/wechat/wasm-shim.c#L1-L175) (175 lines)**
   - [`sdk/scripts/build_wechat.ts:282`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/scripts/build_wechat.ts#L282) copies the SHA-256-verified upstream cache `.cache/wechat-qjs-support/rquickjs-sys-0.14.0/wasm-shim/shim.c` for compilation. No script or config references `sdk/targets/wechat/wasm-shim.c`. Both files have SHA-256 `4939829098f8818477e0dc6668bd9249ef84c14a0c1d18b8531b53df4c490224`. Remove the local duplicate.

2. **Deprecated scalar TraceClock C ABI and redundant `TraceClock.last_*` state**
   - **Source evidence**
     - [sdk/native/src/lib.rs:3637-3651](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/lib.rs#L3637-L3651) (`pocket_trace_clock_begin`), [lib.rs:3692-3707](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/lib.rs#L3692-L3707) (`pocket_trace_clock_end`), [lib.rs:3733-3739](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/lib.rs#L3733-L3739) (`pocket_trace_clock_last_json`).
     - [sdk/native/src/replay.rs:117,123-125,288-304,460-482,544-554,576-583](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/replay.rs#L117-L125) (`TraceClock::last_completed`, `last_scalars`, `last_worker_events`, `last_offload_events`, `begin_scalar`, `end`, `last_json`).
   - Production [`FfiPocketRuntime._lookupTraceClock`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L2340-L2361) binds only `pocket_trace_clock_mode`, `pocket_trace_clock_begin_json`, and `pocket_trace_clock_end_json`. Dart has no callers of the three old scalar ABI functions. `TraceClock` clones `last_completed`, `last_scalars`, `last_worker_events`, and `last_offload_events` solely for `pocket_trace_clock_last_json`. Remove the three exports and serialize the result in `end_json` to avoid retained vectors after every recording or replay transaction.

3. **Unused [`PocketRecordingLimitException`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_recording.dart#L19-L24) and its two barrel exports**
   - **Source evidence** [sdk/packages/pocket_flutter/lib/src/pocket_recording.dart:19-24](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_recording.dart#L19-L24), [sdk/packages/pocket_flutter/lib/pocket_flutter.dart:31](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/pocket_flutter.dart#L31), [sdk/lib/pocket_sdk.dart:35](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/pocket_sdk.dart#L35).
   - Exceeding recording quotas calls `markIncomplete(...)` to record an incomplete capture. Nothing in `sdk/` or `demo/` constructs or catches `PocketRecordingLimitException`.

4. **Duplicate getters and aliases in [`PocketRecordingController`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_recording.dart#L445-L449)**
   - **Source evidence**
     - [pocket_recording.dart:445-446](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_recording.dart#L445-L446) returns `_recording` from `recording` and `completed`. No repository caller uses `completed`.
     - [pocket_recording.dart:448-449](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_recording.dart#L448-L449) returns `_bytes` from `recordedBytes` and `bytes`.
     - [pocket_recording.dart:583,616](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_recording.dart#L583-L616) defines `finish()` and a duplicate `stop() => finish()`.

5. **Deprecated `pocket_duplex_get_ring` stub and duplicate runtime ABI wrapper**
   - **Source evidence**
     - [sdk/native/src/lib.rs:4900-4909](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/lib.rs#L4900-L4909) always returns `null` from `pocket_duplex_get_ring`. All Dart callers moved to the v2 `pocket_duplex_endpoint_acquire` endpoint ABI.
     - [sdk/native/src/lib.rs:4554-4556](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/native/src/lib.rs#L4554-L4556) and [sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart:728-747,775-797](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L728-L797) show that `pocket_bytecode_actual_abi` is a three-line pass-through to `pocket_bytecode_runtime_abi()`. Dart `FfiPocketRuntime.hostRuntimeAbi` and `actualAbi` repeat the same two-symbol lookup fallback.

6. **Demo's two-line [demo/js/host.ts](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/js/host.ts#L1-L2) re-export and the 15-field copy in [`_ensureSystemCaps`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L1392-L1415)**
   - **Source evidence**
     - [demo/js/host.ts:1-2](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/demo/js/host.ts#L1-L2) only forwards `export * from "@pocket/ui/host";`. `demo/js/system.ts` imports the public module directly. Only `demo/js/app.tsx` and `demo/js/recording-panel.tsx` still import through `./host.ts`.
     - [`_ensureSystemCaps`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_system_host.dart#L1392-L1415) copies all 15 `PocketAppConfig` fields to add `_compositorSurfacesCapability`, duplicating [`PocketAppConfig.withPlugins`](https://github.com/CodeEagle/pocket/blob/10bffea54aff0f08dd0a6105e0dbaec0fb44301e/sdk/lib/src/pocket_config.dart#L112-L135).
