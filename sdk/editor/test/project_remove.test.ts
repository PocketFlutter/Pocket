import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startEditor } from "../server.ts";

test("Studio removes an opened project from the list and can reopen its original directory", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-project-remove-"));
  const workspace = join(root, "workspace");
  const projectId = "removable-project";
  const projectName = "Removable project";
  const external = join(root, "External project");
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    cpSync(join(import.meta.dir, "../../templates/app"), external, {
      recursive: true,
      filter: (path) => !path.split(/[\\/]/).includes("node_modules"),
    });
    const sourcePath = join(external, "app.tsx");
    const configPath = join(external, "editor.json");
    const runtimeConfigPath = join(external, "pocket.json");
    writeFileSync(configPath, JSON.stringify({ id: projectId, name: projectName }));
    const runtimeConfig = JSON.parse(readFileSync(runtimeConfigPath, "utf8"));
    writeFileSync(runtimeConfigPath, JSON.stringify({ ...runtimeConfig, title: projectName }));
    const originalSource = readFileSync(sourcePath, "utf8");
    const originalConfig = readFileSync(configPath, "utf8");

    server = await startEditor({ port: 0, workspace });
    const origin = () => `http://127.0.0.1:${server!.port}`;
    const projectRoute = `/api/projects/${projectId}`;
    const listProjects = async () => {
      const response = await fetch(`${origin()}/api/projects`);
      expect(response.status).toBe(200);
      return await response.json() as { id: string; directory: string }[];
    };
    const opened = await fetch(`${origin()}/api/projects/open`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pocket-editor": "1" },
      body: JSON.stringify({ path: external }),
    });
    expect(opened.status).toBe(200);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    await page.route("**/api/studio/upgrade/check", route => route.fulfill({ json: { status: "up-to-date" } }));
    await page.goto(origin());
    const projects = page.locator("#projects");
    const project = projects.locator(".project-item", { hasText: projectName });
    const source = page.locator("#source");
    const remove = projects.getByRole("button", { name: /移除/ });
    let removeRequests = 0;
    page.on("request", request => {
      if (request.method() === "DELETE" && new URL(request.url()).pathname === projectRoute) removeRequests++;
    });

    await page.locator("#source:enabled").waitFor({ state: "attached" });
    expect(await source.inputValue()).toBe(originalSource);
    await page.locator("#project-switcher > summary").click();
    await project.waitFor();
    const cancelled = page.waitForEvent("dialog").then(async dialog => {
      await dialog.dismiss();
      return dialog.message();
    });
    await remove.click();
    expect(await cancelled).toContain(projectName);
    expect(await project.isVisible()).toBe(true);
    expect(removeRequests).toBe(0);
    expect((await listProjects()).map(item => item.id)).toEqual([projectId]);

    const removed = page.waitForResponse(response =>
      response.request().method() === "DELETE" && new URL(response.url()).pathname === projectRoute,
    );
    const confirmed = page.waitForEvent("dialog").then(dialog => dialog.accept());
    await remove.click();
    await confirmed;
    expect((await removed).ok()).toBe(true);
    await project.waitFor({ state: "detached" });
    await page.locator("#source:disabled").waitFor({ state: "attached" });
    expect(await source.inputValue()).toBe("");
    expect(await page.locator("#preview-frame").getAttribute("src")).toBe("about:blank");
    expect(await listProjects()).toEqual([]);
    expect((await fetch(`${origin()}${projectRoute}/config`)).status).toBe(404);
    expect(readFileSync(sourcePath, "utf8")).toBe(originalSource);
    expect(readFileSync(configPath, "utf8")).toBe(originalConfig);

    server.stop(true);
    server = await startEditor({ port: 0, workspace });
    expect(await listProjects()).toEqual([]);

    await page.goto(origin());
    await page.locator("#open-project").click();
    await page.locator('#open-project-form [name="path"]').fill(external);
    await page.locator("#confirm-open-project").click();
    await page.locator("#source:enabled").waitFor({ state: "attached" });
    await project.waitFor({ state: "attached" });
    expect(await listProjects()).toEqual([
      expect.objectContaining({ id: projectId, directory: realpathSync(external) }),
    ]);
    expect(readFileSync(sourcePath, "utf8")).toBe(originalSource);
    expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
  } finally {
    await browser?.close();
    server?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("removing a workspace project hides it after restart and preserves its source", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-workspace-remove-"));
  const workspace = join(root, "workspace");
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  try {
    server = await startEditor({ port: 0, workspace });
    const request = (path: string, method = "GET", body?: object) => fetch(
      `http://127.0.0.1:${server!.port}/api/projects${path}`,
      {
        method,
        headers: { "content-type": "application/json", "x-pocket-editor": "1" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const id = "managed-project";
    const path = `/${id}`;
    const directory = join(workspace, "projects", id);
    const created = await request("", "POST", { id, name: "Managed project", template: "app" });
    expect(created.status).toBe(201);
    const source = join(directory, "app.tsx");
    const original = readFileSync(source, "utf8");

    const denied = await fetch(`http://127.0.0.1:${server.port}/api/projects${path}`, {
      method: "DELETE",
      headers: { origin: "https://example.com", "x-pocket-editor": "1" },
    });
    expect(denied.status).toBe(403);
    const removed = await request(path, "DELETE");
    expect(removed.status).toBe(200);
    expect(await (await request("")).json()).toEqual([]);
    expect(readFileSync(source, "utf8")).toBe(original);

    server.stop(true);
    server = await startEditor({ port: 0, workspace });
    expect(await (await request("")).json()).toEqual([]);
    expect((await request("/open", "POST", { path: directory })).status).toBe(200);
    expect(await (await request("")).json()).toEqual([
      expect.objectContaining({ id, directory: realpathSync(directory) }),
    ]);
    expect(readFileSync(source, "utf8")).toBe(original);
  } finally {
    server?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
