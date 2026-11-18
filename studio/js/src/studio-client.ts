// Typed JS client over the frozen studio.* capability contract
// (studio/docs/ARCHITECTURE.md). Orchestration (chunk loops, hashing, stream
// expansion) lives here in JS; the Dart provider only forwards.
import { base64Decode, base64Encode, utf8Decode, utf8Encode } from "./bytes.ts";
import { Sha256 } from "./sha256.ts";

export const CHUNK_BYTES = 128 * 1024;
/**
 * CPU work per guest turn. Every event dispatch runs under a 250 ms interrupt budget (an interrupted turn cannot be
 * caught and silently drops the awaiting promise) and the pure-JS hash/encoder run at about 1 MB/s on the debug native
 * build, so hashing, encoding and decoding walk large buffers in slices and call `yieldTurn` between them.
 */
export const SLICE_BYTES = 16 * 1024;
/** Also yield once this much wall time was spent in the current turn (a loaded debug host runs several times slower). */
export const TURN_SOFT_MS = 40;
export const SMALL_WRITE_BYTES = 192 * 1024;
export const DEFAULT_MAX_READ_BYTES = 4 * 1024 * 1024;
/** `studio.fs.read` returns `too_large` above ~240 KiB; larger files go straight to chunked reads. */
export const SMALL_READ_BYTES = 240 * 1024;
/** ~140s at 60fps for OS folder picker / COS upload routes (`HostBridge` defaults to 180 frames ~3s). */
export const LONG_PICKER_TIMEOUT_FRAMES = 8400;
/** ~65s at 60fps for COS connectivity verification. */
export const COS_CHECK_TIMEOUT_FRAMES = 3900;

export interface StudioHostRequestOptions {
  timeoutFrames?: number;
}
export interface StudioHost {
  request<T = unknown>(capability: string, params?: Record<string, unknown>, options?: StudioHostRequestOptions): Promise<T>;
}
export interface StudioStreamLike {
  onData(listener: (value: any) => void): () => void;
  onError(listener: (error: { code?: string; message?: string }) => void): () => void;
  onEnd(listener: (close: unknown) => void): () => void;
  cancel(reason?: string): void;
}
export interface StudioStreams {
  open(topic: string, params?: Record<string, unknown>): StudioStreamLike;
}

export class StudioError extends Error {
  readonly code: string;
  readonly capability: string;
  constructor(capability: string, code: string, message: string) {
    super(message);
    this.name = "StudioError";
    this.code = code;
    this.capability = capability;
  }
}

export interface ProjectStatus { revision: number; builtRevision: number | null; busy: boolean; error?: string; [key: string]: unknown }
export interface ProjectInfo {
  id: string; appId: string; name: string; title: string; version: string;
  /** Read-only build number (authoritative; incremented automatically by build/publish). */
  readonly build: number;
  tickHz: number; template: "app" | "game";
  directory?: string;
  ecosystemModules?: string[];
  enabledProfiles?: string[];
  status?: ProjectStatus;
  [key: string]: unknown;
}
export type ProjectSummary = ProjectInfo;
export type ProjectOpenLocalResult = { cancelled: true } | { cancelled: false; project: ProjectSummary };

export interface ProjectSettings {
  id?: string;
  name: string;
  title?: string;
  appId: string;
  version: string;
  /** Read-only metadata; never sent to `studio.project.settings.set`. */
  readonly build?: number;
  tickHz: number;
  reusePublishedPackages?: string[];
  ecosystemModules?: string[];
  enabledProfiles?: string[];
  status?: ProjectStatus;
  [key: string]: unknown;
}
export type ProjectSettingsPatch = Omit<Partial<ProjectSettings>, "build" | "id" | "status"> & Record<string, unknown>;

export interface ProjectCreateParams {
  id: string;
  template?: "app" | "game";
  pickParentDirectory?: boolean;
  ecosystemModules?: string[];
  settings?: Omit<Record<string, unknown>, "build">;
}
export type ProjectCreateResult = ProjectSummary | { cancelled: true };

export interface EcosystemModuleInfo {
  id: string;
  label?: string;
  name?: string;
  title?: string;
  description?: string;
  platform?: string;
  ecosystem?: "apple" | "android" | string;
  profile?: string;
  profileIds?: string[];
  surfaces?: string[];
  capabilities?: string[];
  entryFile?: string;
  isSystemExtension?: boolean;
}
export interface EcosystemStatePayload {
  modules: string[];
  enabledProfiles: string[];
  catalog: EcosystemModuleInfo[];
}
export interface EcosystemSetResult {
  config?: Record<string, unknown>;
  modules?: string[];
  enabledProfileIds?: string[];
  enabledProfiles?: string[];
  createdFiles?: string[];
  updatedFiles?: string[];
  removedFiles?: string[];
  entryWired?: boolean;
  status?: ProjectStatus;
  [key: string]: unknown;
}

export interface CosBucketInfo {
  bucket: string;
  region: string;
  endpoint?: string;
  alias?: string;
}
export interface CosLocalInfo {
  available: boolean;
  source: "coscli" | "coscmd" | "env" | "workspace" | "none" | string;
  sourceDetail?: string;
  maskedSecretId?: string;
  hasWorkspaceCredentials?: boolean;
  discoveredBuckets?: CosBucketInfo[];
  defaultBucket?: { bucket: string; region: string };
}
export interface CosConfig {
  enabled: boolean;
  syncOnPublish: boolean;
  bucket: string;
  region: string;
  keyPrefix: string;
  publicBaseUrl: string;
}
export interface CosPublishSummary {
  slot?: "test" | "stable" | string;
  version?: string;
  build?: number;
  uploadedFiles?: number;
  skippedFiles?: number;
  appConfigUrl?: string;
  manifestUrl?: string;
  publishedAt?: string;
}
export interface CosSnapshot {
  local: CosLocalInfo;
  config: CosConfig;
  published?: { test?: CosPublishSummary; stable?: CosPublishSummary };
}
export interface CosSetInput {
  enabled?: boolean;
  syncOnPublish?: boolean;
  bucket?: string;
  region?: string;
  keyPrefix?: string;
  publicBaseUrl?: string;
  credentials?: { secretId: string; secretKey: string; securityToken?: string } | null;
}
export interface CosCheckInput {
  bucket?: string;
  region?: string;
  keyPrefix?: string;
  publicBaseUrl?: string;
}
export interface CosCheckResult {
  ok: boolean;
  bucket?: string;
  region?: string;
  keyPrefix?: string;
  publicBaseUrl?: string;
  source?: string;
  sourceDetail?: string;
  maskedSecretId?: string;
  checkedAt?: string;
}
export interface CosPublishResult {
  ok: boolean;
  cosPublish: CosPublishSummary;
  status?: unknown;
  cos?: CosSnapshot;
}

export interface PublishResult {
  status?: ProjectStatus & { publish?: Record<string, unknown> };
  manifest?: Record<string, unknown>;
  manifestUrl?: string;
  hostConfigUrl?: string;
  appConfigUrl?: string;
  updateUrl?: string;
  archiveUrl?: string;
  packages?: Array<Record<string, unknown>>;
  reusedPackages?: Array<Record<string, unknown>>;
  cosPublish?: CosPublishSummary;
  cosError?: string;
  [key: string]: unknown;
}

export interface SdkUpgradePayload {
  currentVersion?: string;
  latestVersion?: string | null;
  targetVersion?: string | null;
  mode?: "standalone" | "source" | string;
  modeReason?: string;
  platformTuple?: string;
  autoUpgradeSupported?: boolean;
  status?: string;
  upgradeAvailable?: boolean;
  releaseUrl?: string | null;
  downloadedBytes?: number;
  downloadTotalBytes?: number;
  checkedAt?: string | null;
  appliedAt?: string | null;
  deferredReason?: string | null;
  error?: string | null;
  rolledBack?: boolean;
  [key: string]: unknown;
}
export interface FileEntry { path: string; bytes: number }
export interface TreeResult { files: FileEntry[]; revision: number; assets?: string[] }
export interface ChunkResult { path: string; offset: number; length: number; totalBytes: number; sha256: string; mtimeMs: number; data: string }
export type WatchEvent =
  | { type: "ready"; revision: number }
  | { type: "change"; path: string; kind: "file" | "directory"; event: "change" | "rename" }
  | { type: "revision"; revision: number }
  | { type: "status"; status: ProjectStatus }
  | { type: "log"; line: string }
  | { type: "done"; ok: boolean; builtRevision?: number | null; diagnostics?: unknown[] }
  | { type: "gap"; dropped: number };

export interface DiagnosticsExport {
  exportId: string;
  project: string;
  kind?: "log" | "crash";
  format?: string;
  schemaVersion?: number;
  exportedAt?: string;
  totalRecords: number;
  logCount: number;
  crashCount: number;
  context?: Record<string, unknown>;
  keptRecords: number;
  omitted: number;
  truncated: boolean;
  records: Array<Record<string, unknown>>;
  downloadUrl: string;
}

/** A host-decoded thumbnail: a raw IMG entry (8-byte header + straight RGBA in a power-of-two envelope) ready for `uploadImgEntry`. */
export interface ImagePreview {
  width: number; height: number; textureWidth: number; textureHeight: number; sourceWidth: number; sourceHeight: number; img: Uint8Array;
}
export type ResourcePlacement = "pak" | "network";
export interface ResourceEntry { key: string; kind: "pak" | "asset"; bytes: number; placement: ResourcePlacement; locked?: boolean; reason?: string; preview?: boolean }
export interface ResourcePackage { id: string; title: string; manifest: string; resources: ResourceEntry[]; updateUrl?: string; hostConfigUrl?: string }
export interface ResourceInventory { revision: number; builtRevision?: number; packages: ResourcePackage[] }

const MAX_PREVIEW_EDGE = 128;
const isPowerOfTwo = (n: number): boolean => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
/** Validates the provider's IMG entry (the same layout rules as the host's `platform.images.read`). Never trusts a payload it cannot verify. */
export function parseImagePreview(capability: string, value: unknown): ImagePreview {
  const bad = (why: string): StudioError => new StudioError(capability, "invalid_response", `image preview is malformed: ${why}`);
  const r = value as Record<string, unknown> | null;
  if (!r || typeof r !== "object") throw bad("not an object");
  const img = r.img;
  if (!(img instanceof Uint8Array)) throw bad("img is not binary");
  const dims = ["width", "height", "textureWidth", "textureHeight", "sourceWidth", "sourceHeight"].map((k) => r[k]);
  if (!dims.every((n) => typeof n === "number" && Number.isInteger(n) && n > 0)) throw bad("dimensions");
  const [width, height, textureWidth, textureHeight, sourceWidth, sourceHeight] = dims as number[];
  if (!isPowerOfTwo(textureWidth!) || !isPowerOfTwo(textureHeight!) || textureWidth! > MAX_PREVIEW_EDGE || textureHeight! > MAX_PREVIEW_EDGE || width! > textureWidth! || height! > textureHeight!) throw bad("envelope");
  if (img.byteLength !== 8 + textureWidth! * textureHeight! * 4) throw bad("size");
  const header = new DataView(img.buffer, img.byteOffset, img.byteLength);
  if (header.getUint16(0, true) !== textureWidth || header.getUint16(2, true) !== textureHeight || img[4] !== 3 || img[5] !== 2 || header.getUint16(6, true) !== 0) throw bad("header");
  return { width: width!, height: height!, textureWidth: textureWidth!, textureHeight: textureHeight!, sourceWidth: sourceWidth!, sourceHeight: sourceHeight!, img };
}

export interface Subscription { close(): void }

export interface StudioClientOptions {
  /** Resolves in a LATER guest turn (the guest uses a frame timer); the default only defers a microtask (bun tests). */
  yieldTurn?: () => Promise<void>;
}

export function createStudioClient(host: StudioHost, streams?: StudioStreams, options: StudioClientOptions = {}) {
  const yieldTurn = options.yieldTurn ?? (() => Promise.resolve());
  /** Incremental SHA-256: `update` hashes at most SLICE_BYTES (and TURN_SOFT_MS of wall time) per turn. */
  function createHasher() {
    const hasher = new Sha256();
    const step = 4 * 1024;
    let turnStart = Date.now(), inTurn = 0;
    return {
      async update(bytes: Uint8Array): Promise<void> {
        for (let offset = 0; offset < bytes.length; offset += step) {
          const end = Math.min(offset + step, bytes.length);
          hasher.update(bytes.subarray(offset, end));
          inTurn += end - offset;
          if (inTurn >= SLICE_BYTES || Date.now() - turnStart >= TURN_SOFT_MS) { await yieldTurn(); turnStart = Date.now(); inTurn = 0; }
        }
      },
      hex: () => hasher.hex(),
    };
  }
  /** SHA-256 of `bytes`: at most SLICE_BYTES (and TURN_SOFT_MS of wall time) per turn. */
  async function hashBytes(bytes: Uint8Array): Promise<string> {
    const hasher = new Sha256();
    const step = 4 * 1024;
    let turnStart = Date.now(), inTurn = 0;
    for (let offset = 0; offset < bytes.length; offset += step) {
      const end = Math.min(offset + step, bytes.length);
      hasher.update(bytes.subarray(offset, end));
      inTurn += end - offset;
      if (end < bytes.length && (inTurn >= SLICE_BYTES || Date.now() - turnStart >= TURN_SOFT_MS)) { await yieldTurn(); turnStart = Date.now(); inTurn = 0; }
    }
    return hasher.hex();
  }
  /** UTF-8 encodes `text` in windows (never splitting a surrogate pair), one window per turn. */
  async function encodeText(text: string): Promise<Uint8Array> {
    if (text.length <= SLICE_BYTES) return utf8Encode(text);
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + SLICE_BYTES, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end += 1;
      const part = utf8Encode(text.slice(start, end));
      parts.push(part);
      total += part.length;
      start = end;
      if (start < text.length) await yieldTurn();
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  }
  /** UTF-8 decodes `bytes` in slices cut at character boundaries, one slice per turn. */
  async function decodeText(bytes: Uint8Array): Promise<string> {
    if (bytes.length <= SLICE_BYTES) return utf8Decode(bytes);
    const parts: string[] = [];
    for (let start = 0; start < bytes.length;) {
      let end = Math.min(start + SLICE_BYTES, bytes.length);
      while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end -= 1; // do not cut inside a sequence
      if (end === start) end = Math.min(start + SLICE_BYTES, bytes.length);
      parts.push(utf8Decode(bytes.subarray(start, end)));
      start = end;
      if (start < bytes.length) await yieldTurn();
    }
    return parts.join("");
  }
  async function call<T = any>(capability: string, params: Record<string, unknown> = {}, options?: StudioHostRequestOptions): Promise<T> {
    try {
      return options !== undefined ? await host.request<T>(capability, params, options) : await host.request<T>(capability, params);
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown };
      throw new StudioError(capability, typeof e?.code === "string" ? e.code : "host_error", typeof e?.message === "string" ? e.message : String(error));
    }
  }
  const stripBuild = (settings: Record<string, unknown> | undefined): Record<string, unknown> => {
    if (!settings) return {};
    const { build: _build, ...rest } = settings;
    return rest;
  };

  /** Subscribes to a studio stream and expands the provider's `{events:[...]}` batches. */
  function subscribe(topic: string, project: string, onEvent: (event: WatchEvent) => void, onError?: (error: StudioError) => void, onEnd?: () => void): Subscription {
    if (!streams) throw new StudioError(topic, "streams_unavailable", "stream adapter was not provided");
    const stream = streams.open(topic, { project });
    stream.onData((batch) => {
      const events = batch && Array.isArray(batch.events) ? batch.events : [];
      for (const event of events) onEvent(event as WatchEvent);
    });
    stream.onError((e) => onError?.(new StudioError(topic, e.code ?? "stream_error", e.message ?? "stream failed")));
    stream.onEnd(() => onEnd?.());
    return { close: () => stream.cancel("closed by guest") };
  }

  const fs = {
    tree: (project: string, withAssets = false) => call<TreeResult>("studio.fs.tree", { project, ...(withAssets ? { assets: true } : {}) }),
    read: (project: string, path: string) => call<{ path: string; content: string; bytes: number; revision: number }>("studio.fs.read", { project, path }),
    write: (project: string, path: string, content: string) => call<{ path: string; bytes: number; revision: number }>("studio.fs.write", { project, path, content }),
    rename: (project: string, from: string, to: string, overwrite = false) => call<{ from: string; to: string; revision: number }>("studio.fs.rename", { project, from, to, ...(overwrite ? { overwrite } : {}) }),
    delete: (project: string, path: string) => call<{ path: string; revision: number }>("studio.fs.delete", { project, path }),
    stat: (project: string, path: string) => call<{ path: string; kind: "file" | "directory"; bytes: number; mtimeMs: number; editable: boolean }>("studio.fs.stat", { project, path }),
    mkdir: (project: string, path: string) => call<{ path: string; created: boolean; revision: number }>("studio.fs.mkdir", { project, path }),
    rmdir: (project: string, path: string) => call<{ path: string; revision: number }>("studio.fs.rmdir", { project, path }),
    readChunk: (project: string, path: string, offset: number, length = CHUNK_BYTES) => call<ChunkResult>("studio.fs.readChunk", { project, path, offset, length }),
    upload: {
      begin: (project: string, path: string, totalBytes: number, sha256: string) => call<{ uploadId: string; chunkBytes: number }>("studio.fs.upload.begin", { project, path, totalBytes, sha256 }),
      chunk: (project: string, uploadId: string, offset: number, data: string) => call<{ received: number; totalBytes: number }>("studio.fs.upload.chunk", { project, uploadId, offset, data }),
      commit: (project: string, uploadId: string) => call<{ path: string; bytes: number; sha256: string; revision: number }>("studio.fs.upload.commit", { project, uploadId }),
      abort: (project: string, uploadId: string) => call<{ aborted: boolean }>("studio.fs.upload.abort", { project, uploadId }),
    },
    watch: (project: string, onEvent: (event: WatchEvent) => void, onError?: (error: StudioError) => void, onEnd?: () => void) =>
      subscribe("studio.fs.watch", project, onEvent, onError, onEnd),

    /** Reads a whole file as bytes. Splits into <=128 KiB chunks and verifies the service's whole-file sha256. */
    async readBytes(project: string, path: string, maxBytes = DEFAULT_MAX_READ_BYTES): Promise<{ bytes: Uint8Array; sha256: string }> {
      let first = await fs.readChunk(project, path, 0);
      if (first.totalBytes > maxBytes) throw new StudioError("studio.fs.readChunk", "too_large", `file is ${first.totalBytes} bytes (limit ${maxBytes})`);
      const out = new Uint8Array(first.totalBytes);
      let offset = 0;
      for (;;) {
        const part = base64Decode(first.data);
        if (first.sha256 !== undefined && part.length !== first.length) throw new StudioError("studio.fs.readChunk", "invalid_response", "chunk length mismatch");
        out.set(part, offset);
        offset += part.length;
        if (offset >= first.totalBytes || part.length === 0) break;
        const next = await fs.readChunk(project, path, offset);
        if (next.sha256 !== first.sha256 || next.totalBytes !== first.totalBytes) throw new StudioError("studio.fs.readChunk", "conflict", "file changed while it was being read");
        first = next;
      }
      if (offset !== out.length) throw new StudioError("studio.fs.readChunk", "invalid_response", "short read");
      const digest = await hashBytes(out);
      if (digest !== first.sha256) throw new StudioError("studio.fs.readChunk", "checksum_mismatch", "sha256 does not match the transferred bytes");
      return { bytes: out, sha256: digest };
    },
    /** Reads UTF-8 text: one small call when possible, chunked and verified otherwise. */
    async readText(project: string, path: string, maxBytes = DEFAULT_MAX_READ_BYTES, knownBytes?: number): Promise<{ text: string; bytes: number; revision?: number }> {
      if (knownBytes === undefined || knownBytes <= SMALL_READ_BYTES) {
        try {
          const small = await fs.read(project, path);
          return { text: small.content, bytes: small.bytes, revision: small.revision };
        } catch (error) {
          if (!(error instanceof StudioError) || error.code !== "too_large") throw error;
        }
      }
      const { bytes } = await fs.readBytes(project, path, maxBytes);
      return { text: await decodeText(bytes), bytes: bytes.length };
    },
    /** Writes UTF-8 text: one call when small, otherwise a verified chunked upload that is aborted on failure. */
    async writeText(project: string, path: string, text: string): Promise<{ path: string; bytes: number; revision: number }> {
      const bytes = await encodeText(text);
      if (bytes.length <= SMALL_WRITE_BYTES) return fs.write(project, path, text);
      const digest = await hashBytes(bytes);
      const begin = await fs.upload.begin(project, path, bytes.length, digest);
      try {
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          await fs.upload.chunk(project, begin.uploadId, offset, base64Encode(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length))));
        }
        const done = await fs.upload.commit(project, begin.uploadId);
        return { path: done.path, bytes: done.bytes, revision: done.revision };
      } catch (error) {
        try { await fs.upload.abort(project, begin.uploadId); } catch { /* upload already gone */ }
        throw error;
      }
    },
  };

  return {
    project: {
      async list(): Promise<ProjectInfo[]> { return (await call<{ projects: ProjectInfo[] }>("studio.project.list")).projects; },
      create(
        idOrParams: string | ProjectCreateParams,
        template: "app" | "game" = "app",
        settings: Record<string, unknown> = {},
      ): Promise<ProjectCreateResult> {
        if (typeof idOrParams === "string") {
          return call<ProjectCreateResult>("studio.project.create", { id: idOrParams, template, settings: stripBuild(settings) });
        }
        const payload: Record<string, unknown> = {
          id: idOrParams.id,
          ...(idOrParams.template ? { template: idOrParams.template } : {}),
          ...(idOrParams.pickParentDirectory !== undefined ? { pickParentDirectory: idOrParams.pickParentDirectory } : {}),
          ...(idOrParams.ecosystemModules && idOrParams.ecosystemModules.length > 0 ? { ecosystemModules: idOrParams.ecosystemModules } : {}),
          ...(idOrParams.settings ? { settings: stripBuild(idOrParams.settings) } : {}),
        };
        return call<ProjectCreateResult>(
          "studio.project.create",
          payload,
          idOrParams.pickParentDirectory ? { timeoutFrames: LONG_PICKER_TIMEOUT_FRAMES } : undefined,
        );
      },
      open: (project: string) => call<ProjectInfo>("studio.project.open", { project }),
      openLocal: () => call<ProjectOpenLocalResult>("studio.project.openLocal", {}, { timeoutFrames: LONG_PICKER_TIMEOUT_FRAMES }),
      settings: {
        get: (project: string) => call<ProjectSettings>("studio.project.settings.get", { project }),
        set: (project: string, settings: ProjectSettingsPatch) => call<ProjectSettings>("studio.project.settings.set", { project, settings: stripBuild(settings) }),
      },
    },
    ecosystem: {
      catalog: () => call<{ modules: EcosystemModuleInfo[]; profiles?: unknown[] }>("studio.ecosystem.catalog", {}),
      get: (project: string) => call<EcosystemStatePayload>("studio.ecosystem.get", { project }),
      set: (project: string, body: { modules?: string[]; add?: string[] }) =>
        call<EcosystemSetResult>("studio.ecosystem.set", {
          project,
          ...(body.modules !== undefined ? { modules: body.modules } : {}),
          ...(body.add !== undefined ? { add: body.add } : {}),
        }),
    },
    cos: {
      get: (project: string) => call<CosSnapshot>("studio.cos.get", { project }),
      set: (project: string, patch: CosSetInput) => call<CosSnapshot>("studio.cos.set", { project, ...patch }),
      check: (project: string, draft?: CosCheckInput) =>
        call<CosCheckResult>("studio.cos.check", { project, ...(draft ?? {}) }, { timeoutFrames: COS_CHECK_TIMEOUT_FRAMES }),
      publish: (project: string, channel: "test" | "release" = "test") =>
        call<CosPublishResult>("studio.cos.publish", { project, channel }, { timeoutFrames: LONG_PICKER_TIMEOUT_FRAMES }),
    },
    fs,
    /** Hashing that yields between slices (guest turn budget). */
    hash: { bytes: hashBytes, create: createHasher },
    /** Binary assets below `assets/`: chunked upload (the chunk/commit/abort calls are `fs.upload.*`) and host-side previews. */
    assets: {
      begin: (project: string, name: string, totalBytes: number, sha256: string) => call<{ uploadId: string; chunkBytes: number }>("studio.assets.upload.begin", { project, name, totalBytes, sha256 }),
      commit: (project: string, uploadId: string) => call<{ path: string; bytes: number; sha256: string; revision: number; assets: string[] }>("studio.fs.upload.commit", { project, uploadId }),
      preview: async (project: string, name: string): Promise<ImagePreview> => parseImagePreview("studio.assets.preview", await call("studio.assets.preview", { project, name })),
    },
    resources: {
      get: (project: string) => call<ResourceInventory>("studio.project.resources.get", { project }),
      set: (project: string, revision: number, packageId: string, placements: { key: string; placement: ResourcePlacement }[]) =>
        call<ResourceInventory>("studio.project.resources.set", { project, revision, packageId, placements }),
      preview: async (project: string, revision: number, pkg: string, key: string): Promise<ImagePreview> =>
        parseImagePreview("studio.project.resources.preview", await call("studio.project.resources.preview", { project, revision, package: pkg, key })),
    },
    build: {
      start: (project: string) => call<ProjectStatus>("studio.build.start", { project }),
      cancel: (project: string) => call<{ cancelled: boolean; pending?: boolean; status: ProjectStatus }>("studio.build.cancel", { project }),
      status: (project: string) => call<ProjectStatus & { logs: string[] }>("studio.build.status", { project }),
      events: (project: string, onEvent: (event: WatchEvent) => void, onError?: (error: StudioError) => void, onEnd?: () => void) =>
        subscribe("studio.build.events", project, onEvent, onError, onEnd),
    },
    logs: {
      tail: (project: string) => call<{ logs: string[]; error: string | null }>("studio.logs.tail", { project }),
      /** The project's diagnostics bundle (scrubbed, newest records first, bounded by the provider; `downloadUrl` serves the full file). */
      diagnostics: (project: string, kind?: "log" | "crash") => call<DiagnosticsExport>("studio.logs.diagnostics", { project, ...(kind ? { kind } : {}) }),
    },
    preview: {
      publish: (project: string) => call<Record<string, unknown>>("studio.preview.publish", { project }),
      devices: () => call<{ devices: unknown[] }>("studio.preview.devices"),
      deploy: (project: string, deviceId: string) => call<Record<string, unknown>>("studio.preview.deploy", { project, deviceId }),
      deployStatus: (project: string, job: string) => call<Record<string, unknown>>("studio.preview.deployStatus", { project, job }),
      deployCancel: (project: string, job: string) => call<Record<string, unknown>>("studio.preview.deployCancel", { project, job }),
    },
    publish: {
      plan: (project: string, channel: "test" | "release" = "test") => call<Record<string, unknown>>("studio.publish.plan", { project, channel }),
      publish: (project: string, channel: "test" | "release" = "test") => call<PublishResult>("studio.publish.publish", { project, channel }),
      history: (project: string) => call<Record<string, unknown>>("studio.publish.history", { project }),
      offline: (project: string) => call<{ archiveUrl: string; filename: string }>("studio.publish.offline", { project }),
    },
    artifacts: {
      list: (project: string) => call<{ revision: number; builtRevision: number | null; artifacts?: Record<string, unknown> }>("studio.artifacts.list", { project }),
      inspect: (project: string, name: string) => call<{ name: string; bytes: number; encoding: "utf8" | "binary"; data?: string; truncated?: boolean }>("studio.artifacts.inspect", { project, name }),
    },
    service: {
      health: () => call<{ ok: boolean; service: string; version?: string }>("studio.service.health"),
      upgradeStatus: () => call<SdkUpgradePayload>("studio.service.upgrade.status"),
      /** Checks the release feed only (the provider fixes `autoApply: false`). */
      upgradeCheck: () => call<SdkUpgradePayload>("studio.service.upgrade.check"),
      /** Starts the SDK upgrade (standalone install or clean source checkout); busy/dirty checkouts defer or answer `conflict` (HTTP 409). */
      upgradeApply: () => call<SdkUpgradePayload>("studio.service.upgrade.apply"),
    },
  };
}

export type StudioClient = ReturnType<typeof createStudioClient>;
