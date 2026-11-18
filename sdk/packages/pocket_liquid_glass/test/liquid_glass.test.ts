import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import module from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir =
  (import.meta as { dirname?: string; dir?: string }).dirname ??
  (import.meta as { dir?: string }).dir ??
  resolve(fileURLToPath(import.meta.url), "..");
const packageRoot = resolve(testDir, "..");
const sdkRoot = resolve(packageRoot, "../..");
const srcDir = join(packageRoot, "src");
const upstreamDir = join(sdkRoot, ".cache/pocketjs");
const reqUpstream = module.createRequire(join(upstreamDir, "package.json"));
const typescript = reqUpstream("typescript");

if (typeof module.registerHooks === "function") {
  let inHook = false;
  module.registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith("file:") || !/\.tsx?$/.test(url)) {
        return nextLoad(url, context);
      }
      const fileName = fileURLToPath(url);
      // The pinned framework uses TypeScript parameter properties, which
      // Node's strip-only loader cannot execute.
      const result = typescript.transpileModule(readFileSync(fileName, "utf8"), {
        fileName,
        compilerOptions: {
          module: typescript.ModuleKind.ESNext,
          target: typescript.ScriptTarget.ESNext,
          jsx: typescript.JsxEmit.React,
        },
      });
      return { format: "module", shortCircuit: true, source: result.outputText };
    },
    resolve(specifier, context, nextResolve) {
      if (specifier === "solid-js") {
        return {
          url: pathToFileURL(reqUpstream.resolve("solid-js/dist/solid.js")).href,
          shortCircuit: true,
        };
      }
      if (specifier === "@pocketjs/framework/clock") {
        return {
          url: pathToFileURL(join(upstreamDir, "framework/src/clock.ts")).href,
          shortCircuit: true,
        };
      }
      if (specifier === "@pocketjs/framework/solid/lifecycle") {
        return {
          url: pathToFileURL(join(upstreamDir, "framework/src/lifecycle.ts")).href,
          shortCircuit: true,
        };
      }
      if (specifier === "@pocketjs/framework/animation") {
        return {
          url: pathToFileURL(join(upstreamDir, "framework/src/animation.ts")).href,
          shortCircuit: true,
        };
      }
      if (specifier === "@pocketjs/framework/gesture") {
        return {
          url: pathToFileURL(join(upstreamDir, "framework/src/gesture.ts")).href,
          shortCircuit: true,
        };
      }
      if (specifier === "@pocketjs/framework/renderer") {
        return {
          url: pathToFileURL(join(upstreamDir, "framework/src/renderer.ts")).href,
          shortCircuit: true,
        };
      }
      if (specifier === "@pocketjs/framework/solid/components") {
        return {
          url: pathToFileURL(join(upstreamDir, "framework/src/components.ts")).href,
          shortCircuit: true,
        };
      }
      if (specifier === "@pocket/ui/fast") {
        return {
          url: pathToFileURL(join(sdkRoot, "packages/pocket_ui/src/fast.tsx")).href,
          shortCircuit: true,
        };
      }
      if (specifier === "@pocket/ui") {
        return {
          url: pathToFileURL(join(sdkRoot, "packages/pocket_ui/src/index.ts")).href,
          shortCircuit: true,
        };
      }
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        if (
          !inHook &&
          !specifier.startsWith(".") &&
          !specifier.startsWith("/") &&
          !specifier.startsWith("file:")
        ) {
          inHook = true;
          try {
            return {
              url: pathToFileURL(reqUpstream.resolve(specifier)).href,
              shortCircuit: true,
            };
          } finally {
            inHook = false;
          }
        }
        throw err;
      }
    },
  });
}

const {
  LIQUID_GLASS_ACCENTS,
  concentricGlassRadius,
  hexToArgb,
  resolveLiquidGlassPalette,
  resolveOpticalRecipe,
} = await import("../src/tokens.ts");
const {
  GLASS_SPRINGS,
  createGlassSpring,
  quantizeOptical,
  stepGlassSpring,
} = await import("../src/motion.ts");
const {
  TIER_GPU_BUDGET,
  TIER_OVERLAY_RESERVE,
  createLiquidGlassGovernor,
  createGlassFrameProfiler,
} = await import("../src/governor.ts");
const {
  parseClassLiteral,
  unknownUtilities,
} = await import(pathToFileURL(join(upstreamDir, "framework/compiler/tailwind.ts")).href);

const { createRoot, createSignal, createRenderEffect } = await import("solid-js");
const { runFrameHooks } = await import(
  pathToFileURL(join(upstreamDir, "framework/src/frame.ts")).href
);
const { hasContinuousFrameWork } = await import(
  pathToFileURL(join(upstreamDir, "framework/src/frame-dispatch.ts")).href
);

export function runLiquidGlassPackageTests(): void {
  // 1. Concentric geometry & ARGB color helpers
  assert.equal(concentricGlassRadius(30, 8), 22);
  assert.equal(concentricGlassRadius(22, 8), 14);
  assert.equal(concentricGlassRadius(14, 12, 8), 8);
  assert.equal(concentricGlassRadius(999, 6), 999);
  assert.equal(concentricGlassRadius(Number.NaN, 6, 8), 8);

  assert.equal(hexToArgb("#007AFF"), 0xff007aff);
  assert.equal(hexToArgb("#FF9A00"), 0xffff9a00);
  assert.equal(hexToArgb("invalid", 0xff112233), 0xff112233);

  // 2. All 11 named accents + custom #RRGGBB across light, dark, and 0%-blue amber-night
  for (const acc of LIQUID_GLASS_ACCENTS) {
    const light = resolveLiquidGlassPalette("light", acc);
    const dark = resolveLiquidGlassPalette("dark", acc);
    assert.equal(light.mode, "light");
    assert.equal(light.dark, false);
    assert.equal(dark.mode, "dark");
    assert.equal(dark.dark, true);
    assert.equal(light.accentName, acc);
    assert.equal(dark.accentName, acc);
    assert.notEqual(light.canvasBg, dark.canvasBg);
  }

  const customLight = resolveLiquidGlassPalette("light", "#14b8a6");
  const customDark = resolveLiquidGlassPalette("dark", "#14b8a6");
  assert.equal(customLight.accentHex, "#14B8A6");
  assert.equal(customDark.accentHex, "#14B8A6");

  const amber = resolveLiquidGlassPalette("amber-night", "violet");
  assert.equal(amber.mode, "amber-night");
  assert.equal(amber.dark, true);

  const assertZeroBlueAndNoTransparent = (val: unknown, keyPath: string): void => {
    if (typeof val === "string") {
      assert.notEqual(val, "transparent", `Forbidden transparent string at ${keyPath}`);
      if (val.startsWith("#") && val.length >= 7) {
        assert.equal(
          val.slice(5, 7).toUpperCase(),
          "00",
          `Expected 00 blue channel at ${keyPath}: ${val}`,
        );
      }
    } else if (val && typeof val === "object") {
      for (const [k, v] of Object.entries(val)) {
        assertZeroBlueAndNoTransparent(v, `${keyPath}.${k}`);
      }
    }
  };
  assertZeroBlueAndNoTransparent(amber, "amber");

  // 3. Optical recipes (`clear`, `regular`, `thick`, `chrome` + `amber-night` zero-GPU-pass rule)
  const light = resolveLiquidGlassPalette("light", "blue");
  const clear = resolveOpticalRecipe("clear", light);
  assert.equal(clear.usesGpuBackdrop, true);
  assert.equal(clear.shaderMaterial, "clear");
  assert.equal(clear.blurSigma, 0);

  const regular = resolveOpticalRecipe("regular", light);
  assert.equal(regular.usesGpuBackdrop, true);
  assert.equal(regular.shaderMaterial, "regular");
  assert.equal(regular.blurSigma, 10);
  assert.equal(regular.warp, true);

  const thick = resolveOpticalRecipe("thick", light);
  assert.equal(thick.usesGpuBackdrop, true);
  assert.equal(thick.blurSigma, 16);

  const chrome = resolveOpticalRecipe("chrome", light);
  assert.equal(chrome.usesGpuBackdrop, false);

  const amberRegular = resolveOpticalRecipe("regular", amber);
  assert.equal(amberRegular.usesGpuBackdrop, false);

  // 4. Spring solver convergence, spike stability & optical quantization
  const rm = stepGlassSpring(
    { value: 0, velocity: 15, settled: false },
    1,
    1 / 60,
    GLASS_SPRINGS.fluid,
    true,
  );
  assert.deepEqual(rm, { value: 1, velocity: 0, settled: true });

  const spike = stepGlassSpring(
    { value: 0, velocity: 0, settled: false },
    1,
    4.5,
    GLASS_SPRINGS.tactile,
    false,
  );
  assert.ok(Number.isFinite(spike.value) && spike.value > 0 && spike.value < 1.5);

  for (const preset of ["fluid", "tactile", "jelly", "sheet", "morph", "snappy"] as const) {
    let st = { value: 0, velocity: 0, settled: false };
    for (let frame = 0; frame < 140 && !st.settled; frame += 1) {
      st = stepGlassSpring(st, 100, 1 / 60, GLASS_SPRINGS[preset], false);
    }
    assert.equal(st.settled, true, `Preset ${preset} should settle`);
    assert.equal(st.value, 100);
    assert.equal(st.velocity, 0);
  }

  assert.equal(quantizeOptical(1.002, 0.005, 1), 1);
  assert.ok(Math.abs(quantizeOptical(1.1234, 0.01, 1) - 1.12) < 1e-6);

  const reactiveSpring = createRoot((dispose) => {
    const [goal, setGoal] = createSignal(210);
    return {
      value: createGlassSpring(goal, { preset: "morph", quantizeStep: 0.5 }),
      setGoal,
      dispose,
    };
  });
  try {
    reactiveSpring.setGoal(280);
    assert.ok(hasContinuousFrameWork(), "a new spring target requests frames");
    const initialFrame = stepGlassSpring(
      { value: 210, velocity: 0, settled: false }, 280, 1 / 60, GLASS_SPRINGS.morph,
    );
    runFrameHooks(1);
    assert.equal(reactiveSpring.value(), quantizeOptical(initialFrame.value, 0.5, 280));
    for (let frame = 0; frame < 140 && hasContinuousFrameWork(); frame += 1) {
      runFrameHooks(0);
    }
    assert.equal(reactiveSpring.value(), 280);
    assert.equal(hasContinuousFrameWork(), false, "quantized rendering must not keep the solver awake");
    reactiveSpring.setGoal(350);
    assert.ok(hasContinuousFrameWork());
  } finally {
    reactiveSpring.dispose();
  }
  assert.equal(hasContinuousFrameWork(), false, "unmount removes the spring work hint");

  // 5. Prioritized >=60 FPS GPU Governor (`critical > high > normal > low` + `autoAdapt`)
  assert.deepEqual(TIER_GPU_BUDGET, {
    ultra: 16,
    balanced: 8,
    performance: 3,
    vector: 0,
  });
  assert.deepEqual(TIER_OVERLAY_RESERVE, {
    ultra: 4,
    balanced: 2,
    performance: 1,
    vector: 0,
  });

  const gov = createLiquidGlassGovernor({
    initialTier: "performance",
    targetFps: 60,
    minFps: 58,
    autoAdapt: true,
  });
  assert.equal(gov.budget(), 3);

  const low1 = gov.acquireLease("low");
  const normal1 = gov.acquireLease("normal");
  const normal2 = gov.acquireLease("normal");
  assert.equal(low1.granted(), true);
  assert.equal(normal1.granted(), true);
  assert.equal(normal2.granted(), true);
  assert.equal(gov.activeGpuCount(), 3);

  // Higher priority still outranks a lower-priority incumbent...
  const normal3 = gov.acquireLease("normal");
  assert.equal(normal3.granted(), true);
  assert.equal(low1.granted(), false);
  // ...but an equal-priority newcomer must not evict a visible peer.
  const normal4 = gov.acquireLease("normal");
  assert.equal(normal4.granted(), false, "over-budget equal-priority newcomer waits");
  assert.equal(normal1.granted(), true);
  assert.equal(normal2.granted(), true);
  assert.equal(normal3.granted(), true);
  normal4.release();
  normal3.release();
  assert.equal(low1.granted(), true);

  // A critical overlay first consumes the overlay reserve, so the resting
  // surfaces underneath keep their refractive leases while it animates.
  const crit1 = gov.acquireLease("critical");
  assert.equal(crit1.granted(), true);
  assert.equal(low1.granted(), true, "overlay reserve must not evict resting surfaces");
  assert.equal(normal1.granted(), true);
  assert.equal(gov.activeGpuCount(), 4);
  assert.equal(gov.totalRegisteredCount(), 4);

  // Once the reserve is exhausted, a second overlay displaces the lowest slot.
  const crit2 = gov.acquireLease("critical");
  assert.equal(crit2.granted(), true);
  assert.equal(low1.granted(), false);
  assert.equal(gov.activeGpuCount(), 4);
  crit2.release();
  assert.equal(low1.granted(), true);

  crit1.release();
  assert.equal(crit1.granted(), false, "released leases must stop reporting admission");
  crit1.release();
  assert.equal(low1.granted(), true);
  assert.equal(gov.activeGpuCount(), 3);

  let t = 1000;
  for (let i = 0; i < 40; i += 1) {
    gov.recordFrameSample(t, t + 24);
    t += 26;
  }
  assert.equal(gov.tier(), "vector");
  assert.equal(gov.activeGpuCount(), 0);
  assert.equal(low1.granted(), false);
  assert.equal(normal1.granted(), false);

  low1.release();
  normal1.release();
  normal2.release();
  assert.equal(gov.totalRegisteredCount(), 0);

  const profile = createGlassFrameProfiler();
  for (const begin of [10, 30, 50]) {
    profile.beginFrame(begin);
    profile.endFrame(begin + 3);
  }
  assert.equal(profile.frames(), 3);
  assert.equal(profile.snapshot().avgWorkMs, 3);
  assert.equal(profile.snapshot().fps, 50);
  profile.reset();
  assert.equal(profile.frames(), 0);

  createRoot((dispose) => {
    try {
      const adaptive = createLiquidGlassGovernor();
      createRenderEffect(() => adaptive.setTier("ultra"));
      for (let frame = 0; frame < 80; frame += 1) {
        adaptive.recordFrameSample(1000 + frame * 26, 1024 + frame * 26);
      }
      assert.equal(adaptive.tier(), "vector", "applying a fixed external tier must not subscribe to internal adaptation");
    } finally { dispose(); }
  });

  // 6. 10,000-frame JS budget benchmark (< 0.05 ms/frame => > 20,000 FPS JS headroom!)
  const benchGov = createLiquidGlassGovernor({ initialTier: "ultra", autoAdapt: true });
  const leases = Array.from({ length: 12 }, (_, idx) =>
    benchGov.acquireLease(idx < 2 ? "critical" : idx < 6 ? "high" : "normal"),
  );
  assert.equal(benchGov.activeGpuCount(), 12);
  const zeroGov = createLiquidGlassGovernor({ maxGpuSurfaces: 0 });
  const zeroCritical = zeroGov.acquireLease("critical");
  assert.equal(zeroCritical.granted(), false, "a zero budget admits no overlay reserve either");
  zeroCritical.release();

  let spring = { value: 0, velocity: 0, settled: false };
  const startMs = performance.now();
  let simClock = 0;
  for (let f = 0; f < 10_000; f += 1) {
    const target = (f & 64) === 0 ? 100 : 0;
    spring = stepGlassSpring(spring, target, 1 / 120, GLASS_SPRINGS.fluid, false);
    const q = quantizeOptical(1 + spring.value * 0.002, 0.005, 1);
    if (q < 0) throw new Error("unreachable");
    benchGov.recordFrameSample(simClock, simClock + 0.35);
    simClock += 8.333;
  }
  const elapsedMs = performance.now() - startMs;
  const avgMsPerFrame = elapsedMs / 10_000;
  assert.ok(
    avgMsPerFrame < 0.05,
    `Expected < 0.05 ms/frame, got ${avgMsPerFrame.toFixed(4)} ms/frame`,
  );
  assert.equal(benchGov.tier(), "ultra");
  for (const l of leases) l.release();

  // 7. Static `--strict-classes` & PocketJS native style compliance across all package files
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
  assert.ok(files.length >= 9);

  for (const file of files) {
    const source = readFileSync(join(srcDir, file), "utf8");
    for (const m of source.matchAll(/\b(?:class|contentClass|panelClass|backdropClass)="([^"]+)"/g)) {
      const lit = m[1]!;
      assert.deepEqual(
        unknownUtilities(lit),
        [],
        `Unknown Tailwind utility in ${file}: "${lit}"`,
      );
      assert.notEqual(
        parseClassLiteral(lit),
        null,
        `Failed parseClassLiteral in ${file}: "${lit}"`,
      );
      const tokens = lit.trim().split(/\s+/);
      assert.equal(
        tokens.includes("text-2xs") && tokens.includes("font-mono"),
        false,
        `Forbidden text-2xs + font-mono combo in ${file}: "${lit}"`,
      );
    }

    assert.equal(
      /(?:bgColor|borderColor|textColor|gradFrom|gradTo)\s*:\s*["']transparent["']/.test(source),
      false,
      `Forbidden "transparent" color prop in ${file}`,
    );
  }
}

runLiquidGlassPackageTests();
console.log("@pocket/liquid_glass unit, strict-class and governor tests passed!");
