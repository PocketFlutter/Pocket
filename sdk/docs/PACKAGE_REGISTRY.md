# PocketFlutter 官方包注册中心与按需安装指南

Pocket SDK 内置全部 **28 个官方包**的静态签名包注册表生成与按需安装工具链，采用 **GitHub 静态索引源（`PocketFlutter/registry`） + Cloudflare R2 全球边缘镜像加速**双源架构，兼顾国内外高速可达性与离线可验证性。

## 1. 注册表目录结构与安全校验

静态注册表输出结构如下：

- `registry/v1/index.json`：包含全部 28 个包的包名、短别名、类别（`js-guest` / `tooling` / `host-core` / `host-plugin` / `hybrid`）、依赖拓扑、平台支持矩阵、`tarballSha256`、`provenanceSha256`、R2 主镜像地址与 GitHub 备用地址。
- `registry/v1/signed-index.json`：可选 Ed25519 签名信封（配合 `--public-key` 强制验签）。
- `registry/v1/packages/<slug>/<slug>-<version>.tgz`：确定性打包（固定时间戳与 POSIX 权限、剔除 `.cxx`/`.gradle`/`node_modules` 等构建缓存）的源码归档，内含 `provenance.json`（绑定 `SDK_VERSION`、`UPSTREAM_REVISION` 与 `BYTECODE_ABI`）及宿主插件装配描述 `pocket-plugin.json`。
- `registry/v1/packages/<slug>/<slug>-<version>.tgz.sha256` 与 `metadata.json`。

加载优先级：
1. 默认优先请求 Cloudflare R2 加速源（可通过 `POCKET_REGISTRY_R2_URL` 覆盖），遇到网络异常或 HTTP 5xx 自动无感回退至 GitHub 静态源（可通过 `POCKET_REGISTRY_GITHUB_URL` 覆盖）；在完整 SDK 源码检出环境下若离线未指定远程源，还会自动回退到本地 SDK 构建索引。
2. 每个 `.tgz` 下载后先校验字节长度与 `SHA-256` 摘要，再通过防路径穿越与防符号链接逃逸的 `extractSafeTarGz` 解入本地缓存。

## 2. 按需搜索、安装与移除命令

在任意已初始化的 Pocket 项目中使用 `pocket.ts`（或 `npm --prefix sdk run search|add|remove`）：

```sh
# 1) 搜索全部或指定关键词的官方包
bun sdk/pocket.ts search
bun sdk/pocket.ts search glass
bun sdk/pocket.ts search hardware

# 2) 按需安装一个或多个包（支持短别名、JS 包名、Dart 包名或目录 slug，自动解析依赖闭包）
bun sdk/pocket.ts add ./my-app liquid-glass camera sync cloudflare

# 3) 查看当前项目已安装的包锁文件（pocket-lock.json）
bun sdk/pocket.ts packages ./my-app

# 4) 移除不再需要的包并自动清理宿主注册与依赖
bun sdk/pocket.ts remove ./my-app camera
```

## 3. 免侵入双端自动装配机制

执行 `pocket add` 时，安装器根据包类型自动完成装配且不破坏用户手写业务代码：

- **JS / Tooling 包**（如 `@pocket/liquid_glass`、`@pocket/vn`、`@pocket/cloudflare`）：解包至 `<project>/vendor/<name>` 并写入 `<project>/package.json#dependencies`，无需重编原生宿主即可直接热重载/热更新。
- **Flutter 宿主插件与混合包**（如 `pocket_camera`、`pocket_bluetooth`、`pocket_audio`、`pocket_live2d`、`pocket_sync`）：
  1. 解包至 `<project>/flutter/vendor_packages/<slug>` 并自动修正包内跨包相对路径依赖；
  2. 更新 `<project>/flutter/pubspec.yaml`；
  3. 自动维护 `<project>/flutter/lib/pocket_plugins.g.dart`（生成 `generatedPocketPluginFactories`、`generatedPocketAllowedPermissions`、`generatedPocketRuntimePermissions` 与 `applyGeneratedPocketPlugins(PocketAppConfig)` 包装函数），并在默认 `flutter/lib/main.dart` 中自动接入；
  4. 幂等补齐 `<project>/manifest.json` 的可选能力/权限声明、`AndroidManifest.xml` 的 `<uses-permission>` 以及 iOS `Info.plist` 的权限用途说明文案。

## 4. 维护者构建与同步 `PocketFlutter/registry`

```sh
# 生成完整 28 包静态注册表仓库（可选附带 Ed25519 私钥签名）
bun sdk/pocket.ts registry build \
  --out=/path/to/pocketflutter-registry \
  --key-file=/secure/path/registry-ed25519.json

# 两阶段同步静态注册表至 Cloudflare R2 镜像并自动刷新 Zone 缓存
bun sdk/pocket.ts registry sync-r2 \
  --registry-dir=/path/to/pocketflutter-registry \
  --profile=cf-registry \
  --account-id=<32位Hex账户ID> \
  --bucket=pocketflutter-registry \
  --public-base-url=https://registry-cdn.test \
  --zone-id=<32位HexZoneID>
```
