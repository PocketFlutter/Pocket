import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { join } from "node:path";

test("optional VN example waits for explicit consent and missing SDK input", { timeout: 20_000 }, async () => {
  const clientRoot = join(import.meta.dir, "../client");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health") return Response.json({ csrfToken: "test-nonce" });
      if (path === "/api/projects") return Response.json([]);
      if (path === "/api/devices") return Response.json({ devices: [] });
      if (path === "/api/studio/upgrade/check") return Response.json({ status: "up-to-date" });
      if (path === "/api/preview/device") return Response.json({
        model: "Test device", screenWidth: 375, screenHeight: 812, pixelRatio: 3,
        statusBarHeight: 44, safeAreaBottom: 34,
        safeArea: { top: 44, right: 0, bottom: 34, left: 0 },
        shell: {
          bezel: 8, borderRadius: 42, notchWidth: 200, notchHeight: 30,
          homeIndicatorWidth: 140, homeIndicatorHeight: 5, homeIndicatorBottom: 7,
        },
      });
      if (/^\/(?:editor\.css|editor\.js)?$/.test(path)) {
        return new Response(Bun.file(join(clientRoot, path.slice(1) || "index.html")));
      }
      return new Response(null, { status: 404 });
    },
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const requests: Array<{ acceptCubismTerms: boolean; cubismSdkDirectory?: string }> = [];
    let failInstall = true;
    const sdkDirectory = "/tmp/official-cubism-sdk";
    const licenseUrl = "https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html";
    await page.route("**/api/examples/lantern", async route => {
      if (route.request().method() === "GET") {
        return route.fulfill({ json: {
          available: true, title: "雾港末班信", core: "missing",
          missing: ["Cubism Web Core", "Hiyori"], modelSourceRequired: true,
          consentRequired: true, licenses: [{ title: "Cubism 软件许可", url: licenseUrl }],
        } });
      }
      requests.push(route.request().postDataJSON());
      expect(await route.request().headerValue("x-pocket-csrf")).toBe("test-nonce");
      return route.fulfill(failInstall
        ? { status: 422, json: { error: "模型校验失败" } }
        : { status: 201, json: { id: "lantern" } });
    });
    await page.route("**/api/projects/pick-directory", route => route.fulfill({ json: { path: sdkDirectory } }));

    await Promise.all([page.waitForResponse("**/api/projects"), page.goto(server.url.href)]);
    const launcher = page.getByRole("button", { name: "示例项目" });
    const dialog = page.getByRole("dialog", { name: "雾港末班信" });
    const submit = dialog.getByRole("button", { name: "安装并打开" });
    const consent = dialog.getByRole("checkbox");
    await launcher.click();
    await dialog.getByRole("link", { name: "Cubism 软件许可" }).waitFor();
    expect(await dialog.getByRole("link", { name: "Cubism 软件许可" }).getAttribute("href")).toBe(licenseUrl);
    expect(await dialog.getByText("Hiyori", { exact: true }).isVisible()).toBe(true);
    expect(await submit.isDisabled()).toBe(true);
    await dialog.getByRole("button", { name: "选择 SDK 目录…" }).click();
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[name="cubismSdkDirectory"]')?.value === "/tmp/official-cubism-sdk");
    expect(await submit.isDisabled()).toBe(true);
    await dialog.getByRole("button", { name: "取消" }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(requests).toEqual([]);

    await launcher.click();
    await consent.check();
    expect(await submit.isDisabled()).toBe(true);
    await dialog.getByRole("textbox", { name: "Cubism SDK 目录" }).fill(sdkDirectory);
    await submit.click();
    await dialog.getByRole("alert").waitFor();
    expect(await dialog.getByRole("alert").textContent()).toBe("模型校验失败");
    expect(requests).toEqual([{ acceptCubismTerms: true, cubismSdkDirectory: sdkDirectory }]);
    failInstall = false;
    await submit.click();
    await dialog.waitFor({ state: "hidden" });
    expect(requests).toHaveLength(2);
  } finally {
    await browser.close();
    server.stop(true);
  }
});
