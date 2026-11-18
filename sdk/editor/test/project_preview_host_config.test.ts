import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { startEditor } from "../server.ts";
import { chooseUpdateHost } from "../update_endpoint.ts";

const configuredId = "configured-preview";
const ordinaryId = "ordinary-preview";
const nestedId = "nested-preview";
const marker = "fixture-local-value";
const updatedMarker = "Updated value";
const statusPath = (id: string) => `/api/projects/${id}/preview/status`;
const projectPath = (id: string) => `/api/projects/${id}`;

async function createProject(root: string, id: string, optIn?: unknown): Promise<void> {
  const appId = `test.${id}`;
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "editor.json"), JSON.stringify({
    id, appId, name: id, version: "0.1.0", build: 1, tickHz: 60,
    ...(optIn === undefined ? {} : { previewHostConfig: optIn }),
  }));
  await writeFile(join(root, "pocket.json"), JSON.stringify({
    pocket: 2, id: appId, name: id, version: "0.1.0",
    app: { entry: "app.tsx", framework: "solid" },
  }));
  await writeFile(join(root, "app.tsx"), "export const fixture = true;\n");
}

function profile(projectId: string, projectRoot: string, value = marker) {
  return {
    projectId, projectRoot, hostConfig: { fixtureValue: value },
    http: { allowedOrigins: [], allowedRoutes: [] },
  };
}

async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function jsonAt(origin: string, path: string) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(5_000) });
  expect(response.status).toBe(200);
  return await response.json();
}

test.skipIf(!process.getuid)("workspace preview profiles stay local and reload only the opted-in project", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pocket-project-preview-host-"));
  const workspace = join(temp, "workspace");
  const configured = join(temp, "configured");
  const ordinary = join(temp, "ordinary");
  const nested = join(configured, "nested");
  const profiles = join(workspace, "preview-hosts");
  const profilePath = join(profiles, `${configuredId}.json`);
  await createProject(configured, configuredId, true);
  await createProject(ordinary, ordinaryId);
  await createProject(nested, nestedId);
  await mkdir(profiles, { recursive: true, mode: 0o700 });
  const canonical = await realpath(configured);
  const valid = JSON.stringify(profile(configuredId, canonical));
  await writePrivate(profilePath, valid);
  await writePrivate(join(profiles, `${ordinaryId}.json`), JSON.stringify(profile(ordinaryId, await realpath(ordinary))));
  const server = await startEditor({ host: "0.0.0.0", port: 0, workspace, projectRoot: configured, extraProjectRoots: [ordinary, nested] });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const projects = await jsonAt(origin, "/api/projects");
    expect(projects.map((project: { id: string }) => project.id).sort()).toEqual([configuredId, ordinaryId, nestedId].sort());
    const originalBuilds = await Promise.all([configuredId, ordinaryId].map((id) => jsonAt(origin, projectPath(id) + "/status")));
    const ordinaryPreview = await jsonAt(origin, statusPath(ordinaryId));
    const check = async (expected: "ready" | "invalid") => {
      const configuredPreview = await jsonAt(origin, statusPath(configuredId));
      expect(configuredPreview.hostConfig).toBe(expected);
      expect(JSON.stringify(configuredPreview)).not.toContain(marker);
      expect(JSON.stringify(configuredPreview)).not.toContain(canonical);
      expect(JSON.stringify(configuredPreview)).not.toContain("preview-hosts");
      expect(await jsonAt(origin, statusPath(ordinaryId))).toEqual(ordinaryPreview);
      const currentBuilds = await Promise.all([configuredId, ordinaryId].map((id) => jsonAt(origin, projectPath(id) + "/status")));
      for (const [index, state] of currentBuilds.entries()) {
        expect(state.revision).toBe(originalBuilds[index].revision);
        expect(state.builtRevision).toBe(originalBuilds[index].builtRevision);
      }
    };
    const checkDiagnostics = async () => {
      for (const id of [configuredId, ordinaryId]) {
        const bundle = JSON.stringify(await jsonAt(origin, projectPath(id) + "/diagnostics?download=1"));
        expect(bundle).not.toContain(marker);
        expect(bundle).not.toContain(updatedMarker);
        expect(bundle).not.toContain(profilePath);
      }
    };
    expect(ordinaryPreview.hostConfig).toBe("disabled");
    await check("ready");

    const fileList = await jsonAt(origin, projectPath(configuredId) + "/files");
    expect(fileList.files.some((file: { path: string }) => file.path.includes("preview-hosts"))).toBe(false);
    const escapeProfile = projectPath(configuredId) + "/files/" + encodeURIComponent(relative(configured, profilePath));
    const read = await fetch(origin + escapeProfile);
    expect(read.ok).toBe(false);
    expect(await read.text()).not.toContain(marker);
    const overwrite = await fetch(origin + escapeProfile, {
      method: "PUT", headers: { "content-type": "application/json", "x-pocket-editor": "1" },
      body: JSON.stringify({ content: "{}" }),
    });
    expect(overwrite.ok).toBe(false);
    expect(await readFile(profilePath, "utf8")).toBe(valid);

    await writePrivate(profilePath, JSON.stringify(profile(configuredId, canonical, updatedMarker)));
    await check("ready");
    await rm(profilePath);
    await check("invalid");
    expect((await fetch(origin + projectPath(configuredId) + "/preview")).status).toBe(200);
    await writePrivate(profilePath, valid);
    await check("ready");
    await writePrivate(profilePath, "{ malformed");
    await check("invalid");
    await writePrivate(profilePath, JSON.stringify(profile(ordinaryId, canonical)));
    await check("invalid");
    await writePrivate(profilePath, JSON.stringify(profile(configuredId, await realpath(ordinary))));
    await check("invalid");
    await writePrivate(profilePath, valid);
    await chmod(profilePath, 0o644);
    await check("invalid");
    await rm(profilePath);
    const outsideProfile = join(temp, "outside.json");
    await writePrivate(outsideProfile, valid);
    await symlink(outsideProfile, profilePath);
    await check("invalid");
    await rm(profilePath);
    await link(outsideProfile, profilePath);
    await check("invalid");
    await rm(profilePath);
    await writePrivate(profilePath, valid);
    await check("ready");

    let lan: string | undefined;
    try { lan = chooseUpdateHost(); } catch { /* No LAN interface in this test environment. */ }
    if (lan) {
      const lanOrigin = `http://${lan}:${server.port}`;
      expect((await fetch(lanOrigin + statusPath(configuredId))).status).toBe(403);
      expect((await fetch(lanOrigin + projectPath(configuredId) + "/preview")).status).toBe(403);
      expect((await jsonAt(lanOrigin, statusPath(ordinaryId))).hostConfig).toBe("disabled");
      expect((await fetch(lanOrigin + projectPath(ordinaryId) + "/preview")).status).toBe(200);
      await writePrivate(profilePath, "{ malformed");
      expect((await fetch(lanOrigin + projectPath(configuredId) + "/preview")).status).toBe(403);
      await check("invalid");
      const lanWrite = (id: string, resource: string, method: string, body: string) =>
        fetch(lanOrigin + projectPath(id) + "/" + resource, {
          method, body, headers: { origin: lanOrigin, "x-pocket-editor": "1", "content-type": "application/json" },
          signal: AbortSignal.timeout(5_000),
        });
      const update = JSON.stringify({ name: "LAN control project" });
      expect((await lanWrite(configuredId, "config", "PUT", update)).status).toBe(403);
      expect((await lanWrite(configuredId, "build", "POST", "{}")).status).toBe(403);
      expect((await jsonAt(lanOrigin, statusPath(nestedId))).hostConfig).toBe("disabled");
      expect((await lanWrite(nestedId, "config", "PUT", update)).status).toBe(403);
      expect((await lanWrite(nestedId, "build", "POST", "{}")).status).toBe(403);
      expect((await lanWrite(ordinaryId, "config", "PUT", update)).status).toBe(200);
      expect((await jsonAt(origin, projectPath(ordinaryId) + "/config")).name).toBe("LAN control project");
      expect((await lanWrite(ordinaryId, "build", "POST", "{ malformed")).status).toBe(400);
    }
    await checkDiagnostics();
  } finally {
    await server.stop(true);
    await rm(temp, { recursive: true, force: true });
  }
});

test.skipIf(!process.getuid)("explicit single-project preview adapter takes precedence over the workspace profile", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pocket-explicit-preview-host-"));
  const workspace = join(temp, "workspace");
  const configured = join(temp, "configured");
  const explicitPath = join(temp, "explicit.json");
  await createProject(configured, configuredId, true);
  const { projectRoot: _binding, ...explicit } = profile(configuredId, await realpath(configured));
  await writePrivate(explicitPath, JSON.stringify(explicit));
  const server = await startEditor({ port: 0, workspace, projectRoot: configured, previewHostConfigPath: explicitPath });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    expect((await jsonAt(origin, statusPath(configuredId))).hostConfig).toBe("ready");
  } finally {
    await server.stop(true);
    await rm(temp, { recursive: true, force: true });
  }
});

const sdkRoot = resolve(import.meta.dir, "../..");
const hasNativeProbe = process.env.POCKET_NATIVE_PROBE
  ? existsSync(process.env.POCKET_NATIVE_PROBE)
  : ["aarch64-apple-darwin/release", "release", "debug"]
      .some((directory) => existsSync(join(sdkRoot, "native", "target", directory, "pocket_probe")));

async function createPreviewGuest(root: string, id: string, optIn?: boolean): Promise<void> {
  const appId = `test.${id}`;
  await createProject(root, id, optIn);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: id, private: true, type: "module" }));
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    capabilities: { requires: [], optional: ["funhub.host.config"] },
  }));
  await writeFile(join(root, "pocket.json"), JSON.stringify({
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2, id: appId, name: id, title: id, version: "0.1.0",
    engine: { capabilities: { requires: ["text.glyphs.baked"], enhances: [] } },
    app: {
      entry: "app.tsx", output: "app", framework: "solid",
      viewport: { fixed: { logical: [390, 480], presentation: "native" } },
    },
  }));
  await writeFile(join(root, "pocket.system.json"), JSON.stringify({
    $schema: "https://pocketjs.dev/schema/pocket-system-1.json",
    pocketSystem: 1,
    id: `${appId}.system`,
    name: `${id}-system`,
    title: `${id} system`,
    version: "0.1.0",
    roles: { systemUI: appId },
    applications: {
      installPolicy: { model: "managed", mutable: false },
      backgroundExecution: "suspend",
      catalog: [{ package: appId, manifest: "pocket.json", required: true }],
    },
    installation: { installedPackages: [appId] },
  }));
  await writeFile(join(root, "app.tsx"), `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text } from "@pocketjs/framework/solid/components";
import { ActionButton } from "@pocket/ui";
import { createHostBridge } from "@pocket/ui/host";
const bridge = createHostBridge();
function App() {
  const [value, setValue] = createSignal("Starting");
  const [count, setCount] = createSignal(0);
  void bridge.request("funhub.host.config", {}).then(
    (config) => setValue(config.fixtureValue ?? "Unconfigured"),
    () => setValue("Request failed"),
  );
  return <Screen>
    <Text>{value()}</Text>
    <ActionButton label="Increment" onPress={() => setCount(count() + 1)} />
    <Text>{"Count " + count()}</Text>
  </Screen>;
}
mount(() => <App />);
`);
}

type TextOp = { type: string; text?: string; x: number; y: number; w: number; h: number };
type StreamEvent = { type: string; revision?: number; status?: { state?: string; error?: string }; frame?: { ops: TextOp[] } };

async function during<T>(phase: string, ms: number, work: () => Promise<T>, abort?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${phase} exceeded ${ms}ms`));
          abort?.();
        }, ms);
      }),
    ]);
  } catch (error) {
    throw new Error(`${phase}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

async function openPreview(origin: string, id: string) {
  const request = new AbortController();
  const close = () => request.abort();
  const response = await during(`Open Preview stream for ${id}`, 10_000,
    () => fetch(origin + projectPath(id) + "/preview/stream", { signal: request.signal }), close);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  async function next(): Promise<StreamEvent | null> {
    for (;;) {
      const boundary = buffered.indexOf("\n\n");
      if (boundary >= 0) {
        const packet = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (packet.startsWith("data: ")) return JSON.parse(packet.slice(6));
      } else {
        const chunk = await reader.read();
        if (chunk.done) return null;
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    }
  }
  return {
    async frame(text: string) {
      const phase = `Preview ${id} renders "${text}"`;
      let last: StreamEvent | null = null;
      let lastText: (string | undefined)[] = [];
      try {
        return await during(phase, 10_000, async () => {
          for (;;) {
            const event = await next();
            if (!event) throw new Error(`Preview ended before displaying ${text}`);
            last = event;
            if (event.type === "error" || event.status?.state === "error") throw new Error(JSON.stringify(event));
            if (!event.frame) continue;
            lastText = event.frame.ops.filter((op) => op.type === "text").map((op) => op.text);
            if (lastText.includes(text)) return event;
          }
        }, close);
      } catch (error) {
        const packet = last as StreamEvent | null;
        throw new Error(`${String(error)}. Last packet: ${packet?.type}, state: ${packet?.status?.state}, text: ${JSON.stringify(lastText)}`, { cause: error });
      }
    },
    async expectReload() {
      await during(`Preview ${id} sends reload and closes its old stream`, 10_000, async () => {
        let reload = false;
        for (let event = await next(); event; event = await next()) {
          if (event.type === "project-host-reload") reload = true;
        }
        expect(reload).toBe(true);
      }, close);
    },
    async close() {
      try {
        await during(`Cancel Preview stream reader for ${id}`, 3_000, () => reader.cancel(), close);
      } finally {
        close();
      }
    },
  };
}

test.skipIf(!process.getuid || !hasNativeProbe)("changing a private profile replaces the actual guest Preview without rebuilding or reloading its neighbor", { timeout: 180_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pocket-preview-host-guest-"));
  const workspace = join(temp, "workspace");
  const configured = join(temp, "configured");
  const ordinary = join(temp, "ordinary");
  const profiles = join(workspace, "preview-hosts");
  const profilePath = join(profiles, `${configuredId}.json`);
  await createPreviewGuest(configured, configuredId, true);
  await createPreviewGuest(ordinary, ordinaryId);
  await mkdir(profiles, { recursive: true, mode: 0o700 });
  const canonical = await realpath(configured);
  await writePrivate(profilePath, JSON.stringify(profile(configuredId, canonical)));
  const server = await startEditor({ port: 0, workspace, projectRoot: configured, extraProjectRoots: [ordinary] });
  const streams: Awaited<ReturnType<typeof openPreview>>[] = [];
  const errors: unknown[] = [];
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const start = async (id: string) => {
      const stream = await openPreview(origin, id);
      streams.push(stream);
      return stream;
    };
    const revisions = new Map<string, number>();
    for (const id of [configuredId, ordinaryId]) {
      const path = origin + projectPath(id);
      const build = await fetch(path + "/build", {
        method: "POST", headers: { "x-pocket-editor": "1", "content-type": "application/json" }, body: "{}",
        signal: AbortSignal.timeout(5_000),
      });
      if (!build.ok) throw new Error(`Build request failed for ${id}: ${await build.text()}`);
      expect(build.status).toBe(202);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const state = await jsonAt(origin, projectPath(id) + "/status");
        if (state.error) throw new Error(JSON.stringify(state));
        if (state.builtRevision !== null && state.builtRevision === state.revision && !state.busy) {
          revisions.set(id, state.builtRevision);
          break;
        }
        await Bun.sleep(50);
      }
      if (!revisions.has(id)) throw new Error(`Timed out building ${id}`);
    }
    const savedEditor = JSON.parse(await readFile(join(configured, "editor.json"), "utf8"));
    expect(savedEditor.previewHostConfig).toBe(true);
    const configuredStream = await start(configuredId);
    expect((await configuredStream.frame(marker)).revision).toBe(revisions.get(configuredId)!);
    const ordinaryStream = await start(ordinaryId);
    await ordinaryStream.frame("Unconfigured");

    await writePrivate(profilePath, JSON.stringify(profile(configuredId, canonical, updatedMarker)));
    await configuredStream.expectReload();
    const updatedStream = await start(configuredId);
    expect((await updatedStream.frame(updatedMarker)).revision).toBe(revisions.get(configuredId)!);
    await rm(profilePath);
    await updatedStream.expectReload();
    const noAdapter = await start(configuredId);
    expect((await noAdapter.frame("Unconfigured")).revision).toBe(revisions.get(configuredId)!);

    const snapshot = await jsonAt(origin, projectPath(ordinaryId) + "/preview/snapshot");
    const button = snapshot.frame.ops.find((op: TextOp) => op.type === "text" && op.text === "Increment");
    expect(button).toBeDefined();
    for (const phase of ["down", "up"]) {
      const response = await fetch(origin + projectPath(ordinaryId) + "/preview/input", {
        method: "POST", headers: { "x-pocket-editor": "1", "content-type": "application/json" },
        body: JSON.stringify({ type: "pointer", phase, id: 1, x: button.x + button.w / 2, y: button.y + button.h / 2 }),
        signal: AbortSignal.timeout(5_000),
      });
      expect(response.status).toBe(200);
    }
    expect((await ordinaryStream.frame("Count 1")).revision).toBe(revisions.get(ordinaryId)!);
    for (const [id, revision] of revisions) {
      const diagnostics = JSON.stringify(await jsonAt(origin, projectPath(id) + "/diagnostics?download=1"));
      expect(diagnostics).not.toContain(marker);
      expect(diagnostics).not.toContain(updatedMarker);
      expect(diagnostics).not.toContain(profilePath);
      const state = await jsonAt(origin, projectPath(id) + "/status");
      expect(state.revision).toBe(revision);
      expect(state.builtRevision).toBe(revision);
    }
  } catch (error) {
    errors.push(error);
  } finally {
    for (const result of await Promise.allSettled(streams.map((stream) => stream.close()))) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    try {
      await during("Stop native Preview test server", 10_000, () => server.stop(true));
    } catch (error) {
      errors.push(error);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, errors.map(String).join("\n"));
  }
});
