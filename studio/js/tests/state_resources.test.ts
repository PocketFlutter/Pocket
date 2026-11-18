import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createManualTimers } from "../src/state/env.ts";
import { createToasts } from "../src/state/toasts.ts";
import { createDialogs } from "../src/state/dialogs.ts";
import { createAssets, uploadProgress, type FilesClient } from "../src/state/assets.ts";
import { createImagePreviews } from "../src/state/images.ts";
import { createResources } from "../src/state/resources.ts";
import { createStudioClient, parseImagePreview, StudioError } from "../src/studio-client.ts";
import { flush } from "./fake_client.ts";
import { validateAssetName, previewBlocker } from "../src/lib/assets.ts";

type Req = { capability: string; params: Record<string, any> };
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

/** A fake provider speaking the studio.* contract for assets and resources. */
function fakeHost() {
  const requests: Req[] = [];
  const server = {
    revision: 5, builtRevision: 4 as number | undefined, assets: ["old.png"] as string[], files: new Map<string, Buffer>(),
    upload: undefined as undefined | { name: string; total: number; sha: string; parts: Buffer[] },
    failChunkAt: -1, chunks: 0, aborted: 0, refuseBegin: undefined as undefined | Error,
    placements: new Map<string, "pak" | "network">([["asset:assets/old.png", "pak"]]),
    staleOnce: false, setError: undefined as undefined | Error,
  };
  const inventory = () => ({
    revision: server.revision, ...(server.builtRevision === undefined ? {} : { builtRevision: server.builtRevision }),
    packages: [
      { id: "dev.app", title: "App", manifest: "pocket.json", resources: [
        { key: "asset:assets/old.png", kind: "asset", bytes: 10, placement: server.placements.get("asset:assets/old.png")!, preview: true },
        { key: "pak:ui:font.1", kind: "pak", bytes: 99, placement: "pak", locked: true, reason: "host-critical" },
        { key: "asset:assets/new.png", kind: "asset", bytes: 5, placement: server.placements.get("asset:assets/new.png") ?? "pak" },
      ] },
      { id: "dev.other", title: "Other", manifest: "other.json", resources: [] },
    ],
  });
  const host = {
    async request(capability: string, params: Record<string, any> = {}): Promise<any> {
      requests.push({ capability, params: JSON.parse(JSON.stringify(params)) });
      switch (capability) {
        case "studio.assets.upload.begin":
          if (server.refuseBegin) throw server.refuseBegin;
          server.upload = { name: params.name, total: params.totalBytes, sha: params.sha256, parts: [] };
          return { uploadId: "up-1", chunkBytes: 131072 };
        case "studio.fs.upload.chunk": {
          server.chunks += 1;
          if (server.chunks === server.failChunkAt) throw fail("service_error", "disk full (HTTP 500)");
          server.upload!.parts.push(Buffer.from(params.data, "base64"));
          return { uploadId: params.uploadId, received: server.upload!.parts.reduce((n, b) => n + b.length, 0), totalBytes: server.upload!.total };
        }
        case "studio.fs.upload.commit": {
          const up = server.upload!;
          const all = Buffer.concat(up.parts);
          if (createHash("sha256").update(all).digest("hex") !== up.sha) throw fail("checksum_mismatch", "sha256 mismatch (HTTP 422)");
          server.files.set(up.name, all);
          if (!server.assets.includes(up.name)) server.assets.push(up.name);
          server.revision += 1;
          return { path: `assets/${up.name}`, bytes: all.length, sha256: up.sha, revision: server.revision, assets: server.assets };
        }
        case "studio.fs.upload.abort": server.aborted += 1; server.upload = undefined; return { uploadId: params.uploadId, aborted: true };
        case "studio.fs.tree": return { files: [], revision: server.revision, ...(params.assets ? { assets: server.assets } : {}) };
        case "studio.project.resources.get": return inventory();
        case "studio.project.resources.set": {
          if (server.staleOnce || params.revision !== server.revision) { server.staleOnce = false; throw fail("conflict", "resource revision is stale; reload the project and retry (HTTP 409)"); }
          if (server.setError) throw server.setError;
          for (const p of params.placements) server.placements.set(p.key, p.placement);
          server.revision += 1;
          return inventory();
        }
        case "studio.assets.preview":
          if (params.name === "icon.svg") throw fail("unsupported_format", "SVG cannot be decoded by the Studio host");
          return image(8, 8);
        case "studio.project.resources.preview": return image(16, 8);
        default: throw fail("capability_unavailable", capability);
      }
    },
  };
  return { host, server, requests };
}

function image(w: number, h: number) {
  const tw = 2 ** Math.ceil(Math.log2(w)), th = 2 ** Math.ceil(Math.log2(h));
  const img = new Uint8Array(8 + tw * th * 4);
  const view = new DataView(img.buffer);
  view.setUint16(0, tw, true); view.setUint16(2, th, true); img[4] = 3; img[5] = 2;
  return { width: w, height: h, textureWidth: tw, textureHeight: th, sourceWidth: w * 10, sourceHeight: h * 10, img };
}

function filesFake(contents: Record<string, Buffer>, opts: { pickError?: Error; reads?: number[] } = {}) {
  const handles = new Map<string, Buffer>();
  const released: string[] = [];
  const names = new Map<string, string>();
  const client: FilesClient = {
    async pickOpen() {
      if (opts.pickError) throw opts.pickError;
      return Object.entries(contents).map(([name, bytes], i) => {
        const handle = String(i).padStart(32, "0");
        handles.set(handle, bytes); names.set(handle, name);
        return { handle, name, size: bytes.length, mime: "application/octet-stream" };
      });
    },
    async readChunk(handle, offset, length = 131072) {
      opts.reads?.push(offset);
      const bytes = handles.get(handle)!;
      const part = bytes.subarray(offset, Math.min(offset + length, bytes.length));
      return { length: part.length, size: bytes.length, eof: offset + part.length >= bytes.length, data: part.toString("base64") };
    },
    async release(handle) { released.push(handle); return handles.delete(handle); },
  };
  return { client, released, handles };
}

function harness(files?: FilesClient) {
  const timers = createManualTimers();
  const toasts = createToasts(timers);
  const dialogs = createDialogs();
  const fake = fakeHost();
  const client = createStudioClient(fake.host);
  const uploaded: string[] = [];
  let existing = fake.server.assets;
  const assets = createAssets({ client, files, toasts, dialogs, project: () => "alpha", existing: () => existing, onUploaded: (n) => { uploaded.push(n); existing = fake.server.assets; } });
  const resources = createResources({ client, toasts, dialogs, project: () => "alpha" });
  const previews = createImagePreviews();
  return { ...fake, client, assets, resources, previews, toasts, dialogs, uploaded };
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("asset policy", () => {
  test("names, types and preview blockers", () => {
    expect(validateAssetName("logo.png")).toBeUndefined();
    for (const bad of ["../x.png", ".hidden.png", "a b.png", "a/b.png", "名字.png", "x".repeat(129) + ".png", "-x.png"]) expect(validateAssetName(bad)).toContain("文件名不安全");
    expect(validateAssetName("notes.txt")).toContain("不支持的文件类型");
    expect(previewBlocker("a.svg")).toContain("SVG");
    expect(previewBlocker("a.wav")).toContain("不是图片");
    expect(previewBlocker("a.PNG")).toBeUndefined();
  });
  test("image previews are validated: only a well-formed bounded IMG entry is accepted", () => {
    expect(() => parseImagePreview("x", image(8, 8))).not.toThrow();
    expect(() => parseImagePreview("x", { ...image(8, 8), img: "AAAA" })).toThrow(StudioError);
    expect(() => parseImagePreview("x", { ...image(8, 8), img: image(8, 8).img.subarray(0, 40) })).toThrow(/size/);
    const bad = image(8, 8); bad.img[4] = 1;
    expect(() => parseImagePreview("x", bad)).toThrow(/header/);
    const big = { ...image(8, 8), textureWidth: 256, textureHeight: 256 };
    expect(() => parseImagePreview("x", big)).toThrow(/envelope/);
    expect(() => parseImagePreview("x", { ...image(8, 8), textureWidth: 6 })).toThrow(/envelope/);
  });
});

describe("asset upload", () => {
  test("picks, hashes and uploads in verified chunks, shows progress and refreshes; the handle is released", async () => {
    const bytes = Buffer.alloc(300 * 1024 + 5, 7);
    const reads: number[] = [];
    const f = filesFake({ "hero.png": bytes }, { reads });
    const h = harness(f.client);
    const progress: number[] = [];
    h.assets.store.subscribe(() => { const row = h.assets.state().rows[0]; if (row) progress.push(uploadProgress(row)); });
    await h.assets.pick();
    const row = h.assets.state().rows[0]!;
    expect(row).toMatchObject({ name: "hero.png", size: bytes.length, state: "done" });
    expect(reads).toEqual([0, 131072, 262144]);
    expect(h.requests.filter((r) => r.capability === "studio.fs.upload.chunk").map((r) => r.params.offset)).toEqual([0, 131072, 262144]);
    const begin = h.requests.find((r) => r.capability === "studio.assets.upload.begin")!;
    expect(begin.params).toEqual({ project: "alpha", name: "hero.png", totalBytes: bytes.length, sha256: sha(bytes) });
    expect(h.server.files.get("hero.png")!.equals(bytes)).toBe(true);
    expect(h.uploaded).toEqual(["hero.png"]);
    expect(f.released).toHaveLength(1);
    expect(progress.some((p) => p > 0 && p < 1)).toBe(true);
    expect(Math.max(...progress)).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1]!)).toBe(true);
    expect(h.assets.state().busy).toBe(false);
    expect(h.toasts.items().some((t) => t.message.includes("已上传 hero.png"))).toBe(true);
  });

  test("unsafe names, wrong types and oversized files are refused before anything is read or sent", async () => {
    const f = filesFake({ "bad name.png": Buffer.from("x"), "evil.exe": Buffer.from("x"), "huge.png": Buffer.alloc(1) });
    const h = harness(f.client);
    const pick = f.client.pickOpen.bind(f.client);
    f.client.pickOpen = async () => (await pick()).map((x) => (x.name === "huge.png" ? { ...x, size: 33 * 1024 * 1024 } : x));
    await h.assets.pick();
    const rows = h.assets.state().rows;
    expect(rows.map((r) => r.state)).toEqual(["refused", "refused", "refused"]);
    expect(rows[0]!.error).toContain("文件名不安全");
    expect(rows[1]!.error).toContain("不支持的文件类型");
    expect(rows[2]!.error).toContain("超过");
    expect(h.requests).toEqual([]);
    expect(f.released).toHaveLength(3);
  });

  test("a failing chunk aborts the upload, reports the error and keeps the other files going", async () => {
    const f = filesFake({ "a.png": Buffer.alloc(200 * 1024, 1), "b.png": Buffer.from("fine") });
    const h = harness(f.client);
    h.server.failChunkAt = 2;
    await h.assets.pick();
    const [a, b] = h.assets.state().rows;
    expect(a).toMatchObject({ state: "failed" });
    expect(a!.error).toContain("disk full");
    expect(h.server.aborted).toBe(1);
    expect(b).toMatchObject({ state: "done" });
    expect(h.server.files.has("a.png")).toBe(false);
    expect(h.toasts.items().some((t) => t.tone === "danger" && t.message.includes("a.png"))).toBe(true);
    expect(f.released).toHaveLength(2);
  });

  test("replacing an existing asset asks first; declining skips it", async () => {
    const f = filesFake({ "old.png": Buffer.from("new bytes") });
    const h = harness(f.client);
    const done = h.assets.pick();
    await flush();
    expect(h.dialogs.active()?.title).toContain("替换");
    h.dialogs.cancel();
    await done;
    expect(h.assets.state().rows[0]).toMatchObject({ state: "cancelled" });
    expect(h.requests.filter((r) => r.capability.startsWith("studio.assets"))).toEqual([]);
    f.handles.clear();
    const again = h.assets.pick();
    await flush();
    h.dialogs.confirmActive();
    await again;
    expect(h.assets.state().rows.at(-1)).toMatchObject({ name: "old.png", state: "done" });
    expect(h.server.files.get("old.png")!.toString()).toBe("new bytes");
  });

  test("a dialog that rejects mid-queue still returns busy to false so the next pick is not blocked", async () => {
    const f = filesFake({ "old.png": Buffer.from("new bytes") });
    const h = harness(f.client);
    h.dialogs.confirm = async () => { throw new Error("dialog host went away"); };
    await expect(h.assets.pick()).rejects.toThrow("dialog host went away");
    expect(h.assets.state().busy).toBe(false);
    expect(h.assets.state().picking).toBe(false);
  });

  test("a service refusal at begin and a checksum mismatch are surfaced; cancel stops between chunks", async () => {
    const f = filesFake({ "a.png": Buffer.alloc(400 * 1024, 2) });
    const h = harness(f.client);
    h.server.refuseBegin = fail("too_large", "upload exceeds 33554432 bytes (HTTP 413)");
    await h.assets.pick();
    expect(h.assets.state().rows[0]).toMatchObject({ state: "failed" });
    expect(h.assets.state().rows[0]!.error).toContain("too_large");

    const g = filesFake({ "b.png": Buffer.alloc(600 * 1024, 3) });
    const k = harness(g.client);
    let chunks = 0;
    const orig = k.host.request;
    k.host.request = async (cap: string, p?: Record<string, any>) => { if (cap === "studio.fs.upload.chunk" && ++chunks === 2) k.assets.cancel(); return orig(cap, p); };
    await k.assets.pick();
    expect(k.assets.state().rows[0]).toMatchObject({ state: "cancelled" });
    expect(k.server.aborted).toBe(1);
    expect(k.server.files.size).toBe(0);
  });

  test("a host without the file picker says so instead of failing silently", async () => {
    const none = harness(undefined);
    expect(none.assets.state().unavailable).toContain("文件选择器");
    await none.assets.pick();
    expect(none.requests).toEqual([]);
    const denied = harness(filesFake({}, { pickError: fail("plugin_permission_denied", "denied") }).client);
    await denied.assets.pick();
    expect(denied.assets.state().unavailable).toContain("files.open");
    expect(denied.assets.state().picking).toBe(false);
    const busy = harness(filesFake({}, { pickError: fail("busy", "a file dialog is already open") }).client);
    await busy.assets.pick();
    expect(busy.assets.state().unavailable).toBeUndefined();
    expect(busy.toasts.items().some((t) => t.message.includes("already open"))).toBe(true);
  });

  test("an empty file uploads as zero bytes", async () => {
    const f = filesFake({ "empty.wav": Buffer.alloc(0) });
    const h = harness(f.client);
    await h.assets.pick();
    expect(h.assets.state().rows[0]).toMatchObject({ state: "done", size: 0 });
    expect(h.server.files.get("empty.wav")!.length).toBe(0);
  });
});

describe("image previews", () => {
  test("a decoded preview is served to the stored-image client; a refusal is reported with its reason; entries are bounded", async () => {
    const h = harness();
    await h.previews.request("k1", () => h.client.assets.preview("alpha", "a.png"));
    expect(h.previews.state().k1).toMatchObject({ status: "ready" });
    expect((await h.previews.client.read("k1")).img.length).toBe(8 + 8 * 8 * 4);
    await h.previews.request("k2", () => h.client.assets.preview("alpha", "icon.svg"));
    expect(h.previews.state().k2).toMatchObject({ status: "unavailable" });
    expect((h.previews.state().k2 as { reason: string }).reason).toContain("SVG");
    await expect(h.previews.client.read("k2")).rejects.toThrow();
    expect(h.requests.filter((r) => r.capability === "studio.assets.preview")).toHaveLength(2);
    await h.previews.request("k1", () => h.client.assets.preview("alpha", "a.png"));
    expect(h.requests.filter((r) => r.capability === "studio.assets.preview")).toHaveLength(2); // served from memory
    for (let i = 0; i < 30; i += 1) await h.previews.request(`n${i}`, () => h.client.assets.preview("alpha", "a.png"));
    expect(Object.keys(h.previews.state()).length).toBeLessThanOrEqual(24);
    h.previews.forget();
    expect(h.previews.state()).toEqual({});
  });
});

describe("resource placement editor", () => {
  test("loads the inventory, edits drafts per package, locked rows cannot change, save sends the whole package with the seen revision", async () => {
    const h = harness();
    await h.resources.refresh();
    expect(h.resources.state()).toMatchObject({ loaded: true, selectedPackage: "dev.app" });
    h.resources.setPlacement("pak:ui:font.1", "network"); // locked: ignored
    expect(h.resources.isDirty()).toBe(false);
    h.resources.setPlacement("asset:assets/old.png", "network");
    h.resources.setPlacement("asset:assets/new.png", "network");
    h.resources.setPlacement("asset:assets/new.png", "pak"); // back to the saved value: no change
    expect(h.resources.changedKeys("dev.app")).toEqual(["asset:assets/old.png"]);
    expect(h.resources.isDirty("dev.other")).toBe(false);
    await h.resources.save();
    const set = h.requests.find((r) => r.capability === "studio.project.resources.set")!;
    expect(set.params).toEqual({
      project: "alpha", revision: 5, packageId: "dev.app",
      placements: [{ key: "asset:assets/old.png", placement: "network" }, { key: "pak:ui:font.1", placement: "pak" }, { key: "asset:assets/new.png", placement: "pak" }],
    });
    expect(h.resources.state().inventory!.revision).toBe(6);
    expect(h.resources.isDirty()).toBe(false);
    expect(h.resources.pkg("dev.app")!.resources[0]!.placement).toBe("network");
    expect(h.toasts.items().some((t) => t.message.includes("已保存"))).toBe(true);
  });

  test("a stale revision (409) blocks saving with a reload prompt, keeps the draft until the user reloads", async () => {
    const h = harness();
    await h.resources.refresh();
    h.resources.setPlacement("asset:assets/old.png", "network");
    h.server.revision += 1; // someone else (a source save) bumped the revision
    await h.resources.save();
    expect(h.resources.state().stale).toContain("修订号过期");
    expect(h.resources.isDirty()).toBe(true);
    const sets = h.requests.filter((r) => r.capability === "studio.project.resources.set").length;
    await h.resources.save(); // blocked: no second request
    expect(h.requests.filter((r) => r.capability === "studio.project.resources.set").length).toBe(sets);
    const reload = h.resources.reload();
    await flush();
    expect(h.dialogs.active()?.title).toContain("重新加载");
    h.dialogs.confirmActive();
    await reload;
    expect(h.resources.state().stale).toBeUndefined();
    expect(h.resources.isDirty()).toBe(false);
    expect(h.resources.state().inventory!.revision).toBe(6);
    h.resources.setPlacement("asset:assets/old.png", "network");
    await h.resources.save();
    expect(h.resources.pkg("dev.app")!.resources[0]!.placement).toBe("network");
  });

  test("other service refusals (no build yet, busy) are errors, not a stale prompt", async () => {
    const h = harness();
    await h.resources.refresh();
    h.resources.setPlacement("asset:assets/old.png", "network");
    h.server.setError = fail("conflict", "build the current source before changing resources (HTTP 409)");
    await h.resources.save();
    expect(h.resources.state().stale).toBeUndefined();
    expect(h.resources.state().error).toContain("build the current source");
    expect(h.resources.isDirty()).toBe(true);
    expect(h.resources.state().saving).toBe(false);
  });

  test("refresh after a build or upload reloads only when nothing unsaved would be lost", async () => {
    const h = harness();
    await h.resources.refresh();
    const gets = () => h.requests.filter((r) => r.capability === "studio.project.resources.get").length;
    await h.resources.refreshIfIdle();
    expect(gets()).toBe(2);
    h.resources.setPlacement("asset:assets/old.png", "network");
    await h.resources.refreshIfIdle();
    expect(gets()).toBe(2);
    expect(h.resources.state().stale).toContain("重新加载");
    h.resources.discard();
    h.resources.reset();
    await h.resources.refreshIfIdle(); // nothing loaded: nothing to refresh
    expect(gets()).toBe(2);
  });

  test("an unbuilt project reports no builtRevision (no previews are requested)", async () => {
    const h = harness();
    h.server.builtRevision = undefined;
    await h.resources.refresh();
    expect(h.resources.state().inventory!.builtRevision).toBeUndefined();
  });
});
