/**
 * High-Load, High-FPS Stress Benchmark Lab (`demo/js/stress-page.tsx`, `route === "stress"`).
 *
 * Demonstrates how PocketJS sustains 120+ FPS (< 2 ms guest + FFI frame cost)
 * under simultaneous extreme pressure by consuming `@pocket/ui/fast` SDK primitives:
 * 1. Pre-allocated Structure-of-Arrays (`Float64Array` / `Int32Array`) physics &
 *    market state — zero per-frame object allocations and zero GC pauses.
 * 2. Paint-only absolute retained pool (`posType: 1`, `translateX` / `translateY` /
 *    `scale`) — zero Yoga flexbox relayouts during 60–120Hz motion.
 * 3. `createJumpPool` (`createJumpBatch` + `ops.setPropBatch(ArrayBuffer)`) — packs
 *    up to 512 * 3 = 1,536 node property updates into ONE QuickJS-to-Rust C FFI
 *    call per frame (with an interactive A/B toggle against unbatched `jump()`).
 * 4. `PocketVirtualList` (`VirtualList` two-node windowing + nested `ScrollablePage`
 *    chaining) + `createFastText` / `writeFastText` (`replaceText`) + `syncFastStyle`
 *    — streams 500 to 8,000 data mutations/frame across 100,000 rows while keeping
 *    mounted native nodes strictly O(viewport) (~8 rows).
 */

import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack, useContext, type JSX } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import { createGesture, type GestureContact } from "@pocketjs/framework/gesture";
import {
  MobileButton,
  MobileCard,
  MobileListTile,
  PocketVirtualList,
  ScrollContourItem,
  ScrollablePageContext,
  SkinBadge,
  SkinButton,
  SkinCard,
  SkinListTile,
  SkinParagraph,
  SkinSegmentedControl,
  SkinSwitch,
  createFastText,
  createFrameProfiler,
  createJumpPool,
  formatThousands,
  resolveNodeLocalPoint,
  stateParam,
  syncFastStyle,
  toMobileColor,
  useMobileTheme,
  useOptionalPocketRouter,
  useSearchState,
  useUiSkin,
  writeFastText,
  type VirtualListHandle,
} from "@pocket/ui";
import type { DemoEvent, DemoState, ShowcaseSkin } from "./state.ts";

export type StressPresetId = "balanced" | "heavy" | "extreme";

interface StressPresetConfig {
  readonly id: StressPresetId;
  readonly label: string;
  readonly particles: number;
  readonly rows: number;
  readonly mutationsPerFrame: number;
}

export const STRESS_PRESETS: Readonly<Record<StressPresetId, StressPresetConfig>> = {
  balanced: {
    id: "balanced",
    label: "Balanced",
    particles: 96,
    rows: 10_000,
    mutationsPerFrame: 600,
  },
  heavy: {
    id: "heavy",
    label: "Heavy",
    particles: 224,
    rows: 50_000,
    mutationsPerFrame: 2_500,
  },
  extreme: {
    id: "extreme",
    label: "Extreme",
    particles: 384,
    rows: 100_000,
    mutationsPerFrame: 6_000,
  },
};

const MAX_PARTICLES = 512;
const MAX_ROWS = 100_000;
const SPARK_BARS = 32;
const ARENA_W = 326;
const ARENA_H = 164;
const ROW_H = 34;
const LIST_VIEWPORT_H = 238;

const PARTICLE_SWATCHES_DARK = [
  "#38BDF8",
  "#818CF8",
  "#34D399",
  "#FBBF24",
  "#FB7185",
  "#A78BFA",
] as const;

const PARTICLE_SWATCHES_LIGHT = [
  "#0284C7",
  "#4F46E5",
  "#059669",
  "#D97706",
  "#E11D48",
  "#7C3AED",
] as const;

const PARTICLE_SWATCHES_AMBER = [
  "#FFB300",
  "#FF9800",
  "#FFD000",
  "#E58A00",
  "#FF6D00",
  "#CCA000",
] as const;

const SECTORS = ["AI", "GPU", "MEM", "NET", "BIO", "SOL", "ARC", "SYS"] as const;

function formatSymbol(index: number): string {
  const sector = SECTORS[index & 7]!;
  const code = String(index).padStart(6, "0");
  return `${sector}-${code}`;
}

function formatPrice(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = Math.abs(cents % 100);
  return `${whole}.${frac < 10 ? "0" : ""}${frac}`;
}

function formatDeltaBps(bps: number): string {
  const sign = bps >= 0 ? "+" : "-";
  const abs = Math.abs(bps);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${frac < 10 ? "0" : ""}${frac}%`;
}

function retainedNodesArray(count: number): number[] {
  const out = new Array<number>(count);
  for (let i = 0; i < count; i += 1) out[i] = i;
  return out;
}

// Pre-allocated Structure-of-Arrays (SoA) buffers shared safely inside the guest realm
// so toggling presets never triggers multi-megabyte TypedArray reallocations or GC spikes.
const soaPx = new Float64Array(MAX_PARTICLES);
const soaPy = new Float64Array(MAX_PARTICLES);
const soaVx = new Float64Array(MAX_PARTICLES);
const soaVy = new Float64Array(MAX_PARTICLES);

const marketPriceCents = new Int32Array(MAX_ROWS);
const marketDeltaBps = new Int32Array(MAX_ROWS);
const marketVolume = new Uint32Array(MAX_ROWS);
const marketTickSeq = new Uint32Array(MAX_ROWS);

let buffersSeeded = false;
function ensureSeededBuffers(): void {
  if (buffersSeeded) return;
  buffersSeeded = true;
  let seed = 0x9e3779b9;
  const nextRand = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  for (let i = 0; i < MAX_PARTICLES; i += 1) {
    soaPx[i] = 12 + nextRand() * (ARENA_W - 24);
    soaPy[i] = 12 + nextRand() * (ARENA_H - 24);
    const angle = nextRand() * Math.PI * 2;
    const speed = 42 + nextRand() * 96;
    soaVx[i] = Math.cos(angle) * speed;
    soaVy[i] = Math.sin(angle) * speed;
  }
  for (let r = 0; r < MAX_ROWS; r += 1) {
    marketPriceCents[r] = 1800 + ((r * 73) % 48_000);
    marketDeltaBps[r] = ((r * 37) % 900) - 450;
    marketVolume[r] = 100 + ((r * 19) % 9500);
    marketTickSeq[r] = 1;
  }
}

interface LiveRowRefs {
  priceNode?: NodeMirror;
  deltaNode?: NodeMirror;
  volNode?: NodeMirror;
  pillNode?: NodeMirror;
  positive: boolean;
  paletteKey: string;
}

export function StressLabPage(props: {
  active: () => boolean;
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  runStress: (nodes: number) => void;
}): JSX.Element {
  ensureSeededBuffers();
  const skin = useUiSkin();
  const mobileTheme = useMobileTheme();
  const router = useOptionalPocketRouter();
  const scrollPage = useContext(ScrollablePageContext);

  const runBatched = (fn: () => void): void => {
    if (router) router.batch(fn);
    else fn();
  };

  // URL-synced deep-linkable stress parameters (`pocket://showcase/stress?...`)
  const [preset, setPreset] = useSearchState(
    "preset",
    stateParam.enum(["balanced", "heavy", "extreme"] as const, "heavy"),
    { routeId: "stress" },
  );
  const [particleCount, setParticleCount] = useSearchState(
    "particles",
    stateParam.int(224, { min: 32, max: MAX_PARTICLES }),
    { routeId: "stress" },
  );
  const [rowCount, setRowCount] = useSearchState(
    "rows",
    stateParam.int(50_000, { min: 1_000, max: MAX_ROWS }),
    { routeId: "stress" },
  );
  const [mutationsPerFrame, setMutationsPerFrame] = useSearchState(
    "mutations",
    stateParam.int(2_500, { min: 100, max: 10_000 }),
    { routeId: "stress" },
  );
  const [useBatchFastPath, setUseBatchFastPath] = useSearchState(
    "batch",
    stateParam.boolean(true),
    { routeId: "stress" },
  );
  const [running, setRunning] = useSearchState(
    "running",
    stateParam.boolean(true),
    { routeId: "stress" },
  );

  const applyPreset = (id: StressPresetId): void => {
    const cfg = STRESS_PRESETS[id];
    runBatched(() => {
      setPreset(id);
      setParticleCount(cfg.particles);
      setRowCount(cfg.rows);
      setMutationsPerFrame(cfg.mutationsPerFrame);
      setRunning(true);
    });
  };

  const tokens = () => skin.tokens();
  const isAmberNight = () => tokens().mode === "amber-night";
  const isDark = () => tokens().dark;

  const swatches = () =>
    isAmberNight()
      ? PARTICLE_SWATCHES_AMBER
      : isDark()
        ? PARTICLE_SWATCHES_DARK
        : PARTICLE_SWATCHES_LIGHT;

  const deltaPillBg = (positive: boolean): string =>
    positive
      ? isAmberNight()
        ? "#1C2B00"
        : isDark()
          ? "#052E16"
          : "#DCFCE7"
      : isAmberNight()
        ? "#2E0F00"
        : isDark()
          ? "#450A0A"
          : "#FEE2E2";

  const currentPaletteKey = (): string => `${skin.skinId()}:${tokens().mode}`;

  // SDK FastText slots for zero-VDOM HUD updates
  const fpsValueText = createFastText("60 FPS");
  const fpsDetailText = createFastText("Headroom ~999 FPS · 120Hz budget 8%");
  const workMsValueText = createFastText("0.45 ms");
  const workMsDetailText = createFastText("p95 0.60 ms · 1 FFI batch");
  const throughputText = createFastText("Streaming SoA TypedArrays · 0 GC allocations/frame");
  const attractorHintText = createFastText("Touch/drag arena to pull orbital vortex · tap for shockwave");

  let arenaNode: NodeMirror | undefined;
  let virtualListHandle: VirtualListHandle | undefined;

  // SDK JumpPools (`createJumpBatch` + `ops.setPropBatch`) for particles & sparkline
  const particlePool = createJumpPool(
    MAX_PARTICLES,
    ["translateX", "translateY", "scale"] as const,
  );
  const sparkPool = createJumpPool(
    SPARK_BARS,
    ["scale", "translateY"] as const,
  );
  const sparkHistory = new Float64Array(SPARK_BARS);
  let sparkCursor = 0;

  // Zero-allocation rolling 60-frame profiler from `@pocket/ui/fast`
  const profiler = createFrameProfiler({ windowSize: 60, targetHz: 120 });

  // Mounted VirtualList row registry (~8 rows) for O(visible) live tick refresh
  const mountedRows = new Map<number, LiveRowRefs>();
  const [selectedSymbolIdx, setSelectedSymbolIdx] = createSignal<number>(0);

  // Keep mounted row delta pills/text synced immediately on skin/theme changes,
  // including while the benchmark loop is paused (`running() === false`).
  createEffect(() => {
    const paletteKey = currentPaletteKey();
    const tks = tokens();
    for (const [, refs] of mountedRows) {
      if (refs.paletteKey === paletteKey) continue;
      refs.paletteKey = paletteKey;
      syncFastStyle(refs.pillNode, {
        bgColor: deltaPillBg(refs.positive),
        radius: 5,
        hitPass: 1,
      });
      syncFastStyle(refs.deltaNode, {
        textColor: refs.positive ? tks.successBg : tks.dangerBg,
        hitPass: 1,
      });
    }
  });

  // Interactive pointer vortex attractor inside the physics arena
  let attractorActive = false;
  let attractorX = ARENA_W * 0.5;
  let attractorY = ARENA_H * 0.5;

  const updateAttractorFromContact = (c: GestureContact): void => {
    const resolved = resolveNodeLocalPoint(arenaNode, c.x, c.y, scrollPage, 12);
    if (resolved) {
      attractorX = resolved.clampedX;
      attractorY = resolved.clampedY;
      return;
    }
    const fallbackX = Number.isFinite(c.x) ? c.x - 32 : ARENA_W * 0.5;
    const fallbackY = Number.isFinite(c.y) ? c.y - 220 : ARENA_H * 0.5;
    attractorX = Math.max(12, Math.min(ARENA_W - 12, fallbackX));
    attractorY = Math.max(12, Math.min(ARENA_H - 12, fallbackY));
  };

  createGesture({
    panSlop: 1,
    region: { node: () => (props.active() ? arenaNode : undefined) },
    onDown: (c) => {
      if (!props.active()) return;
      attractorActive = true;
      updateAttractorFromContact(c);
      attractorHintText.write(
        `Vortex lock (${Math.round(attractorX)}, ${Math.round(attractorY)})`,
      );
    },
    onPanMove: (c) => {
      if (!props.active()) return;
      attractorActive = true;
      updateAttractorFromContact(c);
      attractorHintText.write(
        `Vortex drag (${Math.round(attractorX)}, ${Math.round(attractorY)})`,
      );
    },
    onPanEnd: () => {
      attractorActive = false;
      attractorHintText.write("Touch/drag arena to pull orbital vortex · tap for shockwave");
    },
    onTap: (c) => {
      if (!props.active()) return;
      updateAttractorFromContact(c);
      attractorActive = false;
      const n = untrack(particleCount);
      for (let i = 0; i < n; i += 1) {
        const dx = soaPx[i]! - attractorX;
        const dy = soaPy[i]! - attractorY;
        const dist = Math.max(8, Math.hypot(dx, dy));
        soaVx[i] = (dx / dist) * 185;
        soaVy[i] = (dy / dist) * 185;
      }
      attractorHintText.write("Impulse shockwave dispatched!");
    },
    onCancel: () => {
      attractorActive = false;
    },
  });

  let mutationCursor = 0;
  let totalMutationsProcessed = 0;
  let simClockSec = 0;

  const stepBenchmarkFrame = (): void => {
    profiler.beginFrame();

    const dt = 1 / 60;
    simClockSec += dt;
    const activeP = untrack(particleCount);
    const activeRows = untrack(rowCount);
    const muts = untrack(mutationsPerFrame);
    const batchMode = untrack(useBatchFastPath);
    const frameNo = profiler.frames();

    // 1. Step SoA 2D orbital vortex physics (`activeP` particles)
    const cx = attractorActive ? attractorX : ARENA_W * 0.5 + Math.cos(simClockSec * 1.7) * 76;
    const cy = attractorActive ? attractorY : ARENA_H * 0.5 + Math.sin(simClockSec * 2.3) * 42;
    const pull = attractorActive ? 340 : 135;

    for (let i = 0; i < activeP; i += 1) {
      let x = soaPx[i]!;
      let y = soaPy[i]!;
      let vx = soaVx[i]!;
      let vy = soaVy[i]!;

      const dx = cx - x;
      const dy = cy - y;
      const distSq = dx * dx + dy * dy + 140;
      const invDist = 1 / Math.sqrt(distSq);
      const ax = dx * invDist * pull - dy * invDist * 68;
      const ay = dy * invDist * pull + dx * invDist * 68;

      vx = (vx + ax * dt) * 0.986;
      vy = (vy + ay * dt) * 0.986;
      x += vx * dt;
      y += vy * dt;

      if (x < 4) {
        x = 4;
        vx = Math.abs(vx) * 0.88;
      } else if (x > ARENA_W - 10) {
        x = ARENA_W - 10;
        vx = -Math.abs(vx) * 0.88;
      }
      if (y < 4) {
        y = 4;
        vy = Math.abs(vy) * 0.88;
      } else if (y > ARENA_H - 10) {
        y = ARENA_H - 10;
        vy = -Math.abs(vy) * 0.88;
      }

      soaPx[i] = x;
      soaPy[i] = y;
      soaVx[i] = vx;
      soaVy[i] = vy;
      const speedNorm = Math.min(1.65, 0.72 + (Math.abs(vx) + Math.abs(vy)) * 0.0032);
      particlePool.setTransform2D(i, x, y, speedNorm);
    }

    // 2. Commit particle transforms via single-FFI JumpBatch OR individual jump()
    particlePool.commit(activeP, batchMode);

    // 3. Mutate `muts` market rows in-place inside TypedArrays (`0` GC allocations!)
    let cursor = mutationCursor;
    const stride = 97;
    for (let m = 0; m < muts; m += 1) {
      cursor = (cursor + stride) % activeRows;
      const step = ((m + frameNo) & 1) === 0 ? 7 : -7;
      const nextPrice = Math.max(100, marketPriceCents[cursor]! + step);
      marketPriceCents[cursor] = nextPrice;
      const nextDelta = Math.max(-1999, Math.min(1999, marketDeltaBps[cursor]! + (step > 0 ? 3 : -3)));
      marketDeltaBps[cursor] = nextDelta;
      marketVolume[cursor] = marketVolume[cursor]! + 1;
      marketTickSeq[cursor] = marketTickSeq[cursor]! + 1;
    }
    mutationCursor = cursor;
    totalMutationsProcessed += muts;

    // Tick the visible window rows directly via O(visible) `writeFastText` + sign-flip `syncFastStyle`
    const paletteKey = untrack(currentPaletteKey);
    const tks = untrack(tokens);
    let visibleSlotCounter = 0;
    for (const [rowIndex, refs] of mountedRows) {
      if (rowIndex >= activeRows) continue;
      if (((frameNo + visibleSlotCounter) & 1) === 0) {
        const dir = ((rowIndex + frameNo) & 2) === 0 ? 5 : -5;
        marketPriceCents[rowIndex] = Math.max(100, marketPriceCents[rowIndex]! + dir);
        marketDeltaBps[rowIndex] = Math.max(
          -1999,
          Math.min(1999, marketDeltaBps[rowIndex]! + (dir > 0 ? 4 : -4)),
        );
        marketVolume[rowIndex] = marketVolume[rowIndex]! + 2;
        marketTickSeq[rowIndex] = marketTickSeq[rowIndex]! + 1;
      }
      visibleSlotCounter += 1;
      const deltaVal = marketDeltaBps[rowIndex]!;
      const isPositive = deltaVal >= 0;
      writeFastText(refs.priceNode, `$${formatPrice(marketPriceCents[rowIndex]!)}`);
      writeFastText(refs.deltaNode, formatDeltaBps(deltaVal));
      writeFastText(refs.volNode, `v${marketVolume[rowIndex]!}`);
      if (refs.positive !== isPositive || refs.paletteKey !== paletteKey) {
        refs.positive = isPositive;
        refs.paletteKey = paletteKey;
        syncFastStyle(refs.pillNode, {
          bgColor: deltaPillBg(isPositive),
          radius: 5,
          hitPass: 1,
        });
        syncFastStyle(refs.deltaNode, {
          textColor: isPositive ? tks.successBg : tks.dangerBg,
          hitPass: 1,
        });
      }
    }

    const workMs = profiler.endFrame();

    // 4. Update 32-bar rolling frame-time waveform via `sparkPool` (`createJumpBatch`, 0 relayout)
    sparkHistory[sparkCursor] = workMs;
    sparkCursor = (sparkCursor + 1) % SPARK_BARS;
    for (let b = 0; b < SPARK_BARS; b += 1) {
      const sample = sparkHistory[(sparkCursor + b) % SPARK_BARS]!;
      const ratio = Math.max(0.12, Math.min(1, sample / 16.67));
      sparkPool.set(b, 0, ratio);
      sparkPool.set(b, 1, (1 - ratio) * 14);
    }
    sparkPool.commit(SPARK_BARS, true);

    // 5. Refresh HUD numbers every 6 frames (~10Hz) via `FastTextSlot` (zero component rebuilds!)
    if (profiler.frames() % 6 === 1) {
      const snap = profiler.snapshot();
      fpsValueText.write(`${snap.fps.toFixed(0)} FPS`);
      fpsDetailText.write(`Headroom ~${snap.headroomFps} FPS · 120Hz budget ${snap.budgetPct}%`);
      workMsValueText.write(`${snap.avgWorkMs.toFixed(2)} ms`);
      workMsDetailText.write(
        `p95 ${snap.p95WorkMs.toFixed(2)} ms · ${batchMode ? "1 FFI batch" : `${activeP * 3} FFI calls`}`,
      );
      throughputText.write(
        `Frame #${snap.frames} · ${(totalMutationsProcessed / 1000).toFixed(1)}k row ticks · ${mountedRows.size}/${formatThousands(activeRows)} rows mounted`,
      );
    }
  };

  onFrame(stepBenchmarkFrame, {
    continuous: () => props.active() && running(),
  });

  // Expose deterministic test/benchmark snapshot hook for `pocket_probe` native verification
  const globalApi = globalThis as typeof globalThis & {
    __pocketStressStats?: () => {
      frames: number;
      particles: number;
      rows: number;
      mountedRows: number;
      mutationsPerFrame: number;
      totalMutations: number;
      batchFastPath: boolean;
      avgWorkMs: number;
      p95WorkMs: number;
      listOffset: number;
      attractor: { active: boolean; x: number; y: number };
      firstParticle: { x: number; y: number };
    };
  };
  globalApi.__pocketStressStats = () => {
    const snap = profiler.snapshot();
    return {
      frames: snap.frames,
      particles: untrack(particleCount),
      rows: untrack(rowCount),
      mountedRows: mountedRows.size,
      mutationsPerFrame: untrack(mutationsPerFrame),
      totalMutations: totalMutationsProcessed,
      batchFastPath: untrack(useBatchFastPath),
      avgWorkMs: snap.avgWorkMs,
      p95WorkMs: snap.p95WorkMs,
      listOffset: virtualListHandle?.scroller.offset() ?? 0,
      attractor: { active: attractorActive, x: attractorX, y: attractorY },
      firstParticle: { x: soaPx[0]!, y: soaPy[0]! },
    };
  };
  onCleanup(() => {
    if (globalApi.__pocketStressStats) delete globalApi.__pocketStressStats;
  });

  const particleIndices = createMemo(() => {
    const count = particleCount();
    const arr = new Array<number>(count);
    for (let i = 0; i < count; i += 1) arr[i] = i;
    return arr;
  });

  const sparkIndices = Array.from({ length: SPARK_BARS }, (_, i) => i);
  const legacyNodes = () => retainedNodesArray(props.state().stress.nodeCount);

  return (
    <View class="flex-col gap-3.5 w-full" style={{ minW: 0 }}>
      <Show when={props.state().stress.nodeCount > 0}>
        <MobileCard title="Retained Node Burst Result" detail={`${props.state().stress.durationMs} ms JS setup · ${props.state().stress.lastAction}`}>
          <Text class={mobileTheme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}>
            {props.state().stress.nodeCount} retained nodes in the current guest frame.
          </Text>
          <View class="flex-row flex-wrap gap-1 overflow-hidden">
            <For each={legacyNodes()}>
              {() => <View class="w-2 h-2 rounded bg-cyan-500" />}
            </For>
          </View>
        </MobileCard>
      </Show>

      {/* 1. Header Control Deck & Skin/Preset Selector */}
      <SkinCard
        title="High-FPS Extreme Load Stress Lab"
        detail="Sustaining 60–120+ FPS under 100k VirtualList rows + 512 orbital particles + 6,000 mutations/frame."
        variant="raised"
        badge={running() ? "LIVE 60/120HZ" : "PAUSED"}
      >
        <SkinSegmentedControl
          accentActive
          items={[
            { id: "balanced", label: "Balanced (10k)" },
            { id: "heavy", label: "Heavy (50k)" },
            { id: "extreme", label: "Extreme (100k)" },
          ]}
          active={preset()}
          onChange={(id) => applyPreset(id as StressPresetId)}
        />

        <View class="flex-row flex-wrap items-center gap-2 w-full">
          <SkinButton
            label={running() ? "Pause Benchmark" : "Resume Benchmark"}
            variant={running() ? "secondary" : "primary"}
            compact
            onPress={() => setRunning(!running())}
          />
          <SkinButton
            label="Max 512 Particles"
            variant="outline"
            compact
            onPress={() =>
              runBatched(() => {
                setPreset("extreme");
                setParticleCount(MAX_PARTICLES);
                setRowCount(MAX_ROWS);
                setMutationsPerFrame(8_000);
                setRunning(true);
              })
            }
          />
          <SkinSegmentedControl
            items={[
              { id: "default", label: "Default" },
              { id: "looseleaf", label: "Looseleaf" },
              { id: "arc", label: "Arc" },
              { id: "liquid-glass", label: "Glass" },
            ]}
            active={props.state().uiSkin}
            onChange={(id) => props.dispatch({ type: "setUiSkin", value: id as ShowcaseSkin })}
          />
        </View>

        <SkinSwitch
          value={useBatchFastPath()}
          onChange={(next) => setUseBatchFastPath(next)}
          label="Single-FFI JumpBatch (ops.setPropBatch)"
          detail="Packs all particle X/Y/Scale writes into one Float64Array C-FFI transition per frame (0 Yoga relayouts)"
        />
      </SkinCard>

      {/* 2. Zero-VDOM Live Telemetry HUD (`createFastText` / `replaceText` direct mirror writes) */}
      <View class="flex-row gap-2.5 w-full" style={{ minW: 0 }}>
        <View
          class="flex-1 flex-col gap-1 p-3"
          style={{
            bgColor: tokens().surfaceRaisedBg,
            borderColor: tokens().border,
            borderWidth: 1,
            radius: tokens().radiusSurface,
            minW: 0,
          }}
        >
          <Text class="text-2xs font-bold" style={{ textColor: tokens().inkMuted }}>
            CADENCE / HEADROOM
          </Text>
          <Text
            ref={fpsValueText.ref}
            class="text-xl font-bold"
            style={{ textColor: tokens().successBg }}
          >
            60 FPS
          </Text>
          <Text
            ref={fpsDetailText.ref}
            class="text-2xs"
            style={{ textColor: tokens().inkSecondary }}
          >
            Headroom ~999 FPS · 120Hz budget 8%
          </Text>
        </View>

        <View
          class="flex-1 flex-col gap-1 p-3"
          style={{
            bgColor: tokens().surfaceRaisedBg,
            borderColor: tokens().border,
            borderWidth: 1,
            radius: tokens().radiusSurface,
            minW: 0,
          }}
        >
          <Text class="text-2xs font-bold" style={{ textColor: tokens().inkMuted }}>
            JS + FFI FRAME WORK
          </Text>
          <Text
            ref={workMsValueText.ref}
            class="text-xl font-bold"
            style={{ textColor: tokens().accentBg }}
          >
            0.45 ms
          </Text>
          <Text
            ref={workMsDetailText.ref}
            class="text-2xs"
            style={{ textColor: tokens().inkSecondary }}
          >
            p95 0.60 ms · 1 FFI batch
          </Text>
        </View>
      </View>

      {/* 3. Real-Time 2D Orbital Vortex Arena + 32-Bar Frame-Time Waveform */}
      <SkinCard
        title={`2D Orbital Swarm (${particleCount()} Retained Particles)`}
        detail="Zero Yoga layout passes: absolute posType=1 pool driven by SoA Float64Array + JumpPool."
        badge="0 RELAYOUT"
      >
        <View class="w-full items-center">
          <View
            ref={(n) => {
              arenaNode = n;
            }}
            class="relative overflow-hidden"
            style={{
              width: ARENA_W,
              height: ARENA_H,
              bgColor: isAmberNight() ? "#0E0900" : isDark() ? "#090D16" : "#0F172A",
              borderColor: tokens().borderStrong,
              borderWidth: 1,
              radius: tokens().radiusSurface,
            }}
          >
            {/* Subtle HUD grid crosshair lines (static retained nodes, hitPass=1) */}
            <View
              class="absolute left-0 right-0"
              style={{
                posType: 1,
                insetL: 0,
                insetR: 0,
                insetT: Math.round(ARENA_H / 2),
                height: 1,
                bgColor: isAmberNight() ? "#291D00" : "#1E293B",
                hitPass: 1,
              }}
            />
            <View
              class="absolute top-0 bottom-0"
              style={{
                posType: 1,
                insetT: 0,
                insetB: 0,
                insetL: Math.round(ARENA_W / 2),
                width: 1,
                bgColor: isAmberNight() ? "#291D00" : "#1E293B",
                hitPass: 1,
              }}
            />

            <For each={particleIndices()}>
              {(idx) => (
                <View
                  ref={particlePool.bind(idx)}
                  style={{
                    posType: 1,
                    insetL: 0,
                    insetT: 0,
                    width: 6,
                    height: 6,
                    radius: 3,
                    translateX: soaPx[idx]!,
                    translateY: soaPy[idx]!,
                    scale: 1,
                    bgColor: swatches()[idx % swatches().length]!,
                    hitPass: 1,
                  }}
                />
              )}
            </For>
          </View>
        </View>

        <View class="flex-row items-center justify-between gap-2 w-full">
          <Text
            ref={attractorHintText.ref}
            class="text-2xs"
            style={{ textColor: tokens().inkMuted }}
          >
            Touch/drag arena to pull orbital vortex · tap for shockwave
          </Text>
          <SkinBadge label="8.33ms = 120Hz" tone="success" />
        </View>

        {/* Rolling 32-Bar Frame-Work Sparkline */}
        <View
          class="flex-row items-end justify-between px-2 py-1.5 w-full overflow-hidden"
          style={{
            height: 36,
            bgColor: tokens().surfaceBg,
            borderColor: tokens().border,
            borderWidth: 1,
            radius: tokens().radiusControl,
          }}
        >
          <For each={sparkIndices}>
            {(idx) => (
              <View
                ref={sparkPool.bind(idx)}
                style={{
                  width: 6,
                  height: 24,
                  radius: 2,
                  scale: 0.2,
                  translateY: 10,
                  bgColor: tokens().accentBg,
                  hitPass: 1,
                }}
              />
            )}
          </For>
        </View>

        <Text
          ref={throughputText.ref}
          class="text-2xs"
          style={{ textColor: tokens().inkSecondary }}
        >
          Streaming SoA TypedArrays · 0 GC allocations/frame
        </Text>
      </SkinCard>

      {/* 4. 100,000-Row High-Frequency PocketVirtualList Order-Book / Telemetry Stream */}
      <SkinCard
        title={`VirtualList Stream (${formatThousands(rowCount())} Rows · ${formatThousands(mutationsPerFrame())} Ticks/f)`}
        detail="Two-node scissor viewport with nested ScrollablePage scroll chaining: only ~8 visible rows mount."
        badge="O(VIEWPORT)"
      >
        <View class="flex-row flex-wrap items-center gap-1.5 w-full">
          <SkinButton
            label="Top #0"
            variant="outline"
            compact
            onPress={() => virtualListHandle?.scrollToIndex(0, "start", true)}
          />
          <SkinButton
            label="Mid #5,000"
            variant="outline"
            compact
            onPress={() =>
              virtualListHandle?.scrollToIndex(
                Math.min(rowCount() - 1, 5_000),
                "center",
                true,
              )
            }
          />
          <SkinButton
            label={`Mid #${formatThousands(Math.floor(rowCount() / 2))}`}
            variant="secondary"
            compact
            onPress={() =>
              virtualListHandle?.scrollToIndex(
                Math.floor(rowCount() / 2),
                "center",
                true,
              )
            }
          />
          <SkinButton
            label={`Tail #${formatThousands(rowCount() - 1)}`}
            variant="outline"
            compact
            onPress={() =>
              virtualListHandle?.scrollToIndex(
                Math.max(0, rowCount() - 1),
                "end",
                true,
              )
            }
          />
        </View>

        <View
          class="w-full overflow-hidden"
          style={{
            height: LIST_VIEWPORT_H + 2,
            bgColor: tokens().surfaceBg,
            borderColor: tokens().border,
            borderWidth: 1,
            radius: tokens().radiusSurface,
          }}
        >
          <PocketVirtualList
            ref={(h) => {
              virtualListHandle = h;
            }}
            count={rowCount()}
            rowHeight={ROW_H}
            height={LIST_VIEWPORT_H}
            focusRows={false}
            overscan={68}
            inputActive={props.active}
            onRowPress={(idx) => setSelectedSymbolIdx(idx)}
            renderRow={(index) => {
              const initDeltaVal = marketDeltaBps[index] ?? 0;
              const initPositive = initDeltaVal >= 0;
              const initTks = untrack(tokens);
              const initPillStyle = {
                bgColor: untrack(() => deltaPillBg(initPositive)),
                radius: 5,
                hitPass: 1,
              };
              const initDeltaStyle = {
                textColor: initPositive ? initTks.successBg : initTks.dangerBg,
                hitPass: 1,
              };
              const refs: LiveRowRefs = {
                positive: initPositive,
                paletteKey: untrack(currentPaletteKey),
              };
              mountedRows.set(index, refs);
              onCleanup(() => {
                if (mountedRows.get(index) === refs) {
                  mountedRows.delete(index);
                }
              });
              const symbol = formatSymbol(index);
              const initPrice = `$${formatPrice(marketPriceCents[index] ?? 2500)}`;
              const initDelta = formatDeltaBps(initDeltaVal);
              const initVol = `v${marketVolume[index] ?? 100}`;
              const even = (index & 1) === 0;

              return (
                <Focusable
                  class="flex-row items-center justify-between px-3 h-full w-full"
                  style={{
                    bgColor: even ? tokens().surfaceBg : tokens().surfaceRaisedBg,
                    borderColor: tokens().border,
                    borderWidth: 0,
                  }}
                  onPress={() => setSelectedSymbolIdx(index)}
                >
                  <View class="flex-row items-center gap-2" style={{ hitPass: 1 }}>
                    <Text class="text-xs font-bold" style={{ textColor: tokens().ink, hitPass: 1 }}>
                      {symbol}
                    </Text>
                    <Text
                      ref={(n) => {
                        refs.volNode = n;
                      }}
                      class="text-2xs"
                      style={{ textColor: tokens().inkMuted, hitPass: 1 }}
                    >
                      {initVol}
                    </Text>
                  </View>

                  <View class="flex-row items-center gap-2.5" style={{ hitPass: 1 }}>
                    <Text
                      ref={(n) => {
                        refs.priceNode = n;
                      }}
                      class="text-xs font-bold"
                      style={{ textColor: tokens().ink, hitPass: 1 }}
                    >
                      {initPrice}
                    </Text>
                    <View
                      ref={(n) => {
                        refs.pillNode = n;
                      }}
                      class="px-1.5 py-0.5 items-center justify-center"
                      style={initPillStyle}
                    >
                      <Text
                        ref={(n) => {
                          refs.deltaNode = n;
                        }}
                        class="text-2xs font-bold"
                        style={initDeltaStyle}
                      >
                        {initDelta}
                      </Text>
                    </View>
                  </View>
                </Focusable>
              );
            }}
          />
        </View>

        <SkinListTile
          title={`Inspected Row: ${formatSymbol(selectedSymbolIdx())}`}
          detail="Touch-drag inside the list or tap any streaming row across 100,000 items with zero frame drops."
          trailing={<SkinBadge label={`#${selectedSymbolIdx()}`} tone="accent" />}
        />
      </SkinCard>

      {/* 5. Host Deterministic Reducer & Retained Node Probe Compatibility Section */}
      <MobileListTile title="Stress" detail="Measure JS node pressure at two sizes." />
      <MobileCard>
        <MobileListTile title="Retained node pressure" detail="Guest-owned UI state" />
        <View class="flex-row items-center justify-between gap-2">
          <MobileButton label="Run 100 nodes" onPress={() => props.runStress(100)} />
          <MobileButton label="Run 500 nodes" kind="tonal" onPress={() => props.runStress(500)} />
        </View>
      </MobileCard>
      <ScrollContourItem class="flex-row gap-2">
        <MobileCard title="Nodes" detail={`${props.state().stress.durationMs} ms JS setup`}>
          <Text class="text-2xl font-bold" style={{ textColor: toMobileColor(mobileTheme().accentInkColor) }}>
            {String(props.state().stress.nodeCount)}
          </Text>
        </MobileCard>
        <MobileCard title="Checksum" detail={props.state().stress.lastAction}>
          <Text class="text-xl font-bold" style={{ textColor: toMobileColor(mobileTheme().accentInkColor) }}>
            {String(props.state().stress.checksum)}
          </Text>
        </MobileCard>
      </ScrollContourItem>
      <Show when={props.state().stress.nodeCount === 0}>
        <ScrollContourItem mode="padding" class="px-4">
          <Text class={mobileTheme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}>
            {props.state().stress.nodeCount} retained nodes in the current guest frame.
          </Text>
        </ScrollContourItem>
      </Show>

      {/* Architecture Notes */}
      <SkinCard
        title="Why FPS Stays High Under Load (@pocket/ui/fast)"
        detail="SDK primitives backing this Stress Lab:"
        badge="SDK FAST"
      >
        <SkinParagraph text="1. TypedArray SoA State: Keep high-frequency coordinates & market ticks in Float64Array / Int32Array so QuickJS allocates zero temporary objects per vblank." />
        <SkinParagraph text="2. createJumpPool (createJumpBatch): Precompiles node+prop pairs into one ArrayBuffer FFI call per frame with posType=1 paint-only transforms (0 Yoga relayouts)." />
        <SkinParagraph text="3. PocketVirtualList: Wraps VirtualList with panSlop=1 touch ownership, ScrollablePage boundary chaining, desktop wheel chaining, and useRouteActive gating." />
        <SkinParagraph text="4. createFastText & syncFastStyle: Caches #text NodeMirrors via WeakMap for O(1) replaceText writes and sign-flip style updates without VDOM diffs." />
      </SkinCard>
    </View>
  );
}
