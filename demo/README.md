# Pocket Showcase Demo

The Showcase is the SDK's sole example app. The Flutter project lives directly in `demo/`,
and all JS/TS code lives in [js/](js/).

- [lib/main.dart](lib/main.dart) is the thin Flutter host. It configures `PocketSystemHost`
  and the trusted app catalog. JS SystemUI owns multi-app policy.
- [js/app.tsx](js/app.tsx) is the JS entry point for pages, state, routes, mobile UI, transitions,
  and hardware demos. The liquid glass demo entry is temporarily removed. The SDK component
  is still available.

The primary tabs are **Home / UI / Host / Settings**. Secondary pages pin a top navigation
bar with Back and hide the bottom TabBar. Back restores the current primary tab. Settings
centralizes light and dark mode, four accent colors, and interface density, saving choices in
existing device storage and restoring them at startup. Push keeps the caller instance alive
with scroll, input, and local selections. Back destroys only the outgoing secondary page.
Primary tabs retain their own state. Hidden pages deactivate gestures, IME, and overlays.
See [Route lifecycle](../sdk/docs/SHOWCASE_ROUTING.md) and the
[Showcase rewrite record](../sdk/docs/SHOWCASE_REWRITE.md) for provenance, ablation, and
interaction validation.

Profile → Lobby is a nested JS guest call. Lobby's “Return visits to caller” returns to Profile
and preserves Profile's selected and stored identity. Profile's “Return to Showcase” returns
to the Showcase. If the host cancels Lobby, the call unwinds one level to Profile.

Run the Demo with the following commands.

```sh
cd /Volumes/ORICO/Development/Github/pocket/demo
flutter pub get
flutter run -d 4D366210-290E-46DB-8BC6-3C5233700409
```

The hybrid Flutter TabBar host demo includes a native tab, a lazy Pocket catalog tab, and
full-screen mini-app launches with results from arbitrary native pages.
See [Hybrid Flutter tab host](../sdk/docs/HYBRID_FLUTTER_TAB_HOST.md).

```sh
cd /Volumes/ORICO/Development/Github/pocket/demo
flutter run -t tool/hybrid_tab_demo.dart -d macos
# Run hybrid-host widget tests and the real QJBC integration test.
flutter test test/hybrid_tab_host_test.dart
flutter drive --no-pub --no-dds -d macos \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/hybrid_tab_host_test.dart
```

Run Android from `demo/` as well.

```sh
flutter run -d <android-device-id>
# Build an installable APK.
flutter build apk --debug
```

The Android native library currently supports arm64 and API 24 or later. The SDK's Android
provider exposes camera, BLE, motion sensors, location, and biometrics to the same JS pages.
Page actions trigger system permissions. See [Hardware reuse](../sdk/docs/HARDWARE_REUSE.md)
and [Validation](../sdk/docs/VALIDATION.md) for support and device coverage.

For JS-only changes, use the guest build.

```sh
cd /Volumes/ORICO/Development/Github/pocket/demo/js
bun install
bun run build:system
```

Flutter build products and platform projects live directly in `demo/`. JS tests and update
scripts are in `js/`. Device screenshots and test results are in `artifacts/`.
Develop reusable features in the [SDK](../sdk/README.md) and consume them from the Demo.

Recording starts on demand. In the JS **Host → Runtime** page, select `Start recording`
to open a new recording window. You can inspect status, stop recording, validate replay,
or export. Automated tests can pass `--dart-define=POCKET_RECORD=true` to start before the
first frame. Recording captures each app's host inputs, IME, external results, and
binary channels. Exported assets support offline import and replay after the original
instance is disposed. Recording is idle by default and collects no data until enabled.
See [Recording and replay](../sdk/docs/RECORDING_REPLAY.md) for quotas, SDK APIs, and limits.

For Web editing, preview, and device deployment, run `bun run editor` in `demo/js` and
open **http://127.0.0.1:8791**. This entry binds directly to the Demo's JS and Flutter
projects. Deploy to a simulator or connected device, or use the floating Codex chat and
region screenshots to help edit pages. See [Studio](../sdk/docs/EDITOR_STUDIO.md).

With local signing already configured, enable local Editor updates as follows.

```sh
# Run from demo/.
bash ../sdk/scripts/editor_service.sh start
flutter run --dart-define-from-file=../sdk/.pocket-build/editor-host.json
```

## Manual Video Lab validation

**Video Lab** is a standalone JS page using the real local clips
`assets/videos/clip-a.mp4` and `assets/videos/clip-b.mp4`. The root route supplies
`platform`, `host`, and `onNavigate`. The page reuses the pinned root `MobileAppBar`
and owns its `ScrollablePage`. Playback uses the existing native player with real video.

The page's Playback, Coverage, and Scroll sections cover these cases.

- Check default pause, explicit play and pause, and rapid toggling. During playback, open
  the `pocket.demo.profile` MiniApp and return.
- Check exclusivity between the two feed entries, route switching and return, and actual
  scrolling out of view and back.
- Remove and recreate a surface, swap the asset under the same ID and confirm explicit
  pause persists, and retry a failed asset.
- The first screen shows native `video-lab-hero · paused/playing` status,
  a `Native controllers · N` snapshot, and a bounded event log. `Inspect native state`
  requests `video.snapshot` from the existing host. The page displays JS playback intent
  separately from the host's actual `video.state`. Feed, same-ID, retry, and scroll each
  show `video-lab-<id> · <state>` to distinguish `error`, `ready`, `paused`, and `playing`.
- Rotate or resize the window on an iOS or Android preview or device. Check the hero before
  and after opening and closing Duo. `Cover fit`, `Contain fit`, and `Fill fit` update
  the same retained video surface. Confirm with `video.state`, visual bounds, and occlusion.
- Send the app to the background and bring it back. A playing item should pause, an
  explicitly paused item should stay paused, and the prior playing intent should resume
  after return. This case requires actual `video.state` events and visible playback on
  a physical host.

The Video API covers local MP4, fixed loop and muted behavior, play and pause, lifecycle
and occlusion gates, feed exclusivity, and native visibility. Seek and progress, volume,
completion callbacks, and network URLs are outside the exposed API. Count
`video-lab-hero · disposed` only when the host emits the native terminal state.

Run the dedicated source test first.

```sh
cd /Volumes/ORICO/Development/Github/pocket/demo/js
bun run test:video
```

This test checks page source and API wiring, real MP4 names, intent, cleanup, and the
absence of polling. Real playback requires manual validation in a Flutter iOS or Android
preview or on a device. Record native results only after the host emits `video.state`
or real decoding and pause/resume are observed. An empty browser preview texture provides
no playback evidence.
