import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, resolve, sep } from "node:path";
import { verifyWebEngine } from "../scripts/build_web_engine.ts";
import { cubismWebCorePath } from "./live2d.ts";
import type { PreviewProject } from "./preview.ts";

const modelPattern = /^native-models\/([a-f0-9]{64})\.moc3$/;
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const live2dCapabilities = ["media.live2d.model.load", "media.live2d.model.update", "media.live2d.model.release"];
const supportedCapabilities = new Set([
  ...live2dCapabilities, "text.glyphs.baked",
  "platform.storage.get", "platform.storage.set", "platform.storage.remove", "platform.storage.keys",
]);
const clientScript = join(import.meta.dir, "client/live2d-gpu-preview.js");
const coreName = "live2dcubismcore.min.js";

export function live2dGpuEngineDirectory(): string | undefined {
  const configured = process.env.POCKET_EDITOR_GPU_ENGINE_DIR?.trim();
  if (configured) return configured;
  const local = join(import.meta.dir, "../.pocket-build/live2d-gpu-engine");
  return existsSync(join(local, "pocketjs.wasm")) ? local : undefined;
}

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const page = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pocket Live2D GPU 预览</title>
<style>
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#fff}
canvas{display:block;width:100%;height:100%;touch-action:none;outline:none}
[role=status]{position:fixed;inset:0;display:grid;place-content:center;padding:16px;color:#242831;font:15px system-ui;pointer-events:none}
[role=status][hidden]{display:none}
</style>
<canvas id="pocket-preview-surface" aria-label="Pocket Live2D GPU 预览" tabindex="0"></canvas>
<p role="status">正在加载 Live2D GPU 预览…</p>
<script type="module" src="./live2d-gpu-preview.js"></script>
</html>`;

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capabilities(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

export function canBuildLive2dGpuPreview(manifest: Record<string, unknown>): boolean {
  const required = plainObject(manifest.capabilities) ? manifest.capabilities.requires : undefined;
  return capabilities(required) && live2dCapabilities.every(name => required.includes(name)) &&
    required.every(name => supportedCapabilities.has(name)) && !manifest.worker;
}

async function regularFile(path: string, limits = { max: Number.MAX_SAFE_INTEGER }): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.size === 0 || info.size > limits.max) throw new Error("Invalid GPU preview artifact");
  return path;
}

async function artifact(root: string, path: string): Promise<string> {
  const filename = await regularFile(path);
  const canonical = await realpath(filename);
  const subpath = relative(root, canonical);
  if (!subpath || subpath === ".." || subpath.startsWith(".." + sep) || isAbsolute(subpath)) {
    throw new Error("GPU preview artifact escapes its build");
  }
  return canonical;
}

async function jsonFile(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!plainObject(value)) throw new Error("Invalid GPU preview metadata");
  return value;
}

async function projectFiles(project: PreviewProject | undefined) {
  if (!project?.bytecodePath || !project.pakPath || !project.metadataPath || !project.appId ||
      project.generation === undefined || Object.keys(project.applications ?? {}).length ||
      Object.keys(project.compositorSurfaces ?? {}).length || project.workerBytecodePath || project.workerDescriptor) {
    throw new Error("GPU preview requires a completed single-app Live2D build");
  }
  const buildDir = await realpath(dirname(project.bytecodePath));
  const [qjbc, pak, metadata, manifest] = await Promise.all([
    artifact(buildDir, project.bytecodePath),
    artifact(buildDir, project.pakPath),
    artifact(buildDir, project.metadataPath).then(jsonFile),
    artifact(buildDir, join(buildDir, "guest-manifest.json")).then(jsonFile),
  ]);
  if (!canBuildLive2dGpuPreview(manifest) || plainObject(manifest.domains) && manifest.domains.worker !== undefined) {
    throw new Error("GPU preview is unavailable for this guest's capabilities");
  }
  if (metadata.fonts !== "baked" || manifest.fonts !== "baked") {
    throw new Error("Rebuild this project to bake fonts for GPU preview");
  }
  const bindingGeneration = metadata.bindingGeneration;
  if (metadata.entryFormat !== "quickjs-bytecode" || typeof bindingGeneration !== "number" ||
      !Number.isSafeInteger(bindingGeneration) || bindingGeneration < 1) {
    throw new Error("GPU preview requires Pocket QuickJS bytecode");
  }
  const catalog = await artifact(buildDir, join(buildDir, "novel.native-assets.json")).then(jsonFile);
  if (catalog.version !== 1 || !plainObject(catalog.assets) || !Object.keys(catalog.assets).length) {
    throw new Error("GPU preview requires a compiled Live2D model catalog");
  }
  const assets: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(catalog.assets)) {
    if (!key || key.includes("\\") || key.includes("\0") || key.split("/").some(part => !part || part === "." || part === "..") ||
        typeof value !== "string" || !modelPattern.test(value)) throw new Error("Invalid GPU preview model catalog");
    assets[key] = value;
  }
  const declaredCapabilities = manifest.capabilities as { requires: string[]; optional?: string[] };
  const generation = sha256(String(project.generation));
  return {
    qjbc, pak, buildDir, assets, generation,
    config: {
      appId: project.appId, tickHz: project.tickHz ?? 60, bindingGeneration,
      enginePath: "engine/pocketjs.wasm", qjbcUrl: "app.qjbc", pakUrl: "app.pak",
      requires: declaredCapabilities.requires, optional: declaredCapabilities.optional ?? [],
      live2d: { gpuMesh: true, coreUrl: "./" + coreName, assets },
    },
  };
}

async function engineFiles(directory: string) {
  const root = resolve(directory);
  const [wasm, runtime, core] = await Promise.all([
    regularFile(join(root, "pocketjs.wasm")),
    regularFile(join(root, "pocket-web.js")),
    // An explicitly installed official core may be a symlink.
    realpath(cubismWebCorePath()).then(path => regularFile(path, { max: 4 * 1024 * 1024 })),
  ]);
  const verified = await verifyWebEngine(await readFile(wasm));
  if (!verified.exports.includes("web_live2d_mesh_try_present")) {
    throw new Error("GPU preview engine must be built with --live2d-mesh");
  }
  return { wasm, runtime, core };
}

const unavailable = (reason: string, status = 404) => Response.json({ available: false, reason }, { status, headers });

export function createLive2dGpuPreview(engineDirectory?: string) {
  let engine: ReturnType<typeof engineFiles> | undefined;
  return {
    async handle(
      request: Request, suffix: string, resolveArtifacts: () => Promise<PreviewProject | undefined>,
      local: boolean, nativeHostConfigured: boolean,
    ): Promise<Response> {
      if (!local) return unavailable("GPU preview is available only on the Studio computer", 403);
      const origin = request.headers.get("origin");
      if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
        return unavailable("GPU preview requires the Editor origin", 403);
      }
      if (request.method !== "GET") return unavailable("GPU preview expects GET", 405);
      const status = suffix === "status";
      if (!engineDirectory || nativeHostConfigured) return unavailable("GPU preview is unavailable", status ? 200 : 404);
      try {
        const project = await projectFiles(await resolveArtifacts());
        engine ??= engineFiles(engineDirectory).catch(error => { engine = undefined; throw error; });
        const toolchain = await engine;
        if (status) return Response.json({ available: true }, { headers });
        if (!suffix) {
          const pathname = new URL(request.url).pathname.replace(/\/$/, "");
          return new Response(null, { status: 302, headers: { ...headers, location: `${pathname}/${project.generation}/` } });
        }
        const separator = suffix.indexOf("/");
        const generation = separator < 0 ? suffix : suffix.slice(0, separator);
        if (generation !== project.generation) return unavailable("GPU preview build changed; refresh the preview", 409);
        const name = separator < 0 ? "" : suffix.slice(separator + 1);
        if (!name) return new Response(page, { headers: {
          ...headers, "content-type": "text/html;charset=utf-8", "x-frame-options": "SAMEORIGIN",
          "content-security-policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
        } });
        if (name === "pocket.config.json") return Response.json(project.config, { headers });
        const binary = (body: Blob | Uint8Array, contentType = "application/octet-stream") =>
          new Response(body, { headers: { ...headers, "content-type": contentType } });
        const javascript = "text/javascript;charset=utf-8";
        switch (name) {
          case "pocket-web.js": return binary(Bun.file(toolchain.runtime), javascript);
          case "live2d-gpu-preview.js": return binary(Bun.file(clientScript), javascript);
          case "engine/pocketjs.wasm": return binary(Bun.file(toolchain.wasm), "application/wasm");
          case coreName: return binary(Bun.file(toolchain.core), javascript);
          // Capture the bytes before returning so the Editor can confirm the
          // build generation after the read. A lazy path body could open a
          // replacement snapshot after that check.
          case "app.qjbc": return binary(await readFile(project.qjbc));
          case "app.pak": return binary(await readFile(project.pak));
        }
        const model = modelPattern.exec(name);
        if (!model || !Object.values(project.assets).includes(name)) return unavailable("GPU preview asset not found");
        const path = await artifact(project.buildDir, join(project.buildDir, name));
        await regularFile(path, { max: 32 * 1024 * 1024 });
        const data = await readFile(path);
        if (data.byteLength > 32 * 1024 * 1024 || sha256(data) !== model[1]) return unavailable("Invalid GPU preview model asset", 409);
        return binary(data);
      } catch (error) {
        const reason = error instanceof Error && !("code" in error) ? error.message : "GPU preview artifacts or Cubism Web Core are missing";
        return unavailable(reason, status ? 200 : 422);
      }
    },
  };
}
