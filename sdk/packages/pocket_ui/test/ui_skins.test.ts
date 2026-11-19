import { test, expect, mock } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

mock.module("react/jsx-dev-runtime", () => ({
  Fragment: Symbol.for("ui-skins-test-fragment"),
  jsx: (type: unknown, props: unknown) => ({ type, props }),
  jsxs: (type: unknown, props: unknown) => ({ type, props }),
  jsxDEV: (type: unknown, props: unknown) => ({ type, props }),
}));
let testSkinAdapter: (() => unknown) | undefined;

mock.module("solid-js", () => ({
  batch: (fn: () => unknown) => fn(),
  For: () => undefined,
  Show: (props: { when: unknown; children?: unknown }) =>
    typeof props.children === "function" ? props.children(props.when) : props.children,
  children: (value: unknown) => value,
  createContext: (value?: unknown) => ({
    defaultValue: value,
    Provider: (props: { children?: unknown }) => props.children,
  }),
  createEffect: () => undefined,
  createMemo: (fn: () => unknown) => fn,
  createSignal: (initial: unknown) => {
    let value = initial;
    return [() => value, (next: unknown) => {
      value = typeof next === "function" ? next(value) : next;
    }];
  },
  onCleanup: () => undefined,
  onMount: () => undefined,
  untrack: (fn: () => unknown) => fn(),
  useContext: (ctx: { defaultValue?: unknown }) => {
    const value = ctx?.defaultValue;
    if (testSkinAdapter && value && typeof value === "object" && "adapter" in value) {
      return { ...value, adapter: testSkinAdapter };
    }
    return value;
  },
}));
let testPanEnd: ((point: { x: number; y: number }) => void) | undefined;
mock.module("@pocketjs/framework/gesture", () => ({
  createGesture: (options: { onPanEnd?: typeof testPanEnd }) => {
    testPanEnd = options.onPanEnd;
    return {};
  },
}));
mock.module("@pocketjs/framework/animation", () => ({ jump: () => undefined }));
mock.module("@pocket/ui/fast", () => ({
  PocketVirtualList: () => undefined,
  createFastText: () => (() => undefined),
  createFrameProfiler: () => ({}),
  resolveNodeLocalPoint: () => undefined,
}));
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

const skinsModule = await import("../src/skins.tsx");
const mobileModule = await import("../src/mobile.tsx");
const uiModule = await import("../src/ui.tsx");
const backNavModule = await import("../src/back-navigation.ts");

mock.module("@pocket/ui", () => ({
  ...uiModule,
  ...mobileModule,
  ...skinsModule,
  ...backNavModule,
  useAccessibilityPreferences: () => () => ({}),
  useRouteActive: () => () => true,
}));

const {
  DEFAULT_UI_SKIN_MOTION,
  UI_SKIN_FORBIDDEN_KERNEL_KEYS,
  UI_SKIN_KIT_SLOTS,
  UiSkinProvider,
  defaultSkinAdapter,
  defineUiSkin,
  SkinBackButton,
  SkinParagraph,
  SkinScaffold,
  getUiSkin,
  listUiSkins,
  registerUiSkin,
  resolveDefaultSkinTokens,
  resolveUiSkinMotion,
} = skinsModule;
const {
  looseleafSkinAdapter,
  registerLooseleafSkin,
  resolveLooseleafSkinTokens,
} = await import("../../pocket_looseleaf/src/kit.tsx");
const {
  arcSkinAdapter,
  registerArcSkin,
  resolveArcSkinTokens,
} = await import("../../pocket_arc/src/kit.tsx");
const {
  liquidGlassSkinAdapter,
  registerLiquidGlassSkin,
  resolveLiquidGlassSkinTokens,
} = await import("../../pocket_liquid_glass/src/kit.tsx");
const { parseClassLiteral, unknownUtilities } = await import(
  "../../../.cache/pocketjs/framework/compiler/tailwind.ts"
);

test("Default, Looseleaf, Arc, and Liquid Glass adapters implement all 23 UiSkinKit component slots", () => {
  expect(UI_SKIN_KIT_SLOTS.length).toBe(23);
  expect(UI_SKIN_KIT_SLOTS).toContain("BackButton");
  expect(UI_SKIN_KIT_SLOTS).toContain("Paragraph");
  for (const adapter of [
    defaultSkinAdapter,
    looseleafSkinAdapter,
    arcSkinAdapter,
    liquidGlassSkinAdapter,
  ]) {
    for (const slot of UI_SKIN_KIT_SLOTS) {
      expect(typeof adapter.kit[slot]).toBe("function");
    }
  }
});

test("registerUiSkin / getUiSkin / listUiSkins seamlessly switch across Default, Looseleaf, Arc, and Liquid Glass", () => {
  registerLooseleafSkin();
  registerArcSkin();
  registerLiquidGlassSkin();
  registerUiSkin(defaultSkinAdapter);

  expect(getUiSkin("default").id).toBe("default");
  expect(getUiSkin("looseleaf").id).toBe("looseleaf");
  expect(getUiSkin("arc").id).toBe("arc");
  expect(getUiSkin("liquid-glass").id).toBe("liquid-glass");
  expect(getUiSkin("unknown-skin").id).toBe("default");

  const ids = listUiSkins().map((s) => s.id);
  expect(ids).toContain("default");
  expect(ids).toContain("looseleaf");
  expect(ids).toContain("arc");
  expect(ids).toContain("liquid-glass");
});

test("SkinBackButton and SkinParagraph delegate cleanly through the active skin adapter and defineUiSkin overrides slots while inheriting defaults", () => {
  const customSkin = defineUiSkin({
    id: "custom-brand",
    label: "Custom Brand",
    resolveTokens: (_mode, _accent, base) => ({
      ...base,
      ink: "#123456",
      inkMuted: "#654321",
      accentBg: "#ABCDEF",
    }),
    kit: {
      Button: (props) => ({ type: "custom-button", props }) as any,
      BackButton: (props) => ({ type: "custom-back", props }) as any,
    },
  });
  registerUiSkin(customSkin);
  expect(getUiSkin("custom-brand").id).toBe("custom-brand");

  const resolvedTokens = customSkin.resolveTokens("light", "blue");
  expect(resolvedTokens.id).toBe("custom-brand");
  expect(resolvedTokens.label).toBe("Custom Brand");
  expect(resolvedTokens.ink).toBe("#123456");
  expect(resolvedTokens.inkMuted).toBe("#654321");
  expect(resolvedTokens.accentBg).toBe("#ABCDEF");

  // Inherited slots from defaultSkinAdapter.kit
  expect(customSkin.kit.Paragraph).toBe(defaultSkinAdapter.kit.Paragraph);
  expect(customSkin.kit.Dialog).toBe(defaultSkinAdapter.kit.Dialog);
  expect(customSkin.kit.Card).toBe(defaultSkinAdapter.kit.Card);

  expect(listUiSkins().map((s) => s.id)).toContain("custom-brand");
  const unwrapShow = (el: any) => (el && typeof el.type === "function" ? el.type(el.props) : el);
  testSkinAdapter = () => customSkin;
  try {
    const backEl = unwrapShow(SkinBackButton({ label: "Home" }));
    expect(backEl.type).toBe("custom-back");
    expect(backEl.props.label).toBe("Home");

    const paraCalls: any[] = [];
    testSkinAdapter = () => ({
      ...customSkin,
      kit: {
        ...customSkin.kit,
        Paragraph: (props: any) => {
          paraCalls.push(props);
          return defaultSkinAdapter.kit.Paragraph(props);
        },
      },
    });
    const paraEl = unwrapShow(SkinParagraph({ text: "Hello skin", muted: true }));
    expect(paraCalls).toEqual([{ text: "Hello skin", muted: true }]);
    expect(paraEl.type).toBe(mobileModule.MobileParagraph);
  } finally {
    testSkinAdapter = undefined;
  }
});

test("SkinScaffold keeps a regular bottom bar in its safe-area slot and floats only the active skin's bar", () => {
  const button = { type: "bottom-bar", props: {} };
  let bar: any = button;
  let floating = false;
  testSkinAdapter = () => ({ ...defaultSkinAdapter, floatingBottomBar: floating });

  try {
    const scaffold = SkinScaffold({ get bottomBar() { return bar; } }) as any;
    expect(scaffold.type).toBe(uiModule.SafeAreaScaffold);
    expect(scaffold.props.bottomBar()).toBe(button);
    floating = true;
    const floatingBar = scaffold.props.bottomBar();
    expect(floatingBar.props.style).toMatchObject({ posType: 1, insetB: 0 });
    expect(floatingBar.props.children).toBe(button);
    floating = false;
    expect(scaffold.props.bottomBar()).toBe(button);
    bar = undefined;
    floating = true;
    expect(scaffold.props.bottomBar()).toBeUndefined();
    bar = () => undefined;
    floating = true;
    expect(scaffold.props.bottomBar()).toBeUndefined();
    bar = () => button;
    floating = true;
    const floatingFnBar = scaffold.props.bottomBar();
    expect(floatingFnBar.props.style).toMatchObject({ posType: 1, insetB: 0 });
    expect(floatingFnBar.props.children).toBe(button);
  } finally {
    testSkinAdapter = undefined;
  }
});

test("a superseded deferred Liquid Glass submenu cannot replace the current submenu", async () => {
  const { LiquidGlassMenu } = await import("../../pocket_liquid_glass/src/menus.tsx");
  const selected: string[] = [];
  let resolveStale!: (items: { id: string; label: string }[]) => void;
  let resolveCurrent!: (items: { id: string; label: string }[]) => void;
  const stale = new Promise<{ id: string; label: string }[]>((resolve) => { resolveStale = resolve; });
  const current = new Promise<{ id: string; label: string }[]>((resolve) => { resolveCurrent = resolve; });
  LiquidGlassMenu({
    open: true,
    onClose: () => {},
    onSelect: (item) => selected.push(item.id),
    anchor: { x: 20, y: 56, width: 88, height: 34 },
    entries: [
      { id: "stale", label: "Stale", deferred: () => stale },
      { id: "current", label: "Current", deferred: () => current },
    ],
  });

  const pick = (y: number) => testPanEnd?.({ x: 30, y });
  pick(115); // Open first deferred submenu.
  pick(115); // Back while its load is pending.
  pick(160); // Open a different deferred submenu at the same depth.
  resolveStale([{ id: "wrong", label: "Wrong item" }]);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  pick(160);
  expect(selected).toEqual([]);

  resolveCurrent([{ id: "right", label: "Right item" }]);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  pick(160);
  expect(selected).toEqual(["right"]);
});

test("all three skins resolve distinct light, dark, and 0%-blue-light amber-night tokens", () => {
  const defLight = resolveDefaultSkinTokens("light", "blue");
  const llLight = resolveLooseleafSkinTokens("light", "coral");
  const arcLight = resolveArcSkinTokens("light", "violet");

  expect(defLight.canvasBg).not.toBe(llLight.canvasBg);
  expect(llLight.radiusSurface).toBeLessThan(arcLight.radiusSurface);

  const defDark = resolveDefaultSkinTokens("dark", "blue");
  const llDark = resolveLooseleafSkinTokens("dark", "coral");
  const arcDark = resolveArcSkinTokens("dark", "violet");

  for (const tokens of [defDark, llDark, arcDark]) {
    expect(tokens.dark).toBe(true);
    expect(tokens.mode).toBe("dark");
  }
  expect(llDark.canvasBg).toBe("#191E1C");
  expect(llDark.surfaceBg).toBe("#24211E");
  expect(llDark.ink).toBe("#F2ECE1");
  expect(arcDark.canvasBg).toBe("#09090B");
  expect(arcDark.surfaceBg).toBe("#121215");
  expect(arcDark.ink).toBe("#F4F4F6");
  expect(llDark.canvasBg).not.toBe(resolveLooseleafSkinTokens("amber-night", "coral").canvasBg);
  expect(arcDark.canvasBg).not.toBe(resolveArcSkinTokens("amber-night", "violet").canvasBg);

  for (const tokens of [
    resolveDefaultSkinTokens("amber-night", "amber"),
    resolveLooseleafSkinTokens("amber-night", "amber"),
    resolveArcSkinTokens("amber-night", "amber"),
  ]) {
    expect(tokens.dark).toBe(true);
    expect(tokens.mode).toBe("amber-night");
    for (const hex of [tokens.canvasBg, tokens.surfaceBg, tokens.surfaceRaisedBg, tokens.accentBg]) {
      if (hex.startsWith("#") && hex.length >= 7) {
        expect(hex.slice(5, 7).toUpperCase()).toBe("00");
      }
    }
  }

  // Custom #RRGGBB host preset accents are preserved in Default skin light & dark modes
  expect(resolveDefaultSkinTokens("light", "#0ea5e9").accentBg).toBe("#0EA5E9");
  expect(resolveDefaultSkinTokens("dark", "#0ea5e9").accentBg).toBe("#0EA5E9");
});

test("every JSX class literal in unified skin adapters & SkinStudioPage compiles under --strict-classes", () => {
  const testDir = resolve(fileURLToPath(import.meta.url), "..");
  const files = [
    join(testDir, "../src/skins.tsx"),
    join(testDir, "../../pocket_looseleaf/src/kit.tsx"),
    join(testDir, "../../pocket_looseleaf/src/skins.tsx"),
    join(testDir, "../../pocket_arc/src/kit.tsx"),
    join(testDir, "../../pocket_arc/src/skins.tsx"),
    join(testDir, "../../pocket_liquid_glass/src/kit.tsx"),
    join(testDir, "../../../../demo/js/skin-studio-page.tsx"),
  ];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(/\bclass="([^"]+)"/g)) {
      const literal = match[1]!;
      expect(unknownUtilities(literal)).toEqual([]);
      expect(parseClassLiteral(literal)).not.toBeNull();
    }
  }
  const arcDir = join(testDir, "../../pocket_arc/src");
  for (const name of readdirSync(arcDir)) {
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
    const src = readFileSync(join(arcDir, name), "utf8");
    for (const match of src.matchAll(/\bclass="([^"]+)"/g)) {
      expect(unknownUtilities(match[1]!)).toEqual([]);
    }
  }
});

test("all 4 official adapters expose valid motion defaults via resolveUiSkinMotion, and resolveUiSkinMotion clamps duration & respects reducedMotion", () => {
  expect(resolveUiSkinMotion(defaultSkinAdapter.motion)).toEqual({
    routeTransition: "IOS_SPRING_PARALLAX",
    routeTransitionDurationMs: 220,
  });
  expect(resolveUiSkinMotion(looseleafSkinAdapter.motion)).toEqual({
    routeTransition: "SHARED_AXIS_Z",
    routeTransitionDurationMs: 220,
  });
  expect(resolveUiSkinMotion(arcSkinAdapter.motion)).toEqual({
    routeTransition: "IOS_SPRING_PARALLAX",
    routeTransitionDurationMs: 200,
  });
  expect(resolveUiSkinMotion(liquidGlassSkinAdapter.motion)).toEqual({
    routeTransition: "LIQUID_GLASS_MORPH",
    routeTransitionDurationMs: 240,
  });

  // Fallback and clamping to [0, 600]
  expect(resolveUiSkinMotion(undefined)).toEqual(DEFAULT_UI_SKIN_MOTION);
  expect(
    resolveUiSkinMotion({
      routeTransition: "PORTAL_EXPAND",
      routeTransitionDurationMs: -50,
    }),
  ).toEqual({
    routeTransition: "PORTAL_EXPAND",
    routeTransitionDurationMs: 0,
  });
  expect(
    resolveUiSkinMotion({
      routeTransition: "PORTAL_EXPAND",
      routeTransitionDurationMs: 9999,
    }),
  ).toEqual({
    routeTransition: "PORTAL_EXPAND",
    routeTransitionDurationMs: 600,
  });

  // reducedMotion === true forces routeTransitionDurationMs to 0
  expect(resolveUiSkinMotion(liquidGlassSkinAdapter.motion, true)).toEqual({
    routeTransition: "LIQUID_GLASS_MORPH",
    routeTransitionDurationMs: 0,
  });
});

test("defineUiSkin and registerUiSkin enforce the invariant @pocket/ui kernel boundary and throw TypeError on forbidden kernel keys", () => {
  expect(UI_SKIN_FORBIDDEN_KERNEL_KEYS).toEqual([
    "lifecycle",
    "router",
    "backNavigation",
    "hostBridge",
    "systemUi",
    "routeRetention",
    "ime",
    "media",
  ]);
  for (const forbiddenKey of UI_SKIN_FORBIDDEN_KERNEL_KEYS) {
    expect(() =>
      defineUiSkin({
        id: `bad-${forbiddenKey}`,
        label: "Bad Skin",
        [forbiddenKey]: () => {},
      } as any),
    ).toThrow(TypeError);
    expect(() =>
      registerUiSkin({
        ...defaultSkinAdapter,
        id: `bad-reg-${forbiddenKey}`,
        [forbiddenKey]: {},
      } as any),
    ).toThrow(TypeError);
  }
  expect(() =>
    registerUiSkin(
      Object.assign(Object.create({ lifecycle: {} }), {
        id: "proto-bad",
        label: "Bad",
        description: "",
        resolveTokens: defaultSkinAdapter.resolveTokens,
        kit: defaultSkinAdapter.kit,
      }) as any,
    ),
  ).toThrow(TypeError);
});

test("registerUiSkin and UiSkinProvider safely normalize missing kit slots and recover from throwing or partial resolveTokens", () => {
  const customButton = (props: any) => ({ type: "malformed-custom-button", props }) as any;
  const malformedRegistered = registerUiSkin({
    id: "malformed-reg",
    label: "Malformed Registered",
    description: "Missing kit slots",
    resolveTokens: () => {
      throw new Error("resolveTokens boom");
    },
    kit: { Button: customButton } as any,
  });

  expect(malformedRegistered.kit.Button).toBe(customButton);
  expect(malformedRegistered.kit.Dialog).toBe(defaultSkinAdapter.kit.Dialog);
  expect(malformedRegistered.kit.Paragraph).toBe(defaultSkinAdapter.kit.Paragraph);
  for (const slot of UI_SKIN_KIT_SLOTS) {
    expect(typeof malformedRegistered.kit[slot]).toBe("function");
  }

  const providerThrowingEl = UiSkinProvider({
    skin: "malformed-reg",
    mode: "dark",
    accent: "teal",
  }) as any;
  const throwingCtx = providerThrowingEl.props.value;
  expect(throwingCtx.adapter().kit.Button).toBe(customButton);
  expect(throwingCtx.adapter().kit.Dialog).toBe(defaultSkinAdapter.kit.Dialog);
  const fallbackTokens = throwingCtx.tokens();
  const baseDarkTeal = resolveDefaultSkinTokens("dark", "teal");
  expect(fallbackTokens).toEqual({
    ...baseDarkTeal,
    id: "malformed-reg",
    label: "Malformed Registered",
  });

  const rawProviderAdapter = {
    id: "malformed-inline",
    label: "Malformed Inline",
    description: "Partial tokens and kit",
    resolveTokens: () => ({ ink: "#112233", surfaceBg: undefined }) as any,
    kit: undefined as any,
  };
  const providerPartialEl = UiSkinProvider({
    skin: "malformed-inline",
    mode: "light",
    accent: "blue",
    skins: [rawProviderAdapter],
  }) as any;
  const partialCtx = providerPartialEl.props.value;
  for (const slot of UI_SKIN_KIT_SLOTS) {
    expect(partialCtx.adapter().kit[slot]).toBe(defaultSkinAdapter.kit[slot]);
  }
  const baseLightBlue = resolveDefaultSkinTokens("light", "blue");
  expect(partialCtx.tokens()).toEqual({
    ...baseLightBlue,
    id: "malformed-inline",
    label: "Malformed Inline",
    ink: "#112233",
  });
});
