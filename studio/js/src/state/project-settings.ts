// Project settings form (the web Studio's "构建设置"): display name, appId, version, tickHz and the reused
// published packages, over studio.project.settings.get/set. `build` is read-only baseline metadata (never edited or sent).
// The SERVICE validates (appId/version patterns, ranges, reuse rules): its error text is shown inline at the field it
// names; the guest only rejects input it cannot even encode (a non-integer tickHz) or an appId rename while source tabs
// are dirty. The title follows the name on the service side, so it is shown, not edited.
// Dirty handling matches the editor: a draft survives page switches, and leaving the project (or applying an update
// that replaces this guest) asks to save, discard or cancel.
import { createStore } from "./store.ts";
import type { Dialogs } from "./dialogs.ts";
import type { Toasts } from "./toasts.ts";
import { errorText } from "./workspace.ts";
import { asRecord, num, str } from "../lib/format.ts";
import type { ProjectSettingsPatch, StudioClient } from "../studio-client.ts";

export const SETTING_FIELDS = ["name", "appId", "version", "tickHz", "reuse"] as const;
export type SettingField = (typeof SETTING_FIELDS)[number];
/** Form values are strings (the inputs are text fields); numbers are parsed on save. */
export type SettingValues = Record<SettingField, string>;
export type FieldErrors = Partial<Record<SettingField | "build" | "form", string>>;

export interface ProjectSettingsState {
  project?: string;
  phase: "idle" | "loading" | "ready" | "saving" | "error";
  saved?: SettingValues;
  draft: SettingValues;
  /** Read-only authoritative build number from the service baseline (never edited or sent in `save()`). */
  baselineBuild?: number;
  /** The service-derived window title (follows the name). */
  title?: string;
  errors: FieldErrors;
  error?: string;
  message?: string;
}

const EMPTY: SettingValues = { name: "", appId: "", version: "", tickHz: "", reuse: "" };

/** Maps an `EditorConfig` (service result) to form values. */
export function toValues(config: unknown): SettingValues {
  const c = asRecord(config) ?? {};
  const reuse = Array.isArray(c.reusePublishedPackages) ? c.reusePublishedPackages.filter((x): x is string => typeof x === "string") : [];
  return {
    name: str(c.name) ?? "",
    appId: str(c.appId) ?? "",
    version: str(c.version) ?? "",
    tickHz: num(c.tickHz) !== undefined ? String(num(c.tickHz)) : "",
    reuse: reuse.join(", "),
  };
}

const splitReuse = (text: string): string[] => text.split(/[,\s，、]+/).filter((id) => id.length > 0);

/** Picks the field a service validation message is about (the service names the setting in its text). */
export function fieldOfMessage(message: string): SettingField | "build" | undefined {
  const m = message.toLowerCase();
  if (m.includes("reusepublishedpackages") || m.includes("reuse") || m.includes("package id")) return "reuse";
  if (m.includes("appid")) return "appId";
  if (m.includes("tickhz")) return "tickHz";
  if (m.includes("version")) return "version";
  if (m.includes("build")) return "build";
  if (m.includes("name") || m.includes("title")) return "name";
  return undefined;
}

export function createProjectSettings(deps: {
  client: StudioClient;
  toasts: Toasts;
  dialogs: Dialogs;
  /** True when any open workspace document has unsaved edits; blocks renaming `appId`. */
  hasDirtyDocs?: () => boolean;
  /** Runs after `appId` was renamed on the service so open tabs and the file tree reconcile rewritten imports/configs. */
  onAppIdRenamed?: () => Promise<void> | void;
  /** Runs after a successful save: the revision moved and the title/appId may have changed (projects, build, publish views refresh). */
  onSaved?: (config: Record<string, unknown>) => void;
}) {
  const { client, toasts, dialogs } = deps;
  const store = createStore<ProjectSettingsState>({ phase: "idle", draft: { ...EMPTY }, errors: {} });
  const state = () => store.get();
  let epoch = 0;

  const dirtyFields = (): SettingField[] => {
    const { saved, draft } = state();
    return saved ? SETTING_FIELDS.filter((f) => draft[f].trim() !== saved[f].trim()) : [];
  };
  const isDirty = (): boolean => dirtyFields().length > 0;
  const appIdChanged = (): boolean => {
    const { saved, draft } = state();
    return Boolean(saved && draft.appId.trim() !== saved.appId.trim());
  };

  /** Reads the project's settings. Never clobbers an unsaved draft of the same project unless `force`. */
  async function load(project: string | undefined = state().project, force = false): Promise<void> {
    if (!project) { epoch += 1; store.set({ phase: "idle", draft: { ...EMPTY }, baselineBuild: undefined, errors: {}, error: undefined }); return; }
    if (!force && state().project === project && isDirty()) return;
    const mine = ++epoch;
    store.update({ project, phase: "loading", errors: {}, error: undefined, message: undefined });
    try {
      const config = await client.project.settings.get(project);
      if (mine !== epoch) return;
      const values = toValues(config);
      const buildNum = num(asRecord(config)?.build);
      store.update({
        phase: "ready",
        saved: values,
        draft: values,
        baselineBuild: buildNum,
        title: str(asRecord(config)?.title),
        error: undefined,
      });
    } catch (error) {
      if (mine !== epoch) return;
      const msg = errorText(error);
      store.update({ phase: "error", message: msg, error: msg, saved: undefined });
    }
  }

  function attach(project: string | undefined): Promise<void> { return load(project, true); }

  function setField(field: SettingField, value: string): void {
    if (!(SETTING_FIELDS as readonly string[]).includes(field)) return;
    const { [field]: _gone, form: _form, ...errors } = state().errors;
    store.update({ draft: { ...state().draft, [field]: value }, errors, error: undefined });
  }

  function reset(): void {
    if (state().saved) store.update({ draft: { ...state().saved! }, errors: {}, error: undefined });
  }

  /** Local checks for input the service could not even be asked about. Returns the request body of the changed fields (`build` is never included). */
  function buildBody(): { body: ProjectSettingsPatch; errors: FieldErrors } {
    const { draft } = state();
    const changed = new Set(dirtyFields());
    const body: ProjectSettingsPatch = {};
    const errors: FieldErrors = {};
    for (const field of changed) {
      const text = draft[field].trim();
      if (field === "tickHz") {
        if (!/^-?\d+$/.test(text)) { errors.tickHz = "帧率必须是整数"; continue; }
        body.tickHz = Number(text);
      } else if (field === "reuse") {
        body.reusePublishedPackages = splitReuse(text);
      } else {
        body[field] = text;
      }
    }
    return { body, errors };
  }

  /** Saves the changed fields. Resolves true when the service accepted them (or nothing was changed). */
  async function save(): Promise<boolean> {
    const project = state().project;
    if (!project || state().phase === "saving") return false;
    if (!isDirty()) return true;
    const baseline = state().saved;
    const nextAppId = state().draft.appId.trim();
    const didChangeAppId = Boolean(baseline && nextAppId !== baseline.appId.trim());
    if (didChangeAppId && deps.hasDirtyDocs?.() === true) {
      const warnMsg = "修改应用包名 (appId) 前请先保存所有未保存的文件标签页";
      store.update({ error: warnMsg, errors: { ...state().errors, appId: warnMsg, form: warnMsg } });
      toasts.warning(warnMsg);
      return false;
    }
    const { body, errors } = buildBody();
    if (Object.keys(errors).length > 0) {
      const firstErr = Object.values(errors)[0];
      store.update({ errors, error: firstErr });
      return false;
    }
    store.update({ phase: "saving", errors: {}, error: undefined, message: undefined });
    const mine = epoch;
    try {
      const config = await client.project.settings.set(project, body);
      if (mine !== epoch || state().project !== project) return true; // the project changed meanwhile; the write itself succeeded
      const values = toValues(config);
      const buildNum = num(asRecord(config)?.build) ?? state().baselineBuild;
      store.update({
        phase: "ready",
        saved: values,
        draft: values,
        baselineBuild: buildNum,
        title: str(asRecord(config)?.title) ?? state().title,
        errors: {},
        error: undefined,
      });
      if (didChangeAppId) {
        await deps.onAppIdRenamed?.();
      }
      toasts.success("项目设置已保存");
      deps.onSaved?.(config as Record<string, unknown>);
      return true;
    } catch (error) {
      if (mine !== epoch) return false;
      const raw = (error as { message?: unknown })?.message;
      const message = typeof raw === "string" && raw ? raw : errorText(error);
      const targetField = fieldOfMessage(message);
      const key = targetField && targetField !== "build" ? targetField : "form";
      store.update({ phase: "ready", error: message, errors: { [key]: message } });
      return false;
    }
  }

  /** Used before the project changes or this guest is replaced: true when it is safe to drop the draft. */
  async function confirmLeave(): Promise<boolean> {
    if (!isDirty()) return true;
    const names = dirtyFields().map((f) => ({ name: "显示名称", appId: "应用 ID", version: "版本", tickHz: "帧率", reuse: "复用的已发布包" })[f]).join("、");
    const result = await dialogs.open({
      title: "项目设置尚未保存", body: `${state().project ?? "当前项目"} 的 ${names} 有未保存的更改。`,
      confirmLabel: "保存并继续", cancelLabel: "取消", choices: [{ id: "discard", label: "不保存，继续", danger: true }],
    });
    if (result.kind === "cancel") return false;
    if (result.kind === "confirm") return save();
    reset();
    return true;
  }

  return { store, state, load, attach, setField, reset, save, confirmLeave, dirty: isDirty, dirtyFields, appIdChanged };
}
export type ProjectSettings = ReturnType<typeof createProjectSettings>;
