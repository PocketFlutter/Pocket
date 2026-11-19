import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createStudioCodex } from "../../editor/codex.ts";
import { createPreviewManager } from "../../editor/preview.ts";
import { buildStudioCodexContext, startEditor } from "../../editor/server.ts";
import {
  buildGuest,
  inspectGuestFrameworkConventions,
  inspectGuestFrameworkConventionsDetailed,
} from "../build_guest.ts";
import { checkProject } from "../check_project.mjs";
import {
  FRAMEWORK_AGENT_DEVELOPER_INSTRUCTIONS,
  MANAGED_RULES_END,
  MANAGED_RULES_START,
  createStandaloneProject,
  syncExistingProjectAgents,
} from "../create_project.mjs";
import { resolveNativeProbePath } from "../native_probe_path.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const repoRoot = resolve(sdkRoot, "..");
const createProjectScript = join(sdkRoot, "scripts/create_project.mjs");
const checkProjectScript = join(sdkRoot, "scripts/check_project.mjs");

test("Test 1: Standalone create_project.mjs CLI creation, CLI guards & Web SDK export", () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-create-project-cli-"));
  try {
    const appDir = join(root, "demo-notes");
    const runApp = spawnSync(
      process.execPath,
      [createProjectScript, appDir, "--template=app", "--name=Demo Notes"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(runApp.status, `${runApp.stdout}\n${runApp.stderr}`).toBe(0);

    for (const file of [
      "app.tsx",
      "pocket.json",
      "manifest.json",
      "editor.json",
      "tsconfig.json",
      ".pocket/tsconfig.json",
      "AGENTS.md",
      "CLAUDE.md",
      "package.json",
    ]) {
      expect(existsSync(join(appDir, file)), file).toBe(true);
    }

    const userTsconfig = JSON.parse(readFileSync(join(appDir, "tsconfig.json"), "utf8"));
    expect(userTsconfig.extends).toBe("./.pocket/tsconfig.json");

    const agentsMd = readFileSync(join(appDir, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain(MANAGED_RULES_START);
    expect(agentsMd).toContain(MANAGED_RULES_END);
    expect(agentsMd).toContain("PocketAppShell");
    expect(agentsMd).toContain("createPocketRouter");
    expect(agentsMd).toContain("SkinInput");
    expect(agentsMd).toContain("defineUiSkin");
    expect(agentsMd).toContain("usePocketBackHandler");
    expect(agentsMd).toContain("JS_API_SIGNATURES.md");
    expect(agentsMd).toContain("Demo Notes");

    const claudeMd = readFileSync(join(appDir, "CLAUDE.md"), "utf8");
    expect(claudeMd.startsWith("@AGENTS.md")).toBe(true);
    expect(claudeMd).toContain("<!-- pocket:managed-claude -->");
    expect(claudeMd).toContain("AGENTS.md");

    const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
    expect(pkg.scripts.start).toContain("project_commands.mjs");
    expect(pkg.scripts.build).toContain(" build");
    expect(pkg.scripts["build:web"]).toContain("build:web");
    expect(pkg.scripts.check).toContain(" check");
    expect(pkg.scripts.typecheck).toContain(" typecheck");
    expect(pkg.scripts["editor:status"]).toContain("status");
    expect(pkg.scripts["editor:stop"]).toContain("stop");
    expect(pkg.scripts["sync:agents"]).toContain("sync-agents");

    // Relative directory resolved against INIT_CWD when invoked via npm/bun script wrapper
    const relParent = join(root, "rel-parent");
    mkdirSync(relParent, { recursive: true });
    const runRel = spawnSync(
      process.execPath,
      [createProjectScript, "rel-app", "--template=app"],
      {
        cwd: repoRoot,
        env: { ...process.env, INIT_CWD: relParent },
        encoding: "utf8",
      },
    );
    expect(runRel.status, `${runRel.stdout}\n${runRel.stderr}`).toBe(0);
    expect(existsSync(join(relParent, "rel-app/pocket.json"))).toBe(true);

    const gameDir = join(root, "star-game");
    const runGame = spawnSync(
      process.execPath,
      [createProjectScript, gameDir, "--template=game", "--name=Star Game"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(runGame.status, `${runGame.stdout}\n${runGame.stderr}`).toBe(0);
    expect(readFileSync(join(gameDir, "app.tsx"), "utf8")).toBe(
      readFileSync(join(sdkRoot, "templates/game/app.tsx"), "utf8"),
    );
    const gameAgents = readFileSync(join(gameDir, "AGENTS.md"), "utf8");
    expect(gameAgents).toContain("模板：`game`");
    expect(gameAgents).toContain("Star Game");

    // Non-empty directory fails before overwriting files
    const nonEmptyDir = join(root, "non-empty");
    mkdirSync(nonEmptyDir, { recursive: true });
    writeFileSync(join(nonEmptyDir, "keep.txt"), "keep");
    const runNonEmpty = spawnSync(
      process.execPath,
      [createProjectScript, nonEmptyDir, "--template=app"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(runNonEmpty.status).not.toBe(0);
    expect(readFileSync(join(nonEmptyDir, "keep.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(nonEmptyDir, "pocket.json"))).toBe(false);

    // Invalid template fails before creating directory
    const invalidDir = join(root, "invalid-template");
    const runInvalid = spawnSync(
      process.execPath,
      [createProjectScript, invalidDir, "--template=unknown"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(runInvalid.status).not.toBe(0);
    expect(existsSync(invalidDir)).toBe(false);

    // Missing option value fails cleanly
    const runMissingVal = spawnSync(
      process.execPath,
      [createProjectScript, join(root, "no-val"), "--template"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(runMissingVal.status).not.toBe(0);

    // --id combined with --flutter fails cleanly
    const runFlutterId = spawnSync(
      process.execPath,
      [createProjectScript, join(root, "flutter-id"), "--flutter", "--id=custom"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(runFlutterId.status).not.toBe(0);

    // Failed --flutter / --surfaces=unknown-surface rolls back atomically without leaving target dir
    const badFlutterDir = join(root, "bad-flutter");
    const runBadFlutter = spawnSync(
      process.execPath,
      [createProjectScript, badFlutterDir, "--surfaces=unknown-surface"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(runBadFlutter.status).not.toBe(0);
    expect(existsSync(badFlutterDir)).toBe(false);

    // Web SDK export includes create_project.mjs, check_project.mjs, root AGENTS.md, and dependencies
    const exportedSdk = join(root, "exported-web-sdk");
    const exportRes = spawnSync(
      "bun",
      ["sdk/scripts/export_web_sdk.ts", `--out=${exportedSdk}`],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(exportRes.status, `${exportRes.stdout}\n${exportRes.stderr}`).toBe(0);
    expect(existsSync(join(exportedSdk, "scripts/create_project.mjs"))).toBe(true);
    expect(existsSync(join(exportedSdk, "scripts/check_project.mjs"))).toBe(true);
    expect(existsSync(join(exportedSdk, "AGENTS.md"))).toBe(true);

    const exportedPkg = JSON.parse(readFileSync(join(exportedSdk, "package.json"), "utf8"));
    expect(exportedPkg.scripts.create).toBe("node scripts/create_project.mjs");
    expect(exportedPkg.scripts["sync:agents"]).toBe("node scripts/create_project.mjs --sync-agents");
    expect(exportedPkg.scripts.check).toBe("node scripts/check_project.mjs");
    expect(exportedPkg.dependencies.typescript).toBe("5.9.3");
    expect(exportedPkg.dependencies["solid-js"]).toBe("1.9.14");

    const exportedApp = join(root, "exported-app");
    const runExportedCreate = spawnSync(
      process.execPath,
      [join(exportedSdk, "scripts/create_project.mjs"), exportedApp, "--name=Exported Notes"],
      { cwd: exportedSdk, encoding: "utf8" },
    );
    expect(
      runExportedCreate.status,
      `${runExportedCreate.stdout}\n${runExportedCreate.stderr}`,
    ).toBe(0);
    expect(existsSync(join(exportedApp, "app.tsx"))).toBe(true);
    expect(existsSync(join(exportedApp, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(exportedApp, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(exportedApp, ".pocket/tsconfig.json"))).toBe(true);
    expect(readFileSync(join(exportedApp, "AGENTS.md"), "utf8")).toContain("Exported Notes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);

test("Test 2: --sync-agents, check_project.mjs & tsc typechecking", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-sync-agents-test-"));
  try {
    const legacyDir = join(root, "legacy-app");
    await createStandaloneProject(legacyDir, { name: "Legacy App", template: "app" });
    const originalAppTsx = readFileSync(join(legacyDir, "app.tsx"), "utf8");

    unlinkSync(join(legacyDir, "AGENTS.md"));
    unlinkSync(join(legacyDir, "CLAUDE.md"));
    rmSync(join(legacyDir, ".pocket"), { recursive: true, force: true });
    // Replace tsconfig.json with the old bare 6-key legacy tsconfig
    writeFileSync(
      join(legacyDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "bundler",
            jsx: "preserve",
            jsxImportSource: "solid-js",
            strict: true,
          },
        },
        null,
        2,
      ) + "\n",
    );
    const legacyPkg = JSON.parse(readFileSync(join(legacyDir, "package.json"), "utf8"));
    delete legacyPkg.scripts["sync:agents"];
    delete legacyPkg.scripts.check;
    delete legacyPkg.scripts.typecheck;
    writeFileSync(join(legacyDir, "package.json"), JSON.stringify(legacyPkg, null, 2) + "\n");

    const syncRes = spawnSync(
      process.execPath,
      [createProjectScript, "--sync-agents", legacyDir],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(syncRes.status, `${syncRes.stdout}\n${syncRes.stderr}`).toBe(0);
    expect(existsSync(join(legacyDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(legacyDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(legacyDir, ".pocket/tsconfig.json"))).toBe(true);
    expect(readFileSync(join(legacyDir, "app.tsx"), "utf8")).toBe(originalAppTsx);

    const tsconfigPath = join(legacyDir, "tsconfig.json");
    const upgradedTsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    expect(upgradedTsconfig.extends).toBe("./.pocket/tsconfig.json");

    writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          extends: "./.pocket/tsconfig.json",
          include: ["app.tsx", "custom.ts"],
        },
        null,
        2,
      ) + "\n",
    );

    const updatedPkg = JSON.parse(readFileSync(join(legacyDir, "package.json"), "utf8"));
    expect(updatedPkg.scripts["sync:agents"]).toContain("sync-agents");
    expect(updatedPkg.scripts.check).toContain(" check");
    expect(updatedPkg.scripts.typecheck).toContain(" typecheck");

    // Append custom section outside markers and re-run --sync-agents
    const agentsPath = join(legacyDir, "AGENTS.md");
    writeFileSync(
      agentsPath,
      `${readFileSync(agentsPath, "utf8")}\n## Custom Project Rule\nKeep Foo.\n`,
    );
    syncExistingProjectAgents(legacyDir);
    const preservedTsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    expect(preservedTsconfig.include).toEqual(["app.tsx", "custom.ts"]);
    const resyncedAgents = readFileSync(agentsPath, "utf8");
    expect(resyncedAgents).toContain("## Custom Project Rule\nKeep Foo.");
    expect(resyncedAgents).toContain(MANAGED_RULES_START);
    expect(resyncedAgents).toContain(MANAGED_RULES_END);

    // Partial marker corruption (MANAGED_RULES_START without MANAGED_RULES_END) heals cleanly
    writeFileSync(
      agentsPath,
      `# Corrupt Header\n\n${MANAGED_RULES_START}\nold partial managed block\n`,
    );
    syncExistingProjectAgents(legacyDir);
    const healedAgents = readFileSync(agentsPath, "utf8");
    expect(healedAgents.split(MANAGED_RULES_START).length - 1).toBe(1);
    expect(healedAgents.split(MANAGED_RULES_END).length - 1).toBe(1);

    // Sub-project whose parent happens to have pubspec.yaml is NOT misdetected as Flutter unless named "js"
    const parentWithPubspec = join(root, "monorepo-with-pubspec");
    const subApp = join(parentWithPubspec, "sub-app");
    mkdirSync(parentWithPubspec, { recursive: true });
    writeFileSync(join(parentWithPubspec, "pubspec.yaml"), "name: unrelated_parent\n");
    await createStandaloneProject(subApp, { name: "Sub App", template: "app" });
    expect(readFileSync(join(subApp, "AGENTS.md"), "utf8")).not.toContain("本项目包含 `flutter/` 原生宿主");

    // First-layer Flutter checkout (pubspec.yaml + js/pocket.json) resolves into js/ automatically
    const flutterRoot = join(root, "flutter-checkout");
    mkdirSync(join(flutterRoot, "js"), { recursive: true });
    writeFileSync(join(flutterRoot, "pubspec.yaml"), "name: flutter_host\n");
    writeFileSync(
      join(flutterRoot, "js/pocket.json"),
      JSON.stringify({ id: "dev.pocketjs.flutterhost", title: "Flutter Host App" }, null, 2) + "\n",
    );
    const resolved = syncExistingProjectAgents(flutterRoot);
    expect(resolved.project).toBe(join(flutterRoot, "js"));
    expect(existsSync(join(flutterRoot, "js/AGENTS.md"))).toBe(true);
    expect(existsSync(join(flutterRoot, "js/CLAUDE.md"))).toBe(true);
    expect(readFileSync(join(flutterRoot, "js/AGENTS.md"), "utf8")).toContain("Flutter Host App");
    expect(readFileSync(join(flutterRoot, "js/AGENTS.md"), "utf8")).toContain("本项目包含 `flutter/` 原生宿主");

    // checkProject passes cleanly (0 TS errors, 0 convention errors/warnings) on app and game starters
    const appCheck = checkProject(legacyDir);
    expect(appCheck.ok, JSON.stringify(appCheck)).toBe(true);
    expect(appCheck.tsErrors).toEqual([]);
    expect(appCheck.conventionErrors).toEqual([]);
    expect(appCheck.conventionWarnings).toEqual([]);

    const gameDir = join(root, "check-game");
    await createStandaloneProject(gameDir, { name: "Check Game", template: "game" });
    const cliGameCheck = spawnSync(
      process.execPath,
      [checkProjectScript, gameDir],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(cliGameCheck.status, `${cliGameCheck.stdout}\n${cliGameCheck.stderr}`).toBe(0);

    // Invalid TS prop + HTML/DOM JSX + browser global fail checkProject
    const badTsDir = join(root, "bad-ts-app");
    await createStandaloneProject(badTsDir, { name: "Bad TS App", template: "app" });
    writeFileSync(
      join(badTsDir, "app.tsx"),
      [
        'import { SkinCard } from "@pocket/ui";',
        "export function BadTs() {",
        "  const u = window.location.href;",
        "  return <div><SkinCard bogusProp={123} />{u}</div>;",
        "}",
      ].join("\n"),
    );
    const badCheck = checkProject(badTsDir);
    expect(badCheck.ok).toBe(false);
    expect(badCheck.tsErrors.length).toBeGreaterThan(0);
    expect(badCheck.tsErrors.some((e) => e.includes("bogusProp"))).toBe(true);
    expect(badCheck.conventionErrors.some((e) => e.includes("HTML/DOM JSX tag"))).toBe(true);
    expect(badCheck.conventionErrors.some((e) => e.includes("detected browser DOM/history/storage global"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);

test("Test 3: inspectGuestFrameworkConventionsDetailed & buildGuest strict vs warn gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-framework-hints-test-"));
  try {
    const cleanApp = join(root, "clean-app");
    await createStandaloneProject(cleanApp, { name: "Clean App", template: "app" });
    expect(inspectGuestFrameworkConventions(cleanApp, "app.tsx")).toEqual([]);
    expect(inspectGuestFrameworkConventionsDetailed(cleanApp, "app.tsx")).toEqual({
      errors: [],
      warnings: [],
      all: [],
    });

    // Comments and string literals mentioning HTML/DOM or window.location do NOT trigger false positives
    writeFileSync(
      join(cleanApp, "helper.ts"),
      [
        "// <div> window.location.href document.getElementById('x')",
        '/* <button>localStorage.getItem("k")</button> */',
        'export const sample = "<div>window.location.href</div>";',
      ].join("\n"),
    );
    expect(inspectGuestFrameworkConventionsDetailed(cleanApp, "app.tsx")).toEqual({
      errors: [],
      warnings: [],
      all: [],
    });

    // Multi-branch <Show when={tab() === ...}> without PocketAppShell/RouteView emits a router warning
    const showRouterApp = join(root, "show-router-app");
    await createStandaloneProject(showRouterApp, { name: "Show Router App", template: "app" });
    writeFileSync(
      join(showRouterApp, "app.tsx"),
      [
        'import { Show, createSignal } from "solid-js";',
        'import { View, Text } from "@pocketjs/framework/solid/components";',
        "export function App() {",
        '  const [tab] = createSignal("a");',
        "  return (",
        "    <View>",
        '      <Show when={tab() === "a"}><View><Text text="A" /></View></Show>',
        '      <Show when={tab() === "b"}><View><Text text="B" /></View></Show>',
        "    </View>",
        "  );",
        "}",
      ].join("\n"),
    );
    const showRouterReport = inspectGuestFrameworkConventionsDetailed(showRouterApp, "app.tsx");
    expect(showRouterReport.errors).toEqual([]);
    expect(
      showRouterReport.warnings.some((line) =>
        line.includes("detected <Show>/<Match>/<Dynamic> page switching"),
      ),
    ).toBe(true);

    // AGENTS.md without MANAGED_RULES_START emits a warning even if parent directory has AGENTS.md
    writeFileSync(join(root, "AGENTS.md"), "# Unrelated parent AGENTS.md\n");
    writeFileSync(join(showRouterApp, "AGENTS.md"), "# Hand-written AGENTS without managed block\n");
    const unmanagedAgentsReport = inspectGuestFrameworkConventionsDetailed(showRouterApp, "app.tsx");
    expect(
      unmanagedAgentsReport.warnings.some((line) =>
        line.includes("is missing the managed Pocket framework rules block"),
      ),
    ).toBe(true);

    // Bad app with hard errors (HTML tag + browser global)
    const badApp = join(root, "bad-app");
    await createStandaloneProject(badApp, { name: "Bad App", template: "app" });
    unlinkSync(join(badApp, "AGENTS.md"));
    writeFileSync(
      join(badApp, "app.tsx"),
      [
        'import { Show, createSignal } from "solid-js";',
        'import { MobileScaffold } from "@pocket/ui";',
        "export function BadView() {",
        '  const [page] = createSignal("home");',
        "  const href = window.location.href;",
        '  const el = document.getElementById("root");',
        "  return (",
        "    <div>",
        "      <button>{href}{String(el)}</button>",
        '      <Show when={page() === "home"}>',
        "        <MobileScaffold />",
        "      </Show>",
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
    );

    const detailed = inspectGuestFrameworkConventionsDetailed(badApp, "app.tsx");
    expect(detailed.errors.some((line) => line.includes("detected HTML/DOM JSX tag"))).toBe(true);
    expect(detailed.errors.some((line) => line.includes("detected browser DOM/history/storage global"))).toBe(
      true,
    );
    expect(
      detailed.warnings.some((line) =>
        line.includes("detected <Show>/<Match>/<Dynamic> page switching"),
      ),
    ).toBe(true);
    expect(detailed.warnings.some((line) => line.includes("Missing AGENTS.md"))).toBe(true);

    // buildGuest rejects in default strict mode when hard convention errors exist
    await expect(
      buildGuest({
        projectRoot: badApp,
        outDir: join(root, "bad-out-strict"),
      }),
    ).rejects.toThrow(/disallowed browser DOM\/HTML constructs/);

    // Setting conventions: "warn" in editor.json downgrades hard errors to [pocket-agent-hint] logs
    const editorJson = JSON.parse(readFileSync(join(badApp, "editor.json"), "utf8"));
    editorJson.conventions = "warn";
    writeFileSync(join(badApp, "editor.json"), JSON.stringify(editorJson, null, 2) + "\n");
    const warnLogs: string[] = [];
    await buildGuest({
      projectRoot: badApp,
      outDir: join(root, "bad-out-warn"),
      log: (line) => warnLogs.push(line),
    });
    expect(warnLogs.some((line) => line.includes("[pocket-agent-hint]"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);

test("Test 4: Real buildGuest + native pocket_probe Preview runtime execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-create-app-preview-"));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  try {
    // --- Test 4a: Full interactive walk-through of the created app starter ---
    const projectRoot = join(root, "notes-app");
    const outDir = join(root, "out");
    await createStandaloneProject(projectRoot, { name: "Notes App", template: "app" });

    const logs: string[] = [];
    const built = await buildGuest({
      projectRoot,
      outDir,
      log: (line) => logs.push(line),
    });
    expect(logs.filter((line) => line.includes("[pocket-agent-hint]"))).toEqual([]);

    manager = createPreviewManager({
      probePath: resolveNativeProbePath(sdkRoot),
      projectDirectory: projectRoot,
      width: 390,
      height: 844,
      idleDisposeMs: 60_000,
      artifacts: {
        bytecode: built.bytecode,
        pak: built.pak,
        revision: 1,
        tickHz: 60,
      },
    });

    const projectId = "notes-app";
    const url = (suffix: string) => `http://127.0.0.1/api/projects/${projectId}/preview/${suffix}`;
    const call = (suffix: string, init?: RequestInit) =>
      manager!.handle(new Request(url(suffix), init), projectId, suffix);

    const stream = await call("stream");
    expect(stream.status).toBe(200);
    reader = stream.body?.getReader();
    await reader?.read();

    const snapshot = async () => {
      const response = await call("snapshot");
      expect(response.status).toBe(200);
      const value = (await response.json()) as {
        status: { state: string };
        frame: {
          frame: number;
          ops: Array<{ type: string; text?: string; x: number; y: number; w: number; h: number }>;
          events?: Array<{ name?: string; payload?: Record<string, any>; runtimeToken?: string }>;
        };
      };
      expect(value.status.state).toBe("ready");
      return value.frame;
    };

    const has = (frame: Awaited<ReturnType<typeof snapshot>>, text: string) =>
      frame.ops.some((op) => op.type === "text" && op.text === text);

    const waitFor = async (
      predicate: (frame: Awaited<ReturnType<typeof snapshot>>) => boolean,
      expected: string,
    ) => {
      const deadline = Date.now() + 5_000;
      let frame = await snapshot();
      while (!predicate(frame)) {
        if (Date.now() >= deadline) {
          const texts = frame.ops.filter((op) => op.type === "text").map((op) => op.text);
          throw new Error(`Preview did not reach ${expected}; texts=${JSON.stringify(texts)}`);
        }
        await Bun.sleep(25);
        frame = await snapshot();
      }
      return frame;
    };

    const click = async (text: string) => {
      const frame = await waitFor((f) => has(f, text), `text ${JSON.stringify(text)}`);
      const op = frame.ops.find((item) => item.type === "text" && item.text === text)!;
      for (const phase of ["down", "up"] as const) {
        const res = await call("input", {
          method: "POST",
          body: JSON.stringify({
            type: "pointer",
            phase,
            id: 0,
            x: op.x + op.w / 2,
            y: op.y + op.h / 2,
          }),
        });
        expect(res.status).toBe(200);
      }
    };

    // 1. Initial home frame
    await waitFor(
      (f) =>
        has(f, "你好，PocketJS") &&
        has(f, "首页") &&
        has(f, "设置") &&
        has(f, "新建记录") &&
        has(f, "深色"),
      "initial home frame",
    );

    // 2. Toggle dark/light theme
    await click("深色");
    await waitFor((f) => has(f, "浅色"), "theme switched to dark (浅色 button)");
    await click("浅色");
    await waitFor((f) => has(f, "深色"), "theme switched back to light (深色 button)");

    // 3. Tap "新建记录" -> pushes detail route ("保存并返回" visible, bottom tab "设置" hidden)
    await click("新建记录");
    await waitFor(
      (f) => has(f, "保存并返回") && !has(f, "设置"),
      "pushed detail route",
    );

    // 4. Focus SkinInput, commit IME text "买牛奶", and tap "保存并返回" -> returns to home with new note
    await click("输入事项标题");
    const openFrame = await waitFor(
      (f) => Boolean(f.events?.some((e) => e.name === "textInput.open")),
      "textInput.open after clicking SkinInput",
    );
    const openPayload = openFrame.events!.find((e) => e.name === "textInput.open")!.payload!;
    for (const [name, payload] of [
      [
        "textInput.opened",
        {
          id: openPayload.id,
          editingSession: openPayload.editingSession,
          revision: 0,
          jsRevision: openPayload.jsRevision,
          source: "native",
        },
      ],
      [
        "textInput.edit",
        {
          id: openPayload.id,
          editingSession: openPayload.editingSession,
          text: "买牛奶",
          selectionBase: 3,
          selectionExtent: 3,
          composingBase: -1,
          composingExtent: -1,
          revision: 1,
          jsRevision: openPayload.jsRevision,
          source: "native",
        },
      ],
      [
        "textInput.closed",
        {
          id: openPayload.id,
          editingSession: openPayload.editingSession,
          text: "买牛奶",
          selectionBase: 3,
          selectionExtent: 3,
          composingBase: -1,
          composingExtent: -1,
          revision: 2,
          jsRevision: openPayload.jsRevision,
          source: "native",
        },
      ],
    ] as const) {
      const res = await call("input", {
        method: "POST",
        body: JSON.stringify({
          type: "message",
          message: { type: "event", name, payload },
        }),
      });
      expect(res.status).toBe(200);
    }
    await waitFor((f) => has(f, "买牛奶"), "IME committed 买牛奶 into SkinInput");
    await click("保存并返回");
    await waitFor(
      (f) => has(f, "你好，PocketJS") && has(f, "买牛奶") && has(f, "设置"),
      "saved note 买牛奶 and popped back to home",
    );

    // 5. Switch to "设置" tab, open "规则说明" SkinDialog, and verify platform.back.request closes modal first
    await click("设置");
    await waitFor(
      (f) => has(f, "外观与框架") && has(f, "深色模式") && has(f, "规则说明"),
      "switched to settings route",
    );
    await click("规则说明");
    await waitFor(
      (f) => has(f, "框架优先约束") && has(f, "Close"),
      "opened 规则说明 SkinDialog",
    );
    const modalBackRes = await call("input", {
      method: "POST",
      body: JSON.stringify({
        type: "message",
        message: {
          type: "event",
          name: "platform.back.request",
          payload: { requestId: "back-modal-1" },
        },
      }),
    });
    expect(modalBackRes.status).toBe(200);
    await waitFor(
      (f) => !has(f, "框架优先约束") && has(f, "深色模式"),
      "closed SkinDialog via usePocketBackHandler while staying on settings route",
    );

    // 6. Switch back to "首页" and confirm "买牛奶" note is retained
    await click("首页");
    await waitFor(
      (f) => has(f, "你好，PocketJS") && has(f, "买牛奶"),
      "retained 买牛奶 on home route",
    );

    await reader?.cancel();
    reader = undefined;
    await manager?.dispose();
    manager = undefined;

    // --- Test 4b: Dynamic routes getter retention (A2) + swipe-back stack order (A3) ---
    const dynRoot = join(root, "dyn-routes-app");
    const dynOut = join(root, "dyn-out");
    await createStandaloneProject(dynRoot, { name: "Dyn Routes", template: "app" });
    writeFileSync(
      join(dynRoot, "app.tsx"),
      [
        'import { createSignal } from "solid-js";',
        'import { mount } from "@pocketjs/framework/solid";',
        "import {",
        "  PocketAppShell,",
        "  ScrollablePage,",
        "  SkinButton,",
        "  SkinParagraph,",
        "  UiSkinProvider,",
        "  createPocketRouter,",
        "  usePocketRouter,",
        "  type NavigationItem,",
        "  type PocketRouteDefinition,",
        '} from "@pocket/ui";',
        "",
        'type Route = "home" | "detail" | "settings";',
        "const ROUTES: readonly PocketRouteDefinition<Route>[] = [",
        '  { id: "home", path: "/home", aliases: ["/"], primary: true },',
        '  { id: "detail", path: "/detail" },',
        '  { id: "settings", path: "/settings", primary: true },',
        "];",
        "const TABS: readonly NavigationItem[] = [",
        '  { id: "home", label: "首页", kind: "home" },',
        '  { id: "settings", label: "设置", kind: "settings" },',
        "];",
        "",
        "let settingsMounts = 0;",
        "function HomePage() {",
        "  const router = usePocketRouter<Route>();",
        "  return (",
        '    <ScrollablePage class="px-4 py-4">',
        '      <SkinButton label="去设置" onPress={() => router.navigate("settings")} />',
        "    </ScrollablePage>",
        "  );",
        "}",
        "function DetailPage(props: { onBump: () => void }) {",
        "  return (",
        '    <ScrollablePage class="px-4 py-4 gap-3">',
        '      <SkinParagraph text="详情页顶层" />',
        '      <SkinButton label="递增计数" onPress={props.onBump} />',
        "    </ScrollablePage>",
        "  );",
        "}",
        "function SettingsPage() {",
        "  const router = usePocketRouter<Route>();",
        "  const tag = `settings-mounts:${++settingsMounts}`;",
        "  return (",
        '    <ScrollablePage class="px-4 py-4 gap-3">',
        "      <SkinParagraph text={tag} />",
        '      <SkinButton label="推入详情" onPress={() => router.push("detail")} />',
        "    </ScrollablePage>",
        "  );",
        "}",
        "function App() {",
        "  const [count, setCount] = createSignal(0);",
        '  const router = createPocketRouter<Route>({ routes: ROUTES, fallbackRouteId: "home" });',
        "  return (",
        "    <UiSkinProvider>",
        "      <PocketAppShell",
        "        router={router}",
        "        tabs={TABS}",
        "        routes={[",
        '          { id: "home", title: `首页(${count()})`, render: () => <HomePage /> },',
        "          {",
        '            id: "detail",',
        '            title: "详情",',
        "            showBottomBar: false,",
        "            render: () => <DetailPage onBump={() => setCount((c) => c + 1)} />,",
        "          },",
        '          { id: "settings", title: "设置", render: () => <SettingsPage /> },',
        "        ]}",
        "      />",
        "    </UiSkinProvider>",
        "  );",
        "}",
        "mount(() => <App />);",
      ].join("\n"),
    );

    const dynCheck = checkProject(dynRoot);
    expect(dynCheck.ok, JSON.stringify(dynCheck)).toBe(true);
    const dynBuilt = await buildGuest({ projectRoot: dynRoot, outDir: dynOut });
    manager = createPreviewManager({
      probePath: resolveNativeProbePath(sdkRoot),
      projectDirectory: dynRoot,
      width: 390,
      height: 844,
      idleDisposeMs: 60_000,
      artifacts: {
        bytecode: dynBuilt.bytecode,
        pak: dynBuilt.pak,
        revision: 1,
        tickHz: 60,
      },
    });
    const dynStream = await call("stream");
    expect(dynStream.status).toBe(200);
    reader = dynStream.body?.getReader();
    await reader?.read();

    await click("去设置");
    await waitFor((f) => has(f, "settings-mounts:1"), "mounted settings route once");
    await click("推入详情");
    await waitFor((f) => has(f, "详情页顶层"), "pushed detail from settings");
    await click("递增计数");

    // Swipe-back gesture from detail (index 1 in routes[]) back to settings (index 2 in routes[])
    const sendGesture = async (payload: {
      gestureId: string;
      phase: "start" | "update" | "end";
      dx: number;
      width: number;
      velocity: number;
      progress: number;
    }) => {
      const gestureRes = await call("input", {
        method: "POST",
        body: JSON.stringify({
          type: "message",
          message: {
            type: "event",
            name: "platform.back.gesture",
            payload,
          },
        }),
      });
      expect(gestureRes.status).toBe(200);
    };
    await sendGesture({ gestureId: "g1", phase: "start", dx: 20, width: 390, velocity: 100, progress: 0.05 });
    await sendGesture({ gestureId: "g1", phase: "update", dx: 195, width: 390, velocity: 200, progress: 0.5 });
    const midFrame = await waitFor(
      (f) => has(f, "详情页顶层") && has(f, "settings-mounts:1"),
      "both detail and settings visible during swipe-back",
    );
    expect(
      midFrame.ops.findIndex((op) => op.type === "text" && op.text === "详情页顶层"),
    ).toBeGreaterThan(
      midFrame.ops.findIndex((op) => op.type === "text" && op.text === "settings-mounts:1"),
    );
    await sendGesture({ gestureId: "g1", phase: "end", dx: 270, width: 390, velocity: 600, progress: 0.7 });
    await waitFor(
      (f) => has(f, "settings-mounts:1") && !has(f, "详情页顶层"),
      "completed swipe-back to settings without remounting routes",
    );
  } finally {
    await reader?.cancel();
    await manager?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("Test 5: Studio POST /api/projects, POST /api/projects/open non-mutation & createStudioCodex runtime instructions", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pocket-studio-create-agents-"));
  const server = await startEditor({ port: 0, workspace });
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pocket-editor": "1",
      },
      body: JSON.stringify({
        id: "studio-notes",
        appId: "dev.pocketjs.studionotes",
        name: "Studio Notes",
        title: "Studio Notes",
        version: "0.1.0",
        template: "app",
      }),
    });
    expect(res.status).toBe(201);

    const projectDir = join(workspace, "projects/studio-notes");
    expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(projectDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".pocket/tsconfig.json"))).toBe(true);
    expect(readFileSync(join(projectDir, "AGENTS.md"), "utf8")).toContain("Studio Notes");
    expect(readFileSync(join(projectDir, "AGENTS.md"), "utf8")).toContain("PocketAppShell");

    // Verify POST /api/projects/open does not mutate external project files on disk
    const externalDir = join(workspace, "external-legacy-project");
    await createStandaloneProject(externalDir, { name: "External Legacy", template: "app" });
    unlinkSync(join(externalDir, "AGENTS.md"));
    unlinkSync(join(externalDir, "CLAUDE.md"));

    const openRes = await fetch(`${baseUrl}/api/projects/open`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pocket-editor": "1",
      },
      body: JSON.stringify({ path: externalDir }),
    });
    expect(openRes.status).toBe(200);
    const openedConfig = (await openRes.json()) as { id: string };
    expect(existsSync(join(externalDir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(externalDir, "CLAUDE.md"))).toBe(false);

    const calls: Array<{ method: string; params: any }> = [];
    let notify: ((event: { method: string; params: any }) => void) | undefined;
    const codex = createStudioCodex({
      client: {
        async request(method: string, params: any) {
          calls.push({ method, params });
          if (method === "account/read") {
            return { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
          }
          if (method === "model/list") {
            return {
              data: [
                {
                  id: "m1",
                  model: "test-model",
                  displayName: "Test Model",
                  inputModalities: ["text"],
                  isDefault: true,
                },
              ],
            };
          }
          if (method === "thread/start") return { thread: { id: `thread-${calls.length}` } };
          if (method === "turn/start") return { turn: { id: `turn-${calls.length}` } };
          return {};
        },
        onNotification: (callback) => {
          notify = callback;
          return () => {};
        },
        onExit: () => () => {},
        handleRequests: () => {},
        stop: () => {},
      },
      projectDirectory: (id: string) => (id === openedConfig.id ? externalDir : projectDir),
      resolveContext: (id, scope) =>
        buildStudioCodexContext(id === openedConfig.id ? externalDir : projectDir, sdkRoot, scope),
    });
    try {
      const startAndWaitForTurn = async (
        projectId: string,
        input: { text: string; model: string; scope?: "project" | "sdk" },
      ) => {
        const beforeThreadStarts = calls.filter((c) => c.method === "thread/start").length;
        const beforeTurnStarts = calls.filter((c) => c.method === "turn/start").length;
        const turn = await codex.start(projectId, input);
        const deadline = Date.now() + 1_000;
        while (
          (calls.filter((c) => c.method === "thread/start").length <= beforeThreadStarts ||
            calls.filter((c) => c.method === "turn/start").length <= beforeTurnStarts) &&
          Date.now() < deadline
        ) {
          await Bun.sleep(5);
        }
        const threadStarts = calls.filter((c) => c.method === "thread/start");
        const turnStarts = calls.filter((c) => c.method === "turn/start");
        expect(threadStarts.length).toBeGreaterThan(beforeThreadStarts);
        expect(turnStarts.length).toBeGreaterThan(beforeTurnStarts);
        const threadStart = threadStarts[threadStarts.length - 1]!;
        const turnStart = turnStarts[turnStarts.length - 1]!;
        const turnStartIndex = calls.lastIndexOf(turnStart);
        return {
          turn,
          threadStart,
          threadId: String(turnStart.params.threadId),
          remoteTurnId: `turn-${turnStartIndex + 1}`,
        };
      };

      const completeTurn = async (projectId: string, started: { turn: { id: string }; threadId: string; remoteTurnId: string }) => {
        notify?.({
          method: "turn/completed",
          params: {
            threadId: started.threadId,
            turn: { id: started.remoteTurnId, status: "completed" },
          },
        });
        const deadline = Date.now() + 1_000;
        while (codex.get(projectId, started.turn.id).status !== "completed" && Date.now() < deadline) {
          await Bun.sleep(5);
        }
        expect(codex.get(projectId, started.turn.id).status).toBe("completed");
      };

      const studioTurn = await startAndWaitForTurn("studio-notes", {
        text: "Add a settings card",
        model: "test-model",
      });
      expect(studioTurn.threadStart.params.developerInstructions).toContain(
        FRAMEWORK_AGENT_DEVELOPER_INSTRUCTIONS,
      );

      const externalTurn = await startAndWaitForTurn(openedConfig.id, {
        text: "Add a profile tab",
        model: "test-model",
      });
      expect(externalTurn.threadStart.params.developerInstructions).toContain(
        FRAMEWORK_AGENT_DEVELOPER_INSTRUCTIONS,
      );
      expect(existsSync(join(externalDir, "AGENTS.md"))).toBe(false);
      expect(existsSync(join(externalDir, "CLAUDE.md"))).toBe(false);

      await completeTurn("studio-notes", studioTurn);
      await completeTurn(openedConfig.id, externalTurn);

      // Verify "sdk" scope also includes FRAMEWORK_AGENT_DEVELOPER_INSTRUCTIONS
      const sdkTurn = await startAndWaitForTurn("studio-notes", {
        text: "Inspect guest pages",
        model: "test-model",
        scope: "sdk",
      });
      expect(sdkTurn.threadStart.params.developerInstructions).toContain(
        FRAMEWORK_AGENT_DEVELOPER_INSTRUCTIONS,
      );
      expect(sdkTurn.threadStart.params.developerInstructions).toContain(
        `Read ${projectDir}/AGENTS.md (if present) before editing project files.`,
      );
    } finally {
      await codex.dispose();
    }
  } finally {
    await server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
}, 30_000);
