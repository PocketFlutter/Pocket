import { For, Show, createEffect, createSignal, onMount } from "solid-js";
import { MobileButton, MobileListTile, MobileProgress, MobileSegmentedControl, ScrollablePage } from "@pocket/ui";
import { PocketStoredImage } from "@pocket/ui/images";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import { Panel } from "../components/info.tsx";
import { assetKind, KIND_LABEL, previewBlocker } from "../lib/assets.ts";
import { formatBytes } from "../lib/format.ts";
import { uploadProgress, type UploadRow } from "../state/assets.ts";
import { assetPreviewKey, resourcePreviewKey, type PreviewState } from "../state/images.ts";
import type { Studio } from "../state/studio.ts";

const PREVIEW_BOX = 176;
const UPLOAD_LABEL: Record<UploadRow["state"], string> = { queued: "等待", reading: "读取中", uploading: "上传中", done: "完成", failed: "失败", refused: "已拒绝", cancelled: "已取消" };

/** The host-decoded thumbnail of one key, or exactly why there is none. */
function Preview(props: { studio: Studio; id: string | undefined; blocker?: string }) {
  const images = fromStore(props.studio.previews.store);
  const entry = (): PreviewState | undefined => (props.id ? images().items[props.id] : undefined);
  return (
    <View class="flex-col gap-1">
      <Show when={props.blocker}><Text class="text-xs" style={{ textColor: C.warn }}>{props.blocker}</Text></Show>
      <Show when={!props.blocker && entry()?.status === "loading"}><Text class="text-xs" style={{ textColor: C.muted }}>正在解码预览…</Text></Show>
      <Show when={!props.blocker && entry()?.status === "unavailable"}><Text class="text-xs" style={{ textColor: C.warn }}>{(entry() as { reason: string }).reason}</Text></Show>
      <Show when={!props.blocker && entry()?.status === "ready"}>
        <View class="rounded-lg bg-[#27272A] p-1" style={{ width: PREVIEW_BOX + 8 }}>
          <PocketStoredImage client={props.studio.previews.client} imageId={props.id} width={PREVIEW_BOX} height={PREVIEW_BOX} debugName="studio-preview" />
        </View>
        <Text class="text-xs" style={{ textColor: C.faint }}>{`预览（宿主解码，最长边 ≤128 px）${(() => { const e = entry(); return e && e.status === "ready" ? ` · 原图 ${e.image.sourceWidth}×${e.image.sourceHeight}` : ""; })()}`}</Text>
      </Show>
    </View>
  );
}

function UploadRows(props: { studio: Studio }) {
  const s = props.studio;
  const a = fromStore(s.assets.store);
  return (
    <Show when={a().rows.length > 0}>
      <Panel title="上传">
        <For each={a().rows}>{(row) => (
          <View class="flex-col gap-1 w-full">
            <Text class="text-xs" style={{ textColor: row.state === "failed" || row.state === "refused" ? C.danger : row.state === "done" ? C.ok : C.body }}>
              {`${row.name} · ${formatBytes(row.size)} · ${UPLOAD_LABEL[row.state]}`}
            </Text>
            <Show when={row.state === "reading" || row.state === "uploading"}>
              <MobileProgress value={Math.round(uploadProgress(row) * 100)} max={100} label={row.state === "reading" ? "读取" : "上传"} animated={false} />
            </Show>
            <Show when={row.error}><Text class="text-xs" style={{ textColor: row.state === "cancelled" ? C.muted : C.danger }}>{row.error}</Text></Show>
          </View>
        )}</For>
        <View class="flex-row gap-2">
          <Show when={a().busy}><MobileButton label="取消" kind="tonal" compact onPress={() => s.assets.cancel()} /></Show>
          <Show when={!a().busy}><MobileButton label="清除记录" kind="text" compact onPress={() => s.assets.clearFinished()} /></Show>
        </View>
      </Panel>
    </Show>
  );
}

function AssetFiles(props: { studio: Studio }) {
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
  // Ask the provider to decode once the asset's stat is known (a replaced file has a new size/mtime, so a new key).
  createEffect(() => {
    const a = asset();
    const p = project();
    const id = previewId();
    if (!a || !p || !id || previewBlocker(a.name)) return;
    void s.previews.request(id, () => s.client.assets.preview(p, a.name));
  });
  return (
    <View class="flex-row gap-3 flex-1">
      <View class="flex-col gap-2 flex-1">
        <View class="flex-row items-center gap-2">
          <MobileButton label="上传资源…" kind="filled" compact disabled={!project() || up().picking || up().busy || up().unavailable !== undefined} onPress={() => void s.assets.pick()} />
          <Text class="text-xs flex-1" style={{ textColor: C.faint }}>图片 · 音频 · 字体，单个文件不超过 32 MiB，文件名只能含字母、数字、. _ -</Text>
        </View>
        <Show when={up().unavailable}><Text class="text-xs" style={{ textColor: C.warn }}>{up().unavailable}</Text></Show>
        <Show when={ws().project && ws().assets.length === 0}><Text class="text-sm" style={{ textColor: C.muted }}>assets/ 中还没有资源。</Text></Show>
        <ScrollablePage>
          <View class="flex-col gap-1 w-full">
            <UploadRows studio={s} />
            <For each={ws().assets}>{(name) => (
              <MobileListTile title={name} detail={KIND_LABEL[assetKind(name)]} selected={asset()?.name === name} onPress={() => void s.workspace.selectAsset(name)} />
            )}</For>
          </View>
        </ScrollablePage>
      </View>
      <View class="flex-col gap-2" style={{ width: 340 }}>
        <Show when={asset()} fallback={<Text class="text-sm" style={{ textColor: C.muted }}>选择资源以查看信息。</Text>}>
          {(a) => (
            <View class="flex-col gap-1 p-3 rounded-lg bg-[#18181B]">
              <Text class="text-sm font-bold" style={{ textColor: C.text }}>{a().name}</Text>
              <Text class="text-xs" style={{ textColor: C.muted }}>{a().path}</Text>
              <Show when={a().bytes !== undefined}><Text class="text-xs" style={{ textColor: C.body }}>{`大小：${formatBytes(a().bytes!)}`}</Text></Show>
              <Show when={a().mtimeMs !== undefined}><Text class="text-xs" style={{ textColor: C.body }}>{`修改时间：${new Date(a().mtimeMs!).toISOString().replace("T", " ").slice(0, 19)} UTC`}</Text></Show>
              <Show when={a().error}><Text class="text-xs" style={{ textColor: C.danger }}>{a().error}</Text></Show>
              <Show when={a().mtimeMs !== undefined || previewBlocker(a().name)}>
                <Preview studio={s} id={previewId()} blocker={previewBlocker(a().name)} />
              </Show>
            </View>
          )}
        </Show>
      </View>
    </View>
  );
}

function PlacementEditor(props: { studio: Studio }) {
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
  return (
    <View class="flex-col gap-2 flex-1">
      <Show when={r().stale}>
        <View class="flex-row items-center gap-2 p-2 rounded-lg bg-[#3F2F0B]">
          <Text class="text-xs flex-1" style={{ textColor: C.warn }}>{r().stale}</Text>
          <MobileButton label="重新加载" kind="tonal" compact onPress={() => void s.resources.reload()} />
        </View>
      </Show>
      <Show when={r().error && !r().stale}><Text class="text-xs" style={{ textColor: C.danger }}>{r().error}</Text></Show>
      <Show when={r().loading}><Text class="text-xs" style={{ textColor: C.muted }}>正在读取资源清单…</Text></Show>
      <Show when={r().loaded && (r().inventory?.packages.length ?? 0) === 0 && !r().error}><Text class="text-xs" style={{ textColor: C.muted }}>清单中没有资源包。</Text></Show>
      <Show when={r().loaded && r().inventory && built() === undefined}>
        <Text class="text-xs" style={{ textColor: C.warn }}>此项目还没有成功的构建：请先构建，之后才会列出各资源包的内容。</Text>
      </Show>
      <View class="flex-row gap-3 flex-1">
        <View class="flex-col gap-1" style={{ width: 230 }}>
          <Text class="text-xs" style={{ textColor: C.faint }}>{`资源包 · ${r().inventory?.packages.length ?? 0}`}</Text>
          <ScrollablePage>
            <View class="flex-col gap-1 w-full">
              <For each={r().inventory?.packages ?? []}>{(p) => (
                <MobileListTile
                  title={p.title}
                  detail={`${p.id} · ${p.resources.length} 个资源${s.resources.isDirty(p.id) ? " · 未保存" : ""}`}
                  selected={r().selectedPackage === p.id}
                  onPress={() => s.resources.selectPackage(p.id)}
                />
              )}</For>
            </View>
          </ScrollablePage>
        </View>
        <View class="flex-col gap-1 flex-1">
          <Text class="text-xs" style={{ textColor: C.faint }}>{pkg() ? `${pkg()!.title} · ${pkg()!.resources.length} 个资源` : "资源"}</Text>
          <ScrollablePage>
            <View class="flex-col gap-1 w-full">
              <For each={pkg()?.resources ?? []}>{(res) => {
                const placement = () => s.resources.placementOf(pkg()!.id, res);
                return (
                  <MobileListTile
                    title={res.key}
                    detail={`${res.kind === "asset" ? "资产" : "包内"} · ${formatBytes(res.bytes)} · ${res.locked ? "基础包（必需）" : placement() === "network" ? "网络" : "基础包"}${placement() !== res.placement ? " · 未保存" : ""}`}
                    selected={r().selectedKey === res.key}
                    onPress={() => s.resources.selectResource(res.key)}
                  />
                );
              }}</For>
            </View>
          </ScrollablePage>
        </View>
        <View class="flex-col gap-2" style={{ width: 280 }}>
          <Show when={selected()} fallback={<Text class="text-sm" style={{ textColor: C.muted }}>选择资源以更改交付方式。</Text>}>
            {(res) => (
              <View class="flex-col gap-2 p-3 rounded-lg bg-[#18181B]">
                <Text class="text-sm font-bold" style={{ textColor: C.text }}>{res().key}</Text>
                <Text class="text-xs" style={{ textColor: C.muted }}>{`${formatBytes(res().bytes)} · ${res().kind === "asset" ? "资产文件" : "PAK 条目"}`}</Text>
                <Show when={res().locked} fallback={
                  <MobileSegmentedControl
                    items={[{ id: "pak", label: "基础包" }, { id: "network", label: "网络" }]}
                    active={s.resources.placementOf(pkg()!.id, res())}
                    onChange={(id) => s.resources.setPlacement(res().key, id === "network" ? "network" : "pak")}
                  />
                }>
                  <Text class="text-xs" style={{ textColor: C.warn }}>{`位置已锁定：${res().reason ?? "宿主必需的资源"}`}</Text>
                </Show>
                <Show when={res().preview} fallback={<Text class="text-xs" style={{ textColor: C.faint }}>此资源没有缩略图。</Text>}>
                  <Preview studio={s} id={previewId()} />
                </Show>
              </View>
            )}
          </Show>
        </View>
      </View>
      <View class="flex-row items-center gap-2">
        <Text class="text-xs flex-1" style={{ textColor: changed() > 0 ? C.warn : C.faint }}>
          {changed() > 0 ? `${changed()} 项修改未保存（保存后请构建项目以应用）` : r().inventory ? `修订 r${r().inventory!.revision}${built() !== undefined ? ` · 构建 r${built()}` : ""}` : "尚未加载策略"}
        </Text>
        <MobileButton label="还原" kind="text" compact disabled={changed() === 0 || r().saving} onPress={() => s.resources.discard()} />
        <MobileButton label={r().saving ? "正在保存…" : "保存资源策略"} kind="filled" compact disabled={changed() === 0 || r().saving || r().stale !== undefined} onPress={() => void s.resources.save()} />
      </View>
    </View>
  );
}

/**
 * Resources page: the project's `assets/` files (upload through the host's open dialog, host-decoded image previews) and the
 * package resource placement editor (base pak vs network, with stale-revision handling). Everything is capability driven;
 * image bytes are decoded by the host (the guest has no PNG/JPEG decoder) and shown as a texture. SVG is reported, not faked.
 */
export function ResourcesPage(props: { studio: Studio }) {
  const s = props.studio;
  const ws = fromStore(s.workspace.store);
  const r = fromStore(s.resources.store);
  const [tab, setTab] = createSignal<"files" | "placement">("files");
  onMount(() => { if (s.projects.current() && !s.resources.state().loaded) void s.resources.refresh(); });
  return (
    <View class="flex-col gap-2 p-4 flex-1">
      <View class="flex-row items-center gap-2">
        <Text class="text-xl text-[#FAFAFA] font-bold">{`资源 · ${ws().project ?? "请选择项目"}`}</Text>
        <MobileButton label="刷新" kind="text" compact onPress={() => { void s.workspace.refreshTree(); void (s.resources.isDirty() ? s.resources.reload() : s.resources.refresh()); }} />
      </View>
      <MobileSegmentedControl
        items={[{ id: "files", label: "资源文件" }, { id: "placement", label: `包资源策略${r().inventory && s.resources.isDirty() ? " ·" : ""}` }]}
        active={tab()}
        onChange={(id) => { setTab(id as "files" | "placement"); if (id === "placement" && !s.resources.state().loaded && s.projects.current()) void s.resources.refresh(); }}
      />
      <Show when={tab() === "files"}><AssetFiles studio={s} /></Show>
      <Show when={tab() === "placement"}><PlacementEditor studio={s} /></Show>
    </View>
  );
}
