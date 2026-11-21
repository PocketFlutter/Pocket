// Zone C — Docked Source Split (`SourceDock`) & Responsive Source Page (`SourcePage`)
// matching sdk/editor/client/index.html `#source-dock` + `.source-panel` + `.source-foot`.
import { For, Show, createSignal } from "solid-js";
import { ScrollablePage } from "@pocket/ui";
import { SplitPane } from "@pocket/ui/split-pane";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { FileTree } from "../components/file-tree.tsx";
import { PreviewSurface, PREVIEW_PHASE_LABEL } from "../components/preview-surface.tsx";
import { resolveEditor, type EditorPaneProps } from "../components/editor-pane.tsx";
import { C } from "../ui/theme.ts";
import type { Studio } from "../state/studio.ts";
import { isDirty, MAX_INPUT_BYTES } from "../state/workspace.ts";
import { DOCK_WIDTH_LIMITS, TREE_WIDTH_LIMITS } from "../state/settings.ts";
import { basename } from "../lib/path.ts";
import { HairlineH, StateChip, StudioButton } from "../components/workbench-ui.tsx";

/** Web-Preview-styled open file tab bar (keeps exact `${label}${dirty ? " ●" : ""}` and `"×"` close trigger). */
function WorkbenchTabsBar(props: { studio: Studio }) {
  const ws = fromStore(props.studio.workspace.store);
  return (
    <View class="flex-row items-center gap-1 flex-wrap px-2 py-1 w-full" style={{ bgColor: C.bgRaised, minH: 30 }}>
      <Show when={ws().docs.length === 0}>
        <Text class="text-2xs px-1" style={{ textColor: C.faint }}>未打开文件标签</Text>
      </Show>
      <For each={ws().docs}>
        {(doc) => {
          const active = () => ws().active === doc.path;
          const dirty = () => isDirty(doc);
          return (
            <View
              class="relative flex-row items-center rounded-md overflow-hidden"
              style={{
                bgColor: active() ? C.surface2 : C.surface,
                borderColor: active() ? C.primaryBorder : C.line,
                borderWidth: 1,
                radius: 6,
              }}
            >
              <Show when={active()}>
                <View class="absolute left-0 right-0 top-0" style={{ height: 2, bgColor: C.primary }} />
              </Show>
              <Focusable class="px-2.5 py-1" onPress={() => props.studio.workspace.activate(doc.path)}>
                <Text class="text-xs font-bold" style={{ textColor: active() ? C.text : C.muted }}>
                  {`${basename(doc.path)}${dirty() ? " ●" : ""}`}
                </Text>
              </Focusable>
              <Focusable class="px-1.5 py-1" onPress={() => void props.studio.workspace.close(doc.path)}>
                <Text class="text-xs" style={{ textColor: C.faint }}>×</Text>
              </Focusable>
            </View>
          );
        }}
      </For>
    </View>
  );
}

/** Editor pane for the active document: conflict banner, metadata strip, then the swappable editor widget. */
function ActiveEditor(props: { studio: Studio }) {
  const s = props.studio;
  const ws = fromStore(s.workspace.store);
  const settings = fromStore(s.settings.store);
  const build = fromStore(s.build.store);
  const doc = () => ws().docs.find((d) => d.path === ws().active);
  const Editor = (p: EditorPaneProps) => resolveEditor(settings().editor).pane(p);
  const tooBigForInput = () => settings().editor === "input" && (doc()?.bytes ?? 0) > MAX_INPUT_BYTES;
  const own = () => build().diagnostics.filter((d) => d.file === doc()?.path);
  const commands = fromStore(s.commands.requests);

  return (
    <Show
      when={doc()}
      fallback={
        <View class="flex-col items-center justify-center gap-1.5 flex-1 p-4 w-full" style={{ bgColor: C.bgRaised }}>
          <Text class="text-sm font-bold" style={{ textColor: C.muted }}>从左侧选择文件开始编辑。</Text>
          <Text class="text-2xs" style={{ textColor: C.faint }}>支持 Cmd+P 模糊搜索打开文件 · Cmd+S 保存 · Cmd+B 构建</Text>
        </View>
      }
    >
      {(d) => (
        <View class="flex-col flex-1 w-full" style={{ bgColor: C.bgRaised, minH: 0 }}>
          <Show when={d().conflict}>
            <View
              class="flex-row items-center justify-between gap-2 px-3 py-2 w-full"
              style={{ bgColor: C.warnSoft, borderColor: C.warnBorder, borderWidth: 1, shrink: 0 }}
            >
              <Text class="text-xs font-bold flex-1" style={{ textColor: C.warn }}>
                {d().conflict?.kind === "deleted" ? "此文件已在磁盘上被删除" : "此文件在磁盘上被外部修改"}
              </Text>
              <View class="flex-row gap-1.5" style={{ shrink: 0 }}>
                <StudioButton label="保留我的版本" kind="secondary" size="xs" onPress={() => s.workspace.resolveConflict(d().path, "mine")} />
                <StudioButton
                  label={d().conflict?.kind === "deleted" ? "关闭标签" : "载入磁盘版本"}
                  kind="primary"
                  size="xs"
                  onPress={() => s.workspace.resolveConflict(d().path, "theirs")}
                />
              </View>
            </View>
          </Show>
          <Show when={d().status === "loading"}>
            <View class="p-3"><Text class="text-sm" style={{ textColor: C.muted }}>正在读取…</Text></View>
          </Show>
          <Show when={d().status === "blocked" || d().status === "error"}>
            <View class="p-3"><Text class="text-sm" style={{ textColor: C.warn }}>{d().message ?? "无法打开"}</Text></View>
          </Show>
          <Show when={d().status === "ready"}>
            {/* File metadata bar (`.source-header` secondary strip) */}
            <View class="flex-row items-center justify-between px-3 py-1 w-full" style={{ bgColor: C.surface, shrink: 0 }}>
              <Text class="text-xs font-mono" style={{ textColor: isDirty(d()) ? C.warn : C.muted }}>
                {`${d().path} · ${d().bytes} 字节${isDirty(d()) ? " · 未保存" : ""}${d().saving ? " · 保存中…" : ""}`}
              </Text>
            </View>
            <HairlineH soft />
            <Show
              when={!tooBigForInput()}
              fallback={
                <View class="p-3">
                  <Text class="text-sm" style={{ textColor: C.warn }}>此文件超过多行输入框的 1 MiB 上限：请在“设置”中切换到“代码视图”编辑器。</Text>
                </View>
              }
            >
              <Show
                when={resolveEditor(settings().editor).selfScrolling}
                fallback={
                  <ScrollablePage>
                    <Editor
                      path={d().path}
                      text={d().text}
                      onChange={(t) => s.workspace.setText(d().path, t)}
                      onSave={() => void s.workspace.save(d().path)}
                      diagnostics={own()}
                      jump={d().jump}
                    />
                  </ScrollablePage>
                }
              >
                <View class="flex-col flex-1 w-full" style={{ minH: 0 }}>
                  <Editor
                    path={d().path}
                    text={d().text}
                    onChange={(t) => s.workspace.setText(d().path, t)}
                    onSave={() => void s.workspace.save(d().path)}
                    diagnostics={own()}
                    jump={d().jump}
                    buffer={(path) => s.workspace.editorFor(path)}
                    reload={d().reload}
                    clipboard={s.clipboard}
                    caretLine={s.workspace.caretLine}
                    onCaretLine={s.workspace.setCaretLine}
                    focus={d().focus}
                    onFocused={(seq) => s.workspace.focusDone(d().path, seq)}
                    findRequest={commands().find}
                    onKeyDown={(key) => s.commands.handleKey(key, { editorFocused: true })}
                  />
                </View>
              </Show>
            </Show>
          </Show>
        </View>
      )}
    </Show>
  );
}

/**
 * Zone C — Docked Left Source Split (`#source-dock`) used in Wide 5-Zone Desktop Workbench mode.
 * Note: Does NOT mount a second PreviewSurface because Zone D Center Stage owns the single live PreviewSurface.
 */
export function SourceDock(props: { studio: Studio }) {
  const s = props.studio;
  const ws = fromStore(s.workspace.store);
  const settings = fromStore(s.settings.store);
  const build = fromStore(s.build.store);
  const wb = fromStore(s.workbench.store);
  const project = () => ws().project;
  const dirtyCount = () => ws().docs.filter(isDirty).length;
  const [liveTree, setLiveTree] = createSignal<number | undefined>(undefined);
  const treeWidth = () => liveTree() ?? Math.min(200, settings().treeWidth);

  const EditorColumn = () => (
    <View class="flex-col flex-1 h-full" style={{ bgColor: C.bgRaised, minW: 0, minH: 0 }}>
      <WorkbenchTabsBar studio={s} />
      <HairlineH />
      <ActiveEditor studio={s} />
    </View>
  );

  return (
    <View class="flex-col flex-1 h-full w-full" style={{ bgColor: C.bgRaised, minW: 0, minH: 0 }}>
      {/* `.source-header` (38px) */}
      <View class="flex-row items-center justify-between gap-2 px-3 w-full" style={{ height: 38, bgColor: C.surface, shrink: 0 }}>
        <View class="flex-row items-center gap-2 flex-1 overflow-hidden" style={{ minW: 0 }}>
          <StudioButton
            label={wb().treeOpen ? "目录 ▾" : "目录 ▸"}
            kind={wb().treeOpen ? "active" : "quiet"}
            size="xs"
            onPress={() => s.workbench.toggleTree()}
          />
          <View class="flex-1 overflow-hidden" style={{ minW: 0 }}>
            <Text class="text-xs font-bold" style={{ textColor: C.text }}>{`源码 · ${project() ?? "请选择项目"}`}</Text>
          </View>
        </View>
        <View class="flex-row items-center gap-1.5" style={{ shrink: 0 }}>
          <Show when={project()}>
            <StudioButton
              label={dirtyCount() > 0 ? `保存 (${dirtyCount()})` : "保存"}
              shortcut="⌘S"
              kind="primary"
              size="xs"
              disabled={dirtyCount() === 0}
              onPress={() => void s.workspace.saveAll()}
            />
          </Show>
          <StudioButton label="收起分栏" kind="quiet" size="xs" onPress={() => s.workbench.patch({ sourceOpen: false })} />
        </View>
      </View>
      <HairlineH />

      {/* Body: Optional FileTree + ActiveEditor */}
      <View class="flex-row flex-1 w-full" style={{ minH: 0 }}>
        <Show when={wb().treeOpen} fallback={<EditorColumn />}>
          <SplitPane
            size={treeWidth()}
            min={150}
            max={320}
            handle={5}
            onResize={(w) => setLiveTree(w)}
            onResizeEnd={(w) => {
              void s.settings.set({ treeWidth: w });
              setLiveTree(undefined);
            }}
            first={<FileTree studio={s} />}
            second={<EditorColumn />}
          />
        </Show>
      </View>

      {/* `.source-foot` (26px) */}
      <HairlineH />
      <View class="flex-row items-center justify-between gap-2 px-3 w-full" style={{ height: 26, bgColor: C.surface, shrink: 0 }}>
        <Text class="text-2xs" style={{ textColor: C.muted }}>Solid TSX · 界面由 JavaScript 管理</Text>
        <View class="flex-row items-center gap-2">
          <Text class="text-2xs" style={{ textColor: settings().autoBuild ? C.ok : C.faint }}>
            {settings().autoBuild ? "保存后自动构建" : "手动构建"}
          </Text>
          <Show when={build().status?.revision !== undefined}>
            <Text class="text-2xs" style={{ textColor: C.muted }}>{`修订版 r${build().status!.revision}`}</Text>
          </Show>
        </View>
      </View>
    </View>
  );
}

/** Responsive Source Page used when viewport < 1160px (retains optional side-by-side SplitPane PreviewSurface). */
export function SourcePage(props: { studio: Studio }) {
  const s = props.studio;
  const ws = fromStore(s.workspace.store);
  const settings = fromStore(s.settings.store);
  const build = fromStore(s.build.store);
  const preview = fromStore(s.preview.store);
  const project = () => ws().project;
  const dirtyCount = () => ws().docs.filter(isDirty).length;
  const [live, setLive] = createSignal<{ tree?: number; dock?: number }>({});
  const tree = () => live().tree ?? settings().treeWidth;
  const dock = () => live().dock ?? settings().dockWidth;

  const EditorColumn = () => (
    <View class="flex-col flex-1 h-full" style={{ bgColor: C.bgRaised, minW: 0, minH: 0 }}>
      <WorkbenchTabsBar studio={s} />
      <HairlineH />
      <ActiveEditor studio={s} />
    </View>
  );

  return (
    <View class="flex-col flex-1 h-full w-full" style={{ bgColor: C.bg, minW: 0, minH: 0 }}>
      <View class="flex-row items-center justify-between gap-2 px-3 w-full" style={{ height: 38, bgColor: C.surface, shrink: 0 }}>
        <View class="flex-row items-center gap-2" style={{ minW: 0 }}>
          <Text class="text-sm font-bold" style={{ textColor: C.text }}>{`源码 · ${project() ?? "请选择项目"}`}</Text>
          <Show when={project()}>
            <StateChip
              label={settings().autoBuild ? "自动：保存后自动构建" : "手动构建"}
              tone={settings().autoBuild ? "good" : "neutral"}
            />
            <Text class="text-xs" style={{ textColor: C.muted }}>{`预览：${PREVIEW_PHASE_LABEL[preview().phase]}`}</Text>
          </Show>
        </View>
        <Show when={project()}>
          <View class="flex-row items-center gap-1.5" style={{ shrink: 0 }}>
            <StudioButton
              label={dirtyCount() > 0 ? `保存 (${dirtyCount()})` : "保存"}
              kind="primary"
              size="xs"
              disabled={dirtyCount() === 0}
              onPress={() => void s.workspace.saveAll()}
            />
            <StudioButton
              label={build().busy ? "构建中…" : "构建"}
              kind="secondary"
              size="xs"
              disabled={build().busy}
              onPress={() => void s.preview.run({ build: true })}
            />
            <Show when={build().busy}>
              <StudioButton label="取消构建" kind="quiet" size="xs" onPress={() => void s.build.cancel()} />
            </Show>
          </View>
        </Show>
      </View>
      <HairlineH />
      <View class="flex-row flex-1 w-full" style={{ minH: 0 }}>
        <SplitPane
          size={tree()}
          min={TREE_WIDTH_LIMITS.min}
          max={TREE_WIDTH_LIMITS.max}
          handle={6}
          onResize={(w) => setLive({ ...live(), tree: w })}
          onResizeEnd={(w) => {
            void s.settings.set({ treeWidth: w });
            setLive({ ...live(), tree: undefined });
          }}
          first={<FileTree studio={s} />}
          second={
            <Show when={settings().dockPreview && project()} fallback={<EditorColumn />}>
              <SplitPane
                fixed="second"
                size={dock()}
                min={DOCK_WIDTH_LIMITS.min}
                max={DOCK_WIDTH_LIMITS.max}
                handle={6}
                onResize={(w) => setLive({ ...live(), dock: w })}
                onResizeEnd={(w) => {
                  void s.settings.set({ dockWidth: w });
                  setLive({ ...live(), dock: undefined });
                }}
                first={<EditorColumn />}
                second={
                  <View class="flex-col gap-1.5 p-2 flex-1 h-full" style={{ bgColor: C.bg }}>
                    <View class="flex-row items-center justify-between px-1">
                      <Text class="text-xs font-bold" style={{ textColor: C.muted }}>实时预览</Text>
                      <StateChip label={PREVIEW_PHASE_LABEL[preview().phase]} tone={preview().phase === "running" ? "good" : preview().phase === "error" ? "bad" : "neutral"} />
                    </View>
                    <PreviewSurface studio={s} />
                  </View>
                }
              />
            </Show>
          }
        />
      </View>
    </View>
  );
}
