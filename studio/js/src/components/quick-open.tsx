import { For, Show } from "solid-js";
import { InputField } from "@pocket/ui";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import { basename, dirname } from "../lib/path.ts";
import type { QuickOpen } from "../state/quick-open.ts";
import { Eyebrow, HairlineH } from "./workbench-ui.tsx";

const VISIBLE_ROWS = 10;

/** Cmd+P overlay: Web-Preview-styled command palette over the ranked project file list. */
export function QuickOpenOverlay(props: { quickOpen: QuickOpen }) {
  const state = fromStore(props.quickOpen.store);
  const window = () => {
    const { results, selected } = state();
    const start = Math.max(0, Math.min(selected - Math.floor(VISIBLE_ROWS / 2), results.length - VISIBLE_ROWS));
    return results.slice(start, start + VISIBLE_ROWS).map((match, i) => ({ match, index: start + i }));
  };
  return (
    <Show when={state().open}>
      <View class="absolute inset-0 z-50 flex-col items-center p-4" style={{ bgColor: "#000000B0" }}>
        <View
          class="flex-col gap-2 p-3 rounded-xl w-full max-w-[540] mt-[44]"
          style={{
            bgColor: C.surface,
            borderColor: C.lineHover,
            borderWidth: 1,
            radius: 11,
            shadow: 2,
          }}
        >
          <View class="flex-row items-center justify-between w-full">
            <Text class="text-sm font-bold" style={{ textColor: C.text }}>快速打开</Text>
            <Eyebrow text="⌘P · 文件模糊检索" />
          </View>
          <InputField
            autoFocus
            value={() => state().query}
            onInput={(v) => props.quickOpen.setQuery(v)}
            onSubmit={() => void props.quickOpen.accept()}
            placeholder="输入文件名，例如 src/app"
          />
          <HairlineH soft />
          <Show when={state().results.length === 0}>
            <Text class="text-xs py-2" style={{ textColor: C.muted }}>没有匹配的文件</Text>
          </Show>
          <For each={window()}>
            {(row) => {
              const selected = () => row.index === state().selected;
              return (
                <Focusable
                  class="px-2.5 py-1.5 rounded-md flex-row items-center justify-between gap-2 w-full"
                  style={{
                    bgColor: selected() ? C.primarySoft : "#00000000",
                    borderColor: selected() ? C.primaryBorder : "#00000000",
                    borderWidth: selected() ? 1 : 0,
                    radius: 6,
                  }}
                  onPress={() => void props.quickOpen.accept(row.index)}
                >
                  <Text class="text-sm font-bold" style={{ textColor: C.text }}>{basename(row.match.path)}</Text>
                  <Text class="text-xs font-mono" style={{ textColor: selected() ? C.info : C.faint }}>{dirname(row.match.path)}</Text>
                </Focusable>
              );
            }}
          </For>
          <HairlineH soft />
          <Text class="text-2xs" style={{ textColor: C.faint }}>↑↓ 选择 · Enter 打开 · Esc 关闭</Text>
        </View>
      </View>
    </Show>
  );
}
