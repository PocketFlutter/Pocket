// These suites replace framework modules with process-global `mock.module()`
// doubles (solid-js, the clock, route/ui/motion sources, ...). Bun applies
// such mocks to the whole process and `mock.restore()` does not undo them, so
// they poisoned every later file in a combined `bun test packages/pocket_ui`
// run. Each body (`*.isolated.ts`, deliberately outside bun's test-file glob)
// therefore runs in its own `bun test` process; every assertion still
// executes for real and a failing body fails its wrapper with its output.
import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const bodies = [
  "accessibility",
  "display_late_mount",
  "flutter_widgets",
  "glass_surface",
  "host",
  "media",
  "miniapp_presets_presentation",
  "system_kernel",
  "video",
  "wrap_text_lines",
];

for (const name of bodies) {
  test(`${name} suite passes in an isolated bun process`, async () => {
    const file = join(testDir, `${name}.isolated.ts`);
    const child = Bun.spawn([process.execPath, "test", "--timeout", "60000", file], {
      cwd: testDir,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const output = `${stdout}\n${stderr}`;
    expect(code, output).toBe(0);
    expect(output).not.toMatch(/\n\s*[1-9]\d* (fail|error)s?\b/);
  }, 120_000);
}
