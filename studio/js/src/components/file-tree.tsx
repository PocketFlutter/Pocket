import { Show } from "solid-js";
import { Tree } from "@pocket/ui/tree";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { dirname } from "../lib/path.ts";
import { C } from "../ui/theme.ts";
import type { Studio } from "../state/studio.ts";
import { isDirty } from "../state/workspace.ts";
import { Eyebrow, HairlineH, StudioButton } from "./workbench-ui.tsx";

/** Project file explorer with Web-Preview-styled action strip (+ 文件 / + 文件夹 / 重命名 / 删除 / 刷新). */
export function FileTree(props: { studio: Studio }) {
  const ws = props.studio.workspace;
  const state = fromStore(ws.store);
  const dirtyPaths = () => new Set(state().docs.filter(isDirty).map((d) => d.path));
  const targetDir = () => {
    const s = state();
    if (!s.selected) return "";
    return s.selectedKind === "directory" ? s.selected : dirname(s.selected);
  };
  return (
    <View class="flex-col flex-1 h-full" style={{ bgColor: C.bgRaised, minW: 0 }}>
      <View class="flex-col gap-1.5 px-2.5 py-2 w-full" style={{ bgColor: C.surface, shrink: 0 }}>
        <View class="flex-row items-center justify-between gap-1 w-full">
          <Eyebrow text="资源管理器" />
          <Text class="text-2xs" style={{ textColor: C.faint }}>{`${state().files.length} 文件`}</Text>
        </View>
        <View class="flex-row gap-1 flex-wrap w-full">
          <StudioButton label="+ 文件" kind="secondary" size="xs" onPress={() => void ws.createFile(targetDir())} />
          <StudioButton label="+ 文件夹" kind="secondary" size="xs" onPress={() => void ws.createFolder(targetDir())} />
          <StudioButton label="刷新" kind="quiet" size="xs" onPress={() => void ws.refreshTree()} />
        </View>
        <View class="flex-row gap-1 flex-wrap w-full">
          <StudioButton
            label="重命名"
            kind="quiet"
            size="xs"
            disabled={!state().selected || state().selectedKind !== "file"}
            onPress={() => state().selected && void ws.rename(state().selected!)}
          />
          <StudioButton
            label="删除"
            kind="danger"
            size="xs"
            disabled={!state().selected}
            onPress={() => state().selected && void ws.remove(state().selected!)}
          />
        </View>
      </View>
      <HairlineH />
      <View class="flex-col flex-1 px-2 py-1.5 w-full" style={{ minH: 0 }}>
        <Show when={state().treeLoading}>
          <Text class="text-xs pb-1" style={{ textColor: C.muted }}>正在加载文件…</Text>
        </Show>
        <Tree
          files={state().files}
          directories={state().emptyFolders}
          expanded={state().expanded}
          selected={state().selected}
          marked={dirtyPaths()}
          onOpenFile={(path) => void ws.open(path)}
          onToggleFolder={(path) => ws.toggleFolder(path)}
        />
      </View>
    </View>
  );
}
