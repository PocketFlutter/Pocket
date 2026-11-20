import { expect, test } from "bun:test";
import { join } from "node:path";
import { chromium } from "playwright";

test("Studio defaults to Direct Web for eligible previews and remembers an explicit opt-out", { timeout: 20_000 }, async () => {
  const clientRoot = join(import.meta.dir, "../client");
  const projectPath = "/api/projects/live2d";
  const previewPath = projectPath + "/preview";
  const preferenceKey = "pocket.editor.directWebPreview.live2d";
  let available = true;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health") return Response.json({ csrfToken: "test-nonce" });
      if (path === "/api/projects") return Response.json([{ id: "live2d", name: "Live2D preview" }]);
      if (path === "/api/devices") return Response.json({ devices: [] });
      if (path === "/api/studio/upgrade/check") return Response.json({ status: "up-to-date" });
      if (path === "/api/preview/device") return Response.json({
        model: "Test device", screenWidth: 375, screenHeight: 812, pixelRatio: 3,
        statusBarHeight: 44, safeAreaBottom: 34,
        profiles: [{
          id: "iphone-16-pro", label: "Simulated iPhone", kind: "device",
          group: "apple-device", width: 402, height: 874,
          safeArea: { top: 62, right: 0, bottom: 34, left: 0 },
        }],
        safeArea: { top: 44, right: 0, bottom: 34, left: 0 },
        shell: {
          bezel: 8, borderRadius: 42, notchWidth: 200, notchHeight: 30,
          homeIndicatorWidth: 140, homeIndicatorHeight: 5, homeIndicatorBottom: 7,
        },
      });
      if (path === projectPath + "/config") return Response.json({ entry: "app.tsx", ecosystemModules: ["apple-devices"] });
      if (path === projectPath + "/files") return Response.json({ files: ["app.tsx"] });
      if (path === projectPath + "/files/app.tsx") return Response.json({ path: "app.tsx", content: "" });
      if (path === projectPath + "/status") return Response.json({ revision: 1, builtRevision: 1 });
      if (path === previewPath + "/gpu/status") return Response.json({ available });
      if (path === previewPath + "/gpu/" || path === previewPath) {
        const nativeProbe = path === previewPath ? `<script>
          addEventListener("message", event => {
            if (event.data.type === "preview.resize" && event.data.openUri) {
              document.body.textContent = event.data.openUri;
            }
          });
          parent.postMessage({ type: "preview.ready" }, location.origin);
        </script>` : "";
        return new Response(`<!doctype html><body>${nativeProbe}</body>`, { headers: { "Content-Type": "text/html" } });
      }
      if (/^\/(?:[a-z-]+\.(?:css|js))?$/.test(path)) {
        return new Response(Bun.file(join(clientRoot, path.slice(1) || "index.html")));
      }
      return new Response(null, { status: 404 });
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const frame = page.locator("#preview-frame");
    const toggle = page.locator("#preview-gpu-toggle");
    const viewport = page.locator("#viewport-picker");
    async function expectRenderer(gpu: boolean) {
      await page.waitForFunction(expected => {
        const src = document.querySelector<HTMLIFrameElement>("#preview-frame")?.src;
        return src && new URL(src).pathname === expected;
      }, previewPath + (gpu ? "/gpu/" : ""));
      expect(await toggle.getAttribute("aria-pressed")).toBe(String(gpu));
    }

    await page.goto(server.url.href);
    await expectRenderer(true);
    expect(await page.evaluate(key => localStorage.getItem(key), preferenceKey)).toBeNull();
    await toggle.click();
    await expectRenderer(false);
    expect(await page.evaluate(key => localStorage.getItem(key), preferenceKey)).toBe("0");
    await page.reload();
    await expectRenderer(false);
    await toggle.click();
    await expectRenderer(true);
    expect(await page.evaluate(key => localStorage.getItem(key), preferenceKey)).toBe("1");

    await viewport.selectOption("iphone-16-pro");
    await expectRenderer(false);
    expect(await toggle.isDisabled()).toBe(true);
    await viewport.selectOption("mobile");
    await expectRenderer(true);

    const deepLink = new URL(server.url);
    deepLink.searchParams.set("uri", "pocket://chapter/2");
    await page.goto(deepLink.href);
    await expectRenderer(false);
    await frame.contentFrame().getByText("pocket://chapter/2").waitFor();
    available = false;
    await page.goto(server.url.href);
    await expectRenderer(false);
    expect(await toggle.isHidden()).toBe(true);
    expect(await frame.isVisible()).toBe(true);
  } finally {
    await browser.close();
    server.stop(true);
  }
});
