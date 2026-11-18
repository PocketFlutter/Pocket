import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { performance } from "node:perf_hooks";
import { backIconPoint } from "./navigation_geometry.ts";
import {
  NativeSession,
  center,
  readNativeArtifacts,
  textOf,
  textOps,
  type DrawOp,
  type Frame,
} from "./native_session.ts";

const width = 390;
const height = 760;

function findVisibleText(frame: Frame, substring: string): DrawOp | undefined {
  return (frame.ops ?? []).find((op) => {
    if (op.type !== "text" || typeof op.text !== "string" || !op.text.includes(substring)) {
      return false;
    }
    const top = op.y ?? -Infinity;
    const bottom = top + (op.h ?? 0);
    const clipTop = Math.max(0, op.clip?.y ?? 0);
    const clipBottom = Math.min(frame.height ?? height, (op.clip?.y ?? 0) + (op.clip?.h ?? Infinity));
    return top >= clipTop && bottom <= clipBottom;
  });
}

async function revealVisibleText(
  session: NativeSession,
  frame: Frame,
  substring: string,
  fromY = 640,
  toY = 260,
): Promise<{ frame: Frame; op: DrawOp }> {
  let latest = frame;
  let visible = findVisibleText(latest, substring);
  for (let attempt = 0; !visible && attempt < 8; attempt += 1) {
    latest = await session.settle(
      await session.drag({ x: 20, y: fromY }, { x: 20, y: toY }, 8, 4),
      8,
    );
    visible = findVisibleText(latest, substring);
  }
  assert.ok(visible, `expected "${substring}" to become visible\n${textOf(latest)}`);
  return { frame: latest, op: visible! };
}

function particleRectSignature(frame: Frame): string {
  return (frame.ops ?? [])
    .filter(
      (op) =>
        (op.type === "rounded" || op.type === "rect") &&
        (op.w ?? 0) >= 4 &&
        (op.w ?? 0) <= 10 &&
        (op.h ?? 0) >= 4 &&
        (op.h ?? 0) <= 10,
    )
    .slice(0, 12)
    .map((op) => `${Math.round((op.x ?? 0) * 10)},${Math.round((op.y ?? 0) * 10)}`)
    .join("|");
}

async function measureSustainedFps(
  session: NativeSession,
  benchmarkFrames: number,
): Promise<{
  frame: Frame;
  fps: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  sigBefore: string;
  sigAfter: string;
}> {
  let frame = await session.frame();
  for (let w = 0; w < 10; w += 1) {
    frame = await session.frame();
  }
  const sigBefore = particleRectSignature(frame);
  const frameDurationsMs: number[] = [];
  const wallStart = performance.now();
  for (let i = 0; i < benchmarkFrames; i += 1) {
    const f0 = performance.now();
    frame = await session.frame();
    frameDurationsMs.push(performance.now() - f0);
  }
  const totalWallMs = performance.now() - wallStart;
  const sigAfter = particleRectSignature(frame);
  const sorted = [...frameDurationsMs].sort((a, b) => a - b);
  const avgMs = totalWallMs / benchmarkFrames;
  const p50Ms = sorted[Math.floor(sorted.length * 0.5)]!;
  const p95Ms = sorted[Math.floor(sorted.length * 0.95)]!;
  const fps = 1000 / Math.max(0.01, avgMs);
  return { frame, fps, avgMs, p50Ms, p95Ms, sigBefore, sigAfter };
}

test(
  "High-FPS Stress Lab sustains >= 120 FPS native frame throughput under 100,000 VirtualList rows + 384/512 orbital particles + arena vortex drag + nested PocketVirtualList touch pan",
  { timeout: 60_000 },
  async () => {
    const session = new NativeSession(readNativeArtifacts("POCKET_STRESS_FPS"), {
      width,
      height,
    });
    try {
      let frame = await session.boot();

      // 1. Deep-link straight into Extreme Load (384 particles + 100,000 rows + 6,000 mutations/frame)
      session.sendEvent("router.open", {
        url: "pocket://showcase/stress?skin=arc&dark=1&preset=extreme&particles=384&rows=100000&mutations=6000&batch=1&running=1",
      });
      frame = await session.settle(await session.frame(), 12);

      const initialTexts = textOf(frame).replace(/\s+/g, " ");
      assert.match(initialTexts, /High-FPS Extreme Load Stress Lab/);
      assert.match(initialTexts, /LIVE 60\/120HZ/);
      assert.match(initialTexts, /2D Orbital Swarm \(384 Retained Particles\)/);

      // Verify O(viewport) VirtualList node bounding: even with 100,000 rows + 384 particles,
      // total DrawList ops stay strictly bounded (< 950 ops rather than 100,000+ ops!).
      const opCount = frame.ops?.length ?? 0;
      assert.ok(
        opCount > 384 && opCount < 950,
        `expected O(viewport) bounded DrawList ops (385..950), got ${opCount}`,
      );

      // 2. Benchmark 180 consecutive live native frames at Extreme preset (384p + 100k rows + 6k muts/f)
      const extremeRun = await measureSustainedFps(session, 180);
      frame = extremeRun.frame;
      assert.notEqual(
        extremeRun.sigAfter,
        extremeRun.sigBefore,
        "orbital swarm particles must continuously animate across frames without stalling",
      );
      console.log(
        `[stress_high_fps_native] Extreme (384p + 100k rows + 6k muts/f) -> ` +
          `achieved=${extremeRun.fps.toFixed(1)} FPS | avg=${extremeRun.avgMs.toFixed(2)}ms | ` +
          `p50=${extremeRun.p50Ms.toFixed(2)}ms | p95=${extremeRun.p95Ms.toFixed(2)}ms | ops=${frame.ops?.length ?? 0}`,
      );
      assert.ok(
        extremeRun.fps >= 120,
        `expected sustained >= 120 FPS under Extreme stress, got ${extremeRun.fps.toFixed(1)} FPS (avg ${extremeRun.avgMs.toFixed(2)} ms)`,
      );
      assert.ok(
        extremeRun.p95Ms < 12.5,
        `expected p95 frame time < 12.5ms under Extreme stress, got ${extremeRun.p95Ms.toFixed(2)} ms`,
      );

      // Guard against double-run <Text> writes (must replace #text child cleanly, never "240 FPS60 FPS")
      assert.doesNotMatch(
        textOf(frame),
        /\d+\s*FPS\d+\s*FPS/,
        "FastText must update the #text child mirror cleanly without side-by-side duplicate text runs",
      );

      // 2b. Scroll arena caption into view and verify touch-tapping the 2D Orbital Swarm arena
      //     resolves finite local coordinates (no NaN!) and dispatches a radial shockwave!
      const arenaHint = await revealVisibleText(session, frame, "Touch/drag arena", 560, 340);
      frame = arenaHint.frame;
      const arenaTapPoint = {
        x: Math.round(width * 0.5),
        y: Math.max(120, Math.round((arenaHint.op.y ?? 420) - 72)),
      };
      frame = await session.settle(await session.tapPoint(arenaTapPoint), 4);
      assert.doesNotMatch(
        textOf(frame),
        /NaN/,
        "arena touch/tap must never introduce NaN into vortex coordinates or HUD",
      );
      assert.match(
        textOf(frame),
        /Impulse shockwave dispatched!/,
        "tapping the orbital arena must trigger a radial shockwave with finite coordinates",
      );

      // 3. Push to Maximum 512 Particles + 100,000 Rows + 8,000 mutations/frame (batched router update) and verify >= 120 FPS!
      const maxBtn = await revealVisibleText(session, frame, "Max 512 Particles", 320, 520);
      frame = await session.settle(await session.tapPoint(center(maxBtn.op, "Max 512 Particles")), 12);
      assert.match(textOf(frame).replace(/\s+/g, " "), /2D Orbital Swarm \(512 Retained Particles\)/);

      const maxRun = await measureSustainedFps(session, 120);
      frame = maxRun.frame;
      console.log(
        `[stress_high_fps_native] Max Overdrive (512p + 100k rows + 8k muts/f) -> ` +
          `achieved=${maxRun.fps.toFixed(1)} FPS | avg=${maxRun.avgMs.toFixed(2)}ms | ` +
          `p50=${maxRun.p50Ms.toFixed(2)}ms | p95=${maxRun.p95Ms.toFixed(2)}ms | ops=${frame.ops?.length ?? 0}`,
      );
      assert.ok(
        maxRun.fps >= 120,
        `expected sustained >= 120 FPS under Max 512p stress, got ${maxRun.fps.toFixed(1)} FPS (avg ${maxRun.avgMs.toFixed(2)} ms)`,
      );

      // 4. Scroll down so the 100,000-row PocketVirtualList viewport is fully visible:
      //    first verify DIRECT vertical touch-dragging inside the nested PocketVirtualList
      //    scrolls rows directly without ScrollablePage stealing the pan at 2px!
      const inspectedFooter = await revealVisibleText(session, frame, "Inspected Row:");
      frame = inspectedFooter.frame;
      const footerYBeforeListDrag = inspectedFooter.op.y ?? 0;
      const rowZeroOp =
        (frame.ops ?? []).find((op) => op.type === "text" && op.text === "AI-000000") ??
        (frame.ops ?? []).find((op) => op.type === "text" && op.text === "GPU-000001");
      assert.ok(rowZeroOp, `expected initial rows (AI-000000/GPU-000001) visible inside PocketVirtualList\n${textOf(frame)}`);
      const listCenterX = Math.round((rowZeroOp!.x ?? 80) + 80);
      const listDragStartY = Math.round((rowZeroOp!.y ?? 420) + 140);
      const listDragEndY = Math.round(listDragStartY - 136);
      frame = await session.settle(
        await session.drag(
          { x: listCenterX, y: listDragStartY },
          { x: listCenterX, y: listDragEndY },
          8,
          4,
        ),
        12,
      );
      assert.equal(
        (frame.ops ?? []).find((op) => op.type === "text" && op.text === "AI-000000"),
        undefined,
        "direct vertical touch drag inside nested PocketVirtualList must scroll row AI-000000 out of view instead of being stolen by ScrollablePage",
      );
      const footerAfterListDrag = findVisibleText(frame, "Inspected Row:");
      assert.ok(footerAfterListDrag, "Inspected Row footer must remain visible while dragging inside PocketVirtualList");
      assert.ok(
        Math.abs((footerAfterListDrag!.y ?? 0) - footerYBeforeListDrag) <= 2,
        `outer ScrollablePage must not steal in-bounds PocketVirtualList drag (footer y ${footerYBeforeListDrag} -> ${footerAfterListDrag!.y})`,
      );

      // Then jump to Mid #50,000 while live!
      const midBtnOp = findVisibleText(frame, "Mid #50,000");
      assert.ok(midBtnOp, `expected "Mid #50,000" button visible above PocketVirtualList\n${textOf(frame)}`);
      frame = await session.settle(
        await session.tapPoint(center(midBtnOp, "Mid #50,000")),
        32,
      );
      assert.match(
        textOf(frame),
        /-0(?:4999\d|5000\d)/,
        "PocketVirtualList must chase-scroll to the #50,000 neighborhood cleanly under heavy load",
      );

      // 5. Verify HUD throughput text updated imperatively via FastText / replaceText
      assert.ok(
        textOps(frame, "Streaming SoA TypedArrays · 0 GC allocations/frame").length === 0,
        "throughput HUD should advance dynamically from its initial placeholder",
      );

      // 6. Pop back via synthesized parent stack -> lands on Host (`Runtime`)
      const cleanAppBarFrame: Frame = {
        ...frame,
        ops: (frame.ops ?? []).filter((op) => !(op.type === "text" && op.text === "Back")),
      };
      frame = await session.settle(await session.tapPoint(backIconPoint(cleanAppBarFrame)), 24);
      assert.match(textOf(frame), /Runtime/);
    } finally {
      await session.quit();
    }
  },
);
