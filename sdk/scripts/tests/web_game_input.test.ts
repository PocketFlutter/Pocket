import { expect, test } from "bun:test";
import { BrowserGameInput, BTN } from "../../targets/web/game_input.js";
import { BTN as OFFICIAL_BTN } from "../../.cache/pocketjs/contracts/spec/spec.ts";

class Surface extends EventTarget {
  tabIndex = -1;
  attributes = new Map<string, string>();
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); this.tabIndex = -1; }
}
function setup() {
  const canvas = new Surface();
  const environment = new EventTarget() as any;
  const callbacks = new Map<number, () => void>();
  let id = 0;
  const pads: any[] = [];
  environment.document = { activeElement: canvas, hasFocus: () => true };
  environment.navigator = { getGamepads: () => pads };
  environment.requestAnimationFrame = (callback: () => void) => { callbacks.set(++id, callback); return id; };
  environment.cancelAnimationFrame = (id: number) => callbacks.delete(id);
  const changes: any[] = [];
  const input = new BrowserGameInput({ canvas, environment, onChange: (state: any) => changes.push(state) });
  const key = (type: string, code: string, target: EventTarget = canvas, extra = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { code, ...extra });
    target.dispatchEvent(event); return event;
  };
  const tick = () => { const current = [...callbacks.values()]; callbacks.clear(); for (const callback of current) callback(); };
  return { canvas, environment, callbacks, pads, changes, input, key, tick };
}

test("keyboard facts preserve official bits, aliases, release and focus ownership", () => {
  expect(BTN).toEqual(OFFICIAL_BTN);
  const { input, canvas, environment, changes, key } = setup();
  expect(key("keydown", "KeyZ").defaultPrevented).toBe(false);
  input.setActive(true);
  key("keydown", "KeyZ"); key("keydown", "Space");
  expect(input.state().buttons).toBe(BTN.CROSS);
  expect(changes).toHaveLength(1); // repeat/aliases do not synthesize new edges
  key("keyup", "KeyZ", environment);
  expect(input.state().buttons).toBe(BTN.CROSS);
  key("keyup", "Space", environment);
  expect(input.state().buttons).toBe(0);
  expect(key("keydown", "KeyZ", canvas, { isComposing: true }).defaultPrevented).toBe(false);
  expect(key("keydown", "KeyZ", canvas, { ctrlKey: true }).defaultPrevented).toBe(false);
  key("keydown", "ArrowDown"); canvas.dispatchEvent(new Event("blur"));
  expect(input.state().buttons).toBe(0);
  environment.document.activeElement = {};
  key("keydown", "KeyZ"); expect(input.state().buttons).toBe(0);
  input.dispose();
  expect(canvas.tabIndex).toBe(-1);
});

test("standard controller axes, deadzone, disconnect and visibility release use one device fact stream", () => {
  const { input, pads, environment, callbacks, key, tick } = setup();
  pads.push({ connected: true, mapping: "standard", axes: [-1, 1, 0.1, -0.1],
    buttons: Array.from({ length: 16 }, (_, index) => ({ pressed: index === 0 || index === 15 })) });
  input.setActive(true);
  expect(input.state()).toEqual({ buttons: BTN.CROSS | BTN.RIGHT, analog: 0x00ff, rightAnalog: 0x8080 });
  expect(callbacks.size).toBe(1);
  key("keydown", "ArrowLeft");
  pads[0].connected = false; tick();
  expect(input.state()).toEqual({ buttons: BTN.LEFT, analog: 0x8080, rightAnalog: 0x8080 });
  expect(callbacks.size).toBe(0);
  input.setActive(false);
  expect(input.state().buttons).toBe(0);
  input.dispose();
  environment.dispatchEvent(new Event("gamepadconnected"));
  expect(callbacks.size).toBe(0);
});

test("unknown controller mappings are not advertised through fabricated standard axes", () => {
  const { input, pads, callbacks } = setup();
  pads.push({ connected: true, mapping: "", axes: [1, 1], buttons: [{ pressed: true }] });
  input.setActive(true);
  expect(input.state()).toEqual({ buttons: 0, analog: 0x8080, rightAnalog: 0x8080 });
  expect(callbacks.size).toBe(0);
  input.dispose();
});

test("opt-in Web moves coalesce per frame and flush before release and cancel", async () => {
  const { PocketWebRuntime } = await import("../../targets/web/browser_runtime.js");
  const pending = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const browser = {
    document: { baseURI: "http://localhost/" },
    requestAnimationFrame(callback: FrameRequestCallback) { pending.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(frame: number) { pending.delete(frame); },
  };
  const previous = Object.keys(browser).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, browser);
  const runtimes: InstanceType<typeof PocketWebRuntime>[] = [];
  try {
    function setupRuntime(gpuMesh?: boolean) {
      const canvas = Object.assign(new Surface(), {
        getContext: () => ({}),
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 100 }),
        clientWidth: 200,
        clientHeight: 300,
      });
      const runtime = new PocketWebRuntime({
        canvas, engineUrl: "/engine.wasm",
        config: gpuMesh ? { live2d: { gpuMesh, coreUrl: "/core.js", assets: {} } } : {},
      });
      runtimes.push(runtime);
      const frames: unknown[][] = [];
      runtime.host.inputFrame = (contacts) => { frames.push(contacts); };
      runtime.show();
      function pointer(type: string, x: number, y: number) {
        const event = Object.assign(new Event(type, { cancelable: true }), {
          pointerId: 7, clientX: x, clientY: y,
        });
        runtime.pointer(event);
        expect(event.defaultPrevented).toBe(true);
      }
      return { runtime, frames, pointer };
    }
    const contact = (x: number, y: number, cancelled = false) =>
      [{ surface: 0, id: 7, x, y, cancelled }];

    const optedIn = setupRuntime(true);
    optedIn.pointer("pointerdown", 11, 21);
    optedIn.pointer("pointermove", 12, 22);
    optedIn.pointer("pointermove", 13, 23);
    expect(optedIn.frames).toEqual([contact(2, 3)]);
    expect(pending.size).toBe(1);
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback(16);
    expect(optedIn.frames).toEqual([contact(2, 3), contact(6, 9)]);

    optedIn.pointer("pointermove", 14, 24);
    optedIn.pointer("pointerup", 15, 25);
    expect(optedIn.frames.slice(-2)).toEqual([contact(8, 12), []]);

    optedIn.pointer("pointerdown", 11, 21);
    optedIn.pointer("pointermove", 16, 26);
    optedIn.pointer("pointercancel", 17, 27);
    expect(optedIn.frames.slice(-2)).toEqual([contact(12, 18), contact(14, 21, true)]);
    expect(pending.size).toBe(0);

    optedIn.pointer("pointerdown", 11, 21);
    optedIn.pointer("pointermove", 18, 28);
    optedIn.runtime.hide();
    expect(pending.size).toBe(0);
    expect(optedIn.frames.at(-1)).toEqual(contact(2, 3));
    optedIn.runtime.show();
    optedIn.pointer("pointermove", 19, 29);
    expect(pending.size).toBe(1);
    await optedIn.runtime.dispose();
    expect(pending.size).toBe(0);
    expect(optedIn.frames.at(-1)).toEqual(contact(2, 3));

    const standard = setupRuntime();
    standard.pointer("pointerdown", 11, 21);
    standard.pointer("pointermove", 12, 22);
    standard.pointer("pointermove", 13, 23);
    expect(standard.frames).toEqual([contact(2, 3), contact(4, 6), contact(6, 9)]);
    expect(pending.size).toBe(0);
  } finally {
    try {
      await Promise.all(runtimes.map(runtime => runtime.dispose()));
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});
