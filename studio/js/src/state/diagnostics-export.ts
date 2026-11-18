// "Export diagnostics" (the web Studio's 导出诊断记录): asks the provider for the project's scrubbed diagnostics bundle
// (studio.logs.diagnostics) and keeps a summary the pages show: counts, a derived export id and the service's download
// URL, both copyable. There is no file dialog in the Studio; the bundle itself can be copied as JSON.
import { createStore } from "./store.ts";
import type { Toasts } from "./toasts.ts";
import { errorText } from "./workspace.ts";
import type { DiagnosticsExport, StudioClient } from "../studio-client.ts";

export interface DiagnosticsState {
  phase: "idle" | "exporting" | "done" | "error";
  project?: string;
  kind?: "log" | "crash";
  result?: DiagnosticsExport;
  message?: string;
}

export function createDiagnosticsExport(deps: { client: StudioClient; toasts: Toasts; project: () => string | undefined }) {
  const { client, toasts } = deps;
  const store = createStore<DiagnosticsState>({ phase: "idle" });
  const state = () => store.get();
  let epoch = 0;

  async function run(kind?: "log" | "crash"): Promise<boolean> {
    const project = deps.project();
    if (!project) { toasts.info("请先在“项目”页打开一个项目。"); return false; }
    if (state().phase === "exporting") return false;
    const mine = ++epoch;
    store.set({ phase: "exporting", project, ...(kind ? { kind } : {}) });
    try {
      const result = await client.logs.diagnostics(project, kind);
      if (mine !== epoch) return false;
      store.set({ phase: "done", project, ...(kind ? { kind } : {}), result });
      return true;
    } catch (error) {
      if (mine !== epoch) return false;
      const message = errorText(error);
      store.set({ phase: "error", project, ...(kind ? { kind } : {}), message });
      toasts.error(`导出诊断失败：${message}`);
      return false;
    }
  }

  /** The exported bundle as compact JSON (what "复制诊断内容" puts on the clipboard). */
  function bundleText(): string | undefined {
    const result = state().result;
    return result ? JSON.stringify(result) : undefined;
  }

  return { store, state, run, bundleText, reset: () => { epoch += 1; store.set({ phase: "idle" }); } };
}
export type DiagnosticsExporter = ReturnType<typeof createDiagnosticsExport>;
