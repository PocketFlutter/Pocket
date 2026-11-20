import type { BridgeObject, HostBridge } from "./host.ts";

export const POCKET_BACK_REQUEST_EVENT = "platform.back.request";
export const POCKET_BACK_RESPONSE_EVENT = "platform.back.response";
export const POCKET_BACK_GESTURE_EVENT = "platform.back.gesture";

type BackHost = Pick<HostBridge, "onEvent" | "emit">;
type BackAction = () => boolean | Promise<boolean>;

type BackParticipant = {
  captureRequest(requestId: string, deadlineAtMs?: number): BackAction | undefined;
  receiveGesture?(params: BridgeObject): void;
};

type BackLane = {
  pages: Set<BackParticipant>;
  systems: Set<BackParticipant>;
  remove?: () => void;
};

const lanes = new WeakMap<BackHost, BackLane>();

export function registerBackParticipant(
  host: BackHost,
  role: "pages" | "systems",
  participant: BackParticipant,
): () => void {
  let lane = lanes.get(host);
  if (!lane) {
    const created: BackLane = { pages: new Set(), systems: new Set() };
    lane = created;
    lanes.set(host, created);
    created.remove = host.onEvent?.(({ method, params }) => {
      if (lanes.get(host) !== created) return;
      if (method === POCKET_BACK_REQUEST_EVENT) {
        dispatchBackRequest(host, params);
      } else if (method === POCKET_BACK_GESTURE_EVENT) {
        [...created.pages].pop()?.receiveGesture?.(params);
      }
    });
  }
  const participants = lane[role];
  participants.add(participant);
  return () => {
    participants.delete(participant);
    if (lane.pages.size > 0 || lane.systems.size > 0 || lanes.get(host) !== lane) return;
    lanes.delete(host);
    lane.remove?.();
  };
}

export function dispatchBackRequest(host: BackHost, params: unknown): void {
  const lane = lanes.get(host);
  if (!lane) return;
  const { requestId, deadlineAtMs } =
    (params as { requestId?: unknown; deadlineAtMs?: unknown } | null) ?? {};
  if (typeof requestId !== "string" || requestId.length === 0) return;
  const page = [...lane.pages].pop();
  const system = [...lane.systems].pop();
  // Capture the invocation before the page handler can change the stack.
  const fallback = system?.captureRequest(
    requestId,
    typeof deadlineAtMs === "number" && Number.isFinite(deadlineAtMs) ? deadlineAtMs : undefined,
  );
  const action = page?.captureRequest(requestId);
  void Promise.resolve().then(async () => {
    let handled = false;
    if (page && lane.pages.has(page)) {
      try {
        handled = await action?.() === true;
      } catch {
        // A failed page handler declines this request.
      }
    }
    if (!handled && system && lane.systems.has(system)) {
      try {
        handled = await fallback?.() === true;
      } catch {
        // A SystemUI kernel that cannot finish dismissal declines the request.
      }
    }
    if ((page && lane.pages.has(page)) || (system && lane.systems.has(system))) {
      host.emit?.(POCKET_BACK_RESPONSE_EVENT, { requestId, handled });
    }
  }).catch(() => {
    // A disconnected bridge cannot acknowledge the native request.
  });
}
