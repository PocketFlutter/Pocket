/**
 * Declarative multi-page & navigation shell built on `@pocket/ui` primitives.
 *
 * Composes `PocketRouterProvider`, `FocusScope`, retained `RouteView` slots,
 * `PocketRouteScope`, `SkinScaffold`, `SkinAppBar`, `SkinNavigationBar`,
 * `MobileBackButton`, and `createPocketBackNavigation` so apps get retained
 * routes, safe-area insets, tab bars, and native back/swipe-back out of the box.
 */

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
  type JSX,
} from "solid-js";
import { after, simulationHz } from "@pocketjs/framework/clock";
import { FocusScope } from "@pocketjs/framework/solid/components";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import {
  PocketBackInterceptorProvider,
  PocketBackRouteActiveProvider,
  createPocketBackInterceptorRegistry,
  createPocketBackNavigation,
  shouldCommitPocketBackGesture,
  usePocketBackHandler,
  type PocketBackGestureEvent,
} from "./back-navigation.ts";
import { createDisplayGeometry } from "./display.ts";
import { createHostBridge, type HostBridge } from "./host.ts";
import {
  computeTransitionDescriptor,
  TRANSITION_MODES,
  type TransitionDescriptor,
  type TransitionMode,
} from "./legacy.ts";
import { PocketLifecycleProvider, createPocketSystemUiSync } from "./lifecycle.tsx";
import type { MediaController } from "./media.ts";
import type { createPocketPlatformClient } from "./platform.ts";
import type { DisplayGeometry } from "./responsive.ts";
import { RouteView } from "./route.tsx";
import {
  PocketRouteScope,
  PocketRouterProvider,
  type PocketRouteDefinition,
  type PocketRouter,
} from "./router.tsx";
import { AppleSemanticsProvider, useAppleSemantics } from "./semantics.ts";
import {
  SkinAppBar,
  SkinBackButton,
  SkinNavigationBar,
  SkinScaffold,
  useUiSkin,
} from "./skins.tsx";
import {
  deliverTextInputEvent,
  type NavigationItem,
  type SafeAreaEdges,
  type SafeAreaReservedActions,
  type TextInputParams,
} from "./ui.tsx";

export { usePocketBackHandler } from "./back-navigation.ts";

export interface PocketAppRouteView<Id extends string = string> {
  readonly id: Id;
  readonly title?: string | (() => string);
  readonly subtitle?: string | (() => string | undefined);
  readonly appBar?: JSX.Element | (() => JSX.Element) | null;
  readonly leading?: JSX.Element | (() => JSX.Element);
  readonly trailing?: JSX.Element | (() => JSX.Element);
  readonly centered?: boolean;
  readonly edges?: SafeAreaEdges;
  readonly reservedActions?: SafeAreaReservedActions;
  readonly showBottomBar?: boolean;
  readonly backdrop?: boolean;
  readonly render: () => JSX.Element;
}

export interface PocketAppShellProps<Id extends string = string> {
  readonly router: PocketRouter<Id, any>;
  readonly routes: readonly PocketAppRouteView<Id>[];
  readonly tabs?: readonly NavigationItem[];
  readonly host?: HostBridge | Pick<HostBridge, "onEvent" | "emit"> | null;
  readonly platform?: ReturnType<typeof createPocketPlatformClient>;
  readonly media?: MediaController;
  readonly geometry?: Accessor<DisplayGeometry>;
  readonly trailing?: JSX.Element | (() => JSX.Element);
  readonly reservedActions?: SafeAreaReservedActions;
  readonly transitionMode?: TransitionMode | Accessor<TransitionMode | undefined>;
  readonly transitionDurationMs?: number | Accessor<number | undefined>;
  readonly syncSystemUi?: boolean;
  readonly syncMediaRoute?: boolean;
  readonly syncDeepLinks?: boolean;
  readonly onRootBack?: () => boolean | void | Promise<boolean | void>;
}

export interface PocketRouteTransitionState<Id extends string = string> {
  readonly from: Id;
  readonly to: Id;
  readonly direction: "forward" | "reverse";
  readonly elapsedMs: number;
  readonly progress: number;
}

export interface PocketRouteTransitionController<Id extends string = string> {
  readonly transition: Accessor<PocketRouteTransitionState<Id> | undefined>;
  isAnimatingRoute(routeId: Id): boolean;
  isReverseExiting(routeId: Id): boolean;
  styleForRoute(routeId: Id): { translateX: number; translateY: number };
  suppressNext(): void;
}

export function createPocketRouteTransitionController<Id extends string = string>(options: {
  readonly currentRoute: Accessor<Id>;
  readonly stackDepth: Accessor<number>;
  readonly isPrimaryRoute?: (routeId: Id) => boolean;
  readonly mode: Accessor<TransitionMode>;
  readonly durationMs: Accessor<number>;
  readonly reducedMotion: Accessor<boolean>;
  readonly viewportWidth: Accessor<number>;
}): PocketRouteTransitionController<Id> {
  const [tick, setTick] = createSignal<{ readonly id: number; readonly elapsedMs: number }>({
    id: 0,
    elapsedMs: 0,
  });
  let previousRoute = untrack(options.currentRoute);
  let previousDepth = untrack(options.stackDepth);
  let suppressed = false;
  let nextSpecId = 1;
  let activeSpec:
    | {
        readonly id: number;
        readonly from: Id;
        readonly to: Id;
        readonly direction: "forward" | "reverse";
      }
    | undefined;

  const resolvedMode = (): TransitionMode => {
    const m = options.mode();
    return TRANSITION_MODES.includes(m) ? m : "IOS_SPRING_PARALLAX";
  };

  const transition = createMemo<PocketRouteTransitionState<Id> | undefined>(() => {
    const nextRoute = options.currentRoute();
    const nextDepth = options.stackDepth();
    const duration = Math.max(0, Math.min(600, Math.round(options.durationMs())));
    const reduced = options.reducedMotion();

    if (nextRoute !== previousRoute) {
      const from = previousRoute;
      const wasDepth = previousDepth;
      previousRoute = nextRoute;
      previousDepth = nextDepth;
      if (suppressed) {
        suppressed = false;
        activeSpec = undefined;
      } else if (reduced || duration <= 0) {
        activeSpec = undefined;
      } else if (nextDepth < wasDepth) {
        activeSpec = { id: nextSpecId++, from, to: nextRoute, direction: "reverse" };
      } else if (!(options.isPrimaryRoute?.(from) && options.isPrimaryRoute?.(nextRoute))) {
        activeSpec = { id: nextSpecId++, from, to: nextRoute, direction: "forward" };
      } else {
        activeSpec = undefined;
      }
    } else {
      previousDepth = nextDepth;
    }

    if (!activeSpec || reduced || duration <= 0) {
      activeSpec = undefined;
      return undefined;
    }

    const currentTick = tick();
    const elapsedMs = currentTick.id === activeSpec.id ? currentTick.elapsedMs : 0;
    const progress = Math.max(0, Math.min(1, elapsedMs / Math.max(1, duration)));
    if (progress >= 1) {
      activeSpec = undefined;
      return undefined;
    }
    return {
      from: activeSpec.from,
      to: activeSpec.to,
      direction: activeSpec.direction,
      elapsedMs,
      progress,
    };
  });

  try {
    onFrame(
      () => {
        const current = transition();
        if (!current || !activeSpec) return;
        const specId = activeSpec.id;
        const duration = Math.max(0, Math.min(600, Math.round(options.durationMs())));
        if (options.reducedMotion() || duration <= 0) {
          activeSpec = undefined;
          setTick({ id: specId, elapsedMs: duration + 1 });
          return;
        }
        setTick({ id: specId, elapsedMs: current.elapsedMs + 1000 / Math.max(1, simulationHz()) });
      },
      {
        continuous: () => transition() !== undefined,
      },
    );
  } catch {
    // Safe when instantiated outside a Solid render owner.
  }

  return {
    transition,
    isAnimatingRoute(routeId: Id): boolean {
      const t = transition();
      return t !== undefined && (t.from === routeId || t.to === routeId);
    },
    isReverseExiting(routeId: Id): boolean {
      const t = transition();
      return t !== undefined && t.direction === "reverse" && t.from === routeId;
    },
    styleForRoute(routeId: Id): { translateX: number; translateY: number } {
      const t = transition();
      if (!t) return { translateX: 0, translateY: 0 };
      const desc: TransitionDescriptor = computeTransitionDescriptor(
        resolvedMode(),
        t.progress,
        t.direction === "reverse",
        Math.max(1, options.viewportWidth()),
      );
      if (routeId === t.to) {
        return { translateX: desc.inTx, translateY: desc.inTy };
      }
      if (routeId === t.from) {
        return { translateX: desc.outTx, translateY: desc.outTy };
      }
      return { translateX: 0, translateY: 0 };
    },
    suppressNext(): void {
      suppressed = true;
    },
  };
}

interface ActiveRouteBackGesture<Id extends string> {
  readonly gestureId: string;
  readonly fromRoute: Id;
  readonly toRoute: Id;
  readonly width: number;
  readonly progress: number;
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function resolveText(value: string | (() => string) | undefined, fallback: string): string {
  if (typeof value === "function") return value();
  return value ?? fallback;
}

function resolveOptionalText(
  value: string | (() => string | undefined) | undefined,
): string | undefined {
  return typeof value === "function" ? value() : value;
}

function resolveSlot(
  slot: JSX.Element | (() => JSX.Element) | undefined,
): JSX.Element | undefined {
  return typeof slot === "function" ? (slot as () => JSX.Element)() : slot;
}

function resolveDefaultHostBridge():
  | { bridge: Pick<HostBridge, "onEvent" | "emit">; ownedBridge?: HostBridge }
  | undefined {
  const g = globalThis as typeof globalThis & {
    __pocketHostBridge?: HostBridge;
    pocket?: { _emitValue?: unknown };
  };
  if (g.__pocketHostBridge) {
    return { bridge: g.__pocketHostBridge };
  }
  if (typeof g.pocket?._emitValue === "function") {
    try {
      const created = createHostBridge(undefined, {
        timeoutFrames: 10 * simulationHz(),
        scheduleTimeout: (frames, cb) => after(frames / simulationHz(), cb),
      });
      return { bridge: created, ownedBridge: created };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function PocketAppRouteSlot(props: { render: () => JSX.Element | undefined }): JSX.Element {
  return untrack(() => props.render()) as JSX.Element;
}

function PocketShellSystemUiSync(props: {
  bridge?: HostBridge;
  enabled: Accessor<boolean>;
  key: Accessor<string>;
}): JSX.Element {
  if (props.bridge) {
    createPocketSystemUiSync({
      bridge: props.bridge,
      enabled: props.enabled,
      key: props.key,
    });
  }
  return undefined as unknown as JSX.Element;
}

export function PocketAppShell<Id extends string = string>(
  props: PocketAppShellProps<Id>,
): JSX.Element {
  const defaultHost =
    props.host === undefined ? resolveDefaultHostBridge() : undefined;
  const resolvedHost =
    props.host === null ? undefined : (props.host ?? defaultHost?.bridge);
  const ownedHostBridge = defaultHost?.ownedBridge;
  const requestHost =
    resolvedHost && typeof (resolvedHost as HostBridge).request === "function"
      ? (resolvedHost as HostBridge)
      : undefined;
  const geometry = props.geometry ?? createDisplayGeometry();
  const skin = useUiSkin();
  const transitionCtrl = createPocketRouteTransitionController<Id>({
    currentRoute: () => props.router.current().routeId,
    stackDepth: () => props.router.stack().length,
    isPrimaryRoute: (id) => props.router.getRoute(id)?.primary === true,
    mode: () => {
      const ov =
        typeof props.transitionMode === "function"
          ? props.transitionMode()
          : props.transitionMode;
      return ov && TRANSITION_MODES.includes(ov) ? ov : skin.motion().routeTransition;
    },
    durationMs: () => {
      const ov =
        typeof props.transitionDurationMs === "function"
          ? props.transitionDurationMs()
          : props.transitionDurationMs;
      return typeof ov === "number" && Number.isFinite(ov)
        ? ov
        : skin.motion().routeTransitionDurationMs;
    },
    reducedMotion: skin.reducedMotion,
    viewportWidth: () => geometry().width || 390,
  });
  const backInterceptors = createPocketBackInterceptorRegistry();
  const [backGesture, setBackGesture] = createSignal<ActiveRouteBackGesture<Id> | undefined>(
    undefined,
  );

  const gestureFrom = (): Id | undefined => backGesture()?.fromRoute;
  const gestureTo = (): Id | undefined => backGesture()?.toRoute;

  const visitedIds = new Set<Id>();
  const warnedMissingIds = new Set<Id>();
  const hasRouteView = (id: Id): boolean => props.routes.some((r) => r.id === id);
  const warnMissingRouteOnce = (id: Id): void => {
    if (warnedMissingIds.has(id)) return;
    warnedMissingIds.add(id);
    console.warn(`[PocketAppShell] Route "${id}" has no view configured in props.routes`);
  };

  for (const entry of props.router.stack()) {
    visitedIds.add(entry.routeId);
    if (!hasRouteView(entry.routeId)) {
      warnMissingRouteOnce(entry.routeId);
    }
  }
  const initialCurrentId = props.router.current().routeId;
  visitedIds.add(initialCurrentId);
  if (!hasRouteView(initialCurrentId)) {
    warnMissingRouteOnce(initialCurrentId);
  }

  const [mountedIds, setMountedIds] = createSignal<readonly Id[]>(
    props.routes.filter((route) => visitedIds.has(route.id)).map((route) => route.id),
  );

  createEffect(() => {
    const stackEntries = props.router.stack();
    const currentId = props.router.current().routeId;
    const fromId = gestureFrom();
    const toId = gestureTo();
    const configuredIds = props.routes.map((r) => r.id);

    for (const entry of stackEntries) {
      visitedIds.add(entry.routeId);
      if (!configuredIds.includes(entry.routeId)) {
        warnMissingRouteOnce(entry.routeId);
      }
    }
    visitedIds.add(currentId);
    if (!configuredIds.includes(currentId)) {
      warnMissingRouteOnce(currentId);
    }
    if (fromId !== undefined) {
      visitedIds.add(fromId);
    }
    if (toId !== undefined) {
      visitedIds.add(toId);
    }

    const existing = untrack(mountedIds);
    const additions: Id[] = [];
    for (const id of configuredIds) {
      if (visitedIds.has(id) && !existing.includes(id) && !additions.includes(id)) {
        additions.push(id);
      }
    }
    if (additions.length > 0) {
      setMountedIds([...existing, ...additions]);
    }
  });

  if (resolvedHost) {
    const removeTextInput = resolvedHost.onEvent?.((event) => {
      if (event.method.startsWith("textInput.")) {
        deliverTextInputEvent(event.method, event.params as TextInputParams);
      } else if (props.syncDeepLinks !== false && event.method === "router.open") {
        const params = event.params as Record<string, unknown>;
        props.router.openDeepLink(params.url ?? params.uri ?? params.href ?? params);
      }
    });
    const backNav = createPocketBackNavigation(resolvedHost);
    backNav.setHandler(async () => {
      if (backInterceptors.dispatch()) return true;
      setBackGesture(undefined);
      if (props.router.canGoBack()) {
        props.router.back();
        return true;
      }
      if (props.onRootBack) {
        return (await props.onRootBack()) === true;
      }
      return false;
    });

    const handleGesture = (event: PocketBackGestureEvent): boolean | void => {
      if (event.phase === "start") {
        if (backInterceptors.count() > 0) return false;
        const entries = props.router.stack();
        if (entries.length < 2 || event.width <= 0) return false;
        const fromRoute = entries[entries.length - 1]!.routeId;
        const toRoute = entries[entries.length - 2]!.routeId;
        if (fromRoute === toRoute) return false;
        setBackGesture({
          gestureId: event.gestureId,
          fromRoute,
          toRoute,
          width: event.width,
          progress: clampProgress(event.progress),
        });
        return true;
      }

      const active = backGesture();
      if (!active || active.gestureId !== event.gestureId) return;

      if (event.phase === "update") {
        setBackGesture({
          ...active,
          progress: clampProgress(event.progress),
        });
        return;
      }

      setBackGesture(undefined);
      if (shouldCommitPocketBackGesture(event)) {
        transitionCtrl.suppressNext();
        props.router.back();
      }
    };

    createEffect(() => {
      const canSwipe =
        props.router.canGoBack() &&
        backInterceptors.count() === 0 &&
        (() => {
          const s = props.router.stack();
          return s.length >= 2 && s[s.length - 1]!.routeId !== s[s.length - 2]!.routeId;
        })();
      if (canSwipe) {
        backNav.setGestureHandler(handleGesture);
      } else {
        setBackGesture(undefined);
        backNav.setGestureHandler(undefined);
      }
    });

    onCleanup(() => {
      setBackGesture(undefined);
      removeTextInput?.();
      backNav.dispose();
      ownedHostBridge?.dispose();
    });
  }

  createEffect(() => {
    if (props.syncMediaRoute === false) return;
    const activeRouteId = props.router.current().routeId;
    (props.media ?? props.platform?.media)?.setCurrentPage(activeRouteId);
  });

  const routeTranslateX = (routeId: Id): number => {
    const active = backGesture();
    if (!active) return 0;
    const progress = clampProgress(active.progress);
    if (active.fromRoute === routeId) {
      return progress * active.width;
    }
    if (active.toRoute === routeId) {
      return -0.3 * active.width * (1 - progress);
    }
    return 0;
  };

  const routeZIndex = (routeId: Id): number => {
    const stack = props.router.stack();
    let stackIdx = -1;
    for (let i = 0; i < stack.length; i += 1) {
      if (stack[i]!.routeId === routeId) stackIdx = i;
    }
    const active = backGesture();
    if (active) {
      if (active.fromRoute === routeId) return stack.length + 10;
      if (active.toRoute === routeId) return stack.length + 9;
    }
    if (transitionCtrl.isReverseExiting(routeId)) {
      return stack.length + 8;
    }
    return stackIdx >= 0
      ? stackIdx + 2
      : props.router.current().routeId === routeId
        ? stack.length + 2
        : 1;
  };

  const inheritedAppleSemantics = useAppleSemantics();

  const shellContent = (): JSX.Element => (
    <FocusScope class="relative flex-1 flex-col w-full h-full overflow-hidden" autoFocus restoreFocus>
      <PocketShellSystemUiSync
        bridge={requestHost}
        enabled={() => props.syncSystemUi ?? (props.reservedActions !== "mini-app")}
        key={() => props.router.current().routeId}
      />
      <For each={mountedIds()}>
        {(routeId) => {
          const view = (): PocketAppRouteView<Id> | undefined =>
            props.routes.find((candidate) => candidate.id === routeId);
          const routeDef = (): PocketRouteDefinition<Id, any> | undefined =>
            props.router.getRoute(routeId);
          const isPrimary = (): boolean => routeDef()?.primary === true;
          const showBottomBar = (): boolean =>
            view()?.showBottomBar ?? ((props.tabs?.length ?? 0) > 0 && isPrimary());
          const edges: SafeAreaEdges = untrack(
            () => view()?.edges ?? (showBottomBar() ? ["top", "left", "right"] : "all"),
          );
          const resolvedTrailing = (): JSX.Element | undefined =>
            resolveSlot(view()?.trailing ?? props.trailing);
          const appBar = (): JSX.Element | undefined => {
            const customAppBar = view()?.appBar;
            if (customAppBar === null) return undefined;
            if (customAppBar !== undefined) return resolveSlot(customAppBar);
            return (
              <SkinAppBar
                title={resolveText(view()?.title, routeId)}
                subtitle={resolveOptionalText(view()?.subtitle)}
                centered={view()?.centered ?? !isPrimary()}
                leading={
                  view()?.leading !== undefined ? (
                    resolveSlot(view()?.leading)
                  ) : (
                    <Show when={!isPrimary() && props.router.canGoBack()}>
                      <SkinBackButton onPress={() => props.router.back()} />
                    </Show>
                  )
                }
                trailing={resolvedTrailing()}
              />
            );
          };
          const bottomBar = (): JSX.Element | undefined =>
            showBottomBar() && props.tabs?.length ? (
              <SkinNavigationBar
                route={props.router.current().routeId}
                items={props.tabs}
                onNavigate={(nextRoute) => {
                  props.router.navigate(nextRoute);
                }}
                visible
                geometry={geometry}
              />
            ) : undefined;

          const routeActive = createMemo(() => props.router.current().routeId === routeId);
          const routeVisible = createMemo(
            () =>
              routeActive() ||
              gestureTo() === routeId ||
              gestureFrom() === routeId ||
              transitionCtrl.isAnimatingRoute(routeId),
          );

          return (
            <RouteView
              class="absolute inset-0 w-full h-full overflow-hidden"
              active={routeActive}
              visible={routeVisible}
              style={{
                translateX: backGesture()
                  ? routeTranslateX(routeId)
                  : transitionCtrl.styleForRoute(routeId).translateX,
                translateY: backGesture()
                  ? 0
                  : transitionCtrl.styleForRoute(routeId).translateY,
                zIndex: routeZIndex(routeId),
              }}
            >
              <PocketBackRouteActiveProvider active={routeActive}>
                <PocketRouteScope routeId={routeId}>
                  <SkinScaffold
                    edges={edges}
                    geometry={geometry}
                    reservedActions={view()?.reservedActions ?? props.reservedActions}
                    backdrop={view()?.backdrop}
                    appBar={view()?.appBar === null ? undefined : appBar}
                    bottomBar={bottomBar}
                  >
                    <PocketAppRouteSlot render={() => view()?.render()} />
                  </SkinScaffold>
                </PocketRouteScope>
              </PocketBackRouteActiveProvider>
            </RouteView>
          );
        }}
      </For>
    </FocusScope>
  );

  return (
    <PocketRouterProvider router={props.router}>
      <PocketBackInterceptorProvider value={backInterceptors}>
        <PocketLifecycleProvider bridge={resolvedHost} platform={props.platform}>
          {!inheritedAppleSemantics && resolvedHost ? (
            <AppleSemanticsProvider bridge={resolvedHost}>
              {shellContent()}
            </AppleSemanticsProvider>
          ) : (
            shellContent()
          )}
        </PocketLifecycleProvider>
      </PocketBackInterceptorProvider>
    </PocketRouterProvider>
  );
}
