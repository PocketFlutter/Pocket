import { For, Show, createSignal } from "solid-js";
import { ScrollablePage } from "@pocket/ui";
import { getSurfaceProfile, type EcosystemSurfaceProfile, type SurfaceWallpaperBackdrop } from "@pocket/ui/surface-catalog";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { PreviewSurface, PREVIEW_PHASE_LABEL } from "../components/preview-surface.tsx";
import { ACTIVE_JOB, JOB_LABELS } from "../state/deploy.ts";
import {
  PREVIEW_TARGET_SPECS,
  RENDER_MODE_OPTIONS,
  WIDGET_SURFACE_PROFILES,
  type PreviewTargetId,
} from "../state/preview.ts";
import { C } from "../ui/theme.ts";
import type { Studio } from "../state/studio.ts";
import { CapsuleToggle, Eyebrow, HairlineH, HairlineV, LiveChip, StateChip, StudioButton } from "../components/workbench-ui.tsx";

/** Reusable Device Deployment & Simulator Output pane used in `.console-dock` (Tab 2) and `PreviewPage`. */
export function DeployPane(props: { studio: Studio; compactSide?: boolean }) {
  const s = props.studio;
  const deploy = fromStore(s.deploy.store);
  const project = () => s.projects.current();
  const job = () => deploy().job;

  return (
    <View class="flex-col gap-2 p-3 flex-1 h-full w-full" style={{ bgColor: C.bgRaised, minH: 0 }}>
      <View class="flex-row items-center justify-between gap-2 w-full" style={{ shrink: 0 }}>
        <View class="flex-col gap-0.5">
          <Eyebrow text="DEVICE TARGET" />
          <Text class="text-xs font-bold" style={{ textColor: C.text }}>部署到模拟器 / 设备</Text>
        </View>
        <View class="flex-row items-center gap-1.5" style={{ shrink: 0 }}>
          <StudioButton label="刷新设备" kind="secondary" size="xs" onPress={() => void s.deploy.loadDevices()} />
          <StudioButton
            label={job() && ACTIVE_JOB.includes(job()!.status) ? (job()!.status === "running" ? "已运行" : "部署中…") : "部署"}
            kind="primary"
            size="xs"
            disabled={!project() || !deploy().selected || deploy().starting || (job() !== undefined && ACTIVE_JOB.includes(job()!.status))}
            onPress={() => void s.deploy.start()}
          />
          <Show when={job() && ACTIVE_JOB.includes(job()!.status)}>
            <StudioButton label="停止" kind="danger" size="xs" onPress={() => void s.deploy.cancel()} />
          </Show>
        </View>
      </View>

      <Show when={deploy().devicesError}>
        <Text class="text-xs" style={{ textColor: C.danger }}>{`设备发现不可用：${deploy().devicesError}`}</Text>
      </Show>
      <Show when={deploy().devicesLoaded && !deploy().devicesError && deploy().devices.length === 0}>
        <Text class="text-xs" style={{ textColor: C.muted }}>没有可用的模拟器或已连接设备。</Text>
      </Show>
      <Show when={!deploy().devicesLoaded}>
        <Text class="text-xs" style={{ textColor: C.muted }}>点击“刷新设备”以发现目标。</Text>
      </Show>

      <ScrollablePage>
        <View class="flex-col gap-2 w-full">
          <View class={props.compactSide ? "flex-col gap-1.5 w-full" : "flex-row flex-wrap gap-2 w-full"}>
            <For each={deploy().devices}>
              {(device) => {
                const selected = () => deploy().selected === device.id;
                return (
                  <Focusable
                    class="flex-col gap-0.5 px-3 py-2 rounded-lg"
                    style={{
                      width: props.compactSide ? undefined : 240,
                      bgColor: selected() ? C.primarySoft : C.surface,
                      borderColor: selected() ? C.primaryBorder : C.line,
                      borderWidth: 1,
                      radius: 7,
                      opacity: device.supported ? 1 : 0.6,
                    }}
                    onPress={() => device.supported && s.deploy.select(device.id)}
                  >
                    <Text class="text-xs font-bold" style={{ textColor: C.text }}>{device.name}</Text>
                    <Text class="text-2xs" style={{ textColor: C.muted }}>
                      {`${device.platform} · ${device.emulator ? "模拟器" : "已连接设备"}${device.supported ? "" : " · 不支持"}`}
                    </Text>
                  </Focusable>
                );
              }}
            </For>
          </View>

          <Show when={job()}>
            {(j) => (
              <View
                class="flex-col gap-1.5 p-2.5 rounded-lg w-full"
                style={{ bgColor: C.surface, borderColor: C.line, borderWidth: 1, radius: 7 }}
              >
                <Text
                  class="text-xs font-bold"
                  style={{ textColor: ["failed", "error"].includes(j().status) ? C.danger : C.ok }}
                >
                  {`部署：${JOB_LABELS[j().status] ?? j().status}`}
                </Text>
                <For each={j().logs.slice(-60)}>
                  {(line) => <Text class="text-xs font-mono" style={{ textColor: C.body }}>{line.length ? line : " "}</Text>}
                </For>
                <Show when={j().error}>
                  <Text class="text-xs font-mono" style={{ textColor: C.danger }}>{j().error}</Text>
                </Show>
              </View>
            )}
          </Show>
        </View>
      </ScrollablePage>
    </View>
  );
}

function backdropColorFor(wallpaper: SurfaceWallpaperBackdrop): { bg: string; border: string } {
  switch (wallpaper) {
    case "ios-aurora":
      return { bg: "#131C38", border: "#2D4278" };
    case "ios-lock":
      return { bg: "#171B2A", border: "#334155" };
    case "material-you":
      return { bg: "#162629", border: "#2B535A" };
    case "watch-face":
      return { bg: "#080B10", border: "#2A3240" };
    case "spatial-room":
      return { bg: "#1D2434", border: "#475569" };
    default:
      return { bg: "#111622", border: C.deviceBorder };
  }
}

/** 1. Flutter Native Hardware Shell Card (`dev.pocket.studio.preview`). */
function FlutterPreviewCard(props: {
  studio: Studio;
  density: "single" | "dual" | "multi";
  focused: boolean;
  onFocus: () => void;
}) {
  const s = props.studio;
  const wb = fromStore(s.workbench.store);
  const preset = () => wb().viewportPreset;
  const bezel = () => wb().bezelEnabled && preset() !== "desktop";

  const dims = () => {
    if (props.density === "multi") {
      if (preset() === "desktop") return { width: 204, height: 188, radius: 10 };
      if (preset() === "tablet") return { width: 194, height: 188, radius: bezel() ? 18 : 10 };
      return { width: 184, height: 188, radius: bezel() ? 22 : 10 };
    }
    if (props.density === "dual") {
      if (preset() === "desktop") return { width: 320, height: 360, radius: 12 };
      if (preset() === "tablet") return { width: 280, height: 390, radius: bezel() ? 22 : 12 };
      return { width: 236, height: 390, radius: bezel() ? 28 : 12 };
    }
    if (preset() === "desktop") return { width: 520, height: 372, radius: 12 };
    if (preset() === "tablet") return { width: 356, height: 424, radius: bezel() ? 24 : 12 };
    return { width: 272, height: 436, radius: bezel() ? 30 : 12 };
  };

  return (
    <Focusable class="flex-col items-center gap-0.5" onPress={props.onFocus}>
      <View
        class={bezel() ? "flex-col overflow-hidden p-1" : "flex-col overflow-hidden"}
        style={{
          width: dims().width,
          height: dims().height,
          bgColor: bezel() ? "#16181D" : C.stageDevice,
          borderColor: props.focused ? C.primaryBorder : bezel() ? "#3A3F4B" : C.deviceBorder,
          borderWidth: bezel() ? 2 : 1,
          radius: dims().radius,
          shadow: 2,
        }}
      >
        <View
          class="flex-col flex-1 overflow-hidden w-full h-full"
          style={{
            bgColor: C.stageDevice,
            radius: bezel() ? dims().radius - 4 : dims().radius,
          }}
        >
          <Show when={bezel()}>
            <View class="flex-row items-center justify-between px-3 w-full" style={{ height: 16, bgColor: "#0B0E14", shrink: 0 }}>
              <Text class="text-2xs font-bold" style={{ textColor: C.body }}>9:41</Text>
              <View style={{ width: 44, height: 9, radius: 999, bgColor: "#000000" }} />
              <Text class="text-2xs font-bold" style={{ textColor: C.muted }}>5G ▮</Text>
            </View>
          </Show>
          <PreviewSurface
            studio={s}
            target="flutter"
            focused={props.focused}
            compact={props.density === "multi"}
            radius={bezel() ? 0 : dims().radius}
          />
          <Show when={bezel()}>
            <View class="items-center justify-center w-full" style={{ height: 9, bgColor: "#0B0E14", shrink: 0 }}>
              <View style={{ width: 64, height: 3, radius: 2, bgColor: "#475569" }} />
            </View>
          </Show>
        </View>
      </View>
      <View class="flex-row items-center gap-1">
        <Text class="text-xs font-bold" style={{ textColor: props.focused ? C.info : C.text }}>Flutter</Text>
        <Text class="text-2xs" style={{ textColor: C.muted }}>
          {preset() === "mobile" ? "原生画布 · 390×844" : preset() === "tablet" ? "Tablet · 768×1023" : "Desktop · 1023×768"}
        </Text>
      </View>
    </Focusable>
  );
}

/** 2. Web Browser Viewport Shell Card (`dev.pocket.studio.preview.web`). */
function WebPreviewCard(props: {
  studio: Studio;
  density: "single" | "dual" | "multi";
  focused: boolean;
  onFocus: () => void;
}) {
  const s = props.studio;
  const preview = fromStore(s.preview.store);
  const project = () => s.projects.current() ?? "app";
  const webRoute = () => `/api/projects/${project()}/preview`;

  const dims = () => {
    if (props.density === "multi") return { width: 204, height: 188 };
    if (props.density === "dual") return { width: 320, height: 390 };
    return { width: 512, height: 424 };
  };

  return (
    <Focusable class="flex-col items-center gap-0.5" onPress={props.onFocus}>
      <View
        class="flex-col overflow-hidden"
        style={{
          width: dims().width,
          height: dims().height,
          bgColor: "#111622",
          borderColor: props.focused ? C.primaryBorder : C.deviceBorder,
          borderWidth: 1,
          radius: 12,
          shadow: 2,
        }}
      >
        {/* Browser Top Chrome */}
        <View
          class="flex-row items-center justify-between gap-1 px-2 w-full"
          style={{ height: 24, bgColor: "#161B26", shrink: 0 }}
        >
          <View class="flex-row items-center gap-1" style={{ shrink: 0 }}>
            <View style={{ width: 7, height: 7, radius: 999, bgColor: "#EF4444" }} />
            <View style={{ width: 7, height: 7, radius: 999, bgColor: "#F59E0B" }} />
            <View style={{ width: 7, height: 7, radius: 999, bgColor: "#22C55E" }} />
          </View>
          <View
            class="flex-row items-center px-1.5 py-0.5 flex-1 overflow-hidden"
            style={{ bgColor: C.bg, borderColor: C.line, borderWidth: 1, radius: 4, minW: 0 }}
          >
            <Text class="text-2xs" style={{ textColor: C.muted }}>
              {preview().webPreviewUrl ?? webRoute()}
            </Text>
          </View>
          <StudioButton
            label="复制"
            kind="quiet"
            size="xs"
            onPress={() => void s.copy(preview().webPreviewUrl ?? webRoute(), "Web 预览地址")}
          />
        </View>
        <HairlineH />
        <PreviewSurface
          studio={s}
          target="web"
          focused={props.focused}
          compact={props.density === "multi"}
          radius={0}
        />
      </View>
      <View class="flex-row items-center gap-1">
        <Text class="text-xs font-bold" style={{ textColor: props.focused ? C.info : C.text }}>Web</Text>
        <Text class="text-2xs" style={{ textColor: C.muted }}>浏览器视口沙箱 · WASM / Canvas</Text>
      </View>
    </Focusable>
  );
}

/** 3. WeChat Mini Program Capsule Shell Card (`dev.pocket.studio.preview.wechat`). */
function WechatPreviewCard(props: {
  studio: Studio;
  density: "single" | "dual" | "multi";
  focused: boolean;
  onFocus: () => void;
}) {
  const s = props.studio;
  const preview = fromStore(s.preview.store);
  const projects = fromStore(s.projects.store);
  const title = () => {
    const cur = projects().list.find((p) => p.id === projects().current);
    return cur?.title || cur?.name || projects().current || "小程序预览";
  };
  const wxState = () => preview().wechatService;

  const dims = () => {
    if (props.density === "multi") return { width: 192, height: 188 };
    if (props.density === "dual") return { width: 240, height: 390 };
    return { width: 280, height: 436 };
  };

  return (
    <Focusable class="flex-col items-center gap-0.5" onPress={props.onFocus}>
      <View
        class="flex-col overflow-hidden"
        style={{
          width: dims().width,
          height: dims().height,
          bgColor: "#11161F",
          borderColor: props.focused ? "#10B981" : "#25352F",
          borderWidth: 2,
          radius: 18,
          shadow: 2,
        }}
      >
        {/* WeChat Status Bar + Authentic Navigation Bar with `••• | ◎` Capsule */}
        <View class="flex-row items-center justify-between px-2.5 w-full" style={{ height: 15, bgColor: "#0F1715", shrink: 0 }}>
          <Text class="text-2xs font-bold" style={{ textColor: C.muted }}>9:41</Text>
          <Text class="text-2xs" style={{ textColor: "#34D399" }}>WeChat MP</Text>
        </View>
        <View
          class="flex-row items-center justify-between gap-1 px-2.5 w-full"
          style={{ height: 24, bgColor: "#131D1A", shrink: 0 }}
        >
          <View class="flex-1 overflow-hidden" style={{ minW: 0 }}>
            <Text class="text-2xs font-bold" style={{ textColor: C.text }}>{title()}</Text>
          </View>
          {/* Authentic WeChat Capsule `[ ••• | ◎ ]` */}
          <View
            class="flex-row items-center justify-between px-1.5"
            style={{
              width: 48,
              height: 18,
              radius: 999,
              bgColor: "#0B1110",
              borderColor: "#2D423B",
              borderWidth: 1,
              shrink: 0,
            }}
          >
            <Text class="text-2xs font-bold" style={{ textColor: C.text }}>•••</Text>
            <View style={{ width: 1, height: 9, bgColor: "#2D423B" }} />
            <Text class="text-2xs font-bold" style={{ textColor: "#34D399" }}>◎</Text>
          </View>
        </View>
        <HairlineH />

        <PreviewSurface
          studio={s}
          target="wechat"
          focused={props.focused}
          compact={props.density === "multi"}
          radius={0}
        />

        {/* Bottom WeChat WASM & 2 MiB Package Budget Bar + Standalone WeChat Server Toggle */}
        <HairlineH />
        <View
          class="flex-row items-center justify-between gap-1 px-2 w-full"
          style={{ height: 22, bgColor: "#0F1715", shrink: 0 }}
        >
          <Text class="text-2xs" style={{ textColor: "#34D399" }}>
            {wxState().state === "running"
              ? "微信服务已就绪"
              : wxState().state === "building"
                ? "微信包编译中…"
                : "wx.* · ≤2MiB"}
          </Text>
          <View class="flex-row items-center gap-1" style={{ shrink: 0 }}>
            <Show
              when={wxState().state === "running" && wxState().url}
              fallback={
                <StudioButton
                  label={wxState().state === "building" ? "停止" : "微信服务"}
                  kind="quiet"
                  size="xs"
                  onPress={() =>
                    void (wxState().state === "building"
                      ? s.preview.stopWechatService()
                      : s.preview.startWechatService())
                  }
                />
              }
            >
              <StudioButton
                label="复制地址"
                kind="quiet"
                size="xs"
                onPress={() => void s.copy(wxState().url!, "微信预览地址")}
              />
              <StudioButton
                label="停止"
                kind="text"
                size="xs"
                onPress={() => void s.preview.stopWechatService()}
              />
            </Show>
          </View>
        </View>
      </View>
      <View class="flex-row items-center gap-1">
        <Text class="text-xs font-bold" style={{ textColor: "#34D399" }}>微信小程序</Text>
        <Text class="text-2xs" style={{ textColor: C.muted }}>胶囊沙箱 · 375×667</Text>
      </View>
    </Focusable>
  );
}

/** 4. Extensible System Widget / Dynamic Island / Wearable Surface Card (`widget` & `widgetAlt`). */
function WidgetPreviewCard(props: {
  studio: Studio;
  slot: "widget" | "widgetAlt";
  density: "single" | "dual" | "multi";
  focused: boolean;
  onFocus: () => void;
}) {
  const s = props.studio;
  const preview = fromStore(s.preview.store);
  const profileId = () => (props.slot === "widget" ? preview().widgetProfileId : preview().widgetAltProfileId);
  const renderMode = () => (props.slot === "widget" ? preview().widgetRenderMode : preview().widgetAltRenderMode);
  const profile = (): EcosystemSurfaceProfile =>
    getSurfaceProfile(profileId()) ?? getSurfaceProfile("ios-widget-medium")!;

  const stepProfile = (delta: number) => {
    const list = WIDGET_SURFACE_PROFILES;
    if (list.length === 0) return;
    const idx = Math.max(0, list.findIndex((p) => p.id === profile().id));
    const next = list[(idx + delta + list.length) % list.length]!;
    s.preview.setWidgetProfile(next.id, props.slot);
  };

  const stepRenderMode = () => {
    const modes = profile().supportedRenderModes;
    if (modes.length <= 1) return;
    const idx = Math.max(0, modes.indexOf(renderMode()));
    const next = modes[(idx + 1) % modes.length]!;
    s.preview.setWidgetRenderMode(next, props.slot);
  };

  const modeLabel = () => RENDER_MODE_OPTIONS.find((m) => m.id === renderMode())?.label ?? renderMode();
  const backdrop = () => backdropColorFor(profile().shell.wallpaper);

  const cardGeometry = () => {
    const p = profile();
    const maxW = props.density === "multi" ? 168 : props.density === "dual" ? 290 : 380;
    const maxH = props.density === "multi" ? 96 : props.density === "dual" ? 280 : 320;
    const scale = Math.min(1, maxW / Math.max(1, p.width), maxH / Math.max(1, p.height));
    const innerW = Math.max(64, Math.round(p.width * scale));
    const innerH = Math.max(32, Math.round(p.height * scale));
    const innerR = p.screenShape === "round"
      ? Math.round(Math.min(innerW, innerH) / 2)
      : p.screenShape === "capsule"
        ? Math.round(innerH / 2)
        : Math.max(8, Math.round(p.cornerRadius * scale));
    const outerW = Math.max(props.density === "multi" ? 196 : 264, innerW + 24);
    const outerH = props.density === "multi" ? 188 : props.density === "dual" ? 390 : 424;
    return { innerW, innerH, innerR, outerW, outerH };
  };

  return (
    <Focusable class="flex-col items-center gap-0.5" onPress={props.onFocus}>
      <View
        class="flex-col overflow-hidden"
        style={{
          width: cardGeometry().outerW,
          height: cardGeometry().outerH,
          bgColor: backdrop().bg,
          borderColor: props.focused ? C.primaryBorder : backdrop().border,
          borderWidth: 1,
          radius: 16,
          shadow: 2,
        }}
      >
        {/* Top Widget Spec Switcher Header */}
        <View
          class="flex-row items-center justify-between gap-1 px-2 w-full"
          style={{ height: 24, bgColor: "#0E1320", shrink: 0 }}
        >
          <View class="flex-row items-center gap-0.5" style={{ shrink: 1, minW: 0 }}>
            <StudioButton label="‹" kind="quiet" size="xs" onPress={() => stepProfile(-1)} />
            <Text class="text-2xs font-bold" style={{ textColor: C.text }}>{profile().shortLabel}</Text>
            <StudioButton label="›" kind="quiet" size="xs" onPress={() => stepProfile(1)} />
          </View>
          <StudioButton label={modeLabel()} kind="quiet" size="xs" onPress={stepRenderMode} />
        </View>
        <HairlineH />

        {/* Ambient Home/Lock/Watch Wallpaper Stage Centering Exact Surface Geometry */}
        <View class="flex-col items-center justify-center p-1.5 flex-1 w-full" style={{ minH: 0 }}>
          <View
            class="relative overflow-hidden"
            style={{
              width: cardGeometry().innerW,
              height: cardGeometry().innerH,
              radius: cardGeometry().innerR,
              bgColor: C.stageDevice,
              borderColor: renderMode() === "alwaysOn" ? "#1E293B" : "#475569",
              borderWidth: 1,
              shadow: 2,
              opacity: renderMode() === "alwaysOn" ? 0.78 : 1,
            }}
          >
            <PreviewSurface
              studio={s}
              target={props.slot}
              focused={props.focused}
              compact
              radius={cardGeometry().innerR}
            />
            <Show when={profile().shell.cutoutWidth > 0 && profile().kind === "live-activity"}>
              <View
                class="items-center justify-center"
                style={{
                  posType: 1,
                  insetL: Math.max(6, Math.round((cardGeometry().innerW - 44) / 2)),
                  insetT: 2,
                  width: 44,
                  height: 10,
                  radius: 999,
                  bgColor: "#000000",
                }}
              />
            </Show>
          </View>
          <Text class="text-2xs pt-0.5" style={{ textColor: C.muted }}>
            {`${profile().width} × ${profile().height} · ${profile().ecosystem === "apple" ? "Apple" : "Android"} · ${profile().family}`}
          </Text>
        </View>

        {/* Companion App Deep-Link Footer */}
        <HairlineH />
        <View
          class="flex-row items-center justify-between gap-1 px-2 w-full"
          style={{ height: 22, bgColor: "#0E1320", shrink: 0 }}
        >
          <Text class="text-2xs" style={{ textColor: C.muted }}>
            {`${renderMode()}`}
          </Text>
          <StudioButton
            label="联动宿主 App ↗"
            kind="quiet"
            size="xs"
            onPress={() => s.preview.openWidgetCompanion(props.slot)}
          />
        </View>
      </View>
      <View class="flex-row items-center gap-1">
        <Text class="text-xs font-bold" style={{ textColor: props.focused ? C.info : C.text }}>
          {props.slot === "widget" ? "小组件" : "灵动岛 / 穿戴"}
        </Text>
        <Text class="text-2xs" style={{ textColor: C.muted }}>{profile().shortLabel}</Text>
      </View>
    </Focusable>
  );
}

/**
 * Simultaneous Multi-Target Hardware Stage (`#preview-surfaces`).
 * Renders 1 to 5 active preview sandboxes side-by-side (`Flutter`, `Web`, `微信小程序`, `小组件`, `灵动岛/穿戴`).
 */
export function PreviewHardwareStage(props: { studio: Studio }) {
  const s = props.studio;
  const preview = fromStore(s.preview.store);
  const targets = () => preview().activeTargets;
  const [focusedTarget, setFocusedTarget] = createSignal<PreviewTargetId>("flutter");
  const [zoomed, setZoomed] = createSignal(false);

  const effectiveFocus = (): PreviewTargetId => {
    const f = focusedTarget();
    return targets().includes(f) ? f : (targets()[0] ?? "flutter");
  };

  const isZoomed = () => zoomed() && targets().length > 2;
  const visibleTargets = (): readonly PreviewTargetId[] =>
    isZoomed() ? [effectiveFocus()] : targets();

  const density = (): "single" | "dual" | "multi" => {
    if (isZoomed()) return "single";
    const n = targets().length;
    if (n <= 1) return "single";
    if (n === 2) return "dual";
    return "multi";
  };

  return (
    <View class="flex-col flex-1 w-full h-full overflow-hidden" style={{ bgColor: C.bg, minH: 0 }}>
      <ScrollablePage>
        <View class={density() === "multi" ? "flex-col items-center justify-center gap-1 p-1.5 w-full" : "flex-col items-center justify-center gap-2.5 p-3 w-full"}>
          {/* Side-by-side Simultaneous Preview Cards */}
          <View class={density() === "multi" ? "flex-row flex-wrap items-start justify-center gap-2 w-full" : "flex-row flex-wrap items-start justify-center gap-3 w-full"}>
            <For each={visibleTargets()}>
              {(targetId) => {
                const isFocused = () => effectiveFocus() === targetId;
                const focusMe = () => setFocusedTarget(targetId);
                return (
                  <>
                    <Show when={targetId === "flutter"}>
                      <FlutterPreviewCard studio={s} density={density()} focused={isFocused()} onFocus={focusMe} />
                    </Show>
                    <Show when={targetId === "web"}>
                      <WebPreviewCard studio={s} density={density()} focused={isFocused()} onFocus={focusMe} />
                    </Show>
                    <Show when={targetId === "wechat"}>
                      <WechatPreviewCard studio={s} density={density()} focused={isFocused()} onFocus={focusMe} />
                    </Show>
                    <Show when={targetId === "widget"}>
                      <WidgetPreviewCard studio={s} slot="widget" density={density()} focused={isFocused()} onFocus={focusMe} />
                    </Show>
                    <Show when={targetId === "widgetAlt"}>
                      <WidgetPreviewCard studio={s} slot="widgetAlt" density={density()} focused={isFocused()} onFocus={focusMe} />
                    </Show>
                  </>
                );
              }}
            </For>
          </View>

          {/* Aggregate Telemetry & Multi-Card Focus Zoom Caption */}
          <View class="flex-row items-center justify-center gap-2 flex-wrap">
            <Text class="text-2xs" style={{ textColor: C.muted }}>
              {`并行沙箱：${targets().length} 端激活`}
            </Text>
            <Show when={targets().length > 2}>
              <StudioButton
                label={isZoomed() ? "还原多端网格" : "放大焦点画布"}
                kind="quiet"
                size="xs"
                onPress={() => setZoomed((z) => !z)}
              />
            </Show>
            <Show when={preview().version}>
              <Text class="text-2xs" style={{ textColor: C.info }}>{`${preview().version}`}</Text>
            </Show>
            <Show when={preview().lastLatencyMs !== undefined}>
              <Text class="text-2xs" style={{ textColor: C.faint }}>{`上次耗时 ${preview().lastLatencyMs} ms`}</Text>
            </Show>
          </View>
        </View>
      </ScrollablePage>
    </View>
  );
}

/** Responsive Preview Page used when viewport < 1160px (`page === "preview"`). */
export function PreviewPage(props: { studio: Studio }) {
  const s = props.studio;
  const preview = fromStore(s.preview.store);
  const project = () => s.projects.current();
  const phaseTone = () => (preview().phase === "running" ? "good" : preview().phase === "error" ? "bad" : preview().phase === "idle" ? "neutral" : "warn");
  const anySlotRunning = () =>
    (Object.keys(preview().slots) as PreviewTargetId[]).some((k) => preview().slots[k].instanceId !== undefined);

  return (
    <View class="flex-col flex-1 h-full w-full" style={{ bgColor: C.bg, minH: 0 }}>
      {/* `.preview-toolbar` */}
      <View class="flex-row items-center justify-between gap-2 px-3 py-1.5 w-full flex-wrap" style={{ bgColor: C.surface, shrink: 0 }}>
        <View class="flex-row items-center gap-1.5 flex-wrap">
          <Text class="text-sm font-bold" style={{ textColor: C.text }}>预览</Text>
          <LiveChip label={PREVIEW_PHASE_LABEL[preview().phase]} tone={phaseTone()} />
          <View
            class="flex-row items-center gap-0.5 p-0.5 rounded-md"
            style={{ bgColor: C.bgRaised, borderColor: C.line, borderWidth: 1, radius: 6 }}
          >
            <For each={PREVIEW_TARGET_SPECS}>
              {(spec) => (
                <CapsuleToggle
                  label={spec.shortLabel}
                  active={preview().activeTargets.includes(spec.id)}
                  onPress={() => void s.preview.toggleTarget(spec.id)}
                />
              )}
            </For>
          </View>
          <Show when={preview().version}>
            <StateChip label={`${preview().version}`} tone="info" />
          </Show>
          <Show when={preview().lastLatencyMs !== undefined}>
            <Text class="text-2xs" style={{ textColor: C.faint }}>{`上次耗时 ${preview().lastLatencyMs} ms`}</Text>
          </Show>
        </View>
        <View class="flex-row items-center gap-1.5" style={{ shrink: 0 }}>
          <StudioButton label="构建并刷新预览" kind="primary" size="xs" disabled={!project()} onPress={() => void s.preview.run({ build: true })} />
          <StudioButton label="重新加载" kind="secondary" size="xs" disabled={!project()} onPress={() => void s.preview.run({ build: false })} />
          <StudioButton label="关闭预览" kind="quiet" size="xs" disabled={!anySlotRunning() && preview().instanceId === undefined} onPress={() => void s.preview.reset()} />
        </View>
      </View>
      <HairlineH />
      <Show when={preview().message}>
        <View class="px-3 py-1 w-full" style={{ bgColor: C.stageHud, shrink: 0 }}>
          <Text class="text-xs" style={{ textColor: preview().phase === "error" ? C.danger : C.muted }}>{preview().message}</Text>
        </View>
        <HairlineH soft />
      </Show>
      <View class="flex-row flex-1 w-full" style={{ minH: 0 }}>
        <PreviewHardwareStage studio={s} />
        <HairlineV />
        <View class="flex-col h-full" style={{ width: 300, shrink: 0 }}>
          <DeployPane studio={s} compactSide />
        </View>
      </View>
    </View>
  );
}
