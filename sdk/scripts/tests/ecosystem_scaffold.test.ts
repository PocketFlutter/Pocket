import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { initProject } from "../../pocket.ts";
import { buildGuest } from "../build_guest.ts";
import {
  ECOSYSTEM_MODULES,
  enabledProfileIdsForModules,
  readProjectEcosystemModules,
  resolveEcosystemModules,
  scaffoldEcosystemModules,
} from "../ecosystem_scaffold.ts";
import { createPreviewManager } from "../../editor/preview.ts";
import { getSurfaceProfile } from "../../editor/preview_device.ts";

const sdkRoot = resolve(import.meta.dir, "../..");

test("resolveEcosystemModules supports single modules, apple/android/all shorthands, and rejects unknown IDs", () => {
  expect(resolveEcosystemModules(undefined)).toEqual([]);
  expect(resolveEcosystemModules("")).toEqual([]);
  expect(resolveEcosystemModules("apple-today,android-wear")).toEqual([
    "apple-today",
    "android-wear",
  ]);
  const appleOnly = resolveEcosystemModules("apple");
  expect(appleOnly).toEqual([
    "apple-devices",
    "apple-today",
    "apple-lock",
    "apple-live-activity",
    "apple-watch",
    "apple-clip",
  ]);
  const all = resolveEcosystemModules("all");
  expect(all.length).toBe(ECOSYSTEM_MODULES.length);
  expect(() => resolveEcosystemModules("unknown-pack")).toThrow(/unknown ecosystem\/widget module/i);
});

test("default initProject stays 100% minimal with zero surface files or preload bloat", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pocket-minimal-init-"));
  try {
    const projectDir = join(workspace, "clean-starter");
    await initProject(projectDir, { sdkRoot, template: "app", name: "Clean Starter" });

    expect(existsSync(join(projectDir, "surfaces"))).toBe(false);
    expect(existsSync(join(projectDir, "flutter/pocket_surfaces.json"))).toBe(false);

    const pocketJson = JSON.parse(readFileSync(join(projectDir, "pocket.json"), "utf8"));
    const editorJson = JSON.parse(readFileSync(join(projectDir, "editor.json"), "utf8"));
    const appSource = readFileSync(join(projectDir, "app.tsx"), "utf8");
    const templateSource = readFileSync(join(sdkRoot, "templates/app/app.tsx"), "utf8");

    expect(pocketJson.surfaces).toBeUndefined();
    expect(editorJson.ecosystemModules).toBeUndefined();
    expect(appSource).toBe(templateSource);
    expect(readProjectEcosystemModules(projectDir)).toEqual([]);
    expect(enabledProfileIdsForModules([])).toEqual([]);

    const outDir = join(workspace, "out-clean");
    const built = await buildGuest({ projectRoot: projectDir, outDir });
    expect(existsSync(built.bytecode)).toBe(true);
    const bundledJs = readFileSync(built.source, "utf8");
    expect(bundledJs).not.toContain("TodayWidgetCard");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("on-demand ecosystem scaffolding creates modular surfaces, preserves user edits on incremental add, and renders live in PreviewManager", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pocket-ondemand-surfaces-"));
  try {
    const projectDir = join(workspace, "ondemand-app");
    await initProject(projectDir, {
      sdkRoot,
      template: "app",
      name: "Pulse",
      surfaces: ["apple-today"],
    });

    expect(readProjectEcosystemModules(projectDir)).toEqual(["apple-today"]);
    expect(existsSync(join(projectDir, "surfaces/apple-today.tsx"))).toBe(true);
    expect(existsSync(join(projectDir, "surfaces/android-wear.tsx"))).toBe(false);
    expect(existsSync(join(projectDir, "surfaces/index.tsx"))).toBe(true);

    // Ensure flutter/ host descriptor is written when flutter/ host exists
    mkdirSync(join(projectDir, "flutter"), { recursive: true });

    // Customize apple-today.tsx and verify incremental --add preserves user edits!
    const customTodayPath = join(projectDir, "surfaces/apple-today.tsx");
    const customizedSource = readFileSync(customTodayPath, "utf8").replace(
      "Pulse",
      "CUSTOM_TODAY_BADGE",
    );
    writeFileSync(customTodayPath, customizedSource, "utf8");

    const added = scaffoldEcosystemModules(projectDir, ["android-wear"], {
      mode: "add",
      appTitle: "Pulse",
    });
    expect(added.modules).toEqual(["apple-today", "android-wear"]);
    expect(added.createdFiles).not.toContain("surfaces/apple-today.tsx");
    expect(added.createdFiles).toContain("surfaces/android-wear.tsx");
    expect(existsSync(join(projectDir, "flutter/pocket_surfaces.json"))).toBe(true);
    expect(readFileSync(customTodayPath, "utf8")).toContain("CUSTOM_TODAY_BADGE");
    expect(existsSync(join(projectDir, "surfaces/android-wear.tsx"))).toBe(true);
    expect(enabledProfileIdsForModules(added.modules)).toEqual([
      "iphone-16-pro",
      "pixel-9",
      "ios-widget-small",
      "ios-widget-medium",
      "ios-widget-large",
      "ipad-widget-xl",
      "wear-os-round",
      "wear-os-tile",
    ]);

    // Compile real QuickJS bytecode + pak and run live inside Studio PreviewManager!
    const artifactDir = join(workspace, "out-ondemand");
    const built = await buildGuest({ projectRoot: projectDir, outDir: artifactDir });

    const probePath = join(sdkRoot, "node_modules/@pocket/tools-darwin-arm64/bin/pocket_probe");
    if (!existsSync(probePath)) return;

    const projectId = "ondemand-app";
    const base = `https://preview.local/api/projects/${projectId}/preview`;
    const manager = createPreviewManager({
      probePath,
      width: 393,
      height: 852,
      idleDisposeMs: 5_000,
      artifacts: {
        bytecode: built.bytecode,
        pak: built.pak,
        projectDirectory: projectDir,
        revision: 1,
        tickHz: 60,
      },
    });

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const stream = await manager.handle(
        new Request(`${base}/stream?presentation=browser`),
        projectId,
        "stream",
      );
      expect(stream.status).toBe(200);
      reader = stream.body!.getReader();
      await reader.read();

      const getSnap = async () => {
        const res = await manager.handle(new Request(`${base}/snapshot`), projectId, "snapshot");
        return (await res.json()) as Record<string, any>;
      };
      const frameTexts = (snap: Record<string, any>) =>
        ((snap.frame?.ops ?? []) as Array<Record<string, any>>)
          .filter((op) => op.type === "text")
          .map((op) => op.text)
          .join(" | ");

      for (let i = 0; i < 25; i += 1) {
        const snap = await getSnap();
        if (frameTexts(snap).length > 0) break;
        await new Promise((r) => setTimeout(r, 30));
      }

      // Switch to scaffolded Apple Today Medium widget -> renders customized widget!
      await manager.handle(
        new Request(`${base}/input`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "surface",
            profileId: "ios-widget-medium",
            renderMode: "accented",
          }),
        }),
        projectId,
        "input",
      );
      await new Promise((r) => setTimeout(r, 40));
      await manager.handle(
        new Request(`${base}/input`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "surface",
            profileId: "ios-widget-medium",
            renderMode: "accented",
          }),
        }),
        projectId,
        "input",
      );
      const todaySnap = await getSnap();
      expect(todaySnap.status.width).toBe(getSurfaceProfile("ios-widget-medium")!.width);
      expect(frameTexts(todaySnap)).toContain("CUSTOM_TODAY_BADGE");
      expect(todaySnap.widgetSnapshot?.hotspots?.length).toBeGreaterThanOrEqual(1);

      // Switch to incrementally added Wear OS Tile -> renders tile!
      await manager.handle(
        new Request(`${base}/input`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "surface",
            profileId: "wear-os-tile",
            renderMode: "alwaysOn",
          }),
        }),
        projectId,
        "input",
      );
      await new Promise((r) => setTimeout(r, 40));
      await manager.handle(
        new Request(`${base}/input`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "surface",
            profileId: "wear-os-tile",
            renderMode: "alwaysOn",
          }),
        }),
        projectId,
        "input",
      );
      const wearSnap = await getSnap();
      expect(wearSnap.status.width).toBe(getSurfaceProfile("wear-os-tile")!.width);
      expect(frameTexts(wearSnap)).toContain("WEAR OS TILE");

      // Clearing modules drops @pocket/ui/surfaces bundle overhead back to zero while preserving custom files
      const cleared = scaffoldEcosystemModules(projectDir, [], { mode: "set" });
      expect(cleared.modules).toEqual([]);
      expect(existsSync(join(projectDir, "flutter/pocket_surfaces.json"))).toBe(false);
      expect(readFileSync(customTodayPath, "utf8")).toContain("CUSTOM_TODAY_BADGE");
      const outCleared = join(workspace, "out-cleared");
      const builtCleared = await buildGuest({ projectRoot: projectDir, outDir: outCleared });
      expect(readFileSync(builtCleared.source, "utf8")).not.toContain("TodayWidgetCard");
    } finally {
      await reader?.cancel().catch(() => undefined);
      await manager.dispose();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("scaffoldEcosystemModules wires apple-clip and android-instant into SurfaceDispatcher", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pocket-clip-surfaces-"));
  try {
    const projectDir = join(workspace, "clip-app");
    await initProject(projectDir, {
      sdkRoot,
      template: "app",
      name: "ClipDemo",
      surfaces: ["apple-clip", "android-instant"],
    });
    const indexSource = readFileSync(join(projectDir, "surfaces/index.tsx"), "utf8");
    expect(indexSource).toContain('import { AppleAppClipBanner } from "./apple-clip.tsx"');
    expect(indexSource).toContain('import { AndroidInstantBanner } from "./android-instant.tsx"');
    expect(indexSource).toContain('env().ecosystem === "apple" && env().kind === "clip"');
    expect(indexSource).toContain('env().ecosystem === "android" && env().kind === "clip"');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

