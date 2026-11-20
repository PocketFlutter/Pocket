// Composition root of the Studio state. app.tsx only creates this and renders
// the 5-Zone Desktop IDE Workbench shell; zones and pages read the sub-stores they need.
import { createStore } from "./store.ts";
import { createToasts } from "./toasts.ts";
import { createDialogs } from "./dialogs.ts";
import { createWorkspace } from "./workspace.ts";
import { createBuild } from "./build.ts";
import { createPreview, type PreviewRuntime } from "./preview.ts";
import { createDeploy } from "./deploy.ts";
import { createSettings, type SettingsBackend } from "./settings.ts";
import { createProjects } from "./projects.ts";
import { createPublish } from "./publish.ts";
import { createArtifacts } from "./artifacts.ts";
import { createVersions } from "./versions.ts";
import { createCopier } from "./copy.ts";
import { createQuickOpen } from "./quick-open.ts";
import { createCommands } from "./commands.ts";
import { createSelfUpdate, type UpdateBackend } from "./self-update.ts";
import { createProjectSettings } from "./project-settings.ts";
import { createDiagnosticsExport } from "./diagnostics-export.ts";
import { createSdkUpgrade } from "./sdk-upgrade.ts";
import { createAssets, type FilesClient } from "./assets.ts";
import { createImagePreviews } from "./images.ts";
import { createResources } from "./resources.ts";
import { createEcosystemState } from "./ecosystem.ts";
import { createCosState } from "./cos.ts";
import { createWorkbench } from "./workbench.ts";
import type { UpdateHandoff } from "./update-link.ts";
import type { Timers } from "./env.ts";
import type { StudioClient } from "../studio-client.ts";

export type StudioPage = "projects" | "source" | "console" | "preview" | "resources" | "settings" | "artifacts" | "publish" | "versions";
/** Rail order; Cmd+1..9 select by position. */
export const STUDIO_PAGES: readonly StudioPage[] = ["projects", "source", "console", "preview", "resources", "settings", "artifacts", "publish", "versions"];

export interface StudioDeps {
  client: StudioClient;
  timers: Timers;
  runtime: PreviewRuntime;
  settingsBackend: SettingsBackend;
  /** Builds the guest-controlled update backend (M6 self-update) around the Studio's portable UI state; optional. */
  updates?: (handoff: UpdateHandoff) => UpdateBackend;
  /** System clipboard client for the code editor (the guest's `clipboard.*` capability client); optional. */
  clipboard?: { readText(): Promise<string | null>; writeText(text: string): Promise<void> };
  /** The guest's `files.*` client (open dialog + chunked reads) for asset uploads; optional (hosts without the file picker). */
  files?: FilesClient;
}

export function createStudio(deps: StudioDeps) {
  const { client, timers } = deps;
  const nav = createStore<{ page: StudioPage }>({ page: "projects" });
  const workbench = createWorkbench();
  const toasts = createToasts(timers);
  const dialogs = createDialogs();
  const settings = createSettings({ backend: deps.settingsBackend, toasts });
  const workspace = createWorkspace({ client, toasts, dialogs, timers, editorKind: () => settings.get().editor });
  const build = createBuild({ client, timers, toasts });
  // Switching to the InputField hands each CodeView buffer's text back to its document.
  settings.store.subscribe(() => { if (settings.get().editor !== "code") workspace.releaseEditors(); });
  let projects!: ReturnType<typeof createProjects>;
  const preview = createPreview({
    client,
    runtime: deps.runtime,
    build,
    timers,
    toasts,
    project: () => projects.current(),
    viewportPreset: () => workbench.state().viewportPreset,
    setViewportPreset: (preset) => workbench.setViewportPreset(preset),
  });
  const deploy = createDeploy({ client, timers, toasts, build, project: () => projects.current() });
  // M5: publish / inspect. Keys stay in the service; these stores only hold public facts.
  const copy = createCopier({ clipboard: deps.clipboard, toasts });
  const versions = createVersions({ client, toasts, project: () => projects.current() });
  const artifacts = createArtifacts({ client, toasts, project: () => projects.current() });
  const cos = createCosState({
    client,
    toasts,
    dialogs,
    onPublished: () => { void versions.refresh(); },
  });
  const publish = createPublish({
    client, timers, toasts, dialogs, build, project: () => projects.current(),
    hasUnsavedEdits: () => workspace.dirtyDocs().length > 0,
    onPublished: (res) => {
      void versions.refresh();
      const cur = projects.current();
      if (res?.cosPublish) cos.syncFromPublish(res.cosPublish);
      if (cur) {
        void cos.load(cur);
        void projectSettings.load(cur);
      }
    },
  });
  const ecosystem = createEcosystemState({
    client,
    toasts,
    onApplied: () => {
      void workspace.refreshTree();
      void build.refresh();
      void publish.refresh();
    },
  });
  // A finished build changes what can be published and what the inspector shows.
  build.onDone(() => {
    const cur = projects.current();
    if (!cur) return;
    if (publish.state().planState !== "idle") void publish.loadPlan();
    if (artifacts.state().loaded) void artifacts.refresh();
    void projectSettings.load(cur);
  });
  // Unsaved work of any kind (open files, the project settings draft) is asked about as one step.
  const confirmLeave = async (): Promise<boolean> => (await workspace.confirmLeave()) && (await projectSettings.confirmLeave());
  const projectSettings = createProjectSettings({
    client, toasts, dialogs,
    hasDirtyDocs: () => workspace.dirtyDocs().length > 0,
    onAppIdRenamed: async () => {
      await workspace.refreshTree();
      for (const doc of [...workspace.state().docs]) {
        await workspace.reconcile(doc.path);
      }
    },
    // A save bumps the service revision and may rename the project: every view derived from it refreshes.
    onSaved: () => {
      void projects.refresh();
      void build.refresh();
      if (publish.state().planState !== "idle") void publish.loadPlan();
      if (artifacts.state().loaded) void artifacts.refresh();
    },
  });
  // Resources page: asset upload (file dialog), host-decoded image previews and the placement editor.
  const previews = createImagePreviews();
  const resources = createResources({ client, toasts, dialogs, project: () => projects.current() });
  const assets = createAssets({
    client, files: deps.files, toasts, dialogs, project: () => projects.current(),
    existing: () => workspace.state().assets,
    onUploaded: (name) => {
      void workspace.refreshTree();
      void resources.refreshIfIdle();
      if (workspace.state().asset?.name === name) void workspace.selectAsset(name);
    },
  });
  build.onDone(() => { if (resources.state().loaded) void resources.refreshIfIdle(); });
  const diagnostics = createDiagnosticsExport({ client, toasts, project: () => projects.current() });
  const sdkUpgrade = createSdkUpgrade({ client, timers, toasts, dialogs, confirmLeave });

  let selfUpdate!: ReturnType<typeof createSelfUpdate>;

  /** Synchronizes page navigation (rail, Cmd+1..9, self-update restore) with the 5-Zone Desktop Workbench. */
  function setPage(page: StudioPage): void {
    nav.update({ page });
    const cur = projects?.current();
    switch (page) {
      case "projects":
        workbench.patch({ projectMenuOpen: true });
        break;
      case "source":
        workbench.patch({ projectMenuOpen: false, sourceOpen: true });
        break;
      case "preview":
        workbench.patch({ projectMenuOpen: false });
        break;
      case "console":
        workbench.patch({ projectMenuOpen: false, consoleOpen: true, consoleTab: "build" });
        break;
      case "artifacts":
        workbench.patch({ projectMenuOpen: false, consoleOpen: true, consoleTab: "artifacts" });
        if (cur) void artifacts.refresh();
        break;
      case "resources":
        workbench.patch({ projectMenuOpen: false, inspectorOpen: true, inspectorTab: "resources" });
        if (cur && !resources.state().loaded) void resources.refresh();
        break;
      case "publish":
        workbench.patch({ projectMenuOpen: false, inspectorOpen: true, inspectorTab: "versions", versionsSubTab: "publish" });
        if (cur) void publish.enter();
        break;
      case "versions":
        workbench.patch({ projectMenuOpen: false, inspectorOpen: true, inspectorTab: "versions", versionsSubTab: "versions" });
        if (cur) {
          void versions.refresh();
          void cos.load(cur);
        }
        break;
      case "settings":
        workbench.patch({ projectMenuOpen: false, inspectorOpen: true, inspectorTab: "settings" });
        if (selfUpdate) void selfUpdate.load();
        if (cur) {
          void projectSettings.load(cur);
          void ecosystem.load(cur);
        }
        break;
    }
  }

  projects = createProjects({
    client, toasts,
    confirmLeave,
    onOpen: async (id) => {
      quickOpen.hide();
      workbench.patch({ projectMenuOpen: false });
      diagnostics.reset();
      ecosystem.unload();
      cos.unload();
      void projectSettings.attach(id);
      void ecosystem.load(id);
      void cos.load(id);
      await preview.reset();
      deploy.reset();
      publish.reset();
      artifacts.reset();
      versions.reset();
      assets.reset();
      resources.reset();
      previews.forget();
      build.attach(id);
      await workspace.load(id);
    },
    onOpened: () => {
      workbench.patch({
        projectMenuOpen: false,
        sourceOpen: true,
        consoleOpen: true,
        inspectorOpen: true,
      });
      nav.update({ page: "source" });
    },
  });

  // M7: keyboard shell. One keymap (keymap.ts) -> one command table; quick-open is the fuzzy file finder.
  const quickOpen = createQuickOpen({
    paths: () => workspace.state().files.map((f) => f.path),
    recent: () => { const { docs, active } = workspace.state(); return [...(active ? [active] : []), ...docs.map((d) => d.path).filter((p) => p !== active)]; },
    openFile: (path) => workspace.open(path),
    onChosen: (path) => {
      setPage("source");
      workspace.requestFocus(path);
    },
  });
  const commands = createCommands({
    pages: STUDIO_PAGES, page: () => nav.get().page, setPage, project: () => projects.current(),
    workspace, build, preview, publish, dialogs, quickOpen, toasts, workbench,
  });

  // Auto-build: a save (after a quiet period) triggers build -> publish -> reload.
  let cancelAuto: (() => void) | undefined;
  workspace.onSaved(() => {
    if (!settings.get().autoBuild) return;
    cancelAuto?.();
    const savedAt = timers.now();
    cancelAuto = timers.after(settings.get().debounceMs, () => { cancelAuto = undefined; void preview.run({ build: true, since: savedAt }); });
  });

  // M6: self-update. Only portable UI state crosses an update (the page and the open project); the new guest
  // validates it synchronously and the project is reopened once the project list is back.
  const pages = STUDIO_PAGES;
  let restored: { page: StudioPage; project?: string } | undefined;
  const handoff: UpdateHandoff = {
    capture: () => ({ page: nav.get().page, project: projects.current() ?? null }),
    restore: (value) => {
      const v = value as { page?: unknown; project?: unknown } | null;
      if (!v || typeof v !== "object" || Array.isArray(v) || !pages.includes(v.page as StudioPage)) return false;
      if (v.project !== null && v.project !== undefined && (typeof v.project !== "string" || v.project.length > 64)) return false;
      restored = { page: v.page as StudioPage, ...(typeof v.project === "string" ? { project: v.project } : {}) };
      setPage(restored.page);
      return true;
    },
  };
  const updateBackend = deps.updates?.(handoff);
  selfUpdate = createSelfUpdate({ backend: updateBackend, toasts, confirmLeave });

  void settings.load();
  // Reopen the project only after BOTH the project list and the handoff restore have settled (either can come first).
  // Load Studio self-update & SDK upgrade status right after project.list is dispatched so project.list stays first.
  const initialProjects = projects.refresh();
  void selfUpdate.load();
  void initialProjects.then(() => { void sdkUpgrade.load(); });
  void Promise.all([initialProjects, Promise.resolve(updateBackend?.ready).catch(() => false)]).then(async () => {
    const back = restored;
    if (back?.project && projects.state().list.some((p) => p.id === back.project)) {
      if (await projects.open(back.project)) setPage(back.page);
    }
  });

  return {
    nav, page: () => nav.get().page, setPage, workbench,
    toasts, dialogs, workspace, build, settings, preview, deploy, projects,
    publish, artifacts, versions, assets, resources, previews, copy, selfUpdate, quickOpen, commands, projectSettings, diagnostics, sdkUpgrade,
    ecosystem, cos,
    client, timers, clipboard: deps.clipboard,
  };
}
export type Studio = ReturnType<typeof createStudio>;
