// Zone B — Far-Left Activity Rail matching sdk/editor/client/editor.css `.activity-rail`.
import { For, Show } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore, select } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import type { Studio, StudioPage } from "../state/studio.ts";
import { HairlineV } from "./workbench-ui.tsx";

interface RailItem {
  id: StudioPage;
  label: string;
  glyph: string;
}

const TOP_ITEMS: readonly RailItem[] = [
  { id: "projects", label: "项目", glyph: "⊞" },
  { id: "source", label: "源码", glyph: "</>" },
  { id: "preview", label: "预览", glyph: "▣" },
  { id: "resources", label: "资源", glyph: "⬡" },
  { id: "publish", label: "发布", glyph: "⤴" },
  { id: "versions", label: "版本", glyph: "⑂" },
  { id: "settings", label: "设置", glyph: "⚙" },
];

const BOTTOM_ITEMS: readonly RailItem[] = [
  { id: "console", label: "控制台", glyph: ">_" },
  { id: "artifacts", label: "产物", glyph: "◫" },
];

export function Rail(props: { studio: Studio; wide?: boolean }) {
  const s = props.studio;
  const page = select(s.nav, (n) => n.page);
  const wb = fromStore(s.workbench.store);
  const hasProject = () => s.projects.current() !== undefined;

  const isActive = (id: StudioPage): boolean => {
    if (!props.wide) return page() === id;
    const w = wb();
    switch (id) {
      case "projects":
        return w.projectMenuOpen || !hasProject();
      case "source":
        return hasProject() && w.sourceOpen;
      case "preview":
        return hasProject() && !w.projectMenuOpen;
      case "resources":
        return w.inspectorOpen && w.inspectorTab === "resources";
      case "publish":
        return w.inspectorOpen && w.inspectorTab === "versions" && w.versionsSubTab === "publish";
      case "versions":
        return w.inspectorOpen && w.inspectorTab === "versions" && w.versionsSubTab === "versions";
      case "settings":
        return w.inspectorOpen && w.inspectorTab === "settings";
      case "console":
        return w.consoleOpen && w.consoleTab === "build";
      case "artifacts":
        return w.consoleOpen && w.consoleTab === "artifacts";
    }
  };

  const handlePress = (id: StudioPage): void => {
    if (!props.wide) {
      s.setPage(id);
      return;
    }
    const w = wb();
    if (id === "projects") {
      if (!hasProject()) {
        s.setPage("projects");
      } else {
        const next = !w.projectMenuOpen;
        s.workbench.patch({ projectMenuOpen: next });
        if (next) s.nav.update({ page: "projects" });
      }
      return;
    }
    if (id === "source" && hasProject() && w.sourceOpen && page() === "source") {
      s.workbench.patch({ sourceOpen: false });
      s.nav.update({ page: "preview" });
      return;
    }
    if (id === "console" && w.consoleOpen && w.consoleTab === "build" && page() === "console") {
      s.workbench.patch({ consoleOpen: false });
      return;
    }
    if (id === "artifacts" && w.consoleOpen && w.consoleTab === "artifacts" && page() === "artifacts") {
      s.workbench.patch({ consoleOpen: false });
      return;
    }
    s.setPage(id);
  };

  const renderItem = (item: RailItem) => {
    const active = () => isActive(item.id);
    return (
      <Focusable
        class="relative flex-col items-center justify-center gap-0.5 rounded-lg"
        style={{
          width: 44,
          height: 38,
          bgColor: active() ? C.surface2 : "#00000000",
          borderColor: active() ? C.primaryBorder : "#00000000",
          borderWidth: active() ? 1 : 0,
          radius: 7,
        }}
        onPress={() => handlePress(item.id)}
      >
        <Show when={active()}>
          <View
            class="absolute left-0"
            style={{
              insetL: -5,
              insetT: 7,
              insetB: 7,
              width: 2,
              radius: 2,
              bgColor: C.primary,
            }}
          />
        </Show>
        <Text class="text-2xs font-bold" style={{ textColor: active() ? C.info : C.faint }}>{item.glyph}</Text>
        <Text class="text-2xs font-bold" style={{ textColor: active() ? C.text : C.muted }}>{item.label}</Text>
      </Focusable>
    );
  };

  return (
    <View class="flex-row h-full" style={{ shrink: 0 }}>
      <View class="flex-col items-center justify-between py-2 px-1 h-full" style={{ width: 55, bgColor: C.bgRaised }}>
        <View class="flex-col items-center gap-1 w-full">
          {/* Rail brand header (self-update verification anchor) */}
          <View class="px-1 pb-1 items-center">
            <Text class="text-2xs text-[#5D677A] font-bold">POCKET STUDIO</Text>
          </View>
          <For each={TOP_ITEMS}>{(item) => renderItem(item)}</For>
        </View>
        <View class="flex-col items-center gap-1 pt-2 w-full">
          <For each={BOTTOM_ITEMS}>{(item) => renderItem(item)}</For>
        </View>
      </View>
      <HairlineV />
    </View>
  );
}
