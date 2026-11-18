/**
 * Interactive URL & State Deep-Link Studio (`route === "router"`).
 *
 * Demonstrates `@pocket/ui/router` end-to-end inside QuickJS bytecode:
 * - Omnibox URI input (`pocket://showcase/...`) with Push / Replace / Back
 * - One-tap State Deep-Link presets jumping straight into deep sub-tabs,
 *   pre-hydrated counters/inputs, 0% blue night palettes, open modal dialogs,
 *   and cross-boundary MiniApp sheets — with automatic ancestor stack synthesis
 * - Live two-way `useSearchState` + URL-safe Base64 `stateParam.snapshot` codecs
 * - Opt-in `PlatformExperience` host link pull & stream subscription
 */

import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { View } from "@pocketjs/framework/solid/components";
import {
  ScrollablePage,
  SkinAlert,
  SkinBadge,
  SkinButton,
  SkinCard,
  SkinInput,
  SkinListTile,
  SkinMetric,
  SkinParagraph,
  SkinSegmentedControl,
  SkinStepper,
  SkinSwitch,
  extractLinkUri,
  stateParam,
  usePocketRouter,
  useSearchState,
  useUiSkin,
} from "@pocket/ui";
import { hostError } from "@pocket/ui/host";
import type { PlatformExperience, PlatformLinkSubscription } from "@pocket/ui/platform-experience";
import type { DemoEvent, DemoState, ShowcaseSkin } from "./state.ts";

interface DeepLinkPreset {
  readonly id: string;
  readonly title: string;
  readonly badge: string;
  readonly uri: string;
  readonly detail: string;
}

const DEEP_LINK_PRESETS: readonly DeepLinkPreset[] = [
  {
    id: "stress-120fps-extreme",
    title: "Stress Lab · 100k Rows + 384 Particles (120Hz)",
    badge: "HIGH FPS",
    uri: "pocket://showcase/stress?skin=arc&dark=1&preset=extreme&particles=384&rows=100000&mutations=6000&batch=1&running=1",
    detail: "Synthesizes /about -> /stress in Arc Dark and launches 100k VirtualList rows + 384 JumpBatch particles.",
  },
  {
    id: "arc-night-controls",
    title: "Arc · 0% Blue Night Controls (85%)",
    badge: "STATE + STACK",
    uri: "pocket://showcase/skins/controls?skin=arc&mode=amber-night&studioAccent=coral&quota=85",
    detail: "Synthesizes home -> gallery -> skins, switches to Arc 0% Blue OLED palette & 85% stepper.",
  },
  {
    id: "looseleaf-dialog",
    title: "Looseleaf · Overlays + Open Dialog",
    badge: "MODAL DIRECT",
    uri: "pocket://showcase/skins/overlays?skin=looseleaf&dialog=1&note=DeepLink+Verified",
    detail: "Jumps into Looseleaf paper skin, selects Overlays tab, and opens the Confirm Dialog immediately.",
  },
  {
    id: "looseleaf-paper-calm",
    title: "Looseleaf · Paper Tricks (Calm 0 deg)",
    badge: "SUB-ROUTE",
    uri: "pocket://showcase/looseleaf/surfaces?llMode=notebook&llDensity=calm",
    detail: "Matches /looseleaf/:section -> surfaces with zero-tilt calm density and synthesized parent stack.",
  },
  {
    id: "home-playground",
    title: "Home · Counter 42 + Draft Hydrated",
    badge: "HYDRATE",
    uri: "pocket://showcase/home?count=42&draft=DeepLink+Ready&skin=default",
    detail: "Resets to primary Home tab and pre-populates Counter=42 and native Input draft.",
  },
  {
    id: "gallery-modal",
    title: "UI Collection · Lazy + TextField Modal",
    badge: "QUERY CODEC",
    uri: "pocket://showcase/gallery?lazy=1&modal=TextField",
    detail: "Mounts the deferred Lazy chart subtree and opens the TextField detail modal on arrival.",
  },
  {
    id: "miniapp-profile",
    title: "MiniApp · Profile Sheet Dispatch",
    badge: "MINI-APP",
    uri: "pocket://app/pocket.demo.profile/security?from=router&style=sheet",
    detail: "Routes cross-boundary pocket://app/<appId>/... directly into platform.openApp() with sheet override.",
  },
];

interface RouterSnapshotState {
  readonly preset: string;
  readonly rev: number;
  readonly tags: readonly string[];
}

const DEFAULT_SNAPSHOT: RouterSnapshotState = {
  preset: "radix-tree",
  rev: 1,
  tags: ["rou3", "nuqs"],
};

const FILTER_OPTIONS = ["all", "radix", "codecs", "stack"] as const;

export function RouterStudioPage(props: {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  experience: PlatformExperience;
  onOpenDeepLink: (uri: string) => { handled: boolean; kind: string; summary: string };
}): JSX.Element {
  const router = usePocketRouter();
  const skin = useUiSkin();

  // Local URL-synced signals on `/router`
  const [filter, setFilter] = useSearchState(
    "filter",
    stateParam.enum(FILTER_OPTIONS, "all"),
    { routeId: "router" },
  );
  const [stepIndex, setStepIndex] = useSearchState(
    "step",
    stateParam.int(1, { min: 1, max: 9 }),
    { routeId: "router" },
  );
  const [inspectorOpen, setInspectorOpen] = useSearchState(
    "inspect",
    stateParam.boolean(true),
    { routeId: "router" },
  );
  const [snapshot, setSnapshot] = useSearchState<RouterSnapshotState>(
    "snap",
    stateParam.snapshot<RouterSnapshotState>(DEFAULT_SNAPSHOT, (raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const rec = raw as Record<string, unknown>;
      if (typeof rec.preset !== "string" || typeof rec.rev !== "number" || !Array.isArray(rec.tags)) {
        return undefined;
      }
      return {
        preset: rec.preset,
        rev: rec.rev,
        tags: rec.tags.filter((t): t is string => typeof t === "string"),
      };
    }),
    { routeId: "router" },
  );

  const [omnibox, setOmnibox] = createSignal(router.uri());
  const [dispatchLog, setDispatchLog] = createSignal(
    "Ready — tap any preset or edit the URI bar to test State Deep-Linking.",
  );
  const [hostLinkStatus, setHostLinkStatus] = createSignal("Opt-in idle (0 boot RPCs)");
  const [streamSub, setStreamSub] = createSignal<PlatformLinkSubscription | undefined>(undefined);

  createEffect(() => {
    const live = router.uri();
    if (props.state().route === "router") {
      setOmnibox(live);
    }
  });

  onCleanup(() => {
    streamSub()?.unsubscribe();
  });

  const executeUri = (uriText: string, mode: "deeplink" | "replace"): void => {
    const trimmed = uriText.trim();
    if (!trimmed) return;
    if (mode === "replace") {
      const ok = router.replace(trimmed);
      setDispatchLog(ok ? `Replaced URI -> ${router.uri()}` : `Ignored URI: ${trimmed}`);
      return;
    }
    const result = props.onOpenDeepLink(trimmed);
    setDispatchLog(result.summary);
  };

  const pullInitialHostLink = async (): Promise<void> => {
    setHostLinkStatus("Checking platform.links.initial…");
    try {
      const payload = await props.experience.links.initial();
      const extracted = extractLinkUri(payload);
      if (!extracted) {
        setHostLinkStatus("Initial host link: none");
        return;
      }
      const res = props.onOpenDeepLink(extracted);
      setHostLinkStatus(`Applied initial link: ${extracted} (${res.kind})`);
    } catch (error) {
      const err = hostError(error);
      setHostLinkStatus(`${err.code}: ${err.message}`);
    }
  };

  const toggleLiveStream = (): void => {
    const existing = streamSub();
    if (existing) {
      existing.unsubscribe();
      setStreamSub(undefined);
      setHostLinkStatus("Live link stream stopped");
      return;
    }
    try {
      const sub = props.experience.subscribeLinks((payload) => {
        const extracted = extractLinkUri(payload);
        if (extracted) {
          const res = props.onOpenDeepLink(extracted);
          setHostLinkStatus(`Live event -> ${extracted} (${res.kind})`);
        }
      });
      setStreamSub(sub);
      setHostLinkStatus("Listening on platform.links.events");
    } catch (error) {
      const err = hostError(error);
      setHostLinkStatus(`${err.code}: ${err.message}`);
    }
  };

  const stackChain = () =>
    router
      .stack()
      .map((entry) => entry.pathname)
      .join(" -> ");

  const queryEntries = () => {
    const q = router.query();
    const keys = Object.keys(q);
    if (keys.length === 0) return "(clean URL — all values at defaults)";
    return keys
      .map((k) => {
        const v = q[k];
        const str = Array.isArray(v) ? v.join(",") : String(v ?? "");
        const clipped = str.length > 26 ? `${str.slice(0, 24)}…` : str;
        return `${k}=${clipped}`;
      })
      .join(" · ");
  };

  return (
    <ScrollablePage>
      <View class="flex-col gap-3.5 p-4 pb-12 w-full" style={{ minW: 0 }}>
        {/* Quick Skin Bar so Router Lab can also be viewed in Default / Looseleaf / Arc */}
        <SkinCard
          title="URL & State Deep-Link Studio"
          detail="Zero-DOM Radix matcher + typed query codecs + retained RouteView stack synthesis."
          variant="raised"
          badge={skin.skinId().toUpperCase()}
        >
          <SkinSegmentedControl
            accentActive
            items={[
              { id: "default", label: "Default UI" },
              { id: "looseleaf", label: "Looseleaf" },
              { id: "arc", label: "Arc" },
            ]}
            active={props.state().uiSkin}
            onChange={(id) =>
              props.dispatch({ type: "setUiSkin", value: id as ShowcaseSkin })
            }
          />
          <View class="flex-row gap-2.5 w-full" style={{ minW: 0 }}>
            <SkinMetric
              label="Stack Depth"
              value={String(router.stack().length)}
              detail={router.canGoBack() ? "Swipe/Back ready" : "Root"}
              tone="accent"
            />
            <SkinMetric
              label="Active Route"
              value={router.current().routeId}
              detail={router.pathname()}
              tone="success"
            />
          </View>
        </SkinCard>

        {/* Omnibox Card */}
        <SkinCard
          title="Live URI Omnibox"
          detail="Type any pocket:// or /path?query URI and dispatch with stack synthesis."
          badge="RFC 3986"
        >
          <SkinInput
            label="Target Deep-Link URI"
            hint="Zero-DOM parser"
            value={omnibox}
            placeholder="pocket://showcase/skins/controls?skin=arc"
            onInput={setOmnibox}
            onSubmit={(val) => executeUri(val, "deeplink")}
          />
          <View class="flex-row flex-wrap items-center gap-2 w-full">
            <SkinButton
              label="Go (Deep-Link)"
              variant="primary"
              compact
              onPress={() => executeUri(omnibox(), "deeplink")}
            />
            <SkinButton
              label="Replace URI"
              variant="secondary"
              compact
              onPress={() => executeUri(omnibox(), "replace")}
            />
            <SkinButton
              label="Pop Back"
              variant="outline"
              compact
              disabled={!router.canGoBack()}
              onPress={() => {
                props.dispatch({ type: "popRoute" });
              }}
            />
          </View>
          <SkinParagraph text={dispatchLog()} muted />
          <Show when={inspectorOpen()}>
            <View class="flex-col gap-1 pt-1 w-full" style={{ minW: 0 }}>
              <SkinParagraph text={`Stack: ${stackChain()}`} muted />
              <SkinParagraph text={`Query: ${queryEntries()}`} muted />
            </View>
          </Show>
        </SkinCard>

        {/* Two-Way useSearchState + Base64 Snapshot Lab */}
        <SkinCard
          title="Two-Way URL Signal & Snapshot Lab"
          detail="Mutating any control below rewrites ?filter=&step=&snap= in place (default values auto-strip)."
          badge="CODECS"
        >
          <SkinSegmentedControl
            items={[
              { id: "all", label: "All" },
              { id: "radix", label: "Radix" },
              { id: "codecs", label: "Codecs" },
              { id: "stack", label: "Stack" },
            ]}
            active={filter()}
            onChange={(id) => setFilter(id as (typeof FILTER_OPTIONS)[number])}
          />
          <SkinStepper
            label="URL-synced Step (?step=)"
            value={stepIndex()}
            min={1}
            max={9}
            step={1}
            onChange={(next) => setStepIndex(next)}
          />
          <SkinSwitch
            value={inspectorOpen()}
            onChange={(next) => setInspectorOpen(next)}
            label="Show parsed stack & query breakdown"
            detail="Bound to stateParam.boolean(true) -> ?inspect=0 when off"
          />
          <SkinListTile
            title={`Snapshot rev #${snapshot().rev} · ${snapshot().preset}`}
            detail={`Tags: ${snapshot().tags.join(", ")} (encoded via Base64URL ?snap=)`}
            trailing={<SkinBadge label="B64 JSON" tone="accent" />}
          />
          <View class="flex-row flex-wrap items-center gap-2 w-full">
            <SkinButton
              label="Bump Snapshot"
              variant="secondary"
              compact
              onPress={() =>
                setSnapshot((prev) => ({
                  preset: prev.preset === "radix-tree" ? "state-direct" : "radix-tree",
                  rev: prev.rev + 1,
                  tags: [...prev.tags.slice(-2), `v${prev.rev + 1}`],
                }))
              }
            />
            <SkinButton
              label="Reset URL Defaults"
              variant="outline"
              compact
              onPress={() => {
                setFilter("all");
                setStepIndex(1);
                setInspectorOpen(true);
                setSnapshot(DEFAULT_SNAPSHOT);
              }}
            />
          </View>
        </SkinCard>

        {/* One-Tap State Deep-Link Presets */}
        <SkinCard
          title="One-Tap State Deep-Link Presets"
          detail="Jump straight into target routes with pre-hydrated skin, tab, form, and modal state."
          badge="7 SCENARIOS"
        >
          <For each={DEEP_LINK_PRESETS}>
            {(preset) => (
              <View class="flex-col gap-1.5 py-1.5 w-full" style={{ minW: 0 }}>
                <SkinListTile
                  title={preset.title}
                  detail={preset.detail}
                  trailing={<SkinBadge label={preset.badge} tone="accent" />}
                />
                <SkinParagraph text={preset.uri} muted />
                <View class="flex-row flex-wrap items-center gap-2">
                  <SkinButton
                    label="Jump to State"
                    variant="primary"
                    compact
                    onPress={() => executeUri(preset.uri, "deeplink")}
                  />
                  <SkinButton
                    label="Load in Omnibox"
                    variant="outline"
                    compact
                    onPress={() => {
                      setOmnibox(preset.uri);
                      setDispatchLog(`Staged preset "${preset.id}" in Omnibox.`);
                    }}
                  />
                </View>
              </View>
            )}
          </For>
        </SkinCard>

        {/* Host Platform Links Bridge */}
        <SkinCard
          title="Host Deep-Link Bridge (PlatformExperience)"
          detail="Explicit opt-in binding to platform.links.initial and platform.links.events."
          badge="HOST BRIDGE"
        >
          <SkinAlert
            tone="info"
            title="Host Link Status"
            body={hostLinkStatus()}
          />
          <View class="flex-row flex-wrap items-center gap-2 w-full">
            <SkinButton
              label="Pull Initial Link"
              variant="secondary"
              compact
              onPress={() => void pullInitialHostLink()}
            />
            <SkinButton
              label={streamSub() ? "Stop Link Stream" : "Subscribe Link Events"}
              variant="outline"
              compact
              onPress={toggleLiveStream}
            />
          </View>
        </SkinCard>
      </View>
    </ScrollablePage>
  );
}
