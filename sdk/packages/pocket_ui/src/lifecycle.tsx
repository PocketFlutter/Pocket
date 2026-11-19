/**
 * Skin-independent guest app & route lifecycle plus native System-UI sync.
 *
 * Keeps SolidJS page components and app shells tied to the existing Pocket
 * host `platform.lifecycle` event lane without duplicating state machines or
 * coupling lifecycle policy to any specific UI skin.
 */

import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  getOwner,
  onCleanup,
  untrack,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";
import type { BridgeObject, HostBridge, HostEvent } from "./host.ts";
import {
  createPlatformExperience,
  isUnsupportedPlatformError,
  type PlatformExperience,
} from "./platform-experience.ts";
import { useRouteActive } from "./route.tsx";
import { useUiSkin } from "./skins.tsx";

export type PocketAppLifecycleState =
  | "onInit"
  | "onLoad"
  | "onWillAppear"
  | "onDidAppear"
  | "onWillDisappear"
  | "frozenInStack"
  | "onResume"
  | "onUnload";

export interface PocketAppLifecycleEvent {
  readonly state: PocketAppLifecycleState;
  readonly appId?: string;
  readonly instanceId?: string;
  readonly frozenInStack?: boolean;
  readonly raw: BridgeObject;
}

export interface PocketLifecycleHandlers {
  readonly onEvent?: (event: PocketAppLifecycleEvent) => void;
  readonly onAppear?: (event: PocketAppLifecycleEvent) => void;
  readonly onResume?: (event: PocketAppLifecycleEvent) => void;
  readonly onForeground?: (event: PocketAppLifecycleEvent) => void;
  readonly onBackground?: (event: PocketAppLifecycleEvent) => void;
  readonly onUnload?: (event: PocketAppLifecycleEvent) => void;
}

export interface PocketLifecycleController {
  readonly state: Accessor<PocketAppLifecycleState | "mounted">;
  readonly foreground: Accessor<boolean>;
  readonly frozenInStack: Accessor<boolean>;
  readonly lastEvent: Accessor<PocketAppLifecycleEvent | undefined>;
  subscribe(listener: (event: PocketAppLifecycleEvent) => void): () => void;
}

const VALID_LIFECYCLE_STATES = new Set<PocketAppLifecycleState>([
  "onInit",
  "onLoad",
  "onWillAppear",
  "onDidAppear",
  "onWillDisappear",
  "frozenInStack",
  "onResume",
  "onUnload",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

export function parsePocketAppLifecycleEvent(raw: unknown): PocketAppLifecycleEvent | undefined {
  if (!isPlainObject(raw)) return undefined;
  const state = raw.state;
  if (typeof state !== "string" || !VALID_LIFECYCLE_STATES.has(state as PocketAppLifecycleState)) {
    return undefined;
  }
  const appId = typeof raw.appId === "string" && raw.appId.length > 0 ? raw.appId : undefined;
  const instanceId = typeof raw.instanceId === "string" && raw.instanceId.length > 0 ? raw.instanceId : undefined;
  const frozenInStack = typeof raw.frozenInStack === "boolean"
    ? raw.frozenInStack
    : state === "frozenInStack"
      ? true
      : undefined;
  return {
    state: state as PocketAppLifecycleState,
    ...(appId !== undefined ? { appId } : {}),
    ...(instanceId !== undefined ? { instanceId } : {}),
    ...(frozenInStack !== undefined ? { frozenInStack } : {}),
    raw: raw as BridgeObject,
  };
}

export interface CreatePocketLifecycleControllerOptions {
  readonly bridge?: Pick<HostBridge, "onEvent">;
  readonly platform?: {
    onLifecycle: (listener: (event: BridgeObject) => void) => () => void;
  };
}

export function createPocketLifecycleController(
  options: CreatePocketLifecycleControllerOptions = {},
): PocketLifecycleController & { dispose(): void } {
  const [state, setState] = createSignal<PocketAppLifecycleState | "mounted">("mounted");
  const [foreground, setForeground] = createSignal(true);
  const [frozenInStack, setFrozenInStack] = createSignal(false);
  const [lastEvent, setLastEvent] = createSignal<PocketAppLifecycleEvent | undefined>(undefined);
  const listeners = new Set<(event: PocketAppLifecycleEvent) => void>();
  let disposed = false;

  const handleRawEvent = (raw: unknown): void => {
    if (disposed) return;
    const parsed = parsePocketAppLifecycleEvent(raw);
    if (!parsed) return;
    const frozen = parsed.state === "frozenInStack" || parsed.frozenInStack === true;
    setLastEvent(parsed);
    setState(parsed.state);
    setFrozenInStack(frozen);
    if (
      parsed.state === "onWillDisappear" ||
      parsed.state === "onUnload" ||
      parsed.state === "frozenInStack" ||
      frozen
    ) {
      setForeground(false);
    } else if (
      parsed.state === "onWillAppear" ||
      parsed.state === "onDidAppear" ||
      parsed.state === "onResume"
    ) {
      setForeground(true);
    }
    for (const listener of [...listeners]) {
      try {
        listener(parsed);
      } catch {
        // Isolate individual lifecycle listeners so the shared lane stays live.
      }
    }
  };

  let removeSubscription: (() => void) | undefined;
  if (options.platform && typeof options.platform.onLifecycle === "function") {
    removeSubscription = options.platform.onLifecycle((event) => {
      handleRawEvent(event);
    });
  } else {
    const resolvedBridge =
      options.bridge ??
      (globalThis as { __pocketHostBridge?: Pick<HostBridge, "onEvent"> }).__pocketHostBridge;
    removeSubscription = resolvedBridge?.onEvent?.((event: HostEvent) => {
      if (event.method === "platform.lifecycle") {
        handleRawEvent(event.params);
      }
    });
  }

  return {
    state,
    foreground,
    frozenInStack,
    lastEvent,
    subscribe(listener: (event: PocketAppLifecycleEvent) => void): () => void {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      removeSubscription?.();
      removeSubscription = undefined;
      listeners.clear();
    },
  };
}

const PocketLifecycleContext = createContext<PocketLifecycleController | undefined>(undefined);

export function PocketLifecycleProvider(props: {
  controller?: PocketLifecycleController;
  bridge?: Pick<HostBridge, "onEvent">;
  platform?: {
    onLifecycle: (listener: (event: BridgeObject) => void) => () => void;
  };
  children?: JSX.Element;
}): JSX.Element {
  const parent = useContext(PocketLifecycleContext);
  if (
    parent &&
    props.controller === undefined &&
    props.bridge === undefined &&
    props.platform === undefined
  ) {
    return PocketLifecycleContext.Provider({
      value: parent,
      get children() {
        return props.children;
      },
    });
  }

  const owned =
    props.controller === undefined
      ? createPocketLifecycleController({
          bridge: props.bridge,
          platform: props.platform,
        })
      : undefined;
  const controller = props.controller ?? owned!;

  if (owned && getOwner()) {
    onCleanup(() => {
      owned.dispose();
    });
  }

  return PocketLifecycleContext.Provider({
    value: controller,
    get children() {
      return props.children;
    },
  });
}

export function usePocketAppLifecycle(
  handlers?: PocketLifecycleHandlers,
): PocketLifecycleController {
  const existing = useContext(PocketLifecycleContext);
  const owned = existing ? undefined : createPocketLifecycleController();
  const controller = existing ?? owned!;

  if (owned && getOwner()) {
    onCleanup(() => {
      owned.dispose();
    });
  }

  if (handlers) {
    let wasForeground = untrack(controller.foreground);
    const unsubscribe = controller.subscribe((event) => {
      const nowForeground = untrack(controller.foreground);
      const becameForeground = !wasForeground && nowForeground;
      const becameBackground = wasForeground && !nowForeground;
      wasForeground = nowForeground;

      try {
        handlers.onEvent?.(event);
      } catch {
        // Isolate handler error.
      }
      if (event.state === "onDidAppear") {
        try {
          handlers.onAppear?.(event);
        } catch {
          // Isolate handler error.
        }
      }
      if (event.state === "onResume") {
        try {
          handlers.onResume?.(event);
        } catch {
          // Isolate handler error.
        }
      }
      if (becameForeground || event.state === "onResume") {
        try {
          handlers.onForeground?.(event);
        } catch {
          // Isolate handler error.
        }
      }
      if (becameBackground) {
        try {
          handlers.onBackground?.(event);
        } catch {
          // Isolate handler error.
        }
      }
      if (event.state === "onUnload") {
        try {
          handlers.onUnload?.(event);
        } catch {
          // Isolate handler error.
        }
      }
    });
    if (getOwner()) {
      onCleanup(unsubscribe);
    }
  }

  return controller;
}

export interface PocketRouteLifecycleHandlers {
  readonly onEnter?: () => void | (() => void);
  readonly onLeave?: () => void;
  readonly onForeground?: () => void;
  readonly onBackground?: () => void;
}

export function usePocketRouteLifecycle(
  handlers: PocketRouteLifecycleHandlers,
): { active: Accessor<boolean>; visible: Accessor<boolean> } {
  const routeActive = useRouteActive();
  const app = usePocketAppLifecycle();
  const visible = createMemo(() => routeActive() && app.foreground());

  createEffect(() => {
    if (!routeActive()) return;
    let enterCleanup: void | (() => void);
    try {
      enterCleanup = handlers.onEnter?.();
    } catch {
      // Isolate onEnter error.
    }
    onCleanup(() => {
      if (typeof enterCleanup === "function") {
        try {
          enterCleanup();
        } catch {
          // Isolate cleanup error.
        }
      }
      try {
        handlers.onLeave?.();
      } catch {
        // Isolate onLeave error.
      }
    });
  });

  let wasActive = false;
  let wasVisible = false;
  createEffect(() => {
    const isActive = routeActive();
    const isVisible = visible();
    if (isActive && wasActive) {
      if (wasVisible && !isVisible) {
        try {
          handlers.onBackground?.();
        } catch {
          // Isolate onBackground error.
        }
      } else if (!wasVisible && isVisible) {
        try {
          handlers.onForeground?.();
        } catch {
          // Isolate onForeground error.
        }
      }
    }
    wasActive = isActive;
    wasVisible = isVisible;
  });

  return {
    active: routeActive,
    visible,
  };
}

export function parseArgbHexColor(hex: string): number | undefined {
  if (typeof hex !== "string") return undefined;
  const trimmed = hex.trim();
  if (!trimmed.startsWith("#")) return undefined;
  const digits = trimmed.slice(1);
  if (digits.length === 6 && /^[0-9a-fA-F]{6}$/.test(digits)) {
    const rgb = Number.parseInt(digits, 16);
    return ((0xff000000 | rgb) >>> 0);
  }
  if (digits.length === 8 && /^[0-9a-fA-F]{8}$/.test(digits)) {
    return (Number.parseInt(digits, 16) >>> 0);
  }
  return undefined;
}

export interface PocketSystemUiSyncOptions {
  readonly bridge?: HostBridge;
  readonly experience?: Pick<PlatformExperience, "systemUi">;
  readonly enabled?: boolean | Accessor<boolean>;
  readonly key?: Accessor<string>;
  readonly statusBarColor?: number;
  readonly navigationBarColor?: number | Accessor<number | undefined>;
}

export function createPocketSystemUiSync(options: PocketSystemUiSyncOptions = {}): void {
  const skin = useUiSkin();
  let ownedExperience: PlatformExperience | undefined;

  const resolveSystemUi = (): Pick<PlatformExperience, "systemUi">["systemUi"] | undefined => {
    if (options.experience?.systemUi) return options.experience.systemUi;
    if (ownedExperience) return ownedExperience.systemUi;
    const candidateBridge =
      options.bridge && typeof options.bridge.request === "function"
        ? options.bridge
        : (() => {
            const globalBridge = (globalThis as { __pocketHostBridge?: HostBridge }).__pocketHostBridge;
            return globalBridge && typeof globalBridge.request === "function" ? globalBridge : undefined;
          })();
    if (!candidateBridge) return undefined;
    ownedExperience = createPlatformExperience(candidateBridge);
    return ownedExperience.systemUi;
  };

  if (getOwner()) {
    onCleanup(() => {
      ownedExperience?.dispose();
      ownedExperience = undefined;
    });
  }

  let lastAppliedKey: string | undefined;

  const applySystemUi = (force: boolean): void => {
    const isEnabled =
      options.enabled === undefined
        ? true
        : typeof options.enabled === "function"
          ? options.enabled()
          : options.enabled;
    if (!isEnabled) return;
    const tokens = skin.tokens();
    const dark = tokens.dark;
    const customNav =
      typeof options.navigationBarColor === "function"
        ? options.navigationBarColor()
        : options.navigationBarColor;
    const navColor = customNav ?? parseArgbHexColor(tokens.canvasBg) ?? (dark ? 0xff09090b : 0xfffafafa);
    const extraKey = options.key ? options.key() : "";
    const statusBarColor = options.statusBarColor ?? 0x00000000;
    const nextKey = `${dark}:${navColor}:${statusBarColor}:${extraKey}`;
    if (!force && lastAppliedKey === nextKey) return;
    const systemUi = resolveSystemUi();
    if (!systemUi) return;
    lastAppliedKey = nextKey;
    void systemUi
      .set({
        statusBarColor,
        statusBarIconBrightness: dark ? "light" : "dark",
        statusBarBrightness: dark ? "dark" : "light",
        systemNavigationBarColor: navColor,
        systemNavigationBarIconBrightness: dark ? "light" : "dark",
      })
      .catch((error: unknown) => {
        if (!isUnsupportedPlatformError(error)) {
          // Ignore non-fatal native system UI errors in headless/desktop hosts.
        }
      });
  };

  createEffect(() => {
    applySystemUi(false);
  });

  usePocketAppLifecycle({
    onEvent: (event) => {
      if (event.state === "onResume" || event.state === "onDidAppear") {
        untrack(() => applySystemUi(true));
      }
    },
  });
}
