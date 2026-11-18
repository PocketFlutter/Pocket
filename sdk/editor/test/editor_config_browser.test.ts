import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { pack } from "../../.cache/pocketjs/framework/compiler/pak.ts";
import { startEditor } from "../server.ts";

async function waitForBuildRun(runs: Array<unknown>, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (runs.length < count && Date.now() < deadline) await Bun.sleep(10);
  expect(runs).toHaveLength(count);
}

async function waitForConfigSave(page: Page): Promise<void> {
  await page.waitForFunction(() => ["配置已保存", "保存失败"].includes(document.querySelector("#config-save-status")?.textContent || ""), undefined, { timeout: 10_000 });
  const status = await page.locator("#config-save-status").textContent();
  if (status !== "配置已保存") {
    throw new Error(`config save failed: ${await page.locator("#notice-message").textContent()}`);
  }
}

test("Editor saves project config independently and refreshes the backend build number", { timeout: 90_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocket-editor-config-browser-"));
  const workspace = join(temporary, "workspace");
  const artifacts = join(temporary, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const appJs = join(artifacts, "app.js");
  const bytecode = join(artifacts, "app.qjbc");
  const metadata = join(artifacts, "app.bytecode.json");
  const pak = join(artifacts, "app.pak");
  const bytecodeMetadata = { entryFormat: "quickjs-bytecode", runtimeAbi: "config-browser-fixture-v1", bytecodeBytes: 4 };
  writeFileSync(appJs, "globalThis.__pocket_config_fixture = true;\n");
  writeFileSync(bytecode, Buffer.from([0x51, 0x4a, 0x42, 0x43]));
  writeFileSync(metadata, JSON.stringify(bytecodeMetadata));
  writeFileSync(pak, pack([{ key: "fixture:text", dtype: 0, data: new Uint8Array([1, 2, 3]) }]));

  const buildRuns: Array<{ started: Promise<void>; release: () => void; fail: () => void }> = [];
  const server = await startEditor({
    port: 0,
    workspace,
    buildRunner: async () => {
      let signalStarted!: () => void;
      let release!: () => void;
      let reject!: (error: Error) => void;
      const started = new Promise<void>((resolve) => { signalStarted = resolve; });
      const gate = new Promise<void>((resolve, rejectBuild) => { release = resolve; reject = rejectBuild; });
      buildRuns.push({ started, release, fail: () => reject(new Error("fixture build failure")) });
      signalStarted();
      await gate;
      return {
        appJs,
        bytecode,
        metadata,
        pak,
        runtimeAbi: bytecodeMetadata.runtimeAbi,
        bytecodeMetadata,
      };
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const projectCreateBodies: Array<Record<string, unknown>> = [];
    const configPutBodies: Array<Record<string, unknown>> = [];
    const buildPostBodies: Array<Record<string, unknown>> = [];
    let sourcePutCount = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname === "/api/projects") {
        projectCreateBodies.push(request.postDataJSON() as Record<string, unknown>);
      } else if (request.method() === "POST" && /^\/api\/projects\/[^/]+\/build$/.test(url.pathname)) {
        buildPostBodies.push(request.postDataJSON() as Record<string, unknown>);
      } else if (request.method() === "PUT" && /^\/api\/projects\/[^/]+\/config$/.test(url.pathname)) {
        configPutBodies.push(request.postDataJSON() as Record<string, unknown>);
      } else if (request.method() === "PUT" && /^\/api\/projects\/[^/]+\/files\//.test(url.pathname)) {
        sourcePutCount += 1;
      }
    });

    const response = await page.goto(`http://127.0.0.1:${server.port}/`);
    expect(response?.status()).toBe(200);
    await page.locator("#new-project").click();
    expect(await page.locator('#create-form [name="tickHz"]').count()).toBe(0);
    await page.locator('#create-form [name="id"]').fill("config-save-app");
    await page.locator('#create-form [name="name"]').fill("Config Save Original");
    await page.locator('#create-form [name="appId"]').fill("pocket.config.original");
    await page.locator('#create-form [name="version"]').fill("0.1.0");
    await page.locator('#create-form button[type="submit"]').click();

    await page.waitForFunction(() => document.querySelector("#project-title")?.textContent === "Config Save Original");
    expect(projectCreateBodies).toHaveLength(1);
    expect(projectCreateBodies[0]).not.toHaveProperty("tickHz");
    expect(projectCreateBodies[0]).not.toHaveProperty("build");
    expect(await page.locator("#config-tick").count()).toBe(0);
    await page.locator("#inspector-tab-settings").click();
    expect(await page.locator("#config-build").getAttribute("readonly")).not.toBeNull();
    const projectId = "config-save-app";
    const apiBase = `http://127.0.0.1:${server.port}/api/projects/${projectId}`;
    const sourceBefore = await (await fetch(`${apiBase}/files/app.tsx`)).json() as { content: string };

    await page.locator("#rail-source").click();
    await page.locator("#source").fill(`${sourceBefore.content}\n// an unsaved source draft\n`);
    await page.locator("#config-name").fill("Config Save Persisted");
    await page.locator("#config-version").fill("1.2.3");
    await page.locator("#save-config").click();
    await waitForConfigSave(page);

    expect(sourcePutCount).toBe(0);
    expect(await page.locator("#save").isDisabled()).toBe(false);
    expect(await page.locator("#source").inputValue()).toContain("an unsaved source draft");
    const sourceAfterConfigSave = await (await fetch(`${apiBase}/files/app.tsx`)).json() as { content: string };
    expect(sourceAfterConfigSave.content).toBe(sourceBefore.content);
    const persistedConfig = await (await fetch(`${apiBase}/config`)).json() as Record<string, unknown>;
    expect(persistedConfig).toMatchObject({ name: "Config Save Persisted", appId: "pocket.config.original", version: "1.2.3" });
    expect(persistedConfig.build).toBe(1);
    expect(configPutBodies.at(-1)).toEqual({ name: "Config Save Persisted", appId: "pocket.config.original", version: "1.2.3" });

    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#refresh-source").click();
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>("#save")?.disabled === true);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#project-title")?.textContent === "Config Save Persisted");
    await page.locator("#inspector-tab-settings").click();
    expect(await page.locator("#config-name").inputValue()).toBe("Config Save Persisted");
    expect(await page.locator("#config-app-id").inputValue()).toBe("pocket.config.original");
    expect(await page.locator("#config-version").inputValue()).toBe("1.2.3");
    expect(await page.locator("#source").inputValue()).toBe(sourceBefore.content);

    await page.locator("#config-app-id").fill("invalid/id");
    await page.locator("#save-config").click();
    await page.waitForFunction(() => document.querySelector("#config-save-status")?.textContent === "保存失败");
    expect(await page.locator("#notice").isVisible()).toBe(true);
    expect(await page.locator("#notice-message").textContent()).toContain("appId contains unsafe characters");
    expect((await (await fetch(`${apiBase}/config`)).json() as Record<string, unknown>).appId).toBe("pocket.config.original");
    await page.locator("#config-app-id").fill("pocket.config.original");

    await page.locator("#rail-source").click();
    const sourceWithPackageId = `${sourceBefore.content}\nconst linkedPackageId = "pocket.config.original";\n`;
    await page.locator("#source").fill(sourceWithPackageId);
    await page.locator("#save").click();
    await page.waitForFunction(() => document.querySelector("#save-status")?.textContent === "已保存");
    expect(sourcePutCount).toBe(1);

    await page.locator("#config-app-id").fill("pocket.config.updated");
    const sourcePutCountBeforeIdentitySave = sourcePutCount;
    await page.locator("#save-config").click();
    await waitForConfigSave(page);
    const migratedSource = await (await fetch(`${apiBase}/files/app.tsx`)).json() as { content: string };
    expect(migratedSource.content).toContain("pocket.config.updated");
    expect(migratedSource.content).toContain('const linkedPackageId = "pocket.config.updated";');
    expect(migratedSource.content).not.toContain("pocket.config.original");
    expect(sourcePutCount).toBe(sourcePutCountBeforeIdentitySave);
    expect(await page.locator("#source").inputValue()).toBe(migratedSource.content);
    expect(await page.locator("#save").isDisabled()).toBe(true);
    expect(await (await fetch(`${apiBase}/config`)).json()).toMatchObject({ appId: "pocket.config.updated" });

    const sourceDraft = `${migratedSource.content}\n// protect this draft\n`;
    await page.locator("#source").fill(sourceDraft);
    await page.locator("#config-app-id").fill("pocket.config.blocked");
    const configPutCountBeforeBlockedIdentity = configPutBodies.length;
    await page.locator("#save-config").click();
    await page.getByRole("status").filter({ hasText: "请先保存源码" }).waitFor();
    expect(configPutBodies).toHaveLength(configPutCountBeforeBlockedIdentity);
    expect(await page.locator("#source").inputValue()).toBe(sourceDraft);
    expect((await (await fetch(`${apiBase}/config`)).json() as Record<string, unknown>).appId).toBe("pocket.config.updated");

    await page.locator("#source").fill(migratedSource.content);
    await page.locator("#config-name").fill("Config Save Persisted");
    await page.locator("#config-app-id").fill("pocket.config.updated");
    expect(await page.locator("#save-config").isDisabled()).toBe(true);
    expect(await page.locator("#build").isDisabled()).toBe(false);

    await page.locator("#build").click();
    await waitForBuildRun(buildRuns, 1);
    await buildRuns[0]!.started;
    await page.waitForFunction(() => document.querySelector("#build-state")?.textContent?.startsWith("正在构建"));
    await page.locator("#config-name").fill("Draft name during build");
    await page.locator("#config-app-id").fill("pocket.config.draft-during-build");
    const firstBuildConfigRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === `/api/projects/${projectId}/config`;
    });
    buildRuns[0]!.release();
    await firstBuildConfigRefresh;

    await page.waitForFunction(() => {
      const field = document.querySelector<HTMLInputElement>("#config-build");
      return document.querySelector("#build-state")?.classList.contains("good") && field?.value === "1";
    }, undefined, { timeout: 30_000 });
    expect(await page.locator("#config-name").inputValue()).toBe("Draft name during build");
    expect(await page.locator("#config-app-id").inputValue()).toBe("pocket.config.draft-during-build");
    expect(await page.locator("#save-config").isDisabled()).toBe(false);
    expect((await (await fetch(`${apiBase}/config`)).json() as Record<string, unknown>).build).toBe(1);
    for (const body of configPutBodies) {
      expect(body).not.toHaveProperty("build");
      expect(body).not.toHaveProperty("tickHz");
      expect(Object.keys(body).sort()).toEqual(["appId", "name", "version"]);
    }

    // Restore the persisted config values without saving the in-build draft,
    // then build a second time to verify the displayed counter follows the server.
    await page.locator("#config-name").fill("Config Save Persisted");
    await page.locator("#config-app-id").fill("pocket.config.updated");
    expect(await page.locator("#save-config").isDisabled()).toBe(true);
    await page.locator("#build").click();
    await waitForBuildRun(buildRuns, 2);
    await buildRuns[1]!.started;
    const secondBuildConfigRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === `/api/projects/${projectId}/config`;
    });
    buildRuns[1]!.release();
    await secondBuildConfigRefresh;
    await page.waitForFunction(() => {
      const field = document.querySelector<HTMLInputElement>("#config-build");
      return document.querySelector("#build-state")?.classList.contains("good") && field?.value === "2";
    }, undefined, { timeout: 30_000 });
    expect((await (await fetch(`${apiBase}/config`)).json() as Record<string, unknown>).build).toBe(2);
    for (const body of buildPostBodies) expect(body).toEqual({});

    await page.locator("#build").click();
    await waitForBuildRun(buildRuns, 3);
    await buildRuns[2]!.started;
    const failedBuildConfigRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === `/api/projects/${projectId}/config`;
    });
    buildRuns[2]!.fail();
    await failedBuildConfigRefresh;
    await page.waitForFunction(() => document.querySelector("#build-state")?.textContent === "构建失败");
    expect((await (await fetch(`${apiBase}/config`)).json() as Record<string, unknown>).build).toBe(2);
    expect(await page.locator("#config-build").inputValue()).toBe("2");
  } finally {
    for (const run of buildRuns) run.release();
    await browser.close();
    server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
