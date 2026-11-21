// Swappable editor widget selected by the `editor` setting ("code" CodeView default, "input" InputField fallback).
import { For, Show, createEffect, createSignal, on, type JSX } from "solid-js";
import { InputField, inlineFontSlot } from "@pocket/ui";
import { CodeView, type CodeViewHandle } from "@pocket/ui/code-view";
import { single, type CodeEditor } from "@pocket/ui/code";
import { after } from "@pocketjs/framework/clock";
import { Text, View } from "@pocketjs/framework/solid/components";
import { C, CODE_THEME } from "../ui/theme.ts";
import { excerpt, type Diagnostic } from "../lib/diagnostics.ts";
import type { JumpTarget } from "../state/workspace.ts";
import { HairlineH } from "./workbench-ui.tsx";

export interface EditorPaneProps {
  path: string;
  text: string;
  onChange: (text: string) => void;
  onSave: () => void;
  diagnostics: readonly Diagnostic[];
  jump?: JumpTarget;
  buffer?: (path: string) => CodeEditor;
  reload?: number;
  clipboard?: { readText(): Promise<string | null>; writeText(text: string): Promise<void> };
  findRequest?: number;
  caretLine?: (path: string) => number | undefined;
  onCaretLine?: (path: string, line: number) => void;
  focus?: number;
  onFocused?: (seq: number) => void;
  onKeyDown?: (key: string) => boolean | void;
}
export type EditorPane = (props: EditorPaneProps) => JSX.Element;

/** M2 fallback editor: multi-line InputField plus diagnostic context strip. */
export const InputFieldEditor: EditorPane = (props) => (
  <View class="flex-col gap-2 p-2.5 w-full">
    <Show when={props.jump}>
      {(jump) => (
        <View
          class="flex-col p-2.5 rounded-lg gap-1 w-full"
          style={{ bgColor: C.warnSoft, borderColor: C.warnBorder, borderWidth: 1, radius: 7 }}
        >
          <Text class="text-xs font-bold" style={{ textColor: C.warn }}>{`第 ${jump().line} 行，第 ${jump().column} 列`}</Text>
          <For each={excerpt(props.text, jump().line)}>
            {(row) => (
              <Text
                class="text-xs font-mono"
                style={{ textColor: row.number === jump().line ? C.danger : C.body }}
              >
                {`${row.number}  ${row.text.length ? row.text : " "}`}
              </Text>
            )}
          </For>
        </View>
      )}
    </Show>
    <Show when={props.diagnostics.length > 0}>
      <View
        class="flex-col gap-1 p-2 rounded-lg w-full"
        style={{ bgColor: C.dangerSoft, borderColor: C.dangerBorder, borderWidth: 1, radius: 7 }}
      >
        <For each={props.diagnostics.slice(0, 5)}>
          {(d) => (
            <Text class="text-xs font-mono" style={{ textColor: d.severity === "warning" ? C.warn : C.danger }}>
              {`${d.line}:${d.column}  ${d.message}`}
            </Text>
          )}
        </For>
      </View>
    </Show>
    <InputField multiline minLines={12} value={() => props.text} onInput={(value) => props.onChange(value)} placeholder="空文件" />
    <Text class="text-xs" style={{ textColor: C.faint }}>Cmd/Ctrl+S 或工具栏“保存”写入磁盘</Text>
  </View>
);

/** One CodeView over the document's buffer, keyed by path so tab switches swap buffers cleanly. */
function CodeSurface(props: EditorPaneProps & { path: string }): JSX.Element {
  const editor = props.buffer!(props.path);
  let handle: CodeViewHandle | undefined;
  const [cursor, setCursor] = createSignal({ line: 0, column: 0 });
  const lines = (): number => editor.buffer.lineCount;
  const marks = () => props.diagnostics.map((d) => ({ line: d.line - 1, column: d.column - 1, severity: d.severity, message: d.message }));
  const goTo = (target: { line: number; column: number }): void => {
    if (!handle) return;
    const b = editor.buffer;
    const line = Math.min(Math.max(target.line - 1, 0), b.lineCount - 1);
    const column = Math.min(Math.max(target.column - 1, 0), b.lineLength(line));
    editor.setSelection(single(b.offsetAt(line, column)));
    handle.scrollToLine(Math.max(0, line - 5));
    handle.refresh();
    handle.focus();
  };
  let applied = 0;
  const jumpNow = (): void => {
    const jump = props.jump;
    if (jump && jump.seq !== applied) {
      applied = jump.seq;
      goTo(jump);
    }
  };
  after(0.1, () => {
    const last = props.caretLine?.(props.path);
    if (!props.jump && last !== undefined && handle) handle.scrollToLine(Math.max(0, last - 8));
    jumpNow();
    focusNow();
  });
  let focusApplied = 0;
  const focusNow = (): void => {
    const seq = props.focus;
    if (!seq || seq === focusApplied || !handle) return;
    focusApplied = seq;
    handle.focus();
    props.onFocused?.(seq);
  };
  createEffect(on(() => props.focus, () => focusNow(), { defer: true }));
  createEffect(on(() => props.jump?.seq, () => { if (handle) jumpNow(); }, { defer: true }));
  createEffect(on(() => props.reload, () => handle?.refresh(), { defer: true }));
  createEffect(on(() => props.findRequest, () => { if (handle) { handle.focus(); handle.openFind(); } }, { defer: true }));
  return (
    <View class="flex-col flex-1 w-full" style={{ bgColor: C.bgRaised, minH: 0 }}>
      <View class="flex-1 w-full" style={{ minH: 0 }}>
        <CodeView
          editor={editor}
          path={props.path}
          theme={CODE_THEME}
          fontSlot={inlineFontSlot("body")}
          diagnostics={marks()}
          clipboard={props.clipboard}
          onIntent={(intent) => { if (intent.type === "save") props.onSave(); }}
          onKeyDown={(key) => props.onKeyDown?.(key)}
          onCursorChange={(c) => {
            props.onCaretLine?.(props.path, c.line);
            setCursor({ line: c.line, column: c.column });
          }}
          ref={(h) => { handle = h; }}
        />
      </View>
      <HairlineH />
      <View class="flex-row items-center justify-between px-3 w-full" style={{ height: 24, bgColor: C.surface, shrink: 0 }}>
        <Text class="text-xs" style={{ textColor: C.muted }}>
          {`第 ${cursor().line + 1} 行，第 ${cursor().column + 1} 列 · 共 ${lines()} 行 · Cmd+S 保存 · Cmd+F 查找`}
        </Text>
      </View>
    </View>
  );
}

export const CodeViewEditor: EditorPane = (props) => (
  <Show when={props.path} keyed>
    {(path) => <CodeSurface {...props} path={path} />}
  </Show>
);

export const editorPanes: Record<"input" | "code", { pane: EditorPane; selfScrolling: boolean }> = {
  input: { pane: InputFieldEditor, selfScrolling: false },
  code: { pane: CodeViewEditor, selfScrolling: true },
};
export const resolveEditor = (kind: "input" | "code"): { pane: EditorPane; selfScrolling: boolean } => editorPanes[kind];
