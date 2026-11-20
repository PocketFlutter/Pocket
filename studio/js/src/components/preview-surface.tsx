// Live preview surface for a single target slot (`flutter`, `web`, `wechat`, `widget`, `widgetAlt`).
// Each target binds to its dedicated signed child package (`dev.pocket.studio.preview*`) via
// `CompositorSurface`, enabling true simultaneous side-by-side native sandboxes in one stage.
import { Show, onCleanup } from "solid-js";
import { CompositorSurface, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore, select } from "../ui/bind.ts";
import {
  PREVIEW_TARGET_BY_ID,
  type PreviewPhase,
  type PreviewTargetId,
} from "../state/preview.ts";
import { C } from "../ui/theme.ts";
import type { Studio } from "../state/studio.ts";

export const PREVIEW_PHASE_LABEL: Record<PreviewPhase, string> = {
  idle: "尚未运行预览",
  building: "构建中",
  publishing: "发布中",
  loading: "加载中",
  running: "运行中",
  error: "出错",
} as const;

const TARGET_EMPTY_HINT: Record<PreviewTargetId, { glyph: string; hint: string }> = {
  flutter: { glyph: "⌁", hint: "构建后自动签名并加载 Flutter 原生画布。" },
  web: { glyph: "🌐", hint: "构建后同步运行 Web 视口沙箱并生成本地链接。" },
  wechat: { glyph: "◎", hint: "构建后运行微信小程序胶囊沙箱（2 MiB 预算）。" },
  widget: { glyph: "❖", hint: "构建后注入 platform.surface 渲染系统微件。" },
  widgetAlt: { glyph: "◈", hint: "构建后渲染灵动岛实时活动与智能穿戴磁贴。" },
};

function canBindCompositorPackage(appId: string): boolean {
  const surfaces = (globalThis as { ui?: { __surfaces?: Record<string, unknown> } }).ui?.__surfaces;
  if (!surfaces || typeof surfaces !== "object" || Array.isArray(surfaces)) return true;
  return typeof surfaces[appId] === "number" && Number.isInteger(surfaces[appId]);
}

export function PreviewSurface(props: {
  studio: Studio;
  target?: PreviewTargetId;
  radius?: number;
  focused?: boolean;
  compact?: boolean;
}) {
  const s = props.studio;
  const targetId = (): PreviewTargetId => props.target ?? "flutter";
  const spec = () => PREVIEW_TARGET_BY_ID[targetId()];
  const mountedTarget = targetId();
  const unmountSurface = s.preview.mountSurface(mountedTarget);
  onCleanup(unmountSurface);

  const preview = fromStore(s.preview.store);
  const slot = () => preview().slots[targetId()];
  const effectivePhase = (): PreviewPhase => {
    const slotPhase = slot().phase;
    if (slotPhase !== "idle") return slotPhase;
    return targetId() === "flutter" ? preview().phase : "idle";
  };
  const effectiveMessage = (): string | undefined => slot().message ?? (targetId() === "flutter" ? preview().message : undefined);

  const modalOpen = select(s.dialogs.store, (d) => d.active !== undefined);
  const createOpen = select(s.projects.store, (p) => p.createOpen);
  const quickOpen = select(s.quickOpen.store, (q) => q.open);
  const menuOpen = select(s.workbench.store, (w) => w.projectMenuOpen);
  const overlayBlocking = () => modalOpen() || createOpen() || quickOpen() || menuOpen();
  const r = () => props.radius ?? 12;
  const supported = () => canBindCompositorPackage(spec().appId);
  const surfaceFocused = () => !overlayBlocking() && (props.focused ?? true);

  return (
    <View
      class="relative flex-1 overflow-hidden w-full h-full"
      style={{
        bgColor: C.stageDevice,
        radius: r(),
      }}
    >
      <Show when={supported()}>
        <CompositorSurface
          package={spec().appId}
          focused={surfaceFocused()}
          class="absolute inset-0 w-full h-full"
          style={{ radius: r() }}
        />
      </Show>
      <Show when={!supported() || effectivePhase() !== "running"}>
        <View
          class={props.compact ? "absolute inset-0 flex-col items-center justify-center gap-1 p-2" : "absolute inset-0 flex-col items-center justify-center gap-2 p-4"}
          style={{
            bgColor: C.stageEmptyBottom,
            radius: r(),
          }}
        >
          <Show when={!props.compact}>
            <View
              class="items-center justify-center rounded-xl"
              style={{
                width: 34,
                height: 34,
                bgColor: C.primarySoft,
                borderColor: C.primaryBorder,
                borderWidth: 1,
                radius: 10,
              }}
            >
              <Text class="text-sm font-bold" style={{ textColor: C.info }}>
                {TARGET_EMPTY_HINT[targetId()].glyph}
              </Text>
            </View>
          </Show>
          <Text
            class="text-xs font-bold"
            style={{
              textColor: !supported()
                ? C.warn
                : effectivePhase() === "error"
                  ? C.danger
                  : effectivePhase() === "idle"
                    ? C.text
                    : C.warn,
            }}
          >
            {!supported()
              ? `${spec().shortLabel}：当前宿主仅挂载单槽位`
              : targetId() === "flutter"
                ? `预览：${PREVIEW_PHASE_LABEL[effectivePhase()]}`
                : `${spec().shortLabel}：${PREVIEW_PHASE_LABEL[effectivePhase()]}`}
          </Text>
          <Show
            when={effectiveMessage()}
            fallback={
              <Show when={!props.compact}>
                <Text class="text-2xs" style={{ textColor: C.muted }}>
                  {TARGET_EMPTY_HINT[targetId()].hint}
                </Text>
              </Show>
            }
          >
            <Text class="text-2xs" style={{ textColor: effectivePhase() === "error" ? C.danger : C.muted }}>
              {effectiveMessage()}
            </Text>
          </Show>
        </View>
      </Show>
    </View>
  );
}
