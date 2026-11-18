# Pocket Studio architecture (M1 shell and transport, M2 editing, M3 build and live preview, M5 publish, M6 self-hosting, M7 hardening)

Pocket Studio is a Pocket guest app (TSX on `@pocket/ui`, compiled to QuickJS bytecode by the one pinned
`buildGuest` pipeline) running in a thin Flutter macOS host. The Bun editor service in `sdk/editor` stays the
backend. `studio/` is an SDK consumer exactly like `demo/`: the SDK never imports it
(`sdk/scripts/check_architecture.py` enforces that, and also that `studio/` does not import `demo/`).

## Layers

| Layer | Where | Owns | Must not own |
| --- | --- | --- | --- |
| Studio guest | `studio/js/` (`app.tsx`, `src/pages`, `src/components`, `src/state`) | all UI, state, routing, polling, retry, chunk loops, sha256, settings, preview orchestration | any path, key, socket or token |
| Capability client | `studio/js/src/studio-client.ts` | typed wrappers over `host.request` and streams, chunked read/upload helpers, error mapping | business policy |
| Host | `studio/lib/main.dart` (<= 100 lines) | registers plugins, grants permissions, trusted config, memory tier, `rawTextInputEnabled`, preview child catalog | UI, state machines, navigation |
| Provider | `sdk/packages/pocket_studio` | allowlisted capability -> HTTP route map, CSRF injection, path scrubbing, error mapping, SSE -> stream mapping, service lifecycle helper | project/build/transfer state, policy, retries |
| Service | `sdk/editor/server.ts` | everything the web Studio already does; guards unchanged | |

The Dart provider is one more client of the service. It does not weaken a guard: it sends `x-pocket-csrf`
(never the constant `x-pocket-editor`), talks only to `127.0.0.1`, and the service still applies its Host,
peer, path, symlink, size and admission checks to every request.

## Capability contract (FROZEN in M1)

Names, parameter names and result shapes below are frozen. Additions are allowed; renames and removals need an
owner decision. `project` is a project id (`[a-z][a-z0-9-]{0,47}`); `path`, `from`, `to` are project-relative.
All calls are `request` capabilities except the two `stream` rows. Every call needs the listed host permission.

| Capability | Params | Result | Route (method path under `/api/projects/:project` unless absolute) | Perm |
| --- | --- | --- | --- | --- |
| `studio.project.list` | `{}` | `{projects: Project[]}` (status without logs) | `GET /api/projects` | read |
| `studio.project.create` | `{id, template?: "app"\|"game", pickParentDirectory?: boolean, ecosystemModules?: string[], settings?: {name,title,appId,version,tickHz,reusePublishedPackages}}` (`pickParentDirectory: true` makes the provider call internal `POST /api/projects/pick-directory` and pass `directory` without exposing host paths to the guest) | `Project` (or `{cancelled:true}` when folder picker is cancelled) | `POST /api/projects/pick-directory` (optional) + `POST /api/projects` | write |
| `studio.project.open` | `{project}` | `Project` (config + status without logs) | `GET /api/projects/:id` | read |
| `studio.project.openLocal` | `{}` | `{cancelled:true}` or `Project` (opens host OS folder picker, registers scrubbed `<project>` root) | `POST /api/projects/pick-directory` + `POST /api/projects/open` | write |
| `studio.project.settings.get` | `{project}` | `EditorConfig` (includes read-only current `build`) | `GET …/config` | read |
| `studio.project.settings.set` | `{project, settings}` (same keys as create) | `EditorConfig` + status | `PUT …/config` | write |
| `studio.ecosystem.catalog` | `{}` | `{modules, profiles}` | `GET /api/ecosystem/modules` | read |
| `studio.ecosystem.get` | `{project}` | enabled ecosystem modules | `GET …/ecosystem` | read |
| `studio.ecosystem.set` | `{project, modules?\|add?}` | updated ecosystem modules | `POST …/ecosystem` | write |
| `studio.fs.tree` | `{project, assets?: boolean}` | `{files:[{path,bytes}], revision, assets?: string[]}` (flat; the guest builds the tree) | `GET …/files` (+ `GET …/assets`) | read |
| `studio.fs.read` | `{project, path}` | `{path, content, bytes, revision}`; `too_large` above ~240 KiB: use `readChunk` | `GET …/files/<path>` | read |
| `studio.fs.write` | `{project, path, content}` (<= 192 KiB) | `{path, bytes, revision}` | `PUT …/files/<path>` | write |
| `studio.fs.rename` | `{project, from, to, overwrite?}` | `{from, to, revision}` | `POST …/files-move` | write |
| `studio.fs.delete` | `{project, path}` | `{path, revision}` | `DELETE …/files/<path>` | write |
| `studio.fs.stat` | `{project, path}` | `{path, kind, bytes, mtimeMs, editable}` | `GET …/stat/<path>` | read |
| `studio.fs.mkdir` | `{project, path}` | `{path, created, revision}` | `POST …/folders` | write |
| `studio.fs.rmdir` | `{project, path}` (empty folder) | `{path, revision}` | `DELETE …/folders/<path>` | write |
| `studio.fs.readChunk` | `{project, path, offset, length?}` (length clamped to 131072) | `{path, offset, length, totalBytes, sha256, mtimeMs, data(base64)}` | `GET …/chunks/<path>?offset&length` | read |
| `studio.fs.upload.begin` | `{project, path, totalBytes, sha256}` | `{uploadId, chunkBytes, expiresInMs}` | `POST …/uploads` | write |
| `studio.fs.upload.chunk` | `{project, uploadId, offset, data(base64, <=131072 raw bytes)}` | `{uploadId, received, totalBytes}` | `PUT …/uploads/:uploadId` | write |
| `studio.fs.upload.commit` | `{project, uploadId}` | `{path, bytes, sha256, revision}` | `POST …/uploads/:uploadId/commit` | write |
| `studio.fs.upload.abort` | `{project, uploadId}` | `{uploadId, aborted}` | `DELETE …/uploads/:uploadId` | write |
| `studio.fs.watch` (stream) | `{project}` | batches `{events: WatchEvent[]}` | `GET …/watch` (SSE) | read |
| `studio.build.start` | `{project}` | flat status object (202; the service `{status:{…}}` envelope is unwrapped) | `POST …/build` | build |
| `studio.build.cancel` | `{project}` | `{cancelled, pending?, status}` | `POST …/build/cancel` | build |
| `studio.build.status` | `{project}` | `EditorStatus` (newest log lines within budget) | `GET …/status` | read |
| `studio.build.events` (stream) | `{project}` | batches `{events: BuildEvent[]}` | `GET …/build/events` (SSE) | read |
| `studio.logs.tail` | `{project}` | `{logs, error}` | `GET …/logs` | read |
| `studio.preview.publish` | `{project}` | publish record (`buildId, build, manifestUrl, payloadSha256, …`) | `POST …/preview-publish` | build |
| `studio.preview.devices` | `{}` | `{devices}` | `GET /api/devices` | read |
| `studio.preview.deploy` | `{project, deviceId}` | deployment job | `POST …/deploy` | deploy |
| `studio.preview.deployStatus` | `{project, job}` | job | `GET …/deploy/:job` | read |
| `studio.preview.deployCancel` | `{project, job}` | job | `DELETE …/deploy/:job` | deploy |
| `studio.publish.plan` | `{project, channel?: "test"\|"release"}` | target summary | `GET …/publish-targets?channel=` | read |
| `studio.publish.publish` | `{project, channel?}` | `{status:{publish:{keyId,runtimeAbi,payloadSha256,version,build,channel,…}}, manifest:{keyId,signature,payloadBase64Bytes}, manifestUrl, hostConfigUrl, appConfigUrl, updateUrl, archiveUrl, packages, reusedPackages, cosPublish?, cosError?}`. The signed envelope's base64 `payload` body is dropped by the provider (it can exceed the 256 KiB result quota for large projects and would fail an already completed publish); the signed bytes are served at `manifestUrl` | `POST …/publish` | publish |
| `studio.publish.history` | `{project}` | version backend snapshot | `GET …/versions` | read |
| `studio.publish.offline` | `{project}` | `{archiveUrl, filename}` | `POST …/package-offline` | publish |
| `studio.cos.get` | `{project}` | COS config + redacted local/workspace credential inspection | `GET …/cos` | read |
| `studio.cos.set` | `{project, enabled?, syncOnPublish?, bucket?, region?, keyPrefix?, publicBaseUrl?, credentials?}` (guest clears credential input fields immediately after save; `secretKey`/`securityToken` are scrubbed on outbound/returned payloads) | COS config + redacted credential status | `PUT …/cos` | write |
| `studio.cos.check` | `{project, bucket?, region?, keyPrefix?, publicBaseUrl?}` (60 s provider timeout) | connectivity / bucket check result | `POST …/cos/check` | write |
| `studio.cos.publish` | `{project, channel?}` (130 s provider timeout) | COS upload / publish result | `POST …/cos/publish` | publish |
| `studio.artifacts.list` | `{project}` | `{revision, builtRevision, artifacts}` | `GET …/status` (projection) | read |
| `studio.artifacts.inspect` | `{project, name}` (one of the 9 fixed artifact names: the 8 build outputs plus `resources.json`, the read-only resource snapshot added in M5) | `{name, bytes, encoding:"utf8", data, truncated}` for `app.js` and `*.json` (limit 128 KiB of text; an oversized pretty-printed JSON is re-encoded compactly first so `resources.json` stays parseable; `bytes` is always the real artifact size); `{name, bytes, encoding:"binary"}` (no data) for `.qjbc`/`.pak` | `GET …/artifacts/<name>` | read |
| `studio.assets.upload.begin` | `{project, name, totalBytes, sha256}` (`name`: flat safe file name `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, `totalBytes` <= 32 MiB, validated before any request) | `{uploadId, chunkBytes, expiresInMs}`; then `studio.fs.upload.chunk`/`commit`/`abort` as for text uploads. `commit` answers `{path:"assets/<name>", bytes, sha256, revision, assets}` | `POST …/uploads` with `target:"asset"` | write |
| `studio.assets.preview` | `{project, name}` | `{name, width, height, textureWidth, textureHeight, sourceWidth, sourceHeight, img}`: `img` is a binary raw IMG entry (8-byte header, PSM_8888, power-of-two RGBA envelope <= 128 x 128, 65,544 bytes at most) decoded by the host (PNG, JPEG, GIF first frame, WebP, BMP). SVG fails `unsupported_format`, non-image names `not_an_image`, corrupt data `decode_failed`, nothing is substituted | `GET …/assets/<name>` (raw bytes) | read |
| `studio.project.resources.get` | `{project}` | `{revision, builtRevision?, packages:[{id, title, manifest, resources:[{key, kind:"pak"\|"asset", bytes, placement:"pak"\|"network", locked?, reason?, preview?:true}], updateUrl?, hostConfigUrl?}]}`. The service's relative `previewUrl` becomes `preview:true` | `GET …/resources` | read |
| `studio.project.resources.set` | `{project, revision, packageId, placements:[{key, placement}]}` (validated: array, unique keys, `pak`\|`network`) | the new inventory (same shape). A stale `revision` is `conflict` (HTTP 409, message contains "stale"); so are "build still running" and "build the current source first" | `PUT …/resources` | write |
| `studio.project.resources.preview` | `{project, revision, package, key}` (`revision` = `builtRevision`) | same image result as `studio.assets.preview`, plus `key` | `GET …/resources/preview?revision&package&key` | read |
| `studio.service.health` | `{}` | `{ok, service, version, projectId?, updatePackageVersion?, bluetooth?}` | `GET /health` (scrubbed) | read |
| `studio.service.upgrade.status` | `{}` | upgrade status | `GET /api/studio/upgrade` | read |
| `studio.service.upgrade.check` (M8) | `{}` (the provider fixes the body to `{autoApply:false}`: a check from the Studio can never start an apply, whatever the guest passes) | upgrade status: `{currentVersion, latestVersion, mode:"standalone"\|"source", modeReason?, status, upgradeAvailable, releaseUrl, deferredReason, checkedAt, rolledBack, error, platformTuple, …}` | `POST /api/studio/upgrade/check` | write |
| `studio.service.upgrade.apply` (M8) | `{}` | upgrade status (`status:"restarting"` or git source-checkout upgrade result, `targetVersion`); a busy service or unclean git working tree answers `conflict` (HTTP 409, deferred); a standalone install or source-checkout git upgrade restarts/updates the service, so the following calls can fail with `service_unreachable` for a moment | `POST /api/studio/upgrade/apply` | deploy |
| `studio.logs.diagnostics` (M8) | `{project, kind?: "log"\|"crash"}` | `{exportId, project, kind?, format, schemaVersion, exportedAt, totalRecords, logCount, crashCount, context?, keptRecords, omitted, truncated, records[], downloadUrl}`. Scrubbed like every result (paths, token, key blocks/fields). `records` keep the service order (newest first) and whole records up to ~160 KiB; `omitted`/`truncated` say what did not fit; `exportId` is derived (`diag-<project>-<exportedAt digits>`), nothing is stored; `downloadUrl` is the service's own `GET …/diagnostics?download=1` (loopback, no secret) for the full file. The provider reads up to 16 MiB from the service (default 2 MiB); beyond that: `too_large` | `GET …/diagnostics[?kind=]` | read |

Total: **53 capabilities** (37 from M1 + 3 from M8 + 5 from M9 + 8 parity additions: `studio.project.openLocal`, `studio.ecosystem.catalog/get/set`, `studio.cos.get/set/check/publish`). Clipboard and the open-file dialog are not studio capabilities: the guest uses the SDK `clipboard.*` plugin (`@pocket/ui/clipboard`) and the optional
`files.*` plugin (`@pocket/ui/files`, `sdk/docs/FILE_PICKER_PLUGIN.md`; permission `files.open`, granted to the Studio guest only via `PocketFilePickerPlugin` in `studio/lib/main.dart`).
Reloading the preview child is a guest-side `system.runtime.destroy` + `system.runtime.create` (see
`sdk/docs/STUDIO_SIGNED_PREVIEW.md`); `studio.preview.publish` only produces the signed package. Reserved, not
registered now: `studio.project.resources.get/set` (and `.preview`) were reserved and are registered by the resources
page work (rows above); the M5 pack-contents summary still reads the `resources.json` artifact. `studio.service.upgrade.check/apply` and `studio.logs.diagnostics` were reserved in M1 and
registered in M8 (rows above, additive: no existing name, parameter or result changed). They reuse the existing five
permission names, so the host grant (`PocketStudioPermissions.all`, `studio/lib/main.dart`) and the preview child's
"no grant" are unchanged: check = `studio.write`, apply = `studio.deploy`, diagnostics = `studio.read`.

### Permissions

`read`, `write`, `build`, `deploy`, `publish` are the permission names `studio.read`, `studio.write`,
`studio.build`, `studio.deploy`, `studio.publish`. They are separate grants like `clipboard.read/write`.

### Errors

A failure is a structured capability error `{code, message}`; the guest bridge rejects with `error.code`.
Provider codes: `invalid_params` (validation, before any request), `too_large` (result/params over budget),
`capability_not_found`, `plugin_disposed`, `service_unreachable`, `service_timeout`, `invalid_response`,
`service_stream_error`. Service statuses map to: 400 `invalid_request`, 403 `forbidden`, 404 `not_found`,
409 `conflict`, 413 `too_large`, 422 `checksum_mismatch`, 429 `too_many_requests`, 501 `unsupported`, other 5xx
`service_error`. The message is the service's `error` text (scrubbed) plus ` (HTTP n)`. Framework codes
(`capability_denied`, `permission_denied`, `plugin_payload_quota`, `plugin_stream_quota`) can also appear.

### Streams and limits

Stream items are `{events:[...]}` batches, at most 200 events / 128 KiB each, one batch per 25 ms at most.
The provider keeps a queue of at most 1024 events / 512 KiB between the SSE reader and the guest. On overflow it
drops the oldest `log` events (then the oldest of any type) and puts `{type:"gap", dropped:n}` first in the next
batch; the guest must then re-read `studio.build.status` / `studio.fs.tree`. A service-side drop of a slow
consumer, or an error, ends or errors the stream; the guest reopens it (JS owns reconnection). The framework
quota of 10000 items per stream (`plugin_stream_quota`) also means "reopen". Every control message stays below
256 KiB: file transfers use `readChunk` / `upload.chunk` with <= 131072 raw bytes (base64 <= ~175 KB), and the
JS client (`readBytes`, `writeText`) splits and verifies sha256 itself.

## Permission and grant model

1. Host scope (`PocketAppConfig.allowedPermissions`): only the Studio app id `dev.pocket.studio` is given
   `studio.*` and `clipboard.read/write`, and only it has `PocketStudioPlugin` / `PocketClipboardPlugin` in its
   `pluginFactories`.
2. Guest manifest (`studio/js/manifest.json`): declares the capabilities (optional) and permissions it uses. A
   test compares this list with the provider's capability names.
3. The preview child `dev.pocket.studio.preview` has no `allowedPermissions` and no plugin factories, so it
   cannot request any `studio.*` or clipboard capability (tested; see also the isolation proof in
   `sdk/docs/STUDIO_SIGNED_PREVIEW.md`).
4. Trusted configuration (service port, SDK root, project root, workspace, bun path) comes from the host run
   configuration (`--dart-define` or `--dart-define-from-file`), never from the guest: `POCKET_STUDIO_PORT`
   (default 8795), `POCKET_STUDIO_SDK_ROOT`, `POCKET_STUDIO_PROJECT_ROOT`, `POCKET_STUDIO_WORKSPACE`,
   `POCKET_STUDIO_BUN`, `POCKET_STUDIO_AUTOSTART`.

## Path and secret scrubbing

Applied to every response, error message, and stream event (`StudioPathScrubber`):

1. JSON keys `workspace`, `projectRoot`, `flutterRoot`, `sdkRoot`, `csrfToken`, `absolutePath` are dropped at any depth.
2. Roots learned from `/health` (workspace, project root, flutter root) and from host config (SDK root, project
   root, workspace, optional extra temp roots) are replaced by `<workspace>`, `<project>`, `<flutter>`, `<sdk>`,
   `<tmp>`; `<workspace>/projects/<id>` becomes `<project>`; the `/private` alias of `/var`, `/tmp`, `/etc` is covered.
3. Other absolute paths below `/Users /home /var /private /tmp /opt /usr /Volumes /root /mnt /srv /nix /snap /run
   /Library /Applications /System /proc /etc /workspace`, Windows drive paths and `file://` URIs become
   `<path>/<last segment>` (so `build_guest: source=/tmp/x/app.tsx` reads `source=<path>/app.tsx`).
4. The CSRF token value is replaced by `<redacted>` wherever it occurs; it is never returned by any call.
5. Artifacts: text artifacts are scrubbed; binary artifacts (`.qjbc`, `.pak`) are returned as metadata only
   because their embedded debug paths cannot be scrubbed.
6. Signing material and COS secrets (M5 + parity): signing keys stay in the service workspace (`keys/editor-dev-key.json`, never served by any route) and COS credentials stay in local/workspace files. As a
   provider-side backstop, JSON keys named `privateKey`, `private_key`, `privateKeyPem`, `privateKeyBase64`, `secretKey`, `securityToken`,
   `signingKey`, `signingSeed`, `seed` are dropped at any depth and PEM/OpenSSH private-key blocks inside any string become
   `<redacted-key>`. In addition, `studio.cos.set` clears guest credential input fields immediately after save and scrubs `secretKey`/`securityToken` from returned payloads. Public keys (`publicKey`, `keyId`) are not secrets and pass. Tests: `studio_plugin_test.dart` (every
   publish/COS route, errors and artifacts) and `real_service_test.dart` (real publish; no field of the real key file appears in
   any result).
7. Exemptions (by design): `studio.fs.read` `content` and `studio.fs.readChunk` `data` (base64) are the project file's bytes
   returned verbatim; they are not scrubbed, so a file that itself contains a path shows that path. Scrubbing applies to
   the envelope and error text only. The editor workspace directory is unreachable through the fs routes: when the
   workspace lives inside the project (default `<project>/.pocket-editor`), a fs path that resolves into it (lexically, or
   under the workspace's realpath) is rejected with `path is inside the editor workspace` (HTTP 400). Dot-prefixed path
   segments are rejected separately (`hidden (dot-prefixed) path segments are not allowed`, HTTP 400), so the default
   workspace is also unreachable by that rule. Symlinks inside the project are checked against the project root.

Project-relative paths (`src/tmp/x.ts`) and loopback URLs are unaffected. Rule 3 is a safety net with a fixed
list of system top-level directories; it is not a general path parser. Tests: `sdk/packages/pocket_studio/test`.

## Provider design

* HTTP client: plain `dart:io` `HttpClient` (async, `findProxy: DIRECT`, no redirects, 3 s connect timeout,
  30 s request timeout, 2 MiB response cap, loopback `http` origin enforced in the constructor). `pocket_dio`'s
  worker isolate was not reused: it exists for arbitrary-origin Dio traffic and quota policy; here the origin is
  one trusted loopback port and every body is bounded, so socket IO is already off the UI thread and an isolate
  would only add a second message hop.
* Statelessness: no project, build, transfer or retry state. The only cached value is the CSRF token from
  `GET /health`, refreshed once on a 403 (service restart). SSE streams are per-subscription and own only a
  bounded queue.
* Route map: `studioCalls` (`studio_routes.dart`) is a fixed table; a call builds URL segments and a body from
  allowlisted, validated params. Unknown settings keys are rejected rather than forwarded.

## Service lifecycle (host only)

`PocketStudioService.start()`: if `GET http://127.0.0.1:<port>/health` already answers
`{ok:true, service:"pocket-editor"}` it attaches and never starts a second service; otherwise (and only with
`autoStart`) it runs `bun <sdk>/pocket.ts editor <projectRoot> --port=<port> --update-host-version=studio
--workspace=<workspace>` with `workingDirectory` = SDK root, polls `/health` every 200 ms until a 90 s deadline and
fails with the child's last log lines if it exits early. `stop()` (also on app exit via `AppLifecycleListener`)
sends SIGTERM, then SIGKILL after 5 s, only for a process this helper started. `bun pocket.ts editor` was chosen
over `editor_service.mjs`: the latter is the fixed-port (8791), LAN-bound, launchd-style manager for the web
Studio; the former takes an explicit port and loopback bind. The service needs a project root (a directory with
`pocket.json`); Studio-created projects live in its workspace.

## Guest structure (M2/M3)

```
studio/js/app.tsx            shell only: theme, rail, active page, dialog/toast hosts, host-event routing
src/state/                   plain TypeScript stores (no Solid import, unit-testable in bun)
  store.ts env.ts            observable store, injected Timers (guest: frame-driven `after`)
  workspace.ts               files, tabs, dirty, save, create/rename/delete, fs.watch reconcile, assets
  build.ts ring.ts           build control, build.events, 2,000-line ring buffer, diagnostics
  preview.ts system-link.ts  build -> publish -> destroy/create -> first frame; the only System capability user
  deploy.ts settings.ts      devices/deploy jobs; Studio-local settings via system.storage
  publish.ts artifacts.ts    M5: signed publish (plan/confirm/publish/offline); artifact inspector
  versions.ts copy.ts        M5: version journal view; copy-to-clipboard through the clipboard capability client
  projects.ts toasts.ts dialogs.ts resilient.ts studio.ts (composition root, auto-build wiring)
src/pages/                   projects source console preview resources settings artifacts publish versions
src/components/              rail, file-tree, tabs, editor-pane (swappable), preview-surface, toasts, dialog-host
src/ui/bind.ts               Store -> Solid accessor; the only bridge between stores and the renderer
```

Adding a page is one line in `src/pages/index.tsx` plus a store; `app.tsx` and the rail (which renders the `pages` registry) do not change. The editor is
an `EditorPane` (`{path, text, onChange, onSave, diagnostics, jump}`) selected by the `editor` setting; M2 registers
the multi-line `InputField`, M4 registers `code` (CodeView) in `editorPanes` without touching the Source page (see "Code editor pane (M4)").

Rules the stores follow: JS owns reconnection (`resilient.ts`: backoff 0.5 s to 15 s, a resync callback on the
first event after a drop; `gap` events and quota errors take the same path), per-project epochs drop late results
after a project switch, and every service error becomes a toast (`code: message`), never a silent success.

### Editing (M2)

* Open reads through `readText`; files above 240 KiB go straight to verified chunked reads, writes above 192 KiB use
  the sha256-checked upload; files above 1 MiB are not opened in the InputField editor (clear message; CodeView lifts
  the cap in M4).
* Dirty = `text !== saved`. Closing a dirty tab, switching project and saving over an external change ask in a
  modal. `fs.watch`: a clean tab reloads silently, a dirty tab gets a conflict banner (keep mine / load disk), a
  deleted file closes a clean tab or flags a dirty one. The tab's own saves are recognized by content (disk ==
  saved), so no flag races.
* Tree actions: new file/folder, rename/move (files only; the service has no folder move), delete (folders must be
  empty). Empty folders are tracked locally because the service's flat list cannot show them.
* Resources page (two tabs). **Resource files**: assets listed from `studio.fs.tree` with `assets: true`, metadata via `studio.fs.stat`.
  *Upload*: Upload resources… calls `files.pickOpen` (open dialog, extensions of images, audio and fonts, multiple), then per file the
  guest reads `files.readChunk` (128 KiB) while hashing with the sliced `Sha256`, refuses unsafe names, other types and > 32 MiB
  before anything is sent, asks before replacing an existing asset, and uploads with `studio.assets.upload.begin` +
  `studio.fs.upload.chunk/commit` (aborted on any failure, handle released). Progress (read + upload) is a `MobileProgress` row per
  file; the asset list and the placement editor's revision refresh afterwards. All of it is `studio/js/src/state/assets.ts`; the host
  owns only the dialog and the chunked reads. *Preview*: `studio.assets.preview` decodes on the host and the page draws the result with the
  SDK's `PocketStoredImage` (one texture per mounted node, freed on unmount); the decoded envelope is <= 128 px so the entry
  stays under the 256 KiB result quota. SVG, audio and fonts say why there is no preview. **Package resource strategy**: the placement editor
  (`state/resources.ts`): package list, resource list with the current placement (locked rows are fixed), a pak/network
  toggle per resource, drafts per package, save sends the whole package with the revision the user saw. A stale revision shows a
  reload banner (saving is blocked, the draft is kept until the user confirms the reload); other 409s (no build yet, build running) are
  plain errors. Builds and uploads reload the inventory only when no draft would be lost, otherwise they raise the same banner.
* Save: toolbar button. A focused `InputField` is a Flutter text field that keeps its keys, so Cmd/Ctrl+S is reliable
  only in the code editor (below).
* The guest now routes `textInput.*` host events to `deliverTextInputEvent` (the M1 shell never did, so its create
  dialog could not be typed in).

### Code editor pane (M4)

Setting `editor`: `"code"` (default) or `"input"` (the M2 InputField fallback). A stored `studio.settings.v1` without
`editor` migrates to `code`; an explicit `input` is kept. Source: `sdk/docs/CODE_VIEW.md` / `CODE_EDITOR_CORE.md`
(`CodeView` + `CodeEditor` from `@pocket/ui`), reused unchanged except the lazy tokenizer below.

* Files: `src/components/editor-pane.tsx` (`CodeViewEditor`, keyed by path so a tab switch builds a view over that tab's
  buffer), `src/state/workspace.ts` (buffers), `src/pages/source.tsx` (layout), `src/ui/guest-env.ts` (`yieldTurn`).
* Buffer ownership: the workspace keeps one `CodeEditor` per open document (`editorFor`), alive across tab switches
  (undo history and selection survive) and dropped with the doc. The buffer is the live text; `Doc.text` is only a
  snapshot (open, save, reload, hand-over). Dirty = `buffer.version !== savedVersion`; the store is patched only when
  that flag flips, so a keystroke does not re-render tabs or header. Consequence: undoing back to the saved text still
  shows "modified" (versions only grow). Save writes `buffer.toString()` (CRLF files stay CRLF; mixed EOL is
  normalized to the dominant one) and edits made while a write is in flight keep the tab dirty.
* Settings switch: choosing `input` calls `releaseEditors()` (each buffer's text becomes `Doc.text`, still dirty);
  choosing `code` builds new buffers from `Doc.text`, so undo history does not survive a pane switch.
* External change (fs.watch): a clean tab is reloaded as ONE undoable edit over the changed middle (common prefix and
  suffix are found with native `startsWith`/`endsWith`), selection kept when outside the edit, then marked saved. So
  Cmd+Z reverts the reload (the tab then shows modified against the new disk text) and Cmd+Shift+Z re-applies it.
  A dirty tab keeps its buffer and shows the conflict banner; "load disk version" is the same undoable replacement,
  "keep mine" makes the disk text the baseline and the tab stays dirty. `Doc.reload` tells the pane to repaint.
* Diagnostics: build `{file,line,column}` (1-based) -> CodeView gutter dot, line tint and tip (0-based). A Console jump
  `{line, column, seq}` sets the caret, scrolls with 5 lines of context, repaints and opens the raw session (focus).
* Input: Cmd+S is the CodeView `save` intent -> `workspace.save`; Cmd+C/X/V use `clipboard.*` through the client passed
  in `createStudio({clipboard})` (manifest already declares the capabilities and `clipboard.read/write`, which the host
  grants to `dev.pocket.studio`); find/replace is the CodeView bar. `fontSlot={inlineFontSlot("body")}` is passed.
* Size: InputField 1 MiB, code editor 4 MiB with a clear message above it. Large files use the chunked read
  (>240 KiB) and verified upload (>192 KiB).
* Guest turn budget (found on the real host and probe): every guest turn runs under a 250 ms interrupt budget; an
  interrupted turn throws an uncatchable error and silently drops the awaiting promise. The pure-JS base64, SHA-256
  and UTF-8 helpers run at about 1 MB/s on the debug build, so `studio-client` hashes, encodes and decodes in slices
  (16 KiB or 40 ms per turn, `Sha256` is incremental, `base64Decode` is table driven) and awaits `yieldTurn` (a frame
  timer) between slices; `TokenCache` tokenizes with a 60 ms budget per turn and CodeView repaints as it catches up
  (rows past the tokenized prefix are uncoloured meanwhile). Probe tests cover opening and saving a >240 KiB file.
* Native text cache: CODE_VIEW.md measured `textLayoutCacheCapacity: 256` thrashing and 2,048 fine. Since M6
  `PocketAppConfig.textLayoutCacheCapacity` carries it to `PocketView` and `studio/lib/main.dart` sets 2,048.
* Deferred to macOS: the IME checklist (candidate window, marked text, clause selection, dead keys), key forwarding
  for Cmd+C/V/F/S on a real keyboard, and the profile-build frame budget. Not claimed as passed.

### Build, console, logs (M3)

`studio.build.events` feeds the status, the log ring buffer (gap marker + authoritative `build.status` read on a
gap) and structured diagnostics; a build whose `done` was lost with the stream is finished from the next status.
Diagnostics are listed in the Console; tapping one opens the file with a recorded jump target `{line, column}`
(the InputField shows a context strip; CodeView will scroll to it).

### Preview flow (M3)

1. `preview.run`: build if needed (`build.run`, waits for `done`) -> `studio.preview.publish` (a 409 means the source
   changed during the build: rebuild, at most 3 attempts) -> `system.runtime.destroy` of the old child ->
   `system.runtime.create({appId:"dev.pocket.studio.preview", prepareForOpen:true})` WITHOUT `cacheFirst` ->
   `system.runtime.awaitFirstFrame` -> phase `running`. A failure at any step is phase `error` with the code and a toast.
2. The child is composited by `CompositorSurface` in the Source dock (setting) or the Preview page; only one is
   mounted at a time. `awaitFirstFrame` is requested only while the surface is on screen (a hidden child cannot
   produce a visible frame); `focused` is dropped while a modal is open. Presenting the child also lets it reach the
   health window (see `sdk/docs/STUDIO_SIGNED_PREVIEW.md`).
3. Runs requested while one is active coalesce into exactly one follow-up run.
4. Auto-build (Settings): a save starts a debounce (300 ms / 800 ms / 2 s); when it fires, `preview.run({build:true})`
   runs. Settings persist as `studio.settings.v1` through `system.storage.*` with `appId: dev.pocket.studio` (the
   host's SystemUI storage; no Dart state). If storage fails the page says changes are session-only.
5. Deploy (Preview page): `studio.preview.devices` / `deploy` (builds first when stale) / `deployStatus` polling
   (stops at a terminal state or `running`) / `deployCancel`.

### Preview child and the catalog (resolved in M3)

The catalog contains `dev.pocket.studio.preview` with `downloadOnOpen` and signed `updates` pointing at
`<origin>/preview/pocket/studio/dev.pocket.studio.preview/preview/latest.json`, namespace `studio-preview`. Previously the key
existed only after the first `preview-publish`, so the child could not be configured at host start. Fix, in the
service (`sdk/editor/server.ts`): `startEditor` creates the dedicated preview key (`previewTrust`, idempotent, never
rotated; the private half stays in the service) before it serves, covered by `editor_preview_publish.test.ts`.
The host (`studio/lib/main.dart`) starts the service, then reads only the public key from the trusted workspace
(`readPreviewKey`), so `downloadOnOpen` and `updates` are always set. The bootstrap metadata the child needs before
any package exists is built by `previewBootstrap` from the Studio's own runtime ABI with a build floor of 1 (previews
are always build >= 2); the signed package carries the real manifest and bytecode. No Dart state machine was added.

### Publish and inspect (M5)

Three rail pages replace the M1 placeholders. All policy is in JS stores; the provider forwards.

* **Publish** (`state/publish.ts`, `pages/publish.tsx`). The page loads `studio.publish.plan` for the chosen channel
  (Test channel / Stable channel): the root target (version, build, built/busy, the channel's current published version, the slot
  owner = this project) and the reused packages with their slot owners (`ownerProjectId`). The publish gate runs in the
  guest and reads the service's current truth: unsaved source edits refuse (publishing signs the saved build only), then
  `build.refresh()` must show `builtRevision === revision`, no error, not busy; otherwise a message and a "Build first" button, and
  **no request is sent**. A release (stable) publish additionally asks in a modal first ("Publish stable release?", cancel publishes
  nothing); a test publish does not. While `studio.publish.publish` is in flight the page shows the step and the last log
  lines of the service (they arrive on the already open `build.events` stream, because the service logs publish steps).
  The result shows the public facts: version, build, source revision, time, key id, runtime ABI, payload sha256, manifest
  (`latest.json`), `host.json`, App entry and archive URLs, published and reused packages, each with a Copy button. A failure
  (409 slot owned by another project, build gate, ...) is shown as the error and a toast, never as a success; a
  `service_timeout` additionally says to check the version page (the service may have finished) and refreshes it. After a
  page reload the last publish is read back from `studio.build.status` (`publish`). **Keys never reach the guest**: the
  service signs with `keys/editor-dev-key.json`; no route returns it, and the provider's scrubber drops key-like fields and
  PEM blocks as a backstop (rule 6 above). The offline package (`studio.publish.offline`) shows the archive file and its
  absolute URL (service origin + `/releases/...`); it never changes a channel.
* **Artifacts** (`state/artifacts.ts`, `pages/artifacts.tsx`). `studio.artifacts.list` says whether a build exists; each
  announced file is inspected once (binaries: size only; JSON: parsed). Overview tabs: bytecode (`runtimeAbi`,
  `bindingGeneration`, `entryFormat`, `tickHz`, payload/source sha256, engine ABI, sizes), Guest manifest (required/optional
  capabilities, permissions, `memory.heapLimitBytes/maxPakBytes`), Package contents and Build information (`build.json`: generation, revision,
  packages). Pack contents are summarised **from the build's resource snapshot (`resources.json`)**: per package the count and
  bytes of resources in the pak vs. network and the asset count. The `.pak`/`.qjbc` themselves are metadata only (embedded
  debug paths cannot be scrubbed); a snapshot above 128 KiB of text or a missing snapshot is reported as such. Selecting a
  file shows its raw text (first 400 lines; `app.js` is fetched only on demand). Hashes have Copy buttons that copy the
  whole value through the clipboard capability client (`studio.copy`); a missing or denied clipboard is reported, not faked.
* **Versions** (`state/versions.ts`, `pages/versions.tsx`). A read-only view of `studio.publish.history`: backend origin,
  host version, compatibility branch, LAN flag, the fixed App entry URL, the `test` and `stable` slots (version/build,
  packages, reused packages, archive URL) and every published release (version, build, revision, time, key identity data,
  payload digest, per-package manifest/host.json URLs, archive URL). Archive downloads are shown as URLs (no file dialog).
  **Trial / promoted / rolled-back is not shown because the service does not know it**: it records publications and slot
  pointers; trial, promotion and rollback are decided on each device by its update coordinator
  (`sdk/docs/RELEASE_TRUST_POLICY.md`). The page says so in place instead of inventing a status.

Composition (`state/studio.ts`): `publish.onPublished` refreshes the version list; a finished build refreshes the publish plan
and (if loaded) the artifact list; a project switch resets all three stores (per-project epochs drop late results).

Service/provider changes made for M5 (everything else was already present): `resources.json` joined the artifact allow-list
(`readArtifact` in `sdk/editor/server.ts`, test in `editor_server.test.ts`); provider: artifact name, compact re-encode of
oversized JSON, publish-result envelope slimming, key scrubbing (`studio_plugin_test.dart`, `real_service_test.dart`).

## Self-hosting and self-update (M6)

The Studio can open, build and publish **its own guest project** (`studio/js`) like any project, and then update
itself through the SDK's normal signed OTA path. No new downloader, verifier or package store exists; Dart gained
configuration only.

**Opening its own project.** The service lists one primary project (`--project-root`). M6 adds trusted
*additional roots*: `--extra-project-root=DIR` (repeatable; `StartEditorOptions.extraProjectRoots`;
`PocketStudioConfig.extraProjectRoots`, dart-define `POCKET_STUDIO_EXTRA_PROJECT_ROOTS`, ':' separated). They are
validated at startup like the primary root (directory, never a symlink, `pocket.json`, unique project id; any problem
aborts startup because the configuration is trusted) and registered in the existing catalog-source map, so listing,
fs, build and publish use the same guarded code. No HTTP route can add, change or list roots, `POST /api/projects`
cannot create over one (409), and paths are scrubbed as before. `bun pocket.ts editor --pocket` adds `studio/js`
automatically. Tests: `sdk/editor/test/editor_extra_roots.test.ts`, `real_service_test.dart`.

**Updating itself.**

```
Studio (v0, bundled or last good)        editor service                      host (PocketSession / coordinator)
Projects -> open "Pocket Studio"  ---->  extra root studio/js (appId dev.pocket.studio)
edit, Console build, Publish test package    ---->  pinned buildGuest, Ed25519 sign (editor-dev-key), test slot
Settings: Check for Studio updates          updates.check{granular,all} ---------------> prepare(): fetch changed blobs, verify
                                    <---- preparedUpdate {version, build}
Apply update                            capture {page, project} to platform.storage; updates.apply{expectedVersion/Build}
                                                                  mount new package after 150 ms: generation++ (QuickJS realm replaced)
new guest: restore handoff, reopen project                         health trial: foreground first frame + 1 s live window
                                                                  -> promoted to lastGood (anti-downgrade floor rises)
```

* Host (`studio/lib/main.dart`, still <= 100 lines, stateless): `studioSystemUI` sets `updates` to
  `PocketUpdateConfig(indexUrl: config.selfUpdateUrl, keyId/publicKey: config.readUpdateKey(), namespace: 'studio-self')`.
  `selfUpdateUrl` is `<origin>/<channel>/pocket/<hostVersion>/dev.pocket.studio/latest.json`; the channel is `test` by default
  (`POCKET_STUDIO_UPDATE_CHANNEL=stable` selects the stable slot). The trusted key is the **public half** of the service's
  update key, read from the trusted workspace (`keys/editor-dev-key.json`) exactly like the preview child reads
  `editor-preview-key.json`; the host never sees the private key. The key is the one `host.json` of the slot publishes. The
  service creates it at startup (`--provision-update-key`, idempotent, never rotated; the host's spawn command passes the flag),
  so the SystemUI is configured before the first publish and no host restart is needed after it. The Studio's bundled
  `assets/` stay the built-in fallback: without a key, without a published package or after a total failure the host runs them.
  The package's `appId` binds it (`PocketManifestVerifier`), so a user project signed by the same key cannot replace the
  Studio unless it declares `dev.pocket.studio`.
* Guest (`state/self-update.ts`, `state/update-link.ts`, Settings page "Studio Update"): `createPocketUpdateClient` with the
  `state` handoff (SYSTEM_UI_SELF_REFRESH.md). **No automatic refresh**: replacing the guest under a user who is editing would
  lose focus and IME state, so the Studio checks (`mode: "granular"`, scope all; the one-shot zip needs the native archive
  extractor, which Linux lacks and a 100 KB package does not need) and applies only on the user's tap. Handoff schema
  `studio-ui/1` carries only `{page, project}`; the restoring guest validates it synchronously and reopens the project after
  the project list and the restore have both settled. Editor buffers, tabs, build logs and the preview child are not carried
  (unsaved edits are saved on disk or lost; the preview child is rebuilt on demand), as documented for any SystemUI update.
  The guest manifest gained optional `updates.status/check/apply` and `platform.storage.get/set/remove`.
* Rollback: the SDK owns it. A candidate that throws at startup or never draws a first frame (15 s watchdog) fails the trial in
  `PocketSession.onError`; the coordinator's `fallbackFor` mounts the last good package (or the bundled bytecode when none is
  recorded) in the same session, keeps `lastError`, and the failed release is not re-applied by a resume event. Because the
  handoff record keeps its source package, the recovered guest restores the same page and project. The Settings page shows the
  host's `lastError` ("Last update failed (rolled back to a working version)") next to the running version.
* Text cache: `PocketAppConfig.textLayoutCacheCapacity` (default 256) is passed to `PocketView`; the Studio sets 2,048.

Test: `studio/test/studio_self_update_test.dart` (real library, real service, real signing, temp copy of `studio/js`).

## M8: project settings form, diagnostics export, SDK upgrade, leftovers

Source-first: the web Studio (`sdk/editor/client/index.html` ids `config-*`, `export-diagnostics`, `studio-upgrade-*`;
`editor.js` `renderStudioUpgrade`), `sdk/editor/diagnostics.ts` and `scripts/studio_upgrade.mjs` were read; the existing routes
cover everything, so `sdk/editor/server.ts` is unchanged. Logic lives in JS (`state/project-settings.ts`,
`state/diagnostics-export.ts`, `state/sdk-upgrade.ts`); the provider only adds the three routes and the diagnostics bound.

* Settings page sections (segmented control): "Studio" (the Studio-local switches, the guest's own OTA self-update, shortcuts;
  unchanged), "Project Settings", "Diagnostics and SDK Upgrade".
* **Project settings** (`studio.project.settings.get/set`) and **on-demand ecosystem modules** (`studio.ecosystem.catalog/get/set`): fields Display name (name; the service derives the title and the page shows
  it), App ID, Version, Build number (strictly read-only current `build` display; rejected as a writable key by `_configKeys`), Frame rate, Reused published packages (`reusePublishedPackages`, comma separated), plus on-demand ecosystem module toggles (`modules` / `profiles`). Only changed fields are sent (numbers as
  numbers). Renaming `appId` is guarded when the workspace has dirty open tabs (refuses or prompts to save/discard before applying a rename that rewrites `manifest.json`/`pocket.json` on disk). The service validates; its message is shown inline under the field it names (`fieldOfMessage` maps the setting name in the
  text), anything else under the form. The draft is kept after a refused save. Dirty handling: a draft survives page switches and a reload
  of the same project; switching project, the guest self-update apply and the SDK upgrade apply go through one `confirmLeave`
  (unsaved files, then unsaved project settings: save and continue / discard / cancel). After a save the project list, build status, and (if
  loaded) publish plan and artifacts refresh, because the service bumped the revision.
* **Open local project & create in parent directory** (`studio.project.openLocal`, `studio.project.create` with `pickParentDirectory` & `ecosystemModules`): the Projects page offers "Open local project" (calls internal `POST /api/projects/pick-directory` + `POST /api/projects/open` in the provider, registers the new scrubbed `<project>` root, and returns `{cancelled:true}` or `Project`) and allows choosing a parent folder + initial ecosystem modules when creating a project without exposing host filesystem paths to the guest.
* **Tencent Cloud COS publishing** (`studio.cos.get/set/check/publish` and `cosPublish`/`cosError` on `studio.publish.publish`): the **Versions** page hosts the full COS configuration UI (bucket/region/keyPrefix/publicBaseUrl/`enabled`/`syncOnPublish`, local/workspace credentials with redacted inspection on `get`, immediate clearing of `secretId`/`secretKey`/`securityToken` inputs after `set`, and scrubbing of `secretKey`/`securityToken` on outbound/returned payloads), runs connectivity checks (`cos.check`, 60 s timeout), and triggers standalone COS uploads (`cos.publish`, 130 s timeout), while the **Publish** page displays `cosPublish` / `cosError` results returned by `studio.publish.publish`.
* **Diagnostics export** (`studio.logs.diagnostics`): Console button "Export diagnostics" and the Settings "Diagnostic records" panel (All / Crashes only). The result
  shows exported time, counts, the export id and the download URL (both with copy buttons), the newest records, and a "Copy diagnostics (JSON)"
  button (no file dialog exists). The bundle is scrubbed in the provider; a bundle that does not fit says so (`truncated`, `omitted`).
* **SDK upgrade** (`studio.service.upgrade.status/check/apply`): panel "SDK Upgrade (Editor service)" with current version, latest release, mode
  (Standalone install / Source checkout, plus `modeReason` and `deferredReason`), platform, last check and release link. Opening the page never touches the network; Check for SDK updates asks the release feed
  (never applies); Apply SDK upgrade appears when a newer release is available (`status: "available"`, HTTP 200 in both standalone and git source-checkout modes) and asks for a confirmation dialog and the unsaved-work prompt.
  In a git source checkout, the service supports git-based SDK upgrades (HTTP 200 `status: "available"` with `deferredReason` / `modeReason` when a fast-forward/checkout upgrade is possible, or HTTP 409 deferral when the service is busy or the git working tree is unclean). A standalone or git apply polls `studio.service.health` (1.5 s, up to 80 times) through the restart and reports the new version or a
  timeout. This panel is separate from the guest OTA self-update ("Studio Update"), which is unchanged.
* **Leftovers**: quick-open requests focus for the chosen document (`workspace.requestFocus` -> `Doc.focus` seq -> the code pane opens its raw
  key session once and calls `focusDone`), so typing continues in the file without a tap. The module-level `lastLine` map of the editor pane moved into
  the workspace (`caretLine`/`setCaretLine`), where it is pruned when a document closes, follows a rename and is cleared on project unload.

Verified on Linux and Apple Silicon macOS (2026-11-17): settings, ecosystem modules, COS config/check/publish against fake & real service, git source-checkout upgrade status/check/deferral, and local directory picker routing. Live COS cloud upload with real credentials and standalone binary release replacement remain manual/release checks.

## Studio-local settings

`studio.settings.v1 = {autoBuild, debounceMs, dockPreview, editor}` in the Studio's SystemUI storage. `studio.project.settings.*`
only accepts the project's own configuration keys, so it is not used for Studio preferences. The manifest declares
`system.storage.get/set/remove/keys` and `system.runtime.awaitFirstFrame` as optional capabilities.

## Keyboard and quick-open (M7)

One table, `studio/js/src/keymap.ts`, maps raw-input key names (`sdk/docs/STUDIO_TEXT_INPUT.md`: modifiers folded in the order
Control, Alt, Shift, Meta, e.g. `Meta+s`, `Shift+Meta+B`, `Control+Shift+p`) to command ids; `state/commands.ts` executes a
command against the stores (the only place where "build" or "close tab" is defined); Settings renders the same table
(`helpRows`). `Mod` is Meta on macOS and Control elsewhere; the default platform `any` accepts exactly one of them, so
`Control+Meta+b` is nothing.

Routing uses the existing raw key path, no second one: while a CodeView owns the keyboard its raw text session consumes every
text event (framework handlers run newest first), so the CodeView offers each key-down to the shell through its
`onKeyDown(key, owned)` hook (`@pocket/ui/code-view`) before handling it; when no editor has the keyboard the shell's own
`onTextEvent` handler in `app.tsx` receives the plain key events. Both call `commands.handleKey`.

Precedence (documented and tested in `keymap.test.ts`, `studio_guest_keys.test.ts`):

1. **Editor-scoped bindings** (Cmd+S, Cmd+F) belong to the CodeView while it has the keyboard: its save intent runs the same
   `workspace.save` (exactly one write), its find bar opens. The shell runs them only when no editor has the keyboard (Cmd+F then
   switches to Source and sends a find request that the pane turns into `focus()` + `openFind()`).
2. **Global bindings** (build, quick-open, close tab, tab switch, pages, publish) win even if CodeView's keymap also maps the
   key; they are consumed before the editor sees them. The only overlap is Shift+[ / ] when a host names them `[` / `]`
   instead of `{` / `}` (the editor's outdent / indent-lines); the tab switch wins.
3. **Conditional globals** (Esc, ArrowUp/Down, Enter) are consumed only while a dialog or quick-open is open; otherwise the
   command reports "not handled" and the key reaches the editor untouched (Esc still closes find).
4. Unbound keys always reach the editor. A focused `InputField` is a Flutter text field: its keys never reach the guest.

| Key | Command | Notes |
| --- | --- | --- |
| Cmd+S | save | editor-scoped |
| Cmd+F | find | editor-scoped |
| Cmd+B / Cmd+Shift+B | build / build + publish preview + reload child | `build.start` / `preview.run({build:true})` |
| Cmd+P | quick-open toggle | needs a project |
| Cmd+W | close tab | dirty tab asks first (existing dialog) |
| Cmd+Shift+[ / ] | previous / next tab (wraps) | `stepTab` from `@pocket/ui/tabs` |
| Cmd+1..9 | rail page by position | `STUDIO_PAGES` order |
| Cmd+Shift+P | publish | opens the Publish page and loads the plan; signing stays behind that page's button (and the stable-channel confirmation) |
| Esc | close dialog, else quick-open | conditional |

Quick-open (`state/quick-open.ts`, `lib/fuzzy.ts`, `components/quick-open.tsx`): subsequence match over the project's editable
files with word-start, consecutive and file-name bonuses; an empty query lists open tabs first. The overlay's field uses the new
`InputField autoFocus` so typing works right after Cmd+P; arrows/Enter/Esc come from the keymap when the field's session does
not take them, rows are tappable, Enter in the field accepts too.

## Shared components and the Source layout (M7)

`Tree`, `SplitPane`, `TabsBar` and `ToastHost` live in `sdk/packages/pocket_ui` (record: `sdk/docs/SHARED_EDITOR_COMPONENTS.md`);
the Studio keeps `file-tree.tsx` (toolbar around `Tree`) and `state/toasts.ts`. The Source page is
`SplitPane(tree | SplitPane(editor | preview dock))`: widths 240 / 300 by default, limits 160-480 and 200-640, live while dragging,
persisted once on release in `studio.settings.v1` (`treeWidth`, `dockWidth`; invalid values clamp to the limits).

## Record-and-replay regression and profiling (M7)

* `studio/test/studio_recording_test.dart` uses the SDK recording facility (`PocketRecordingLibrary`, `docs/RECORDING_REPLAY.md`)
  on the real Studio guest, host plugins and a real service on a temp project. Recorded: open, file open, IME edit, Cmd+S, Cmd+B,
  Cmd+Shift+P, publish tap. Replay: fresh native guests, no providers, `host.response`s, clock values and inputs from the tape, every
  frame digest must match; then the exported archive is replayed from disk. **Determinism:** a tape pins the bytecode hash, so
  it is re-recorded on every run rather than stored; the stored fixture is the normalised semantic checkpoint list
  (`test/fixtures/journey_checkpoints.json`), free of timestamps, build ids, hashes, ports and paths.
* SDK fix found by this test: `PocketView` synced host font metrics after compositor/offload/worker configuration. A recording
  locks its font snapshot with the first recorded transaction, so the sync was deferred and a native-text bytecode (the Studio)
  could not load. The sync now runs right after the runtime is created.
* `studio/js/tests/studio_profile.test.ts` and the extended `studio_code_editor_test.dart`: see `PERFORMANCE.md`. The SDK exposes no
  QuickJS used-bytes counter, so the heap high-water is bisected with the real allocator ceiling (`memory.heapLimitBytes`).
* Leak review (`keymap.test.ts` "resources are released"): tab churn and project switches keep one watch stream and one build stream,
  editor buffers are dropped with their document, toasts (4) and the build log ring (2,000) are bounded. The probe churn test shows
  no linear RSS growth (24 versus 6 cycles: +2 MB versus +3 MB).

## Building and running on macOS

```sh
cd studio/js && bun install && bun run build      # writes studio/assets/{app.qjbc,app.pak,...}
cd .. && flutter pub get
flutter run -d macos \
  --dart-define=POCKET_STUDIO_SDK_ROOT=/path/to/pocket/sdk \
  --dart-define=POCKET_STUDIO_PROJECT_ROOT=/path/to/a/pocket/project \
  --dart-define=POCKET_STUDIO_WORKSPACE=/path/to/studio-workspace
# or: flutter run -d macos --dart-define-from-file=studio.config.example.json (after editing the paths)
```

Shortcut: on macOS when `studio/` is present in the repo checkout, `bun sdk/pocket.ts editor [<project>] [--port=N] [--workspace=DIR]` defaults to Pocket Studio (`--pocket` is also accepted explicitly): `sdk/scripts/pocket_studio_launcher.ts` writes the trusted
configuration to `<workspace>/pocket-studio-host.config.json`, adds `studio/js` as an extra root, auto-detects `<repoRoot>/.fvm/flutter_sdk/bin/flutter` (falling back to `POCKET_FLUTTER` or `flutter` on `PATH`), and runs
`flutter run -d macos --dart-define-from-file=...` in `studio/`; the host attaches to a running service or starts one.
Use `--web` or `POCKET_EDITOR_UI=web` (or service-only flags, standalone Web SDK exports without `studio/`, or non-macOS platforms) to launch the web Studio. On non-macOS platforms, passing `--pocket` explicitly exits with "Pocket Studio host is macOS-only; use the web Studio (bun pocket.ts editor) on this
platform".

The macOS target is the only platform (`studio/macos`). The app runs without the App Sandbox
(`macos/Runner/*.entitlements`) because it starts `bun` and reads the trusted workspace; this is a developer-tool
host. Verified on Apple Silicon macOS (2026-11-17): `bash sdk/scripts/build_native.sh macos` produced `libpocket_flutter.a`, `flutter build macos --debug` in `studio/` produced `pocket_studio_app.app`, which launched via Impeller MetalSDF, started the live editor service via `PocketStudioService` (`POCKET_STUDIO_BUN`), passed `/health` (`service: pocket-editor`), and stayed running cleanly; all automated guest/host/provider test suites passed (`studio/test` 10/10, `studio/js` `test_guest.sh` 129 unit + 70 probe, `pocket_studio` 94/94 with `POCKET_REQUIRE_REAL=1`, `pocket_clipboard` 13/13, `pocket_file_picker` 9/9). Interactive live macOS GUI/IME candidate-window checks, live COS cloud upload with real credentials, and Apple Developer ID signing/notarisation remain manual/distribution steps.

## Tests

* `sdk/packages/pocket_studio/test/studio_plugin_test.dart`: real loopback HTTP fake: routing of every call,
  validation, CSRF, scrubbing, error mapping, SSE batching/gap/cancel, admission and permission denial, lifecycle.
* `sdk/packages/pocket_studio/test/real_service_test.dart`: the real editor service started by the lifecycle helper.
* `studio/js/tests/studio_client.test.ts`, `tree.test.ts`: client request shapes, chunk splitting, sha256, errors.
* `studio/js/tests/state.test.ts`: ring buffer, resilient streams, toasts/dialogs, workspace (save, dirty prompts, watch
  reconcile, tree operations), build, preview orchestration (phases, 409 rebuild, coalescing, failures), settings.
* `studio/js/tests/studio_guest_{native,workflows,preview}.test.ts`: the built bytecode on the real `pocket_probe`
  with the stateful `fake_studio.ts` (studio.* and System host): input-driven frame changes for every flow above.
* `studio/test/studio_host_test.dart`: M1 exit test (real native library, real service on the demo JS project).
* `studio/test/studio_edit_test.dart`: M2 exit test (temp copy of the Showcase project, edit + Save on disk).
* `studio/test/studio_preview_loop_test.dart`: M3 exit test (auto-build, signed preview child reloads, latency).
* `studio/test/studio_code_editor_test.dart`: M4 exit test, Linux half (5,000-line TSX through the real host: wheel scroll, IME deltas, hardware keys, Meta+Z, Meta+S, file on disk; prints layout-cache stats).
* `studio/js/tests/studio_guest_code.test.ts`: code pane on the probe (typing, save write/upload, >240 KiB open, diagnostic jump, reload, settings switch, clipboard, find). The M2/M3 tests select the InputField explicitly.
* `studio/js/tests/state_m5.test.ts`, `studio_guest_publish.test.ts` (fake service on the real probe): publish/artifacts/versions stores and the three pages by taps.
* `studio/test/studio_self_update_test.dart`: M6 exit test (Linux): the Studio opens its own project (temp copy of `studio/js`, trusted extra root), builds and publishes it by taps; Settings checks and applies; the running Studio shows the new marker; a deliberately broken build (throws at startup) is applied and the host rolls back to the last good package; the package store's `active`/`lastGood` pointers are asserted.
* `studio/js/tests/state_m6.test.ts`, `studio_guest_update.test.ts`: self-update store and the Settings flow on the real probe with a fake host.
* M8: `studio/js/tests/state_m8.test.ts` (project settings, diagnostics export, SDK upgrade stores, confirm-leave composition, quick-open focus, caret-line pruning), `studio_guest_settings.test.ts` (input-driven on the probe: settings form with inline service errors and save, leave prompt, diagnostics export and copy, SDK upgrade in source and standalone mode, quick-open refocus), `sdk/packages/pocket_studio/test/{studio_plugin_test,real_service_test}.dart` (routes, fixed `autoApply:false`, scrubbing and bounds of the export, permissions; real service: settings round trip and validation, export and its download URL, upgrade status/check against a local releases feed and the 409 apply).
* `studio/test/studio_publish_test.dart`: M5 exit test (Linux part): real service + real signing; the Studio guest publishes a signed test update by taps; a client (`PocketHostConfig.load` -> `PocketSession` -> `FfiPocketRuntime`) downloads, verifies, activates and runs it; a second publish is picked up by the same client session; no key material or absolute path reached the guest.
* M7: `studio/test/studio_recording_test.dart` (record/replay regression), `studio/js/tests/keymap.test.ts` (keymap, fuzzy, commands, leak checks), `studio_guest_keys.test.ts` (keys on the probe), `studio_profile.test.ts` (profiling bounds), `sdk/packages/pocket_ui/test/shared_components_{model,native}.test.ts`.

Known gaps found while testing: (1) in the probe harness a second large (>~170 KB) inbound `host.response` right after
another is not delivered to the guest, so chunked reads are verified by bun unit tests and the verified client, not by
a probe test; the real-host path for files above 240 KiB is unverified. (2) The multi-line InputField shapes the whole
text, which is slow for ~100 KiB files on the debug native build (fine on release).
