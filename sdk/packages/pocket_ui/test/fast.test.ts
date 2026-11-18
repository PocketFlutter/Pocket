import { describe, expect, mock, test } from "bun:test";
import { createRoot } from "solid-js";

const replacedTexts: Array<{ id: number; value: string }> = [];
const syncedStyles: Array<{ id: number; style: Record<string, unknown> }> = [];
const jumpedCalls: Array<{ id: number; prop: string; value: number | string }> = [];
const capturedGestures: Array<Record<string, any>> = [];
let batchCreatedCount = 0;
let batchCommitCount = 0;
let lastBatchValues: Array<number | string> = [];

mock.module("react/jsx-dev-runtime", () => ({
  Fragment: Symbol.for("fast-test-fragment"),
  jsx: (type: unknown, props: unknown) =>
    typeof type === "function" ? (type as (p: unknown) => unknown)(props) : { type, props },
  jsxs: (type: unknown, props: unknown) =>
    typeof type === "function" ? (type as (p: unknown) => unknown)(props) : { type, props },
  jsxDEV: (type: unknown, props: unknown) =>
    typeof type === "function" ? (type as (p: unknown) => unknown)(props) : { type, props },
}));

mock.module("@pocketjs/framework/gesture", () => ({
  createGesture: (opts: Record<string, any>) => {
    capturedGestures.push(opts);
    return { cancel: () => {}, dispose: () => {}, panning: false, pinching: false };
  },
}));

mock.module("@pocketjs/framework/kinetics", () => ({
  bindDpadScroll: () => () => {},
  createScroller: (opts?: { max?: () => number }) => {
    let offset = 0;
    let state: "idle" | "tracking" | "fling" = "idle";
    let lastEndVel: number | undefined;
    return {
      offset: () => offset,
      intent: () => offset,
      state: () => state,
      lastEndVel: () => lastEndVel,
      step: () => {},
      stop: () => {
        state = "idle";
      },
      beginDrag: () => {
        state = "tracking";
      },
      drag: (d: number) => {
        const max = opts?.max ? opts.max() : 1000;
        offset = Math.max(0, Math.min(max, offset + d));
      },
      endDrag: (vel: number) => {
        lastEndVel = vel;
        state = Math.abs(vel) > 4 ? "fling" : "idle";
      },
      scrollBy: (d: number) => {
        const max = opts?.max ? opts.max() : 1000;
        offset = Math.max(0, Math.min(max, offset + d));
      },
      scrollTo: (to: number) => {
        const max = opts?.max ? opts.max() : 1000;
        offset = Math.max(0, Math.min(max, to));
      },
      chaseTo: () => {},
      rebase: () => {},
    };
  },
}));

mock.module("@pocketjs/framework/virtual-list", () => ({
  VirtualList: (props: unknown) => ({ type: "VirtualList", props }),
}));

mock.module("@pocketjs/framework/animation", () => ({
  jump: (node: { id: number } | number, prop: string, value: number | string) => {
    const id = typeof node === "number" ? node : node.id;
    jumpedCalls.push({ id, prop, value });
  },
  createJumpBatch: (entries: ReadonlyArray<readonly [{ id: number } | number, string]>) => {
    batchCreatedCount += 1;
    const staging = new Array<number | string>(entries.length).fill(0);
    return {
      set(index: number, value: number | string) {
        staging[index] = value;
      },
      commit() {
        batchCommitCount += 1;
        lastBatchValues = [...staging];
      },
    };
  },
}));

mock.module("@pocketjs/framework/renderer", () => ({
  // Match native-tree.ts: BOTH `<Text>` elements (type=1) and `#text` leaf
  // mirrors (type=1, domTag="#text") satisfy `isTextNode(node) === true`.
  isTextNode: (node: { type?: number; tag?: string; domTag?: string }) =>
    node?.type === 1 || node?.tag === "text" || node?.tag === "#text" || node?.domTag === "#text",
  replaceText: (node: { id: number; text?: string }, value: string) => {
    node.text = value;
    replacedTexts.push({ id: node.id, value });
  },
  syncStyle: (node: { id: number }, style: Record<string, unknown>) => {
    syncedStyles.push({ id: node.id, style });
  },
}));

mock.module("@pocketjs/framework/solid/components", () => ({
  CompositorSurface: (props: unknown) => ({ type: "CompositorSurface", props }),
  Focusable: (props: unknown) => ({ type: "Focusable", props }),
  Grid: (props: unknown) => ({ type: "Grid", props }),
  Image: (props: unknown) => ({ type: "Image", props }),
  Modal: (props: unknown) => ({ type: "Modal", props }),
  Portal: (props: unknown) => ({ type: "Portal", props }),
  Screen: (props: unknown) => ({ type: "Screen", props }),
  Text: (props: unknown) => ({ type: "Text", props }),
  View: (props: unknown) => ({ type: "View", props }),
}));

mock.module("@pocketjs/framework/solid/lifecycle", () => ({
  onFrame: () => {},
}));

mock.module("@pocketjs/framework/host", () => ({
  getOps: () => ({}),
}));

mock.module("@pocketjs/framework/clock", () => ({
  after: () => () => {},
  simulationHz: () => 60,
  virtualNow: () => 0,
}));

const {
  PocketVirtualList,
  SkinVirtualList,
  createFastText,
  createFrameProfiler,
  createJumpPool,
  formatThousands,
  resolveNodeLocalPoint,
  syncFastStyle,
  writeFastText,
} = await import("../src/fast.tsx");
const { ScrollablePageContext } = await import("../src/ui.tsx");
const { EMPTY_DISPLAY_GEOMETRY, hasActiveSideOcclusions } = await import(
  "../src/responsive.ts"
);

describe("@pocket/ui/fast — High-FPS SDK primitives", () => {
  test("writeFastText & createFastText cache #text NodeMirrors and deduplicate writes", () => {
    replacedTexts.length = 0;
    const textChild = { id: 102, tag: "#text", text: "init", parent: null as any, children: [] };
    const textWrapper = { id: 101, tag: "text", children: [textChild], parent: null };
    textChild.parent = textWrapper;

    expect(writeFastText(textWrapper as any, "init")).toBe(false);
    expect(replacedTexts).toHaveLength(0);

    expect(writeFastText(textWrapper as any, "120 FPS")).toBe(true);
    expect(textChild.text).toBe("120 FPS");
    expect(replacedTexts).toEqual([{ id: 102, value: "120 FPS" }]);

    // Pre-mount write on createFastText applies immediately when ref binds
    const slot = createFastText("0 FPS");
    slot.write("240 FPS");
    expect(slot.current()).toBe("240 FPS");
    const lateChild = { id: 202, tag: "#text", text: "0 FPS", parent: null as any, children: [] };
    const lateWrapper = { id: 201, tag: "text", children: [lateChild], parent: null };
    lateChild.parent = lateWrapper;
    slot.ref(lateWrapper as any);
    expect(lateChild.text).toBe("240 FPS");
    expect(slot.write("240 FPS")).toBe(false);

    // Simulate Solid universal `spread()` order: `ref(el)` runs BEFORE static `#text` child is appended!
    const spreadSlot = createFastText("60 FPS");
    const spreadWrapper = {
      id: 301,
      type: 1,
      domNodeType: 1,
      domTag: "text",
      children: [] as any[],
      parent: null,
    };
    spreadSlot.ref(spreadWrapper as any);
    const spreadLeaf = {
      id: 302,
      type: 1,
      domNodeType: 3,
      domTag: "#text",
      text: "60 FPS",
      children: [],
      parent: spreadWrapper,
    };
    spreadWrapper.children.push(spreadLeaf);
    expect(spreadSlot.write("240 FPS")).toBe(true);
    expect(spreadLeaf.text).toBe("240 FPS");
    expect((spreadWrapper as any).text).toBeUndefined();
  });

  test("syncFastStyle forwards style updates to retained mirrors safely", () => {
    syncedStyles.length = 0;
    const pill = { id: 301, tag: "view", children: [], parent: null };
    syncFastStyle(undefined, { bgColor: "#00FF00" });
    expect(syncedStyles).toHaveLength(0);

    syncFastStyle(pill as any, { bgColor: "#052E16", radius: 5 });
    expect(syncedStyles).toEqual([
      { id: 301, style: { bgColor: "#052E16", radius: 5 } },
    ]);
  });

  test("createJumpPool compiles a cached JumpBatch, falls back to jump(), and evicts unmounted Solid owners", () => {
    jumpedCalls.length = 0;
    batchCreatedCount = 0;
    batchCommitCount = 0;
    lastBatchValues = [];

    const pool = createJumpPool(4, ["translateX", "translateY", "scale"] as const);
    const n0 = { id: 10, children: [], parent: null } as any;
    const n1 = { id: 11, children: [], parent: null } as any;
    pool.bind(0)(n0);

    let disposeRow1!: () => void;
    createRoot((dispose) => {
      disposeRow1 = dispose;
      pool.bind(1)(n1);
    });
    expect(pool.node(1)).toBe(n1);

    pool.setTransform2D(0, 24, 48, 1.25);
    pool.setTransform2D(1, 96, 128, 0.85);

    expect(pool.commit(2, true)).toBe(true);
    expect(batchCreatedCount).toBe(1);
    expect(batchCommitCount).toBe(1);
    expect(lastBatchValues).toEqual([24, 48, 1.25, 96, 128, 0.85]);

    // Second frame with same activeCount reuses compiled JumpBatch (0 recompilations!)
    pool.setTransform2D(0, 30, 50, 1.1);
    expect(pool.commit(2, true)).toBe(true);
    expect(batchCreatedCount).toBe(1);
    expect(batchCommitCount).toBe(2);

    // Disposing the Solid owner of slot 1 evicts the destroyed NodeMirror & invalidates JumpBatch!
    disposeRow1();
    expect(pool.node(1)).toBeUndefined();
    expect(pool.commit(2, true)).toBe(false); // falls back to jump() for mounted slot 0 only
    expect(jumpedCalls).toEqual([
      { id: 10, prop: "translateX", value: 30 },
      { id: 10, prop: "translateY", value: 50 },
      { id: 10, prop: "scale", value: 1.1 },
    ]);
  });

  test("createFrameProfiler computes rolling FPS/p50/p95 and clears stale ring slots on pause or burst wraparound", () => {
    const profiler = createFrameProfiler({ windowSize: 4, targetHz: 120 });
    let t = 1000;
    for (let i = 0; i < 4; i += 1) {
      profiler.beginFrame(t);
      profiler.endFrame(t + 1 + i * 0.2);
      t += 8.3333; // ~120 FPS
    }
    const snap = profiler.snapshot();
    expect(snap.frames).toBe(4);
    expect(snap.fps).toBeGreaterThan(118);
    expect(snap.fps).toBeLessThan(122);
    expect(snap.avgWorkMs).toBeCloseTo(1.3, 2);
    expect(snap.p50WorkMs).toBeCloseTo(1.2, 2);
    expect(snap.maxWorkMs).toBeCloseTo(1.6, 2);

    // Simulate a 2-second pause (>250ms) followed by 3 zero-delta deterministic frames:
    // all 4 ring slots wrap around and clear stale 8.33ms cadence values instead of retaining them!
    t += 2000;
    for (let i = 0; i < 4; i += 1) {
      profiler.beginFrame(t);
      profiler.endFrame(t + 0.5);
    }
    const postBurst = profiler.snapshot();
    expect(postBurst.fps).toBeCloseTo(60, 5); // falls back cleanly to 60Hz nominal when all 4 cadences were paused/0ms
  });

  test("PocketVirtualList reclaims fling ownership when finger reverses back inside list after boundary chaining, and SkinVirtualList deducts border width", () => {
    capturedGestures.length = 0;
    const parentChainDrags: number[] = [];
    const parentChainEnds: number[] = [];

    let innerScroller: any;
    createRoot((dispose) => {
      ScrollablePageContext.Provider({
        value: {
          scrollOffset: () => 0,
          geometry: () => EMPTY_DISPLAY_GEOMETRY,
          subscribeContour: () => () => {},
          chainDrag: (d) => parentChainDrags.push(d),
          chainEndDrag: (v) => parentChainEnds.push(v),
        },
        get children() {
          const vnode = SkinVirtualList({
            count: 10,
            rowHeight: 30, // total = 300, max = 300 - 198 = 102
            height: 200, // default skin borderWidth=1 -> inner height = 198!
            renderRow: () => null,
          }) as any;
          // SkinVirtualList outer View -> PocketVirtualList View -> VirtualList
          const pocketListNode = vnode.props.children;
          const virtualListNode = pocketListNode.props.children;
          expect(virtualListNode.props.height).toBe(198);
          innerScroller = virtualListNode.props.controller;
          return vnode;
        },
      });

      const gesture = capturedGestures[capturedGestures.length - 1]!;
      expect(gesture.panSlop).toBe(1);

      // 1. Finger down, then drag past bottom boundary (dy = -140 -> wantDelta = +140 > max 102)
      gesture.onDown({});
      gesture.onPanStart({});
      gesture.onPanMove({ dy: -140, fdy: -140, vy: -300 });
      expect(innerScroller.offset()).toBe(102);
      expect(parentChainDrags).toEqual([38]); // 140 - 102 = 38 chained to parent!

      // 2. Without lifting finger, reverse back UP inside the list (fdy = +30 -> wantDelta = -30)
      gesture.onPanMove({ dy: -110, fdy: 30, vy: 420 });
      expect(innerScroller.offset()).toBe(72);
      // Parent must immediately settle with chainEndDrag(0)!
      expect(parentChainEnds).toEqual([0]);

      // 3. Lift finger: fling velocity (-vy = -420) goes to inner PocketVirtualList, NOT parent!
      gesture.onPanEnd({ vy: 420 });
      expect(parentChainEnds).toEqual([0]);
      expect(innerScroller.lastEndVel()).toBe(-420);

      dispose();
    });
  });

  test("resolveNodeLocalPoint composes ScrollablePage visual translation and clamps finite bounds", () => {
    const globalWithPocket = globalThis as typeof globalThis & {
      pocket?: { getLayout?: (id: number) => unknown };
    };
    const prevPocket = globalWithPocket.pocket;
    globalWithPocket.pocket = {
      getLayout: (id: number) =>
        id === 77 ? { x: 32, y: 400, width: 326, height: 164 } : undefined,
    };
    try {
      const arena = { id: 77, children: [], parent: null } as any;
      const fakeScrollPage = {
        scrollOffset: () => 150,
        geometry: () => EMPTY_DISPLAY_GEOMETRY,
        subscribeContour: () => () => {},
        visualRect: (_n: any, fallback?: any) =>
          fallback ? { ...fallback, y: fallback.y - 150 } : undefined,
      };
      const pt = resolveNodeLocalPoint(arena, 132, 310, fakeScrollPage, 12);
      expect(pt).toEqual({
        x: 100,
        y: 60,
        clampedX: 100,
        clampedY: 60,
        width: 326,
        height: 164,
        inside: true,
      });

      const outside = resolveNodeLocalPoint(arena, 5, 500, fakeScrollPage, 12);
      expect(outside?.inside).toBe(false);
      expect(outside?.clampedX).toBe(12);
      expect(outside?.clampedY).toBe(152);
    } finally {
      if (prevPocket) globalWithPocket.pocket = prevPocket;
      else delete globalWithPocket.pocket;
    }
  });

  test("formatThousands and hasActiveSideOcclusions handle edge cases cleanly", () => {
    expect(formatThousands(0)).toBe("0");
    expect(formatThousands(999)).toBe("999");
    expect(formatThousands(100_000)).toBe("100,000");
    expect(formatThousands(-1_234_567.89)).toBe("-1,234,567");
    expect(formatThousands(Number.NaN)).toBe("0");

    expect(hasActiveSideOcclusions(EMPTY_DISPLAY_GEOMETRY)).toBe(false);
    expect(
      hasActiveSideOcclusions({
        ...EMPTY_DISPLAY_GEOMETRY,
        reservedRegions: [
          {
            id: "status-pill",
            kind: "occlusion",
            frame: { left: 320, top: 0, width: 70, height: 36 },
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            active: true,
          },
        ],
      }),
    ).toBe(true);
  });
});
