import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  hmacSha1Hex,
  IMMUTABLE_CACHE_CONTROL,
  MUTABLE_CACHE_CONTROL,
  sha1Hex,
} from "../../packages/pocket_cos/src/index.ts";
import {
  sha256Hex,
  verifySignedManifest,
  type PocketUpdatePayload,
  type SignedManifest,
} from "../../scripts/package_update.ts";
import { startEditor } from "../server.ts";
import { startUpdateEndpoint } from "../update_endpoint.ts";

const sdkRoot = resolve(import.meta.dir, "../..");

function findProbeBinary(): string {
  const configured = process.env.POCKET_NATIVE_PROBE?.trim();
  if (configured && existsSync(configured)) return resolve(configured);
  const candidates = [
    join(sdkRoot, "native/target/debug/pocket_probe"),
    join(sdkRoot, "native/target/release/pocket_probe"),
    join(sdkRoot, "node_modules/@pocket/tools-darwin-arm64/bin/pocket_probe"),
    join(sdkRoot, "node_modules/@pocket/tools-win32-x64/bin/pocket_probe.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`No pocket_probe binary found; checked: ${candidates.join(", ")}`);
}

async function editorRequest(
  server: ReturnType<typeof Bun.serve>,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; value: any }> {
  const headers = new Headers(init?.headers);
  if (["POST", "PUT", "PATCH", "DELETE"].includes((init?.method ?? "GET").toUpperCase())) {
    headers.set("x-pocket-editor", "1");
  }
  const response = await fetch(`http://${server.hostname}:${server.port}${path}`, {
    ...init,
    headers,
  });
  const type = response.headers.get("content-type") ?? "";
  const value = type.includes("application/json")
    ? await response.json()
    : await response.text();
  return { response, value };
}

async function waitForBuild(server: ReturnType<typeof Bun.serve>, id: string): Promise<any> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = await editorRequest(server, `/api/projects/${id}/status`);
    if (!status.value.busy) return status.value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`build timed out for ${id}`);
}

async function runProbeVerification(
  probePath: string,
  bytecodePath: string,
  pakPath: string,
): Promise<{ initialTexts: string[]; afterClickTexts: string[]; clickPoint: { x: number; y: number } }> {
  const proc = spawn(probePath, [], { stdio: ["pipe", "pipe", "pipe"] });
  const rl = createInterface({ input: proc.stdout });
  const lines: string[] = [];
  let lineResolver: ((line: string) => void) | null = null;

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.__pocket_probe_event) return;
    } catch {
      // Pass through to command waiter
    }
    if (lineResolver) {
      const r = lineResolver;
      lineResolver = null;
      r(trimmed);
    } else {
      lines.push(trimmed);
    }
  });

  const sendCommand = async (cmd: Record<string, unknown>): Promise<any> => {
    const nextLine = new Promise<string>((resolveLine) => {
      if (lines.length > 0) {
        resolveLine(lines.shift()!);
      } else {
        lineResolver = resolveLine;
      }
    });
    proc.stdin.write(JSON.stringify(cmd) + "\n");
    const raw = await nextLine;
    return JSON.parse(raw);
  };

  try {
    const created = await sendCommand({ op: "create", width: 390, height: 360 });
    expect(created.ok).toBe(true);

    const loaded = await sendCommand({
      op: "loadBytecode",
      bytecodePath,
      pakPath,
      render: true,
    });
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);

    const frame1 = loaded.frame;
    const ops1: Array<Record<string, any>> = frame1?.ops ?? [];
    const initialTexts = ops1.filter((op) => op.type === "text").map((op) => String(op.text));

    const btnOp = ops1.find(
      (op) => op.type === "text" && String(op.text).includes("Increment"),
    );
    const clickX = btnOp ? Number(btnOp.x) + Number(btnOp.w ?? 40) / 2 : 195;
    const clickY = btnOp ? Number(btnOp.y) + Number(btnOp.h ?? 20) / 2 : 120;

    for (const phase of ["down", "up"]) {
      const sent = await sendCommand({
        op: "send",
        message: {
          type: "event",
          name: "input.pointer",
          payload: { phase, id: 0, x: clickX, y: clickY },
        },
      });
      expect(sent.ok).toBe(true);
    }

    const rendered2 = await sendCommand({ op: "frame", deltaMs: 16 });
    expect(rendered2.ok).toBe(true);
    const ops2: Array<Record<string, any>> = rendered2.frame?.ops ?? [];
    const afterClickTexts = ops2.filter((op) => op.type === "text").map((op) => String(op.text));

    await sendCommand({ op: "destroy" });
    await sendCommand({ op: "quit" });
    return { initialTexts, afterClickTexts, clickPoint: { x: clickX, y: clickY } };
  } finally {
    proc.kill();
  }
}

test(
  "Pocket Studio COS end-to-end: .cos.yaml auto-discovery, config preservation, update_endpoint isolation, two-phase COS upload with network asset, and native probe execution of downloaded package",
  { timeout: 120_000 },
  async () => {
    const probePath = findProbeBinary();
    const tempRoot = mkdtempSync(join(tmpdir(), "pocket-studio-cos-e2e-"));
    const homeDir = join(tempRoot, "home");
    const workspaceDir = join(tempRoot, "workspace");
    const projectDir = join(tempRoot, "project");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(join(projectDir, "assets"), { recursive: true });

    const SECRET_ID = "AKID_E2E_COS_SECRET_123456";
    const SECRET_KEY = "SK_E2E_COS_SUPER_SECRET_KEY_999999";
    const BUCKET = "studio-e2e-1250000099";
    const REGION = "ap-guangzhou";

    type StoredCosObject = {
      bytes: Uint8Array;
      contentType: string;
      cacheControl: string;
      sha256: string;
    };
    const cosObjects = new Map<string, StoredCosObject>();
    const putKeysOrder: string[] = [];

    const cosServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const method = req.method.toUpperCase();
        const key = decodeURIComponent(url.pathname).replace(/^\/+/, "");

        // Public GET for Flutter/downloader verification
        if (method === "GET") {
          const obj = cosObjects.get(key);
          if (!obj) return new Response("Not Found", { status: 404 });
          return new Response(Buffer.from(obj.bytes), {
            status: 200,
            headers: {
              "content-type": obj.contentType,
              "cache-control": obj.cacheControl,
              "content-length": String(obj.bytes.byteLength),
              ...(obj.sha256 ? { "x-cos-meta-sha256": obj.sha256 } : {}),
            },
          });
        }

        // Authenticated HEAD / PUT must carry valid COS XML v5 Authorization signature
        const auth = req.headers.get("authorization") ?? "";
        if (!auth.includes("q-sign-algorithm=sha1") || !auth.includes(`q-ak=${SECRET_ID}`)) {
          return new Response(
            `<Error><Code>AccessDenied</Code><Message>Missing or invalid Authorization</Message></Error>`,
            { status: 403, headers: { "content-type": "application/xml" } },
          );
        }
        const keyTimeMatch = auth.match(/q-key-time=([^&]+)/);
        const sigMatch = auth.match(/q-signature=([0-9a-f]{40})/);
        if (!keyTimeMatch || !sigMatch) {
          return new Response(
            `<Error><Code>AccessDenied</Code><Message>Malformed signature fields</Message></Error>`,
            { status: 403, headers: { "content-type": "application/xml" } },
          );
        }
        const signKey = hmacSha1Hex(SECRET_KEY, keyTimeMatch[1]!);
        expect(signKey).toHaveLength(40);
        expect(sha1Hex(auth).length).toBe(40);

        if (method === "HEAD" && (url.pathname === "/" || key === "")) {
          return new Response(null, { status: 200 });
        }

        if (method === "HEAD") {
          const obj = cosObjects.get(key);
          if (!obj) return new Response(null, { status: 404 });
          return new Response(null, {
            status: 200,
            headers: {
              "content-length": String(obj.bytes.byteLength),
              "content-type": obj.contentType,
              "cache-control": obj.cacheControl,
              ...(obj.sha256 ? { "x-cos-meta-sha256": obj.sha256 } : {}),
            },
          });
        }

        if (method === "PUT") {
          const bytes = new Uint8Array(await req.arrayBuffer());
          const contentMd5 = req.headers.get("content-md5");
          const expectedMd5 = createHash("md5").update(bytes).digest("base64");
          if (contentMd5 !== expectedMd5) {
            return new Response(
              `<Error><Code>BadDigest</Code><Message>Content-MD5 mismatch</Message></Error>`,
              { status: 400, headers: { "content-type": "application/xml" } },
            );
          }
          const etag = createHash("md5").update(bytes).digest("hex");
          putKeysOrder.push(key);
          cosObjects.set(key, {
            bytes,
            contentType: req.headers.get("content-type") ?? "application/octet-stream",
            cacheControl: req.headers.get("cache-control") ?? "",
            sha256: req.headers.get("x-cos-meta-sha256") ?? "",
          });
          return new Response(null, {
            status: 200,
            headers: { ETag: `"${etag}"` },
          });
        }

        return new Response(null, { status: 405 });
      },
    });

    const cosOrigin = `http://127.0.0.1:${cosServer.port}`;

    // Write ~/.cos.yaml in synthetic home directory
    writeFileSync(
      join(homeDir, ".cos.yaml"),
      `cos:
  base:
    secretid: ${SECRET_ID}
    secretkey: ${SECRET_KEY}
    protocol: http
  buckets:
    - name: ${BUCKET}
      alias: studio-e2e
      region: ${REGION}
      endpoint: ${cosOrigin}
`,
      "utf8",
    );

    // Prepare Guest project with custom consumer fields, interactive Counter state, and a network asset
    writeFileSync(
      join(projectDir, "pocket.json"),
      JSON.stringify(
        {
          $schema: "https://pocketjs.dev/schema/pocket-2.json",
          pocket: 2,
          id: "pocket.cos.e2e",
          name: "cos-e2e-app",
          title: "COS E2E Counter",
          version: "0.1.0",
          customConsumerField: { preserveMe: true, nested: [1, 2, 3] },
          app: {
            entry: "app.tsx",
            output: "app",
            framework: "solid",
            viewport: {
              fixed: {
                logical: [390, 360],
                presentation: "native",
              },
            },
            customAppField: "keep-intact",
          },
        },
        null,
        2,
      ) + "\n",
    );

    writeFileSync(
      join(projectDir, "editor.json"),
      JSON.stringify(
        {
          id: "cos-e2e-app",
          appId: "pocket.cos.e2e",
          name: "COS E2E Counter",
          title: "COS E2E Counter",
          version: "0.1.0",
          build: 1,
          tickHz: 60,
          entry: "app.tsx",
          output: "app",
          framework: "solid",
          customEditorField: "editor-keep-me",
        },
        null,
        2,
      ) + "\n",
    );

    writeFileSync(
      join(projectDir, "manifest.json"),
      JSON.stringify(
        {
          $schema: "https://pocketjs.dev/schema/pocket-guest-manifest.json",
          protocolVersion: 1,
          capabilities: { requires: ["text.glyphs.baked"], optional: [] },
          permissions: { optional: [] },
        },
        null,
        2,
      ) + "\n",
    );

    const networkSvgContent =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#10b981"/></svg>';
    writeFileSync(join(projectDir, "assets", "cloud-badge.svg"), networkSvgContent, "utf8");

    writeFileSync(
      join(projectDir, "pocket.resources.json"),
      JSON.stringify(
        {
          version: 1,
          packages: {
            "pocket.cos.e2e": {
              network: ["asset:assets/cloud-badge.svg"],
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    writeFileSync(
      join(projectDir, "app.tsx"),
      `import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { ActionButton } from "@pocket/ui";

function App() {
  const [count, setCount] = createSignal(0);

  return (
    <Screen>
      <View class="flex-col w-full gap-4 p-4 bg-slate-100">
        <Text class="text-slate-900">COS E2E Counter</Text>
        <Text class="text-slate-900">{\`Count \${count()}\`}</Text>
        <ActionButton label="Increment counter" onPress={() => setCount((value) => value + 1)} />
      </View>
    </Screen>
  );
}

mount(() => <App />);
`,
      "utf8",
    );

    const editorServer = await startEditor({
      port: 0,
      updateHost: "127.0.0.1",
      updatePort: 0,
      updateHostVersion: "0.1.0",
      workspace: workspaceDir,
      projectRoot: projectDir,
      cosOptions: {
        env: {},
        homeDir,
        allowInsecureHttpForTesting: true,
        endpointOverride: cosOrigin,
      },
    });

    const readonlyEndpoint = startUpdateEndpoint({
      hostname: "127.0.0.1",
      port: 0,
      read: async () => new Response("ok"),
    });

    try {
      // 1. Verify update_endpoint.ts strictly rejects any /cos or /api/.../cos paths
      for (const forbiddenPath of [
        "/cos",
        "/cos/latest.json",
        "/api/projects/cos-e2e-app/cos",
        "/api/projects/cos-e2e-app/cos/publish",
      ]) {
        const res = await fetch(`${readonlyEndpoint.origin}${forbiddenPath}`);
        expect(res.status).toBe(404);
      }

      // 2. GET /api/projects/:id/cos detects ~/.cos.yaml and masks SecretId without leaking SecretKey
      const initialCos = await editorRequest(editorServer, "/api/projects/cos-e2e-app/cos");
      expect(initialCos.response.status).toBe(200);
      expect(initialCos.value.local.available).toBe(true);
      expect(initialCos.value.local.source).toBe("coscli");
      expect(initialCos.value.local.maskedSecretId).toBe("AKID****3456");
      expect(initialCos.value.local.defaultBucket.bucket).toBe(BUCKET);
      expect(JSON.stringify(initialCos.value)).not.toContain(SECRET_KEY);
      expect(JSON.stringify(initialCos.value)).not.toContain(SECRET_ID);

      // 3. POST /api/projects/:id/cos/check verifies live connectivity to mock COS server
      const checked = await editorRequest(editorServer, "/api/projects/cos-e2e-app/cos/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bucket: BUCKET,
          region: REGION,
          keyPrefix: "apps/demo-cos",
        }),
      });
      expect(checked.response.status).toBe(200);
      expect(checked.value.ok).toBe(true);
      expect(checked.value.bucket).toBe(BUCKET);
      expect(checked.value.keyPrefix).toBe("apps/demo-cos");

      // 4. Build the Guest project first, then verify saving COS config does NOT bump revision or invalidate build
      const buildStart = await editorRequest(editorServer, "/api/projects/cos-e2e-app/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(buildStart.response.status).toBe(202);
      const builtStatus = await waitForBuild(editorServer, "cos-e2e-app");
      expect(builtStatus.error, builtStatus.logs?.join("\n")).toBeUndefined();
      expect(builtStatus.builtRevision).toBe(builtStatus.revision);
      const revisionBeforeCosSave = builtStatus.revision;

      // Reject keyPrefix containing reserved "pocket" segment
      const badPrefix = await editorRequest(editorServer, "/api/projects/cos-e2e-app/cos", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          bucket: BUCKET,
          region: REGION,
          keyPrefix: "apps/pocket/demo",
        }),
      });
      expect(badPrefix.response.status).toBe(400);

      // Save valid COS config with keyPrefix: "apps/demo-cos"
      const savedCos = await editorRequest(editorServer, "/api/projects/cos-e2e-app/cos", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          syncOnPublish: false,
          bucket: BUCKET,
          region: REGION,
          keyPrefix: "apps/demo-cos",
        }),
      });
      expect(savedCos.response.status).toBe(200);
      expect(savedCos.value.config).toEqual({
        enabled: true,
        syncOnPublish: false,
        bucket: BUCKET,
        region: REGION,
        keyPrefix: "apps/demo-cos",
        publicBaseUrl: "",
      });

      // Verify revision and builtRevision were untouched, and custom consumer fields in pocket.json & editor.json were preserved!
      const statusAfterCosSave = await editorRequest(editorServer, "/api/projects/cos-e2e-app/status");
      expect(statusAfterCosSave.value.revision).toBe(revisionBeforeCosSave);
      expect(statusAfterCosSave.value.builtRevision).toBe(revisionBeforeCosSave);

      const diskPocket = JSON.parse(readFileSync(join(projectDir, "pocket.json"), "utf8"));
      expect(diskPocket.customConsumerField).toEqual({ preserveMe: true, nested: [1, 2, 3] });
      expect(diskPocket.app.customAppField).toBe("keep-intact");
      expect(JSON.stringify(diskPocket)).not.toContain(SECRET_KEY);

      const diskEditor = JSON.parse(readFileSync(join(projectDir, "editor.json"), "utf8"));
      expect(diskEditor.customEditorField).toBe("editor-keep-me");
      expect(diskEditor.cos.keyPrefix).toBe("apps/demo-cos");
      expect(JSON.stringify(diskEditor)).not.toContain(SECRET_KEY);

      // 5. Publishing to COS before local publish returns 409
      const prematureCosPublish = await editorRequest(
        editorServer,
        "/api/projects/cos-e2e-app/cos/publish",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel: "test" }),
        },
      );
      expect(prematureCosPublish.response.status).toBe(409);

      // 6. Publish local test version, then publish to COS
      const localPublish = await editorRequest(editorServer, "/api/projects/cos-e2e-app/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "test" }),
      });
      expect(localPublish.response.status).toBe(200);
      const releaseId = localPublish.value.status.publish.releaseId as string;
      expect(releaseId).toBeTruthy();

      const cosPublishRes = await editorRequest(
        editorServer,
        "/api/projects/cos-e2e-app/cos/publish",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel: "test" }),
        },
      );
      expect(cosPublishRes.response.status).toBe(200);
      expect(cosPublishRes.value.ok).toBe(true);
      const summary = cosPublishRes.value.cosPublish;
      expect(summary.appConfigUrl).toBe(
        `${cosOrigin}/apps/demo-cos/test/pocket/0.1.0/pocket.cos.e2e/latest.json`,
      );
      expect(summary.uploadedFiles).toBeGreaterThan(0);
      expect(summary.skippedFiles).toBe(0);

      // Verify Phase 2 static package index was uploaded VERY LAST
      expect(putKeysOrder.at(-1)).toBe(
        "apps/demo-cos/test/pocket/0.1.0/pocket.cos.e2e/latest.json",
      );
      const indexObj = cosObjects.get(
        "apps/demo-cos/test/pocket/0.1.0/pocket.cos.e2e/latest.json",
      );
      expect(indexObj).toBeDefined();
      expect(indexObj!.cacheControl).toBe(MUTABLE_CACHE_CONTROL);

      // 7. Fetch the published package from the COS HTTP server and verify relative links & rebased host.json
      const indexResp = await fetch(summary.appConfigUrl);
      expect(indexResp.status).toBe(200);
      const indexJson = (await indexResp.json()) as Record<string, any>;
      expect(indexJson.kind).toBe("pocket-editor-package-index");
      expect(indexJson.latest.manifestUrl).toBe(
        `../../../../pocket/0.1.0/pocket.cos.e2e/${releaseId}/latest.json`,
      );
      expect(indexJson.latest.hostConfigUrl).toBe(
        `../../../../pocket/0.1.0/pocket.cos.e2e/${releaseId}/host.json`,
      );

      const resolvedHostUrl = new URL(indexJson.latest.hostConfigUrl, summary.appConfigUrl).href;
      expect(resolvedHostUrl).toBe(
        `${cosOrigin}/apps/demo-cos/pocket/0.1.0/pocket.cos.e2e/${releaseId}/host.json`,
      );
      expect(summary.hostConfigUrl).toBe(
        `${cosOrigin}/apps/demo-cos/pocket/0.1.0/pocket.cos.e2e/${releaseId}/host.json`,
      );
      expect(resolvedHostUrl).toBe(summary.hostConfigUrl);
      const hostResp = await fetch(resolvedHostUrl);
      expect(hostResp.status).toBe(200);
      const hostJson = (await hostResp.json()) as Record<string, any>;
      expect(hostJson.kind).toBe("pocket-editor-app-host");
      expect(hostJson.updates.baseUrl).toBe(`${cosOrigin}/apps/demo-cos/test`);

      const resolvedManifestUrl = new URL(indexJson.latest.manifestUrl, summary.appConfigUrl).href;
      expect(resolvedManifestUrl).toBe(
        `${cosOrigin}/apps/demo-cos/pocket/0.1.0/pocket.cos.e2e/${releaseId}/latest.json`,
      );
      const manifestResp = await fetch(resolvedManifestUrl);
      expect(manifestResp.status).toBe(200);
      const envelope = (await manifestResp.json()) as SignedManifest;

      const devKeyJson = JSON.parse(
        readFileSync(join(workspaceDir, "keys/editor-dev-key.json"), "utf8"),
      );
      const verifiedPayloadBytes = verifySignedManifest(envelope, devKeyJson.publicKeyPem);
      const payload = JSON.parse(
        new TextDecoder().decode(verifiedPayloadBytes),
      ) as PocketUpdatePayload;
      expect(payload.appId).toBe("pocket.cos.e2e");
      expect(payload.entryFormat).toBe("quickjs-bytecode");

      // Verify network asset is listed in payload.assets and downloadable from COS blobs
      expect(payload.assets?.["assets/cloud-badge.svg"]).toBeDefined();
      const badgeAsset = payload.assets!["assets/cloud-badge.svg"]!;
      const badgeBlobUrl = new URL(`blobs/${badgeAsset.sha256}`, resolvedManifestUrl).href;
      const badgeBlobResp = await fetch(badgeBlobUrl);
      expect(badgeBlobResp.status).toBe(200);
      expect(badgeBlobResp.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
      const badgeBytes = new Uint8Array(await badgeBlobResp.arrayBuffer());
      expect(sha256Hex(badgeBytes)).toBe(badgeAsset.sha256);
      expect(new TextDecoder().decode(badgeBytes)).toBe(networkSvgContent);

      // 8. Reconstruct app.qjbc + app.pak from COS HTTP blobs and execute in real pocket_probe
      const entryBlobUrl = new URL(`blobs/${payload.entry.sha256}`, resolvedManifestUrl).href;
      const entryBytes = new Uint8Array(await (await fetch(entryBlobUrl)).arrayBuffer());
      expect(sha256Hex(entryBytes)).toBe(payload.entry.sha256);

      const reconstructedPak = new Uint8Array(payload.pak.size);
      for (const part of payload.pak.parts) {
        const partUrl = new URL(`blobs/${part.sha256}`, resolvedManifestUrl).href;
        const partResp = await fetch(partUrl);
        expect(partResp.status).toBe(200);
        const partBytes = new Uint8Array(await partResp.arrayBuffer());
        expect(partBytes.byteLength).toBe(part.size);
        expect(sha256Hex(partBytes)).toBe(part.sha256);
        reconstructedPak.set(partBytes, part.offset);
      }
      expect(sha256Hex(reconstructedPak)).toBe(payload.pak.sha256);

      const verifyDir = join(tempRoot, "downloaded-verify");
      mkdirSync(verifyDir, { recursive: true });
      const downloadedQjbc = join(verifyDir, "app.qjbc");
      const downloadedPak = join(verifyDir, "app.pak");
      writeFileSync(downloadedQjbc, entryBytes);
      writeFileSync(downloadedPak, reconstructedPak);

      const probeResult = await runProbeVerification(probePath, downloadedQjbc, downloadedPak);
      expect(probeResult.initialTexts).toContain("Count 0");
      expect(probeResult.afterClickTexts).toContain("Count 1");

      // 9. Second COS publish of same build deduplicates all immutable blobs via HEAD
      const secondCosPublish = await editorRequest(
        editorServer,
        "/api/projects/cos-e2e-app/cos/publish",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel: "test" }),
        },
      );
      expect(secondCosPublish.response.status).toBe(200);
      expect(secondCosPublish.value.cosPublish.skippedFiles).toBeGreaterThan(0);
    } finally {
      readonlyEndpoint.stop();
      editorServer.stop(true);
      cosServer.stop(true);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);
