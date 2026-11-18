// Resource placement editor (the web Studio's "包资源" panel): which resources of a built package ship inside the base pak
// and which are downloaded over the network. The inventory and the save go through `studio.project.resources.*`; the save
// carries the revision the user saw, and a stale revision (HTTP 409) is surfaced as a reload prompt instead of overwriting.
import { createStore } from "./store.ts";
import { errorText } from "./workspace.ts";
import type { Toasts } from "./toasts.ts";
import type { Dialogs } from "./dialogs.ts";
import { StudioError, type ResourceEntry, type ResourceInventory, type ResourcePackage, type ResourcePlacement, type StudioClient } from "../studio-client.ts";

export interface ResourcesState {
  project?: string;
  loading: boolean;
  saving: boolean;
  loaded: boolean;
  error?: string;
  inventory?: ResourceInventory;
  selectedPackage?: string;
  /** Unsaved placement choices: package id -> resource key -> placement. */
  draft: Record<string, Record<string, ResourcePlacement>>;
  selectedKey?: string;
  /** The service holds a newer revision than the inventory on screen: saving is blocked until the user reloads. */
  stale?: string;
}

const STALE = /stale/i;

export function createResources(deps: { client: StudioClient; toasts: Toasts; dialogs: Dialogs; project: () => string | undefined }) {
  const { client, toasts } = deps;
  const store = createStore<ResourcesState>({ loading: false, saving: false, loaded: false, draft: {} });
  const state = () => store.get();
  let epoch = 0;

  const pkg = (id = state().selectedPackage): ResourcePackage | undefined => state().inventory?.packages.find((p) => p.id === id);
  /** The placement the user currently sees for one resource. */
  const placementOf = (packageId: string, resource: ResourceEntry): ResourcePlacement => state().draft[packageId]?.[resource.key] ?? resource.placement;
  /** Keys of `packageId` whose draft differs from the saved placement. */
  function changedKeys(packageId: string): string[] {
    const p = pkg(packageId);
    return p ? p.resources.filter((r) => !r.locked && placementOf(packageId, r) !== r.placement).map((r) => r.key) : [];
  }
  const isDirty = (packageId?: string): boolean =>
    packageId ? changedKeys(packageId).length > 0 : (state().inventory?.packages ?? []).some((p) => changedKeys(p.id).length > 0);

  function adopt(inventory: ResourceInventory): void {
    const current = state().selectedPackage;
    store.update({
      inventory, loaded: true, loading: false, error: undefined, stale: undefined, draft: {},
      selectedPackage: inventory.packages.some((p) => p.id === current) ? current : inventory.packages[0]?.id,
      selectedKey: undefined,
    });
  }

  async function refresh(): Promise<void> {
    const project = deps.project();
    if (!project) return;
    const mine = epoch;
    store.update({ project, loading: true, error: undefined });
    try {
      const inventory = await client.resources.get(project);
      if (mine === epoch) adopt(inventory);
    } catch (error) {
      if (mine !== epoch) return;
      store.update({ loading: false, loaded: true, error: errorText(error) });
      toasts.error(`读取资源清单失败：${errorText(error)}`);
    }
  }

  /** Reload after a build or an upload: only when nothing unsaved would be lost, otherwise ask the user to reload. */
  async function refreshIfIdle(): Promise<void> {
    if (!state().loaded) return;
    if (isDirty()) { store.update({ stale: "项目已更改（构建或资源上传），资源清单需要重新加载。未保存的修改会被丢弃。" }); return; }
    await refresh();
  }

  async function reload(): Promise<void> {
    const dirty = isDirty();
    if (dirty && !(await deps.dialogs.confirm({ title: "重新加载资源清单？", body: "未保存的交付方式修改将被丢弃。", confirmLabel: "重新加载", tone: "danger" }))) return;
    await refresh();
  }

  function selectPackage(id: string): void {
    if (pkg(id)) store.update({ selectedPackage: id, selectedKey: undefined });
  }
  function selectResource(key: string | undefined): void { store.update({ selectedKey: key }); }

  function setPlacement(key: string, placement: ResourcePlacement): void {
    const id = state().selectedPackage;
    const p = pkg(id);
    const resource = p?.resources.find((r) => r.key === key);
    if (!id || !resource || resource.locked || state().saving) return;
    const draft = { ...(state().draft[id] ?? {}) };
    if (placement === resource.placement) delete draft[key]; else draft[key] = placement;
    store.update({ draft: { ...state().draft, [id]: draft } });
  }
  function discard(): void {
    const id = state().selectedPackage;
    if (id) store.update({ draft: { ...state().draft, [id]: {} } });
  }

  async function save(): Promise<void> {
    const project = deps.project();
    const inventory = state().inventory;
    const id = state().selectedPackage;
    const p = pkg(id);
    if (!project || !inventory || !id || !p || state().saving || state().stale || !isDirty(id)) return;
    const mine = epoch;
    store.update({ saving: true });
    try {
      const saved = await client.resources.set(project, inventory.revision, id, p.resources.map((r) => ({ key: r.key, placement: placementOf(id, r) })));
      if (mine !== epoch) return;
      const other = { ...state().draft };
      delete other[id];
      // The service rebuilt the inventory for the new revision: other packages' drafts still apply to the same keys.
      store.update({ inventory: saved, saving: false, draft: other, error: undefined, stale: undefined });
      toasts.success("资源策略已保存。请构建项目以应用。");
    } catch (error) {
      if (mine !== epoch) return;
      store.update({ saving: false });
      const e = error as StudioError;
      if (e?.code === "conflict" && STALE.test(e.message)) {
        store.update({ stale: "服务器上的资源策略已变化（修订号过期）。请重新加载后再保存。" });
        toasts.warning("资源清单已过期，请重新加载");
      } else if (e?.code === "conflict") {
        toasts.warning(errorText(error));
        store.update({ error: errorText(error) });
      } else {
        toasts.error(`保存资源策略失败：${errorText(error)}`);
        store.update({ error: errorText(error) });
      }
    }
  }

  function reset(): void {
    epoch += 1;
    store.set({ loading: false, saving: false, loaded: false, draft: {} });
  }

  return { store, state, pkg, placementOf, changedKeys, isDirty, refresh, refreshIfIdle, reload, selectPackage, selectResource, setPlacement, discard, save, reset };
}
export type Resources = ReturnType<typeof createResources>;
