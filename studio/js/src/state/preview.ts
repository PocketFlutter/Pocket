// Multi-Target Simultaneous Preview Orchestration:
// Supports running Flutter native canvas, Web viewport, WeChat Mini Program (`wx.*` capsule),
// and extensible Ecosystem System Widgets / Live Activities / Watch tiles side-by-side in one stage.
// Every child slot is a real signed Pocket runtime (`dev.pocket.studio.preview*`) composited via
// `CompositorSurface`; failures are surfaced honestly and never masked by fake placeholders.
import {
  ECOSYSTEM_SURFACE_PROFILES,
  SURFACE_CONTEXT_EVENT,
  getSurfaceProfile,
  surfaceEnvironmentFromProfile,
  type EcosystemSurfaceProfile,
  type SurfaceRenderMode,
} from "@pocket/ui/surface-catalog";
import { createStore } from "./store.ts";
import type { Timers } from "./env.ts";
import type { Toasts } from "./toasts.ts";
import type { Build } from "./build.ts";
import type { ViewportPreset } from "./workbench.ts";
import { errorText } from "./workspace.ts";
import type { StudioClient } from "../studio-client.ts";

export const PREVIEW_APP_ID = "dev.pocket.studio.preview";
export const PREVIEW_WEB_APP_ID = "dev.pocket.studio.preview.web";
export const PREVIEW_WECHAT_APP_ID = "dev.pocket.studio.preview.wechat";
export const PREVIEW_WIDGET_APP_ID = "dev.pocket.studio.preview.widget";
export const PREVIEW_WIDGET_ALT_APP_ID = "dev.pocket.studio.preview.widget-alt";

export const ALL_PREVIEW_APP_IDS: readonly string[] = Object.freeze([
  PREVIEW_APP_ID,
  PREVIEW_WEB_APP_ID,
  PREVIEW_WECHAT_APP_ID,
  PREVIEW_WIDGET_APP_ID,
  PREVIEW_WIDGET_ALT_APP_ID,
]);

export type PreviewTargetId = "flutter" | "web" | "wechat" | "widget" | "widgetAlt";

const TARGET_ORDER: readonly PreviewTargetId[] = Object.freeze([
  "flutter",
  "web",
  "wechat",
  "widget",
  "widgetAlt",
]);

export interface PreviewTargetSpec {
  readonly id: PreviewTargetId;
  readonly appId: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly subtitle: string;
}

export const PREVIEW_TARGET_SPECS: readonly PreviewTargetSpec[] = Object.freeze([
  {
    id: "flutter",
    appId: PREVIEW_APP_ID,
    label: "Flutter",
    shortLabel: "Flutter",
    subtitle: "原生画布沙箱",
  },
  {
    id: "web",
    appId: PREVIEW_WEB_APP_ID,
    label: "Web",
    shortLabel: "Web",
    subtitle: "浏览器视口沙箱",
  },
  {
    id: "wechat",
    appId: PREVIEW_WECHAT_APP_ID,
    label: "微信小程序",
    shortLabel: "微信小程序",
    subtitle: "胶囊导航 · wx.* 2MiB",
  },
  {
    id: "widget",
    appId: PREVIEW_WIDGET_APP_ID,
    label: "小组件",
    shortLabel: "小组件",
    subtitle: "桌面 / 锁屏系统微件",
  },
  {
    id: "widgetAlt",
    appId: PREVIEW_WIDGET_ALT_APP_ID,
    label: "灵动岛 / 穿戴",
    shortLabel: "灵动岛/穿戴",
    subtitle: "实时活动 · 智能穿戴",
  },
]);

export const PREVIEW_TARGET_BY_ID: Readonly<Record<PreviewTargetId, PreviewTargetSpec>> = Object.freeze({
  flutter: PREVIEW_TARGET_SPECS[0]!,
  web: PREVIEW_TARGET_SPECS[1]!,
  wechat: PREVIEW_TARGET_SPECS[2]!,
  widget: PREVIEW_TARGET_SPECS[3]!,
  widgetAlt: PREVIEW_TARGET_SPECS[4]!,
});

/** Curated quick-pick widget/wearable surface profiles from `@pocket/ui/surface-catalog` (extensible to all 38 profiles). */
export const WIDGET_SURFACE_PROFILES: readonly EcosystemSurfaceProfile[] = Object.freeze(
  ECOSYSTEM_SURFACE_PROFILES.filter(
    (p) => p.isSystemSurface || p.family === "watch" || p.family === "menubar",
  ),
);

export const RENDER_MODE_OPTIONS: ReadonlyArray<{ id: SurfaceRenderMode; label: string }> = Object.freeze([
  { id: "fullColor", label: "全彩" },
  { id: "accented", label: "强调色" },
  { id: "vibrant", label: "锁屏毛玻璃" },
  { id: "alwaysOn", label: "常亮 AOD" },
]);

export interface PreviewInitialEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** Host-side system capabilities the preview needs (real: system-link.ts; tests: a fake). */
export interface PreviewRuntime {
  /** Installs the System kernel (system.runtime.configure). Rejects when the host has no System support. */
  ensure(): Promise<void>;
  /** Optional list of preview slot appIds supported by the current host's compositor table. */
  supportedAppIds?: () => readonly string[];
  create(
    appId: string,
    initialEvents?: readonly PreviewInitialEvent[],
  ): Promise<{ instanceId: string; generation: number | string }>;
  post?: (instanceId: string, event: string, params: Record<string, unknown>) => Promise<boolean>;
  destroy(instanceId: string): Promise<void>;
  awaitFirstFrame(instanceId: string, generation: number | string): Promise<void>;
}

export type PreviewPhase = "idle" | "building" | "publishing" | "loading" | "running" | "error";

export interface PreviewSlotState {
  targetId: PreviewTargetId;
  appId: string;
  phase: PreviewPhase;
  message?: string;
  code?: string;
  instanceId?: string;
  generation?: number | string;
  surfaceVisible: boolean;
}

export interface WechatServiceViewState {
  state: "idle" | "building" | "running" | "error" | "stopped";
  url?: string;
  error?: string;
  logs: string[];
}

export interface PreviewState {
  phase: PreviewPhase;
  message?: string;
  /** Machine-readable error code when phase is "error". */
  code?: string;
  /** Primary active child instanceId (backward-compatible with single-surface callers/tests). */
  instanceId?: string;
  version?: string;
  previewBuild?: number;
  /** Counts completed reloads (running states) so a test or the UI can tell a new frame from the old one. */
  reloads: number;
  /** Time from the request (a save, when triggered by one) to the child's first frame. */
  lastLatencyMs?: number;
  surfaceVisible: boolean;
  /** Set when the runtime could not be installed (no System host). */
  runtime: "unknown" | "ready" | "unavailable";
  runtimeMessage?: string;
  /** Simultaneously enabled preview targets rendered side-by-side in `#preview-surfaces`. */
  activeTargets: readonly PreviewTargetId[];
  /** Per-target runtime slot states. */
  slots: Record<PreviewTargetId, PreviewSlotState>;
  /** Selected surface profile for the `widget` slot (`@pocket/ui/surface-catalog`). */
  widgetProfileId: string;
  /** Selected render mode for the `widget` slot (`fullColor | accented | vibrant | alwaysOn`). */
  widgetRenderMode: SurfaceRenderMode;
  /** Selected surface profile for the secondary `widgetAlt` slot (Live Activity / Watch / Tile). */
  widgetAltProfileId: string;
  /** Selected render mode for the secondary `widgetAlt` slot. */
  widgetAltRenderMode: SurfaceRenderMode;
  /** Loopback browser preview URL (`http://127.0.0.1:<port>/api/projects/<project>/preview`). */
  webPreviewUrl?: string;
  /** Standalone WeChat Mini Program preview server state (`studio.wechat.*`). */
  wechatService: WechatServiceViewState;
}

function emptySlot(targetId: PreviewTargetId): PreviewSlotState {
  return {
    targetId,
    appId: PREVIEW_TARGET_BY_ID[targetId].appId,
    phase: "idle",
    surfaceVisible: false,
  };
}

function createInitialSlots(): Record<PreviewTargetId, PreviewSlotState> {
  return {
    flutter: emptySlot("flutter"),
    web: emptySlot("web"),
    wechat: emptySlot("wechat"),
    widget: emptySlot("widget"),
    widgetAlt: emptySlot("widgetAlt"),
  };
}

function surfaceEventForProfile(profileId: string, renderMode?: SurfaceRenderMode): PreviewInitialEvent {
  const profile = getSurfaceProfile(profileId) ?? getSurfaceProfile("iphone-16-pro")!;
  const env = surfaceEnvironmentFromProfile(profile, renderMode ? { renderMode } : undefined);
  return {
    method: SURFACE_CONTEXT_EVENT,
    params: { ...env } as Record<string, unknown>,
  };
}

function mergeOrderedTargets(
  left: readonly PreviewTargetId[],
  right: readonly PreviewTargetId[],
): PreviewTargetId[] {
  return TARGET_ORDER.filter((id) => left.includes(id) || right.includes(id));
}

export function createPreview(deps: {
  client: StudioClient;
  runtime: PreviewRuntime;
  build: Build;
  timers: Timers;
  toasts: Toasts;
  project: () => string | undefined;
  viewportPreset?: () => ViewportPreset;
  setViewportPreset?: (preset: ViewportPreset) => void;
}) {
  const { client, runtime, build, timers, toasts } = deps;
  const store = createStore<PreviewState>({
    phase: "idle",
    reloads: 0,
    surfaceVisible: false,
    runtime: "unknown",
    activeTargets: ["flutter"],
    slots: createInitialSlots(),
    widgetProfileId: "ios-widget-medium",
    widgetRenderMode: "fullColor",
    widgetAltProfileId: "ios-live-activity-expanded",
    widgetAltRenderMode: "fullColor",
    wechatService: { state: "idle", logs: [] },
  });

  let running = false;
  let queued: { build: boolean; since: number; onlyTargets?: readonly PreviewTargetId[] } | undefined;
  let inflightEndpoints: Promise<void> | undefined;
  const surfaceMounts: Record<PreviewTargetId, number> = {
    flutter: 0,
    web: 0,
    wechat: 0,
    widget: 0,
    widgetAlt: 0,
  };
  const pendingFrames = new Map<PreviewTargetId, { instanceId: string; generation: number | string; since: number; mine: number }>();
  let wechatPollCancel: (() => void) | undefined;
  let epoch = 0;
  const state = () => store.get();

  function supportedSlotSet(): ReadonlySet<string> {
    const ids = runtime.supportedAppIds?.();
    if (!ids || ids.length === 0) return new Set(ALL_PREVIEW_APP_IDS);
    return new Set(ids);
  }

  function isTargetSupported(targetId: PreviewTargetId): boolean {
    if (targetId === "flutter") return true;
    return supportedSlotSet().has(PREVIEW_TARGET_BY_ID[targetId].appId);
  }

  function pruneQueuedTargets(removedIds: readonly PreviewTargetId[]): void {
    if (!queued?.onlyTargets || removedIds.length === 0) return;
    const remaining = queued.onlyTargets.filter((id) => !removedIds.includes(id));
    if (remaining.length === 0 && !queued.build) {
      queued = undefined;
    } else {
      queued = {
        ...queued,
        onlyTargets: remaining.length > 0 ? remaining : undefined,
      };
    }
  }

  function initialEventsForTarget(targetId: PreviewTargetId): readonly PreviewInitialEvent[] {
    const s = state();
    switch (targetId) {
      case "flutter": {
        const preset = deps.viewportPreset?.() ?? "mobile";
        const profileId = preset === "desktop" ? "macos-window" : preset === "tablet" ? "ipad-pro" : "iphone-16-pro";
        // Default mobile Flutter slot omits synthetic events when no special preset is needed so legacy single-arg mocks match cleanly.
        return preset === "mobile" ? [] : [surfaceEventForProfile(profileId)];
      }
      case "web":
        return [surfaceEventForProfile("macos-window", "fullColor")];
      case "wechat":
        return [surfaceEventForProfile("iphone-se", "fullColor")];
      case "widget":
        return [surfaceEventForProfile(s.widgetProfileId, s.widgetRenderMode)];
      case "widgetAlt":
        return [surfaceEventForProfile(s.widgetAltProfileId, s.widgetAltRenderMode)];
    }
  }

  function patchSlot(targetId: PreviewTargetId, patch: Partial<PreviewSlotState>): void {
    const cur = state();
    const nextSlot: PreviewSlotState = { ...cur.slots[targetId], ...patch };
    const nextSlots: Record<PreviewTargetId, PreviewSlotState> = {
      ...cur.slots,
      [targetId]: nextSlot,
    };
    const primaryTarget = cur.activeTargets[0] ?? "flutter";
    const primaryInstance = nextSlots.flutter.instanceId ?? nextSlots[primaryTarget]?.instanceId;
    const anyVisible = cur.activeTargets.some((t) => nextSlots[t].surfaceVisible);
    store.update({
      slots: nextSlots,
      instanceId: primaryInstance,
      surfaceVisible: anyVisible,
    });
  }

  async function ensureRuntime(): Promise<boolean> {
    if (state().runtime === "ready") return true;
    try {
      await runtime.ensure();
      store.update({ runtime: "ready", runtimeMessage: undefined });
      return true;
    } catch (error) {
      store.update({
        runtime: "unavailable",
        runtimeMessage: errorText(error),
        phase: "error",
        code: "runtime_unavailable",
        message: `预览运行时不可用：${errorText(error)}`,
      });
      return false;
    }
  }

  function fail(code: string, message: string, notify = true): false {
    store.update({ phase: "error", code, message });
    if (notify) toasts.error(message);
    return false;
  }

  async function destroySlot(targetId: PreviewTargetId): Promise<void> {
    pendingFrames.delete(targetId);
    const id = state().slots[targetId].instanceId;
    patchSlot(targetId, { instanceId: undefined, generation: undefined, phase: "idle", message: undefined, code: undefined });
    if (!id) return;
    try { await runtime.destroy(id); } catch { /* already gone */ }
  }

  async function destroyAllSlots(): Promise<void> {
    const ids: Array<{ targetId: PreviewTargetId; instanceId?: string }> = (
      Object.keys(state().slots) as PreviewTargetId[]
    ).map((targetId) => ({ targetId, instanceId: state().slots[targetId].instanceId }));
    pendingFrames.clear();
    const resetSlots = createInitialSlots();
    for (const targetId of Object.keys(resetSlots) as PreviewTargetId[]) {
      resetSlots[targetId] = {
        ...resetSlots[targetId],
        surfaceVisible: state().slots[targetId].surfaceVisible,
      };
    }
    store.update({ slots: resetSlots, instanceId: undefined });
    await Promise.all(
      ids.map(async (item) => {
        if (!item.instanceId) return;
        try { await runtime.destroy(item.instanceId); } catch { /* already gone */ }
      }),
    );
  }

  /** Waits for one child's first visible frame and marks that slot running. */
  async function finishSlotFrame(
    targetId: PreviewTargetId,
    instanceId: string,
    generation: number | string,
    since: number,
    mine: number,
  ): Promise<boolean> {
    patchSlot(targetId, { message: "等待预览首帧…" });
    try {
      await runtime.awaitFirstFrame(instanceId, generation);
    } catch (error) {
      if (mine !== epoch) return false;
      const code = (error as { code?: string }).code ?? "first_frame_failed";
      const msg = `预览首帧失败：${errorText(error)}`;
      patchSlot(targetId, { phase: "error", code, message: msg });
      return fail(code, msg);
    }
    if (mine !== epoch) return false;
    patchSlot(targetId, { phase: "running", message: undefined, code: undefined });
    const cur = state();
    const activeSupported = cur.activeTargets.filter(isTargetSupported);
    const hasErrorSlot = activeSupported.some((t) => cur.slots[t].phase === "error");
    const allReady = !hasErrorSlot && activeSupported.every(
      (t) => cur.slots[t].phase === "running" || !cur.slots[t].surfaceVisible,
    );
    if (allReady && cur.phase !== "running") {
      store.update({
        phase: "running",
        message: undefined,
        code: undefined,
        reloads: cur.reloads + 1,
        lastLatencyMs: Math.max(0, timers.now() - since),
      });
    }
    return true;
  }

  async function execute(
    withBuild: boolean,
    since: number,
    onlyTargets?: readonly PreviewTargetId[],
  ): Promise<boolean> {
    const project = deps.project();
    if (!project) return fail("no_project", "请先打开项目", false);

    const active = state().activeTargets;
    const requestedTargets = (
      onlyTargets
        ? onlyTargets.filter((t) => active.includes(t))
        : active
    ).filter(isTargetSupported);
    // An incremental target load whose target was toggled OFF before drain is a clean no-op.
    if (onlyTargets !== undefined && requestedTargets.length === 0) {
      return true;
    }

    const mine = ++epoch;
    if (!onlyTargets) pendingFrames.clear();
    if (!(await ensureRuntime())) return false;

    const targets: PreviewTargetId[] = requestedTargets.length > 0 ? [...requestedTargets] : ["flutter"];
    const slotAppIds = targets.map((t) => PREVIEW_TARGET_BY_ID[t].appId);

    for (const t of targets) {
      patchSlot(t, { phase: withBuild ? "building" : "publishing", message: withBuild ? "正在构建…" : "正在签名预览包…", code: undefined });
    }

    let published: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 3 && !published; attempt += 1) {
      const status = build.state().status;
      const fresh = status !== undefined && status.builtRevision === status.revision && !status.error && !build.state().busy;
      if (withBuild || !fresh || attempt > 0) {
        store.update({ phase: "building", message: "正在构建…", code: undefined });
        const done = await build.run();
        if (mine !== epoch) return false;
        if (!done.ok) {
          for (const t of targets) patchSlot(t, { phase: "error", code: "build_failed", message: "构建失败" });
          return fail("build_failed", "构建失败，请在控制台查看诊断信息");
        }
      }
      store.update({ phase: "publishing", message: "正在签名并发布多端预览包…" });
      try {
        published = slotAppIds.length === 1 && slotAppIds[0] === PREVIEW_APP_ID
          ? await client.preview.publish(project)
          : await client.preview.publish(project, slotAppIds);
      } catch (error) {
        if (mine !== epoch) return false;
        const code = (error as { code?: string }).code;
        if (code === "conflict" && attempt < 2) continue;
        for (const t of targets) patchSlot(t, { phase: "error", code: code ?? "publish_failed", message: errorText(error) });
        return fail(code ?? "publish_failed", `发布预览失败：${errorText(error)}`);
      }
    }
    if (!published) return fail("publish_failed", "源码在构建期间持续变化，请稍后重试");
    if (mine !== epoch) return false;

    // Refresh loopback Web/WeChat metadata only when Web or WeChat target is active.
    if (targets.includes("web") || targets.includes("wechat")) {
      void refreshEndpoints();
    }

    const primaryActive = state().activeTargets[0] ?? "flutter";
    const preservePrimaryVersion =
      onlyTargets !== undefined &&
      !targets.includes(primaryActive) &&
      state().version !== undefined;
    store.update({
      phase: "loading",
      message: targets.length > 1 ? `正在并行加载 ${targets.length} 个预览沙箱…` : "正在加载预览子应用…",
      version: preservePrimaryVersion ? state().version : String(published.version ?? ""),
      previewBuild: preservePrimaryVersion ? state().previewBuild : (Number(published.build) || undefined),
    });

    await Promise.all(
      targets.map(async (t) => {
        await destroySlot(t);
        patchSlot(t, { phase: "loading", message: "正在启动沙箱…" });
      }),
    );
    if (mine !== epoch) return false;

    const creations = await Promise.allSettled(
      targets.map(async (targetId) => {
        const appId = PREVIEW_TARGET_BY_ID[targetId].appId;
        const initEvents = initialEventsForTarget(targetId);
        const created = initEvents.length > 0
          ? await runtime.create(appId, initEvents)
          : await runtime.create(appId);
        return { targetId, instanceId: created.instanceId, generation: created.generation };
      }),
    );
    if (mine !== epoch) {
      await Promise.all(
        creations.map(async (res) => {
          if (res.status === "fulfilled") {
            try { await runtime.destroy(res.value.instanceId); } catch { /* ignore */ }
          }
        }),
      );
      return false;
    }

    const firstRejectedIndex = creations.findIndex((res) => res.status === "rejected");
    if (firstRejectedIndex >= 0) {
      await Promise.all(
        creations.map(async (res) => {
          if (res.status === "fulfilled") {
            try { await runtime.destroy(res.value.instanceId); } catch { /* ignore */ }
          }
        }),
      );
      for (let i = 0; i < creations.length; i += 1) {
        const t = targets[i]!;
        const c = creations[i]!;
        if (c.status === "rejected") {
          const errCode = (c.reason as { code?: string })?.code ?? "reload_failed";
          patchSlot(t, {
            phase: "error",
            code: errCode,
            message: `预览加载失败 (${PREVIEW_TARGET_BY_ID[t].label})：${errorText(c.reason)}`,
          });
        } else {
          patchSlot(t, { phase: "idle", instanceId: undefined, generation: undefined, message: undefined });
        }
      }
      const failedTarget = targets[firstRejectedIndex]!;
      const reason = (creations[firstRejectedIndex] as PromiseRejectedResult).reason;
      const code = (reason as { code?: string })?.code ?? "reload_failed";
      const msg = `预览加载失败 (${PREVIEW_TARGET_BY_ID[failedTarget].label})：${errorText(reason)}`;
      return fail(code, msg);
    }

    const spawned = creations.map(
      (res) => (res as PromiseFulfilledResult<{ targetId: PreviewTargetId; instanceId: string; generation: number | string }>).value,
    );
    for (const item of spawned) {
      patchSlot(item.targetId, { instanceId: item.instanceId, generation: item.generation });
    }

    const visibleWaiters: Promise<boolean>[] = [];
    for (const item of spawned) {
      if (!state().slots[item.targetId].surfaceVisible) {
        pendingFrames.set(item.targetId, { ...item, since, mine });
        patchSlot(item.targetId, { message: "预览已就绪，展开画布后显示" });
      } else {
        visibleWaiters.push(finishSlotFrame(item.targetId, item.instanceId, item.generation, since, mine));
      }
    }

    if (visibleWaiters.length === 0) {
      store.update({ message: "预览已加载，打开预览面板后显示" });
      return true;
    }
    const results = await Promise.all(visibleWaiters);
    const activeSupported = state().activeTargets.filter(isTargetSupported);
    const hasErrorSlot = activeSupported.some((t) => state().slots[t].phase === "error");
    if (mine === epoch && results.every(Boolean) && !hasErrorSlot && state().phase !== "running") {
      store.update({
        phase: "running",
        message: undefined,
        code: undefined,
        reloads: state().reloads + 1,
        lastLatencyMs: Math.max(0, timers.now() - since),
      });
    }
    return results.every(Boolean);
  }

  /** Builds (optionally), publishes and reloads active targets. Calls made while active coalesce cleanly. */
  async function run(options: { build?: boolean; since?: number; onlyTargets?: readonly PreviewTargetId[] } = {}): Promise<boolean> {
    const withBuild = options.build !== false;
    const since = options.since ?? timers.now();
    if (running) {
      const nextBuild = (queued?.build ?? false) || withBuild;
      const nextSince = queued ? Math.min(queued.since, since) : since;
      // Full runs (`onlyTargets === undefined` or `nextBuild === true`) refresh all activeTargets;
      // incremental slot additions coalesce into a deduplicated union of target IDs.
      const nextOnlyTargets = nextBuild
        ? undefined
        : queued === undefined
          ? options.onlyTargets ? [...options.onlyTargets] : undefined
          : queued.onlyTargets !== undefined && options.onlyTargets !== undefined
            ? mergeOrderedTargets(queued.onlyTargets, options.onlyTargets)
            : undefined;
      queued = {
        build: nextBuild,
        since: nextSince,
        ...(nextOnlyTargets !== undefined ? { onlyTargets: nextOnlyTargets } : {}),
      };
      return false;
    }
    running = true;
    let ok = false;
    try {
      ok = await execute(withBuild, since, options.onlyTargets);
    } finally {
      running = false;
    }
    const next = queued;
    queued = undefined;
    if (next) return run(next);
    return ok;
  }

  function syncSurfaceVisibility(targetId: PreviewTargetId): void {
    const visible = surfaceMounts[targetId] > 0;
    const slot = state().slots[targetId];
    if (slot.surfaceVisible === visible) return;
    patchSlot(targetId, { surfaceVisible: visible });
    const pending = pendingFrames.get(targetId);
    if (visible && pending && pending.mine === epoch && pending.instanceId === state().slots[targetId].instanceId) {
      pendingFrames.delete(targetId);
      void finishSlotFrame(targetId, pending.instanceId, pending.generation, pending.since, pending.mine);
    }
  }

  /** Reference-counted mount hook for `PreviewSurface` so overlapping responsive layout swaps never clobber visibility. */
  function mountSurface(targetId: PreviewTargetId = "flutter"): () => void {
    surfaceMounts[targetId] += 1;
    syncSurfaceVisibility(targetId);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      surfaceMounts[targetId] = Math.max(0, surfaceMounts[targetId] - 1);
      syncSurfaceVisibility(targetId);
    };
  }

  function setSurfaceVisible(visible: boolean, targetId: PreviewTargetId = "flutter"): void {
    surfaceMounts[targetId] = visible ? Math.max(1, surfaceMounts[targetId]) : 0;
    syncSurfaceVisibility(targetId);
  }

  /** Recomputes aggregate preview phase after removing/disabling slots so stale slot errors never linger. */
  function reconcileAggregatePhase(): void {
    if (running) return;
    const cur = state();
    if (cur.runtime === "unavailable") return;
    const activeSupported = cur.activeTargets.filter(isTargetSupported);
    if (activeSupported.length === 0) return;
    const errorSlot = activeSupported.map((t) => cur.slots[t]).find((s) => s.phase === "error");
    if (errorSlot) {
      if (cur.phase !== "error" || cur.message !== errorSlot.message) {
        store.update({
          phase: "error",
          code: errorSlot.code ?? "slot_error",
          message: errorSlot.message,
        });
      }
      return;
    }
    const anyLoading = activeSupported.some(
      (t) => cur.slots[t].phase === "building" || cur.slots[t].phase === "publishing" || cur.slots[t].phase === "loading",
    );
    if (anyLoading) return;
    const anyRunning = activeSupported.some((t) => cur.slots[t].phase === "running");
    if (anyRunning) {
      if (cur.phase !== "running" || cur.code !== undefined || cur.message !== undefined) {
        store.update({ phase: "running", code: undefined, message: undefined });
      }
      return;
    }
    if (cur.phase !== "idle" || cur.code !== undefined || cur.message !== undefined) {
      store.update({ phase: "idle", code: undefined, message: undefined });
    }
  }

  /** Toggle one preview target ON/OFF while keeping at least 1 target active. */
  async function toggleTarget(targetId: PreviewTargetId): Promise<void> {
    const current = state().activeTargets;
    if (current.includes(targetId)) {
      if (current.length <= 1) return; // Always keep at least one stage surface visible.
      const next = current.filter((id) => id !== targetId);
      store.update({ activeTargets: next });
      pruneQueuedTargets([targetId]);
      await destroySlot(targetId);
      reconcileAggregatePhase();
      return;
    }
    const next = TARGET_ORDER.filter((id) => current.includes(id) || id === targetId);
    store.update({ activeTargets: next });
    const status = build.state().status;
    const hasBuild = status !== undefined && status.builtRevision !== null && !status.error;
    const shouldSpinUp = (running || state().reloads > 0 || hasBuild) && isTargetSupported(targetId);
    if (shouldSpinUp) {
      await run({ build: false, onlyTargets: [targetId] });
    } else if (targetId === "wechat" || targetId === "web") {
      void refreshEndpoints();
    }
  }

  /** Activate a preset set of simultaneous targets (e.g. 4-up `["flutter", "web", "wechat", "widget"]` or single `["flutter"]`). */
  async function setTargets(targets: readonly PreviewTargetId[]): Promise<void> {
    const unique = TARGET_ORDER.filter((id) => targets.includes(id));
    const next: readonly PreviewTargetId[] = unique.length > 0 ? unique : ["flutter"];
    const prev = state().activeTargets;
    const removed = prev.filter((id) => !next.includes(id));
    const added = next.filter((id) => !prev.includes(id));
    store.update({ activeTargets: next });
    pruneQueuedTargets(removed);
    await Promise.all(removed.map((r) => destroySlot(r)));
    const status = build.state().status;
    const hasBuild = status !== undefined && status.builtRevision !== null && !status.error;
    const supportedAdded = added.filter(isTargetSupported);
    const shouldSpinUp = supportedAdded.length > 0 && (running || state().reloads > 0 || hasBuild);
    if (shouldSpinUp) {
      await run({ build: false, onlyTargets: supportedAdded });
    } else {
      if (removed.length > 0) reconcileAggregatePhase();
      if (next.includes("wechat") || next.includes("web")) {
        void refreshEndpoints();
      }
    }
  }

  async function pushFlutterSurfaceUpdate(): Promise<void> {
    const slot = state().slots.flutter;
    if (!slot.instanceId || !runtime.post) return;
    const preset = deps.viewportPreset?.() ?? "mobile";
    const profileId = preset === "desktop" ? "macos-window" : preset === "tablet" ? "ipad-pro" : "iphone-16-pro";
    const ev = surfaceEventForProfile(profileId, "fullColor");
    try {
      await runtime.post(slot.instanceId, ev.method, ev.params);
    } catch {
      // Best-effort live push; next reload also carries initialEvents.
    }
  }

  function syncFlutterViewport(): void {
    void pushFlutterSurfaceUpdate();
  }

  async function pushSurfaceUpdate(targetId: "widget" | "widgetAlt"): Promise<void> {
    const s = state();
    const slot = s.slots[targetId];
    if (!slot.instanceId || !runtime.post) return;
    const profileId = targetId === "widget" ? s.widgetProfileId : s.widgetAltProfileId;
    const renderMode = targetId === "widget" ? s.widgetRenderMode : s.widgetAltRenderMode;
    const ev = surfaceEventForProfile(profileId, renderMode);
    try {
      await runtime.post(slot.instanceId, ev.method, ev.params);
    } catch {
      // Best-effort live push; next reload also carries initialEvents.
    }
  }

  function setWidgetProfile(profileId: string, slot: "widget" | "widgetAlt" = "widget"): void {
    const profile = getSurfaceProfile(profileId);
    if (!profile) return;
    if (slot === "widget") {
      const mode = profile.supportedRenderModes.includes(state().widgetRenderMode)
        ? state().widgetRenderMode
        : profile.defaultRenderMode;
      store.update({ widgetProfileId: profile.id, widgetRenderMode: mode });
      void pushSurfaceUpdate("widget");
    } else {
      const mode = profile.supportedRenderModes.includes(state().widgetAltRenderMode)
        ? state().widgetAltRenderMode
        : profile.defaultRenderMode;
      store.update({ widgetAltProfileId: profile.id, widgetAltRenderMode: mode });
      void pushSurfaceUpdate("widgetAlt");
    }
  }

  function setWidgetRenderMode(mode: SurfaceRenderMode, slot: "widget" | "widgetAlt" = "widget"): void {
    if (slot === "widget") {
      store.update({ widgetRenderMode: mode });
      void pushSurfaceUpdate("widget");
    } else {
      store.update({ widgetAltRenderMode: mode });
      void pushSurfaceUpdate("widgetAlt");
    }
  }

  /** Jump from a widget/Live Activity surface to its companion host app device (`iphone-16-pro` / `ipad-pro` / `macos-window`). */
  function openWidgetCompanion(slot: "widget" | "widgetAlt" = "widget"): void {
    const profileId = slot === "widget" ? state().widgetProfileId : state().widgetAltProfileId;
    const profile = getSurfaceProfile(profileId);
    const companionId = profile?.companionDeviceId ?? "iphone-16-pro";
    const preset: ViewportPreset = companionId === "macos-window"
      ? "desktop"
      : companionId === "ipad-pro"
        ? "tablet"
        : "mobile";
    deps.setViewportPreset?.(preset);
    if (!state().activeTargets.includes("flutter")) {
      void toggleTarget("flutter");
    }
    toasts.info(`已联动宿主设备视口：${getSurfaceProfile(companionId)?.shortLabel ?? companionId}`);
  }

  /** Sync loopback Web preview URL and WeChat Mini Program preview server status (deduplicated while in flight). */
  function refreshEndpoints(): Promise<void> {
    if (inflightEndpoints) return inflightEndpoints;
    const project = deps.project();
    const wechatApi = (client as Partial<StudioClient>).wechat;
    if (!project || !wechatApi?.status) return Promise.resolve();
    const task = (async () => {
      try {
        const res = await wechatApi.status(project);
        if (deps.project() !== project) return;
        store.update({
          ...(res.webPreviewUrl ? { webPreviewUrl: res.webPreviewUrl } : {}),
          wechatService: {
            state: res.state?.state ?? "idle",
            url: res.state?.url,
            error: res.state?.error,
            logs: res.state?.logs ?? [],
          },
        });
      } catch {
        // Optional capability on older fake hosts: ignore silently.
      } finally {
        if (inflightEndpoints === task) inflightEndpoints = undefined;
      }
    })();
    inflightEndpoints = task;
    return task;
  }

  function stopWechatPoll(): void {
    wechatPollCancel?.();
    wechatPollCancel = undefined;
  }

  function scheduleWechatPoll(project: string): void {
    stopWechatPoll();
    const step = (): void => {
      wechatPollCancel = timers.after(800, async () => {
        wechatPollCancel = undefined;
        if (deps.project() !== project) return;
        await refreshEndpoints();
        if (state().wechatService.state === "building") step();
      });
    };
    step();
  }

  async function startWechatService(): Promise<void> {
    const project = deps.project();
    const wechatApi = (client as Partial<StudioClient>).wechat;
    if (!project || !wechatApi?.start) return;
    try {
      const res = await wechatApi.start(project, "main");
      store.update({
        ...(res.webPreviewUrl ? { webPreviewUrl: res.webPreviewUrl } : {}),
        wechatService: {
          state: res.state.state,
          url: res.state.url,
          error: res.state.error,
          logs: res.state.logs ?? [],
        },
      });
      if (res.state.state === "building") scheduleWechatPoll(project);
    } catch (error) {
      toasts.error(`启动微信预览服务失败：${errorText(error)}`);
    }
  }

  async function stopWechatService(): Promise<void> {
    const project = deps.project();
    const wechatApi = (client as Partial<StudioClient>).wechat;
    stopWechatPoll();
    if (!project || !wechatApi?.stop) return;
    try {
      const res = await wechatApi.stop(project);
      store.update({
        wechatService: {
          state: res.state.state,
          url: res.state.url,
          error: res.state.error,
          logs: res.state.logs ?? [],
        },
      });
    } catch (error) {
      toasts.error(`停止微信预览服务失败：${errorText(error)}`);
    }
  }

  /** Closes all active preview children (used when the project changes or user clicks 关闭预览). */
  async function reset(): Promise<void> {
    epoch += 1;
    queued = undefined;
    inflightEndpoints = undefined;
    stopWechatPoll();
    await destroyAllSlots();
    store.update({
      phase: "idle",
      message: undefined,
      code: undefined,
      version: undefined,
      previewBuild: undefined,
      webPreviewUrl: undefined,
      wechatService: { state: "idle", logs: [] },
    });
  }

  return {
    store,
    state,
    run,
    reset,
    mountSurface,
    setSurfaceVisible,
    syncFlutterViewport,
    toggleTarget,
    setTargets,
    isTargetSupported,
    setWidgetProfile,
    setWidgetRenderMode,
    openWidgetCompanion,
    refreshEndpoints,
    startWechatService,
    stopWechatService,
    isRunning: () => running,
  };
}
export type Preview = ReturnType<typeof createPreview>;
