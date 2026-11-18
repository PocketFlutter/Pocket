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

    frame = await session.settle(await session.tap("UIKit Gallery", frame));
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

type GlassSample = { x: number; y: number; w: number; h: number; material?: string; opacity: number; magnification: number };

function glassSurfaces(frame: { ops?: Array<Record<string, unknown>> }): GlassSample[] {
  return (frame.ops ?? []).filter((op) => op.type === "hostSurface" && typeof op.asset === "string").map((op) => {
    const parameters = (JSON.parse(op.asset as string) as { parameters?: Record<string, unknown> }).parameters ?? {};
    return {
      x: Number(op.x), y: Number(op.y), w: Number(op.w), h: Number(op.h),
      material: parameters.material as string | undefined,
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
