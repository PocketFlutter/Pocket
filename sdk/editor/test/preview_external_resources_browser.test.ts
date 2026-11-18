import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { chromium } from "playwright";
import { encodePreviewStreamPacket } from "../preview.ts";

const source = readFileSync(
  process.env.POCKET_PREVIEW_CLIENT ?? new URL("../client/preview.js", import.meta.url),
  "utf8",
);

function externalResource(project: string, revision: number, scope = "scope-a") {
  const query = new URLSearchParams({
    asset: "delayed-pixel",
    revision: String(revision),
    scope,
    part: "pixels",
  });
  return {
    asset: "delayed-pixel",
    revision,
    width: 1,
    height: 1,
    psm: 3,
    linear: false,
    bytesEncoding: "external",
    pixelsUrl: `/api/projects/${encodeURIComponent(project)}/preview/resource?${query}`,
    pixelsBytes: 4,
  };
}

function frame(
  number: number,
  ops: Array<Record<string, unknown>>,
  resources: Array<Record<string, unknown>> = [],
  extra: Record<string, unknown> = {},
) {
  return {
    frame: number,
    width: 16,
    height: 16,
    events: [],
    ops,
    resources,
    ...extra,
  };
}

const background = (color: number) => ({ type: "rect", x: 0, y: 0, w: 16, h: 16, color });
const image = (x: number, y: number) => ({ type: "image", asset: "delayed-pixel", x, y, w: 4, h: 4 });

test("external texture fetch leaves frame ingestion live and gates presentation ACK on decoded paint", { timeout: 30_000 }, async () => {
  const project = "external-ack";
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let markResourceStarted!: () => void;
  const resourceStarted = new Promise<void>((resolve) => { markResourceStarted = resolve; });
  let resourceResponseAt = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/stream")) {
        assert.equal(url.searchParams.get("resources"), "http");
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(encodePreviewStreamPacket({
              type: "frame",
              frame: frame(1, [background(0xff102030), image(0, 0)], [externalResource(project, 4)]),
            }, true));
          },
        }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }
      if (url.pathname.endsWith("/resource")) {
        markResourceStarted();
        await new Promise((resolve) => setTimeout(resolve, 300));
        resourceResponseAt = Date.now();
        return new Response(new Uint8Array([201, 98, 45, 255]), {
          headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
        });
      }
      if (url.pathname.endsWith("/input")) return Response.json({ ok: true });
      return new Response(
        `<div data-pocket-preview data-project-id=${project}></div><script>${source.replaceAll("</script", "<\\/script")}</script>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 16, height: 16 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      (window as any).__rafTicks = 0;
      (window as any).__presentationAcks = [];
      const tick = () => {
        (window as any).__rafTicks += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (init?.method === "POST" && String(input).endsWith("/input")) {
          const payload = JSON.parse(String(init.body || "{}"));
          if (payload.type === "presented") {
            const preview = (window as any).PocketEditorPreviewInstance;
            const canvas = preview?.canvas as HTMLCanvasElement | undefined;
            const pixel = canvas?.getContext("2d")?.getImageData(9, 9, 1, 1).data;
            (window as any).__presentationAcks.push({
              payload,
              frame: preview?.getFrame()?.frame,
              pixel: pixel ? Array.from(pixel) : null,
              at: Date.now(),
            });
          }
        }
        return originalFetch(input, init);
      };
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance?.getFrame()?.frame === 1);
    await resourceStarted;

    const beforeGeometry = await page.evaluate(() => Number((window as any).__rafTicks));
    streamController!.enqueue(encodePreviewStreamPacket({
      type: "frame",
      frame: frame(2, [background(0xff113355), image(8, 8)], [], { presentationTokens: ["launch-ready"] }),
    }, true));
    await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance?.getFrame()?.frame === 2);
    await new Promise((resolve) => setTimeout(resolve, 70));
    const beforeResource = await page.evaluate(() => {
      const preview = (window as any).PocketEditorPreviewInstance;
      return {
        frame: preview.getFrame().frame,
        pixel: Array.from((preview.canvas as HTMLCanvasElement).getContext("2d")!.getImageData(2, 2, 1, 1).data),
        ticks: Number((window as any).__rafTicks),
        acks: (window as any).__presentationAcks.length,
      };
    });
    assert.equal(beforeResource.frame, 2, "geometry frame arrives while raw texture GET is delayed");
    assert.deepEqual(beforeResource.pixel, [17, 51, 85, 255], "the later geometry frame paints before resource bytes arrive");
    assert.ok(beforeResource.ticks - beforeGeometry >= 2, "browser animation frames continue during the delayed resource GET");
    assert.equal(beforeResource.acks, 0, "presentation ACK waits while a referenced external texture is pending");

    await page.waitForFunction(() => (window as any).__presentationAcks.length === 1);
    const ack = await page.evaluate(() => (window as any).__presentationAcks[0]);
    assert.deepEqual(ack.payload.tokens, ["launch-ready"]);
    assert.equal(ack.frame, 2, "ACK follows the current geometry frame, not the stale initial frame");
    assert.deepEqual(ack.pixel, [201, 98, 45, 255], "ACK is sent only after the external texture reached Canvas");
    assert.ok(ack.at >= resourceResponseAt, "ACK follows the raw bytes response");

    streamController!.enqueue(encodePreviewStreamPacket({
      type: "frame",
      frame: frame(3, [background(0xff113355), image(8, 8)], [externalResource(project, 4)]),
    }, true));
    await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance?.getFrame()?.frame === 3);
    await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance.getFrame().resources[0]?.pixels instanceof Uint8Array);
    const hydrated = await page.evaluate(() => (window as any).PocketEditorPreviewInstance.getFrame().resources[0]);
    assert.deepEqual([...hydrated.pixels], [201, 98, 45, 255], "getFrame hydrates the existing resource shape once bytes are ready");
    assert.equal(hydrated.bytesEncoding, undefined);
    await page.evaluate(() => (window as any).PocketEditorPreviewInstance.close());
  } finally {
    await browser.close();
    await server.stop(true);
  }
});

test("external resource replacement and release ignore stale raw responses", { timeout: 30_000 }, async () => {
  const project = "external-stale";
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let markStreamReady!: () => void;
  const streamReady = new Promise<void>((resolve) => { markStreamReady = resolve; });
  let markRevision1Started!: () => void;
  const revision1Started = new Promise<void>((resolve) => { markRevision1Started = resolve; });
  let markRevision3Started!: () => void;
  const revision3Started = new Promise<void>((resolve) => { markRevision3Started = resolve; });
  const errors: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/stream")) {
        assert.equal(url.searchParams.get("resources"), "http");
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; markStreamReady(); } }), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
        });
      }
      if (url.pathname.endsWith("/resource")) {
        const revision = Number(url.searchParams.get("revision"));
        if (revision === 1) markRevision1Started();
        if (revision === 3) markRevision3Started();
        await new Promise((resolve) => setTimeout(resolve, revision === 1 ? 240 : revision === 2 ? 45 : 180));
        const red = revision === 1 ? 10 : revision === 2 ? 220 : 90;
        return new Response(new Uint8Array([red, 20, 30, 255]), {
          headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
        });
      }
      if (url.pathname.endsWith("/input")) return Response.json({ ok: true });
      return new Response(
        `<div data-pocket-preview data-project-id=${project}></div><script>${source.replaceAll("</script", "<\\/script")}</script>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 16, height: 16 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      window.addEventListener("message", (event) => {
        if (event.data?.source === "pocket-editor-preview" && event.data?.type === "preview.error") {
          ((window as any).__resourceErrors ||= []).push(event.data.error);
        }
      });
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const send = async (value: ReturnType<typeof frame>) => {
      streamController!.enqueue(encodePreviewStreamPacket({ type: "frame", frame: value }, true));
      await page.waitForFunction((expected) => (window as any).PocketEditorPreviewInstance?.getFrame()?.frame === expected, value.frame);
    };
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance?.getFrame));
    await streamReady;
    await send(frame(1, [image(0, 0)], [externalResource(project, 1)]));
    await revision1Started;
    await send(frame(2, [image(0, 0)], [externalResource(project, 2)]));
    await page.waitForFunction(() => {
      const preview = (window as any).PocketEditorPreviewInstance;
      return preview?.getFrame()?.resources?.[0]?.pixels instanceof Uint8Array;
    });
    await new Promise((resolve) => setTimeout(resolve, 260));
    const replacement = await page.evaluate(() => {
      const preview = (window as any).PocketEditorPreviewInstance;
      return {
        revision: preview.getFrame().resources[0].revision,
        pixel: Array.from((preview.canvas as HTMLCanvasElement).getContext("2d")!.getImageData(2, 2, 1, 1).data),
        errors: (window as any).__resourceErrors || [],
      };
    });
    assert.equal(replacement.revision, 2, "the replacement descriptor stays current after the older request settles");
    assert.deepEqual(replacement.pixel, [220, 20, 30, 255], "a stale revision cannot replace the current Canvas resource");
    assert.deepEqual(replacement.errors, [], "aborted stale resource requests do not report a preview error");

    await send(frame(3, [image(0, 0)], [externalResource(project, 3)]));
    await revision3Started;
    await send(frame(4, [background(0xff334455)], [], { releasedResources: ["delayed-pixel"] }));
    await new Promise((resolve) => setTimeout(resolve, 220));
    const released = await page.evaluate(() => ({
      frame: (window as any).PocketEditorPreviewInstance.getFrame().frame,
      resources: (window as any).PocketEditorPreviewInstance.getFrame().resources,
      pixel: Array.from(((window as any).PocketEditorPreviewInstance.canvas as HTMLCanvasElement).getContext("2d")!.getImageData(2, 2, 1, 1).data),
      errors: (window as any).__resourceErrors || [],
    }));
    assert.equal(released.frame, 4);
    assert.deepEqual(released.resources, []);
    assert.deepEqual(released.pixel, [51, 68, 85, 255], "release removes the previous decoded source and late bytes stay ignored");
    assert.deepEqual(released.errors, [], "release aborts the pending request without reporting a stale failure");
    await page.evaluate(() => (window as any).PocketEditorPreviewInstance.close());
  } finally {
    await browser.close();
    await server.stop(true);
  }
});

test("HTTP 404 arriving ahead of SSE releasedResources frame neither emits preview.error nor drops active pointer contacts", { timeout: 30_000 }, async () => {
  const project = "external-404-race";
  const retiredAsset = "assets/looseleaf/viz/avatar_guoguo.png";
  const brokenAsset = "assets/looseleaf/viz/genuinely_missing.png";
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamConnections = 0;
  let markStreamReady!: () => void;
  const streamReady = new Promise<void>((resolve) => { markStreamReady = resolve; });
  let markResource404Sent!: () => void;
  const resource404Sent = new Promise<void>((resolve) => { markResource404Sent = resolve; });
  const pointerInputs: Array<Record<string, unknown>> = [];

  const descriptorFor = (asset: string) => ({
    asset,
    revision: 1,
    width: 1,
    height: 1,
    psm: 3,
    linear: false,
    bytesEncoding: "external",
    pixelsUrl: `/api/projects/${encodeURIComponent(project)}/preview/resource?asset=${encodeURIComponent(asset)}&revision=rev-1&scope=scope-a&part=pixels`,
    pixelsBytes: 4,
  });

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/stream")) {
        streamConnections += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            markStreamReady();
          },
        }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }
      if (url.pathname.endsWith("/resource")) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (url.searchParams.get("asset") === retiredAsset) markResource404Sent();
        return new Response("resource not found", {
          status: 404,
          headers: { "cache-control": "no-store" },
        });
      }
      if (url.pathname.endsWith("/input")) {
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        if (body.type === "pointer") pointerInputs.push(body);
        return Response.json({ ok: true });
      }
      return new Response(
        `<div data-pocket-preview data-project-id=${project}></div><script>${source.replaceAll("</script", "<\\/script")}</script>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 16, height: 16 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      window.addEventListener("message", (event) => {
        if (event.data?.source === "pocket-editor-preview" && event.data?.type === "preview.error") {
          ((window as any).__resourceErrors ||= []).push(event.data.error);
        }
      });
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance?.getFrame));
    await streamReady;

    // 1. Frame 1 references avatar_guoguo.png; user presses pointer down while fetch is queued.
    streamController!.enqueue(encodePreviewStreamPacket({
      type: "frame",
      frame: frame(1, [background(0xff102030), { type: "image", asset: retiredAsset, x: 0, y: 0, w: 4, h: 4 }], [descriptorFor(retiredAsset)]),
    }, true));
    await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance?.getFrame()?.frame === 1);
    await page.mouse.move(4, 4);
    await page.mouse.down();

    // HTTP /resource returns 404 BEFORE SSE delivers Frame 2 with releasedResources.
    await resource404Sent;
    await new Promise((resolve) => setTimeout(resolve, 60));
    streamController!.enqueue(encodePreviewStreamPacket({
      type: "frame",
      frame: frame(2, [background(0xff224466)], [], { releasedResources: [retiredAsset] }),
    }, true));
    await page.waitForFunction(() => (window as any).PocketEditorPreviewInstance?.getFrame()?.frame === 2);
    await page.mouse.up();
    await new Promise((resolve) => setTimeout(resolve, 120));

    const errorsAfterRelease = await page.evaluate(() => (window as any).__resourceErrors || []);
    assert.deepEqual(errorsAfterRelease, [], "retired texture 404 arriving before SSE release must not emit preview.error");
    assert.equal(streamConnections, 1, "retired texture 404 must not tear down and reconnect the SSE stream");
    assert.deepEqual(
      pointerInputs.map((entry) => entry.phase),
      ["down", "up"],
      "active pointer contact completes down->up cleanly without stream-loss cancellation",
    );

    // 2. Conversely, a persistent 404 on a still-referenced texture still self-heals after settle timeout.
    streamController!.enqueue(encodePreviewStreamPacket({
      type: "frame",
      frame: frame(3, [background(0xff224466), { type: "image", asset: brokenAsset, x: 0, y: 0, w: 4, h: 4 }], [descriptorFor(brokenAsset)]),
    }, true));
    await page.waitForFunction(() => ((window as any).__resourceErrors || []).length === 1, undefined, { timeout: 5_000 });
    const persistentErrors = await page.evaluate(() => (window as any).__resourceErrors || []);
    assert.equal(persistentErrors[0], `preview resource ${brokenAsset}: pixels fetch failed (404)`);
    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.ok(streamConnections >= 2, "genuinely broken still-referenced texture triggers SSE stream reconnect");

    await page.evaluate(() => (window as any).PocketEditorPreviewInstance.close());
  } finally {
    await browser.close();
    await server.stop(true);
  }
});
