// Host-decoded image previews. The guest has no PNG/JPEG decoder: the provider decodes on the host into a bounded raw
// IMG entry and the page shows it with the SDK's `PocketStoredImage` (one uploaded texture per mounted node). This module
// only remembers the outcome per key, so the page can say exactly why a preview is missing (SVG, corrupt file, ...).
import { createStore } from "./store.ts";
import { errorText } from "./workspace.ts";
import type { ImagePreview } from "../studio-client.ts";

export type PreviewState =
  | { status: "loading" }
  | { status: "ready"; image: ImagePreview }
  | { status: "unavailable"; reason: string };

const MAX_ENTRIES = 24;

/** Provider codes that mean "this file has no preview" (not a failure of the Studio). */
const NO_PREVIEW_CODES = new Set(["unsupported_format", "not_an_image", "decode_failed", "too_large"]);

export function createImagePreviews() {
  const store = createStore<{ items: Record<string, PreviewState> }>({ items: {} });
  const order: string[] = [];
  const state = () => store.get().items;
  let epoch = 0;

  function put(key: string, value: PreviewState): void {
    const at = order.indexOf(key);
    if (at >= 0) order.splice(at, 1);
    order.push(key);
    const items = { ...state(), [key]: value };
    while (order.length > MAX_ENTRIES) delete items[order.shift()!];
    store.set({ items });
  }

  /** Loads `key` once; a settled key is served from memory. */
  async function request(key: string, load: () => Promise<ImagePreview>): Promise<void> {
    if (state()[key]) return;
    const mine = epoch;
    put(key, { status: "loading" });
    try {
      const image = await load();
      if (mine === epoch) put(key, { status: "ready", image });
    } catch (error) {
      if (mine !== epoch) return;
      const code = (error as { code?: string })?.code;
      const message = (error as { message?: string })?.message ?? errorText(error);
      put(key, { status: "unavailable", reason: code && NO_PREVIEW_CODES.has(code) ? `没有预览：${message}` : `预览失败：${errorText(error)}` });
    }
  }

  /** Forgets one key (the asset was replaced) or everything (project switch). */
  function forget(key?: string): void {
    if (key === undefined) { epoch += 1; order.length = 0; store.set({ items: {} }); return; }
    const items = { ...state() };
    delete items[key];
    const at = order.indexOf(key);
    if (at >= 0) order.splice(at, 1);
    store.set({ items });
  }

  /** The `PocketStoredImage` client: serves the decoded entries this module already holds. */
  const client = {
    async read(id: string) {
      const entry = state()[id];
      if (!entry || entry.status !== "ready") throw new Error("image preview is not ready");
      return { id, ...entry.image };
    },
  };

  return { store, state, request, forget, client };
}
export type ImagePreviews = ReturnType<typeof createImagePreviews>;

/** `version` is anything that changes when the file does (its size and mtime). */
export const assetPreviewKey = (project: string, name: string, version: string): string => `asset:${project}:${name}@${version}`;
export const resourcePreviewKey = (project: string, pkg: string, key: string, built: number): string => `resource:${project}:${pkg}:${key}@${built}`;
