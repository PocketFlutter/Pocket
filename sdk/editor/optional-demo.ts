import { createHash, randomUUID } from "node:crypto";
import { cp, link, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cubismWebCorePath } from "./live2d.ts";

const coreUrl = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";
const coreSha256 = "25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f";
const coreMaximumBytes = 4 * 1024 * 1024;
const modelDownloadUrl = "https://www.live2d.com/en/sdk/download/native/";
const licenses = [
  { title: "Cubism 专有软件许可", url: "https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html" },
  { title: "Cubism 开放软件许可", url: "https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html" },
  { title: "Live2D 免费素材许可", url: "https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html" },
  { title: "Cubism 示例数据使用条款", url: "https://www.live2d.com/eula/live2d-sample-model-terms_en.html" },
];

type CoreStatus = "ready" | "missing" | "invalid" | "external-missing";

function exampleError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pathStat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
}

async function isRegularFile(path: string): Promise<boolean> {
  return (await pathStat(path))?.isFile() ?? false;
}

async function findExampleSource(sdkRoot: string): Promise<string | undefined> {
  // The example is data copied on demand. Studio never imports the Demo app.
  for (const path of [join(sdkRoot, "examples/optional/lantern"), join(sdkRoot, "../demo/js/apps/lantern")]) {
    if ((await pathStat(path))?.isDirectory() &&
      (await isRegularFile(join(path, "pocket.json"))) &&
      (await isRegularFile(join(path, "app.tsx"))) &&
      (await isRegularFile(join(path, "scripts/prepare_live2d.ts")))) return path;
  }
}

function configuredCubismSdk(sdkRoot: string): string {
  return resolve(process.env.CUBISM_SDK_ROOT ||
    join(sdkRoot, "packages/pocket_live2d/.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5"));
}

async function hasModelSource(path: string): Promise<boolean> {
  return (await pathStat(path))?.isDirectory() === true &&
    await isRegularFile(join(path, "Samples/Resources/Hiyori/Hiyori.model3.json"));
}

async function coreStatus(path: string): Promise<CoreStatus> {
  const entry = await pathStat(path);
  if (!entry) return process.env.POCKET_CUBISM_WEB_CORE ? "external-missing" : "missing";
  if (!entry.isFile() || entry.size < 1 || entry.size > coreMaximumBytes) return "invalid";
  return sha256(await readFile(path)) === coreSha256 ? "ready" : "invalid";
}

export async function lanternExampleStatus(sdkRoot: string) {
  const [source, core, hasModel] = await Promise.all([
    findExampleSource(sdkRoot),
    coreStatus(cubismWebCorePath()),
    hasModelSource(configuredCubismSdk(sdkRoot)),
  ]);
  const missing: string[] = [];
  if (!source) missing.push("安装包中没有雾港末班信示例源码。");
  if (core === "missing") missing.push("Cubism Web Core 将从 Live2D 官方站点下载。");
  if (core === "invalid") missing.push("现有 Cubism Web Core 校验失败。请检查或修正其配置。");
  if (core === "external-missing") missing.push("POCKET_CUBISM_WEB_CORE 指向的文件不存在。请修正配置。");
  if (!hasModel) missing.push("请选择已解压的官方 Cubism Native SDK 5-r.5 目录。");
  return {
    available: Boolean(source),
    title: "雾港末班信 · Live2D",
    core,
    missing,
    licenses,
    consentRequired: Boolean(source),
    modelSourceRequired: !hasModel,
    modelDownloadUrl,
  };
}

async function downloadCore(signal?: AbortSignal): Promise<Uint8Array> {
  const downloadSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const response = await fetch(coreUrl, { signal: downloadSignal, redirect: "error" });
  if (!response.ok || !response.body) throw exampleError(`下载 Cubism Web Core 失败（HTTP ${response.status}）。`, 502);
  const reader = response.body.getReader();
  const bytes = new Uint8Array(coreMaximumBytes);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bytes.byteLength) throw exampleError("Cubism Web Core 超出大小限制。", 502);
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const result = bytes.subarray(0, length);
  if (sha256(result) !== coreSha256) throw exampleError("下载的 Cubism Web Core 与固定 SHA-256 不匹配。", 502);
  return result;
}

async function ensureCore(sdkRoot: string, path: string, signal?: AbortSignal): Promise<void> {
  const current = await coreStatus(path);
  if (current === "ready") return;
  if (current !== "missing") throw exampleError("请修正现有 Cubism Web Core 配置后重试。", 409);

  // The cache is always owned by this SDK. Never change an external override.
  const packageRoot = await realpath(join(sdkRoot, "packages/pocket_live2d"));
  let directory = packageRoot;
  for (const segment of [".cache", "cubism-web-core"]) {
    directory = join(directory, segment);
    await mkdir(directory, { recursive: true });
    if ((await pathStat(directory))?.isDirectory() !== true || await realpath(directory) !== directory) {
      throw exampleError("Cubism Web Core 缓存目录不可用。", 409);
    }
  }
  const filename = join(directory, "live2dcubismcore.min.js");
  if (filename !== resolve(await realpath(dirname(path)), "live2dcubismcore.min.js")) {
    throw exampleError("Cubism Web Core 路径与 SDK 缓存不一致。", 409);
  }
  const bytes = await downloadCore(signal);
  const temporary = join(directory, `.core-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    // Publish without overwriting a Core installed concurrently by another Studio process.
    try { await link(temporary, filename); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await coreStatus(filename) !== "ready") throw exampleError("现有 Cubism Web Core 校验失败。", 409);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

const exampleFiles = [
  "app.tsx", "pocket.json", "package.json", "manifest.json", "story.json", "story.ts",
  "novel.assets.json", "novel.locales.json", "images.json", "ASSETS.md", "CONTENT.md", "LIVE2D_SAMPLE.md",
  "revision-map.json", "revision-map-v2.json", "revision-map-v3.json", "revision-map-v4.json", "revision-map-v5.json",
  "art", "assets", "models", "scripts/prepare_live2d.ts",
];

function copyExampleEntry(path: string, source: string): Promise<boolean> | boolean {
  const parts = relative(source, path).split(sep);
  const firstTwo = parts.slice(0, 2).join("/");
  if (["art/masters", "art/reference"].includes(firstTwo) ||
    parts.some(part => part.startsWith(".") || part === "node_modules" || part.toLowerCase() === "hiyori")) return false;
  return pathStat(path).then(entry => {
    if (!entry?.isFile() && !entry?.isDirectory()) throw exampleError("示例源码包含不支持的文件类型。", 422);
    return true;
  });
}

export async function stageLanternExample(input: {
  sdkRoot: string;
  destination: string;
  acceptCubismTerms: unknown;
  cubismSdkDirectory: unknown;
  signal?: AbortSignal;
}): Promise<void> {
  if (input.acceptCubismTerms !== true) throw exampleError("请先阅读并同意 Live2D 和示例数据许可。", 400);
  const source = await findExampleSource(input.sdkRoot);
  if (!source) throw exampleError("安装包中没有雾港末班信示例源码。", 404);
  const corePath = cubismWebCorePath();
  const state = await coreStatus(corePath);
  if (state !== "ready" && state !== "missing") throw exampleError("请修正现有 Cubism Web Core 配置后重试。", 409);

  const picked = input.cubismSdkDirectory;
  if (picked !== undefined && (typeof picked !== "string" || !isAbsolute(picked) || picked.includes("\0"))) {
    throw exampleError("请选择已解压的 Cubism Native SDK 目录。", 400);
  }
  const cubismSdk = typeof picked === "string" ? resolve(picked) : configuredCubismSdk(input.sdkRoot);
  if (!(await hasModelSource(cubismSdk))) throw exampleError("目录中没有官方 Cubism Native SDK 5-r.5 的 Hiyori 示例。", 422);

  for (const name of exampleFiles) {
    const entry = join(source, name);
    if (!await pathStat(entry)) continue;
    const target = join(input.destination, name);
    await mkdir(dirname(target), { recursive: true });
    await cp(entry, target, { recursive: true, filter: path => copyExampleEntry(path, source) });
  }

  const manifestPath = join(input.destination, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // buildGuest resolves these trusted SDK source packages using its normal
  // project dependency path; the starter need not install a second toolchain.
  const dependencies = Object.fromEntries(["ui", "vn", "spine", "live2d"].map(slug => [
    `@pocket/${slug}`, `file:${relative(input.destination, join(input.sdkRoot, "packages", `pocket_${slug}`)).split(sep).join("/")}`,
  ]));
  await writeFile(manifestPath, JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    type: "module",
    private: true,
    dependencies,
    overrides: { "@pocket/spine": dependencies["@pocket/spine"], "@pocket/live2d": dependencies["@pocket/live2d"] },
  }, null, 2) + "\n");
  const result = Bun.spawn([process.execPath, "scripts/prepare_live2d.ts"], {
    cwd: input.destination,
    env: { ...process.env, CUBISM_SDK_ROOT: cubismSdk },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    signal: input.signal,
  });
  const stderr = await new Response(result.stderr).text();
  if (await result.exited) {
    throw exampleError(`Hiyori 示例验证失败。\n${stderr.trim().slice(0, 1500)}`, 422);
  }

  await ensureCore(input.sdkRoot, corePath, input.signal);
}
