import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { ProbeSession, textOf, type Frame } from "./probe_session.ts";
import { boot, has, openAlpha, openFile, tapText, typeInEditor } from "./helpers.ts";
import { FakePublish } from "./fake_publish.ts";

// Guest-level parity tests on the real native probe (`pocket_probe` + built QuickJS bytecode):
// covers Projects (openLocal, create with version / ecosystemModules / pickParentDirectory),
// Settings (ecosystem extensions, read-only build + appId dirty-tab guard + clean-tab reload, SDK upgrade deferral),
// and Versions & Publish (Tencent Cloud COS configuration, credential management, check, slot upload, and auto sync on publish).

const wheel = async (session: ProbeSession, deltaY: number, x = 450, y = 300) => {
  session.sendEvent("input.scroll", { x, y, deltaY, source: "wheel", phase: "update" });
  await session.settle(4);
};

async function openSettings(session: ProbeSession, section: "项目设置" | "诊断与 SDK 升级" = "项目设置"): Promise<Frame> {
  let frame = await session.frame();
  await tapText(session, frame, "设置", 0);
  frame = await session.until((f) => has(f, "诊断与 SDK 升级"), "settings sections", 100);
  await tapText(session, frame, section);
  if (section !== "项目设置") return session.until((f) => has(f, "诊断记录"), "the service section", 100);
  return session.until((f) => has(f, "项目设置 · alpha-app") && has(f, "pocket.alpha"), "the project settings form", 200);
}

test("projects: 打开本地项目 calls studio.project.openLocal, handles cancel cleanly, and opens the selected local project", async () => {
  const { fake, session } = await boot((f) => {
    f.openLocalOutcome = "cancel";
  });
  try {
    let frame = await session.until((f) => has(f, "Alpha 应用") && has(f, "打开本地项目"), "projects page");
    await tapText(session, frame, "打开本地项目");
    await session.until(() => fake.calls("studio.project.openLocal").length === 1, "first openLocal request", 100);
    frame = await session.settle(8);
    assert.ok(has(frame, "打开本地项目") && has(frame, "Alpha 应用"), "cancel stays on the projects page");
    assert.equal(fake.calls("studio.fs.tree").length, 0, "cancel does not open any project");

    // Next attempt returns a picked local project directory
    fake.openLocalOutcome = {
      id: "local-picked",
      appId: "pocket.local",
      name: "Local Picked",
      title: "本地导入项目",
      version: "0.2.0",
      build: 1,
      tickHz: 60,
      template: "app",
      directory: "<picked-parent>/local-picked",
      ecosystemModules: [],
      enabledProfiles: [],
    };
    await tapText(session, frame, "打开本地项目");
    frame = await session.until(
      (f) => has(f, "源码 · local-picked") && has(f, "已打开本地项目 local-picked"),
      "local project opened on source page",
      200,
    );
    assert.equal(fake.calls("studio.project.openLocal").length, 2);
    assert.deepEqual(fake.calls("studio.fs.tree").map((r) => r.params.project), ["local-picked"]);

    // Going back to Projects page lists the newly opened local project with its directory
    await tapText(session, frame, "项目", 0);
    frame = await session.until((f) => has(f, "本地导入项目") && has(f, "<picked-parent>/local-picked"), "local project in project list", 100);
  } finally {
    session.kill();
  }
}, 120_000);

test("projects: + 新建项目 dialog shows version and ecosystem chips without tickHz, keeps dialog open on picker cancel, and creates & opens project", async () => {
  const { fake, session } = await boot((f) => {
    f.createPickCancel = true;
  });
  try {
    let frame = await session.until((f) => has(f, "+ 新建项目"), "projects page");
    await tapText(session, frame, "+ 新建项目");
    frame = await session.until(
      (f) => has(f, "新建 SDK 项目") && has(f, "初始版本") && has(f, "选择目录并创建…") && has(f, "创建并打开"),
      "create project dialog",
      150,
    );
    assert.ok(!has(frame, "帧率"), "create dialog does not show tickHz");
    assert.ok(!has(frame, "构建号"), "create dialog does not show build");
    assert.ok(has(frame, "按需生态扩展（已选 0 项）"), textOf(frame));

    // Toggle an ecosystem module chip and edit version
    const chipLabel = "iOS / macOS 小组件 (WidgetKit)";
    await tapText(session, frame, chipLabel);
    frame = await session.until((f) => has(f, "按需生态扩展（已选 1 项）") && has(f, `✓ ${chipLabel}`), "module chip selected", 100);

    await tapText(session, frame, "0.1.0");
    frame = await session.typeIntoOpenField("0.3.0");
    await session.settle(3);

    // 1) Cancelled parent directory picker keeps the dialog open
    frame = await session.frame();
    await tapText(session, frame, "选择目录并创建…");
    await session.until(() => fake.calls("studio.project.create").length === 1, "cancelled create call", 100);
    frame = await session.settle(8);
    assert.ok(has(frame, "新建 SDK 项目") && has(frame, "按需生态扩展（已选 1 项）"), "dialog stays open after cancel");
    assert.equal(fake.calls("studio.fs.tree").length, 0);

    // 2) Successful parent directory picker creates the project with version + ecosystemModules (and no tickHz/build)
    fake.createPickCancel = false;
    await tapText(session, frame, "选择目录并创建…");
    frame = await session.until(
      (f) => has(f, "源码 · my-pocket-app") && has(f, "已创建项目 my-pocket-app"),
      "created project opened",
      200,
    );
    const lastCreate = fake.calls("studio.project.create").at(-1)!.params;
    assert.deepEqual(lastCreate, {
      id: "my-pocket-app",
      template: "app",
      pickParentDirectory: true,
      ecosystemModules: ["apple-widget"],
      settings: {
        name: "我的 Pocket 应用",
        appId: "pocket.app",
        version: "0.3.0",
      },
    });
    assert.equal("tickHz" in (lastCreate.settings ?? {}), false);
    assert.equal("build" in (lastCreate.settings ?? {}), false);
  } finally {
    session.kill();
  }
}, 150_000);

test("settings: 生态设备与微件扩展（按需创建） toggles modules / 全选 Apple / 按需生成扩展, calls studio.ecosystem.set, and refreshes workspace tree", async () => {
  const { fake, session } = await boot();
  try {
    await openAlpha(session);
    const treesBefore = fake.calls("studio.fs.tree").length;
    await openSettings(session, "项目设置");
    await wheel(session, 420);
    let frame = await session.until(
      (f) => has(f, "生态设备与微件扩展（按需创建）") && has(f, "全选 Apple") && has(f, "按需生成扩展"),
      "ecosystem panel",
      200,
    );
    assert.ok(has(frame, "0 项（当前勾选 0 项）"));
    assert.ok(has(frame, "未启用任何系统微件/扩展 Profile"));

    // Select all Apple modules, then clear, then toggle one module and apply
    await tapText(session, frame, "全选 Apple");
    frame = await session.until((f) => !has(f, "0 项（当前勾选 0 项）"), "apple modules selected", 100);
    await tapText(session, frame, "清空");
    frame = await session.until((f) => has(f, "0 项（当前勾选 0 项）"), "selection cleared", 100);

    await tapText(session, frame, /iOS \/ macOS 小组件/);
    frame = await session.until((f) => has(f, "0 项（当前勾选 1 项）"), "single module toggled", 100);

    await tapText(session, frame, "按需生成扩展");
    frame = await session.until(
      (f) => has(f, "1 项（当前勾选 1 项）") && has(f, "ios-widget-extension"),
      "ecosystem applied",
      200,
    );
    assert.deepEqual(fake.calls("studio.ecosystem.set").map((r) => r.params), [
      { project: "alpha-app", modules: ["apple-widget"] },
    ]);
    assert.ok(fake.calls("studio.fs.tree").length > treesBefore, "workspace tree refreshed after ecosystem.set");
    assert.ok(fake.files.has("ecosystem/apple_widget.tsx"), "generated skeleton file exists in fake studio");
  } finally {
    session.kill();
  }
}, 150_000);

test("settings: shows read-only 当前 Build 号; refuses appId rename locally when a tab is dirty; allows rename when saved and reconciles open clean tab", async () => {
  const { fake, session } = await boot((f) => {
    f.files.set("app.tsx", 'export const MARKER_APP_TSX = 1;\nexport const APP_ID = "pocket.alpha";\n');
  });
  try {
    await openAlpha(session);
    // Open app.tsx and make it dirty
    let frame = await openFile(session, "app.tsx", "MARKER_APP_TSX");
    assert.ok(has(frame, "pocket.alpha"));
    frame = await typeInEditor(
      session,
      frame,
      /MARKER_APP_TSX/,
      'export const MARKER_APP_TSX = 1;\nexport const APP_ID = "pocket.alpha"; // dirty\n',
    );
    frame = await session.until((f) => has(f, "app.tsx ●"), "tab is dirty");

    // Go to Project Settings and attempt to rename appId while app.tsx is dirty
    frame = await openSettings(session, "项目设置");
    assert.ok(has(frame, "当前 Build 号") && has(frame, "1"), "shows read-only 当前 Build 号");
    await tapText(session, frame, "pocket.alpha");
    frame = await session.typeIntoOpenField("pocket.alpha.renamed");
    frame = await session.until((f) => has(f, "提示：修改应用包名 (appId) 会同步重写源码中的包引用"), "appId rename hint", 100);
    await wheel(session, 400);
    frame = await session.frame();
    await tapText(session, frame, "保存项目设置");
    frame = await session.until(
      (f) => has(f, "修改应用包名 (appId) 前请先保存所有未保存的文件标签页"),
      "dirty-tab refusal message",
      150,
    );
    assert.equal(fake.calls("studio.project.settings.set").length, 0, "studio.project.settings.set must NOT be called when a tab is dirty");

    // Go back to Source page and save the dirty tab
    await tapText(session, frame, "源码", 0);
    frame = await session.until((f) => has(f, "app.tsx ●"), "back on source page");
    await tapText(session, frame, /^保存/);
    frame = await session.until((f) => has(f, "已保存 app.tsx") && !has(f, "app.tsx ●"), "tab saved and clean", 150);

    // Return to Settings (the unsaved draft with pocket.alpha.renamed was preserved) and save
    frame = await openSettings(session, "项目设置");
    await wheel(session, 400);
    frame = await session.frame();
    await tapText(session, frame, "保存项目设置");
    frame = await session.until((f) => has(f, "项目设置已保存") && has(f, "项目设置已是最新"), "appId rename saved", 200);
    assert.equal(fake.calls("studio.project.settings.set").length, 1);
    assert.deepEqual(fake.calls("studio.project.settings.set")[0]!.params, {
      project: "alpha-app",
      settings: { appId: "pocket.alpha.renamed" },
    });

    // Switch back to Source page: the open clean tab was reconciled with the rewritten appId on disk
    await tapText(session, frame, "源码", 0);
    frame = await session.until((f) => has(f, "pocket.alpha.renamed") && !has(f, "app.tsx ●"), "open clean tab reconciled with new appId", 200);
  } finally {
    session.kill();
  }
}, 180_000);

test("settings: SDK upgrade shows modeReason and handles HTTP 200 and HTTP 409 apply deferrals gracefully", async () => {
  const { fake, session } = await boot((f) => {
    f.sdk.mode = "standalone";
    f.sdk.modeReason = "独立安装模式（支持后台下载与热重启升级）";
    f.sdk.applyDefer200 = true;
    f.sdk.deferredReason = "正在执行构建任务，已暂缓应用升级";
  });
  try {
    await openAlpha(session);
    await openSettings(session, "诊断与 SDK 升级");
    await wheel(session, 4000);
    let frame = await session.until(
      (f) => has(f, "SDK 升级（编辑服务）") && has(f, "独立安装模式（支持后台下载与热重启升级）"),
      "SDK upgrade panel with modeReason",
      200,
    );
    await tapText(session, frame, "检查 SDK 更新");
    frame = await session.until((f) => has(f, "应用 SDK 升级"), "release found", 200);

    // 1) HTTP 200 deferral ({ status: "available", deferredReason })
    await tapText(session, frame, "应用 SDK 升级");
    frame = await session.until((f) => has(f, "升级 SDK 到 v0.2.0？"), "confirm dialog", 150);
    await tapText(session, frame, "应用升级");
    frame = await session.until(
      (f) => has(f, "自动升级已暂缓") && has(f, "服务已暂缓升级：正在执行构建任务，已暂缓应用升级"),
      "HTTP 200 deferral shown",
      200,
    );
    assert.equal(fake.calls("studio.service.upgrade.apply").length, 1);

    // 2) HTTP 409 conflict deferral when service is busy
    fake.sdk.applyDefer200 = false;
    fake.sdk.deferredReason = null;
    fake.sdk.applyBusy = true;
    await wheel(session, 4000);
    frame = await session.settle(8);
    await tapText(session, frame, "应用 SDK 升级");
    frame = await session.until((f) => has(f, "升级 SDK 到 v0.2.0？"), "confirm dialog 2", 150);
    await tapText(session, frame, "应用升级");
    frame = await session.until(
      (f) => has(f, "服务未执行升级") && has(f, "已暂缓应用更新"),
      "HTTP 409 deferral shown",
      200,
    );
    assert.equal(fake.calls("studio.service.upgrade.apply").length, 2);
  } finally {
    session.kill();
  }
}, 150_000);

async function bootPublish(setup?: (fake: FakePublish) => void): Promise<{ fake: FakePublish; session: ProbeSession }> {
  const fake = new FakePublish();
  fake.storage.set("studio.settings.v1", { editor: "input" });
  setup?.(fake);
  const session = new ProbeSession(fake.handle);
  fake.attach(session);
  await session.boot();
  return { fake, session };
}

test("versions: renders 腾讯云 COS 云端素材与热更发布, configures/saves COS, verifies connection, saves & clears workspace credentials, and uploads test/release slots", async () => {
  const { fake, session } = await bootPublish((f) => {
    f.builtRevision = f.revision;
  });
  try {
    await openAlpha(session);
    let frame = await session.frame();
    await tapText(session, frame, "版本", 0);
    frame = await session.until((f) => has(f, "版本 · alpha-app"), "versions page", 150);
    await wheel(session, 300, 300, 300);
    frame = await session.until(
      (f) => has(f, "腾讯云 COS 云端素材与热更发布") && has(f, "已从 coscli (~/.cos.yaml) 加载"),
      "COS panel visible",
      200,
    );

    // Pick discovered staging bucket and enable COS + syncOnPublish
    await tapText(session, frame, "staging · pocket-test-1250000001 (ap-shanghai)");
    frame = await session.settle(4);
    await tapText(session, frame, "启用 COS");
    frame = await session.settle(4);
    await tapText(session, frame, "发布后自动同步 COS");
    frame = await session.settle(4);

    // Scroll down to credential inputs and action buttons
    await wheel(session, 600, 300, 300);
    frame = await session.until(
      (f) => has(f, "保存配置") && has(f, "验证连接") && has(f, "上传测试版到 COS") && has(f, "上传稳定版到 COS"),
      "COS buttons visible",
      200,
    );

    // Save COS config
    await tapText(session, frame, "保存配置");
    frame = await session.until((f) => has(f, "腾讯云 COS 配置已保存"), "COS config saved toast", 150);
    assert.equal(fake.calls("studio.cos.set").length, 1);
    assert.deepEqual(fake.calls("studio.cos.set")[0]!.params, {
      project: "alpha-app",
      enabled: true,
      syncOnPublish: true,
      bucket: "pocket-test-1250000001",
      region: "ap-shanghai",
      keyPrefix: "pocket-ota",
      publicBaseUrl: "",
    });

    // Enter workspace credentials and save them (inputs are immediately cleared after save)
    await tapText(session, frame, "AKID...");
    frame = await session.typeIntoOpenField("AKID9876543210");
    await session.settle(3);
    frame = await session.frame();
    await tapText(session, frame, "SecretKey（保存后立即清空输入框）");
    frame = await session.typeIntoOpenField("my-super-secret-key");
    frame = await session.settle(4);
    await tapText(session, frame, "保存工作区凭据");
    frame = await session.until((f) => has(f, "已保存工作区 COS 凭据"), "workspace credentials saved", 150);
    assert.equal(fake.calls("studio.cos.set").length, 2);
    assert.deepEqual(fake.calls("studio.cos.set")[1]!.params.credentials, {
      secretId: "AKID9876543210",
      secretKey: "my-super-secret-key",
    });
    assert.ok(!has(frame, "my-super-secret-key"), "secretKey is cleared from the UI immediately after save");

    // Clear workspace credentials
    await tapText(session, frame, "清除工作区凭据");
    frame = await session.until((f) => has(f, "已清除 Studio 保存的本机 COS 密钥"), "workspace credentials cleared", 150);
    assert.equal(fake.calls("studio.cos.set").length, 3);
    assert.equal(fake.calls("studio.cos.set")[2]!.params.credentials, null);

    // Verify connection (studio.cos.check)
    await tapText(session, frame, "验证连接");
    frame = await session.until(
      (f) => has(f, "连接验证通过：pocket-test-1250000001 (ap-shanghai)"),
      "cos check result shown",
      150,
    );
    assert.equal(fake.calls("studio.cos.check").length, 1);

    // Upload test slot to COS
    await tapText(session, frame, "上传测试版到 COS");
    await session.until(() => fake.calls("studio.cos.publish").length === 1, "COS test publish call", 150);
    await session.until((f) => has(f, "已上传测试版"), "COS test publish toast", 150);
    await wheel(session, 800, 300, 300);
    frame = await session.until(
      (f) => has(f, "COS 测试版") && has(f, "https://pocket-test-1250000001.cos.ap-shanghai.myqcloud.com/pocket-ota/test/pocket.alpha/host.json"),
      "COS test slot uploaded and URL shown",
      200,
    );
    assert.deepEqual(fake.calls("studio.cos.publish").map((r) => r.params), [{ project: "alpha-app", channel: "test" }]);

    // Upload release slot to COS (requires confirmation dialog)
    await tapText(session, frame, "上传稳定版到 COS");
    frame = await session.until((f) => has(f, "上传稳定版到腾讯云 COS？"), "release COS confirm dialog", 150);
    await tapText(session, frame, "上传稳定版到 COS", -1);
    await session.until(() => fake.calls("studio.cos.publish").length === 2, "COS release publish call", 150);
    await session.until((f) => has(f, "已上传稳定版"), "COS release publish toast", 150);
    await wheel(session, 800, 300, 300); await wheel(session, 800, 300, 300);
    frame = await session.until(
      (f) => has(f, "COS 稳定版") && has(f, "https://pocket-test-1250000001.cos.ap-shanghai.myqcloud.com/pocket-ota/stable/pocket.alpha/host.json"),
      "COS stable slot uploaded and URL shown",
      200,
    );
    assert.equal(fake.calls("studio.cos.publish").length, 2);
    assert.deepEqual(fake.calls("studio.cos.publish")[1]!.params, { project: "alpha-app", channel: "release" });
  } finally {
    session.kill();
  }
}, 180_000);

test("publish: renders cosPublish (with COS appConfigUrl) or non-fatal cosError banner when returned by studio.publish.publish", async () => {
  const { fake, session } = await bootPublish((f) => {
    f.builtRevision = f.revision;
    const snap = f.cosSnapshot("alpha-app");
    snap.config.enabled = true;
    snap.config.syncOnPublish = true;
    snap.config.bucket = "pocket-ota-1250000001";
    snap.config.region = "ap-guangzhou";
    snap.config.keyPrefix = "pocket-ota";
  });
  try {
    await openAlpha(session);
    let frame = await session.frame();
    await tapText(session, frame, "发布", 0);
    frame = await session.until((f) => has(f, "已构建（可发布）"), "publish plan ready", 150);

    // 1) Publish with auto COS sync -> renders cosPublish panel with COS App 接入地址
    await tapText(session, frame, "发布测试包");
    frame = await session.until((f) => has(f, "发布完成 · 测试"), "publish done", 200);
    await wheel(session, 600, 650, 300);
    frame = await session.until(
      (f) =>
        has(f, "腾讯云 COS 云端同步结果") &&
        has(f, "https://pocket-ota-1250000001.cos.ap-guangzhou.myqcloud.com/pocket-ota/test/pocket.alpha/host.json"),
      "cosPublish panel with COS appConfigUrl",
      200,
    );
    assert.ok(has(frame, "上传 5 个文件 / 复用 1 个文件"));

    // 2) Publish when COS sync returns a non-fatal cosError -> renders warning banner while local publish succeeds
    fake.publishCosError = "COS 签名校验失败 (SignatureDoesNotMatch)";
    await tapText(session, frame, "发布测试包");
    await session.until(() => fake.calls("studio.publish.publish").length === 2, "second publish call", 200);
    await wheel(session, -600, 650, 300);
    frame = await session.until((f) => has(f, "发布完成 · 测试"), "local publish succeeded", 200);
    await wheel(session, 600, 650, 300);
    frame = await session.until(
      (f) => has(f, "腾讯云 COS 自动同步未完成（本地发布已成功）") && has(f, "COS 签名校验失败 (SignatureDoesNotMatch)"),
      "non-fatal cosError banner rendered",
      200,
    );
  } finally {
    session.kill();
  }
}, 150_000);
