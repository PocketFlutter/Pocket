import { Index, Show, batch, createEffect, createMemo, createRenderEffect, createSignal, onCleanup } from "solid-js";
import { getOps, mount } from "@pocketjs/framework/solid";
import { Text, View, type NodeMirror } from "@pocketjs/framework/solid/components";
import { after, simulationHz, virtualNow } from "@pocketjs/framework/clock";
import { createGesture } from "@pocketjs/framework/gesture";
import { createDisplayGeometry, EMPTY_DISPLAY_GEOMETRY, pageInsets, SafeAreaScaffold, SkinButton } from "@pocket/ui";
import { createHostBridge, type BridgeObject } from "@pocket/ui/host";
import { encodeNovelMeshEffect, type NovelModelDefinition, type NovelModelMesh, type NovelModelPoint } from "@pocket/vn";
import { createBundledNovelLive2dFactory } from "@pocket/vn/live2d";
import { NovelMeshView } from "@pocket/vn/mesh-view";
import { pocketLive2dUpdateCapability } from "@pocket/live2d";
import assets from "./novel.assets.json";

const host = createHostBridge();
const actions = ["TapBody:0", "TapBody:1"] as const;
type Action = typeof actions[number];
// Durations come from the official Mao motion3 files.
const actionSeconds: Record<Action, number> = { "TapBody:0": 3.47, "TapBody:1": 4.4 };

function MaoStage(props: {
  showRobe: () => boolean;
  placement: () => { x: number; y: number; scale: number };
  offset: () => NovelModelPoint;
  screenPlacement: () => { x: number; y: number; scale: number };
  move: (dx: number, dy: number) => void;
  onStatus: (message: string) => void;
  command: () => { motion?: Action };
}) {
  const model = assets.models.mao as NovelModelDefinition;
  const resting = { key: "mao", animation: "Idle:0" };
  const createModel = createBundledNovelLive2dFactory({
    request(capability, params) {
      if (capability !== pocketLive2dUpdateCapability) return host.request(capability, params as BridgeObject);
      const parts = params.partOpacities as readonly { id: string; value: number }[];
      return host.request(capability, {
        ...params as BridgeObject,
        partOpacities: [
          ...parts.filter(part => part.id !== "PartRobe"),
          { id: "PartRobe", value: props.showRobe() ? 1 : 0 },
        ],
      });
    },
  });
  const [frame, setFrame] = createSignal<readonly NovelModelMesh[]>([]);
  const [frameVersion, setFrameVersion] = createSignal(0);
  const [nodeVersion, setNodeVersion] = createSignal(0);
  const nodeIds: number[] = [];
  const effects = new Map<number, Uint8Array>();
  let stage: NodeMirror | undefined;
  let instance: Awaited<ReturnType<typeof createModel>> | undefined;
  let stopped = false;
  let cancelTick: (() => void) | undefined;
  let frameInFlight = false;
  let contactId: number | undefined;
  let dragStarted = false;
  let motionSecondsLeft = 0;
  const fail = (cause: unknown) => {
    if (stopped) return;
    console.error("Mao model failed", cause);
    stop();
    setFrame([]);
    props.onStatus("角色加载失败");
  };
  function stop() {
    stopped = true;
    cancelTick?.();
    instance?.dispose();
    instance = undefined;
  }
  let lastFrame = virtualNow();
  function scheduleFrame() {
    if (stopped || dragStarted || !instance || frameInFlight || cancelTick) return;
    cancelTick = after(1 / simulationHz(), () => {
      cancelTick = undefined;
      nextFrame();
    });
  }
  function nextFrame() {
    if (stopped || dragStarted || !instance || frameInFlight) return;
    const now = virtualNow();
    const delta = Math.min(250, (now - lastFrame) * 1000);
    lastFrame = now;
    if (motionSecondsLeft > 0) {
      motionSecondsLeft = Math.max(0, motionSecondsLeft - delta / 1000);
      if (motionSecondsLeft === 0) {
        instance.setIntent(resting);
        props.onStatus("点我打招呼，拖动我换个位置。");
      }
    }
    frameInFlight = true;
    Promise.resolve(instance.advance(delta)).then(meshes => {
      if (stopped || dragStarted) return;
      batch(() => {
        setFrame(meshes);
        setFrameVersion(value => value + 1);
      });
    }).catch(fail).finally(() => {
      frameInFlight = false;
      scheduleFrame();
    });
  }

  const applyCommand = () => {
    const motion = props.command().motion;
    motionSecondsLeft = 0;
    if (!instance || stopped) return;
    try {
      instance.setIntent(resting);
      if (motion) {
        instance.setIntent({ key: resting.key, animation: motion, loop: false });
        motionSecondsLeft = actionSeconds[motion];
      }
    } catch (cause) { fail(cause); }
  };
  createEffect(applyCommand);
  Promise.resolve(createModel(model, resting)).then(value => {
    if (stopped) { value.dispose(); return; }
    instance = value;
    lastFrame = virtualNow();
    applyCommand();
    props.onStatus("点我打招呼，拖动我换个位置。");
    nextFrame();
  }).catch(fail);

  const localPoint = (point: NovelModelPoint) => {
    const placement = props.screenPlacement();
    return { x: (point.x - placement.x) / placement.scale, y: (point.y - placement.y) / placement.scale };
  };
  const clearGesture = () => {
    contactId = undefined;
    if (!dragStarted) return;
    dragStarted = false;
    lastFrame = virtualNow();
    scheduleFrame();
  };
  const gesture = createGesture({
    region: { node: () => stage },
    axis: "any",
    onDown(contact) {
      if (contactId !== undefined) {
        if (contact.id !== contactId) { clearGesture(); gesture.cancel(); }
        return;
      }
      if (instance?.hitTest?.(localPoint(contact))) contactId = contact.id;
    },
    onTap(contact) {
      if (contact.id !== contactId) return;
      if (instance?.tap?.(localPoint(contact))) props.onStatus("你好呀，今天见到你真开心！");
      clearGesture();
    },
    onPanMove(contact) {
      if (contact.id !== contactId) return;
      if (dragStarted) {
        if (contact.fdx === 0 && contact.fdy === 0) return;
        props.move(contact.fdx, contact.fdy);
      } else {
        // Include the initial motion below the recognizer's pan threshold.
        dragStarted = true;
        cancelTick?.();
        cancelTick = undefined;
        props.move(contact.dx, contact.dy);
        props.onStatus("我跟着你的手指走。");
      }
    },
    onPanEnd(contact) {
      if (contact.id !== contactId) return;
      clearGesture();
      props.onStatus("这里也不错。");
    },
    onCancel(contact) { if (contact.id === contactId) clearGesture(); },
  });
  onCleanup(stop);

  const nodesReady = createMemo(() => {
    nodeVersion();
    return frame().every((_, index) => nodeIds[index] !== undefined);
  });
  const rendered = <View
    class="absolute w-[240] h-[350]"
    style={{ insetL: props.placement().x, insetT: props.placement().y, translateX: props.offset().x, translateY: props.offset().y }}>
    <View ref={node => { stage = node; }} debugName="mao-character" class="absolute inset-0 w-full h-full"
      style={{ scale: props.placement().scale, originX: -0.5, originY: -0.5 }}>
      <Index each={frame()}>{(mesh, index) => <NovelMeshView
        src={mesh().texture}
        geometry={mesh().geometry}
        version={frameVersion()}
        onNode={id => { nodeIds[index] = id; setNodeVersion(value => value + 1); }}
        class="absolute inset-0 w-full h-full"
        style={{ opacity: nodesReady() && mesh().visible !== false ? 1 : 0 }}
      />}</Index>
    </View>
  </View>;
  createRenderEffect(() => {
    const meshes = frame();
    if (!nodesReady()) return;
    const ops = getOps() as ReturnType<typeof getOps> & { setMeshEffect?(id: number, bytes: Uint8Array): boolean };
    const masks = new Map(meshes.map((mesh, index) => [mesh.id, nodeIds[index]!]));
    try {
      for (const [index, mesh] of meshes.entries()) {
        if (!mesh.effect) continue;
        const node = nodeIds[index]!;
        // The official Mao export repeats one ArtMesh in its mask union.
        const effect = { ...mesh.effect, masks: [...new Set(mesh.effect.masks)] };
        const payload = encodeNovelMeshEffect(effect, id => {
          const mask = masks.get(id);
          if (mask === undefined) throw new Error(`Missing Mao mask ${id}`);
          return mask;
        });
        const previous = effects.get(node);
        if (previous?.length === payload.length && payload.every((byte, offset) => byte === previous[offset])) continue;
        if (!ops.setMeshEffect?.(node, payload)) throw new Error("Pocket refused Mao mesh compositing");
        effects.set(node, payload);
      }
    } catch (cause) { fail(cause); }
  });
  return rendered;
}

function App() {
  const geometry = createDisplayGeometry({ fallback: { ...EMPTY_DISPLAY_GEOMETRY, width: 360, height: 640 } });
  const [showRobe, setShowRobe] = createSignal(true);
  const [visible, setVisible] = createSignal(true);
  const [status, setStatus] = createSignal("Mao 正在准备中…");
  const [offset, setOffset] = createSignal({ x: 0, y: 0 });
  const [command, setCommand] = createSignal<{ motion?: Action }>({});
  let nextAction = 0;
  const insets = () => pageInsets(geometry());
  const usable = () => ({
    width: geometry().width - insets().left - insets().right,
    height: geometry().height - insets().top - insets().bottom,
  });
  const placement = () => {
    const { width, height } = usable();
    const scale = Math.max(0.25, Math.min(1.25, (width - 36) / 240, (height - 200) / 350));
    return {
      x: (width - 240 * scale) / 2,
      y: 100 + Math.max(0, (height - 200 - 350 * scale) / 2),
      scale,
    };
  };
  const screenPlacement = () => {
    const base = placement();
    const delta = offset();
    return { ...base, x: base.x + insets().left + delta.x, y: base.y + insets().top + delta.y };
  };
  const move = (dx: number, dy: number) => {
    const limitX = Math.max(24, usable().width * 0.28);
    const limitY = Math.max(20, (usable().height - 320) / 3);
    setOffset(current => {
      const x = Math.max(-limitX, Math.min(limitX, current.x + dx));
      const y = Math.max(-limitY, Math.min(limitY, current.y + dy));
      return x === current.x && y === current.y ? current : { x, y };
    });
  };
  const toggle = () => {
    if (visible()) { setVisible(false); setCommand({}); setStatus("Mao 躲起来了。"); }
    else { setStatus("Mao 正在准备中…"); setVisible(true); }
  };
  return <SafeAreaScaffold geometry={geometry} reservedActions="mini-app" class="w-full h-full bg-[#F9F3EF]">
    <View class="relative w-full h-full overflow-hidden bg-[#F9F3EF]">
      <View class="absolute top-[12] left-[24] flex-col">
        <Text class="text-4xl font-bold text-[#301F2A]">看板娘</Text>
        <Text class="mt-1 text-sm text-[#7A4F5D]">{showRobe() ? "Mao · 披风" : "Mao · 连帽衫"}</Text>
      </View>
      <View class="absolute w-[208] h-[208] rounded-full bg-[#F5DEE0]" style={{ insetL: (usable().width - 208) / 2, insetT: Math.max(100, usable().height * 0.30), hitPass: 1 }} />
      <Show when={visible()}>
        <MaoStage showRobe={showRobe} placement={placement} offset={offset} screenPlacement={screenPlacement} move={move} onStatus={setStatus} command={command} />
      </Show>
      <View class="absolute bottom-[10] left-[20] right-[20] flex-col items-center gap-2 rounded-[20] bg-[#FFFDFC] p-3">
        <Text class="text-center text-sm text-[#563841]">{status()}</Text>
        <View class="flex-row justify-center gap-2">
          <SkinButton label="动作" compact variant="primary" disabled={!visible()} onPress={() => {
            setCommand({ motion: actions[nextAction]! });
            nextAction = (nextAction + 1) % actions.length;
            setStatus("给你表演一个动作！");
          }} />
          <SkinButton label="换装" compact variant="secondary" onPress={() => setShowRobe(value => !value)} />
          <SkinButton label={visible() ? "隐藏" : "显示"} compact variant="secondary" onPress={toggle} />
          <SkinButton label="复位" compact variant="outline" onPress={() => {
            setOffset({ x: 0, y: 0 });
            setCommand({});
            if (visible()) setStatus("我回到原来的位置啦。");
          }} />
        </View>
        <Text class="text-center text-xs text-[#775562]">Live2D Inc. 官方样例</Text>
      </View>
    </View>
  </SafeAreaScaffold>;
}

mount(App);
