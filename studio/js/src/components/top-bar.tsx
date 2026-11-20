// Zone A — Top Global Command Bar (46px) + Floating Project Switcher Popover
// matching sdk/editor/client/index.html `.project-switcher-bar` and `.project-switcher-menu`.
import { For, Show } from "solid-js";
import { ScrollablePage } from "@pocket/ui";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import { isDirty } from "../state/workspace.ts";
import type { Studio } from "../state/studio.ts";
import { CapsuleToggle, Eyebrow, HairlineH, StateChip, StudioButton, type ChipTone } from "./workbench-ui.tsx";

export function TopCommandBar(props: { studio: Studio; wide: boolean }) {
  const s = props.studio;
  const projects = fromStore(s.projects.store);
  const ws = fromStore(s.workspace.store);
  const build = fromStore(s.build.store);
  const wb = fromStore(s.workbench.store);
  const selfUp = fromStore(s.selfUpdate.store);
  const sdkUp = fromStore(s.sdkUpgrade.store);

  const activeProject = () => projects().list.find((p) => p.id === projects().current);
  const dirtyDocs = () => ws().docs.filter(isDirty).length;

  const projectChip = (): { label: string; tone: ChipTone } => {
    if (!projects().current) return { label: projects().list.length ? `${projects().list.length} 个项目` : "暂无项目", tone: "neutral" };
    if (build().busy) return { label: "构建中", tone: "warn" };
    if (build().error) return { label: "构建异常", tone: "bad" };
    if (dirtyDocs() > 0) return { label: "有未保存修改", tone: "warn" };
    const st = build().status;
    if (st && st.builtRevision !== null && st.builtRevision === st.revision) return { label: "已构建", tone: "good" };
    if (st && st.builtRevision !== null) return { label: "待重编", tone: "warn" };
    return { label: "已打开", tone: "info" };
  };

  const upgradeSummary = () => {
    const u = selfUp();
    const sdk = sdkUp().info;
    const activeVer = u.activeVersion ? `v${u.activeVersion}` : sdk?.currentVersion ? `v${sdk.currentVersion}` : "Studio";
    if (u.candidateVersion) {
      return {
        version: `${activeVer} → v${u.candidateVersion}`,
        detail: "发现 Studio 新版本",
        tone: "good" as ChipTone,
      };
    }
    if (sdk?.upgradeAvailable && sdk.latestVersion) {
      return {
        version: `${activeVer} → v${sdk.latestVersion}`,
        detail: "发现 SDK 新版本",
        tone: "warn" as ChipTone,
      };
    }
    if (u.lastError || sdk?.rolledBack) {
      return {
        version: activeVer,
        detail: "已回滚到健康版本",
        tone: "warn" as ChipTone,
      };
    }
    return {
      version: activeVer,
      detail: sdk?.mode === "standalone" ? "自动升级就绪" : "本机工作区就绪",
      tone: "neutral" as ChipTone,
    };
  };

  const onProjectPillPress = () => {
    if (props.wide && projects().current) {
      s.workbench.toggleProjectMenu();
    } else {
      s.setPage("projects");
    }
  };

  const openUpgradeSettings = () => {
    s.workbench.setSettingsSection(sdkUp().info?.upgradeAvailable ? "service" : "studio");
    s.setPage("settings");
  };

  return (
    <View class="flex-col w-full" style={{ bgColor: C.surface, shrink: 0 }}>
      <View class="flex-row items-center justify-between gap-2 px-3 w-full" style={{ height: props.wide ? 46 : 38 }}>
        {/* Left: Brand Emblem + Project Switcher Pill + Open / New Project */}
        <View class="flex-row items-center gap-2" style={{ minW: 0, shrink: 1 }}>
          {/* Pocket Studio Geometric Emblem (26x26 blue badge + emerald live dot) */}
          <View
            class="relative items-center justify-center rounded-lg"
            style={{
              width: 26,
              height: 26,
              bgColor: C.primary,
              borderColor: "#60A5FA",
              borderWidth: 1,
              radius: 7,
              shrink: 0,
            }}
          >
            <Text class="text-xs font-bold text-[#FFFFFF]">P</Text>
            <View
              class="absolute"
              style={{
                insetR: 3,
                insetB: 3,
                width: 5,
                height: 5,
                radius: 3,
                bgColor: C.ok,
              }}
            />
          </View>

          {/* Project Switcher Trigger Pill */}
          <Focusable
            class="flex-row items-center justify-between gap-2 px-2.5 rounded-lg"
            style={{
              height: 30,
              bgColor: wb().projectMenuOpen ? C.surface3 : C.surface2,
              borderColor: wb().projectMenuOpen ? C.primary : C.line,
              borderWidth: 1,
              radius: 7,
              minW: 140,
            }}
            onPress={onProjectPillPress}
          >
            <Text class="text-xs font-bold" style={{ textColor: C.text }}>
              {activeProject()?.title || activeProject()?.name || projects().current || "选择项目"}
            </Text>
            <View class="flex-row items-center gap-1.5" style={{ shrink: 0 }}>
              <StateChip label={projectChip().label} tone={projectChip().tone} />
              <Text class="text-xs" style={{ textColor: C.muted }}>{wb().projectMenuOpen ? "▴" : "⌄"}</Text>
            </View>
          </Focusable>

          <Show when={props.wide}>
            <StudioButton
              label={projects().openingLocal ? "选择目录中…" : "打开本地项目"}
              kind="secondary"
              disabled={projects().openingLocal}
              onPress={() => void s.projects.openLocal()}
            />
            <StudioButton
              label="+ 新建项目"
              kind="secondary"
              onPress={() => s.projects.setCreateOpen(true)}
            />
          </Show>
        </View>

        {/* Center: Primary Build ⌘B + Mode Capsule */}
        <View class="flex-row items-center gap-2" style={{ shrink: 0 }}>
          <StudioButton
            label={build().busy ? "构建中…" : "立即构建"}
            shortcut="⌘B"
            kind="primary"
            disabled={!projects().current || build().busy}
            onPress={() => void s.build.start()}
          />
          <Show when={props.wide}>
            <View
              class="flex-row items-center gap-0.5 p-0.5 rounded-lg"
              style={{
                bgColor: C.bgRaised,
                borderColor: C.line,
                borderWidth: 1,
                radius: 7,
              }}
            >
              <CapsuleToggle
                label="源码分栏"
                active={wb().sourceOpen && Boolean(projects().current)}
                disabled={!projects().current}
                onPress={() => s.workbench.toggleSource()}
              />
              <CapsuleToggle
                label="终端面板"
                active={wb().consoleOpen}
                onPress={() => s.workbench.toggleConsole()}
              />
              <CapsuleToggle
                label="检查器"
                active={wb().inspectorOpen}
                onPress={() => s.workbench.toggleInspector()}
              />
            </View>
          </Show>
        </View>

        {/* Right: Studio & SDK Upgrade Capsule (`#studio-upgrade-bar`) */}
        <Show when={props.wide}>
          <View
            class="flex-row items-center gap-2.5 px-2.5 rounded-lg"
            style={{
              height: 32,
              bgColor: C.bgRaised,
              borderColor:
                upgradeSummary().tone === "good"
                  ? C.okBorder
                  : upgradeSummary().tone === "warn"
                    ? C.warnBorder
                    : C.line,
              borderWidth: 1,
              radius: 7,
              shrink: 0,
            }}
          >
            <View class="flex-row items-center gap-1.5">
              <Text class="text-xs font-mono font-bold" style={{ textColor: C.text }}>
                {upgradeSummary().version}
              </Text>
              <Text
                class="text-2xs"
                style={{
                  textColor:
                    upgradeSummary().tone === "good"
                      ? C.ok
                      : upgradeSummary().tone === "warn"
                        ? C.warn
                        : C.muted,
                }}
              >
                {upgradeSummary().detail}
              </Text>
            </View>
            <StudioButton label="升级管理" kind="quiet" size="xs" onPress={openUpgradeSettings} />
          </View>
        </Show>
      </View>
      <HairlineH />
    </View>
  );
}

/** Floating `.project-switcher-menu` anchored beneath the Top Command Bar when `projectMenuOpen` is active in wide mode. */
export function ProjectSwitcherPopover(props: { studio: Studio }) {
  const s = props.studio;
  const p = s.projects;
  const state = fromStore(p.store);
  const wb = fromStore(s.workbench.store);

  return (
    <Show when={wb().projectMenuOpen}>
      <View class="absolute inset-0 z-40" style={{ bgColor: "#00000066" }}>
        {/* Click backdrop to dismiss */}
        <Focusable class="absolute inset-0 w-full h-full" onPress={() => s.workbench.closeProjectMenu()} />
        <View
          class="absolute flex-col gap-2 p-3 rounded-xl"
          style={{
            insetT: 50,
            insetL: 64,
            width: 380,
            maxH: 440,
            bgColor: C.surface,
            borderColor: C.lineHover,
            borderWidth: 1,
            radius: 10,
            shadow: 2,
          }}
        >
          <View class="flex-row items-center justify-between gap-2 pb-1.5 w-full">
            <View class="flex-row items-center gap-2">
              <Text class="text-xs font-bold" style={{ textColor: C.text }}>项目列表</Text>
              <Eyebrow text="本地工作区" />
            </View>
            <View class="flex-row items-center gap-1.5">
              <StudioButton label="刷新" kind="quiet" size="xs" onPress={() => void p.refresh()} />
              <StudioButton label="关闭" kind="text" size="xs" onPress={() => s.workbench.closeProjectMenu()} />
            </View>
          </View>
          <HairlineH />
          <Show when={!state().loaded}>
            <Text class="text-xs py-2" style={{ textColor: C.muted }}>正在加载项目…</Text>
          </Show>
          <Show when={state().loaded && state().list.length === 0}>
            <Text class="text-xs py-2" style={{ textColor: C.muted }}>暂无项目</Text>
          </Show>
          <View style={{ height: Math.min(280, Math.max(72, state().list.length * 56)) }}>
            <ScrollablePage>
              <View class="flex-col gap-1.5 w-full">
                <For each={state().list}>
                  {(project) => {
                    const active = () => state().current === project.id;
                    return (
                      <Focusable
                        class="flex-col gap-0.5 px-3 py-2 rounded-lg w-full"
                        style={{
                          bgColor: active() ? C.primarySoft : C.bgRaised,
                          borderColor: active() ? C.primaryBorder : C.line,
                          borderWidth: 1,
                          radius: 7,
                        }}
                        onPress={() => void p.open(project.id)}
                      >
                        <View class="flex-row items-center justify-between gap-2 w-full">
                          <Text class="text-xs font-bold" style={{ textColor: C.text }}>
                            {project.title || project.name || project.id}
                          </Text>
                          <StateChip label={project.template === "game" ? "游戏" : "应用"} tone={active() ? "info" : "neutral"} />
                        </View>
                        <Text class="text-2xs" style={{ textColor: C.muted }}>
                          {`${project.id} · ${project.appId}${project.directory ? ` · ${project.directory}` : ""}`}
                        </Text>
                      </Focusable>
                    );
                  }}
                </For>
              </View>
            </ScrollablePage>
          </View>
          <HairlineH soft />
          <View class="flex-row items-center justify-end gap-2 pt-1 w-full">
            <StudioButton
              label={state().openingLocal ? "选择目录中…" : "打开本地项目"}
              kind="secondary"
              size="xs"
              disabled={state().openingLocal}
              onPress={() => void p.openLocal()}
            />
            <StudioButton
              label="+ 新建项目"
              kind="primary"
              size="xs"
              onPress={() => {
                s.workbench.closeProjectMenu();
                p.setCreateOpen(true);
              }}
            />
          </View>
        </View>
      </View>
    </Show>
  );
}
