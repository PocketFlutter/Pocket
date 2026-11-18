import { describe, expect, test } from "bun:test";
import { createManualTimers } from "../src/state/env.ts";
import { createToasts } from "../src/state/toasts.ts";
import { createDialogs } from "../src/state/dialogs.ts";
import { SETTING_FIELDS, createProjectSettings, fieldOfMessage, toValues } from "../src/state/project-settings.ts";
import { createDiagnosticsExport } from "../src/state/diagnostics-export.ts";
import { createSdkUpgrade, toUpgradeInfo } from "../src/state/sdk-upgrade.ts";
import { createStudio } from "../src/state/studio.ts";
import { StudioError, type StudioClient } from "../src/studio-client.ts";
import { createFakeClient, flush } from "./fake_client.ts";

const config = { id: "p1", name: "Alpha", title: "Alpha", appId: "pocket.alpha", version: "1.0.0", build: 3, tickHz: 60, entry: "app.tsx" };

function settingsHarness(setImpl?: (project: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const timers = createManualTimers();
  const toasts = createToasts(timers);
  const dialogs = createDialogs();
  const sets: Record<string, unknown>[] = [];
  let saved = 0;
  const client = {
    project: {
      settings: {
        get: async () => ({ ...config }),
        set: async (project: string, body: Record<string, unknown>) => {
          sets.push(body);
          if (setImpl) return setImpl(project, body);
          return { ...config, ...body, ...(body.name ? { title: body.name } : {}), status: { revision: 9 } };
        },
      },
    },
  } as unknown as StudioClient;
  const ps = createProjectSettings({ client, toasts, dialogs, onSaved: () => { saved += 1; } });
  return { ps, sets, dialogs, toasts, saved: () => saved };
}

describe("project settings", () => {
  test("values map from the service config (build is read-only baselineBuild, not in SETTING_FIELDS) and the service message names the field", () => {
    expect(SETTING_FIELDS).toEqual(["name", "appId", "version", "tickHz", "reuse"]);
    expect((SETTING_FIELDS as readonly string[]).includes("build")).toBe(false);
    expect(toValues({ ...config, reusePublishedPackages: ["a.b", "c.d"] })).toEqual({ name: "Alpha", appId: "pocket.alpha", version: "1.0.0", tickHz: "60", reuse: "a.b, c.d" });
    expect("build" in toValues(config)).toBe(false);
    expect(fieldOfMessage("appId contains unsafe characters (HTTP 400)")).toBe("appId");
    expect(fieldOfMessage("tickHz must be an integer from 1 through 120")).toBe("tickHz");
    expect(fieldOfMessage("build must be a positive safe integer")).toBe("build");
    expect(fieldOfMessage("version contains unsafe characters")).toBe("version");
    expect(fieldOfMessage("name must not be empty")).toBe("name");
    expect(fieldOfMessage("the root app cannot reuse its own published package")).toBe("reuse");
    expect(fieldOfMessage("disk exploded")).toBeUndefined();
  });

  test("load, edit, save sends only the changed fields (numbers as numbers, never build) and keeps baselineBuild read-only", async () => {
    const h = settingsHarness();
    await h.ps.attach("p1");
    expect(h.ps.state()).toMatchObject({ phase: "ready", project: "p1", baselineBuild: 3 });
    expect(h.ps.dirty()).toBe(false);
    h.ps.setField("version", "1.1.0");
    h.ps.setField("tickHz", " 90 ");
    h.ps.setField("reuse", "x.y, z.w");
    // Attempting to set "build" is ignored because build is read-only metadata.
    (h.ps.setField as (f: string, v: string) => void)("build", "99");
    expect(h.ps.dirtyFields()).toEqual(["version", "tickHz", "reuse"]);
    expect(await h.ps.save()).toBe(true);
    expect(h.sets).toEqual([{ version: "1.1.0", tickHz: 90, reusePublishedPackages: ["x.y", "z.w"] }]);
    expect("build" in h.sets[0]!).toBe(false);
    expect(h.ps.dirty()).toBe(false);
    expect(h.ps.state().saved).toMatchObject({ version: "1.1.0", tickHz: "90" });
    expect(h.ps.state().baselineBuild).toBe(3);
    expect(h.saved()).toBe(1);
    expect(h.toasts.items().some((t) => t.message.includes("已保存"))).toBe(true);
    // Renaming: the service derives the title.
    h.ps.setField("name", "Beta");
    await h.ps.save();
    expect(h.ps.state().title).toBe("Beta");
  });

  test("service validation errors stay inline at the named field, the draft is kept, and editing the field clears the error", async () => {
    const h = settingsHarness(async (_p, body) => {
      if (body.appId) throw new StudioError("studio.project.settings.set", "invalid_request", "appId contains unsafe characters (HTTP 400)");
      if (body.tickHz) throw new StudioError("studio.project.settings.set", "invalid_request", "tickHz must be an integer from 1 through 120 (HTTP 400)");
      throw new StudioError("studio.project.settings.set", "service_error", "disk full (HTTP 500)");
    });
    await h.ps.attach("p1");
    h.ps.setField("appId", "bad id!");
    expect(await h.ps.save()).toBe(false);
    expect(h.ps.state().errors.appId).toContain("unsafe characters");
    expect(h.ps.state().draft.appId).toBe("bad id!");
    expect(h.ps.dirty()).toBe(true);
    expect(h.saved()).toBe(0);
    h.ps.setField("appId", "good.id");
    expect(h.ps.state().errors.appId).toBeUndefined();
    h.ps.reset();
    h.ps.setField("tickHz", "500");
    await h.ps.save();
    expect(h.ps.state().errors.tickHz).toContain("1 through 120");
    h.ps.reset();
    h.ps.setField("name", "N");
    await h.ps.save();
    expect(h.ps.state().errors.form).toContain("disk full");
  });

  test("a non-integer tickHz never reaches the service", async () => {
    const h = settingsHarness();
    await h.ps.attach("p1");
    h.ps.setField("tickHz", "abc");
    expect(await h.ps.save()).toBe(false);
    expect(h.sets).toEqual([]);
    expect(h.ps.state().errors.tickHz).toContain("整数");
  });

  test("a draft survives a reload of the same project; attach (project switch) replaces it", async () => {
    const h = settingsHarness();
    await h.ps.attach("p1");
    h.ps.setField("version", "9.9.9");
    await h.ps.load("p1");
    expect(h.ps.state().draft.version).toBe("9.9.9");
    await h.ps.attach("p2");
    expect(h.ps.state().draft.version).toBe("1.0.0");
  });

  test("confirmLeave: nothing dirty passes silently; dirty asks save / discard / cancel", async () => {
    const h = settingsHarness();
    await h.ps.attach("p1");
    expect(await h.ps.confirmLeave()).toBe(true);
    expect(h.dialogs.active()).toBeUndefined();
    h.ps.setField("version", "2.0.0");
    let leave = h.ps.confirmLeave();
    expect(h.dialogs.active()?.title).toContain("项目设置尚未保存");
    expect(h.dialogs.active()?.body).toContain("版本");
    h.dialogs.cancel();
    expect(await leave).toBe(false);
    expect(h.ps.dirty()).toBe(true);
    leave = h.ps.confirmLeave();
    h.dialogs.choose("discard");
    expect(await leave).toBe(true);
    expect(h.ps.dirty()).toBe(false);
    h.ps.setField("version", "2.0.0");
    leave = h.ps.confirmLeave();
    h.dialogs.confirmActive();
    expect(await leave).toBe(true);
    expect(h.sets).toEqual([{ version: "2.0.0" }]);
  });

  test("a failed save in confirmLeave keeps the user on the project", async () => {
    const h = settingsHarness(async () => { throw new StudioError("x", "invalid_request", "version contains unsafe characters"); });
    await h.ps.attach("p1");
    h.ps.setField("version", "!!");
    const leave = h.ps.confirmLeave();
    h.dialogs.confirmActive();
    expect(await leave).toBe(false);
    expect(h.ps.state().errors.version).toBeDefined();
  });
});

describe("diagnostics export", () => {
  const exported = { exportId: "diag-p1-20261116", project: "p1", totalRecords: 3, logCount: 2, crashCount: 1, keptRecords: 3, omitted: 0, truncated: false, records: [{ kind: "crash", message: "boom" }], downloadUrl: "http://127.0.0.1:8791/api/projects/p1/diagnostics?download=1" };
  function harness(project: string = "p1", fail?: StudioError) {
    const timers = createManualTimers();
    const toasts = createToasts(timers);
    const asked: unknown[][] = [];
    const client = { logs: { diagnostics: async (...args: unknown[]) => { asked.push(args); if (fail) throw fail; return exported; } } } as unknown as StudioClient;
    return { d: createDiagnosticsExport({ client, toasts, project: () => project || undefined }), asked, toasts };
  }
  test("export keeps the summary and offers the bundle as JSON", async () => {
    const h = harness();
    expect(await h.d.run()).toBe(true);
    expect(h.asked).toEqual([["p1", undefined]]);
    expect(h.d.state()).toMatchObject({ phase: "done", result: { exportId: "diag-p1-20261116" } });
    expect(JSON.parse(h.d.bundleText()!).downloadUrl).toContain("download=1");
    await h.d.run("crash");
    expect(h.asked[1]).toEqual(["p1", "crash"]);
    h.d.reset();
    expect(h.d.state().phase).toBe("idle");
    expect(h.d.bundleText()).toBeUndefined();
  });
  test("no project -> a hint, no call; a failure is reported, never shown as a result", async () => {
    const none = harness("");
    expect(await none.d.run()).toBe(false);
    expect(none.asked).toEqual([]);
    const bad = harness("p1", new StudioError("studio.logs.diagnostics", "too_large", "service response exceeds 16777216 bytes"));
    expect(await bad.d.run()).toBe(false);
    expect(bad.d.state()).toMatchObject({ phase: "error" });
    expect(bad.d.state().result).toBeUndefined();
    expect(bad.toasts.items().some((t) => t.message.includes("导出诊断失败"))).toBe(true);
  });
});

describe("sdk upgrade", () => {
  const source = { currentVersion: "0.1.12", latestVersion: "0.1.12", mode: "source", status: "idle", upgradeAvailable: false, platformTuple: "linux-x64", rolledBack: false };
  function harness(over: { checked?: Record<string, unknown>; apply?: () => Promise<Record<string, unknown>>; health?: () => Promise<{ ok: boolean; service: string; version?: string }>; leave?: boolean } = {}) {
    const timers = createManualTimers();
    const toasts = createToasts(timers);
    const dialogs = createDialogs();
    const calls: string[] = [];
    let current: Record<string, unknown> = { ...source, ...(over.checked ? {} : {}) };
    const client = {
      service: {
        upgradeStatus: async () => { calls.push("status"); return current; },
        upgradeCheck: async () => { calls.push("check"); current = { ...source, ...over.checked }; return current; },
        upgradeApply: async () => { calls.push("apply"); return over.apply ? over.apply() : { ...current, status: "restarting", targetVersion: "0.2.0" }; },
        health: over.health ?? (async () => { calls.push("health"); return { ok: true, service: "pocket-editor", version: "0.1.12" }; }),
      },
    } as unknown as StudioClient;
    const up = createSdkUpgrade({ client, timers, toasts, dialogs, confirmLeave: async () => over.leave !== false });
    return { up, calls, dialogs, toasts, timers };
  }

  test("info maps the service status; load makes no network check", async () => {
    expect(toUpgradeInfo({ ...source, mode: "weird" }).mode).toBe("unknown");
    const h = harness();
    await h.up.load();
    expect(h.calls).toEqual(["status"]);
    expect(h.up.state().info).toMatchObject({ currentVersion: "0.1.12", mode: "source", upgradeAvailable: false });
  });

  test("source checkout: a check reports the newer release and says it will not be applied; apply is refused with the service's 409 text", async () => {
    const h = harness({
      checked: { latestVersion: "0.2.0", upgradeAvailable: true, status: "available", releaseUrl: "https://github.com/x/releases/tag/sdk-v0.2.0" },
      apply: async () => { throw new StudioError("studio.service.upgrade.apply", "conflict", "当前为源码检出模式，仅支持检查新版本，禁止自动覆盖 Git 工作区 (HTTP 409)"); },
    });
    await h.up.check();
    expect(h.up.state().info).toMatchObject({ latestVersion: "0.2.0", upgradeAvailable: true, mode: "source" });
    expect(h.up.state().notice?.tone).toBe("warn");
    expect(h.up.state().notice?.text).toContain("不会自动覆盖");
    const done = h.up.apply();
    await flush();
    expect(h.dialogs.active()?.title).toContain("v0.2.0");
    expect(h.dialogs.active()?.body).toContain("409");
    h.dialogs.confirmActive();
    await done;
    expect(h.calls).toEqual(["check", "apply"]);
    expect(h.up.state().phase).toBe("idle");
    expect(h.up.state().notice).toMatchObject({ tone: "warn" });
    expect(h.up.state().notice?.text).toContain("禁止自动覆盖 Git 工作区");
  });

  test("apply needs a found upgrade, the dialog and the unsaved-work prompt; cancelling either does nothing", async () => {
    const found = { latestVersion: "0.2.0", upgradeAvailable: true, status: "available", mode: "standalone" };
    const h = harness({ checked: found });
    await h.up.apply();
    expect(h.calls).toEqual([]);
    await h.up.check();
    let done = h.up.apply();
    await flush();
    h.dialogs.cancel();
    await done;
    expect(h.calls).toEqual(["check"]);
    const unsaved = harness({ checked: found, leave: false });
    await unsaved.up.check();
    done = unsaved.up.apply();
    await flush();
    unsaved.dialogs.confirmActive();
    await done;
    expect(unsaved.calls).toEqual(["check"]);
    expect(unsaved.up.state().phase).toBe("idle");
  });

  test("standalone apply: the service restarts, the Studio waits through unreachable health calls and reports the new version", async () => {
    let healthCalls = 0;
    const h = harness({
      checked: { latestVersion: "0.2.0", upgradeAvailable: true, status: "available", mode: "standalone" },
      health: async () => {
        healthCalls += 1;
        if (healthCalls < 3) throw new StudioError("studio.service.health", "service_unreachable", "connect refused");
        return { ok: true, service: "pocket-editor", version: "0.2.0" };
      },
    });
    await h.up.check();
    const done = h.up.apply();
    await flush();
    h.dialogs.confirmActive();
    await done;
    expect(h.up.state().phase).toBe("restarting");
    for (let i = 0; i < 5 && h.up.state().phase === "restarting"; i += 1) { h.timers.advance(1500); await flush(); }
    expect(healthCalls).toBe(3);
    expect(h.up.state().phase).toBe("idle");
    expect(h.up.state().notice).toMatchObject({ tone: "ok" });
    expect(h.up.state().notice?.text).toContain("v0.2.0");
    expect(h.toasts.items().some((t) => t.message.includes("SDK 已升级到 v0.2.0"))).toBe(true);
  });

  test("a restart that never comes back is reported as an error after the wait limit", async () => {
    const h = harness({
      checked: { latestVersion: "0.2.0", upgradeAvailable: true, status: "available", mode: "standalone" },
      health: async () => { throw new StudioError("studio.service.health", "service_unreachable", "refused"); },
    });
    await h.up.check();
    const done = h.up.apply();
    await flush();
    h.dialogs.confirmActive();
    await done;
    for (let i = 0; i < 90; i += 1) { h.timers.advance(1500); await flush(1); }
    expect(h.up.state().phase).toBe("error");
    expect(h.up.state().notice?.text).toContain("超时");
  });

  test("a failed check is an error, not a result", async () => {
    const timers = createManualTimers();
    const client = { service: { upgradeCheck: async () => { throw new StudioError("x", "service_error", "检查 GitHub Release 失败（HTTP 403）"); } } } as unknown as StudioClient;
    const up = createSdkUpgrade({ client, timers, toasts: createToasts(timers), dialogs: createDialogs(), confirmLeave: async () => true });
    await up.check();
    expect(up.state().phase).toBe("error");
    expect(up.state().notice?.tone).toBe("danger");
    expect(up.state().info).toBeUndefined();
  });
});

describe("studio composition", () => {
  function studioWith(fake = createFakeClient()) {
    const timers = createManualTimers();
    const studio = createStudio({
      client: fake.client, timers,
      runtime: { ensure: async () => {}, create: async () => ({ instanceId: "i1", generation: 1 }), destroy: async () => {}, awaitFirstFrame: async () => {} },
      settingsBackend: { get: async () => undefined, set: async () => {} },
    });
    return { studio, fake, timers };
  }

  test("replacing the selected asset re-stats it so its size and mtime are not stale; another asset is left alone", async () => {
    const fake = createFakeClient();
    let mtime = 1;
    let bytes = 10;
    (fake.client as any).fs.stat = async (_p: string, path: string) => { fake.calls.push({ name: "stat", args: [path] }); return { path, kind: "file", bytes, mtimeMs: mtime, editable: false }; };
    (fake.client as any).hash = { create: () => ({ update: async () => {}, hex: () => "0".repeat(64) }) };
    (fake.client as any).assets = { begin: async () => ({ uploadId: "u1", chunkBytes: 131072 }), commit: async () => { bytes = 99; mtime = 2; return {}; } };
    (fake.client as any).fs.upload = { chunk: async () => ({}), abort: async () => ({}) };
    let picked = { handle: "h1", name: "a.png", size: 3, mime: "image/png" };
    const files = {
      pickOpen: async () => [picked],
      readChunk: async () => ({ length: 3, size: 3, eof: true, data: Buffer.from("abc").toString("base64") }),
      release: async () => true,
    };
    const timers = createManualTimers();
    const studio = createStudio({
      client: fake.client, timers, files,
      runtime: { ensure: async () => {}, create: async () => ({ instanceId: "i1", generation: 1 }), destroy: async () => {}, awaitFirstFrame: async () => {} },
      settingsBackend: { get: async () => undefined, set: async () => {} },
    });
    await studio.projects.open("alpha");
    await flush();
    await studio.workspace.selectAsset("a.png");
    expect(studio.workspace.state().asset).toMatchObject({ name: "a.png", bytes: 10, mtimeMs: 1 });
    const statsBefore = fake.calls.filter((c) => c.name === "stat").length;

    const replacing = studio.assets.pick();
    await flush();
    studio.dialogs.confirmActive();
    await replacing;
    await flush();
    expect(fake.calls.filter((c) => c.name === "stat").length).toBe(statsBefore + 1);
    expect(studio.workspace.state().asset).toMatchObject({ name: "a.png", bytes: 99, mtimeMs: 2 });

    // Uploading a different name must not re-stat the selected asset.
    picked = { handle: "h2", name: "other.png", size: 3, mime: "image/png" };
    const statsAfter = fake.calls.filter((c) => c.name === "stat").length;
    await studio.assets.pick();
    await flush();
    expect(fake.calls.filter((c) => c.name === "stat").length).toBe(statsAfter);
    expect(studio.workspace.state().asset?.name).toBe("a.png");
  });

  test("an unsaved project-settings draft blocks switching projects until it is resolved", async () => {
    const fake = createFakeClient();
    const { studio } = studioWith(fake);
    await studio.projects.open("alpha");
    await flush();
    expect(studio.projectSettings.state().project).toBe("alpha");
    studio.projectSettings.setField("version", "3.0.0");
    const switching = studio.projects.open("beta");
    await flush();
    expect(studio.dialogs.active()?.title).toContain("项目设置尚未保存");
    studio.dialogs.cancel();
    expect(await switching).toBe(false);
    expect(studio.projects.current()).toBe("alpha");
  });

  test("quick-open focuses the editor of the opened file; closing the document prunes its remembered caret line", async () => {
    const { studio, fake } = studioWith();
    fake.files.set("a.ts", "a\n");
    fake.files.set("b.ts", "b\n");
    await studio.projects.open("alpha");
    await flush();
    studio.quickOpen.show();
    studio.quickOpen.setQuery("a.ts");
    expect(await studio.quickOpen.accept()).toBe(true);
    expect(studio.page()).toBe("source");
    const doc = studio.workspace.docOf("a.ts")!;
    expect(doc.focus).toBeGreaterThan(0);
    studio.workspace.focusDone("a.ts", doc.focus!);
    expect(studio.workspace.docOf("a.ts")!.focus).toBeUndefined();
    // already open: a second quick-open asks again
    await studio.workspace.open("b.ts");
    studio.quickOpen.show();
    studio.quickOpen.setQuery("a.ts");
    await studio.quickOpen.accept();
    expect(studio.workspace.docOf("a.ts")!.focus).toBeGreaterThan(doc.focus!);

    studio.workspace.setCaretLine("a.ts", 7);
    studio.workspace.setCaretLine("b.ts", 3);
    studio.workspace.setCaretLine("ghost.ts", 1);
    expect(studio.workspace.caretLinePaths().sort()).toEqual(["a.ts", "b.ts"]);
    await studio.workspace.close("a.ts");
    expect(studio.workspace.caretLine("a.ts")).toBeUndefined();
    expect(studio.workspace.caretLinePaths()).toEqual(["b.ts"]);
    await studio.workspace.load("alpha");
    expect(studio.workspace.caretLinePaths()).toEqual([]);
  });
});
