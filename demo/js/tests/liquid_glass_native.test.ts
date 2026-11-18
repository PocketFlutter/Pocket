import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { NativeSession, readNativeArtifacts, textOf, textOp, textOps } from "./native_session.ts";

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
