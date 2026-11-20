import { For, Show, createSignal } from "solid-js";
import { ScrollablePage } from "@pocket/ui";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import { DiagnosticsPanel } from "../components/settings-panels.tsx";
import type { Studio } from "../state/studio.ts";
import { HairlineH, StateChip, StudioButton } from "../components/workbench-ui.tsx";

const PAGE_LINES = 150;

/** Reusable Build Log + Clickable Diagnostics pane embedded inside `.console-dock` (Tab 1) and `ConsolePage`. */
export function ConsolePane(props: { studio: Studio; showHeaderTitle?: boolean }) {
  const s = props.studio;
  const build = fromStore(s.build.store);
  const diag = fromStore(s.diagnostics.store);
  const [window, setWindow] = createSignal(PAGE_LINES);
  const lines = () => { build(); return s.build.tail(window()); };
  const size = () => { build(); return s.build.logSize(); };
  const status = () => {
    const b = build();
    if (b.busy) return "构建中";
    if (b.error) return "失败";
    const st = b.status;
    if (st && st.builtRevision !== null && st.builtRevision === st.revision) return "已构建（最新）";
    if (st && st.builtRevision !== null) return "已构建（源码已更改）";
    return "尚未构建";
  };
  const statusTone = () => (build().error ? "bad" : build().busy ? "warn" : build().status?.builtRevision !== null && build().status?.builtRevision !== undefined ? "good" : "neutral");

  const open = (file: string, line: number, column: number) => {
    if (!file) return;
    s.setPage("source");
    void s.workspace.open(file, { line, column });
  };

  return (
    <View class="flex-col flex-1 h-full w-full" style={{ bgColor: C.bgRaised, minH: 0 }}>
      {/* Action & Status Bar */}
      <View class="flex-row items-center justify-between gap-2 px-3 py-1.5 w-full" style={{ bgColor: C.surface, shrink: 0 }}>
        <View class="flex-row items-center gap-2 flex-wrap" style={{ minW: 0 }}>
          <Show when={props.showHeaderTitle}>
            <Text class="text-sm font-bold" style={{ textColor: C.text }}>控制台</Text>
          </Show>
          <StateChip label={status()} tone={statusTone()} />
          <Show when={build().stream !== "closed"}>
            <Text class="text-2xs" style={{ textColor: C.faint }}>
              {build().stream === "open" ? "事件流已连接" : build().stream === "retrying" ? "事件流重连中…" : build().stream === "connecting" ? "事件流连接中…" : ""}
            </Text>
          </Show>
          <Text class="text-2xs" style={{ textColor: C.muted }}>
            {`构建日志 · 显示最近 ${Math.min(window(), size())} / ${size()} 行（缓冲上限 2000）`}
          </Text>
        </View>
        <View class="flex-row items-center gap-1.5" style={{ shrink: 0 }}>
          <StudioButton
            label={build().busy ? "构建中…" : "开始构建"}
            kind="primary"
            size="xs"
            disabled={build().busy || !build().project}
            onPress={() => void s.build.start()}
          />
          <StudioButton label="取消" kind="quiet" size="xs" disabled={!build().busy} onPress={() => void s.build.cancel()} />
          <StudioButton label="清空日志" kind="text" size="xs" onPress={() => s.build.clearLogs()} />
          <StudioButton label="导出诊断" kind="secondary" size="xs" disabled={!build().project} onPress={() => void s.diagnostics.run()} />
        </View>
      </View>
      <HairlineH />

      {/* Body: Diagnostics Banner + Streamed Log Lines */}
      <View class="flex-col gap-2 px-3 py-2 flex-1 w-full" style={{ minH: 0 }}>
        <ScrollablePage>
          <View class="flex-col gap-2 w-full">
            <Show when={diag().phase !== "idle"}>
              <DiagnosticsPanel studio={s} title="诊断导出" />
            </Show>
            <Show when={build().error}>
              <Text class="text-xs font-mono" style={{ textColor: C.danger }}>{build().error}</Text>
            </Show>
            <Show when={build().diagnostics.length > 0}>
              <View
                class="flex-col gap-1 p-2.5 rounded-lg w-full"
                style={{ bgColor: C.dangerSoft, borderColor: C.dangerBorder, borderWidth: 1, radius: 7 }}
              >
                <Text class="text-xs font-bold" style={{ textColor: C.text }}>
                  {`诊断（${build().diagnostics.length}）· 点击跳转到源码`}
                </Text>
                <For each={build().diagnostics.slice(0, 20)}>
                  {(d) => (
                    <Focusable class="py-0.5" onPress={() => open(d.file, d.line, d.column)}>
                      <Text class="text-xs font-mono" style={{ textColor: d.severity === "warning" ? C.warn : C.danger }}>
                        {`${d.file || "(项目)"}:${d.line}:${d.column}  ${d.message}`}
                      </Text>
                    </Focusable>
                  )}
                </For>
              </View>
            </Show>
            <Show when={size() > window()}>
              <StudioButton label="显示更早的日志" kind="quiet" size="xs" onPress={() => setWindow(window() + PAGE_LINES)} />
            </Show>
            <Show when={size() === 0}>
              <Text class="text-xs font-mono" style={{ textColor: C.faint }}>暂无日志。</Text>
            </Show>
            <For each={lines()}>
              {(line) => (
                <Text class="text-xs font-mono" style={{ textColor: line.gap ? C.warn : C.body }}>
                  {line.text.length ? line.text : " "}
                </Text>
              )}
            </For>
          </View>
        </ScrollablePage>
      </View>
    </View>
  );
}

export function ConsolePage(props: { studio: Studio }) {
  return <ConsolePane studio={props.studio} showHeaderTitle />;
}
