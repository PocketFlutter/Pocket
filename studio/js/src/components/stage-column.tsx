// Zone D — Center Multi-Target Simultaneous Preview Stage & Collapsible 4-Tab Console Dock (`.stage-column`)
// Supports running Flutter native canvas, Web viewport, WeChat Mini Program (`wx.*` capsule),
// and extensible Ecosystem System Widgets / Live Activities / Watch tiles simultaneously.
import { For, Show } from "solid-js";
import { ScrollablePage } from "@pocket/ui";
import { getSurfaceProfile } from "@pocket/ui/surface-catalog";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import { ACTIVE_JOB } from "../state/deploy.ts";
import {
  PREVIEW_TARGET_SPECS,
  RENDER_MODE_OPTIONS,
  WIDGET_SURFACE_PROFILES,
  type PreviewTargetId,
} from "../state/preview.ts";
import type { ConsoleTab } from "../state/workbench.ts";
import type { Studio } from "../state/studio.ts";
import { PREVIEW_PHASE_LABEL } from "./preview-surface.tsx";
import { DeployPane, PreviewHardwareStage } from "../pages/preview.tsx";
import { ProjectsWorkbenchCard } from "../pages/projects.tsx";
import { ConsolePane } from "../pages/console.tsx";
import { ArtifactsPane } from "../pages/artifacts.tsx";
import { Field, Line, Panel } from "./info.tsx";
import { shortHash } from "../lib/format.ts";
import { CapsuleToggle, Eyebrow, HairlineH, LiveChip, StateChip, StudioButton, UnderlineTabs } from "./workbench-ui.tsx";

const QUICK_WIDGET_PRESETS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "ios-widget-small", label: "小号" },
  { id: "ios-widget-medium", label: "中号" },
  { id: "ios-widget-large", label: "大号" },
  { id: "ios-live-activity-expanded", label: "灵动岛" },
  { id: "apple-watch-45mm", label: "Watch" },
  { id: "android-widget-medium", label: "安卓 4×2" },
  { id: "wear-os-tile", label: "圆表磁贴" },
];

/** Tab 4 of `.console-dock`: Quick Signing & Release summary matching `#console-pane-signing`. */
function SigningQuickPane(props: { studio: Studio }) {
  const s = props.studio;
  const pub = fromStore(s.publish.store);
  const a = fromStore(s.artifacts.store);
  const project = () => s.projects.current();
  const last = () => pub().lastPublish ?? pub().info;
  const copy = (text: string, what: string) => { void s.copy(text, what); };

  return (
    <View class="flex-col p-3 flex-1 h-full w-full" style={{ bgColor: C.bgRaised, minH: 0 }}>
      <ScrollablePage>
        <View class="flex-col gap-2 w-full">
          <Panel
            title="发布此构建版本"
            eyebrow="SIGNING & OTA"
            right={
              <View class="flex-row items-center gap-1.5">
                <Show when={a().bytecode?.runtimeAbi}>
                  <StateChip label={`ABI ${shortHash(a().bytecode!.runtimeAbi!, 10, 6)}`} tone="neutral" />
                </Show>
                <StudioButton
                  label="打开版本发布"
                  kind="primary"
                  size="xs"
                  disabled={!project()}
                  onPress={() => s.setPage("publish")}
                />
              </View>
            }
            note="选择频道后，在右侧检查器“版本发布”面板签名构建并同步到本地版本槽或腾讯云 COS。"
          >
            <Show
              when={last()}
              fallback={<Text class="text-xs" style={{ textColor: C.muted }}>尚未发布任何签名版本。</Text>}
            >
              {(info) => (
                <View class="flex-col gap-1 w-full">
                  <Line
                    label="最近发布"
                    value={`${info().channel === "release" ? "稳定版" : "测试版"}${info().version ? ` · v${info().version}` : ""}${info().build !== undefined ? ` · 构建 ${info().build}` : ""}`}
                    tone="ok"
                  />
                  <Field label="App 接入地址" value={info().appConfigUrl} copyLabel="App 接入地址" onCopy={copy} />
                </View>
              )}
            </Show>
            <View class="flex-row items-center gap-2 pt-1">
              <StudioButton
                label={pub().offline.phase === "working" ? "正在生成…" : "生成离线包 (.tar.gz)"}
                kind="secondary"
                size="xs"
                disabled={!project() || pub().offline.phase === "working"}
                onPress={() => void s.publish.makeOffline()}
              />
              <StudioButton
                label="查看版本槽位"
                kind="quiet"
                size="xs"
                disabled={!project()}
                onPress={() => s.setPage("versions")}
              />
            </View>
            <Show when={pub().offline.phase === "done"}>
              <Field label="离线归档地址" value={pub().offline.archiveUrl} copyLabel="离线包地址" onCopy={copy} />
            </Show>
          </Panel>
        </View>
      </ScrollablePage>
    </View>
  );
}

export function StageColumn(props: { studio: Studio }) {
  const s = props.studio;
  const wb = fromStore(s.workbench.store);
  const preview = fromStore(s.preview.store);
  const deploy = fromStore(s.deploy.store);
  const build = fromStore(s.build.store);
  const projects = fromStore(s.projects.store);

  const project = () => projects().current;
  const job = () => deploy().job;
  const selectedDevice = () => deploy().devices.find((d) => d.id === deploy().selected);
  const activeTargets = () => preview().activeTargets;
  const multiActive = () => activeTargets().length >= 3;
  const hasWidgetTarget = () => activeTargets().includes("widget") || activeTargets().includes("widgetAlt");
  const anySlotRunning = () =>
    (Object.keys(preview().slots) as PreviewTargetId[]).some((k) => preview().slots[k].instanceId !== undefined);

  const phaseTone = () =>
    preview().phase === "running"
      ? "good"
      : preview().phase === "error"
        ? "bad"
        : preview().phase === "idle"
          ? "neutral"
          : "warn";

  const selectConsoleTab = (tab: ConsoleTab) => {
    s.workbench.setConsoleTab(tab);
    if (tab === "artifacts" && project()) void s.artifacts.refresh();
    if (tab === "signing" && project()) void s.publish.enter();
  };

  const cycleWidgetProfile = () => {
    const list = WIDGET_SURFACE_PROFILES;
    if (list.length === 0) return;
    const idx = list.findIndex((p) => p.id === preview().widgetProfileId);
    const next = list[(idx + 1) % list.length]!;
    s.preview.setWidgetProfile(next.id, "widget");
  };

  const currentWidgetProfile = () => getSurfaceProfile(preview().widgetProfileId);

  return (
    <View class="flex-col flex-1 h-full overflow-hidden" style={{ bgColor: C.bg, minW: 0, minH: 0 }}>
      {/* Row 1: Unified Multi-Target Preview Toolbar (`.preview-toolbar`, auto-wrapping without clipping) */}
      <View
        class="flex-row flex-wrap items-center justify-between gap-1.5 px-2.5 py-1.5 w-full"
        style={{ bgColor: C.surface, shrink: 0, minH: 38 }}
      >
        {/* Left: Multi-Target Simultaneous Preview Selector + Build/Refresh */}
        <View class="flex-row items-center gap-1.5 flex-wrap" style={{ shrink: 1, minW: 0 }}>
          <View
            class="flex-row items-center gap-0.5 p-0.5 rounded-md flex-wrap"
            style={{ bgColor: C.bgRaised, borderColor: C.line, borderWidth: 1, radius: 7 }}
          >
            <For each={PREVIEW_TARGET_SPECS}>
              {(spec) => {
                const active = () => activeTargets().includes(spec.id);
                const slotRunning = () => preview().slots[spec.id].phase === "running";
                return (
                  <CapsuleToggle
                    label={slotRunning() ? `● ${spec.shortLabel}` : spec.shortLabel}
                    active={active()}
                    onPress={() => void s.preview.toggleTarget(spec.id)}
                  />
                );
              }}
            </For>
            <StudioButton
              label={multiActive() ? "单端聚焦" : "四端同屏"}
              kind={multiActive() ? "active" : "quiet"}
              size="xs"
              onPress={() =>
                void s.preview.setTargets(
                  multiActive() ? ["flutter"] : ["flutter", "web", "wechat", "widget"],
                )
              }
            />
          </View>

          <View
            class="flex-row items-center gap-1 px-1.5 py-0.5 rounded-md"
            style={{ bgColor: C.bgRaised, borderColor: C.line, borderWidth: 1, radius: 6, shrink: 0 }}
          >
            <LiveChip label={PREVIEW_PHASE_LABEL[preview().phase]} tone={phaseTone()} />
            <StudioButton
              label="构建并刷新预览"
              kind="secondary"
              size="xs"
              disabled={!project()}
              onPress={() => void s.preview.run({ build: true })}
            />
            <StudioButton
              label="刷新"
              kind="quiet"
              size="xs"
              disabled={!project()}
              onPress={() => void s.preview.run({ build: false })}
            />
            <Show when={anySlotRunning() || preview().instanceId !== undefined}>
              <StudioButton label="关闭预览" kind="text" size="xs" onPress={() => void s.preview.reset()} />
            </Show>
          </View>
        </View>

        {/* Right: Simulator / Physical Device Target Capsule */}
        <View
          class="flex-row items-center gap-1 px-1.5 py-0.5 rounded-md"
          style={{ bgColor: C.bgRaised, borderColor: C.line, borderWidth: 1, radius: 6, shrink: 0 }}
        >
          <Eyebrow text="设备" />
          <StudioButton
            label={selectedDevice() ? selectedDevice()!.name : deploy().devicesLoaded ? "无可用设备" : "选择设备"}
            kind="quiet"
            size="xs"
            onPress={() => {
              s.workbench.setConsoleTab("deploy");
              if (!deploy().devicesLoaded) void s.deploy.loadDevices();
            }}
          />
          <StudioButton
            label={job() && ACTIVE_JOB.includes(job()!.status) ? (job()!.status === "running" ? "已运行" : "部署中…") : "运行"}
            kind="secondary"
            size="xs"
            disabled={!project() || !deploy().selected || deploy().starting || (job() !== undefined && ACTIVE_JOB.includes(job()!.status))}
            onPress={() => {
              s.workbench.setConsoleTab("deploy");
              void s.deploy.start();
            }}
          />
          <Show when={job() && ACTIVE_JOB.includes(job()!.status)}>
            <StudioButton label="停止" kind="danger" size="xs" onPress={() => void s.deploy.cancel()} />
          </Show>
        </View>
      </View>
      <HairlineH />

      {/* Row 2: Context-Aware Stage HUD Bar (`.preview-header`, auto-wrapping without clipping) */}
      <View
        class="flex-row flex-wrap items-center justify-between gap-1.5 px-2.5 py-1 w-full"
        style={{ bgColor: C.stageHud, shrink: 0, minH: 34 }}
      >
        {/* Left: Flutter Device Viewport & Bezel Presets */}
        <View
          class="flex-row items-center gap-0.5 p-0.5 rounded-lg"
          style={{ bgColor: C.surface, borderColor: C.line, borderWidth: 1, radius: 7, shrink: 0 }}
        >
          <CapsuleToggle
            label="手机 · 390×844"
            active={wb().viewportPreset === "mobile"}
            onPress={() => s.workbench.setViewportPreset("mobile")}
          />
          <CapsuleToggle
            label="平板"
            active={wb().viewportPreset === "tablet"}
            onPress={() => s.workbench.setViewportPreset("tablet")}
          />
          <CapsuleToggle
            label="桌面"
            active={wb().viewportPreset === "desktop"}
            onPress={() => s.workbench.setViewportPreset("desktop")}
          />
          <CapsuleToggle
            label="设备边框"
            active={wb().bezelEnabled}
            onPress={() => s.workbench.toggleBezel()}
          />
        </View>

        {/* Center: Dynamic Widget / Ecosystem Micro-Surface Profile & RenderMode Controls */}
        <Show
          when={hasWidgetTarget()}
          fallback={
            <View class="flex-row items-center gap-1" style={{ shrink: 1 }}>
              <Text class="text-2xs" style={{ textColor: C.faint }}>
                {`同屏预览槽：已启用 ${activeTargets().length} 端`}
              </Text>
            </View>
          }
        >
          <View class="flex-row items-center gap-1 flex-wrap" style={{ shrink: 1, minW: 0 }}>
            <View
              class="flex-row items-center gap-0.5 p-0.5 rounded-lg flex-wrap"
              style={{ bgColor: C.surface, borderColor: C.line, borderWidth: 1, radius: 7 }}
            >
              <For each={QUICK_WIDGET_PRESETS}>
                {(preset) => (
                  <CapsuleToggle
                    label={preset.label}
                    active={preview().widgetProfileId === preset.id}
                    onPress={() => s.preview.setWidgetProfile(preset.id, "widget")}
                  />
                )}
              </For>
              <StudioButton
                label={`更多规格 (${WIDGET_SURFACE_PROFILES.length}) ↻`}
                kind="quiet"
                size="xs"
                onPress={cycleWidgetProfile}
              />
            </View>
            <View
              class="flex-row items-center gap-0.5 p-0.5 rounded-lg"
              style={{ bgColor: C.surface, borderColor: C.line, borderWidth: 1, radius: 7 }}
            >
              <For each={RENDER_MODE_OPTIONS}>
                {(mode) => {
                  const allowed = () => currentWidgetProfile()?.supportedRenderModes.includes(mode.id) ?? true;
                  return (
                    <Show when={allowed()}>
                      <CapsuleToggle
                        label={mode.label}
                        active={preview().widgetRenderMode === mode.id}
                        onPress={() => s.preview.setWidgetRenderMode(mode.id, "widget")}
                      />
                    </Show>
                  );
                }}
              </For>
            </View>
          </View>
        </Show>

        {/* Right: Scaffold & Diagnostics */}
        <View class="flex-row items-center gap-1" style={{ shrink: 0 }}>
          <StudioButton
            label="＋ 生态/微件"
            kind="quiet"
            size="xs"
            disabled={!project()}
            onPress={() => {
              s.workbench.setSettingsSection("project");
              s.setPage("settings");
            }}
          />
          <StudioButton
            label="导出诊断"
            kind="quiet"
            size="xs"
            disabled={!project()}
            onPress={() => {
              s.workbench.setConsoleTab("build");
              void s.diagnostics.run();
            }}
          />
        </View>
      </View>
      <HairlineH soft />

      {/* Row 3: Interactive Simultaneous Multi-Target Stage Canvas (`#preview-stage-wrap`) */}
      <View class="flex-col items-center justify-center flex-1 w-full h-full overflow-hidden" style={{ bgColor: C.bg, minH: 180 }}>
        <Show
          when={project()}
          fallback={
            <View class="flex-col p-4 w-full h-full flex-1 items-center justify-center" style={{ minH: 0 }}>
              <ProjectsWorkbenchCard studio={s} embedded />
            </View>
          }
        >
          <PreviewHardwareStage studio={s} />
        </Show>
      </View>

      {/* Row 4: Collapsible Bottom Console & Build Output Dock (`.console-dock`) */}
      <HairlineH />
      <View
        class="flex-col w-full"
        style={{
          height: wb().consoleOpen ? (wb().consoleTall ? 320 : multiActive() ? 148 : 184) : 32,
          bgColor: C.bgRaised,
          shrink: 0,
        }}
      >
        {/* `.console-header` (32px) */}
        <View class="flex-row items-center justify-between px-2.5 w-full" style={{ height: 32, bgColor: C.surface, shrink: 0 }}>
          <UnderlineTabs<ConsoleTab>
            height={32}
            active={wb().consoleTab}
            onSelect={selectConsoleTab}
            items={[
              {
                id: "build",
                label: "构建日志",
                badge: build().diagnostics.length > 0 ? `${build().diagnostics.length}` : undefined,
              },
              { id: "deploy", label: "部署输出" },
              { id: "artifacts", label: "产物清单" },
              { id: "signing", label: "签名发布" },
            ]}
          />
          <View class="flex-row items-center gap-1.5" style={{ shrink: 0 }}>
            <Show when={wb().consoleOpen && wb().consoleTab === "build"}>
              <StudioButton label="清空" kind="text" size="xs" onPress={() => s.build.clearLogs()} />
            </Show>
            <Show when={wb().consoleOpen}>
              <StudioButton
                label={wb().consoleTall ? "还原高度" : "展开高度"}
                kind="quiet"
                size="xs"
                onPress={() => s.workbench.toggleConsoleTall()}
              />
            </Show>
            <StudioButton
              label={wb().consoleOpen ? "折叠 ⌄" : "展开 ▴"}
              shortcut="⌘J"
              kind="quiet"
              size="xs"
              onPress={() => s.workbench.toggleConsole()}
            />
          </View>
        </View>
        <Show when={wb().consoleOpen}>
          <HairlineH />
          <View class="flex-col flex-1 w-full" style={{ minH: 0 }}>
            <Show when={wb().consoleTab === "build"}><ConsolePane studio={s} /></Show>
            <Show when={wb().consoleTab === "deploy"}><DeployPane studio={s} /></Show>
            <Show when={wb().consoleTab === "artifacts"}><ArtifactsPane studio={s} /></Show>
            <Show when={wb().consoleTab === "signing"}><SigningQuickPane studio={s} /></Show>
          </View>
        </Show>
      </View>
    </View>
  );
}
