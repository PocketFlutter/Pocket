// Asset upload: the user picks image / audio / font files with the host's open dialog (`files.pickOpen`, opaque handles,
// no paths) and the guest uploads them into the project's `assets/` in verified chunks. Every policy lives here in JS:
// name and size refusals, overwrite confirmation, hashing, the chunk loops, progress and cleanup. The host only offers
// the dialog and chunked reads; the service applies its own name, size and path guards again.
import { createStore } from "./store.ts";
import { errorText } from "./workspace.ts";
import type { Toasts } from "./toasts.ts";
import type { Dialogs } from "./dialogs.ts";
import { CHUNK_BYTES, type StudioClient } from "../studio-client.ts";
import { base64Decode } from "../bytes.ts";
import { ASSET_EXTENSIONS, MAX_ASSET_BYTES, validateAssetName } from "../lib/assets.ts";
import { formatBytes } from "../lib/format.ts";

/** The guest's `files.*` client (createPocketFilesClient); absent when the host has no file picker. */
export interface FilesClient {
  pickOpen(options?: { accept?: readonly string[]; multiple?: boolean }): Promise<{ handle: string; name: string; size: number; mime: string }[]>;
  readChunk(handle: string, offset: number, length?: number): Promise<{ length: number; size: number; eof: boolean; data: string }>;
  release(handle: string): Promise<boolean>;
}

export type UploadState = "queued" | "reading" | "uploading" | "done" | "failed" | "refused" | "cancelled";
export interface UploadRow {
  id: number;
  name: string;
  size: number;
  state: UploadState;
  /** Bytes read from the file plus bytes uploaded: progress is `done / (2 * size)`. */
  done: number;
  error?: string;
}
export interface AssetsState {
  rows: UploadRow[];
  picking: boolean;
  busy: boolean;
  /** Set when the host cannot show a file dialog (no plugin or no `files.open` grant). */
  unavailable?: string;
}

const UNAVAILABLE_CODES = new Set(["capability_unavailable", "capability_denied", "plugin_permission_denied", "permission_denied", "capability_not_found"]);

export const uploadProgress = (row: UploadRow): number => (row.state === "done" ? 1 : row.size === 0 ? 0 : Math.min(1, row.done / (2 * row.size)));

export function createAssets(deps: {
  client: StudioClient; files?: FilesClient; toasts: Toasts; dialogs: Dialogs;
  project: () => string | undefined;
  existing: () => string[];
  onUploaded: (name: string) => void;
}) {
  const { client, toasts } = deps;
  const store = createStore<AssetsState>({ rows: [], picking: false, busy: false, ...(deps.files ? {} : { unavailable: "此宿主没有启用文件选择器，无法上传资源。" }) });
  const state = () => store.get();
  let nextId = 1;
  let cancelled = false;
  let epoch = 0;

  const patch = (id: number, change: Partial<UploadRow>): void => {
    store.update({ rows: state().rows.map((r) => (r.id === id ? { ...r, ...change } : r)) });
  };

  async function transfer(project: string, file: { handle: string; name: string; size: number }, rowId: number, mine: number): Promise<void> {
    const files = deps.files!;
    const stop = (): boolean => cancelled || mine !== epoch;
    let uploadId: string | undefined;
    try {
      // Pass 1: read the whole file in chunks, hashing as it goes (the service wants the digest up front).
      const hasher = client.hash.create();
      const parts: { data: string; length: number }[] = [];
      let read = 0;
      patch(rowId, { state: "reading" });
      while (read < file.size) {
        if (stop()) throw new Error("已取消");
        const chunk = await files.readChunk(file.handle, read, Math.min(CHUNK_BYTES, file.size - read));
        const bytes = base64Decode(chunk.data);
        if (bytes.length === 0 || bytes.length !== chunk.length) throw new Error("读取到的数据与文件大小不一致");
        await hasher.update(bytes);
        parts.push({ data: chunk.data, length: bytes.length });
        read += bytes.length;
        patch(rowId, { done: read });
      }
      if (read !== file.size) throw new Error("读取到的数据与文件大小不一致");
      // Pass 2: upload.
      if (stop()) throw new Error("已取消");
      patch(rowId, { state: "uploading" });
      const begin = await client.assets.begin(project, file.name, file.size, hasher.hex());
      uploadId = begin.uploadId;
      let sent = 0;
      for (const part of parts) {
        if (stop()) throw new Error("已取消");
        await client.fs.upload.chunk(project, uploadId, sent, part.data);
        sent += part.length;
        patch(rowId, { done: file.size + sent });
      }
      await client.assets.commit(project, uploadId);
      uploadId = undefined;
      patch(rowId, { state: "done", done: file.size * 2 });
      toasts.success(`已上传 ${file.name}（${formatBytes(file.size)}）`);
      if (mine === epoch) deps.onUploaded(file.name);
    } catch (error) {
      if (uploadId) { try { await client.fs.upload.abort(project, uploadId); } catch { /* the service already dropped it */ } }
      const message = errorText(error);
      patch(rowId, { state: message.includes("已取消") ? "cancelled" : "failed", error: message });
      if (!message.includes("已取消")) toasts.error(`上传 ${file.name} 失败：${message}`);
    } finally {
      try { await files.release(file.handle); } catch { /* handle already gone */ }
    }
  }

  /** Shows the open dialog and uploads what the user picked, one file at a time. */
  async function pick(): Promise<void> {
    const project = deps.project();
    const files = deps.files;
    if (!project) { toasts.warning("请先打开一个项目"); return; }
    if (!files) return;
    if (state().picking || state().busy) return;
    store.update({ picking: true, unavailable: undefined });
    let picked: Awaited<ReturnType<FilesClient["pickOpen"]>>;
    try {
      picked = await files.pickOpen({ accept: ASSET_EXTENSIONS, multiple: true });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      store.update({ picking: false, ...(code && UNAVAILABLE_CODES.has(code) ? { unavailable: "此宿主没有启用文件选择器（files.open），无法上传资源。" } : {}) });
      if (!(code && UNAVAILABLE_CODES.has(code))) toasts.error(`无法打开文件选择器：${errorText(error)}`);
      return;
    }
    store.update({ picking: false });
    if (picked.length === 0) return;
    const mine = epoch;
    cancelled = false;
    store.update({ busy: true });
    const queue: { handle: string; name: string; size: number; rowId: number }[] = [];
    const rows: UploadRow[] = [...state().rows];
    for (const file of picked) {
      const row: UploadRow = { id: nextId++, name: file.name, size: file.size, state: "queued", done: 0 };
      const refusal = validateAssetName(file.name) ?? (file.size > MAX_ASSET_BYTES ? `文件超过 ${formatBytes(MAX_ASSET_BYTES)}（${formatBytes(file.size)}）。` : undefined);
      if (refusal) {
        rows.push({ ...row, state: "refused", error: refusal });
        try { await files.release(file.handle); } catch { /* ignore */ }
        continue;
      }
      rows.push(row);
      queue.push({ ...file, rowId: row.id });
    }
    store.update({ rows });
    try {
      for (const file of queue) {
        if (cancelled || mine !== epoch) { patch(file.rowId, { state: "cancelled", error: "已取消" }); try { await files.release(file.handle); } catch { /* ignore */ } continue; }
        if (deps.existing().includes(file.name)) {
          const replace = await deps.dialogs.confirm({ title: "替换资源？", body: `assets/${file.name} 已存在，上传会替换它。`, confirmLabel: "替换", tone: "danger" });
          if (!replace) { patch(file.rowId, { state: "cancelled", error: "已取消替换" }); try { await files.release(file.handle); } catch { /* ignore */ } continue; }
        }
        await transfer(project, file, file.rowId, mine);
      }
    } finally {
      if (mine === epoch) store.update({ busy: false });
    }
  }

  function cancel(): void { cancelled = true; }
  function clearFinished(): void { store.update({ rows: state().rows.filter((r) => r.state === "queued" || r.state === "reading" || r.state === "uploading") }); }
  /** Project switch: stop and forget everything. */
  function reset(): void {
    cancelled = true;
    epoch += 1;
    store.update({ rows: [], picking: false, busy: false });
  }

  return { store, state, pick, cancel, clearFinished, reset };
}
export type Assets = ReturnType<typeof createAssets>;
