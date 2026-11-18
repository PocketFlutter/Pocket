import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager, type PreviewArtifactPaths, type PreviewFrame } from "../preview.ts";
import { renameProjectAppIdentity } from "../project_identity.ts";

const repositoryRoot = resolve(import.meta.dir, "../..", "..");
const sdkRoot = join(repositoryRoot, "sdk");
const oldRootId = "identity.before";
const newRootId = "identity.after";
const oldChildId = `${oldRootId}.child`;
const newChildId = `${newRootId}.child`;
const probeCandidates = process.env.POCKET_NATIVE_PROBE
  ? [resolve(process.env.POCKET_NATIVE_PROBE)]
  : [
      join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
      join(sdkRoot, "native/target/release/pocket_probe"),
      join(sdkRoot, "native/target/debug/pocket_probe"),
    ];
const probe = probeCandidates.find(existsSync);

type Snapshot = { status: Record<string, any>; frame: PreviewFrame };

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function packageManifest(id: string, output: string, root = false): Record<string, unknown> {
  return {
    "$schema": "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id,
    name: id.replaceAll(".", "-"),
    title: id,
    version: "0.1.0",
    engine: {
      capabilities: {
        requires: root ? ["text.glyphs.baked", "platform.apps.open", "ui.compositor-surfaces"] : ["text.glyphs.baked"],
        enhances: [],
      },
    },
    app: {
      entry: "app.tsx",
      output,
      framework: "solid",
      viewport: { fixed: { logical: [390, 480], presentation: "native" } },
    },
  };
}

function createProject(root: string): void {
  writeJson(join(root, "pocket.json"), packageManifest(oldRootId, "identity-root", true));
  writeJson(join(root, "editor.json"), {
    id: "identity-preview",
    appId: oldRootId,
    name: "Identity Preview",
    title: "Identity Preview",
    version: "0.1.0",
    build: 1,
    tickHz: 60,
  });
  writeFileSync(join(root, "app.tsx"), `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { ActionButton } from "@pocket/ui";
import { SystemAppSurfaces } from "@pocket/ui/system-surfaces";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketPlatformClient } from "@pocket/ui/platform";
import { installPocketSystem } from "@pocket/ui/system";
import { onCleanup } from "solid-js";
import systemManifest from "./pocket.system.json";

const bridge = createHostBridge();
const platform = createPocketPlatformClient(undefined, { bridge });
const system = installPocketSystem(systemManifest, {
  bridge,
  policies: {
    "${oldRootId}": { allowedOpenApps: ["${oldChildId}"], messageTargets: [], sharedNamespaces: [] },
    "${oldChildId}": { allowedOpenApps: [], messageTargets: [], sharedNamespaces: [] },
  },
});
function App() {
  const [status, setStatus] = createSignal("Ready");
  onCleanup(() => platform.dispose());
  return <Screen><View class="flex-col gap-4 p-4">
    <Text>Identity root is running</Text>
    <ActionButton label="Open renamed child" onPress={() => { void platform.openApp("${oldChildId}", { source: "identity-preview" }).then(() => setStatus("Child returned")).catch((error) => setStatus("open failed: " + String(error))); }} />
    <Text>{status()}</Text>
  </View></Screen>;
}
mount(() => <><App /><SystemAppSurfaces system={system} systemUIFocused={false} presentation="mini-app" onClose={async (binding) => {
  const frame = system.snapshot().stack.find((entry) => entry.instanceId === binding.instanceId);
  if (frame?.requestId) await bridge.request("platform.apps.cancel", { requestId: frame.requestId });
}} /></>);
`);
  const childRoot = join(root, "apps", "child");
  writeJson(join(childRoot, "pocket.json"), packageManifest(oldChildId, "identity-child"));
  writeJson(join(childRoot, "editor.json"), {
    id: "identity-child-editor",
    appId: oldChildId,
    name: "Identity Child",
    version: "0.1.0",
    build: 1,
  });
  writeFileSync(join(childRoot, "app.tsx"), `
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
function App() { return <Screen><View class="p-4"><Text>Renamed package child is active</Text></View></Screen>; }
mount(() => <App />);
`);
  writeJson(join(root, "pocket.system.json"), {
    "$schema": "https://pocketjs.dev/schema/pocket-system-1.json",
    pocketSystem: 1,
    id: "identity.system",
    name: "identity-preview-system",
    title: "Identity Preview System",
    version: "0.1.0",
    roles: { systemUI: oldRootId },
    applications: {
      installPolicy: { model: "managed", mutable: false },
      backgroundExecution: "suspend",
      catalog: [
        { package: oldRootId, manifest: "pocket.json", required: true },
        { package: oldChildId, manifest: "apps/child/pocket.json", required: true },
      ],
    },
    installation: { installedPackages: [oldRootId, oldChildId] },
  });
  writeJson(join(root, "generated", "compositor-surfaces.json"), {
    schemaVersion: 1,
    surfaces: { [oldChildId]: 2 },
    applications: { [oldChildId]: { title: "Identity Child", assetDirectory: "apps/child/dist" } },
  });
}

async function waitForFrame(read: () => Promise<Snapshot>, text: string): Promise<Snapshot> {
  const deadline = Date.now() + 8_000;
  let last: Snapshot | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (last.frame.ops.some((op) => op.type === "text" && op.text === text)) return last;
    await Bun.sleep(16);
  }
  throw new Error(`timed out waiting for ${text}; status=${JSON.stringify(last?.status)}`);
}

function centerOf(snapshot: Snapshot, text: string): { x: number; y: number } {
  const op = snapshot.frame.ops.find((value) => value.type === "text" && value.text === text);
  assert.ok(op, `frame is missing ${text}`);
  assert.deepEqual([typeof op.x, typeof op.y, typeof op.w, typeof op.h], ["number", "number", "number", "number"]);
  return { x: Number(op.x) + Number(op.w) / 2, y: Number(op.y) + Number(op.h) / 2 };
}

test.skipIf(!probe)("renamed root builds and opens its managed child through real JS input", { timeout: 180_000 }, async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pocket-identity-preview-project-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "pocket-identity-preview-root-"));
  const outputChild = mkdtempSync(join(tmpdir(), "pocket-identity-preview-child-"));
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    createProject(projectRoot);
    await renameProjectAppIdentity(projectRoot, oldRootId, newRootId, async () => {
      const editor = readJson(join(projectRoot, "editor.json"));
      editor.appId = newRootId;
      writeJson(join(projectRoot, "editor.json"), editor);
      const pocket = readJson(join(projectRoot, "pocket.json"));
      pocket.id = newRootId;
      writeJson(join(projectRoot, "pocket.json"), pocket);
    });

    const rootBuild = await buildGuest({ projectRoot, outDir: outputRoot, tickHz: 60 });
    const childBuild = await buildGuest({ projectRoot: join(projectRoot, "apps", "child"), outDir: outputChild, tickHz: 60 });
    const applications: Record<string, PreviewArtifactPaths> = {
      [newChildId]: { bytecodePath: childBuild.bytecode, pakPath: childBuild.pak, appId: newChildId },
    };
    manager = createPreviewManager({
      probePath: probe!,
      projectDirectory: projectRoot,
      width: 390,
      height: 480,
      idleDisposeMs: 1_000,
      artifacts: {
        bytecodePath: rootBuild.bytecode,
        pakPath: rootBuild.pak,
        appId: newRootId,
        revision: 1,
        tickHz: 60,
        applications,
      },
    });

    const projectId = "identity-preview";
    const prefix = `http://127.0.0.1/api/projects/${projectId}/preview`;
    const readSnapshot = async (): Promise<Snapshot> => await (await manager!.handle(
      new Request(`${prefix}/snapshot`), projectId, "snapshot",
    )).json() as Snapshot;
    const stream = await manager.handle(new Request(`${prefix}/stream`), projectId, "stream");
    assert.equal(stream.status, 200, stream.status === 200 ? undefined : await stream.text());
    reader = stream.body!.getReader();
    await reader.read();

    let snapshot = await waitForFrame(readSnapshot, "Open renamed child");
    const point = centerOf(snapshot, "Open renamed child");
    for (const phase of ["down", "up"] as const) {
      const response = await manager.handle(new Request(`${prefix}/input`, {
        method: "POST",
        body: JSON.stringify({ type: "pointer", phase, id: 1, x: point.x, y: point.y }),
      }), projectId, "input");
      assert.equal(response.status, 200, `${phase} input failed`);
    }
    snapshot = await waitForFrame(readSnapshot, "Renamed package child is active");
    assert.equal(snapshot.status.state, "ready");
    assert.equal(snapshot.status.error, undefined);
    assert.equal(readJson(join(projectRoot, "pocket.system.json")).applications.catalog[1].package, newChildId);
    assert.equal(readJson(join(projectRoot, "apps/child/pocket.json")).id, newChildId);
    assert.equal(readJson(join(projectRoot, "generated/compositor-surfaces.json")).surfaces[newChildId], 2);
  } finally {
    await reader?.cancel().catch(() => {});
    await manager?.dispose().catch(() => {});
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(outputChild, { recursive: true, force: true });
  }
});
