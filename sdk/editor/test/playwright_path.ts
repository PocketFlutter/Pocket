import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Playwright entry used by browser acceptance tests that load it by file URL.
 * Resolution order: explicit `POCKET_PLAYWRIGHT`, the SDK's pinned
 * `node_modules` install, then the historical reviewer scratch location.
 */
export function resolvePlaywrightPath(): string {
  const explicit = process.env.POCKET_PLAYWRIGHT;
  if (explicit) return explicit;
  const installed = join(resolve(import.meta.dir, "../.."), "node_modules/playwright/index.mjs");
  if (existsSync(installed)) return installed;
  return "/tmp/pocket-playwright-review/node_modules/playwright/index.mjs";
}

/**
 * The Chromium binary an acceptance run actually drives. `executablePath()` is
 * the full Chromium build; headless-only machines (CI, containers) install just
 * the headless shell that `chromium.launch({ headless: true })` uses, so fall
 * back to that binary instead of recording a path that does not exist.
 */
export function resolveChromiumExecutable(chromium: { executablePath(): string }): string {
  const full = chromium.executablePath();
  if (existsSync(full)) return full;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(process.env.HOME ?? "", ".cache/ms-playwright")].filter((value): value is string => Boolean(value));
  for (const root of roots) {
    let entries: string[] = [];
    try { entries = readdirSync(root).filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse(); } catch { continue; }
    for (const entry of entries) {
      const dir = join(root, entry);
      let platforms: string[] = [];
      try { platforms = readdirSync(dir).filter((name) => name.startsWith("chrome-headless-shell-")); } catch { continue; }
      for (const platform of platforms) {
        const candidate = join(dir, platform, "chrome-headless-shell");
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return full;
}
