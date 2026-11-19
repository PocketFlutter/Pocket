#!/usr/bin/env node
/**
 * Plain-Node ESM project typechecker and framework convention inspector for PocketJS.
 *
 * Generates and maintains `<projectRoot>/.pocket/tsconfig.json`, runs TypeScript
 * pre-emit diagnostics against the pinned `@pocketjs/framework` and SDK workspace
 * packages, and checks guest sources for guaranteed browser DOM/HTML errors and
 * framework convention warnings.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePrebuiltTools } from "./prebuilt_tools.mjs";

const defaultSdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const MANAGED_RULES_START = "<!-- pocket:framework-rules:start -->";
export const MANAGED_RULES_END = "<!-- pocket:framework-rules:end -->";

const EXCLUDED_HINT_DIRS = new Set([
  "node_modules",
  "vendor",
  "build",
  "dist",
  ".pocket",
  ".pocket-build",
  ".cache",
  "flutter",
  "test",
  "tests",
]);

function readJsonSafe(path) {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function canonicalPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function selectExportTarget(target) {
  if (typeof target === "string") return target;
  if (target && typeof target === "object" && !Array.isArray(target)) {
    const candidate = target.types ?? target.default ?? target.import;
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

export function resolveProjectDirectory(directory) {
  const raw = resolve(directory);
  if (existsSync(join(raw, "pubspec.yaml")) && existsSync(join(raw, "js/pocket.json"))) {
    return join(raw, "js");
  }
  return raw;
}

export function resolveCompilerRoot(sdkRoot = defaultSdkRoot) {
  const sdk = resolve(sdkRoot);
  const cached = join(sdk, ".cache/pocketjs");
  if (process.env.POCKET_SOURCE_BUILD === "1") {
    if (existsSync(cached)) return cached;
  }
  try {
    const tools = resolvePrebuiltTools(sdk);
    if (tools?.compiler && existsSync(tools.compiler)) {
      return tools.compiler;
    }
  } catch {
    // Fall back to local .cache/pocketjs when prebuilt tools are not installed.
  }
  if (existsSync(cached)) return cached;
  return undefined;
}

export function buildManagedTsconfigData(projectRoot, sdkRoot = defaultSdkRoot) {
  const sdk = resolve(sdkRoot);
  const paths = {};

  // 1. Workspace packages under <sdkRoot>/packages
  const packagesRoot = join(sdk, "packages");
  if (existsSync(packagesRoot)) {
    let entries = [];
    try {
      entries = readdirSync(packagesRoot, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgDir = join(packagesRoot, entry.name);
      const pkgJson = readJsonSafe(join(pkgDir, "package.json"));
      if (!pkgJson || typeof pkgJson.name !== "string" || !pkgJson.name.trim()) continue;
      const pkgName = pkgJson.name.trim();
      const exportsMap = pkgJson.exports;
      let hasWildcard = false;
      if (exportsMap && typeof exportsMap === "object" && !Array.isArray(exportsMap)) {
        for (const [sub, rawTarget] of Object.entries(exportsMap)) {
          const targetRel = selectExportTarget(rawTarget);
          if (!targetRel) continue;
          const key =
            sub === "."
              ? pkgName
              : sub.startsWith("./")
                ? `${pkgName}/${sub.slice(2)}`
                : `${pkgName}/${sub}`;
          if (key === `${pkgName}/*`) hasWildcard = true;
          paths[key] = [resolve(pkgDir, targetRel)];
        }
      }
      if (!hasWildcard && existsSync(join(pkgDir, "src"))) {
        paths[`${pkgName}/*`] = [resolve(pkgDir, "src/*")];
      }
    }
  }

  // 2. solid-js types under <sdkRoot>/node_modules/solid-js (or compiler root fallback)
  const fwRoot = resolveCompilerRoot(sdk);
  const solidRootCandidates = [
    join(sdk, "node_modules/solid-js"),
    ...(fwRoot ? [join(fwRoot, "node_modules/solid-js")] : []),
  ];
  for (const solidRoot of solidRootCandidates) {
    const solidTypesIndex = join(solidRoot, "types/index.d.ts");
    if (existsSync(solidTypesIndex)) {
      paths["solid-js"] = [resolve(solidTypesIndex)];
      paths["solid-js/*"] = [resolve(solidRoot, "*/types/index.d.ts")];
      break;
    }
  }

  // 3. @pocketjs/framework exports from fwRoot
  if (fwRoot && existsSync(join(fwRoot, "package.json"))) {
    const fwPkg = readJsonSafe(join(fwRoot, "package.json"));
    const fwExports = fwPkg?.exports;
    if (fwExports && typeof fwExports === "object" && !Array.isArray(fwExports)) {
      for (const [sub, rawTarget] of Object.entries(fwExports)) {
        if (
          sub === "./vue-vapor" ||
          sub.startsWith("./vue-vapor/") ||
          sub === "./octane" ||
          sub.startsWith("./octane/")
        ) {
          continue;
        }
        const targetRel = selectExportTarget(rawTarget);
        if (!targetRel) continue;
        const resolvedTarget = resolve(fwRoot, targetRel);
        const key =
          sub === "."
            ? "@pocketjs/framework"
            : sub.startsWith("./")
              ? `@pocketjs/framework/${sub.slice(2)}`
              : `@pocketjs/framework/${sub}`;
        paths[key] = [resolvedTarget];

        if (
          sub !== "." &&
          sub !== "./solid" &&
          !sub.startsWith("./solid/") &&
          sub !== "./worker" &&
          !sub.startsWith("./worker/") &&
          sub !== "./io" &&
          !sub.startsWith("./io/") &&
          sub.startsWith("./")
        ) {
          const solidSub = `./solid/${sub.slice(2)}`;
          if (!(solidSub in fwExports)) {
            paths[`@pocketjs/framework/solid/${sub.slice(2)}`] = [resolvedTarget];
          }
        }
      }
    }
  }

  const include = ["../**/*.ts", "../**/*.tsx"];
  const files = [];
  if (fwRoot) {
    for (const relDecl of ["framework/src/jsx.d.ts", "framework/compiler/app-globals.d.ts"]) {
      const fullDecl = resolve(fwRoot, relDecl);
      if (existsSync(fullDecl)) {
        files.push(fullDecl);
      }
    }
  }

  const exclude = [
    "../node_modules",
    "../build",
    "../.pocket",
    "../.pocket-build",
    "../flutter",
    "../vendor",
    "../test",
    "../tests",
  ];

  return {
    tsconfig: {
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2023"],
        types: [],
        strict: true,
        noEmit: true,
        jsx: "preserve",
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        paths,
      },
      ...(files.length > 0 ? { files } : {}),
      include,
      exclude,
    },
    fwRoot,
    declFiles: files,
  };
}

export function writeManagedProjectTsconfig(projectRoot, sdkRoot = defaultSdkRoot) {
  const project = resolve(projectRoot);
  const sdk = resolve(sdkRoot);
  const { tsconfig, fwRoot, declFiles } = buildManagedTsconfigData(project, sdk);
  const pocketDir = join(project, ".pocket");
  const tsconfigPath = join(pocketDir, "tsconfig.json");
  const serialized = JSON.stringify(tsconfig, null, 2) + "\n";
  const current = existsSync(tsconfigPath) ? readFileSync(tsconfigPath, "utf8") : undefined;
  if (current !== serialized) {
    mkdirSync(pocketDir, { recursive: true });
    writeFileSync(tsconfigPath, serialized);
  }
  return { tsconfigPath, fwRoot, declFiles };
}

/**
 * Replaces the contents of single/double-quoted strings, line comments, block
 * comments, and non-`${...}` template literal text chunks with spaces while
 * preserving newlines (`\n`) and keeping `${...}` template expression bodies intact.
 */
export function stripCommentsAndStrings(source) {
  const len = source.length;
  const out = new Array(len);
  let i = 0;
  // Stack of brace depths for nested template `${ ... }` expressions.
  const templateBraceDepths = [];

  const blankChar = (ch) => (ch === "\n" || ch === "\r" ? ch : " ");

  const consumeTemplateText = () => {
    while (i < len) {
      const ch = source[i];
      if (ch === "\\") {
        out[i] = " ";
        i++;
        if (i < len) {
          out[i] = blankChar(source[i]);
          i++;
        }
        continue;
      }
      if (ch === "`") {
        out[i] = "`";
        i++;
        return;
      }
      if (ch === "$" && i + 1 < len && source[i + 1] === "{") {
        out[i] = " ";
        out[i + 1] = "{";
        i += 2;
        templateBraceDepths.push(1);
        return;
      }
      out[i] = blankChar(ch);
      i++;
    }
  };

  while (i < len) {
    const ch = source[i];
    const next = i + 1 < len ? source[i + 1] : "";

    // Line comment //
    if (ch === "/" && next === "/") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < len && source[i] !== "\n") {
        out[i] = source[i] === "\r" ? "\r" : " ";
        i++;
      }
      continue;
    }

    // Block comment /* ... */
    if (ch === "/" && next === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < len) {
        if (source[i] === "*" && i + 1 < len && source[i + 1] === "/") {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
          break;
        }
        out[i] = blankChar(source[i]);
        i++;
      }
      continue;
    }

    // Single-quoted or double-quoted string
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out[i] = quote;
      i++;
      while (i < len) {
        const c = source[i];
        if (c === "\\") {
          out[i] = " ";
          i++;
          if (i < len) {
            out[i] = blankChar(source[i]);
            i++;
          }
          continue;
        }
        if (c === quote) {
          out[i] = quote;
          i++;
          break;
        }
        if (c === "\n" || c === "\r") {
          out[i] = c;
          i++;
          break;
        }
        out[i] = " ";
        i++;
      }
      continue;
    }

    // Template literal start `
    if (ch === "`") {
      out[i] = "`";
      i++;
      consumeTemplateText();
      continue;
    }

    // Inside a `${ ... }` template expression body
    if (templateBraceDepths.length > 0) {
      if (ch === "{") {
        templateBraceDepths[templateBraceDepths.length - 1]++;
        out[i] = ch;
        i++;
        continue;
      }
      if (ch === "}") {
        const topIdx = templateBraceDepths.length - 1;
        templateBraceDepths[topIdx]--;
        out[i] = ch;
        i++;
        if (templateBraceDepths[topIdx] === 0) {
          templateBraceDepths.pop();
          consumeTemplateText();
        }
        continue;
      }
    }

    out[i] = ch;
    i++;
  }

  return out.join("");
}

const HTML_DOM_TAG_RE =
  /<(?:div|span|button|input|textarea|select|form|label|p|h[1-6]|ul|ol|li|a|img|svg|canvas|video|audio|table|thead|tbody|tr|td|th|iframe|section|article|aside|header|footer|main|nav|br|hr)(?=[\s/>])/;

const BROWSER_GLOBAL_RE =
  /\b(?:document\.(?:getElementById|querySelector|querySelectorAll|createElement|body|documentElement|cookie|addEventListener)|window\.(?:location|history|localStorage|sessionStorage|navigator|addEventListener|open|alert|confirm|prompt|requestAnimationFrame)|localStorage\.|sessionStorage\.|navigator\.(?:userAgent|clipboard|geolocation)|history\.(?:pushState|replaceState|back|forward))\b|\balert\s*\(/;

export function inspectGuestFrameworkConventionsDetailed(projectRoot, entryRelative) {
  const resolvedRoot = resolve(projectRoot);
  const errors = [];
  const warnings = [];
  const files = new Set();

  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of entries) {
      if (item.name.startsWith(".")) continue;
      const fullPath = join(dir, item.name);
      if (item.isDirectory()) {
        if (EXCLUDED_HINT_DIRS.has(item.name)) continue;
        walk(fullPath, depth + 1);
      } else if (
        item.isFile() &&
        (item.name.endsWith(".ts") || item.name.endsWith(".tsx")) &&
        !item.name.endsWith(".d.ts")
      ) {
        files.add(resolve(fullPath));
      }
    }
  };

  walk(resolvedRoot, 0);
  if (entryRelative) {
    const entryFull = resolve(resolvedRoot, entryRelative);
    if (existsSync(entryFull)) {
      try {
        if (lstatSync(entryFull).isFile()) files.add(entryFull);
      } catch {
        // Ignore unreadable entry path here.
      }
    }
  }

  const sortedFiles = [...files].sort((a, b) => a.localeCompare(b));
  for (const filePath of sortedFiles) {
    let source;
    try {
      source = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const rel = relative(resolvedRoot, filePath).replaceAll("\\", "/");
    const stripped = stripCommentsAndStrings(source);

    if (HTML_DOM_TAG_RE.test(stripped)) {
      errors.push(
        `[pocket-agent-hint] [error] ${rel}: detected HTML/DOM JSX tag; PocketJS renders View/Text/Image/Surface only. Use @pocket/ui (PocketAppShell, SkinScaffold, ScrollablePage, InputField/SkinInput, SkinButton) first.`,
      );
    }
    if (BROWSER_GLOBAL_RE.test(stripped)) {
      errors.push(
        `[pocket-agent-hint] [error] ${rel}: detected browser DOM/history/storage global; QuickJS guests have no DOM or window.history. Use createPocketRouter + PocketAppShell (@pocket/ui) and HostBridge.`,
      );
    }

    if (
      !rel.startsWith("surfaces/") &&
      !stripped.includes("createPocketRouter") &&
      !stripped.includes("PocketAppShell") &&
      !stripped.includes("RouteView") &&
      !stripped.includes("ProjectSurfaceRoot")
    ) {
      const wrapsScaffold =
        /(?:<Show|<Match)\b[^>]*>[\s\S]{0,240}<(?:MobileScaffold|SafeAreaScaffold|SkinScaffold)\b/.test(
          stripped,
        );
      const equalityBranches =
        stripped.match(/<(?:Show|Match)\b[^>]*\bwhen=\{[^}]*===[^}]*\}/g) ?? [];
      const hasDynamicPage = /<Dynamic\b[^>]*\bcomponent=\{/.test(stripped);

      if (wrapsScaffold || equalityBranches.length >= 2 || hasDynamicPage) {
        warnings.push(
          `[pocket-agent-hint] ${rel}: detected <Show>/<Match>/<Dynamic> page switching without createPocketRouter/PocketAppShell/RouteView; unmounting pages resets scroll offsets, IME sessions, and local state. Use createPocketRouter + PocketAppShell (or retained <RouteView>) from @pocket/ui.`,
        );
      }
    }
  }

  if (existsSync(join(resolvedRoot, "editor.json"))) {
    const localAgents = join(resolvedRoot, "AGENTS.md");
    const parentFlutterAgents =
      basename(resolvedRoot) === "js" && existsSync(join(resolvedRoot, "../pubspec.yaml"))
        ? join(resolvedRoot, "../AGENTS.md")
        : undefined;
    const agentsPath = existsSync(localAgents)
      ? localAgents
      : parentFlutterAgents && existsSync(parentFlutterAgents)
        ? parentFlutterAgents
        : undefined;

    if (!agentsPath) {
      warnings.push(
        `[pocket-agent-hint] Missing AGENTS.md in ${resolvedRoot}; run "npm run sync:agents" (or "node ${join(defaultSdkRoot, "scripts/create_project.mjs")} --sync-agents ${resolvedRoot}") so AI agents use Pocket's built-in framework.`,
      );
    } else {
      let agentsContent = "";
      try {
        agentsContent = readFileSync(agentsPath, "utf8");
      } catch {
        agentsContent = "";
      }
      if (!agentsContent.includes(MANAGED_RULES_START)) {
        warnings.push(
          `[pocket-agent-hint] AGENTS.md in ${resolvedRoot} is missing the managed Pocket framework rules block (${MANAGED_RULES_START}); run "npm run sync:agents" to synchronize framework conventions.`,
        );
      }
    }
  }

  return {
    errors,
    warnings,
    all: [...errors, ...warnings],
  };
}

export function inspectGuestFrameworkConventions(projectRoot, entryRelative) {
  return inspectGuestFrameworkConventionsDetailed(projectRoot, entryRelative).all;
}

function isInsideProjectGuestSources(filePath, canonicalProject) {
  const canonicalFile = canonicalPath(filePath);
  const prefix = canonicalProject.endsWith(sep) ? canonicalProject : canonicalProject + sep;
  if (!canonicalFile.startsWith(prefix)) return false;
  const rel = canonicalFile.slice(prefix.length).replaceAll("\\", "/");
  const firstSegment = rel.split("/")[0];
  if (EXCLUDED_HINT_DIRS.has(firstSegment)) return false;
  return true;
}

function formatTsDiagnostic(ts, diag, projectRoot) {
  const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
  if (!diag.file || typeof diag.start !== "number") {
    return `TS${diag.code}: ${message}`;
  }
  const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
  const rel = relative(projectRoot, diag.file.fileName).replaceAll("\\", "/");
  return `${rel}:${pos.line + 1}:${pos.character + 1} - error TS${diag.code}: ${message}`;
}

export function checkProject(
  directory,
  { sdkRoot, typecheckOnly = false, warnOnly = false } = {},
) {
  const fallbackDir = process.env.INIT_CWD ? resolve(process.env.INIT_CWD) : process.cwd();
  const project = resolveProjectDirectory(directory || fallbackDir);
  const sdk = resolve(sdkRoot ?? defaultSdkRoot);

  if (!existsSync(project) || !lstatSync(project).isDirectory()) {
    throw new Error(`project directory does not exist: ${project}`);
  }
  const editorDoc = readJsonSafe(join(project, "editor.json")) ?? {};
  const pocketDoc = readJsonSafe(join(project, "pocket.json")) ?? {};
  if (!existsSync(join(project, "editor.json")) && !existsSync(join(project, "pocket.json"))) {
    throw new Error(`not a Pocket project (missing pocket.json / editor.json): ${project}`);
  }

  const entryRel =
    (typeof editorDoc.entry === "string" && editorDoc.entry.trim()) ||
    (pocketDoc.app &&
      typeof pocketDoc.app === "object" &&
      typeof pocketDoc.app.entry === "string" &&
      pocketDoc.app.entry.trim()) ||
    "app.tsx";

  const { tsconfigPath: managedTsconfigPath, fwRoot, declFiles } = writeManagedProjectTsconfig(project, sdk);

  let ts;
  const reqCandidates = [
    join(sdk, "package.json"),
    ...(fwRoot && existsSync(join(fwRoot, "package.json")) ? [join(fwRoot, "package.json")] : []),
  ];
  for (const pkgPath of reqCandidates) {
    if (!existsSync(pkgPath)) continue;
    try {
      ts = createRequire(pkgPath)("typescript");
      break;
    } catch {
      // Try next candidate
    }
  }

  const tsErrors = [];
  if (!ts) {
    const msg = `TypeScript is not installed under ${sdk}; run "npm run setup" to enable typechecking.`;
    if (typecheckOnly) {
      throw new Error(msg);
    }
    tsErrors.push(msg);
  } else {
    const userTsconfigPath = join(project, "tsconfig.json");
    const activeConfigPath = existsSync(userTsconfigPath) ? userTsconfigPath : managedTsconfigPath;
    const readResult = ts.readConfigFile(activeConfigPath, ts.sys.readFile);
    if (readResult.error) {
      tsErrors.push(formatTsDiagnostic(ts, readResult.error, project));
    } else {
      const parsed = ts.parseJsonConfigFileContent(
        readResult.config,
        ts.sys,
        dirname(activeConfigPath),
        undefined,
        activeConfigPath,
      );
      const canonicalProject = canonicalPath(project);
      for (const diag of parsed.errors) {
        if (!diag.file || isInsideProjectGuestSources(diag.file.fileName, canonicalProject)) {
          tsErrors.push(formatTsDiagnostic(ts, diag, project));
        }
      }
      const program = ts.createProgram({
        rootNames: [...new Set([...parsed.fileNames, ...declFiles])],
        options: { ...parsed.options, noEmit: true },
      });
      const diagnostics = ts.getPreEmitDiagnostics(program);
      for (const diag of diagnostics) {
        if (diag.category !== ts.DiagnosticCategory.Error) continue;
        if (!diag.file) {
          tsErrors.push(formatTsDiagnostic(ts, diag, project));
          continue;
        }
        if (isInsideProjectGuestSources(diag.file.fileName, canonicalProject)) {
          tsErrors.push(formatTsDiagnostic(ts, diag, project));
        }
      }
    }
  }

  const conventions = typecheckOnly
    ? { errors: [], warnings: [], all: [] }
    : inspectGuestFrameworkConventionsDetailed(project, entryRel);

  const conventionsMode =
    editorDoc.conventions === "off" || editorDoc.conventions === "warn"
      ? editorDoc.conventions
      : "strict";

  const ok =
    tsErrors.length === 0 &&
    (typecheckOnly || warnOnly || conventionsMode !== "strict" || conventions.errors.length === 0);

  return {
    ok,
    project,
    tsErrors,
    conventionErrors: conventions.errors,
    conventionWarnings: conventions.warnings,
    conventionsMode,
  };
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node check_project.mjs [<directory>] [options]",
      "",
      "Options:",
      "  --sdk-root=DIR          Override Pocket SDK root directory",
      "  --typecheck-only        Run TypeScript pre-emit typecheck only",
      "  --warn-only             Report convention errors as non-fatal warnings",
      "  --help, -h              Show this help message",
    ].join("\n"),
  );
}

if (
  process.argv[1] &&
  canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))
) {
  try {
    const rawArgs = process.argv.slice(2);
    const invokeCwd = process.env.INIT_CWD ? resolve(process.env.INIT_CWD) : process.cwd();
    const positionals = [];
    let sdkRoot;
    let typecheckOnly = false;
    let warnOnly = false;

    for (let i = 0; i < rawArgs.length; i++) {
      const arg = rawArgs[i];
      if (arg === "--help" || arg === "-h") {
        printUsage();
        process.exit(0);
      } else if (arg === "--typecheck-only") {
        typecheckOnly = true;
      } else if (arg === "--warn-only") {
        warnOnly = true;
      } else if (arg.startsWith("--sdk-root=")) {
        const val = arg.slice("--sdk-root=".length);
        if (!val) throw new Error("--sdk-root requires a value");
        sdkRoot = resolve(invokeCwd, val);
      } else if (arg === "--sdk-root") {
        if (i + 1 >= rawArgs.length || !rawArgs[i + 1] || rawArgs[i + 1].startsWith("-")) {
          throw new Error("--sdk-root requires a value");
        }
        sdkRoot = resolve(invokeCwd, rawArgs[++i]);
      } else if (arg.startsWith("-")) {
        throw new Error(`unknown option: ${arg}`);
      } else {
        positionals.push(resolve(invokeCwd, arg));
      }
    }

    if (positionals.length > 1) {
      throw new Error(`expected at most 1 project directory (got ${positionals.length})`);
    }

    const targetDir = positionals[0] ?? invokeCwd;
    const result = checkProject(targetDir, { sdkRoot, typecheckOnly, warnOnly });

    for (const warning of result.conventionWarnings) {
      console.warn(warning);
    }
    for (const err of result.conventionErrors) {
      if (warnOnly || result.conventionsMode !== "strict") {
        console.warn(err);
      } else {
        console.error(err);
      }
    }
    for (const tsErr of result.tsErrors) {
      console.error(`[pocket-typecheck] ${tsErr}`);
    }

    if (result.ok) {
      console.log(`check_project: ok (${result.project})`);
      process.exit(0);
    } else {
      console.error(
        `check_project: failed (${result.tsErrors.length} type error(s), ${result.conventionErrors.length} convention error(s) in ${result.project})`,
      );
      process.exit(1);
    }
  } catch (error) {
    console.error(`check_project: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
