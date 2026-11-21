import { Show, type JSX } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { C } from "../ui/theme.ts";
import { HairlineH } from "./workbench-ui.tsx";

/** A titled Web-Preview-styled inspector/workbench card (`border: 1px solid #232A38`, `#0D1016` body + `#11151D` header). */
export function Panel(props: { title?: string; eyebrow?: string; note?: string; right?: JSX.Element; tone?: "default" | "blue" | "emerald" | "warn"; children: JSX.Element }) {
  const palette = () => {
    switch (props.tone) {
      case "blue":
        return { bg: C.primarySoft, headerBg: "#152644", border: C.primaryBorder };
      case "emerald":
        return { bg: C.okSoft, headerBg: "#112B24", border: C.okBorder };
      case "warn":
        return { bg: C.warnSoft, headerBg: "#2E2410", border: C.warnBorder };
      default:
        return { bg: C.bgRaised, headerBg: C.surface, border: C.line };
    }
  };
  return (
    <View
      class="flex-col rounded-lg overflow-hidden w-full"
      style={{
        bgColor: palette().bg,
        borderColor: palette().border,
        borderWidth: 1,
        radius: 8,
      }}
    >
      <Show when={props.title || props.eyebrow || props.right}>
        <View class="flex-row items-center justify-between gap-2 px-2.5 py-1.5 w-full" style={{ bgColor: palette().headerBg }}>
          <View class="flex-row items-center gap-2 flex-1" style={{ minW: 0 }}>
            <Show when={props.title}>
              <Text class="text-xs font-bold" style={{ textColor: C.text }}>{props.title}</Text>
            </Show>
            <Show when={props.eyebrow}>
              <Text class="text-2xs font-bold" style={{ textColor: C.faint }}>{props.eyebrow}</Text>
            </Show>
          </View>
          {props.right}
        </View>
        <HairlineH soft />
      </Show>
      <View class="flex-col gap-1.5 p-2.5 w-full">
        <Show when={props.note}>
          <Text class="text-2xs" style={{ textColor: C.muted }}>{props.note}</Text>
        </Show>
        {props.children}
      </View>
    </View>
  );
}

/** `label: value` row in a subtle inset code/url box with an optional Web-Preview `.text-button` copy trigger. */
export function Field(props: { label: string; value: string | number | undefined; shown?: string; copyLabel?: string; onCopy?: (text: string, label: string) => void; tone?: "ok" | "warn" | "danger" }) {
  const text = () => (props.value === undefined ? "" : String(props.value));
  return (
    <Show when={props.value !== undefined && text().length > 0}>
      <View class="flex-col gap-0.5 w-full">
        <Text class="text-2xs font-bold" style={{ textColor: C.faint }}>{props.label}</Text>
        <View
          class="flex-row items-center gap-2 px-2 py-1 rounded-md w-full"
          style={{
            bgColor: C.surface,
            borderColor: C.line,
            borderWidth: 1,
            radius: 6,
          }}
        >
          <Text class="text-xs font-mono flex-1" style={{ textColor: props.tone ? C[props.tone] : C.info }}>{props.shown ?? text()}</Text>
          <Show when={props.onCopy}>
            <Focusable
              class="px-2 py-0.5 rounded"
              style={{ bgColor: C.surface2, borderColor: C.line, borderWidth: 1, radius: 4, shrink: 0 }}
              onPress={() => props.onCopy!(text(), props.copyLabel ?? props.label)}
            >
              <Text class="text-xs font-bold" style={{ textColor: C.info }}>复制</Text>
            </Focusable>
          </Show>
        </View>
      </View>
    </Show>
  );
}

/** One short `label  value` key-value line inside an inspector card. */
export function Line(props: { label: string; value: string | number | undefined; tone?: "ok" | "warn" | "danger" }) {
  return (
    <Show when={props.value !== undefined && String(props.value).length > 0}>
      <View class="flex-row items-center gap-2 w-full">
        <Text class="text-xs" style={{ textColor: C.muted, width: 116 }}>{props.label}</Text>
        <Text class="text-xs flex-1" style={{ textColor: props.tone ? C[props.tone] : C.text }}>{String(props.value)}</Text>
      </View>
    </Show>
  );
}
