import { For, Show } from "solid-js";
import { InputField, MobileButton, MobileDialog, MobileSegmentedControl, ScrollablePage } from "@pocket/ui";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import type { Studio } from "../state/studio.ts";
import { Eyebrow, HairlineH, StateChip, StudioButton } from "../components/workbench-ui.tsx";

/** Workspace Projects List Card — used both inside Center Stage on cold boot and as the Projects view in compact mode. */
export function ProjectsWorkbenchCard(props: { studio: Studio; embedded?: boolean }) {
  const s = props.studio;
  const p = s.projects;
  const state = fromStore(p.store);

  return (
    <View
      class={props.embedded ? "flex-col flex-1 rounded-xl overflow-hidden w-full h-full max-w-[680]" : "flex-col flex-1 w-full h-full"}
      style={
        props.embedded
          ? { bgColor: C.surface, borderColor: C.line, borderWidth: 1, radius: 11, shadow: 2, minH: 200, maxH: 520 }
          : { bgColor: C.bg }
      }
    >
      {/* Header */}
      <View class="flex-row items-center justify-between gap-2 px-4 py-3 w-full" style={{ bgColor: C.surface, shrink: 0 }}>
        <View class="flex-col gap-0.5" style={{ minW: 0 }}>
          <Eyebrow text="POCKET WORKSPACE" />
          <View class="flex-row items-center gap-2">
            <Text class="text-base font-bold" style={{ textColor: C.text }}>项目</Text>
            <StateChip label={state().loaded ? `${state().list.length} 个工作区工程` : "加载中"} tone="info" />
          </View>
        </View>
        <View class="flex-row items-center gap-2 flex-wrap" style={{ shrink: 0 }}>
          <StudioButton label="+ 新建项目" kind="primary" onPress={() => p.setCreateOpen(true)} />
          <StudioButton
            label={state().openingLocal ? "选择目录中…" : "打开本地项目"}
            kind="secondary"
            disabled={state().openingLocal}
            onPress={() => void s.projects.openLocal()}
          />
          <StudioButton label="刷新" kind="quiet" onPress={() => void p.refresh()} />
        </View>
      </View>
      <HairlineH />

      {/* Body */}
      <View class="flex-col gap-2 p-4 flex-1 w-full" style={{ bgColor: C.bgRaised, minH: 0 }}>
        <Show when={!state().loaded}>
          <Text class="text-xs" style={{ textColor: C.muted }}>正在加载项目…</Text>
        </Show>
        <Show when={state().loaded && state().list.length === 0}>
          <View
            class="flex-col items-center justify-center gap-2 p-6 rounded-lg w-full"
            style={{ bgColor: C.surface, borderColor: C.line, borderWidth: 1, radius: 8 }}
          >
            <Text class="text-sm font-bold" style={{ textColor: C.text }}>暂无项目</Text>
            <Text class="text-xs" style={{ textColor: C.muted }}>点击右上角“+ 新建项目”从模板创建，或点击“打开本地项目”导入已有工程。</Text>
          </View>
        </Show>
        <ScrollablePage>
          <View class="flex-col gap-2 w-full">
            <For each={state().list}>
              {(project) => {
                const selected = () => state().current === project.id;
                return (
                  <Focusable
                    class="flex-row items-center justify-between gap-3 px-3.5 py-3 rounded-lg w-full"
                    style={{
                      bgColor: selected() ? C.primarySoft : C.surface,
                      borderColor: selected() ? C.primaryBorder : C.line,
                      borderWidth: 1,
                      radius: 8,
                    }}
                    onPress={() => void p.open(project.id)}
                  >
                    <View class="flex-col gap-1 flex-1" style={{ minW: 0 }}>
                      <View class="flex-row items-center gap-2">
                        <Text class="text-sm font-bold" style={{ textColor: C.text }}>
                          {project.title || project.name || project.id}
                        </Text>
                        <StateChip
                          label={project.template === "game" ? "游戏" : "应用"}
                          tone={selected() ? "info" : "neutral"}
                        />
                        <Show when={project.version}>
                          <Text class="text-2xs" style={{ textColor: C.faint }}>{`v${project.version}`}</Text>
                        </Show>
                      </View>
                      <Text class="text-xs font-mono" style={{ textColor: C.muted }}>
                        {`${project.id} · ${project.appId} · ${project.template === "game" ? "游戏" : "应用"}${project.directory ? ` · ${project.directory}` : ""}`}
                      </Text>
                    </View>
                    <Text class="text-xs font-bold" style={{ textColor: selected() ? C.info : C.faint }}>
                      {selected() ? "当前打开 ›" : "打开 ›"}
                    </Text>
                  </Focusable>
                );
              }}
            </For>
          </View>
        </ScrollablePage>
      </View>
    </View>
  );
}

export function ProjectsPage(props: { studio: Studio }) {
  return <ProjectsWorkbenchCard studio={props.studio} />;
}

/** Rendered once by the shell so it overlays every zone. */
export function CreateProjectDialog(props: { studio: Studio }) {
  const s = props.studio;
  const p = s.projects;
  const state = fromStore(p.store);
  const set = (key: "id" | "name" | "appId" | "version", value: string) => p.setDraft({ ...state().draft, [key]: value });
  const selected = () => state().draft.ecosystemModules ?? [];
  return (
    <MobileDialog
      open={() => state().createOpen}
      title="新建 SDK 项目"
      cancelLabel="取消"
      onClose={() => p.setCreateOpen(false)}
    >
      <MobileSegmentedControl
        items={[{ id: "app", label: "应用" }, { id: "game", label: "游戏" }]}
        active={state().draft.template}
        onChange={(id) => p.setDraft({ ...state().draft, template: id === "game" ? "game" : "app" })}
      />
      <Text class="text-xs" style={{ textColor: C.muted }}>文件夹 ID</Text>
      <InputField value={() => state().draft.id} onInput={(v) => set("id", v)} placeholder="my-pocket-app" />
      <Text class="text-xs" style={{ textColor: C.muted }}>显示名称</Text>
      <InputField value={() => state().draft.name} onInput={(v) => set("name", v)} />
      <Text class="text-xs" style={{ textColor: C.muted }}>应用 ID</Text>
      <InputField value={() => state().draft.appId} onInput={(v) => set("appId", v)} />
      <Text class="text-xs" style={{ textColor: C.muted }}>初始版本</Text>
      <InputField value={() => state().draft.version} onInput={(v) => set("version", v)} placeholder="0.1.0" />
      <Text class="text-xs" style={{ textColor: C.muted }}>{`按需生态扩展（已选 ${selected().length} 项）`}</Text>
      <View style={{ height: 112 }}>
        <ScrollablePage>
          <View class="flex-row flex-wrap gap-1.5 w-full">
            <For each={state().catalog}>
              {(mod) => {
                const active = () => selected().includes(mod.id);
                return (
                  <MobileButton
                    label={`${active() ? "✓ " : ""}${mod.label ?? mod.id}`}
                    kind={active() ? "filled" : "outlined"}
                    compact
                    disabled={state().creating}
                    onPress={() => s.projects.toggleDraftModule(mod.id)}
                  />
                );
              }}
            </For>
          </View>
        </ScrollablePage>
      </View>
      <View class="flex-row flex-wrap items-center justify-end gap-2 w-full">
        <MobileButton
          label="选择目录并创建…"
          kind="tonal"
          compact
          disabled={state().creating}
          onPress={() => void s.projects.create({ pickParentDirectory: true })}
        />
        <MobileButton
          label={state().creating ? "创建中…" : "创建并打开"}
          kind="filled"
          compact
          disabled={state().creating}
          onPress={() => void s.projects.create({ pickParentDirectory: false })}
        />
      </View>
    </MobileDialog>
  );
}
