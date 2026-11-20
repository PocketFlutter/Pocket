import { createContext, createEffect, createSignal, onCleanup, useContext, type Accessor, type JSX } from "solid-js";
import type { BridgeObject, HostBridge } from "./host.ts";
import { registerBackParticipant } from "./back-requests.ts";
export {
  POCKET_BACK_REQUEST_EVENT,
  POCKET_BACK_RESPONSE_EVENT,
  POCKET_BACK_GESTURE_EVENT,
} from "./back-requests.ts";
export const POCKET_BACK_GESTURE_RESPONSE_EVENT = "platform.back.gesture.response";
export const POCKET_BACK_GESTURE_READY_EVENT = "platform.back.gesture.ready";

export type PocketBackRequestHandler = (requestId: string) => boolean | Promise<boolean>;

export type PocketBackGesturePhase = "start" | "update" | "end" | "cancel";

export interface PocketBackGestureEvent {
  gestureId: string;
  phase: PocketBackGesturePhase;
  dx: number;
  width: number;
  velocity: number;
  progress: number;
}

/** Return true only for a synchronously accepted start; later phases are notifications. */
export type PocketBackGestureHandler = (event: PocketBackGestureEvent) => boolean | void;

/** Pocket's distance rule: commit only when the latest terminal progress is over half. */
export function shouldCommitPocketBackGesture(event: PocketBackGestureEvent): boolean {
  return event.phase === "end" && event.progress > 0.5;
}

/**
 * Respond to a native back request through the existing Pocket host event lane.
 * The host addresses the request to the currently focused guest and falls back
 * to SystemUI when that guest reports `handled: false`.
 */
export function createPocketBackNavigation(
  host: Pick<HostBridge, "onEvent" | "emit">,
) {
  let disposed = false;
  let handler: PocketBackRequestHandler | undefined;
  let gestureHandler: PocketBackGestureHandler | undefined;
  let gestureReady = false;
  let activeGestureId: string | undefined;
  let lastGesture: PocketBackGestureEvent | undefined;

  const emitGestureResponse = (gestureId: string, handled: boolean): void => {
    try {
      host.emit?.(POCKET_BACK_GESTURE_RESPONSE_EVENT, { gestureId, handled });
    } catch {
      // A disconnected or older host cannot prevent local cleanup.
    }
  };

  const setGestureReady = (ready: boolean): void => {
    if (gestureReady === ready) return;
    gestureReady = ready;
    try {
      host.emit?.(POCKET_BACK_GESTURE_READY_EVENT, { ready });
    } catch {
      // Readiness is advisory to the native recognizer; disposal still succeeds.
    }
  };

  const clearGesture = (notifyCancel: boolean): void => {
    const last = lastGesture;
    activeGestureId = undefined;
    lastGesture = undefined;
    if (!notifyCancel || !last || !gestureHandler) return;
    try {
      gestureHandler({ ...last, phase: "cancel" });
    } catch {
      // Cancellation is best effort and must not strand a native gesture ID.
    }
  };

  const parseGesture = (value: Record<string, unknown>): PocketBackGestureEvent | undefined => {
    const { gestureId, phase, dx, width, velocity, progress } = value;
    if (
      typeof gestureId !== "string" || gestureId.length === 0 ||
      (phase !== "start" && phase !== "update" && phase !== "end" && phase !== "cancel") ||
      typeof dx !== "number" || !Number.isFinite(dx) ||
      typeof width !== "number" || !Number.isFinite(width) || width <= 0 ||
      typeof velocity !== "number" || !Number.isFinite(velocity) ||
      typeof progress !== "number" || !Number.isFinite(progress)
    ) return undefined;
    return { gestureId, phase, dx, width, velocity, progress };
  };

  const receiveGesture = (raw: BridgeObject): void => {
    if (disposed) return;
    if (raw.phase === "start") {
      clearGesture(true);
      const gestureId = typeof raw.gestureId === "string" ? raw.gestureId : "";
      const gesture = parseGesture(raw);
      let handled = false;
      if (gesture && gestureHandler) {
        try {
          handled = gestureHandler(gesture) === true;
        } catch {
          handled = false;
        }
      }
      if (handled && gesture) {
        activeGestureId = gesture.gestureId;
        lastGesture = gesture;
      }
      if (gestureId.length > 0) emitGestureResponse(gestureId, handled);
      return;
    }

    const gesture = parseGesture(raw);
    if (!gesture || gesture.gestureId !== activeGestureId) return;
    lastGesture = gesture;
    try {
      gestureHandler?.(gesture);
    } catch {
      // A failed consumer callback cannot leave this gesture active.
    }
    if (gesture.phase === "end" || gesture.phase === "cancel") clearGesture(false);
  };

  const remove = registerBackParticipant(host, "pages", {
    captureRequest(requestId) {
      clearGesture(true);
      return () => handler?.(requestId) ?? false;
    },
    receiveGesture,
  });

  return {
    setHandler(next: PocketBackRequestHandler | undefined): void {
      if (!disposed) handler = next;
    },
    setGestureHandler(next: PocketBackGestureHandler | undefined): void {
      if (disposed || next === gestureHandler) return;
      clearGesture(true);
      gestureHandler = next;
      setGestureReady(typeof next === "function");
    },
    dispose(): void {
      if (disposed) return;
      clearGesture(true);
      setGestureReady(false);
      disposed = true;
      handler = undefined;
      gestureHandler = undefined;
      remove();
    },
  };
}

export type PocketBackInterceptorHandler = () => boolean | void;

export interface PocketBackInterceptorEntry {
  readonly id: number;
  readonly handler: PocketBackInterceptorHandler;
  readonly isEnabled: () => boolean;
}

export interface PocketBackInterceptorRegistry {
  register(handler: PocketBackInterceptorHandler, isEnabled?: () => boolean): () => void;
  dispatch(): boolean;
  readonly count: Accessor<number>;
}

export function createPocketBackInterceptorRegistry(): PocketBackInterceptorRegistry {
  let nextId = 1;
  const entries: PocketBackInterceptorEntry[] = [];
  const [count, setCount] = createSignal(0);

  return {
    register(handler: PocketBackInterceptorHandler, isEnabled: () => boolean = () => true): () => void {
      const id = nextId++;
      const entry: PocketBackInterceptorEntry = { id, handler, isEnabled };
      entries.push(entry);
      setCount(entries.length);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const idx = entries.findIndex((candidate) => candidate.id === id);
        if (idx >= 0) {
          entries.splice(idx, 1);
          setCount(entries.length);
        }
      };
    },
    dispatch(): boolean {
      const snapshot = entries.slice();
      for (let i = snapshot.length - 1; i >= 0; i -= 1) {
        const entry = snapshot[i]!;
        if (!entries.some((candidate) => candidate.id === entry.id)) continue;
        try {
          if (!entry.isEnabled()) continue;
          if (entry.handler() === true) return true;
        } catch {
          // Ignore errors from individual interceptors and continue LIFO walk.
        }
      }
      return false;
    },
    count,
  };
}

const PocketBackInterceptorContext = createContext<PocketBackInterceptorRegistry | undefined>(undefined);

const PocketBackRouteActiveContext = createContext<Accessor<boolean>>(() => true);

export function PocketBackRouteActiveProvider(props: {
  readonly active: Accessor<boolean>;
  readonly children: JSX.Element;
}): JSX.Element {
  return PocketBackRouteActiveContext.Provider({
    get value() {
      return props.active;
    },
    get children() {
      return props.children;
    },
  });
}

export function PocketBackInterceptorProvider(props: {
  readonly value: PocketBackInterceptorRegistry;
  readonly children: JSX.Element;
}): JSX.Element {
  return PocketBackInterceptorContext.Provider({
    get value() {
      return props.value;
    },
    get children() {
      return props.children;
    },
  });
}

export function usePocketBackHandler(
  handler: PocketBackInterceptorHandler,
  enabled: boolean | Accessor<boolean> = true,
): void {
  const registry = useContext(PocketBackInterceptorContext);
  const routeActive = useContext(PocketBackRouteActiveContext);
  if (!registry) return;
  createEffect(() => {
    const isEnabled = typeof enabled === "function" ? enabled() : enabled;
    if (!isEnabled || !routeActive()) return;
    const unregister = registry.register(
      handler,
      () => routeActive() && (typeof enabled === "function" ? enabled() : enabled),
    );
    onCleanup(unregister);
  });
}
