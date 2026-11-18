import { describe, expect, test } from "bun:test";
import { createManualTimers } from "../src/state/env.ts";
import { createToasts } from "../src/state/toasts.ts";
import { createDialogs } from "../src/state/dialogs.ts";
import { createProjects } from "../src/state/projects.ts";
import { createEcosystemState, modulePlatform } from "../src/state/ecosystem.ts";
import { cosSourceLabel, createCosState } from "../src/state/cos.ts";
import { createProjectSettings } from "../src/state/project-settings.ts";
import { createSdkUpgrade } from "../src/state/sdk-upgrade.ts";
import { createStudio } from "../src/state/studio.ts";
import { isDirty } from "../src/state/workspace.ts";
import { createFakeClient, flush } from "./fake_client.ts";

function createTestStudio(fake = createFakeClient()) {
  const timers = createManualTimers();
  const studio = createStudio({
    client: fake.client,
    timers,
    runtime: {
      ensure: async () => {},
      create: async () => ({ instanceId: "i1", generation: 1 }),
      destroy: async () => {},
      awaitFirstFrame: async () => {},
    },
    settingsBackend: { get: async () => undefined, set: async () => {} },
  });
  return { studio, fake, timers };
}

describe("Feature 1: project openLocal & create with pickParentDirectory / ecosystemModules / version", () => {
  test("projects.openLocal(): cancelled returns { cancelled: true } without switching; opened refreshes list and opens the project", async () => {
    const fake = createFakeClient();
    const timers = createManualTimers();
    const toasts = createToasts(timers);
    const opened: string[] = [];
    const projects = createProjects({
      client: fake.client,
      toasts,
      confirmLeave: async () => true,
      onOpen: async (id) => { opened.push(id); },
    });

    await projects.refresh();
    await projects.open("alpha");
    expect(projects.current()).toBe("alpha");

    // 1) Picker cancelled
    fake.state.openLocalOutcome = "cancel";
    const cancelledRes = await projects.openLocal();
    expect(cancelledRes).toEqual({ cancelled: true });
    expect(projects.current()).toBe("alpha");
    expect(opened).toEqual(["alpha"]);

    // 2) Picker selects a local project directory
    fake.state.openLocalOutcome = {
      id: "local-demo",
      appId: "pocket.local.demo",
      name: "Local Demo",
      title: "本地示例应用",
      version: "0.4.0",
      build: 1,
      tickHz: 60,
      template: "app",
      directory: "<picked-parent>/local-demo",
    };
    const openRes = await projects.openLocal();
    expect(openRes).toMatchObject({
      cancelled: false,
      project: { id: "local-demo", appId: "pocket.local.demo", directory: "<picked-parent>/local-demo", build: 1 },
    });
    expect(projects.current()).toBe("local-demo");
    expect(projects.state().list.some((p) => p.id === "local-demo")).toBe(true);
    expect(opened).toEqual(["alpha", "local-demo"]);
    expect(toasts.items().some((t) => t.message.includes("已打开本地项目 local-demo"))).toBe(true);
  });

  test("projects.create({ pickParentDirectory: true }): cancelled keeps createOpen: true; success opens project with ecosystemModules & version (no tickHz)", async () => {
    const fake = createFakeClient();
    const timers = createManualTimers();
    const toasts = createToasts(timers);
    const opened: string[] = [];
    const projects = createProjects({
      client: fake.client,
      toasts,
      confirmLeave: async () => true,
      onOpen: async (id) => { opened.push(id); },
    });

    projects.setCreateOpen(true);
    await flush();
    expect(projects.state().createOpen).toBe(true);
    expect(projects.state().catalog.length).toBeGreaterThan(0);

    projects.setDraft({
      template: "game",
      id: "picked-game",
      name: "Picked Game",
      appId: "pocket.picked.game",
      version: "0.2.5",
    });
    projects.toggleDraftModule("ios-live-activity");
    projects.toggleDraftModule("android-glance-widget");
    expect(projects.state().draft.ecosystemModules).toEqual(["ios-live-activity", "android-glance-widget"]);
    expect("tickHz" in projects.state().draft).toBe(false);

    // 1) Cancelled parent directory picker keeps dialog open
    fake.state.createPickCancel = true;
    const cancelled = await projects.create({ pickParentDirectory: true });
    expect(cancelled).toEqual({ cancelled: true });
    expect(projects.state().createOpen).toBe(true);
    expect(projects.current()).toBeUndefined();

    // 2) Successful parent directory picker creates project with ecosystemModules & version (and no tickHz in settings)
    fake.state.createPickCancel = false;
    const created = await projects.create({ pickParentDirectory: true });
    expect(projects.state().createOpen).toBe(false);
    expect(projects.current()).toBe("picked-game");
    expect(opened).toEqual(["picked-game"]);
    expect(created).toMatchObject({
      id: "picked-game",
      appId: "pocket.picked.game",
      version: "0.2.5",
      build: 1,
      template: "game",
      directory: "<picked-parent>/picked-game",
      ecosystemModules: ["ios-live-activity", "android-glance-widget"],
    });

    const createCalls = fake.calls.filter((c) => c.name === "project.create");
    const lastCreateArg = createCalls.at(-1)!.args[0] as Record<string, unknown>;
    expect(lastCreateArg).toEqual({
      id: "picked-game",
      template: "game",
      pickParentDirectory: true,
      ecosystemModules: ["ios-live-activity", "android-glance-widget"],
      settings: {
        name: "Picked Game",
        appId: "pocket.picked.game",
        version: "0.2.5",
      },
    });
    expect("tickHz" in (lastCreateArg.settings as Record<string, unknown>)).toBe(false);
    expect("build" in (lastCreateArg.settings as Record<string, unknown>)).toBe(false);
  });
});

describe("Feature 2: ecosystem state (load, toggle, selectPlatform, clearSelection, apply)", () => {
  test("loads catalog & modules, toggles modules, selects apple/android platforms, clears selection, and applies with onApplied callbacks", async () => {
    const fake = createFakeClient();
    const timers = createManualTimers();
    const toasts = createToasts(timers);
    let appliedCount = 0;
    const eco = createEcosystemState({
      client: fake.client,
      toasts,
      onApplied: () => { appliedCount += 1; },
    });

    await eco.load("alpha");
    expect(eco.state().loading).toBe(false);
    expect(eco.state().project).toBe("alpha");
    expect(eco.state().savedModules).toEqual([]);
    expect(eco.state().selectedModules).toEqual([]);
    expect(eco.state().dirty).toBe(false);

    // Toggle individual module
    eco.toggle("ios-live-activity");
    expect(eco.state().selectedModules).toEqual(["ios-live-activity"]);
    expect(eco.state().dirty).toBe(true);
    eco.toggle("ios-live-activity");
    expect(eco.state().selectedModules).toEqual([]);
    expect(eco.state().dirty).toBe(false);

    // Select all Apple modules
    eco.selectPlatform("apple");
    const appleIds = eco.state().catalog.filter((m) => modulePlatform(m) === "apple").map((m) => m.id);
    expect(appleIds.length).toBeGreaterThan(0);
    expect(eco.state().selectedModules).toEqual(appleIds);
    expect(eco.state().dirty).toBe(true);

    // Select all Android modules too
    eco.selectPlatform("android");
    const allIds = eco.state().catalog.map((m) => m.id);
    expect(eco.state().selectedModules).toEqual(allIds);

    // Clear selection
    eco.clearSelection();
    expect(eco.state().selectedModules).toEqual([]);
    expect(eco.state().dirty).toBe(false);

    // Select two modules and apply
    eco.toggle("ios-live-activity");
    eco.toggle("android-glance-widget");
    expect(await eco.apply()).toBe(true);
    expect(appliedCount).toBe(1);
    expect(eco.state().dirty).toBe(false);
    expect(eco.state().savedModules).toEqual(["ios-live-activity", "android-glance-widget"]);
    expect(eco.state().enabledProfiles).toContain("ios-live-activity");
    expect(eco.state().enabledProfiles).toContain("android-app-widget");
    expect(eco.state().lastResult?.generatedFiles).toEqual([
      "ecosystem/ios_live_activity.tsx",
      "ecosystem/android_glance_widget.tsx",
    ]);
    expect(eco.state().lastResult?.entryWired).toBe(true);

    // Also verify full Studio wiring refreshes workspace tree, build, and publish plan on ecosystem.apply()
    const { studio, fake: studioFake } = createTestStudio();
    await studio.projects.open("alpha");
    await flush();
    const treesBefore = studioFake.count("tree");
    const buildsBefore = studioFake.count("build.status");
    const plansBefore = studioFake.count("publish.plan");
    studio.ecosystem.toggle("watchos");
    expect(await studio.ecosystem.apply()).toBe(true);
    await flush();
    expect(studioFake.count("tree")).toBeGreaterThan(treesBefore);
    expect(studioFake.count("build.status")).toBeGreaterThan(buildsBefore);
    expect(studioFake.count("publish.plan")).toBeGreaterThan(plansBefore);
    expect(studio.workspace.state().files.some((f) => f.path === "ecosystem/watchos.tsx")).toBe(true);
  });
});

describe("Feature 3: Tencent Cloud COS state & Publish COS integration", () => {
  test("cos load, pickDiscoveredBucket, saveConfig, saveWorkspaceCredentials (clearing secret inputs immediately), clearWorkspaceCredentials, checkConnection, publishChannel(test/release)", async () => {
    const fake = createFakeClient();
    const timers = createManualTimers();
    const toasts = createToasts(timers);
    const dialogs = createDialogs();
    let publishedCalls = 0;
    const cos = createCosState({
      client: fake.client,
      toasts,
      dialogs,
      onPublished: () => { publishedCalls += 1; },
    });

    await cos.load("alpha");
    expect(cos.state().snapshot?.local.available).toBe(true);
    expect(cosSourceLabel(cos.state().snapshot?.local)).toContain("coscli");
    // Default bucket was pre-populated into draft
    expect(cos.state().draft.bucket).toBe("pocket-ota-1250000001");
    expect(cos.state().draft.region).toBe("ap-guangzhou");

    // Pick discovered bucket
    cos.pickDiscoveredBucket("pocket-test-1250000001", "ap-shanghai");
    expect(cos.state().draft).toMatchObject({ bucket: "pocket-test-1250000001", region: "ap-shanghai" });
    expect(cos.state().dirty).toBe(true);

    // Save config
    cos.patchDraft({ enabled: true, syncOnPublish: true, keyPrefix: "custom-ota", publicBaseUrl: "https://cdn.example.com" });
    const savedSnap = await cos.saveConfig();
    expect(savedSnap?.config).toEqual({
      enabled: true,
      syncOnPublish: true,
      bucket: "pocket-test-1250000001",
      region: "ap-shanghai",
      keyPrefix: "custom-ota",
      publicBaseUrl: "https://cdn.example.com",
    });
    expect(cos.state().dirty).toBe(false);

    // Save workspace credentials -> immediately clears secretIdInput, secretKeyInput, securityTokenInput from memory
    cos.setCredentialInputs({
      secretId: "AKID9876543210",
      secretKey: "super-secret-key-never-keep",
      securityToken: "temp-security-token",
    });
    expect(cos.state().secretIdInput).toBe("AKID9876543210");
    expect(cos.state().secretKeyInput).toBe("super-secret-key-never-keep");
    expect(cos.state().securityTokenInput).toBe("temp-security-token");

    const credSnap = await cos.saveWorkspaceCredentials();
    expect(cos.state().secretIdInput).toBe("");
    expect(cos.state().secretKeyInput).toBe("");
    expect(cos.state().securityTokenInput).toBe("");
    expect(credSnap?.local.hasWorkspaceCredentials).toBe(true);
    expect(credSnap?.local.source).toBe("workspace");
    expect(credSnap?.local.maskedSecretId).toBe("AKID98****3210");
    expect(JSON.stringify(credSnap)).not.toContain("super-secret-key-never-keep");
    expect(JSON.stringify(credSnap)).not.toContain("temp-security-token");

    // Clear workspace credentials
    const clearedSnap = await cos.clearWorkspaceCredentials();
    expect(clearedSnap?.local.hasWorkspaceCredentials).toBe(false);

    // Check connection
    const chk = await cos.checkConnection();
    expect(chk).toMatchObject({
      ok: true,
      bucket: "pocket-test-1250000001",
      region: "ap-shanghai",
      keyPrefix: "custom-ota",
      publicBaseUrl: "https://cdn.example.com",
    });
    expect(cos.state().checkResult?.ok).toBe(true);

    // Publish test channel (no confirmation dialog required)
    const testSummary = await cos.publishChannel("test");
    expect(dialogs.active()).toBeUndefined();
    expect(testSummary).toMatchObject({
      slot: "test",
      version: "0.1.0-test.1",
      build: 1,
      uploadedFiles: 4,
      skippedFiles: 2,
      appConfigUrl: "https://cdn.example.com/custom-ota/test/pocket.alpha/host.json",
      manifestUrl: "https://cdn.example.com/custom-ota/test/pocket.alpha/latest.json",
    });
    expect(cos.state().snapshot?.published?.test).toEqual(testSummary);
    expect(publishedCalls).toBe(1);

    // Publish release channel: requires confirmation via dialogs.confirm
    const releaseCancelPromise = cos.publishChannel("release");
    await flush();
    expect(dialogs.active()?.title).toBe("上传稳定版到腾讯云 COS？");
    dialogs.cancel();
    expect(await releaseCancelPromise).toBeUndefined();
    expect(publishedCalls).toBe(1);

    const releaseOkPromise = cos.publishChannel("release");
    await flush();
    expect(dialogs.active()?.title).toBe("上传稳定版到腾讯云 COS？");
    dialogs.confirmActive();
    const releaseSummary = await releaseOkPromise;
    expect(releaseSummary).toMatchObject({
      slot: "stable",
      version: "0.1.0",
      build: 1,
      appConfigUrl: "https://cdn.example.com/custom-ota/stable/pocket.alpha/host.json",
    });
    expect(cos.state().snapshot?.published?.stable).toEqual(releaseSummary);
    expect(publishedCalls).toBe(2);
  });

  test("publish state surfaces cosPublish & non-fatal cosError and refreshes cos in Studio", async () => {
    const { studio, fake } = createTestStudio();
    await studio.projects.open("alpha");
    await flush();

    // Mark build as current and enable COS syncOnPublish
    fake.state.builtRevision = fake.state.revision;
    await studio.cos.load("alpha");
    studio.cos.patchDraft({ enabled: true, syncOnPublish: true, bucket: "pocket-ota-1250000001", region: "ap-guangzhou" });
    await studio.cos.saveConfig();

    // 1) Successful publish with auto COS sync
    await studio.publish.publish();
    await flush();
    expect(studio.publish.state().phase).toBe("done");
    expect(studio.publish.state().info?.cosPublish).toMatchObject({
      slot: "test",
      uploadedFiles: 5,
      skippedFiles: 1,
    });
    expect(studio.publish.state().info?.cosError).toBeUndefined();
    expect(studio.cos.state().snapshot?.published?.test?.uploadedFiles).toBe(5);
    expect(studio.toasts.items().some((t) => t.message.includes("同步到腾讯云 COS"))).toBe(true);

    // 2) Publish with non-fatal cosError (local publish succeeds, warning toast shown)
    fake.state.publishCosError = "COS SecretKey 签名不匹配 (SignatureDoesNotMatch)";
    await studio.publish.publish();
    await flush();
    expect(studio.publish.state().phase).toBe("done");
    expect(studio.publish.state().info?.cosError).toBe("COS SecretKey 签名不匹配 (SignatureDoesNotMatch)");
    expect(studio.toasts.items().some((t) => t.tone === "warning" && t.message.includes("同步到 COS 失败"))).toBe(true);
  });
});

describe("Feature 4: projectSettings appId rename dirty-tab guard & clean-tab reload", () => {
  test("blocks appId rename when workspace has dirty tabs (no RPC call sent); when clean, renames appId and reloads open tabs & tree", async () => {
    // 1) Standalone projectSettings unit check
    const fake = createFakeClient();
    const timers = createManualTimers();
    const toasts = createToasts(timers);
    const dialogs = createDialogs();
    let dirty = true;
    let renamedCount = 0;
    const ps = createProjectSettings({
      client: fake.client,
      toasts,
      dialogs,
      hasDirtyDocs: () => dirty,
      onAppIdRenamed: () => { renamedCount += 1; },
    });

    await ps.attach("alpha");
    ps.setField("appId", "pocket.alpha.renamed");
    expect(ps.appIdChanged()).toBe(true);

    const setCallsBefore = fake.count("project.settings.set");
    expect(await ps.save()).toBe(false);
    expect(fake.count("project.settings.set")).toBe(setCallsBefore);
    expect(ps.state().error).toBe("修改应用包名 (appId) 前请先保存所有未保存的文件标签页");
    expect(ps.state().errors.appId).toBe("修改应用包名 (appId) 前请先保存所有未保存的文件标签页");
    expect(renamedCount).toBe(0);

    // Once dirty tabs are saved, save() succeeds and triggers onAppIdRenamed
    dirty = false;
    expect(await ps.save()).toBe(true);
    expect(fake.count("project.settings.set")).toBe(setCallsBefore + 1);
    expect(renamedCount).toBe(1);

    // 2) Full Studio wiring: dirty tab blocks appId rename, then saving tab and renaming reloads open tab content and tree
    const { studio, fake: studioFake } = createTestStudio();
    studioFake.files.set("src/index.tsx", 'export const APP = "pocket.alpha";\n');
    studioFake.files.set("pocket.json", '{\n  "appId": "pocket.alpha"\n}\n');
    await studio.projects.open("alpha");
    await flush();

    await studio.workspace.open("src/index.tsx");
    expect(studio.workspace.textOf("src/index.tsx")).toContain("pocket.alpha");

    // Make the open tab dirty
    studio.workspace.setText("src/index.tsx", 'export const APP = "pocket.alpha"; // unsaved edit\n');
    expect(isDirty(studio.workspace.docOf("src/index.tsx")!)).toBe(true);

    studio.projectSettings.setField("appId", "pocket.alpha.v2");
    const setsBefore = studioFake.count("project.settings.set");
    expect(await studio.projectSettings.save()).toBe(false);
    expect(studioFake.count("project.settings.set")).toBe(setsBefore);
    expect(studio.projectSettings.state().error).toBe("修改应用包名 (appId) 前请先保存所有未保存的文件标签页");

    // Save the open tab so all tabs are clean
    expect(await studio.workspace.save("src/index.tsx")).toBe(true);
    expect(isDirty(studio.workspace.docOf("src/index.tsx")!)).toBe(false);

    // Now save projectSettings with the new appId -> service rewrites files on disk and Studio reconciles open tabs
    expect(await studio.projectSettings.save()).toBe(true);
    await flush();
    expect(studioFake.count("project.settings.set")).toBe(setsBefore + 1);
    expect(studio.workspace.textOf("src/index.tsx")).toBe('export const APP = "pocket.alpha.v2"; // unsaved edit\n');
    expect(isDirty(studio.workspace.docOf("src/index.tsx")!)).toBe(false);
  });
});

describe("Feature 5: sdkUpgrade new telemetry fields & HTTP 200 / HTTP 409 deferral handling", () => {
  test("parses autoUpgradeSupported, modeReason, downloadedBytes, downloadTotalBytes, appliedAt, and handles both HTTP 200 and HTTP 409 deferrals cleanly", async () => {
    const fake = createFakeClient();
    fake.state.sdkUpgrade = {
      ...fake.state.sdkUpgrade,
      currentVersion: "0.1.12",
      latestVersion: "0.2.0",
      mode: "standalone",
      modeReason: "独立安装模式（支持后台下载与热切换）",
      autoUpgradeSupported: true,
      status: "downloading",
      upgradeAvailable: true,
      downloadedBytes: 2 * 1024 * 1024,
      downloadTotalBytes: 8 * 1024 * 1024,
      appliedAt: "2026-11-16T09:30:00.000Z",
      deferredReason: null,
    };

    const timers = createManualTimers();
    const toasts = createToasts(timers);
    const dialogs = createDialogs();
    const up = createSdkUpgrade({
      client: fake.client,
      timers,
      toasts,
      dialogs,
      confirmLeave: async () => true,
    });

    await up.load();
    expect(up.state().info).toMatchObject({
      currentVersion: "0.1.12",
      latestVersion: "0.2.0",
      mode: "standalone",
      modeReason: "独立安装模式（支持后台下载与热切换）",
      autoUpgradeSupported: true,
      status: "downloading",
      upgradeAvailable: true,
      downloadedBytes: 2 * 1024 * 1024,
      downloadTotalBytes: 8 * 1024 * 1024,
      appliedAt: "2026-11-16T09:30:00.000Z",
    });

    // Case A: HTTP 200 deferral ({ status: "available", deferredReason: "..." })
    fake.state.sdkUpgrade.applyMode = "defer_200";
    fake.state.sdkUpgrade.deferMessage = "正在构建项目 alpha，已暂缓应用升级";
    const apply200 = up.apply();
    await flush();
    expect(dialogs.active()?.title).toContain("v0.2.0");
    dialogs.confirmActive();
    await apply200;
    expect(up.state().phase).toBe("idle");
    expect(up.state().info?.deferredReason).toBe("正在构建项目 alpha，已暂缓应用升级");
    expect(up.state().notice).toEqual({
      tone: "warn",
      text: "服务已暂缓升级：正在构建项目 alpha，已暂缓应用升级",
    });

    // Case B: HTTP 409 conflict deferral
    fake.state.sdkUpgrade.applyMode = "defer_409";
    fake.state.sdkUpgrade.deferMessage = "正在发布签名包，已暂缓升级";
    const apply409 = up.apply();
    await flush();
    dialogs.confirmActive();
    await apply409;
    expect(up.state().phase).toBe("idle");
    expect(up.state().info?.deferredReason).toContain("正在发布签名包，已暂缓升级");
    expect(up.state().notice?.tone).toBe("warn");
    expect(up.state().notice?.text).toContain("服务未执行升级：");
    expect(up.state().notice?.text).toContain("正在发布签名包，已暂缓升级");
  });
});
