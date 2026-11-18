import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildGuest } from "../build_guest.ts";

test("Looseleaf, ARC, and Liquid Glass buttons change real QJBC frames through pointer input within the native frame-work budget", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "pocket-ui-packages-"));
  const probe = process.env.POCKET_NATIVE_PROBE;
  expect(probe, "Set POCKET_NATIVE_PROBE to the matching real native probe").toBeTruthy();
  try {
    const result = await buildGuest({ projectRoot: resolve(import.meta.dir, "ui_packages_fixture"), outDir });
    const boot = [{ op: "create", width: 360, height: 640 }, { op: "loadBytecode", bytecodePath: result.bytecode, pakPath: result.pak }];
    const frames = () => Array.from({ length: 12 }, () => ({ op: "frame", deltaMs: 16 }));
    function run(commands: object[]): any[] {
      const output = spawnSync(probe!, { input: [...commands, { op: "quit" }].map(value => JSON.stringify(value)).join("\n") + "\n", encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
      expect(output.status, output.stderr).toBe(0);
      const records = output.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      for (const record of records) expect(record.ok, record.error).toBe(true);
      return records.flatMap(record => record.frame ? [record.frame] : []);
    }
    const initial = run([...boot, ...frames()]).at(-1)!;
    const commands: object[] = [...boot, ...frames()];
    for (const [label, expected] of [
      ["Paper increment", "Count 1"],
      ["Arc increment", "Count 11"],
      ["Glass increment", "Count 111"],
    ]) {
      const frame = run(commands).at(-1)!;
      const op = frame.ops.find((value: any) => value.type === "text" && value.text === label);
      expect(op, `Missing actual button ${label}`).toBeTruthy();
      for (const phase of ["down", "up"]) commands.push({ op: "send", message: { type: "event", name: "input.pointer", payload: { phase, id: 0, x: op.x + op.w / 2, y: op.y + op.h / 2 } } }, { op: "frame", deltaMs: 16 });
      commands.push(...frames());
      const changed = run(commands).at(-1)!;
      expect(changed.ops.some((value: any) => value.type === "text" && value.text === expected)).toBe(true);
      expect(changed.ops).not.toEqual(initial.ops);
    }

    // Benchmark 180 consecutive active frames in native QuickJS + Rust probe to measure the 16.67 ms guest-work target (excludes Flutter/GPU rendering)
    const benchFrames = Array.from({ length: 180 }, () => ({ op: "frame", deltaMs: 16 }));
    const t0 = performance.now();
    const benchOut = run([...boot, ...benchFrames]);
    const elapsedMs = performance.now() - t0;
    expect(benchOut.length).toBe(180);
    const avgFrameMs = elapsedMs / 180;
    expect(avgFrameMs).toBeLessThan(16.67);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 120_000);
