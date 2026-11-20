import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildWeb } from "../../../../sdk/scripts/build_web.ts";
import { resolvePrebuiltTools } from "../../../../sdk/scripts/prebuilt_tools.mjs";
import { prepareWorkbenchGuest } from "./stage.ts";

const sdk = resolve(import.meta.dir, "../../../../sdk");
const packageRoot = join(sdk, "packages/pocket_live2d");
const builds = resolve(sdk, "../.pocket-build");
const hostname = process.env.LIVE2D_PREVIEW_HOST || "127.0.0.1";
const gpuBuild = process.env.LIVE2D_PREVIEW_GPU_DIR;

if (process.env.POCKET_SOURCE_BUILD !== "1" && !process.env.POCKET_TOOLS_PACKAGE) {
  process.env.POCKET_TOOLS_PACKAGE = resolvePrebuiltTools(sdk).root;
}

mkdirSync(builds, { recursive: true });
const cache = mkdtempSync(join(builds, "live2d-phone-preview-"));
const { projectRoot } = prepareWorkbenchGuest(join(cache, "guest"));
const output = join(cache, "web");
await buildWeb({
  projectRoot,
  outDir: output,
  rasterDensity: 2,
  ...(gpuBuild ? {
    enginePath: join(resolve(gpuBuild), "pocketjs.wasm"),
    runtimePath: join(resolve(gpuBuild), "pocket-web.js"),
  } : {}),
  live2dCorePath: process.env.POCKET_CUBISM_WEB_CORE || join(packageRoot, ".cache/cubism-web-core/live2dcubismcore.min.js"),
});

const configPath = join(output, "pocket.config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const { live2d } = config;
if (gpuBuild) {
  live2d.gpuMesh = true;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}
const compressedPak = Bun.gzipSync(readFileSync(join(output, "app.pak")));
const assets = new Set([
  "pocket.config.json", "pocket-web.js", "engine/pocketjs.wasm", "app.qjbc", "app.pak",
  "live2dcubismcore.min.js", ...Object.values<string>(live2d.assets),
]);
const prefix = `/${randomBytes(16).toString("hex")}/`;
const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src 'self' data: blob:",
};
const server = Bun.serve({
  hostname,
  port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith(prefix)) return new Response(null, { status: 404 });
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const key = pathname.slice(prefix.length);
    if (key === "") return new Response(page, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
    if (key === "preview.js") return new Response(bootstrap, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } });
    if (!assets.has(key)) return new Response(null, { status: 404 });
    if (key === "app.pak" && /\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")) {
      return new Response(compressedPak, { headers: { ...headers, "content-type": "application/octet-stream", "content-encoding": "gzip", vary: "accept-encoding" } });
    }
    return new Response(Bun.file(join(output, key)), { headers });
  },
});
console.log(`Pocket Live2D phone preview: http://${hostname}:${server.port}${prefix}`);

const page = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Pocket 看板娘</title>
<style>
html,body{width:100%;height:100%;margin:0;background:#f5f2f0;color:#252129;font:16px system-ui}
canvas{display:block;width:100%;height:100dvh;touch-action:none}
p{position:fixed;inset:0;display:grid;place-content:center;pointer-events:none;padding:1rem}
p[hidden]{display:none}
</style>
<canvas aria-label="Pocket Live2D 看板娘"></canvas>
<p role="status">正在加载 Live2D…</p>
<script type="module" src="./preview.js"></script>
</html>`;

const bootstrap = `import { PocketWebRuntime } from './pocket-web.js';

const status = document.querySelector('[role=status]');
const showError = error => {
  status.textContent = String(error?.message ?? error);
  status.hidden = false;
};

try {
  const response = await fetch('./pocket.config.json');
  if (!response.ok) throw new Error('Preview configuration failed to load: ' + response.status);
  const config = await response.json();
  const runtime = new PocketWebRuntime({
    canvas: document.querySelector('canvas'),
    engineUrl: './engine/pocketjs.wasm',
    qjbcUrl: './app.qjbc',
    pakUrl: './app.pak',
    config,
    gameInput: true,
    onError: showError,
  });
  await runtime.mount();
  status.hidden = true;
} catch (error) {
  showError(error);
}`;
