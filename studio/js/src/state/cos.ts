import { createStore } from "./store.ts";
import type { Dialogs } from "./dialogs.ts";
import type { Toasts } from "./toasts.ts";
import { errorText } from "./workspace.ts";
import { asRecord, list, num, str } from "../lib/format.ts";
import type {
  CosBucketInfo,
  CosCheckResult,
  CosConfig,
  CosLocalInfo,
  CosPublishSummary,
  CosSnapshot,
  StudioClient,
} from "../studio-client.ts";

export const EMPTY_COS_CONFIG: CosConfig = {
  enabled: false,
  syncOnPublish: false,
  bucket: "",
  region: "",
  keyPrefix: "",
  publicBaseUrl: "",
};

const EMPTY_LOCAL_INFO: CosLocalInfo = {
  available: false,
  source: "none",
  discoveredBuckets: [],
};

export function cosSourceLabel(local?: CosLocalInfo): string {
  if (!local || !local.available) {
    return "未检测到本机密钥（可配置 ~/.cos.yaml、~/.cos.conf、环境变量或手动输入）";
  }
  const masked = local.maskedSecretId ? ` · ${local.maskedSecretId}` : "";
  if (local.source === "coscli") return `已从 coscli (~/.cos.yaml) 加载${masked}`;
  if (local.source === "coscmd") return `已从 coscmd (~/.cos.conf) 加载${masked}`;
  if (local.source === "env") return `已从环境变量加载${masked}`;
  if (local.source === "workspace") return `已从 Studio 本机密钥库加载${masked}`;
  return `${local.sourceDetail || "已检测到本机密钥"}${masked}`;
}

export function normalizeCosSummary(raw: unknown): CosPublishSummary | undefined {
  const r = asRecord(raw);
  if (!r) return undefined;
  const slot = str(r.slot);
  const version = str(r.version);
  const build = num(r.build);
  const uploadedFiles = num(r.uploadedFiles);
  const skippedFiles = num(r.skippedFiles);
  const appConfigUrl = str(r.appConfigUrl);
  const manifestUrl = str(r.manifestUrl);
  const publishedAt = str(r.publishedAt);
  if (
    !slot &&
    !version &&
    build === undefined &&
    uploadedFiles === undefined &&
    skippedFiles === undefined &&
    !appConfigUrl &&
    !manifestUrl
  ) {
    return undefined;
  }
  return {
    ...(slot ? { slot } : {}),
    ...(version ? { version } : {}),
    ...(build !== undefined ? { build } : {}),
    ...(uploadedFiles !== undefined ? { uploadedFiles } : {}),
    ...(skippedFiles !== undefined ? { skippedFiles } : {}),
    ...(appConfigUrl ? { appConfigUrl } : {}),
    ...(manifestUrl ? { manifestUrl } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

export function normalizeCosSnapshot(raw: unknown): CosSnapshot {
  const r = asRecord(raw) ?? {};
  const localRaw = asRecord(r.local) ?? {};
  const cfgRaw = asRecord(r.config) ?? {};
  const pubRaw = asRecord(r.published) ?? {};

  const discoveredBuckets: CosBucketInfo[] = list(localRaw.discoveredBuckets).flatMap((item): CosBucketInfo[] => {
    const b = asRecord(item);
    const bucket = str(b?.bucket);
    const region = str(b?.region);
    if (!bucket || !region) return [];
    return [{
      bucket,
      region,
      ...(str(b?.endpoint) ? { endpoint: str(b?.endpoint)! } : {}),
      ...(str(b?.alias) ? { alias: str(b?.alias)! } : {}),
    }];
  });

  const defRaw = asRecord(localRaw.defaultBucket);
  const defaultBucket = str(defRaw?.bucket) && str(defRaw?.region)
    ? { bucket: str(defRaw?.bucket)!, region: str(defRaw?.region)! }
    : undefined;

  const local: CosLocalInfo = {
    available: localRaw.available === true,
    source: str(localRaw.source) ?? "none",
    ...(str(localRaw.sourceDetail) ? { sourceDetail: str(localRaw.sourceDetail)! } : {}),
    ...(str(localRaw.maskedSecretId) ? { maskedSecretId: str(localRaw.maskedSecretId)! } : {}),
    ...(typeof localRaw.hasWorkspaceCredentials === "boolean" ? { hasWorkspaceCredentials: localRaw.hasWorkspaceCredentials } : {}),
    discoveredBuckets,
    ...(defaultBucket ? { defaultBucket } : {}),
  };

  const config: CosConfig = {
    enabled: cfgRaw.enabled === true,
    syncOnPublish: cfgRaw.syncOnPublish === true,
    bucket: str(cfgRaw.bucket) ?? "",
    region: str(cfgRaw.region) ?? "",
    keyPrefix: str(cfgRaw.keyPrefix) ?? "",
    publicBaseUrl: str(cfgRaw.publicBaseUrl) ?? "",
  };

  const testPub = normalizeCosSummary(pubRaw.test);
  const stablePub = normalizeCosSummary(pubRaw.stable);

  return {
    local,
    config,
    ...(testPub || stablePub
      ? {
          published: {
            ...(testPub ? { test: testPub } : {}),
            ...(stablePub ? { stable: stablePub } : {}),
          },
        }
      : {}),
  };
}

const sameConfig = (a: CosConfig, b: CosConfig): boolean =>
  a.enabled === b.enabled &&
  a.syncOnPublish === b.syncOnPublish &&
  a.bucket.trim() === b.bucket.trim() &&
  a.region.trim() === b.region.trim() &&
  a.keyPrefix.trim() === b.keyPrefix.trim() &&
  a.publicBaseUrl.trim() === b.publicBaseUrl.trim();

export interface CosState {
  loading: boolean;
  saving: boolean;
  checking: boolean;
  publishing: boolean;
  error?: string;
  project?: string;
  snapshot?: CosSnapshot;
  draft: CosConfig;
  secretIdInput: string;
  secretKeyInput: string;
  securityTokenInput: string;
  dirty: boolean;
  checkResult?: CosCheckResult;
  lastCosPublish?: CosPublishSummary;
}

export function createCosState(deps: {
  client: StudioClient;
  toasts: Toasts;
  dialogs: Dialogs;
  onPublished?: () => void;
}) {
  const { client, toasts, dialogs } = deps;
  const store = createStore<CosState>({
    loading: false,
    saving: false,
    checking: false,
    publishing: false,
    draft: { ...EMPTY_COS_CONFIG },
    secretIdInput: "",
    secretKeyInput: "",
    securityTokenInput: "",
    dirty: false,
  });
  const state = () => store.get();
  let epoch = 0;

  function draftFromSnapshot(snap: CosSnapshot): CosConfig {
    const cfg = snap.config;
    const def = snap.local.defaultBucket;
    return {
      enabled: cfg.enabled,
      syncOnPublish: cfg.syncOnPublish,
      bucket: cfg.bucket || def?.bucket || "",
      region: cfg.region || def?.region || "",
      keyPrefix: cfg.keyPrefix,
      publicBaseUrl: cfg.publicBaseUrl,
    };
  }

  async function load(project: string | undefined = state().project): Promise<void> {
    if (!project) {
      unload();
      return;
    }
    const mine = ++epoch;
    store.update({ project, loading: true, error: undefined });
    try {
      const raw = await client.cos.get(project);
      if (mine !== epoch) return;
      const snapshot = normalizeCosSnapshot(raw);
      const draft = draftFromSnapshot(snapshot);
      const pub = snapshot.published;
      const latestPub = pub?.test && pub?.stable
        ? (String(pub.test.publishedAt ?? "") >= String(pub.stable.publishedAt ?? "") ? pub.test : pub.stable)
        : (pub?.test ?? pub?.stable ?? state().lastCosPublish);
      store.update({
        loading: false,
        error: undefined,
        snapshot,
        draft,
        dirty: !sameConfig(draft, snapshot.config),
        ...(latestPub ? { lastCosPublish: latestPub } : {}),
      });
    } catch (error) {
      if (mine !== epoch) return;
      store.update({ loading: false, error: errorText(error) });
    }
  }

  function unload(): void {
    epoch += 1;
    store.set({
      loading: false,
      saving: false,
      checking: false,
      publishing: false,
      draft: { ...EMPTY_COS_CONFIG },
      secretIdInput: "",
      secretKeyInput: "",
      securityTokenInput: "",
      dirty: false,
    });
  }

  function patchDraft(partial: Partial<CosConfig>): void {
    const nextDraft: CosConfig = {
      ...state().draft,
      ...partial,
    };
    const baseline = state().snapshot?.config ?? EMPTY_COS_CONFIG;
    store.update({
      draft: nextDraft,
      dirty: !sameConfig(nextDraft, baseline),
      error: undefined,
    });
  }

  function pickDiscoveredBucket(bucket: string, region: string): void {
    patchDraft({ bucket, region });
  }

  function setCredentialInputs(patch: { secretId?: string; secretKey?: string; securityToken?: string }): void {
    store.update({
      ...(patch.secretId !== undefined ? { secretIdInput: patch.secretId } : {}),
      ...(patch.secretKey !== undefined ? { secretKeyInput: patch.secretKey } : {}),
      ...(patch.securityToken !== undefined ? { securityTokenInput: patch.securityToken } : {}),
      error: undefined,
    });
  }

  async function saveConfig(): Promise<CosSnapshot | undefined> {
    const project = state().project;
    if (!project || state().saving) return undefined;
    const d = state().draft;
    const secretId = state().secretIdInput.trim();
    const secretKey = state().secretKeyInput.trim();
    const securityToken = state().securityTokenInput.trim();
    const local = state().snapshot?.local ?? EMPTY_LOCAL_INFO;
    if (d.enabled && (!d.bucket.trim() || !d.region.trim() || (!local.available && !(secretId && secretKey)))) {
      const msg = "开启 COS 发布前，请先确认本机密钥并填写存储桶（Bucket-APPID）与地域（Region）。";
      store.update({ error: msg });
      toasts.warning(msg);
      return undefined;
    }
    const mine = epoch;
    store.update({ saving: true, error: undefined });
    try {
      const payload = {
        enabled: d.enabled,
        syncOnPublish: d.syncOnPublish,
        bucket: d.bucket.trim(),
        region: d.region.trim(),
        keyPrefix: d.keyPrefix.trim(),
        publicBaseUrl: d.publicBaseUrl.trim(),
        ...(secretId && secretKey
          ? {
              credentials: {
                secretId,
                secretKey,
                ...(securityToken ? { securityToken } : {}),
              },
            }
          : {}),
      };
      const raw = await client.cos.set(project, payload);
      store.update({
        secretIdInput: "",
        secretKeyInput: "",
        securityTokenInput: "",
      });
      if (mine !== epoch || state().project !== project) return undefined;
      const snapshot = normalizeCosSnapshot(raw);
      const draft = draftFromSnapshot(snapshot);
      store.update({
        saving: false,
        snapshot,
        draft,
        dirty: false,
      });
      toasts.success("腾讯云 COS 配置已保存。");
      return snapshot;
    } catch (error) {
      if (mine !== epoch) return undefined;
      const msg = errorText(error);
      store.update({ saving: false, error: msg });
      toasts.error(`保存 COS 配置失败：${msg}`);
      return undefined;
    }
  }

  async function saveWorkspaceCredentials(): Promise<CosSnapshot | undefined> {
    const project = state().project;
    if (!project || state().saving) return undefined;
    const secretId = state().secretIdInput.trim();
    const secretKey = state().secretKeyInput.trim();
    const securityToken = state().securityTokenInput.trim();
    if (!secretId || !secretKey) {
      const msg = "请填写 SecretId 和 SecretKey。";
      store.update({ error: msg });
      toasts.warning(msg);
      return undefined;
    }
    const d = state().draft;
    const mine = epoch;
    store.update({ saving: true, error: undefined });
    try {
      const raw = await client.cos.set(project, {
        enabled: d.enabled,
        syncOnPublish: d.syncOnPublish,
        bucket: d.bucket.trim(),
        region: d.region.trim(),
        keyPrefix: d.keyPrefix.trim(),
        publicBaseUrl: d.publicBaseUrl.trim(),
        credentials: {
          secretId,
          secretKey,
          ...(securityToken ? { securityToken } : {}),
        },
      });
      // Always clear sensitive inputs immediately after save!
      store.update({
        secretIdInput: "",
        secretKeyInput: "",
        securityTokenInput: "",
      });
      if (mine !== epoch || state().project !== project) return undefined;
      const snapshot = normalizeCosSnapshot(raw);
      const draft = draftFromSnapshot(snapshot);
      store.update({
        saving: false,
        snapshot,
        draft,
        dirty: false,
      });
      toasts.success("已保存工作区 COS 凭据（0600 权限）。");
      return snapshot;
    } catch (error) {
      if (mine !== epoch) return undefined;
      const msg = errorText(error);
      store.update({ saving: false, error: msg });
      toasts.error(`保存工作区凭据失败：${msg}`);
      return undefined;
    }
  }

  async function clearWorkspaceCredentials(): Promise<CosSnapshot | undefined> {
    const project = state().project;
    if (!project || state().saving) return undefined;
    const d = state().draft;
    const mine = epoch;
    store.update({ saving: true, error: undefined });
    try {
      const raw = await client.cos.set(project, {
        enabled: d.enabled,
        syncOnPublish: d.syncOnPublish,
        bucket: d.bucket.trim(),
        region: d.region.trim(),
        keyPrefix: d.keyPrefix.trim(),
        publicBaseUrl: d.publicBaseUrl.trim(),
        credentials: null,
      });
      if (mine !== epoch || state().project !== project) return undefined;
      const snapshot = normalizeCosSnapshot(raw);
      const draft = draftFromSnapshot(snapshot);
      store.update({
        saving: false,
        snapshot,
        draft,
        dirty: false,
        secretIdInput: "",
        secretKeyInput: "",
        securityTokenInput: "",
      });
      toasts.info("已清除 Studio 保存的本机 COS 密钥。");
      return snapshot;
    } catch (error) {
      if (mine !== epoch) return undefined;
      const msg = errorText(error);
      store.update({ saving: false, error: msg });
      toasts.error(`清除工作区凭据失败：${msg}`);
      return undefined;
    }
  }

  async function checkConnection(): Promise<CosCheckResult | undefined> {
    const project = state().project;
    if (!project || state().checking) return undefined;
    const d = state().draft;
    const mine = epoch;
    store.update({ checking: true, error: undefined, checkResult: undefined });
    try {
      const res = asRecord(await client.cos.check(project, {
        bucket: d.bucket.trim(),
        region: d.region.trim(),
        keyPrefix: d.keyPrefix.trim(),
        publicBaseUrl: d.publicBaseUrl.trim(),
      })) ?? {};
      if (mine !== epoch || state().project !== project) return undefined;
      const checkResult: CosCheckResult = {
        ok: res.ok !== false,
        ...(str(res.bucket) ? { bucket: str(res.bucket)! } : d.bucket.trim() ? { bucket: d.bucket.trim() } : {}),
        ...(str(res.region) ? { region: str(res.region)! } : d.region.trim() ? { region: d.region.trim() } : {}),
        ...(str(res.keyPrefix) ? { keyPrefix: str(res.keyPrefix)! } : {}),
        ...(str(res.publicBaseUrl) ? { publicBaseUrl: str(res.publicBaseUrl)! } : {}),
        ...(str(res.source) ? { source: str(res.source)! } : {}),
        ...(str(res.sourceDetail) ? { sourceDetail: str(res.sourceDetail)! } : {}),
        ...(str(res.maskedSecretId) ? { maskedSecretId: str(res.maskedSecretId)! } : {}),
        ...(str(res.checkedAt) ? { checkedAt: str(res.checkedAt)! } : {}),
      };
      store.update({ checking: false, checkResult });
      toasts.success(`腾讯云 COS 连接验证成功：${checkResult.bucket ?? ""} (${checkResult.region ?? ""})。`);
      return checkResult;
    } catch (error) {
      if (mine !== epoch) return undefined;
      const msg = errorText(error);
      store.update({ checking: false, error: msg, checkResult: { ok: false } });
      toasts.error(`验证 COS 连接失败：${msg}`);
      return undefined;
    }
  }

  async function publishChannel(channel: "test" | "release"): Promise<CosPublishSummary | undefined> {
    const project = state().project;
    if (!project || state().publishing) return undefined;
    const mine = epoch;
    const label = channel === "release" ? "稳定版" : "测试版";
    if (channel === "release") {
      const ok = await dialogs.confirm({
        title: "上传稳定版到腾讯云 COS？",
        body: `将把 ${project} 的稳定版签名产物同步上传到腾讯云 COS（${state().draft.bucket || "当前配置存储桶"}），并更新云端稳定版 latest.json 与 host.json。`,
        confirmLabel: "上传稳定版到 COS",
        cancelLabel: "取消",
        tone: "danger",
      });
      if (!ok || mine !== epoch) return undefined;
    }
    store.update({ publishing: true, error: undefined });
    try {
      const res = asRecord(await client.cos.publish(project, channel)) ?? {};
      if (mine !== epoch || state().project !== project) return undefined;
      const summary = normalizeCosSummary(res.cosPublish) ?? { slot: channel === "release" ? "stable" : "test" };
      const snapshot = res.cos ? normalizeCosSnapshot(res.cos) : state().snapshot;
      const nextSnapshot: CosSnapshot | undefined = snapshot
        ? {
            ...snapshot,
            published: {
              ...(snapshot.published ?? {}),
              [channel === "release" ? "stable" : "test"]: summary,
            },
          }
        : undefined;
      store.update({
        publishing: false,
        ...(nextSnapshot ? { snapshot: nextSnapshot, draft: draftFromSnapshot(nextSnapshot), dirty: false } : {}),
        lastCosPublish: summary,
      });
      toasts.success(
        summary.version
          ? `已上传${label} v${summary.version} 到腾讯云 COS（上传 ${summary.uploadedFiles ?? 0} 个文件，复用 ${summary.skippedFiles ?? 0} 个文件）。`
          : `已上传${label}到腾讯云 COS。`,
      );
      deps.onPublished?.();
      return summary;
    } catch (error) {
      if (mine !== epoch) return undefined;
      const msg = errorText(error);
      store.update({ publishing: false, error: msg });
      toasts.error(`上传${label}到 COS 失败：${msg}`);
      return undefined;
    }
  }

  function syncFromPublish(cosPublish?: CosPublishSummary): void {
    if (!cosPublish) return;
    const summary = normalizeCosSummary(cosPublish);
    if (!summary) return;
    const slotKey = summary.slot === "stable" || summary.slot === "release" ? "stable" : "test";
    const curSnap = state().snapshot;
    store.update({
      lastCosPublish: summary,
      ...(curSnap
        ? {
            snapshot: {
              ...curSnap,
              published: {
                ...(curSnap.published ?? {}),
                [slotKey]: summary,
              },
            },
          }
        : {}),
    });
  }

  return {
    store,
    state,
    load,
    unload,
    reset: unload,
    patchDraft,
    pickDiscoveredBucket,
    setCredentialInputs,
    saveConfig,
    saveWorkspaceCredentials,
    clearWorkspaceCredentials,
    checkConnection,
    publishChannel,
    syncFromPublish,
  };
}

export type CosStateManager = ReturnType<typeof createCosState>;
export type CosStore = CosStateManager;
