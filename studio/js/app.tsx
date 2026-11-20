// Studio 5-Zone Desktop IDE Workbench Shell (matching Web Preview sdk/editor/client/).
// Zone A: TopCommandBar (46px)
// Zone B: Activity Rail (56px)
// Zone C: Docked Source Split (`SourceDock`, resizable via SplitPane)
// Zone D: Center Preview Stage & Collapsible 4-Tab Console Dock (`StageColumn`)
// Zone E: Right 3-Tab Inspector (`InspectorColumn`, 368px)
// Below WIDE_WORKBENCH_MIN_WIDTH (<1160px), gracefully adapts to responsive single-pane focus mode.
import { Show, createSignal, onCleanup } from "solid-js";
import { MobileThemeProvider, deliverTextInputEvent } from "@pocket/ui";
import { createDisplayGeometry } from "@pocket/ui/display";
import { SplitPane } from "@pocket/ui/split-pane";
import { createHostBridge, type HostBridge } from "@pocket/ui/host";
import { createPocketStreamAdapter } from "@pocket/ui/streams";
import { createPocketClipboardClient } from "@pocket/ui/clipboard";
import { createPocketFilesClient } from "@pocket/ui/files";
import { ToastHost } from "@pocket/ui/toast-host";
import { mount } from "@pocketjs/framework/solid";
import { onTextEvent } from "@pocketjs/framework/input";
import { Screen, View } from "@pocketjs/framework/solid/components";
import { createStudioClient } from "./src/studio-client.ts";
import { createStudio, type Studio } from "./src/state/studio.ts";
import { SOURCE_DOCK_LIMITS } from "./src/state/workbench.ts";
import { createSystemLink } from "./src/state/system-link.ts";
import { createUpdateLink } from "./src/state/update-link.ts";
import { guestTimers, yieldTurn } from "./src/ui/guest-env.ts";
import { fromStore, select } from "./src/ui/bind.ts";
import { C, STUDIO_MOBILE_THEME, WIDE_WORKBENCH_MIN_WIDTH } from "./src/ui/theme.ts";
import { TopCommandBar, ProjectSwitcherPopover } from "./src/components/top-bar.tsx";
import { Rail } from "./src/components/rail.tsx";
import { StageColumn } from "./src/components/stage-column.tsx";
import { InspectorColumn } from "./src/components/inspector-column.tsx";
import { QuickOpenOverlay } from "./src/components/quick-open.tsx";
import { DialogHost } from "./src/components/dialog-host.tsx";
import { CreateProjectDialog } from "./src/pages/projects.tsx";
import { SourceDock } from "./src/pages/source.tsx";
import { pages } from "./src/pages/index.tsx";

function Shell(props: { studio: Studio; host: HostBridge }) {
  const s = props.studio;
  const page = select(s.nav, (n) => n.page);
  const wb = fromStore(s.workbench.store);
  const projects = fromStore(s.projects.store);
  const toastState = fromStore(s.toasts.store);
  const geometry = createDisplayGeometry({
    fallback: {
      width: 1440,
      height: 900,
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      keyboardInset: 0,
      reservedRegions: [],
    },
  });
  const [liveSourceWidth, setLiveSourceWidth] = createSignal<number | undefined>(undefined);

  const wide = () => geometry().width >= WIDE_WORKBENCH_MIN_WIDTH;
  const sourceWidth = () => liveSourceWidth() ?? wb().sourceWidth;

  // Route Flutter text overlay events to InputField sessions.
  const stopText = props.host.onEvent?.((event) => {
    deliverTextInputEvent(event.method, event.params as Record<string, unknown>);
  });
  onCleanup(() => stopText?.());

  // Global shell keyboard shortcuts (src/keymap.ts).
  const toasts = s.toasts;
  const stopKeys = onTextEvent((event) => {
    if (event.kind === "key" && event.pressed && !event.repeat) {
      return s.commands.handleKey(event.key, { editorFocused: false });
    }
  });
  onCleanup(stopKeys);

  return (
    <Screen class="w-full h-full flex-col" style={{ bgColor: C.bg }}>
      {/* Zone A: Top Global Command Bar (46px) */}
      <TopCommandBar studio={s} wide={wide()} />

      {/* Main Workspace Grid */}
      <View class="flex-row flex-1 w-full" style={{ bgColor: C.bg, minH: 0 }}>
        {/* Zone B: Far-Left Activity Rail */}
        <Rail studio={s} wide={wide()} />

        {/* Zones C + D + E (Wide 5-Zone Desktop IDE Workbench vs Responsive Focus Mode) */}
        <Show
          when={wide()}
          fallback={
            <View class="flex-col flex-1 h-full" style={{ minW: 0, minH: 0 }}>
              {pages.map((def) => <Show when={page() === def.id}>{def.render(s)}</Show>)}
            </View>
          }
        >
          <View class="flex-row flex-1 h-full overflow-hidden" style={{ minW: 0, minH: 0 }}>
            <View class="flex-row flex-1 h-full overflow-hidden" style={{ minW: 0, minH: 0 }}>
              <Show
                when={wb().sourceOpen && Boolean(projects().current)}
                fallback={<StageColumn studio={s} />}
              >
                <SplitPane
                  size={sourceWidth()}
                  min={SOURCE_DOCK_LIMITS.min}
                  max={SOURCE_DOCK_LIMITS.max}
                  handle={5}
                  onResize={(w) => setLiveSourceWidth(w)}
                  onResizeEnd={(w) => {
                    s.workbench.setSourceWidth(w);
                    setLiveSourceWidth(undefined);
                  }}
                  first={<SourceDock studio={s} />}
                  second={<StageColumn studio={s} />}
                />
              </Show>
            </View>
            <Show when={wb().inspectorOpen}>
              <InspectorColumn studio={s} />
            </Show>
          </View>
        </Show>
      </View>

      {/* Global Overlays & Popovers */}
      <Show when={wide()}>
        <ProjectSwitcherPopover studio={s} />
      </Show>
      <CreateProjectDialog studio={s} />
      <DialogHost dialogs={s.dialogs} />
      <QuickOpenOverlay quickOpen={s.quickOpen} />
      <ToastHost items={toastState().items} onDismiss={(id) => toasts.dismiss(id)} />
    </Screen>
  );
}

function App() {
  const host = createHostBridge();
  const streams = createPocketStreamAdapter(host);
  const link = createSystemLink(host);
  const studio = createStudio({
    client: createStudioClient(host, streams, { yieldTurn }),
    timers: guestTimers,
    runtime: link,
    settingsBackend: link,
    clipboard: createPocketClipboardClient(host),
    files: createPocketFilesClient(host),
    updates: (handoff) => createUpdateLink(host, handoff),
  });
  return (
    <MobileThemeProvider theme={() => STUDIO_MOBILE_THEME} density="desktop">
      <Shell studio={studio} host={host} />
    </MobileThemeProvider>
  );
}

mount(() => <App />);
