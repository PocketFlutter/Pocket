import { Show, createSignal, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import {
  ScrollablePage,
  SkinAlert,
  SkinBadge,
  SkinButton,
  SkinCard,
  SkinDialog,
  SkinListTile,
  SkinParagraph,
  SkinSegmentedControl,
  useUiSkin,
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
  const { tokens } = useUiSkin();
  const [resetOpen, setResetOpen] = createSignal(false);
  return (
    <ScrollablePage>
      <View class="flex-col gap-4 p-4 pb-6">
        <Show
          when={props.ready()}
          fallback={
            <SkinAlert
              title="Loading preferences"
              body="Getting your saved appearance from this device."
              tone="info"
            />
          }
        >
          <SkinCard title="Appearance" detail="Choose how Pocket looks, everywhere.">
            <Text
              class="text-sm font-bold"
              style={{ textColor: tokens().ink }}
            >
              Theme
            </Text>
            <SkinSegmentedControl
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
              class="text-sm font-bold"
              style={{ textColor: tokens().ink }}
            >
              Accent color
            </Text>
            <SkinSegmentedControl
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
              class="text-sm font-bold"
              style={{ textColor: tokens().ink }}
            >
              UI skin
            </Text>
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
          </SkinCard>
          <SkinCard
            title="Interface density"
            detail="Automatic adapts to your window size."
          >
            <SkinSegmentedControl
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
          </SkinCard>
          <SkinCard
            title="MiniApp presentation"
            detail="Default transition when a manifest sets no presentation.style."
          >
            <SkinSegmentedControl
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
            <SkinParagraph
              text='Profile uses "page"; Lobby follows this setting.'
              muted
            />
          </SkinCard>
          <SkinCard title="Your preferences">
            <SkinListTile title="Device storage" detail={props.status()} />
            <SkinButton
              label="Reset appearance"
              variant="outline"
              onPress={() => setResetOpen(true)}
            />
          </SkinCard>
        </Show>
        <SkinCard
          title="About Pocket"
          detail="An interactive collection of components, motion and device experiences."
        >
          <SkinListTile
            title="Version"
            detail={version}
            trailing={<SkinBadge label="SHOWCASE" tone="neutral" />}
          />
          <SkinListTile
            title="Device capabilities"
            detail="Camera, photos, location and other device features ask for access when you use them."
          />
          <View class="flex-row flex-wrap items-center gap-2">
            <SkinButton
              label="Open Skin Studio"
              variant="tonal"
              compact
              onPress={() => props.dispatch({ type: "navigate", route: "skins" })}
            />
            <SkinButton
              label="Explore device capabilities"
              variant="ghost"
              onPress={() => props.dispatch({ type: "navigate", route: "hardware" })}
            />
          </View>
        </SkinCard>
        <SkinDialog
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
