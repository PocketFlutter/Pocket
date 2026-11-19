#!/usr/bin/env node
/**
 * Standalone PocketJS project creation and AI agent instruction synchronizer.
 *
 * Runs cleanly under plain Node.js >=22.22.2 without TypeScript static imports,
 * supporting both the full source repository and exported Web SDK packages.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MANAGED_RULES_END,
  MANAGED_RULES_START,
  writeManagedProjectTsconfig,
} from "./check_project.mjs";
import { resolveManagedBun } from "./prebuilt_tools.mjs";

export { MANAGED_RULES_START, MANAGED_RULES_END };

const defaultSdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectIdPattern = /^[a-z][a-z0-9-]{0,47}$/;
const appIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export const FRAMEWORK_AGENT_DEVELOPER_INSTRUCTIONS = [
  "Always use Pocket's built-in framework primitives first (`@pocket/ui`: `createPocketRouter`, `PocketAppShell` or retained `<RouteView>` + `<PocketRouteScope>`, `SkinScaffold`/`SafeAreaScaffold`, `SkinAppBar`/`MobileAppBar`, `SkinBackButton`/`MobileBackButton`, `SkinNavigationBar`/`NavigationBar`, `ScrollablePage`, `InputField`/`SkinInput`, and all 23 polymorphic `Skin*` controls inside `<UiSkinProvider>`; or `@pocket/vn` `createNovelEngine` + `NovelView` for visual novels). When custom brand styling is needed, plug in a custom skin via `defineUiSkin({ id, label, resolveTokens, kit })` + `registerUiSkin(...)` (or official skins `@pocket/looseleaf`, `@pocket/arc`, `@pocket/liquid_glass`) instead of hand-rolling raw `<View>` controls.",
  "Never hand-roll `<Show>`/`<Match>`/`<Dynamic>` page routers (visited routes stay mounted inside `<RouteView>` so page state and scroll offsets are preserved), HTML/DOM JSX tags (`<div>`, `<button>`, `<input>`), browser globals (`window`, `document`, `localStorage`), fake `<View>` inputs, or non-translation transforms (`scale`/`rotate`) on `<View>` ancestors containing `<Text>`. Run `npm run check && npm run build` to verify.",
].join("\n");

function quoteShellPath(value) {
  const normalized = process.platform === "win32" ? value.replaceAll("\\", "/") : value;
  if (process.platform !== "win32") return "'" + normalized.replaceAll("'", "'\\''") + "'";
  if (/[%!"\r\n]/.test(normalized)) throw new Error("SDK/project path contains unsupported Windows shell characters");
  return '"' + normalized + '"';
}

function slugForDirectory(directory) {
  const raw = directory.split(/[\\/]/).filter(Boolean).at(-1) ?? "pocket-app";
  const slug = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return projectIdPattern.test(slug) ? slug : "pocket-app";
}

function copyDirectoryFiltered(source, destination) {
  if (!existsSync(source) || !lstatSync(source).isDirectory()) {
    throw new Error(`SDK template directory is missing: ${source}`);
  }
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name === "node_modules") continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`SDK template contains unsupported symlink: ${from}`);
    }
    cpSync(from, to, { recursive: entry.isDirectory(), force: true, errorOnExist: false });
  }
}

function readJsonSafe(path) {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

const SAFE_BARE_TSCONFIG_KEYS = new Set([
  "target",
  "module",
  "moduleResolution",
  "jsx",
  "jsxImportSource",
  "strict",
  "skipLibCheck",
  "noEmit",
]);

function isLegacyBareTsconfig(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  const topKeys = Object.keys(doc);
  if (topKeys.length !== 1 || topKeys[0] !== "compilerOptions") return false;
  const co = doc.compilerOptions;
  if (!co || typeof co !== "object" || Array.isArray(co)) return false;
  const coKeys = Object.keys(co);
  if (coKeys.length === 0) return false;
  return coKeys.every((key) => SAFE_BARE_TSCONFIG_KEYS.has(key));
}

function ensureProjectTsconfig(project, sdk) {
  writeManagedProjectTsconfig(project, sdk);
  const tsconfigPath = join(project, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    writeJson(tsconfigPath, { extends: "./.pocket/tsconfig.json" });
    return;
  }
  const existing = readJsonSafe(tsconfigPath);
  if (isLegacyBareTsconfig(existing)) {
    writeJson(tsconfigPath, { extends: "./.pocket/tsconfig.json" });
  }
}

export function renderProjectAgentsMarkdown({ name, sdk, template = "app", flutter = false } = {}) {
  const sdkDisplay = sdk || defaultSdkRoot;
  const hostNote = flutter
    ? "本项目包含 `flutter/` 原生宿主；所有业务 UI、路由、状态仍 100% 归属 JS，Dart 仅保留渲染画布、IME、FFI 与显式注册的原生插件通道。"
    : "本项目为纯 JS / Web / Pocket Studio 独立项目（无 `flutter/` 宿主目录），直接编译为真实 QuickJS 字节码（`app.qjbc`）与 `app.pak`。";

  return [
    MANAGED_RULES_START,
    "## 1. 核心原则：框架优先、23 槽位多态皮肤架构",
    "",
    "- **框架优先（Framework-First）**：开发或修改任何页面与组件时，**必须优先使用 `@pocket/ui`（或视觉小说 `@pocket/vn`）内置框架原语**。严禁手搓路由栈、页面切换器、滚动容器、伪输入框、弹窗、Toast 或安全区计算。",
    "- **23 槽位多态皮肤契约（`UiSkinProvider` + `Skin*`）**：所有界面统一在 `<UiSkinProvider>` 内使用 `Skin*` 组件构建（`SkinScaffold`、`SkinAppBar`、`SkinBackButton`、`SkinNavigationBar`、`SkinCard`、`SkinListTile`、`SkinButton`、`SkinBadge`、`SkinSegmentedControl`、`SkinSwitch`、`SkinCheckbox`、`SkinRadioGroup`、`SkinInput`、`SkinProgress`、`SkinStepper`、`SkinAlert`、`SkinToast`、`SkinDialog`、`SkinSheet`、`SkinMetric`、`SkinEmptyState`、`SkinAccordion`、`SkinParagraph`）。",
    "- **自定义品牌视觉插拔皮肤**：当默认样式无法满足特定品牌视觉时，**优先通过 `defineUiSkin({ id, label, resolveTokens, kit })` + `registerUiSkin(...)`（或选用官方皮肤包 `@pocket/looseleaf`、`@pocket/arc`、`@pocket/liquid_glass`）插入自定义皮肤适配器**，覆写语义 Token 或局部 Kit 槽位，切勿放弃 `Skin*` 契约去手搓裸 `<View>` 控件。",
    "",
    "## 2. 页面架构与路由导航（严禁 `<Show>` 手搓切页）",
    "",
    "- **标准多页应用**：使用 `@pocket/ui` 的 `createPocketRouter` + `PocketAppShell`（或常驻 `<RouteView>` + `<PocketRouteScope>` + `<SkinScaffold>` + `<SkinBackButton>` / `<MobileBackButton>` + `<SkinNavigationBar>`）。",
    "- **原生返回与侧滑返回**：`PocketAppShell` 默认自动绑定全局 `HostBridge`（也可显式传入 `host={host}`），接管硬件返回键、iOS 边缘侧滑返回、顶栏标题/返回按钮以及主 Tab 切换；已访问过的路由在 `<RouteView>` 中保持挂载，自动保留页面局部状态与 `ScrollablePage` 滚动偏移。若使用 `ProjectSurfaceRoot`，切勿在子组件 `onCleanup` 中调用 `host.dispose()`。",
    "- **返回键拦截与浮层关闭（`usePocketBackHandler`）**：`SkinDialog`、`SkinSheet`、`MobileDialog`、`MobilePopup` 已自动注册 `usePocketBackHandler`，打开时按硬件返回键或触发返回手势会优先关闭浮层而不会误退底层路由；自定义全屏遮罩也可调用 `usePocketBackHandler(() => { close(); return true; }, isOpen)`。",
    "- **导航栏图标（`NavigationIconKind`）**：`NavigationItem.kind` 内置 8 种跨平台几何图标：`\"home\" | \"gallery\" | \"host\" | \"settings\" | \"profile\" | \"search\" | \"inbox\" | \"star\"`；也可通过 `NavigationItem.icon` 传入自定义 JSX 或 `({ active, color, dark }) => JSX.Element`。",
    "- **禁止 `<Show>` / `<Match>` / `<Dynamic>` 包裹整页切换**：手搓条件切页会卸载非当前页面，导致滚动偏移、IME 输入会话与组件状态丢失。",
    "",
    "```tsx",
    "import { createSignal } from \"solid-js\";",
    "import {",
    "  PocketAppShell,",
    "  ScrollablePage,",
    "  SkinButton,",
    "  SkinCard,",
    "  SkinInput,",
    "  SkinParagraph,",
    "  UiSkinProvider,",
    "  createPocketRouter,",
    "} from \"@pocket/ui\";",
    "",
    "const router = createPocketRouter({",
    "  routes: [",
    "    { id: \"home\", path: \"/home\", aliases: [\"/\"], primary: true },",
    "    { id: \"detail\", path: \"/detail\", parent: \"home\" },",
    "  ],",
    "  fallbackRouteId: \"home\",",
    "});",
    "",
    "export function App() {",
    "  const [dark, setDark] = createSignal(false);",
    "  const [draft, setDraft] = createSignal(\"\");",
    "",
    "  return (",
    "    <UiSkinProvider mode={() => (dark() ? \"dark\" : \"light\")}>",
    "      <PocketAppShell",
    "        router={router}",
    "        tabs={[{ id: \"home\", label: \"首页\", kind: \"home\" }]}",
    "        trailing={() => (",
    "          <SkinButton",
    "            label={dark() ? \"浅色\" : \"深色\"}",
    "            variant=\"ghost\"",
    "            compact",
    "            onPress={() => setDark((v) => !v)}",
    "          />",
    "        )}",
    "        routes={[",
    "          {",
    "            id: \"home\",",
    "            title: \"首页\",",
    "            render: () => (",
    "              <ScrollablePage class=\"px-4 py-4 gap-3\">",
    "                <SkinCard title=\"示例\">",
    "                  <SkinParagraph text={draft() || \"暂无草稿\"} muted />",
    "                  <SkinButton label=\"查看详情\" onPress={() => router.push(\"detail\")} />",
    "                </SkinCard>",
    "              </ScrollablePage>",
    "            ),",
    "          },",
    "          {",
    "            id: \"detail\",",
    "            title: \"详情\",",
    "            render: () => (",
    "              <ScrollablePage class=\"px-4 py-4 gap-3\">",
    "                <SkinCard title=\"编辑内容\">",
    "                  <SkinInput value={draft} onInput={setDraft} placeholder=\"输入内容\" />",
    "                  <SkinButton label=\"返回首页\" onPress={() => router.back()} />",
    "                </SkinCard>",
    "              </ScrollablePage>",
    "            ),",
    "          },",
    "        ]}",
    "      />",
    "    </UiSkinProvider>",
    "  );",
    "}",
    "```",
    "",
    "## 3. 内置组件选型表（`@pocket/ui` & `@pocket/vn`）",
    "",
    "| 场景 | 必用内置组件 / API | 说明 |",
    "| --- | --- | --- |",
    "| 应用外壳与多页路由 | `createPocketRouter` + `PocketAppShell`（或 `<RouteView>` + `<PocketRouteScope>`） | 自动管理页面栈、常驻挂载保活、返回键与 Tab 栏 |",
    "| 页面安全区与顶栏/底栏 | `SkinScaffold` / `SafeAreaScaffold`、`SkinAppBar` / `MobileAppBar`、`SkinBackButton` / `MobileBackButton`、`SkinNavigationBar` / `NavigationBar` | 唯一消费系统刘海/状态栏/底部手势区 inset 的入口 |",
    "| 页面滚动与长列表 | `ScrollablePage`、`PocketVirtualList` | 自动处理惯性滚动、安全区底部留白与虚拟化回收 |",
    "| 文本输入（IME） | `SkinInput` / `InputField` | 绑定真实系统宿主输入法、光标、选区与组合输入，严禁 `<View>` 伪造输入框 |",
    "| 卡片、列表项与排版 | `SkinCard`、`SkinListTile`、`SkinParagraph`、`SkinBadge`、`SkinMetric`、`SkinEmptyState`、`SkinAccordion` | 内置圆角、间距、点击态与无障碍焦点语义 |",
    "| 按钮与表单选择控件 | `SkinButton`、`SkinSegmentedControl`、`SkinSwitch`、`SkinCheckbox`、`SkinRadioGroup`、`SkinProgress`、`SkinStepper` | 内置焦点环、按下取消态、禁用态与键盘/手柄导航 |",
    "| 弹窗、抽屉、横幅与轻提示 | `SkinDialog`、`SkinSheet`、`SkinAlert`、`SkinToast` | 统一遮罩层、`usePocketBackHandler` 返回键关闭与焦点管理 |",
    "| 主题与可插拔多皮肤体系 | `UiSkinProvider`、`defineUiSkin`、`registerUiSkin`、`SkinSwitcherBar`（及 `@pocket/liquid_glass`、`@pocket/arc`、`@pocket/looseleaf`） | 23 槽位多态皮肤切换与品牌 Token 定制 |",
    "| 2D / 帧循环小游戏（`game`） | `SafeAreaScaffold.background` + `Focusable` + `onFrame` | 装饰层放 `background`（`hitPass: 1`），交互区留在 once-inset 内容区 |",
    "| 视觉小说 / 剧情演出 | `@pocket/vn`（`createNovelEngine` + `NovelView`） | 内置剧本状态机、立绘/背景过渡、对话框、分支选项、存档与回放 |",
    "",
    "## 4. 常见场景标准范式（Recipes）",
    "",
    "### (1) 无顶栏/底栏的全屏页（Splash / 登录 / 引导页）及重置路由栈",
    "```tsx",
    "{",
    "  id: \"welcome\",",
    "  appBar: null,",
    "  showBottomBar: false,",
    "  render: () => (",
    "    <ScrollablePage class=\"px-6 py-8 gap-4\">",
    "      <SkinParagraph text=\"欢迎使用\" class=\"text-2xl font-bold\" />",
    "      <SkinButton",
    "        label=\"进入首页\"",
    "        onPress={() => router.navigate(\"home\", { history: \"reset\" })}",
    "      />",
    "    </ScrollablePage>",
    "  ),",
    "}",
    "```",
    "",
    "### (2) 带路径参数的详情页（`/detail/:id` + `useRouteParams` + `usePocketRouter`）",
    "```tsx",
    "import { ScrollablePage, SkinButton, SkinCard, SkinParagraph, usePocketRouter, useRouteParams } from \"@pocket/ui\";",
    "",
    "// 路由定义：{ id: \"detail\", path: \"/detail/:id\", parent: \"home\" }",
    "// 跳转调用：router.push(\"detail\", { params: { id: \"42\" } })",
    "function DetailPage() {",
    "  const router = usePocketRouter();",
    "  const params = useRouteParams<{ id: string }>();",
    "  return (",
    "    <ScrollablePage class=\"px-4 py-4 gap-3\">",
    "      <SkinCard title={`条目 #${params().id ?? \"\"}`}>",
    "        <SkinParagraph text=\"子组件内直接通过 useRouteParams 与 usePocketRouter 读取参数与导航。\" />",
    "        <SkinButton label=\"返回\" onPress={() => router.back()} />",
    "      </SkinCard>",
    "    </ScrollablePage>",
    "  );",
    "}",
    "```",
    "",
    "### (3) 确认弹窗（`SkinDialog` 自动拦截返回键关闭）",
    "```tsx",
    "<SkinDialog",
    "  open={confirmOpen()}",
    "  title=\"确认归档\"",
    "  body=\"弹窗打开时按返回键会自动触发 onClose，不会误退当前页面路由。\"",
    "  confirmLabel=\"确认\"",
    "  cancelLabel=\"取消\"",
    "  onConfirm={() => {",
    "    setConfirmOpen(false);",
    "  }}",
    "  onClose={() => setConfirmOpen(false)}",
    "/>",
    "```",
    "",
    "### (4) 自定义可插拔品牌皮肤（`defineUiSkin` + `UiSkinProvider`）",
    "```tsx",
    "import { UiSkinProvider, defineUiSkin } from \"@pocket/ui\";",
    "",
    "const myBrandSkin = defineUiSkin({",
    "  id: \"my-brand\",",
    "  label: \"My Brand\",",
    "  resolveTokens: (mode, _accent, base) => ({",
    "    ...base,",
    "    accentBg: mode === \"dark\" ? \"#38BDF8\" : \"#0284C7\",",
    "    radiusControl: 14,",
    "    radiusSurface: 18,",
    "  }),",
    "});",
    "",
    "// 在根组件挂载：",
    "<UiSkinProvider skin=\"my-brand\" skins={[myBrandSkin]}>",
    "  {/* 内部所有 Skin* 组件自动应用新皮肤 Token 与 Kit 槽位 */}",
    "</UiSkinProvider>",
    "```",
    "",
    "## 5. 原生渲染硬性约束与开发闭环",
    "",
    "1. **严禁使用 HTML/DOM 标签**：Guest 运行在 QuickJS + 原生/Wasm 渲染树上，不存在 DOM。禁止 `<div>`、`<span>`、`<button>`、`<input>`、`<img>` 等标签（`npm run check` 与 `npm run build` 会直接报错拦截）；底层仅使用 `@pocket/ui` 组件或 `View`、`Text`、`Image`、`Focusable`、`Surface`。",
    "2. **严禁访问浏览器 DOM / History / Storage 全局对象**：禁止 `window.*`、`document.*`、`localStorage.*`、`sessionStorage.*`、`navigator.*`、`history.*`、`alert()`。路由使用 `createPocketRouter`，宿主能力通过 `HostBridge` 调用。",
    "3. **严禁在包含 `<Text>` 的祖先 `<View>` 上设置缩放或旋转变换**：不要在含文字的父级 `<View>` 上设置非平移几何变换（缩放或旋转），以免文字光栅化基线与裁剪失真。",
    "4. **严禁在 `onFrame` 帧循环中发起网络请求**：网络请求与重计算放入业务 Worker（`domains.worker` + `net.http`）或 `--dio` 插件通道。",
    "5. **TCA 开发与类型/构建双重验证闭环**：按 `State / Action / Reducer / Effect` 先完成业务逻辑 -> 补充并通过单元测试 -> 绑定 `@pocket/ui` 视图 -> **必须运行 `npm run check && npm run build`** 验证 TypeScript 类型、框架规范与真实 QJBC/PAK 编译全部通过。",
    "",
    "## 6. API Ground Truth & Verification（API 权威定义与校验）",
    "",
    "编写或调用任何 `@pocket/ui` / `@pocket/vn` 组件前，若不确定 Props 签名，直接查阅以下权威文件（切勿凭空猜测 React/HTML 属性名）：",
    "",
    `- **JS/TS 全量签名目录**：\`${sdkDisplay}/docs/JS_API_SIGNATURES.md\``,
    `- **应用外壳与路由容器**：\`${sdkDisplay}/packages/pocket_ui/src/app-shell.tsx\``,
    `- **23 槽位多态皮肤组件与 Props 定义**：\`${sdkDisplay}/packages/pocket_ui/src/skins.tsx\``,
    `- **基础安全区、滚动、导航栏与输入框原语**：\`${sdkDisplay}/packages/pocket_ui/src/ui.tsx\``,
    "",
    "每次完成修改后必须执行：`npm run check && npm run build`。",
    "",
    "## 7. 项目常用命令与环境信息",
    "",
    `- **项目名称**：\`${name || "pocket-app"}\`（模板：\`${template}\`）`,
    `- **绑定 SDK 路径**：\`${sdkDisplay}\``,
    `- **宿主形态**：${hostNote}`,
    "",
    "```sh",
    "npm run check         # 运行 TypeScript 类型检查 + Pocket 框架规范校验 (check_project.mjs)",
    "npm run typecheck     # 仅运行 TypeScript 类型检查",
    "npm start             # 启动 Pocket Studio 实时预览与编辑器 (http://127.0.0.1:8791)",
    "npm run build         # 编译真实 QuickJS 字节码 (app.qjbc) 与资源包 (app.pak)",
    "npm run build:web     # 构建独立 WebAssembly + Canvas2D Web 产物 (build/web)",
    "npm run sync:agents   # 刷新 AGENTS.md / CLAUDE.md 与 .pocket/tsconfig.json",
    "```",
    MANAGED_RULES_END,
  ].join("\n");
}

function renderManagedClaudeMarkdown() {
  return "@AGENTS.md\n\n<!-- pocket:managed-claude -->\nRead and follow AGENTS.md before editing.\n";
}

export function syncProjectAgentFiles(
  project,
  { name, sdk, template = "app", flutter = false, overwriteManaged = false } = {},
) {
  const resolvedProject = resolve(project);
  const displayTitle = (name && String(name).trim()) || basename(resolvedProject) || "Pocket App";
  const resolvedSdk = sdk ? resolve(sdk) : defaultSdkRoot;
  const managedBlock = renderProjectAgentsMarkdown({
    name: displayTitle,
    sdk: resolvedSdk,
    template,
    flutter,
  });

  const agentsPath = join(resolvedProject, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, `# ${displayTitle} — PocketJS AI 开发约束\n\n${managedBlock}\n`);
  } else if (overwriteManaged === true) {
    const existing = readFileSync(agentsPath, "utf8");
    const startIdx = existing.indexOf(MANAGED_RULES_START);
    const endIdx = existing.indexOf(MANAGED_RULES_END);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const before = existing.slice(0, startIdx);
      const after = existing.slice(endIdx + MANAGED_RULES_END.length);
      writeFileSync(agentsPath, `${before}${managedBlock}${after}`);
    } else if (startIdx !== -1) {
      const before = existing.slice(0, startIdx).replace(/\s+$/, "");
      writeFileSync(agentsPath, `${before ? `${before}\n\n` : ""}${managedBlock}\n`);
    } else {
      const trimmed = existing.replace(/\s+$/, "");
      writeFileSync(agentsPath, `${trimmed}\n\n${managedBlock}\n`);
    }
  }

  const claudePath = join(resolvedProject, "CLAUDE.md");
  if (!existsSync(claudePath)) {
    writeFileSync(claudePath, renderManagedClaudeMarkdown());
  } else if (overwriteManaged === true) {
    const existingClaude = readFileSync(claudePath, "utf8");
    if (
      existingClaude.includes("<!-- pocket:managed-claude -->") ||
      existingClaude.includes("./AGENTS.md") ||
      existingClaude.includes("@AGENTS.md")
    ) {
      writeFileSync(claudePath, renderManagedClaudeMarkdown());
    }
  }
}

export function writeProjectSupport(project, sdk, name, options = {}) {
  const invoke = `node ${quoteShellPath(join(sdk, "scripts/project_commands.mjs"))}`;
  const flutter =
    existsSync(join(project, "flutter/pubspec.yaml")) ||
    (basename(project) === "js" && existsSync(join(project, "../pubspec.yaml")));
  const scripts = {
    start: `${invoke} start`,
    build: `${invoke} build`,
    "build:web": `${invoke} build:web`,
    check: `${invoke} check`,
    typecheck: `${invoke} typecheck`,
    "editor:status": `${invoke} status`,
    "editor:stop": `${invoke} stop`,
    "sync:agents": `${invoke} sync-agents`,
  };
  const path = join(project, "package.json");
  const pkg = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { name, private: true, type: "module" };
  pkg.scripts = { ...scripts, ...pkg.scripts };
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  ensureProjectTsconfig(project, sdk);
  mkdirSync(join(project, "assets"), { recursive: true });
  const ignore = join(project, ".gitignore");
  const prior = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  const patterns = [
    "node_modules/",
    "build/",
    ".pocket/",
    ".pocket-build/",
    ".pocket-ui.lock",
    ".pocket-ui-backup-*",
    ".pocket-*.lock",
    ".pocket-*-backup-*",
    "flutter/.dart_tool/",
    "flutter/build/",
  ];
  const missing = patterns.filter((line) => !prior.split(/\r?\n/).includes(line));
  if (missing.length) {
    writeFileSync(ignore, prior + (prior && !prior.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
  }
  const readme = join(project, "README.md");
  const priorReadme = existsSync(readme) ? readFileSync(readme, "utf8") : `# ${name}\n`;
  if (!priorReadme.includes("## Project commands")) {
    writeFileSync(
      readme,
      priorReadme +
        `\n## Project commands\n\nRun from this directory:\n\n\`\`\`sh\nnpm run check\nnpm start\nnpm run build\nnpm run build:web\nnpm run editor:status\nnpm run editor:stop\n\`\`\`\n\nOpen http://127.0.0.1:8791. Edit \`app.tsx\` and \`assets/\`, then rebuild.\nThe project uses the SDK at \`${sdk}\`; install its matching platform tools first.\nSource developers explicitly set \`POCKET_SOURCE_BUILD=1\` and install source prerequisites.\n${flutter ? "The native Flutter host is under `flutter/`; native libraries still require the target build tools.\n" : "This is a JS/Preview project; it does not generate a Flutter host.\n"}\nApplication state, routing and component composition belong in JS. Use the existing Worker/IO contracts for network and expensive business work; rendering Workers remain opt-in.\n`,
    );
  }
  syncProjectAgentFiles(project, {
    name: options.title || name,
    sdk,
    template: options.template || "app",
    flutter,
    overwriteManaged: false,
  });
}

function cleanupTargetOnFailure(target, createdTargetDir) {
  try {
    if (createdTargetDir) {
      rmSync(target, { recursive: true, force: true });
    } else if (existsSync(target)) {
      for (const entry of readdirSync(target)) {
        rmSync(join(target, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // Best-effort rollback so original creation error is preserved.
  }
}

export async function createStandaloneProject(directory, options = {}) {
  if (!directory || typeof directory !== "string") {
    throw new Error("project target directory is required");
  }
  const target = resolve(directory);
  const sdk = resolve(options.sdkRoot ?? defaultSdkRoot);
  const template = options.template ?? "app";
  if (template !== "app" && template !== "game") {
    throw new Error(`template must be "app" or "game" (got ${JSON.stringify(template)})`);
  }
  if (options.flutter === true && options.id !== undefined) {
    throw new Error("--id cannot be combined with --flutter; the project ID is derived from the directory name");
  }
  const id = options.id ?? slugForDirectory(target);
  if (!projectIdPattern.test(id)) {
    throw new Error(`project id is unsafe: ${id}`);
  }
  const appId = options.appId ?? `dev.pocketjs.${id}`;
  if (!appIdPattern.test(appId)) {
    throw new Error(`app id is unsafe: ${appId}`);
  }
  const version = options.version ?? "0.1.0";
  if (!versionPattern.test(version)) {
    throw new Error(`version is unsafe: ${version}`);
  }
  const name = typeof options.name === "string" && options.name.trim() ? options.name.trim() : id;

  const createdTargetDir = !existsSync(target);
  if (!createdTargetDir && readdirSync(target).length > 0) {
    throw new Error(`target directory must be empty: ${target}`);
  }

  try {
    if (options.flutter === true) {
      const pocketTs = join(sdk, "pocket.ts");
      if (!existsSync(pocketTs)) {
        throw new Error("--flutter requires the full Pocket source SDK checkout (pocket.ts not found)");
      }
      let bun;
      try {
        bun = resolveManagedBun(sdk);
      } catch {
        bun = "bun";
      }
      const initArgs = [
        pocketTs,
        "init",
        target,
        `--sdk-root=${sdk}`,
        `--template=${template}`,
        `--app-id=${appId}`,
        `--name=${name}`,
        `--version=${version}`,
      ];
      if (options.hardware === true) initArgs.push("--hardware");
      if (options.camera === true) initArgs.push("--camera");
      if (options.bluetooth === true) initArgs.push("--bluetooth");
      if (options.sensors === true) initArgs.push("--sensors");
      if (options.location === true) initArgs.push("--location");
      if (options.biometrics === true || options.biometric === true) initArgs.push("--biometrics");
      if (options.weather === true) initArgs.push("--weather");
      if (typeof options.permissions === "string" && options.permissions.trim()) {
        initArgs.push(`--permissions=${options.permissions.trim()}`);
      }
      if (options.dio === true) initArgs.push("--dio");
      if (options.clipboard === true) initArgs.push("--clipboard");
      if (options.platformExperience === true) initArgs.push("--platform-experience");
      if (typeof options.deepLinkScheme === "string" && options.deepLinkScheme.trim()) {
        initArgs.push(`--deep-link-scheme=${options.deepLinkScheme.trim()}`);
      }
      if (typeof options.surfaces === "string" && options.surfaces.trim()) {
        initArgs.push(`--surfaces=${options.surfaces.trim()}`);
      }
      const res = spawnSync(bun, initArgs, { stdio: "inherit", env: process.env });
      if (res.error) throw res.error;
      if (res.status !== 0) {
        throw new Error(`pocket.ts init exited with status ${res.status ?? 1}`);
      }
      if (
        options.useXcodegen === true ||
        options.embedIosExtensions === true ||
        (typeof options.teamId === "string" && options.teamId.trim())
      ) {
        const surfaceArgs = [pocketTs, "surfaces", target];
        if (options.useXcodegen === true) surfaceArgs.push("--xcodegen");
        if (options.embedIosExtensions === true) surfaceArgs.push("--embed-ios-extensions");
        if (typeof options.teamId === "string" && options.teamId.trim()) {
          surfaceArgs.push(`--team-id=${options.teamId.trim()}`);
        }
        if (typeof options.deepLinkScheme === "string" && options.deepLinkScheme.trim()) {
          surfaceArgs.push(`--deep-link-scheme=${options.deepLinkScheme.trim()}`);
        }
        const surfRes = spawnSync(bun, surfaceArgs, { stdio: "inherit", env: process.env });
        if (surfRes.error) throw surfRes.error;
        if (surfRes.status !== 0) {
          throw new Error(`pocket.ts surfaces exited with status ${surfRes.status ?? 1}`);
        }
      }
      return target;
    }

    const templateDir = join(sdk, "templates", template);
    copyDirectoryFiltered(templateDir, target);

    writeJson(join(target, "editor.json"), {
      id,
      appId,
      name,
      title: name,
      version,
      build: 1,
      tickHz: 60,
      entry: "app.tsx",
      framework: "solid",
      template,
      hardware: Boolean(options.hardware),
      dio: Boolean(options.dio),
      clipboard: Boolean(options.clipboard),
    });

    writeJson(join(target, "pocket.json"), {
      $schema: "https://pocketjs.dev/schema/pocket-2.json",
      pocket: 2,
      id: appId,
      name,
      title: name,
      version,
      build: 1,
      engine: { capabilities: { requires: ["text.glyphs.baked"], enhances: [] } },
      app: { entry: "app.tsx", output: "app", framework: "solid" },
    });

    writeJson(join(target, "manifest.json"), {
      $schema: "https://pocketjs.dev/schema/pocket-guest-manifest.json",
      protocolVersion: 1,
      capabilities: { requires: ["text.glyphs.baked"], optional: [] },
      permissions: { optional: [] },
    });

    writeProjectSupport(target, sdk, id, { template, title: name });

    if (typeof options.surfaces === "string" && options.surfaces.trim()) {
      let bun;
      try {
        bun = resolveManagedBun(sdk);
      } catch {
        bun = "bun";
      }
      const ecoModuleHref = pathToFileURL(join(sdk, "scripts/ecosystem_scaffold.ts")).href;
      const evalScript = [
        "const mod = await import(process.env.POCKET_ECO_MOD);",
        "mod.scaffoldEcosystemModules(process.env.POCKET_TARGET_DIR, process.env.POCKET_SURFACES, { mode: 'set', appTitle: process.env.POCKET_APP_TITLE });",
      ].join(" ");
      const res = spawnSync(bun, ["--eval", evalScript], {
        stdio: "inherit",
        env: {
          ...process.env,
          POCKET_ECO_MOD: ecoModuleHref,
          POCKET_TARGET_DIR: target,
          POCKET_SURFACES: options.surfaces.trim(),
          POCKET_APP_TITLE: name,
        },
      });
      if (res.error) throw res.error;
      if (res.status !== 0) {
        throw new Error(`ecosystem surface scaffolding failed with status ${res.status ?? 1}`);
      }
    }

    return target;
  } catch (error) {
    cleanupTargetOnFailure(target, createdTargetDir);
    throw error;
  }
}

export function syncExistingProjectAgents(directory, options = {}) {
  const raw = resolve(directory);
  const project =
    existsSync(join(raw, "pubspec.yaml")) && existsSync(join(raw, "js/pocket.json"))
      ? join(raw, "js")
      : raw;
  if (!existsSync(project) || !lstatSync(project).isDirectory()) {
    throw new Error(`project directory does not exist: ${project}`);
  }
  const hasPocketJson = existsSync(join(project, "pocket.json"));
  const hasEditorJson = existsSync(join(project, "editor.json"));
  if (!hasPocketJson && !hasEditorJson) {
    throw new Error(`not a Pocket project (missing pocket.json / editor.json): ${project}`);
  }
  const sdk = resolve(options.sdkRoot ?? defaultSdkRoot);
  const editorDoc = readJsonSafe(join(project, "editor.json")) ?? {};
  const pocketDoc = readJsonSafe(join(project, "pocket.json")) ?? {};
  const title =
    (typeof editorDoc.title === "string" && editorDoc.title.trim()) ||
    (typeof pocketDoc.title === "string" && pocketDoc.title.trim()) ||
    (typeof editorDoc.name === "string" && editorDoc.name.trim()) ||
    (typeof pocketDoc.name === "string" && pocketDoc.name.trim()) ||
    basename(project);
  const template =
    editorDoc.template === "game" || pocketDoc.template === "game" ? "game" : "app";
  const flutter =
    existsSync(join(project, "flutter/pubspec.yaml")) ||
    (basename(project) === "js" && existsSync(join(project, "../pubspec.yaml")));

  syncProjectAgentFiles(project, {
    name: title,
    sdk,
    template,
    flutter,
    overwriteManaged: true,
  });

  ensureProjectTsconfig(project, sdk);

  const ignorePath = join(project, ".gitignore");
  if (existsSync(ignorePath)) {
    const prior = readFileSync(ignorePath, "utf8");
    if (!prior.split(/\r?\n/).includes(".pocket/")) {
      writeFileSync(ignorePath, prior + (prior && !prior.endsWith("\n") ? "\n" : "") + ".pocket/\n");
    }
  }

  const pkgPath = join(project, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = readJsonSafe(pkgPath);
    if (pkg) {
      const invoke = `node ${quoteShellPath(join(sdk, "scripts/project_commands.mjs"))}`;
      const existingScripts = pkg.scripts && typeof pkg.scripts === "object" ? { ...pkg.scripts } : {};
      const managedScriptMap = {
        start: `${invoke} start`,
        build: `${invoke} build`,
        "build:web": `${invoke} build:web`,
        check: `${invoke} check`,
        typecheck: `${invoke} typecheck`,
        "editor:status": `${invoke} status`,
        "editor:stop": `${invoke} stop`,
        "sync:agents": `${invoke} sync-agents`,
      };
      for (const [key, cmd] of Object.entries(managedScriptMap)) {
        if (
          !(key in existingScripts) ||
          (typeof existingScripts[key] === "string" && existingScripts[key].includes("project_commands.mjs"))
        ) {
          existingScripts[key] = cmd;
        }
      }
      pkg.scripts = existingScripts;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    }
  }

  return {
    project,
    agentsPath: join(project, "AGENTS.md"),
    claudePath: join(project, "CLAUDE.md"),
  };
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node create_project.mjs <directory> [options]",
      "  node create_project.mjs --sync-agents [<directory>...]",
      "",
      "Options:",
      "  --template=app|game          Project template (default: app)",
      "  --name=TITLE                 Display title for the project",
      "  --id=SLUG                    Project ID slug (^[a-z][a-z0-9-]{0,47}$)",
      "  --app-id=BUNDLE_ID           Application / package identifier",
      "  --version=SEMVER             Initial version string (default: 0.1.0)",
      "  --surfaces=MODULES           Comma-separated ecosystem surface modules",
      "  --sdk-root=DIR               Override Pocket SDK root directory",
      "  --flutter                    Create a full Flutter + JS project via pocket.ts init",
      "  --dio                        Enable Dio HTTP plugin on Flutter host",
      "  --hardware                   Enable hardware plugin bundle on Flutter host",
      "  --clipboard                  Enable clipboard plugin on Flutter host",
      "  --bluetooth                  Enable Bluetooth hardware module on Flutter host",
      "  --biometric, --biometrics    Enable Biometrics hardware module on Flutter host",
      "  --camera                     Enable Camera hardware module on Flutter host",
      "  --sensors                    Enable Sensors hardware module on Flutter host",
      "  --location                   Enable Location hardware module on Flutter host",
      "  --weather                    Enable Weather hardware module on Flutter host",
      "  --permissions=KEYS           Comma-separated hardware permission keys",
      "  --platform-experience        Enable platform experience plugin on Flutter host",
      "  --file-picker                Enable file picker capability option",
      "  --deep-link-scheme=SCHEME    Configure custom deep-link URL scheme",
      "  --team-id=TEAM_ID            Apple Developer Team ID for iOS surface extensions",
      "  --use-xcodegen               Generate Xcode project via XcodeGen for surfaces",
      "  --embed-ios-extensions       Embed iOS surface extension targets",
      "  --sync-agents                Refresh AGENTS.md & CLAUDE.md in existing Pocket project(s)",
      "  --help, -h                   Show this help message",
    ].join("\n"),
  );
}

function canonicalPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function nextOptionValue(args, index, flag) {
  if (argHasInlineValue(flag)) {
    const eqIdx = flag.indexOf("=");
    const val = flag.slice(eqIdx + 1);
    if (!val) {
      throw new Error(`${flag.slice(0, eqIdx)} requires a non-empty value`);
    }
    return { value: val, nextIndex: index };
  }
  const next = index + 1 < args.length ? args[index + 1] : undefined;
  if (next === undefined || next === "" || next.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return { value: next, nextIndex: index + 1 };
}

function argHasInlineValue(arg) {
  return arg.includes("=");
}

if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  (async () => {
    const rawArgs = process.argv.slice(2);
    const invokeCwd = process.env.INIT_CWD ? resolve(process.env.INIT_CWD) : process.cwd();
    const positionals = [];
    let syncAgents = false;
    let flutter = false;
    let dio = false;
    let hardware = false;
    let clipboard = false;
    let bluetooth = false;
    let biometrics = false;
    let camera = false;
    let sensors = false;
    let location = false;
    let weather = false;
    let filePicker = false;
    let platformExperience = false;
    let useXcodegen = false;
    let embedIosExtensions = false;
    let template;
    let name;
    let id;
    let appId;
    let version;
    let surfaces;
    let sdkRoot;
    let permissions;
    let deepLinkScheme;
    let teamId;

    for (let i = 0; i < rawArgs.length; i++) {
      const arg = rawArgs[i];
      if (arg === "--help" || arg === "-h") {
        printUsage();
        process.exit(0);
      } else if (arg === "--sync-agents") {
        syncAgents = true;
      } else if (arg === "--flutter") {
        flutter = true;
      } else if (arg === "--dio") {
        dio = true;
      } else if (arg === "--hardware") {
        hardware = true;
      } else if (arg === "--clipboard") {
        clipboard = true;
      } else if (arg === "--bluetooth") {
        bluetooth = true;
      } else if (arg === "--biometric" || arg === "--biometrics") {
        biometrics = true;
      } else if (arg === "--camera") {
        camera = true;
      } else if (arg === "--sensors") {
        sensors = true;
      } else if (arg === "--location") {
        location = true;
      } else if (arg === "--weather") {
        weather = true;
      } else if (arg === "--file-picker") {
        filePicker = true;
      } else if (arg === "--platform-experience") {
        platformExperience = true;
      } else if (arg === "--use-xcodegen" || arg === "--xcodegen") {
        useXcodegen = true;
      } else if (arg === "--embed-ios-extensions") {
        embedIosExtensions = true;
      } else if (arg === "--template" || arg.startsWith("--template=")) {
        const parsed = nextOptionValue(rawArgs, i, arg);
        template = parsed.value;
        i = parsed.nextIndex;
      } else if (arg === "--name" || arg.startsWith("--name=")) {
        const parsed = nextOptionValue(rawArgs, i, arg);
        name = parsed.value;
        i = parsed.nextIndex;
      } else if (arg === "--id" || arg.startsWith("--id=")) {
        const parsed = nextOptionValue(rawArgs, i, arg);
        id = parsed.value;
        i = parsed.nextIndex;
      } else if (arg === "--app-id" || arg.startsWith("--app-id=")) {
        const parsed = nextOptionValue(rawArgs, i, arg);
        appId = parsed.value;
        i = parsed.nextIndex;
      } else if (arg === "--version" || arg.startsWith("--version=")) {
        const parsed = nextOptionValue(rawArgs, i, arg);
        version = parsed.value;
        i = parsed.nextIndex;
      } else if (arg === "--surfaces" || arg.startsWith("--surfaces=")) {
        const parsed = nextOptionValue(rawArgs, i, arg);
        surfaces = parsed.value;
        i = parsed.nextIndex;
      } else if (arg === "--sdk-root" || arg.startsWith("--sdk-root=")) {
        const parsed = nextOptionValue(rawArgs, i, arg);
        sdkRoot = resolve(invokeCwd, parsed.value);
        i = parsed.nextIndex;
      } else if (arg === "--permissions" || arg.startsWith("--permissions=")) {
        const parsed = nextOptionValue(rawArgs, i, arg);
        permissions = parsed.value;
        i = parsed.nextIndex;
      } else if (arg === "--deep-link-scheme" || arg.startsWith("--deep-link-scheme=")) {
        const parsed = nextOptionValue(rawArgs, i, arg);
        deepLinkScheme = parsed.value;
        i = parsed.nextIndex;
      } else if (arg === "--team-id" || arg.startsWith("--team-id=")) {
        const parsed = nextOptionValue(rawArgs, i, arg);
        teamId = parsed.value;
        i = parsed.nextIndex;
      } else if (arg.startsWith("-")) {
        throw new Error(`unknown option: ${arg}`);
      } else {
        positionals.push(resolve(invokeCwd, arg));
      }
    }

    if (syncAgents) {
      const targets = positionals.length > 0 ? positionals : [invokeCwd];
      for (const dir of targets) {
        const res = syncExistingProjectAgents(dir, { sdkRoot });
        console.log(`create_project: synced AGENTS.md in ${res.project}`);
      }
      process.exit(0);
    }

    if (positionals.length !== 1) {
      printUsage();
      process.exit(1);
    }

    const created = await createStandaloneProject(positionals[0], {
      template,
      name,
      id,
      appId,
      version,
      surfaces,
      sdkRoot,
      flutter,
      dio,
      hardware,
      clipboard,
      bluetooth,
      biometrics,
      camera,
      sensors,
      location,
      weather,
      filePicker,
      permissions,
      platformExperience,
      deepLinkScheme,
      teamId,
      useXcodegen,
      embedIosExtensions,
    });
    console.log(`create_project: created ${created}`);
  })().catch((error) => {
    console.error(`create_project: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
