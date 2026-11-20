import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import {
  generateDevKey,
  packageArtifacts,
  pocketReleaseDirectory,
  sha256Hex,
  signPayload,
  verifySignedManifest,
  type PocketUpdatePayload,
  type PublicKeyConfig,
} from "../scripts/package_update.ts";

/**
 * Pocket Studio signed preview slot.
 *
 * The preview child is an ordinary signed package under fixed preview app ids.
 * Each target is published into its own `preview` slot so the `test`/`stable`
 * slots, their package-slot ownership checks and the version history journal
 * never see it. Nothing here loads unsigned bytes: the host fetches the slot
 * through the normal update coordinator, which performs the usual signature,
 * hash, ABI and anti-downgrade checks.
 */
export const PREVIEW_APP_ID = "dev.pocket.studio.preview";
export const PREVIEW_PACKAGE_VERSION = "preview";
const PREVIEW_ROOT = ".preview";
const COUNTER_FILE = "preview-slots.json";
const KEY_FILE = "editor-preview-key.json";

type PreviewCounters = {
  schemaVersion: 1;
  slots: Record<string, { build: number; version: string; projectId: string; publishedAt: string }>;
};

export type PreviewWorkspace = { updates: string; states: string; keys: string };

export type PreviewPublishInput = {
  workspace: PreviewWorkspace;
  projectId: string;
  /** Request origin used to build absolute URLs returned to the caller. */
  origin: string;
  hostVersion: string;
  previewAppId?: string;
  /** Directory holding the built `app.qjbc`, `app.pak`, `app.bytecode.json`, `guest-manifest.json` and optional `assets/`. */
  buildDirectory: string;
  revision: number;
  generation: string;
  /** Project config version/build; the preview build number always exceeds the build. */
  version: string;
  build: number;
  networkPak?: string[];
  networkAssets?: string[];
};

export type PreviewPublishBatchInput = Omit<PreviewPublishInput, "previewAppId"> & {
  previewAppIds: readonly string[];
};

export type PreviewPublishResult = {
  buildId: string;
  revision: number;
  generation: string;
  version: string;
  build: number;
  packageId: string;
  manifestUrl: string;
  hostConfigUrl: string;
  payloadSha256: string;
  runtimeAbi: string;
  keyId: string;
  timingsMs: { package: number; sign: number; total: number };
};

export type PreviewPublishBatchResult = {
  primary: PreviewPublishResult;
  slots: Record<string, PreviewPublishResult>;
};

const slotLocks = new Set<string>();
const workspaceCounterLocks = new Map<string, Promise<void>>();
const textEncoder = new TextEncoder();

async function withWorkspaceCounterLock<T>(statesDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = workspaceCounterLocks.get(statesDir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => current, () => current);
  workspaceCounterLocks.set(statesDir, chained);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (workspaceCounterLocks.get(statesDir) === chained) {
      workspaceCounterLocks.delete(statesDir);
    }
  }
}

function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  return writeFile(temporary, JSON.stringify(value, null, 2) + "\n").then(() => rename(temporary, path));
}

async function readJson<T>(path: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (fallback !== undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

/** Fault-tolerant JSON reader for non-authoritative metadata/cache files (`payload.json`, `preview-slots.json`). */
async function readJsonSafe<T>(path: string, fallback: T): Promise<T> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Dedicated Ed25519 preview signing key, generated like the editor dev key. */
export async function previewTrust(workspace: PreviewWorkspace): Promise<{ keyPath: string; key: PublicKeyConfig }> {
  const keyPath = join(workspace.keys, KEY_FILE);
  await mkdir(workspace.keys, { recursive: true });
  if (!existsSync(keyPath)) generateDevKey(keyPath, "editor-preview");
  const stored = await readJson<PublicKeyConfig>(keyPath);
  return { keyPath, key: { keyId: stored.keyId, publicKeyBase64: stored.publicKeyBase64 } };
}

function loadPreviewSigningKey(keyPath: string, keyId: string): { keyId: string; privateKey: ReturnType<typeof createPrivateKey> } {
  const parsed = JSON.parse(readFileSync(keyPath, "utf8")) as { privateKeyPem?: string; privateKey?: string };
  const pem = parsed.privateKeyPem ?? parsed.privateKey;
  if (!pem) throw new Error("preview signing key is missing privateKeyPem");
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("preview signing key must be Ed25519");
  return { keyId, privateKey };
}

export function previewSlotDirectory(workspace: PreviewWorkspace, hostVersion: string, packageId: string): string {
  return pocketReleaseDirectory(join(workspace.updates, PREVIEW_ROOT), hostVersion, packageId, PREVIEW_PACKAGE_VERSION);
}

export function previewRoute(hostVersion: string, packageId: string): string {
  return `/preview/pocket/${hostVersion}/${encodeURIComponent(packageId)}/${PREVIEW_PACKAGE_VERSION}`;
}

async function pruneUnreferenced(directory: string, keep: Set<string>): Promise<void> {
  for (const sub of ["blobs", "bundles"]) {
    const dir = join(directory, sub);
    if (!existsSync(dir)) continue;
    for (const name of await readdir(dir)) {
      if (!keep.has(`${sub}/${name}`) && !keep.has(name)) await rm(join(dir, name), { force: true });
    }
  }
}

/**
 * Sanitize a staged copy of `guest-manifest.json` exclusively for Studio's
 * zero-plugin preview children (`dev.pocket.studio.preview*`).
 *
 * Required permissions (`permissions.requires`) are preserved intact so any
 * package that strictly requires host hardware/system permissions still fails
 * closed. Optional permissions (`permissions.optional`) are stripped from the
 * preview-staged manifest because `PocketPluginManager.negotiate` rejects any
 * declared permission not registered on a host plugin, whereas optional
 * capabilities degrade cleanly to `unavailableOptional`.
 */
async function stagePreviewGuestManifest(sourcePath: string, stagingRoot: string): Promise<string> {
  const raw = JSON.parse(await readFile(sourcePath, "utf8")) as Record<string, unknown>;
  const clone = structuredClone(raw);
  const stripOptionalPermissions = (holder: Record<string, unknown> | undefined): void => {
    if (!holder) return;
    const perms = holder.permissions;
    if (perms && typeof perms === "object" && !Array.isArray(perms)) {
      const group = perms as Record<string, unknown>;
      if (Array.isArray(group.optional) && group.optional.length > 0) {
        group.optional = [];
      }
    }
  };
  stripOptionalPermissions(clone);
  if (clone.guest && typeof clone.guest === "object" && !Array.isArray(clone.guest)) {
    stripOptionalPermissions(clone.guest as Record<string, unknown>);
  }
  const stagedPath = join(stagingRoot, "preview-guest-manifest.json");
  await writeFile(stagedPath, JSON.stringify(clone, null, 2) + "\n");
  return stagedPath;
}

/**
 * Build number of the package currently published in the slot, trusted only if
 * its signed manifest verifies against the preview public key. The host's
 * anti-downgrade floor comes from this package, so it survives a lost counter
 * file. Missing, unreadable or unverifiable data counts as 0.
 */
async function publishedSlotBuild(slotDirectory: string, key: PublicKeyConfig): Promise<number> {
  try {
    const envelope = JSON.parse(await readFile(join(slotDirectory, "latest.json"), "utf8")) as { payload: string; signature: string };
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key.publicKeyBase64, "base64")]),
      format: "der",
      type: "spki",
    }).export({ type: "spki", format: "pem" }).toString();
    const payload = JSON.parse(new TextDecoder().decode(verifySignedManifest(envelope as never, publicKey))) as { build?: unknown };
    const build = Number(payload.build);
    return Number.isSafeInteger(build) && build > 0 ? build : 0;
  } catch {
    return 0;
  }
}

/**
 * Package one build into 1..N preview slots in a single pass.
 *
 * Content-addressed blobs (`app.qjbc`, `app.pak` parts, loose `assets/`) are
 * hashed and staged once, then each slot receives its own Ed25519-signed
 * `PocketUpdatePayload` (`appId`, monotonic `build` & `version`) and atomic
 * pointer swap while `preview-slots.json` is updated under a workspace mutex.
 */
export async function publishPreviews(input: PreviewPublishBatchInput): Promise<PreviewPublishBatchResult> {
  const started = performance.now();
  const uniqueIds: string[] = [];
  for (const rawId of input.previewAppIds) {
    if (rawId && !uniqueIds.includes(rawId)) uniqueIds.push(rawId);
  }
  if (uniqueIds.length === 0) uniqueIds.push(PREVIEW_APP_ID);

  const slotKeys = uniqueIds.map((id) => `${input.hostVersion}/${id}`);
  for (const slotKey of slotKeys) {
    if (slotLocks.has(slotKey)) {
      const error = new Error("another preview publish is using this slot; retry when it completes");
      (error as unknown as { status: number }).status = 409;
      throw error;
    }
  }
  for (const slotKey of slotKeys) slotLocks.add(slotKey);

  try {
    const { keyPath, key } = await previewTrust(input.workspace);
    const metadata = await readJson<Record<string, unknown>>(join(input.buildDirectory, "app.bytecode.json"));
    if (typeof metadata.runtimeAbi !== "string" || !metadata.runtimeAbi) {
      throw new Error("build metadata has no runtime ABI");
    }
    const runtimeAbi = metadata.runtimeAbi;

    // Allocate monotonic per-slot build numbers and persist counters atomically under the workspace lock.
    const countersPath = join(input.workspace.states, COUNTER_FILE);
    const allocated = await withWorkspaceCounterLock(input.workspace.states, async () => {
      const rawCounters = await readJsonSafe<Partial<PreviewCounters>>(countersPath, { schemaVersion: 1, slots: {} });
      const counters: PreviewCounters = {
        schemaVersion: 1,
        slots:
          rawCounters.slots && typeof rawCounters.slots === "object" && !Array.isArray(rawCounters.slots)
            ? { ...rawCounters.slots }
            : {},
      };
      const plans: Array<{ packageId: string; slotKey: string; slotDirectory: string; build: number; version: string }> = [];
      for (let i = 0; i < uniqueIds.length; i += 1) {
        const packageId = uniqueIds[i]!;
        const slotKey = slotKeys[i]!;
        const slotDirectory = previewSlotDirectory(input.workspace, input.hostVersion, packageId);
        const previousBuild = Number(counters.slots[slotKey]?.build ?? 0);
        const slotBuild = await publishedSlotBuild(slotDirectory, key);
        const build = Math.max(input.build, Number(metadata.build ?? 0), previousBuild, slotBuild) + 1;
        if (!Number.isSafeInteger(build)) throw new Error("preview build number is outside the safe integer range");
        const version = `${input.version}-preview.${build}`;
        plans.push({ packageId, slotKey, slotDirectory, build, version });
      }
      const publishedAt = new Date().toISOString();
      for (const plan of plans) {
        counters.slots[plan.slotKey] = {
          build: plan.build,
          version: plan.version,
          projectId: input.projectId,
          publishedAt,
        };
      }
      await mkdir(input.workspace.states, { recursive: true });
      await atomicJson(countersPath, counters);
      return plans;
    });

    const stagingRoot = join(input.workspace.updates, PREVIEW_ROOT, `.staging-${randomUUID()}`);
    const primaryStaging = join(stagingRoot, "primary");
    await mkdir(primaryStaging, { recursive: true });

    try {
      const sourceGuestManifest = join(input.buildDirectory, "guest-manifest.json");
      const stagedGuestManifest = existsSync(sourceGuestManifest)
        ? await stagePreviewGuestManifest(sourceGuestManifest, stagingRoot)
        : undefined;
      const assetDirectory = join(input.buildDirectory, "assets");
      const hasAssets = existsSync(assetDirectory) && readdirSync(assetDirectory).length > 0;

      const primaryPlan = allocated[0]!;
      let totalSignMs = 0;
      const packageStarted = performance.now();
      const primaryPkg = packageArtifacts({
        appId: primaryPlan.packageId,
        version: primaryPlan.version,
        build: primaryPlan.build,
        bytecodePath: join(input.buildDirectory, "app.qjbc"),
        entryFormat: "quickjs-bytecode",
        runtimeAbi,
        pakPath: join(input.buildDirectory, "app.pak"),
        outDir: primaryStaging,
        keyFile: keyPath,
        ...(stagedGuestManifest ? { guestManifestPath: stagedGuestManifest } : {}),
        ...(hasAssets ? { assetDir: assetDirectory, assetPrefix: "assets" } : {}),
        networkPakKeys: input.networkPak ?? [],
        networkAssets: input.networkAssets ?? [],
        includeBundle: false,
        onSignTiming: (ms) => { totalSignMs += ms; },
      });
      const sharedPackageMs = performance.now() - packageStarted - totalSignMs;
      const signingKey = uniqueIds.length > 1 ? loadPreviewSigningKey(keyPath, key.keyId) : undefined;
      const signedAt = primaryPkg.payload.signedAt ?? Math.floor(Date.now() / 1000);
      const blobNames = existsSync(join(primaryStaging, "blobs"))
        ? await readdir(join(primaryStaging, "blobs"))
        : [];

      const slots: Record<string, PreviewPublishResult> = {};
      for (let i = 0; i < allocated.length; i += 1) {
        const plan = allocated[i]!;
        const slotStaging = i === 0 ? primaryStaging : join(stagingRoot, `slot-${i}`);
        let payload: PocketUpdatePayload;
        let payloadBytes: Uint8Array;

        if (i === 0) {
          payload = primaryPkg.payload;
          payloadBytes = primaryPkg.payloadBytes;
        } else {
          await mkdir(slotStaging, { recursive: true });
          payload = {
            ...primaryPkg.payload,
            appId: plan.packageId,
            version: plan.version,
            build: plan.build,
            signedAt,
          };
          payloadBytes = textEncoder.encode(JSON.stringify(payload));
          const signStart = performance.now();
          const envelope = signPayload(payloadBytes, signingKey!);
          totalSignMs += performance.now() - signStart;
          const envelopeBytes = textEncoder.encode(JSON.stringify(envelope));
          await writeFile(join(slotStaging, "payload.json"), payloadBytes);
          await writeFile(join(slotStaging, "signed-manifest.json"), envelopeBytes);
          await writeFile(join(slotStaging, "latest.json"), envelopeBytes);
        }

        const payloadSha256 = sha256Hex(payloadBytes);
        await mkdir(join(slotStaging, "bootstrap"), { recursive: true });
        await writeFile(join(slotStaging, "bootstrap", "app.bytecode.json"), JSON.stringify(metadata, null, 2) + "\n");
        if (stagedGuestManifest) {
          await cp(stagedGuestManifest, join(slotStaging, "bootstrap", "guest-manifest.json"));
        }
        const route = previewRoute(input.hostVersion, plan.packageId);
        await writeFile(join(slotStaging, "host.json"), JSON.stringify({
          kind: "pocket-studio-preview-host",
          schemaVersion: 1,
          appId: plan.packageId,
          hostVersion: input.hostVersion,
          packageVersion: PREVIEW_PACKAGE_VERSION,
          POCKET_UPDATE_URL: `${route}/latest.json`,
          POCKET_UPDATE_KEY_ID: key.keyId,
          POCKET_UPDATE_PUBLIC_KEY: key.publicKeyBase64,
          POCKET_HOST_VERSION: input.hostVersion,
          POCKET_STORE_NAMESPACE: "studio-preview",
          version: plan.version,
          build: plan.build,
          runtimeAbi,
          payloadSha256,
        }, null, 2) + "\n");

        // Swap in: immutable content-addressed blobs first, pointer files last.
        const previousPayload = await readJsonSafe<{ files?: Array<{ url: string }> }>(join(plan.slotDirectory, "payload.json"), {});
        await mkdir(join(plan.slotDirectory, "blobs"), { recursive: true });
        for (const blobName of blobNames) {
          const targetBlob = join(plan.slotDirectory, "blobs", blobName);
          if (existsSync(targetBlob)) continue;
          const sourceBlob = join(primaryStaging, "blobs", blobName);
          if (i === allocated.length - 1) {
            await rename(sourceBlob, targetBlob);
          } else {
            const tempBlob = join(plan.slotDirectory, "blobs", `.${blobName}.${randomUUID()}.tmp`);
            await copyFile(sourceBlob, tempBlob);
            await rename(tempBlob, targetBlob);
          }
        }
        await mkdir(join(plan.slotDirectory, "bootstrap"), { recursive: true });
        for (const bootName of await readdir(join(slotStaging, "bootstrap"))) {
          const tempBoot = join(plan.slotDirectory, "bootstrap", `.${bootName}.${randomUUID()}.tmp`);
          await rename(join(slotStaging, "bootstrap", bootName), tempBoot);
          await rename(tempBoot, join(plan.slotDirectory, "bootstrap", bootName));
        }
        for (const name of ["bundle.7z", "bundle.zip", "payload.json", "signed-manifest.json", "host.json", "latest.json"]) {
          const source = join(slotStaging, name);
          if (!existsSync(source)) continue;
          const temporary = join(plan.slotDirectory, `.${name}.${randomUUID()}.tmp`);
          await rename(source, temporary);
          await rename(temporary, join(plan.slotDirectory, name));
        }

        const keep = new Set<string>();
        for (const file of [...payload.files, ...(previousPayload.files ?? [])]) keep.add(file.url);
        if (payload.bundle) keep.add(payload.bundle.url);
        await pruneUnreferenced(plan.slotDirectory, keep);

        slots[plan.packageId] = {
          buildId: `${input.projectId}@${input.revision}`,
          revision: input.revision,
          generation: input.generation,
          version: plan.version,
          build: plan.build,
          packageId: plan.packageId,
          manifestUrl: `${input.origin}${route}/latest.json`,
          hostConfigUrl: `${input.origin}${route}/host.json`,
          payloadSha256,
          runtimeAbi,
          keyId: key.keyId,
          timingsMs: {
            package: round(sharedPackageMs),
            sign: round(totalSignMs),
            total: round(performance.now() - started),
          },
        };
      }

      const primary = slots[primaryPlan.packageId]!;
      return { primary, slots };
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  } finally {
    for (const slotKey of slotKeys) slotLocks.delete(slotKey);
  }
}

/**
 * Package the current successful build into a single preview slot.
 */
export async function publishPreview(input: PreviewPublishInput): Promise<PreviewPublishResult> {
  const batch = await publishPreviews({
    ...input,
    previewAppIds: [input.previewAppId ?? PREVIEW_APP_ID],
  });
  return batch.primary;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const artifactRoots = new Set([
  "latest.json", "signed-manifest.json", "payload.json", "host.json",
  "bundle.7z", "bundle.zip", "bundles", "blobs", "bootstrap",
]);

/**
 * Serve `/preview/pocket/<host>/<packageId>/preview/<artifact>`. Same public,
 * read-only artifact set as the test/stable slots; nothing outside the slot
 * directory is reachable.
 */
export async function readPreviewSlot(workspace: PreviewWorkspace, path: string, servingOrigin: string): Promise<Response> {
  const parts = path.split("/").filter(Boolean);
  const notFound = () => new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
  if (parts[0] !== "preview" || parts[1] !== "pocket" || parts.length < 6 || parts[4] !== PREVIEW_PACKAGE_VERSION) return notFound();
  const host = parts[2]!;
  let packageId: string;
  try { packageId = decodeURIComponent(parts[3]!); } catch { return notFound(); }
  const artifact = parts.slice(5);
  if (!artifactRoots.has(artifact[0]!) || artifact.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) return notFound();
  let directory: string;
  try { directory = previewSlotDirectory(workspace, host, packageId); } catch { return notFound(); }
  const file = join(directory, ...artifact);
  if (relative(directory, file).startsWith("..") || !existsSync(file)) return notFound();
  let bytes: Uint8Array = new Uint8Array(await readFile(file));
  if (artifact.length === 1 && artifact[0] === "host.json") {
    const config = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof config.POCKET_UPDATE_URL === "string" && config.POCKET_UPDATE_URL.startsWith("/")) {
      config.POCKET_UPDATE_URL = `${servingOrigin}${config.POCKET_UPDATE_URL}`;
    }
    bytes = new TextEncoder().encode(JSON.stringify(config, null, 2) + "\n");
  }
  const type = artifact[0] === "bundles" || artifact[0] === "blobs" || artifact[0]!.startsWith("bundle.")
    ? "application/octet-stream"
    : "application/json; charset=utf-8";
  return new Response(bytes, { headers: { "content-type": type, "cache-control": "no-store" } });
}
