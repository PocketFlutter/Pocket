import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { backIconPoint } from "./navigation_geometry.ts";
import {
  NativeSession,
  center,
  readNativeArtifacts,
  textOf,
  textOp,
  textOps,
  type DrawOp,
  type Frame,
} from "./native_session.ts";

const width = 390;
const height = 760;

function findVisibleText(frame: Frame, label: string): DrawOp | undefined {
  return textOps(frame, label).find((op) => {
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
  label: string,
  fromY = 620,
  toY = 300,
): Promise<{ frame: Frame; op: DrawOp }> {
  let latest = frame;
  let visible = findVisibleText(latest, label);
  for (let attempt = 0; !visible && attempt < 6; attempt += 1) {
    latest = await session.settle(
      await session.drag({ x: 195, y: fromY }, { x: 195, y: toY }, 10, 8),
      16,
    );
    visible = findVisibleText(latest, label);
  }
  assert.ok(visible, `expected "${label}" to become visible\n${textOf(latest)}`);
  return { frame: latest, op: visible! };
}

test(
  "native URL + State Router deep-links directly into component states and synthesizes back stacks",
  { timeout: 35_000 },
  async () => {
    const session = new NativeSession(readNativeArtifacts("POCKET_URL_ROUTER"), { width, height });
    try {
      let frame = await session.boot();

      // 1. Navigate to UI -> Open Router Studio via real pointer taps
      frame = await session.settle(
        await session.tap("UI", frame, (op) => (op.y ?? 0) > height - 90),
        16,
      );
      const routerCard = await revealVisibleText(session, frame, "Open Router Studio");
      frame = await session.settle(
        await session.tapPoint(center(routerCard.op, "Open Router Studio")),
        20,
      );
      assert.match(textOf(frame), /URL & State Router/);
      assert.match(textOf(frame), /Live URI Omnibox/);

      // 2. State Deep-Link into Arc · 0% Blue Night Controls (85% quota) via router.open
      session.sendEvent("router.open", {
        url: "pocket://showcase/skins/controls?skin=arc&mode=amber-night&studioAccent=coral&quota=85",
      });
      frame = await session.settle(await session.frame(), 24);
      assert.match(textOf(frame), /Skin Studio/);
      assert.match(textOf(frame), /ARC/);
      assert.match(textOf(frame), /Buttons & Semantic Badges/);

      const stepperLabel = await revealVisibleText(
        session,
        frame,
        "Target frame utilization (%)",
      );
      frame = stepperLabel.frame;
      assert.ok(textOps(frame, "85").length > 0, "quota=85 query state must hydrate SkinStepper");

      // 3. Synthesized parent stack: popping Back from deep-linked `/skins/controls` lands on `/gallery` (`UI Collection`)
      const cleanAppBarFrame: Frame = {
        ...frame,
        ops: (frame.ops ?? []).filter((op) => !(op.type === "text" && op.text === "Back")),
      };
      frame = await session.settle(await session.tapPoint(backIconPoint(cleanAppBarFrame)), 24);
      assert.match(textOf(frame), /UI Collection/);

      // 4. Deep-link directly into Looseleaf Overlays with modal Confirm Dialog already open
      session.sendEvent("demo.openUrl", {
        uri: "pocket://showcase/skins/overlays?skin=looseleaf&dialog=1&note=DeepLink+Verified",
      });
      frame = await session.settle(await session.frame(), 24);
      assert.match(textOf(frame), /Confirm in Looseleaf/);

      // 5. Deep-link into Home with Counter=42 and Draft pre-hydrated
      session.sendEvent("router.open", {
        url: "pocket://showcase/home?count=42&draft=Hello+State+Router&skin=default",
      });
      frame = await session.settle(await session.frame(), 24);
      assert.match(textOf(frame), /42/);
      assert.match(textOf(frame), /Draft: Hello State Router/);
    } finally {
      await session.quit();
    }
  },
);
