import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { resolveNativeProbePath } from "../../scripts/native_probe_path.ts";
import { createPreviewManager, type PreviewHostFontMetrics } from "../preview.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const repositoryRoot = resolve(sdkRoot, "..");
const demoRoot = join(repositoryRoot, "demo/js");
const bytecode = join(repositoryRoot, "demo/assets/app.qjbc");
const pak = join(repositoryRoot, "demo/assets/app.pak");
const probe = process.env.POCKET_NATIVE_PROBE ?? resolveNativeProbePath(sdkRoot);

type TextDrawOp = {
  type: "text";
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  font?: number;
};

function defaultProportionalHostFonts(boldScale = 1.0): PreviewHostFontMetrics {
  const sizes = [
    12, 14, 16, 18, 20, 24, 36, // regular 0..6
    12, 14, 16, 18, 20, 24, 36, // bold 7..13
    54, 54, // 14, 15
    12, 14, 16, // mono 16..18
    10, 10, // 2xs 19, 20
  ];
  const lineHeights: number[] = [];
  const cjkAdvances: number[] = [];
  const asciiAdvances: number[] = [];
  for (let slot = 0; slot < 21; slot += 1) {
    const px = sizes[slot]!;
    const isBold = (slot >= 7 && slot <= 13) || slot === 15 || slot === 20;
    const factor = isBold ? boldScale : 1.0;
    lineHeights.push(Math.round(px * 1.35));
    cjkAdvances.push(Math.round(px * 1.02 * factor));
    for (let code = 32; code <= 126; code += 1) {
      const ch = String.fromCharCode(code);
      const base =
        "MW@#%".includes(ch)
          ? px * 0.84
          : "ABCDGHKNOPQRSTUVXYZmw".includes(ch)
            ? px * 0.68
            : "ijl.,:;!|' ".includes(ch)
              ? px * 0.32
              : px * 0.58;
      asciiAdvances.push(Math.max(1, Math.round(base * factor)));
    }
  }
  return { lineHeights, cjkAdvances, asciiAdvances };
}

function collectTextOps(session: any): TextDrawOp[] {
  const ops = session.rootRuntime?.frame?.ops;
  if (!Array.isArray(ops)) return [];
  return ops.filter(
    (op: any): op is TextDrawOp =>
      Boolean(op && op.type === "text" && typeof op.text === "string"),
  );
}

async function settleShowcase(session: any, mustInclude?: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    while (
      (session.pendingSystemRequests.size > 0 || session.rootRuntime?.pumping > 0) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(10);
    }
    await session.tickNow(16);
    if (!mustInclude || collectTextOps(session).some((op) => op.text.includes(mustInclude))) {
      break;
    }
    await Bun.sleep(10);
  }
  for (let i = 0; i < 6; i += 1) {
    await session.tickNow(16);
  }
}

test(
  "Showcase mobile text wraps cleanly across 375px, 320px, desktop->mobile resize, and async wider hostFonts",
  { timeout: 120_000 },
  async () => {
    assert.ok(existsSync(probe), `pocket_probe is required: ${probe}`);
    assert.ok(existsSync(bytecode), `Showcase bytecode is required: ${bytecode}`);
    assert.ok(existsSync(pak), `Showcase pak is required: ${pak}`);

    const manager = createPreviewManager({
      probePath: probe,
      projectDirectory: demoRoot,
      width: 1023,
      height: 768,
      idleDisposeMs: 30_000,
      artifacts: { bytecodePath: bytecode, pakPath: pak, revision: 1, tickHz: 60 },
    });
    const projectId = `preview-mobile-wrap-${Math.random().toString(36).slice(2, 8)}`;
    const prefix = `http://127.0.0.1/api/projects/${projectId}/preview`;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const sendInput = async (payload: Record<string, unknown>): Promise<void> => {
      const response = await manager.handle(
        new Request(`${prefix}/input`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
        projectId,
        "input",
      );
      assert.equal(response.status, 200, await response.text());
    };

    try {
      const stream = await manager.handle(new Request(`${prefix}/stream`), projectId, "stream");
      assert.equal(stream.status, 200);
      reader = stream.body!.getReader();
      await reader.read();

      const session = (manager as any).sessions.get(projectId) as any;
      await settleShowcase(session, "Mobile UI");

      // 1. Resize from desktop (1023x768) -> mobile iPhone X width (375x3600 so below-the-fold cards render unclipped)
      await sendInput({
        type: "resize",
        width: 375,
        height: 3600,
        safeArea: { top: 44, right: 0, bottom: 34, left: 0 },
      });
      await settleShowcase(session, "Effective · Profile:");

      const assertMobileBounds = (maxRightEdge: number, viewportLabel: string) => {
        const texts = collectTextOps(session);
        const targets = [
          "Effective · Profile:",
          "Pointer/touch fallback is available",
          "PocketJS: Motion Lab",
          "No pointer fallback",
        ];
        for (const snippet of targets) {
          const hit = texts.find((op) => op.text.includes(snippet));
          expect(
            hit,
            `${viewportLabel}: missing text "${snippet}". Visible sample: ${JSON.stringify(
              texts.slice(0, 20).map((t) => t.text),
            )}`,
          ).toBeDefined();
          expect(
            hit!.text.includes("\n"),
            `${viewportLabel}: expected "${snippet}" to wrap with newline, got: ${JSON.stringify(hit)}`,
          ).toBe(true);
          expect(
            hit!.x + hit!.w,
            `${viewportLabel}: "${snippet}" overflowed right bound (${hit!.x + hit!.w} > ${maxRightEdge}): ${JSON.stringify(hit)}`,
          ).toBeLessThanOrEqual(maxRightEdge);
        }
      };

      assertMobileBounds(351, "375px initial fallback metrics");

      // 2. Post asynchronous wider proportional SF Pro Bold hostFonts AFTER mount
      // without resizing the viewport, verifying display.fontMetrics re-wraps in-place.
      const beforeMotion = collectTextOps(session).find((op) =>
        op.text.includes("PocketJS: Motion Lab"),
      )!;
      const widerFonts = defaultProportionalHostFonts(1.32);
      await sendInput({ type: "hostFonts", hostFonts: widerFonts });
      await settleShowcase(session, "PocketJS: Motion Lab");

      assertMobileBounds(351, "375px after async wider hostFonts");
      const afterMotion = collectTextOps(session).find((op) =>
        op.text.includes("PocketJS: Motion Lab"),
      )!;
      expect(
        afterMotion.text.split("\n").length,
        `wider bold hostFonts must re-wrap mounted bold title (${JSON.stringify(beforeMotion.text)} -> ${JSON.stringify(afterMotion.text)})`,
      ).toBeGreaterThanOrEqual(beforeMotion.text.split("\n").length);

      // 3. Resize down to iPhone SE width (320px) and verify zero horizontal overflow
      await sendInput({
        type: "resize",
        width: 320,
        height: 3600,
        safeArea: { top: 20, right: 0, bottom: 0, left: 0 },
      });
      await settleShowcase(session, "Effective · Profile:");
      assertMobileBounds(296, "320px iPhone SE");
    } finally {
      await reader?.cancel();
      await manager.dispose();
    }
  },
);
