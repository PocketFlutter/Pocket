/**
 * 1:1 Replica of iOS 26 UIKit Gallery (`GalleryListViewController` + 21 Component Scenes)
 * powered by `@pocket/liquid_glass`.
 *
 * Reproduces:
 * - Full-bleed status bar (`9:41 Tue Jun 9`), `GalleryWallpaperView` 8 real bundled iPadOS
 *   wallpapers (`iPadOS Waves`, `Circles Blue`, `Circles Pink`, `iPad mini`, `Plain`), and
 *   adaptive `HomeGrabberView` (`Auto-Hide Home Indicator`).
 * - Top `UIKit Gallery` navigation bar with `ScrollEdgeEffect` fading glass platter and
 *   morphing `Options` pull-down `LiquidGlassMenuButton` (with inline `Wallpaper` submenu).
 * - All 5 catalog sections and all 21 interactive UIKit component detail pages.
 * - Persistent app-wide `SiriSideButtonOverlay` (`IntelligentLight` + `EdgeLightMask`) that
 *   continues glowing around the screen perimeter while browsing other pages.
 */

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  useContext,
  type JSX,
} from "solid-js";
import {
  Focusable,
  Image,
  Text,
  View,
} from "@pocketjs/framework/solid/components";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import {
  MobileParagraph,
  ScrollablePage,
  ScrollablePageContext,
  useAccessibilityPreferences,
  useRouteParams,
  useRouteActive,
  useSearchState,
  stateParam,
  type DisplayGeometry,
} from "@pocket/ui";
import {
  createGlassSpring,
  LiquidGlassActivityIndicator,
  LiquidGlassAlertModal,
  LiquidGlassBadge,
  LiquidGlassButton,
  LiquidGlassCard,
  LiquidGlassContextMenu,
  LiquidGlassFlexSurface,
  LiquidGlassFpsHud,
  LiquidGlassGroup,
  LiquidGlassListTile,
  LiquidGlassMenuButton,
  LiquidGlassNavigationBar,
  LiquidGlassPageControl,
  LiquidGlassPopover,
  LiquidGlassProgress,
  LiquidGlassProvider,
  LiquidGlassSegmentedControl,
  LiquidGlassSlider,
  LiquidGlassStepper,
  LiquidGlassSurface,
  LiquidGlassSwitch,
  type LiquidGlassAlertAction,
  type LiquidGlassMenuEntry,
  type LiquidGlassMaterial,
} from "@pocket/liquid_glass";

// Critically damped springs fitted to uikit.even.how frame captures (omega = sqrt(stiffness / mass)).
/** Push/pop: omega = 22 rad/s, settles in ~430 ms. */
const PAGE_PUSH_SPRING = { stiffness: 484, damping: 44, mass: 1, precision: 0.001 };
/** Large-title collapse and bar backdrop: omega = 16 rad/s, ~450 ms. */
const BAR_COLLAPSE_SPRING = { stiffness: 256, damping: 32, mass: 1, precision: 0.002 };
import type { DemoEvent, DemoState } from "./state.ts";

export type GalleryWallpaperId =
  | "waves"
  | "circles-blue"
  | "circles-pink"
  | "mini-purple"
  | "plain";

export type GalleryComponentSlug =
  | "tab-bar"
  | "navigation"
  | "alert"
  | "button"
  | "segmented-control"
  | "switch"
  | "slider"
  | "stepper"
  | "page-control"
  | "liquid-lens"
  | "visual-effect"
  | "control-and-flex"
  | "siri"
  | "pointer"
  | "text"
  | "image-view"
  | "progress-view"
  | "activity-indicator"
  | "view"
  | "scroll-view"
  | "collection-view";

export interface GalleryRowMeta {
  readonly slug: GalleryComponentSlug;
  readonly title: string;
  readonly subtitle: string;
  readonly glyph: string;
  readonly tint: string;
}

export interface GallerySectionMeta {
  readonly title: string;
  readonly rows: readonly GalleryRowMeta[];
}

export const UIKIT_GALLERY_SECTIONS: readonly GallerySectionMeta[] = [
  {
    title: "Bars & Presentation",
    rows: [
      {
        slug: "tab-bar",
        title: "Tab Bar",
        subtitle: "Floating Liquid Glass lens & wallpaper switcher",
        glyph: "▣",
        tint: "#007AFF",
      },
      {
        slug: "navigation",
        title: "Navigation",
        subtitle: "ScrollEdgeEffect glass & pull-down bar menus",
        glyph: "◧",
        tint: "#5856D6",
      },
      {
        slug: "alert",
        title: "Alert",
        subtitle: "Alert glass group & continuous action scrubbing",
        glyph: "!",
        tint: "#FF9500",
      },
    ],
  },
  {
    title: "Controls",
    rows: [
      {
        slug: "button",
        title: "Button",
        subtitle: "Configurations, toggle state & pull-down menus",
        glyph: "⬭",
        tint: "#007AFF",
      },
      {
        slug: "segmented-control",
        title: "Segmented Control",
        subtitle: "Draggable Liquid Lens & momentary segments",
        glyph: "▤",
        tint: "#32ADE6",
      },
      {
        slug: "switch",
        title: "Switch",
        subtitle: "Droplet thumb magnification & well gradients",
        glyph: "⊶",
        tint: "#34C759",
      },
      {
        slug: "slider",
        title: "Slider",
        subtitle: "Refractive droplet thumb & Updates on Release",
        glyph: "⊸",
        tint: "#007AFF",
      },
      {
        slug: "stepper",
        title: "Stepper",
        subtitle: "Split highlight, Hold to Accelerate & Wraps Around",
        glyph: "±",
        tint: "#AF52DE",
      },
      {
        slug: "page-control",
        title: "Page Control",
        subtitle: "Glass capsule scrub & Windowed Dots (12 Pages)",
        glyph: "•••",
        tint: "#5856D6",
      },
    ],
  },
  {
    title: "Materials & Effects",
    rows: [
      {
        slug: "liquid-lens",
        title: "Liquid Lens",
        subtitle: "Interactive Regular & Clear refractive lenses",
        glyph: "◉",
        tint: "#00C7BE",
      },
      {
        slug: "visual-effect",
        title: "Visual Effect",
        subtitle: "Color discs, Glass Merge Spacing & Vibrancy",
        glyph: "✦",
        tint: "#FF2D55",
      },
      {
        slug: "control-and-flex",
        title: "Control & Flex",
        subtitle: "Press & drag flex rubber-band deformation",
        glyph: "✥",
        tint: "#FF9500",
      },
      {
        slug: "siri",
        title: "Siri",
        subtitle: "IntelligentLight edge glow & shockwave overlay",
        glyph: "〰",
        tint: "#E040FB",
      },
      {
        slug: "pointer",
        title: "Pointer",
        subtitle: "Hover shapes, Text Beam & Context Menu lift",
        glyph: "↖",
        tint: "#007AFF",
      },
    ],
  },
  {
    title: "Content & Indicators",
    rows: [
      {
        slug: "text",
        title: "Text",
        subtitle: "Styled runs, Multilingual Emoji, BiDi & Baseline",
        glyph: "Aa",
        tint: "#8E8E93",
      },
      {
        slug: "image-view",
        title: "Image View",
        subtitle: "Aspect Fit, Aspect Fill & tinted symbols",
        glyph: "▣",
        tint: "#34C759",
      },
      {
        slug: "progress-view",
        title: "Progress View",
        subtitle: "Default, Bar Style & Animated Progress",
        glyph: "▰",
        tint: "#007AFF",
      },
      {
        slug: "activity-indicator",
        title: "Activity Indicator",
        subtitle: "Medium, Large & Playback hidesWhenStopped",
        glyph: "◌",
        tint: "#64748B",
      },
    ],
  },
  {
    title: "Layout & Containers",
    rows: [
      {
        slug: "view",
        title: "View",
        subtitle: "Continuous corner radius, clipping & colors",
        glyph: "❐",
        tint: "#5856D6",
      },
      {
        slug: "scroll-view",
        title: "Scroll View",
        subtitle: "ScrollIndicators & ScrollEdgeEffect under glass",
        glyph: "↕",
        tint: "#32ADE6",
      },
      {
        slug: "collection-view",
        title: "Collection View",
        subtitle: "Featured pager, pinned Grid & compositional List",
        glyph: "⊞",
        tint: "#FF2D55",
      },
    ],
  },
];

const ALL_ROWS: readonly GalleryRowMeta[] = UIKIT_GALLERY_SECTIONS.flatMap(
  (s) => s.rows,
);

const WALLPAPER_OPTIONS: readonly { id: GalleryWallpaperId; label: string }[] = [
  { id: "waves", label: "iPadOS Waves" },
  { id: "circles-blue", label: "Circles Blue" },
  { id: "circles-pink", label: "Circles Pink" },
  { id: "mini-purple", label: "iPad mini" },
  { id: "plain", label: "Plain" },
];

function isComponentSlug(val: string | undefined): val is GalleryComponentSlug {
  return Boolean(val && ALL_ROWS.some((r) => r.slug === val));
}

function wallpaperAssetFor(id: GalleryWallpaperId, dark: boolean): string | null {
  if (id === "waves") return dark ? "wallpapers/waves-dark.png" : "wallpapers/waves-light.png";
  if (id === "circles-blue") {
    return dark ? "wallpapers/circles-blue-dark.png" : "wallpapers/circles-blue-light.png";
  }
  if (id === "circles-pink") {
    return dark ? "wallpapers/circles-pink-dark.png" : "wallpapers/circles-pink-light.png";
  }
  if (id === "mini-purple") {
    return dark ? "wallpapers/mini-purple-dark.png" : "wallpapers/mini-purple-light.png";
  }
  return null;
}

const wallpaperCodec = stateParam.enum<GalleryWallpaperId>(
  ["waves", "circles-blue", "circles-pink", "mini-purple", "plain"] as const,
  "waves",
);
const siriCodec = stateParam.boolean(false);
const autoHideCodec = stateParam.boolean(false);

export function UIKitGalleryReplicaPage(props: {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  geometry: () => DisplayGeometry;
}): JSX.Element {
  const routeActive = useRouteActive();
  const routeParams = useRouteParams<{ component?: string }>({ routeId: "uikit-gallery" });
  const accessibility = useAccessibilityPreferences();

  const [componentParam, setComponentParam] = useSearchState(
    "component",
    stateParam.string(""),
  );
  const [wallpaper, setWallpaper] = useSearchState("wallpaper", wallpaperCodec);
  const [siriActive, setSiriActive] = useSearchState("siri", siriCodec);
  const [autoHideHome, setAutoHideHome] = useSearchState("autohide", autoHideCodec);
  const [optionsMenuOpen, setOptionsMenuOpen] = createSignal(false);
  const [fpsHudOpen, setFpsHudOpen] = createSignal(false);

  const activeSlug = createMemo<GalleryComponentSlug | null>(() => {
    const q = componentParam();
    if (isComponentSlug(q)) return q;
    const p = routeParams().component;
    if (isComponentSlug(p)) return p;
    return null;
  });

  const activeRow = createMemo(() =>
    ALL_ROWS.find((r) => r.slug === activeSlug()) ?? null,
  );

  const openComponent = (slug: GalleryComponentSlug | null): void => {
    setComponentParam(slug ?? "");
  };

  const isDark = () => props.state().mobileDark;
  const setDark = (dark: boolean): void => {
    if (dark !== isDark()) {
      props.dispatch({ type: "setMobileDark", value: dark });
    }
  };

  // Measured on uikit.even.how (sdk/docs/LIQUID_GLASS_PACKAGE.md, "Gallery motion").
  // Scroll edge: past ~45pt the bar runs a timed collapse instead of a scroll-linked ramp.
  const [catalogScrollY, setCatalogScrollY] = createSignal(0);
  const [detailScrollY, setDetailScrollY] = createSignal(0);
  createEffect(() => {
    activeSlug();
    setDetailScrollY(0);
  });
  const onCatalog = () => activeSlug() === null;
  const barCollapsed = createMemo(() => (onCatalog() ? catalogScrollY() > 44 : detailScrollY() > 4));
  const barProgress = createGlassSpring(() => (barCollapsed() ? 1 : 0), {
    config: BAR_COLLAPSE_SPRING,
    quantizeStep: 0.01,
    reducedMotion: () => accessibility().reduceMotion,
  });

  // Push/pop: critically damped spring, -30% catalog parallax and a 12% black dim.
  const [prevSlug, setPrevSlug] = createSignal<GalleryComponentSlug | null>(null);
  createEffect(() => {
    const slug = activeSlug();
    if (slug !== null) setPrevSlug(slug);
  });
  const pushProgress = createGlassSpring(() => (activeSlug() !== null ? 1 : 0), {
    config: PAGE_PUSH_SPRING,
    reducedMotion: () => accessibility().reduceMotion,
  });
  const pageWidth = () => props.geometry().width || 390;
  const showDetail = createMemo(() => pushProgress() > 0);
  const showCatalog = createMemo(() => pushProgress() < 1);

  // Siri IntelligentLight animated phase (demand-driven: runs ONLY while `siriActive()` is true!)
  const [siriPhase, setSiriPhase] = createSignal(0);
  try {
    onFrame(
      () => {
        setSiriPhase((p) => (p + 0.012) % (Math.PI * 2));
      },
      {
        active: () => routeActive() && siriActive() && !accessibility().reduceMotion,
        continuous: () => routeActive() && siriActive() && !accessibility().reduceMotion,
      },
    );
  } catch {}

  const optionsMenuEntries = createMemo<readonly LiquidGlassMenuEntry[]>(() => [
    {
      title: "Appearance",
      items: [
        {
          id: "appearance-light",
          label: "Light",
          icon: "☀",
          checked: !isDark(),
          onSelect: () => setDark(false),
        },
        {
          id: "appearance-dark",
          label: "Dark",
          icon: "☾",
          checked: isDark(),
          onSelect: () => setDark(true),
        },
      ],
    },
    {
      title: "Backdrop & Chrome",
      items: [
        {
          id: "wallpaper-submenu",
          label: "Wallpaper",
          subtitle: WALLPAPER_OPTIONS.find((w) => w.id === wallpaper())?.label,
          icon: "▣",
          children: WALLPAPER_OPTIONS.map((opt) => ({
            id: `wp-${opt.id}`,
            label: opt.label,
            checked: wallpaper() === opt.id,
            onSelect: () => setWallpaper(opt.id),
          })),
        },
        {
          id: "auto-hide-home",
          label: "Auto-Hide Home Indicator",
          checked: autoHideHome(),
          keepOpen: true,
          onSelect: () => setAutoHideHome(!autoHideHome()),
        },
        {
          id: "toggle-siri-glow",
          label: siriActive() ? "Dismiss Siri Edge Glow" : "Activate Siri",
          icon: "✦",
          checked: siriActive(),
          onSelect: () => setSiriActive(!siriActive()),
        },
        {
          id: "toggle-fps-hud",
          label: "60 FPS Governor HUD",
          checked: fpsHudOpen(),
          keepOpen: true,
          onSelect: () => setFpsHudOpen(!fpsHudOpen()),
        },
      ],
    },
    {
      items: [
        {
          id: "exit-showcase",
          label: "Exit to Pocket Showcase",
          icon: "↩",
          onSelect: () => props.dispatch({ type: "navigate", route: "home" }),
        },
      ],
    },
  ]);

  // Navigation detail page state (`NavigationPage::makeMenu`)
  const [navDepth, setNavDepth] = createSignal(1);
  const [navSort, setNavSort] = createSignal<"Name" | "Date" | "Kind">("Name");
  const [lastNavAction, setLastNavAction] = createSignal("None");

  const navMenuEntries = createMemo<readonly LiquidGlassMenuEntry[]>(() => [
    {
      items: [
        {
          id: "push-next",
          label: "Push next page",
          icon: "›",
          onSelect: () => {
            setNavDepth((d) => d + 1);
            setLastNavAction(`Pushed Page ${navDepth() + 1}`);
          },
        },
        {
          id: "pop-first",
          label: "Pop to first page",
          disabled: navDepth() <= 1,
          icon: "«",
          onSelect: () => {
            setNavDepth(1);
            setLastNavAction("Popped to Page 1");
          },
        },
      ],
    },
    {
      items: [
        {
          id: "nav-sort-by",
          label: "Sort By",
          subtitle: navSort(),
          children: (["Name", "Date", "Kind"] as const).map((k) => ({
            id: `sort-${k}`,
            label: k,
            checked: navSort() === k,
            onSelect: () => {
              setNavSort(k);
              setLastNavAction(`Sorted by ${k}`);
            },
          })),
        },
        {
          id: "nav-recents",
          label: "Recents",
          deferred: () =>
            new Promise((resolve) => {
              setTimeout(() => {
                resolve([
                  {
                    id: "recent-1",
                    label: "Recent Item · Liquid Lens",
                    onSelect: () => setLastNavAction("Opened Recent: Liquid Lens"),
                  },
                  {
                    id: "recent-2",
                    label: "Recent Item · Visual Effect",
                    onSelect: () => setLastNavAction("Opened Recent: Visual Effect"),
                  },
                  {
                    id: "recent-3",
                    label: "Recent Item · Pointer",
                    onSelect: () => setLastNavAction("Opened Recent: Pointer"),
                  },
                ]);
              }, 120);
            }),
        },
      ],
    },
    {
      items: [
        {
          id: "nav-reset",
          label: "Reset Navigation",
          destructive: true,
          icon: "⌫",
          onSelect: () => {
            setNavDepth(1);
            setNavSort("Name");
            setLastNavAction("Reset Navigation");
          },
        },
      ],
    },
  ]);

  const fgColor = () => (isDark() ? "#F8FAFC" : "#0F172A");
  const subColor = () => (isDark() ? "#CBD5E1" : "#475569");
  const plainBg = () => (isDark() ? "#000000" : "#F2F2F7");
  const wpSrc = () => wallpaperAssetFor(wallpaper(), isDark());

  return (
    <LiquidGlassProvider
      mode={() => (isDark() ? "dark" : "light")}
      accent={() => props.state().accentColor}
      density={() =>
        props.state().interfaceDensity === "desktop" ? "compact" : "comfortable"
      }
      reducedMotion={() => accessibility().reduceMotion}
      gpuBudget={8}
    >
      <View
        class="relative flex-col w-full h-full overflow-hidden"
        style={{
          posType: 0,
          bgColor: plainBg(),
          overflow: 1,
        }}
      >
        {/* 1. GalleryWallpaperView Full-Bleed Backdrop */}
        <Show when={wpSrc() !== null}>
          <Image
            src={wpSrc()!}
            class="absolute inset-0 w-full h-full"
            style={{
              posType: 1,
              insetT: 0,
              insetL: 0,
              width: props.geometry().width || 390,
              height: props.geometry().height || 844,
              hitPass: 1,
            }}
          />
        </Show>

        {/* Subtle dark-mode contrast veil */}
        <Show when={isDark()}>
          <View
            class="absolute inset-0 w-full h-full"
            style={{
              posType: 1,
              insetT: 0,
              insetR: 0,
              insetB: 0,
              insetL: 0,
              bgColor: "#0206172E",
              hitPass: 1,
            }}
          />
        </Show>

        {/* 2. Scrollable Content Layer with animated page transitions */}
        <View class="relative flex-1 w-full h-full" style={{ posType: 0 }}>
          {/* Catalog list (fades/slides out when a detail opens) */}
          <Show when={showCatalog()}>
            <View
              class="absolute inset-0 w-full h-full"
              style={{
                posType: 1,
                insetT: 0,
                insetR: 0,
                insetB: 0,
                insetL: 0,
                translateX: -0.3 * pageWidth() * pushProgress(),
                hitPass: pushProgress() > 0.5 ? 1 : 0,
              }}
            >
              <GalleryCatalogList
                isDark={isDark}
                onSelectComponent={(slug) => openComponent(slug)}
                fpsHudOpen={fpsHudOpen}
                onScroll={setCatalogScrollY}
              />
              {/* Pinned large title; content scrolls under it until the bar collapses. */}
              <View
                class="absolute left-0 right-0 px-4"
                style={{ posType: 1, insetL: 0, insetR: 0, insetT: 92, opacity: 1 - barProgress(), hitPass: 1 }}
              >
                <Text class="text-4xl font-bold" style={{ textColor: fgColor(), hitPass: 1 }}>
                  UIKit Gallery
                </Text>
              </View>
              <Show when={pushProgress() > 0}>
                <View
                  class="absolute inset-0 w-full h-full"
                  style={{
                    posType: 1,
                    insetT: 0,
                    insetR: 0,
                    insetB: 0,
                    insetL: 0,
                    bgColor: "#000000",
                    opacity: 0.12 * pushProgress(),
                    hitPass: 1,
                  }}
                />
              </Show>
            </View>
          </Show>
          {/* Detail page (slides in from right, fades in) */}
          <Show when={showDetail()}>
            <View
              class="absolute inset-0 w-full h-full"
              style={{
                posType: 1,
                insetT: 0,
                insetR: 0,
                insetB: 0,
                insetL: 0,
                translateX: pageWidth() * (1 - pushProgress()),
                hitPass: pushProgress() < 0.5 ? 1 : 0,
              }}
            >
              {/* The pushed page is opaque: it carries its own backdrop and covers the catalog. */}
              <View
                class="absolute inset-0 w-full h-full"
                style={{ posType: 1, insetT: 0, insetR: 0, insetB: 0, insetL: 0, bgColor: plainBg(), hitPass: 1 }}
              />
              <Show when={wpSrc() !== null}>
                <Image
                  src={wpSrc()!}
                  class="absolute inset-0 w-full h-full"
                  style={{ posType: 1, insetT: 0, insetL: 0, width: pageWidth(), height: props.geometry().height || 844, hitPass: 1 }}
                />
              </Show>
              <Show when={isDark()}>
                <View
                  class="absolute inset-0 w-full h-full"
                  style={{ posType: 1, insetT: 0, insetR: 0, insetB: 0, insetL: 0, bgColor: "#0206172E", hitPass: 1 }}
                />
              </Show>
              <ScrollablePage>
                <ScrollOffsetTracker onScroll={setDetailScrollY} />
                <View class="flex-col gap-3.5 px-4 pt-[104] pb-[96] w-full" style={{ minW: 0 }}>
                  <Show when={fpsHudOpen()}>
                    <LiquidGlassFpsHud active={fpsHudOpen} />
                  </Show>
                  <ComponentDetailRouter
                    slug={prevSlug() ?? activeSlug()!}
                    isDark={isDark}
                    wallpaper={wallpaper}
                    setWallpaper={setWallpaper}
                    siriActive={siriActive}
                    setSiriActive={setSiriActive}
                    navDepth={navDepth}
                    setNavDepth={setNavDepth}
                    navSort={navSort}
                    lastNavAction={lastNavAction}
                  />
                </View>
              </ScrollablePage>
            </View>
          </Show>
        </View>

        {/* 3. Top ScrollEdgeEffect Glass Navigation Bar (`Navigation bar fading platter glass`) */}
        <View
          class="absolute left-0 right-0 top-0 flex-col overflow-hidden"
          style={{
            posType: 1,
            insetL: 0,
            insetR: 0,
            insetT: 0,
            overflow: 1,
          }}
        >
          <LiquidGlassSurface
            material="regular"
            priority="critical"
            shape="rounded"
            radius={0}
            elevated={false}
            class="absolute inset-0 w-full h-full"
            contentClass="p-0"
            opacity={barProgress()}
            style={{
              posType: 1,
              insetT: 0,
              insetR: 0,
              insetB: 0,
              insetL: 0,
              hitPass: 1,
            }}
          />
          <View
            class="absolute inset-0 w-full h-full"
            style={{
              posType: 1,
              insetT: 0,
              insetR: 0,
              insetB: 0,
              insetL: 0,
              bgColor: isDark() ? "#090D16B8" : "#F8FAFCC4",
              borderColor: isDark() ? "#FFFFFF1E" : "#0F172A14",
              borderWidth: 0.5,
              opacity: barProgress(),
              hitPass: 1,
            }}
          />
          {/* Status Bar (`9:41 Tue Jun 9` ... `100%`) */}
          <View
            class="flex-row items-center justify-between px-5 h-[40] w-full"
            style={{ height: 40, hitPass: 1 }}
          >
            <View class="flex-row items-center gap-2">
              <Text
                class="text-xs font-bold"
                style={{ textColor: fgColor(), hitPass: 1 }}
              >
                9:41
              </Text>
              <Text
                class="text-2xs font-bold"
                style={{ textColor: subColor(), hitPass: 1 }}
              >
                Tue Jun 9
              </Text>
            </View>
            <View class="flex-row items-center gap-1.5">
              <Text
                class="text-2xs font-bold"
                style={{ textColor: fgColor(), hitPass: 1 }}
              >
                •••  Wi-Fi  100%
              </Text>
              <View
                class="w-[20] h-[10] p-[1.5] justify-center"
                style={{
                  width: 20,
                  height: 10,
                  borderColor: fgColor(),
                  borderWidth: 1,
                  radius: 3,
                }}
              >
                <View
                  class="h-[5] w-full"
                  style={{ height: 5, bgColor: fgColor(), radius: 1.5 }}
                />
              </View>
            </View>
          </View>

          {/* Navigation Bar Row (`Navigation bar platter glass`) */}
          <View class="flex-row items-center justify-between gap-2 px-4 pb-2.5 h-[50] w-full">
            <Show
              when={activeRow() !== null}
              fallback={
                <View class="flex-row items-center gap-2 flex-1" style={{ minW: 0 }}>
                  <Focusable
                    onPress={() => props.dispatch({ type: "navigate", route: "home" })}
                  >
                    <LiquidGlassSurface
                      material="clear"
                      priority="high"
                      shape="pill"
                      radius={999}
                      class="shrink-0"
                      contentClass="flex-row items-center gap-1 px-2.5 h-[32]"
                    >
                      <Text
                        class="text-xs font-bold"
                        style={{ textColor: isDark() ? "#60A5FA" : "#007AFF", hitPass: 1 }}
                      >
                        ‹ Pocket
                      </Text>
                    </LiquidGlassSurface>
                  </Focusable>
                  <View class="flex-1 items-center justify-center" style={{ minW: 0, opacity: barProgress() }}>
                    <Text class="text-sm font-bold" style={{ textColor: fgColor() }}>
                      UIKit Gallery
                    </Text>
                  </View>
                </View>
              }
            >
              <Focusable onPress={() => openComponent(null)}>
                <LiquidGlassSurface
                  material="clear"
                  priority="high"
                  shape="pill"
                  radius={999}
                  class="shrink-0"
                  contentClass="flex-row items-center gap-1 px-3.5 h-[36]"
                >
                  <Text
                    class="text-base font-bold"
                    style={{ textColor: isDark() ? "#60A5FA" : "#007AFF", hitPass: 1 }}
                  >
                    ‹
                  </Text>
                  <Text
                    class="text-xs font-bold"
                    style={{ textColor: isDark() ? "#60A5FA" : "#007AFF", hitPass: 1 }}
                  >
                    UIKit Gallery
                  </Text>
                </LiquidGlassSurface>
              </Focusable>
            </Show>

            <Show when={activeRow() !== null}>
              <View class="flex-1 items-center justify-center" style={{ minW: 0 }}>
                <Text
                  class="text-sm font-bold"
                  style={{ textColor: fgColor() }}
                >
                  {activeRow()!.title}
                </Text>
              </View>
            </Show>

            {/* Right Bar Button: `Options` on catalog root, `•••` on Navigation, or Quick Options */}
            <Show
              when={activeSlug() === "navigation"}
              fallback={
                <LiquidGlassMenuButton
                  label="Options"
                  compact
                  align="end"
                  width={244}
                  open={optionsMenuOpen()}
                  onOpenChange={setOptionsMenuOpen}
                  entries={optionsMenuEntries()}
                />
              }
            >
              <LiquidGlassMenuButton
                glyph="•••"
                compact
                align="end"
                width={236}
                entries={navMenuEntries()}
              />
            </Show>
          </View>
        </View>

        {/* 4. Persistent App-Wide SiriSideButtonOverlay (`IntelligentLight` + `EdgeLightMask`) */}
        <Show when={siriActive()}>
          <SiriEdgeGlowOverlay
            phase={siriPhase}
            width={() => props.geometry().width || 390}
            height={() => props.geometry().height || 844}
          />
        </Show>

        {/* 5. HomeGrabberView (`LumaDodgePillView`) */}
        <Show when={!autoHideHome()}>
          <View
            class="absolute left-0 right-0 bottom-[8] items-center justify-center"
            style={{
              posType: 1,
              insetL: 0,
              insetR: 0,
              insetB: 8,
              height: 8,
              hitPass: 1,
            }}
          >
            <View
              class="w-[134] h-[5]"
              style={{
                width: 134,
                height: 5,
                bgColor: isDark() ? "#FFFFFFCC" : "#0F172AB8",
                radius: 999,
                hitPass: 1,
              }}
            />
          </View>
        </Show>
      </View>
    </LiquidGlassProvider>
  );
}

/** Persistent multi-chromatic Siri IntelligentLight screen-perimeter overlay (`hitPass: 1`). */
function ScrollOffsetTracker(props: { onScroll?: (y: number) => void }): JSX.Element {
  const ctx = useContext(ScrollablePageContext);
  createEffect(() => {
    const y = ctx?.scrollOffset() ?? 0;
    props.onScroll?.(y);
  });
  return null as unknown as JSX.Element;
}

// IntelligentLight palette from the reference shader (kLightBase/Purple/Pink/Orange).
const SIRI_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0, 150, 255],
  [187, 100, 255],
  [255, 45, 85],
  [255, 147, 0],
];

function siriColor(h: number, alpha: number): string {
  const x = (((h % 1) + 1) % 1) * SIRI_PALETTE.length;
  const k = Math.floor(x);
  const t = x - k;
  const a = SIRI_PALETTE[k]!;
  const b = SIRI_PALETTE[(k + 1) % SIRI_PALETTE.length]!;
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${hex(a[0] + (b[0] - a[0]) * t)}${hex(a[1] + (b[1] - a[1]) * t)}${hex(a[2] + (b[2] - a[2]) * t)}${hex(alpha * 255)}`;
}

type GlowSegmentRect = {
  posType: 1;
  insetL: number;
  insetT: number;
  width: number;
  height: number;
  hitPass: 1;
};

type GlowSegment = {
  u: number;
  x: number;
  y: number;
  w: number;
  h: number;
  side: "t" | "r" | "b" | "l";
  outer: GlowSegmentRect;
  inner: GlowSegmentRect;
};

function glowSegments(width: number, height: number): GlowSegment[] {
  const out: GlowSegment[] = [];
  const perimeter = 2 * (width + height);
  const makeRect = (
    side: GlowSegment["side"],
    x: number,
    y: number,
    w: number,
    h: number,
    depth: number,
  ): GlowSegmentRect => {
    const horizontal = side === "t" || side === "b";
    return {
      posType: 1,
      insetL: side === "r" ? x - depth : x,
      insetT: side === "b" ? y - depth : y,
      width: horizontal ? w : depth,
      height: horizontal ? depth : h,
      hitPass: 1,
    };
  };
  const run = (side: GlowSegment["side"], count: number, length: number, offset: number) => {
    for (let i = 0; i < count; i += 1) {
      const a = (length * i) / count;
      const b = (length * (i + 1)) / count;
      const u = (offset + (a + b) / 2) / perimeter;
      const x = side === "t" ? a : side === "r" ? width : side === "b" ? width - b : 0;
      const y = side === "t" ? 0 : side === "r" ? a : side === "b" ? height : height - b;
      const w = side === "t" || side === "b" ? b - a : 0;
      const h = side === "r" || side === "l" ? b - a : 0;
      out.push({
        u,
        side,
        x,
        y,
        w,
        h,
        outer: makeRect(side, x, y, w, h, 4),
        inner: makeRect(side, x, y, w, h, 12),
      });
    }
  };
  run("t", 6, width, 0);
  run("r", 10, height, width);
  run("b", 6, width, width + height);
  run("l", 10, height, 2 * width + height);
  return out;
}

/** Perimeter edge light measured on uikit.even.how: bright outer ~4pt, faded by ~12pt, colors drifting along the edge. */
function SiriEdgeGlowOverlay(props: { phase: () => number; width: () => number; height: () => number }): JSX.Element {
  const segments = createMemo(() => glowSegments(props.width(), props.height()));
  const hue = (u: number) => {
    const turn = props.phase() / (Math.PI * 2);
    return u * 2 + turn + 0.12 * Math.sin(Math.PI * 2 * u * 3 + props.phase());
  };
  return (
    <View
      class="absolute inset-0 w-full h-full"
      style={{ posType: 1, insetT: 0, insetR: 0, insetB: 0, insetL: 0, hitPass: 1 }}
    >
      <For each={segments()}>
        {(segment) => {
          const h = createMemo(() => hue(segment.u));
          return (
            <>
              <View class="absolute" style={{ ...segment.inner, bgColor: siriColor(h(), 0.28) }} />
              <View class="absolute" style={{ ...segment.outer, bgColor: siriColor(h(), 0.9) }} />
            </>
          );
        }}
      </For>
    </View>
  );
}

/** Root `UIKit Gallery` 5-section Inset Grouped Catalog (`GalleryListViewController`). */
function GalleryCatalogList(props: {
  isDark: () => boolean;
  onSelectComponent: (slug: GalleryComponentSlug) => void;
  fpsHudOpen: () => boolean;
  onScroll?: (y: number) => void;
}): JSX.Element {
  const cardBg = () => (props.isDark() ? "#1C1C1ECC" : "#FFFFFFD8");
  const cardBorder = () => (props.isDark() ? "#FFFFFF24" : "#FFFFFFEE");
  const rowTitle = () => (props.isDark() ? "#F8FAFC" : "#0F172A");
  const rowSub = () => (props.isDark() ? "#94A3B8" : "#64748B");
  const headerText = () => (props.isDark() ? "#CBD5E1" : "#334155");

  return (
    <ScrollablePage>
      <ScrollOffsetTracker onScroll={props.onScroll} />
      <View class="flex-col gap-4 px-4 pt-[144] pb-[48] w-full" style={{ minW: 0 }}>
        <Show when={props.fpsHudOpen()}>
          <LiquidGlassFpsHud active={props.fpsHudOpen} />
        </Show>

        {/* Hero Liquid Glass Welcome Banner */}
        <LiquidGlassSurface
          material="regular"
          priority="high"
          shape="rounded"
          radius={22}
          class="w-full"
          contentClass="flex-row items-center justify-between gap-3 p-4 w-full"
        >
          <View class="flex-col gap-1 flex-1" style={{ minW: 0 }}>
            <Text
              class="text-base font-bold"
              style={{ textColor: rowTitle() }}
            >
              iOS 26 Liquid Glass UIKit
            </Text>
            <MobileParagraph
              text="21 interactive component scenes · Morphing menus · Snell refraction · >=60 FPS."
              class="text-xs"
              style={{ textColor: rowSub() }}
            />
          </View>
          <LiquidGlassBadge label="21 Pages" tone="accent" />
        </LiquidGlassSurface>

        <For each={UIKIT_GALLERY_SECTIONS}>
          {(section) => (
            <View class="flex-col gap-1.5 w-full" style={{ minW: 0 }}>
              <View class="px-3">
                <Text
                  class="text-xs font-bold"
                  style={{ textColor: headerText() }}
                >
                  {section.title.toUpperCase()}
                </Text>
              </View>

              <View
                class="flex-col w-full overflow-hidden"
                style={{
                  bgColor: cardBg(),
                  borderColor: cardBorder(),
                  borderWidth: 1,
                  radius: 18,
                  overflow: 1,
                }}
              >
                <For each={section.rows}>
                  {(row, idx) => (
                    <Focusable
                      class="w-full"
                      onPress={() => props.onSelectComponent(row.slug)}
                    >
                      <View class="relative flex-row items-center justify-between gap-3 px-3.5 py-3 w-full">
                        <Show when={idx() > 0}>
                          <View
                            class="absolute left-[54] right-0 top-0 h-[1]"
                            style={{
                              posType: 1,
                              insetL: 54,
                              insetR: 0,
                              insetT: 0,
                              height: 1,
                              bgColor: props.isDark() ? "#FFFFFF18" : "#0F172A12",
                              hitPass: 1,
                            }}
                          />
                        </Show>
                        <View
                          class="w-[30] h-[30] items-center justify-center shrink-0"
                          style={{
                            width: 30,
                            height: 30,
                            bgColor: row.tint,
                            radius: 8,
                          }}
                        >
                          <Text
                            class="text-xs font-bold"
                            style={{ textColor: "#FFFFFF", hitPass: 1 }}
                          >
                            {row.glyph}
                          </Text>
                        </View>

                        <View class="flex-col gap-0.5 flex-1" style={{ minW: 0 }}>
                          <Text
                            class="text-sm font-bold"
                            style={{ textColor: rowTitle(), hitPass: 1 }}
                          >
                            {row.title}
                          </Text>
                          <MobileParagraph
                            text={row.subtitle}
                            class="text-xs"
                            style={{ textColor: rowSub(), hitPass: 1 }}
                            fallbackInsetPx={116}
                          />
                        </View>

                        <Text
                          class="text-base font-bold shrink-0"
                          style={{ textColor: rowSub(), hitPass: 1 }}
                        >
                          ›
                        </Text>
                      </View>
                    </Focusable>
                  )}
                </For>
              </View>
            </View>
          )}
        </For>
      </View>
    </ScrollablePage>
  );
}

/** Dispatches each of the 21 `UIKit Gallery` detail scenes. */
function ComponentDetailRouter(props: {
  slug: GalleryComponentSlug;
  isDark: () => boolean;
  wallpaper: () => GalleryWallpaperId;
  setWallpaper: (wp: GalleryWallpaperId) => void;
  siriActive: () => boolean;
  setSiriActive: (next: boolean) => void;
  navDepth: () => number;
  setNavDepth: (fn: (prev: number) => number) => void;
  navSort: () => "Name" | "Date" | "Kind";
  lastNavAction: () => string;
}): JSX.Element {
  // Tab Bar Demo State
  const [activeTab, setActiveTab] = createSignal<"home" | "search" | "saved" | "profile">("home");
  const tabWallpaperMap: Record<"home" | "search" | "saved" | "profile", GalleryWallpaperId> = {
    home: "waves",
    search: "circles-blue",
    saved: "circles-pink",
    profile: "mini-purple",
  };

  // Alert Demo State
  const [alertSample, setAlertSample] = createSignal<{
    title?: string;
    message?: string;
    actions: readonly LiquidGlassAlertAction[];
  } | null>(null);
  const [alertChoice, setAlertChoice] = createSignal("Tap a sample below to present an Alert glass group.");

  // Button Demo State
  const [btnToggled, setBtnToggled] = createSignal(true);
  const [btnFormat, setBtnFormat] = createSignal("Keep Original Format");

  // Segmented Control Demo State
  const [segHero, setSegHero] = createSignal("day");
  const [segTint, setSegTint] = createSignal("first");
  const [segDis, setSegDis] = createSignal("selected");
  const [momentaryLog, setMomentaryLog] = createSignal("None yet");

  // Switch Demo State
  const [sw1, setSw1] = createSignal(true);
  const [sw2, setSw2] = createSignal(false);
  const [sw3, setSw3] = createSignal(true);

  // Slider Demo State
  const [slHero, setSlHero] = createSignal(68);
  const [slBright, setSlBright] = createSignal(75);
  const [slVol, setSlVol] = createSignal(42);
  const [slReleaseCommitted, setSlReleaseCommitted] = createSignal(50);

  // Stepper Demo State
  const [stepQty, setStepQty] = createSignal(3);
  const [stepAccel, setStepAccel] = createSignal(100);
  const [stepWrap, setStepWrap] = createSignal(5);

  // Page Control Demo State
  const [carouselPage, setCarouselPage] = createSignal(1);
  const [windowedPage, setWindowedPage] = createSignal(5);

  // Visual Effect Demo State
  const [mergeGap, setMergeGap] = createSignal(8);

  // Pointer & Context Menu Demo State
  const [pointerShape, setPointerShape] = createSignal("Lift");
  const [regionCell, setRegionCell] = createSignal(4);
  const [ctxMenuOpen, setCtxMenuOpen] = createSignal(false);
  const [ctxFormat, setCtxFormat] = createSignal("Keep Original Format");
  const [ctxLastAction, setCtxLastAction] = createSignal("Tap or long-press the card below");

  // Progress & Activity Demo State
  const [animProgress, setAnimProgress] = createSignal(0.65);
  const [spinnerRunning, setSpinnerRunning] = createSignal(true);

  // View & Collection Demo State
  const [cornerRad, setCornerRad] = createSignal(24);
  const [selectedCollectionItem, setSelectedCollectionItem] = createSignal("Featured 1");

  return (
    <View class="flex-col gap-3.5 w-full" style={{ minW: 0 }}>
      {/* 1. TAB BAR */}
      <Show when={props.slug === "tab-bar"}>
        <LiquidGlassCard
          title="Tab Bar"
          detail="Tap a tab, or hold and slide across the Liquid Glass lens. Switching tabs cycles iPadOS wallpapers."
          variant="raised"
          badge={activeTab().toUpperCase()}
        >
          <ChromaticArtworkStage label={`Scene · ${activeTab().toUpperCase()}`} />
          <LiquidGlassNavigationBar
            route={activeTab()}
            items={[
              { id: "home", label: "Home", kind: "home" },
              { id: "search", label: "Search", kind: "gallery" },
              { id: "saved", label: "Saved", kind: "host" },
              { id: "profile", label: "Profile", kind: "settings" },
            ]}
            onNavigate={(next) => {
              setActiveTab(next);
              props.setWallpaper(tabWallpaperMap[next]);
            }}
          />
        </LiquidGlassCard>
      </Show>

      {/* 2. NAVIGATION */}
      <Show when={props.slug === "navigation"}>
        <LiquidGlassCard
          title={`Navigation Stack · Depth ${props.navDepth()}`}
          detail="Scroll the cards under the glass, or open the ••• menu in the top-right bar."
          variant="raised"
          badge={`Sort: ${props.navSort()}`}
        >
          <MobileParagraph
            text={`Last menu action: ${props.lastNavAction()}`}
            class="text-xs font-bold"
            style={{ textColor: props.isDark() ? "#60A5FA" : "#007AFF" }}
          />
          <View class="flex-row flex-wrap gap-2">
            <LiquidGlassButton
              label="Push next page"
              variant="primary"
              compact
              onPress={() => props.setNavDepth((d) => d + 1)}
            />
            <LiquidGlassButton
              label="Pop to first page"
              variant="glass"
              compact
              disabled={props.navDepth() <= 1}
              onPress={() => props.setNavDepth(() => 1)}
            />
          </View>
        </LiquidGlassCard>
        <For each={[1, 2, 3, 4]}>
          {(idx) => (
            <LiquidGlassCard
              title={`Under-Glass Card #${idx} (Page ${props.navDepth()})`}
              detail="Navigation bar fading platter glass refracts this card as it scrolls underneath."
            >
              <ChromaticArtworkStage label={`Layer ${idx} · ${props.navSort()}`} compact />
            </LiquidGlassCard>
          )}
        </For>
      </Show>

      {/* 3. ALERT */}
      <Show when={props.slug === "alert"}>
        <LiquidGlassCard
          title="Alert Glass Group"
          detail={alertChoice()}
          variant="raised"
          badge="Press & Scrub"
        >
          <View class="flex-col gap-2 w-full">
            <LiquidGlassListTile
              title="Two Actions (Side by Side)"
              detail="Fewer than three actions sit side by side when their titles fit."
              onPress={() =>
                setAlertSample({
                  title: "Save Changes?",
                  message: "Your edits will be lost if you don't save them.",
                  actions: [
                    { id: "cancel", label: "Cancel", style: "cancel" },
                    { id: "save", label: "Save", preferred: true },
                  ],
                })
              }
            />
            <LiquidGlassListTile
              title="Three Actions (Stacked)"
              detail="Hold and scrub vertically across Save, Duplicate, and Delete."
              onPress={() =>
                setAlertSample({
                  title: "Delete Photo?",
                  message: "This photo will be deleted from all your devices.",
                  actions: [
                    { id: "keep", label: "Keep Photo", preferred: true },
                    { id: "archive", label: "Archive Copy" },
                    { id: "delete", label: "Delete", style: "destructive" },
                    { id: "cancel", label: "Cancel", style: "cancel" },
                  ],
                })
              }
            />
            <LiquidGlassListTile
              title="Action Styles & Disabled"
              detail="Continue is unavailable until you sign in."
              onPress={() =>
                setAlertSample({
                  title: "Sign In Required",
                  message: "Continue is unavailable until you sign in.",
                  actions: [
                    { id: "continue", label: "Continue", disabled: true },
                    { id: "preferred", label: "Preferred Action", preferred: true },
                    { id: "destructive", label: "Destructive Action", style: "destructive" },
                    { id: "cancel", label: "Cancel", style: "cancel" },
                  ],
                })
              }
            />
            <LiquidGlassListTile
              title="Long Action Titles (Auto-Stacked)"
              detail="Actions whose titles do not fit side by side are stacked."
              onPress={() =>
                setAlertSample({
                  title: "Turn Off Notifications?",
                  message: "You can re-enable alerts anytime in Settings.",
                  actions: [
                    { id: "mute-hour", label: "Mute Notifications for 1 Hour" },
                    { id: "turn-off", label: "Turn Off Completely", style: "destructive" },
                  ],
                })
              }
            />
          </View>
        </LiquidGlassCard>

        <LiquidGlassAlertModal
          open={() => alertSample() !== null}
          title={alertSample()?.title}
          message={alertSample()?.message}
          actions={alertSample()?.actions ?? []}
          onAction={(a) => setAlertChoice(`Chose “${a.label}”`)}
          onClose={() => setAlertSample(null)}
        />
      </Show>

      {/* 4. BUTTON */}
      <Show when={props.slug === "button"}>
        <LiquidGlassCard title="Configurations" detail="Standard iOS 26 button styles & clear glass capsules." variant="raised">
          <View class="flex-row flex-wrap gap-2">
            <LiquidGlassButton label="Glass" variant="glass" flex />
            <LiquidGlassButton label="Prominent" variant="primary" flex />
            <LiquidGlassButton label="Tinted" variant="secondary" flex />
            <LiquidGlassButton label="Outline" variant="outline" />
            <LiquidGlassButton label="Plain" variant="ghost" />
            <LiquidGlassButton label="Destructive" variant="danger" />
          </View>
        </LiquidGlassCard>

        <LiquidGlassCard
          title="Selection & Dynamic Press State"
          detail="The button toggles its selection as its primary action. The custom button changes its title while pressed."
        >
          <View class="flex-row flex-wrap items-center gap-2.5">
            <LiquidGlassButton
              label={btnToggled() ? "Selected ✓" : "Select"}
              variant="glass"
              selected={btnToggled()}
              onPress={() => setBtnToggled(!btnToggled())}
            />
            <LiquidGlassButton
              label="Hold to Inspect"
              pressedLabel="Pressed!"
              variant="secondary"
              flex
            />
            <LiquidGlassMenuButton
              label={`Format: ${btnFormat()}`}
              compact
              entries={[
                {
                  title: "Choose a Format",
                  items: [
                    {
                      id: "orig",
                      label: "Keep Original Format",
                      checked: btnFormat() === "Keep Original Format",
                      onSelect: () => setBtnFormat("Keep Original Format"),
                    },
                    {
                      id: "compat",
                      label: "Convert to Most Compatible",
                      checked: btnFormat() === "Convert to Most Compatible",
                      onSelect: () => setBtnFormat("Convert to Most Compatible"),
                    },
                  ],
                },
              ]}
            />
          </View>
        </LiquidGlassCard>
      </Show>

      {/* 5. SEGMENTED CONTROL */}
      <Show when={props.slug === "segmented-control"}>
        <LiquidGlassCard
          title="Liquid Lens Segmented Control"
          detail="Hold and drag the clear magnifying Liquid Glass lens across segments."
          variant="raised"
        >
          <LiquidGlassSegmentedControl
            items={[
              { id: "day", label: "Day" },
              { id: "week", label: "Work Week" },
              { id: "month", label: "Month" },
            ]}
            active={segHero()}
            onChange={setSegHero}
          />
        </LiquidGlassCard>

        <LiquidGlassCard title="Minimal & Custom Tint" detail="Custom accent lens over recessed glass rail.">
          <LiquidGlassSegmentedControl
            items={[
              { id: "first", label: "First" },
              { id: "second", label: "Second" },
              { id: "third", label: "Third" },
            ]}
            active={segTint()}
            tintColor="#5856D6"
            onChange={setSegTint}
          />
        </LiquidGlassCard>

        <LiquidGlassCard title="Disabled Segment" detail="Middle segment is non-interactive.">
          <LiquidGlassSegmentedControl
            items={[
              { id: "avail", label: "Available" },
              { id: "unavail", label: "Unavailable", disabled: true },
              { id: "selected", label: "Selected" },
            ]}
            active={segDis()}
            onChange={setSegDis}
          />
        </LiquidGlassCard>

        <LiquidGlassCard
          title="Momentary"
          detail={`A momentary control does not keep its selection. Last triggered: ${momentaryLog()}`}
        >
          <LiquidGlassSegmentedControl
            momentary
            items={[
              { id: "prev", label: "‹ Previous" },
              { id: "replay", label: "Replay" },
              { id: "next", label: "Next ›" },
            ]}
            active="replay"
            onChange={(id) => setMomentaryLog(id.toUpperCase())}
          />
        </LiquidGlassCard>
      </Show>

      {/* 6. SWITCH */}
      <Show when={props.slug === "switch"}>
        <LiquidGlassCard
          title="SwitchModernVisualElement"
          detail="Press or drag the switch thumb to bloom its clear magnifying Liquid Glass droplet."
          variant="raised"
        >
          <LiquidGlassSwitch
            label="Liquid Glass Optics"
            detail="Switch well gradient + 1.18x clear droplet lens"
            value={sw1()}
            onChange={setSw1}
          />
          <LiquidGlassSwitch
            label="Custom Indigo Tint"
            value={sw2()}
            tintColor="#5856D6"
            onChange={setSw2}
          />
          <LiquidGlassSwitch
            label="Custom Rose Tint"
            value={sw3()}
            tintColor="#FF2D55"
            onChange={setSw3}
          />
          <LiquidGlassSwitch
            label="Disabled (On)"
            value={true}
            disabled
          />
        </LiquidGlassCard>
      </Show>

      {/* 7. SLIDER */}
      <Show when={props.slug === "slider"}>
        <LiquidGlassCard
          title="Slider Glass Visual Element"
          detail="Hold and scrub to expand the capsule thumb into a 1.22x clear refractive droplet."
          variant="raised"
        >
          <LiquidGlassSlider
            label="Refractive Droplet Slider"
            value={slHero()}
            min={0}
            max={100}
            onChange={setSlHero}
          />
        </LiquidGlassCard>

        <LiquidGlassCard title="Custom Tint & Value Images" detail="Leading & trailing SF symbol indicators.">
          <LiquidGlassSlider
            label="Display Brightness"
            leadingGlyph="☀"
            trailingGlyph="☀+"
            tintColor="#F59E0B"
            value={slBright()}
            min={0}
            max={100}
            onChange={setSlBright}
          />
          <LiquidGlassSlider
            label="Speaker Output"
            leadingGlyph="🔈"
            trailingGlyph="🔊"
            tintColor="#EC4899"
            value={slVol()}
            min={0}
            max={100}
            onChange={setSlVol}
          />
        </LiquidGlassCard>

        <LiquidGlassCard
          title="Updates on Release"
          detail="With isContinuous set to false, ValueChanged fires when the thumb is released."
        >
          <LiquidGlassSlider
            label={`Committed Value: ${slReleaseCommitted()}`}
            continuous={false}
            value={slReleaseCommitted()}
            min={0}
            max={100}
            onChange={setSlReleaseCommitted}
          />
        </LiquidGlassCard>
      </Show>

      {/* 8. STEPPER */}
      <Show when={props.slug === "stepper"}>
        <LiquidGlassCard title="Stepper Visual Element" variant="raised">
          <LiquidGlassStepper
            label={`Standard (0 to 10) · Quantity: ${stepQty()}`}
            value={stepQty()}
            min={0}
            max={10}
            onChange={setStepQty}
          />
          <LiquidGlassStepper
            label={`Hold to Accelerate · Step ×5: ${stepAccel()}`}
            detail="Autorepeat accelerates while +/- is held down."
            value={stepAccel()}
            min={0}
            max={500}
            step={5}
            autorepeat
            onChange={setStepAccel}
          />
          <LiquidGlassStepper
            label={`Wraps Around · Cycle (1–5): ${stepWrap()}`}
            detail="Incrementing past the maximum wraps back to the minimum."
            value={stepWrap()}
            min={1}
            max={5}
            wraps
            onChange={setStepWrap}
          />
        </LiquidGlassCard>
      </Show>

      {/* 9. PAGE CONTROL */}
      <Show when={props.slug === "page-control"}>
        <LiquidGlassCard
          title="PageControlPlatterView"
          detail="Swipe pages, tap either side of the pill, or hold and scrub across the dots."
          variant="raised"
        >
          <ChromaticArtworkStage label={`Artwork Page ${carouselPage() + 1} of 5`} />
          <View class="items-center justify-center pt-1">
            <LiquidGlassPageControl
              count={5}
              current={carouselPage()}
              onChange={setCarouselPage}
            />
          </View>
        </LiquidGlassCard>

        <LiquidGlassCard
          title={`Windowed Dots (12 Pages) · Page ${windowedPage() + 1}`}
          detail="Edge indicators scale smoothly when page count exceeds 7."
        >
          <View class="items-center justify-center py-2">
            <LiquidGlassPageControl
              count={12}
              current={windowedPage()}
              onChange={setWindowedPage}
            />
          </View>
        </LiquidGlassCard>
      </Show>

      {/* 10. LIQUID LENS */}
      <Show when={props.slug === "liquid-lens"}>
        <LiquidGlassCard
          title="Liquid Lens"
          detail="Press and drag either lens across the chromatic geometry to inspect Snell refraction & magnification."
          variant="raised"
        >
          <View class="relative w-full h-[220] overflow-hidden" style={{ posType: 0, height: 220, radius: 18, overflow: 1 }}>
            <OverlappingDiscsBackdrop isDark={props.isDark} />
            <View class="absolute inset-0 flex-row items-center justify-around px-3" style={{ posType: 1, insetT: 0, insetR: 0, insetB: 0, insetL: 0 }}>
              <LiquidGlassFlexSurface
                material="regular"
                radius={24}
                class="w-[144]"
                contentClass="flex-col items-center justify-center gap-1 p-3.5"
              >
                <Text class="text-xs font-bold" style={{ textColor: props.isDark() ? "#FFFFFF" : "#0F172A", hitPass: 1 }}>
                  Interactive Regular
                </Text>
                <Text class="text-2xs" style={{ textColor: props.isDark() ? "#E2E8F0" : "#334155", hitPass: 1 }}>
                  GlassEffectStyle::Regular
                </Text>
              </LiquidGlassFlexSurface>

              <LiquidGlassFlexSurface
                material="clear"
                radius={24}
                class="w-[144]"
                contentClass="flex-col items-center justify-center gap-1 p-3.5"
              >
                <Text class="text-xs font-bold" style={{ textColor: props.isDark() ? "#FFFFFF" : "#0F172A", hitPass: 1 }}>
                  Interactive Clear
                </Text>
                <Text class="text-2xs" style={{ textColor: props.isDark() ? "#E2E8F0" : "#334155", hitPass: 1 }}>
                  GlassEffectStyle::Clear
                </Text>
              </LiquidGlassFlexSurface>
            </View>
          </View>
        </LiquidGlassCard>
      </Show>

      {/* 11. VISUAL EFFECT */}
      <Show when={props.slug === "visual-effect"}>
        <LiquidGlassCard
          title="VisualEffectShowcaseView"
          detail="Sharp overlapping color discs highlight real-time glass refraction and rim highlights."
          variant="raised"
        >
          <View class="relative w-full h-[196] overflow-hidden" style={{ posType: 0, height: 196, radius: 18, overflow: 1 }}>
            <OverlappingDiscsBackdrop isDark={props.isDark} />
            <View class="absolute inset-0 flex-col items-center justify-center gap-2.5 p-3" style={{ posType: 1, insetT: 0, insetR: 0, insetB: 0, insetL: 0 }}>
              <Text class="text-2xs font-bold" style={{ textColor: "#FFFFFF" }}>
                GLASS MERGE SPACING ({mergeGap()}pt)
              </Text>
              <View class="flex-row items-center justify-center" style={{ gap: mergeGap() }}>
                <LiquidGlassSurface material="regular" priority="high" shape="pill" radius={999} contentClass="px-3.5 py-2">
                  <Text class="text-xs font-bold" style={{ textColor: props.isDark() ? "#F8FAFC" : "#0F172A" }}>Regular A</Text>
                </LiquidGlassSurface>
                <LiquidGlassSurface material="regular" priority="high" shape="pill" radius={999} contentClass="px-3.5 py-2">
                  <Text class="text-xs font-bold" style={{ textColor: props.isDark() ? "#F8FAFC" : "#0F172A" }}>Regular B</Text>
                </LiquidGlassSurface>
                <LiquidGlassSurface material="clear" priority="high" shape="pill" radius={999} contentClass="px-3.5 py-2">
                  <Text class="text-xs font-bold" style={{ textColor: props.isDark() ? "#F8FAFC" : "#0F172A" }}>Clear</Text>
                </LiquidGlassSurface>
              </View>
            </View>
          </View>
          <LiquidGlassSlider
            label="Glass Merge Spacing"
            value={mergeGap()}
            min={0}
            max={28}
            onChange={setMergeGap}
          />
        </LiquidGlassCard>

        <LiquidGlassCard title="Adaptive System Materials & Vibrancy Hierarchy">
          <View class="flex-row flex-wrap gap-2">
            {(["clear", "regular", "thick", "chrome"] as readonly LiquidGlassMaterial[]).map((mat) => (
              <LiquidGlassSurface
                material={mat}
                priority="normal"
                radius={14}
                class="w-[152]"
                contentClass="flex-col gap-0.5 p-3"
              >
                <Text class="text-xs font-bold" style={{ textColor: props.isDark() ? "#F8FAFC" : "#0F172A" }}>
                  {mat.toUpperCase()}
                </Text>
                <Text class="text-2xs" style={{ textColor: props.isDark() ? "#94A3B8" : "#475569" }}>
                  Primary · Secondary
                </Text>
              </LiquidGlassSurface>
            ))}
          </View>
        </LiquidGlassCard>
      </Show>

      {/* 12. CONTROL & FLEX */}
      <Show when={props.slug === "control-and-flex"}>
        <LiquidGlassCard
          title="FlexInteraction & GlowView"
          detail="Press and drag a control to see it deform, then release it to watch the spring recover."
          variant="raised"
        >
          <View class="relative w-full h-[210] overflow-hidden" style={{ posType: 0, height: 210, radius: 18, overflow: 1 }}>
            <OverlappingDiscsBackdrop isDark={props.isDark} />
            <View class="absolute inset-0 flex-col items-center justify-center gap-3 p-4" style={{ posType: 1, insetT: 0, insetR: 0, insetB: 0, insetL: 0 }}>
              <LiquidGlassFlexSurface
                material="regular"
                shape="pill"
                radius={999}
                class="w-[240]"
                contentClass="flex-row items-center justify-center gap-2 py-3 px-5"
              >
                <Text class="text-sm font-bold" style={{ textColor: props.isDark() ? "#F8FAFC" : "#0F172A", hitPass: 1 }}>
                  ✥  Press & Drag Flex (Regular)
                </Text>
              </LiquidGlassFlexSurface>

              <LiquidGlassFlexSurface
                material="clear"
                shape="pill"
                radius={999}
                class="w-[240]"
                contentClass="flex-row items-center justify-center gap-2 py-3 px-5"
              >
                <Text class="text-sm font-bold" style={{ textColor: props.isDark() ? "#F8FAFC" : "#0F172A", hitPass: 1 }}>
                  ◉  Press & Drag Flex (Clear)
                </Text>
              </LiquidGlassFlexSurface>
            </View>
          </View>
        </LiquidGlassCard>
      </Show>

      {/* 13. SIRI */}
      <Show when={props.slug === "siri"}>
        <LiquidGlassCard
          title="Siri Side-Button Appearance"
          detail="Plays the side-button Siri appearance over the whole app. The edge glow stays while you browse other pages."
          variant="raised"
          badge={props.siriActive() ? "ACTIVE" : "IDLE"}
        >
          <View class="flex-row flex-wrap gap-2.5 pt-1">
            <LiquidGlassButton
              label={props.siriActive() ? "Dismiss Siri" : "Activate Siri"}
              variant={props.siriActive() ? "danger" : "primary"}
              flex
              onPress={() => props.setSiriActive(!props.siriActive())}
            />
            <LiquidGlassButton
              label="Replay Pulse"
              variant="glass"
              onPress={() => props.setSiriActive(true)}
            />
          </View>
        </LiquidGlassCard>
      </Show>

      {/* 14. POINTER & CONTEXT MENU */}
      <Show when={props.slug === "pointer"}>
        <LiquidGlassCard
          title="Secondary Click · ContextMenuInteraction"
          detail={ctxLastAction()}
          variant="raised"
          badge="Lift + Submenu"
        >
          <LiquidGlassContextMenu
            open={ctxMenuOpen()}
            onOpenChange={setCtxMenuOpen}
            previewTitle="Spatial Artwork_2026.heic"
            previewSubtitle={`4032 × 3024 · Display P3 · ${ctxFormat()}`}
            previewBadge="HEIC"
            onSelect={(item) => setCtxLastAction(`Selected “${item.label}”`)}
            entries={[
              {
                items: [
                  { id: "cut", label: "Cut", icon: "✂" },
                  { id: "copy", label: "Copy", icon: "❐" },
                  { id: "paste", label: "Paste", icon: "📋" },
                  { id: "dup", label: "Duplicate", icon: "＋" },
                ],
              },
              {
                items: [
                  { id: "share", label: "Share", icon: "↗" },
                  { id: "pin", label: "Pin", icon: "📌" },
                  {
                    id: "format-sub",
                    label: "Choose a Format",
                    subtitle: ctxFormat(),
                    children: [
                      {
                        id: "fmt-orig",
                        label: "Keep Original Format",
                        checked: ctxFormat() === "Keep Original Format",
                        onSelect: () => setCtxFormat("Keep Original Format"),
                      },
                      {
                        id: "fmt-compat",
                        label: "Convert to Most Compatible",
                        checked: ctxFormat() === "Convert to Most Compatible",
                        onSelect: () => setCtxFormat("Convert to Most Compatible"),
                      },
                    ],
                  },
                  { id: "contact", label: "Send to a contact", icon: "👤" },
                ],
              },
              {
                items: [
                  { id: "archive", label: "Archive", icon: "▣" },
                  { id: "delete", label: "Delete", destructive: true, icon: "⌫" },
                ],
              },
            ]}
          >
            <View
              class="flex-row items-center justify-between gap-3 p-4 w-full"
              style={{
                bgColor: props.isDark() ? "#1E293B" : "#EFF6FF",
                borderColor: props.isDark() ? "#38BDF866" : "#60A5FA88",
                borderWidth: 1,
                radius: 18,
              }}
            >
              <View class="flex-col gap-1 flex-1" style={{ minW: 0 }}>
                <Text class="text-sm font-bold" style={{ textColor: props.isDark() ? "#F8FAFC" : "#0F172A", hitPass: 1 }}>
                  Spatial Artwork_2026.heic
                </Text>
                <Text class="text-xs" style={{ textColor: props.isDark() ? "#94A3B8" : "#475569", hitPass: 1 }}>
                  Tap or hold to lift card & morph Context Menu
                </Text>
              </View>
              <LiquidGlassBadge label="Menu ⌄" tone="accent" />
            </View>
          </LiquidGlassContextMenu>
        </LiquidGlassCard>

        <LiquidGlassCard title="Effects and Shapes" detail={`Active pointer effect: ${pointerShape()}`}>
          <View class="flex-row flex-wrap gap-2">
            {["Automatic", "Highlight", "Lift", "Hover", "Hover + Shadow", "Hover Underlay"].map((eff) => (
              <LiquidGlassButton
                label={eff}
                compact
                variant={pointerShape() === eff ? "primary" : "glass"}
                onPress={() => setPointerShape(eff)}
              />
            ))}
          </View>
          <MobileParagraph
            text="Move the pointer over this paragraph: the pointer becomes a vertical beam as tall as a line of text, as it does over text on iPadOS."
            class="text-xs"
            style={{ textColor: props.isDark() ? "#CBD5E1" : "#475569" }}
          />
          <View class="flex-row flex-wrap gap-1.5 pt-1">
            {[0, 1, 2, 3, 4, 5].map((cell) => (
              <Focusable onPress={() => setRegionCell(cell)}>
                <View
                  class="w-[48] h-[36] items-center justify-center"
                  style={{
                    width: 48,
                    height: 36,
                    bgColor: regionCell() === cell ? "#007AFF33" : props.isDark() ? "#FFFFFF12" : "#0F172A0A",
                    borderColor: regionCell() === cell ? "#007AFF" : "#94A3B844",
                    borderWidth: 1,
                    radius: 10,
                  }}
                >
                  <Text class="text-xs font-bold" style={{ textColor: props.isDark() ? "#F8FAFC" : "#0F172A", hitPass: 1 }}>
                    R{cell + 1}
                  </Text>
                </View>
              </Focusable>
            ))}
          </View>
        </LiquidGlassCard>
      </Show>

      {/* 15. TEXT */}
      <Show when={props.slug === "text"}>
        <LiquidGlassCard title="Multilingual, Emoji & Bidirectional" variant="raised">
          <Text class="text-base font-bold" style={{ textColor: props.isDark() ? "#F8FAFC" : "#0F172A" }}>
            Hello 世界 · 日本語  👩‍💻 🌍 👨‍👩‍👧‍👦
          </Text>
          <Text class="text-sm" style={{ textColor: props.isDark() ? "#CBD5E1" : "#334155" }}>
            مرحبا بالعالم · שלום עולם · 123
          </Text>
        </LiquidGlassCard>

        <LiquidGlassCard title="Typographic Baseline" detail="The line marks the first baseline.">
          <View class="relative py-2 w-full" style={{ posType: 0 }}>
            <Text class="text-xl font-bold" style={{ textColor: props.isDark() ? "#F8FAFC" : "#0F172A" }}>
              Aa Bb Gg Qq · 24pt
            </Text>
            <View
              class="w-full h-[1.5]"
              style={{ height: 1.5, bgColor: "#FF2D55" }}
            />
          </View>
        </LiquidGlassCard>
      </Show>

      {/* 16. IMAGE VIEW */}
      <Show when={props.slug === "image-view"}>
        <LiquidGlassCard
          title="Content Modes & Bundled Wallpapers"
          detail="1:1 square artwork centered without cropping vs Aspect Fill."
          variant="raised"
        >
          <View class="flex-row items-center gap-3 w-full">
            <View class="flex-1 flex-col items-center gap-1">
              <View class="w-[120] h-[96] items-center justify-center overflow-hidden" style={{ width: 120, height: 96, bgColor: "#0F172A22", radius: 14, overflow: 1 }}>
                <Image src="wallpapers/waves-light.png" class="w-[88] h-[88]" style={{ width: 88, height: 88 }} />
              </View>
              <Text class="text-2xs font-bold" style={{ textColor: props.isDark() ? "#CBD5E1" : "#475569" }}>Aspect Fit</Text>
            </View>
            <View class="flex-1 flex-col items-center gap-1">
              <View class="w-[120] h-[96] overflow-hidden" style={{ width: 120, height: 96, radius: 14, overflow: 1 }}>
                <Image src="wallpapers/circles-pink-light.png" class="w-[120] h-[120]" style={{ width: 120, height: 120 }} />
              </View>
              <Text class="text-2xs font-bold" style={{ textColor: props.isDark() ? "#CBD5E1" : "#475569" }}>Aspect Fill</Text>
            </View>
          </View>
        </LiquidGlassCard>
      </Show>

      {/* 17. PROGRESS VIEW */}
      <Show when={props.slug === "progress-view"}>
        <LiquidGlassCard title="ProgressHeroCard" variant="raised">
          <LiquidGlassProgress label="Transferring Assets…" value={animProgress()} />
          <LiquidGlassProgress label="Preparing Workspace… (Bar Style)" value={0.72} barStyle="bar" tone="success" />
          <View class="flex-row flex-wrap gap-2 pt-1">
            <LiquidGlassButton
              label="Advance (+25%)"
              compact
              variant="primary"
              onPress={() => setAnimProgress((p) => Math.min(1, Number((p + 0.25).toFixed(2))))}
            />
            <LiquidGlassButton
              label="Reset to Zero"
              compact
              variant="glass"
              onPress={() => setAnimProgress(0)}
            />
          </View>
        </LiquidGlassCard>
      </Show>

      {/* 18. ACTIVITY INDICATOR */}
      <Show when={props.slug === "activity-indicator"}>
        <LiquidGlassCard title="ActivityIndicatorView" detail="Medium (20 × 20), Large & Playback hidesWhenStopped." variant="raised">
          <View class="flex-row items-center justify-around py-3 w-full">
            <View class="flex-col items-center gap-1.5">
              <LiquidGlassActivityIndicator animating={spinnerRunning()} size="medium" />
              <Text class="text-2xs" style={{ textColor: props.isDark() ? "#94A3B8" : "#64748B" }}>Medium</Text>
            </View>
            <View class="flex-col items-center gap-1.5">
              <LiquidGlassActivityIndicator animating={spinnerRunning()} size="large" color="#007AFF" />
              <Text class="text-2xs" style={{ textColor: props.isDark() ? "#94A3B8" : "#64748B" }}>Large · Tinted</Text>
            </View>
            <View class="flex-col items-center gap-1.5">
              <LiquidGlassActivityIndicator animating={spinnerRunning()} size="large" hidesWhenStopped color="#FF2D55" />
              <Text class="text-2xs" style={{ textColor: props.isDark() ? "#94A3B8" : "#64748B" }}>hidesWhenStopped</Text>
            </View>
          </View>
          <LiquidGlassSwitch
            label="Animating"
            detail="Toggle live spoke rotation"
            value={spinnerRunning()}
            onChange={setSpinnerRunning}
          />
        </LiquidGlassCard>
      </Show>

      {/* 19. VIEW */}
      <Show when={props.slug === "view"}>
        <LiquidGlassCard
          title="Block Corner Radius & Clipping"
          detail="The view on the left lets its child extend past its bounds; the one on the right clips it."
          variant="raised"
        >
          <View class="flex-row items-center justify-around py-3 w-full">
            <View
              class="relative w-[112] h-[84] p-2"
              style={{ posType: 0, width: 112, height: 84, bgColor: "#3B82F633", borderColor: "#3B82F6", borderWidth: 1, radius: cornerRad() }}
            >
              <View class="w-[124] h-[36] items-center justify-center" style={{ width: 124, height: 36, bgColor: "#EC4899CC", radius: 10 }}>
                <Text class="text-2xs font-bold" style={{ textColor: "#FFFFFF" }}>Unclipped</Text>
              </View>
            </View>

            <View
              class="relative w-[112] h-[84] p-2 overflow-hidden"
              style={{ posType: 0, width: 112, height: 84, overflow: 1, bgColor: "#10B98133", borderColor: "#10B981", borderWidth: 1, radius: cornerRad() }}
            >
              <View class="w-[124] h-[36] items-center justify-center" style={{ width: 124, height: 36, bgColor: "#8B5CF6CC", radius: 10 }}>
                <Text class="text-2xs font-bold" style={{ textColor: "#FFFFFF" }}>Clipped</Text>
              </View>
            </View>
          </View>
          <LiquidGlassSlider
            label={`Continuous Corner Radius (${cornerRad()}pt)`}
            value={cornerRad()}
            min={0}
            max={42}
            onChange={setCornerRad}
          />
        </LiquidGlassCard>
      </Show>

      {/* 20. SCROLL VIEW */}
      <Show when={props.slug === "scroll-view"}>
        <LiquidGlassCard
          title="ScrollIndicators & ScrollEdgeEffect"
          detail="Scroll vertically through chromatic bands beneath the top glass navigation bar."
          variant="raised"
        >
          <For each={[1, 2, 3, 4, 5, 6]}>
            {(band) => (
              <ChromaticArtworkStage label={`Scrollable Band #${band}`} compact />
            )}
          </For>
        </LiquidGlassCard>
      </Show>

      {/* 21. COLLECTION VIEW */}
      <Show when={props.slug === "collection-view"}>
        <LiquidGlassCard
          title="Featured (group paging, centered)"
          detail={`Selected cell: ${selectedCollectionItem()}`}
          variant="raised"
        >
          <View class="flex-row gap-2.5 w-full">
            {["Featured 1", "Featured 2"].map((item, i) => (
              <Focusable class="flex-1" onPress={() => setSelectedCollectionItem(item)}>
                <View
                  class="h-[88] p-3 justify-end"
                  style={{
                    height: 88,
                    bgColor: i === 0 ? "#2563EB" : "#DB2777",
                    radius: 16,
                  }}
                >
                  <Text class="text-xs font-bold" style={{ textColor: "#FFFFFF", hitPass: 1 }}>{item}</Text>
                </View>
              </Focusable>
            ))}
          </View>
        </LiquidGlassCard>

        <LiquidGlassCard title="Grid (pinned header, background)">
          <View class="flex-row flex-wrap gap-2 w-full">
            {["Grid A", "Grid B", "Grid C", "Grid D"].map((g) => (
              <Focusable onPress={() => setSelectedCollectionItem(g)}>
                <View
                  class="w-[146] h-[54] items-center justify-center"
                  style={{
                    width: 146,
                    height: 54,
                    bgColor: selectedCollectionItem() === g ? "#007AFF28" : props.isDark() ? "#FFFFFF12" : "#0F172A0A",
                    borderColor: selectedCollectionItem() === g ? "#007AFF" : "#94A3B844",
                    borderWidth: 1,
                    radius: 14,
                  }}
                >
                  <Text class="text-xs font-bold" style={{ textColor: props.isDark() ? "#F8FAFC" : "#0F172A", hitPass: 1 }}>
                    {g}
                  </Text>
                </View>
              </Focusable>
            ))}
          </View>
        </LiquidGlassCard>

        <LiquidGlassCard title="List">
          <View class="flex-col gap-1.5 w-full">
            {["Compositional Row 1", "Compositional Row 2", "Compositional Row 3"].map((r) => (
              <LiquidGlassListTile
                title={r}
                selected={selectedCollectionItem() === r}
                onPress={() => setSelectedCollectionItem(r)}
              />
            ))}
          </View>
        </LiquidGlassCard>
      </Show>
    </View>
  );
}

/** High-contrast overlapping color discs (`VisualEffectShowcaseView` parity). */
function OverlappingDiscsBackdrop(props: { isDark: () => boolean }): JSX.Element {
  return (
    <View
      class="absolute inset-0 w-full h-full overflow-hidden"
      style={{
        posType: 1,
        insetT: 0,
        insetR: 0,
        insetB: 0,
        insetL: 0,
        bgColor: props.isDark() ? "#0B1120" : "#F8FAFC",
        overflow: 1,
        hitPass: 1,
      }}
    >
      <View
        class="absolute left-[18] top-[14] w-[124] h-[124]"
        style={{ posType: 1, insetL: 18, insetT: 14, width: 124, height: 124, bgColor: "#FF2D55", radius: 999, hitPass: 1 }}
      />
      <View
        class="absolute left-[96] top-[34] w-[132] h-[132]"
        style={{ posType: 1, insetL: 96, insetT: 34, width: 132, height: 132, bgColor: "#007AFF", radius: 999, hitPass: 1 }}
      />
      <View
        class="absolute right-[22] top-[16] w-[118] h-[118]"
        style={{ posType: 1, insetR: 22, insetT: 16, width: 118, height: 118, bgColor: "#34C759", radius: 999, hitPass: 1 }}
      />
      <View
        class="absolute left-[146] bottom-[10] w-[112] h-[112]"
        style={{ posType: 1, insetL: 146, insetB: 10, width: 112, height: 112, bgColor: "#FF9500", radius: 999, hitPass: 1 }}
      />
    </View>
  );
}

function ChromaticArtworkStage(props: { label: string; compact?: boolean }): JSX.Element {
  const h = () => (props.compact ? 68 : 112);
  return (
    <View
      class="relative w-full overflow-hidden items-center justify-center"
      style={{
        posType: 0,
        height: h(),
        bgColor: "#1E1B4B",
        radius: 16,
        overflow: 1,
      }}
    >
      <View
        class="absolute left-[-10] top-[-18] w-[130] h-[130]"
        style={{ posType: 1, insetL: -10, insetT: -18, width: 130, height: 130, bgColor: "#EC4899AA", radius: 999, hitPass: 1 }}
      />
      <View
        class="absolute right-[8] bottom-[-24] w-[140] h-[140]"
        style={{ posType: 1, insetR: 8, insetB: -24, width: 140, height: 140, bgColor: "#06B6D4AA", radius: 999, hitPass: 1 }}
      />
      <LiquidGlassSurface
        material="clear"
        priority="normal"
        shape="pill"
        radius={999}
        contentClass="px-4 py-1.5"
      >
        <Text class="text-xs font-bold" style={{ textColor: "#FFFFFF", hitPass: 1 }}>
          {props.label}
        </Text>
      </LiquidGlassSurface>
    </View>
  );
}
