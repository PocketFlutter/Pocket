import { test as bunTest } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readNativeArtifacts, type NativeArtifacts } from "./native_session.ts";

/**
 * Lantern's staged guest (`demo/assets/apps/lantern`) is gitignored: it can only
 * be built with a local, pinned Live2D Cubism sample (`CUBISM_SDK_ROOT`), which
 * the build deliberately never downloads.  Tests that run the real Lantern QJBC
 * therefore skip, naming that prerequisite, when the staged artifacts are
 * absent.  With POCKET_REQUIRE_REAL=1 (CI / release) they are never skipped and
 * fail with the strict `readNativeArtifacts` diagnostics instead.
 */
const stagedDirectory = resolve(import.meta.dir, "../../assets/apps/lantern");
const stagedPaths = {
  bytecode: process.env.POCKET_LANTERN_GUEST_BYTECODE ?? resolve(stagedDirectory, "app.qjbc"),
  pak: process.env.POCKET_LANTERN_GUEST_PAK ?? resolve(stagedDirectory, "app.pak"),
  metadata: process.env.POCKET_LANTERN_GUEST_METADATA ?? resolve(stagedDirectory, "app.bytecode.json"),
};

function reason(): string | null {
  if (process.env.POCKET_REQUIRE_REAL === "1") return null;
  const missing = Object.values(stagedPaths).filter((path) => !existsSync(path));
  if (missing.length === 0) return null;
  return `staged Lantern guest is not built (missing ${missing.join(", ")}); it needs a local pinned Cubism sample: CUBISM_SDK_ROOT=<path> bun scripts/build_mini_apps.ts --mini-app=lantern (set POCKET_REQUIRE_REAL=1 to fail instead of skip)`;
}

export const lanternSkipReason = reason();

/** `test` that is skipped, with the reason in its name, while Lantern is not staged. */
export const test: typeof bunTest = lanternSkipReason === null
  ? bunTest
  : (Object.assign(
      (name: string, fn?: any, options?: any) => bunTest.skip(`${name} [skipped: ${lanternSkipReason}]`, fn, options),
      bunTest,
    ) as typeof bunTest);

/**
 * Strict artifact reader for Lantern suites.  When Lantern is not staged (and
 * the suite is therefore skipped) it only returns the unbuilt paths so that
 * module-level setup can finish; no skipped test ever executes them.
 */
export function readLanternArtifacts(prefix = "POCKET_LANTERN"): NativeArtifacts {
  if (lanternSkipReason === null) return readNativeArtifacts(prefix);
  return {
    bytecodePath: stagedPaths.bytecode,
    pakPath: stagedPaths.pak,
    metadataPath: stagedPaths.metadata,
    runtimeAbi: "unavailable: Lantern is not staged",
  };
}
