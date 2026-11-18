import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

test("compact native pixels and palette stay compact in cache and decode only at HTTP delivery", async () => {
  const manager = createPreviewManager();
  try {
    const session = (manager as any).session("compact-resources");
    const resource = { asset: "atlas", revision: 1, width: 2, height: 2, psm: 1,
      bytesEncoding: "base64", pixels: Buffer.from([0, 1, 2, 3]).toString("base64"),
      palette: Buffer.from([7, 8, 9, 255]).toString("base64") };
    session.updateResourceCache({ resources: [resource] });
    const packet = session.encodeExternalPacket({ type: "frame", frame: { resources: [resource] } });
    const descriptor = JSON.parse(new TextDecoder().decode(packet).slice(6)).frame.resources[0];
    assert.equal(descriptor.bytesEncoding, "external");
    assert.equal(descriptor.pixelsBytes, 4);
    assert.equal(descriptor.paletteBytes, 4);
    assert.equal(descriptor.pixels, undefined);
    assert.equal(descriptor.palette, undefined);
    for (const [part, expected] of [["pixels", [0, 1, 2, 3]], ["palette", [7, 8, 9, 255]]] as const) {
      const url = `http://localhost${descriptor[`${part}Url`]}`;
      const response = await manager.handle(new Request(url), "compact-resources");
      assert.equal(response.status, 200);
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...expected]);
      const head = await manager.handle(new Request(url, { method: "HEAD" }), "compact-resources");
      assert.equal(head.headers.get("content-length"), "4");
      assert.equal((await head.arrayBuffer()).byteLength, 0);
    }
    assert.equal(session.resourceCache.get("atlas"), resource);
    assert.equal(typeof resource.pixels, "string");
  } finally { await manager.dispose(); }
});

test("HTTP textures use scoped raw bytes while SSE remains metadata and stale URLs expire", async () => {
  const manager = createPreviewManager({ artifacts: { bytecodePath: "/unused", pakPath: "/unused" } });
  const session = (manager as any).session("resource-transport");
  const resource = { asset: "texture/a", revision: 7, width: 1, height: 1, psm: 0, pixels: [1, 2, 3, 255] };
  session.updateResourceCache({ resources: [resource] });
  const packet = session.encodeExternalPacket({ type: "frame", frame: { resources: [resource] } });
  const wire = JSON.parse(new TextDecoder().decode(packet).slice(6));
  const descriptor = wire.frame.resources[0];
  assert.equal(descriptor.pixels, undefined);
  assert.equal(descriptor.pixelsBytes, 4);
  assert.deepEqual(resource.pixels, [1, 2, 3, 255]);
  const url = `http://localhost${descriptor.pixelsUrl}`;
  const response = await manager.handle(new Request(url), "resource-transport");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], resource.pixels);
  session.updateResourceCache({ resources: [{ ...resource, revision: 8 }] });
  assert.equal((await manager.handle(new Request(url), "resource-transport")).status, 404);
  // A guest may omit or reuse its native revision. The retained bytes still
  // need a new URL so an old in-flight fetch cannot win after replacement.
  session.updateResourceCache({ resources: [{ ...resource, pixels: [4, 5, 6, 255] }] });
  const replacement = JSON.parse(new TextDecoder().decode(session.encodeExternalPacket({ type: "frame", frame: { resources: [...session.resourceCache.values()] } })).slice(6)).frame.resources[0];
  assert.notEqual(replacement.pixelsUrl, descriptor.pixelsUrl);
  assert.equal((await manager.handle(new Request(url), "resource-transport")).status, 404);
  session.updateResourceCache({ resources: [resource] });
  await session.stopProbe();
  session.updateResourceCache({ resources: [resource] });
  assert.equal((await manager.handle(new Request(url), "resource-transport")).status, 404);
  await manager.dispose();
});

test("multi-pass runtime settle preserves releasedResources and re-emits static PAK textures on remount", async () => {
  const manager = createPreviewManager();
  try {
    const session = (manager as any).session("multi-pass-release");
    const asset = "assets/looseleaf/viz/avatar_guoguo.png";
    const staticTexture = {
      asset,
      revision: 1,
      width: 1,
      height: 1,
      psm: 3,
      pixels: [12, 34, 56, 255],
    };
    const runtime = {
      appId: "babylink-system-ui",
      instanceId: "system-ui",
      generation: 1,
      probe: null,
      artifacts: {},
      viewportWidth: 390,
      viewportHeight: 844,
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      resources: new Map(),
      pendingReleasedResources: new Set<string>(),
      initialEvents: [],
      pendingBrowserEvents: [],
      needsPump: false,
      pumping: 0,
    };
    session.rootRuntime = runtime;

    // 1. Modal opens: static PAK texture (revision 1) is mounted and cached.
    await session.ingestRuntimeFrame(runtime, {
      frame: 1,
      width: 390,
      height: 844,
      ops: [{ type: "image", asset, x: 0, y: 0, w: 48, h: 48 }],
      events: [],
      resources: [staticTexture],
    }, 0, false);
    session.publishCompositedFrame(runtime.frame);
    assert.equal(session.frame.resources.length, 1);
    assert.equal(session.resourceCache.has(asset), true);

    // 2. Modal closes on pass 0 (emits releasedResources + accessibility event),
    // followed immediately by settle pass 1 with empty releasedResources before publish.
    await session.ingestRuntimeFrame(runtime, {
      frame: 2,
      width: 390,
      height: 844,
      ops: [],
      events: [{ name: "accessibility.snapshot", payload: { generation: 1, controls: [] } }],
      resources: [],
      releasedResources: [asset],
    }, 0, false);
    await session.ingestRuntimeFrame(runtime, {
      frame: 3,
      width: 390,
      height: 844,
      ops: [],
      events: [],
      resources: [],
      releasedResources: [],
    }, 0, false);
    session.publishCompositedFrame(runtime.frame);
    assert.deepEqual(session.frame.releasedResources, [asset]);
    assert.equal(session.resourceCache.has(asset), false);

    // 3. Subsequent frame does not repeat the already-published release delta.
    await session.ingestRuntimeFrame(runtime, {
      frame: 4,
      width: 390,
      height: 844,
      ops: [],
      events: [],
      resources: [],
      releasedResources: [],
    }, 0, false);
    session.publishCompositedFrame(runtime.frame);
    assert.deepEqual(session.frame.releasedResources, []);

    // 4. Re-opening the modal with the same static PAK revision (1) re-emits the resource.
    await session.ingestRuntimeFrame(runtime, {
      frame: 5,
      width: 390,
      height: 844,
      ops: [{ type: "image", asset, x: 0, y: 0, w: 48, h: 48 }],
      events: [],
      resources: [staticTexture],
    }, 0, false);
    session.publishCompositedFrame(runtime.frame);
    assert.equal(session.frame.resources.length, 1);
    assert.equal(session.frame.resources[0].asset, asset);
  } finally {
    await manager.dispose();
  }
});
