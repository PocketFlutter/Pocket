// Settings-page panels backed by the service: the project settings form, ecosystem extensions, the diagnostics export and the SDK upgrade.
// (The Studio-local switches and the guest's own OTA self-update stay in pages/settings.tsx.)
import { For, Show, onMount } from "solid-js";
import { InputField, MobileButton, MobileProgress, MobileSwitch } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import { Field, Line, Panel } from "./info.tsx";
import { formatBytes, formatTime } from "../lib/format.ts";
import { modulePlatform } from "../state/ecosystem.ts";
import type { SettingField } from "../state/project-settings.ts";
import type { Studio } from "../state/studio.ts";

const LABEL: Record<SettingField, string> = {
  name: "显示名称",
  appId: "应用 ID",
  version: "版本",
  tickHz: "帧率（1–120）",
  reuse: "复用的已发布包（逗号分隔，可留空）",
};
const ORDER: SettingField[] = ["name", "appId", "version", "tickHz", "reuse"];

/** 项目设置: name, appId, version, read-only build, tickHz, reused packages. Service validation errors appear under the field. */
export function ProjectSettingsPanel(props: { studio: Studio }) {
  const ps = props.studio.projectSettings;
  const state = fromStore(ps.store);
  const projects = fromStore(props.studio.projects.store);
  const dirty = () => { state(); return ps.dirty(); };
  const appIdEdited = () => { state(); return ps.appIdChanged(); };
  const busy = () => state().phase === "loading" || state().phase === "saving";
  // Opening the page reads the current values (a dirty draft of the same project is kept).
  onMount(() => { if (projects().current) void ps.load(projects().current); });
  return (
    <Panel title={projects().current ? `项目设置 · ${projects().current}` : "项目设置"} note="保存后版本和应用 ID 会用于下一次构建和发布；构建号由构建/发布自动递增；窗口标题随显示名称更新。">
      <Show when={!projects().current}><Text class="text-xs" style={{ textColor: C.muted }}>请先在“项目”页打开一个项目。</Text></Show>
      <Show when={projects().current}>
        <Show when={state().phase === "loading" && !state().saved}><Text class="text-xs" style={{ textColor: C.muted }}>正在读取项目设置…</Text></Show>
        <Show when={state().phase === "error"}>
          <Text class="text-xs" style={{ textColor: C.danger }}>{`无法读取项目设置：${state().message ?? ""}`}</Text>
          <MobileButton label="重试" kind="tonal" compact onPress={() => void ps.load(projects().current, true)} />
        </Show>
        <Show when={state().saved}>
          <Line label="当前 Build 号" value={state().baselineBuild ?? "—"} />
          <For each={ORDER}>{(field) => (
            <View class="flex-col gap-1 w-full">
              <Text class="text-xs" style={{ textColor: C.faint }}>{LABEL[field]}</Text>
              <InputField value={() => state().draft[field]} onInput={(v) => ps.setField(field, v)} onSubmit={() => void ps.save()} />
              <Show when={field === "appId" && appIdEdited()}>
                <Text class="text-xs" style={{ textColor: C.warn }}>
                  提示：修改应用包名 (appId) 会同步重写源码中的包引用；保存前请先保存所有未保存的文件标签页。
                </Text>
              </Show>
              <Show when={state().errors[field]}><Text class="text-xs" style={{ textColor: C.danger }}>{state().errors[field]}</Text></Show>
            </View>
          )}</For>
          <Line label="窗口标题" value={state().title} />
          <Show when={state().errors.form}><Text class="text-xs" style={{ textColor: C.danger }}>{state().errors.form}</Text></Show>
          <Text class="text-xs" style={{ textColor: dirty() ? C.warn : C.faint }}>{state().phase === "saving" ? "正在保存…" : dirty() ? "有未保存的项目设置" : "项目设置已是最新"}</Text>
          <View class="flex-row gap-2">
            <MobileButton label="保存项目设置" compact disabled={!dirty() || busy()} onPress={() => void ps.save()} />
            <MobileButton label="还原" kind="outlined" compact disabled={!dirty() || busy()} onPress={() => ps.reset()} />
          </View>
        </Show>
      </Show>
    </Panel>
  );
}

/** 生态设备与微件扩展（按需创建）: Apple & Android system surface / widget extensions. */
export function EcosystemPanel(props: { studio: Studio }) {
  const s = props.studio;
  const eco = fromStore(s.ecosystem.store);
  const projects = fromStore(s.projects.store);
  onMount(() => { if (projects().current) void s.ecosystem.load(projects().current); });
  const appleModules = () => eco().catalog.filter((m) => modulePlatform(m) === "apple");
  const androidModules = () => eco().catalog.filter((m) => modulePlatform(m) === "android");
  const busy = () => eco().loading || eco().applying;
  const profilesText = () => (eco().enabledProfiles.length > 0 ? eco().enabledProfiles.join("、") : "未启用任何系统微件/扩展 Profile");

  return (
    <Panel
      title="生态设备与微件扩展（按需创建）"
      note="勾选需要的 Apple / Android 生态扩展模块，点击“按需生成扩展”将自动生成骨架源码并接线入口。"
    >
      <Show when={!projects().current}><Text class="text-xs" style={{ textColor: C.muted }}>请先在“项目”页打开一个项目。</Text></Show>
      <Show when={projects().current}>
        <Line label="已启用模块数" value={`${eco().savedModules.length} 项（当前勾选 ${eco().selectedModules.length} 项）`} />
        <Line label="已启用 Profiles" value={profilesText()} />
        <Show when={eco().loading}><Text class="text-xs" style={{ textColor: C.muted }}>正在读取生态扩展配置…</Text></Show>
        <Show when={eco().error}><Text class="text-xs" style={{ textColor: C.danger }}>{eco().error}</Text></Show>

        <View class="flex-row flex-wrap gap-2">
          <MobileButton label="全选 Apple" kind="tonal" compact disabled={busy()} onPress={() => s.ecosystem.selectPlatform("apple")} />
          <MobileButton label="全选 Android" kind="tonal" compact disabled={busy()} onPress={() => s.ecosystem.selectPlatform("android")} />
          <MobileButton label="清空" kind="outlined" compact disabled={busy()} onPress={() => s.ecosystem.clearSelection()} />
          <MobileButton
            label={eco().applying ? "生成中…" : "按需生成扩展"}
            kind="filled"
            compact
            disabled={busy()}
            onPress={() => void s.ecosystem.apply()}
          />
        </View>

        <Text class="text-xs font-bold" style={{ textColor: C.body }}>Apple 生态扩展</Text>
        <For each={appleModules()}>{(mod) => (
          <View class="flex-col gap-0.5 w-full">
            <MobileSwitch
              label={`${mod.label ?? mod.id}${mod.entryFile ? ` (${mod.entryFile})` : ""}`}
              value={eco().selectedModules.includes(mod.id)}
              disabled={busy()}
              onChange={() => s.ecosystem.toggle(mod.id)}
            />
            <Show when={mod.description}>
              <Text class="text-xs" style={{ textColor: C.faint }}>{mod.description}</Text>
            </Show>
          </View>
        )}</For>

        <Text class="text-xs font-bold" style={{ textColor: C.body }}>Android 生态扩展</Text>
        <For each={androidModules()}>{(mod) => (
          <View class="flex-col gap-0.5 w-full">
            <MobileSwitch
              label={`${mod.label ?? mod.id}${mod.entryFile ? ` (${mod.entryFile})` : ""}`}
              value={eco().selectedModules.includes(mod.id)}
              disabled={busy()}
              onChange={() => s.ecosystem.toggle(mod.id)}
            />
            <Show when={mod.description}>
              <Text class="text-xs" style={{ textColor: C.faint }}>{mod.description}</Text>
            </Show>
          </View>
        )}</For>

        <Show when={eco().lastResult}>
          {(res) => (
            <View class="flex-col gap-1 w-full">
              <Show when={(res().generatedFiles?.length ?? 0) > 0}>
                <Line label="新增源码文件" value={res().generatedFiles!.join("、")} tone="ok" />
              </Show>
              <Show when={(res().updatedFiles?.length ?? 0) > 0}>
                <Line label="更新文件" value={res().updatedFiles!.join("、")} />
              </Show>
            </View>
          )}
        </Show>
      </Show>
    </Panel>
  );
}

/** 诊断: export button and the result (counts, derived id, download URL, copy of the bundle). */
export function DiagnosticsPanel(props: { studio: Studio; title?: string }) {
  const s = props.studio;
  const state = fromStore(s.diagnostics.store);
  const projects = fromStore(s.projects.store);
  const result = () => state().result;
  return (
    <Panel title={props.title ?? "诊断记录"} note="导出本项目的日志与崩溃记录（路径和密钥已在宿主侧清除）。没有文件对话框：可复制导出编号、下载链接或诊断内容。">
      <View class="flex-row gap-2">
        <MobileButton label={state().phase === "exporting" ? "导出中…" : "导出诊断记录"} compact kind="tonal" disabled={!projects().current || state().phase === "exporting"} onPress={() => void s.diagnostics.run()} />
        <MobileButton label="仅崩溃" compact kind="text" disabled={!projects().current || state().phase === "exporting"} onPress={() => void s.diagnostics.run("crash")} />
      </View>
      <Show when={!projects().current}><Text class="text-xs" style={{ textColor: C.muted }}>请先打开一个项目。</Text></Show>
      <Show when={state().phase === "done" || state().phase === "error"}><MobileButton label="清除结果" compact kind="text" onPress={() => s.diagnostics.reset()} /></Show>
      <Show when={state().phase === "error"}><Text class="text-xs" style={{ textColor: C.danger }}>{`导出失败：${state().message ?? ""}`}</Text></Show>
      <Show when={result()}>
        {(r) => (
          <View class="flex-col gap-1 w-full">
            <Line label="导出时间" value={formatTime(r().exportedAt)} />
            <Line label="范围" value={r().kind === "crash" ? "仅崩溃记录" : r().kind === "log" ? "仅日志" : "日志与崩溃记录"} />
            <Line label="记录" value={`共 ${r().totalRecords} 条（日志 ${r().logCount} · 崩溃 ${r().crashCount}）`} tone={r().crashCount > 0 ? "warn" : undefined} />
            <Show when={r().truncated}><Text class="text-xs" style={{ textColor: C.warn }}>{`内容过大：仅包含最近 ${r().keptRecords} 条，另有 ${r().omitted} 条请通过下载链接获取。`}</Text></Show>
            <Field label="导出编号" value={r().exportId} onCopy={(text, label) => void s.copy(text, label)} />
            <Field label="下载链接（完整文件，仅本机服务可访问）" value={r().downloadUrl} onCopy={(text, label) => void s.copy(text, label)} copyLabel="下载链接" />
            <MobileButton label="复制诊断内容（JSON）" compact kind="outlined" onPress={() => { const text = s.diagnostics.bundleText(); if (text) void s.copy(text, "诊断内容"); }} />
            <For each={r().records.slice(0, 5)}>{(record) => (
              <Text class="text-xs" style={{ textColor: record.kind === "crash" ? C.danger : C.muted }}>{`${String(record.kind ?? "log")}  ${String(record.message ?? "").slice(0, 120)}`}</Text>
            )}</For>
            <Show when={r().records.length === 0}><Text class="text-xs" style={{ textColor: C.faint }}>没有匹配的记录。</Text></Show>
          </View>
        )}
      </Show>
    </Panel>
  );
}

/** SDK 升级: the editor service's SDK (not this guest): version, latest release, mode, check and apply. */
export function SdkUpgradePanel(props: { studio: Studio }) {
  const s = props.studio;
  const state = fromStore(s.sdkUpgrade.store);
  onMount(() => { void s.sdkUpgrade.load(); });
  const info = () => state().info;
  const busy = () => state().phase === "checking" || state().phase === "applying" || state().phase === "restarting" || state().phase === "loading";
  const tone = (t: "ok" | "warn" | "danger" | "info") => (t === "ok" ? C.ok : t === "warn" ? C.warn : t === "danger" ? C.danger : C.muted);
  const isDownloadingWithTotal = () => info()?.status === "downloading" && (info()?.downloadTotalBytes ?? 0) > 0;
  return (
    <Panel title="SDK 升级（编辑服务）" note="升级的是 Studio 背后的 SDK 编辑服务，不是 Studio 自身（Studio 自身更新在“Studio”页）。检查不会自动应用；应用前会再确认。">
      <Line label="当前版本" value={info()?.currentVersion ? `v${info()!.currentVersion}` : undefined} />
      <Line label="最新发布" value={info()?.latestVersion ? `v${info()!.latestVersion}` : undefined} tone={info()?.upgradeAvailable ? "warn" : undefined} />
      <Line label="运行模式" value={info() ? (info()!.mode === "standalone" ? "独立安装（可升级）" : info()!.mode === "source" ? "源码检出（只检查，不覆盖 Git 工作区）" : "未知") : undefined} />
      <Show when={info()?.modeReason}><Line label="模式说明" value={info()!.modeReason} /></Show>
      <Line label="平台" value={info()?.platform} />
      <Line label="上次检查" value={formatTime(info()?.checkedAt)} />
      <Show when={info()?.appliedAt}><Line label="上次应用" value={formatTime(info()!.appliedAt)} /></Show>
      <Show when={isDownloadingWithTotal()}>
        <MobileProgress
          value={info()!.downloadedBytes ?? 0}
          max={info()!.downloadTotalBytes!}
          label={`正在下载升级包 (${formatBytes(info()!.downloadedBytes ?? 0)} / ${formatBytes(info()!.downloadTotalBytes!)})`}
          animated={false}
        />
      </Show>
      <Show when={info()?.releaseUrl}><Field label="发布说明" value={info()!.releaseUrl} onCopy={(text, label) => void s.copy(text, label)} copyLabel="发布说明链接" /></Show>
      <View class="flex-row gap-2">
        <MobileButton label={state().phase === "checking" ? "检查中…" : "检查 SDK 更新"} kind="tonal" compact disabled={busy()} onPress={() => void s.sdkUpgrade.check()} />
        <Show when={info()?.upgradeAvailable}>
          <MobileButton label="应用 SDK 升级" compact disabled={busy()} onPress={() => void s.sdkUpgrade.apply()} />
        </Show>
      </View>
      <Show when={state().notice}>{(n) => <Text class="text-xs" style={{ textColor: tone(n().tone) }}>{n().text}</Text>}</Show>
      <Show when={info()?.deferredReason}>
        <View class="flex-col gap-1 p-2 rounded-lg bg-[#3F2F0B] w-full">
          <Text class="text-xs font-bold" style={{ textColor: C.warn }}>自动升级已暂缓</Text>
          <Text class="text-xs" style={{ textColor: C.warn }}>{info()!.deferredReason}</Text>
        </View>
      </Show>
    </Panel>
  );
}
