import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";

import { buildGuest } from "../../../scripts/build_guest.ts";
import { resolveNativeProbePath } from "../../../scripts/native_probe_path.ts";
import { SYSTEM_PRESETS_EVENT, type JsonObject } from "../src/host.ts";
import { ACCESSIBILITY_PREFERENCES_EVENT } from "../src/accessibility.ts";
import { POCKET_BACK_REQUEST_EVENT, POCKET_BACK_RESPONSE_EVENT } from "../src/back-navigation.ts";

const sdkRoot = resolve(import.meta.dir, "../../..");
const testTimeoutMs = 120_000;

type FrameEvent = { name?: string; payload?: JsonObject };
type FrameOp = {
  type?: string;
  id?: string;
  text?: string;
  color?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};
type Frame = { events?: FrameEvent[]; ops?: FrameOp[]; width?: number; height?: number };
type ProbeResponse = { ok?: boolean; error?: string; frame?: Frame };

function probeEvent(name: string, payload: JsonObject = {}): JsonObject {
  return { op: "send", message: { type: "event", name, payload } };
}

function frames(count: number, deltaMs = 16): JsonObject[] {
  return Array.from({ length: count }, () => ({ op: "frame", deltaMs }));
}

function runProbeCommands(probe: string, commands: JsonObject[]): Frame[] {
  const result = spawnSync(probe, {
    input: `${commands.map((cmd) => JSON.stringify(cmd)).join("\n")}\n`,
    encoding: "utf8",
    timeout: testTimeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`,
  );
  const lines = String(result.stdout ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const responses = lines.map((line) => JSON.parse(line) as ProbeResponse);
  for (const response of responses) {
    assert.notEqual(response.ok, false, response.error);
  }
  return responses.flatMap((response) => (response.frame ? [response.frame] : []));
}

test(
  "Skin-independent PocketAppShell + UiSkinProvider + route/app lifecycle + retained-route Back isolation + host presets/a11y/SystemUI sync + SkinToast auto-dismiss run in native pocket_probe",
  async () => {
    const probe = resolveNativeProbePath(sdkRoot);
    const projectDir = mkdtempSync(join(tmpdir(), "pocket-ui-skin-lifecycle-"));

    try {
      writeFileSync(
        join(projectDir, "package.json"),
        JSON.stringify({
          name: "skin-lifecycle-native",
          private: true,
          type: "module",
          dependencies: {
            "@pocket/ui": `file:${join(sdkRoot, "packages/pocket_ui")}`,
            "@pocket/looseleaf": `file:${join(sdkRoot, "packages/pocket_looseleaf")}`,
            "@pocket/arc": `file:${join(sdkRoot, "packages/pocket_arc")}`,
            "@pocket/liquid_glass": `file:${join(sdkRoot, "packages/pocket_liquid_glass")}`,
          },
        }),
      );
      writeFileSync(
        join(projectDir, "pocket.json"),
        JSON.stringify({
          pocket: 2,
          id: "dev.pocket.ui.skin-lifecycle-native",
          app: {
            entry: "app.tsx",
            framework: "solid",
            viewport: { fixed: { logical: [390, 844], presentation: "native" } },
          },
        }),
      );
      writeFileSync(
        join(projectDir, "manifest.json"),
        JSON.stringify({ capabilities: { requires: [] } }),
      );
      writeFileSync(
        join(projectDir, "app.tsx"),
        `
import { createEffect, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { View } from "@pocketjs/framework/solid/components";
import {
  PocketAppShell,
  SkinButton,
  SkinCard,
  SkinDialog,
  SkinParagraph,
  SkinToast,
  UiSkinProvider,
  createPocketRouter,
  defaultSkinAdapter,
  defineUiSkin,
  parseArgbHexColor,
  subscribeHostEvents,
  usePocketAppLifecycle,
  usePocketRouteLifecycle,
  useUiSkin,
  type UiSkinId,
} from "@pocket/ui";
import { looseleafSkinAdapter } from "@pocket/looseleaf";
import { arcSkinAdapter } from "@pocket/arc";
import { liquidGlassSkinAdapter } from "@pocket/liquid_glass";

const pocketGlobal = globalThis as typeof globalThis & {
  pocket?: { _emitValue?: (packet: Record<string, unknown>) => boolean };
};

const emitTelemetry = (kind: string, data: Record<string, unknown> = {}): void => {
  pocketGlobal.pocket?._emitValue?.({
    type: "event",
    name: "fixture.telemetry",
    payload: { kind, ...data },
  });
};

const customSkin = defineUiSkin({
  id: "custom",
  label: "Custom",
  motion: {
    routeTransition: "PORTAL_EXPAND",
    routeTransitionDurationMs: 180,
  },
  resolveTokens: (_mode, _accent, base) => ({
    ...base,
    canvasBg: "#112233",
    accentBg: "#334455",
  }),
});

const router = createPocketRouter({
  routes: [
    { id: "home", path: "/home", primary: true },
    { id: "detail", path: "/detail", parent: "home" },
  ],
  initialUrl: "/home",
});

let homeMounts = 0;
let detailMounts = 0;
const lifecycleLog: string[] = [];

const [skinOverride, setSkinOverride] = createSignal<UiSkinId | undefined>("default");
const [homeCount, setHomeCount] = createSignal(0);
const [homeDialogOpen, setHomeDialogOpen] = createSignal(false);
const [toastOpen, setToastOpen] = createSignal(false);
const [toastDismissCount, setToastDismissCount] = createSignal(0);

function HomeScreen() {
  homeMounts += 1;
  const skin = useUiSkin();
  createEffect(() => {
    const tokens = skin.tokens();
    emitTelemetry("skinTokens", {
      skinId: skin.skinId(),
      mode: skin.mode(),
      accent: skin.accent(),
      canvasBg: tokens.canvasBg,
      navColor: parseArgbHexColor(tokens.canvasBg),
    });
  });
  usePocketRouteLifecycle({
    onEnter: () => {
      lifecycleLog.push("home.onEnter");
    },
    onLeave: () => {
      lifecycleLog.push("home.onLeave");
    },
    onForeground: () => {
      lifecycleLog.push("home.onForeground");
    },
    onBackground: () => {
      lifecycleLog.push("home.onBackground");
    },
  });

  usePocketAppLifecycle({
    onAppear: (e) => {
      lifecycleLog.push(\`app.onAppear:\${e.state}\`);
    },
    onResume: (e) => {
      lifecycleLog.push(\`app.onResume:\${e.state}\`);
    },
    onForeground: (e) => {
      lifecycleLog.push(\`app.onForeground:\${e.state}\`);
    },
    onBackground: (e) => {
      lifecycleLog.push(\`app.onBackground:\${e.state}\`);
    },
    onUnload: (e) => {
      lifecycleLog.push(\`app.onUnload:\${e.state}\`);
    },
  });

  subscribeHostEvents((event) => {
    if (event.method === "fixture.openDetail") {
      router.navigate("detail");
    } else if (event.method === "fixture.goHome") {
      router.back();
    } else if (event.method === "fixture.incrementHome") {
      setHomeCount((c) => c + 1);
    } else if (event.method === "fixture.openHomeDialog") {
      setHomeDialogOpen(event.params.open !== false);
    } else if (event.method === "fixture.switchSkin") {
      const next = event.params.skin;
      setSkinOverride(typeof next === "string" && next.length > 0 ? (next as UiSkinId) : undefined);
    } else if (event.method === "fixture.openToast") {
      setToastOpen(true);
    } else if (event.method === "fixture.snapshot") {
      emitTelemetry("snapshot", {
        tag: typeof event.params.tag === "string" ? event.params.tag : "",
        route: router.current().routeId,
        skinId: skin.skinId(),
        mode: skin.mode(),
        accent: skin.accent(),
        density: skin.density(),
        reducedMotion: skin.reducedMotion(),
        motion: skin.motion(),
        canvasBg: skin.tokens().canvasBg,
        navColor: parseArgbHexColor(skin.tokens().canvasBg),
        dark: skin.tokens().dark,
        homeMounts,
        detailMounts,
        homeCount: homeCount(),
        homeDialogOpen: homeDialogOpen(),
        toastOpen: toastOpen(),
        toastDismissCount: toastDismissCount(),
        lifecycleLog: [...lifecycleLog],
      });
    }
  });

  return (
    <View class="flex-col gap-2 p-4 w-full">
      <SkinCard title="HomeCard" subtitle={\`Skin:\${skin.skinId()}\`}>
        <SkinParagraph text={\`HomeCount:\${homeCount()}\`} />
        <SkinButton label="IncHomeBtn" onPress={() => setHomeCount((c) => c + 1)} />
      </SkinCard>
      <SkinDialog
        open={homeDialogOpen()}
        title="HomeDialogTitle"
        body="Dialog on Home route"
        onClose={() => {
          setHomeDialogOpen(false);
          lifecycleLog.push("home.dialogClosed");
        }}
      />
      <SkinToast
        open={toastOpen()}
        title="SavedToast"
        durationMs={200}
        onDismiss={() => {
          setToastOpen(false);
          setToastDismissCount((c) => c + 1);
          emitTelemetry("toastDismissed", { skinId: skin.skinId(), count: toastDismissCount() });
        }}
      />
    </View>
  );
}

function DetailScreen() {
  detailMounts += 1;
  const skin = useUiSkin();
  usePocketRouteLifecycle({
    onEnter: () => {
      lifecycleLog.push("detail.onEnter");
    },
    onLeave: () => {
      lifecycleLog.push("detail.onLeave");
    },
    onForeground: () => {
      lifecycleLog.push("detail.onForeground");
    },
    onBackground: () => {
      lifecycleLog.push("detail.onBackground");
    },
  });

  return (
    <View class="flex-col gap-2 p-4 w-full">
      <SkinCard title="DetailCard" subtitle={\`DetailSkin:\${skin.skinId()}\`}>
        <SkinParagraph text="DetailRouteBody" />
      </SkinCard>
    </View>
  );
}

function GuestApp() {
  return (
    <UiSkinProvider
      skin={skinOverride()}
      skins={[
        defaultSkinAdapter,
        looseleafSkinAdapter,
        arcSkinAdapter,
        liquidGlassSkinAdapter,
        customSkin,
      ]}
    >
      <PocketAppShell
        router={router}
        routes={[
          { id: "home", title: "HomeTitle", render: () => <HomeScreen /> },
          { id: "detail", title: "DetailTitle", render: () => <DetailScreen /> },
        ]}
      />
    </UiSkinProvider>
  );
}

mount(() => <GuestApp />);
`,
      );

      const built = await buildGuest({
        projectRoot: projectDir,
        outDir: join(projectDir, "out"),
      });

      const allFrames = runProbeCommands(probe, [
        { op: "create", width: 390, height: 844 },
        { op: "loadBytecode", bytecodePath: built.bytecode, pakPath: built.pak },
        ...frames(2),

        // 1. Increment home counter twice -> homeCount = 2, then open toast on default skin
        probeEvent("fixture.incrementHome"),
        probeEvent("fixture.incrementHome"),
        probeEvent("fixture.openToast"),
        ...frames(1),
        probeEvent("fixture.snapshot", { tag: "toast-opened-default" }),
        // Advance 16 frames (~256ms > 200ms) so toast auto-dismisses
        ...frames(16),
        probeEvent("fixture.snapshot", { tag: "toast-dismissed-default" }),

        // 2. Navigate home -> detail, capture mid-transition frame, then settle and switch across looseleaf, arc, liquid-glass, custom
        probeEvent("fixture.openDetail"),
        ...frames(2),
        probeEvent("fixture.snapshot", { tag: "mid-push-to-detail" }),
        ...frames(18),
        probeEvent("fixture.switchSkin", { skin: "looseleaf" }),
        ...frames(2),
        probeEvent("fixture.switchSkin", { skin: "arc" }),
        ...frames(2),
        probeEvent("fixture.switchSkin", { skin: "liquid-glass" }),
        ...frames(2),
        probeEvent("fixture.switchSkin", { skin: "custom" }),
        ...frames(2),
        probeEvent("fixture.snapshot", { tag: "on-detail-after-skin-switches" }),

        // 3. App lifecycle while on detail: onDidAppear, onWillDisappear, frozenInStack, onResume
        probeEvent("platform.lifecycle", { state: "onDidAppear" }),
        ...frames(1),
        probeEvent("platform.lifecycle", { state: "onWillDisappear" }),
        ...frames(1),
        probeEvent("platform.lifecycle", { state: "frozenInStack", frozenInStack: true }),
        ...frames(1),
        probeEvent("platform.lifecycle", { state: "onResume" }),
        ...frames(1),
        probeEvent("fixture.snapshot", { tag: "after-detail-lifecycle" }),

        // 4. Pop detail -> home, open HomeDialog, push detail, test retained-route Back isolation & reverse exit animation
        probeEvent("fixture.goHome"),
        ...frames(18),
        probeEvent("fixture.openHomeDialog", { open: true }),
        ...frames(2),
        probeEvent("fixture.openDetail"),
        ...frames(18),
        probeEvent("fixture.switchSkin", { skin: "arc" }),
        ...frames(2),
        probeEvent("fixture.snapshot", { tag: "detail-with-home-dialog-open-arc" }),
        probeEvent("fixture.switchSkin", { skin: "liquid-glass" }),
        ...frames(2),
        probeEvent("fixture.snapshot", { tag: "detail-with-home-dialog-open-glass" }),
        probeEvent("fixture.switchSkin", { skin: "custom" }),
        ...frames(2),
        probeEvent("fixture.snapshot", { tag: "detail-with-home-dialog-open" }),

        // First Back request on detail pops detail -> home (capture intermediate reverse exit frame, then settle)
        probeEvent(POCKET_BACK_REQUEST_EVENT, { requestId: "back-1" }),
        ...frames(2),
        probeEvent("fixture.snapshot", { tag: "mid-pop-to-home" }),
        ...frames(18),
        probeEvent("fixture.snapshot", { tag: "after-first-back" }),

        // Second Back request on home closes home's SkinDialog
        probeEvent(POCKET_BACK_REQUEST_EVENT, { requestId: "back-2" }),
        ...frames(2),
        probeEvent("fixture.snapshot", { tag: "after-second-back" }),

        // 5. Clear explicit skin override so root UiSkinProvider inherits platform.presets & accessibility.preferences
        probeEvent("fixture.switchSkin", { skin: "" }),
        ...frames(1),
        probeEvent(SYSTEM_PRESETS_EVENT, {
          darkMode: true,
          accentColor: "teal",
          density: "desktop",
          skin: "arc",
        }),
        probeEvent(ACCESSIBILITY_PREFERENCES_EVENT, {
          reduceMotion: true,
        }),
        ...frames(2),
        probeEvent("fixture.snapshot", { tag: "inherited-presets-arc-dark" }),
        ...frames(1),

        // Trigger onResume to verify createPocketSystemUiSync forces a re-sync
        probeEvent("platform.lifecycle", { state: "onResume" }),
        ...frames(2),

        // Reset preset skin back to "default" and verify toast auto-dismiss under inherited preset
        probeEvent(SYSTEM_PRESETS_EVENT, {
          skin: "default",
        }),
        ...frames(2),
        probeEvent("fixture.openToast"),
        ...frames(16),
        probeEvent("fixture.snapshot", { tag: "inherited-presets-reset-default" }),
        ...frames(2),

        { op: "quit" },
      ]);

      const emittedEvents = allFrames.flatMap((f) => f.events ?? []);
      const snapshots = new Map<string, JsonObject>();
      const snapshotFrames = new Map<string, Frame>();
      const skinTokenLogs: JsonObject[] = [];
      for (const frame of allFrames) {
        for (const ev of frame.events ?? []) {
          if (ev.name === "fixture.telemetry" && ev.payload?.kind === "snapshot") {
            const tag = String(ev.payload.tag ?? "");
            snapshots.set(tag, ev.payload);
            snapshotFrames.set(tag, frame);
          } else if (ev.name === "fixture.telemetry" && ev.payload?.kind === "skinTokens") {
            skinTokenLogs.push(ev.payload);
          }
        }
      }

      const findTextOp = (frame: Frame | undefined, text: string): FrameOp | undefined =>
        (frame?.ops ?? []).find((op) => typeof op.text === "string" && op.text.includes(text));

      // Assertion 0: Kernel route transition animation on push (home -> detail) and reverse pop (detail -> home)
      const midPushFrame = snapshotFrames.get("mid-push-to-detail");
      const settledDetailFrame = snapshotFrames.get("on-detail-after-skin-switches");
      assert.ok(midPushFrame && settledDetailFrame, "must capture mid-push and settled detail frames");
      const midPushDetailBody = findTextOp(midPushFrame, "DetailRouteBody");
      const settledDetailBody = findTextOp(settledDetailFrame, "DetailRouteBody");
      assert.ok(midPushDetailBody && settledDetailBody, "DetailRouteBody must be painted during and after push");
      assert.ok(
        (midPushDetailBody.x ?? 0) > (settledDetailBody.x ?? 0),
        `detail route must slide in from the right during push transition (mid x=${String(midPushDetailBody.x)}, settled x=${String(settledDetailBody.x)})`,
      );

      const midPopFrame = snapshotFrames.get("mid-pop-to-home");
      const settledAfterFirstBackFrame = snapshotFrames.get("after-first-back");
      assert.ok(midPopFrame && settledAfterFirstBackFrame, "must capture mid-pop and settled-home frames");
      assert.ok(
        findTextOp(midPopFrame, "DetailRouteBody") !== undefined,
        "DetailRouteBody must stay painted on top during reverse pop transition",
      );
      assert.equal(
        findTextOp(settledAfterFirstBackFrame, "DetailRouteBody"),
        undefined,
        "DetailRouteBody must be removed from painted text ops once reverse pop transition settles",
      );

      // Assertion 5: SkinToast auto-dismisses after ~200ms without hanging
      const toastOpenedSnap = snapshots.get("toast-opened-default");
      const toastDismissedSnap = snapshots.get("toast-dismissed-default");
      assert.ok(toastOpenedSnap && toastDismissedSnap, "must capture toast snapshots");
      assert.equal(toastOpenedSnap.toastOpen, true, "toast must be open right after fixture.openToast");
      assert.equal(
        toastDismissedSnap.toastOpen,
        false,
        "toast must auto-dismiss after ~200ms (16 frames at 16ms)",
      );
      assert.equal(toastDismissedSnap.toastDismissCount, 1);

      // Assertion 1: Switching skins dynamically NEVER re-runs home or detail render() mount count and preserves state
      const detailSkinsSnap = snapshots.get("on-detail-after-skin-switches");
      assert.ok(detailSkinsSnap, "must capture on-detail-after-skin-switches snapshot");
      assert.equal(detailSkinsSnap.route, "detail");
      assert.equal(detailSkinsSnap.skinId, "custom");
      assert.equal(detailSkinsSnap.navColor, 0xff112233);
      assert.deepEqual(detailSkinsSnap.motion, {
        routeTransition: "PORTAL_EXPAND",
        routeTransitionDurationMs: 180,
      });
      assert.equal(
        detailSkinsSnap.homeMounts,
        1,
        "switching across all 5 skins must never re-mount HomeScreen",
      );
      assert.equal(
        detailSkinsSnap.detailMounts,
        1,
        "switching across all 5 skins must never re-mount DetailScreen",
      );
      assert.equal(
        detailSkinsSnap.homeCount,
        2,
        "HomeScreen counter state must remain intact while inactive and across skin switches",
      );

      // Assertion 2: usePocketRouteLifecycle & usePocketAppLifecycle isolation
      const lifecycleSnap = snapshots.get("after-detail-lifecycle");
      assert.ok(lifecycleSnap, "must capture after-detail-lifecycle snapshot");
      const logAfterDetailLifecycle = lifecycleSnap.lifecycleLog as string[];
      assert.deepEqual(
        logAfterDetailLifecycle,
        [
          "home.onEnter",
          "home.onLeave",
          "detail.onEnter",
          "app.onAppear:onDidAppear",
          "detail.onBackground",
          "app.onBackground:onWillDisappear",
          "detail.onForeground",
          "app.onResume:onResume",
          "app.onForeground:onResume",
        ],
        "usePocketRouteLifecycle must fire home.onLeave -> detail.onEnter -> detail.onBackground -> detail.onForeground without spuriously firing home.onBackground, and usePocketAppLifecycle must distinguish onAppear vs onResume",
      );

      // Assertion 3: Retained-route Back isolation (Dialog on inactive home route does not steal Back from detail route)
      const beforeBackSnap = snapshots.get("detail-with-home-dialog-open");
      const afterFirstBackSnap = snapshots.get("after-first-back");
      const afterSecondBackSnap = snapshots.get("after-second-back");
      assert.ok(beforeBackSnap && afterFirstBackSnap && afterSecondBackSnap);
      assert.equal(
        findTextOp(snapshotFrames.get("detail-with-home-dialog-open-arc"), "HomeDialogTitle"),
        undefined,
      );
      assert.equal(
        findTextOp(snapshotFrames.get("detail-with-home-dialog-open-glass"), "HomeDialogTitle"),
        undefined,
      );
      assert.equal(
        findTextOp(snapshotFrames.get("detail-with-home-dialog-open"), "HomeDialogTitle"),
        undefined,
      );
      assert.equal(beforeBackSnap.route, "detail");
      assert.equal(beforeBackSnap.homeDialogOpen, true);

      assert.equal(
        afterFirstBackSnap.route,
        "home",
        "first platform.back.request on detail must pop detail -> home",
      );
      assert.equal(
        afterFirstBackSnap.homeDialogOpen,
        true,
        "first platform.back.request on detail must NOT close inactive home route's SkinDialog",
      );
      assert.ok(
        (afterFirstBackSnap.lifecycleLog as string[]).includes("detail.onLeave"),
        "popping detail -> home must fire detail.onLeave",
      );

      assert.equal(
        afterSecondBackSnap.route,
        "home",
        "second platform.back.request on home stays on home",
      );
      assert.equal(
        afterSecondBackSnap.homeDialogOpen,
        false,
        "second platform.back.request on active home route must close home's SkinDialog",
      );
      assert.equal(
        afterSecondBackSnap.homeMounts,
        1,
        "home route render() mount count must still be 1 after round-trip navigations and back requests",
      );
      assert.equal(
        afterSecondBackSnap.detailMounts,
        1,
        "detail route render() mount count must still be 1",
      );
      assert.equal(
        afterSecondBackSnap.homeCount,
        2,
        "home counter state is preserved across home -> detail -> home",
      );

      const backResponses = emittedEvents
        .filter((ev) => ev.name === POCKET_BACK_RESPONSE_EVENT)
        .map((ev) => ev.payload);
      assert.deepEqual(
        backResponses,
        [
          { requestId: "back-1", handled: true },
          { requestId: "back-2", handled: true },
        ],
        "both back requests must emit handled: true responses",
      );

      // Assertion 4: Root UiSkinProvider inherits platform.presets & accessibility.preferences + createPocketSystemUiSync emits platform.systemUi.set
      const inheritedArcSnap = snapshots.get("inherited-presets-arc-dark");
      const inheritedDefaultSnap = snapshots.get("inherited-presets-reset-default");
      assert.ok(inheritedArcSnap && inheritedDefaultSnap);
      assert.equal(inheritedArcSnap.skinId, "arc");
      assert.equal(inheritedArcSnap.mode, "dark");
      assert.equal(inheritedArcSnap.accent, "teal");
      assert.equal(inheritedArcSnap.density, "desktop");
      assert.equal(inheritedArcSnap.reducedMotion, true);
      assert.deepEqual(inheritedArcSnap.motion, {
        routeTransition: "IOS_SPRING_PARALLAX",
        routeTransitionDurationMs: 0,
      });

      assert.equal(
        inheritedDefaultSnap.skinId,
        "default",
        "platform.presets skin: 'default' must reset inherited skin back to default",
      );
      assert.equal(inheritedDefaultSnap.mode, "dark");
      assert.equal(inheritedDefaultSnap.accent, "teal");
      assert.equal(inheritedDefaultSnap.density, "desktop");
      assert.equal(inheritedDefaultSnap.reducedMotion, true);
      assert.equal(
        inheritedDefaultSnap.toastOpen,
        false,
        "SkinToast must also auto-dismiss cleanly after preset skin switch",
      );
      assert.equal(inheritedDefaultSnap.toastDismissCount, 2);

      // Verify platform.systemUi.set requests emitted by createPocketSystemUiSync across all skins and onResume
      const systemUiRequests = emittedEvents
        .filter(
          (ev) =>
            ev.name === "host.request" && ev.payload?.capability === "platform.systemUi.set",
        )
        .map((ev) => ev.payload?.params as JsonObject);

      assert.ok(
        systemUiRequests.length >= 7,
        `createPocketSystemUiSync must emit platform.systemUi.set across skin switches and lifecycle appear/resume (got ${systemUiRequests.length})`,
      );

      const expectedSkinNavColors = skinTokenLogs.map((entry) => entry.navColor as number);
      assert.ok(
        expectedSkinNavColors.includes(0xff112233),
        "custom skin #112233 must resolve to 0xff112233",
      );
      const lightSkinNavSet = new Set(
        skinTokenLogs
          .filter(
            (entry) =>
              entry.mode === "light" &&
              ["default", "looseleaf", "arc", "liquid-glass"].includes(String(entry.skinId)),
          )
          .map((entry) => entry.navColor as number),
      );
      assert.equal(
        lightSkinNavSet.size,
        4,
        `default, looseleaf, arc, and liquid-glass light canvas colors must all be distinct (got ${JSON.stringify([...lightSkinNavSet])})`,
      );

      const observedNavColors = systemUiRequests.map((req) => req.systemNavigationBarColor);
      for (const expectedColor of expectedSkinNavColors) {
        assert.ok(
          observedNavColors.includes(expectedColor),
          `platform.systemUi.set must include navColor ${expectedColor} (observed: ${JSON.stringify(observedNavColors)})`,
        );
      }

      const darkArcNavColor = inheritedArcSnap.navColor;
      assert.equal(typeof darkArcNavColor, "number");
      const darkArcRequests = systemUiRequests.filter(
        (req) =>
          req.systemNavigationBarColor === darkArcNavColor &&
          req.statusBarIconBrightness === "light" &&
          req.statusBarBrightness === "dark",
      );
      assert.ok(
        darkArcRequests.length >= 2,
        "platform.lifecycle onResume must force createPocketSystemUiSync to re-emit platform.systemUi.set even when tokens are unchanged",
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
  testTimeoutMs,
);
