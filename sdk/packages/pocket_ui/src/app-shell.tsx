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
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
  type JSX,
} from "solid-js";
import { FocusScope } from "@pocketjs/framework/solid/components";
import {
  PocketBackInterceptorProvider,
  createPocketBackInterceptorRegistry,
  createPocketBackNavigation,
  shouldCommitPocketBackGesture,
  usePocketBackHandler,
  type PocketBackGestureEvent,
} from "./back-navigation.ts";
import { createDisplayGeometry } from "./display.ts";
import { createHostBridge, type HostBridge } from "./host.ts";
import type { DisplayGeometry } from "./responsive.ts";
import { RouteView } from "./route.tsx";
import {
  PocketRouteScope,
  PocketRouterProvider,
  type PocketRouteDefinition,
  type PocketRouter,
} from "./router.tsx";
import { SkinAppBar, SkinBackButton, SkinNavigationBar, SkinScaffold } from "./skins.tsx";
import {
  deliverTextInputEvent,
  type NavigationItem,
  type SafeAreaEdges,
  type TextInputParams,
} from "./ui.tsx";

export { usePocketBackHandler } from "./back-navigation.ts";

export interface PocketAppRouteView<Id extends string = string> {
  readonly id: Id;
  readonly title?: string | (() => string);
  readonly subtitle?: string | (() => string | undefined);
  readonly appBar?: JSX.Element | (() => JSX.Element) | null;
  readonly trailing?: JSX.Element | (() => JSX.Element);
  readonly edges?: SafeAreaEdges;
  readonly showBottomBar?: boolean;
  readonly backdrop?: boolean;
  readonly render: () => JSX.Element;
}

export interface PocketAppShellProps<Id extends string = string> {
  readonly router: PocketRouter<Id, any>;
  readonly routes: readonly PocketAppRouteView<Id>[];
  readonly tabs?: readonly NavigationItem[];
  readonly host?: Pick<HostBridge, "onEvent" | "emit"> | null;
  readonly geometry?: Accessor<DisplayGeometry>;
  readonly trailing?: JSX.Element | (() => JSX.Element);
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
      const created = createHostBridge();
      return { bridge: created, ownedBridge: created };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function PocketAppShell<Id extends string = string>(
  props: PocketAppShellProps<Id>,
): JSX.Element {
  const defaultHost =
    props.host === undefined ? resolveDefaultHostBridge() : undefined;
  const resolvedHost =
    props.host === null ? undefined : (props.host ?? defaultHost?.bridge);
  const ownedHostBridge = defaultHost?.ownedBridge;
  const geometry = props.geometry ?? createDisplayGeometry();
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
      }
    });
    const backNav = createPocketBackNavigation(resolvedHost);
    backNav.setHandler(() => {
      if (backInterceptors.dispatch()) return true;
      setBackGesture(undefined);
      return props.router.canGoBack() ? props.router.back() : false;
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
    return stackIdx >= 0
      ? stackIdx + 2
      : props.router.current().routeId === routeId
        ? stack.length + 2
        : 1;
  };

  return (
    <PocketRouterProvider router={props.router}>
      <PocketBackInterceptorProvider value={backInterceptors}>
        <FocusScope class="relative flex-1 flex-col w-full h-full overflow-hidden" autoFocus restoreFocus>
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
              const initialBody = untrack(() => view()?.render());
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
                    centered={!isPrimary()}
                    leading={
                      <Show when={!isPrimary() && props.router.canGoBack()}>
                        <SkinBackButton onPress={() => props.router.back()} />
                      </Show>
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

              return (
                <RouteView
                  class="absolute inset-0 w-full h-full overflow-hidden"
                  active={() =>
                    props.router.current().routeId === routeId ||
                    gestureTo() === routeId ||
                    gestureFrom() === routeId
                  }
                  style={{
                    translateX: routeTranslateX(routeId),
                    zIndex: routeZIndex(routeId),
                  }}
                >
                  <PocketRouteScope routeId={routeId}>
                    <SkinScaffold
                      edges={edges}
                      geometry={geometry}
                      backdrop={view()?.backdrop}
                      appBar={view()?.appBar === null ? undefined : appBar}
                      bottomBar={bottomBar}
                    >
                      {initialBody}
                    </SkinScaffold>
                  </PocketRouteScope>
                </RouteView>
              );
            }}
          </For>
        </FocusScope>
      </PocketBackInterceptorProvider>
    </PocketRouterProvider>
  );
}
