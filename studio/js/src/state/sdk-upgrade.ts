// SDK upgrade (the web Studio's "Studio 版本与自升级" bar): the editor SERVICE's SDK checkout/installation, not this
// guest. (The guest updates itself through the signed OTA path in self-update.ts; the two are separate panels.)
//
//   load   -> studio.service.upgrade.status   no network
//   check  -> studio.service.upgrade.check    asks the release feed; the provider never lets a check apply
//   apply  -> studio.service.upgrade.apply    only after a confirmation (and the unsaved-edit prompt)
//
// A source checkout only reports: the service answers apply with HTTP 409 and that text is shown as is. A standalone
// install downloads, verifies and replaces its files and restarts the service; the Studio then polls the service
// health until it reports the new version again (the service is unreachable for a moment, which is expected).
import { createStore } from "./store.ts";
import type { Timers } from "./env.ts";
import type { Toasts } from "./toasts.ts";
import type { Dialogs } from "./dialogs.ts";
import { errorText } from "./workspace.ts";
import { asRecord, num, str } from "../lib/format.ts";
import type { StudioClient } from "../studio-client.ts";

export interface UpgradeInfo {
  currentVersion?: string;
  latestVersion?: string;
  targetVersion?: string;
  mode: "standalone" | "source" | "unknown";
  modeReason?: string;
  platform?: string;
  autoUpgradeSupported: boolean;
  /** The service's own status word: idle, checking, available, up-to-date, downloading, applying, restarting, error. */
  status: string;
  upgradeAvailable: boolean;
  releaseUrl?: string;
  downloadedBytes?: number;
  downloadTotalBytes?: number;
  checkedAt?: string;
  appliedAt?: string;
  deferredReason?: string;
  error?: string;
  rolledBack: boolean;
}

export type UpgradePhase = "idle" | "loading" | "checking" | "applying" | "restarting" | "error";
export interface SdkUpgradeState {
  phase: UpgradePhase;
  info?: UpgradeInfo;
  /** An outcome the user should read (409 refusal, deferral, restart result). */
  notice?: { tone: "ok" | "warn" | "danger" | "info"; text: string };
}

export function toUpgradeInfo(value: unknown): UpgradeInfo {
  const r = asRecord(value) ?? {};
  const mode = r.mode === "standalone" || r.mode === "source" ? r.mode : "unknown";
  const autoUpgradeSupported = typeof r.autoUpgradeSupported === "boolean"
    ? r.autoUpgradeSupported
    : mode === "standalone";
  return {
    ...(str(r.currentVersion) ? { currentVersion: str(r.currentVersion)! } : {}),
    ...(str(r.latestVersion) ? { latestVersion: str(r.latestVersion)! } : {}),
    ...(str(r.targetVersion) ? { targetVersion: str(r.targetVersion)! } : {}),
    mode,
    ...(str(r.modeReason) ? { modeReason: str(r.modeReason)! } : {}),
    ...(str(r.platformTuple) ? { platform: str(r.platformTuple)! } : {}),
    autoUpgradeSupported,
    status: str(r.status) ?? "idle",
    upgradeAvailable: r.upgradeAvailable === true,
    ...(str(r.releaseUrl) ? { releaseUrl: str(r.releaseUrl)! } : {}),
    ...(num(r.downloadedBytes) !== undefined ? { downloadedBytes: num(r.downloadedBytes)! } : {}),
    ...(num(r.downloadTotalBytes) !== undefined ? { downloadTotalBytes: num(r.downloadTotalBytes)! } : {}),
    ...(str(r.checkedAt) ? { checkedAt: str(r.checkedAt)! } : {}),
    ...(str(r.appliedAt) ? { appliedAt: str(r.appliedAt)! } : {}),
    ...(str(r.deferredReason) ? { deferredReason: str(r.deferredReason)! } : {}),
    ...(str(r.error) ? { error: str(r.error)! } : {}),
    rolledBack: r.rolledBack === true,
  };
}

const POLL_MS = 1500;
const POLL_LIMIT = 80;

export function createSdkUpgrade(deps: {
  client: StudioClient;
  timers: Timers;
  toasts: Toasts;
  dialogs: Dialogs;
  /** Asks about unsaved work (files, project settings) before the service restarts; false cancels. */
  confirmLeave: () => Promise<boolean>;
}) {
  const { client, timers, toasts, dialogs } = deps;
  const store = createStore<SdkUpgradeState>({ phase: "idle" });
  const state = () => store.get();
  let busy = false;
  let cancelPoll: (() => void) | undefined;

  async function load(): Promise<void> {
    if (busy || state().phase === "restarting") return;
    store.update({ phase: "loading" });
    try {
      store.update({ phase: "idle", info: toUpgradeInfo(await client.service.upgradeStatus()) });
    } catch (error) {
      store.update({ phase: "error", notice: { tone: "danger", text: `无法读取升级状态：${errorText(error)}` } });
    }
  }

  async function check(): Promise<void> {
    if (busy) return;
    busy = true;
    store.update({ phase: "checking", notice: undefined });
    try {
      const info = toUpgradeInfo(await client.service.upgradeCheck());
      store.update({ phase: "idle", info, notice: noticeAfterCheck(info) });
    } catch (error) {
      const text = errorText(error);
      store.update({ phase: "error", notice: { tone: "danger", text: `检查 SDK 更新失败：${text}` } });
      toasts.error(`检查 SDK 更新失败：${text}`);
    } finally {
      busy = false;
    }
  }

  async function apply(): Promise<void> {
    const info = state().info;
    if (busy || !info?.upgradeAvailable) return;
    busy = true;
    try {
      const target = info.latestVersion ? `v${info.latestVersion}` : "新版本";
      const sure = await dialogs.confirm({
        title: `升级 SDK 到 ${target}？`,
        body: info.mode === "source"
          ? "当前是源码检出：服务仅在干净的 main 工作区中尝试 Git 事务升级；存在未提交修改、非 main 分支或正在构建/发布时会暂缓或拒绝（HTTP 409），不会强行覆盖改动。确定向服务发起升级请求吗？"
          : `服务将下载 ${target}、校验并替换 SDK 文件，然后重启；重启期间 Studio 会暂时无法连接服务。正在构建、保存或发布时服务会暂缓升级。`,
        confirmLabel: "应用升级", cancelLabel: "取消", tone: "danger",
      });
      if (!sure) return;
      let proceed = false;
      try { proceed = await deps.confirmLeave(); } catch (error) { toasts.error(`无法确认未保存的更改：${errorText(error)}`); }
      if (!proceed) return;
      store.update({ phase: "applying", notice: { tone: "info", text: "正在向服务提交升级请求…" } });
      try {
        const after = toUpgradeInfo(await client.service.upgradeApply());
        store.update({ info: after });
        if (after.deferredReason || (after.status === "available" && after.upgradeAvailable)) {
          const reason = after.deferredReason || "当前有正在执行的任务，已暂缓应用更新。";
          const nextInfo: UpgradeInfo = { ...after, deferredReason: reason };
          store.update({
            phase: "idle",
            info: nextInfo,
            notice: { tone: "warn", text: `服务已暂缓升级：${reason}` },
          });
          toasts.warning(reason);
        } else if (after.status === "up-to-date" || !after.upgradeAvailable) {
          store.update({ phase: "idle", notice: { tone: "ok", text: "已是最新版本，无需升级。" } });
        } else {
          startRestartWatch(info.currentVersion, after.targetVersion ?? after.latestVersion ?? info.latestVersion);
        }
      } catch (error) {
        const e = error as { code?: unknown; message?: unknown };
        const text = typeof e.message === "string" && e.message ? e.message : errorText(error);
        if (e.code === "conflict") {
          // Source checkout (never overwritten), or the service is busy / deferred it: the service's own words.
          const currentInfo = state().info ?? info;
          const nextInfo: UpgradeInfo = { ...currentInfo, deferredReason: text };
          store.update({
            phase: "idle",
            info: nextInfo,
            notice: { tone: "warn", text: `服务未执行升级：${text}` },
          });
          toasts.warning(text);
        } else if (e.code === "service_unreachable" || e.code === "service_timeout") {
          // The service may already be restarting: watch for the new version instead of reporting failure.
          startRestartWatch(info.currentVersion, info.latestVersion);
        } else {
          store.update({ phase: "error", notice: { tone: "danger", text: `升级失败：${text}` } });
          toasts.error(`升级失败：${text}`);
        }
      }
    } finally {
      busy = false;
    }
  }

  function startRestartWatch(previous: string | undefined, target: string | undefined): void {
    cancelPoll?.();
    store.update({ phase: "restarting", notice: { tone: "info", text: `服务正在升级${target ? `到 v${target}` : ""}并重启，Studio 会等待它重新连接…` } });
    let attempts = 0;
    const tick = async (): Promise<void> => {
      attempts += 1;
      try {
        const health = await client.service.health();
        const version = health.version;
        if (version && (target ? version === target : version !== previous)) {
          cancelPoll = undefined;
          toasts.success(`SDK 已升级到 v${version}`);
          store.update({ phase: "idle", notice: { tone: "ok", text: `SDK 已升级到 v${version}，服务已重新连接。` } });
          const info = toUpgradeInfo(await client.service.upgradeStatus().catch(() => undefined));
          store.update({ info: info.currentVersion ? info : { ...(state().info ?? info), currentVersion: version, upgradeAvailable: false, deferredReason: undefined } });
          return;
        }
      } catch { /* unreachable while restarting: keep waiting */ }
      if (attempts >= POLL_LIMIT) {
        cancelPoll = undefined;
        store.update({ phase: "error", notice: { tone: "danger", text: "等待服务升级并重启超时：请检查服务进程，或在 Web Studio 中查看升级状态。" } });
        return;
      }
      cancelPoll = timers.after(POLL_MS, () => { void tick(); });
    };
    cancelPoll = timers.after(POLL_MS, () => { void tick(); });
  }

  return { store, state, load, check, apply, dispose: () => cancelPoll?.() };
}
export type SdkUpgrade = ReturnType<typeof createSdkUpgrade>;

function noticeAfterCheck(info: UpgradeInfo): SdkUpgradeState["notice"] {
  if (info.status === "error" && info.error) return { tone: "danger", text: info.error };
  if (info.rolledBack && info.error) return { tone: "warn", text: `上次升级已回滚：${info.error}` };
  if (!info.upgradeAvailable) return { tone: "ok", text: info.mode === "source" ? "已是最新稳定版（源码检出）。" : "已是最新稳定版。" };
  if (info.mode === "source") return { tone: "warn", text: `发现新版本 v${info.latestVersion}。源码检出只检查更新，不会自动覆盖 Git 工作区；请用 git 更新。` };
  if (info.deferredReason) return { tone: "warn", text: `发现新版本 v${info.latestVersion}：${info.deferredReason}` };
  return { tone: "info", text: `发现新版本 v${info.latestVersion}。` };
}
