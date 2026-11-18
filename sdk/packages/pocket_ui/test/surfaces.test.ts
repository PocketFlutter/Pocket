import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

mock.module("react/jsx-dev-runtime", () => ({
  Fragment: Symbol.for("surfaces-test-fragment"),
  jsx: (type: unknown, props: unknown) => ({ type, props }),
  jsxs: (type: unknown, props: unknown) => ({ type, props }),
  jsxDEV: (type: unknown, props: unknown) => ({ type, props }),
}));
mock.module("solid-js", () => ({
  For: () => undefined,
  Show: (props: { when: unknown; children?: unknown }) =>
    typeof props.children === "function" ? props.children(props.when) : props.children,
  children: (value: unknown) => value,
  createContext: (value?: unknown) => ({
    defaultValue: value,
    Provider: (props: { children?: unknown }) => props.children,
  }),
  batch: (fn: () => unknown) => fn(),
  createEffect: () => undefined,
  createMemo: (fn: () => unknown) => fn,
  createSignal: (value: unknown) => [() => value, () => undefined],
  getOwner: () => undefined,
  onCleanup: () => undefined,
  onMount: () => undefined,
  untrack: (fn: () => unknown) => fn(),
  useContext: (ctx: { defaultValue?: unknown }) => ctx?.defaultValue,
}));
mock.module("@pocketjs/framework/gesture", () => ({ createGesture: () => ({}) }));
mock.module("@pocketjs/framework/kinetics", () => ({
  bindDpadScroll: () => () => {},
  createScroller: () => ({}),
}));
mock.module("@pocketjs/framework/host", () => ({
  getOps: () => ({}),
  hostViewport: () => ({ w: 390, h: 844 }),
}));
mock.module("@pocketjs/framework/solid/components", () => ({
  CompositorSurface: () => undefined,
  Focusable: () => undefined,
  Grid: () => undefined,
  Image: () => undefined,
  Modal: () => undefined,
  Portal: () => undefined,
  Screen: () => undefined,
  Text: () => undefined,
  View: () => undefined,
}));
mock.module("@pocketjs/framework/solid/lifecycle", () => ({
  onFrame: () => undefined,
}));
mock.module("@pocketjs/framework/clock", () => ({
  after: () => () => {},
  simulationHz: () => 60,
  virtualNow: () => 0,
}));

const { availableDisplayPanes, deriveResponsiveLayout } = await import("../src/responsive.ts");
const { resolveDefaultSkinTokens } = await import("../src/skins.tsx");
const { isUnsupportedPlatformError } = await import("../src/platform-experience.ts");
const {
  DEFAULT_SURFACE_ENVIRONMENT,
  ECOSYSTEM_SURFACE_PROFILES,
  WIDGET_ACTION_EVENT,
  WIDGET_SNAPSHOT_EVENT,
  createWidgetSnapshotStore,
  deriveSurfaceFormFactor,
  getSurfaceProfile,
  inscribedRoundInset,
  listSurfaceProfiles,
  parseSurfaceEnvironment,
  publishWidgetSnapshot,
  resolveSurfacePalette,
  surfaceEnvironmentFromProfile,
  surfaceGeometryForProfile,
} = await import("../src/surfaces.tsx");
const { parseClassLiteral, unknownUtilities } = await import(
  "../../../.cache/pocketjs/framework/compiler/tailwind.ts"
);

describe("@pocket/ui/surfaces ecosystem & widget contract", () => {
  test("covers Apple & Android full-ecosystem devices and system widgets within 10-bit pointer wire [1, 1023]", () => {
    expect(ECOSYSTEM_SURFACE_PROFILES.length).toBeGreaterThanOrEqual(28);
    const ids = new Set<string>();
    for (const profile of ECOSYSTEM_SURFACE_PROFILES) {
      expect(ids.has(profile.id)).toBe(false);
      ids.add(profile.id);
      expect(Number.isInteger(profile.width)).toBe(true);
      expect(Number.isInteger(profile.height)).toBe(true);
      expect(profile.width).toBeGreaterThanOrEqual(1);
      expect(profile.width).toBeLessThanOrEqual(1023);
      expect(profile.height).toBeGreaterThanOrEqual(1);
      expect(profile.height).toBeLessThanOrEqual(1023);
      expect(profile.supportedRenderModes).toContain(profile.defaultRenderMode);
      if (profile.isSystemSurface) {
        expect(profile.companionDeviceId).toBeTruthy();
        expect(getSurfaceProfile(profile.companionDeviceId!)).toBeDefined();
      }
    }

    expect(listSurfaceProfiles({ ecosystem: "apple", isSystemSurface: false }).length).toBeGreaterThanOrEqual(9);
    expect(listSurfaceProfiles({ ecosystem: "apple", isSystemSurface: true }).length).toBeGreaterThanOrEqual(10);
    expect(listSurfaceProfiles({ ecosystem: "android", isSystemSurface: false }).length).toBeGreaterThanOrEqual(6);
    expect(listSurfaceProfiles({ ecosystem: "android", isSystemSurface: true }).length).toBeGreaterThanOrEqual(6);

    expect(getSurfaceProfile("mobile")?.id).toBe("iphone-16-pro");
    expect(getSurfaceProfile("tablet")?.id).toBe("ipad-pro");
    expect(getSurfaceProfile("desktop")?.id).toBe("macos-window");
  });

  test("unfolded Android foldable publishes central hinge division and splits into two non-overlapping panes", () => {
    const foldOpen = getSurfaceProfile("android-fold-open")!;
    const geometry = surfaceGeometryForProfile(foldOpen);
    const layout = deriveResponsiveLayout(geometry);
    expect(layout.mode).toBe("wide");
    expect(layout.division?.id).toBe("display-feature-hinge");

    const panes = availableDisplayPanes(geometry);
    expect(panes.length).toBe(2);
    expect(panes[0]!.width).toBe(416);
    expect(panes[1]!.left).toBe(424);
    expect(panes[1]!.width).toBe(416);

    const env = surfaceEnvironmentFromProfile(foldOpen);
    expect(deriveSurfaceFormFactor(geometry, env)).toBe("foldable-dual");
  });

  test("round Wear OS watch & tile compute inscribed safe inset and Dynamic Island compact preserves sensor cutout", () => {
    expect(inscribedRoundInset(227, 227)).toBe(34);
    const wearTile = getSurfaceProfile("wear-os-tile")!;
    expect(wearTile.screenShape).toBe("round");
    expect(wearTile.contentPadding).toBe(34);

    const islandCompact = getSurfaceProfile("ios-island-compact")!;
    expect(islandCompact.reservedRegions.length).toBe(1);
    expect(islandCompact.reservedRegions[0]!.id).toBe("dynamic-island-cutout");
    expect(islandCompact.reservedRegions[0]!.frame).toEqual({
      left: 74,
      top: 0,
      width: 88,
      height: 37,
    });
  });

  test("parses platform.surface events and resolves fullColor, vibrant, accented, and alwaysOn palettes", () => {
    const parsed = parseSurfaceEnvironment({
      profileId: "ios-lock-rectangular",
      renderMode: "vibrant",
      entryUri: "pocket://showcase/stress",
    });
    expect(parsed.profileId).toBe("ios-lock-rectangular");
    expect(parsed.ecosystem).toBe("apple");
    expect(parsed.kind).toBe("lock-accessory");
    expect(parsed.family).toBe("accessoryRectangular");
    expect(parsed.isSystemSurface).toBe(true);
    expect(parsed.renderMode).toBe("vibrant");
    expect(parsed.entryUri).toBe("pocket://showcase/stress");

    const tokens = resolveDefaultSkinTokens("light", "blue");
    for (const mode of ["fullColor", "vibrant", "accented", "alwaysOn"] as const) {
      const palette = resolveSurfacePalette(tokens, mode);
      expect(palette.mode).toBe(mode);
      expect(palette.surfaceBg).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(palette.border).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(palette.primaryInk).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    expect(DEFAULT_SURFACE_ENVIRONMENT.profileId).toBe("iphone-16-pro");
  });

  test("collects committed WidgetActionLink hotspots, deduplicates snapshots, and dispatches widget.action", async () => {
    const globalObj = globalThis as typeof globalThis & {
      pocket?: { getLayouts?: (ids: readonly number[]) => unknown[] };
    };
    const previousPocket = globalObj.pocket;
    const emitted: Array<{ method: string; params: Record<string, unknown> }> = [];
    let eventHandler: ((event: any) => void) | undefined;

    globalObj.pocket = {
      getLayouts: (ids) =>
        ids.map((id) => ({
          x: id * 10,
          y: 14,
          width: 120,
          height: 42,
        })),
    };

    try {
      const env = surfaceEnvironmentFromProfile(getSurfaceProfile("ios-widget-medium")!);
      const store = createWidgetSnapshotStore({
        environment: () => env,
        bridge: {
          emit: (method, params) => {
            emitted.push({ method, params: params as Record<string, unknown> });
            return true;
          },
          onEvent: (listener) => {
            eventHandler = listener;
            return () => {
              eventHandler = undefined;
            };
          },
        },
      });

      let activatedHref = "";
      const refBind = store.register({
        id: "open-stress",
        label: "Open Stress Lab",
        href: "pocket://showcase/stress?skin=arc",
        role: "button",
        onActivate: (href) => {
          activatedHref = href;
        },
      });

      refBind({ id: 7 } as any);
      expect(store.flush()).toBe(true);
      expect(emitted.length).toBe(1);
      expect(emitted[0]!.method).toBe(WIDGET_SNAPSHOT_EVENT);
      expect(emitted[0]!.params).toEqual({
        generation: 1,
        profileId: "ios-widget-medium",
        renderMode: "fullColor",
        hotspots: [
          {
            id: "open-stress",
            nativeId: 7,
            label: "Open Stress Lab",
            href: "pocket://showcase/stress?skin=arc",
            role: "button",
            rect: { x: 70, y: 14, width: 120, height: 42 },
          },
        ],
      });

      expect(store.flush()).toBe(true);
      expect(emitted.length).toBe(1);

      eventHandler?.({
        id: "evt-1",
        method: WIDGET_ACTION_EVENT,
        params: { id: "open-stress" },
        raw: {},
      });
      expect(activatedHref).toBe("pocket://showcase/stress?skin=arc");

      let publishedCapability = "";
      let publishedParams: unknown;
      await publishWidgetSnapshot(
        {
          request: async (cap, params) => {
            publishedCapability = cap;
            publishedParams = params;
            return { accepted: true } as any;
          },
        },
        store.snapshot(),
      );
      expect(publishedCapability).toBe("platform.widgets.publishSnapshot");
      expect((publishedParams as any).hotspots.length).toBe(1);

      store.dispose();
      expect(emitted.at(-1)?.params.hotspots).toEqual([]);
    } finally {
      globalObj.pocket = previousPocket;
    }

    expect(isUnsupportedPlatformError({ code: "unsupported_capability" })).toBe(true);
  });

  test("every JSX class literal in surfaces.tsx compiles cleanly under --strict-classes", () => {
    const testDir = resolve(fileURLToPath(import.meta.url), "..");
    const src = readFileSync(join(testDir, "../src/surfaces.tsx"), "utf8");
    for (const match of src.matchAll(/\bclass="([^"]+)"/g)) {
      const literal = match[1]!;
      expect(unknownUtilities(literal)).toEqual([]);
      expect(parseClassLiteral(literal)).not.toBeNull();
    }
  });
});
