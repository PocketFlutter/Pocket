import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";
import { base64Decode, base64Encode, utf8Decode, utf8Encode } from "../src/bytes.ts";
import { sha256Hex } from "../src/sha256.ts";
import {
  CHUNK_BYTES,
  COS_CHECK_TIMEOUT_FRAMES,
  LONG_PICKER_TIMEOUT_FRAMES,
  createStudioClient,
  StudioError,
  type StudioHost,
  type StudioHostRequestOptions,
  type StudioStreams,
} from "../src/studio-client.ts";

type Call = { capability: string; params: any; options?: StudioHostRequestOptions };

function fakeHost(handler: (c: Call) => unknown | Promise<unknown>): { host: StudioHost; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    host: {
      async request(capability, params = {}, options) {
        const call: Call = { capability, params, ...(options !== undefined ? { options } : {}) };
        calls.push(call);
        return handler(call) as any;
      },
    },
  };
}

test("sha256, base64 and utf8 helpers match node", () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 1000, 200_000]) {
    const bytes = new Uint8Array(randomBytes(size));
    assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"), `sha ${size}`);
    assert.equal(base64Encode(bytes), Buffer.from(bytes).toString("base64"));
    assert.deepEqual(Array.from(base64Decode(base64Encode(bytes))), Array.from(bytes));
  }
  const text = "héllo 你好 😀 \n tab\t";
  assert.deepEqual(Array.from(utf8Encode(text)), Array.from(Buffer.from(text)));
  assert.equal(utf8Decode(utf8Encode(text)), text);
});

test("request shapes: every wrapper sends the frozen capability and params", async () => {
  const { host, calls } = fakeHost(() => ({ projects: [] }));
  const c = createStudioClient(host);
  await c.project.list();
  await c.project.create("p-1", "game", { name: "N" });
  await c.project.open("p-1");
  await c.project.openLocal();
  await c.project.settings.get("p-1");
  await c.project.settings.set("p-1", { title: "T" });
  await c.ecosystem.catalog();
  await c.ecosystem.get("p-1");
  await c.ecosystem.set("p-1", { modules: ["apple-widget"] });
  await c.cos.get("p-1");
  await c.cos.set("p-1", { enabled: true, bucket: "b-1", region: "ap-guangzhou" });
  await c.cos.check("p-1", { bucket: "b-1", region: "ap-guangzhou" });
  await c.cos.publish("p-1", "release");
  await c.fs.tree("p-1", true);
  await c.fs.read("p-1", "a.ts");
  await c.fs.write("p-1", "a.ts", "x");
  await c.fs.rename("p-1", "a.ts", "b.ts", true);
  await c.fs.delete("p-1", "b.ts");
  await c.fs.stat("p-1", "src");
  await c.fs.mkdir("p-1", "src");
  await c.fs.rmdir("p-1", "src");
  await c.build.start("p-1");
  await c.build.cancel("p-1");
  await c.build.status("p-1");
  await c.logs.tail("p-1");
  await c.preview.publish("p-1");
  await c.preview.publish("p-1", ["dev.pocket.studio.preview", "dev.pocket.studio.preview.web", "dev.pocket.studio.preview.wechat"]);
  await c.wechat.status("p-1");
  await c.wechat.start("p-1", "main");
  await c.wechat.stop("p-1");
  await c.preview.devices();
  await c.preview.deploy("p-1", "sim");
  await c.preview.deployStatus("p-1", "j1");
  await c.preview.deployCancel("p-1", "j1");
  await c.publish.plan("p-1", "release");
  await c.publish.publish("p-1");
  await c.publish.history("p-1");
  await c.publish.offline("p-1");
  await c.artifacts.list("p-1");
  await c.artifacts.inspect("p-1", "build.json");
  await c.service.health();
  await c.service.upgradeStatus();
  await c.service.upgradeCheck();
  await c.service.upgradeApply();
  await c.logs.diagnostics("p-1");
  await c.logs.diagnostics("p-1", "crash");
  assert.deepEqual(calls.map((x) => x.capability), [
    "studio.project.list", "studio.project.create", "studio.project.open", "studio.project.openLocal",
    "studio.project.settings.get", "studio.project.settings.set",
    "studio.ecosystem.catalog", "studio.ecosystem.get", "studio.ecosystem.set",
    "studio.cos.get", "studio.cos.set", "studio.cos.check", "studio.cos.publish",
    "studio.fs.tree", "studio.fs.read", "studio.fs.write", "studio.fs.rename", "studio.fs.delete", "studio.fs.stat", "studio.fs.mkdir", "studio.fs.rmdir",
    "studio.build.start", "studio.build.cancel", "studio.build.status", "studio.logs.tail",
    "studio.preview.publish", "studio.preview.publish",
    "studio.wechat.status", "studio.wechat.start", "studio.wechat.stop",
    "studio.preview.devices", "studio.preview.deploy", "studio.preview.deployStatus", "studio.preview.deployCancel",
    "studio.publish.plan", "studio.publish.publish", "studio.publish.history", "studio.publish.offline",
    "studio.artifacts.list", "studio.artifacts.inspect", "studio.service.health", "studio.service.upgrade.status",
    "studio.service.upgrade.check", "studio.service.upgrade.apply", "studio.logs.diagnostics", "studio.logs.diagnostics",
  ]);
  assert.deepEqual(calls[26]!.params, {
    project: "p-1",
    previewAppIds: ["dev.pocket.studio.preview", "dev.pocket.studio.preview.web", "dev.pocket.studio.preview.wechat"],
  });
  assert.deepEqual(calls[28]!.params, { project: "p-1", targetId: "main" });
  assert.deepEqual(calls[calls.length - 2]!.params, { project: "p-1" });
  assert.deepEqual(calls[calls.length - 1]!.params, { project: "p-1", kind: "crash" });
  assert.deepEqual(calls[1]!.params, { id: "p-1", template: "game", settings: { name: "N" } });
  assert.deepEqual(calls[3]!.params, {});
  assert.deepEqual(calls[3]!.options, { timeoutFrames: LONG_PICKER_TIMEOUT_FRAMES });
  assert.deepEqual(calls[5]!.params, { project: "p-1", settings: { title: "T" } });
  assert.deepEqual(calls[13]!.params, { project: "p-1", assets: true });
  assert.deepEqual(calls[16]!.params, { project: "p-1", from: "a.ts", to: "b.ts", overwrite: true });
});

test("project settings & create strip build, and openLocal / create / ecosystem / cos / publish / upgrade pass exact options and payloads", async () => {
  const { host, calls } = fakeHost((call) => {
    switch (call.capability) {
      case "studio.project.openLocal":
        return { cancelled: false, project: { id: "local-app", appId: "pocket.local", name: "Local", title: "Local", version: "0.2.0", build: 1, tickHz: 60, template: "app", directory: "<picked>/local-app" } };
      case "studio.project.create":
        return { id: call.params.id, appId: "pocket.created", name: "Created", title: "Created", version: "0.3.0", build: 1, tickHz: 60, template: call.params.template ?? "app", ecosystemModules: call.params.ecosystemModules ?? [] };
      case "studio.project.settings.set":
        return { id: call.params.project, name: "Created", appId: "pocket.created", version: "0.3.1", build: 1, tickHz: 60, ...call.params.settings };
      case "studio.ecosystem.catalog":
        return { modules: [{ id: "ios-live-activity", platform: "apple", label: "Live Activity" }, { id: "android-glance-widget", platform: "android", label: "Glance" }] };
      case "studio.ecosystem.get":
        return { modules: ["ios-live-activity"], enabledProfiles: ["ios-live-activity"], catalog: [] };
      case "studio.ecosystem.set":
        return { modules: call.params.modules ?? call.params.add ?? [], enabledProfileIds: ["ios-live-activity"], createdFiles: ["ecosystem/ios_live_activity.tsx"], entryWired: true };
      case "studio.cos.get":
        return { local: { available: true, source: "coscli" }, config: { enabled: true, syncOnPublish: true, bucket: "b-1", region: "ap-guangzhou", keyPrefix: "ota", publicBaseUrl: "" } };
      case "studio.cos.set":
        return { local: { available: true, source: "workspace", hasWorkspaceCredentials: call.params.credentials !== null }, config: { enabled: true, syncOnPublish: true, bucket: call.params.bucket ?? "b-1", region: call.params.region ?? "ap-guangzhou", keyPrefix: "ota", publicBaseUrl: "" } };
      case "studio.cos.check":
        return { ok: true, bucket: call.params.bucket, region: call.params.region, checkedAt: "2026-11-17T12:00:00.000Z" };
      case "studio.cos.publish":
        return { ok: true, cosPublish: { slot: call.params.channel === "release" ? "stable" : "test", version: "0.3.0", build: 1, uploadedFiles: 3, skippedFiles: 1, appConfigUrl: "https://cos/host.json", manifestUrl: "https://cos/latest.json" } };
      case "studio.publish.publish":
        return {
          status: { revision: 2, builtRevision: 2, busy: false, publish: { channel: call.params.channel, version: "0.3.0", build: 1 } },
          cosPublish: { slot: "test", version: "0.3.0", build: 1, uploadedFiles: 2, skippedFiles: 0 },
          cosError: "cos warning",
        };
      case "studio.service.upgrade.status":
        return {
          currentVersion: "0.1.12",
          latestVersion: "0.2.0",
          mode: "standalone",
          modeReason: "独立安装目录",
          autoUpgradeSupported: true,
          status: "downloading",
          upgradeAvailable: true,
          downloadedBytes: 512_000,
          downloadTotalBytes: 1_024_000,
          appliedAt: "2026-11-15T08:00:00.000Z",
          deferredReason: "busy",
        };
      default:
        return {};
    }
  });
  const c = createStudioClient(host);

  // 1) stripBuild in settings.set and create
  await c.project.settings.set("p-1", { name: "New", version: "0.3.1", build: 99 } as any);
  assert.deepEqual(calls.at(-1)!.params, { project: "p-1", settings: { name: "New", version: "0.3.1" } });
  assert.equal("build" in calls.at(-1)!.params.settings, false);

  await c.project.create("p-legacy", "app", { name: "Legacy", build: 42 });
  assert.deepEqual(calls.at(-1)!.params, { id: "p-legacy", template: "app", settings: { name: "Legacy" } });
  assert.equal("build" in calls.at(-1)!.params.settings, false);
  assert.equal(calls.at(-1)!.options, undefined);

  // 2) create({ pickParentDirectory, ecosystemModules, settings }) & LONG_PICKER_TIMEOUT_FRAMES
  const created = await c.project.create({
    id: "p-picked",
    template: "game",
    pickParentDirectory: true,
    ecosystemModules: ["ios-live-activity", "android-glance-widget"],
    settings: { name: "Picked", appId: "pocket.picked", version: "0.3.0", build: 7 } as any,
  });
  assert.deepEqual(calls.at(-1)!.params, {
    id: "p-picked",
    template: "game",
    pickParentDirectory: true,
    ecosystemModules: ["ios-live-activity", "android-glance-widget"],
    settings: { name: "Picked", appId: "pocket.picked", version: "0.3.0" },
  });
  assert.deepEqual(calls.at(-1)!.options, { timeoutFrames: LONG_PICKER_TIMEOUT_FRAMES });
  assert.equal((created as any).id, "p-picked");

  // 3) openLocal passes LONG_PICKER_TIMEOUT_FRAMES
  const openedLocal = await c.project.openLocal();
  assert.equal(calls.at(-1)!.capability, "studio.project.openLocal");
  assert.deepEqual(calls.at(-1)!.options, { timeoutFrames: LONG_PICKER_TIMEOUT_FRAMES });
  assert.equal(openedLocal.cancelled, false);

  // 4) ecosystem.{catalog, get, set}
  const cat = await c.ecosystem.catalog();
  assert.equal(cat.modules.length, 2);
  const ecoGet = await c.ecosystem.get("p-picked");
  assert.deepEqual(ecoGet.modules, ["ios-live-activity"]);
  const ecoSet = await c.ecosystem.set("p-picked", { modules: ["ios-live-activity"], add: ["watchos"] });
  assert.deepEqual(calls.at(-1)!.params, { project: "p-picked", modules: ["ios-live-activity"], add: ["watchos"] });
  assert.equal(ecoSet.entryWired, true);

  // 5) cos.{get, set, check, publish} & timeouts
  await c.cos.get("p-picked");
  assert.deepEqual(calls.at(-1)!.params, { project: "p-picked" });
  await c.cos.set("p-picked", { enabled: true, syncOnPublish: true, bucket: "b-1", region: "ap-guangzhou", credentials: null });
  assert.deepEqual(calls.at(-1)!.params, { project: "p-picked", enabled: true, syncOnPublish: true, bucket: "b-1", region: "ap-guangzhou", credentials: null });
  const chk = await c.cos.check("p-picked", { bucket: "b-1", region: "ap-guangzhou" });
  assert.deepEqual(calls.at(-1)!.params, { project: "p-picked", bucket: "b-1", region: "ap-guangzhou" });
  assert.deepEqual(calls.at(-1)!.options, { timeoutFrames: COS_CHECK_TIMEOUT_FRAMES });
  assert.equal(chk.ok, true);
  const cosPub = await c.cos.publish("p-picked", "release");
  assert.deepEqual(calls.at(-1)!.params, { project: "p-picked", channel: "release" });
  assert.deepEqual(calls.at(-1)!.options, { timeoutFrames: LONG_PICKER_TIMEOUT_FRAMES });
  assert.equal(cosPub.cosPublish.slot, "stable");

  // 6) PublishResult.cosPublish / cosError & SdkUpgradePayload fields
  const pubRes = await c.publish.publish("p-picked", "test");
  assert.equal(pubRes.cosPublish?.uploadedFiles, 2);
  assert.equal(pubRes.cosError, "cos warning");
  const upg = await c.service.upgradeStatus();
  assert.equal(upg.autoUpgradeSupported, true);
  assert.equal(upg.modeReason, "独立安装目录");
  assert.equal(upg.downloadedBytes, 512_000);
  assert.equal(upg.downloadTotalBytes, 1_024_000);
  assert.equal(upg.appliedAt, "2026-11-15T08:00:00.000Z");
  assert.equal(upg.deferredReason, "busy");
});

test("error mapping keeps the structured code and message", async () => {
  const { host } = fakeHost(() => { throw Object.assign(new Error("file not found (HTTP 404)"), { code: "not_found" }); });
  await assert.rejects(createStudioClient(host).fs.read("p", "a.ts"), (e: unknown) =>
    e instanceof StudioError && e.code === "not_found" && e.capability === "studio.fs.read" && e.message.includes("404"));
  const plain = fakeHost(() => { throw "boom"; });
  await assert.rejects(createStudioClient(plain.host).fs.stat("p", "a"), (e: unknown) => e instanceof StudioError && e.code === "host_error");
});

function chunkServer(file: Uint8Array, tamper = false) {
  const sha = createHash("sha256").update(file).digest("hex");
  return fakeHost(({ capability, params }) => {
    if (capability === "studio.fs.read") throw Object.assign(new Error("too big"), { code: "too_large" });
    assert.equal(capability, "studio.fs.readChunk");
    const length = Math.min(params.length, CHUNK_BYTES);
    const part = file.subarray(params.offset, params.offset + length);
    const data = Buffer.from(part);
    if (tamper && data.length) data[0] = data[0]! ^ 1;
    return { path: params.path, offset: params.offset, length: part.length, totalBytes: file.length, sha256: sha, mtimeMs: 1, data: data.toString("base64") };
  });
}

test("chunked read splits at 128 KiB, reassembles and verifies sha256", async () => {
  const file = new Uint8Array(randomBytes(CHUNK_BYTES * 2 + 777));
  const { host, calls } = chunkServer(file);
  const result = await createStudioClient(host).fs.readBytes("p", "big.bin");
  assert.deepEqual(Array.from(result.bytes), Array.from(file));
  const chunks = calls.filter((c) => c.capability === "studio.fs.readChunk");
  assert.deepEqual(chunks.map((c) => c.params.offset), [0, CHUNK_BYTES, CHUNK_BYTES * 2]);
  assert.ok(chunks.every((c) => c.params.length <= CHUNK_BYTES));
});

test("chunked read rejects corrupted bytes, oversize files and files that change mid-read", async () => {
  const file = new Uint8Array(randomBytes(CHUNK_BYTES + 10));
  await assert.rejects(createStudioClient(chunkServer(file, true).host).fs.readBytes("p", "x"), (e: any) => e.code === "checksum_mismatch");
  await assert.rejects(createStudioClient(chunkServer(file).host).fs.readBytes("p", "x", 100), (e: any) => e.code === "too_large");
  let n = 0;
  const { host } = fakeHost(({ params }) => ({ path: "x", offset: params.offset, length: CHUNK_BYTES, totalBytes: CHUNK_BYTES * 2, sha256: `s${n++}`, mtimeMs: 1, data: base64Encode(new Uint8Array(CHUNK_BYTES)) }));
  await assert.rejects(createStudioClient(host).fs.readBytes("p", "x"), (e: any) => e.code === "conflict");
});

test("readText falls back to chunks only when the small read is too_large", async () => {
  const text = "x".repeat(CHUNK_BYTES + 5) + "你";
  const { host, calls } = chunkServer(utf8Encode(text));
  assert.equal((await createStudioClient(host).fs.readText("p", "a.ts")).text, text);
  assert.equal(calls[0]!.capability, "studio.fs.read");
  const missing = fakeHost(() => { throw Object.assign(new Error("nope"), { code: "not_found" }); });
  await assert.rejects(createStudioClient(missing.host).fs.readText("p", "a.ts"), (e: any) => e.code === "not_found");
  assert.equal(missing.calls.length, 1);
});

test("writeText: small write is one call; large write is a chunked, hashed upload", async () => {
  const small = fakeHost(() => ({ path: "a", bytes: 1, revision: 2 }));
  await createStudioClient(small.host).fs.writeText("p", "a.ts", "hi");
  assert.deepEqual(small.calls.map((c) => c.capability), ["studio.fs.write"]);

  const text = "// big\n" + "é".repeat(300_000);
  const bytes = Buffer.from(text);
  const received: Buffer[] = [];
  const { host, calls } = fakeHost(({ capability, params }) => {
    if (capability === "studio.fs.upload.begin") return { uploadId: "u1", chunkBytes: CHUNK_BYTES };
    if (capability === "studio.fs.upload.chunk") { assert.equal(params.offset, received.reduce((n, b) => n + b.length, 0)); received.push(Buffer.from(params.data, "base64")); return { received: 0, totalBytes: 0 }; }
    if (capability === "studio.fs.upload.commit") return { path: "big.ts", bytes: bytes.length, sha256: createHash("sha256").update(Buffer.concat(received)).digest("hex"), revision: 3 };
    throw new Error(capability);
  });
  const done = await createStudioClient(host).fs.writeText("p", "big.ts", text);
  assert.equal(done.bytes, bytes.length);
  assert.ok(received.every((b) => b.length <= CHUNK_BYTES));
  assert.equal(Buffer.concat(received).toString("utf8"), text);
  assert.equal(calls[0]!.params.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(calls[0]!.params.totalBytes, bytes.length);
});

test("a failed upload chunk aborts the upload and rethrows", async () => {
  const { host, calls } = fakeHost(({ capability }) => {
    if (capability === "studio.fs.upload.begin") return { uploadId: "u9", chunkBytes: CHUNK_BYTES };
    if (capability === "studio.fs.upload.chunk") throw Object.assign(new Error("budget"), { code: "too_many_requests" });
    return {};
  });
  await assert.rejects(createStudioClient(host).fs.writeText("p", "big.ts", "x".repeat(300_000)), (e: any) => e.code === "too_many_requests");
  assert.equal(calls.at(-1)!.capability, "studio.fs.upload.abort");
  assert.equal(calls.at(-1)!.params.uploadId, "u9");
});

test("stream batches are expanded into individual events; gap markers pass through; close cancels", () => {
  let dataListener: (v: any) => void = () => {};
  let cancelled = "";
  let opened: any;
  const streams: StudioStreams = { open(topic, params) { opened = { topic, params }; return {
    onData(l) { dataListener = l; return () => {}; }, onError: () => () => {}, onEnd: () => () => {}, cancel(r) { cancelled = r ?? ""; },
  }; } };
  const c = createStudioClient(fakeHost(() => ({})).host, streams);
  const seen: any[] = [];
  const sub = c.fs.watch("p-1", (e) => seen.push(e));
  dataListener({ events: [{ type: "ready", revision: 1 }, { type: "gap", dropped: 4 }] });
  dataListener({ events: [{ type: "change", path: "a.ts", kind: "file", event: "change" }] });
  dataListener({ nonsense: true });
  assert.deepEqual(seen.map((e) => e.type), ["ready", "gap", "change"]);
  assert.deepEqual(opened, { topic: "studio.fs.watch", params: { project: "p-1" } });
  sub.close();
  assert.ok(cancelled);
  assert.throws(() => createStudioClient(fakeHost(() => ({})).host).build.events("p", () => {}), (e: any) => e.code === "streams_unavailable");
});

test("guest manifest declares exactly the capabilities the Dart provider registers", () => {
  const dart = readFileSync(join(import.meta.dir, "../../../sdk/packages/pocket_studio/lib/src/studio_routes.dart"), "utf8");
  const names = [...dart.matchAll(/StudioCall\(\s*'(studio\.[A-Za-z.]+)'/g)].map((m) => m[1]!).sort();
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../manifest.json"), "utf8"));
  const declared = (manifest.capabilities.optional as string[]).filter((n) => n.startsWith("studio.")).sort();
  assert.deepEqual(declared, names);
  assert.ok(names.length >= 40);
  for (const added of [
    "studio.project.openLocal",
    "studio.ecosystem.catalog",
    "studio.ecosystem.get",
    "studio.ecosystem.set",
    "studio.cos.get",
    "studio.cos.set",
    "studio.cos.check",
    "studio.cos.publish",
    "studio.logs.diagnostics",
    "studio.service.upgrade.check",
    "studio.service.upgrade.apply",
    "studio.wechat.status",
    "studio.wechat.start",
    "studio.wechat.stop",
  ]) {
    assert.ok(names.includes(added), added);
  }
});

test("incremental sha256 equals one-shot across arbitrary update boundaries", async () => {
  const { Sha256 } = await import("../src/sha256.ts");
  const bytes = new Uint8Array(randomBytes(10_000));
  for (const step of [1, 7, 63, 64, 65, 1000]) {
    const hasher = new Sha256();
    for (let i = 0; i < bytes.length; i += step) hasher.update(bytes.subarray(i, Math.min(i + step, bytes.length)));
    assert.equal(hasher.hex(), createHash("sha256").update(bytes).digest("hex"), `step ${step}`);
  }
});

test("large writes and reads work in bounded slices: every slice yields a turn, multibyte text is never cut", async () => {
  // 600 KB of text with 3- and 4-byte characters at every offset class.
  const text = Array.from({ length: 30_000 }, (_, i) => `行${i}😀é\n`).join("");
  const bytes = Buffer.from(text);
  let upload: Buffer[] = [];
  let begun: any;
  const { host, calls } = fakeHost((c) => {
    if (c.capability === "studio.fs.upload.begin") { begun = c.params; return { uploadId: "u", chunkBytes: CHUNK_BYTES }; }
    if (c.capability === "studio.fs.upload.chunk") { upload.push(Buffer.from(c.params.data, "base64")); return { received: 0, totalBytes: 0 }; }
    if (c.capability === "studio.fs.upload.commit") return { path: "big.ts", bytes: bytes.length, sha256: begun.sha256, revision: 2 };
    if (c.capability === "studio.fs.readChunk") {
      const length = Math.min(c.params.length, bytes.length - c.params.offset);
      return { path: "big.ts", offset: c.params.offset, length, totalBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mtimeMs: 1, data: bytes.subarray(c.params.offset, c.params.offset + length).toString("base64") };
    }
    throw new Error(c.capability);
  });
  let yields = 0;
  const client = createStudioClient(host, undefined, { yieldTurn: async () => { yields += 1; } });
  const result = await client.fs.writeText("p", "big.ts", text);
  assert.equal(result.bytes, bytes.length);
  assert.equal(begun.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(Buffer.concat(upload).toString("utf8"), text);
  const writeYields = yields;
  assert.ok(writeYields >= Math.floor(bytes.length / (64 * 1024)), `encode and hash yield per slice (${writeYields})`);
  const read = await client.fs.readText("p", "big.ts", 4 * 1024 * 1024, bytes.length);
  assert.equal(read.text, text);
  assert.ok(yields > writeYields, "hashing and decoding on read yield too");
  assert.ok(calls.some((c) => c.capability === "studio.fs.readChunk"));
});
