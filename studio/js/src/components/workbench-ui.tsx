// Shared Desktop IDE Workbench visual primitives matching sdk/editor/client/editor.css 1:1.
import { For, Show, type JSX } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { C } from "../ui/theme.ts";

export type ChipTone = "neutral" | "good" | "warn" | "bad" | "info";

/** Crisp 1px horizontal divider (`border-bottom` / `border-top` equivalent in PocketJS). */
export function HairlineH(props: { soft?: boolean }) {
  return <View class="w-full" style={{ height: 1, bgColor: props.soft ? C.lineSoft : C.line }} />;
}

/** Crisp 1px vertical divider (`border-left` / `border-right` equivalent in PocketJS). */
export function HairlineV(props: { soft?: boolean }) {
  return <View class="h-full" style={{ width: 1, bgColor: props.soft ? C.lineSoft : C.line }} />;
}

/** `.eyebrow` — 10px bold muted label. */
export function Eyebrow(props: { text: string; color?: string }) {
  return <Text class="text-2xs font-bold" style={{ textColor: props.color ?? C.faint }}>{props.text}</Text>;
}

/** `.state-chip` / `.meta-chip` — compact pill badge with semantic border & fill. */
export function StateChip(props: { label: string; tone?: ChipTone }) {
  const tone = () => props.tone ?? "neutral";
  const palette = () => {
    switch (tone()) {
      case "good":
        return { bg: C.okSoft, border: C.okBorder, text: C.ok };
      case "warn":
        return { bg: C.warnSoft, border: C.warnBorder, text: C.warn };
      case "bad":
        return { bg: C.dangerSoft, border: C.dangerBorder, text: C.danger };
      case "info":
        return { bg: C.primarySoft, border: C.primaryBorder, text: C.info };
      default:
        return { bg: C.bgRaised, border: C.line, text: C.muted };
    }
  };
  return (
    <View
      class="flex-row items-center px-2 py-0.5 rounded-lg"
      style={{
        bgColor: palette().bg,
        borderColor: palette().border,
        borderWidth: 1,
        radius: 10,
        shrink: 0,
      }}
    >
      <Text class="text-2xs font-bold" style={{ textColor: palette().text }}>{props.label}</Text>
    </View>
  );
}

/** `.live-chip` — status pill with a 6px semantic indicator dot (`●`). */
export function LiveChip(props: { label: string; tone?: ChipTone }) {
  const tone = () => props.tone ?? "neutral";
  const palette = () => {
    switch (tone()) {
      case "good":
        return { bg: C.okSoft, border: C.okBorder, text: C.ok, dot: C.okStrong };
      case "warn":
        return { bg: C.warnSoft, border: C.warnBorder, text: C.warn, dot: C.warn };
      case "bad":
        return { bg: C.dangerSoft, border: C.dangerBorder, text: C.danger, dot: C.danger };
      default:
        return { bg: C.bgRaised, border: C.line, text: C.muted, dot: C.faint };
    }
  };
  return (
    <View
      class="flex-row items-center gap-1.5 px-2 py-0.5 rounded-lg"
      style={{
        bgColor: palette().bg,
        borderColor: palette().border,
        borderWidth: 1,
        radius: 10,
        shrink: 0,
      }}
    >
      <View style={{ width: 6, height: 6, radius: 3, bgColor: palette().dot }} />
      <Text class="text-2xs font-bold" style={{ textColor: palette().text }}>{props.label}</Text>
    </View>
  );
}

export type StudioButtonKind = "primary" | "secondary" | "quiet" | "text" | "danger" | "active";

/**
 * `.button.small-button` — Web Preview desktop toolbar & panel button.
 * Supports `.primary` (#3B82F6), `.secondary` (#171C27 + #232A38), `.quiet`, `.text` (#60A5FA), `.danger`, `.active`,
 * plus optional `<kbd class="shortcut-hint">` chord pill (e.g. `⌘B`).
 */
export function StudioButton(props: {
  label: string;
  shortcut?: string;
  kind?: StudioButtonKind;
  size?: "xs" | "sm";
  disabled?: boolean;
  onPress?: () => void;
}) {
  const kind = () => props.kind ?? "secondary";
  const height = () => (props.size === "xs" ? 24 : 28);
  const colors = () => {
    switch (kind()) {
      case "primary":
        return { bg: C.primary, border: "#5A9BFF", text: "#FFFFFF", borderW: 1 };
      case "active":
        return { bg: C.primarySoft, border: C.primary, text: "#FFFFFF", borderW: 1 };
      case "danger":
        return { bg: C.dangerSoft, border: C.dangerBorder, text: C.danger, borderW: 1 };
      case "quiet":
        return { bg: C.bgRaised, border: C.line, text: C.muted, borderW: 1 };
      case "text":
        return { bg: "#00000000", border: "#00000000", text: C.info, borderW: 0 };
      default:
        return { bg: C.surface2, border: C.line, text: C.text, borderW: 1 };
    }
  };
  return (
    <Focusable
      class={props.size === "xs" ? "flex-row items-center justify-center gap-1 px-2 rounded-md" : "flex-row items-center justify-center gap-1.5 px-2.5 rounded-md"}
      style={{
        height: height(),
        bgColor: colors().bg,
        borderColor: colors().border,
        borderWidth: colors().borderW,
        radius: 6,
        opacity: props.disabled ? 0.46 : 1,
        shrink: 0,
      }}
      focusable={!props.disabled}
      onPress={props.disabled ? undefined : props.onPress}
    >
      <Text class="text-xs font-bold" style={{ textColor: colors().text }}>{props.label}</Text>
      <Show when={props.shortcut}>
        <View
          class="px-1 py-0.5 rounded"
          style={{
            bgColor: kind() === "primary" ? "#2563EB" : C.surface3,
            radius: 4,
          }}
        >
          <Text class="text-2xs font-bold" style={{ textColor: kind() === "primary" ? "#DBEAFE" : C.muted }}>
            {props.shortcut}
          </Text>
        </View>
      </Show>
    </Focusable>
  );
}

/** `.mode-capsule` item button in Top Global Command Bar or sub-toolbars. */
export function CapsuleToggle(props: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Focusable
      class="flex-row items-center justify-center px-2.5 rounded"
      style={{
        height: 24,
        bgColor: props.active ? C.surface3 : "#00000000",
        borderColor: props.active ? C.primaryBorder : "#00000000",
        borderWidth: props.active ? 1 : 0,
        radius: 5,
        opacity: props.disabled ? 0.45 : 1,
        shrink: 0,
      }}
      focusable={!props.disabled}
      onPress={props.disabled ? undefined : props.onPress}
    >
      <Text class="text-xs font-bold" style={{ textColor: props.active ? C.text : C.muted }}>{props.label}</Text>
    </Focusable>
  );
}

/** `.console-tabs` / `.inspector-tabs` — tab bar with 2px `#3B82F6` bottom active indicator. */
export function UnderlineTabs<T extends string>(props: {
  items: readonly { id: T; label: string; badge?: string }[];
  active: T;
  onSelect: (id: T) => void;
  equalWidth?: boolean;
  height?: number;
}) {
  const h = () => props.height ?? 34;
  return (
    <View class={props.equalWidth ? "flex-row items-center w-full" : "flex-row items-center gap-1"} style={{ height: h() }}>
      <For each={props.items}>
        {(item, idx) => {
          const isActive = () => props.active === item.id;
          return (
            <View
              class={props.equalWidth ? "flex-row items-center flex-1 h-full" : "flex-row items-center h-full"}
              style={props.equalWidth ? { minW: 0 } : { shrink: 0 }}
            >
              <Focusable
                class={props.equalWidth ? "relative flex-row items-center justify-center gap-1 flex-1 h-full px-2" : "relative flex-row items-center justify-center gap-1 h-full px-2.5"}
                style={{
                  bgColor: props.equalWidth && isActive() ? C.surface : "#00000000",
                  minW: 0,
                }}
                onPress={() => props.onSelect(item.id)}
              >
                <Text class="text-xs font-bold" style={{ textColor: isActive() ? C.text : C.muted }}>{item.label}</Text>
                <Show when={item.badge}>
                  <Text class="text-2xs font-bold" style={{ textColor: isActive() ? C.info : C.faint }}>{item.badge}</Text>
                </Show>
                <Show when={isActive()}>
                  <View
                    class="absolute left-0 right-0 bottom-0"
                    style={{
                      height: 2,
                      bgColor: C.primary,
                      insetL: props.equalWidth ? 0 : 4,
                      insetR: props.equalWidth ? 0 : 4,
                    }}
                  />
                </Show>
              </Focusable>
              <Show when={props.equalWidth && idx() < props.items.length - 1}>
                <HairlineV soft />
              </Show>
            </View>
          );
        }}
      </For>
    </View>
  );
}

/** Compact Web Preview panel header bar (`.panel-header`, 34–36px, bottom hairline). */
export function WorkbenchPanelHeader(props: {
  eyebrow?: string;
  title: string;
  badge?: JSX.Element;
  actions?: JSX.Element;
}) {
  return (
    <View class="flex-col w-full" style={{ bgColor: C.surface, shrink: 0 }}>
      <View class="flex-row items-center justify-between gap-2 px-3 py-1.5 w-full" style={{ minH: 36 }}>
        <View class="flex-row items-center gap-2 flex-1" style={{ minW: 0 }}>
          <Show when={props.eyebrow}>
            <Eyebrow text={props.eyebrow!} />
          </Show>
          <Text class="text-xs font-bold" style={{ textColor: C.text }}>{props.title}</Text>
          {props.badge}
        </View>
        <Show when={props.actions}>
          <View class="flex-row items-center gap-1.5" style={{ shrink: 0 }}>
            {props.actions}
          </View>
        </Show>
      </View>
      <HairlineH />
    </View>
  );
}
