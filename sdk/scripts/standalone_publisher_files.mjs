import { readFileSync } from "node:fs";
import { join } from "node:path";

export function standalonePublisherFiles(sdkRoot, publisher) {
  const versionStore = readFileSync(join(sdkRoot, "editor", "version_store.ts"), "utf8");
  const versionTypes = versionStore.match(/export type VersionSlot = [\s\S]+?(?=export type VersionHistory = )/);
  if (!versionTypes) throw new Error("Missing publisher release record types");

  for (const [source, destination] of [
    ["../../../editor/version_store.ts", "./internal/version_types.ts"],
    ["../../../scripts/package_update.ts", "./internal/package_update.ts"],
  ]) {
    if (!publisher.includes(source)) throw new Error(`Missing publisher staging import: ${source}`);
    publisher = publisher.replaceAll(source, destination);
  }

  return new Map([
    ["src/publisher.ts", Buffer.from(publisher)],
    ["src/internal/version_types.ts", Buffer.from(versionTypes[0].trimEnd() + "\n")],
    ["src/internal/package_update.ts", readFileSync(join(sdkRoot, "scripts", "package_update.ts"))],
  ]);
}
