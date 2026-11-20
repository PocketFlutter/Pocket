# Cloudflare 多账户 × 平台矩阵部署指南 (`@pocket/cloudflare`)

`@pocket/cloudflare`（源码位于 [`packages/pocket_cloudflare`](../packages/pocket_cloudflare/package.json)）为 Pocket SDK 提供零 AWS SDK 依赖的 Cloudflare R2 两阶段签名热更发布、多账户按平台分发矩阵、原生安装包（IPA / APK / DMG / MSIX）签名下载清单、Cloudflare Zone Cache Purge 自动刷新，以及 Cloudflare Pages / Workers Static Assets Web 直连部署能力。

## 1. 核心架构与安全边界

1. **多账户 × 平台矩阵路由（Single-Primary + Multi-Fallback）**：
   - 每个 Cloudflare 目标可绑定独立 `accountId`、`bucket`、`publicBaseUrl`、`platforms`（`ios`、`android`、`macos`、`windows`、`linux`、`web`、`wechat`、`*`）与 `role`（`primary` 或 `fallback`）。
   - 矩阵校验器强制每个具体平台至多拥有一个 `primary` 目标，其余镜像账户标记为 `fallback`，防止主源歧义。
2. **跨账户全局两阶段发布屏障（Two-Phase Atomic Barrier）**：
   - **Phase 1（不可变内容寻址层）**：并发上传所有目标账户的 `blobs/<sha256>` 与 `bundles/bundle-<sha256>.7z|.zip`（`Cache-Control: public, max-age=31536000, immutable`），通过 `HEAD` + `x-amz-meta-sha256` 自动跳过已存在分片；大于等于 8 MiB 的归档自动启用 S3 Multipart 分片并发上传并在异常时执行 `AbortMultipartUpload` 清理。
   - **全局屏障**：任一账户在 Phase 1 失败时立即中止整次发布，绝不写入任何账户的 `latest.json` 或 `host.json`。
   - **Phase 2（可变索引指针层）**：按各账户自身的 `publicBaseUrl` 独立重写 `host.json`（剥离本地开发态 `debugHttpHosts`、对齐同源地址），最后更新 `latest.json`（`Cache-Control: public, max-age=30, must-revalidate`），并按 30 URL/批自动调用 Cloudflare Zone Cache Purge API 刷新边缘节点缓存。
3. **客户端构建期内置路由表 + 同源故障转移（零额外网关请求）**：
   - 构建或发布时自动生成 `pocket-endpoints.json` 并打入 `flutter/assets/pocket-endpoints.json`。
   - Dart 宿主通过 `PocketPlatformEndpoints` 按当前运行平台读取 `primaryUrl` 与 `fallbackUrls`。当主账户发生网络超时或 5xx 瞬态故障时自动切换至备用账户；若遇到 `FormatException`、Ed25519 签名不匹配、SHA-256 摘要不符或非同源重定向则立即拒绝（Fail-Closed），严守同源与签名信任锚安全模型。

## 2. 本地多账户凭据保险箱

凭据切勿写入 `pocket.json`、`editor.json` 或代码仓库。使用 CLI 将多账户 R2 S3 凭据与可选 Zone/Pages API Token 存入本地 `0o600` 权限保险箱（`<workspace>/keys/cloudflare-credentials.json`），或通过环境变量 `POCKET_CF_ACCOUNTS_JSON` 注入：

```sh
# 查看本机已配置的脱敏账户列表
npm --prefix sdk run cf -- inspect

# 添加或更新账户配置（支持设置多个不同 Cloudflare 账户）
npm --prefix sdk run cf -- profile-set \
  --profile cf-apple \
  --account-id <32位Hex账户ID> \
  --access-key-id <R2_ACCESS_KEY_ID> \
  --secret-access-key <R2_SECRET_ACCESS_KEY> \
  --api-token <CLOUDFLARE_API_TOKEN> \
  --default

# 校验 R2 存储桶读写探针权限
npm --prefix sdk run cf -- check --profile cf-apple --bucket pocket-apple
```

## 3. 项目多账户平台矩阵配置与构建

在项目的 `editor.json` 或 `pocket.json` 中声明公开非敏感的目标矩阵（不含任何密钥）：

```json
{
  "cloudflare": {
    "enabled": true,
    "slot": "stable",
    "hostVersion": "0.1.22",
    "keyId": "prod-ed25519-2026",
    "publicKey": "<32字节Ed25519公钥Base64>",
    "targets": [
      {
        "profileId": "cf-apple",
        "accountId": "a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2",
        "bucket": "pocket-apple",
        "publicBaseUrl": "https://ota-apple.test",
        "platforms": ["ios", "macos"],
        "role": "primary",
        "zoneId": "11221122112211221122112211221122"
      },
      {
        "profileId": "cf-android",
        "accountId": "c3d4c3d4c3d4c3d4c3d4c3d4c3d4c3d4",
        "bucket": "pocket-android",
        "publicBaseUrl": "https://ota-android.test",
        "platforms": ["android", "windows", "linux", "web", "wechat"],
        "role": "primary"
      },
      {
        "profileId": "cf-global-backup",
        "accountId": "e5f6e5f6e5f6e5f6e5f6e5f6e5f6e5f6",
        "bucket": "pocket-backup",
        "publicBaseUrl": "https://ota-backup.test",
        "platforms": ["*"],
        "role": "fallback"
      }
    ]
  }
}
```

运行 `bun sdk/pocket.ts build <project>` 时，构建管线会自动将 `pocket-endpoints.json` 生成至 `build/pocket/pocket-endpoints.json` 与 `flutter/assets/pocket-endpoints.json`，并自动挂载到 `flutter/pubspec.yaml` 的 `assets` 列表。

## 4. 发布热更包、原生安装包与 Web 产物

```sh
# 1) 多账户两阶段热更发布 + 自动 Zone Cache Purge + 输出平台路由表
npm --prefix sdk run cf -- publish \
  --deploy-root ./deploy \
  --slot stable \
  --targets-file ./cf-targets.json \
  --public-key-file ./keys/release-public.pem \
  --endpoints-out ./flutter/assets/pocket-endpoints.json

# 2) 按平台分发原生安装包（IPA/APK/DMG）并生成 Ed25519 签名下载清单
npm --prefix sdk run cf -- publish-installers \
  --app-id com.example.app \
  --channel stable \
  --targets-file ./cf-targets.json \
  --key-file ./keys/release-private.json \
  --installer ios:1.0.0:10:./dist/App-1.0.0.ipa \
  --installer android:1.0.0:10:./dist/App-1.0.0.apk

# 3) 部署 build:web 产物至 Cloudflare Pages / Workers Static Assets / R2 静态站
npm --prefix sdk run cf -- deploy-web \
  --mode pages \
  --profile cf-android \
  --project pocket-web-app \
  --web-dir ./build/web
```

## 5. Flutter 宿主侧接入示例

```dart
import 'package:flutter/material.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final endpoints = await PocketPlatformEndpoints.loadFromAsset();

  // 方式 A：单应用 PocketApp 按当前平台自动绑定更新源
  runApp(
    PocketApp(
      config: PocketAppConfig(
        appId: endpoints.appId,
        updates: endpoints.toUpdateConfig(),
      ),
    ),
  );

  // 方式 B：混合宿主或多应用目录使用主备自动故障转移加载 PocketHostConfig
  // final hostConfig = await endpoints.loadHostConfig();
}
```
