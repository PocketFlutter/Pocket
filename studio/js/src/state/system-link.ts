// The only module that talks to the System capabilities: it installs the
// PocketSystem kernel (system.runtime.configure) once and exposes the host
// requests needed by simultaneous multi-target previews and Studio settings.
// Orchestration stays in the stores; Dart only owns child runtime lifetime and compositing.
import type { HostBridge } from "@pocket/ui/host";
import { installPocketSystem, type PocketSystemV1 } from "@pocket/ui/system";
import {
  ALL_PREVIEW_APP_IDS,
  PREVIEW_APP_ID,
  type PreviewInitialEvent,
  type PreviewRuntime,
} from "./preview.ts";
import type { SettingsBackend } from "./settings.ts";

export const STUDIO_APP_ID = "dev.pocket.studio";

function detectSupportedPreviewAppIds(): readonly string[] {
  const surfaces = (globalThis as { ui?: { __surfaces?: Record<string, unknown> } }).ui?.__surfaces;
  if (!surfaces || typeof surfaces !== "object" || Array.isArray(surfaces)) {
    return [PREVIEW_APP_ID];
  }
  const matched = ALL_PREVIEW_APP_IDS.filter(
    (appId) => typeof surfaces[appId] === "number" && Number.isInteger(surfaces[appId]),
  );
  return matched.length > 0 ? matched : [PREVIEW_APP_ID];
}

function buildStudioManifest(previewAppIds: readonly string[]): PocketSystemV1 {
  return {
    pocketSystem: 1,
    id: STUDIO_APP_ID,
    roles: { systemUI: STUDIO_APP_ID },
    applications: {
      backgroundExecution: "suspend",
      catalog: [
        { package: STUDIO_APP_ID, manifest: "pocket.json", required: true },
        ...previewAppIds.map((appId, idx) => ({
          package: appId,
          manifest: idx === 0 ? "preview/pocket.json" : `preview-${idx}/pocket.json`,
          required: true,
        })),
      ],
    },
    installation: { installedPackages: [STUDIO_APP_ID, ...previewAppIds] },
  };
}

export function createSystemLink(host: HostBridge): PreviewRuntime & SettingsBackend {
  let installed: Promise<void> | undefined;
  let supportedIds: readonly string[] = [PREVIEW_APP_ID];
  const ensure = (): Promise<void> => {
    if (!installed) {
      installed = (async () => {
        supportedIds = detectSupportedPreviewAppIds();
        const maxResidentApps = Math.max(2, supportedIds.length + 1);
        const system = installPocketSystem(buildStudioManifest(supportedIds), {
          bridge: host,
          maxResidentApps,
        });
        await system.ready;
      })();
      installed.catch(() => { installed = undefined; }); // allow a later retry
    }
    return installed;
  };
  const request = async <T>(capability: string, params: Record<string, unknown>): Promise<T> => {
    await ensure();
    return await host.request(capability, params as never) as T;
  };
  return {
    ensure,
    supportedAppIds: () => detectSupportedPreviewAppIds(),
    async create(appId: string, initialEvents?: readonly PreviewInitialEvent[]) {
      // prepareForOpen without cacheFirst: the signed update is checked and verified before the child can run.
      const created = await request<{ instanceId: string; generation: number | string }>("system.runtime.create", {
        appId,
        prepareForOpen: true,
        ...(initialEvents && initialEvents.length > 0 ? { initialEvents: [...initialEvents] } : {}),
      });
      return { instanceId: String(created.instanceId), generation: created.generation };
    },
    async post(instanceId: string, event: string, params: Record<string, unknown>): Promise<boolean> {
      const res = await request<{ accepted?: boolean }>("system.runtime.post", { instanceId, event, params });
      return res?.accepted === true;
    },
    async destroy(instanceId) { await request("system.runtime.destroy", { instanceId }); },
    async awaitFirstFrame(instanceId, generation) { await request("system.runtime.awaitFirstFrame", { instanceId, generation }); },
    async get(key) { return await request<unknown>("system.storage.get", { appId: STUDIO_APP_ID, key }); },
    async set(key, value) { await request("system.storage.set", { appId: STUDIO_APP_ID, key, value }); },
  };
}
