import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { after, simulationHz } from "@pocketjs/framework/clock";
import {
  FocusScope,
  Focusable,
  Image,
  Lazy,
  Named,
  Screen,
  Text,
  View,
} from "@pocketjs/framework/solid/components";
import {
  MobileButton,
  MobileCard,
  InputField,
  MiniBarChart,
  MobileAlert,
  MobileBadge,
  MobileBackButton,
  RouteView,
  MobileThemeProvider,
  AccessibilityPreferencesProvider,
  AppleSemanticsProvider,
  createAccessibilityPreferences,
  createMobileTheme,
  useMobileTheme,
  toMobileColor,
  MobileDialog,
  MobilePopup,
  MobileSegmentedControl,
  MobileToast,
  NavigationBar,
  MobileAppBar,
  SafeAreaScaffold,
  ScrollContourItem,
  ScrollablePage,
  MobileListTile,
  MobileParagraph,
  deliverTextInputEvent,
  useScrollContourReserve,
  ShadcnAspectRatio,
  ShadcnBreadcrumb,
  ShadcnButtonGroup,
  ShadcnCalendar,
  ShadcnCarousel,
  ShadcnChart,
  ShadcnCollapsible,
  ShadcnCombobox,
  ShadcnCommand,
  ShadcnContextMenu,
  ShadcnDataTable,
  ShadcnDatePicker,
  ShadcnDrawer,
  ShadcnDropdownMenu,
  ShadcnEmpty,
  ShadcnFormField,
  ShadcnHoverCard,
  ShadcnInputGroup,
  ShadcnInputOTP,
  ShadcnItem,
  ShadcnKbd,
  ShadcnMenubar,
  ShadcnNavigationMenu,
  ShadcnPagination,
  ShadcnPopover,
  ShadcnResizable,
  ShadcnScrollArea,
  ShadcnSelect,
  ShadcnSeparator,
  ShadcnSheet,
  ShadcnSidebar,
  ShadcnSpinner,
  ShadcnTable,
  ShadcnTextarea,
  ShadcnToggleGroup,
  ShadcnTooltip,
  ShadcnTypography,
  PocketLifecycleProvider,
  PocketRouteScope,
  PocketRouterProvider,
  PocketVirtualList,
  SkinAppBar,
  SkinBackButton,
  SkinBadge,
  SkinButton,
  SkinCard,
  SkinDialog,
  SkinListTile,
  SkinNavigationBar,
  SkinParagraph,
  SkinScaffold,
  SkinSegmentedControl,
  UiSkinProvider,
  createPocketRouter,
  createPocketSystemUiSync,
  defaultSkinAdapter,
  getUiSkin,
  useUiSkin,
  type PocketHistoryEntry,
  type PocketRouteDefinition,
} from "@pocket/ui";
import {
  SurfaceEnvironmentProvider,
  WidgetSnapshotProvider,
  useSurfaceEnvironment,
} from "@pocket/ui/surfaces";
import { looseleafSkinAdapter } from "@pocket/looseleaf";
import { arcSkinAdapter } from "@pocket/arc";
import { liquidGlassSkinAdapter } from "@pocket/liquid_glass";
import { HardwarePage, MobileUiPage, TransitionsPage } from "./mobile-pages.tsx";
import { createHostBridge, hostError, type HostBridge, type HostEvent, type JsonValue } from "@pocket/ui/host";
import {
  PocketBackInterceptorProvider,
  PocketBackRouteActiveProvider,
  createPocketBackInterceptorRegistry,
  createPocketBackNavigation,
  shouldCommitPocketBackGesture,
  type PocketBackGestureEvent,
} from "@pocket/ui/back-navigation";
import { VideoPage } from "./video-page.tsx";
import { RecordingPanel } from "./recording-panel.tsx";
import { MiniAppUpdatesPage } from "./mini-app-updates.tsx";
import { createPocketPlatformClient, type AppLaunchOptions } from "@pocket/ui/platform";
import { createPlatformExperience } from "@pocket/ui/platform-experience";
import { SystemAppSurfaces } from "@pocket/ui/system-surfaces";
import { installShowcaseSystem } from "./system.ts";
import { showcaseUpdateState } from "./update-state.ts";
import { SettingsPage, readAppearance, storedAppearance } from "./settings.tsx";
import { ApplePage } from "./apple-page.tsx";
import { LooseleafPage } from "./looseleaf-page.tsx";
import { SkinStudioPage } from "./skin-studio-page.tsx";
import { UIKitGalleryReplicaPage } from "./uikit-gallery-page.tsx";
import { RouterStudioPage } from "./router-page.tsx";
import { StressLabPage } from "./stress-page.tsx";
import { EcosystemStudioPage, ShowcaseSystemWidgetRoot } from "./ecosystem-page.tsx";
import { computeTransitionDescriptor, createDisplayGeometry, type TransitionMode } from "@pocket/ui";
import {
  isPrimaryRoute,
  PERFORMANCE_HISTORY_LIMIT,
  PERFORMANCE_JANK_LIMIT,
  initialDemoState,
  appendPerformanceSample,
  parsePerformancePoint,
  parsePerformanceSnapshot,
  reduceDemoState,
  type AccentColor,
  type CapabilityKey,
  type CapabilityState,
  type DemoEvent,
  type DemoState,
  type InterfaceDensity,
  type MiniAppPresentationMode,
  type PerformanceJank,
  type PerformancePoint,
  type PerformanceSnapshot,
  type Route,
  type ShowcaseSkin,
} from "./state.ts";

type BridgeMessage = {
  type?: string;
  method?: string;
  name?: string;
  params?: Record<string, unknown>;
  payload?: Record<string, unknown>;
};

const bridge = globalThis as typeof globalThis & {
  __pocketEvent?: (line: string) => void;
};

const componentCards = [
  "View",
  "Text",
  "Image",
  "Focusable",
  "Grid",
  "For",
  "Lazy",
  "Modal",
  "TextField",
];

const componentDetails: Record<string, string> = {
  View: "Flexible layout and spacing.",
  Text: "Typography drawn by the active host.",
  Image: "Local images from the app bundle.",
  Focusable: "Tap and keyboard interactions.",
  Grid: "Responsive rows and columns.",
  For: "Reactive lists owned by JavaScript.",
  Lazy: "Mount content only when needed.",
  Modal: "A guest-controlled overlay.",
  TextField: "Native keyboard. State stays in JS.",
};

const hostTabs = [
  { id: "about", label: "Runtime" },
  { id: "bytecode", label: "Bytecode" },
  { id: "updates", label: "Updates" },
  { id: "plugins", label: "Plugins" },
  { id: "stress", label: "Stress" },
];

const demoTitle = "Pocket";
const showcaseTabs = [
  { id: "home" as const, label: "Home", kind: "home" as const },
  { id: "gallery" as const, label: "UI", kind: "gallery" as const },
  { id: "about" as const, label: "Host", kind: "host" as const },
  { id: "settings" as const, label: "Settings", kind: "settings" as const },
];

type BackGestureTarget =
  | { kind: "route"; fromRoute: Route; toRoute: Route }
  | { kind: "mini-app"; instanceId: string; requestId: string };

type ActiveBackGesture = {
  gestureId: string;
  target: BackGestureTarget;
  width: number;
  progress: number;
  phase: "dragging" | "settling" | "committing";
  settleFrom: number;
  settleTo: number;
  settleElapsedMs: number;
  settleDurationMs: number;
};

function decode(line: string): BridgeMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as BridgeMessage : undefined;
  } catch {
    return undefined;
  }
}

function paramsOf(message: BridgeMessage): Record<string, unknown> {
  return message.params ?? message.payload ?? {};
}

const SHOWCASE_ROUTES: readonly PocketRouteDefinition<Route>[] = [
  { id: "home", path: "/home", aliases: ["/"], primary: true },
  { id: "gallery", path: "/gallery", aliases: ["/ui"], primary: true },
  { id: "about", path: "/about", aliases: ["/host"], primary: true },
  { id: "settings", path: "/settings", primary: true },
  { id: "skins", path: "/skins/:tab?", parent: "gallery" },
  { id: "uikit-gallery", path: "/uikit-gallery/:component?", aliases: ["/kit-gallery"], parent: "gallery" },
  { id: "looseleaf", path: "/looseleaf/:section?", parent: "gallery" },
  { id: "apple", path: "/apple", parent: "gallery" },
  { id: "router", path: "/router", aliases: ["/deeplink"], parent: "gallery" },
  { id: "ecosystem", path: "/ecosystem", aliases: ["/widgets"], parent: "gallery" },
  { id: "mobile", path: "/mobile/:section?", parent: "home" },
  { id: "transitions", path: "/transitions", parent: "home" },
  { id: "hardware", path: "/hardware", parent: "home" },
  { id: "video", path: "/video", parent: "home" },
  { id: "miniapps", path: "/miniapps", parent: "home" },
  { id: "bytecode", path: "/bytecode", parent: "about" },
  { id: "updates", path: "/updates", parent: "about" },
  { id: "plugins", path: "/plugins", parent: "about" },
  { id: "stress", path: "/stress", parent: "about" },
  { id: "performance", path: "/performance", parent: "about" },
];

function routeOf(value: unknown): Route | undefined {
  const route = String(value ?? "");
  // `gallery` remains the old probe's compatibility spelling for UI.
  if (route === "settings" || route === "home" || route === "gallery" || route === "about" || route === "bytecode" || route === "updates" || route === "miniapps" || route === "plugins" || route === "stress" || route === "performance" || route === "mobile" || route === "transitions" || route === "hardware" || route === "video" || route === "apple" || route === "looseleaf" || route === "skins" || route === "uikit-gallery" || route === "router" || route === "ecosystem") return route;
  if (route === "kit-gallery") return "uikit-gallery";
  if (route === "ui") return "gallery";
  if (route === "host") return "about";
  if (route === "deeplink") return "router";
  if (route === "widgets") return "ecosystem";
  return undefined;
}

function capabilityUnavailable(state: CapabilityState): boolean {
  return !!state.result && typeof state.result === "object" &&
    (state.result as Record<string, unknown>).supported === false;
}

function hostLabel(state: CapabilityState): string {
  const result = state.result && typeof state.result === "object" ? state.result as Record<string, unknown> : {};
  const provider = result.provider ?? result.host;
  return typeof provider === "string" && provider.length > 0 ? provider : "Pocket host";
}

function supportsRecording(state: CapabilityState): boolean {
  const result = state.result && typeof state.result === "object" ? state.result as Record<string, unknown> : {};
  const features = result.features as Record<string, unknown> | undefined;
  // Keep legacy hosts usable: only an explicit false disables the optional
  // panel. The action still reports the real host error if the provider is
  // absent; missing metadata is not evidence of unsupported recording.
  return features?.recording !== false;
}

function hostPhase(state: CapabilityState): string {
  if (state.phase === "idle") return "Not requested";
  if (state.phase === "loading") return "Loading";
  if (state.phase === "ready") return capabilityUnavailable(state) ? "Unavailable" : "Ready";
  return "Error";
}

function toneForPhase(state: CapabilityState): "accent" | "success" | "warning" | "danger" {
  if (state.phase === "ready") return capabilityUnavailable(state) ? "warning" : "success";
  if (state.phase === "error") return "danger";
  if (state.phase === "loading") return "warning";
  return "accent";
}

function valueSummary(value: unknown): string {
  if (value === null || value === undefined) return "No result payload";
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.supported === false) {
      return String(record.reason ?? "This capability is unavailable in the active host.");
    }
    if ("entryFormat" in record || "runtimeAbi" in record) {
      const entry = String(record.entryFormat ?? "entry unknown");
      const abi = String(record.runtimeAbi ?? "ABI unknown");
      const version = record.version === undefined ? "" : ` · v${String(record.version)}`;
      const build = record.build === undefined ? "" : ` build ${String(record.build)}`;
      const source = record.source === undefined ? "" : ` · ${String(record.source)}`;
      const glass = record.glassRenderer === undefined ? "" : ` · glassRenderer=${String(record.glassRenderer)}`;
      const surfaces = record.hostSurfaces === undefined ? "" : ` · surfaces=${String(record.hostSurfaces)}`;
      return `${entry} · ${abi}${version}${build}${source}${glass}${surfaces}`;
    }
    if ("activeVersion" in record || "availableVersion" in record || "configured" in record) {
      return [
        `configured=${String(record.configured ?? "unknown")}`,
        `stage=${String(record.stage ?? "unknown")}`,
        `active=${String(record.activeVersion ?? "none")}`,
        `available=${String(record.availableVersion ?? "none")}`,
        `lastError=${String(record.lastError ?? "none")}`,
      ].join(" · ");
    }
    if ("history" in record && "recording" in record) {
      const history = Array.isArray(record.history) ? record.history.length : 0;
      const latest = record.latest && typeof record.latest === "object"
        ? String((record.latest as Record<string, unknown>).fps ?? "unknown")
        : "unknown";
      return `recording=${String(record.recording)} · samples=${history} · guestTicksPerSecond=${latest}`;
    }
    if (Array.isArray(record.plugins)) return `${record.plugins.length} plugin descriptor(s)`;
    if ("packageName" in record || "provider" in record) {
      return [record.provider, record.appName, record.packageName, record.version, record.buildNumber]
        .filter((entry) => entry !== undefined)
        .map(String)
        .join(" · ");
    }
  }
  try {
    const encoded = JSON.stringify(value);
    if (!encoded) return String(value);
    return encoded.length > 180 ? `${encoded.slice(0, 177)}...` : encoded;
  } catch {
    return String(value);
  }
}

function capabilitySummary(state: CapabilityState): string {
  if (state.phase === "error") return `${state.error?.code ?? "host_error"}: ${state.error?.message ?? "Host request failed"}`;
  if (state.phase === "loading") return "Waiting for host.response...";
  if (state.phase === "idle") return "No host request has been made.";
  return valueSummary(state.result);
}

function summaryLines(value: string): string[] {
  // PocketJS text runs are deliberately explicit: keep provider diagnostics
  // readable on a 390px device instead of relying on Flutter text wrapping.
  const segments = value.split(" · ");
  const lines: string[] = [];
  for (const segment of segments) {
    if (segment.length <= 34) {
      lines.push(segment);
      continue;
    }
    let remaining = segment;
    while (remaining.length > 34) {
      let cut = remaining.lastIndexOf(" ", 34);
      if (cut < 12) cut = 34;
      lines.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) lines.push(remaining);
  }
  return lines.length > 0 ? lines : ["No result payload"];
}

function listItems(value: unknown): { id: string; title: string; detail?: string }[] {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { plugins?: unknown }).plugins)
      ? (value as { plugins: unknown[] }).plugins
      : [];
  return source.map((item, index) => {
    if (item && typeof item === "object") {
      const record = item as { id?: unknown; name?: unknown; version?: unknown; description?: unknown };
      const title = String(record.name ?? record.id ?? `Plugin ${index + 1}`);
      const detail = [record.version, record.description].filter((entry) => entry !== undefined).map(String).join(" · ");
      return { id: `${index}-${title}`, title, detail: detail || undefined };
    }
    return { id: `${index}-${String(item)}`, title: String(item) };
  });
}

type VersionHistoryItem = { id: string; title: string; detail: string };

function versionHistory(value: unknown): VersionHistoryItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const versions = (value as { versions?: unknown }).versions;
  if (!Array.isArray(versions)) return [];
  return versions.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const version = String(record.version ?? record.versionId ?? `Version ${index + 1}`);
    const build = record.build === undefined ? "unknown" : String(record.build);
    const markers = [
      record.active === true ? "active" : "",
      record.previous === true ? "previous" : "",
      record.lastGood === true ? "last good" : "",
    ].filter(Boolean);
    return [{
      id: `${index}-${version}-${build}`,
      title: `${version} · build ${build}`,
      detail: markers.length > 0 ? markers.join(" · ") : "verified version",
    }];
  });
}


function metricNumber(value: number | undefined, digits = 1): string {
  return value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function timestampLabel(value: string | number): string {
  return String(value);
}

function recentPerformance(snapshot: PerformanceSnapshot): PerformancePoint[] {
  return snapshot.history.slice(-PERFORMANCE_HISTORY_LIMIT);
}

function performanceBudget(point: PerformancePoint | undefined): number | undefined {
  if (!point) return undefined;
  if (point.frameBudgetMs !== undefined && point.frameBudgetMs > 0) return point.frameBudgetMs;
  if (point.refreshHz !== undefined && point.refreshHz > 0) return 1000 / point.refreshHz;
  return undefined;
}

function performanceGap(point: PerformancePoint | undefined): number | undefined {
  if (!point) return undefined;
  return point.activeGapMs ?? point.maxGapMs;
}

function jankFromPoint(point: PerformancePoint): PerformanceJank[] {
  if (point.longFrameEvents && point.longFrameEvents.length > 0) return point.longFrameEvents;
  const gap = performanceGap(point);
  const budget = performanceBudget(point);
  const slowFrames = point.activeGapCount ?? point.slowFrames ?? 0;
  // Legacy samples already carry a provider-side slow-frame count. For newer
  // samples without that count, only classify a gap with the actual display
  // budget; a sparse guest that reports FPS 4.28 and gap 0 is not a jank.
  const exceedsBudget = gap !== undefined && budget !== undefined && gap > budget * 1.5;
  if (gap === undefined || (!exceedsBudget && slowFrames <= 0)) return [];
  return [{
    timestamp: point.timestamp,
    ...(gap !== undefined ? { durationMs: gap, activeGapMs: gap } : {}),
    ...(budget !== undefined ? { budgetMs: budget } : {}),
    reason: "window aggregate",
    ...(point.context !== undefined ? { context: point.context } : {}),
    ...(point.page !== undefined ? { page: point.page } : {}),
    ...(point.action !== undefined ? { action: point.action } : {}),
  }];
}

function sameJankEvent(first: PerformanceJank, second: PerformanceJank): boolean {
  if (String(first.timestamp) !== String(second.timestamp)) return false;
  if (first.reason === "window aggregate" || second.reason === "window aggregate") return true;
  const firstIdentity = first.context ?? (first.page || first.action ? `${first.page ?? ""}:${first.action ?? ""}` : undefined);
  const secondIdentity = second.context ?? (second.page || second.action ? `${second.page ?? ""}:${second.action ?? ""}` : undefined);
  if (firstIdentity !== undefined && secondIdentity !== undefined && firstIdentity !== secondIdentity) {
    const sharedFrameMetrics =
      (first.activeGapMs !== undefined && first.activeGapMs === second.activeGapMs) ||
      (first.durationMs !== undefined && first.durationMs === second.durationMs) ||
      (first.nativeMs !== undefined && first.nativeMs === second.nativeMs);
    if (!sharedFrameMetrics) return false;
  }
  return true;
}

function performanceScopeLabel(event: PerformanceJank): string {
  if (event.scope === "flutterView") return "Flutter view";
  if (event.scope === "pocketView") return "Pocket view";
  return event.scope ?? "Frame path";
}

function recentPerformanceJanks(snapshot: PerformanceSnapshot): PerformanceJank[] {
  const merged: PerformanceJank[] = [];
  const add = (event: PerformanceJank): void => {
    const index = merged.findIndex((existing) => sameJankEvent(existing, event));
    if (index >= 0) {
      const existing = merged[index]!;
      const refreshHz = event.refreshHz ?? existing.refreshHz;
      const budgetMs = event.budgetMs ?? existing.budgetMs;
      const durationMs = event.durationMs ?? existing.durationMs;
      const buildMs = event.buildMs ?? existing.buildMs;
      const rasterMs = event.rasterMs ?? existing.rasterMs;
      const nativeMs = event.nativeMs ?? existing.nativeMs;
      const activeGapMs = event.activeGapMs ?? existing.activeGapMs;
      const active = event.active ?? existing.active;
      const scope = event.scope === "flutterView" || existing.scope === "flutterView"
        ? "flutterView"
        : (event.scope ?? existing.scope);
      const reason = existing.reason ?? event.reason;
      const context = existing.context ?? event.context;
      const page = existing.page ?? event.page;
      const action = existing.action ?? event.action;
      merged[index] = {
        timestamp: existing.timestamp,
        ...(refreshHz !== undefined ? { refreshHz } : {}),
        ...(budgetMs !== undefined ? { budgetMs } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(buildMs !== undefined ? { buildMs } : {}),
        ...(rasterMs !== undefined ? { rasterMs } : {}),
        ...(nativeMs !== undefined ? { nativeMs } : {}),
        ...(activeGapMs !== undefined ? { activeGapMs } : {}),
        ...(active !== undefined ? { active } : {}),
        ...(scope !== undefined ? { scope } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(context !== undefined ? { context } : {}),
        ...(page !== undefined ? { page } : {}),
        ...(action !== undefined ? { action } : {}),
      };
    } else {
      merged.push(event);
    }
  };
  for (const event of snapshot.longFrameEvents ?? []) add(event);
  for (const point of recentPerformance(snapshot)) {
    for (const event of jankFromPoint(point)) add(event);
  }
  merged.sort((first, second) => {
    const firstTime = Date.parse(String(first.timestamp));
    const secondTime = Date.parse(String(second.timestamp));
    return Number.isFinite(firstTime) && Number.isFinite(secondTime) ? firstTime - secondTime : 0;
  });
  return merged.slice(-PERFORMANCE_JANK_LIMIT);
}

function performanceContextLabel(point: PerformanceJank): string {
  const page = point.page;
  const action = point.action;
  if (page && action) return `${page} · ${action}`;
  if (page) return page;
  if (action) return action;
  return point.context ?? "Host frame sampler";
}

function performanceJankRows(snapshot: PerformanceSnapshot): { id: string; title: string; detail: string; context: string }[] {
  return recentPerformanceJanks(snapshot)
    .slice()
    .reverse()
    .map((event, index) => {
      const gap = event.activeGapMs ?? event.durationMs;
      const metric = gap === undefined ? "long frame" : `${metricNumber(gap)} ms active gap`;
      const budgetMs = event.budgetMs;
      const budget = budgetMs === undefined ? "budget unavailable" : `budget ${metricNumber(budgetMs)} ms`;
      const breakdown = [
        event.buildMs === undefined ? "build —" : `build ${metricNumber(event.buildMs)} ms`,
        event.rasterMs === undefined ? "raster —" : `raster ${metricNumber(event.rasterMs)} ms`,
      ].join(" · ");
      const bridge = event.nativeMs === undefined ? "bridge/decode —" : `bridge/decode ${metricNumber(event.nativeMs)} ms`;
      const reason = event.reason ? ` · ${event.reason}` : "";
      return {
        id: `${index}-${String(event.timestamp)}-${String(gap ?? "long")}`,
        title: `${metric} · ${timestampLabel(event.timestamp)}${reason}`,
        detail: `${budget} · ${breakdown}`,
        context: `${bridge} · ${performanceScopeLabel(event)} · ${performanceContextLabel(event)}`,
      };
    });
}

function performanceBars(points: readonly PerformancePoint[]): number[] {
  if (points.length === 0) return [];
  // Use the visible sample window itself as the reference. Display refresh
  // rate and guest cadence can be 90/120/144Hz, so a 60 FPS floor would make
  // a high-refresh chart silently under-report those samples.
  const scale = Math.max(1, ...points.map((point) => point.fps));
  return points.map((point) => Math.max(4, Math.min(32, point.fps / scale * 32)));
}

function minimumPerformanceFps(points: readonly PerformancePoint[]): number | undefined {
  return points.length === 0 ? undefined : Math.min(...points.map((point) => point.fps));
}

function lowPerformanceRows(points: readonly PerformancePoint[]): { id: string; title: string; detail: string }[] {
  return [...points]
    .sort((first, second) => first.fps - second.fps)
    .slice(0, 5)
    .map((point, index) => ({
      id: `${index}-${String(point.timestamp)}`,
      title: `${metricNumber(point.fps)} guest ticks/s · ${timestampLabel(point.timestamp)}`,
      detail: `gap ${metricNumber(point.maxGapMs)} ms · slow ${metricNumber(point.slowFrames, 0)} · bridge/decode p95 ${metricNumber(point.nativeMsP95)} ms`,
    }));
}

function CapabilityCard(props: {
  title: string;
  capability: string;
  state: CapabilityState;
  onRefresh: () => void;
}): JSX.Element {
  const theme = useMobileTheme();
  const [expanded, setExpanded] = createSignal(true);
  const lines = () => summaryLines(capabilitySummary(props.state));
  return (
    <MobileCard title={props.title} detail={props.capability}>
      <MobileBadge tone={toneForPhase(props.state)} label={hostPhase(props.state)} />
      <Show when={expanded()}>
        <View class="flex-col gap-1 w-full" style={{ minW: 0 }}>
          <For each={lines()}>{(line) => <MobileParagraph text={line} class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"} />}</For>
        </View>
      </Show>
      <View class="flex-row items-center gap-2">
        <MobileButton label={expanded() ? "Hide details" : "Details"} kind="text" onPress={() => setExpanded(!expanded())} />
        <MobileButton label={props.state.phase === "loading" ? "Waiting" : "Refresh"} kind="text" onPress={props.onRefresh} />
      </View>
    </MobileCard>
  );
}

function App() {
  const [state, setState] = createSignal<DemoState>(initialDemoState());
  const [routeTransition, setRouteTransition] = createSignal<{
    from: Route;
    to: Route;
    direction: "forward" | "reverse";
    elapsedMs: number;
    progress: number;
  } | undefined>(undefined);
  // The stack is the navigation source of truth. The Set is only an instance
  // cache for visited primary tabs; popped secondary routes leave this list
  // after their reverse transition. Every retained route owns its actual
  // local signals and ScrollablePage instead of mirrored scroll snapshots.
  const primaryPages = new Set<Route>(["home"]);
  const stack = createMemo(() => state().routeStack);
  const mountedRoutes = createMemo(() => {
    const entries = stack();
    for (const route of entries) if (isPrimaryRoute(route)) primaryPages.add(route);
    const mounted = [...primaryPages, ...entries.filter((route) => !isPrimaryRoute(route))];
    const transition = routeTransition();
    if (transition?.direction === "reverse" && !mounted.includes(transition.from)) {
      // A pop removes the route from the stack immediately. Keep its existing
      // subtree alive above the destination until the shared reverse
      // transition finishes so the outgoing page can slide off to the right.
      mounted.push(transition.from);
    }
    return mounted;
  });
  const displayGeometry = createDisplayGeometry();
  // One persisted appearance applies to the canvas and every mounted route.
  const mobileDark = () => state().mobileDark;
  const theme = () => createMobileTheme(mobileDark(), state().accentColor);
  const [preferencesReady, setPreferencesReady] = createSignal(false);
  const [preferencesStatus, setPreferencesStatus] = createSignal("Loading your preferences…");
  let saveQueue: Promise<void> = Promise.resolve();
  let saveRevision = 0;
  const contentPaneWidth = (): number => Math.max(0, displayGeometry().width);
  // Performance samples arrive independently of the application reducer. This
  // keeps a 1 Hz/host-driven metric stream from rebuilding Home/Stress trees.
  const [performance, setPerformance] = createSignal<PerformanceSnapshot>({
    latest: null,
    history: [],
    recording: false,
  });
  const [recordingStatus, setRecordingStatus] = createSignal<Record<string, unknown> | undefined>(undefined);
  // Capability providers such as BLE, biometrics and location can legitimately
  // take several seconds on a real device. Keep the request map bounded, but
  // give those providers a deterministic 30-second guest-clock window.
  const host = createHostBridge(undefined, {
    maxPendingRequests: 32,
    timeoutFrames: 30 * simulationHz(),
    scheduleTimeout: (frames, callback) => after(frames / simulationHz(), callback),
  });
  const platform = createPocketPlatformClient(undefined, { bridge: host });
  const accessibility = createAccessibilityPreferences({ bridge: host });
  const [miniAppOpenMode, setMiniAppOpenMode] = createSignal<"embedded" | "fullscreen">("embedded");
  const [fullscreenOpenAvailable, setFullscreenOpenAvailable] = createSignal(false);
  const system = installShowcaseSystem(
    host,
    showcaseUpdateState(platform.storage, state, setState, routeOf),
    {
      darkMode: mobileDark(),
      accentColor: state().accentColor,
      density: state().interfaceDensity,
      presentationStyle: state().miniAppPresentationStyle,
    },
    { openMode: () => miniAppOpenMode() },
  );
  onMount(() => {
    void host.request<JsonValue>("demo.hybridFlutter.openMode", {}).then((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const facts = value as Record<string, unknown>;
      const available = facts.fullscreenAvailable === true;
      setFullscreenOpenAvailable(available);
      setMiniAppOpenMode(
        available && facts.defaultMode === "fullscreen" ? "fullscreen" : "embedded",
      );
    }).catch(() => {
      // Ordinary Showcase hosts keep the embedded default when they do not
      // register this optional native route capability.
      setFullscreenOpenAvailable(false);
      setMiniAppOpenMode("embedded");
    });
  });
  const [directLaunch, setDirectLaunch] = createSignal(system.snapshot().directLaunch);
  const unsubscribeDirectLaunch = system.subscribe(() => {
    const next = system.snapshot().directLaunch;
    if (next !== directLaunch()) setDirectLaunch(next);
  });
  onCleanup(unsubscribeDirectLaunch);
  const backInterceptors = createPocketBackInterceptorRegistry();
  const backNavigation = createPocketBackNavigation(host);
  backNavigation.setHandler(async () => {
    cancelBackGesture();
    if (await system.handleBack()) return true;
    if (backInterceptors.dispatch()) return true;
    if (state().routeStack.length > 1) {
      dispatch({ type: "popRoute" });
      return true;
    }
    try {
      await system.closeContainer();
      return true;
    } catch {
      return false;
    }
  });
  const syncSystemPresets = (): void => {
    const skin = state().uiSkin;
    const hadSkin = system.presets().skin !== undefined;
    void system.setPresets({
      darkMode: mobileDark(),
      accentColor: state().accentColor,
      density: state().interfaceDensity,
      presentationStyle: state().miniAppPresentationStyle,
      ...(skin !== "default" || hadSkin ? { skin } : {}),
    });
  };
  createEffect(() => {
    if (!preferencesReady()) return;
    syncSystemPresets();
  });
  const experience = createPlatformExperience(host);
  let requestSequence = 0;
  let lastPublishedPerformanceContext = "";
  const routeTransitionDuration = 220;
  const routeTransitionTickHz = simulationHz();
  let previousRoute: Route = initialDemoState().route;
  const [customTransitionOverride, setCustomTransitionOverride] = createSignal(false);
  const [backGesture, setBackGesture] = createSignal<ActiveBackGesture | undefined>(undefined);
  let cancelBackGesture = (): void => {};

  const publishPerformanceContext = (): void => {
    const current = state();
    const context = `page=${current.route} · action=${current.lastAction}`;
    if (context === lastPublishedPerformanceContext) return;
    lastPublishedPerformanceContext = context;
    // Context is diagnostic-only host state. Routing and action policy stay in
    // JS; the host merely attaches this bounded string to future long frames.
    void host.request<JsonValue>("runtime.performance", { context }).catch(() => {
      // Older hosts may ignore the optional context parameter. Realtime
      // samples still receive page/action labels below from the JS signal.
    });
  };

  let syncingToRouter = false;
  let syncingFromRouter = false;

  const hydrateStateFromRouterEntry = (
    entry: PocketHistoryEntry<Route>,
    nextStackEntries: readonly PocketHistoryEntry<Route>[],
    reason: "navigate" | "replace" | "pop" | "deeplink" | "search",
  ): void => {
    if (reason === "pop") {
      syncingFromRouter = true;
      try {
        if (state().routeStack.length > 1 && state().routeStack[state().routeStack.length - 2] === entry.routeId) {
          dispatch({ type: "popRoute" });
        } else {
          dispatch({
            type: "syncDeepLink",
            route: entry.routeId,
            routeStack: nextStackEntries.map((item) => item.routeId),
            detailsOpen: state().detailsOpen,
            lastAction: `Returned to ${entry.pathname}`,
          });
        }
      } finally {
        syncingFromRouter = false;
      }
      return;
    }

    const q = entry.query;
    const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(q, key);
    const firstStr = (key: string): string | undefined => {
      if (!hasOwn(key)) return undefined;
      const val = q[key];
      return typeof val === "string" ? val : Array.isArray(val) ? val[0] : undefined;
    };

    const isFullDeepLink = reason === "deeplink";

    const rawSkin = firstStr("skin");
    const uiSkin: ShowcaseSkin | undefined =
      rawSkin === "default" || rawSkin === "looseleaf" || rawSkin === "arc" || rawSkin === "liquid-glass"
        ? rawSkin
        : isFullDeepLink
          ? "default"
          : undefined;

    const rawDark = firstStr("dark");
    const rawMode = firstStr("mode") ?? firstStr("appearance");
    const mobileDark: boolean | undefined =
      rawDark === "1" || rawDark === "true"
        ? true
        : rawDark === "0" || rawDark === "false"
          ? false
          : rawMode === "dark" || rawMode === "amber-night"
            ? true
            : rawMode === "light"
              ? false
              : isFullDeepLink
                ? false
                : undefined;

    const rawAccent = firstStr("accent");
    const accentColor: AccentColor | undefined =
      rawAccent === "blue" || rawAccent === "violet" || rawAccent === "teal" || rawAccent === "rose"
        ? rawAccent
        : isFullDeepLink
          ? "blue"
          : undefined;

    const rawDensity = firstStr("density");
    const interfaceDensity: InterfaceDensity | undefined =
      rawDensity === "auto" || rawDensity === "touch" || rawDensity === "desktop"
        ? rawDensity
        : isFullDeepLink
          ? "auto"
          : undefined;

    const rawCount = firstStr("count");
    const parsedCount = rawCount !== undefined && rawCount !== "" ? Number(rawCount) : Number.NaN;
    const count = Number.isFinite(parsedCount)
      ? Math.trunc(parsedCount)
      : isFullDeepLink && entry.routeId === "home"
        ? 0
        : undefined;

    const draft =
      firstStr("draft") ?? (isFullDeepLink && entry.routeId === "home" ? "" : undefined);

    const rawLazy = firstStr("lazy");
    const lazyVisible =
      rawLazy === "1" || rawLazy === "true"
        ? true
        : rawLazy === "0" || rawLazy === "false"
          ? false
          : isFullDeepLink && entry.routeId === "gallery"
            ? false
            : undefined;

    const rawModal = firstStr("modal");
    const validModal =
      rawModal && componentCards.includes(rawModal) ? rawModal : undefined;

    const rawMotion = firstStr("motion");
    const transitionMode: TransitionMode | undefined =
      rawMotion === "IOS_SPRING_PARALLAX" ||
      rawMotion === "MATERIAL_SHARED_AXIS_Z" ||
      rawMotion === "DESKTOP_PORTAL_SNAP"
        ? rawMotion
        : isFullDeepLink && entry.routeId === "transitions"
          ? "IOS_SPRING_PARALLAX"
          : undefined;

    const current = state();
    if (reason === "search") {
      // Local page `useSearchState` updates (e.g. `quota`, `step`, `dialog`) must
      // not fire `syncDeepLink` or cancel gestures unless a root DemoState query changed.
      const rootChanged =
        (uiSkin !== undefined && uiSkin !== current.uiSkin) ||
        (mobileDark !== undefined && mobileDark !== current.mobileDark) ||
        (accentColor !== undefined && accentColor !== current.accentColor) ||
        (interfaceDensity !== undefined && interfaceDensity !== current.interfaceDensity) ||
        (count !== undefined && count !== current.count) ||
        (draft !== undefined && draft !== current.draft) ||
        (lazyVisible !== undefined && lazyVisible !== current.lazyVisible) ||
        (validModal !== undefined && (!current.detailsOpen || current.selectedComponent !== validModal)) ||
        (transitionMode !== undefined && transitionMode !== current.transitionMode);
      if (!rootChanged) return;
    }

    const routeStack = nextStackEntries.map((item) => item.routeId);
    const sameStack =
      current.route === entry.routeId &&
      current.routeStack.length === routeStack.length &&
      current.routeStack.every((r, idx) => r === routeStack[idx]);

    // In-page subpath replace (e.g. `/skins` -> `/skins/controls` tab switch) with no
    // root DemoState change does not need a redundant reducer dispatch.
    if (
      reason === "replace" &&
      sameStack &&
      (uiSkin === undefined || uiSkin === current.uiSkin) &&
      (mobileDark === undefined || mobileDark === current.mobileDark) &&
      (accentColor === undefined || accentColor === current.accentColor) &&
      (interfaceDensity === undefined || interfaceDensity === current.interfaceDensity) &&
      (count === undefined || count === current.count) &&
      (draft === undefined || draft === current.draft) &&
      (lazyVisible === undefined || lazyVisible === current.lazyVisible) &&
      validModal === undefined &&
      (transitionMode === undefined || transitionMode === current.transitionMode)
    ) {
      return;
    }

    syncingFromRouter = true;
    try {
      dispatch({
        type: "syncDeepLink",
        route: entry.routeId,
        routeStack,
        ...(count !== undefined ? { count } : {}),
        ...(draft !== undefined ? { draft } : {}),
        ...(uiSkin !== undefined ? { uiSkin } : {}),
        ...(mobileDark !== undefined ? { mobileDark } : {}),
        ...(accentColor !== undefined ? { accentColor } : {}),
        ...(interfaceDensity !== undefined ? { interfaceDensity } : {}),
        ...(lazyVisible !== undefined ? { lazyVisible } : {}),
        ...(validModal !== undefined
          ? { selectedComponent: validModal, detailsOpen: true }
          : isFullDeepLink || current.route !== entry.routeId
            ? { detailsOpen: false }
            : { detailsOpen: current.detailsOpen }),
        ...(transitionMode !== undefined ? { transitionMode } : {}),
        lastAction: isFullDeepLink
          ? `Deep-linked to ${entry.pathname}`
          : sameStack
            ? current.lastAction
            : `Navigated to ${entry.pathname}`,
      });
    } finally {
      syncingFromRouter = false;
    }
  };

  const showcaseRouter = createPocketRouter<Route>({
    defaultScheme: "pocket",
    defaultAuthority: "showcase",
    fallbackRouteId: "home",
    routes: SHOWCASE_ROUTES,
    retainParams: ["skin", "dark", "accent", "density"],
    onMiniAppLink: async (miniApp) => {
      try {
        await system.ready;
        const launchOptions: AppLaunchOptions | undefined = miniApp.presentationStyle
          ? { presentationStyle: miniApp.presentationStyle }
          : undefined;
        const queryJson: Record<string, JsonValue> = {};
        for (const [key, val] of Object.entries(miniApp.query)) {
          queryJson[key] = Array.isArray(val) ? [...val] : (val ?? null);
        }
        await platform.openApp(
          miniApp.appId,
          {
            source: "deeplink",
            uri: miniApp.uri,
            subPath: miniApp.subPath,
            query: queryJson,
          },
          launchOptions,
        );
      } catch (error) {
        const failure = hostError(error);
        setState((current) => ({
          ...current,
          lastAction: `MiniApp deep-link failed (${failure.code})`,
        }));
      }
    },
    onChange: (entry, nextStack, reason) => {
      if (syncingToRouter || reason === "init") return;
      hydrateStateFromRouterEntry(entry, nextStack, reason);
    },
  });

  const openShowcaseDeepLink = (
    rawUri: unknown,
  ): { handled: boolean; kind: string; summary: string } => {
    const res = showcaseRouter.openDeepLink(rawUri, { synthesizeStack: true });
    if (!res.handled) {
      return { handled: false, kind: "ignored", summary: "Ignored empty or invalid deep link." };
    }
    if (res.kind === "miniapp" && res.miniApp) {
      return {
        handled: true,
        kind: "miniapp",
        summary: `Dispatched MiniApp ${res.miniApp.appId} (${res.miniApp.subPath})`,
      };
    }
    return {
      handled: true,
      kind: "route",
      summary: `Navigated -> ${showcaseRouter.uri()} (stack ${showcaseRouter.stack().length})`,
    };
  };

  const syncRouterFromDemoEvent = (event: DemoEvent, nextState: DemoState): void => {
    if (syncingFromRouter) return;
    syncingToRouter = true;
    try {
      if (event.type === "navigate") {
        showcaseRouter.navigate(event.route, {
          search: (prev) => ({
            ...prev,
            skin: nextState.uiSkin === "default" ? null : nextState.uiSkin,
            dark: nextState.mobileDark ? "1" : null,
            accent: nextState.accentColor === "blue" ? null : nextState.accentColor,
            density: nextState.interfaceDensity === "auto" ? null : nextState.interfaceDensity,
            modal: null,
          }),
        });
      } else if (event.type === "popRoute") {
        showcaseRouter.back();
      } else if (
        event.type === "setUiSkin" ||
        event.type === "setMobileDark" ||
        event.type === "setAccentColor" ||
        event.type === "setInterfaceDensity" ||
        event.type === "resetAppearance" ||
        event.type === "restoreAppearance" ||
        event.type === "increment" ||
        event.type === "decrement" ||
        event.type === "draft" ||
        event.type === "select" ||
        event.type === "closeDetails" ||
        event.type === "toggleLazy" ||
        event.type === "setTransitionMode"
      ) {
        showcaseRouter.setSearch((prev) => ({
          ...prev,
          skin: nextState.uiSkin === "default" ? null : nextState.uiSkin,
          dark: nextState.mobileDark ? "1" : null,
          accent: nextState.accentColor === "blue" ? null : nextState.accentColor,
          density: nextState.interfaceDensity === "auto" ? null : nextState.interfaceDensity,
          ...(nextState.route === "home"
            ? {
                count: nextState.count === 0 ? null : nextState.count,
                draft: nextState.draft === "" ? null : nextState.draft,
              }
            : {}),
          ...(nextState.route === "gallery"
            ? {
                lazy: nextState.lazyVisible ? "1" : null,
                modal: nextState.detailsOpen && nextState.selectedComponent ? nextState.selectedComponent : null,
              }
            : {}),
          ...(nextState.route === "transitions"
            ? {
                motion:
                  nextState.transitionMode === "IOS_SPRING_PARALLAX"
                    ? null
                    : nextState.transitionMode,
              }
            : {}),
        }));
      }
    } finally {
      syncingToRouter = false;
    }
  };

  const dispatch = (event: DemoEvent, options: { animatePop?: boolean } = {}): void => {
    if (event.type === "navigate" || event.type === "popRoute" || event.type === "syncDeepLink") {
      cancelBackGesture();
    }
    if (event.type === "popRoute" && options.animatePop !== false && state().routeStack.length > 1) {
      const from = state().route;
      const to = state().routeStack[state().routeStack.length - 2];
      if (to) {
        // Publish the reverse transition before shrinking the source of truth.
        // That lets the retained RouteView move from the stack into the
        // transition layer without disposal/recreation of its local state.
        previousRoute = to;
        setRouteTransition({ from, to, direction: "reverse", elapsedMs: 0, progress: 0 });
      }
    }
    setState((current) => reduceDemoState(current, event));
    if (event.type === "setTransitionMode") {
      setCustomTransitionOverride(true);
    } else if (event.type === "resetAppearance") {
      setCustomTransitionOverride(false);
    }
    syncRouterFromDemoEvent(event, state());
    if (
      event.type === "setUiSkin" ||
      event.type === "setMobileDark" ||
      event.type === "setAccentColor" ||
      event.type === "setInterfaceDensity" ||
      event.type === "setMiniAppPresentationStyle" ||
      event.type === "resetAppearance"
    ) {
      const value = storedAppearance(state());
      const revision = ++saveRevision;
      setPreferencesStatus("Saving preferences…");
      saveQueue = saveQueue.then(async () => {
        try {
          await platform.storage.set("appearance", value);
          if (revision === saveRevision) setPreferencesStatus("Saved on this device");
        } catch {
          if (revision === saveRevision) setPreferencesStatus("Changes apply this session. Device storage is unavailable.");
        }
      });
    }
    if (event.type !== "capabilityStart" && event.type !== "capabilitySuccess" && event.type !== "capabilityFailure") {
      publishPerformanceContext();
    }
  };

  const navigate = (route: Route): void => dispatch({ type: "navigate", route });
  const restorePreferences = async (): Promise<void> => {
    setPreferencesReady(false);
    setPreferencesStatus("Loading your preferences…");
    try {
      const saved = readAppearance(await platform.storage.get("appearance"));
      if (saved) dispatch({ type: "restoreAppearance", ...saved });
      setPreferencesStatus(saved ? "Saved on this device" : "Using the default appearance");
    } catch {
      setPreferencesStatus("Changes apply this session. Device storage is unavailable.");
    } finally {
      setPreferencesReady(true);
    }
  };
  onMount(() => { void restorePreferences(); });


  const clampBackProgress = (value: number): number => Math.max(0, Math.min(1, value));
  const backGestureForegroundX = (): number => {
    const gesture = backGesture();
    return gesture?.target.kind === "route" ? clampBackProgress(gesture.progress) * gesture.width : 0;
  };
  const backGestureBackgroundX = (): number => {
    const gesture = backGesture();
    return gesture?.target.kind === "route" ? -0.3 * gesture.width * (1 - clampBackProgress(gesture.progress)) : 0;
  };
  const backGestureRouteFrom = (): Route | undefined => {
    const gesture = backGesture();
    return gesture?.target.kind === "route" ? gesture.target.fromRoute : undefined;
  };
  const backGestureRouteTo = (): Route | undefined => {
    const gesture = backGesture();
    return gesture?.target.kind === "route" ? gesture.target.toRoute : undefined;
  };
  const miniAppBackPreview = () => {
    const gesture = backGesture();
    return gesture?.target.kind === "mini-app" ? {
      instanceId: gesture.target.instanceId,
      requestId: gesture.target.requestId,
      width: gesture.width,
      progress: gesture.progress,
    } : undefined;
  };
  cancelBackGesture = (): void => setBackGesture(undefined);
  const unsubscribeBackStack = system.subscribe(() => {
    const gesture = backGesture();
    if (gesture?.target.kind !== "mini-app") return;
    const snapshot = system.snapshot();
    const top = snapshot.stack[snapshot.stack.length - 1];
    if (top?.instanceId !== gesture.target.instanceId || top.requestId !== gesture.target.requestId) {
      cancelBackGesture();
    }
  });
  onCleanup(unsubscribeBackStack);

  const canStartBackGesture = (event: PocketBackGestureEvent): boolean => {
    const current = state();
    if (
      event.phase !== "start" ||
      event.width <= 0 ||
      current.detailsOpen ||
      routeTransition() !== undefined
    ) return false;
    const snapshot = system.snapshot();
    if (snapshot.directLaunch && snapshot.stack.length <= 2) return false;
    const top = snapshot.stack[snapshot.stack.length - 1];
    if (snapshot.foregroundAppId !== null && snapshot.foregroundAppId !== snapshot.systemUI) {
      if (!top?.requestId || top.instanceId !== snapshot.foregroundInstanceId || top.appId !== snapshot.foregroundAppId) return false;
      const call = snapshot.pendingCalls.find((candidate) =>
        candidate.requestId === top.requestId &&
        candidate.targetInstanceId === top.instanceId &&
        !candidate.completionPending);
      const binding = system.surfaceBindings({ includeStack: true }).find((candidate) => candidate.instanceId === top.instanceId);
      return call !== undefined && binding?.focused === true && binding.ready !== false;
    }
    // Root showcase navigation remains the same stack; MiniApp calls above it
    // use their existing invocation frame and request/result path.
    return backInterceptors.count() === 0 && current.routeStack.length > 1;
  };

  const finishBackGesture = (gesture: ActiveBackGesture): void => {
    if (gesture.settleTo >= 1 && gesture.target.kind === "route") {
      const current = state();
      const destination = current.routeStack[current.routeStack.length - 2];
      if (current.route === gesture.target.fromRoute && destination === gesture.target.toRoute) {
        // Advance the existing route observer before dispatch so its normal
        // transition does not replay after this interactive transition.
        previousRoute = gesture.target.toRoute;
        dispatch({ type: "popRoute" }, { animatePop: false });
      }
      setBackGesture(undefined);
      return;
    }
    if (gesture.settleTo >= 1 && gesture.target.kind === "mini-app") {
      if (gesture.phase === "committing") return;
      const stack = system.snapshot().stack;
      const top = stack[stack.length - 1];
      if (top?.instanceId !== gesture.target.instanceId || top.requestId !== gesture.target.requestId) {
        setBackGesture(undefined);
        return;
      }
      const current: ActiveBackGesture = { ...gesture, phase: "committing", progress: 1 };
      setBackGesture(current);
      void system.handleBack().then((handled) => {
        if (backGesture()?.gestureId !== current.gestureId) return;
        if (handled) {
          // The kernel's before-dismiss callback sees progress 1 and removes
          // the existing frame immediately. Keep the preview until it does.
          setBackGesture(undefined);
        } else {
          beginBackSettle({ ...current, progress: 1 }, 0);
        }
      }).catch(() => {
        if (backGesture()?.gestureId === current.gestureId) beginBackSettle({ ...current, progress: 1 }, 0);
      });
      return;
    }
    setBackGesture(undefined);
  };

  const beginBackSettle = (gesture: ActiveBackGesture, target: 0 | 1): void => {
    const progress = clampBackProgress(gesture.progress);
    if (Math.abs(target - progress) < 0.001) {
      finishBackGesture({ ...gesture, progress, settleTo: target });
      return;
    }
    setBackGesture({
      ...gesture,
      progress,
      phase: "settling",
      settleFrom: progress,
      settleTo: target,
      settleElapsedMs: 0,
      settleDurationMs: Math.max(180, Math.min(260, 180 + Math.abs(target - progress) * 80)),
    });
  };

  const handleBackGesture = (event: PocketBackGestureEvent): boolean | void => {
    if (event.phase === "start") {
      if (!canStartBackGesture(event)) return false;
      const current = state();
      const snapshot = system.snapshot();
      const top = snapshot.stack[snapshot.stack.length - 1];
      let target: BackGestureTarget;
      if (top?.requestId && top.instanceId === snapshot.foregroundInstanceId &&
          top.appId === snapshot.foregroundAppId && snapshot.foregroundAppId !== snapshot.systemUI) {
        target = { kind: "mini-app", instanceId: top.instanceId, requestId: top.requestId };
      } else {
        const toRoute = current.routeStack[current.routeStack.length - 2];
        if (!toRoute) return false;
        target = { kind: "route", fromRoute: current.route, toRoute };
      }
      const progress = clampBackProgress(event.progress);
      setBackGesture({
        gestureId: event.gestureId,
        target,
        width: event.width,
        progress,
        phase: "dragging",
        settleFrom: progress,
        settleTo: progress,
        settleElapsedMs: 0,
        settleDurationMs: 0,
      });
      return true;
    }

    const current = backGesture();
    if (!current || current.gestureId !== event.gestureId) return;
    if (current.phase === "committing") return;
    if (current.phase === "settling") {
      if (event.phase === "cancel") beginBackSettle(current, 0);
      return;
    }
    const progress = clampBackProgress(event.progress);
    if (event.phase === "update") {
      setBackGesture({ ...current, progress });
      return;
    }

    const terminal = { ...current, progress };
    beginBackSettle(terminal, shouldCommitPocketBackGesture(event) ? 1 : 0);
  };

  backNavigation.setGestureHandler(handleBackGesture);

  // One JS route gate owns playback policy; the Flutter host only executes it.
  // This also pauses a video before its page is removed from the draw tree.
  createEffect(() => platform.media?.setCurrentPage(state().route));

  const nowMs = (): number =>
    typeof globalThis.performance !== "undefined" && typeof globalThis.performance.now === "function"
      ? globalThis.performance.now()
      : Date.now();

  createEffect(() => {
    const nextRoute = state().route;
    if (nextRoute === previousRoute) return;
    const from = previousRoute;
    previousRoute = nextRoute;
    setRouteTransition({
      from,
      to: nextRoute,
      direction: "forward",
      elapsedMs: 0,
      progress: 0,
    });
  });

  const isShowcaseRoute = (route: Route): boolean =>
    route === "mobile" || route === "transitions" || route === "hardware" || route === "video" || route === "apple" || route === "looseleaf" || route === "skins" || route === "uikit-gallery" || route === "router" || route === "ecosystem";
  const effectiveTransitionMode = (): TransitionMode =>
    customTransitionOverride()
      ? state().transitionMode
      : (getUiSkin(state().uiSkin).motion?.routeTransition ?? state().transitionMode);
  const effectiveTransitionDuration = (): number =>
    accessibility().reduceMotion
      ? 0
      : (getUiSkin(state().uiSkin).motion?.routeTransitionDurationMs ?? routeTransitionDuration);
  const transitionDescriptor = () => {
    const transition = routeTransition();
    const width = Math.max(1, contentPaneWidth());
    const mode = effectiveTransitionMode();
    if (!transition || (transition.direction === "forward" &&
        !isShowcaseRoute(transition.from) && !isShowcaseRoute(transition.to))) {
      return computeTransitionDescriptor(mode, 1, false, width);
    }
    return computeTransitionDescriptor(
      mode,
      transition.progress,
      transition.direction === "reverse",
      width,
    );
  };
  const reverseExitFor = (route: Route) => {
    const transition = routeTransition();
    return transition?.direction === "reverse" && transition.from === route
      ? transition
      : undefined;
  };

  onFrame(() => {
    host.tick();
    const transition = routeTransition();
    if (transition) {
      const duration = effectiveTransitionDuration();
      const elapsedMs = transition.elapsedMs + 1000 / routeTransitionTickHz;
      const progress = duration <= 0 ? 1 : Math.max(0, Math.min(1, elapsedMs / duration));
      if (progress >= 1) {
        setRouteTransition(undefined);
      } else {
        setRouteTransition((current) => current ? { ...current, elapsedMs, progress } : current);
      }
    }
    const gesture = backGesture();
    if (gesture?.phase === "settling") {
      const elapsedMs = gesture.settleElapsedMs + 1000 / routeTransitionTickHz;
      const linear = Math.min(1, elapsedMs / gesture.settleDurationMs);
      const eased = 1 - (1 - linear) ** 3;
      const progress = gesture.settleFrom + (gesture.settleTo - gesture.settleFrom) * eased;
      if (linear >= 1) {
        finishBackGesture({ ...gesture, progress: gesture.settleTo });
      } else {
        setBackGesture({ ...gesture, progress, settleElapsedMs: elapsedMs });
      }
    }
  }, {
    continuous: () => routeTransition() !== undefined || backGesture()?.phase === "settling",
  });

  const requestCapability = (key: CapabilityKey, capability: string, params: Record<string, JsonValue> = {}): void => {
    if (state()[key].phase === "loading") return;
    const requestId = `${capability}-${++requestSequence}`;
    dispatch({ type: "capabilityStart", key, requestId });
    const request = capability === "updates.apply" ? system.updates.apply() : host.request<JsonValue>(capability, params);
    request.then(
      (result) => {
        if (key === "runtimePerformance") setPerformance(parsePerformanceSnapshot(result));
        dispatch({ type: "capabilitySuccess", key, requestId, result });
      },
      (error) => {
        const failure = hostError(error);
        dispatch({ type: "capabilityFailure", key, requestId, code: failure.code, message: failure.message });
      },
    );
  };

  // Camera access belongs to the visible device page. Keep this gate above
  // page lifetime so a start result arriving after pop is stopped as well.
  let stoppedPreviewRequest: string | null | undefined;
  createEffect(() => {
    const current = state();
    if (current.route === "hardware") {
      stoppedPreviewRequest = undefined;
      return;
    }
    const preview = current.hardwareCameraPreviewStart;
    if (preview.phase !== "ready" || preview.requestId === stoppedPreviewRequest) return;
    stoppedPreviewRequest = preview.requestId;
    requestCapability("hardwareCameraPreviewStop", "hardware.camera.preview.stop");
  });

  const runStress = (requestedNodes: number): void => {
    const nodeCount = requestedNodes === 500 ? 500 : 100;
    const startedAt = Date.now();
    let current = initialDemoState();
    let checksum = 0;
    for (let index = 0; index < nodeCount; index += 1) {
      current = reduceDemoState(current, { type: index % 2 === 0 ? "increment" : "decrement" });
      checksum = (checksum + current.count * (index + 1)) % 1000003;
    }
    dispatch({ type: "stressRun", nodeCount, checksum, durationMs: Math.max(0, Date.now() - startedAt) });
  };

  onMount(() => {
    const handleEvent = (method: string, params: Record<string, unknown>): void => {
      if (deliverTextInputEvent(method, params)) {
        // The shell owns the input session; its callbacks dispatch the app
        // draft while preserving native selection/composing metadata.
      } else if (method === "demo.openUrl" || method === "router.open") {
        openShowcaseDeepLink(params.url ?? params.uri ?? params.href ?? params);
      } else if (method === "demo.navigate") {
        if (typeof params.url === "string" || typeof params.uri === "string") {
          openShowcaseDeepLink(params.url ?? params.uri);
        } else {
          const route = routeOf(params.route);
          if (route) navigate(route);
        }
      } else if (method === "diagnostics.recording.started") {
        setRecordingStatus(params);
        navigate("about");
      } else if (method === "demo.increment") {
        dispatch({ type: "increment" });
      } else if (method === "demo.decrement") {
        dispatch({ type: "decrement" });
      } else if (method === "demo.setText") {
        dispatch({ type: "draft", value: String(params.value ?? "") });
      } else if (method === "demo.toggleLazy") {
        dispatch({ type: "toggleLazy" });
      } else if (method === "updates.changed") {
        // The host may publish this after an apply/rollback reload. Re-read
        // the canonical status instead of trusting a stale local snapshot.
        requestCapability("updatesStatus", "updates.status");
      } else if (method === "demo.stress") {
        runStress(Number(params.nodes ?? 100));
      } else if (method === "runtime.performance.sample") {
        const rawSample = params.sample ?? params.result ?? params;
        const sampleRecord = rawSample && typeof rawSample === "object" && !Array.isArray(rawSample)
          ? {
            ...(rawSample as Record<string, unknown>),
            ...(params.minFps === undefined ? {} : { minFps: params.minFps }),
            // The host may send the bounded long-frame delta separately as
            // `jank` to avoid repeating the persisted history in each sample.
            ...(
              (rawSample as Record<string, unknown>).longFrameEvents === undefined &&
              params.longFrameEvents === undefined &&
              params.jank !== undefined
                ? { longFrameEvents: params.jank }
                : {}
            ),
          }
          : rawSample;
        const sample = parsePerformancePoint(sampleRecord);
        if (sample) {
          // The native provider owns measured durations; JS owns the user
          // context that explains which page/action was active when the
          // sample arrived. Do not ask Flutter to infer app routing.
          const current = state();
          const context = typeof params.context === "string" ? params.context : sample.context;
          const existingEvents = performance().longFrameEvents ?? [];
          const contextualEvents = sample.longFrameEvents?.map((event) => {
            const prior = existingEvents.find((item) => sameJankEvent(item, event));
            const nextPage = prior?.page ?? event.page ?? current.route;
            const nextAction = prior?.action ?? event.action ?? current.lastAction;
            const nextContext = prior?.context ?? event.context ?? context;
            return {
              ...event,
              ...(nextPage !== undefined ? { page: nextPage } : {}),
              ...(nextAction !== undefined ? { action: nextAction } : {}),
              ...(nextContext !== undefined ? { context: nextContext } : {}),
            };
          });
          const contextualSample: PerformancePoint = {
            ...sample,
            ...(sample.page !== undefined ? {} : { page: current.route }),
            ...(sample.action !== undefined ? {} : { action: current.lastAction }),
            ...(sample.context !== undefined || typeof params.context !== "string"
              ? {}
              : { context: params.context }),
            ...(contextualEvents === undefined ? {} : {
              longFrameEvents: contextualEvents,
            }),
          };
          setPerformance((current) => {
            // A host event-only burst has no cadence window (frames/duration
            // are zero), so its fps=0 marker must not poison latest/history.
            // Its explicit long-frame events still belong in the diagnostics
            // list and are merged by the state model.
            const next = appendPerformanceSample(current, contextualSample, params.eventOnly !== true);
            return {
              ...next,
              recording: typeof params.recording === "boolean" ? params.recording : current.recording,
            };
          });
        }
      }
    };
    const previous = typeof host.onEvent === "function" ? undefined : bridge.__pocketEvent;
    const receive = (line: string): void => {
      // Request-only injected bridges retain the compatibility sink. Modern
      // HostBridge users receive the already-decoded HostEvent below.
      if (typeof host.onEvent !== "function") host.handle(line);
      const message = decode(line);
      if (!message) return;
      handleEvent(message.method ?? message.name ?? "", paramsOf(message));
      try { previous?.(line); } catch { /* isolate legacy previous sinks */ }
    };
    const removeHostEvent = typeof host.onEvent === "function"
      ? host.onEvent((event: HostEvent) => handleEvent(event.method, event.params))
      : undefined;
    if (typeof host.onEvent !== "function") bridge.__pocketEvent = receive;

    // These are real requests. If the active host has not registered a
    // capability, the resulting host error is rendered rather than replaced
    // with a success placeholder.
    requestCapability("runtimeInfo", "runtime.info");
    publishPerformanceContext();
    requestCapability("pluginsList", "plugins.list");
    requestCapability("packageInfo", "plugins.packageInfo");
    requestCapability("updatesStatus", "updates.status");

    onCleanup(() => {
      removeHostEvent?.();
      if (bridge.__pocketEvent === receive) bridge.__pocketEvent = previous;
      system.dispose();
      backNavigation.dispose();
      experience.dispose();
      platform.dispose();
      host.dispose();
    });
  });

  const requestCloseContainer = (): void => {
    void system.closeContainer().catch((error) => {
      const failure = hostError(error);
      setState((current) => ({
        ...current,
        lastAction: `Container close unavailable (${failure.code})`,
      }));
    });
  };

  const renderRoute = (route: Route): JSX.Element => {
    switch (route) {
      case "home":
        return <HomePage
          state={state}
          platform={platform}
          system={system}
          dispatch={dispatch}
          runtime={state().runtimeInfo}
          miniAppOpenMode={miniAppOpenMode}
          fullscreenOpenAvailable={fullscreenOpenAvailable}
          setMiniAppOpenMode={setMiniAppOpenMode}
        />;
      case "settings":
        return <SettingsPage state={state} dispatch={dispatch} ready={preferencesReady} status={preferencesStatus} />;
      case "gallery":
        return <GalleryPage state={state} dispatch={dispatch} contentWidth={contentPaneWidth} />;
      case "mobile":
        return <ScrollablePage><MobileUiPage state={state} dispatch={dispatch} requestCapability={requestCapability} /></ScrollablePage>;
      case "transitions":
        return <ScrollablePage><TransitionsPage state={state} dispatch={dispatch} requestCapability={requestCapability} /></ScrollablePage>;
      case "hardware":
        return <ScrollablePage><HardwarePage state={state} dispatch={dispatch} requestCapability={requestCapability} host={host} experience={experience} /></ScrollablePage>;
      case "video":
        return <VideoPage host={host} platform={platform} onNavigate={navigate} />;
      case "miniapps":
        return <MiniAppUpdatesPage platform={platform} system={system} />;
      case "apple":
        return <ApplePage />;
      case "looseleaf":
        return <LooseleafPage />;
      case "skins":
        return <SkinStudioPage state={state} dispatch={dispatch} />;
      case "uikit-gallery":
        return <UIKitGalleryReplicaPage state={state} dispatch={dispatch} geometry={() => displayGeometry()} />;
      case "router":
        return <RouterStudioPage state={state} dispatch={dispatch} experience={experience} onOpenDeepLink={openShowcaseDeepLink} />;
      case "ecosystem":
        return <EcosystemStudioPage state={state} dispatch={dispatch} geometry={displayGeometry} />;
      default:
        return <HostPages route={route} host={host} state={state} dispatch={dispatch} requestCapability={requestCapability} runStress={runStress} performance={performance} recordingStatus={recordingStatus} />;
    }
  };

  const routeTitle = (route: Route): string => route === "home" ? demoTitle
    : route === "gallery" ? "UI Collection"
    : route === "about" ? "Host"
    : route === "settings" ? "Settings"
    : route === "miniapps" ? "MiniApp versions"
    : route === "mobile" ? "Mobile UI"
    : route === "transitions" ? "Transitions"
    : route === "hardware" ? "Hardware"
    : route === "video" ? "Video Lab"
    : route === "apple" ? "Apple Glass"
    : route === "looseleaf" ? "Looseleaf"
    : route === "skins" ? "Skin Studio"
    : route === "uikit-gallery" ? "UIKit Gallery"
    : route === "router" ? "URL & State Router"
    : route === "ecosystem" ? "Ecosystem & Widgets"
    : hostTabs.find((tab) => tab.id === route)?.label ?? "Frame diagnostics";

  const renderRouteAppBar = (route: Route): JSX.Element => {
    const leading = route === "home"
      ? <SkinBackButton onPress={requestCloseContainer} />
      : isPrimaryRoute(route)
        ? undefined
        : <SkinBackButton onPress={() => dispatch({ type: "popRoute" })} />;
    const trailing = route === "home"
      ? <SkinButton label="退出容器" variant="danger" compact onPress={requestCloseContainer} />
      : undefined;
    return (
      <SkinAppBar
        title={routeTitle(route)}
        centered={!isPrimaryRoute(route)}
        leading={leading}
        trailing={trailing}
      />
    );
  };

  // The retained Flutter host consumed MediaQuery.padding.top before its page
  // body. PocketView reports the equivalent logical inset through
  // display.viewport; consume it once at the SystemUI shell so every route
  // (including the Home header and mobile AppBar) starts below the status bar
  // without teaching each page its own safe-area state.
  const activeSkinCanvasBg = (): string =>
    getUiSkin(state().uiSkin).resolveTokens(mobileDark() ? "dark" : "light", state().accentColor).canvasBg;

  return (
    <Show when={preferencesReady() || directLaunch()}>
    {() => (
    <PocketBackInterceptorProvider value={backInterceptors}>
    <PocketLifecycleProvider bridge={host} platform={platform}>
    <PocketRouterProvider router={showcaseRouter}>
    <AppleSemanticsProvider bridge={host}>
    <AccessibilityPreferencesProvider value={accessibility}>
    <UiSkinProvider
      skin={() => state().uiSkin}
      mode={() => (mobileDark() ? "dark" : "light")}
      accent={() => state().accentColor}
      density={() => state().interfaceDensity}
      reducedMotion={() => accessibility().reduceMotion}
      skins={[defaultSkinAdapter, looseleafSkinAdapter, arcSkinAdapter, liquidGlassSkinAdapter]}
      onSkinChange={(next) => dispatch({ type: "setUiSkin", value: next as ShowcaseSkin })}
    >
    <ShowcaseSystemUiSync experience={experience} ready={preferencesReady} route={() => state().route} />
    <SurfaceEnvironmentProvider bridge={host}>
    <WidgetSnapshotProvider bridge={host}>
    <ShowcaseSurfaceGate
      canvasBg={activeSkinCanvasBg}
      widget={() => <ShowcaseSystemWidgetRoot state={state} dispatch={dispatch} />}
    >
      <Show when={!directLaunch()}>
        <FocusScope class="relative flex-1 flex-col w-full h-full overflow-hidden" autoFocus restoreFocus>
          <For each={mountedRoutes()}>{(route) => (
            <RouteView
              class="absolute inset-0 w-full h-full overflow-hidden"
              active={state().route === route || backGestureRouteTo() === route || reverseExitFor(route) !== undefined}
              style={{
                bgColor: activeSkinCanvasBg(),
                translateX: backGestureRouteFrom() !== undefined
                  ? backGestureRouteFrom() === route
                    ? backGestureForegroundX()
                    : backGestureRouteTo() === route
                      ? backGestureBackgroundX()
                      : 0
                  : reverseExitFor(route) ? transitionDescriptor().outTx
                  : route === state().route ? transitionDescriptor().inTx : 0,
                translateY: backGestureRouteFrom() === undefined
                  ? reverseExitFor(route) ? transitionDescriptor().outTy
                    : route === state().route ? transitionDescriptor().inTy : 0
                  : 0,
                scale: backGestureRouteFrom() === undefined
                  ? reverseExitFor(route) ? transitionDescriptor().outScale
                    : route === state().route ? transitionDescriptor().inScale : 1
                  : 1,
              }}
            >
              <PocketBackRouteActiveProvider active={() => state().route === route}>
              <PocketRouteScope routeId={route}>
              <SkinScaffold
                edges={route === "uikit-gallery" ? [] : isPrimaryRoute(route) || route === "skins" || route === "router" || route === "ecosystem" ? ["top"] : ["top", "bottom"]}
                geometry={() => displayGeometry()}
                class="flex-col w-full h-full"
                backdrop={state().uiSkin !== "default" && route !== "skins" && route !== "uikit-gallery"}
                appBar={route === "uikit-gallery" ? undefined : () => renderRouteAppBar(route)}
                bottomBar={route !== "uikit-gallery" && isPrimaryRoute(route)
                  ? () => (
                      <SkinNavigationBar
                        route={route}
                        onNavigate={navigate}
                        items={showcaseTabs}
                        visible
                        geometry={() => displayGeometry()}
                      />
                    )
                  : undefined}
              >
                {renderRoute(route)}
              </SkinScaffold>
              </PocketRouteScope>
              </PocketBackRouteActiveProvider>
            </RouteView>
          )}</For>
        </FocusScope>
      </Show>
      <SystemAppSurfaces
        system={system}
        systemUIFocused={state().detailsOpen}
        backGesture={miniAppBackPreview()}
        presentation="mini-app"
        onClose={async (binding) => {
          const frame = system.snapshot().stack.find((entry) => entry.instanceId === binding.instanceId);
          if (!frame?.requestId) return;
          await host.request("platform.apps.cancel", { requestId: frame.requestId });
        }}
      />
      <Show when={!directLaunch()}>
        <SkinDialog
          open={state().detailsOpen}
          title={state().selectedComponent ?? "Component"}
          body={componentDetails[state().selectedComponent ?? ""] ?? "Official guest composition."}
          onClose={() => dispatch({ type: "closeDetails" })}
        />
      </Show>
    </ShowcaseSurfaceGate>
    </WidgetSnapshotProvider>
    </SurfaceEnvironmentProvider>
    </UiSkinProvider>
    </AccessibilityPreferencesProvider>
    </AppleSemanticsProvider>
    </PocketRouterProvider>
    </PocketLifecycleProvider>
    </PocketBackInterceptorProvider>
    )}
    </Show>
  );
}

function ShowcaseSystemUiSync(props: {
  experience: ReturnType<typeof createPlatformExperience>;
  ready: () => boolean;
  route: () => Route;
}): JSX.Element {
  const skin = useUiSkin();
  createPocketSystemUiSync({
    experience: props.experience,
    enabled: props.ready,
    key: props.route,
    navigationBarColor: () =>
      skin.skinId() === "default"
        ? (skin.tokens().dark ? 0xff0e1728 : 0xfff5f6fa)
        : undefined,
  });
  return null;
}

function ShowcaseSurfaceGate(props: {
  canvasBg: () => string;
  widget: () => JSX.Element;
  children: JSX.Element;
}): JSX.Element {
  const surfaceEnv = useSurfaceEnvironment();
  return (
    <Screen
      class="w-full h-full flex-col overflow-hidden"
      style={{ bgColor: surfaceEnv().isSystemSurface ? "#00000000" : props.canvasBg() }}
    >
      <Show when={!surfaceEnv().isSystemSurface} fallback={props.widget()}>
        {props.children}
      </Show>
    </Screen>
  );
}

function HomePage(props: {
  state: () => DemoState;
  platform: ReturnType<typeof createPocketPlatformClient>;
  system: ReturnType<typeof installShowcaseSystem>;
  dispatch: (event: DemoEvent) => void;
  runtime: CapabilityState;
  miniAppOpenMode: () => "embedded" | "fullscreen";
  fullscreenOpenAvailable: () => boolean;
  setMiniAppOpenMode: (mode: "embedded" | "fullscreen") => void;
}): JSX.Element {
  const { tokens } = useUiSkin();
  return (
    <ScrollablePage>
      <View class="flex-col gap-3 p-4 pb-6">
        <ScrollContourItem
          defaultInBand
          class={
            tokens().dark
              ? "flex-col gap-1.5 p-4 rounded-xl bg-[#18181B] border-[#27272A]"
              : "flex-col gap-1.5 p-4 rounded-xl bg-[#18181B] border-[#18181B]"
          }
          style={{ radius: 12, borderWidth: 1 }}
        >
          <Text class="text-xs text-[#A1A1AA] font-bold">POCKET SHOWCASE</Text>
          <SkinParagraph text="Made to feel native." class="text-2xl text-[#FAFAFA] font-bold" style={{ textColor: "#FAFAFA" }} />
          <SkinParagraph text="Small building blocks. Real possibilities." class="text-xs text-[#A1A1AA]" style={{ textColor: "#A1A1AA" }} />
        </ScrollContourItem>
        <HomeExplore dispatch={props.dispatch} />
        <SkinCard title="Playground" detail="A small interaction. An immediate response.">
          <Named name="CounterCard">
            <View class="flex-row items-center justify-between gap-3">
              <View class="flex-col gap-1 flex-1" style={{ minW: 0 }}>
                <Text class="text-sm font-bold" style={{ textColor: tokens().ink }}>Counter</Text>
                <SkinParagraph text={props.state().lastAction} muted />
              </View>
              <View class="flex-row items-center gap-2">
                <SkinButton label="−" variant="tonal" onPress={() => props.dispatch({ type: "decrement" })} />
                <Text class="text-xl font-bold" style={{ textColor: tokens().ink }}>{String(props.state().count).padStart(2, "0")}</Text>
                <SkinButton label="+1" onPress={() => props.dispatch({ type: "increment" })} />
              </View>
            </View>
          </Named>
          <Text class="text-sm font-bold" style={{ textColor: tokens().ink }}>Input round-trip</Text>
          <InputField
            value={() => props.state().draft}
            onInput={(value) => props.dispatch({ type: "draft", value })}
            onSubmit={(value) => props.dispatch({ type: "draft", value })}
            appearance={{
              fillColor: (tokens().surfaceBg.startsWith("#") ? tokens().surfaceBg : (tokens().dark ? "#09090B" : "#FFFFFF")) as `#${string}`,
              textColor: (tokens().ink.startsWith("#") ? tokens().ink : (tokens().dark ? "#FAFAFA" : "#09090B")) as `#${string}`,
              placeholderColor: (tokens().inkMuted.startsWith("#") ? tokens().inkMuted : (tokens().dark ? "#A1A1AA" : "#71717A")) as `#${string}`,
              borderColor: (tokens().border.startsWith("#") ? tokens().border : (tokens().dark ? "#27272A" : "#E4E4E7")) as `#${string}`,
              focusedBorderColor: (tokens().accentBg.startsWith("#") ? tokens().accentBg : (tokens().dark ? "#FAFAFA" : "#18181B")) as `#${string}`,
              borderRadius: 8,
            }}
          />
          <SkinParagraph text={`Draft: ${props.state().draft || "(empty)"}`} muted />
        </SkinCard>
        <PlatformAppsCard
          state={props.state}
          dispatch={props.dispatch}
          platform={props.platform}
          system={props.system}
          miniAppOpenMode={props.miniAppOpenMode}
          fullscreenOpenAvailable={props.fullscreenOpenAvailable}
          setMiniAppOpenMode={props.setMiniAppOpenMode}
        />
        <SkinCard title="UIKit Gallery · 1:1 Liquid Glass Replica" detail="Full-bleed 21-component gallery, morphing menus, submenus, context menu lift & Siri edge glow at >=60 FPS.">
          <SkinButton label="Open 1:1 UIKit Gallery" onPress={() => props.dispatch({ type: "navigate", route: "uikit-gallery" })} />
        </SkinCard>
        <SkinListTile
          title={props.runtime.phase === "ready" ? "Runtime ready" : props.runtime.phase === "error" ? "Runtime unavailable" : "Connecting"}
          detail="Explore the host behind your experience."
          trailing={<SkinButton label="Open Host details" variant="ghost" onPress={() => props.dispatch({ type: "navigate", route: "about" })} />}
        />
      </View>
    </ScrollablePage>
  );
}

function miniAppResultSummary(value: JsonValue | undefined): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return valueSummary(value ?? null);
  const profile = value.profile ?? value.userInfo;
  const person = profile && typeof profile === "object" && !Array.isArray(profile) ? profile : undefined;
  const result = value.lobby && typeof value.lobby === "object" && !Array.isArray(value.lobby) ? value.lobby : value;
  const parts: string[] = [];
  if (typeof person?.name === "string") parts.push(person.name);
  if (typeof result.visits === "number") parts.push(`visits=${result.visits}`);
  if (typeof result.count === "number") parts.push(`count=${result.count}`);
  return parts.length > 0 ? parts.join(" · ") : valueSummary(value);
}

function PlatformAppsCard(props: {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  platform: ReturnType<typeof createPocketPlatformClient>;
  system: ReturnType<typeof installShowcaseSystem>;
  miniAppOpenMode: () => "embedded" | "fullscreen";
  fullscreenOpenAvailable: () => boolean;
  setMiniAppOpenMode: (mode: "embedded" | "fullscreen") => void;
}): JSX.Element {
  const { tokens } = useUiSkin();
  const [status, setStatus] = createSignal("Preparing apps...");
  const [showAllOfficial, setShowAllOfficial] = createSignal(false);
  const [launchOverride, setLaunchOverride] = createSignal<"default" | MiniAppPresentationMode>("default");
  const officialDemos = createMemo(() => props.system.snapshot().catalog.flatMap((entry) => {
    const presentation = entry.presentation as Record<string, unknown> | undefined;
    if (presentation?.officialDemo !== true) return [];
    const strings = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
    return [{
      id: typeof presentation.id === "string" ? presentation.id : entry.appId,
      appId: entry.appId,
      title: typeof presentation.title === "string" ? presentation.title : entry.appId,
      status: typeof presentation.status === "string" ? presentation.status : "unverified",
      statusReason: typeof presentation.statusReason === "string" ? presentation.statusReason : "",
      launchability: typeof presentation.launchability === "string" ? presentation.launchability : "platform-limited",
      missingCapabilities: strings(presentation.missingSessionCapabilities),
      pointerFallbackCapabilities: strings(presentation.pointerFallbackCapabilities),
      installed: entry.installed,
    }];
  }).sort((a, b) => {
    const featured = new Map([["hero", 0], ["motions", 1]]);
    return (featured.get(a.id) ?? 2) - (featured.get(b.id) ?? 2) || a.id.localeCompare(b.id);
  }));
  const visibleOfficialDemos = createMemo(() => officialDemos().slice(0, showAllOfficial() ? officialDemos().length : 6));
  onMount(() => {
    void props.system.ready.then(
      () => setStatus("Ready to explore"),
      (error) => setStatus(hostError(error).message),
    );
  });
  const [message, setMessage] = createSignal("No app messages yet");
  const stopMessages = props.platform.onMessage((message) => {
    setMessage(`Message from ${message.sourceAppId}: · ${miniAppResultSummary(message.data)}`);
  });
  onCleanup(stopMessages);
  const open = async (appId: string, explicitStyle?: MiniAppPresentationMode) => {
    try {
      await props.system.ready;
      const mode = explicitStyle ?? (launchOverride() === "default" ? undefined : launchOverride());
      const options: AppLaunchOptions | undefined = mode ? { presentationStyle: mode } : undefined;
      const result = await props.platform.openApp(appId, { source: "showcase" }, options);
      setStatus(result.cancelled ? `Cancelled: ${result.reason ?? "closed"}` : `App result: · ${miniAppResultSummary(result.value)}`);
    } catch (error) { setStatus(hostError(error).message); }
  };
  const effectiveProfileStyle = () => launchOverride() === "default" ? "page (pocket.json)" : `${launchOverride()} (override)`;
  const effectiveLobbyStyle = () => launchOverride() === "default"
    ? `${props.state().miniAppPresentationStyle} (global)`
    : `${launchOverride()} (override)`;
  return (
    <SkinCard>
      <View class="flex-row items-center justify-between gap-2 w-full" style={{ minW: 0 }}>
        <View class="flex-1 min-w-0" style={{ minW: 0 }}>
          <SkinListTile title="Mini Apps" detail="A little more to explore." />
        </View>
        <SkinBadge label={`${2 + officialDemos().filter((demo) => demo.installed).length} INSTALLED`} tone="neutral" />
      </View>
      <View class="flex-col gap-2 w-full" style={{ minW: 0 }}>
        <SkinButton label="Open profile app" onPress={() => void open("pocket.demo.profile")} />
        <SkinButton label="Open lobby app" variant="ghost" onPress={() => void open("pocket.demo.lobby")} />
        <SkinButton
          label="Manage MiniApp versions"
          variant="outline"
          onPress={() => props.dispatch({ type: "navigate", route: "miniapps" })}
        />
      </View>
      <View class="flex-col gap-2 w-full" style={{ minW: 0 }}>
        <Text class="text-xs font-bold" style={{ textColor: tokens().ink }}>
          MiniApp container
        </Text>
        <SkinSegmentedControl
          items={[
            { id: "embedded", label: "嵌入 Pocket 广场" },
            ...(props.fullscreenOpenAvailable()
              ? [{ id: "fullscreen", label: "全屏 Flutter 容器" }]
              : []),
          ]}
          active={props.miniAppOpenMode()}
          onChange={(id) => {
            if (id === "embedded" || (id === "fullscreen" && props.fullscreenOpenAvailable())) {
              props.setMiniAppOpenMode(id);
            }
          }}
        />
        <Show when={!props.fullscreenOpenAvailable()}>
          <SkinParagraph
            text="This host provides embedded MiniApps; fullscreen Flutter routes are unavailable."
            muted
          />
        </Show>
      </View>
      <View
        class="flex-col w-full gap-2 p-3 rounded-xl"
        style={{
          minW: 0,
          radius: tokens().radiusSurface,
          borderWidth: 1,
          bgColor: tokens().surfaceBg,
          borderColor: tokens().border,
        }}
      >
        <Text class="text-xs font-bold" style={{ textColor: tokens().ink }}>
          Global default presentation
        </Text>
        <SkinSegmentedControl
          items={[
            { id: "sheet", label: "Sheet (Bottom-Up)" },
            { id: "page", label: "Page (Push)" },
          ]}
          active={props.state().miniAppPresentationStyle}
          onChange={(id) => props.dispatch({ type: "setMiniAppPresentationStyle", value: id as MiniAppPresentationMode })}
        />
        <Text class="text-xs font-bold" style={{ textColor: tokens().ink }}>
          Launch override
        </Text>
        <SkinSegmentedControl
          items={[
            { id: "default", label: "Default" },
            { id: "sheet", label: "Force Sheet" },
            { id: "page", label: "Force Page" },
          ]}
          active={launchOverride()}
          onChange={(id) => setLaunchOverride(id as "default" | MiniAppPresentationMode)}
        />
        <SkinParagraph
          text={`Effective · Profile: ${effectiveProfileStyle()} · Lobby: ${effectiveLobbyStyle()}`}
          muted
        />
        <View class="flex-row flex-wrap items-center gap-1.5 pt-1 w-full" style={{ minW: 0 }}>
          <SkinButton label="Profile · Sheet" variant="tonal" compact onPress={() => void open("pocket.demo.profile", "sheet")} />
          <SkinButton label="Profile · Page" variant="tonal" compact onPress={() => void open("pocket.demo.profile", "page")} />
          <SkinButton label="Lobby · Sheet" variant="tonal" compact onPress={() => void open("pocket.demo.lobby", "sheet")} />
          <SkinButton label="Lobby · Page" variant="tonal" compact onPress={() => void open("pocket.demo.lobby", "page")} />
        </View>
      </View>
      <View class="flex-col w-full gap-1.5 pt-2" style={{ minW: 0 }}>
        <Text class="text-sm font-bold" style={{ textColor: tokens().ink }}>Official upstream demos</Text>
        <SkinParagraph
          text="Pointer/touch fallback is available where listed; it does not emulate a physical gamepad."
          muted
        />
        <For each={visibleOfficialDemos()}>{(demo) => {
          const fallback = demo.pointerFallbackCapabilities.length > 0
            ? `Pointer/touch fallback for ${demo.pointerFallbackCapabilities.join(", ")}`
            : "No pointer fallback declared";
          const capabilityDetail = demo.missingCapabilities.length > 0
            ? `Host gap: ${demo.missingCapabilities.join(", ")}`
            : fallback;
          const details = [
            demo.status,
            !demo.installed ? "Not installed in this host: no native surface is registered" : "",
            demo.launchability === "portable_pointer_fallback" ? fallback : "",
            capabilityDetail,
            demo.statusReason,
          ]
            .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
            .join(" · ");
          return (
            <View
              class="flex-col w-full gap-1 p-2 rounded-lg"
              style={{
                minW: 0,
                radius: 8,
                borderWidth: 1,
                bgColor: tokens().surfaceBg,
                borderColor: tokens().border,
              }}
            >
              <SkinListTile title={demo.title} detail={details} />
              <SkinButton
                label={demo.installed ? `Open ${demo.id} demo` : "Not installed in this host"}
                disabled={!demo.installed}
                onPress={() => void open(demo.appId)}
              />
            </View>
          );
        }}</For>
        <Show when={officialDemos().length > 6}>
          <SkinButton
            variant="ghost"
            label={showAllOfficial() ? "Show fewer demos" : `Show all ${officialDemos().length} demos`}
            onPress={() => setShowAllOfficial(!showAllOfficial())}
          />
        </Show>
        <Show when={officialDemos().length === 0}>
          <SkinParagraph text="No official demos are staged in this build." muted />
        </Show>
      </View>
      <SkinParagraph text={status()} muted />
      <Show when={message() !== "No app messages yet"}>
        <SkinParagraph text={message()} muted />
      </Show>
      <SkinButton label="Prewarm lobby" variant="ghost" onPress={() => {
        void props.system.ready.then(() => props.platform.prewarm("pocket.demo.lobby")).then(
          () => setStatus("Lobby prewarmed; its guest clock is paused"),
          (error) => setStatus(hostError(error).message),
        );
      }} />
    </SkinCard>
  );
}

function HomeExplore(props: { dispatch: (event: DemoEvent) => void }): JSX.Element {
  const { tokens } = useUiSkin();
  const features = [
    { title: "Mobile UI", detail: "Components", route: "mobile" as const },
    { title: "Transitions", detail: "Motion", route: "transitions" as const },
    { title: "Hardware", detail: "Device APIs", route: "hardware" as const },
    { title: "Video Lab", detail: "Playback", route: "video" as const },
  ];
  return (
    <ScrollContourItem class="flex-row gap-2">
      <For each={features}>{(feature) => (
        <Focusable
          class="flex-1 flex-col gap-2 h-[104] p-2.5 rounded-xl overflow-hidden"
          style={{
            radius: tokens().radiusSurface,
            borderWidth: 1,
            bgColor: tokens().surfaceRaisedBg,
            borderColor: tokens().border,
          }}
          onPress={() => props.dispatch({ type: "navigate", route: feature.route })}
        >
          <View
            class="w-[30] h-[30] items-center justify-center rounded-lg"
            style={{
              bgColor: tokens().surfaceMutedBg,
              radius: 8,
            }}
          >
            <Show when={feature.route === "mobile"}><Image class="w-[20] h-[20]" src="icons/components.svg" /></Show>
            <Show when={feature.route === "transitions"}><Image class="w-[20] h-[20]" src="icons/motion.svg" /></Show>
            <Show when={feature.route === "hardware"}><Image class="w-[20] h-[20]" src="icons/hardware.svg" /></Show>
            <Show when={feature.route === "video"}><Text class="text-sm" style={{ textColor: tokens().ink }}>▶</Text></Show>
          </View>
          <Text class="text-xs font-bold" style={{ textColor: tokens().ink }}>{feature.title}</Text>
          <Text class="text-xs" style={{ textColor: tokens().inkMuted }}>{feature.detail}</Text>
        </Focusable>
      )}</For>
    </ScrollContourItem>
  );
}

function GalleryTile(props: {
  card: string;
  index: () => number;
  contentWidth: () => number;
  onSelect: () => void;
}): JSX.Element {
  const theme = useMobileTheme();
  const { leftReserve, nodeRef, reserve } = useScrollContourReserve({
    itemLeft: 16,
    itemRight: () => Math.max(0, props.contentWidth() - 16),
  });
  let appliedLeftNonZero = false;
  const tileStyle = () => {
    const l = leftReserve();
    const r = reserve();
    const isLeftColumn = props.index() % 2 === 0;
    if (isLeftColumn && l > 0) appliedLeftNonZero = true;
    const width = Math.max(0, (props.contentWidth() - l - r - 32 - 12) / 2);
    return {
      width,
      radius: 12,
      borderWidth: 1,
      ...(isLeftColumn && (l > 0 || appliedLeftNonZero) ? { marginL: l } : {}),
    };
  };
  return (
    <Focusable
      nodeRef={nodeRef}
      class={
        theme().name === "dark"
          ? "flex-col gap-3 h-[112] p-4 rounded-xl bg-[#09090B] border-[#27272A] focus:bg-[#18181B] overflow-hidden"
          : "flex-col gap-3 h-[112] p-4 rounded-xl bg-white border-[#E4E4E7] focus:bg-[#F4F4F5] overflow-hidden"
      }
      style={tileStyle()}
      onPress={props.onSelect}
    >
      <View
        class={
          theme().name === "dark"
            ? "w-[28] h-[28] items-center justify-center rounded-md bg-[#27272A]"
            : "w-[28] h-[28] items-center justify-center rounded-md bg-[#F4F4F5]"
        }
      >
        <Text class={theme().name === "dark" ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#09090B] font-bold"}>{props.card.slice(0, 2)}</Text>
      </View>
      <View class="flex-row items-center justify-between">
        <Text class={theme().name === "dark" ? "text-sm text-[#FAFAFA] font-bold" : "text-sm text-[#09090B] font-bold"}>{props.card}</Text>
        <Text class={theme().name === "dark" ? "text-sm text-[#A1A1AA]" : "text-sm text-[#71717A]"}>›</Text>
      </View>
    </Focusable>
  );
}

function GalleryPage(props: {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  contentWidth: () => number;
}): JSX.Element {
  const theme = useMobileTheme();
  const [galleryToastOpen, setGalleryToastOpen] = createSignal(true);
  const [galleryPopupOpen, setGalleryPopupOpen] = createSignal(false);
  const [galleryDialogOpen, setGalleryDialogOpen] = createSignal(false);
  const [galleryFw, setGalleryFw] = createSignal("Next.js");
  const [galleryOtp, setGalleryOtp] = createSignal(1);
  const [galleryToggle, setGalleryToggle] = createSignal<string[]>(["bold"]);
  const [galleryDay, setGalleryDay] = createSignal(14);
  const [galleryCmd, setGalleryCmd] = createSignal("calendar");
  const [galleryInv, setGalleryInv] = createSignal("INV001");
  const [galleryPage, setGalleryPage] = createSignal(1);
  const [shadcnTab, setShadcnTab] = createSignal<"scroll" | "menus" | "forms" | "data" | "overlays">("scroll");
  const isDark = () => theme().name === "dark";
  return (
    <ScrollablePage>
      <View class="flex-col gap-4 p-4 pb-6">
      <MobileListTile title="Official building blocks" detail="The essentials, ready to explore." />
      <MobileCard
        title="UIKit Gallery · 1:1 Liquid Glass Replica"
        detail="21 interactive iOS 26 scenes, morphing Options & ••• menus, inline submenus, Context Menu lift, iPadOS wallpapers & Siri IntelligentLight."
      >
        <MobileButton label="Open 1:1 UIKit Gallery" onPress={() => props.dispatch({ type: "navigate", route: "uikit-gallery" })} />
      </MobileCard>
      <MobileCard
        title="Apple Glass"
        detail="Apple-style controls and navigation, with a calm backdrop to explore."
      >
        <MobileButton label="Open Apple Glass" onPress={() => props.dispatch({ type: "navigate", route: "apple" })} />
      </MobileCard>
      <MobileCard
        title="Looseleaf Paper & Ink"
        detail="Standalone @pocket/looseleaf package: hand-drawn paper, felt-tip, marker and masking tape UI."
      >
        <MobileButton label="Open Looseleaf" onPress={() => props.dispatch({ type: "navigate", route: "looseleaf" })} />
      </MobileCard>
      <MobileCard
        title="Unified Skin Studio (Default · Looseleaf · Arc · Glass)"
        detail="Seamless runtime switching across Default UI, @pocket/looseleaf, @pocket/arc and @pocket/liquid_glass behind one shared UiSkinKit interface."
      >
        <MobileButton label="Open Skin Studio" onPress={() => props.dispatch({ type: "navigate", route: "skins" })} />
      </MobileCard>
      <MobileCard
        title="URL & State Router (Deep-Linking Lab)"
        detail="Radix path matcher, typed stateParam query codecs, Base64URL snapshots, and automatic back-stack synthesis."
      >
        <MobileButton label="Open Router Studio" onPress={() => props.dispatch({ type: "navigate", route: "router" })} />
      </MobileCard>
      <MobileCard
        title="High-FPS Extreme Load Stress Lab"
        detail="Sustain 60–120+ FPS under 100,000 VirtualList rows, 512 orbital particles & single-FFI JumpBatch."
      >
        <MobileButton label="Open Stress Lab" onPress={() => props.dispatch({ type: "navigate", route: "stress" })} />
      </MobileCard>
      <MobileCard
        title="Apple & Android Full Ecosystem + Widgets"
        detail="Single-engine pixel identity across iPhone, iPad, Mac, Watch, TV, Vision Pro, Foldables, Today Widget, Lock Screen, Dynamic Island, Glance & Wear OS Tiles."
      >
        <MobileButton label="Open Ecosystem Lab" onPress={() => props.dispatch({ type: "navigate", route: "ecosystem" })} />
      </MobileCard>
      <View class="flex-row flex-wrap gap-3">
        <For each={componentCards}>
          {(card, index) => (
            <GalleryTile
              card={card}
              index={index}
              contentWidth={props.contentWidth}
              onSelect={() => props.dispatch({ type: "select", component: card })}
            />
          )}
        </For>
      </View>
      <MobileCard>
        <MobileListTile title="Lazy panel" detail="Content, when you need it." trailing={<MobileButton label={props.state().lazyVisible ? "Hide" : "Show"} kind="tonal" onPress={() => props.dispatch({ type: "toggleLazy" })} />} />
        <Lazy when={() => props.state().lazyVisible}>
          {() => (
            <View class="flex-col gap-1 p-3 rounded-lg bg-[#18181B] border-[#27272A]">
              <Text class="text-xs text-[#FAFAFA] font-bold">Lazy subtree is mounted</Text>
              <Text class="text-xs text-[#A1A1AA]">Only mounted while visible.</Text>
              <MiniBarChart values={[8, 14, 10, 22, 18, 28, 24]} />
            </View>
          )}
        </Lazy>
      </MobileCard>
      <MobileCard>
        <MobileListTile title="Go a little further" detail="Components, motion and device APIs." />
        <View class="flex-row flex-wrap gap-2">
          <MobileButton label="Mobile UI" onPress={() => props.dispatch({ type: "navigate", route: "mobile" })} />
          <MobileButton label="Transitions" kind="tonal" onPress={() => props.dispatch({ type: "navigate", route: "transitions" })} />
          <MobileButton label="Hardware" kind="text" onPress={() => props.dispatch({ type: "navigate", route: "hardware" })} />
          <MobileButton label="Video Lab" kind="text" onPress={() => props.dispatch({ type: "navigate", route: "video" })} />
        </View>
      </MobileCard>
      <MobileCard>
        <MobileListTile title="Feedback & overlays" detail="Messages, sheets and dialogs." />
        <MobileAlert
          tone="info"
          title="Make it yours"
          body="Choose your appearance and display preferences in Settings."
        />
        <MobileToast
          open={galleryToastOpen()}
          tone="success"
          message="Toast ready in Gallery"
          detail="Spring entrance & tone transitions"
          onClose={() => setGalleryToastOpen(false)}
        />
        <View class="flex-row flex-wrap gap-2">
          <MobileButton label="Toast" kind="tonal" onPress={() => setGalleryToastOpen(true)} />
          <MobileButton label="Popup" kind="text" onPress={() => setGalleryPopupOpen(true)} />
          <MobileButton label="Dialog" kind="text" onPress={() => setGalleryDialogOpen(true)} />
          <MobileButton label="Full Suite" onPress={() => props.dispatch({ type: "navigate", route: "mobile" })} />
        </View>
      </MobileCard>
      <MobilePopup
        open={galleryPopupOpen()}
        title="Gallery Action Sheet"
        subtitle="BottomSheet on mobile, centered Popover on desktop."
        actions={[
          { id: "mobile", label: "Open full Mobile + PC UI showcase", detail: "Explore the component collection" },
          { id: "transitions", label: "Inspect route transitions", detail: "iOS spring, shared axis & portal" },
        ]}
        onSelectAction={(id) => {
          if (id === "mobile") props.dispatch({ type: "navigate", route: "mobile" });
          if (id === "transitions") props.dispatch({ type: "navigate", route: "transitions" });
        }}
        onClose={() => setGalleryPopupOpen(false)}
      />
      <MobileDialog
        open={galleryDialogOpen()}
        title="A moment to confirm"
        body="Animated scale & opacity transition owned by JS."
        confirmLabel="Open Mobile UI"
        onConfirm={() => props.dispatch({ type: "navigate", route: "mobile" })}
        onClose={() => setGalleryDialogOpen(false)}
      />
      <MobileAlert tone="info" title="Not mounted here" body="More capabilities live under Host." />

      <Show when={props.state().route === "gallery"}>
        <MobileCard
          title="shadcn/ui Full Component Suite (50+)"
          detail="Browse all shadcn/ui primitives: ScrollArea/ScrollFade, Resizable, Sidebar, Menus, Forms, DataTable, Chart, Overlays & Typography."
        >
          <View class="flex-row flex-wrap gap-1.5">
            <MobileButton
              label="Scroll & Layout"
              kind={shadcnTab() === "scroll" ? "filled" : "tonal"}
              compact
              onPress={() => setShadcnTab("scroll")}
            />
            <MobileButton
              label="Menus & Command"
              kind={shadcnTab() === "menus" ? "filled" : "tonal"}
              compact
              onPress={() => setShadcnTab("menus")}
            />
            <MobileButton
              label="Forms & Date"
              kind={shadcnTab() === "forms" ? "filled" : "tonal"}
              compact
              onPress={() => setShadcnTab("forms")}
            />
            <MobileButton
              label="Charts & Tables"
              kind={shadcnTab() === "data" ? "filled" : "tonal"}
              compact
              onPress={() => setShadcnTab("data")}
            />
            <MobileButton
              label="Overlays & Text"
              kind={shadcnTab() === "overlays" ? "filled" : "tonal"}
              compact
              onPress={() => setShadcnTab("overlays")}
            />
          </View>

          <Show when={shadcnTab() === "scroll"}>
            <ShadcnScrollArea title="Tags (ScrollArea + ScrollFade)" dark={isDark()} />
            <ShadcnSeparator dark={isDark()} />
            <ShadcnResizable dark={isDark()} />
            <ShadcnSeparator dark={isDark()} />
            <ShadcnSidebar dark={isDark()} />
            <ShadcnSeparator dark={isDark()} />
            <ShadcnCarousel dark={isDark()} />
            <ShadcnAspectRatio dark={isDark()} />
          </Show>

          <Show when={shadcnTab() === "menus"}>
            <ShadcnBreadcrumb items={["shadcn/ui", "Components", "Preview"]} dark={isDark()} />
            <ShadcnNavigationMenu dark={isDark()} />
            <ShadcnMenubar dark={isDark()} />
            <ShadcnCommand
              selectedId={galleryCmd()}
              onSelect={setGalleryCmd}
              items={[
                { id: "calendar", label: "Calendar", group: "Suggestions" },
                { id: "emoji", label: "Search Emoji", group: "Suggestions" },
                { id: "profile", label: "Profile", group: "Preferences", shortcut: "⌘P" },
                { id: "billing", label: "Billing", group: "Preferences", shortcut: "⌘B" },
              ]}
              dark={isDark()}
            />
            <ShadcnDropdownMenu
              triggerLabel="My Account"
              items={[
                { id: "profile", label: "Profile", shortcut: "⇧⌘P" },
                { id: "billing", label: "Billing", shortcut: "⌘B" },
                { id: "shortcuts", label: "Keyboard shortcuts", shortcut: "⌘K" },
              ]}
              dark={isDark()}
            />
            <ShadcnContextMenu dark={isDark()} />
            <ShadcnHoverCard
              handle="@nextjs"
              description="The React Framework – created and maintained by @vercel."
              joined="Joined December 2021"
              dark={isDark()}
            />
          </Show>

          <Show when={shadcnTab() === "forms"}>
            <ShadcnSelect
              label="Framework"
              value={galleryFw()}
              options={["Next.js", "SolidJS", "SvelteKit", "Astro", "Remix"]}
              onChange={setGalleryFw}
              dark={isDark()}
            />
            <ShadcnCombobox dark={isDark()} />
            <ShadcnInputOTP
              value="482910"
              activeSlot={galleryOtp()}
              onSelectSlot={setGalleryOtp}
              dark={isDark()}
            />
            <ShadcnToggleGroup
              options={[
                { id: "bold", label: "B Bold" },
                { id: "italic", label: "I Italic" },
                { id: "underline", label: "U Underline" },
              ]}
              selected={galleryToggle()}
              onToggle={(id) =>
                setGalleryToggle((prev) =>
                  prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
                )
              }
              dark={isDark()}
            />
            <ShadcnDatePicker dark={isDark()} />
            <ShadcnCalendar
              monthLabel="November 2026"
              selectedDay={galleryDay()}
              onSelectDay={setGalleryDay}
              dark={isDark()}
            />
            <ShadcnFormField dark={isDark()} />
            <ShadcnInputGroup dark={isDark()} />
            <ShadcnTextarea dark={isDark()} />
            <ShadcnButtonGroup dark={isDark()} />
          </Show>

          <Show when={shadcnTab() === "data"}>
            <ShadcnChart dark={isDark()} />
            <ShadcnDataTable dark={isDark()} />
            <ShadcnTable
              caption="A list of your recent invoices."
              selectedInvoice={galleryInv()}
              onSelectRow={setGalleryInv}
              rows={[
                { invoice: "INV001", status: "Paid", method: "Credit Card", amount: "$250.00" },
                { invoice: "INV002", status: "Pending", method: "PayPal", amount: "$150.00" },
                { invoice: "INV003", status: "Unpaid", method: "Bank Transfer", amount: "$350.00" },
              ]}
              totalAmount="$750.00"
              dark={isDark()}
            />
            <View class="flex-row items-center justify-between flex-wrap gap-2">
              <View class="flex-row items-center gap-1.5">
                <ShadcnKbd keys="⌘K" dark={isDark()} />
                <ShadcnKbd keys="⇧⌘P" dark={isDark()} />
              </View>
              <ShadcnPagination page={galleryPage()} totalPages={3} onChange={setGalleryPage} dark={isDark()} />
            </View>
            <ShadcnItem
              title="Two-factor authentication (Item)"
              description="Verify via email or authenticator code."
              badge="Enabled"
              dark={isDark()}
            />
          </Show>

          <Show when={shadcnTab() === "overlays"}>
            <ShadcnDrawer dark={isDark()} />
            <ShadcnSheet dark={isDark()} />
            <ShadcnPopover dark={isDark()} />
            <ShadcnCollapsible
              title="@peduarte starred 3 repositories"
              pinnedItem="@radix-ui/primitives"
              hiddenItems={["@radix-ui/colors", "@stitches/react"]}
              dark={isDark()}
            />
            <View class="flex-row items-center justify-between flex-wrap gap-2">
              <ShadcnTooltip dark={isDark()} />
              <ShadcnSpinner dark={isDark()} />
            </View>
            <ShadcnEmpty dark={isDark()} />
            <ShadcnTypography dark={isDark()} />
          </Show>
        </MobileCard>
      </Show>
      </View>
    </ScrollablePage>
  );
}

function HostPages(props: {
  route: Route;
  host: HostBridge;
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  requestCapability: (key: CapabilityKey, capability: string, params?: Record<string, JsonValue>) => void;
  runStress: (nodes: number) => void;
  performance: () => PerformanceSnapshot;
  recordingStatus?: () => Record<string, unknown> | undefined;
}): JSX.Element {
  const route = () => props.route;
  const switchTab = (id: string): void => {
    const target = routeOf(id);
    if (target && target !== "home" && target !== "gallery") props.dispatch({ type: "navigate", route: target });
  };
  return (
    <ScrollablePage>
      <View class="flex-col gap-4 p-4 pb-6">
      <Show when={route() === "about"}>
        <HybridFlutterHostEntry host={props.host} />
      </Show>
      <Show when={route() === "about"}>
        <RuntimePage host={props.host} state={props.state} requestCapability={props.requestCapability} onNavigate={(route) => props.dispatch({ type: "navigate", route })} recordingStatus={props.recordingStatus} />
      </Show>
      <Show when={route() === "about"}>
        <MobileCard title="Explore your host" detail="Packages, updates and diagnostics.">
          <For each={hostTabs.filter((tab) => tab.id !== "about")}>{(tab) => <MobileListTile title={tab.label} detail="Open details" trailing={<MobileButton label={`Open ${tab.label}`} kind="text" onPress={() => switchTab(tab.id)} />} onPress={() => switchTab(tab.id)} />}</For>
        </MobileCard>
      </Show>

      <Show when={route() === "bytecode"}>
        <BytecodePage state={props.state} requestCapability={props.requestCapability} />
      </Show>
      <Show when={route() === "updates"}>
        <UpdatesPage state={props.state} requestCapability={props.requestCapability} />
      </Show>
      <Show when={route() === "plugins"}>
        <PluginsPage state={props.state} requestCapability={props.requestCapability} />
      </Show>
      <Show when={route() === "stress"}>
        <StressLabPage active={() => props.state().route === "stress"} state={props.state} dispatch={props.dispatch} runStress={props.runStress} />
      </Show>
      <Show when={route() === "performance"}>
        <PerformancePage state={props.state} performance={props.performance} requestCapability={props.requestCapability} />
      </Show>
      </View>
    </ScrollablePage>
  );
}

function HybridFlutterHostEntry(props: { host: HostBridge }): JSX.Element {
  const [phase, setPhase] = createSignal<"idle" | "opening" | "returned" | "error">("idle");
  const [errorText, setErrorText] = createSignal("");

  const open = async (): Promise<void> => {
    if (phase() === "opening") return;
    setPhase("opening");
    setErrorText("");
    try {
      await props.host.request<JsonValue>("demo.hybridFlutter.open", {});
      setPhase("returned");
    } catch (error) {
      const failure = hostError(error);
      setErrorText(`${failure.code}: ${failure.message}`);
      setPhase("error");
    }
  };

  return (
    <MobileCard title="混合 Flutter 宿主" detail="打开带有原生首页、发现页和 Pocket 广场的 Flutter 宿主。">
      <MobileButton
        label={phase() === "opening" ? "混合宿主已打开…" : phase() === "returned" ? "再次打开混合宿主" : "打开混合 Flutter 宿主"}
        kind="tonal"
        onPress={() => { void open(); }}
      />
      <Show when={phase() === "returned"}>
        <MobileAlert tone="success" title="已返回 Host" body="原页面状态已保留，可再次打开混合宿主。" />
      </Show>
      <Show when={phase() === "error"}>
        <MobileAlert tone="danger" title="混合宿主打开失败" body={errorText()} />
      </Show>
    </MobileCard>
  );
}

function RuntimePage(props: {
  host: HostBridge;
  state: () => DemoState;
  requestCapability: (key: CapabilityKey, capability: string) => void;
  onNavigate: (route: Route) => void;
  recordingStatus?: () => Record<string, unknown> | undefined;
}): JSX.Element {
  const theme = useMobileTheme();
  return (
    <View class="flex-col gap-3">
      <MobileListTile title="Runtime" detail="Live host status and package identity." />
      <CapabilityCard title="Runtime info" capability="runtime.info" state={props.state().runtimeInfo} onRefresh={() => props.requestCapability("runtimeInfo", "runtime.info")} />
      <CapabilityCard title="Package metadata" capability="plugins.packageInfo" state={props.state().packageInfo} onRefresh={() => props.requestCapability("packageInfo", "plugins.packageInfo")} />
      <ScrollContourItem>
        <MobileButton label="Frame diagnostics" kind="tonal" onPress={() => props.onNavigate("performance")} />
      </ScrollContourItem>
      <Show
        when={supportsRecording(props.state().runtimeInfo)}
        fallback={<MobileAlert
          tone="info"
          title={props.state().runtimeInfo.phase === "ready"
            ? "Deterministic replay unavailable"
            : props.state().runtimeInfo.phase === "error"
            ? "Recording support unavailable"
            : "Checking recording support"}
          body={props.state().runtimeInfo.phase === "ready"
            ? "The active host does not provide recording and replay."
            : props.state().runtimeInfo.phase === "error"
            ? `${props.state().runtimeInfo.error?.code ?? "host_error"}: ${props.state().runtimeInfo.error?.message ?? "Runtime facts are unavailable."}`
            : "Waiting for the host to finish capability negotiation."}
        />}
      >
        <RecordingPanel host={props.host} status={props.recordingStatus} />
      </Show>
      <MobileAlert title={`Connected to ${hostLabel(props.state().runtimeInfo)}`} body="UI state stays in JS" tone={props.state().runtimeInfo.phase === "error" ? "danger" : "info"} />
    </View>
  );
}

function PerformancePage(props: {
  state: () => DemoState;
  performance: () => PerformanceSnapshot;
  requestCapability: (key: CapabilityKey, capability: string, params?: Record<string, JsonValue>) => void;
}): JSX.Element {
  const theme = useMobileTheme();
  onMount(() => props.requestCapability("runtimePerformance", "runtime.performance"));
  const points = () => recentPerformance(props.performance());
  const latest = () => props.performance().latest;
  const lowRows = () => lowPerformanceRows(points());
  const jankRows = () => performanceJankRows(props.performance());
  const provider = () => props.state().runtimePerformance;
  const latestLongFrame = () => {
    const events = recentPerformanceJanks(props.performance());
    return events[events.length - 1];
  };
  const latestBudget = () => performanceBudget(latest()) ?? latestLongFrame()?.budgetMs;
  const latestGap = () => performanceGap(latest()) ?? latestLongFrame()?.activeGapMs ?? latestLongFrame()?.durationMs;
  const latestBuild = () => latest()?.buildMsP95 ?? latestLongFrame()?.buildMs;
  const latestRaster = () => latest()?.rasterMsP95 ?? latestLongFrame()?.rasterMs;
  const latestBridgeDecode = () => latest()?.nativeWorkMsP95 ?? latestLongFrame()?.nativeMs;
  return (
    <View class="flex-col gap-2">
      <MobileListTile title="Frame diagnostics" detail="Guest ticks are separate from display FPS. Sparse rendering is not a stall." />
      <MobileCard>
        <View class="flex-col gap-1 flex-1" style={{ minW: 0 }}>
          <MobileParagraph text={`Performance provider · ${hostPhase(provider())}`} class={theme().name === "dark" ? "text-xs text-white font-bold" : "text-xs text-slate-950 font-bold"} />
          <MobileParagraph
            text={capabilitySummary(provider())}
            class={provider().phase === "error" ? "text-xs text-rose-700" : "text-xs text-slate-600"}
          />
        </View>
        <MobileButton
          label={provider().phase === "loading" ? "Wait" : "Refresh"}
          kind="text"
          onPress={() => props.requestCapability("runtimePerformance", "runtime.performance")}
        />
      </MobileCard>
      <MobileCard>
        <MobileListTile title="Recent 60 samples" detail={props.performance().recording ? "Recording" : "Provider not recording"} trailing={<MobileBadge tone={props.performance().recording ? "success" : "warning"} label={String(points().length)} />} />
        <Show when={points().length > 0} fallback={<MobileAlert tone="info" title="No guest tick samples" body="Open a configured host performance provider or refresh this page." />}>
          <MiniBarChart values={performanceBars(points())} />
          <MobileParagraph text="Bars show guest scheduler turns per active second, not display FPS." class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"} />
        </Show>
      </MobileCard>
      <ScrollContourItem class="flex-row gap-2">
        <MobileCard title="Guest ticks/s" detail={latest() ? `min ${metricNumber(latest()?.minFps)} · active gap ${metricNumber(latestGap())} ms` : "No latest sample"}>
          <Text class="text-2xl font-bold" style={{ textColor: toMobileColor(theme().accentInkColor) }}>{metricNumber(latest()?.fps)}</Text>
        </MobileCard>
        <MobileCard>
          <Text class={theme().name === "dark" ? "text-xs text-rose-300" : "text-xs text-rose-700"}>Current minimum</Text>
          <Text class={theme().name === "dark" ? "text-xl text-rose-300 font-bold" : "text-xl text-rose-700 font-bold"}>{metricNumber(minimumPerformanceFps(points()))}</Text>
          <Text class={theme().name === "dark" ? "text-xs text-rose-300" : "text-xs text-rose-700"}>lowest guest tick window</Text>
        </MobileCard>
      </ScrollContourItem>
      <Show when={latest() ?? latestLongFrame()} fallback={<MobileAlert tone="info" title="No frame breakdown" body="The provider has not returned a current frame window." />}>
        <MobileCard>
          <MobileListTile
            title="Latest frame breakdown"
            detail={latestBudget() === undefined ? "refresh budget unavailable" : `budget ${metricNumber(latestBudget())} ms`}
          />
          <View class="flex-row items-center justify-between gap-2 w-full" style={{ minW: 0 }}>
            <View class="flex-1 min-w-0" style={{ minW: 0 }}>
              <MobileListTile title="UI build" detail={latestBuild() === undefined ? "—" : `${metricNumber(latestBuild())} ms${latest()?.buildMsP95 === undefined ? " long frame" : " p95"}`} />
            </View>
            <View class="flex-1 min-w-0" style={{ minW: 0 }}>
              <MobileListTile title="Raster" detail={latestRaster() === undefined ? "—" : `${metricNumber(latestRaster())} ms${latest()?.rasterMsP95 === undefined ? " long frame" : " p95"}`} />
            </View>
          </View>
          <View class="flex-row items-center justify-between gap-2 w-full" style={{ minW: 0 }}>
            <View class="flex-1 min-w-0" style={{ minW: 0 }}>
              <MobileListTile title="Bridge/decode" detail={latestBridgeDecode() === undefined ? "—" : `${metricNumber(latestBridgeDecode())} ms${latest()?.nativeWorkMsP95 === undefined ? " long frame" : " p95"}`} />
            </View>
            <View class="flex-1 min-w-0" style={{ minW: 0 }}>
              <MobileListTile title="Active gap" detail={latestGap() === undefined ? "—" : `${metricNumber(latestGap())} ms`} />
            </View>
          </View>
          <MobileParagraph
            text={`Compatibility bridge p95: ${metricNumber(latest()?.nativeMsP95)} ms · refresh ${latest()?.refreshHz === undefined ? "—" : `${metricNumber(latest()?.refreshHz)} Hz`}`}
            class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}
          />
        </MobileCard>
      </Show>
      <Show when={jankRows().length > 0} fallback={<MobileAlert tone="info" title="No recent long frames" body="No active gap exceeded the provider's refresh-rate budget. A low guest tick rate with gap 0 can be intentional sparse rendering." />}>
        <MobileCard>
          <MobileListTile title="Recent long frames" detail="Measured jank history" />
          <PocketVirtualList
            count={jankRows().length}
            rowHeight={64}
            height={192}
            focusRows={false}
            overscan={12}
            renderRow={(index) => {
              const item = jankRows()[index];
              return (
                <View class="flex-col gap-1 px-2 py-1 bg-[#3D2E10] border-[#936211]">
                  <Text class={theme().name === "dark" ? "text-xs text-[#FCD34D] font-bold" : "text-xs text-amber-800 font-bold"}>{item?.title ?? "Long frame"}</Text>
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}>{item?.detail ?? "Frame timing breakdown unavailable"}</Text>
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}>{item?.context ?? "Host frame sampler"}</Text>
                </View>
              );
            }}
          />
        </MobileCard>
      </Show>
      <Show when={lowRows().length > 0} fallback={<MobileAlert tone="info" title="No low-frame samples" body="The provider has not returned a measurable history yet." />}>
        <MobileCard>
          <MobileListTile title="Lowest guest tick samples" detail="Compatibility history · not jank by itself" />
          <PocketVirtualList
            count={lowRows().length}
            rowHeight={36}
            height={108}
            focusRows={false}
            overscan={12}
            renderRow={(index) => {
              const item = lowRows()[index];
              return (
                <View class={theme().name === "dark" ? "flex-col gap-1 px-2 py-1 bg-[#17233B] border-[#30405A]" : "flex-col gap-1 px-2 py-1 bg-slate-50 border-slate-200"}>
                  <Text class={theme().name === "dark" ? "text-xs text-rose-300 font-bold" : "text-xs text-rose-700 font-bold"}>{item?.title ?? "Low guest tick sample"}</Text>
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}>{item?.detail ?? "Provider metrics unavailable"}</Text>
                </View>
              );
            }}
          />
        </MobileCard>
      </Show>
    </View>
  );
}

function BytecodePage(props: {
  state: () => DemoState;
  requestCapability: (key: CapabilityKey, capability: string) => void;
}): JSX.Element {
  const theme = useMobileTheme();
  return (
    <View class="flex-col gap-3">
      <MobileListTile title="Bytecode" detail="QuickJS runtime and bundle identity." />
      <CapabilityCard title="QuickJS runtime" capability="runtime.info" state={props.state().runtimeInfo} onRefresh={() => props.requestCapability("runtimeInfo", "runtime.info")} />
      <MobileCard>
        <MobileListTile title="Package response" detail="Reported by the active runtime." />
        <For each={summaryLines(capabilitySummary(props.state().runtimeInfo))}>{(line) => <MobileParagraph text={line} class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-500"} />}</For>
      </MobileCard>
    </View>
  );
}

function UpdatesPage(props: {
  state: () => DemoState;
  requestCapability: (key: CapabilityKey, capability: string, params?: Record<string, JsonValue>) => void;
}): JSX.Element {
  const theme = useMobileTheme();
  const versions = () => versionHistory(props.state().updatesStatus.result);
  return (
    <View class="flex-col gap-2">
      <MobileListTile title="Updates" detail="Manage versions supplied by the host." />
      <CapabilityCard title="Current status" capability="updates.status" state={props.state().updatesStatus} onRefresh={() => props.requestCapability("updatesStatus", "updates.status")} />
      <Show when={versions().length > 0} fallback={<MobileAlert tone="info" title="Version history" body="The host returned no verified versions." />}>
        <MobileCard>
          <MobileListTile title="Version history" detail="From updates.status" trailing={<MobileBadge label={String(versions().length)} />} />
          <PocketVirtualList
            count={versions().length}
            rowHeight={32}
            height={80}
            focusRows={false}
            overscan={32}
            renderRow={(index) => {
              const item = versions()[index];
              return (
                <View class={theme().name === "dark" ? "flex-col gap-1 px-2 py-1 bg-[#17233B] border-[#30405A]" : "flex-col gap-1 px-2 py-1 bg-white border-slate-200"}>
                  <Text class={theme().name === "dark" ? "text-xs text-white font-bold" : "text-xs text-slate-950 font-bold"}>{item?.title ?? "Version"}</Text>
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}>{item?.detail ?? "verified version"}</Text>
                </View>
              );
            }}
          />
        </MobileCard>
      </Show>
      <Show when={!capabilityUnavailable(props.state().updatesStatus)}
        fallback={<MobileAlert tone="info" title="Updates not configured" body="This host runs the embedded package. Pocket package updates are not enabled." />}>
      <View class="flex-row flex-wrap gap-2">
        <MobileButton label="Check" onPress={() => props.requestCapability("updatesCheck", "updates.check")} />
        <MobileButton label="Apply" kind="tonal" onPress={() => props.requestCapability("updatesApply", "updates.apply")} />
        <MobileButton label="Rollback" kind="danger" onPress={() => props.requestCapability("updatesRollback", "updates.rollback")} />
      </View>
      <MobileCard>
        <MobileListTile title="updates.check" detail={capabilitySummary(props.state().updatesCheck)} />
        <MobileListTile title="updates.apply" detail={capabilitySummary(props.state().updatesApply)} />
        <MobileListTile title="updates.rollback" detail={capabilitySummary(props.state().updatesRollback)} />
      </MobileCard>
      </Show>
    </View>
  );
}

function PluginsPage(props: {
  state: () => DemoState;
  requestCapability: (key: CapabilityKey, capability: string) => void;
}): JSX.Element {
  const theme = useMobileTheme();
  const plugins = () => listItems(props.state().pluginsList.result);
  return (
    <View class="flex-col gap-3">
      <MobileListTile title="Plugins" detail="Installed capabilities from the host." />
      <CapabilityCard title="Installed plugins" capability="plugins.list" state={props.state().pluginsList} onRefresh={() => props.requestCapability("pluginsList", "plugins.list")} />
      <Show when={plugins().length > 0} fallback={<MobileAlert tone="info" title="No plugin list" body={capabilitySummary(props.state().pluginsList)} />}>
        <MobileCard><For each={plugins()}>{(plugin) => <MobileListTile title={plugin.title} detail={plugin.detail} />}</For></MobileCard>
      </Show>
      <CapabilityCard title="External package info" capability="plugins.packageInfo" state={props.state().packageInfo} onRefresh={() => props.requestCapability("packageInfo", "plugins.packageInfo")} />
    </View>
  );
}



mount(() => <App />);

