import { PocketWebRuntime } from "./pocket-web.js";

const canvas = document.querySelector("#pocket-preview-surface");
const status = document.querySelector("[role=status]");
const parent = window.parent;
const origin = window.location.origin;
const lifetime = new AbortController();
let runtime;
let ready = false;

function announce(type, payload = {}) {
  if (parent !== window) {
    parent.postMessage({ source: "pocket-editor-preview", version: 1, renderer: "gpu", type, ...payload }, origin);
  }
}

function reportError(error) {
  if (lifetime.signal.aborted) return;
  ready = false;
  const detail = String(error?.message ?? error);
  status.textContent = detail;
  status.hidden = false;
  announce("preview.status", { status: { state: "error", error: detail } });
  announce("preview.error", { error: detail });
}

function resize({ width, height }) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 ||
      width > 32_000 || height > 32_000) return;
  width = Math.round(width);
  height = Math.round(height);
  if (canvas.clientWidth === width && canvas.clientHeight === height) return;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  // Use the Web runtime's ordinary viewport event after applying the CSS size.
  if (ready) window.dispatchEvent(new Event("resize"));
}

async function capture({ requestId = null, scale = 1 }) {
  try {
    if (!ready || !canvas.width || !canvas.height) throw new Error("Preview has no presented frame");
    const { width: logicalWidth, height: logicalHeight } = await runtime.stats();
    if (lifetime.signal.aborted) return;
    const factor = Number.isFinite(scale) ? Math.max(1, Math.min(4, Math.round(scale))) : 1;
    let output = canvas;
    if (factor !== 1) {
      output = document.createElement("canvas");
      output.width = canvas.width * factor;
      output.height = canvas.height * factor;
      const context = output.getContext("2d");
      if (!context) throw new Error("Preview capture canvas is unavailable");
      context.imageSmoothingEnabled = false;
      context.drawImage(canvas, 0, 0, output.width, output.height);
    }
    const dataUrl = output.toDataURL("image/png");
    if (!dataUrl.startsWith("data:image/png;")) throw new Error("Preview canvas could not be encoded");
    announce("preview.capture.result", { requestId, dataUrl, width: output.width, height: output.height,
      logicalWidth, logicalHeight });
  } catch (error) {
    if (!lifetime.signal.aborted) {
      announce("preview.capture.result", { requestId, error: String(error?.message ?? error) });
    }
  }
}

window.addEventListener("message", (event) => {
  if (parent === window || event.source !== parent || event.origin !== origin) return;
  const message = event.data;
  if (!message || typeof message !== "object" || message.source !== "pocket-editor") return;
  if (message.type === "preview.resize") resize(message);
  else if (message.type === "preview.capture") void capture(message);
}, { signal: lifetime.signal });

window.addEventListener("pagehide", (event) => {
  if (event.persisted) {
    runtime?.hide();
  } else {
    lifetime.abort();
    void runtime?.dispose();
  }
}, { signal: lifetime.signal });
window.addEventListener("pageshow", (event) => {
  if (event.persisted) runtime?.show();
}, { signal: lifetime.signal });

async function mount() {
  announce("preview.ready", { width: canvas.clientWidth, height: canvas.clientHeight, transport: "browser-runtime",
    capabilities: { capture: true, regions: false, nativeInspection: false, safeArea: false, surface: false, openUri: false } });
  announce("preview.status", { status: { state: "starting" } });
  try {
    const response = await fetch("./pocket.config.json", { signal: lifetime.signal });
    if (!response.ok) throw new Error(`Preview configuration HTTP ${response.status}`);
    const config = await response.json();
    if (lifetime.signal.aborted) return;
    const { enginePath, qjbcUrl, pakUrl } = config;
    if (![enginePath, qjbcUrl, pakUrl].every((url) => typeof url === "string" && url.length > 0)) {
      throw new Error("Preview configuration is missing runtime artifacts");
    }
    let failed = false;
    runtime = new PocketWebRuntime({
      canvas, engineUrl: enginePath, qjbcUrl, pakUrl,
      config, gameInput: true, onError: (error) => { failed = true; reportError(error); },
    });
    await runtime.mount();
    if (lifetime.signal.aborted || failed) return;
    // The parent may have resized the child while the guest was booting.
    window.dispatchEvent(new Event("resize"));
    const { frameCount, width, height, pixelWidth, pixelHeight } = await runtime.stats();
    if (lifetime.signal.aborted || failed) return;
    if (frameCount < 1) throw new Error("Preview runtime did not present a frame");
    ready = true;
    status.hidden = true;
    // The browser runtime owns the canvas and exposes no native DrawOps frame.
    announce("preview.frame", { frameCount, width, height, pixelWidth, pixelHeight });
    announce("preview.status", { status: { state: "ready" } });
  } catch (error) {
    reportError(error);
  }
}

// Let the parent iframe load handler finish resetting its readiness first.
function afterLoad() { setTimeout(() => { if (!lifetime.signal.aborted) void mount(); }, 0); }
if (document.readyState === "complete") afterLoad();
else window.addEventListener("load", afterLoad, { once: true, signal: lifetime.signal });
