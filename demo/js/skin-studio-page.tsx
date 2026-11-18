/**
 * Unified Multi-Skin Live Studio (`Default UI` · `Looseleaf` · `Arc`)
 * with full URL + State Deep-Linking (`@pocket/ui/router`).
 *
 * Every tab (`/skins/:tab?`), active skin (`skin`), palette mode (`mode`),
 * accent (`studioAccent`), frame budget (`quota`), milestone draft (`note`),
 * and open overlay (`dialog` / `sheet` / `toast`) syncs two-way with the
 * live Pocket router URL without unmounting or losing state.
 */

import { Show, createEffect, createSignal, type JSX } from "solid-js";
import { View } from "@pocketjs/framework/solid/components";
import {
  ScrollablePage,
  SkinAccordion,
  SkinAlert,
  SkinAppBar,
  SkinBadge,
  SkinButton,
  SkinCard,
  SkinCheckbox,
  SkinDialog,
  SkinEmptyState,
  SkinInput,
  SkinListTile,
  SkinMetric,
  SkinNavigationBar,
  SkinParagraph,
  SkinProgress,
  SkinRadioGroup,
  SkinScaffold,
  SkinSegmentedControl,
  SkinSheet,
  SkinStepper,
  SkinSwitch,
  SkinToast,
  UiSkinProvider,
  defaultSkinAdapter,
  stateParam,
  useOptionalPocketRouter,
  useRouteParams,
  useSearchState,
  useUiSkin,
  type NavigationItem,
  type UiSkinAccent,
  type UiSkinThemeMode,
} from "@pocket/ui";
import { looseleafSkinAdapter } from "@pocket/looseleaf";
import { arcSkinAdapter } from "@pocket/arc";
import type { DemoEvent, DemoState, ShowcaseSkin } from "./state.ts";

type StudioTab = "workspace" | "controls" | "overlays";

const STUDIO_TAB_VALUES = ["workspace", "controls", "overlays"] as const;
const URL_MODE_VALUES = ["auto", "light", "dark", "amber-night"] as const;
const ACCENT_VALUES = ["blue", "coral", "violet", "green"] as const;
const PRIORITY_VALUES = ["calm", "snappy"] as const;

const STUDIO_TABS: readonly NavigationItem[] = [
  { id: "workspace", label: "Workspace", kind: "home" },
  { id: "controls", label: "Controls", kind: "gallery" },
  { id: "overlays", label: "Overlays", kind: "settings" },
];

function isStudioTab(value: string | undefined): value is StudioTab {
  return value === "workspace" || value === "controls" || value === "overlays";
}

function SkinStudioContent(props: {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  localMode: () => UiSkinThemeMode;
  onChangeMode: (next: UiSkinThemeMode) => void;
  localAccent: () => UiSkinAccent;
  onChangeAccent: (next: UiSkinAccent) => void;
}): JSX.Element {
  const skin = useUiSkin();
  const router = useOptionalPocketRouter();
  const routeParams = useRouteParams<{ tab?: string }>({ routeId: "skins" });
  const [fallbackTab, setFallbackTab] = useSearchState(
    "tab",
    stateParam.enum(STUDIO_TAB_VALUES, "workspace"),
    { routeId: "skins" },
  );
  const tab = (): StudioTab => {
    const paramTab = routeParams().tab;
    return isStudioTab(paramTab) ? paramTab : fallbackTab();
  };
  const selectTab = (nextId: string): void => {
    const next: StudioTab = isStudioTab(nextId) ? nextId : "workspace";
    if (router && router.current().routeId === "skins") {
      const targetPath = next === "workspace" ? "/skins" : `/skins/${next}`;
      router.replace(targetPath, {
        search: (prev) => ({ ...prev, tab: null }),
        preserveRetainedParams: true,
      });
    } else {
      setFallbackTab(next);
    }
  };

  const [noteTitle, setNoteTitle] = useSearchState(
    "note",
    stateParam.string("Release v0.2 multi-skin contract"),
    { routeId: "skins" },
  );
  const [shipped, setShipped] = useSearchState(
    "shipped",
    stateParam.boolean(true),
    { routeId: "skins" },
  );
  const [strictClasses, setStrictClasses] = useSearchState(
    "strict",
    stateParam.boolean(true),
    { routeId: "skins" },
  );
  const [autoNight, setAutoNight] = useSearchState(
    "night",
    stateParam.boolean(true),
    { routeId: "skins" },
  );
  const [priority, setPriority] = useSearchState(
    "priority",
    stateParam.enum(PRIORITY_VALUES, "calm"),
    { routeId: "skins" },
  );
  const [quota, setQuota] = useSearchState(
    "quota",
    stateParam.int(72, { min: 10, max: 100 }),
    { routeId: "skins" },
  );
  const [accordionOpen, setAccordionOpen] = createSignal(true);
  const [toastOpen, setToastOpen] = useSearchState(
    "toast",
    stateParam.boolean(false),
    { routeId: "skins" },
  );
  const [dialogOpen, setDialogOpen] = useSearchState(
    "dialog",
    stateParam.boolean(false),
    { routeId: "skins" },
  );
  const [sheetOpen, setSheetOpen] = useSearchState(
    "sheet",
    stateParam.boolean(false),
    { routeId: "skins" },
  );
  const [lastFeedback, setLastFeedback] = createSignal(
    "Ready — switch skins above and verify all signals + URL state persist.",
  );

  const completedCount = () => (shipped() ? 1 : 0) + (strictClasses() ? 1 : 0);
  const liveUri = () =>
    router && router.current().routeId === "skins"
      ? router.uri()
      : `pocket://showcase/skins${tab() === "workspace" ? "" : `/${tab()}`}`;

  return (
    <SkinScaffold
      edges={["bottom"]}
      bottomBar={
        <SkinNavigationBar
          route={tab()}
          items={STUDIO_TABS}
          onNavigate={selectTab}
        />
      }
    >
      <ScrollablePage>
        <View class="flex-col gap-3.5 p-4 pb-24 w-full" style={{ minW: 0 }}>
          <SkinAppBar
            title="Unified Skin Studio"
            subtitle={`${skin.adapter().label} · ${skin.tokens().mode}`}
            trailing={<SkinBadge label={skin.skinId().toUpperCase()} tone="accent" />}
          />

          <SkinCard
            title="Live State URI"
            detail={liveUri()}
            badge="URL SYNC"
          >
            <View class="flex-row flex-wrap items-center gap-2 w-full">
              <SkinButton
                label="Open URL Router Lab"
                variant="secondary"
                compact
                onPress={() => props.dispatch({ type: "navigate", route: "router" })}
              />
            </View>
          </SkinCard>

          <SkinCard
            title="Live Skin & Palette Switcher"
            detail="Switch between Default UI, Looseleaf, and Arc without losing input text, counters, or open panels."
            variant="raised"
            badge="3 SKINS"
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
            <SkinSegmentedControl
              items={[
                { id: "light", label: "Light" },
                { id: "dark", label: "Dark" },
                { id: "amber-night", label: "0% Blue Night" },
              ]}
              active={props.localMode()}
              onChange={(id) => {
                const next = id as UiSkinThemeMode;
                props.onChangeMode(next);
                props.dispatch({ type: "setMobileDark", value: next !== "light" });
              }}
            />
            <SkinSegmentedControl
              items={[
                { id: "blue", label: "Blue" },
                { id: "coral", label: "Coral" },
                { id: "violet", label: "Violet" },
                { id: "green", label: "Green" },
              ]}
              active={props.localAccent()}
              onChange={(id) => props.onChangeAccent(id as UiSkinAccent)}
            />
          </SkinCard>

          <Show when={tab() === "workspace"}>
            <View class="flex-row gap-2.5 w-full" style={{ minW: 0 }}>
              <SkinMetric
                label="Checklist"
                value={`${completedCount()}/2`}
                detail="Shared reactive state"
                tone="accent"
              />
              <SkinMetric
                label="Frame Budget"
                value={`${quota()}%`}
                detail={`Radius ${skin.tokens().radiusSurface}px`}
                tone="success"
              />
            </View>

            <SkinCard
              title="Shared Task & IME State"
              detail="Edit or toggle here, then flip Default / Looseleaf / Arc above."
            >
              <SkinInput
                label="Milestone title"
                hint="Native IME"
                value={noteTitle}
                placeholder="Type across skins..."
                onInput={(val) => setNoteTitle(val)}
                onSubmit={(val) => setNoteTitle(val)}
              />
              <SkinParagraph
                text={`Live value: ${noteTitle() || "(empty)"}`}
                muted
              />
              <SkinCheckbox
                checked={shipped()}
                onChange={(val) => setShipped(val)}
                label="Unify Default, Looseleaf, and Arc behind one UiSkinKit contract"
              />
              <SkinCheckbox
                checked={strictClasses()}
                onChange={(val) => setStrictClasses(val)}
                label="Verify --strict-classes and host-native CoreText line wrapping"
              />
              <SkinProgress
                value={quota() / 100}
                label="Bundle & glyph budget utilization"
                tone="success"
              />
            </SkinCard>

            <SkinCard title="Skin Adapter Registry" detail="Active adapter metadata resolved from @pocket/ui/skins.">
              <SkinListTile
                title={skin.adapter().label}
                detail={skin.adapter().description}
                trailing={<SkinBadge label="ACTIVE" tone="success" />}
              />
              <SkinAccordion
                title="Token & behavior inheritance"
                detail="Focus, IME, safe-area and line-wrap stay unified"
                badge="Contract"
                expanded={accordionOpen()}
                onToggle={() => setAccordionOpen((v) => !v)}
              >
                <SkinParagraph
                  text={`Canvas ${skin.tokens().canvasBg} · Surface ${skin.tokens().surfaceBg} · Accent ${skin.tokens().accentBg}. Every skin reuses SafeAreaScaffold, Focusable, InputField, and MobileParagraph.`}
                  muted
                />
              </SkinAccordion>
            </SkinCard>
          </Show>

          <Show when={tab() === "controls"}>
            <SkinCard
              title="Buttons & Semantic Badges"
              detail="Identical variant props render each skin's native visual grammar."
            >
              <View class="flex-row flex-wrap items-center gap-2 w-full">
                <SkinButton
                  label="Primary"
                  variant="primary"
                  onPress={() => setLastFeedback("Pressed Primary button")}
                />
                <SkinButton
                  label="Secondary"
                  variant="secondary"
                  onPress={() => setLastFeedback("Pressed Secondary button")}
                />
                <SkinButton
                  label="Outline"
                  variant="outline"
                  onPress={() => setLastFeedback("Pressed Outline button")}
                />
                <SkinButton
                  label="Danger"
                  variant="danger"
                  onPress={() => setLastFeedback("Pressed Danger button")}
                />
              </View>
              <View class="flex-row flex-wrap items-center gap-2 w-full">
                <SkinBadge label="ACCENT" tone="accent" />
                <SkinBadge label="SUCCESS" tone="success" />
                <SkinBadge label="WARNING" tone="warning" />
                <SkinBadge label="DANGER" tone="danger" />
                <SkinBadge label="OUTLINE" tone="outline" />
              </View>
              <SkinParagraph text={lastFeedback()} muted />
            </SkinCard>

            <SkinCard title="Switches, Radios & Stepper" detail="Spring and tactile state controls.">
              <SkinSwitch
                value={autoNight()}
                onChange={(val) => setAutoNight(val)}
                label="Zero-blue-light night schedule"
                detail="Automatically switches into #RRGG00 amber OLED palette after 21:00."
              />
              <SkinStepper
                label="Target frame utilization (%)"
                value={quota()}
                min={10}
                max={100}
                step={5}
                onChange={(val) => setQuota(val)}
              />
              <SkinRadioGroup
                value={priority()}
                onChange={(val) => setPriority(val as "calm" | "snappy")}
                items={[
                  { id: "calm", label: "Calm spring motion", detail: "Critically damped transitions" },
                  { id: "snappy", label: "Snappy tactile response", detail: "Immediate press settle" },
                ]}
              />
            </SkinCard>
          </Show>

          <Show when={tab() === "overlays"}>
            <SkinAlert
              tone="info"
              title="Unified Overlay Contract"
              body="Alerts, Toasts, Modal Dialogs, and Bottom Action Sheets adapt automatically to the active skin."
              actionLabel="Trigger Toast"
              onAction={() => setToastOpen(true)}
            />

            <SkinCard title="Dialogs, Sheets & Empty States" detail="Test modal focus scopes and action sheets in each skin.">
              <View class="flex-row flex-wrap items-center gap-2 w-full">
                <SkinButton
                  label="Open Dialog"
                  variant="primary"
                  onPress={() => setDialogOpen(true)}
                />
                <SkinButton
                  label="Open Action Sheet"
                  variant="outline"
                  onPress={() => setSheetOpen(true)}
                />
                <SkinButton
                  label={toastOpen() ? "Hide Toast" : "Show Toast"}
                  variant="secondary"
                  onPress={() => setToastOpen((v) => !v)}
                />
              </View>
              <SkinParagraph text={lastFeedback()} muted />
              <SkinEmptyState
                title="No custom skin overrides queued"
                detail="Register additional brand skins via registerUiSkin(adapter) without changing page code."
                actionLabel="Reset Quota to 80%"
                onAction={() => {
                  setQuota(80);
                  setLastFeedback("Reset quota to 80% from EmptyState action");
                }}
              />
            </SkinCard>
          </Show>

          <SkinToast
            open={toastOpen()}
            tone="success"
            title={`${skin.adapter().label} Toast`}
            body="Skin-aware notification rendered without remounting."
            onDismiss={() => setToastOpen(false)}
          />

          <SkinDialog
            open={dialogOpen()}
            title={`Confirm in ${skin.adapter().label}?`}
            body="Modal focus scope, backdrop dismissal, and button grammar are inherited from the active UiSkinAdapter."
            confirmLabel="Confirm"
            cancelLabel="Cancel"
            onConfirm={() => {
              setLastFeedback(`Confirmed dialog in ${skin.adapter().label}`);
              setDialogOpen(false);
            }}
            onClose={() => setDialogOpen(false)}
          />

          <SkinSheet
            open={sheetOpen()}
            title="Switch Workspace Preset"
            subtitle="Rendered by SkinSheet across Default Popup, Looseleaf Drawer, and Arc BottomSheet."
            actions={[
              { id: "default", label: "Use Default UI", detail: "Option C / Shadcn system tokens" },
              { id: "looseleaf", label: "Use Looseleaf", detail: "Hand-drawn paper, ink & masking tape" },
              { id: "arc", label: "Use Arc", detail: "Concentric radii & calm physical springs" },
            ]}
            onSelectAction={(id) => {
              props.dispatch({ type: "setUiSkin", value: id as ShowcaseSkin });
              setLastFeedback(`Selected ${id} from SkinSheet`);
            }}
            onClose={() => setSheetOpen(false)}
          />
        </View>
      </ScrollablePage>
    </SkinScaffold>
  );
}

function toSkinAccent(accent: DemoState["accentColor"]): UiSkinAccent {
  if (accent === "violet") return "violet";
  if (accent === "teal") return "green";
  if (accent === "rose") return "coral";
  return "blue";
}

export function SkinStudioPage(props: {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
}): JSX.Element {
  const [urlMode, setUrlMode] = useSearchState(
    "mode",
    stateParam.enum(URL_MODE_VALUES, "auto"),
    { routeId: "skins" },
  );
  const effectiveMode = (): UiSkinThemeMode => {
    const current = urlMode();
    if (current === "light" || current === "dark" || current === "amber-night") {
      return current;
    }
    return props.state().mobileDark ? "dark" : "light";
  };
  const applyStudioMode = (next: UiSkinThemeMode): void => {
    setUrlMode(next);
    const shouldBeDark = next !== "light";
    if (props.state().mobileDark !== shouldBeDark) {
      props.dispatch({ type: "setMobileDark", value: shouldBeDark });
    }
  };
  const [urlAccent, setUrlAccent] = useSearchState(
    "studioAccent",
    stateParam.enum(ACCENT_VALUES, toSkinAccent(props.state().accentColor)),
    { routeId: "skins" },
  );

  // Keep global dark theme synced when deep-linking into explicit `mode=amber-night` or `mode=dark`
  createEffect(() => {
    const raw = urlMode();
    if (props.state().route === "skins" && raw !== "auto") {
      const shouldBeDark = raw !== "light";
      if (props.state().mobileDark !== shouldBeDark) {
        props.dispatch({ type: "setMobileDark", value: shouldBeDark });
      }
    }
  });

  return (
    <UiSkinProvider
      skin={() => props.state().uiSkin}
      mode={effectiveMode}
      accent={urlAccent}
      density={() => props.state().interfaceDensity}
      skins={[defaultSkinAdapter, looseleafSkinAdapter, arcSkinAdapter]}
      onSkinChange={(next) =>
        props.dispatch({ type: "setUiSkin", value: next as ShowcaseSkin })
      }
      onModeChange={applyStudioMode}
      onAccentChange={(next) => setUrlAccent(next)}
    >
      <SkinStudioContent
        state={props.state}
        dispatch={props.dispatch}
        localMode={effectiveMode}
        onChangeMode={applyStudioMode}
        localAccent={urlAccent}
        onChangeAccent={(next) => setUrlAccent(next)}
      />
    </UiSkinProvider>
  );
}
