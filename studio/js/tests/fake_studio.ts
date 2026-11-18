// A stateful stand-in for the studio.* provider and the System host, serving
// the exact result shapes of the frozen contract (studio/docs/ARCHITECTURE.md).
// It exists only for guest-level tests on the real native probe: the Dart
// provider and the real service are tested elsewhere (pocket_studio tests and
// studio/test/studio_host_test.dart).
import { createHash } from "node:crypto";
import type {
  CosPublishSummary,
  CosSnapshot,
  EcosystemModuleInfo,
  ProjectInfo,
} from "../src/studio-client.ts";
import {
  FAKE_ECOSYSTEM_CATALOG,
  createDefaultCosSnapshot,
  maskSecretId,
  profilesForModules,
} from "./fake_client.ts";
import type { HostRequest, ProbeSession, Reply } from "./probe_session.ts";

export const projects = [
  { id: "alpha-app", appId: "pocket.alpha", name: "Alpha", title: "Alpha 应用", version: "0.1.0", build: 1, tickHz: 60, template: "app" as const },
  { id: "beta-game", appId: "pocket.beta", name: "Beta", title: "Beta 游戏", version: "0.1.0", build: 1, tickHz: 60, template: "game" as const },
];

const err = (code: string, message: string): Reply => ({ ok: false, error: { code, message } });
const ok = (result: unknown): Reply => ({ ok: true, result });

export class FakeStudio {
  files = new Map<string, string>([
    ["app.tsx", "export const MARKER_APP_TSX = 1;\n"],
    ["manifest.json", "{}\n"],
    ["src/alpha.ts", "export const MARKER_ALPHA = 2;\n"],
    ["src/deep/beta.ts", "export const MARKER_BETA = 3;\n"],
  ]);
  assets = ["logo.png", "hero.jpg"];
  revision = 1;
  builtRevision: number | null = null;
  busy = false;
  buildError: string | undefined;
  diagnostics: unknown[] = [];
  /** "ok" builds succeed; "fail" ends with a syntax error diagnostic. */
  buildMode: "ok" | "fail" = "ok";
  buildDelayMs = 30;
  previewBuild = 1;
  failPublish: Reply | undefined;
  failCreate: Reply | undefined;
  storage = new Map<string, unknown>();
  storageAvailable = true;
  /** Host update facts (`updates.*`) for the self-update tests. */
  updates: { configured: boolean; stage: string; activeVersion: string; activeBuild: number; lastError: string | null; available: { version: string; build: number } | null; prepared: { version: string; build: number } | null; failCheck: Reply | undefined } =
    { configured: true, stage: "ready", activeVersion: "0.1.0", activeBuild: 1, lastError: null, available: null, prepared: null, failCheck: undefined };
  /** Project settings (EditorConfig) the service holds; `settings.set` validates like `validateConfig`. */
  config: Record<string, unknown> = { id: "alpha-app", name: "Alpha", title: "Alpha 应用", appId: "pocket.alpha", version: "0.1.0", build: 1, tickHz: 60, entry: "app.tsx" };
  failSettingsSet: Reply | undefined;
  /** Project list and per-project state for `project.list`, `project.openLocal`, `project.create`, `ecosystem.*`, `cos.*`. */
  projectList: ProjectInfo[] = projects.map((p) => ({ ...p, ecosystemModules: [], enabledProfiles: [] }));
  /** Configurable outcome for `studio.project.openLocal`: `"cancel"`, `"open"`, or a custom `ProjectInfo`. */
  openLocalOutcome: "cancel" | "open" | ProjectInfo = "open";
  openLocalProject: ProjectInfo = {
    id: "local-picked",
    appId: "pocket.local",
    name: "Local Picked",
    title: "Local Picked",
    version: "0.2.0",
    build: 1,
    tickHz: 60,
    template: "app",
    directory: "<picked-parent>/local-picked",
    ecosystemModules: [],
    enabledProfiles: [],
  };
  /** Configurable cancel when `studio.project.create` is called with `pickParentDirectory: true`. */
  createPickCancel = false;
  pickedParentDir = "<picked-parent>";
  /** Ecosystem catalog & per-project enabled modules. */
  ecosystemCatalog: EcosystemModuleInfo[] = [...FAKE_ECOSYSTEM_CATALOG];
  projectModules = new Map<string, string[]>([["alpha-app", []], ["beta-game", []]]);
  failEcosystemSet: Reply | undefined;
  /** Tencent Cloud COS per-project state. */
  cosSnapshots = new Map<string, CosSnapshot>();
  failCosSet: Reply | undefined;
  failCosCheck: Reply | undefined;
  failCosPublish: Reply | undefined;
  /** Optional non-fatal `cosError` returned on `studio.publish.publish` when `syncOnPublish` is enabled. */
  publishCosError: string | undefined;
  /** Diagnostics export fixture (`studio.logs.diagnostics`). */
  diagnosticsRecords: Array<Record<string, unknown>> = [
    { id: "d-2", kind: "crash", message: "Preview crashed: TypeError at <project>/app.tsx:9" },
    { id: "d-1", kind: "log", message: "Studio started" },
  ];
  failDiagnostics: Reply | undefined;
  /** Texts written through `clipboard.writeText`. */
  clipboard: string[] = [];
  /** SDK upgrade facts of the editor service (`studio.service.upgrade.*`). */
  sdk: {
    mode: "source" | "standalone";
    modeReason?: string;
    currentVersion: string;
    latest: string | null;
    healthVersion: string;
    healthDown: number;
    failCheck: Reply | undefined;
    applyBusy: boolean;
    /** When true, `upgrade.apply` returns HTTP 200 `{ status: "available", deferredReason }` instead of HTTP 409. */
    applyDefer200?: boolean;
    deferredReason?: string | null;
    downloadedBytes?: number;
    downloadTotalBytes?: number;
    appliedAt?: string | null;
    autoUpgradeSupported?: boolean;
    status: string;
  } = {
    mode: "source",
    currentVersion: "0.1.12",
    latest: null,
    healthVersion: "0.1.12",
    healthDown: 0,
    failCheck: undefined,
    applyBusy: false,
    status: "idle",
  };
  requests: HostRequest[] = [];
  streams = new Map<string, { topic: string; params: Record<string, any> }>();
  cancelled = new Set<string>();
  instanceSeq = 0;
  instances = new Set<string>();
  session: ProbeSession | undefined;
  devices: unknown[] = [];
  deployPolls = 0;
  deployJob: Record<string, unknown> | undefined;
  logs: string[] = [];
  /** Overrides the size the tree reports for a path (to model files that are not worth materializing). */
  reportedBytes = new Map<string, number>();
  upload: { path: string; total: number; sha: string; parts: Buffer[]; asset?: string } | undefined;
  /** Bytes of uploaded assets, by name. */
  assetFiles = new Map<string, Buffer>();
  /** What the host's open dialog returns next (files.pickOpen), keyed by display name. */
  dialogFiles: Record<string, Buffer> = {};
  /** Picked files by handle (files.readChunk). */
  picked = new Map<string, Buffer>();
  releasedHandles: string[] = [];
  /** A provider refusal for the dialog (no plugin / not granted). */
  failPick: Reply | undefined;
  /** Image previews: asset name -> RGBA envelope size, or a refusal. SVG is refused like the real provider. */
  previewFailures = new Map<string, Reply>();
  /** Resource inventory the service holds: placement per key, package ids, and whether a build exists. */
  resourcePlacements = new Map<string, "pak" | "network">([["asset:assets/logo.png", "pak"], ["asset:assets/hero.jpg", "pak"]]);
  resourcesRevisionOffset = 0;
  failResourcesSet: Reply | undefined;

  attach(session: ProbeSession): void {
    this.session = session;
    session.onGuestEvent = (name, payload) => {
      if (name === "stream.open") this.streams.set(String(payload.streamId), { topic: String(payload.topic), params: payload.params ?? {} });
      if (name === "stream.cancel" || name === "stream.end") this.cancelled.add(String(payload.streamId));
      if (name === "stream.open" && payload.topic === "studio.build.events") this.pushTo(String(payload.streamId), [{ type: "status", status: this.status() }]);
      if (name === "stream.open" && payload.topic === "studio.fs.watch") this.pushTo(String(payload.streamId), [{ type: "ready", revision: this.revision }]);
    };
  }

  cosSnapshot(project = "alpha-app"): CosSnapshot {
    let snap = this.cosSnapshots.get(project);
    if (!snap) {
      snap = createDefaultCosSnapshot();
      this.cosSnapshots.set(project, snap);
    }
    return snap;
  }

  /** Computes COS sync summary or error for `studio.publish.publish` when `cos.config.enabled && cos.config.syncOnPublish`. */
  cosForPublish(project: string, channel: "test" | "release", version: string, build: number): { cosPublish?: CosPublishSummary; cosError?: string } {
    const snap = this.cosSnapshot(project);
    if (!snap.config.enabled || !snap.config.syncOnPublish) return {};
    if (this.publishCosError) return { cosError: this.publishCosError };
    const slot = channel === "release" ? "stable" : "test";
    const bucket = snap.config.bucket || snap.local.defaultBucket?.bucket || "pocket-ota-1250000001";
    const region = snap.config.region || snap.local.defaultBucket?.region || "ap-guangzhou";
    const base = snap.config.publicBaseUrl || `https://${bucket}.cos.${region}.myqcloud.com`;
    const prefix = snap.config.keyPrefix ? `${snap.config.keyPrefix}/` : "";
    const appId = String(this.config.appId ?? "pocket.alpha");
    const summary: CosPublishSummary = {
      slot,
      version,
      build,
      uploadedFiles: 5,
      skippedFiles: 1,
      appConfigUrl: `${base}/${prefix}${slot}/${appId}/host.json`,
      manifestUrl: `${base}/${prefix}${slot}/${appId}/latest.json`,
      publishedAt: "2026-11-17T12:10:00.000Z",
    };
    snap.published = { ...(snap.published ?? {}), [slot]: summary };
    return { cosPublish: summary };
  }

  /** A well-formed host-decoded preview: a w x h image in its power-of-two RGBA envelope (left half red). */
  imageEntry(w: number, h: number, name: string) {
    const tw = 2 ** Math.ceil(Math.log2(w)), th = 2 ** Math.ceil(Math.log2(h));
    const img = new Uint8Array(8 + tw * th * 4);
    const view = new DataView(img.buffer);
    view.setUint16(0, tw, true); view.setUint16(2, th, true); img[4] = 3; img[5] = 2;
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const at = 8 + (y * tw + x) * 4; img[at] = x < w / 2 ? 255 : 0; img[at + 2] = x < w / 2 ? 0 : 255; img[at + 3] = 255; }
    return { name, key: name, width: w, height: h, textureWidth: tw, textureHeight: th, sourceWidth: w * 40, sourceHeight: h * 40, img };
  }

  resourceInventory() {
    const entry = (key: string, bytes: number, extra: Record<string, unknown> = {}) => ({ key, kind: key.startsWith("asset:") ? "asset" : "pak", bytes, placement: this.resourcePlacements.get(key) ?? "pak", ...extra });
    return {
      revision: this.revision + this.resourcesRevisionOffset, ...(this.builtRevision === null ? {} : { builtRevision: this.builtRevision }),
      packages: [
        { id: "pocket.alpha", title: "Alpha 应用", manifest: "pocket.json", resources: this.builtRevision === null ? [] : [
          entry("asset:assets/logo.png", 2048, { preview: true }), entry("asset:assets/hero.jpg", 4096, { preview: true }), entry("pak:ui:font.1", 99999, { locked: true, reason: "字形图集，宿主必需" }),
        ] },
        { id: "pocket.beta", title: "Beta 包", manifest: "beta.json", resources: this.builtRevision === null ? [] : [entry("asset:assets/beta.png", 10)] },
      ],
    };
  }

  calls(capability: string): HostRequest[] { return this.requests.filter((r) => r.capability === capability); }
  openStreams(topic: string): string[] {
    return [...this.streams].filter(([id, s]) => s.topic === topic && !this.cancelled.has(id)).map(([id]) => id);
  }

  status() {
    return {
      id: "alpha-app", revision: this.revision, builtRevision: this.builtRevision, busy: this.busy,
      ...(this.buildError ? { error: this.buildError, diagnostics: this.diagnostics } : {}), logs: this.logs.slice(-200),
    };
  }

  pushTo(streamId: string, events: unknown[]): void {
    try { this.session?.sendEvent("stream.data", { streamId, data: { events } }); } catch { /* session already closed */ }
  }
  push(topic: string, events: unknown[]): void { for (const id of this.openStreams(topic)) this.pushTo(id, events); }
  /** Ends every open stream of a topic as the provider does on a service-side drop. */
  drop(topic: string): void {
    for (const id of this.openStreams(topic)) {
      this.cancelled.add(id);
      try { this.session?.sendEvent("stream.end", { streamId: id, reason: "service closed" }); } catch { /* session already closed */ }
    }
  }

  /** Simulates another process editing a file on disk. */
  externalWrite(path: string, content: string | undefined): void {
    if (content === undefined) this.files.delete(path); else this.files.set(path, content);
    this.revision += 1;
    this.push("studio.fs.watch", [{ type: "change", path, kind: "file", event: content === undefined ? "rename" : "change" }]);
  }

  private startBuild(): void {
    this.busy = true;
    this.buildError = undefined;
    this.diagnostics = [];
    this.logs = ["build: start"];
    this.push("studio.build.events", [{ type: "status", status: this.status() }, { type: "log", line: "build: start" }]);
    setTimeout(() => {
      this.busy = false;
      if (this.buildMode === "fail") {
        this.buildError = "SyntaxError: app.tsx: Unterminated JSX contents. (3:5)";
        this.diagnostics = [{ file: "app.tsx", line: 3, column: 5, severity: "error", message: "Unterminated JSX contents." }];
        this.logs.push(this.buildError);
        this.push("studio.build.events", [{ type: "log", line: this.buildError }, { type: "status", status: this.status() }, { type: "done", ok: false, builtRevision: this.builtRevision, diagnostics: this.diagnostics }]);
      } else {
        this.builtRevision = this.revision;
        this.logs.push("build: ok");
        this.push("studio.build.events", [{ type: "log", line: "build: ok" }, { type: "status", status: this.status() }, { type: "done", ok: true, builtRevision: this.builtRevision, diagnostics: [] }]);
      }
    }, this.buildDelayMs);
  }

  mutate(): void {
    this.revision += 1;
    this.builtRevision = this.builtRevision; // a source change leaves builtRevision behind
  }

  updateStatus() {
    const u = this.updates;
    return { configured: u.configured, stage: u.stage, activeVersion: u.activeVersion, activeBuild: u.activeBuild, availableVersion: u.prepared?.version ?? null, preparedUpdate: u.prepared, versions: [], lastError: u.lastError };
  }

  upgradeInfo() {
    const u = this.sdk;
    const autoUpgradeSupported = typeof u.autoUpgradeSupported === "boolean" ? u.autoUpgradeSupported : u.mode === "standalone";
    const modeReason = u.modeReason ?? (u.mode === "standalone" ? "独立安装目录，支持自动下载校验并热重启升级" : "Git 源码检出目录，仅检查新版本");
    return {
      currentVersion: u.currentVersion,
      latestVersion: u.latest ?? u.currentVersion,
      mode: u.mode,
      modeReason,
      platformTuple: "linux-x64",
      autoUpgradeSupported,
      status: u.status,
      upgradeAvailable: u.latest !== null && u.latest !== u.currentVersion,
      deferredReason: u.deferredReason ?? null,
      rolledBack: false,
      error: null,
      releaseUrl: u.latest ? `https://github.com/pocket/sdk/releases/tag/sdk-v${u.latest}` : null,
      checkedAt: u.latest ? "2026-11-16T10:00:00.000Z" : null,
      ...(u.downloadedBytes !== undefined ? { downloadedBytes: u.downloadedBytes } : {}),
      ...(u.downloadTotalBytes !== undefined ? { downloadTotalBytes: u.downloadTotalBytes } : {}),
      ...(u.appliedAt !== undefined ? { appliedAt: u.appliedAt } : {}),
      ...(u.status === "restarting" ? { targetVersion: u.latest } : {}),
    };
  }

  private rewriteAppIdOnDisk(oldAppId: string, newAppId: string): void {
    if (!oldAppId || oldAppId === newAppId) return;
    for (const [path, text] of [...this.files.entries()]) {
      if (text.includes(oldAppId)) {
        this.files.set(path, text.split(oldAppId).join(newAppId));
      }
    }
  }

  handle = (request: HostRequest): Reply | Promise<Reply> => {
    this.requests.push(request);
    const p = request.params;
    switch (request.capability) {
      case "studio.project.list": return ok({ projects: this.projectList });
      case "studio.project.openLocal": {
        if (this.openLocalOutcome === "cancel") return ok({ cancelled: true });
        const opened: ProjectInfo = typeof this.openLocalOutcome === "object"
          ? { ...this.openLocalOutcome, build: 1 }
          : { ...this.openLocalProject, build: 1 };
        const idx = this.projectList.findIndex((item) => item.id === opened.id);
        if (idx >= 0) this.projectList[idx] = opened;
        else this.projectList.push(opened);
        return ok({ cancelled: false, project: opened });
      }
      case "studio.project.create": {
        const rawSettings = (p.settings ?? {}) as Record<string, unknown>;
        if ("build" in rawSettings) return err("invalid_params", "unknown setting: build");
        if (p.pickParentDirectory && this.createPickCancel) return ok({ cancelled: true });
        const modules = Array.isArray(p.ecosystemModules)
          ? (p.ecosystemModules as string[])
          : Array.isArray(rawSettings.ecosystemModules)
            ? (rawSettings.ecosystemModules as string[])
            : [];
        const enabledProfiles = profilesForModules(modules, this.ecosystemCatalog);
        const name = typeof rawSettings.name === "string" && rawSettings.name.trim() ? rawSettings.name.trim() : String(p.id);
        const appId = typeof rawSettings.appId === "string" && rawSettings.appId.trim() ? rawSettings.appId.trim() : `pocket.${p.id}`;
        const version = typeof rawSettings.version === "string" && rawSettings.version.trim() ? rawSettings.version.trim() : "0.1.0";
        const tickHz = typeof rawSettings.tickHz === "number" ? rawSettings.tickHz : 60;
        const created: ProjectInfo = {
          ...projects[0],
          id: String(p.id),
          name,
          title: name,
          appId,
          version,
          build: 1,
          tickHz,
          template: p.template === "game" ? "game" : "app",
          ...(p.pickParentDirectory ? { directory: `${this.pickedParentDir}/${p.id}` } : {}),
          ecosystemModules: modules,
          enabledProfiles,
        };
        const idx = this.projectList.findIndex((item) => item.id === created.id);
        if (idx >= 0) this.projectList[idx] = created;
        else this.projectList.push(created);
        this.projectModules.set(created.id, [...modules]);
        for (const modId of modules) {
          const mod = this.ecosystemCatalog.find((m) => m.id === modId);
          const entryFile = mod?.entryFile ?? `ecosystem/${modId.replace(/-/g, "_")}.tsx`;
          this.files.set(entryFile, `// generated ${modId}\nexport const MODULE = "${modId}";\n`);
        }
        return ok(created);
      }
      case "studio.project.open": {
        const found = this.projectList.find((item) => item.id === p.project) ?? { ...projects[0], id: String(p.project) };
        return ok({ ...found, status: this.status() });
      }
      case "clipboard.writeText": this.clipboard.push(String(p.text)); return ok({ ok: true });
      case "studio.project.settings.get": return ok({ ...this.config });
      case "studio.project.settings.set": {
        if (this.failSettingsSet) return this.failSettingsSet;
        const body = (p.settings ?? {}) as Record<string, any>;
        if ("build" in body) return err("invalid_params", "unknown setting: build");
        if (body.appId !== undefined && !/^[A-Za-z0-9._-]+$/.test(body.appId)) return err("invalid_request", "appId contains unsafe characters (HTTP 400)");
        if (body.version !== undefined && !/^[0-9A-Za-z.+-]+$/.test(body.version)) return err("invalid_request", "version contains unsafe characters (HTTP 400)");
        if (body.tickHz !== undefined && !(Number.isSafeInteger(body.tickHz) && body.tickHz >= 1 && body.tickHz <= 120)) return err("invalid_request", "tickHz must be an integer from 1 through 120 (HTTP 400)");
        if (body.name !== undefined && !String(body.name).trim()) return err("invalid_request", "name must not be empty (HTTP 400)");
        const prevBuild = typeof this.config.build === "number" ? this.config.build : 1;
        const prevAppId = String(this.config.appId ?? "");
        const nextAppId = body.appId !== undefined ? String(body.appId).trim() : prevAppId;
        this.config = {
          ...this.config,
          ...body,
          build: prevBuild,
          ...(body.name !== undefined ? { title: String(body.name).trim() } : {}),
        };
        if (nextAppId !== prevAppId) {
          this.rewriteAppIdOnDisk(prevAppId, nextAppId);
        }
        const listIdx = this.projectList.findIndex((item) => item.id === p.project);
        if (listIdx >= 0) {
          this.projectList[listIdx] = {
            ...this.projectList[listIdx]!,
            name: String(this.config.name ?? ""),
            title: String(this.config.title ?? ""),
            appId: String(this.config.appId ?? ""),
            version: String(this.config.version ?? "0.1.0"),
            build: prevBuild,
            tickHz: Number(this.config.tickHz ?? 60),
          };
        }
        this.revision += 1;
        return ok({ ...this.config, status: this.status() });
      }
      case "studio.ecosystem.catalog": {
        return ok({ modules: [...this.ecosystemCatalog] });
      }
      case "studio.ecosystem.get": {
        const projId = String(p.project ?? "alpha-app");
        const modules = [...(this.projectModules.get(projId) ?? [])];
        const enabledProfiles = profilesForModules(modules, this.ecosystemCatalog);
        return ok({
          modules,
          enabledProfiles,
          catalog: [...this.ecosystemCatalog],
        });
      }
      case "studio.ecosystem.set": {
        if (this.failEcosystemSet) return this.failEcosystemSet;
        const projId = String(p.project ?? "alpha-app");
        const prev = new Set(this.projectModules.get(projId) ?? []);
        const nextModules: string[] = Array.isArray(p.add)
          ? Array.from(new Set([...prev, ...(p.add as string[])]))
          : Array.isArray(p.modules)
            ? [...(p.modules as string[])]
            : [];
        const enabledProfileIds = profilesForModules(nextModules, this.ecosystemCatalog);
        const createdFiles: string[] = [];
        for (const modId of nextModules) {
          const mod = this.ecosystemCatalog.find((m) => m.id === modId);
          const entryFile = mod?.entryFile ?? `ecosystem/${modId.replace(/-/g, "_")}.tsx`;
          if (!this.files.has(entryFile)) {
            this.files.set(entryFile, `// generated ${modId}\nexport const MODULE = "${modId}";\n`);
            createdFiles.push(entryFile);
          }
        }
        const updatedFiles = createdFiles.length > 0 ? ["manifest.json"] : [];
        this.projectModules.set(projId, nextModules);
        this.config = { ...this.config, ecosystemModules: nextModules, enabledProfiles: enabledProfileIds };
        const listIdx = this.projectList.findIndex((item) => item.id === projId);
        if (listIdx >= 0) {
          this.projectList[listIdx] = {
            ...this.projectList[listIdx]!,
            ecosystemModules: nextModules,
            enabledProfiles: enabledProfileIds,
          };
        }
        this.revision += 1;
        return ok({
          modules: nextModules,
          enabledProfileIds,
          enabledProfiles: enabledProfileIds,
          createdFiles,
          updatedFiles,
          removedFiles: [...prev].filter((m) => !nextModules.includes(m)),
          entryWired: nextModules.length > 0,
          status: this.status(),
        });
      }
      case "studio.cos.get": {
        const snap = this.cosSnapshot(String(p.project ?? "alpha-app"));
        return ok(JSON.parse(JSON.stringify(snap)));
      }
      case "studio.cos.set": {
        if (this.failCosSet) return this.failCosSet;
        const snap = this.cosSnapshot(String(p.project ?? "alpha-app"));
        if (typeof p.enabled === "boolean") snap.config.enabled = p.enabled;
        if (typeof p.syncOnPublish === "boolean") snap.config.syncOnPublish = p.syncOnPublish;
        if (typeof p.bucket === "string") snap.config.bucket = p.bucket;
        if (typeof p.region === "string") snap.config.region = p.region;
        if (typeof p.keyPrefix === "string") snap.config.keyPrefix = p.keyPrefix;
        if (typeof p.publicBaseUrl === "string") snap.config.publicBaseUrl = p.publicBaseUrl;
        if ("credentials" in p) {
          if (p.credentials === null) {
            snap.local.hasWorkspaceCredentials = false;
            snap.local.source = "coscli";
            snap.local.sourceDetail = "~/.cos.yaml";
            snap.local.maskedSecretId = "AKID12****7890";
          } else if (p.credentials && typeof p.credentials === "object") {
            snap.local.available = true;
            snap.local.hasWorkspaceCredentials = true;
            snap.local.source = "workspace";
            snap.local.sourceDetail = "Studio 本机密钥库 (0600)";
            snap.local.maskedSecretId = maskSecretId(String(p.credentials.secretId ?? ""));
          }
        }
        return ok(JSON.parse(JSON.stringify(snap)));
      }
      case "studio.cos.check": {
        if (this.failCosCheck) return this.failCosCheck;
        const snap = this.cosSnapshot(String(p.project ?? "alpha-app"));
        const bucket = (typeof p.bucket === "string" && p.bucket.trim()) || snap.config.bucket || snap.local.defaultBucket?.bucket || "pocket-ota-1250000001";
        const region = (typeof p.region === "string" && p.region.trim()) || snap.config.region || snap.local.defaultBucket?.region || "ap-guangzhou";
        const keyPrefix = typeof p.keyPrefix === "string" ? p.keyPrefix.trim() : snap.config.keyPrefix;
        const publicBaseUrl = typeof p.publicBaseUrl === "string" ? p.publicBaseUrl.trim() : snap.config.publicBaseUrl;
        return ok({
          ok: true,
          bucket,
          region,
          keyPrefix,
          publicBaseUrl,
          source: snap.local.source,
          sourceDetail: snap.local.sourceDetail,
          maskedSecretId: snap.local.maskedSecretId ?? "AKID12****7890",
          checkedAt: "2026-11-17T12:00:00.000Z",
        });
      }
      case "studio.cos.publish": {
        if (this.failCosPublish) return this.failCosPublish;
        const projId = String(p.project ?? "alpha-app");
        const channel = p.channel === "release" ? "release" : "test";
        const slot = channel === "release" ? "stable" : "test";
        const snap = this.cosSnapshot(projId);
        const bucket = snap.config.bucket || snap.local.defaultBucket?.bucket || "pocket-ota-1250000001";
        const region = snap.config.region || snap.local.defaultBucket?.region || "ap-guangzhou";
        const base = snap.config.publicBaseUrl || `https://${bucket}.cos.${region}.myqcloud.com`;
        const prefix = snap.config.keyPrefix ? `${snap.config.keyPrefix}/` : "";
        const appId = String(this.config.appId ?? "pocket.alpha");
        const buildNum = Number(this.config.build ?? 1);
        const ver = channel === "release" ? String(this.config.version ?? "0.1.0") : `${this.config.version ?? "0.1.0"}-test.${buildNum}`;
        const summary: CosPublishSummary = {
          slot,
          version: ver,
          build: buildNum,
          uploadedFiles: 4,
          skippedFiles: 2,
          appConfigUrl: `${base}/${prefix}${slot}/${appId}/host.json`,
          manifestUrl: `${base}/${prefix}${slot}/${appId}/latest.json`,
          publishedAt: "2026-11-17T12:05:00.000Z",
        };
        snap.published = { ...(snap.published ?? {}), [slot]: summary };
        return ok({
          ok: true,
          cosPublish: summary,
          status: this.status(),
          cos: JSON.parse(JSON.stringify(snap)),
        });
      }
      case "studio.publish.publish": {
        if (p.channel !== "test" && p.channel !== "release") return err("invalid_params", "channel");
        if (this.builtRevision !== this.revision || this.buildError) return err("conflict", "build the current source before publishing (HTTP 409)");
        const projId = String(p.project ?? "alpha-app");
        const slot = p.channel === "release" ? "stable" : "test";
        const buildNum = Number(this.config.build ?? 1);
        const version = p.channel === "release" ? String(this.config.version ?? "0.1.0") : `${this.config.version ?? "0.1.0"}-test.${buildNum}`;
        const appId = String(this.config.appId ?? "pocket.alpha");
        const route = `http://127.0.0.1:8795/${slot}/pocket/studio/${appId}/${version}`;
        const cosExtra = this.cosForPublish(projId, p.channel, version, buildNum);
        return ok({
          status: {
            ...this.status(),
            publish: {
              channel: p.channel,
              version,
              build: buildNum,
              revision: this.revision,
              keyId: "editor-alpha-app",
              runtimeAbi: "quickjs-bytecode-v1",
              payloadSha256: "a".repeat(64),
              releaseId: `${projId}-${slot}-${buildNum}`,
              publishedAt: "2026-11-17T12:10:00.000Z",
              packages: [{ id: appId, version, build: buildNum, manifestUrl: `${route}/latest.json`, hostConfigUrl: `${route}/host.json` }],
            },
          },
          manifestUrl: `${route}/latest.json`,
          hostConfigUrl: `${route}/host.json`,
          appConfigUrl: `http://127.0.0.1:8795/${slot}/pocket/studio/${appId}/latest.json`,
          archiveUrl: `/releases/${projId}.tar.gz`,
          packages: [{ id: appId, version, build: buildNum, manifestUrl: `${route}/latest.json`, hostConfigUrl: `${route}/host.json` }],
          ...cosExtra,
        });
      }
      case "studio.logs.diagnostics": {
        if (this.failDiagnostics) return this.failDiagnostics;
        const records = this.diagnosticsRecords.filter((r) => p.kind === undefined || r.kind === p.kind);
        return ok({
          exportId: `diag-${p.project}-20261116102030123`, project: p.project, ...(p.kind ? { kind: p.kind } : {}), format: "pocket-diagnostics-export", schemaVersion: 1,
          exportedAt: "2026-11-16T10:20:30.123Z", totalRecords: records.length, logCount: records.filter((r) => r.kind === "log").length, crashCount: records.filter((r) => r.kind === "crash").length,
          keptRecords: records.length, omitted: 0, truncated: false, records,
          downloadUrl: `http://127.0.0.1:8791/api/projects/${p.project}/diagnostics?download=1${p.kind ? `&kind=${p.kind}` : ""}`,
        });
      }
      case "studio.service.health": {
        if (this.sdk.healthDown > 0) { this.sdk.healthDown -= 1; return err("service_unreachable", "Studio service is unreachable"); }
        return ok({ ok: true, service: "pocket-editor", version: this.sdk.healthVersion });
      }
      case "studio.service.upgrade.status": return ok(this.upgradeInfo());
      case "studio.service.upgrade.check": {
        if (this.sdk.failCheck) return this.sdk.failCheck;
        this.sdk.latest = this.sdk.latest ?? "0.2.0";
        this.sdk.status = this.sdk.latest !== this.sdk.currentVersion ? "available" : "up-to-date";
        return ok(this.upgradeInfo());
      }
      case "studio.service.upgrade.apply": {
        if (this.sdk.mode === "source") return err("conflict", "当前为源码检出模式，仅支持检查新版本，禁止自动覆盖 Git 工作区 (HTTP 409)");
        if (this.sdk.applyDefer200) {
          this.sdk.status = "available";
          this.sdk.deferredReason = this.sdk.deferredReason ?? "当前 Studio 有正在执行的构建、保存、发布或部署任务，已暂缓应用更新";
          return ok(this.upgradeInfo());
        }
        if (this.sdk.applyBusy) return err("conflict", "当前 Studio 有正在执行的构建、保存、发布或部署任务，已暂缓应用更新 (HTTP 409)");
        this.sdk.status = "restarting";
        this.sdk.healthDown = 2;
        this.sdk.healthVersion = this.sdk.latest ?? this.sdk.healthVersion;
        return ok(this.upgradeInfo());
      }
      case "studio.fs.tree": return ok({
        files: [...this.files].map(([path, text]) => ({ path, bytes: this.reportedBytes.get(path) ?? new TextEncoder().encode(text).length })),
        revision: this.revision, ...(p.assets ? { assets: this.assets } : {}),
      });
      case "studio.fs.read": {
        const text = this.files.get(p.path);
        return text === undefined ? err("not_found", "file not found") : ok({ path: p.path, content: text, bytes: new TextEncoder().encode(text).length, revision: this.revision });
      }
      case "studio.fs.readChunk": {
        const bytes = Buffer.from(this.files.get(p.path) ?? "", "utf8");
        if (!this.files.has(p.path)) return err("not_found", "file not found");
        const length = Math.min(Number(p.length ?? 131072), 131072, bytes.length - p.offset);
        return ok({ path: p.path, offset: p.offset, length, totalBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mtimeMs: 1, data: bytes.subarray(p.offset, p.offset + length).toString("base64") });
      }
      case "studio.fs.write": {
        this.files.set(p.path, p.content);
        this.mutate();
        // The service's watcher reports our own writes too; the guest must ignore them.
        this.push("studio.fs.watch", [{ type: "change", path: p.path, kind: "file", event: "change" }, { type: "revision", revision: this.revision }]);
        return ok({ path: p.path, bytes: new TextEncoder().encode(p.content).length, revision: this.revision });
      }
      case "files.pickOpen": {
        if (this.failPick) return this.failPick;
        const files = Object.entries(this.dialogFiles).map(([name, bytes], i) => {
          const handle = `${i + 1}`.padStart(32, "0");
          this.picked.set(handle, bytes);
          return { handle, name, size: bytes.length, mime: "application/octet-stream" };
        });
        return ok({ files });
      }
      case "files.readChunk": {
        const bytes = this.picked.get(p.handle);
        if (!bytes) return err("handle_not_found", "unknown or released file handle");
        const part = bytes.subarray(p.offset, Math.min(p.offset + p.length, bytes.length));
        return ok({ handle: p.handle, offset: p.offset, length: part.length, size: bytes.length, eof: p.offset + part.length >= bytes.length, data: part.toString("base64") });
      }
      case "files.release": { this.releasedHandles.push(p.handle); return ok({ released: this.picked.delete(p.handle) }); }
      case "studio.assets.upload.begin": {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(p.name)) return err("invalid_params", "name must be a flat safe file name");
        this.upload = { path: `assets/${p.name}`, total: p.totalBytes, sha: p.sha256, parts: [], asset: p.name };
        return ok({ uploadId: "up-asset", chunkBytes: 131072 });
      }
      case "studio.assets.preview": {
        const refusal = this.previewFailures.get(p.name);
        if (refusal) return refusal;
        return ok(this.imageEntry(8, 6, p.name));
      }
      case "studio.project.resources.get": return ok(this.resourceInventory());
      case "studio.project.resources.set": {
        if (this.failResourcesSet) return this.failResourcesSet;
        if (p.revision !== this.revision + this.resourcesRevisionOffset) return err("conflict", "resource revision is stale; reload the project and retry (HTTP 409)");
        for (const placement of p.placements) this.resourcePlacements.set(placement.key, placement.placement);
        this.revision += 1;
        return ok(this.resourceInventory());
      }
      case "studio.project.resources.preview": return ok(this.imageEntry(16, 8, p.key));
      case "studio.fs.upload.begin": { this.upload = { path: p.path, total: p.totalBytes, sha: p.sha256, parts: [] }; return ok({ uploadId: "up-1", chunkBytes: 131072 }); }
      case "studio.fs.upload.chunk": { this.upload?.parts.push(Buffer.from(p.data, "base64")); return ok({ uploadId: p.uploadId, received: this.upload?.parts.reduce((n, b) => n + b.length, 0) ?? 0, totalBytes: this.upload?.total ?? 0 }); }
      case "studio.fs.upload.commit": {
        const up = this.upload;
        if (!up) return err("not_found", "no upload");
        const all = Buffer.concat(up.parts);
        if (createHash("sha256").update(all).digest("hex") !== up.sha) return err("checksum_mismatch", "sha256 mismatch (HTTP 422)");
        if (up.asset) {
          this.assetFiles.set(up.asset, all);
          if (!this.assets.includes(up.asset)) this.assets.push(up.asset);
          this.mutate(); this.upload = undefined;
          return ok({ path: up.path, bytes: all.length, sha256: up.sha, revision: this.revision, assets: [...this.assets] });
        }
        this.files.set(up.path, all.toString("utf8")); this.mutate(); this.upload = undefined;
        return ok({ path: up.path, bytes: all.length, sha256: up.sha, revision: this.revision });
      }
      case "studio.fs.upload.abort": this.upload = undefined; return ok({ uploadId: p.uploadId, aborted: true });
      case "studio.fs.rename": {
        const text = this.files.get(p.from);
        if (text === undefined) return err("not_found", "source missing");
        if (this.files.has(p.to)) return err("conflict", "target exists (HTTP 409)");
        this.files.delete(p.from); this.files.set(p.to, text); this.mutate();
        return ok({ from: p.from, to: p.to, revision: this.revision });
      }
      case "studio.fs.delete": {
        if (!this.files.delete(p.path)) return err("not_found", "file not found");
        this.mutate();
        return ok({ path: p.path, revision: this.revision });
      }
      case "studio.fs.mkdir": this.mutate(); return ok({ path: p.path, created: true, revision: this.revision });
      case "studio.fs.rmdir": this.mutate(); return ok({ path: p.path, revision: this.revision });
      case "studio.fs.stat": return p.path.startsWith("assets/")
        ? ok({ path: p.path, kind: "file", bytes: 2048, mtimeMs: 1_700_000_000_000, editable: false })
        : err("not_found", "missing");
      case "studio.build.status": return ok(this.status());
      case "studio.build.start": {
        if (this.busy) return err("conflict", "build already running (HTTP 409)");
        this.startBuild();
        return ok(this.status());
      }
      case "studio.build.cancel": {
        if (!this.busy) return err("conflict", "no build is running (HTTP 409)");
        return ok({ cancelled: true, status: this.status() });
      }
      case "studio.preview.publish": {
        if (this.failPublish) return this.failPublish;
        if (this.builtRevision !== this.revision) return err("conflict", "build the current source successfully before preview publish (HTTP 409)");
        this.previewBuild += 1;
        return ok({ buildId: `alpha-app@${this.revision}`, revision: this.revision, version: `0.1.0-preview.${this.previewBuild}`, build: this.previewBuild, packageId: "dev.pocket.studio.preview" });
      }
      case "studio.preview.devices": return ok({ devices: this.devices });
      case "studio.preview.deploy": {
        this.deployPolls = 0;
        this.deployJob = { id: "job-1", status: "queued", logs: ["queued"] };
        return ok({ job: this.deployJob });
      }
      case "studio.preview.deployStatus": {
        this.deployPolls += 1;
        this.deployJob = this.deployPolls < 2
          ? { id: "job-1", status: "building", logs: ["queued", "flutter build"] }
          : { id: "job-1", status: "running", logs: ["queued", "flutter build", "app is running"] };
        return ok(this.deployJob);
      }
      case "studio.preview.deployCancel": return ok({ id: "job-1", status: "cancelled", logs: [] });
      case "system.runtime.configure": return ok({ systemInstanceId: "system-ui", generation: 1 });
      case "system.runtime.post": return ok({ delivered: true });
      case "system.runtime.create": {
        if (this.failCreate) return this.failCreate;
        const instanceId = `pocket-app-${++this.instanceSeq}`;
        this.instances.add(instanceId);
        return ok({ instanceId, appId: p.appId, generation: 1, preparedForOpen: p.prepareForOpen === true });
      }
      case "system.runtime.destroy": {
        if (!this.instances.delete(p.instanceId)) return err("instance_not_found", "no such instance");
        return ok({});
      }
      case "system.runtime.awaitFirstFrame": return ok({ ready: true });
      case "system.storage.get": return this.storageAvailable ? ok(this.storage.get(p.key) ?? null) : err("not_configured", "storage unavailable");
      case "system.storage.set": {
        if (!this.storageAvailable) return err("not_configured", "storage unavailable");
        this.storage.set(p.key, p.value);
        return ok(null);
      }
      case "updates.status": return ok(this.updateStatus());
      case "updates.check": {
        if (this.updates.failCheck) return this.updates.failCheck;
        this.updates.prepared = this.updates.available;
        return ok(this.updateStatus());
      }
      case "updates.apply": return ok({ scheduled: this.updates.prepared !== null, version: this.updates.prepared?.version ?? this.updates.activeVersion });
      case "platform.storage.get": return ok(this.storage.get(`platform:${p.key}`) ?? null);
      case "platform.storage.set": this.storage.set(`platform:${p.key}`, p.value); return ok(null);
      case "platform.storage.remove": this.storage.delete(`platform:${p.key}`); return ok(null);
      default: return err("capability_unavailable", request.capability);
    }
  };
}
