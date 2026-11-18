import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildGuest } from "../build_guest.ts";

// Reuse the real input/counter scenario from system_update_fixture.ts without
// its update dependencies, so the same guest runs in both distributions.
const output = process.argv[2];
if (!output) throw new Error("Pass the distribution fixture output directory");
const project = mkdtempSync(join(tmpdir(), "pocket-distribution-fixture-"));
try {
  writeFileSync(join(project, "pocket.json"), JSON.stringify({ app: { entry: "app.tsx" } }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: ["text.layout.native"], optional: ["ui.compositor-surfaces"] } }));
  writeFileSync(join(project, "app.tsx"), `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
const host = createHostBridge();
const [count, setCount] = createSignal(0);
host.onEvent?.(event => {
  if (event.method === "input.pointer" && event.params.phase === "up") {
    setCount(value => value + 1);
  }
});
mount(() => <Screen class="w-full h-full bg-white"><Text class="text-base text-black">Taps:{count()}</Text></Screen>);
`);
  const root = resolve(output);
  mkdirSync(root, { recursive: true });
  await buildGuest({ projectRoot: project, outDir: join(root, "build"), copyAssetsTo: join(root, "assets") });
  console.log(`Distribution fixture: ${root}`);
} finally {
  rmSync(project, { recursive: true, force: true });
}
