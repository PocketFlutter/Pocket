import { For, Show, createMemo, createSignal, type Accessor, type JSX } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import {
  MobileParagraph,
  ScrollablePage,
  useOptionalPocketRouter,
  useUiSkin,
  type DisplayGeometry,
} from "@pocket/ui";
import {
  EcosystemAdaptiveShell,
  LiveActivityBanner,
  LockAccessoryWidget,
  SurfaceEnvironmentProvider,
  TodayWidgetCard,
  WearTileSurface,
  WidgetActionLink,
  WidgetSurface,
  deriveSurfaceFormFactor,
  listSurfaceProfiles,
  resolveSurfacePalette,
  useSurfaceEnvironment,
  useWidgetSnapshots,
  type SurfaceEnvironment,
  type SurfaceRenderMode,
} from "@pocket/ui/surfaces";
import type { DemoEvent, DemoState, Route } from "./state.ts";

const PREVIEW_MODES: readonly { id: SurfaceRenderMode; label: string }[] = [
  { id: "fullColor", label: "Full Color" },
  { id: "accented", label: "Accented" },
  { id: "vibrant", label: "Vibrant" },
  { id: "alwaysOn", label: "Always-On" },
];

function skinLabelOf(state: DemoState): string {
  if (state.uiSkin === "looseleaf") return "Looseleaf";
  if (state.uiSkin === "arc") return "Arc Neon";
  return "Default";
}

/**
 * Projected automatically when Pocket runs inside an Apple or Android system
 * widget, Lock Screen accessory, Dynamic Island / Live Update, or Watch/Wear
 * tile surface — using the exact same compiled QJBC + PAK bundle as the app.
 */
export function ShowcaseSystemWidgetRoot(props: {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
}): JSX.Element {
  const env = useSurfaceEnvironment();
  const skin = useUiSkin();
  const router = useOptionalPocketRouter<Route>();
  const palette = createMemo(() =>
    resolveSurfacePalette(skin.tokens(), env().renderMode),
  );

  const openHref = (href: string, fallbackRoute: Route = "ecosystem") => {
    if (router) {
      router.openDeepLink(href, { synthesizeStack: true });
    } else {
      props.dispatch({ type: "navigate", route: fallbackRoute });
    }
  };

  return (
    <View
      class="w-full h-full flex-col justify-center items-stretch overflow-hidden"
      style={{ bgColor: "#00000000" }}
    >
      <Show
        when={(env().kind === "lock-accessory" && env().family !== "atAGlance") || env().kind === "complication"}
        fallback={
          <Show
            when={env().kind === "live-activity"}
            fallback={
              <Show
                when={env().kind === "tile" || env().family === "watchSmartStack"}
                fallback={
                  <Show
                    when={env().family === "atAGlance"}
                    fallback={
                      <TodayWidgetCard
                        eyebrow={env().ecosystem === "android" ? "POCKET GLANCE" : "POCKET TODAY"}
                        title={`${skinLabelOf(props.state())} · Single Engine`}
                        primaryValue={`${props.state().count}`}
                        subtitle={`Route /${props.state().route} · QJBC Native`}
                        badge="120Hz"
                        primaryHref="pocket://showcase/ecosystem?source=widget-card"
                        onAction={(href) => openHref(href, "ecosystem")}
                        metrics={[
                          {
                            id: "m-skin",
                            label: "Skin",
                            value: skinLabelOf(props.state()),
                            href: "pocket://showcase/skins?from=widget",
                          },
                          {
                            id: "m-stress",
                            label: "Nodes",
                            value: `${props.state().stressNodes}`,
                            href: "pocket://showcase/stress?from=widget",
                          },
                        ]}
                        actions={[
                          {
                            id: "act-skins",
                            label: "Skin Studio",
                            href: "pocket://showcase/skins?from=widget",
                          },
                          {
                            id: "act-stress",
                            label: "Stress FPS",
                            href: "pocket://showcase/stress?from=widget",
                          },
                        ]}
                      />
                    }
                  >
                    <WidgetSurface
                      class="w-full h-full flex-row items-center justify-between px-4 py-2"
                      style={{
                        bgColor: palette().surfaceBg,
                        borderColor: palette().border,
                        borderWidth: 1,
                        radius: env().cornerRadius,
                      }}
                    >
                      <WidgetActionLink
                        id="glance-main"
                        href="pocket://showcase/ecosystem?source=at-a-glance"
                        label="Open Pocket Ecosystem"
                        onPress={() => openHref("pocket://showcase/ecosystem?source=at-a-glance", "ecosystem")}
                        class="flex-1 flex-col gap-0.5 pr-2 overflow-hidden"
                      >
                        <Text
                          class="text-sm font-bold"
                          style={{ textColor: palette().primaryInk }}
                        >
                          {`Pocket · ${skinLabelOf(props.state())} Active`}
                        </Text>
                        <Text
                          class="text-xs"
                          style={{ textColor: palette().secondaryInk }}
                        >
                          {`QJBC Single-Engine · Count ${props.state().count} · Tap to open`}
                        </Text>
                      </WidgetActionLink>
                      <WidgetActionLink
                        id="glance-stress"
                        href="pocket://showcase/stress?source=glance"
                        label="Open Stress Lab"
                        onPress={() => openHref("pocket://showcase/stress?source=glance", "stress")}
                        class="px-3 py-1.5"
                        style={{
                          bgColor: palette().accentSoftBg,
                          borderColor: palette().border,
                          borderWidth: 1,
                          radius: 999,
                        }}
                      >
                        <Text class="text-xs font-bold" style={{ textColor: palette().accentInk }}>
                          120Hz ↗
                        </Text>
                      </WidgetActionLink>
                    </WidgetSurface>
                  </Show>
                }
              >
                <WearTileSurface
                  eyebrow={env().ecosystem === "android" ? "WEAR OS TILE" : "SMART STACK"}
                  metric={`${props.state().count}`}
                  unit={skinLabelOf(props.state())}
                  caption={`/${props.state().route} · Single QJBC`}
                  actionLabel="Open Stress"
                  href="pocket://showcase/stress?source=wear-tile"
                  onAction={(href) => openHref(href, "stress")}
                />
              </Show>
            }
          >
            <LiveActivityBanner
              leadingBadge="PKT"
              trailingMetric="120Hz"
              title={`Pocket · ${skinLabelOf(props.state())}`}
              subtitle={`Single-Engine QJBC · Route /${props.state().route}`}
              progress={0.84}
              primaryActionLabel="Ecosystem"
              primaryHref="pocket://showcase/ecosystem?from=live-activity"
              secondaryActionLabel="Stress FPS"
              secondaryHref="pocket://showcase/stress?from=live-activity"
              onAction={(href) =>
                openHref(href, href.includes("/stress") ? "stress" : "ecosystem")
              }
            />
          </Show>
        }
      >
        <LockAccessoryWidget
          glyph="⚡"
          shortValue={`${props.state().count}`}
          title="POCKET QJBC"
          detail={`${skinLabelOf(props.state())} · /${props.state().route}`}
          inlineText={`Pocket · ${skinLabelOf(props.state())} · 120Hz`}
          href="pocket://showcase/ecosystem?source=lock-widget"
          onAction={(href) => openHref(href, "ecosystem")}
        />
      </Show>
    </View>
  );
}

/**
 * Full-screen adaptive Showcase studio for inspecting Apple & Android
 * device form factors, foldable hinge split, and pixel-identical widget cards.
 */
export function EcosystemStudioPage(props: {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  geometry: Accessor<DisplayGeometry>;
}): JSX.Element {
  const skin = useUiSkin();
  const env = useSurfaceEnvironment();
  const widgetStore = useWidgetSnapshots();
  const router = useOptionalPocketRouter<Route>();

  const [previewMode, setPreviewMode] = createSignal<SurfaceRenderMode>("fullColor");
  const [selectedEcosystem, setSelectedEcosystem] = createSignal<"apple" | "android">("apple");

  const appleCount = listSurfaceProfiles({ ecosystem: "apple" }).length;
  const androidCount = listSurfaceProfiles({ ecosystem: "android" }).length;

  const formFactor = createMemo(() =>
    deriveSurfaceFormFactor(props.geometry(), env()),
  );

  const profiles = createMemo(() =>
    listSurfaceProfiles({ ecosystem: selectedEcosystem() }),
  );

  const hotspotCount = createMemo(() => widgetStore?.hotspots().length ?? 0);

  const inlineMediumWidgetEnv = createMemo<SurfaceEnvironment>(() => ({
    profileId: selectedEcosystem() === "apple" ? "ios-widget-medium" : "android-widget-medium",
    ecosystem: selectedEcosystem(),
    kind: "widget",
    family: selectedEcosystem() === "apple" ? "systemMedium" : "appWidgetMedium",
    renderMode: previewMode(),
    screenShape: "rect",
    inputModality: "touch",
    isSystemSurface: true,
    cornerRadius: 22,
    contentPadding: 14,
  }));

  const inlineLiveActivityEnv = createMemo<SurfaceEnvironment>(() => ({
    profileId: selectedEcosystem() === "apple" ? "ios-live-activity-expanded" : "android-live-update",
    ecosystem: selectedEcosystem(),
    kind: "live-activity",
    family: selectedEcosystem() === "apple" ? "dynamicIslandExpanded" : "liveUpdate",
    renderMode: previewMode(),
    screenShape: "capsule",
    inputModality: "touch",
    isSystemSurface: true,
    cornerRadius: 36,
    contentPadding: 14,
  }));

  const inlineLockEnv = createMemo<SurfaceEnvironment>(() => ({
    profileId: "ios-lock-rectangular",
    ecosystem: selectedEcosystem(),
    kind: "lock-accessory",
    family: "accessoryRectangular",
    renderMode: previewMode() === "fullColor" ? "vibrant" : previewMode(),
    screenShape: "rect",
    inputModality: "touch",
    isSystemSurface: true,
    cornerRadius: 14,
    contentPadding: 8,
  }));

  const inlineTileEnv = createMemo<SurfaceEnvironment>(() => ({
    profileId: selectedEcosystem() === "apple" ? "watchos-smart-stack" : "wear-os-tile",
    ecosystem: selectedEcosystem(),
    kind: "tile",
    family: selectedEcosystem() === "apple" ? "watchSmartStack" : "wearTile",
    renderMode: previewMode(),
    screenShape: selectedEcosystem() === "android" ? "round" : "rect",
    inputModality: "crown",
    isSystemSurface: true,
    cornerRadius: selectedEcosystem() === "android" ? 98 : 20,
    contentPadding: selectedEcosystem() === "android" ? 28 : 10,
  }));

  const triggerDeepLink = (href: string, fallback: Route) => {
    if (router) {
      router.openDeepLink(href, { synthesizeStack: true });
    } else {
      props.dispatch({ type: "navigate", route: fallback });
    }
  };

  const primaryPane = () => (
    <ScrollablePage>
      <View class="flex-col gap-3 p-4 pb-8">
        <View
          class="flex-col gap-2 p-3.5"
          style={{
            bgColor: skin.tokens().surfaceBg,
            borderColor: skin.tokens().border,
            borderWidth: 1,
            radius: skin.tokens().radiusSurface,
          }}
        >
          <View class="flex-row items-center justify-between">
            <Text class="text-xs font-bold" style={{ textColor: skin.tokens().accentBg }}>
              SINGLE-ENGINE PIXEL IDENTITY
            </Text>
            <View
              class="px-2 py-0.5"
              style={{
                bgColor: skin.tokens().surfaceMutedBg,
                borderColor: skin.tokens().border,
                borderWidth: 1,
                radius: 999,
              }}
            >
              <Text class="text-xs font-bold" style={{ textColor: skin.tokens().ink }}>
                {`${env().ecosystem.toUpperCase()} · ${formFactor()}`}
              </Text>
            </View>
          </View>
          <MobileParagraph
            text="Apple & Android Ecosystem + Widgets"
            class="text-base font-bold"
            style={{ textColor: skin.tokens().ink }}
          />
          <MobileParagraph
            text={`Active profile: ${env().profileId} (${props.geometry().width}×${props.geometry().height}) · SafeArea T${props.geometry().safeArea.top}/B${props.geometry().safeArea.bottom} · Regions ${props.geometry().reservedRegions.length} · Hotspots ${hotspotCount()}`}
            class="text-xs"
            style={{ textColor: skin.tokens().inkSecondary }}
          />
          <View class="flex-row flex-wrap gap-2 pt-1">
            <Focusable
              onPress={() => setSelectedEcosystem("apple")}
              class="px-3 py-1.5"
              style={{
                bgColor: selectedEcosystem() === "apple" ? skin.tokens().accentBg : skin.tokens().surfaceMutedBg,
                borderColor: skin.tokens().border,
                borderWidth: 1,
                radius: 999,
              }}
            >
              <Text
                class="text-xs font-bold"
                style={{ textColor: selectedEcosystem() === "apple" ? skin.tokens().accentFg : skin.tokens().ink }}
              >
                {`Apple Family (${appleCount})`}
              </Text>
            </Focusable>
            <Focusable
              onPress={() => setSelectedEcosystem("android")}
              class="px-3 py-1.5"
              style={{
                bgColor: selectedEcosystem() === "android" ? skin.tokens().accentBg : skin.tokens().surfaceMutedBg,
                borderColor: skin.tokens().border,
                borderWidth: 1,
                radius: 999,
              }}
            >
              <Text
                class="text-xs font-bold"
                style={{ textColor: selectedEcosystem() === "android" ? skin.tokens().accentFg : skin.tokens().ink }}
              >
                {`Android Family (${androidCount})`}
              </Text>
            </Focusable>
          </View>
        </View>

        <View
          class="flex-col gap-2 p-3.5"
          style={{
            bgColor: skin.tokens().surfaceBg,
            borderColor: skin.tokens().border,
            borderWidth: 1,
            radius: skin.tokens().radiusSurface,
          }}
        >
          <MobileParagraph
            text="Widget Render Mode Tint Matrix"
            class="text-sm font-bold"
            style={{ textColor: skin.tokens().ink }}
          />
          <MobileParagraph
            text="Switch between Full Color, iOS 18 Accented / Material You, Lock Screen Vibrant, and Watch/Wear Always-On."
            class="text-xs"
            style={{ textColor: skin.tokens().inkSecondary }}
          />
          <View class="flex-row flex-wrap gap-1.5 pt-1">
            <For each={PREVIEW_MODES}>
              {(mode) => (
                <Focusable
                  onPress={() => setPreviewMode(mode.id)}
                  class="px-2.5 py-1.5"
                  style={{
                    bgColor: previewMode() === mode.id ? skin.tokens().accentBg : skin.tokens().surfaceMutedBg,
                    borderColor: skin.tokens().border,
                    borderWidth: 1,
                    radius: 999,
                  }}
                >
                  <Text
                    class="text-xs font-bold"
                    style={{ textColor: previewMode() === mode.id ? skin.tokens().accentFg : skin.tokens().ink }}
                  >
                    {mode.label}
                  </Text>
                </Focusable>
              )}
            </For>
          </View>
        </View>

        <View class="flex-col gap-1.5">
          <Text class="text-xs font-bold" style={{ textColor: skin.tokens().inkMuted }}>
            LIVE TODAY / WIDGETKIT & GLANCE APPWIDGET
          </Text>
          <View class="w-full h-[170]">
            <SurfaceEnvironmentProvider value={inlineMediumWidgetEnv}>
              <TodayWidgetCard
                eyebrow={selectedEcosystem() === "apple" ? "POCKET TODAY" : "POCKET GLANCE"}
                title={`${skinLabelOf(props.state())} · Live Telemetry`}
                primaryValue={`${props.state().count}`}
                subtitle="100% pixel-identical QuickJS + pocket_core DrawOps"
                badge={previewMode()}
                renderMode={previewMode()}
                primaryHref="pocket://showcase/skins?from=inline-today"
                onAction={(href) =>
                  triggerDeepLink(href, href.includes("/stress") ? "stress" : "skins")
                }
                metrics={[
                  { id: "m1", label: "Skin", value: skinLabelOf(props.state()) },
                  { id: "m2", label: "Hotspots", value: `${hotspotCount()}` },
                ]}
                actions={[
                  {
                    id: "inline-skins",
                    label: "Skin Studio",
                    href: "pocket://showcase/skins?from=today",
                  },
                  {
                    id: "inline-stress",
                    label: "Stress Lab",
                    href: "pocket://showcase/stress?from=today",
                  },
                ]}
              />
            </SurfaceEnvironmentProvider>
          </View>
        </View>

        <View class="flex-col gap-1.5">
          <Text class="text-xs font-bold" style={{ textColor: skin.tokens().inkMuted }}>
            DYNAMIC ISLAND LIVE ACTIVITY & ANDROID 16 LIVE UPDATE
          </Text>
          <View class="w-full h-[160]">
            <SurfaceEnvironmentProvider value={inlineLiveActivityEnv}>
              <LiveActivityBanner
                leadingBadge="LIVE"
                trailingMetric="120Hz"
                title="Pocket Build & OTA Sync"
                subtitle="Shared QJBC + PAK across Host & Extensions"
                progress={0.92}
                primaryActionLabel="Router Lab"
                primaryHref="pocket://showcase/router?from=live-activity"
                secondaryActionLabel="+1 State"
                secondaryHref="pocket://showcase/ecosystem?bump=1"
                onAction={(href) => {
                  if (href.includes("bump=1")) {
                    props.dispatch({ type: "increment" });
                    return;
                  }
                  triggerDeepLink(href, "router");
                }}
              />
            </SurfaceEnvironmentProvider>
          </View>
        </View>
      </View>
    </ScrollablePage>
  );

  const secondaryPane = () => (
    <ScrollablePage>
      <View class="flex-col gap-3 p-4 pb-8">
        <View class="flex-row flex-wrap gap-3 items-center">
          <View class="flex-col gap-1.5">
            <Text class="text-xs font-bold" style={{ textColor: skin.tokens().inkMuted }}>
              LOCK ACCESSORY
            </Text>
            <View class="w-[172] h-[76]">
              <SurfaceEnvironmentProvider value={inlineLockEnv}>
                <LockAccessoryWidget
                  glyph="⚡"
                  shortValue={`${props.state().count}`}
                  title="LOCK WIDGET"
                  detail={`${skinLabelOf(props.state())} · Ready`}
                  href="pocket://showcase/stress?from=lock"
                  renderMode={previewMode() === "fullColor" ? "vibrant" : previewMode()}
                  onAction={(href) => triggerDeepLink(href, "stress")}
                />
              </SurfaceEnvironmentProvider>
            </View>
          </View>

          <View class="flex-col gap-1.5">
            <Text class="text-xs font-bold" style={{ textColor: skin.tokens().inkMuted }}>
              WATCH / WEAR TILE
            </Text>
            <View class="w-[196] h-[196]">
              <SurfaceEnvironmentProvider value={inlineTileEnv}>
                <WearTileSurface
                  eyebrow={selectedEcosystem() === "apple" ? "SMART STACK" : "WEAR TILE"}
                  metric={`${props.state().count}`}
                  unit={skinLabelOf(props.state())}
                  caption="Inscribed safe inset"
                  actionLabel="Stress FPS"
                  href="pocket://showcase/stress?from=tile"
                  onAction={(href) => triggerDeepLink(href, "stress")}
                />
              </SurfaceEnvironmentProvider>
            </View>
          </View>
        </View>

        <View
          class="flex-col gap-2 p-3.5"
          style={{
            bgColor: skin.tokens().surfaceBg,
            borderColor: skin.tokens().border,
            borderWidth: 1,
            radius: skin.tokens().radiusSurface,
          }}
        >
          <Text class="text-sm font-bold" style={{ textColor: skin.tokens().ink }}>
            {`${selectedEcosystem() === "apple" ? "Apple" : "Android"} Catalog (${profiles().length} Surfaces)`}
          </Text>
          <For each={profiles()}>
            {(item) => (
              <View
                class="flex-row items-center justify-between py-1.5 px-2"
                style={{
                  bgColor: env().profileId === item.id ? skin.tokens().surfaceMutedBg : "#00000000",
                  radius: 8,
                }}
              >
                <View class="flex-col flex-1 pr-2 overflow-hidden" style={{ minW: 0 }}>
                  <MobileParagraph
                    text={item.label}
                    class="text-xs font-bold"
                    style={{ textColor: skin.tokens().ink }}
                    fallbackInsetPx={128}
                  />
                  <MobileParagraph
                    text={`${item.kind} · ${item.family} · ${item.defaultRenderMode}`}
                    class="text-xs"
                    style={{ textColor: skin.tokens().inkSecondary }}
                    fallbackInsetPx={128}
                  />
                </View>
                <Text class="text-xs font-bold" style={{ textColor: skin.tokens().accentBg }}>
                  {`${item.width}×${item.height}`}
                </Text>
              </View>
            )}
          </For>
        </View>
      </View>
    </ScrollablePage>
  );

  return (
    <EcosystemAdaptiveShell
      geometry={props.geometry}
      environment={env}
      renderWatch={() => (
        <ScrollablePage>
          <View class="flex-col gap-2 p-3 items-center">
            <Text class="text-xs font-bold" style={{ textColor: skin.tokens().accentBg }}>
              {`${env().ecosystem.toUpperCase()} WATCH`}
            </Text>
            <Text class="text-sm font-bold" style={{ textColor: skin.tokens().ink }}>
              {`Count ${props.state().count}`}
            </Text>
            <Focusable
              onPress={() => props.dispatch({ type: "increment" })}
              class="px-3 py-1.5"
              style={{ bgColor: skin.tokens().accentBg, radius: 999 }}
            >
              <Text class="text-xs font-bold" style={{ textColor: skin.tokens().accentFg }}>
                +1 Sync State
              </Text>
            </Focusable>
          </View>
        </ScrollablePage>
      )}
      primaryPane={primaryPane}
      secondaryPane={secondaryPane}
    />
  );
}
