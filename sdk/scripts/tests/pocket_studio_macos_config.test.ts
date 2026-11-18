// Text-only Linux-side substitute for macOS acceptance of the Pocket Studio host. Nothing here builds or runs
// Flutter/Xcode; it only lints checked-in config text. It does NOT prove the host builds or launches on macOS.
// POCKET_STUDIO_MACOS_DIR / POCKET_STUDIO_MAIN_DART may point at copies (used to prove an assertion can fail).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { planPocketStudioLaunch } from "../pocket_studio_launcher.ts";

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = resolve(sdkRoot, "..");
const macosDir = process.env.POCKET_STUDIO_MACOS_DIR ?? join(repoRoot, "studio", "macos");
const mainDart = process.env.POCKET_STUDIO_MAIN_DART ?? join(repoRoot, "studio", "lib", "main.dart");
const configDart = join(sdkRoot, "packages", "pocket_studio", "lib", "src", "studio_config.dart");
const SUBSTITUTE = "(text-only substitute for macOS acceptance; not a build or run)";

const read = (path: string): string => readFileSync(path, "utf8");

/** Tiny plist reader: top-level <key> -> boolean for <true/>/<false/>, otherwise the raw next-element text. */
function plistTopLevel(xml: string): Map<string, boolean | string> {
  const stripped = xml.replace(/<!--[\s\S]*?-->/g, "");
  const open = (stripped.match(/<dict>/g) ?? []).length;
  const close = (stripped.match(/<\/dict>/g) ?? []).length;
  assert.equal(open, close, "plist <dict> tags must balance");
  assert.equal((stripped.match(/<plist[\s>]/g) ?? []).length, 1, "plist must have one <plist> open");
  assert.equal((stripped.match(/<\/plist>/g) ?? []).length, 1, "plist must have one </plist> close");
  const out = new Map<string, boolean | string>();
  const re = /<key>([^<]*)<\/key>\s*(<true\/>|<false\/>|<string>([^<]*)<\/string>|<[a-z]+\/?>)/g;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) {
    out.set(m[1], m[2] === "<true/>" ? true : m[2] === "<false/>" ? false : (m[3] ?? m[2]));
  }
  return out;
}

test("Release.entitlements: unsandboxed, no JIT, no listening socket", () => {
  const keys = plistTopLevel(read(join(macosDir, "Runner", "Release.entitlements")));
  assert.equal(keys.get("com.apple.security.app-sandbox"), false,
    `Release must run outside the App Sandbox so Studio can spawn bun and read the workspace ${SUBSTITUTE}`);
  assert.equal(keys.has("com.apple.security.cs.allow-jit"), false,
    `Release must not request allow-jit (hardened-runtime JIT exception is unneeded for bytecode) ${SUBSTITUTE}`);
  assert.equal(keys.has("com.apple.security.network.server"), false,
    `Release must not request network.server (the host only connects out to the local editor service) ${SUBSTITUTE}`);
});

test("DebugProfile.entitlements: unsandboxed", () => {
  const keys = plistTopLevel(read(join(macosDir, "Runner", "DebugProfile.entitlements")));
  assert.equal(keys.get("com.apple.security.app-sandbox"), false,
    `Debug/Profile must run outside the App Sandbox so Studio can spawn bun ${SUBSTITUTE}`);
});

test("project.pbxproj: entitlement wiring and deployment target", () => {
  const pbx = read(join(macosDir, "Runner.xcodeproj", "project.pbxproj"));
  const count = (needle: string) => (pbx.match(new RegExp(`CODE_SIGN_ENTITLEMENTS = ${needle};`, "g")) ?? []).length;
  assert.equal(count("Runner/Release\\.entitlements"), 1,
    `Release configuration must sign with Release.entitlements exactly once ${SUBSTITUTE}`);
  assert.equal(count("Runner/DebugProfile\\.entitlements"), 2,
    `Debug and Profile configurations must sign with DebugProfile.entitlements exactly twice ${SUBSTITUTE}`);
  const targets = [...pbx.matchAll(/MACOSX_DEPLOYMENT_TARGET = ([0-9.]+);/g)].map((m) => m[1]);
  assert.ok(targets.length > 0, "project.pbxproj must declare MACOSX_DEPLOYMENT_TARGET");
  assert.equal(new Set(targets).size, 1,
    `every build configuration must share one deployment target or macOS min-version behaviour diverges ${SUBSTITUTE}: ${targets.join(", ")}`);
  const [major, minor = 0] = targets[0].split(".").map(Number);
  assert.ok(major > 12 || (major === 12 && minor >= 0), `deployment target must be >= 12.0, got ${targets[0]} ${SUBSTITUTE}`);
});

test("Info.plist: well-formed with bundle id and minimum system version", () => {
  const keys = plistTopLevel(read(join(macosDir, "Runner", "Info.plist")));
  assert.ok(keys.has("CFBundleIdentifier"), `Info.plist needs CFBundleIdentifier or the app cannot be signed/launched ${SUBSTITUTE}`);
  assert.ok(keys.has("LSMinimumSystemVersion"), `Info.plist needs LSMinimumSystemVersion so old macOS refuses the app ${SUBSTITUTE}`);
});

test("launcher dart-define keys are all read by the Studio host", () => {
  const plan = planPocketStudioLaunch(
    { sdkRoot, directory: "/proj", port: 8795, workspace: "/proj/.ws" },
    {
      platform: "darwin",
      cwd: "/proj",
      bun: "/usr/bin/bun",
      flutter: "flutter",
      exists: () => true,
      realpath: (p) => p,
    },
  );
  // main.dart only calls PocketStudioConfig.fromEnvironment(); the real String/int/bool.fromEnvironment calls live
  // in the pocket_studio package's studio_config.dart, so assert against the union of both files.
  const dart = read(mainDart) + "\n" + read(configDart);
  const keys = Object.keys(plan.config);
  assert.ok(keys.length > 0, "launcher plan must define at least one dart-define");
  for (const key of keys) {
    assert.ok(dart.includes(`fromEnvironment('${key}'`),
      `launcher dart-define ${key} is never read via fromEnvironment('${key}'...) so macOS would silently ignore it ${SUBSTITUTE}`);
  }
});
