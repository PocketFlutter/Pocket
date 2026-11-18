# Editor Studio Review and Acceptance Report

The review covered the uncommitted Editor Studio changes. Other SDK changes were outside its scope. The actual `agy` catalog supplied `gemini-4-argon-high` with effort `high`. Session `47c02dae-c591-4166-9cf1-434178d9863d` contained one independent review and one correction pass with the same model.

## Conclusion

The Editor work had the following workflow issues at review time. All 28 existing tests passed. They left gaps for edits during builds, process exit after deployment reaches running, and probe recovery.

The coordinator rejected the first Argon draft because it cited nonexistent APIs, expected output from a failing script, and descriptions inconsistent with the code. The correction pass withdrew those claims. The findings below come from coordinator code inspection or independent execution. Running build scripts from a trusted local project was outside the scope of confirmed remote code execution. The coordinator reassessed the original High ratings and confirmed local development reliability issues. No urgent security blocker was verified.

## Confirmed Findings

### 1. Writes During Builds Change Inputs and Failures Block New Revisions (P2)

Locations `sdk/editor/server.ts:760`, `:852`, `:862`, `:1285`, `:1309`.

A file or config save can arrive after an asynchronous build starts and before its runner completes. The HTTP-level `projectWrites` lock releases when the server returns 202. Write branches do not all check `state.busy`, so the compiler reads mutable project files. The artifact manifest is read after the runner finishes, leaving no guarantee of one input revision. After a build failure, the `!state.error` guard ends the loop even if a newer revision was saved.

An isolated temporary instance returned 202 and busy=true. PUT source succeeded with 200 and changed revision 1 to 2. Releasing an intentionally failing runner left revision=2, builtRevision=null, busy=false, and the older error. This establishes state-machine behavior. Compiler output consistency remains untested.

A minimal fix would reject project input writes during builds with 409. To support editing during compilation, use immutable input snapshots and associate errors with the originating revision. Add regression coverage for saves during builds and retries after failures.

### 2. Temporary UI Backup Is Rejected as Editor Input (P2)

Locations `sdk/editor/server.ts:412`, `:450`, and `sdk/scripts/build_guest.ts:263`.

During buildGuest, node_modules/@pocket/ui containing an SDK symlink can move to project-root `.pocket-ui-backup-*`. An overlapping file-list request sees the backup. Input scanning skips node_modules but does not recognize the generated backup. listEditableFiles validates the whole tree before skipping hidden directories.

A temporary build created a backup symlink matching the builder's structure. GET files returned 400 and `project contains unsupported source symlink: .pocket-ui-backup-review/ui`. The builder's source confirmed the backup layout. The reproduction simulated the timing window using an isolated project.

Unify generated-file boundaries. Backup moves require a same-volume rename, so a generic /tmp destination may fail. Recognize trusted generated directories or consolidate same-volume temporaries under the existing build directory while preserving user-source symlink validation. Exclude temporary `pocket-ui-entry-*.tsx` from editable sources.

### 3. Deployment Status Stops Updating After Running (P2)

Locations `sdk/editor/client/editor.js:777`, `:789`, `:807`, and `sdk/editor/devices.ts:954`.

After the browser observes running, Flutter may exit, the device can disconnect, or the task can time out. pollDeploy and resumeDeployment stop querying at running while retaining activeDeploy. The server can still transition to succeeded or failed. Without notification, logs and status stay at running, and deployment and project switching remain locked until Stop or refresh.

Code inspection confirmed the path. Physical disconnect was outside this run. Server events could deliver terminal state. With polling, keep tracking in running, reduce frequency for hidden tabs, and clear activeDeploy at completion.

### 4. Preview System Surface Handles Diverge From Official Build (P2)

Locations `sdk/editor/preview.ts:190`, `sdk/scripts/build_system.ts:628`, `:669`.

When a catalog excluding SystemUI contains an uninstalled entry before an installed entry, allocation diverges. The official build uses catalog index `2 + index`, leaving gaps for uninstalled entries. Preview increments only for installed entries. For [uninstalled A, installed B], official B=3 and Preview B=2.

Inspection compared both functions directly. Browser child-app composition is incomplete and was outside runtime coverage. Reuse a single surface registry rule and test both paths with sparse installation.

### 5. Probe Discovery Cannot Recover From an Initial Miss (P2)

Location `sdk/editor/preview.ts:687`.

If the first findProbe call cannot locate the binary, the rejected probePathPromise remains cached. Adding the file at the expected location still returns the same not found error. The test verified path discovery with a temporary file. Executable probe behavior was outside the check.

Clear the cache on rejection so the next call discovers paths again. Add a failed-then-recovered regression.

### 6. Saves Write Twice and Shortcuts Bypass Button Guards (P2)

Locations `sdk/editor/client/editor.js:404`, `:1254`.

Saving source, or pressing Cmd/Ctrl+S with no changes or during a build, reaches saveProject. It checks currentId and saving but omits dirty/workLocked and always sends serial PUTs to files and config. If config validation fails, the file is already saved while the UI displays Save failed. A clean shortcut can generate two revisions.

Inspection covered the client and both server write branches. Browser automation for this boundary was not run. Use one save predicate and send only changed data. If both writes must be atomic, validate both before committing.

## Known Limits and Open Checks

- The cancellation fallback for the Codex App Server shared by multiple projects can widen the failure domain. Concurrent multi-project support needs cancellation tests and explicit isolation rules.
- The roughly ten-minute browser turn polling budget is close to server timeouts and cleanup windows. A request may still be rejected briefly after the UI unlocks. The ten-minute boundary was not tested.
- Preview reads pocket.system.json outside the server's safeProjectFile path, so path validation differs. Unauthorized disclosure within the current trusted workspace was not demonstrated.
- Canvas native hardware, system IME, and full System child guest composition were unsupported. Actual Android installation, a live model turn, and device disconnect were outside this acceptance.

## Executed Verification

Argon ran the following checks.

- `cd sdk && bun run test:editor` returned 28 pass, 0 fail, 258 expect, 6 files, about 3.54s.
- `python3 sdk/scripts/check_architecture.py` passed.
- Actual API calls on an isolated /tmp instance reproduced file-list 400, PUT 200 during build, old errors blocking the queue, and cached findProbe rejection. The script exited 0.
- GET files on the live 8791 service succeeded through a read-only request. No live writes ran.

The coordinator also ran the following checks.

- `bun /tmp/pocket-editor-root-verify.ts` independently reproduced concurrent writes, false rejection of temporary directories, and probe recovery failure. Log `/tmp/pocket-editor-root-verify.log`.
- `node --check sdk/editor/client/editor.js` and `node --check sdk/editor/client/preview.js` passed.
- `git diff --check` passed.

The review added this report. Implementation sources and live services on 8790/8791 and Flutter previews stayed in place. Performance and physical device acceptance were outside the evidence.
