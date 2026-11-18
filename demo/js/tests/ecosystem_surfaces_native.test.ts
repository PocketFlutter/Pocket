import { strict as assert } from "node:assert";
import { expect, test } from "bun:test";
import {
  getSurfaceProfile,
  surfaceEnvironmentFromProfile,
  surfaceGeometryForProfile,
} from "../../../sdk/packages/pocket_ui/src/surface-catalog.ts";
import {
  NativeSession,
  center,
  readNativeArtifacts,
  textOf,
  textOps,
  type DrawOp,
  type Frame,
} from "./native_session.ts";

function findVisibleText(frame: Frame, label: string): DrawOp | undefined {
  const height = frame.height ?? 760;
  return textOps(frame, label).find((op) => {
    const top = op.y ?? -Infinity;
    const bottom = top + (op.h ?? 0);
    const clipTop = Math.max(0, op.clip?.y ?? 0);
    const clipBottom = Math.min(height, (op.clip?.y ?? 0) + (op.clip?.h ?? Infinity));
    return top >= clipTop && bottom <= clipBottom;
  });
}

async function applySurfaceProfile(
  session: NativeSession,
  profileId: string,
  renderMode?: "fullColor" | "vibrant" | "accented" | "alwaysOn",
): Promise<Frame> {
  const profile = getSurfaceProfile(profileId);
  assert.ok(profile, `missing surface profile: ${profileId}`);
  const geo = surfaceGeometryForProfile(profile!);
  const env = surfaceEnvironmentFromProfile(profile!, { renderMode });
  await session.resize(geo.width, geo.height);
  session.sendEvent("display.viewport", {
    width: geo.width,
    height: geo.height,
    safeArea: geo.safeArea,
    ...(geo.reservedRegions.length > 0 ? { reservedRegions: geo.reservedRegions } : {}),
  });
  session.sendEvent("platform.surface", env as unknown as Record<string, unknown>);
  return session.settle(await session.frame(), 6);
}

test(
  "single-engine Showcase QJBC renders Ecosystem Lab, unfolded Foldable dual-pane, and Apple/Android system widgets identically",
  { timeout: 45_000 },
  async () => {
    const session = new NativeSession(readNativeArtifacts("POCKET_ECOSYSTEM"), {
      width: 393,
      height: 852,
    });
    try {
      let frame = await session.boot();

      // 1. Deep-link directly to /ecosystem (and alias /widgets) on iPhone 16 Pro
      session.sendEvent("router.open", { url: "pocket://showcase/widgets?skin=arc" });
      frame = await session.settle(await session.frame(), 20);
      expect(textOf(frame)).toContain("Ecosystem & Widgets");
      expect(textOf(frame)).toContain("SINGLE-ENGINE PIXEL IDENTITY");
      expect(textOf(frame)).toContain("Apple & Android Ecosystem + Widgets");

      // Tap "Accented" render mode chip inside Ecosystem Lab
      const accentedChip = findVisibleText(frame, "Accented");
      assert.ok(accentedChip, `expected Accented mode chip\n${textOf(frame)}`);
      frame = await session.settle(await session.tapPoint(center(accentedChip!, "Accented")), 8);
      expect(textOf(frame)).toContain("accented");

      // 2. Project exact same compiled QJBC into Apple Today Widget (338x158)
      session.widgetSnapshots.length = 0;
      frame = await applySurfaceProfile(session, "ios-widget-medium", "vibrant");
      expect(frame.width).toBe(338);
      expect(frame.height).toBe(158);
      expect(textOf(frame)).toContain("POCKET TODAY");
      expect(textOf(frame)).toContain("Arc Neon · Single Engine");
      expect(session.widgetSnapshots.length).toBeGreaterThan(0);

      const latestWidgetSnap = session.widgetSnapshots.at(-1)!;
      expect(Array.isArray(latestWidgetSnap.hotspots)).toBe(true);
      expect(latestWidgetSnap.hotspots.length).toBeGreaterThanOrEqual(2);
      for (const spot of latestWidgetSnap.hotspots) {
        expect(spot.rect.x).toBeGreaterThanOrEqual(0);
        expect(spot.rect.y).toBeGreaterThanOrEqual(0);
        expect(spot.rect.width).toBeGreaterThan(0);
        expect(spot.rect.height).toBeGreaterThan(0);
        expect(spot.rect.x + spot.rect.width).toBeLessThanOrEqual(338);
        expect(spot.rect.y + spot.rect.height).toBeLessThanOrEqual(158);
      }

      // 3. Project into iOS Lock Screen Circular & Rectangular Accessories
      frame = await applySurfaceProfile(session, "ios-lock-rectangular", "vibrant");
      expect(frame.width).toBe(172);
      expect(frame.height).toBe(76);
      expect(textOf(frame)).toContain("POCKET QJBC");

      // 4. Project into Dynamic Island Expanded Live Activity & Android At-a-Glance
      const expandedIsland = getSurfaceProfile("ios-live-activity-expanded")!;
      frame = await applySurfaceProfile(session, "ios-live-activity-expanded", "fullColor");
      expect(frame.width).toBe(expandedIsland.width);
      expect(frame.height).toBe(expandedIsland.height);
      expect(textOf(frame)).toContain("PKT");
      expect(textOf(frame)).toContain("120Hz");

      const glanceProfile = getSurfaceProfile("android-at-a-glance")!;
      frame = await applySurfaceProfile(session, "android-at-a-glance", "accented");
      expect(frame.width).toBe(glanceProfile.width);
      expect(frame.height).toBe(glanceProfile.height);
      expect(textOf(frame)).toContain("Pocket · Arc Neon Active");

      // 5. Project into Round Wear OS Tile (alwaysOn)
      const wearTileProfile = getSurfaceProfile("wear-os-tile")!;
      frame = await applySurfaceProfile(session, "wear-os-tile", "alwaysOn");
      expect(frame.width).toBe(wearTileProfile.width);
      expect(frame.height).toBe(wearTileProfile.height);
      expect(textOf(frame)).toContain("WEAR OS TILE");

      // 6. Switch to Android Unfolded Foldable (android-fold-open) -> dual-pane around hinge
      const foldProfile = getSurfaceProfile("android-fold-open")!;
      frame = await applySurfaceProfile(session, "android-fold-open", "fullColor");
      expect(frame.width).toBe(foldProfile.width);
      expect(frame.height).toBe(foldProfile.height);
      const foldText = textOf(frame);
      expect(foldText).toContain("ANDROID · foldable-dual");
      expect(foldText).toContain("SINGLE-ENGINE PIXEL IDENTITY");
      expect(foldText).toContain("LOCK ACCESSORY");
      expect(foldText).toContain("WATCH / WEAR TILE");

      const leftHeading = findVisibleText(frame, "SINGLE-ENGINE PIXEL IDENTITY");
      const rightHeading = findVisibleText(frame, "LOCK ACCESSORY");
      assert.ok(leftHeading && rightHeading, "both foldable panes must mount simultaneously");
      const hinge = foldProfile.reservedRegions[0]!.frame;
      expect((leftHeading!.x ?? 0) + (leftHeading!.w ?? 0)).toBeLessThanOrEqual(hinge.left + 2);
      expect(rightHeading!.x ?? 0).toBeGreaterThanOrEqual(hinge.left + hinge.width - 2);

      // 7. Switch to Apple Watch 45mm -> watch layout branch
      const watchProfile = getSurfaceProfile("apple-watch-45mm")!;
      frame = await applySurfaceProfile(session, "apple-watch-45mm", "fullColor");
      expect(frame.width).toBe(watchProfile.width);
      expect(frame.height).toBe(watchProfile.height);
      expect(textOf(frame)).toContain("APPLE WATCH");
    } finally {
      await session.quit();
    }
  },
);
