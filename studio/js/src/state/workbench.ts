// Multi-zone Desktop IDE Workbench state (Zone C Source Split, Zone D Stage & Console Dock,
// Zone E Right Tabbed Inspector, and Zone A Project Switcher Popover), synchronized with StudioPage.
import { createStore } from "./store.ts";

export type ConsoleTab = "build" | "deploy" | "artifacts" | "signing";
export type InspectorTab = "resources" | "versions" | "settings";
export type VersionsSubTab = "publish" | "versions";
export type SettingsSection = "studio" | "project" | "service";
export type ResourcesSubTab = "files" | "placement";
export type ViewportPreset = "mobile" | "tablet" | "desktop";
export type WorkbenchPreviewTargetId = "flutter" | "web" | "wechat" | "widget" | "widgetAlt";

export interface WorkbenchState {
  /** Whether the viewport is currently in wide 5-zone desktop mode (`>= 1160px`). */
  wide: boolean;
  /** Zone C: Docked Left Source Split (`#source-dock`). */
  sourceOpen: boolean;
  /** Collapsible FileTree inside Zone C. */
  treeOpen: boolean;
  /** Resizable width of Zone C in wide desktop mode. */
  sourceWidth: number;
  /** Zone D bottom: Collapsible `.console-dock`. */
  consoleOpen: boolean;
  /** Expanded height toggle for `.console-dock`. */
  consoleTall: boolean;
  /** Active tab in `.console-dock`. */
  consoleTab: ConsoleTab;
  /** Zone E: Right Tabbed Inspector (`.inspector-column`). */
  inspectorOpen: boolean;
  /** Active tab in `.inspector-column`. */
  inspectorTab: InspectorTab;
  /** Sub-view inside Inspector -> Versions & Publish (`publish` plan vs `versions` & COS). */
  versionsSubTab: VersionsSubTab;
  /** Active sub-section in Settings. */
  settingsSection: SettingsSection;
  /** Active sub-tab in Resources (`files` vs `placement`). */
  resourcesTab: ResourcesSubTab;
  /** Zone A: Project Switcher dropdown menu open state. */
  projectMenuOpen: boolean;
  /** Zone D: Preview stage viewport preset. */
  viewportPreset: ViewportPreset;
  /** Zone D: Show device bezel shell (`9:41` status bar, Dynamic Island, home indicator). */
  bezelEnabled: boolean;
  /** Zone D: Currently focused preview target card on the multi-surface stage. */
  focusedPreviewTarget: WorkbenchPreviewTargetId;
}

export const SOURCE_DOCK_LIMITS = { min: 340, max: 580 } as const;

const clampSourceWidth = (w: number): number =>
  Math.min(SOURCE_DOCK_LIMITS.max, Math.max(SOURCE_DOCK_LIMITS.min, Math.round(w)));

export function createWorkbench() {
  const store = createStore<WorkbenchState>({
    wide: false,
    sourceOpen: false,
    treeOpen: true,
    sourceWidth: 388,
    consoleOpen: true,
    consoleTall: false,
    consoleTab: "build",
    inspectorOpen: true,
    inspectorTab: "resources",
    versionsSubTab: "publish",
    settingsSection: "studio",
    resourcesTab: "files",
    projectMenuOpen: false,
    viewportPreset: "mobile",
    bezelEnabled: true,
    focusedPreviewTarget: "flutter",
  });

  const state = () => store.get();

  return {
    store,
    state,
    patch: (patch: Partial<WorkbenchState>) => store.update(patch),
    setWide: (wide: boolean) => {
      if (state().wide !== wide) store.update({ wide });
    },
    setSourceWidth: (width: number) => store.update({ sourceWidth: clampSourceWidth(width) }),
    toggleSource: () => store.update({ sourceOpen: !state().sourceOpen, projectMenuOpen: false }),
    toggleTree: () => store.update({ treeOpen: !state().treeOpen }),
    toggleConsole: () => store.update({ consoleOpen: !state().consoleOpen }),
    toggleConsoleTall: () => store.update({ consoleTall: !state().consoleTall, consoleOpen: true }),
    setConsoleTab: (consoleTab: ConsoleTab) => store.update({ consoleTab, consoleOpen: true }),
    toggleInspector: () => store.update({ inspectorOpen: !state().inspectorOpen }),
    setInspectorTab: (inspectorTab: InspectorTab) => store.update({ inspectorTab, inspectorOpen: true }),
    setVersionsSubTab: (versionsSubTab: VersionsSubTab) =>
      store.update({ inspectorTab: "versions", versionsSubTab, inspectorOpen: true }),
    setSettingsSection: (settingsSection: SettingsSection) => store.update({ settingsSection }),
    setResourcesTab: (resourcesTab: ResourcesSubTab) => store.update({ resourcesTab }),
    toggleProjectMenu: () => store.update({ projectMenuOpen: !state().projectMenuOpen }),
    closeProjectMenu: () => {
      if (!state().projectMenuOpen) return false;
      store.update({ projectMenuOpen: false });
      return true;
    },
    setViewportPreset: (viewportPreset: ViewportPreset) => store.update({ viewportPreset }),
    toggleBezel: () => store.update({ bezelEnabled: !state().bezelEnabled }),
    setFocusedPreviewTarget: (focusedPreviewTarget: WorkbenchPreviewTargetId) =>
      store.update({ focusedPreviewTarget }),
  };
}

export type Workbench = ReturnType<typeof createWorkbench>;
