import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { parseFlutterDevices } from "../devices.ts";
import { createPreviewManager } from "../preview.ts";
import { ECOSYSTEM_SURFACE_PROFILES, getSurfaceProfile, previewDevice } from "../preview_device.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const demoRoot = resolve(sdkRoot, "../demo");
const probeCandidates = process.env.POCKET_NATIVE_PROBE
  ? [resolve(process.env.POCKET_NATIVE_PROBE)]
  : [
      join(sdkRoot, "node_modules/@pocket/tools-darwin-arm64/bin/pocket_probe"),
      join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
      join(sdkRoot, "native/target/release/pocket_probe"),
      join(sdkRoot, "native/target/debug/pocket_probe"),
    ];
const probe = probeCandidates.find(existsSync);

test("previewDevice exposes all 38 Apple/Android ecosystem & widget profiles and Editor client binds them cleanly", () => {
  expect(previewDevice.profiles).toBe(ECOSYSTEM_SURFACE_PROFILES);
  expect(previewDevice.profiles.length).toBe(38);

  const groups = new Set(previewDevice.profiles.map((item) => item.group));
  expect([...groups].sort()).toEqual([
    "android-device",
    "android-widget",
    "apple-device",
    "apple-widget",
  ]);

  const html = readFileSync(join(sdkRoot, "editor/client/index.html"), "utf8");
  const editorJs = readFileSync(join(sdkRoot, "editor/client/editor.js"), "utf8");
  const previewJs = readFileSync(join(sdkRoot, "editor/client/preview.js"), "utf8");

  expect(html).toContain('id="surface-render-mode"');
  expect(html).toContain('id="widget-companion-jump"');
  expect(html).toContain('id="open-ecosystem-builder"');
  expect(html).toContain('id="ecosystem-panel"');
  expect(html).toContain('id="create-ecosystem-list"');
  expect(html).toContain('class="preview-macos-titlebar"');
  expect(html).toContain('class="preview-fold-hinge"');
  expect(html).toContain('class="preview-watch-crown"');
  expect(editorJs).toContain('"apple-device"');
  expect(editorJs).toContain('"apple-widget"');
  expect(editorJs).toContain('"android-device"');
  expect(editorJs).toContain('"android-widget"');
  expect(editorJs).toContain("enabledProfileSetForModules");
  expect(editorJs).toContain("/ecosystem");
  expect(editorJs).toContain('"preview.surface"');
  expect(editorJs).toContain('"preview.widget-snapshot"');
  expect(previewJs).toContain('message.type === "preview.surface"');
  expect(previewJs).toContain('announce("preview.widget-snapshot"');
});

test("parseFlutterDevices classifies Apple Watch, Apple TV, Vision Pro, Mac, Android Foldable, and Wear OS targets", () => {
  const devices = parseFlutterDevices(
    JSON.stringify([
      {
        id: "watch-sim-1",
        name: "Apple Watch Ultra 2 (49mm)",
        targetPlatform: "darwin-arm64",
        sdk: "watchOS 11.2 Simulator",
        emulator: true,
      },
      {
        id: "tv-sim-1",
        name: "Apple TV 4K (3rd generation)",
        targetPlatform: "darwin-arm64",
        sdk: "tvOS 18.2 Simulator",
        emulator: true,
      },
      {
        id: "vision-sim-1",
        name: "Apple Vision Pro",
        targetPlatform: "darwin-arm64",
        sdk: "xrsimulator 2.2",
        emulator: true,
      },
      {
        id: "macos",
        name: "macOS",
        targetPlatform: "darwin-arm64",
        sdk: "macOS 15.2",
        emulator: false,
        category: "desktop",
      },
      {
        id: "emulator-5556",
        name: "Pixel 9 Pro Fold",
        targetPlatform: "android-arm64",
        sdk: "Android 16 (API 36)",
        emulator: true,
      },
      {
        id: "emulator-5558",
        name: "Wear OS Large Round",
        targetPlatform: "android-arm64",
        sdk: "Wear OS 5",
        emulator: true,
      },
    ]),
  );

  expect(
    devices.map((d) => ({
      id: d.id,
      platform: d.platform,
      kind: d.kind,
      ecosystem: d.ecosystem,
      formFactor: d.formFactor,
    })),
  ).toEqual([
    { id: "watch-sim-1", platform: "ios", kind: "ios-simulator", ecosystem: "apple", formFactor: "watch" },
    { id: "tv-sim-1", platform: "ios", kind: "ios-simulator", ecosystem: "apple", formFactor: "tv" },
    { id: "vision-sim-1", platform: "ios", kind: "ios-simulator", ecosystem: "apple", formFactor: "spatial" },
    { id: "macos", platform: "macos", kind: "other", ecosystem: "apple", formFactor: "desktop" },
    { id: "emulator-5556", platform: "android", kind: "android-emulator", ecosystem: "android", formFactor: "foldable" },
    { id: "emulator-5558", platform: "android", kind: "android-emulator", ecosystem: "android", formFactor: "watch" },
  ]);
});

test(
  "PreviewManager switches single-engine Showcase QJBC live across Apple/Android widgets, foldables, and companion deep links",
  { timeout: 60_000 },
  async () => {
    assert.ok(probe, `pocket_probe is required: ${probeCandidates.join(", ")}`);
    const bytecode = join(demoRoot, "assets/app.qjbc");
    const pak = join(demoRoot, "assets/app.pak");
    assert.ok(existsSync(bytecode) && existsSync(pak), "Showcase bytecode/pak must exist");

    const projectId = "ecosystem-preview";
    const base = `http://127.0.0.1/api/projects/${projectId}/preview`;
    const manager = createPreviewManager({
      probePath: probe,
      width: 393,
      height: 852,
      idleDisposeMs: 5_000,
      artifacts: {
        bytecode,
        pak,
        projectDirectory: join(demoRoot, "js"),
        revision: 1,
        tickHz: 60,
      },
    });

    const postInput = async (payload: Record<string, unknown>): Promise<Response> =>
      manager.handle(
        new Request(`${base}/input`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
        projectId,
        "input",
      );

    const getSnapshot = async (): Promise<Record<string, any>> => {
      const res = await manager.handle(new Request(`${base}/snapshot`), projectId, "snapshot");
      assert.equal(res.status, 200);
      return (await res.json()) as Record<string, any>;
    };

    const frameTexts = (snap: Record<string, any>): string =>
      ((snap.frame?.ops ?? []) as Array<Record<string, any>>)
        .filter((op) => op.type === "text" && typeof op.text === "string")
        .map((op) => op.text)
        .join(" | ");

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const stream = await manager.handle(
        new Request(`${base}/stream?presentation=browser`),
        projectId,
        "stream",
      );
      assert.equal(stream.status, 200);
      reader = stream.body!.getReader();
      await reader.read();

      for (let attempt = 0; attempt < 30; attempt += 1) {
        const bootSnap = await getSnapshot();
        if (bootSnap.status.error) throw new Error(`Preview boot error: ${bootSnap.status.error}`);
        if (frameTexts(bootSnap).length > 0) break;
        await new Promise((r) => setTimeout(r, 30));
      }

      // 1. Switch live to Apple Today Medium Widget (338x158, accented mode)
      const widgetProfile = getSurfaceProfile("ios-widget-medium")!;
      const widgetRes = await postInput({
        type: "surface",
        profileId: widgetProfile.id,
        renderMode: "accented",
      });
      assert.equal(widgetRes.status, 200);
      await new Promise((r) => setTimeout(r, 40));
      await postInput({
        type: "surface",
        profileId: widgetProfile.id,
        renderMode: "accented",
      });

      const widgetSnap = await getSnapshot();
      expect(widgetSnap.status.width).toBe(338);
      expect(widgetSnap.status.height).toBe(158);
      expect(widgetSnap.status.surface).toMatchObject({
        profileId: "ios-widget-medium",
        ecosystem: "apple",
        kind: "widget",
        family: "systemMedium",
        renderMode: "accented",
        isSystemSurface: true,
      });
      expect(frameTexts(widgetSnap)).toContain("POCKET TODAY");
      expect(frameTexts(widgetSnap)).toContain("Single Engine");
      expect(Array.isArray(widgetSnap.widgetSnapshot?.hotspots)).toBe(true);
      expect(widgetSnap.widgetSnapshot.hotspots.length).toBeGreaterThanOrEqual(2);
      expect(
        widgetSnap.widgetSnapshot.hotspots.some((h: any) =>
          String(h.href).startsWith("pocket://showcase/"),
        ),
      ).toBe(true);

      // 2. Switch live to Dynamic Island Compact -> sensor occlusion preserved
      const compactIsland = getSurfaceProfile("ios-island-compact")!;
      const islandRes = await postInput({
        type: "surface",
        profileId: "ios-island-compact",
      });
      assert.equal(islandRes.status, 200);
      const islandSnap = await getSnapshot();
      expect(islandSnap.status.width).toBe(compactIsland.width);
      expect(islandSnap.status.height).toBe(compactIsland.height);
      expect(frameTexts(islandSnap)).toContain("PKT");
      expect(frameTexts(islandSnap)).toContain("120Hz");

      // 3. Switch live to Wear OS Round Tile (196x196, alwaysOn)
      const tileProfile = getSurfaceProfile("wear-os-tile")!;
      const tileRes = await postInput({
        type: "surface",
        profileId: "wear-os-tile",
        renderMode: "alwaysOn",
      });
      assert.equal(tileRes.status, 200);
      const tileSnap = await getSnapshot();
      expect(tileSnap.status.width).toBe(tileProfile.width);
      expect(tileSnap.status.height).toBe(tileProfile.height);
      expect(tileSnap.status.surface.renderMode).toBe("alwaysOn");
      expect(frameTexts(tileSnap)).toContain("WEAR OS TILE");

      // 4. Companion deep-link jump from widget -> Android Unfolded Foldable (android-fold-open)
      const foldProfile = getSurfaceProfile("android-fold-open")!;
      const foldRes = await postInput({
        type: "surface",
        profileId: "android-fold-open",
        openUri: "pocket://showcase/ecosystem?from=wear-os-tile",
      });
      assert.equal(foldRes.status, 200);
      await new Promise((r) => setTimeout(r, 40));
      await postInput({
        type: "surface",
        profileId: "android-fold-open",
      });
      const foldSnap = await getSnapshot();
      expect(foldSnap.status.width).toBe(foldProfile.width);
      expect(foldSnap.status.height).toBe(foldProfile.height);
      expect(foldSnap.status.surface.isSystemSurface).toBe(false);
      const foldTexts = frameTexts(foldSnap);
      expect(foldTexts).toContain("SINGLE-ENGINE PIXEL IDENTITY");
      expect(foldTexts).toContain("ANDROID · foldable-dual");
      expect(foldTexts).toContain("LOCK ACCESSORY");
    } finally {
      await reader?.cancel().catch(() => undefined);
      await manager.dispose();
    }
  },
);
