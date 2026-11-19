import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { NativeSession, pointer, readNativeArtifacts, textOf, textOp, textOps } from "./native_session.ts";

test("the Showcase UIKit Gallery supports native pointer navigation, controls, and deep links", async () => {
  const session = new NativeSession(readNativeArtifacts("POCKET_LIQUID_GLASS"), {
    width: 390,
    height: 844,
  });

  try {
    await session.boot();
    session.sendEvent("demo.navigate", { route: "uikit-gallery" });
    let frame = await session.settle(await session.frame());
    textOp(frame, "UIKit Gallery");
    textOp(frame, "BARS & PRESENTATION");

    frame = await session.settle(await session.tap("Button", frame));
    textOp(frame, "Configurations");
    frame = await session.settle(await session.tap("Selected ✓", frame));
    textOp(frame, "Select");
    frame = await session.settle(await session.tap("Select", frame));
    textOp(frame, "Selected ✓");

    frame = await session.settle(await session.tap("Format: Keep Original Format", frame));
    textOp(frame, "Choose a Format");
    frame = await session.settle(await session.tap("Convert to Most Compatible", frame));
    assert.match(textOf(frame), /Format: Convert to Most Compatible/);
    assert.equal(textOps(frame, "Choose a Format").length, 0);

    // The pop spring settles in ~35 frames at the guest's 60 Hz tick.
    frame = await session.settle(await session.tap("UIKit Gallery", frame), 45);
    textOp(frame, "BARS & PRESENTATION");
    assert.equal(textOps(frame, "Configurations").length, 0);

    session.sendEvent("demo.openUrl", {
      url: "pocket://showcase/uikit-gallery?component=switch",
    });
    frame = await session.settle(await session.frame());
    textOp(frame, "SwitchModernVisualElement");
    textOp(frame, "Liquid Glass Optics");
  } finally {
    await session.quit();
  }
}, 30_000);

type GlassSample = { x: number; y: number; w: number; h: number; material?: string; blur: number; opacity: number; magnification: number };

function glassSurfaces(frame: { ops?: Array<Record<string, unknown>> }): GlassSample[] {
  return (frame.ops ?? []).filter((op) => op.type === "hostSurface" && typeof op.asset === "string").map((op) => {
    const parameters = (JSON.parse(op.asset as string) as { parameters?: Record<string, unknown> }).parameters ?? {};
    return {
      x: Number(op.x), y: Number(op.y), w: Number(op.w), h: Number(op.h),
      material: parameters.material as string | undefined,
      blur: Number(parameters.blur ?? 0),
      opacity: Number(parameters.opacity ?? 1),
      magnification: Number(parameters.magnification ?? 1),
    };
  });
}

test("Liquid Glass overlays crossfade and morph glass geometry, commit press-drag-release, and keep one switch droplet", async () => {
  const session = new NativeSession(readNativeArtifacts("POCKET_LIQUID_GLASS"), { width: 390, height: 844 });
  try {
    await session.boot();

    // 1. Menu platter: the optical glass fades through its own opacity while
    // its logical quad grows; no affine scale squashes the bevel.
    session.sendEvent("demo.openUrl", { url: "pocket://showcase/uikit-gallery?component=button" });
    let frame = await session.settle(await session.frame(), 20);
    const resting = glassSurfaces(frame);
    const restingKeys = new Set(resting.map((surface) => `${surface.x},${surface.y},${surface.w},${surface.h}`));
    const trigger = textOp(frame, "Format: Keep Original Format");
    session.send(pointer("down", trigger.x + 4, trigger.y + 4));
    await session.frame();
    session.send(pointer("up", trigger.x + 4, trigger.y + 4));
    const platter: GlassSample[] = [];
    for (let index = 0; index < 24; index += 1) {
      frame = await session.frame();
      const added = glassSurfaces(frame).filter((surface) =>
        surface.material === "regular" && !restingKeys.has(`${surface.x},${surface.y},${surface.w},${surface.h}`));
      if (added.length > 0) platter.push(added.at(-1)!);
    }
    assert.ok(platter.length >= 6, "the menu platter must register an optical surface");
    assert.ok(platter[0]!.opacity < 0.5, `platter glass must start translucent, got ${platter[0]!.opacity}`);
    assert.equal(platter.at(-1)!.opacity, 1, "platter glass must settle at full opacity");
    for (let index = 1; index < platter.length; index += 1) {
      assert.ok(platter[index]!.opacity + 1e-6 >= platter[index - 1]!.opacity, "platter glass opacity must not pop or dip while opening");
    }
    assert.ok(platter.at(-1)!.h > platter[0]!.h + 40, "the glass quad must grow its logical height from the trigger");
    const stillGlass = glassSurfaces(frame).filter((surface) => restingKeys.has(`${surface.x},${surface.y},${surface.w},${surface.h}`));
    assert.ok(stillGlass.length >= resting.length - 1, "underlying resting glass keeps its leases (only the faded trigger pill may release)");

    frame = await session.settle(await session.tap("Convert to Most Compatible", frame), 24);
    assert.match(textOf(frame), /Format: Convert to Most Compatible/);

    // 2. Single-stroke press-drag-release from the trigger selects a row.
    session.sendEvent("demo.navigate", { route: "uikit-gallery" });
    frame = await session.settle(await session.frame(), 20);
    const options = textOp(frame, "Options");
    const start = { x: options.x + options.w / 2, y: options.y + options.h / 2 };
    session.send(pointer("down", start.x, start.y));
    await session.frame();
    let y = start.y;
    for (let index = 0; index < 12; index += 1) {
      y += 3;
      session.send(pointer("move", start.x, y));
      frame = await session.frame();
    }
    const wallpaper = textOp(frame, "Wallpaper");
    const target = { x: wallpaper.x + 10, y: wallpaper.y + 6 };
    for (let index = 1; index <= 6; index += 1) {
      session.send(pointer("move", start.x + (target.x - start.x) * index / 6, y + (target.y - y) * index / 6));
      frame = await session.frame();
    }
    session.send(pointer("up", target.x, target.y));
    const rowY: number[] = [];
    for (let index = 0; index < 18; index += 1) {
      frame = await session.frame();
      const row = textOps(frame, "Circles Blue")[0];
      if (row) rowY.push(Number(row.y));
    }
    assert.ok(rowY.length > 0, "releasing over a submenu row must commit it and push the submenu");
    assert.ok(textOps(frame, "iPadOS Waves").length > 0, "the pushed submenu lists its sibling rows");
    assert.ok(rowY[0]! > rowY.at(-1)! + 4, `submenu rows must slide into place, got ${rowY.join(",")}`);

    frame = await session.settle(await session.tap("Circles Blue", frame), 24);
    assert.equal(textOps(frame, "iPadOS Waves").length, 0, "selecting a submenu leaf closes the menu");

    // 3. Switch: one persistent droplet fades from opaque pill to clear lens.
    session.sendEvent("demo.openUrl", { url: "pocket://showcase/uikit-gallery?component=switch" });
    frame = await session.settle(await session.frame(), 24);
    const label = textOp(frame, "Liquid Glass Optics");
    const track = (frame.ops ?? []).find((op) => Math.round(Number(op.w)) === 60 && Math.round(Number(op.h)) === 32 && Math.abs(Number(op.y) - Number(label.y)) < 40);
    assert.ok(track, "the switch track must be painted next to its label");
    const droplet = (current: typeof frame) => glassSurfaces(current).filter((surface) => surface.material === "clear" && surface.w < 160 && surface.opacity < 1);
    const press = { x: Number(track!.x) + 12, y: Number(track!.y) + 16 };
    session.send(pointer("down", press.x, press.y));
    const held: GlassSample[] = [];
    for (let index = 0; index < 10; index += 1) {
      frame = await session.frame();
      const lens = droplet(frame)[0];
      if (lens) held.push(lens);
    }
    assert.ok(held.length >= 5, "holding the switch must show its clear droplet");
    assert.ok(held[0]!.opacity < 0.4 && held.at(-1)!.opacity > 0.8, `droplet must fade in continuously, got ${held.map((s) => s.opacity).join(",")}`);
    assert.ok(held.at(-1)!.magnification > 1.1, "the lifted droplet magnifies its backdrop");
    session.send(pointer("up", press.x, press.y));
    frame = await session.settle(await session.frame(), 20);
    assert.equal(droplet(frame).length, 0, "the droplet fades out and releases its surface at rest");
  } finally {
    await session.quit();
  }
}, 30_000);

test("UIKit Gallery motion matches the uikit.even.how reference captures", async () => {
  // Reference numbers: sdk/docs/LIQUID_GLASS_PACKAGE.md, "Gallery motion".
  const session = new NativeSession(readNativeArtifacts("POCKET_LIQUID_GLASS"), { width: 390, height: 844 });
  const navGlass = (frame: { ops?: Array<Record<string, unknown>> }) =>
    glassSurfaces(frame).filter((surface) => surface.y <= 0.5 && surface.w >= 380);
  const xOf = (frame: Parameters<typeof textOps>[0], label: string) => textOps(frame, label)[0]?.x;
  const titleAlpha = (frame: Parameters<typeof textOps>[0], size: number) =>
    ((Number(textOps(frame, "UIKit Gallery").find((op) => Number(op.size) === size)?.color ?? 0) >>> 24) & 255) / 255;
  try {
    await session.boot();
    session.sendEvent("demo.navigate", { route: "uikit-gallery" });
    let frame = await session.settle(await session.frame());
    assert.equal(navGlass(frame).length, 0, "bar backdrop is clear at the scroll top");
    assert.equal(titleAlpha(frame, 36), 1, "large title is shown at rest");

    // Scroll edge: crossing ~45pt starts a timed collapse that keeps running while input is idle.
    frame = await session.drag({ x: 200, y: 600 }, { x: 200, y: 520 }, 6);
    const early = titleAlpha(frame, 14);
    frame = await session.settle(frame, 30);
    assert.ok(early < 0.6, `inline title starts faded (${early})`);
    assert.equal(titleAlpha(frame, 14), 1, "inline title fades in after the drag ends");
    assert.ok(titleAlpha(frame, 36) < 0.02, "large title fades out");
    assert.equal(navGlass(frame)[0]?.opacity, 1, "bar backdrop is opaque once collapsed");
    frame = await session.settle(await session.drag({ x: 200, y: 400 }, { x: 200, y: 700 }, 6), 60);
    assert.equal(navGlass(frame).length, 0, "bar backdrop clears again at the top");
    assert.equal(titleAlpha(frame, 36), 1, "large title returns");

    // Push: critically damped spring (omega = 22), catalog parallax -30% width.
    const catalogRest = xOf(frame, "BARS & PRESENTATION")!;
    frame = await session.tap("Button", frame);
    const detailXs: number[] = [];
    let catalogMin = catalogRest;
    for (let index = 0; index < 40; index += 1) {
      const detail = xOf(frame, "Configurations");
      const catalog = xOf(frame, "BARS & PRESENTATION");
      if (detail !== undefined) detailXs.push(detail);
      if (catalog !== undefined) catalogMin = Math.min(catalogMin, catalog);
      frame = await session.frame();
    }
    const detailRest = detailXs.at(-1)!;
    assert.ok(detailXs[0]! > detailRest + 200, `detail enters from the trailing edge (${detailXs[0]})`);
    for (let index = 1; index < detailXs.length; index += 1) assert.ok(detailXs[index]! <= detailXs[index - 1]!);
    // At 100 ms (frame 6) the reference spring is 64.5% of the way; allow one frame of layout lag.
    const progressAt100ms = 1 - (detailXs[6]! - detailRest) / 390;
    assert.ok(progressAt100ms > 0.5 && progressAt100ms < 0.8, `spring progress at 100 ms (${progressAt100ms})`);
    assert.ok(Math.abs(catalogRest - catalogMin - 117) < 2, `catalog parallax is -30% width (${catalogMin - catalogRest})`);
    assert.equal(textOps(frame, "BARS & PRESENTATION").length, 0, "covered catalog unmounts after push");

    frame = await session.settle(await session.tap("UIKit Gallery", frame), 45);
    assert.equal(textOps(frame, "Configurations").length, 0);
    assert.ok(Math.abs(xOf(frame, "BARS & PRESENTATION")! - catalogRest) < 0.5, "catalog returns to rest");
  } finally {
    await session.quit();
  }
}, 30_000);

test("UIKit Gallery alert matches the uikit.even.how presentation captures", async () => {
  // Reference: page dimmed with black (not blurred), platter shrinks 1.2 -> 1 on open, dismiss is a pure fade.
  const session = new NativeSession(readNativeArtifacts("POCKET_LIQUID_GLASS"), { width: 390, height: 844 });
  const platter = (frame: { ops?: Array<Record<string, unknown>> }) => glassSurfaces(frame).find((surface) => surface.blur === 16); // the thick modal material
  const dimAlpha = (frame: { ops?: Array<Record<string, unknown>> }) => {
    const dims = (frame.ops ?? []).filter((op) => op.type === "rect" && Number(op.w) >= 389 && Number(op.h) >= 843 && ((Number(op.color) >>> 0) & 0xffffff) === 0);
    return dims.length ? ((Number(dims.at(-1)!.color) >>> 24) & 255) / 255 : 0;
  };
  try {
    await session.boot();
    session.sendEvent("demo.openUrl", { url: "pocket://showcase/uikit-gallery?component=alert" });
    let frame = await session.settle(await session.frame(), 40);
    frame = await session.tap("Two Actions (Side by Side)", frame);
    const widths: number[] = [];
    const opacities: number[] = [];
    const dims: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      const surface = platter(frame);
      if (surface) { widths.push(surface.w); opacities.push(surface.opacity); dims.push(dimAlpha(frame)); }
      frame = await session.frame();
    }
    const rest = widths.at(-1)!;
    assert.ok(widths[0]! > rest * 1.08, `platter opens oversized (${widths[0]} vs ${rest})`);
    for (let index = 1; index < widths.length; index += 1) assert.ok(widths[index]! <= widths[index - 1]! + 0.01, "platter shrinks monotonically");
    assert.ok(opacities[0]! < 0.6 && opacities.at(-1) === 1, `platter fades in (${opacities[0]} -> ${opacities.at(-1)})`);
    assert.ok(Math.abs(dims.at(-1)! - 0.2) < 0.02, `light-mode dim is 20% black (${dims.at(-1)})`);

    frame = await session.tap("Cancel", frame);
    const closing: Array<{ w: number; opacity: number }> = [];
    for (let index = 0; index < 40; index += 1) {
      const surface = platter(frame);
      if (surface) closing.push({ w: surface.w, opacity: surface.opacity });
      frame = await session.frame();
    }
    assert.ok(closing.length > 3, "dismiss animates over several frames");
    for (const sample of closing) assert.ok(Math.abs(sample.w - rest) < 0.5, `dismiss keeps the platter size (${sample.w})`);
    for (let index = 1; index < closing.length; index += 1) assert.ok(closing[index]!.opacity <= closing[index - 1]!.opacity + 1e-6, "dismiss fades monotonically");
    assert.equal(platter(frame), undefined, "platter unmounts after dismiss");
    assert.equal(dimAlpha(frame), 0, "dim clears after dismiss");
  } finally {
    await session.quit();
  }
}, 30_000);
