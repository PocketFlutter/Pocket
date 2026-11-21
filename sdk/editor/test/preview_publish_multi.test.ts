import { expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREVIEW_APP_ID,
  previewSlotDirectory,
  previewTrust,
  publishPreview,
  publishPreviews,
  readPreviewSlot,
  type PreviewWorkspace,
} from "../preview_publish.ts";
import { packPak, verifySignedManifest } from "../../scripts/package_update.ts";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function makeFixture(): {
  root: string;
  workspace: PreviewWorkspace;
  buildDirectory: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "pocket-preview-multi-unit-"));
  const workspace: PreviewWorkspace = {
    updates: join(root, "updates"),
    states: join(root, "states"),
    keys: join(root, "keys"),
  };
  mkdirSync(workspace.updates, { recursive: true });
  mkdirSync(workspace.states, { recursive: true });
  mkdirSync(workspace.keys, { recursive: true });

  const buildDirectory = join(root, "build-out");
  mkdirSync(join(buildDirectory, "assets"), { recursive: true });
  writeFileSync(join(buildDirectory, "app.qjbc"), Buffer.from("QJSBC_SYNTHETIC_BYTECODE_PAYLOAD_0123456789"));
  writeFileSync(
    join(buildDirectory, "app.pak"),
    packPak([{ key: "ui:fonts.host", dtype: 1, data: new Uint8Array([1]) }]),
  );
  writeFileSync(join(buildDirectory, "assets", "hero.png"), Buffer.from("PNG_ASSET_BYTES"));
  writeFileSync(
    join(buildDirectory, "app.bytecode.json"),
    JSON.stringify(
      {
        runtimeAbi: "pocket-runtime-abi-unit-test",
        engineAbi: "pocket-engine-abi-unit-test",
        bindingGeneration: 1,
        tickHz: 60,
        version: "0.2.0",
        build: 3,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(buildDirectory, "guest-manifest.json"),
    JSON.stringify(
      {
        protocolVersion: 1,
        capabilities: {
          requires: ["text.layout.native"],
          optional: ["camera.capture"],
        },
        permissions: {
          requires: ["network.local"],
          optional: ["hardware.camera", "hardware.microphone"],
        },
        guest: {
          permissions: {
            requires: ["storage.app"],
            optional: ["hardware.bluetooth"],
          },
        },
      },
      null,
      2,
    ) + "\n",
  );

  return {
    root,
    workspace,
    buildDirectory,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function publicKeyPemFromBase64(publicKeyBase64: string): string {
  const raw = Buffer.from(publicKeyBase64, "base64");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  })
    .export({ type: "spki", format: "pem" })
    .toString();
}

test("publishPreviews stages shared blobs once, signs each slot independently, and strips only permissions.optional", async () => {
  const fx = makeFixture();
  try {
    const slotIds = [
      PREVIEW_APP_ID,
      "dev.pocket.studio.preview.web",
      "dev.pocket.studio.preview.wechat",
      "dev.pocket.studio.preview.widget",
      "dev.pocket.studio.preview.widget-alt",
    ];
    const batch = await publishPreviews({
      workspace: fx.workspace,
      projectId: "demo-multi",
      origin: "https://preview.pocket.local",
      hostVersion: "0.1.27",
      previewAppIds: slotIds,
      buildDirectory: fx.buildDirectory,
      revision: 7,
      generation: "gen-7",
      version: "0.2.0",
      build: 3,
    });

    expect(Object.keys(batch.slots)).toEqual(slotIds);
    expect(batch.primary.packageId).toBe(PREVIEW_APP_ID);

    const { key } = await previewTrust(fx.workspace);
    const pubPem = publicKeyPemFromBase64(key.publicKeyBase64);

    let referenceFilesJson = "";
    for (const slotId of slotIds) {
      const slotRes = batch.slots[slotId]!;
      expect(slotRes.packageId).toBe(slotId);
      expect(slotRes.build).toBe(4);
      expect(slotRes.version).toBe("0.2.0-preview.4");

      const slotDir = previewSlotDirectory(fx.workspace, "0.1.27", slotId);
      const envelope = JSON.parse(readFileSync(join(slotDir, "latest.json"), "utf8"));
      const verifiedBytes = verifySignedManifest(envelope, pubPem);
      const payload = JSON.parse(new TextDecoder().decode(verifiedBytes));
      expect(payload.appId).toBe(slotId);
      expect(payload.build).toBe(4);

      // Content-addressed blob descriptors match across all 5 slots:
      const filesJson = JSON.stringify(payload.files);
      if (!referenceFilesJson) referenceFilesJson = filesJson;
      expect(filesJson).toBe(referenceFilesJson);

      // Optional permissions stripped, required permissions preserved fail-closed:
      const stagedManifest = JSON.parse(readFileSync(join(slotDir, "bootstrap", "guest-manifest.json"), "utf8"));
      expect(stagedManifest.permissions.requires).toEqual(["network.local"]);
      expect(stagedManifest.permissions.optional).toEqual([]);
      expect(stagedManifest.guest.permissions.requires).toEqual(["storage.app"]);
      expect(stagedManifest.guest.permissions.optional).toEqual([]);
      expect(stagedManifest.capabilities.optional).toEqual(["camera.capture"]);

      // Served read-only via readPreviewSlot with origin rebasing on host.json:
      const hostResp = await readPreviewSlot(
        fx.workspace,
        `/preview/pocket/0.1.27/${encodeURIComponent(slotId)}/preview/host.json`,
        "https://lan.pocket.local:8787",
      );
      expect(hostResp.status).toBe(200);
      const hostDoc = await hostResp.json() as Record<string, unknown>;
      expect(hostDoc.appId).toBe(slotId);
      expect(String(hostDoc.POCKET_UPDATE_URL)).toBe(
        `https://lan.pocket.local:8787/preview/pocket/0.1.27/${encodeURIComponent(slotId)}/preview/latest.json`,
      );
    }

    // No leftover .staging-* directory:
    const previewRootEntries = readdirSync(join(fx.workspace.updates, ".preview"));
    expect(previewRootEntries.some((name) => name.startsWith(".staging-"))).toBe(false);
  } finally {
    fx.cleanup();
  }
});

test("publishPreviews rejects overlapping concurrent slot publishes with 409 without leaking non-overlapping slot locks", async () => {
  const fx = makeFixture();
  try {
    const baseInput = {
      workspace: fx.workspace,
      projectId: "demo-lock",
      origin: "https://preview.pocket.local",
      hostVersion: "0.1.27",
      buildDirectory: fx.buildDirectory,
      revision: 1,
      generation: "gen-1",
      version: "0.2.0",
      build: 1,
    };

    const first = publishPreviews({
      ...baseInput,
      previewAppIds: [PREVIEW_APP_ID, "dev.pocket.studio.preview.web"],
    });

    // Immediately launch a second batch sharing `.web` plus `.widget`: must reject synchronously before touching `.widget` lock!
    let caughtStatus: number | undefined;
    try {
      await publishPreviews({
        ...baseInput,
        previewAppIds: ["dev.pocket.studio.preview.widget", "dev.pocket.studio.preview.web"],
      });
    } catch (error) {
      caughtStatus = (error as { status?: number }).status;
    }
    expect(caughtStatus).toBe(409);

    // Non-overlapping `.widget` was NOT left locked and can publish concurrently right away!
    const independentWidget = await publishPreview({
      ...baseInput,
      previewAppId: "dev.pocket.studio.preview.widget",
    });
    expect(independentWidget.packageId).toBe("dev.pocket.studio.preview.widget");
    await first;
  } finally {
    fx.cleanup();
  }
});

test("publishPreviews self-heals corrupted preview-slots.json and payload.json while preserving the signed anti-downgrade floor", async () => {
  const fx = makeFixture();
  try {
    const baseInput = {
      workspace: fx.workspace,
      projectId: "demo-heal",
      origin: "https://preview.pocket.local",
      hostVersion: "0.1.27",
      buildDirectory: fx.buildDirectory,
      revision: 2,
      generation: "gen-2",
      version: "0.2.0",
      build: 3,
    };

    const r1 = await publishPreview(baseInput);
    const r2 = await publishPreview(baseInput);
    expect(r2.build).toBeGreaterThan(r1.build);

    // Corrupt BOTH preview-slots.json and the slot's payload.json on disk:
    const countersPath = join(fx.workspace.states, "preview-slots.json");
    const slotDir = previewSlotDirectory(fx.workspace, "0.1.27", PREVIEW_APP_ID);
    writeFileSync(countersPath, "{corrupt-counters-json");
    writeFileSync(join(slotDir, "payload.json"), "{corrupt-payload-json");
    expect(existsSync(join(slotDir, "latest.json"))).toBe(true);

    // Next publish succeeds without SyntaxError AND advances strictly above r2.build via signed latest.json!
    const r3 = await publishPreview(baseInput);
    expect(r3.build).toBe(r2.build + 1);
    const healedCounters = JSON.parse(readFileSync(countersPath, "utf8"));
    expect(healedCounters.slots[`0.1.27/${PREVIEW_APP_ID}`].build).toBe(r3.build);
  } finally {
    fx.cleanup();
  }
});
