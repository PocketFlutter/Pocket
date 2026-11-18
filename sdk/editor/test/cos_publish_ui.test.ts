import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { previewDevice } from "../preview_device.ts";

const clientRoot = resolve(import.meta.dir, "../client");
const html = readFileSync(join(clientRoot, "index.html"), "utf8");
const css = readFileSync(join(clientRoot, "editor.css"), "utf8");
const script = readFileSync(join(clientRoot, "editor.js"), "utf8");

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

test(
  "COS publish UI: detects ~/.cos.yaml, selects preset bucket, verifies connection, enables COS, publishes test version, and copies COS appConfigUrl with zero pageerrors",
  { timeout: 25_000 },
  async () => {
    let server: ReturnType<typeof Bun.serve> | undefined;
    const browser = await chromium.launch({ headless: true });

    const project = {
      id: "cos-ui-app",
      name: "COS UI App",
      appId: "pocket.cos.ui",
      version: "0.1.0",
    };

    const status = {
      revision: 3,
      builtRevision: 3,
      busy: false,
      logs: [],
      artifacts: { generation: "cos-ui-gen" },
      publish: {
        channel: "test",
        version: "0.1.0-test.1",
        build: 1,
        revision: 3,
        releaseId: "test-rel-1",
      },
    };

    let cosConfig = {
      enabled: false,
      syncOnPublish: false,
      bucket: "alpha-1250000001",
      region: "ap-guangzhou",
      keyPrefix: "",
      publicBaseUrl: "",
    };

    let cosPublished: Record<string, unknown> = {};
    const checkCalls: Array<Record<string, unknown>> = [];
    const putCosCalls: Array<Record<string, unknown>> = [];
    const publishCosCalls: Array<Record<string, unknown>> = [];

    const buildCosSnapshot = () => ({
      local: {
        available: true,
        source: "coscli",
        sourceDetail: "coscli (~/.cos.yaml)",
        maskedSecretId: "AKID****9876",
        hasSecurityToken: false,
        discoveredBuckets: [
          {
            bucket: "alpha-1250000001",
            region: "ap-guangzhou",
            alias: "alpha-dev",
          },
          {
            bucket: "beta-1250000002",
            region: "ap-shanghai",
            alias: "beta-prod",
          },
        ],
        defaultBucket: {
          bucket: "alpha-1250000001",
          region: "ap-guangzhou",
          alias: "alpha-dev",
        },
      },
      config: { ...cosConfig },
      published: { ...cosPublished },
    });

    try {
      server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const path = url.pathname;
          const method = request.method.toUpperCase();

          if (path === "/") {
            return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
          }
          if (path === "/editor.css") {
            return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
          }
          if (path === "/editor.js") {
            return new Response(script, {
              headers: { "content-type": "text/javascript; charset=utf-8" },
            });
          }
          if (path === "/api/preview/device") return json(previewDevice);
          if (path === "/health") {
            return json({
              ok: true,
              service: "pocket-editor",
              version: "0.1.0",
              csrfToken: "cos-ui-csrf",
              projectId: project.id,
              bluetooth: { local: false },
            });
          }
          if (path === "/api/studio/upgrade") {
            return json({
              currentVersion: "0.1.0",
              latestVersion: "0.1.0",
              status: "up-to-date",
              upgradeAvailable: false,
              autoUpgradeSupported: false,
            });
          }
          if (path === "/api/studio/upgrade/check" && method === "POST") {
            return json({
              currentVersion: "0.1.0",
              latestVersion: "0.1.0",
              status: "up-to-date",
              upgradeAvailable: false,
              autoUpgradeSupported: false,
            });
          }
          if (path === "/api/devices") return json([]);
          if (path === "/api/projects") return json([project]);

          const prefix = `/api/projects/${project.id}`;
          if (!path.startsWith(prefix)) {
            return new Response("not found", { status: 404 });
          }
          const tail = path.slice(prefix.length).replace(/^\/+/, "");

          if (tail === "config") {
            return json({
              ...project,
              title: project.name,
              framework: "solid",
              entry: "app.tsx",
              output: "app",
              build: 1,
              tickHz: 60,
              cos: cosConfig,
            });
          }
          if (tail === "files") return json({ files: [{ path: "app.tsx", bytes: 27 }] });
          if (tail === "files/app.tsx") {
            return json({ path: "app.tsx", content: "export default () => null;", bytes: 27 });
          }
          if (tail === "status") return json(status);
          if (tail === "resources") return json({ revision: 3, builtRevision: 3, packages: [] });
          if (tail === "publish-targets") {
            return json({
              currentProjectId: project.id,
              channel: "test",
              targets: [
                {
                  projectId: project.id,
                  appId: project.appId,
                  title: project.name,
                  kind: "root",
                  version: "0.1.0",
                  build: 1,
                  revision: 3,
                  builtRevision: 3,
                  built: true,
                  busy: false,
                  canSelect: true,
                  canPublish: true,
                },
              ],
            });
          }
          if (tail === "versions") {
            const lanOrigin = "http://192.168.50.10:8791";
            return json({
              origin: lanOrigin,
              hostVersion: "0.1.0",
              lan: true,
              appConfigUrl: `${lanOrigin}/test/pocket/0.1.0/${project.appId}/latest.json`,
              current: { test: "test-rel-1" },
              slots: [
                {
                  name: "test",
                  releaseId: "test-rel-1",
                  version: "0.1.0-test.1",
                  build: 1,
                  archiveUrl: `/releases/${project.id}/test-rel-1.tar.gz`,
                  packages: [
                    {
                      id: project.appId,
                      version: "0.1.0-test.1",
                      build: 1,
                      manifestUrl: `${lanOrigin}/test/pocket/0.1.0/${project.appId}/0.1.0/latest.json`,
                      hostConfigUrl: `${lanOrigin}/test/pocket/0.1.0/${project.appId}/0.1.0/host.json`,
                    },
                  ],
                },
                {
                  name: "stable",
                  releaseId: null,
                  packages: [],
                },
              ],
              history: [
                {
                  id: "test-rel-1",
                  releaseId: "test-rel-1",
                  slot: "test",
                  channel: "test",
                  version: "0.1.0-test.1",
                  build: 1,
                  revision: 3,
                  hostVersion: "0.1.0",
                  packageVersion: "test-rel-1",
                  publishedAt: "2026-11-16T08:00:00.000Z",
                  archiveUrl: `/releases/${project.id}/test-rel-1.tar.gz`,
                  appConfigUrl: `${lanOrigin}/pocket/0.1.0/${project.appId}/test-rel-1/host.json`,
                  packages: [
                    {
                      id: project.appId,
                      version: "0.1.0-test.1",
                      build: 1,
                      updateUrl: `${lanOrigin}/pocket/0.1.0/${project.appId}/test-rel-1/latest.json`,
                      manifestUrl: `${lanOrigin}/pocket/0.1.0/${project.appId}/test-rel-1/latest.json`,
                      hostConfigUrl: `${lanOrigin}/pocket/0.1.0/${project.appId}/test-rel-1/host.json`,
                    },
                  ],
                },
              ],
              cos: buildCosSnapshot(),
            });
          }
          if (tail === "cos" && method === "GET") {
            return json(buildCosSnapshot());
          }
          if (tail === "cos" && method === "PUT") {
            const body = (await request.json()) as Record<string, any>;
            putCosCalls.push(body);
            cosConfig = {
              enabled: body.enabled !== undefined ? Boolean(body.enabled) : cosConfig.enabled,
              syncOnPublish:
                body.syncOnPublish !== undefined
                  ? Boolean(body.syncOnPublish)
                  : cosConfig.syncOnPublish,
              bucket: typeof body.bucket === "string" ? body.bucket : cosConfig.bucket,
              region: typeof body.region === "string" ? body.region : cosConfig.region,
              keyPrefix:
                typeof body.keyPrefix === "string" ? body.keyPrefix : cosConfig.keyPrefix,
              publicBaseUrl:
                typeof body.publicBaseUrl === "string"
                  ? body.publicBaseUrl
                  : cosConfig.publicBaseUrl,
            };
            return json(buildCosSnapshot());
          }
          if (tail === "cos/check" && method === "POST") {
            const body = (await request.json()) as Record<string, any>;
            checkCalls.push(body);
            return json({
              ok: true,
              bucket: body.bucket || cosConfig.bucket,
              region: body.region || cosConfig.region,
              keyPrefix: body.keyPrefix || cosConfig.keyPrefix,
              publicBaseUrl:
                body.publicBaseUrl ||
                `https://${body.bucket || cosConfig.bucket}.cos.${body.region || cosConfig.region}.myqcloud.com`,
              source: "coscli",
              sourceDetail: "coscli (~/.cos.yaml)",
              maskedSecretId: "AKID****9876",
              checkedAt: new Date().toISOString(),
            });
          }
          if (tail === "cos/publish" && method === "POST") {
            const body = (await request.json()) as Record<string, any>;
            publishCosCalls.push(body);
            const prefixPart = cosConfig.keyPrefix ? `/${cosConfig.keyPrefix}` : "";
            const summary = {
              appConfigUrl: `https://${cosConfig.bucket}.cos.${cosConfig.region}.myqcloud.com${prefixPart}/test/pocket/0.1.0/${project.appId}/latest.json`,
              hostConfigUrl: `https://${cosConfig.bucket}.cos.${cosConfig.region}.myqcloud.com${prefixPart}/pocket/0.1.0/${project.appId}/test-rel-1/host.json`,
              bucket: cosConfig.bucket,
              region: cosConfig.region,
              keyPrefix: cosConfig.keyPrefix,
              publicBaseUrl: `https://${cosConfig.bucket}.cos.${cosConfig.region}.myqcloud.com${prefixPart}`,
              slot: "test",
              channel: "test",
              releaseId: "test-rel-1",
              version: "0.1.0-test.1",
              build: 1,
              uploadedFiles: 5,
              skippedFiles: 2,
              uploadedBytes: 18432,
              skippedBytes: 4096,
              publishedAt: "2026-11-16T08:05:00.000Z",
            };
            cosPublished = { ...cosPublished, test: summary };
            return json({
              ok: true,
              cosPublish: summary,
              status,
              cos: buildCosSnapshot(),
            });
          }
          if (tail === "preview") {
            return new Response(
              "<!doctype html><script>parent.postMessage({source:'pocket-editor-preview',type:'preview.ready'}, location.origin); parent.postMessage({source:'pocket-editor-preview',type:'preview.frame'}, location.origin);</script>",
              { headers: { "content-type": "text/html; charset=utf-8" } },
            );
          }
          if (tail === "wechat") return json({ state: "idle", logs: [] });
          if (tail === "deploy") return json({ jobs: [] });
          return new Response("not found", { status: 404 });
        },
      });

      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (value: string) => {
              (window as unknown as { __copiedUrl?: string }).__copiedUrl = value;
            },
          },
        });
      });

      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.locator("#versions-open").waitFor({ state: "attached" });
      await page.locator("#versions-open").click();

      await page.waitForFunction(
        () => document.getElementById("version-cos-badge")?.textContent === "已检测到",
      );
      expect(await page.locator("#version-cos-source").textContent()).toContain("AKID****9876");
      expect(await page.locator("#version-cos-panel").textContent()).not.toContain("SECRET");

      // Open COS settings and select preset bucket beta-1250000002@ap-shanghai
      await page.locator("#cos-toggle-settings").click();
      expect(await page.locator("#version-cos-settings").isHidden()).toBe(false);
      expect(await page.locator("#cos-bucket-preset-row").isHidden()).toBe(false);

      await page.locator("#cos-bucket-preset").selectOption("beta-1250000002@ap-shanghai");
      expect(await page.locator("#cos-bucket").inputValue()).toBe("beta-1250000002");
      expect(await page.locator("#cos-region").inputValue()).toBe("ap-shanghai");

      await page.locator("#cos-prefix").fill("apps/demo-cos");

      // Click verify connection
      await page.locator("#cos-check-connection").click();
      await page.waitForFunction(() =>
        document.getElementById("notice-message")?.textContent?.includes("连接验证成功"),
      );
      expect(checkCalls).toHaveLength(1);
      expect(checkCalls[0]).toEqual({
        bucket: "beta-1250000002",
        region: "ap-shanghai",
        keyPrefix: "apps/demo-cos",
        publicBaseUrl: "",
      });

      // Toggle #cos-enabled ON
      await page.locator("#cos-enabled").check();
      await page.waitForFunction(
        () => document.getElementById("version-cos-badge")?.textContent === "已开启",
      );
      expect(putCosCalls).toHaveLength(1);
      expect(putCosCalls[0]?.enabled).toBe(true);
      expect(putCosCalls[0]?.bucket).toBe("beta-1250000002");
      expect(putCosCalls[0]?.region).toBe("ap-shanghai");
      expect(putCosCalls[0]?.keyPrefix).toBe("apps/demo-cos");
      expect(await page.locator("#version-cos-active").isHidden()).toBe(false);
      expect(await page.locator("#cos-publish-test").isDisabled()).toBe(false);

      // Click #cos-publish-test
      await page.locator("#cos-publish-test").click();
      const expectedCosUrl =
        "https://beta-1250000002.cos.ap-shanghai.myqcloud.com/apps/demo-cos/test/pocket/0.1.0/pocket.cos.ui/latest.json";
      await page.waitForFunction(
        (url) => document.getElementById("version-cos-app-config-link")?.getAttribute("href") === url,
        expectedCosUrl,
      );
      expect(publishCosCalls).toEqual([{ channel: "test" }]);
      expect(await page.locator("#version-cos-app-config").isHidden()).toBe(false);
      expect(await page.locator("#version-cos-publish-meta").textContent()).toContain(
        "上传 5 个文件 / 复用 2 个文件",
      );

      // Copy COS URL
      await page.locator("#version-cos-app-config-copy").click();
      await page.waitForFunction(
        (url) => (window as unknown as { __copiedUrl?: string }).__copiedUrl === url,
        expectedCosUrl,
      );
      expect(await page.locator("#version-cos-app-config-copy").textContent()).toBe("已复制");

      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
      server?.stop(true);
    }
  },
);
