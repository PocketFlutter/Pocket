import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "../server.ts";

test("Web companion extensions build independently and preserve legacy ownership on restart", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pocket-ecosystem-companion-"));
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  let base = "";
  let csrf = "";
  const boot = async () => {
    server = await startEditor({ port: 0, workspace });
    base = `http://127.0.0.1:${server.port}`;
    csrf = (await (await fetch(`${base}/health`)).json()).csrfToken;
  };
  const api = async (path: string, method = "GET", data?: unknown) => {
    const response = await fetch(`${base}/api/projects${path}`, {
      method,
      headers: { "content-type": "application/json", "x-pocket-csrf": csrf },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await boot();
    expect((await api("", "POST", { id: "parent-app", ecosystemModules: ["apple-today"] })).status).toBe(201);
    const endpoint = "/parent-app/ecosystem";
    const parent = join(workspace, "projects", "parent-app");
    const parentEntry = readFileSync(join(parent, "app.tsx"), "utf8");
    const parentConfig = readFileSync(join(parent, "editor.json"), "utf8");
    const selection = { mode: "companion", modules: ["apple-today", "android-widgets", "apple-watch"] };
    const first = await api(endpoint, "POST", selection);
    expect(first.status).toBe(200);
    expect(first.body.parentChanged).toBe(false);
    const child = first.body.companion;
    expect(child.modules).toEqual(["apple-watch", "android-widgets"]);
    expect(child.profileIds).toContain("watchos-smart-stack");
    expect(child.profileIds).not.toContain("apple-watch-45mm");
    const childDir = join(workspace, "projects", child.projectId);
    expect(readFileSync(join(parent, "app.tsx"), "utf8")).toBe(parentEntry);
    expect(readFileSync(join(parent, "editor.json"), "utf8")).toBe(parentConfig);
    expect(existsSync(join(parent, "surfaces/android-widgets.tsx"))).toBe(false);
    expect(existsSync(join(childDir, "surfaces/android-widgets.tsx"))).toBe(true);
    expect(existsSync(join(childDir, "surfaces/apple-today.tsx"))).toBe(false);
    const childEndpoint = `/${child.projectId}/ecosystem`;
    expect((await api(childEndpoint)).body.managedByParent).toBe(true);
    expect((await api(childEndpoint, "POST", { modules: [] })).status).toBe(409);

    const started = await api(`/${child.projectId}/build`, "POST", {});
    expect(started.status).toBe(202);
    const deadline = Date.now() + 60_000;
    let childStatus = (await api(`/${child.projectId}/status`)).body;
    while (childStatus.busy && Date.now() < deadline) {
      await Bun.sleep(50);
      childStatus = (await api(`/${child.projectId}/status`)).body;
    }
    expect(childStatus.error).toBeUndefined();
    expect(childStatus.builtRevision).toBe(childStatus.revision);
    expect(existsSync(join(workspace, "builds", child.projectId, String(childStatus.revision), "app.qjbc"))).toBe(true);
    expect(existsSync(join(workspace, "builds", child.projectId, String(childStatus.revision), "app.pak"))).toBe(true);

    await server!.stop(true);
    await boot();
    const reloaded = (await api(endpoint)).body;
    expect(reloaded.companion.projectId).toBe(child.projectId);
    expect(reloaded.modules).toEqual(first.body.modules);
    const noOp = (await api(endpoint, "POST", selection)).body;
    expect(noOp.companion.status.revision).toBe(childStatus.revision);
    expect(noOp.companion.status.builtRevision).toBe(childStatus.builtRevision);
    const legacy = (await api(endpoint, "POST", { modules: selection.modules })).body;
    expect(legacy.modules).toEqual(first.body.modules);
    expect(legacy.config.ecosystemModules).toEqual(["apple-today"]);
    expect(existsSync(join(parent, "surfaces/android-widgets.tsx"))).toBe(false);

    const removed = (await api(endpoint, "POST", { mode: "companion", modules: ["apple-today"] })).body;
    expect(removed.companion.modules).toEqual([]);
    expect(existsSync(join(childDir, "surfaces/android-widgets.tsx"))).toBe(true);
    const restored = (await api(endpoint, "POST", selection)).body;
    expect(restored.companion.projectId).toBe(child.projectId);
    expect(restored.companion.status.revision).toBe(childStatus.revision + 2);
    expect(restored.status.revision).toBe(legacy.status.revision);
  } finally {
    await server?.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
}, 90_000);
