# Pocket Studio, the Native Pocket Editor

Studio is built with Pocket. TSX using `@pocket/ui` compiles to QuickJS bytecode and runs in a thin macOS Flutter host. The backend remains the Bun service in `sdk/editor`. Like `demo/`, `studio/` consumes the SDK.

> Web Studio (`bun pocket.ts editor --web <project>`) is **legacy** for features Pocket Studio covers. The visual novel editor, WeChat preview, Noble Bluetooth, and Codex remain Web Studio features per the maintainer decision.
>
> **Verified:** Apple Silicon macOS build and smoke launch on 2026-11-17, plus Linux and macOS Guest and host tests. On macOS repository workspaces containing `studio/`, `bun sdk/pocket.ts editor [<project>]` defaults to Pocket Studio and detects `<repoRoot>/.fvm/flutter_sdk/bin/flutter`. Web Studio remains the entry for `--web`, `POCKET_EDITOR_UI=web`, service-only arguments, standalone Web SDK exports without `studio/`, and non-macOS platforms.

- The Studio Guest includes project listing and local open, file tree, tabbed CodeView editing with save and find, console and build, preview, publish, Tencent Cloud COS publishing, artifacts, versions, on-demand ecosystem modules, settings with current build number, source-workspace Git SDK upgrades, Studio self-update, Quick Open (Cmd+P), and shortcuts. The capability client is `src/studio-client.ts`. [Guest source](js/)
- The thin host (≤100 lines) registers `PocketStudioPlugin`, `PocketClipboardPlugin`, and `PocketFilePickerPlugin`. It grants `studio.*`, clipboard, and `files.open` exclusively to `dev.pocket.studio`. Preview child `dev.pocket.studio.preview` has no grants. [Host entry point](lib/main.dart)
- See layering, the frozen `studio.*` capability table, permission model, path redaction, and service lifecycle. [Architecture](docs/ARCHITECTURE.md)
- Compare Web Studio feature parity and the initial audit. [Parity checklist](docs/PARITY.md), [M0 report](docs/M0_REPORT.md)

The native app targets macOS (`macos/`). Build and run it as follows.

```sh
cd studio/js && bun install && bun run build   # Artifacts go to studio/assets
cd .. && flutter pub get
flutter run -d macos \
  --dart-define=POCKET_STUDIO_SDK_ROOT=/absolute/path/pocket/sdk \
  --dart-define=POCKET_STUDIO_PROJECT_ROOT="/absolute/path/to/a Pocket project" \
  --dart-define=POCKET_STUDIO_WORKSPACE=/absolute/path/studio-workspace
```

On macOS with `studio/` present, use `bun sdk/pocket.ts editor [<project>] [--port=N] [--workspace=DIR]`. `--pocket` explicitly selects Pocket Studio. `--web` or `POCKET_EDITOR_UI=web` selects Web Studio. The launcher writes trusted settings to `<workspace>/pocket-studio-host.config.json`, adds `studio/js` as a project root so Studio can open, build, and publish itself, detects `<repoRoot>/.fvm/flutter_sdk/bin/flutter`, and runs `flutter run -d macos`. An explicit `--pocket` on other platforms reports “Pocket Studio host is macOS-only; use the web Studio (bun pocket.ts editor) on this platform”.

For self-updates, go to Settings → Studio Update and choose Check Studio Update or Apply Update. The host uses the signed test channel by default. Set `POCKET_STUDIO_UPDATE_CHANNEL=stable` for stable. The SDK rolls failed builds back to the last healthy release, with embedded bytecode as the fallback. [Architecture](docs/ARCHITECTURE.md)

Supply trusted SDK path, port, and project root through `--dart-define` or `--dart-define-from-file=studio.config.example.json`. Guests cannot see absolute paths, signing keys, sockets, or CSRF tokens. The host attaches to an existing Editor service or starts it with `bun <sdk>/pocket.ts editor` and stops the service it started on exit.

## Keyboard Shortcuts (M7)

The primary modifier is Cmd on macOS and Ctrl elsewhere. Settings → Keyboard Shortcuts displays the complete table from `js/src/keymap.ts`.

| Shortcut | Action |
| --- | --- |
| Cmd+S | Save current file. Focused CodeView handles the editor's save intent. |
| Cmd+F | Find. CodeView handles it in the editor. Other pages switch to Source and open Find. |
| Cmd+B / Cmd+Shift+B | Build / build and refresh Preview |
| Cmd+P | Quick Open with fuzzy file search. Up/Down selects, Enter opens, and Esc closes. |
| Cmd+W | Close current tab, with confirmation for unsaved edits |
| Cmd+Shift+[ / ] | Previous / next tab |
| Cmd+1 … 9 | Switch to the numbered sidebar page |
| Cmd+Shift+P | Open Publish |
| Esc | Close a dialog or Quick Open, or pass to the editor |

CodeView owns editor-scoped keys such as save, find, and arrows while focused. Global keys such as build, Quick Open, and navigation take precedence. Unbound keys pass through to the editor. A focused Flutter `InputField` owns its keys. [Keyboard and Quick Open](docs/ARCHITECTURE.md)

## Tests

Run in the Linux container with the real native library and Editor service. Adjust paths to your machine. `POCKET_SOURCE_BUILD=1 TMPDIR=/tmp` uses the local cache for the pinned compiler.

```sh
export POCKET_NATIVE_LIBRARY=/absolute/path/pocket/sdk/native/target/debug/libpocket_flutter.so
export POCKET_SOURCE_BUILD=1 TMPDIR=/tmp
export POCKET_REQUIRE_REAL=1   # Fail if the library, bun, or fixtures are missing. Required in CI and before release.
cd studio/js && bash scripts/test_guest.sh        # Unit tests, bytecode build, and Guest probe tests including keyboard and profiling
cd .. && flutter analyze && flutter test --no-pub  # M1–M7 exit tests with real library and service, including record/replay
```

- `test/studio_recording_test.dart` records open, edit, save, build, and publish with the SDK recorder. It replays offline, verifies frame digests, then replays an exported archive and compares semantic checkpoints with `test/fixtures/journey_checkpoints.json`. Regenerate using `STUDIO_UPDATE_FIXTURES=1`.
- `js/tests/studio_profile.test.ts` measures frame time, RSS, tab open/close leaks, and QuickJS heap limits while opening and scrolling a 5,000-line file, entering 100 keystrokes, building, and publishing. [Performance results](docs/PERFORMANCE.md)

## Troubleshooting

- **“bytecode package requires host-native fonts”**. Install font metrics before the first recorded transaction. `PocketView` synchronizes fonts before compositor setup (M7 fix). Custom hosts should call `syncPocketHostFonts` first.
- **Guest turn exceeds 250 ms**. The probe reports `pocket_probe frame failed`. `studio-client.ts` chunks large file IO. Chunk other heavy work with `yieldTurn`.
- **`flutter test` skips**. Set `POCKET_NATIVE_LIBRARY` and make `bun` available or set `POCKET_BUN`. `POCKET_REQUIRE_REAL=1` converts missing prerequisites into failures and the suite reports 0 skipped.
- **SDK edits only visible after `bun install`**. `studio/js/node_modules/@pocket/ui` is a copy. Rerun `bun install` in `studio/js` after editing `sdk/packages/pocket_ui`.
- **macOS startup error or blank window**. Run `cd studio/js && bun run build` and check for `app.qjbc` in `studio/assets`. See the checklist for issues such as system menus consuming Cmd+W or Cmd+P. [Release checklist](docs/RELEASE_CHECKLIST.md)
- **Service port occupied**. Select another port with `--port=N`. The host can attach to an already running Editor server.
- Apple Silicon macOS passed `libpocket_flutter.a` static library build, `pocket_studio_app.app` Debug build, and Impeller MetalSDF smoke launch on 2026-11-17. `PocketStudioService` launched Editor and passed `/health`. Automated results were `studio/test` 10/10, `studio/js` 129 unit and 70 probe checks, `pocket_studio` 94/94, `pocket_clipboard` 13/13, and `pocket_file_picker` 9/9. Interactive GUI and IME candidates, COS upload with real credentials, and Apple Developer ID signing and notarization remain manual release checks. [Release checklist](docs/RELEASE_CHECKLIST.md)
