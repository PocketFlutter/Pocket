import { For, Show, createEffect } from "solid-js";
import { MobileProgress, MobileSegmentedControl, ScrollablePage } from "@pocket/ui";
import { PocketStoredImage } from "@pocket/ui/images";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import { Panel } from "../components/info.tsx";
import { assetKind, KIND_LABEL, previewBlocker } from "../lib/assets.ts";
import { formatBytes } from "../lib/format.ts";
import { uploadProgress, type UploadRow } from "../state/assets.ts";
import { assetPreviewKey, resourcePreviewKey, type PreviewState } from "../state/images.ts";
import type { Studio } from "../state/studio.ts";
import { Eyebrow, HairlineH, HairlineV, StateChip, StudioButton } from "../components/workbench-ui.tsx";

const PREVIEW_BOX = 160;
const UPLOAD_LABEL: Record<UploadRow["state"], string> = {
  queued: "等待",
  reading: "读取中",
  uploading: "上传中",
  done: "完成",
  failed: "失败",
  refused: "已拒绝",
  cancelled: "已取消",
};

/** Host-decoded thumbnail of one key, or honest explanation when unavailable. */
function Preview(props: { studio: Studio; id: string | undefined; blocker?: string }) {
  const images = fromStore(props.studio.previews.store);
  const entry = (): PreviewState | undefined => (props.id ? images().items[props.id] : undefined);
  return (
    <View class="flex-col gap-1.5 w-full">
      <Show when={props.blocker}><Text class="text-xs" style={{ textColor: C.warn }}>{props.blocker}</Text></Show>
      <Show when={!props.blocker && entry()?.status === "loading"}><Text class="text-xs" style={{ textColor: C.muted }}>正在解码预览…</Text></Show>
      <Show when={!props.blocker && entry()?.status === "unavailable"}>
        <Text class="text-xs" style={{ textColor: C.warn }}>{(entry() as { reason: string }).reason}</Text>
      </Show>
      <Show when={!props.blocker && entry()?.status === "ready"}>
        <View
          class="items-center justify-center rounded-lg p-1.5"
          style={{ width: PREVIEW_BOX + 12, bgColor: C.stageDevice, borderColor: C.line, borderWidth: 1, radius: 7 }}
        >
          <PocketStoredImage client={props.studio.previews.client} imageId={props.id} width={PREVIEW_BOX} height={PREVIEW_BOX} debugName="studio-preview" />
        </View>
        <Text class="text-2xs" style={{ textColor: C.faint }}>
          {`预览（宿主解码，最长边 ≤128 px）${(() => { const e = entry(); return e && e.status === "ready" ? ` · 原图 ${e.image.sourceWidth}×${e.image.sourceHeight}` : ""; })()}`}
        </Text>
      </Show>
    </View>
  );
}

function UploadRows(props: { studio: Studio }) {
  const s = props.studio;
  const a = fromStore(s.assets.store);
  return (
    <Show when={a().rows.length > 0}>
      <Panel title="上传队列" eyebrow="ASSET UPLOAD">
        <For each={a().rows}>
          {(row) => (
            <View class="flex-col gap-1 w-full">
              <Text
                class="text-xs font-mono"
                style={{ textColor: row.state === "failed" || row.state === "refused" ? C.danger : row.state === "done" ? C.ok : C.body }}
              >
                {`${row.name} · ${formatBytes(row.size)} · ${UPLOAD_LABEL[row.state]}`}
              </Text>
              <Show when={row.state === "reading" || row.state === "uploading"}>
                <MobileProgress value={Math.round(uploadProgress(row) * 100)} max={100} label={row.state === "reading" ? "读取" : "上传"} animated={false} />
              </Show>
              <Show when={row.error}>
                <Text class="text-xs" style={{ textColor: row.state === "cancelled" ? C.muted : C.danger }}>{row.error}</Text>
              </Show>
            </View>
          )}
        </For>
        <View class="flex-row gap-2">
          <Show when={a().busy}><StudioButton label="取消" kind="secondary" size="xs" onPress={() => s.assets.cancel()} /></Show>
          <Show when={!a().busy}><StudioButton label="清除记录" kind="quiet" size="xs" onPress={() => s.assets.clearFinished()} /></Show>
        </View>
      </Panel>
    </Show>
  );
}

function AssetFiles(props: { studio: Studio; inspector?: boolean }) {
  const s = props.studio;
  const ws = fromStore(s.workspace.store);
  const up = fromStore(s.assets.store);
  const asset = () => ws().asset;
  const project = () => ws().project;
  const previewId = (): string | undefined => {
    const a = asset();
    const p = project();
    return a && p && a.mtimeMs !== undefined ? assetPreviewKey(p, a.name, `${a.bytes}:${a.mtimeMs}`) : undefined;
  };
  createEffect(() => {
    const a = asset();
    const p = project();
    const id = previewId();
    if (!a || !p || !id || previewBlocker(a.name)) return;
    void s.previews.request(id, () => s.client.assets.preview(p, a.name));
  });

  const DetailCard = () => (
    <Show
      when={asset()}
      fallback={
        <View class="p-3 rounded-lg w-full" style={{ bgColor: C.bgRaised, borderColor: C.line, borderWidth: 1, radius: 7 }}>
          <Text class="text-xs" style={{ textColor: C.muted }}>选择资源以查看信息。</Text>
        </View>
      }
    >
      {(a) => (
        <Panel title={a().name} eyebrow="ASSET DETAIL">
          <Text class="text-xs font-mono" style={{ textColor: C.muted }}>{a().path}</Text>
          <Show when={a().bytes !== undefined}><Text class="text-xs" style={{ textColor: C.body }}>{`大小：${formatBytes(a().bytes!)}`}</Text></Show>
          <Show when={a().mtimeMs !== undefined}>
            <Text class="text-xs font-mono" style={{ textColor: C.body }}>
              {`修改时间：${new Date(a().mtimeMs!).toISOString().replace("T", " ").slice(0, 19)} UTC`}
            </Text>
          </Show>
          <Show when={a().error}><Text class="text-xs" style={{ textColor: C.danger }}>{a().error}</Text></Show>
          <Show when={a().mtimeMs !== undefined || previewBlocker(a().name)}>
            <Preview studio={s} id={previewId()} blocker={previewBlocker(a().name)} />
          </Show>
        </Panel>
      )}
    </Show>
  );

  if (props.inspector) {
    return (
      <View class="flex-col gap-2.5 flex-1 p-3 w-full" style={{ minH: 0 }}>
        <View class="flex-row items-center justify-between gap-2 w-full" style={{ shrink: 0 }}>
          <StudioButton
            label="上传资源…"
            kind="primary"
            size="xs"
            disabled={!project() || up().picking || up().busy || up().unavailable !== undefined}
            onPress={() => void s.assets.pick()}
          />
          <Text class="text-2xs flex-1" style={{ textColor: C.faint }}>图片 · 音频 · 字体 ≤ 32 MiB</Text>
        </View>
        <Show when={up().unavailable}><Text class="text-xs" style={{ textColor: C.warn }}>{up().unavailable}</Text></Show>
        <Show when={ws().project && ws().assets.length === 0}>
          <Text class="text-xs" style={{ textColor: C.muted }}>assets/ 中还没有资源。</Text>
        </Show>
        <ScrollablePage>
          <View class="flex-col gap-2 w-full">
            <UploadRows studio={s} />
            <For each={ws().assets}>
              {(name) => {
                const selected = () => asset()?.name === name;
                return (
                  <Focusable
                    class="flex-row items-center justify-between px-3 py-2 rounded-lg w-full"
                    style={{
                      bgColor: selected() ? C.primarySoft : C.bgRaised,
                      borderColor: selected() ? C.primaryBorder : C.line,
                      borderWidth: 1,
                      radius: 7,
                    }}
                    onPress={() => void s.workspace.selectAsset(name)}
                  >
                    <Text class="text-xs font-mono font-bold" style={{ textColor: C.text }}>{name}</Text>
                    <StateChip label={KIND_LABEL[assetKind(name)]} tone={selected() ? "info" : "neutral"} />
                  </Focusable>
                );
              }}
            </For>
            <DetailCard />
          </View>
        </ScrollablePage>
      </View>
    );
  }

  return (
    <View class="flex-row flex-1 w-full" style={{ minH: 0 }}>
      <View class="flex-col gap-2 p-3 flex-1 h-full" style={{ minW: 0, minH: 0 }}>
        <View class="flex-row items-center gap-2" style={{ shrink: 0 }}>
          <StudioButton
            label="上传资源…"
            kind="primary"
            size="xs"
            disabled={!project() || up().picking || up().busy || up().unavailable !== undefined}
            onPress={() => void s.assets.pick()}
          />
          <Text class="text-xs flex-1" style={{ textColor: C.faint }}>图片 · 音频 · 字体，单个文件不超过 32 MiB，文件名只能含字母、数字、. _ -</Text>
        </View>
        <Show when={up().unavailable}><Text class="text-xs" style={{ textColor: C.warn }}>{up().unavailable}</Text></Show>
        <Show when={ws().project && ws().assets.length === 0}><Text class="text-sm" style={{ textColor: C.muted }}>assets/ 中还没有资源。</Text></Show>
        <ScrollablePage>
          <View class="flex-col gap-1.5 w-full">
            <UploadRows studio={s} />
            <For each={ws().assets}>
              {(name) => {
                const selected = () => asset()?.name === name;
                return (
                  <Focusable
                    class="flex-row items-center justify-between px-3 py-2 rounded-lg w-full"
                    style={{
                      bgColor: selected() ? C.primarySoft : C.bgRaised,
                      borderColor: selected() ? C.primaryBorder : C.line,
                      borderWidth: 1,
                      radius: 7,
                    }}
                    onPress={() => void s.workspace.selectAsset(name)}
                  >
                    <Text class="text-xs font-mono font-bold" style={{ textColor: C.text }}>{name}</Text>
                    <StateChip label={KIND_LABEL[assetKind(name)]} tone={selected() ? "info" : "neutral"} />
                  </Focusable>
                );
              }}
            </For>
          </View>
        </ScrollablePage>
      </View>
      <HairlineV />
      <View class="flex-col p-3 h-full" style={{ width: 320, shrink: 0 }}>
        <ScrollablePage>
          <DetailCard />
        </ScrollablePage>
      </View>
    </View>
  );
}

function PlacementEditor(props: { studio: Studio; inspector?: boolean }) {
  const s = props.studio;
  const r = fromStore(s.resources.store);
  const project = () => r().project ?? s.projects.current();
  const pkg = () => s.resources.pkg(r().selectedPackage);
  const built = () => r().inventory?.builtRevision;
  const selected = () => pkg()?.resources.find((x) => x.key === r().selectedKey);
  const changed = () => (r().selectedPackage ? s.resources.changedKeys(r().selectedPackage!).length : 0);
  const previewId = (): string | undefined => {
    const p = project();
    const id = r().selectedPackage;
    const key = selected()?.key;
    const b = built();
    return p && id && key && b !== undefined ? resourcePreviewKey(p, id, key, b) : undefined;
  };
  createEffect(() => {
    const p = project();
    const id = r().selectedPackage;
    const sel = selected();
    const b = built();
    const key = previewId();
    if (!p || !id || !sel || b === undefined || !sel.preview || !key) return;
    void s.previews.request(key, () => s.client.resources.preview(p, b, id, sel.key));
  });

  const SelectedResourceCard = () => (
    <Show
      when={selected()}
      fallback={
        <View class="p-3 rounded-lg w-full" style={{ bgColor: C.bgRaised, borderColor: C.line, borderWidth: 1, radius: 7 }}>
          <Text class="text-xs" style={{ textColor: C.muted }}>选择资源以更改交付方式。</Text>
        </View>
      }
    >
      {(res) => (
        <Panel title={res().key} eyebrow="RESOURCE POLICY">
          <Text class="text-xs" style={{ textColor: C.muted }}>{`${formatBytes(res().bytes)} · ${res().kind === "asset" ? "资产文件" : "PAK 条目"}`}</Text>
          <Show
            when={res().locked}
            fallback={
              <MobileSegmentedControl
                items={[{ id: "pak", label: "基础包" }, { id: "network", label: "网络" }]}
                active={s.resources.placementOf(pkg()!.id, res())}
                onChange={(id) => s.resources.setPlacement(res().key, id === "network" ? "network" : "pak")}
              />
            }
          >
            <View class="px-2 py-1 rounded" style={{ bgColor: C.warnSoft, borderColor: C.warnBorder, borderWidth: 1, radius: 5 }}>
              <Text class="text-xs" style={{ textColor: C.warn }}>{`位置已锁定：${res().reason ?? "宿主必需的资源"}`}</Text>
            </View>
          </Show>
          <Show when={res().preview} fallback={<Text class="text-xs" style={{ textColor: C.faint }}>此资源没有缩略图。</Text>}>
            <Preview studio={s} id={previewId()} />
          </Show>
        </Panel>
      )}
    </Show>
  );

  const StickySaveBar = () => (
    <View class="flex-col w-full" style={{ bgColor: C.surface, shrink: 0 }}>
      <HairlineH />
      <View class="flex-row items-center justify-between gap-2 px-3 py-2 w-full">
        <Text class="text-2xs flex-1" style={{ textColor: changed() > 0 ? C.warn : C.muted }}>
          {changed() > 0
            ? `${changed()} 项修改未保存（保存后请构建项目以应用）`
            : r().inventory
              ? `修订 r${r().inventory!.revision}${built() !== undefined ? ` · 构建 r${built()}` : ""}`
              : "尚未加载策略"}
        </Text>
        <View class="flex-row items-center gap-1.5" style={{ shrink: 0 }}>
          <StudioButton label="还原" kind="quiet" size="xs" disabled={changed() === 0 || r().saving} onPress={() => s.resources.discard()} />
          <StudioButton
            label={r().saving ? "正在保存…" : "保存资源策略"}
            kind="primary"
            size="xs"
            disabled={changed() === 0 || r().saving || r().stale !== undefined}
            onPress={() => void s.resources.save()}
          />
        </View>
      </View>
    </View>
  );

  const Banners = () => (
    <>
      <Show when={r().stale}>
        <View class="flex-row items-center gap-2 px-3 py-2 w-full" style={{ bgColor: C.warnSoft, borderColor: C.warnBorder, borderWidth: 1 }}>
          <Text class="text-xs flex-1" style={{ textColor: C.warn }}>{r().stale}</Text>
          <StudioButton label="重新加载" kind="secondary" size="xs" onPress={() => void s.resources.reload()} />
        </View>
      </Show>
      <Show when={r().error && !r().stale}>
        <View class="px-3 py-1.5"><Text class="text-xs" style={{ textColor: C.danger }}>{r().error}</Text></View>
      </Show>
      <Show when={r().loading}>
        <View class="px-3 py-1.5"><Text class="text-xs" style={{ textColor: C.muted }}>正在读取资源清单…</Text></View>
      </Show>
      <Show when={r().loaded && (r().inventory?.packages.length ?? 0) === 0 && !r().error}>
        <View class="px-3 py-1.5"><Text class="text-xs" style={{ textColor: C.muted }}>清单中没有资源包。</Text></View>
      </Show>
      <Show when={r().loaded && r().inventory && built() === undefined}>
        <View class="px-3 py-1.5">
          <Text class="text-xs" style={{ textColor: C.warn }}>此项目还没有成功的构建：请先构建，之后才会列出各资源包的内容。</Text>
        </View>
      </Show>
    </>
  );

  if (props.inspector) {
    return (
      <View class="flex-col flex-1 h-full w-full" style={{ minH: 0 }}>
        <Banners />
        <View class="flex-col p-3 flex-1 w-full" style={{ minH: 0 }}>
          <ScrollablePage>
            <View class="flex-col gap-2.5 w-full">
              {/* Notice box matching `.resources-notice` in Web Preview */}
              <View class="p-2.5 rounded-lg w-full" style={{ bgColor: C.bgRaised, borderColor: C.line, borderWidth: 1, radius: 6 }}>
                <Text class="text-2xs" style={{ textColor: C.muted }}>
                  网络资源会在打开时下载，成功启动后可离线使用。必需的字体和样式会保留在基础包中。
                </Text>
              </View>

              {/* Package cards rail matching `.resource-package-rail` */}
              <View class="flex-col gap-1.5 p-2.5 rounded-lg w-full" style={{ bgColor: C.bgRaised, borderColor: C.line, borderWidth: 1, radius: 7 }}>
                <View class="flex-row items-center justify-between w-full">
                  <Eyebrow text="资源包" />
                  <Text class="text-2xs" style={{ textColor: C.faint }}>{`${r().inventory?.packages.length ?? 0} 个资源包`}</Text>
                </View>
                <For each={r().inventory?.packages ?? []}>
                  {(p) => {
                    const active = () => r().selectedPackage === p.id;
                    return (
                      <Focusable
                        class="flex-col gap-0.5 px-2.5 py-2 rounded-md w-full"
                        style={{
                          bgColor: active() ? C.primarySoft : C.surface,
                          borderColor: active() ? C.primaryBorder : C.line,
                          borderWidth: 1,
                          radius: 6,
                        }}
                        onPress={() => s.resources.selectPackage(p.id)}
                      >
                        <Text class="text-xs font-bold" style={{ textColor: C.text }}>{p.title}</Text>
                        <Text class="text-2xs" style={{ textColor: C.muted }}>
                          {`${p.id} · ${p.resources.length} 个资源${s.resources.isDirty(p.id) ? " · 未保存" : ""}`}
                        </Text>
                      </Focusable>
                    );
                  }}
                </For>
              </View>

              {/* Resource items list */}
              <Show when={pkg()}>
                {(curPkg) => (
                  <View class="flex-col gap-1.5 w-full">
                    <View class="flex-row items-center justify-between w-full">
                      <Eyebrow text={`已选包 · ${curPkg().title}`} />
                      <Text class="text-2xs" style={{ textColor: C.muted }}>{`${curPkg().resources.length} 个资源`}</Text>
                    </View>
                    <For each={curPkg().resources}>
                      {(res) => {
                        const placement = () => s.resources.placementOf(curPkg().id, res);
                        const active = () => r().selectedKey === res.key;
                        return (
                          <Focusable
                            class="flex-col gap-1 p-2.5 rounded-lg w-full"
                            style={{
                              bgColor: active() ? C.primarySoft : res.locked ? C.warnSoft : C.bgRaised,
                              borderColor: active() ? C.primaryBorder : res.locked ? C.warnBorder : C.line,
                              borderWidth: 1,
                              radius: 7,
                            }}
                            onPress={() => s.resources.selectResource(res.key)}
                          >
                            <Text class="text-xs font-mono font-bold" style={{ textColor: C.text }}>{res.key}</Text>
                            <Text class="text-2xs" style={{ textColor: res.locked ? C.warn : C.muted }}>
                              {`${res.kind === "asset" ? "资产" : "包内"} · ${formatBytes(res.bytes)} · ${res.locked ? "基础包（必需）" : placement() === "network" ? "网络" : "基础包"}${placement() !== res.placement ? " · 未保存" : ""}`}
                            </Text>
                          </Focusable>
                        );
                      }}
                    </For>
                  </View>
                )}
              </Show>

              <SelectedResourceCard />
            </View>
          </ScrollablePage>
        </View>
        <StickySaveBar />
      </View>
    );
  }

  return (
    <View class="flex-col flex-1 h-full w-full" style={{ minH: 0 }}>
      <Banners />
      <View class="flex-row flex-1 w-full" style={{ minH: 0 }}>
        <View class="flex-col gap-1.5 p-2.5 h-full" style={{ width: 220, bgColor: C.bgRaised, shrink: 0 }}>
          <Text class="text-2xs font-bold" style={{ textColor: C.faint }}>{`资源包 · ${r().inventory?.packages.length ?? 0}`}</Text>
          <ScrollablePage>
            <View class="flex-col gap-1 w-full">
              <For each={r().inventory?.packages ?? []}>
                {(p) => {
                  const active = () => r().selectedPackage === p.id;
                  return (
                    <Focusable
                      class="flex-col gap-0.5 px-2.5 py-2 rounded-md w-full"
                      style={{
                        bgColor: active() ? C.primarySoft : C.surface,
                        borderColor: active() ? C.primaryBorder : C.line,
                        borderWidth: 1,
                        radius: 6,
                      }}
                      onPress={() => s.resources.selectPackage(p.id)}
                    >
                      <Text class="text-xs font-bold" style={{ textColor: C.text }}>{p.title}</Text>
                      <Text class="text-2xs" style={{ textColor: C.muted }}>
                        {`${p.id} · ${p.resources.length} 个资源${s.resources.isDirty(p.id) ? " · 未保存" : ""}`}
                      </Text>
                    </Focusable>
                  );
                }}
              </For>
            </View>
          </ScrollablePage>
        </View>
        <HairlineV />
        <View class="flex-col gap-1.5 p-2.5 flex-1 h-full" style={{ minW: 0, minH: 0 }}>
          <Text class="text-2xs font-bold" style={{ textColor: C.faint }}>
            {pkg() ? `${pkg()!.title} · ${pkg()!.resources.length} 个资源` : "资源"}
          </Text>
          <ScrollablePage>
            <View class="flex-col gap-1 w-full">
              <For each={pkg()?.resources ?? []}>
                {(res) => {
                  const placement = () => s.resources.placementOf(pkg()!.id, res);
                  const active = () => r().selectedKey === res.key;
                  return (
                    <Focusable
                      class="flex-col gap-0.5 px-2.5 py-2 rounded-md w-full"
                      style={{
                        bgColor: active() ? C.primarySoft : C.bgRaised,
                        borderColor: active() ? C.primaryBorder : C.line,
                        borderWidth: 1,
                        radius: 6,
                      }}
                      onPress={() => s.resources.selectResource(res.key)}
                    >
                      <Text class="text-xs font-mono font-bold" style={{ textColor: C.text }}>{res.key}</Text>
                      <Text class="text-2xs" style={{ textColor: res.locked ? C.warn : C.muted }}>
                        {`${res.kind === "asset" ? "资产" : "包内"} · ${formatBytes(res.bytes)} · ${res.locked ? "基础包（必需）" : placement() === "network" ? "网络" : "基础包"}${placement() !== res.placement ? " · 未保存" : ""}`}
                      </Text>
                    </Focusable>
                  );
                }}
              </For>
            </View>
          </ScrollablePage>
        </View>
        <HairlineV />
        <View class="flex-col p-2.5 h-full" style={{ width: 280, shrink: 0 }}>
          <ScrollablePage>
            <SelectedResourceCard />
          </ScrollablePage>
        </View>
      </View>
      <StickySaveBar />
    </View>
  );
}

export function ResourcesPage(props: { studio: Studio; inspector?: boolean }) {
  const s = props.studio;
  const ws = fromStore(s.workspace.store);
  const r = fromStore(s.resources.store);
  const wb = fromStore(s.workbench.store);
  const tab = () => wb().resourcesTab;

  createEffect(() => {
    if (s.projects.current() && !s.resources.state().loaded && !s.resources.state().loading) {
      void s.resources.refresh();
    }
  });

  return (
    <View class="flex-col flex-1 h-full w-full" style={{ bgColor: props.inspector ? C.surface : C.bg, minH: 0 }}>
      <View class="flex-col gap-2 px-3 py-2 w-full" style={{ bgColor: C.surface, shrink: 0 }}>
        <View class="flex-row items-center justify-between gap-2 w-full">
          <View class="flex-col gap-0.5" style={{ minW: 0 }}>
            <Eyebrow text="PACKAGE RESOURCES" />
            <Text class="text-xs font-bold" style={{ textColor: C.text }}>{`资源 · ${ws().project ?? "请选择项目"}`}</Text>
          </View>
          <StudioButton
            label="刷新"
            kind="quiet"
            size="xs"
            onPress={() => {
              void s.workspace.refreshTree();
              void (s.resources.isDirty() ? s.resources.reload() : s.resources.refresh());
            }}
          />
        </View>
        <MobileSegmentedControl
          items={[
            { id: "files", label: "资源文件" },
            { id: "placement", label: `包资源策略${r().inventory && s.resources.isDirty() ? " ·" : ""}` },
          ]}
          active={tab()}
          onChange={(id) => {
            const next = id as "files" | "placement";
            s.workbench.setResourcesTab(next);
            if (next === "placement" && !s.resources.state().loaded && s.projects.current()) void s.resources.refresh();
          }}
        />
      </View>
      <HairlineH />
      <Show when={tab() === "files"}><AssetFiles studio={s} inspector={props.inspector} /></Show>
      <Show when={tab() === "placement"}><PlacementEditor studio={s} inspector={props.inspector} /></Show>
    </View>
  );
}
