import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { ProbeSession, textOf, textOps } from "./probe_session.ts";
import { FakeStudio } from "./fake_studio.ts";
import { has, press, tapText } from "./helpers.ts";

const META = 8;

async function bootWide(setup?: (fake: FakeStudio) => void) {
  const fake = new FakeStudio();
  setup?.(fake);
  const session = new ProbeSession(fake.handle, { width: 1440, height: 900 });
  fake.attach(session);
  await session.boot();
  return { fake, session };
}

test("1440x900 5-zone desktop IDE workbench: top command bar, activity rail, docked source split, hardware bezel stage + 4-tab console dock, and 3-tab right inspector", async () => {
  const { fake, session } = await bootWide();
  try {
    // 1. Cold boot shows Top Command Bar + Activity Rail + Welcome Projects Card + Console Dock + Right Inspector
    let frame = await session.until((f) => has(f, "Alpha 应用") && has(f, "立即构建"), "1440x900 cold boot workbench");
    for (const label of [
      "选择项目",
      "打开本地项目",
      "+ 新建项目",
      "立即构建",
      "源码分栏",
      "终端面板",
      "检查器",
      "升级管理",
      "POCKET STUDIO",
      "构建日志",
      "部署输出",
      "产物清单",
      "签名发布",
      "包资源",
      "版本发布",
      "项目设置",
    ]) {
      assert.ok(has(frame, label), `missing "${label}" on cold boot:\n${textOf(frame)}`);
    }

    // Spatial coordinates check matching Web Preview 5-zone geometry:
    // Top Command Bar sits in y < 48; Activity Rail sits in x < 60; Right Inspector tabs sit in x > 1020.
    const buildBtn = textOps(frame, "立即构建")[0]!;
    assert.ok(buildBtn.y! < 46, `立即构建 should be in 46px top command bar, got y=${buildBtn.y}`);
    const railProjects = textOps(frame, "项目")[0]!;
    assert.ok(railProjects.x! < 58, `Activity rail should sit in left 56px rail, got x=${railProjects.x}`);
    const inspectorResTab = textOps(frame, "包资源")[0]!;
    assert.ok(inspectorResTab.x! > 1020, `Right inspector should sit on right edge, got x=${inspectorResTab.x}`);

    // 2. Opening a project activates all 5 zones simultaneously (Source Dock + Stage + Console Dock + Inspector)
    await tapText(session, frame, "Alpha 应用");
    frame = await session.until(
      (f) => has(f, "源码 · alpha-app") && has(f, "手机 · 390×844") && has(f, "资源 · alpha-app"),
      "all 5 zones mounted after opening Alpha 应用",
      200,
    );
    assert.ok(has(frame, "收起分栏") && has(frame, "目录 ▾"), "Zone C source split docked");
    assert.ok(has(frame, "设备边框") && has(frame, "9:41") && has(frame, "＋ 生态/微件"), "Zone D hardware bezel stage & HUD");

    // 3. Single CompositorSurface invariant: build & run preview -> exactly ONE surface op is mounted even with Source Dock open!
    await tapText(session, frame, "构建并刷新预览");
    frame = await session.until((f) => fake.calls("system.runtime.awaitFirstFrame").length === 1 && has(f, "运行中"), "live preview running in center stage", 300);
    const surfaceOps = (frame.ops ?? []).filter(
      (o) => o.type !== "text" && ((o as any).package === "dev.pocket.studio.preview" || o.type === "application" || o.type === "hostSurface"),
    );
    assert.equal(surfaceOps.length, 1, `expected exactly 1 CompositorSurface op, got ${surfaceOps.length}`);

    // 4. Toggle Source Split via Cmd+E (collapses Zone C without destroying Center PreviewSurface, then re-opens)
    await press(session, "e", META);
    frame = await session.until((f) => !has(f, "收起分栏"), "Cmd+E collapsed source dock");
    assert.ok(has(frame, "手机 · 390×844") && has(frame, "运行中"), "center preview stage stays running when source split is hidden");
    assert.equal(fake.calls("system.runtime.destroy").length, 0, "collapsing source split never destroys the live preview instance");
    await press(session, "e", META);
    frame = await session.until((f) => has(f, "收起分栏") && has(f, "源码 · alpha-app"), "Cmd+E re-opened source dock");

    // 5. Switch Console Dock 4 tabs & collapse/expand via Cmd+J
    await tapText(session, frame, "部署输出");
    frame = await session.until((f) => has(f, "部署到模拟器 / 设备"), "console dock switched to deploy tab");
    await tapText(session, frame, "产物清单");
    frame = await session.until((f) => has(f, "产物 · alpha-app"), "console dock switched to artifacts tab");
    await tapText(session, frame, "签名发布");
    frame = await session.until((f) => has(f, "发布此构建版本"), "console dock switched to signing tab");
    await press(session, "j", META);
    frame = await session.until((f) => has(f, "展开 ▴"), "Cmd+J collapsed console dock to 32px bar");
    await press(session, "j", META);
    frame = await session.until((f) => has(f, "折叠 ⌄"), "Cmd+J expanded console dock");

    // 6. Switch Right Inspector 3 tabs (`包资源` / `版本发布` / `项目设置`)
    await tapText(session, frame, "版本发布");
    frame = await session.until((f) => has(f, "签名与热更发布") && has(f, "版本槽与腾讯云 COS"), "inspector versions/publish tab");
    await tapText(session, frame, "版本槽与腾讯云 COS");
    frame = await session.until((f) => has(f, "本地版本后端"), "inspector versions sub-tab");
    await tapText(session, frame, "项目设置", 0);
    frame = await session.until((f) => has(f, "诊断与 SDK 升级"), "inspector settings tab");

    // 7. Project Switcher Popover from Top Command Bar pill -> Esc closes it
    await tapText(session, frame, "Alpha 应用", 0);
    frame = await session.until((f) => has(f, "项目列表") && has(f, "Beta 游戏"), "project switcher popover opened");
    await press(session, "Escape");
    frame = await session.until((f) => !has(f, "项目列表"), "Esc closed project switcher popover");
  } finally {
    session.kill();
  }
}, 180_000);

test("simultaneous multi-target preview stage: Flutter + Web + WeChat Mini Program + extensible System Widgets side-by-side", async () => {
  const { fake, session } = await bootWide();
  try {
    let frame = await session.until((f) => has(f, "Alpha 应用"), "cold boot");
    await tapText(session, frame, "Alpha 应用");
    frame = await session.until(
      (f) => has(f, "源码 · alpha-app") && has(f, "四端同屏") && has(f, "构建并刷新预览"),
      "project opened and 5-zone layout settled",
      200,
    );

    // 1. Activate 4-way simultaneous preview (`Flutter` + `Web` + `微信小程序` + `小组件`)
    await tapText(session, frame, "四端同屏");
    frame = await session.until(
      (f) =>
        has(f, "单端聚焦") &&
        has(f, "并行沙箱：4 端激活") &&
        has(f, "浏览器视口沙箱 · WASM / Canvas") &&
        has(f, "胶囊沙箱 · 375×667") &&
        has(f, "联动宿主 App ↗"),
      "4 simultaneous preview shells visible",
    );
    assert.ok(has(frame, "•••") && has(frame, "◎"), "WeChat authentic capsule chrome rendered");

    // 2. Build & run all 4 targets simultaneously -> publishes 4 slot appIds & mounts 4 CompositorSurface ops
    await tapText(session, frame, "构建并刷新预览");
    frame = await session.until(
      (f) => fake.calls("system.runtime.awaitFirstFrame").length === 4 && has(f, "运行中"),
      "all 4 child preview sandboxes running simultaneously",
      300,
    );

    const publishCalls = fake.calls("studio.preview.publish");
    assert.equal(publishCalls.length, 1);
    assert.deepEqual(publishCalls[0]!.params.previewAppIds, [
      "dev.pocket.studio.preview",
      "dev.pocket.studio.preview.web",
      "dev.pocket.studio.preview.wechat",
      "dev.pocket.studio.preview.widget",
    ]);

    const surfaceOps = (frame.ops ?? []).filter(
      (o) =>
        o.type !== "text" &&
        (typeof o.package === "string" ? o.package.startsWith("dev.pocket.studio.preview") : o.type === "application" || o.type === "hostSurface"),
    );
    assert.equal(surfaceOps.length, 4, `expected 4 simultaneous CompositorSurface ops, got ${surfaceOps.length}`);

    // Verify initialEvents carried `platform.surface` context for Web, WeChat, and Widget slots
    const creates = fake.calls("system.runtime.create");
    assert.equal(creates.length, 4);
    const widgetCreate = creates.find((c) => c.params.appId === "dev.pocket.studio.preview.widget");
    assert.ok(widgetCreate, "widget child runtime created");
    assert.equal(widgetCreate!.params.initialEvents?.[0]?.method, "platform.surface");
    assert.equal(widgetCreate!.params.initialEvents?.[0]?.params?.profileId, "ios-widget-medium");

    // 3. Live Widget spec switching (`灵动岛` -> `圆表磁贴`) + renderMode (`常亮 AOD`) posts `platform.surface` events
    await tapText(session, frame, "灵动岛", 0);
    frame = await session.until(
      () => fake.calls("system.runtime.post").some((c) => c.params.params?.profileId === "ios-live-activity-expanded"),
      "switched widget slot to iOS Dynamic Island Expanded",
    );
    await tapText(session, frame, "圆表磁贴");
    frame = await session.until(
      () => fake.calls("system.runtime.post").some((c) => c.params.params?.profileId === "wear-os-tile"),
      "switched widget slot to Wear OS round tile",
    );
    await tapText(session, frame, "常亮 AOD");
    frame = await session.until(
      () => fake.calls("system.runtime.post").some((c) => c.params.params?.renderMode === "alwaysOn"),
      "switched widget renderMode to alwaysOn AOD",
    );

    // 4. Standalone WeChat Mini Program preview server start -> copy URL -> stop
    await tapText(session, frame, "微信服务");
    frame = await session.until((f) => has(f, "微信服务已就绪") && has(f, "复制地址"), "WeChat preview service running");
    await tapText(session, frame, "复制地址");
    await session.until(() => fake.clipboard.some((u) => u.includes("wechat.pocket.local/mp/alpha-app")), "copied WeChat preview URL");
    await tapText(session, frame, "停止");
    frame = await session.until((f) => has(f, "wx.* · ≤2MiB"), "WeChat preview service stopped");

    // 5. Enable 5th simultaneous slot (`灵动岛/穿戴` secondary micro-surface) without rebuilding!
    await tapText(session, frame, "灵动岛/穿戴");
    frame = await session.until(
      (f) => has(f, "并行沙箱：5 端激活") && fake.calls("system.runtime.awaitFirstFrame").length === 5,
      "5th simultaneous micro-surface slot spun up immediately",
      200,
    );

    // 6. Collapse back to `单端聚焦` -> destroys the 4 extra child runtimes cleanly while keeping Flutter running
    await tapText(session, frame, "单端聚焦");
    frame = await session.until(
      (f) => has(f, "并行沙箱：1 端激活") && fake.instances.size === 1,
      "returned to single-target focus and destroyed extra child runtimes",
    );
    assert.equal(fake.instances.size, 1, "only primary Flutter preview instance remains active");
  } finally {
    session.kill();
  }
}, 180_000);
