# Pocket app template

Use this template for pages, forms, and product interfaces. JS owns UI, routing, and application state. Implement state and effects first, add tests, then wire up the UI.

## 页面与导航（框架优先）

- 所有页面布局、多路由导航、安全区处理、弹性滚动与原生键盘输入，**必须优先复用内置框架与组件库**：
  - 路由与深链接：`@pocket/ui` 的 `createPocketRouter` + `PocketAppShell`（或手动组合保留式 `RouteView` + `PocketRouteScope` + `createPocketBackNavigation`）。
  - 页面外壳与导航栏：`SkinScaffold` / `SafeAreaScaffold`、`SkinAppBar` / `MobileAppBar`、`MobileBackButton`、`SkinNavigationBar` / `NavigationBar`。
  - 滚动与输入：`ScrollablePage`（内置动量滚动、挖孔避让与 IME 视口滚动）、`InputField` / `SkinInput`（唯一真实原生 IME 文本输入桥接）。
  - 控件与主题：`UiSkinProvider`、`SkinCard`、`SkinListTile`、`SkinButton`、`SkinSwitch`、`SkinDialog`、`SkinSheet`（或对应的 `Mobile*` / `Shadcn*` 组件；视觉小说场景优先使用 `@pocket/vn` 的 `createNovelEngine` + `NovelView`）。
- 仅当内置组件无法满足特定视觉设计时，才通过切换/扩展 Skin Adapter（如 `@pocket/liquid_glass`、`@pocket/arc`、`@pocket/looseleaf`）、传入自定义 `style`/`class` 或组合底层 `<View>` / `<Text>` / `<Focusable>` 进行定制。
- **严禁**：使用 `<Show>` 手写条件分支路由（会销毁非活跃页面的滚动位置与输入会话）、使用 `<View>` + `<Text>` 伪造输入框、使用 HTML/DOM 标签（`div`/`span`/`button`/`input`），或在包含 `<Text>` 的祖先 `<View>` 上施加 `scale` / `rotate` 变换。

## Application Workers for networking and games

- When first adding the official `net.http` API, the coding assistant adds `worker.ts`, `domains.worker` in `pocket.json`, the HTTP node and channels, and the `runtime.worker` and `net.http` declarations. Send requests, receive streams, and parse results through the official Worker IO path. Report progress and results to the UI through a channel.
- The host loads the application Worker from its built descriptor. Official Worker HTTP also requires exact `workerHttpOrigins` in trusted host configuration. Avoid wildcard grants, requests at startup, and requests inside the UI frame loop.
- Move pathfinding, AI decisions, map generation, and expensive batch computations into the application Worker as needed. Keep UI, input, animations, scoring, and lifecycle on the existing JS state and `onFrame` path. Simple games can avoid an idle Worker and copying the entire world state each frame.
- `renderWorker` independently controls Web rendering and defaults to `false`. Enable it only when measurements from the target game support the change.
- The initial template omits `worker.ts`. The coding assistant adds and verifies it when implementing a feature that needs it. The builder leaves existing `fetch` and `dio.request` calls alone. The native Dio plugin selected by `--dio` automatically uses a dedicated IO Worker isolate and keeps the `dio.request` interface. A Dio-only feature uses the `network` permission and the plugin's `allowedOrigins` without adding a JS Worker or enabling `domains.worker` or `renderWorker`.
- Reuse the pinned QJBC and descriptor pipeline. Verify real requests or calculations, channel responses, errors, cancellation, and hide/resume behavior. A dedicated Worker execution domain may share an OS thread on some hosts, and actual FPS gains require measurement.

See `docs/PROJECT_TEMPLATES.md`, `docs/WEB_WORKER_IMPLEMENTATION.md`, and `docs/WORKER_IO_IMPLEMENTATION.md` for full integration and source details. These paths are relative to the SDK root.
