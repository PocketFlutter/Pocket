import {
  installPocketSystem,
  type PocketSystemExternalOpenHandler,
  type PocketSystemOpenMode,
  type PocketSystemPresetUpdate,
  type PocketSystemV1,
} from "@pocket/ui/system";
import type { AppLaunch, AppResult } from "@pocket/ui/platform";
import { createPocketUpdateClient, type PocketUpdateStateOptions } from "@pocket/ui/updates";
import { hostError, type HostBridge } from "@pocket/ui/host";
import type { JsonObject } from "@pocket/ui/host";
import type { PocketSystemPolicies } from "@pocket/ui/system";
import { onCleanup } from "solid-js";
import manifest from "./pocket.system.json";
import lobbyManifest from "./apps/lobby/pocket.json";
import profileManifest from "./apps/profile/pocket.json";
import {
  officialDemoAppId,
  officialDemos,
  isOfficialDemoLaunchable,
  readTrustedCompositorSurfaceIds,
  type OfficialDemo,
} from "./official_demos.ts";

export { isOfficialDemoLaunchable } from "./official_demos.ts";

export interface ShowcaseSystemInstallOptions {
  openMode?: () => PocketSystemOpenMode;
  externalOpen?: PocketSystemExternalOpenHandler;
}

const HYBRID_OPEN_CAPABILITY = "demo.hybridFlutter.openMiniApp";
const HYBRID_CANCEL_CAPABILITY = "demo.hybridFlutter.cancelMiniApp";
const HYBRID_RESULT_EVENT = "demo.hybridFlutter.result";

/** Bridges a native route's async completion into the normal platform.result lane. */
function createHybridFlutterOpenAdapter(bridge: HostBridge) {
  const pending = new Map<string, {
    appId: string;
    resolve: (result: AppResult) => void;
  }>();
  const removeListener = bridge.onEvent?.((event) => {
    if (event.method !== HYBRID_RESULT_EVENT) return;
    const params = event.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) return;
    const requestId = params.requestId;
    if (typeof requestId !== "string") return;
    const waiter = pending.get(requestId);
    if (!waiter) return;
    pending.delete(requestId);
    waiter.resolve({
      requestId,
      appId: typeof params.appId === "string" ? params.appId : waiter.appId,
      cancelled: params.cancelled === true,
      value: params.value as AppResult["value"] ?? null,
      ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
    });
  });

  const open: PocketSystemExternalOpenHandler = async (request) => {
    if (!removeListener) {
      throw Object.assign(new Error("Host event transport is required for fullscreen MiniApps"), {
        code: "external_open_unavailable",
      });
    }
    let resolve!: (result: AppResult) => void;
    const result = new Promise<AppResult>((done) => { resolve = done; });
    // Register before asking the host: a route can close before the accepted
    // response makes a round trip through the bridge.
    pending.set(request.requestId, { appId: request.appId, resolve });
    try {
      const accepted = await bridge.request<JsonObject>(HYBRID_OPEN_CAPABILITY, {
        requestId: request.requestId,
        appId: request.appId,
        arguments: request.arguments,
        ...(request.presentationStyle ? { presentationStyle: request.presentationStyle } : {}),
      });
      if (
        !accepted ||
        accepted.accepted !== true ||
        accepted.requestId !== request.requestId ||
        accepted.appId !== request.appId
      ) {
        throw Object.assign(new Error("Native host did not accept the fullscreen MiniApp route"), {
          code: "external_open_rejected",
        });
      }
    } catch (error) {
      const waiter = pending.get(request.requestId);
      pending.delete(request.requestId);
      waiter?.resolve({
        requestId: request.requestId,
        appId: request.appId,
        cancelled: true,
        value: null,
        reason: "external_open_rejected",
      });
      throw error;
    }
    const launch: AppLaunch = {
      requestId: request.requestId,
      targetAppId: request.appId,
      result,
      cancel: () => bridge.request(HYBRID_CANCEL_CAPABILITY, { requestId: request.requestId }),
    };
    return launch;
  };

  return {
    open,
    dispose(): void {
      removeListener?.();
      for (const [requestId, waiter] of pending) {
        waiter.resolve({
          requestId,
          appId: waiter.appId,
          cancelled: true,
          value: null,
          reason: "system_ui_disposed",
        });
      }
      pending.clear();
    },
  };
}

const BUILTIN_APP_MANIFESTS: Readonly<Record<string, unknown>> = {
  "pocket.demo.lobby": lobbyManifest,
  "pocket.demo.profile": profileManifest,
};

function manifestPresentationOf(appManifest: unknown): JsonObject | undefined {
  if (!appManifest || typeof appManifest !== "object" || Array.isArray(appManifest)) return undefined;
  const record = appManifest as Record<string, unknown>;
  const appSection = record.app && typeof record.app === "object" && !Array.isArray(record.app)
    ? record.app as Record<string, unknown>
    : undefined;
  const rawPresentation = appSection?.presentation ?? record.presentation;
  const presentation = rawPresentation && typeof rawPresentation === "object" && !Array.isArray(rawPresentation)
    ? rawPresentation as JsonObject
    : undefined;
  const title = typeof record.title === "string" ? record.title : undefined;
  if (!presentation && !title) return undefined;
  return {
    ...(title ? { title } : {}),
    ...(presentation ?? {}),
  };
}

function presentationOf(demo: OfficialDemo): JsonObject {
  return {
    officialDemo: true,
    id: demo.id,
    title: demo.title,
    status: demo.status,
    ...(demo.statusReason ? { statusReason: demo.statusReason } : {}),
    ...(demo.launchability ? { launchability: demo.launchability } : {}),
    requiredCapabilities: demo.requiredCapabilities ?? [],
    enhancedCapabilities: demo.enhancedCapabilities ?? [],
    pointerFallbackCapabilities: demo.launchabilityDetails?.pointerFallbackCapabilities ?? [],
    missingSessionCapabilities: demo.hostCompatibility?.missingSessionCapabilities ?? [],
  };
}

/** Adds generated upstream entries to the existing system manifest and ACL. */
export function buildShowcaseSystemConfiguration(
  base: PocketSystemV1 = manifest as PocketSystemV1,
  demos: readonly OfficialDemo[] = officialDemos,
  trustedAvailableIds: ReadonlySet<string> = new Set(),
): { manifest: PocketSystemV1; policies: PocketSystemPolicies } {
  if (demos.length > 59) throw new RangeError("Official demo catalog exceeds reserved compositor handles 4..62");
  const seen = new Set(base.applications.catalog.map((entry) => entry.package));
  const officialPackageIds = new Set(demos.map(officialDemoAppId));
  const systemUI = base.roles.systemUI;
  const installedBaseChildren = base.installation.installedPackages.filter(
    (appId) => appId !== systemUI && !officialPackageIds.has(appId),
  );
  const baseRegistryIsComplete = installedBaseChildren.every((appId) => trustedAvailableIds.has(appId));
  const launchableIds: string[] = [];
  const officialCatalog = demos.map((demo) => {
    if (!demo.id || !demo.title || !demo.assets?.manifest) {
      throw new TypeError("Official demo catalog entries require id, title, and manifest path");
    }
    const packageId = officialDemoAppId(demo);
    if (seen.has(packageId)) throw new TypeError(`Duplicate official demo package: ${packageId}`);
    seen.add(packageId);
    if (baseRegistryIsComplete && isOfficialDemoLaunchable(demo) && trustedAvailableIds.has(packageId)) {
      launchableIds.push(packageId);
    }
    return {
      package: packageId,
      manifest: demo.assets.manifest,
      required: false,
      presentation: presentationOf(demo),
    };
  });
  const baseCatalog = base.applications.catalog.map((entry) => {
    const manifestPresentation = manifestPresentationOf(BUILTIN_APP_MANIFESTS[entry.package]);
    if (!manifestPresentation && !entry.presentation) return entry;
    return {
      ...entry,
      presentation: {
        ...(manifestPresentation ?? {}),
        ...(entry.presentation ?? {}),
      },
    };
  });
  const nextManifest: PocketSystemV1 = {
    ...base,
    applications: {
      ...base.applications,
      catalog: [...baseCatalog, ...officialCatalog],
    },
    installation: {
      ...base.installation,
      installedPackages: [...new Set([
        ...base.installation.installedPackages.filter((appId) => !officialPackageIds.has(appId)),
        ...launchableIds,
      ])],
    },
  };
  const policies: PocketSystemPolicies = {
    "pocket.host.demo": {
      allowedOpenApps: ["pocket.demo.profile", "pocket.demo.lobby", ...launchableIds],
      messageTargets: ["pocket.demo.profile", "pocket.demo.lobby"],
      sharedNamespaces: ["identity"],
    },
    "pocket.demo.profile": {
      allowedOpenApps: ["pocket.demo.lobby"],
      messageTargets: ["pocket.host.demo"],
      sharedNamespaces: ["identity"],
    },
    "pocket.demo.lobby": {
      allowedOpenApps: [],
      messageTargets: ["pocket.host.demo", "pocket.demo.profile"],
      sharedNamespaces: ["identity"],
    },
    ...Object.fromEntries(launchableIds.map((id) => [id, {
      allowedOpenApps: [],
      messageTargets: [],
      sharedNamespaces: [],
    }])) as PocketSystemPolicies,
  };
  return { manifest: nextManifest, policies };
}

/** Product policy stays in the SystemUI guest, outside the Flutter shell. */
export function installShowcaseSystem(
  bridge: HostBridge,
  state?: PocketUpdateStateOptions,
  presets?: PocketSystemPresetUpdate,
  options: ShowcaseSystemInstallOptions = {},
) {
  const configuration = buildShowcaseSystemConfiguration(
    manifest as PocketSystemV1,
    officialDemos,
    readTrustedCompositorSurfaceIds(),
  );
  const hybridOpenAdapter = createHybridFlutterOpenAdapter(bridge);
  const system = installPocketSystem(configuration.manifest, {
    bridge,
    maxResidentApps: 3,
    policies: configuration.policies,
    presets,
    ...(options.openMode ? { openMode: options.openMode } : {}),
    externalOpen: options.externalOpen ?? hybridOpenAdapter.open,
  });
  // The host already prepares cache-first updates in the background for the
  // next open. A second guest auto-refresh would apply them over a live page.
  const updates = createPocketUpdateClient(bridge, {
    state: state && {
      ...state,
      storage: {
        get: async (key, namespace) => { await system.ready; return state.storage.get(key, namespace); },
        set: async (key, value, namespace) => { await system.ready; return state.storage.set(key, value, namespace); },
        remove: async (key, namespace) => { await system.ready; return state.storage.remove(key, namespace); },
      },
    },
    onError: (error) => console.warn("SystemUI update", hostError(error).code),
  });
  onCleanup(() => {
    updates.dispose();
    hybridOpenAdapter.dispose();
  });
  return Object.assign(system, { updates });
}
