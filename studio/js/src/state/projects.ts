import { createStore } from "./store.ts";
import type { Toasts } from "./toasts.ts";
import { errorText } from "./workspace.ts";
import { DEFAULT_ECOSYSTEM_CATALOG, normalizeModule } from "./ecosystem.ts";
import { asRecord, list } from "../lib/format.ts";
import type { EcosystemModuleInfo, ProjectInfo, ProjectOpenLocalResult, StudioClient } from "../studio-client.ts";

export interface ProjectDraft {
  template: "app" | "game";
  id: string;
  name: string;
  appId: string;
  version: string;
  ecosystemModules: string[];
}
export interface ProjectsState {
  list: ProjectInfo[];
  loaded: boolean;
  current?: string;
  createOpen: boolean;
  creating: boolean;
  openingLocal: boolean;
  catalog: EcosystemModuleInfo[];
  draft: ProjectDraft;
}

const DEFAULT_DRAFT: ProjectDraft = {
  template: "app",
  id: "my-pocket-app",
  name: "我的 Pocket 应用",
  appId: "pocket.app",
  version: "0.1.0",
  ecosystemModules: [],
};

export function createProjects(deps: {
  client: StudioClient;
  toasts: Toasts;
  /** Runs before the current project is replaced; false cancels the switch (unsaved changes prompt). */
  confirmLeave: () => Promise<boolean>;
  /** Runs once the project is chosen: load files, attach build, reset preview. */
  onOpen: (project: string) => Promise<void>;
  onOpened?: (project?: string) => void;
}) {
  const { client, toasts } = deps;
  const store = createStore<ProjectsState>({
    list: [],
    loaded: false,
    createOpen: false,
    creating: false,
    openingLocal: false,
    catalog: [...DEFAULT_ECOSYSTEM_CATALOG],
    draft: { ...DEFAULT_DRAFT },
  });
  const state = () => store.get();
  let catalogLoaded = false;

  async function loadCatalog(): Promise<EcosystemModuleInfo[]> {
    if (catalogLoaded) return state().catalog;
    try {
      const res = asRecord(await client.ecosystem?.catalog?.());
      const items = list(res?.modules).map(normalizeModule).filter((m): m is EcosystemModuleInfo => m !== undefined);
      if (items.length > 0) {
        catalogLoaded = true;
        store.update({ catalog: items });
        return items;
      }
    } catch {
      /* fallback to default catalog */
    }
    return state().catalog;
  }

  async function refresh(): Promise<void> {
    try {
      store.update({ list: await client.project.list(), loaded: true });
    } catch (error) {
      store.update({ loaded: true });
      toasts.error(errorText(error));
    }
  }

  async function open(id: string): Promise<boolean> {
    if (state().current && state().current !== id && !(await deps.confirmLeave())) return false;
    if (state().current === id) { deps.onOpened?.(id); return true; }
    try {
      store.update({ current: id });
      await deps.onOpen(id);
      deps.onOpened?.(id);
      return true;
    } catch (error) {
      toasts.error(errorText(error));
      return false;
    }
  }

  async function openLocal(): Promise<ProjectOpenLocalResult | undefined> {
    if (state().openingLocal) return undefined;
    if (state().current && !(await deps.confirmLeave())) return { cancelled: true };
    store.update({ openingLocal: true });
    try {
      const res = await client.project.openLocal();
      if (!res || res.cancelled === true || !("project" in res) || !res.project?.id) {
        return { cancelled: true };
      }
      await refresh();
      await open(res.project.id);
      toasts.success(`已打开本地项目 ${res.project.id}`);
      return res;
    } catch (error) {
      toasts.error(`打开本地项目失败：${errorText(error)}`);
      return undefined;
    } finally {
      store.update({ openingLocal: false });
    }
  }

  async function create(options?: { pickParentDirectory?: boolean }): Promise<ProjectInfo | { cancelled: true } | undefined> {
    if (state().creating) return undefined;
    const d = state().draft;
    const pickParentDirectory = options?.pickParentDirectory === true;
    const ecosystemModules = Array.isArray(d.ecosystemModules) && d.ecosystemModules.length > 0 ? [...d.ecosystemModules] : undefined;
    const version = (d.version ?? "0.1.0").trim() || "0.1.0";
    const settings: Record<string, unknown> = {
      name: d.name,
      appId: d.appId,
      version,
    };
    store.update({ creating: true });
    try {
      const created = pickParentDirectory || ecosystemModules || version !== "0.1.0"
        ? await client.project.create({
            id: d.id,
            template: d.template,
            ...(pickParentDirectory ? { pickParentDirectory: true } : {}),
            ...(ecosystemModules ? { ecosystemModules } : {}),
            settings,
          })
        : await client.project.create(d.id, d.template, { name: d.name, appId: d.appId });
      if (created && typeof created === "object" && "cancelled" in created && created.cancelled === true) {
        return { cancelled: true };
      }
      const proj = created as ProjectInfo;
      const createdId = proj?.id || d.id;
      store.update({ createOpen: false });
      await refresh();
      toasts.success(`已创建项目 ${createdId}`);
      await open(createdId);
      return proj;
    } catch (error) {
      toasts.error(errorText(error));
      return undefined;
    } finally {
      store.update({ creating: false });
    }
  }

  function toggleDraftModule(moduleId: string): void {
    const cur = state().draft.ecosystemModules ?? [];
    const next = cur.includes(moduleId) ? cur.filter((x) => x !== moduleId) : [...cur, moduleId];
    store.update({ draft: { ...state().draft, ecosystemModules: next } });
  }

  return {
    store,
    state,
    refresh,
    open,
    openLocal,
    openLocalProject: openLocal,
    create,
    loadCatalog,
    ecosystemCatalog: () => state().catalog,
    toggleDraftModule,
    setCreateOpen: (createOpen: boolean) => {
      store.update({ createOpen });
      if (createOpen) void loadCatalog();
    },
    setDraft: (draft: Partial<ProjectDraft> & Pick<ProjectDraft, "template" | "id" | "name" | "appId">) =>
      store.update({
        draft: {
          ...state().draft,
          ...draft,
          version: draft.version ?? state().draft.version ?? "0.1.0",
          ecosystemModules: draft.ecosystemModules ?? state().draft.ecosystemModules ?? [],
        },
      }),
    current: () => state().current,
  };
}
export type Projects = ReturnType<typeof createProjects>;
