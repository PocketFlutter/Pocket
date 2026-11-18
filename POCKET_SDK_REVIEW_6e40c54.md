# Pocket SDK regression review and optimization proposals

Target `6e40c5486aab548ee70904b042b7d2a7a08e884a`, baseline `bba327e`. The implementation commit contains 127 files. This independent review followed the commit and was outside it.

AGY `gemini-4-argon-high` reviewed the full change. GPT-5.6 Luna Max independently reviewed hot paths for scheduling, events, and streams. The lead checked code and logs and reproduced key issues. The review left production code and three pre-existing untracked root review files untouched.

See [REVIEW_FIXES_6e40c54.md](sdk/docs/REVIEW_FIXES_6e40c54.md) for subsequent workspace fixes and verification. This report retains the target snapshot.

## Conclusion

Hold a stable SDK release. Existing regressions pass while sensor lifetime, event-listener isolation, and stream bounds remain open. Current evidence does not support replacing demand scheduling or converting every JSON path to PB. Production frame output already has a binary path.

The findings describe runtime reproductions, confirmed source paths, and proposed measurements. Physical iOS and Android hardware was outside runtime scope. Compilation and Dart fakes cover different boundaries. This review found no P0 and leaves overall security acceptance open.

## Confirmed issues

### R1 / P1: iOS one-shot reads stop the shared continuous sensor producer

- Location: `sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift:695`, `:2527`, `:2537`, `:2623`, and `:2654`.
- Trigger: Start `hardware.sensors.watch`, then call `hardware.sensors.read`. Include the permission request path in regression testing.
- Evidence: Watch starts updates on the shared `motionManager` and `altimeter` and sets `sensorStreamProducerRunning=true`. A read supersedes by calling `clearSensorOperationState()`, which unconditionally stops both managers, then stops them again on completion. The path leaves the watch producer and callbacks stopped.
- Impact: A subscription remains open and stops receiving samples without a terminal error. This is source-path evidence. Physical-device verification remains open.
- Proposal: Use one controlled sampling producer and let one-shot read consume the next sample, or isolate one-shot work in its own native manager where necessary. Clarify producer ownership so read cancellation preserves watchers. Test watch → read → timeout/cancel → increasing watch samples and two sessions.

### R2 / P1: A throwing JS event listener blocks later subscriptions and compatibility sinks

- Location: `sdk/packages/pocket_ui/src/host.ts:187`, `:212`, and `:224`.
- Trigger: An early `host.onEvent` consumer throws before a later stream or system listener.
- Evidence: The lead reproduced with actual `createHostBridge` in Bun: `{"error":"boom","later":0}`. `dispatchEvent` calls listeners directly in order. An exception also prevents `eventDeliver` from calling the previous sink. `onTick` has a similar gap. The Demo already supplies a virtual deadline scheduler, so a Demo timeout regression remains unverified.
- Impact: One consumer can suppress unrelated stream and system events. Add actual QuickJS coverage for exception behavior.
- Proposal: Isolate exceptions per listener, continue later listeners and the existing sink, and record bounded diagnostics through the existing bus.

### R3 / P2: Multiple adapters claim one host-initiated stream

- Location: `sdk/packages/pocket_ui/src/streams.ts:619`, `:835`, and `:319`.
- Trigger: Create two adapters on one HostBridge, then deliver host `stream.open` with ID `host-stream-1`.
- Evidence: The lead reproduced `openedA=1, openedB=1`. Disposing A sent `stream.cancel(host-stream-1)`; B kept its local record `open`.
- Impact: Cancellation semantics conflict and leave a locally open but remotely canceled subscription. The Hardware example primarily opens streams from the Guest. This is a public duplex API defect.
- Proposal: Reuse one adapter or a unique claimant per bridge, with cancellation ownership per consumer. Test open/data/cancel/dispose for two consumers before considering additional routing.

### R4 / P2: Dart maxBufferedMessages misses actual queued messages

- Location: `sdk/packages/pocket_services/lib/src/pocket_stream.dart:207`.
- Trigger: Deliver events to an unlistened or paused port.
- Evidence: `_buffered++ → _controller.add(value) → _buffered--` returns to zero synchronously and ignores the StreamController pending queue. The lead reran Luna's Dart reproduction: `maxBufferedMessages=1 batch=10001 received=10001 isClosed=false`.
- Impact: The public bridge buffer guarantee fails. The implementation inherited this behavior. PluginManager cumulative event and byte quotas guard a separate boundary. Each stream still needs a pending bound.
- Proposal: Count actual unconsumed events and define overflow for unlistened and paused consumers. Cover pause, resume, cancellation, and remote termination.

### R5 / P2: Android sensors share a throttle timestamp

- Location: `sdk/packages/pocket_hardware/android/src/main/kotlin/dev/pocketjs/pocket_hardware/PocketHardwarePlugin.kt:1485` and `:1495`.
- Trigger: Subscribe to multiple default sensors and deliver closely timed events.
- Evidence: Each stream has one `lastEventNs`. The first sensor advances it and drops others in that window, while the emitted packet contains only the first type. Synchronized arrival order can starve another type. Physical Android sampling remains unverified.
- Proposal: Define fixed-rate merged snapshots or independent per-type sampling. Prefer bounded snapshots consistent with iOS. For per-type events, track per-type timestamps and a total budget. Add native coverage for different rates and stable arrival order.

### R6 / P2: Android notification setup failure can lose its original error to disconnect cleanup

- Location: `sdk/packages/pocket_hardware/android/src/main/kotlin/dev/pocketjs/pocket_hardware/PocketGattConnection.kt:272` and `:495`, and `PocketHardwarePlugin.kt:1255` and `:1399`.
- Trigger: A CCCD notification operation fails and takes the invalidateConnection path.
- Evidence: `complete()` disconnects before dispatching operation completion. The disconnect callback removes notification state with generic disconnected. Later config completion exits on its identity check and loses the original cause.
- Scope: Notification config and related streams. Ordinary read/write completions own their results directly. Source ordering is confirmed, actual BLE remains open.
- Proposal: Preserve immediate fence/close and identity guards. Pass the original cause into notification cleanup and complete once. Preserve rejection of stale notifications.

### R7 / P2: Outbound batches lack early count and byte limits

- Location: `sdk/packages/pocket_ui/src/streams.ts:282`, `host.ts:235`, and `sdk/native/src/lib.rs:1004`.
- Trigger: Give `sendBatch` a large array. It fully runs every/map/stringify before native.
- Evidence: Actual SDK with fake transport encoded about 8.5 MB for 100000 events. A direct actual QuickJS `pocket._emit` probe used equivalent map/stringify shape and reported `accepted=true count=30000 outer_events=2 nested_events=30000 frame_json_bytes=2479219 last_error=`. It measures the native emit boundary independently of compiling the SDK module. Luna observed Guest OOM at 40000 in its probe. The result belongs to that input, with no universal threshold established.
- Impact: JS synchronous work and native decode and dispatch may hit heap OOM before a structured quota error. Per-stream inbound buffering does not bound this outbound path.
- Proposal: Bound count before large construction and bound bytes during encoding. Native emit should reject oversize consistently. Reuse accepted/error and add chunk/ack only if sustained throughput requires it.

## Ablations to prioritize

| Order | Change | Evidence and scope | Acceptance |
| --- | --- | --- | --- |
| 1 | Reuse decoded HostBridge.onEvent payloads in System, Platform, Display, and Demo shell. | The real Demo installs all of these. Luna measured five parses for one stream.data and synthetic Bun/macOS 20000-packet time of about 32.97→7.253 ms. Device QuickJS, FPS, and power remain unmeasured. | Preserve event order and cancellation, decode once, and measure device JS CPU, allocations, and p95 event delay. |
| 2 | Configure native sampling to the highest required subscription frequency and allow selected sensors. | Android uses SENSOR_DELAY_FASTEST and iOS motion runs at 60 Hz, followed by JS throttling. Output frequency differs from actual sampling. | Count callbacks and wakeups and measure power at 1/10/60 Hz, across multiple subscribers, and after the last subscriber exits. Stop with no subscriptions. |
| 3 | Limit JS sendBatch count and bytes before encoding, then evaluate chunk/ack if needed. | every→map→stringify builds the whole batch. Actual SDK fake transport produced about 8.5 MB, and actual QuickJS/native accepted 30000 events in a roughly 2.48 MB frame. See R7. | Reject before large allocations, measure peak JS heap and longest synchronous block, and surface errors. |
| 4 | Short-circuit unchanged native frames before constructing owned DrawOps. | `sdk/native/src/lib.rs:2318` clones ops/auxiliary/handles on cache hit, before unchanged at `:5136`. Luna observed increasing allocations with static ops. Cloning explains only part of the observed delta until isolated. | Compare allocations, bytes, and p50/p95 on empty, complex static, and transient-event frames. Preserve transient events. |
| 5 | Enforce admitted PAK size before reading the file. | `sdk/native/src/lib.rs:4660` reads up to 256 MiB before per-runtime PAK admission. This is earlier rejection within the existing contract. Whole-process RSS has no SDK cap promise. | Reject oversized files before reading, detect length changes and bounds during reads, and measure peak native allocation. |

Reuse HostBridge, streams, and demand scheduling and remove duplicate work. Compare JSON with PB or dedicated binary only if schema encoding dominates measured high-frequency messages. Frame output already uses binary.

## Evidence corrections

The original AGY report is in ignored `.pocket-build/review-6e40c54/argon-raw-report.md`, with event and test records in `argon-review-events.jsonl`. Source and actual reproductions take precedence:

- The public function is `pocket_create_with_memory_limits`. The cited `pocket_set_memory_limits`, dynamic limits, `PocketMemoryLimits.fromPolicy`, and total-app `maxTotalHeapBytes` are absent.
- The default host allowance is a documented 16 MiB policy. Keep access explicit. Tests should define whether catalog and manifest admission can tighten each other. This remains a contract question.
- `HARDWARE_STREAMS.md` does not promise `sensor` or `sensors` filters. On-demand selection remains a power improvement.
- Android FASTEST permissions and hardware behavior were not checked on-device. Registration exceptions are caught. The proposed universal Android 12+ failure was unverified.
- Universal Links, App Links, signed asset naming, and unlistened backpressure require separate proof. This review checked historical custom-scheme records. Cold start and Android delivery were not rerun.
- The original report summarized 256 tests. Executed batches total 297 and are recorded individually below.

## Tests executed in this review

AGY tool completion records show exit 0 for the commands below. Flutter used `--no-pub --concurrency=1`.

| Executor and directory | Command and scope | Result |
| --- | --- | --- |
| Lead / repo | `git diff --cached --check` before commit, `python3 sdk/scripts/check_architecture.py` | Passed |
| AGY / repo | `python3 sdk/scripts/check_architecture.py`, `git diff --check bba327e..6e40c54` | Passed |
| AGY / repo | `bun test` across UI streams, platform_experience, platform_client, system_kernel, recording | 19 pass |
| AGY / repo | `bun test` across plugin_types, platform_scaffold, package_update, streams_runtime, android_scaffold, ios_archive_outputs, tooling_scene, system_manifest, demand_scheduler, capability_panels, guest_state, hardware_platform, mobile_ui | 61 pass |
| AGY / repo | `bun test sdk/editor/test/editor_server.test.ts demo/js/tests/system_capabilities.test.ts` | 11 pass |
| AGY / sdk/native | `cargo test --locked --lib` | 81 pass |
| AGY and lead separately / sdk/native | `cargo test --locked --test memory_limits` | Four pass each, including actual QuickJS OOM and independent runtimes |
| AGY / sdk/packages/pocket_services | `flutter test --no-pub --concurrency=1` | 39 pass |
| AGY / sdk/packages/pocket_platform | Same Flutter command | 8 pass |
| AGY / sdk/packages/pocket_hardware | Same Flutter command | 11 pass |
| AGY / sdk | `flutter test --no-pub --concurrency=1 test/memory_policy_test.dart test/pocket_system_host_test.dart test/recording_library_test.dart test/performance_history_test.dart` | 27 pass |
| AGY / sdk/packages/pocket_flutter | `flutter test --no-pub --concurrency=1 test/pocket_memory_ffi_test.dart test/pocket_view_first_frame_test.dart test/pocket_recording_ffi_test.dart` | 21 pass |
| AGY / demo | `flutter test --no-pub --concurrency=1 test/plugin_contract_export_test.dart test/flutter_frame_monitor_test.dart test/showcase_admission_test.dart` | 15 pass |
| Luna / temporary probes | Multiple adapters, thrown listener, paused/unlistened Dart, parse count, native allocator | Results above. Synthetic timing does not establish device performance. |
| Lead / repo | Bun with actual HostBridge and two adapters | Reproduced R2/R3 |
| Lead / temporary probes | Unlistened Dart queue, Bun parse chain, Rust/QuickJS large emit | Reproduced 10001 queued without overflow, five parses, and 30000 accepted emit events |

Actual Bun native probes used `POCKET_NATIVE_PROBE=sdk/native/target/debug/pocket_probe` and `POCKET_BYTECODE_COMPILER=sdk/native/target/debug/pocketjs_bytecode`. Some SDK, bridge, and Demo Flutter tests used the absolute path to `POCKET_NATIVE_LIBRARY=sdk/native/target/debug/libpocket_flutter.dylib`. Existing binaries were reused where applicable. Clean-machine build acceptance remains open. Rust cargo tests check current source.

Temporary reproductions and commands outside the SDK:

```sh
bun /tmp/pocket_js_probes/multi_adapter_listener.ts
bun /tmp/pocket_js_probes/send_batch_fake.ts
bun /tmp/pocket_js_probes/parse_chain.ts
cd /tmp/pocket_stream_backpressure_probe
/Users/lincoln.law/fvm/default/bin/dart run bin/main.dart
```

```sh
CARGO_TARGET_DIR=/tmp/pocket_binary_alloc_probe/target cargo run --quiet \
  --manifest-path /tmp/pocket_binary_alloc_probe/Cargo.toml
POCKET_PROBE_COUNT=30000 CARGO_TARGET_DIR=/tmp/pocket_emit_probe/target \
  cargo run --quiet --manifest-path /tmp/pocket_emit_probe/Cargo.toml
```

Raw `PocketStreamBridge` has no 10000-event cumulative quota. `PocketPluginBudget.maxStreamEvents` applies per managed plugin stream. Current production providers open from the Guest, and the review found no production caller of host-initiated `PocketStreamBridge.open()`. R3 remains a public embedding API defect.

## Coverage and next acceptance

| Area | Covered | Open |
| --- | --- | --- |
| Runtime, FFI, and memory | Actual Rust library and memory execution, Dart FFI, and admission | Aggregate cross-app budgets and device RSS/GPU memory remain outside the per-realm promise. |
| Frames, input, and FPS | Source review, first frame, frame monitor, and recording FFI | Physical device input, scrolling and sustained 120 Hz, 30-second idle wake and power. Simulator UI was not rerun. |
| Host streams | Duplex lifecycle, direct R2/R3 reproductions, and buffer negative control | Native start/cancel late callbacks and multi-session stress. |
| Hardware | Dart contracts and native source paths | iOS watch/read concurrency, Android multi-sensor, and real BLE CCCD, disconnect, and revocation. |
| Platform and deep links | Provider and JS tests and historical warm/repeat/background evidence | Cold start and Android delivery. Universal Links and App Links require integration and evidence. |
| Multi-app and SystemUI | JS kernel and Dart system-host tests | Aggregate budget contract, complex child composition, and physical-device resident stress. |
| Build, Editor, and scaffolding | Editor security regressions, scaffolding, native patches, types, and bytecode probes | Historical audit items need their own evidence. Clean cross-platform builds remain a release gate. |

Recommended order is R1/R2, then R3/R4/R5/R6/R7, duplicate parsing ablation, then native sampling rate and static-frame allocations. After error isolation and real buffer fixes, measure on-device p95 input and event delay, sustained frame rate, CPU and wakeups, peak memory, and power. An idle FPS minimum would defeat idle suspension.
