// Zone E — Right Tabbed Inspector Workbench (`.inspector-column`, 368px)
// matching sdk/editor/client/index.html `#inspector-tab-resources`, `#inspector-tab-versions`, `#inspector-tab-settings`.
import { Show } from "solid-js";
import { View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import type { InspectorTab } from "../state/workbench.ts";
import type { Studio } from "../state/studio.ts";
import { ResourcesPage } from "../pages/resources.tsx";
import { PublishPage } from "../pages/publish.tsx";
import { VersionsPage } from "../pages/versions.tsx";
import { SettingsPage } from "../pages/settings.tsx";
import { CapsuleToggle, HairlineH, HairlineV, UnderlineTabs } from "./workbench-ui.tsx";

export function InspectorColumn(props: { studio: Studio }) {
  const s = props.studio;
  const wb = fromStore(s.workbench.store);

  const selectTab = (tab: InspectorTab) => {
    s.workbench.setInspectorTab(tab);
    const cur = s.projects.current();
    if (tab === "resources" && cur && !s.resources.state().loaded) void s.resources.refresh();
    if (tab === "versions" && cur) {
      if (wb().versionsSubTab === "publish") void s.publish.enter();
      else {
        void s.versions.refresh();
        void s.cos.load(cur);
      }
    }
    if (tab === "settings") {
      void s.selfUpdate.load();
      if (cur) {
        void s.projectSettings.load(cur);
        void s.ecosystem.load(cur);
      }
    }
  };

  return (
    <View class="flex-row h-full" style={{ shrink: 0 }}>
      <HairlineV />
      <View class="flex-col h-full" style={{ width: 368, bgColor: C.surface }}>
        {/* `.inspector-tabs` (38px, 3 equal columns) */}
        <View class="w-full" style={{ bgColor: C.bgRaised, shrink: 0 }}>
          <UnderlineTabs<InspectorTab>
            equalWidth
            height={38}
            active={wb().inspectorTab}
            onSelect={selectTab}
            items={[
              { id: "resources", label: "包资源" },
              { id: "versions", label: "版本发布" },
              { id: "settings", label: "项目设置" },
            ]}
          />
        </View>
        <HairlineH />

        {/* `.inspector-body` */}
        <View class="flex-col flex-1 w-full" style={{ minH: 0 }}>
          <Show when={wb().inspectorTab === "resources"}>
            <ResourcesPage studio={s} inspector />
          </Show>
          <Show when={wb().inspectorTab === "versions"}>
            <View class="flex-col flex-1 h-full w-full" style={{ minH: 0 }}>
              {/* Sub-mode capsule switching Publish Plan vs Versions & COS */}
              <View class="flex-row items-center justify-center px-3 py-1.5 w-full" style={{ bgColor: C.bgRaised, shrink: 0 }}>
                <View
                  class="flex-row items-center gap-1 p-0.5 rounded-lg"
                  style={{ bgColor: C.surface, borderColor: C.line, borderWidth: 1, radius: 7 }}
                >
                  <CapsuleToggle
                    label="签名与热更发布"
                    active={wb().versionsSubTab === "publish"}
                    onPress={() => {
                      s.workbench.setVersionsSubTab("publish");
                      if (s.projects.current()) void s.publish.enter();
                    }}
                  />
                  <CapsuleToggle
                    label="版本槽与腾讯云 COS"
                    active={wb().versionsSubTab === "versions"}
                    onPress={() => {
                      s.workbench.setVersionsSubTab("versions");
                      const cur = s.projects.current();
                      if (cur) {
                        void s.versions.refresh();
                        void s.cos.load(cur);
                      }
                    }}
                  />
                </View>
              </View>
              <HairlineH soft />
              <Show when={wb().versionsSubTab === "publish"}>
                <PublishPage studio={s} inspector />
              </Show>
              <Show when={wb().versionsSubTab === "versions"}>
                <VersionsPage studio={s} inspector />
              </Show>
            </View>
          </Show>
          <Show when={wb().inspectorTab === "settings"}>
            <SettingsPage studio={s} inspector />
          </Show>
        </View>
      </View>
    </View>
  );
}
