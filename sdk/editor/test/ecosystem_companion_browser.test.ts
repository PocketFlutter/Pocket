import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startEditor } from "../server.ts";

test("Studio presents an independent extension project beside a live main preview", { timeout: 90_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pocket-ecosystem-browser-"));
  const server = await startEditor({ port: 0, workspace });
  const browser = await chromium.launch({ headless: true });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const headers = { "x-pocket-editor": "1", "content-type": "application/json" };
    const projectId = "ecosystem-fixture";
    const created = await fetch(origin + "/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: projectId, name: "Ecosystem Fixture" }),
    });
    expect(created.status).toBe(201);
    const projectUrl = `${origin}/api/projects/${projectId}`;
    const source = await readFile(new URL("./fixtures/counter/app.tsx", import.meta.url), "utf8");
    const saved = await fetch(projectUrl + "/source", {
      method: "PUT",
      headers,
      body: JSON.stringify({ source }),
    });
    expect(saved.status).toBe(200);

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15_000);
    await page.addInitScript((id) => {
      localStorage.setItem("pocket.editor.directWebPreview." + id, "0");
      window.addEventListener("message", (event) => {
        if (event.data?.type !== "preview.frame") return;
        for (const lane of ["preview", "ecosystem-preview"]) {
          const frame = document.querySelector<HTMLIFrameElement>(`#${lane}-frame`);
          if (event.source === frame?.contentWindow) (window as any)[lane] = event.data.frame;
        }
      });
    }, projectId);
    await page.goto(`${origin}/?project=${projectId}`);
    const waitText = (lane: string, text: string) => page.waitForFunction(({ lane, text }) =>
      (window as any)[lane]?.ops.find((op: any) => op.type === "text" && op.text === text),
    { lane, text });
    const mainViewport = page.locator("#viewport-picker");
    await mainViewport.selectOption("tablet");
    await page.locator("#build").click();
    await waitText("preview", "count=0");
    await page.waitForFunction(() => (window as any).preview?.width === 768);
    const mainFrame = page.locator("#preview-frame");
    const mainSrc = await mainFrame.getAttribute("src");
    const countButton = await waitText("preview", "Increment counter");
    const { x, y, w, h } = await countButton.jsonValue();
    const canvas = page.frameLocator("#preview-frame").locator("canvas").first();
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();
    await page.mouse.click(canvasBox!.x + (x + w / 2) * canvasBox!.width / 768,
      canvasBox!.y + (y + h / 2) * canvasBox!.height / 1023);
    await waitText("preview", "count=1");

    await page.locator("#open-ecosystem-builder").click();
    const appleToday = page.locator('#ecosystem-module-list input[value="apple-today"]');
    const apply = page.locator("#apply-ecosystem-modules");
    await appleToday.check();
    await apply.click();
    const ecosystemFrame = page.locator("#ecosystem-preview-frame");
    const profile = page.locator("#ecosystem-preview-picker");
    await waitText("ecosystem-preview", "TODAY WIDGET");
    await page.locator("#ecosystem-preview-empty").waitFor({ state: "hidden" });
    expect(await profile.inputValue()).toBe("ios-widget-small");
    expect(await mainViewport.inputValue()).toBe("tablet");
    expect(await mainFrame.getAttribute("src")).toBe(mainSrc);
    expect(await mainFrame.boundingBox()).not.toBeNull();
    expect((await ecosystemFrame.boundingBox())!.x).toBeGreaterThan((await mainFrame.boundingBox())!.x);
    expect(new URL((await ecosystemFrame.getAttribute("src"))!).searchParams.get("lane")).toBe("ecosystem");
    expect(await page.locator("#open-ecosystem-companion").isVisible()).toBe(true);
    const companion = (await (await fetch(projectUrl + "/ecosystem")).json()).companion;
    expect(companion.projectId).not.toBe(projectId);
    expect(new URL((await ecosystemFrame.getAttribute("src"))!).pathname).toBe(`/api/projects/${companion.projectId}/preview`);

    const mode = page.locator("#surface-render-mode");
    await mode.selectOption("accented");
    await page.waitForFunction(async (url) =>
      (await (await fetch(url)).json()).status?.surface?.renderMode === "accented",
    `/api/projects/${companion.projectId}/preview/snapshot?lane=ecosystem`);
    await profile.selectOption("ios-widget-medium");
    await page.locator("#ecosystem-preview-empty").waitFor({ state: "hidden" });
    expect(await mainFrame.getAttribute("src")).toBe(mainSrc);
    await waitText("preview", "count=1");

    const deepLink = page.waitForRequest((request) =>
      new URL(request.url()).pathname === `/api/projects/${projectId}/preview/input` &&
      request.method() === "POST" &&
      request.postDataJSON()?.openUri === "pocket://app/home?from=apple-today");
    await page.locator("#widget-companion-jump").click();
    await deepLink;
    expect(await mainViewport.inputValue()).toBe("tablet");
    expect(await mainFrame.getAttribute("src")).toBe(mainSrc);

    await mainViewport.selectOption("iphone-16-pro");
    await page.locator("#main-render-mode").selectOption("alwaysOn");
    await page.waitForFunction(async (url) => {
      const { status } = await (await fetch(url)).json();
      return status?.surface?.profileId === "iphone-16-pro" && status.surface.renderMode === "alwaysOn";
    }, `/api/projects/${projectId}/preview/snapshot`);
    expect(await profile.inputValue()).toBe("ios-widget-medium");
    await mainViewport.selectOption("tablet");

    await appleToday.uncheck();
    await apply.click();
    await page.locator("#ecosystem-preview-pane").waitFor({ state: "hidden" });
    expect(await mainFrame.getAttribute("src")).toBe(mainSrc);
    await waitText("preview", "count=1");

    await page.locator("#open-ecosystem-companion").click();
    await page.waitForFunction(() => document.querySelector("#project-title")?.textContent?.includes("生态扩展"));
    await page.waitForFunction(() => !(document.querySelector<HTMLSelectElement>("#file-picker")?.disabled));
    expect(await page.locator("#file-picker").inputValue()).toBe("app.tsx");
    expect(await apply.isDisabled()).toBe(true);
    expect(await page.locator("#ecosystem-preview-pane").isHidden()).toBe(true);
    const switcher = page.locator("#project-switcher");
    await switcher.locator("summary").click();
    await switcher.locator(".project-item").filter({ has: page.getByText("Ecosystem Fixture", { exact: true }) }).click();
    await page.waitForFunction((id) => {
      const iframe = document.querySelector<HTMLIFrameElement>("#preview-frame");
      return iframe?.src.includes(`/api/projects/${id}/preview`);
    }, projectId);
    expect(await mainViewport.inputValue()).toBe("tablet");
    expect(await appleToday.isChecked()).toBe(false);
  } finally {
    await browser.close();
    await server.stop();
    await rm(workspace, { recursive: true, force: true });
  }
});
