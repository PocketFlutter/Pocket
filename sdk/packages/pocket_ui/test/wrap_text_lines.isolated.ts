import { test, expect, mock } from "bun:test";

mock.module("react/jsx-dev-runtime", () => ({
  Fragment: Symbol.for("wrap-text-test-fragment"),
  jsx: (type: unknown, props: unknown) => ({ type, props }),
  jsxs: (type: unknown, props: unknown) => ({ type, props }),
  jsxDEV: (type: unknown, props: unknown) => ({ type, props }),
}));
mock.module("solid-js", () => ({
  For: () => undefined,
  Show: () => undefined,
  children: (value: unknown) => value,
  createContext: (value?: unknown) => ({ value }),
  createEffect: () => undefined,
  createMemo: (value: () => unknown) => value,
  createSignal: (value: unknown) => [() => value, () => undefined],
  onCleanup: () => undefined,
  onMount: () => undefined,
  untrack: (value: () => unknown) => value(),
  useContext: () => undefined,
}));
mock.module("@pocketjs/framework/gesture", () => ({ createGesture: () => ({}) }));
mock.module("@pocketjs/framework/solid/components", () => ({
  CompositorSurface: () => undefined,
  Focusable: () => undefined,
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
mock.module("../src/legacy.ts", () => ({
  buildLiquidGlassRecipe: () => ({}),
}));
mock.module("../src/ui.tsx", () => ({
  ContourConsumedContext: {},
  InputField: () => undefined,
  NavigationBar: () => undefined,
  SafeAreaScaffold: () => undefined,
  SafeAreaScaffoldContext: {},
  ScrollContourItem: () => undefined,
  ScrollablePageContext: {},
  useScrollContourReserve: () => undefined,
}));
mock.module("../src/route.tsx", () => ({ useRouteActive: () => true }));
mock.module("../src/motion.ts", () => ({
  MOBILE_MOTION: {
    control: 240,
    overlay: 260,
    presentation: 320,
    selection: 220,
    state: 250,
  },
  motionEaseInOut: (value: number) => value,
  motionEaseOut: (value: number) => value,
  stepMotionSpring: () => 0,
}));
mock.module("../src/accessibility.ts", () => ({
  useAccessibilityPreferences: () => ({}),
}));

const { inferFontSlotFromClass, wrapTextLines } = await import("../src/mobile.tsx");
const { base64ToBytes, bytesToBase64 } = await import("../src/bytes.ts");

type WrapBridge = (text: string, fontSlot: number, maxWidth: number) => number[];
type MeasureBridge = (text: string, fontSlot: number) => number;

function setWrapBridge(
  wrapText: WrapBridge | undefined,
  measureText?: MeasureBridge,
): () => void {
  const global = globalThis as typeof globalThis & {
    ui?: { wrapText?: WrapBridge; measureText?: MeasureBridge };
  };
  const previous = global.ui;
  if (wrapText || measureText) global.ui = { wrapText, measureText };
  else delete global.ui;
  return () => {
    if (previous) global.ui = previous;
    else delete global.ui;
  };
}

test("wrapTextLines measures each explicit paragraph and preserves blank breaks", () => {
  const calls: string[] = [];
  const restore = setWrapBridge((text, fontSlot, maxWidth) => {
    calls.push(`${fontSlot}/${maxWidth}/${text}`);
    return text === "abcdefghij" ? [4, 8] : [5, 10];
  });
  try {
    expect(
      wrapTextLines("abcdefghij\n\nklmnopqrst", 42, 180, 2),
    ).toBe("abcd\nefgh\nij\n\nklmno\npqrst");
    expect(calls).toEqual([
      "2/180/abcdefghij",
      "2/180/klmnopqrst",
    ]);
  } finally {
    restore();
  }
});

test("wrapTextLines retains authored short lines and wraps long Chinese paragraphs", () => {
  const calls: string[] = [];
  const restore = setWrapBridge((text) => {
    calls.push(text);
    return text.startsWith("第二段") ? [3, 6, 9] : [];
  });
  try {
    expect(
      wrapTextLines("一行短句\n\n第二段文字很长需要换行\n末行", 42, 240, 2),
    ).toBe("一行短句\n\n第二段\n文字很\n长需要\n换行\n末行");
    expect(calls).toEqual(["一行短句", "第二段文字很长需要换行", "末行"]);
  } finally {
    restore();
  }
});

test("wrapTextLines preserves >42-char single-line text when native wrapText returns []", () => {
  const longFittingLine = "Starts paused. Play, explicit pause, and inspect progress.";
  const restore = setWrapBridge(() => []);
  try {
    expect(longFittingLine.length).toBeGreaterThan(42);
    expect(wrapTextLines(longFittingLine, 42, 340, 0)).toBe(longFittingLine);
  } finally {
    restore();
  }
});

test("wrapTextLines wraps mixed English and CJK with measureText and keeps closing punctuation", () => {
  const restore = setWrapBridge(
    () => [],
    (str) => {
      let w = 0;
      for (const ch of str) {
        w += ch.charCodeAt(0) > 0x7f ? 14 : 7;
      }
      return w;
    },
  );
  try {
    const wrapped = wrapTextLines("Pocket SDK 支持跨端自动换行，标点不会出现在行首。", 42, 140, 1);
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]?.startsWith("Pocket SDK 支持")).toBe(true);
    for (const line of lines) {
      expect(/^[，。、；：！？]/.test(line)).toBe(false);
    }
  } finally {
    restore();
  }
});

test("inferFontSlotFromClass aligns with compiler Tailwind font slots", () => {
  expect(inferFontSlotFromClass("text-xs text-slate-500")).toBe(0);
  expect(inferFontSlotFromClass("text-sm")).toBe(1);
  expect(inferFontSlotFromClass("text-base")).toBe(2);
  expect(inferFontSlotFromClass("text-xs font-bold")).toBe(7);
  expect(inferFontSlotFromClass("text-2xl font-bold")).toBe(12);
  expect(inferFontSlotFromClass("text-xs font-mono")).toBe(16);
  expect(inferFontSlotFromClass("text-2xs font-bold")).toBe(20);
  expect(inferFontSlotFromClass("px-3 py-2", 1)).toBe(1);
});

test("base64ToBytes strips internal newlines and indentation whitespace", () => {
  const original = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
  const raw = bytesToBase64(original);
  const multiline = `  ${raw.slice(0, 6)}\n  ${raw.slice(6, 12)}\r\n\t${raw.slice(12)}  `;
  expect(Array.from(base64ToBytes(multiline))).toEqual(Array.from(original));
});

test("wrapTextLines fallback wraps each paragraph without collapsing explicit spacing", () => {
  const restore = setWrapBridge(undefined);
  try {
    const wrapped = wrapTextLines(
      "Short first line\n\nLong Chinese passage without spaces 中文测试\nLast line",
      10,
      0,
    );
    expect(wrapped.split("\n").filter((line) => line.length === 0)).toHaveLength(1);
    expect(wrapped.startsWith("Short\nfirst line\n\n")).toBe(true);
    expect(wrapped.endsWith("\nLast line")).toBe(true);
    expect(wrapped.split("\n").every((line) => line.length <= 10)).toBe(true);
  } finally {
    restore();
  }
});
