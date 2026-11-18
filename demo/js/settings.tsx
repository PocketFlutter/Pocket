import { Show, createSignal, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import {
  MobileAlert,
  MobileBadge,
  MobileButton,
  MobileCard,
  MobileDialog,
  MobileListTile,
  MobileParagraph,
  MobileSegmentedControl,
  ScrollablePage,
  useMobileTheme,
} from "@pocket/ui";
import { version } from "./package.json";
import type {
  AccentColor,
  DemoEvent,
  DemoState,
  InterfaceDensity,
  MiniAppPresentationMode,
  ShowcaseSkin,
} from "./state.ts";

type Appearance = {
  dark: boolean;
  accent: AccentColor;
  density: InterfaceDensity;
  presentationStyle?: MiniAppPresentationMode;
  skin?: ShowcaseSkin;
};

/** Only recognized preferences cross the persisted-data boundary. */
export function readAppearance(value: unknown): Appearance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  return {
    dark: record.dark === true,
    accent:
      record.accent === "violet" || record.accent === "teal" || record.accent === "rose"
        ? record.accent
        : "blue",
    density:
      record.density === "touch" || record.density === "desktop" ? record.density : "auto",
    ...(record.presentationStyle === "page" ? { presentationStyle: "page" as const } : {}),
    ...(record.skin === "looseleaf" || record.skin === "arc" || record.skin === "liquid-glass"
      ? { skin: record.skin }
      : {}),
  };
}

export function storedAppearance(state: DemoState): Appearance & { version: number } {
  return {
    version: 1,
    dark: state.mobileDark,
    accent: state.accentColor,
    density: state.interfaceDensity,
    ...(state.miniAppPresentationStyle === "page"
      ? { presentationStyle: "page" as const }
      : {}),
    ...(state.uiSkin !== "default" ? { skin: state.uiSkin } : {}),
  };
}

export function SettingsPage(props: {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  ready: () => boolean;
  status: () => string;
}): JSX.Element {
  const theme = useMobileTheme();
  const [resetOpen, setResetOpen] = createSignal(false);
  return (
    <ScrollablePage>
      <View class="flex-col gap-4 p-4 pb-6">
        <Show
          when={props.ready()}
          fallback={
            <MobileAlert
              title="Loading preferences"
              body="Getting your saved appearance from this device."
              tone="info"
            />
          }
        >
          <MobileCard title="Appearance" detail="Choose how Pocket looks, everywhere.">
            <Text
              class={
                theme().name === "dark"
                  ? "text-sm font-bold text-[#FAFAFA]"
                  : "text-sm font-bold text-[#09090B]"
              }
            >
              Theme
            </Text>
            <MobileSegmentedControl
              items={[
                { id: "light", label: "Light" },
                { id: "dark", label: "Dark" },
              ]}
              active={props.state().mobileDark ? "dark" : "light"}
              onChange={(id) =>
                props.dispatch({ type: "setMobileDark", value: id === "dark" })
              }
            />
            <Text
              class={
                theme().name === "dark"
                  ? "text-sm font-bold text-[#FAFAFA]"
                  : "text-sm font-bold text-[#09090B]"
              }
            >
              Accent color
            </Text>
            <MobileSegmentedControl
              accentActive
              items={[
                { id: "blue", label: "Blue" },
                { id: "violet", label: "Violet" },
                { id: "teal", label: "Teal" },
                { id: "rose", label: "Rose" },
              ]}
              active={props.state().accentColor}
              onChange={(id) =>
                props.dispatch({ type: "setAccentColor", value: id as AccentColor })
              }
            />
            <Text
              class={
                theme().name === "dark"
                  ? "text-sm font-bold text-[#FAFAFA]"
                  : "text-sm font-bold text-[#09090B]"
              }
            >
              UI skin
            </Text>
            <MobileSegmentedControl
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
          </MobileCard>
          <MobileCard
            title="Interface density"
            detail="Automatic adapts to your window size."
          >
            <MobileSegmentedControl
              items={[
                { id: "auto", label: "Automatic" },
                { id: "touch", label: "Comfortable" },
                { id: "desktop", label: "Compact" },
              ]}
              active={props.state().interfaceDensity}
              onChange={(id) =>
                props.dispatch({
                  type: "setInterfaceDensity",
                  value: id as InterfaceDensity,
                })
              }
            />
          </MobileCard>
          <MobileCard
            title="MiniApp presentation"
            detail="Default transition when a manifest sets no presentation.style."
          >
            <MobileSegmentedControl
              items={[
                { id: "sheet", label: "Sheet (Bottom-Up)" },
                { id: "page", label: "Page (Push)" },
              ]}
              active={props.state().miniAppPresentationStyle}
              onChange={(id) =>
                props.dispatch({
                  type: "setMiniAppPresentationStyle",
                  value: id as MiniAppPresentationMode,
                })
              }
            />
            <MobileParagraph
              text='Profile uses "page"; Lobby & Lantern follow this setting.'
              class={
                theme().name === "dark"
                  ? "text-xs text-[#A1A1AA]"
                  : "text-xs text-[#71717A]"
              }
            />
          </MobileCard>
          <MobileCard title="Your preferences">
            <MobileListTile title="Device storage" detail={props.status()} />
            <MobileButton
              label="Reset appearance"
              kind="outlined"
              onPress={() => setResetOpen(true)}
            />
          </MobileCard>
        </Show>
        <MobileCard
          title="About Pocket"
          detail="An interactive collection of components, motion and device experiences."
        >
          <MobileListTile
            title="Version"
            detail={version}
            trailing={<MobileBadge label="SHOWCASE" tone="neutral" />}
          />
          <MobileListTile
            title="Device capabilities"
            detail="Camera, photos, location and other device features ask for access when you use them."
          />
          <View class="flex-row flex-wrap items-center gap-2">
            <MobileButton
              label="Open Skin Studio"
              kind="tonal"
              compact
              onPress={() => props.dispatch({ type: "navigate", route: "skins" })}
            />
            <MobileButton
              label="Explore device capabilities"
              kind="text"
              onPress={() => props.dispatch({ type: "navigate", route: "hardware" })}
            />
          </View>
        </MobileCard>
        <MobileDialog
          open={resetOpen()}
          title="Reset appearance?"
          body="Restore the default UI skin, light theme, blue accent, automatic density and bottom-up sheet MiniApp presentation. Your other data stays on this device."
          confirmLabel="Reset"
          onConfirm={() => {
            props.dispatch({ type: "resetAppearance" });
            setResetOpen(false);
          }}
          onClose={() => setResetOpen(false)}
        />
      </View>
    </ScrollablePage>
  );
}
