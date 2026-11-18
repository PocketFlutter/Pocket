import { test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { packageToolchain } from "../package_toolchain.ts";
import { SDK_VERSION } from "../prebuilt_tools.mjs";

/**
 * Frozen acceptance tests run against pinned artifacts (a release-built
 * `pocket_probe`, a pinned Bun/Playwright install, a Live2D sample cache, ...)
 * that only exist on a prepared review machine. When one of those is absent
 * the test is skipped with the named prerequisite printed once at load time.
 * `POCKET_REQUIRE_REAL=1` turns the same condition into a failure so a
 * missing prerequisite can never be mistaken for a pass in a gated run.
 */
export interface Prerequisite {
  readonly name: string;
  readonly satisfied: boolean;
}

export const sdkRoot = resolve(import.meta.dir, "../..");

export function fileExists(name: string, path: string): Prerequisite {
  return { name: `${name} (${path})`, satisfied: existsSync(path) };
}

export function environmentVariable(name: string): Prerequisite {
  return { name: `environment variable ${name}`, satisfied: Boolean(process.env[name]?.trim()) };
}

/** The native probe + tools package a native-backed acceptance test runs against. */
export interface NativeToolchain {
  readonly probe: string;
  readonly toolsPackage: string;
  /** SHA-256 of `probe`; the identity recorded in acceptance evidence. */
  readonly probeSha256: string;
}

let toolchain: NativeToolchain | undefined | null = null;

/**
 * Resolve the native toolchain without any pinned macOS artifact:
 * `POCKET_NATIVE_PROBE` / `POCKET_TOOLS_PACKAGE` win when set; otherwise the
 * SDK's own source-built release `pocket_probe` + `pocketjs_bytecode`
 * (`cargo build --release`) are used and a tools package is assembled from
 * them with `scripts/package_toolchain.ts` (the same packager release CI uses)
 * into `.pocket-build/toolchain-package`. Returns undefined when neither the
 * overrides nor the release binaries + pinned compiler cache exist.
 */
export function nativeToolchain(): NativeToolchain | undefined {
  if (toolchain !== null) return toolchain;
  toolchain = undefined;
  const explicitProbe = process.env.POCKET_NATIVE_PROBE?.trim();
  const explicitTools = process.env.POCKET_TOOLS_PACKAGE?.trim();
  let toolsPackage = explicitTools ? resolve(explicitTools) : undefined;
  let probe = explicitProbe ? resolve(explicitProbe) : undefined;
  if (!toolsPackage) {
    const releaseProbe = join(sdkRoot, "native/target/release/pocket_probe");
    const releaseBytecode = join(sdkRoot, "native/target/release/pocketjs_bytecode");
    if (!existsSync(releaseProbe) || !existsSync(releaseBytecode) || !existsSync(join(sdkRoot, ".cache/pocketjs/.pocketjs-revision"))) return toolchain;
    toolsPackage = join(sdkRoot, ".pocket-build/toolchain-package");
    const manifest = join(toolsPackage, "manifest.json");
    const stale = !existsSync(manifest)
      || statSync(manifest).mtimeMs < Math.max(statSync(releaseProbe).mtimeMs, statSync(releaseBytecode).mtimeMs);
    if (stale) packageToolchain({ sdkRoot, out: toolsPackage, force: true, version: SDK_VERSION });
  }
  probe ??= join(toolsPackage, "bin/pocket_probe");
  if (!existsSync(probe) || !existsSync(join(toolsPackage, "compiler/tools/build.ts"))) return toolchain;
  toolchain = { probe, toolsPackage, probeSha256: createHash("sha256").update(readFileSync(probe)).digest("hex") };
  return toolchain;
}

export function toolchainPrerequisite(): Prerequisite {
  return {
    name: "native pocket_probe + tools package (POCKET_NATIVE_PROBE/POCKET_TOOLS_PACKAGE, or source-built native/target/release binaries with .cache/pocketjs)",
    satisfied: nativeToolchain() !== undefined,
  };
}

/**
 * The generic Web engine + browser host bundle: `POCKET_WEB_ENGINE` /
 * `POCKET_WEB_RUNTIME` win, otherwise the repo's own
 * `scripts/build_web_engine.ts` output under `.pocket-build/web-engine`.
 */
export function webEngine(): { engine: string; runtime: string } | undefined {
  const engine = process.env.POCKET_WEB_ENGINE?.trim() || join(sdkRoot, ".pocket-build/web-engine/pocketjs.wasm");
  const runtime = process.env.POCKET_WEB_RUNTIME?.trim() || join(sdkRoot, ".pocket-build/web-engine/pocket-web.js");
  return existsSync(engine) && existsSync(runtime) ? { engine, runtime } : undefined;
}

/** Browser acceptance was frozen against Bun 1.4.4; any platform's 1.4.4 runner is the same JS runtime. */
export const pinnedBunVersion = "1.4.4";
export function pinnedBunPrerequisite(): Prerequisite {
  return { name: `Bun ${pinnedBunVersion} test runner (running Bun is ${Bun.version})`, satisfied: Bun.version === pinnedBunVersion };
}

export function acceptanceTest(suite: string, prerequisites: readonly Prerequisite[]): typeof test {
  const missing = prerequisites.filter((item) => !item.satisfied).map((item) => item.name);
  if (missing.length === 0) return test;
  const reason = `${suite}: missing prerequisite(s): ${missing.join("; ")}`;
  if (process.env.POCKET_REQUIRE_REAL === "1") {
    return ((name: string) => test(name, () => {
      throw new Error(`POCKET_REQUIRE_REAL=1: ${reason}`);
    })) as unknown as typeof test;
  }
  console.warn(`[skipped] ${reason}`);
  return ((name: string, ...rest: unknown[]) =>
    (test.skip as unknown as (...args: unknown[]) => void)(`${name} [skipped: missing ${missing.join("; ")}]`, ...rest)) as unknown as typeof test;
}
