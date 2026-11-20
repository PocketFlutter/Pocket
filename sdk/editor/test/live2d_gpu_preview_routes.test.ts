import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cubismWebCorePath } from "../live2d.ts";
import { canBuildLive2dGpuPreview, createLive2dGpuPreview } from "../live2d-gpu-preview.ts";
import type { PreviewProject } from "../preview.ts";

const route = "http://127.0.0.1:17500/api/projects/mao/preview/gpu/";
const repositoryRoot = resolve(import.meta.dir, "../../..");
const engineDirectory = process.env.POCKET_TEST_GPU_ENGINE_DIR
  ?? join(repositoryRoot, ".pocket-build/live2d-web-raster-ab/opt-in-engine");
const guestDirectory = process.env.POCKET_TEST_GPU_GUEST_DIR
  ?? join(repositoryRoot, ".pocket-build/live2d-workbench/guest-build");

async function status(response: Response) {
  expect(response.status).toBe(200);
  return await response.json() as { available: boolean; reason?: string };
}

test("GPU preview denies remote and cross-origin access before resolving artifacts", async () => {
  const preview = createLive2dGpuPreview(engineDirectory);
  const resolveArtifacts = async (): Promise<PreviewProject | undefined> => {
    throw new Error("unauthorized requests must not resolve project artifacts");
  };
  for (const suffix of ["status", "", "1234/app.pak"]) {
    const remote = await preview.handle(new Request(route + suffix), suffix, resolveArtifacts, false, false);
    expect(remote.status).toBe(403);
    for (const headers of [new Headers({ Origin: "https://example.invalid" }), new Headers({ "Sec-Fetch-Site": "cross-site" })]) {
      const crossOrigin = new Request(route + suffix, { headers });
      expect((await preview.handle(crossOrigin, suffix, resolveArtifacts, true, false)).status).toBe(403);
    }
  }
});

test("GPU preview stays unavailable without engine configuration or with a native host", async () => {
  const resolveArtifacts = async (): Promise<PreviewProject | undefined> => {
    throw new Error("disabled previews must not resolve project artifacts");
  };
  for (const [directory, nativeHost] of [[undefined, false], [engineDirectory, true]] as const) {
    const preview = createLive2dGpuPreview(directory);
    const body = await status(await preview.handle(new Request(route + "status"), "status", resolveArtifacts, true, nativeHost));
    expect(body.available).toBe(false);
    expect(body.reason).toBeTruthy();
    const entry = await preview.handle(new Request(route), "", resolveArtifacts, true, nativeHost);
    expect(entry.status).toBe(404);
  }
});

test("GPU preview build admission requires Live2D and only capabilities the Web provider supports", () => {
  const requires = ["media.live2d.model.load", "media.live2d.model.update", "media.live2d.model.release", "text.glyphs.baked"];
  expect(canBuildLive2dGpuPreview({ capabilities: { requires } })).toBe(true);
  expect(canBuildLive2dGpuPreview({ capabilities: { requires: requires.slice(1) } })).toBe(false);
  expect(canBuildLive2dGpuPreview({ capabilities: { requires: [...requires, "native.only"] } })).toBe(false);
  expect(canBuildLive2dGpuPreview({ capabilities: { requires }, worker: {} })).toBe(false);
});

const realArtifacts = [
  join(engineDirectory, "pocketjs.wasm"),
  join(engineDirectory, "pocket-web.js"),
  cubismWebCorePath(),
  ...["app.qjbc", "app.pak", "app.bytecode.json", "guest-manifest.json", "novel.native-assets.json"]
    .map((filename) => join(guestDirectory, filename)),
].every(existsSync);

test.skipIf(!realArtifacts)("GPU preview publishes only the current generation and its admitted assets", async () => {
  const preview = createLive2dGpuPreview(engineDirectory);
  const project: PreviewProject = {
    bytecodePath: join(guestDirectory, "app.qjbc"),
    pakPath: join(guestDirectory, "app.pak"),
    metadataPath: join(guestDirectory, "app.bytecode.json"),
    appId: "pocket.demo.live2d-workbench",
    generation: "first-build",
    tickHz: 60,
  };
  const handle = (suffix: string) =>
    preview.handle(new Request(route + suffix), suffix, async () => project, true, false);
  for (const unsupported of [{ ...project, workerDescriptor: {} }, { ...project, applications: { child: {} } }]) {
    expect((await status(await preview.handle(new Request(route + "status"), "status",
      async () => unsupported, true, false))).available).toBe(false);
  }
  const readiness = await status(await handle("status"));
  expect(readiness).toEqual({ available: true });

  const redirect = await handle("");
  expect(redirect.status).toBe(302);
  const pagePath = new URL(redirect.headers.get("location")!, route).pathname;
  const suffix = pagePath.slice(new URL(route).pathname.length);
  expect(suffix).toMatch(/^[a-f0-9]+\/$/);

  const page = await handle(suffix);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  const configuration = await handle(suffix + "pocket.config.json");
  expect(configuration.status).toBe(200);
  const config = await configuration.json();
  expect(config.live2d.gpuMesh).toBe(true);

  const guest = await handle(suffix + "app.qjbc");
  expect(guest.status).toBe(200);
  expect(Buffer.from(await guest.arrayBuffer()).equals(readFileSync(project.bytecodePath!))).toBe(true);
  const models = Object.values(config.live2d.assets) as string[];
  expect(models.length).toBeGreaterThan(0);
  expect((await handle(suffix + models[0]!.replace(/^\.\//, ""))).status).toBe(200);
  for (const unlisted of ["app.bytecode.json", "not-admitted.moc3", "%2e%2e%2fapp.qjbc"]) {
    expect((await handle(suffix + unlisted)).status).not.toBe(200);
  }

  project.generation = "second-build";
  expect((await handle(suffix + "app.qjbc")).status).toBe(409);
});
