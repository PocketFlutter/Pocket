import { createStore } from "./store.ts";
import type { Toasts } from "./toasts.ts";
import { errorText } from "./workspace.ts";
import { asRecord, list, str } from "../lib/format.ts";
import type { EcosystemModuleInfo, StudioClient } from "../studio-client.ts";

export const DEFAULT_ECOSYSTEM_CATALOG: readonly EcosystemModuleInfo[] = [
  { id: "apple-widget", ecosystem: "apple", platform: "apple", label: "iOS / macOS 小组件 (WidgetKit)", description: "桌面与锁屏 Widget 卡片视图骨架", entryFile: "ecosystem/apple_widget.tsx", profileIds: ["ios-widget-extension"] },
  { id: "apple-live-activity", ecosystem: "apple", platform: "apple", label: "灵动岛与实时活动 (Live Activities)", description: "Dynamic Island 紧凑/最小化/展开态与锁屏实时卡片", entryFile: "ecosystem/apple_live_activity.tsx", profileIds: ["ios-live-activity"] },
  { id: "apple-watch", ecosystem: "apple", platform: "apple", label: "Apple Watch 伴侣页与表盘复杂功能", description: "watchOS 伴侣应用视图与表盘小组件骨架", entryFile: "ecosystem/apple_watch.tsx", profileIds: ["watchos-companion"] },
  { id: "apple-app-intents", ecosystem: "apple", platform: "apple", label: "Siri / 快捷指令 (App Intents)", description: "Siri 语音、Spotlight 与快捷指令动作处理器", entryFile: "ecosystem/apple_intents.ts", profileIds: ["ios-app-intents"] },
  { id: "apple-carplay", ecosystem: "apple", platform: "apple", label: "CarPlay 车载界面模板", description: "车载列表、兴趣点与音频控制模板骨架", entryFile: "ecosystem/apple_carplay.tsx", profileIds: ["ios-carplay"] },
  { id: "android-app-widget", ecosystem: "android", platform: "android", label: "Android 桌面微件 (AppWidget)", description: "RemoteViews / Glance 风格桌面小组件骨架", entryFile: "ecosystem/android_widget.tsx", profileIds: ["android-app-widget"] },
  { id: "android-live-update", ecosystem: "android", platform: "android", label: "Android 实况通知 / 流体云", description: "Promoted Ongoing Notification 实时进度卡片骨架", entryFile: "ecosystem/android_live_update.tsx", profileIds: ["android-ongoing-live-notification"] },
  { id: "android-tile", ecosystem: "android", platform: "android", label: "Android 快捷设置磁贴 (Quick Settings Tile)", description: "下拉控制中心快捷开关磁贴处理逻辑", entryFile: "ecosystem/android_tile.ts", profileIds: ["android-quick-settings-tile"] },
  { id: "android-wear", ecosystem: "android", platform: "android", label: "Wear OS 表盘与手表明细卡 (Tiles)", description: "Wear OS Tile 卡片与复杂功能数据提供器", entryFile: "ecosystem/android_wear.tsx", profileIds: ["wearos-tile-complication"] },
  { id: "android-auto", ecosystem: "android", platform: "android", label: "Android Auto 车载模板", description: "Android Auto 车载列表与导航信息流模板", entryFile: "ecosystem/android_auto.tsx", profileIds: ["android-auto-template"] },
];

export function normalizeModule(raw: unknown): EcosystemModuleInfo | undefined {
  const r = asRecord(raw);
  const id = str(r?.id);
  if (!r || !id) return undefined;
  const platform = str(r.platform) ?? str(r.ecosystem) ?? (id.startsWith("android-") ? "android" : "apple");
  const label = str(r.label) ?? str(r.title) ?? str(r.name) ?? id;
  const description = str(r.description);
  const entryFile = str(r.entryFile);
  const profile = str(r.profile);
  const profileIds = list(r.profileIds).filter((x): x is string => typeof x === "string");
  const surfaces = list(r.surfaces).filter((x): x is string => typeof x === "string");
  const capabilities = list(r.capabilities).filter((x): x is string => typeof x === "string");
  return {
    id,
    label,
    ...(str(r.name) ? { name: str(r.name)! } : {}),
    ...(str(r.title) ? { title: str(r.title)! } : {}),
    ...(description ? { description } : {}),
    platform,
    ecosystem: platform,
    ...(profile ? { profile } : {}),
    ...(profileIds.length > 0 ? { profileIds } : profile ? { profileIds: [profile] } : {}),
    ...(surfaces.length > 0 ? { surfaces } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(entryFile ? { entryFile } : {}),
    ...(typeof r.isSystemExtension === "boolean" ? { isSystemExtension: r.isSystemExtension } : {}),
  };
}

export function modulePlatform(mod: EcosystemModuleInfo): "apple" | "android" {
  const p = (mod.platform ?? mod.ecosystem ?? "").toLowerCase();
  if (p === "android" || mod.id.startsWith("android-")) return "android";
  return "apple";
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
};

export interface EcosystemLastResult {
  added?: string[];
  removed?: string[];
  generatedFiles?: string[];
  updatedFiles?: string[];
  entryWired?: boolean;
}

export interface EcosystemState {
  loading: boolean;
  applying: boolean;
  error?: string;
  project?: string;
  catalog: EcosystemModuleInfo[];
  savedModules: string[];
  selectedModules: string[];
  enabledProfiles: string[];
  dirty: boolean;
  lastResult?: EcosystemLastResult;
}

export function createEcosystemState(deps: {
  client: StudioClient;
  toasts: Toasts;
  onApplied?: () => void;
}) {
  const { client, toasts } = deps;
  const store = createStore<EcosystemState>({
    loading: false,
    applying: false,
    catalog: [...DEFAULT_ECOSYSTEM_CATALOG],
    savedModules: [],
    selectedModules: [],
    enabledProfiles: [],
    dirty: false,
  });
  const state = () => store.get();
  let epoch = 0;

  async function load(project: string | undefined = state().project): Promise<void> {
    if (!project) { unload(); return; }
    const mine = ++epoch;
    store.update({ project, loading: true, error: undefined });
    try {
      const res = asRecord(await client.ecosystem.get(project)) ?? {};
      if (mine !== epoch) return;
      const catalogRaw = list(res.catalog).map(normalizeModule).filter((m): m is EcosystemModuleInfo => m !== undefined);
      const catalog = catalogRaw.length > 0 ? catalogRaw : [...DEFAULT_ECOSYSTEM_CATALOG];
      const modules = list(res.modules).filter((x): x is string => typeof x === "string");
      const enabledProfiles = list(res.enabledProfiles ?? res.enabledProfileIds).filter((x): x is string => typeof x === "string");
      store.update({
        loading: false,
        error: undefined,
        catalog,
        savedModules: [...modules],
        selectedModules: [...modules],
        enabledProfiles,
        dirty: false,
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
      applying: false,
      catalog: [...DEFAULT_ECOSYSTEM_CATALOG],
      savedModules: [],
      selectedModules: [],
      enabledProfiles: [],
      dirty: false,
    });
  }

  function setSelection(nextSelected: string[]): void {
    const order = state().catalog.map((m) => m.id);
    const unique = Array.from(new Set(nextSelected));
    unique.sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    store.update({
      selectedModules: unique,
      dirty: !sameSet(unique, state().savedModules),
      error: undefined,
    });
  }

  function toggle(id: string): void {
    const cur = state().selectedModules;
    if (cur.includes(id)) setSelection(cur.filter((x) => x !== id));
    else setSelection([...cur, id]);
  }

  function selectPlatform(platform: "apple" | "android"): void {
    const platformIds = state().catalog.filter((m) => modulePlatform(m) === platform).map((m) => m.id);
    setSelection([...state().selectedModules, ...platformIds]);
  }

  function clearSelection(): void {
    setSelection([]);
  }

  async function apply(): Promise<boolean> {
    const project = state().project;
    if (!project || state().applying) return false;
    const prevSaved = new Set(state().savedModules);
    const requested = [...state().selectedModules];
    const mine = epoch;
    store.update({ applying: true, error: undefined });
    try {
      const res = asRecord(await client.ecosystem.set(project, { modules: requested })) ?? {};
      if (mine !== epoch || state().project !== project) return false;
      const modules = list(res.modules).filter((x): x is string => typeof x === "string");
      const finalModules = modules.length > 0 || requested.length === 0 ? modules : requested;
      const enabledProfiles = list(res.enabledProfileIds ?? res.enabledProfiles).filter((x): x is string => typeof x === "string");
      const createdFiles = list(res.createdFiles ?? res.generatedFiles).filter((x): x is string => typeof x === "string");
      const updatedFiles = list(res.updatedFiles).filter((x): x is string => typeof x === "string");
      const added = finalModules.filter((id) => !prevSaved.has(id));
      const removed = [...prevSaved].filter((id) => !finalModules.includes(id));
      const lastResult: EcosystemLastResult = {
        added,
        removed,
        generatedFiles: createdFiles,
        updatedFiles,
        ...(typeof res.entryWired === "boolean" ? { entryWired: res.entryWired } : {}),
      };
      store.update({
        applying: false,
        savedModules: [...finalModules],
        selectedModules: [...finalModules],
        enabledProfiles,
        dirty: false,
        lastResult,
      });
      const summary = createdFiles.length > 0
        ? `已启用 ${finalModules.length} 个生态扩展模块（新增 ${createdFiles.length} 个源码文件）`
        : `已更新生态扩展配置（当前启用 ${finalModules.length} 个模块）`;
      toasts.success(summary);
      deps.onApplied?.();
      return true;
    } catch (error) {
      if (mine !== epoch) return false;
      const msg = errorText(error);
      store.update({ applying: false, error: msg });
      toasts.error(`更新生态扩展失败：${msg}`);
      return false;
    }
  }

  return {
    store,
    state,
    load,
    unload,
    reset: unload,
    toggle,
    selectPlatform,
    clearSelection,
    apply,
  };
}

export type Ecosystem = ReturnType<typeof createEcosystemState>;
