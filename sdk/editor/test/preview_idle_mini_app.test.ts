import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { createPreviewManager, type PreviewFrame } from "../preview.ts";

const repositoryRoot = resolve(import.meta.dir, "..", "..", "..");
const sdkRoot = join(repositoryRoot, "sdk");
const demoRoot = join(repositoryRoot, "demo/js");
const probe = process.env.POCKET_NATIVE_PROBE
  ? resolve(process.env.POCKET_NATIVE_PROBE)
  : join(sdkRoot, "native/target/debug/pocket_probe");
const projectId = "preview-idle-mini-app";
const prefix = `http://127.0.0.1/api/projects/${projectId}/preview`;

type Snapshot = { status: Record<string, any>; frame: PreviewFrame };

async function readSnapshot(manager: ReturnType<typeof createPreviewManager>): Promise<Snapshot> {
  const response = await manager.handle(new Request(`${prefix}/snapshot`), projectId, "snapshot");
  assert.equal(response.status, 200);
  return await response.json() as Snapshot;
}

async function waitFor(
  manager: ReturnType<typeof createPreviewManager>,
  predicate: (snapshot: Snapshot) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  let value = await readSnapshot(manager);
  while (Date.now() < deadline && !predicate(value)) {
    await Bun.sleep(25);
    value = await readSnapshot(manager);
  }
  assert.ok(predicate(value), `timed out waiting for ${label}: ${JSON.stringify({ status: value.status, frame: value.frame?.frame })}`);
  return value;
}

function visibleTextCenter(frame: PreviewFrame, text: string): { x: number; y: number } {
  const op = frame.ops.find((candidate) => candidate.type === "text" && candidate.text === text);
  assert.ok(op, `visible preview frame must contain the ${JSON.stringify(text)} label`);
  const x = op.x;
  const y = op.y;
  const width = op.w;
  const height = op.h;
  assert.ok(
    typeof x === "number" && Number.isFinite(x) &&
      typeof y === "number" && Number.isFinite(y) &&
      typeof width === "number" && Number.isFinite(width) && width > 0 &&
      typeof height === "number" && Number.isFinite(height) && height > 0,
    `${JSON.stringify(text)} label must expose finite preview bounds`,
  );
  const clip = op.clip && typeof op.clip === "object" && !Array.isArray(op.clip)
    ? op.clip as Record<string, unknown>
    : { x: 0, y: 0, w: frame.width, h: frame.height };
  const clipX = typeof clip.x === "number" ? clip.x : 0;
  const clipY = typeof clip.y === "number" ? clip.y : 0;
  const clipWidth = typeof clip.w === "number" ? clip.w : frame.width;
  const clipHeight = typeof clip.h === "number" ? clip.h : frame.height;
  const left = Math.max(x, clipX, 0);
  const top = Math.max(y, clipY, 0);
  const right = Math.min(x + width, clipX + clipWidth, frame.width);
  const bottom = Math.min(y + height, clipY + clipHeight, frame.height);
  assert.ok(
    right > left && bottom > top,
    `${JSON.stringify(text)} label is outside the visible frame/clip; scroll it into view before tapping`,
  );
  return {
    x: Math.floor((left + right) / 2),
    y: Math.floor((top + bottom) / 2),
  };
}

async function pointer(
  manager: ReturnType<typeof createPreviewManager>,
  id: number,
  x: number,
  y: number,
): Promise<void> {
  for (const phase of ["down", "up"] as const) {
    const response = await manager.handle(new Request(`${prefix}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "pointer", phase, id, x, y }),
    }), projectId, "input");
    assert.equal(response.status, 200, `${phase} pointer failed: ${await response.text()}`);
  }
}

test("native mini-app launch rebases the clock after an idle preview", { timeout: 60_000 }, async () => {
  assert.ok(existsSync(probe), `pocket_probe is required for idle mini-app acceptance: ${probe}`);
  const manager = createPreviewManager({
    probePath: probe,
    projectDirectory: demoRoot,
    width: 390,
    height: 844,
    idleDisposeMs: 30_000,
    artifacts: {
      bytecodePath: join(repositoryRoot, "demo/assets/app.qjbc"),
      pakPath: join(repositoryRoot, "demo/assets/app.pak"),
      revision: 1,
      tickHz: 60,
      applications: {
        "pocket.demo.profile": {
          bytecodePath: join(repositoryRoot, "demo/assets/apps/profile/app.qjbc"),
          pakPath: join(repositoryRoot, "demo/assets/apps/profile/app.pak"),
          appId: "pocket.demo.profile",
        },
        "pocket.demo.lobby": {
          bytecodePath: join(repositoryRoot, "demo/assets/apps/lobby/app.qjbc"),
          pakPath: join(repositoryRoot, "demo/assets/apps/lobby/app.pak"),
          appId: "pocket.demo.lobby",
        },
      },
    },
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stopReader = false;
  let consumeError: unknown;
  const decoder = new TextDecoder();
  const acknowledged = new Set<string>();
  let pending = "";
  try {
    const stream = await manager.handle(new Request(`${prefix}/stream?presentation=browser`), projectId, "stream");
    assert.equal(stream.status, 200, stream.status === 200 ? undefined : await stream.text());
    reader = stream.body!.getReader();
    const consume = (async (): Promise<void> => {
      while (!stopReader) {
        const next = await reader!.read();
        if (next.done) return;
        pending += decoder.decode(next.value, { stream: true });
        let boundary = pending.indexOf("\n\n");
        while (boundary >= 0) {
          const block = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const line = block.split(/\r?\n/).find((value) => value.startsWith("data: "));
          if (line) {
            let packet: any;
            try { packet = JSON.parse(line.slice("data: ".length)); } catch { packet = undefined; }
            const tokens = packet?.type === "frame" && Array.isArray(packet.frame?.presentationTokens)
              ? packet.frame.presentationTokens.filter((token: unknown): token is string => typeof token === "string")
              : [];
            const fresh = tokens.filter((token: string) => !acknowledged.has(token));
            for (const token of fresh) acknowledged.add(token);
            if (fresh.length > 0) {
              const response = await manager.handle(new Request(`${prefix}/input`, {
                method: "POST",
                body: JSON.stringify({ type: "presented", tokens: fresh }),
              }), projectId, "input");
              assert.equal(response.status, 200, `presentation ACK failed: ${await response.text()}`);
            }
          }
          boundary = pending.indexOf("\n\n");
        }
      }
    })().catch((error) => { consumeError = error; });

    await waitFor(manager, (value) => value.frame.ops.some((op) => op.type === "text" && op.text === "Open profile app"), "Showcase open action");
    // The root has no active native wake while home is idle. This exceeds the
    // 30-frame guest host-request timeout without making the acceptance slow.
    await Bun.sleep(750);
    const idle = await readSnapshot(manager);
    assert.equal(idle.status.state, "ready");
    assert.equal(idle.status.nextWakeDelayMs, -1);

    // Keep the input attached to the real rendered control. The Showcase added
    // a MiniApp open-mode selector above this button, so a fixed old y=670 tap
    // hits that selector instead of opening the profile.
    const openProfile = visibleTextCenter(idle.frame, "Open profile app");
    await pointer(manager, 0, openProfile.x, openProfile.y);
    const opened = await waitFor(
      manager,
      (value) => value.status.state === "ready" && value.status.error === undefined &&
        value.frame.ops.some((op) => op.type === "text" && op.text === "Pocket Profile") &&
        value.frame.inputBounds !== undefined,
      "Profile after idle launch",
    );
    assert.ok(acknowledged.size > 0, "browser presentation ACK must have been exercised");
    assert.equal(opened.status.error, undefined);
  } finally {
    stopReader = true;
    await reader?.cancel();
    await manager.dispose();
    if (consumeError) throw consumeError;
  }
});
