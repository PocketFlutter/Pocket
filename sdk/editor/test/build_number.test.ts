import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "../../.cache/pocketjs/framework/compiler/pak.ts";
import { startEditor } from "../server.ts";

type BuildMode = "normal" | "fail" | "break-current-pointer" | "blocked";
type RunnerControl = { value: BuildMode; onEntered?: () => void; resume?: Promise<void> };

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fixtureRunner(workspace: string, observedBuilds: number[], mode: RunnerControl) {
  const output = temporaryDirectory("pocket-editor-build-number-output-");
  const appJs = join(output, "app.js");
  const bytecode = join(output, "app.qjbc");
  const metadata = join(output, "app.bytecode.json");
  const pak = join(output, "app.pak");
  writeFileSync(appJs, "globalThis.__build_number_test = true;\n");
  writeFileSync(bytecode, Buffer.from([0x51, 0x4a, 0x42, 0x43, 1, 2, 3]));
  writeFileSync(metadata, JSON.stringify({ entryFormat: "quickjs-bytecode", runtimeAbi: "build-number-fixture-v1", bytecodeBytes: 7 }));
  writeFileSync(pak, pack([{ key: "fixture:text", dtype: 0, data: new Uint8Array([1, 2, 3]) }]));
  return {
    output,
    runner: async ({ config }: { config: { build: number } }) => {
      observedBuilds.push(config.build);
      const currentPointer = join(workspace, "builds/counter-app/current.json");
      if (mode.value === "fail") {
        mode.value = "normal";
        throw new Error("injected build failure");
      }
      if (mode.value === "break-current-pointer") {
        mode.value = "normal";
        rmSync(currentPointer, { force: true });
        mkdirSync(currentPointer);
      }
      if (mode.value === "blocked") {
        mode.value = "normal";
        mode.onEntered?.();
        await mode.resume;
      }
      return {
        appJs,
        bytecode,
        metadata,
        pak,
        runtimeAbi: "build-number-fixture-v1",
        bytecodeMetadata: JSON.parse(readFileSync(metadata, "utf8")),
      };
    },
  };
}

async function request(server: ReturnType<typeof Bun.serve>, path: string, init?: RequestInit): Promise<{ response: Response; value: any }> {
  const headers = new Headers(init?.headers);
  if ((init?.method ?? "GET").toUpperCase() !== "GET") headers.set("x-pocket-editor", "1");
  const host = server.hostname === "0.0.0.0" ? "127.0.0.1" : server.hostname;
  const response = await fetch(`http://${host}:${server.port}${path}`, { ...init, headers });
  const contentType = response.headers.get("content-type") ?? "";
  return { response, value: contentType.includes("application/json") ? await response.json() : await response.arrayBuffer() };
}

async function waitForBuild(server: ReturnType<typeof Bun.serve>, id: string): Promise<any> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const status = await request(server, `/api/projects/${id}/status`);
    if (!status.value.busy) return status.value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Editor build did not finish within five seconds");
}

async function startBuild(server: ReturnType<typeof Bun.serve>, id: string): Promise<any> {
  const started = await request(server, `/api/projects/${id}/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(started.response.status).toBe(202);
  return await waitForBuild(server, id);
}

function writeExternalProject(project: string, build: number): void {
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "app.tsx"), "export default function App() { return null; }\n");
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ protocolVersion: 1, capabilities: { requires: [], optional: [] } }));
  writeFileSync(join(project, "pocket.json"), JSON.stringify({
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: "com.example.counter",
    name: "counter-app",
    title: "Counter App",
    version: "0.1.0",
    build,
    app: { entry: "app.tsx", output: "app", framework: "solid" },
  }, null, 2));
  writeFileSync(join(project, "editor.json"), JSON.stringify({
    id: "counter-app", appId: "com.example.counter", title: "Counter App", version: "0.1.0", build,
    entry: "app.tsx", output: "app", framework: "solid",
  }, null, 2));
}

test("build number commits with the artifact, survives restart, and rolls back failed commits", async () => {
  const workspace = temporaryDirectory("pocket-editor-build-number-workspace-");
  const project = temporaryDirectory("pocket-editor-build-number-project-");
  writeExternalProject(project, 1);
  const observedBuilds: number[] = [];
  const mode: RunnerControl = { value: "normal" };
  const fixture = fixtureRunner(workspace, observedBuilds, mode);
  let server = await startEditor({ port: 0, workspace, projectRoot: project, buildRunner: fixture.runner as any });
  try {
    let enteredBuild!: () => void;
    let resumeBuild!: () => void;
    const runnerEntered = new Promise<void>((resolve) => { enteredBuild = resolve; });
    const buildGate = new Promise<void>((resolve) => { resumeBuild = resolve; });
    mode.value = "blocked";
    mode.onEntered = enteredBuild;
    mode.resume = buildGate;
    const started = await request(server, "/api/projects/counter-app/build", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(started.response.status).toBe(202);
    await runnerEntered;
    const rejectedConfig = await request(server, "/api/projects/counter-app/config", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "While Building" }),
    });
    expect(rejectedConfig.response.status).toBe(409);
    resumeBuild();
    mode.onEntered = undefined;
    mode.resume = undefined;
    let result = await waitForBuild(server, "counter-app");
    expect(result.error).toBeUndefined();
    expect(JSON.parse(readFileSync(join(workspace, "builds/counter-app/1/build.json"), "utf8")).build).toBe(1);
    expect(JSON.parse(readFileSync(join(workspace, "builds/counter-app/1/guest-manifest.json"), "utf8")).build).toBe(1);
    const firstResources = JSON.parse(readFileSync(join(workspace, "builds/counter-app/1/resources.json"), "utf8"));
    expect(firstResources.packages.find((pkg: any) => pkg.id === "com.example.counter").build).toBe(1);

    const saved = await request(server, "/api/projects/counter-app/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "0.2.0", build: 94 }),
    });
    expect(saved.response.status).toBe(200);
    expect(saved.value.build).toBe(1);
    expect(JSON.parse(readFileSync(join(project, "editor.json"), "utf8")).build).toBe(1);

    mode.value = "fail";
    result = await startBuild(server, "counter-app");
    expect(result.error).toContain("injected build failure");
    expect(JSON.parse(readFileSync(join(project, "editor.json"), "utf8")).build).toBe(1);
    expect(JSON.parse(readFileSync(join(workspace, "builds/counter-app/current.json"), "utf8")).revision).toBe(1);

    result = await startBuild(server, "counter-app");
    expect(result.error).toBeUndefined();
    expect(JSON.parse(readFileSync(join(workspace, "builds/counter-app/2/build.json"), "utf8")).build).toBe(2);
    expect(JSON.parse(readFileSync(join(project, "editor.json"), "utf8")).build).toBe(2);

    server.stop(true);
    const savedStatePath = join(workspace, "states/counter-app.json");
    const savedState = JSON.parse(readFileSync(savedStatePath, "utf8"));
    savedState.builtRevision = null;
    delete savedState.artifacts;
    writeFileSync(savedStatePath, JSON.stringify(savedState));
    server = await startEditor({ port: 0, workspace, projectRoot: project, buildRunner: fixture.runner as any });
    result = await startBuild(server, "counter-app");
    expect(result.error).toBeUndefined();
    expect(JSON.parse(readFileSync(join(workspace, "builds/counter-app/2/build.json"), "utf8")).build).toBe(3);
    expect(JSON.parse(readFileSync(join(project, "editor.json"), "utf8")).build).toBe(3);

    const priorPointer = readFileSync(join(workspace, "builds/counter-app/current.json"));
    const priorEditor = readFileSync(join(project, "editor.json"));
    const priorPocket = readFileSync(join(project, "pocket.json"));
    const priorArtifact = readFileSync(join(workspace, "builds/counter-app/2/build.json"));
    mode.value = "break-current-pointer";
    result = await startBuild(server, "counter-app");
    expect(result.error).toContain("EISDIR");
    expect(readFileSync(join(workspace, "builds/counter-app/current.json"))).toEqual(priorPointer);
    expect(readFileSync(join(project, "editor.json"))).toEqual(priorEditor);
    expect(readFileSync(join(project, "pocket.json"))).toEqual(priorPocket);
    expect(readFileSync(join(workspace, "builds/counter-app/2/build.json"))).toEqual(priorArtifact);
    expect(readdirSync(join(workspace, "builds/counter-app")).some((name) => name.includes(".backup-"))).toBe(false);

    result = await startBuild(server, "counter-app");
    expect(result.error).toBeUndefined();
    expect(JSON.parse(readFileSync(join(workspace, "builds/counter-app/2/build.json"), "utf8")).build).toBe(4);
    expect(observedBuilds).toEqual([1, 2, 2, 3, 4, 4]);
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(fixture.output, { recursive: true, force: true });
  }
});

test("new projects start at build 1 and legacy config history advances without artifacts", async () => {
  const workspace = temporaryDirectory("pocket-editor-build-number-create-");
  const legacyWorkspace = temporaryDirectory("pocket-editor-build-number-legacy-workspace-");
  const legacyProject = temporaryDirectory("pocket-editor-build-number-legacy-project-");
  writeExternalProject(legacyProject, 22);
  const observedBuilds: number[] = [];
  const mode: RunnerControl = { value: "normal" };
  const fixture = fixtureRunner(workspace, observedBuilds, mode);
  let server = await startEditor({ port: 0, workspace, buildRunner: fixture.runner as any });
  let legacyServer: ReturnType<typeof Bun.serve> | undefined;
  try {
    const created = await request(server, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "counter-app", name: "Counter App", build: 81 }),
    });
    expect(created.response.status).toBe(201);
    expect(created.value.build).toBe(1);
    const createdStatus = await startBuild(server, "counter-app");
    expect(createdStatus.error).toBeUndefined();
    expect(JSON.parse(readFileSync(join(workspace, "builds/counter-app/1/build.json"), "utf8")).build).toBe(1);

    const legacyFixture = fixtureRunner(legacyWorkspace, observedBuilds, mode);
    legacyServer = await startEditor({ port: 0, workspace: legacyWorkspace, projectRoot: legacyProject, buildRunner: legacyFixture.runner as any });
    const legacyStatus = await startBuild(legacyServer, "counter-app");
    expect(legacyStatus.error).toBeUndefined();
    expect(JSON.parse(readFileSync(join(legacyWorkspace, "builds/counter-app/1/build.json"), "utf8")).build).toBe(23);
    expect(JSON.parse(readFileSync(join(legacyProject, "editor.json"), "utf8")).build).toBe(23);
    rmSync(legacyFixture.output, { recursive: true, force: true });
  } finally {
    server.stop(true);
    legacyServer?.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(legacyWorkspace, { recursive: true, force: true });
    rmSync(legacyProject, { recursive: true, force: true });
    rmSync(fixture.output, { recursive: true, force: true });
  }
});
