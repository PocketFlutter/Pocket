/**
 * Unified Multi-Skin Live Studio (`Default UI` · `Looseleaf` · `Arc` · `Liquid Glass`)
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
  usePocketAppLifecycle,
  useRouteParams,
  useSearchState,
  useUiSkin,
  type NavigationItem,
  type UiSkinAccent,
  type UiSkinThemeMode,
} from "@pocket/ui";
import { looseleafSkinAdapter } from "@pocket/looseleaf";
import { arcSkinAdapter } from "@pocket/arc";
import { Text } from "@pocketjs/framework/solid/components";
import {
  LiquidGlassButton,
  LiquidGlassFpsHud,
  LiquidGlassGroup,
  LiquidGlassIconButton,
  LiquidGlassSlider,
  LiquidGlassSurface,
  LiquidGlassSwitch,
  liquidGlassSkinAdapter,
  useLiquidGlass,
  type LiquidGlassQualityTier,
} from "@pocket/liquid_glass";
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

function LiquidGlassStudioTelemetry(props: {
  quota: number;
  onQuotaChange: (next: number) => void;
  autoNight: boolean;
  onAutoNightChange: (next: boolean) => void;
}): JSX.Element {
  const lg = useLiquidGlass();
  const [lensPulse, setLensPulse] = createSignal(false);
  return (
    <SkinCard
      title="@pocket/liquid_glass >=60 FPS Optical Stage"
      detail="Live Snell bevel refraction, shared UIGlassContainerEffect toolbar & droplet controls."
      variant="raised"
      badge="60-120 FPS"
    >
      <LiquidGlassFpsHud active={() => true} />

      {/* High-contrast chromatic stage so Snell edge refraction & magnification are immediately visible */}
      <View
        class="relative w-full h-[142] overflow-hidden p-3 flex-col justify-between"
        style={{
          posType: 0,
          height: 142,
          overflow: 1,
          bgColor: lg.palette().dark ? "#101B33" : "#E6EEFF",
          radius: 18,
        }}
      >
        <View
          class="absolute left-[-20] top-[10] w-[190] h-[96]"
          style={{
            posType: 1,
            insetL: -20,
            insetT: 10,
            width: 190,
            height: 96,
            bgColor: "#007AFF",
            opacity: 0.92,
            radius: 48,
            rotate: -14,
            hitPass: 1,
          }}
        />
        <View
          class="absolute right-[-16] top-[8] w-[170] h-[94]"
          style={{
            posType: 1,
            insetR: -16,
            insetT: 8,
            width: 170,
            height: 94,
            bgColor: "#FF5E4D",
            opacity: 0.90,
            radius: 48,
            rotate: 15,
            hitPass: 1,
          }}
        />
        <View
          class="absolute left-[84] bottom-[-22] w-[200] h-[92]"
          style={{
            posType: 1,
            insetL: 84,
            insetB: -22,
            width: 200,
            height: 92,
            bgColor: "#28C864",
            opacity: 0.90,
            radius: 46,
            rotate: -6,
            hitPass: 1,
          }}
        />

        <View class="relative flex-row items-center justify-between gap-2 w-full">
          <LiquidGlassGroup material="clear" priority="high">
            <LiquidGlassIconButton glyph="✦" compact onPress={() => setLensPulse((v) => !v)} active={lensPulse()} />
            <LiquidGlassButton
              label="Shared Group"
              variant="glass"
              compact
              onPress={() => setLensPulse((v) => !v)}
            />
          </LiquidGlassGroup>
          <LiquidGlassButton
            label="Clear Pill"
            variant="glass"
            compact
            onPress={() => setLensPulse((v) => !v)}
          />
        </View>

        <LiquidGlassSurface
          material="clear"
          priority="high"
          shape="pill"
          radius={999}
          magnification={() => (lensPulse() ? 1.24 : 1.08)}
          class="relative w-full"
          contentClass="relative flex-row items-center justify-between px-4 py-2.5 w-full"
        >
          <Text class="text-xs font-bold" style={{ textColor: "#FFFFFF" }}>
            Snell Refraction Lens (1/1.520)
          </Text>
          <Text class="text-xs font-mono font-bold" style={{ textColor: "#FFFFFF" }}>
            {lensPulse() ? "MAG 1.24x" : "MAG 1.08x"}
          </Text>
        </LiquidGlassSurface>
      </View>

      <SkinSegmentedControl
        items={[
          { id: "ultra", label: "Ultra (16)" },
          { id: "balanced", label: "Bal (8)" },
          { id: "performance", label: "Perf (3)" },
          { id: "vector", label: "Vec (0)" },
        ]}
        active={lg.governor.tier()}
        onChange={(next) => lg.governor.setTier(next as LiquidGlassQualityTier)}
      />
      <LiquidGlassSlider
        label="Refractive droplet slider (drag for live lens)"
        value={props.quota}
        min={10}
        max={100}
        step={1}
        onChange={props.onQuotaChange}
      />
      <LiquidGlassSwitch
        value={props.autoNight}
        onChange={props.onAutoNightChange}
        label="Liquid Glass droplet switch"
        detail="Hold or drag for clear magnifying droplet lens."
      />
    </SkinCard>
  );
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
  const appLifecycle = usePocketAppLifecycle();
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
            detail="Switch between Default UI, Looseleaf, Arc, and Liquid Glass without losing input text, counters, or open panels."
            variant="raised"
            badge="4 SKINS"
          >
            <SkinSegmentedControl
              accentActive
              items={[
                { id: "default", label: "Default" },
                { id: "looseleaf", label: "Looseleaf" },
                { id: "arc", label: "Arc" },
                { id: "liquid-glass", label: "Glass" },
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

            <Show when={skin.skinId() === "liquid-glass"}>
              <LiquidGlassStudioTelemetry
                quota={quota()}
                onQuotaChange={(val) => setQuota(val)}
                autoNight={autoNight()}
                onAutoNightChange={(val) => setAutoNight(val)}
              />
            </Show>

            <SkinCard
              title="Shared Task & IME State"
              detail="Edit or toggle here, then flip Default / Looseleaf / Arc / Glass above."
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
                label="Unify Default, Looseleaf, Arc, and Liquid Glass behind one UiSkinKit contract"
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
              <SkinListTile
                title="Skin-Configurable Surface"
                detail={`Motion: ${skin.motion().routeTransition} (${skin.motion().routeTransitionDurationMs}ms) · Floating Bar: ${skin.adapter().floatingBottomBar ? "Yes" : "No"} · 23 Kit Slots`}
              />
              <SkinListTile
                title="Invariant @pocket/ui Kernel"
                detail={`Lifecycle: ${appLifecycle.state()} · Retained Routes · Active-Route Back Isolation · IME & SystemUI`}
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

        </View>
      </ScrollablePage>

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
        subtitle="Rendered by SkinSheet across Default Popup, Looseleaf Drawer, Arc BottomSheet, and LiquidGlassSheet."
        actions={[
          { id: "default", label: "Use Default UI", detail: "Option C / Shadcn system tokens" },
          { id: "looseleaf", label: "Use Looseleaf", detail: "Hand-drawn paper, ink & masking tape" },
          { id: "arc", label: "Use Arc", detail: "Concentric radii & calm physical springs" },
          { id: "liquid-glass", label: "Use Liquid Glass", detail: ">=60 FPS GPU-governed optical glass + vector fallback" },
        ]}
        onSelectAction={(id) => {
          props.dispatch({ type: "setUiSkin", value: id as ShowcaseSkin });
          setLastFeedback(`Selected ${id} from SkinSheet`);
        }}
        onClose={() => setSheetOpen(false)}
      />
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
      skins={[defaultSkinAdapter, looseleafSkinAdapter, arcSkinAdapter, liquidGlassSkinAdapter]}
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
