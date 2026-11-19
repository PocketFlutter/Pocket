/** Project support files shared by CLI and Studio; all commands use SDK entry points. */
import {
  MANAGED_RULES_END as RAW_MANAGED_RULES_END,
  MANAGED_RULES_START as RAW_MANAGED_RULES_START,
} from "./check_project.mjs";
import {
  FRAMEWORK_AGENT_DEVELOPER_INSTRUCTIONS as RAW_FRAMEWORK_AGENT_DEVELOPER_INSTRUCTIONS,
  renderProjectAgentsMarkdown as rawRenderProjectAgentsMarkdown,
  syncProjectAgentFiles as rawSyncProjectAgentFiles,
  writeProjectSupport as rawWriteProjectSupport,
} from "./create_project.mjs";

export interface ProjectAgentMarkdownOptions {
  readonly name?: string;
  readonly sdk?: string;
  readonly template?: "app" | "game" | string;
  readonly flutter?: boolean;
}

export interface SyncProjectAgentFilesOptions extends ProjectAgentMarkdownOptions {
  readonly overwriteManaged?: boolean;
}

export interface WriteProjectSupportOptions {
  readonly template?: "app" | "game" | string;
  readonly title?: string;
}

export const MANAGED_RULES_START: string = RAW_MANAGED_RULES_START;
export const MANAGED_RULES_END: string = RAW_MANAGED_RULES_END;
export const FRAMEWORK_AGENT_DEVELOPER_INSTRUCTIONS: string = RAW_FRAMEWORK_AGENT_DEVELOPER_INSTRUCTIONS;

export function renderProjectAgentsMarkdown(options: ProjectAgentMarkdownOptions = {}): string {
  return rawRenderProjectAgentsMarkdown(options);
}

export function syncProjectAgentFiles(project: string, options: SyncProjectAgentFilesOptions = {}): void {
  rawSyncProjectAgentFiles(project, options);
}

export function writeProjectSupport(
  project: string,
  sdk: string,
  name: string,
  options: WriteProjectSupportOptions = {},
): void {
  rawWriteProjectSupport(project, sdk, name, options);
}
