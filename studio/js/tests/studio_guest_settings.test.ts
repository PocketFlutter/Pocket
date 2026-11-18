import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { textOf, textOps } from "./probe_session.ts";
import type { ProbeSession } from "./probe_session.ts";
import { boot, has, openAlpha, openFile, press, tapText } from "./helpers.ts";

const META = 8;

// M8 on the real native probe (input driven): the project settings form, the diagnostics export, the SDK upgrade panel
// and the quick-open refocus, against the stateful fake studio.* provider.

const wheel = async (session: ProbeSession, deltaY: number) => {
  session.sendEvent("input.scroll", { x: 450, y: 300, deltaY, source: "wheel", phase: "update" });
  await session.settle(4);
};

async function openSettings(session: ProbeSession, section: "项目设置" | "诊断与 SDK 升级" = "项目设置") {
  let frame = await session.frame();
  await tapText(session, frame, "设置", 0);
  frame = await session.until((f) => has(f, "诊断与 SDK 升级"), "settings sections", 100);
  await tapText(session, frame, section);
  if (section !== "项目设置") return session.until((f) => has(f, "诊断记录"), "the service section", 100);
  return session.until((f) => has(f, "项目设置 · alpha-app") && has(f, "pocket.alpha"), "the project settings form with the service values", 200);
}

test("project settings: the form shows the service values; a service validation error is inline, then a valid edit is saved and reflected", async () => {
  const { fake, session } = await boot();
  try {
    await openAlpha(session);
    let frame = await openSettings(session);
    for (const text of ["当前 Build 号", "显示名称", "应用 ID", "版本", "帧率（1–120）", "pocket.alpha", "0.1.0", "60", "窗口标题"]) assert.ok(has(frame, text), `${text} in\n${textOf(frame)}`);
    assert.ok(!has(frame, "构建号\n"), "build is displayed as read-only 当前 Build 号, not an editable 构建号 input");
    assert.equal(fake.calls("studio.project.settings.get").length >= 1, true);
    assert.equal(fake.calls("studio.project.settings.set").length, 0);

    // An invalid appId: the SERVICE refuses it and its text appears under the field; nothing is saved.
    await tapText(session, frame, "pocket.alpha");
    frame = await session.typeIntoOpenField("bad id!");
    frame = await session.until((f) => has(f, "有未保存的项目设置"), "dirty marker", 100);
    await wheel(session, 400);
    frame = await session.frame();
    await tapText(session, frame, "保存项目设置");
    await session.until(() => fake.calls("studio.project.settings.set").length === 1, "the save request", 200);
    await wheel(session, -400);
    frame = await session.until((f) => has(f, "appId contains unsafe characters"), "inline service error", 200);
    assert.deepEqual(fake.calls("studio.project.settings.set").map((r) => r.params), [{ project: "alpha-app", settings: { appId: "bad id!" } }]);
    assert.equal("build" in (fake.calls("studio.project.settings.set")[0]!.params.settings ?? {}), false, "build is never sent in settings.set");
    assert.equal(fake.config.appId, "pocket.alpha", "a refused save changes nothing");
    assert.ok(has(frame, "有未保存的项目设置"), "the draft is kept");

    // Fix it (and rename): saved values and the derived title are reflected.
    frame = await session.frame();
    await tapText(session, frame, "bad id!");
    await session.typeIntoOpenField("pocket.alpha2");
    frame = await session.settle(3);
    await tapText(session, frame, "Alpha", 0);
    await session.typeIntoOpenField("Alpha 改名");
    await session.settle(3);
    await wheel(session, 400);
    frame = await session.frame();
    await tapText(session, frame, "保存项目设置");
    frame = await session.until((f) => has(f, "项目设置已保存") && has(f, "项目设置已是最新"), "saved", 200);
    assert.deepEqual(fake.calls("studio.project.settings.set").at(-1)!.params, { project: "alpha-app", settings: { name: "Alpha 改名", appId: "pocket.alpha2" } });
    assert.equal("build" in (fake.calls("studio.project.settings.set").at(-1)!.params.settings ?? {}), false, "build is never sent in settings.set");
    assert.equal(fake.config.appId, "pocket.alpha2");
    assert.equal(fake.config.title, "Alpha 改名");
    assert.ok(!has(frame, "appId contains unsafe"), "the error is gone after a good save");
    await wheel(session, -400);
    frame = await session.until((f) => has(f, "pocket.alpha2") && has(f, "Alpha 改名"), "saved values reflected in the form and title line", 100);
  } finally { session.kill(); }
}, 150_000);

test("project settings: an unsaved draft is asked about when switching projects (cancel keeps it, discard drops it)", async () => {
  const { fake, session } = await boot();
  try {
    await openAlpha(session);
    let frame = await openSettings(session);
    await tapText(session, frame, "0.1.0");
    await session.typeIntoOpenField("0.2.0");
    frame = await session.until((f) => has(f, "有未保存的项目设置"), "dirty", 100);
    frame = await session.frame();
    await tapText(session, frame, "项目", 0);
    frame = await session.until((f) => has(f, "Beta 游戏"), "project list");
    await tapText(session, frame, "Beta 游戏");
    frame = await session.until((f) => has(f, "项目设置尚未保存"), "leave dialog", 200);
    assert.ok(has(frame, "版本"), "the dialog names the changed field");
    await tapText(session, frame, "取消");
    frame = await session.settle(8);
    assert.equal(fake.calls("studio.fs.tree").length, 1, "the other project was not opened");
    assert.equal(fake.calls("studio.project.settings.set").length, 0);

    await tapText(session, frame, "Beta 游戏");
    frame = await session.until((f) => has(f, "项目设置尚未保存"), "leave dialog again", 200);
    await tapText(session, frame, "不保存，继续");
    await session.until(() => fake.calls("studio.fs.tree").length === 2, "beta opened after discarding", 200);
    assert.equal(fake.calls("studio.project.settings.set").length, 0, "discard never writes");
  } finally { session.kill(); }
}, 120_000);

test("diagnostics: the Console button exports the bundle and shows counts, a copyable id and the download URL", async () => {
  const { fake, session } = await boot();
  try {
    await openAlpha(session);
    let frame = await session.frame();
    await tapText(session, frame, "控制台", 0);
    frame = await session.until((f) => has(f, "导出诊断"), "console page", 100);
    await tapText(session, frame, "导出诊断");
    frame = await session.until((f) => has(f, "共 2 条（日志 1 · 崩溃 1）"), "export summary", 200);
    assert.deepEqual(fake.calls("studio.logs.diagnostics").map((r) => r.params), [{ project: "alpha-app" }]);
    assert.ok(has(frame, "diag-alpha-app-20261116102030123"), textOf(frame));
    assert.ok(has(frame, "http://127.0.0.1:8791/api/projects/alpha-app/diagnostics?download=1"));
    assert.ok(has(frame, "Preview crashed"));
    // Copy the export id (the first 复制 button of the result) and the bundle.
    const copies = textOps(frame, "复制");
    assert.ok(copies.length >= 2, "id and URL are copyable");
    await tapText(session, frame, "复制", 0);
    await session.until(() => fake.clipboard.length === 1, "clipboard write", 100);
    assert.equal(fake.clipboard[0], "diag-alpha-app-20261116102030123");
    frame = await session.frame();
    await tapText(session, frame, "复制诊断内容（JSON）");
    await session.until(() => fake.clipboard.length === 2, "bundle copy", 100);
    assert.equal(JSON.parse(fake.clipboard[1]!).crashCount, 1);

    // crash-only export from the same panel
    frame = await session.frame();
    await tapText(session, frame, "仅崩溃");
    await session.until(() => fake.calls("studio.logs.diagnostics").length === 2, "crash export", 100);
    assert.deepEqual(fake.calls("studio.logs.diagnostics")[1]!.params, { project: "alpha-app", kind: "crash" });
    frame = await session.until((f) => has(f, "共 1 条（日志 0 · 崩溃 1）"), "crash-only summary", 100);
    assert.ok(has(frame, "仅崩溃记录"));
  } finally { session.kill(); }
}, 120_000);

test("diagnostics: a failing export is reported as a failure from the Settings panel", async () => {
  const { fake, session } = await boot((f) => { f.failDiagnostics = { ok: false, error: { code: "too_large", message: "service response exceeds 16777216 bytes" } }; });
  try {
    await openAlpha(session);
    let frame = await openSettings(session, "诊断与 SDK 升级");
    await tapText(session, frame, "导出诊断记录");
    frame = await session.until((f) => has(f, "导出失败：too_large"), "failure shown", 200);
    assert.ok(!has(frame, "共 "), "no summary is invented");
    assert.equal(fake.calls("studio.logs.diagnostics").length, 1);
  } finally { session.kill(); }
}, 120_000);

async function toUpgradePanel(session: ProbeSession) {
  await openAlpha(session);
  await openSettings(session, "诊断与 SDK 升级");
  await wheel(session, 4000);
  return session.until((f) => has(f, "SDK 升级（编辑服务）") && has(f, "检查 SDK 更新"), "the SDK upgrade panel", 200);
}

test("sdk upgrade (source checkout): shows version and mode, a check finds a release, apply asks for confirmation and the 409 is shown honestly", async () => {
  const { fake, session } = await boot();
  try {
    let frame = await toUpgradePanel(session);
    assert.ok(has(frame, "v0.1.12"));
    assert.ok(has(frame, "源码检出（只检查，不覆盖 Git 工作区）"), textOf(frame));
    assert.ok(has(frame, "模式说明") && has(frame, "Git 源码检出目录，仅检查新版本"), textOf(frame));
    assert.ok(!has(frame, "应用 SDK 升级"), "no apply before a check found a release");
    assert.equal(fake.calls("studio.service.upgrade.check").length, 0, "opening the page never checks the network");

    await tapText(session, frame, "检查 SDK 更新");
    frame = await session.until((f) => has(f, "发现新版本 v0.2.0") && has(f, "应用 SDK 升级"), "release found", 200);
    assert.equal(fake.calls("studio.service.upgrade.apply").length, 0);
    assert.ok(has(frame, "不会自动覆盖"));

    await tapText(session, frame, "应用 SDK 升级");
    frame = await session.until((f) => has(f, "升级 SDK 到 v0.2.0？"), "confirmation", 200);
    assert.equal(fake.calls("studio.service.upgrade.apply").length, 0, "nothing is sent before the confirmation");
    await tapText(session, frame, "取消");
    await session.settle(6);
    assert.equal(fake.calls("studio.service.upgrade.apply").length, 0);

    frame = await session.frame();
    await tapText(session, frame, "应用 SDK 升级");
    frame = await session.until((f) => has(f, "升级 SDK 到 v0.2.0？"), "confirmation again", 200);
    await tapText(session, frame, "应用升级");
    frame = await session.until((f) => has(f, "服务未执行升级") && has(f, "禁止自动覆盖 Git 工作区") && has(f, "自动升级已暂缓"), "the service's 409 text and deferral banner", 200);
    assert.equal(fake.calls("studio.service.upgrade.apply").length, 1);
    assert.ok(has(frame, "v0.1.12"), "still on the old version");
  } finally { session.kill(); }
}, 150_000);

test("sdk upgrade (standalone): confirm, apply, wait through the service restart, then show the new version", async () => {
  const { fake, session } = await boot((f) => { f.sdk.mode = "standalone"; });
  try {
    let frame = await toUpgradePanel(session);
    assert.ok(has(frame, "独立安装（可升级）"));
    assert.ok(has(frame, "独立安装目录，支持自动下载校验并热重启升级"));
    await tapText(session, frame, "检查 SDK 更新");
    frame = await session.until((f) => has(f, "应用 SDK 升级"), "release found", 200);
    await tapText(session, frame, "应用 SDK 升级");
    frame = await session.until((f) => has(f, "升级 SDK 到 v0.2.0？"), "confirmation", 200);
    assert.ok(has(frame, "重启"));
    await tapText(session, frame, "应用升级");
    await session.until((f) => has(f, "服务正在升级") || has(f, "SDK 已升级到 v0.2.0"), "restart notice", 200);
    assert.equal(fake.calls("studio.service.upgrade.apply").length, 1);
    frame = await session.until((f) => has(f, "SDK 已升级到 v0.2.0，服务已重新连接。"), "new version reported after the restart", 400);
    assert.ok(fake.calls("studio.service.health").length >= 3, "health was polled through the unreachable window");
    assert.ok(has(frame, "v0.2.0"));
  } finally { session.kill(); }
}, 150_000);

test("sdk upgrade: a failing release check is shown as an error", async () => {
  const { session } = await boot((f) => { f.sdk.failCheck = { ok: false, error: { code: "service_error", message: "检查 GitHub Release 失败（HTTP 403） (HTTP 500)" } }; });
  try {
    let frame = await toUpgradePanel(session);
    await tapText(session, frame, "检查 SDK 更新");
    frame = await session.until((f) => has(f, "检查 SDK 更新失败：service_error"), "failure shown", 200);
    assert.ok(!has(frame, "应用 SDK 升级"));
  } finally { session.kill(); }
}, 120_000);

test("quick-open: choosing a file opens it and the code editor takes the keyboard (raw text session) without another tap", async () => {
  const { session } = await boot(undefined, "code");
  try {
    await openAlpha(session);
    await press(session, "p", META);
    await session.until((f) => has(f, "快速打开") && has(f, "beta.ts"), "overlay with the project files");
    await session.settle(15);
    await session.typeIntoOpenField("beta");
    await session.until((f) => has(f, "beta.ts") && !has(f, "alpha.ts"), "filtered to beta.ts");
    const before = session.guestEvents.filter((e) => e.name === "textInput.rawOpen").length;
    await press(session, "Enter");
    await session.until((f) => has(f, "src/deep/beta.ts · ") && has(f, "MARKER_BETA") && !has(f, "快速打开"), "beta.ts opened in the code view");
    await session.until(() => { return session.guestEvents.filter((e) => e.name === "textInput.rawOpen").length > before; }, "the editor opened a raw key session by itself", 300);
    const open = [...session.guestEvents].reverse().find((e) => e.name === "textInput.rawOpen")!;
    session.sendEvent("textInput.rawOpened", { id: String(open.payload.id) });
    await session.settle(3);
    // Typing now lands in the file: commit text through the raw session; the tab turns dirty without any tap on the editor.
    session.sendEvent("input.text", [{ kind: "commit", text: "ZZ" }] as unknown as Record<string, unknown>);
    const frame = await session.until((f) => has(f, "未保存"), "typing continued in the opened file", 100);
    assert.ok(has(frame, "ZZ"), textOf(frame));
  } finally { session.kill(); }
}, 120_000);

test("quick-open on an already open file also hands the keyboard to its editor", async () => {
  const { session } = await boot(undefined, "code");
  try {
    await openAlpha(session);
    let frame = await openFile(session, "app.tsx", "MARKER_APP_TSX");
    await press(session, "p", META);
    await session.until((f) => has(f, "快速打开") && has(f, "beta.ts"), "overlay");
    await session.settle(15);
    await session.typeIntoOpenField("app");
    await session.until((f) => has(f, "app.tsx"), "ranked app.tsx");
    const before = session.guestEvents.filter((e) => e.name === "textInput.rawOpen").length;
    await press(session, "Enter");
    await session.until(() => { return session.guestEvents.filter((e) => e.name === "textInput.rawOpen").length > before; }, "raw key session for the already open file", 300);
  } finally { session.kill(); }
}, 120_000);
