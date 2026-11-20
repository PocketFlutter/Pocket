import { For, Show, createEffect } from "solid-js";
import { MobileSegmentedControl, MobileSwitch, ScrollablePage } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { DEBOUNCE_CHOICES } from "../state/settings.ts";
import { C } from "../ui/theme.ts";
import { Line, Panel } from "../components/info.tsx";
import { DiagnosticsPanel, EcosystemPanel, ProjectSettingsPanel, SdkUpgradePanel } from "../components/settings-panels.tsx";
import { helpRows } from "../keymap.ts";
import type { Studio } from "../state/studio.ts";
import { Eyebrow, HairlineH, StudioButton } from "../components/workbench-ui.tsx";

export function SettingsPage(props: { studio: Studio; inspector?: boolean }) {
  const s = props.studio;
  const settings = fromStore(s.settings.store);
  const preview = fromStore(s.preview.store);
  const update = fromStore(s.selfUpdate.store);
  const wb = fromStore(s.workbench.store);
  const section = () => wb().settingsSection;

  createEffect(() => { void s.selfUpdate.load(); });

  return (
    <View class="flex-col flex-1 h-full w-full" style={{ bgColor: props.inspector ? C.surface : C.bg, minH: 0 }}>
      <View
        class={props.inspector ? "flex-col gap-1.5 px-3 py-2 w-full" : "flex-row items-center justify-between gap-3 px-3 py-1.5 w-full"}
        style={{ bgColor: C.surface, shrink: 0 }}
      >
        <View class="flex-row items-center gap-2" style={{ shrink: 0 }}>
          <Text class="text-xs font-bold" style={{ textColor: C.text }}>设置</Text>
          <Eyebrow text="PREFERENCES" />
        </View>
        <View class={props.inspector ? "w-full" : "flex-1 max-w-[440]"}>
          <MobileSegmentedControl
            items={[
              { id: "studio", label: "Studio" },
              { id: "project", label: "项目设置" },
              { id: "service", label: "诊断与 SDK 升级" },
            ]}
            active={section()}
            onChange={(id) => s.workbench.setSettingsSection(id === "project" || id === "service" ? id : "studio")}
          />
        </View>
      </View>
      <HairlineH />

      <View class="flex-col p-2.5 flex-1 w-full" style={{ minH: 0 }}>
        <ScrollablePage>
          <Show when={section() === "project"}>
            <View class="flex-col gap-2.5 w-full">
              <ProjectSettingsPanel studio={s} />
              <EcosystemPanel studio={s} />
            </View>
          </Show>
          <Show when={section() === "service"}>
            <View class="flex-col gap-2.5 w-full">
              <DiagnosticsPanel studio={s} />
              <SdkUpgradePanel studio={s} />
            </View>
          </Show>
          <Show when={section() === "studio"}>
            <View class="flex-col gap-2 w-full">
              <Panel title="工作台偏好" eyebrow="EDITOR & PREVIEW">
                <MobileSwitch
                  label="保存后自动构建并刷新预览"
                  value={settings().autoBuild}
                  onChange={(v: boolean) => void s.settings.set({ autoBuild: v })}
                />
                <View class="flex-row items-center justify-between gap-2 w-full">
                  <Text class="text-2xs font-bold" style={{ textColor: C.faint, shrink: 0 }}>自动构建等待时间</Text>
                  <View class="flex-1 max-w-[260]">
                    <MobileSegmentedControl
                      items={DEBOUNCE_CHOICES.map((ms) => ({ id: String(ms), label: ms < 1000 ? `${ms} 毫秒` : `${ms / 1000} 秒` }))}
                      active={String(settings().debounceMs)}
                      onChange={(id) => void s.settings.set({ debounceMs: Number(id) })}
                    />
                  </View>
                </View>
                <MobileSwitch
                  label="在“源码”页右侧显示实时预览"
                  value={settings().dockPreview}
                  onChange={(v: boolean) => void s.settings.set({ dockPreview: v })}
                />
                <View class="flex-row items-center justify-between gap-2 w-full">
                  <Text class="text-2xs font-bold" style={{ textColor: C.faint, shrink: 0 }}>编辑器</Text>
                  <View class="flex-1 max-w-[300]">
                    <MobileSegmentedControl
                      items={[
                        { id: "input", label: "多行输入框（备用）" },
                        { id: "code", label: "代码视图（默认）" },
                      ]}
                      active={settings().editor}
                      onChange={(id) => void s.settings.set({ editor: id === "code" ? "code" : "input" })}
                    />
                  </View>
                </View>
                <View class="flex-row items-center justify-between gap-2 flex-wrap w-full">
                  <Text class="text-2xs" style={{ textColor: settings().persistence === "unavailable" ? C.warn : C.faint }}>
                    {settings().persistence === "ok" ? "设置已保存到本机。" : settings().persistence === "unavailable" ? "设置存储不可用：更改仅在本次会话有效。" : "正在读取设置…"}
                  </Text>
                  <Text class="text-2xs" style={{ textColor: preview().runtime === "unavailable" ? C.danger : C.faint }}>
                    {preview().runtime === "unavailable" ? `预览运行时不可用：${preview().runtimeMessage ?? ""}` : "预览运行时：按需初始化"}
                  </Text>
                </View>
              </Panel>

              <Panel
                title="Studio 更新"
                eyebrow="SELF-UPDATE (OTA)"
                note="Studio 通过服务的已签名测试频道更新自己；内置版本始终是后备。应用后由宿主验证签名并试运行，不健康会自动回滚。"
              >
                <Line label="当前版本" value={update().activeVersion ? `v${update().activeVersion} · 构建 ${update().activeBuild ?? "?"}` : undefined} />
                <Line label="宿主阶段" value={update().stage} />
                <Show when={update().candidateVersion}>
                  <Line label="可用更新" value={`v${update().candidateVersion} · 构建 ${update().candidateBuild}`} tone="ok" />
                </Show>
                <Show when={update().lastError}>
                  <Text class="text-xs" style={{ textColor: C.warn }}>{`上次更新失败（已回滚到可用版本）：${update().lastError}`}</Text>
                </Show>
                <Show when={update().message}>
                  <Text class="text-xs" style={{ textColor: update().phase === "error" || update().phase === "unavailable" ? C.danger : C.muted }}>
                    {update().message}
                  </Text>
                </Show>
                <View class="flex-row gap-2">
                  <StudioButton
                    label="检查 Studio 更新"
                    kind="secondary"
                    size="xs"
                    disabled={update().phase === "checking" || update().phase === "applying" || update().phase === "unavailable"}
                    onPress={() => void s.selfUpdate.check()}
                  />
                  <Show when={update().phase === "available"}>
                    <StudioButton label="应用更新" kind="primary" size="xs" onPress={() => void s.selfUpdate.apply()} />
                  </Show>
                </View>
              </Panel>

              <Panel
                title="键盘快捷键"
                eyebrow="SHORTCUTS"
                note="Cmd 为主修饰键（非 macOS 为 Ctrl）。标有“编辑器”的快捷键在代码视图获得键盘时由编辑器处理，其余快捷键始终由 Studio 外壳优先处理。"
              >
                <For each={helpRows("mac")}>
                  {(row) => <Line label={row.chord} value={`${row.label}${row.scope === "editor" ? "（编辑器内由编辑器处理）" : ""}`} />}
                </For>
              </Panel>
            </View>
          </Show>
        </ScrollablePage>
      </View>
    </View>
  );
}
