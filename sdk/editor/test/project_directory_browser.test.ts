import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { startEditor } from "../server.ts";

test("directory selection opens the original project; cancel and picker errors preserve manual input", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-directory-ui-"));
  const external = join(root, "Project with spaces");
  cpSync(join(import.meta.dir, "../../templates/app"), external, { recursive: true });
  writeFileSync(join(external, "editor.json"), JSON.stringify({ id: "picked-project", name: "Picked project" }));
  const server = await startEditor({ port: 0, workspace: join(root, "workspace") });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let selection: string | null = null;
    let fail = false;
    // Only the native OS dialog boundary is replaced. Project opening uses the real server.
    await page.route("**/api/projects/pick-directory", route => route.fulfill(fail
      ? { status: 400, json: { error: "系统选择器不可用" } }
      : { json: { path: selection } }));
    await page.route("**/api/studio/upgrade/check", route => route.fulfill({ json: { status: "up-to-date" } }));
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.locator("#open-project").click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#browse-project-directory")!.disabled);
    expect(await page.locator('#open-project-form [name="path"]').inputValue()).toBe("");
    expect(await (await fetch(`http://127.0.0.1:${server.port}/api/projects`)).json()).toEqual([]);
    fail = true;
    await page.locator("#browse-project-directory").click();
    await page.locator("#open-project-error:not([hidden])").waitFor();
    await page.locator('#open-project-form [name="path"]').fill(external);
    expect(await page.locator('#open-project-form [name="path"]').inputValue()).toBe(external);
    fail = false;
    selection = external;
    await page.locator("#browse-project-directory").click();
    await page.locator("#open-project-dialog").waitFor({ state: "hidden" });
    const projects = await (await fetch(`http://127.0.0.1:${server.port}/api/projects`)).json() as any[];
    expect(projects.map(item => item.id)).toEqual(["picked-project"]);
    const denied = await fetch(`http://127.0.0.1:${server.port}/api/projects/pick-directory`, {
      method: "POST", headers: { origin: "https://example.com", "x-pocket-editor": "1" }, body: "{}",
    });
    expect(denied.status).toBe(403);
  } finally { await browser.close(); server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
