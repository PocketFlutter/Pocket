// In-memory StudioClient for unit tests of the state modules (no host, no probe).
import { DEFAULT_ECOSYSTEM_CATALOG } from "../src/state/ecosystem.ts";
import {
  StudioError,
  type CosCheckInput,
  type CosCheckResult,
  type CosPublishResult,
  type CosPublishSummary,
  type CosSetInput,
  type CosSnapshot,
  type EcosystemModuleInfo,
  type EcosystemSetResult,
  type EcosystemStatePayload,
  type ProjectCreateParams,
  type ProjectCreateResult,
  type ProjectInfo,
  type ProjectOpenLocalResult,
  type ProjectSettings,
  type ProjectSettingsPatch,
  type PublishResult,
  type SdkUpgradePayload,
  type StudioClient,
  type Subscription,
  type WatchEvent,
} from "../src/studio-client.ts";

type Handlers = { onEvent(e: WatchEvent): void; onError(e: StudioError): void; onEnd(): void };

export const FAKE_ECOSYSTEM_CATALOG: EcosystemModuleInfo[] = [
  ...DEFAULT_ECOSYSTEM_CATALOG,
  { id: "ios-live-activity", ecosystem: "apple", platform: "apple", label: "iOS 实时活动 (Live Activity)", description: "灵动岛与锁屏实时状态卡片", entryFile: "ecosystem/ios_live_activity.tsx", profileIds: ["ios-live-activity"] },
  { id: "ios-widgetkit", ecosystem: "apple", platform: "apple", label: "iOS 桌面小组件 (WidgetKit)", description: "桌面与锁屏 Widget 视图骨架", entryFile: "ecosystem/ios_widgetkit.tsx", profileIds: ["ios-widget-extension"] },
  { id: "watchos", ecosystem: "apple", platform: "apple", label: "watchOS 伴侣与复杂功能", description: "Apple Watch 伴侣视图与表盘小组件", entryFile: "ecosystem/watchos.tsx", profileIds: ["watchos-companion"] },
  { id: "android-glance-widget", ecosystem: "android", platform: "android", label: "Android Glance 桌面微件", description: "Jetpack Glance 风格桌面小组件骨架", entryFile: "ecosystem/android_glance_widget.tsx", profileIds: ["android-app-widget"] },
];

export function profilesForModules(modules: readonly string[], catalog: readonly EcosystemModuleInfo[] = FAKE_ECOSYSTEM_CATALOG): string[] {
  const out = new Set<string>();
  for (const id of modules) {
    const mod = catalog.find((m) => m.id === id);
    for (const p of mod?.profileIds ?? (mod?.profile ? [mod.profile] : [`profile-${id}`])) out.add(p);
  }
  return [...out];
}

export function maskSecretId(secretId: string): string {
  const trimmed = secretId.trim();
  if (trimmed.length <= 8) return "AKID****";
  return `${trimmed.slice(0, 6)}****${trimmed.slice(-4)}`;
}

export function createDefaultCosSnapshot(): CosSnapshot {
  return {
    local: {
      available: true,
      source: "coscli",
      sourceDetail: "~/.cos.yaml",
      maskedSecretId: "AKID12****7890",
      hasWorkspaceCredentials: false,
      discoveredBuckets: [
        { bucket: "pocket-ota-1250000001", region: "ap-guangzhou", alias: "prod" },
        { bucket: "pocket-test-1250000001", region: "ap-shanghai", alias: "staging" },
      ],
      defaultBucket: { bucket: "pocket-ota-1250000001", region: "ap-guangzhou" },
    },
    config: {
      enabled: false,
      syncOnPublish: false,
      bucket: "",
      region: "",
      keyPrefix: "pocket-ota",
      publicBaseUrl: "",
    },
  };
}

export function createFakeClient() {
  const files = new Map<string, string>();
  const calls: { name: string; args: unknown[] }[] = [];
  const watchers: Handlers[] = [];
  const buildStreams: Handlers[] = [];

  const projectMap = new Map<string, ProjectInfo>([
    [
      "alpha",
      {
        id: "alpha",
        appId: "pocket.alpha",
        name: "Alpha",
        title: "Alpha 应用",
        version: "0.1.0",
        build: 1,
        tickHz: 60,
        template: "app",
        ecosystemModules: [],
        enabledProfiles: [],
      },
    ],
    [
      "beta",
      {
        id: "beta",
        appId: "pocket.beta",
        name: "Beta",
        title: "Beta 游戏",
        version: "0.1.0",
        build: 1,
        tickHz: 60,
        template: "game",
        ecosystemModules: [],
        enabledProfiles: [],
      },
    ],
  ]);

  const cosMap = new Map<string, CosSnapshot>();
  const getCos = (project: string): CosSnapshot => {
    let snap = cosMap.get(project);
    if (!snap) {
      snap = createDefaultCosSnapshot();
      cosMap.set(project, snap);
    }
    return snap;
  };

  const state = {
    revision: 1,
    builtRevision: null as number | null,
    busy: false,
    error: undefined as string | undefined,
    diagnostics: [] as unknown[],
    logs: [] as string[],
    failWrites: false,
    publishError: undefined as StudioError | undefined,
    previewBuild: 1,
    startBuildHook: undefined as undefined | (() => void),
    /** Configurable outcome for `project.openLocal`: `"cancel"` or a `ProjectInfo` (or default opened project). */
    openLocalOutcome: "open" as "cancel" | "open" | ProjectInfo,
    openLocalProject: {
      id: "local-picked",
      appId: "pocket.local",
      name: "Local Picked",
      title: "Local Picked",
      version: "0.2.0",
      build: 1,
      tickHz: 60,
      template: "app" as const,
      directory: "<picked-parent>/local-picked",
      ecosystemModules: [] as string[],
      enabledProfiles: [] as string[],
    } satisfies ProjectInfo,
    /** Configurable cancel when `create` is called with `pickParentDirectory: true`. */
    createPickCancel: false,
    pickedParentDir: "<picked-parent>",
    /** Configurable catalog returned by `ecosystem.catalog` / `ecosystem.get`. */
    ecosystemCatalog: [...FAKE_ECOSYSTEM_CATALOG] as EcosystemModuleInfo[],
    /** Configurable COS check failure or custom result. */
    cosCheckError: undefined as StudioError | undefined,
    /** Configurable non-fatal `cosError` during `studio.publish.publish`. */
    publishCosError: undefined as string | undefined,
    /** Configurable SDK upgrade state. */
    sdkUpgrade: {
      currentVersion: "0.1.12",
      latestVersion: "0.1.12" as string | null,
      targetVersion: null as string | null,
      mode: "standalone" as "standalone" | "source" | string,
      modeReason: "独立安装目录，支持自动下载校验并热重启升级",
      platformTuple: "darwin-arm64",
      autoUpgradeSupported: true,
      status: "idle",
      upgradeAvailable: false,
      releaseUrl: null as string | null,
      downloadedBytes: 0,
      downloadTotalBytes: 0,
      checkedAt: "2026-11-16T10:00:00.000Z" as string | null,
      appliedAt: null as string | null,
      deferredReason: null as string | null,
      error: null as string | null,
      rolledBack: false,
      /** How `upgradeApply()` behaves: `"restart"` | `"defer_200"` | `"defer_409"`. */
      applyMode: "restart" as "restart" | "defer_200" | "defer_409",
      deferMessage: "当前 Studio 有正在执行的构建或发布任务，已暂缓应用更新",
    },
  };

  const record = (name: string, ...args: unknown[]) => { calls.push({ name, args }); };
  const status = (id = "p") => ({
    id,
    revision: state.revision,
    builtRevision: state.builtRevision,
    busy: state.busy,
    ...(state.error ? { error: state.error, diagnostics: state.diagnostics } : {}),
    logs: [...state.logs],
  });
  const notFound = (cap: string) => new StudioError(cap, "not_found", "file not found");
  const sub = (list: Handlers[], h: Handlers): Subscription => {
    list.push(h);
    return { close: () => { const i = list.indexOf(h); if (i >= 0) list.splice(i, 1); } };
  };

  const ensureProject = (id: string): ProjectInfo => {
    let proj = projectMap.get(id);
    if (!proj) {
      proj = {
        id,
        appId: `pocket.${id.replace(/[^a-zA-Z0-9_]/g, "_")}`,
        name: id,
        title: id,
        version: "0.1.0",
        build: 1,
        tickHz: 60,
        template: "app",
        ecosystemModules: [],
        enabledProfiles: [],
      };
      projectMap.set(id, proj);
    }
    return proj;
  };

  const rewriteAppIdInFiles = (oldAppId: string, newAppId: string) => {
    let changed = false;
    for (const [path, content] of [...files.entries()]) {
      if (content.includes(oldAppId)) {
        files.set(path, content.split(oldAppId).join(newAppId));
        changed = true;
      }
    }
    if (!changed && files.has("pocket.json")) {
      try {
        const parsed = JSON.parse(files.get("pocket.json")!);
        parsed.appId = newAppId;
        files.set("pocket.json", `${JSON.stringify(parsed, null, 2)}\n`);
      } catch {
        files.set("pocket.json", `${JSON.stringify({ appId: newAppId }, null, 2)}\n`);
      }
    }
  };

  const client = {
    project: {
      list: async () => {
        record("project.list");
        return [...projectMap.values()];
      },
      openLocal: async (): Promise<ProjectOpenLocalResult> => {
        record("project.openLocal");
        if (state.openLocalOutcome === "cancel") return { cancelled: true };
        const opened: ProjectInfo = typeof state.openLocalOutcome === "object"
          ? { ...state.openLocalOutcome, build: 1 }
          : { ...state.openLocalProject, build: 1 };
        projectMap.set(opened.id, opened);
        return { cancelled: false, project: opened };
      },
      create: async (
        idOrParams: string | ProjectCreateParams,
        templateArg: "app" | "game" = "app",
        settingsArg: Record<string, unknown> = {},
      ): Promise<ProjectCreateResult> => {
        record("project.create", idOrParams, templateArg, settingsArg);
        const params: ProjectCreateParams = typeof idOrParams === "string"
          ? { id: idOrParams, template: templateArg, settings: settingsArg }
          : idOrParams;
        const rawSettings = (params.settings ?? {}) as Record<string, unknown>;
        if ("build" in rawSettings) {
          throw new StudioError("studio.project.create", "invalid_params", "unknown setting: build");
        }
        if (params.pickParentDirectory && state.createPickCancel) {
          return { cancelled: true };
        }
        const modules = Array.isArray(params.ecosystemModules)
          ? [...params.ecosystemModules]
          : Array.isArray(rawSettings.ecosystemModules)
            ? [...(rawSettings.ecosystemModules as string[])]
            : [];
        const enabledProfiles = profilesForModules(modules, state.ecosystemCatalog);
        const name = typeof rawSettings.name === "string" && rawSettings.name.trim() ? rawSettings.name.trim() : params.id;
        const appId = typeof rawSettings.appId === "string" && rawSettings.appId.trim() ? rawSettings.appId.trim() : `pocket.${params.id}`;
        const version = typeof rawSettings.version === "string" && rawSettings.version.trim() ? rawSettings.version.trim() : "0.1.0";
        const tickHz = typeof rawSettings.tickHz === "number" ? rawSettings.tickHz : 60;
        const created: ProjectInfo = {
          id: params.id,
          appId,
          name,
          title: name,
          version,
          build: 1,
          tickHz,
          template: params.template ?? "app",
          ...(params.pickParentDirectory ? { directory: `${state.pickedParentDir}/${params.id}` } : {}),
          ecosystemModules: modules,
          enabledProfiles,
        };
        projectMap.set(created.id, created);
        for (const modId of modules) {
          const mod = state.ecosystemCatalog.find((m) => m.id === modId);
          const entryFile = mod?.entryFile ?? `ecosystem/${modId.replace(/-/g, "_")}.tsx`;
          files.set(entryFile, `// generated ${modId}\nexport const MODULE = "${modId}";\n`);
        }
        return created;
      },
      open: async (project: string) => {
        record("project.open", project);
        return { ...ensureProject(project), status: status(project) };
      },
      settings: {
        get: async (project: string): Promise<ProjectSettings> => {
          record("project.settings.get", project);
          const p = ensureProject(project);
          return {
            id: p.id,
            name: p.name,
            title: p.title,
            appId: p.appId,
            version: p.version,
            build: p.build,
            tickHz: p.tickHz,
            reusePublishedPackages: Array.isArray(p.reusePublishedPackages) ? (p.reusePublishedPackages as string[]) : [],
            ecosystemModules: p.ecosystemModules ?? [],
            enabledProfiles: p.enabledProfiles ?? [],
            status: status(project),
          };
        },
        set: async (project: string, settings: ProjectSettingsPatch): Promise<ProjectSettings> => {
          record("project.settings.set", project, settings);
          if ("build" in (settings as Record<string, unknown>)) {
            throw new StudioError("studio.project.settings.set", "invalid_params", "unknown setting: build");
          }
          const prev = ensureProject(project);
          const prevAppId = prev.appId;
          const nextName = typeof settings.name === "string" ? settings.name.trim() : prev.name;
          const nextTitle = typeof settings.title === "string"
            ? settings.title.trim()
            : typeof settings.name === "string"
              ? nextName
              : prev.title;
          const nextAppId = typeof settings.appId === "string" ? settings.appId.trim() : prev.appId;
          const nextVersion = typeof settings.version === "string" ? settings.version.trim() : prev.version;
          const nextTickHz = typeof settings.tickHz === "number" ? settings.tickHz : prev.tickHz;
          const nextReuse = Array.isArray(settings.reusePublishedPackages)
            ? (settings.reusePublishedPackages as string[])
            : Array.isArray(prev.reusePublishedPackages)
              ? (prev.reusePublishedPackages as string[])
              : [];
          const updated: ProjectInfo = {
            ...prev,
            name: nextName,
            title: nextTitle,
            appId: nextAppId,
            version: nextVersion,
            build: prev.build, // authoritative read-only build preserved
            tickHz: nextTickHz,
            reusePublishedPackages: nextReuse,
          };
          projectMap.set(project, updated);
          if (nextAppId !== prevAppId) {
            rewriteAppIdInFiles(prevAppId, nextAppId);
          }
          state.revision += 1;
          return {
            id: updated.id,
            name: updated.name,
            title: updated.title,
            appId: updated.appId,
            version: updated.version,
            build: updated.build,
            tickHz: updated.tickHz,
            reusePublishedPackages: nextReuse,
            ecosystemModules: updated.ecosystemModules ?? [],
            enabledProfiles: updated.enabledProfiles ?? [],
            status: status(project),
          };
        },
      },
    },
    ecosystem: {
      catalog: async () => {
        record("ecosystem.catalog");
        return { modules: [...state.ecosystemCatalog] };
      },
      get: async (project: string): Promise<EcosystemStatePayload> => {
        record("ecosystem.get", project);
        const p = ensureProject(project);
        const modules = [...(p.ecosystemModules ?? [])];
        const enabledProfiles = [...(p.enabledProfiles ?? profilesForModules(modules, state.ecosystemCatalog))];
        return {
          modules,
          enabledProfiles,
          catalog: [...state.ecosystemCatalog],
        };
      },
      set: async (project: string, body: { modules?: string[]; add?: string[] }): Promise<EcosystemSetResult> => {
        record("ecosystem.set", project, body);
        const p = ensureProject(project);
        const prevModules = new Set(p.ecosystemModules ?? []);
        const nextModules = body.add !== undefined
          ? Array.from(new Set([...prevModules, ...body.add]))
          : [...(body.modules ?? [])];
        const enabledProfileIds = profilesForModules(nextModules, state.ecosystemCatalog);
        const createdFiles: string[] = [];
        for (const modId of nextModules) {
          const mod = state.ecosystemCatalog.find((m) => m.id === modId);
          const entryFile = mod?.entryFile ?? `ecosystem/${modId.replace(/-/g, "_")}.tsx`;
          if (!files.has(entryFile)) {
            files.set(entryFile, `// generated ${modId}\nexport const MODULE = "${modId}";\n`);
            createdFiles.push(entryFile);
          }
        }
        const updatedFiles = createdFiles.length > 0 ? ["pocket.json"] : [];
        projectMap.set(project, {
          ...p,
          ecosystemModules: nextModules,
          enabledProfiles: enabledProfileIds,
        });
        state.revision += 1;
        return {
          modules: nextModules,
          enabledProfileIds,
          enabledProfiles: enabledProfileIds,
          createdFiles,
          updatedFiles,
          removedFiles: [...prevModules].filter((m) => !nextModules.includes(m)),
          entryWired: nextModules.length > 0,
          status: status(project),
        };
      },
    },
    cos: {
      get: async (project: string): Promise<CosSnapshot> => {
        record("cos.get", project);
        const snap = getCos(project);
        return JSON.parse(JSON.stringify(snap));
      },
      set: async (project: string, patch: CosSetInput): Promise<CosSnapshot> => {
        record("cos.set", project, patch);
        const snap = getCos(project);
        if (patch.enabled !== undefined) snap.config.enabled = patch.enabled;
        if (patch.syncOnPublish !== undefined) snap.config.syncOnPublish = patch.syncOnPublish;
        if (patch.bucket !== undefined) snap.config.bucket = patch.bucket;
        if (patch.region !== undefined) snap.config.region = patch.region;
        if (patch.keyPrefix !== undefined) snap.config.keyPrefix = patch.keyPrefix;
        if (patch.publicBaseUrl !== undefined) snap.config.publicBaseUrl = patch.publicBaseUrl;
        if ("credentials" in patch) {
          if (patch.credentials === null) {
            snap.local.hasWorkspaceCredentials = false;
            snap.local.source = "coscli";
            snap.local.sourceDetail = "~/.cos.yaml";
            snap.local.maskedSecretId = "AKID12****7890";
          } else if (patch.credentials && typeof patch.credentials === "object") {
            snap.local.available = true;
            snap.local.hasWorkspaceCredentials = true;
            snap.local.source = "workspace";
            snap.local.sourceDetail = "Studio 本机密钥库 (0600)";
            snap.local.maskedSecretId = maskSecretId(patch.credentials.secretId);
          }
        }
        // Never leak secretKey or securityToken in the returned snapshot
        return JSON.parse(JSON.stringify(snap));
      },
      check: async (project: string, draft?: CosCheckInput): Promise<CosCheckResult> => {
        record("cos.check", project, draft);
        if (state.cosCheckError) throw state.cosCheckError;
        const snap = getCos(project);
        const bucket = draft?.bucket?.trim() || snap.config.bucket || snap.local.defaultBucket?.bucket || "pocket-ota-1250000001";
        const region = draft?.region?.trim() || snap.config.region || snap.local.defaultBucket?.region || "ap-guangzhou";
        const keyPrefix = draft?.keyPrefix?.trim() ?? snap.config.keyPrefix;
        const publicBaseUrl = draft?.publicBaseUrl?.trim() ?? snap.config.publicBaseUrl;
        return {
          ok: true,
          bucket,
          region,
          keyPrefix,
          publicBaseUrl,
          source: snap.local.source,
          sourceDetail: snap.local.sourceDetail,
          maskedSecretId: snap.local.maskedSecretId ?? "AKID12****7890",
          checkedAt: "2026-11-17T12:00:00.000Z",
        };
      },
      publish: async (project: string, channel: "test" | "release" = "test"): Promise<CosPublishResult> => {
        record("cos.publish", project, channel);
        const snap = getCos(project);
        const p = ensureProject(project);
        const slot = channel === "release" ? "stable" : "test";
        const bucket = snap.config.bucket || snap.local.defaultBucket?.bucket || "pocket-ota-1250000001";
        const region = snap.config.region || snap.local.defaultBucket?.region || "ap-guangzhou";
        const base = snap.config.publicBaseUrl || `https://${bucket}.cos.${region}.myqcloud.com`;
        const prefix = snap.config.keyPrefix ? `${snap.config.keyPrefix}/` : "";
        const ver = channel === "release" ? p.version : `${p.version}-test.${p.build}`;
        const summary: CosPublishSummary = {
          slot,
          version: ver,
          build: p.build,
          uploadedFiles: 4,
          skippedFiles: 2,
          appConfigUrl: `${base}/${prefix}${slot}/${p.appId}/host.json`,
          manifestUrl: `${base}/${prefix}${slot}/${p.appId}/latest.json`,
          publishedAt: "2026-11-17T12:05:00.000Z",
        };
        snap.published = { ...(snap.published ?? {}), [slot]: summary };
        return {
          ok: true,
          cosPublish: summary,
          status: status(project),
          cos: JSON.parse(JSON.stringify(snap)),
        };
      },
    },
    fs: {
      tree: async (p: string, assets?: boolean) => {
        record("tree", p, assets);
        return {
          files: [...files].map(([path, t]) => ({ path, bytes: new TextEncoder().encode(t).length })),
          revision: state.revision,
          assets: ["a.png"],
        };
      },
      readText: async (p: string, path: string, max?: number, known?: number) => {
        record("readText", p, path, max, known);
        const t = files.get(path);
        if (t === undefined) throw notFound("studio.fs.read");
        return { text: t, bytes: new TextEncoder().encode(t).length };
      },
      writeText: async (p: string, path: string, text: string) => {
        record("writeText", p, path, text);
        if (state.failWrites) throw new StudioError("studio.fs.write", "service_error", "disk full (HTTP 500)");
        files.set(path, text);
        state.revision += 1;
        return { path, bytes: new TextEncoder().encode(text).length, revision: state.revision };
      },
      rename: async (p: string, from: string, to: string) => {
        record("rename", p, from, to);
        const t = files.get(from);
        if (t === undefined) throw notFound("rename");
        files.delete(from);
        files.set(to, t);
        state.revision += 1;
        return { from, to, revision: state.revision };
      },
      delete: async (p: string, path: string) => {
        record("delete", p, path);
        if (!files.delete(path)) throw notFound("delete");
        state.revision += 1;
        return { path, revision: state.revision };
      },
      mkdir: async (p: string, path: string) => {
        record("mkdir", p, path);
        return { path, created: true, revision: ++state.revision };
      },
      rmdir: async (p: string, path: string) => {
        record("rmdir", p, path);
        return { path, revision: ++state.revision };
      },
      stat: async (p: string, path: string) => {
        record("stat", p, path);
        return { path, kind: "file" as const, bytes: 10, mtimeMs: 1, editable: false };
      },
      watch: (p: string, onEvent: (e: WatchEvent) => void, onError?: (e: StudioError) => void, onEnd?: () => void) => {
        record("watch", p);
        const s = sub(watchers, { onEvent, onError: onError ?? (() => {}), onEnd: onEnd ?? (() => {}) });
        onEvent({ type: "ready", revision: state.revision });
        return s;
      },
    },
    build: {
      start: async (p: string) => {
        record("build.start", p);
        state.busy = true;
        state.error = undefined;
        state.diagnostics = [];
        state.startBuildHook?.();
        return status(p);
      },
      cancel: async (p: string) => {
        record("build.cancel", p);
        return { cancelled: true, status: status(p) };
      },
      status: async (p: string) => {
        record("build.status", p);
        return status(p);
      },
      events: (p: string, onEvent: (e: WatchEvent) => void, onError?: (e: StudioError) => void, onEnd?: () => void) => {
        record("build.events", p);
        const s = sub(buildStreams, { onEvent, onError: onError ?? (() => {}), onEnd: onEnd ?? (() => {}) });
        onEvent({ type: "status", status: status(p) } as WatchEvent);
        return s;
      },
    },
    preview: {
      publish: async (p: string) => {
        record("publish", p);
        if (state.publishError) throw state.publishError;
        if (state.builtRevision !== state.revision) {
          throw new StudioError("studio.preview.publish", "conflict", "build the current source first (HTTP 409)");
        }
        return { version: `0.1.0-preview.${++state.previewBuild}`, build: state.previewBuild };
      },
      devices: async () => ({ devices: [] }),
      deploy: async () => ({}),
      deployStatus: async () => ({}),
      deployCancel: async () => ({}),
    },
    publish: {
      plan: async (p: string, channel: "test" | "release" = "test") => {
        record("publish.plan", p, channel);
        const proj = ensureProject(p);
        const built = !state.busy && !state.error && state.builtRevision !== null && state.builtRevision === state.revision;
        return {
          targets: [
            {
              kind: "root",
              appId: proj.appId,
              title: proj.title,
              version: proj.version,
              build: proj.build,
              built,
              busy: state.busy,
              canPublish: built,
            },
          ],
        };
      },
      publish: async (p: string, channel: "test" | "release" = "test"): Promise<PublishResult> => {
        record("publish.publish", p, channel);
        if (state.publishError) throw state.publishError;
        const proj = ensureProject(p);
        const slot = channel === "release" ? "stable" : "test";
        const buildNum = proj.build;
        const version = channel === "release" ? proj.version : `${proj.version}-test.${buildNum}`;
        const snap = getCos(p);
        let cosPublish: CosPublishSummary | undefined;
        let cosError: string | undefined;
        if (snap.config.enabled && snap.config.syncOnPublish) {
          if (state.publishCosError) {
            cosError = state.publishCosError;
          } else {
            const bucket = snap.config.bucket || snap.local.defaultBucket?.bucket || "pocket-ota-1250000001";
            const region = snap.config.region || snap.local.defaultBucket?.region || "ap-guangzhou";
            const base = snap.config.publicBaseUrl || `https://${bucket}.cos.${region}.myqcloud.com`;
            const prefix = snap.config.keyPrefix ? `${snap.config.keyPrefix}/` : "";
            cosPublish = {
              slot,
              version,
              build: buildNum,
              uploadedFiles: 5,
              skippedFiles: 1,
              appConfigUrl: `${base}/${prefix}${slot}/${proj.appId}/host.json`,
              manifestUrl: `${base}/${prefix}${slot}/${proj.appId}/latest.json`,
              publishedAt: "2026-11-17T12:10:00.000Z",
            };
            snap.published = { ...(snap.published ?? {}), [slot]: cosPublish };
          }
        }
        return {
          status: {
            ...status(p),
            publish: {
              channel,
              version,
              build: buildNum,
              revision: state.revision,
              keyId: `editor-${p}`,
              runtimeAbi: "quickjs-bytecode-v1",
              payloadSha256: "a".repeat(64),
              releaseId: `${p}-${slot}-${buildNum}`,
              publishedAt: "2026-11-17T12:10:00.000Z",
              packages: [{ id: proj.appId, version, build: buildNum }],
            },
          },
          manifestUrl: `http://127.0.0.1:8795/${slot}/pocket/studio/${proj.appId}/${version}/latest.json`,
          hostConfigUrl: `http://127.0.0.1:8795/${slot}/pocket/studio/${proj.appId}/${version}/host.json`,
          appConfigUrl: `http://127.0.0.1:8795/${slot}/pocket/studio/${proj.appId}/latest.json`,
          archiveUrl: `/releases/${p}.tar.gz`,
          packages: [{ id: proj.appId, version, build: buildNum }],
          ...(cosPublish ? { cosPublish } : {}),
          ...(cosError ? { cosError } : {}),
        };
      },
      history: async (p: string) => {
        record("publish.history", p);
        return { origin: "http://127.0.0.1:8795", slots: [], history: [] };
      },
      offline: async (p: string) => {
        record("publish.offline", p);
        return { archiveUrl: `/releases/${p}-offline.tar.gz`, filename: `${p}-offline.tar.gz` };
      },
    },
    artifacts: {
      list: async (p: string) => {
        record("artifacts.list", p);
        return { revision: state.revision, builtRevision: state.builtRevision };
      },
      inspect: async (p: string, name: string) => {
        record("artifacts.inspect", p, name);
        return { name, bytes: 0, encoding: "utf8" as const, data: "{}" };
      },
    },
    logs: {
      tail: async (p: string) => {
        record("logs.tail", p);
        return { logs: [...state.logs], error: state.error ?? null };
      },
      diagnostics: async (p: string, kind?: "log" | "crash") => {
        record("logs.diagnostics", p, kind);
        return {
          exportId: `diag-${p}`,
          project: p,
          ...(kind ? { kind } : {}),
          totalRecords: 0,
          logCount: 0,
          crashCount: 0,
          keptRecords: 0,
          omitted: 0,
          truncated: false,
          records: [],
          downloadUrl: `http://127.0.0.1:8791/api/projects/${p}/diagnostics?download=1`,
        };
      },
    },
    service: {
      health: async () => {
        record("service.health");
        return { ok: true, service: "pocket-editor", version: state.sdkUpgrade.currentVersion };
      },
      upgradeStatus: async (): Promise<SdkUpgradePayload> => {
        record("service.upgradeStatus");
        const u = state.sdkUpgrade;
        return {
          currentVersion: u.currentVersion,
          latestVersion: u.latestVersion,
          targetVersion: u.targetVersion,
          mode: u.mode,
          modeReason: u.modeReason,
          platformTuple: u.platformTuple,
          autoUpgradeSupported: u.autoUpgradeSupported,
          status: u.status,
          upgradeAvailable: u.upgradeAvailable,
          releaseUrl: u.releaseUrl,
          downloadedBytes: u.downloadedBytes,
          downloadTotalBytes: u.downloadTotalBytes,
          checkedAt: u.checkedAt,
          appliedAt: u.appliedAt,
          deferredReason: u.deferredReason,
          error: u.error,
          rolledBack: u.rolledBack,
        };
      },
      upgradeCheck: async (): Promise<SdkUpgradePayload> => {
        record("service.upgradeCheck");
        const u = state.sdkUpgrade;
        u.latestVersion = u.latestVersion && u.latestVersion !== u.currentVersion ? u.latestVersion : "0.2.0";
        u.upgradeAvailable = u.latestVersion !== u.currentVersion;
        u.status = u.upgradeAvailable ? "available" : "up-to-date";
        return client.service.upgradeStatus();
      },
      upgradeApply: async (): Promise<SdkUpgradePayload> => {
        record("service.upgradeApply");
        const u = state.sdkUpgrade;
        if (u.mode === "source") {
          throw new StudioError("studio.service.upgrade.apply", "conflict", "当前为源码检出模式，仅支持检查新版本，禁止自动覆盖 Git 工作区 (HTTP 409)");
        }
        if (u.applyMode === "defer_409") {
          throw new StudioError("studio.service.upgrade.apply", "conflict", `${u.deferMessage} (HTTP 409)`);
        }
        if (u.applyMode === "defer_200") {
          u.status = "available";
          u.upgradeAvailable = true;
          u.deferredReason = u.deferMessage;
          return client.service.upgradeStatus();
        }
        u.status = "restarting";
        u.targetVersion = u.latestVersion ?? "0.2.0";
        u.deferredReason = null;
        return client.service.upgradeStatus();
      },
    },
  } as unknown as StudioClient;

  /** Finishes the running build the way the service does: status, then done. */
  const finishBuild = (ok: boolean, diagnostics: unknown[] = []) => {
    state.busy = false;
    if (ok) {
      state.builtRevision = state.revision;
      state.error = undefined;
      state.diagnostics = [];
    } else {
      state.error = "build failed";
      state.diagnostics = diagnostics;
    }
    for (const h of [...buildStreams]) {
      h.onEvent({ type: "status", status: status() } as WatchEvent);
      h.onEvent({ type: "done", ok, builtRevision: state.builtRevision, diagnostics } as WatchEvent);
    }
  };

  return {
    client,
    files,
    projectMap,
    cosMap,
    getCos,
    calls,
    state,
    watchers,
    buildStreams,
    finishBuild,
    count: (name: string) => calls.filter((c) => c.name === name).length,
    emitWatch: (e: WatchEvent) => { for (const h of [...watchers]) h.onEvent(e); },
    emitBuild: (e: unknown) => { for (const h of [...buildStreams]) h.onEvent(e as WatchEvent); },
    dropWatch: () => { for (const h of [...watchers]) h.onEnd(); },
    errorBuildStream: () => { for (const h of [...buildStreams]) h.onError(new StudioError("studio.build.events", "plugin_stream_quota", "stream quota")); },
    external: (path: string, text: string | undefined) => {
      if (text === undefined) files.delete(path);
      else files.set(path, text);
      state.revision += 1;
      for (const h of [...watchers]) h.onEvent({ type: "change", path, kind: "file", event: "change" });
    },
  };
}
export const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
