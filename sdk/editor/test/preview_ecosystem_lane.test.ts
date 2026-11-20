import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { scaffoldEcosystemModules } from "../../scripts/ecosystem_scaffold.ts";
import { createPreviewManager } from "../preview.ts";

const projectId = "companion-preview";
const base = `http://127.0.0.1/api/projects/${projectId}/preview`;

test("the ecosystem lane is explicit and cannot use the primary host or Bluetooth", async () => {
  const manager = createPreviewManager();
  const configured = createPreviewManager({
    projectPreviewHost: () => ({ status: "invalid" }),
  });
  try {
    const page = await manager.handle(new Request(`${base}?lane=ecosystem`), projectId);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-preview-lane="ecosystem"');
    const primary = await manager.handle(new Request(base), projectId);
    expect(await primary.text()).not.toContain('data-preview-lane="ecosystem"');

    for (const search of ["?lane=wrong", "?lane=ecosystem&lane=ecosystem"]) {
      expect((await manager.handle(new Request(base + search), projectId)).status).toBe(400);
    }
    const bluetooth = await manager.handle(new Request(`${base}/stream?lane=ecosystem&webBluetooth=1`), projectId);
    expect(bluetooth.status).toBe(400);
    expect(await bluetooth.text()).toContain("Bluetooth is available in the primary preview");
    const host = await configured.handle(new Request(`${base}?lane=ecosystem`), projectId);
    expect(host.status).toBe(409);
    expect(await host.text()).toContain("configured native preview host");
  } finally {
    await Promise.all([manager.dispose(), configured.dispose()]);
  }
});

test("widget input draws a separate native frame while the main guest keeps its viewport", async () => {
  const root = resolve(import.meta.dir, "../../..");
  const candidates = [
    process.env.POCKET_NATIVE_PROBE,
    resolve(root, "sdk/native/target/debug/pocket_probe"),
    resolve(root, "sdk/native/target/release/pocket_probe"),
    resolve(root, "sdk/node_modules/@pocket/tools-darwin-arm64/bin/pocket_probe"),
  ];
  const probePath = candidates.find((path): path is string => Boolean(path && existsSync(path)));
  if (!probePath) throw new Error("Build the native Pocket probe or set POCKET_NATIVE_PROBE");
  const temporary = mkdtempSync(resolve(tmpdir(), "pocket-ecosystem-lane-"));
  const project = resolve(temporary, "project");
  const ecosystem = "?lane=ecosystem";
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  let main: Response | undefined;
  let companion: Response | undefined;
  try {
    cpSync(resolve(import.meta.dir, "fixtures/counter"), project, { recursive: true });
    scaffoldEcosystemModules(project, ["apple-today"], { appTitle: "Companion Widget Fixture" });
    const built = await buildGuest({ projectRoot: project, outDir: resolve(temporary, "build"), tickHz: 60 });
    manager = createPreviewManager({
      probePath,
      width: 393,
      height: 852,
      artifacts: (id) => {
        expect(id).toBe(projectId);
        return { bytecode: built.bytecode, pak: built.pak, revision: 1, tickHz: 60 };
      },
    });
    main = await manager.handle(new Request(`${base}/stream?presentation=browser`), projectId);
    expect(main.status).toBe(200);
    companion = await manager.handle(new Request(`${base}/stream${ecosystem}&presentation=browser`), projectId);
    expect(companion.status).toBe(200);
    const activeManager = manager;
    const snapshot = async (lane = "") => {
      const response = await activeManager.handle(new Request(`${base}/snapshot${lane}`), projectId);
      expect(response.status).toBe(200);
      return await response.json() as {
        status: { width: number; height: number; surface?: { profileId: string } };
        frame?: { ops?: { type: string; text?: string }[] };
      };
    };
    const surface = await manager.handle(new Request(`${base}/input${ecosystem}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "surface", profileId: "ios-widget-medium" }),
    }), projectId);
    expect(surface.status).toBe(200);
    const containsWidget = (frame: Awaited<ReturnType<typeof snapshot>>) =>
      frame.frame?.ops?.some((op) => op.type === "text" && op.text?.includes("Companion Widget Fixture"));
    let widget = await snapshot(ecosystem);
    for (let attempt = 0; attempt < 30 && !containsWidget(widget); attempt += 1) {
      await Bun.sleep(30);
      widget = await snapshot(ecosystem);
    }
    expect(widget.status).toMatchObject({ width: 338, height: 158, surface: { profileId: "ios-widget-medium" } });
    expect(containsWidget(widget)).toBe(true);

    const primary = await snapshot();
    expect(primary.status).toMatchObject({ width: 393, height: 852 });
    expect(primary.status.surface).toBeUndefined();
    expect(primary.frame?.ops?.some((op) => op.type === "text" && op.text?.includes("Independent counter fixture"))).toBe(true);
    expect(containsWidget(primary)).toBe(false);
  } finally {
    await Promise.all([main?.body?.cancel(), companion?.body?.cancel()]);
    await manager?.dispose();
    rmSync(temporary, { recursive: true, force: true });
  }
}, 30_000);
