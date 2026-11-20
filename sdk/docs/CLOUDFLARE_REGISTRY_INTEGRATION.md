# Cloudflare 发布与包注册表修复记录

保留的父项目 `../pocketjs_flutter_demo`（排除 `pocket_host/`）中没有 Cloudflare 发布或包注册表实现。原有运行时、原生宿主及编译路径继续沿用。

- 复用 `sdk/scripts/package_update.ts` 的签名包与摘要校验，以及 `sdk/editor/version_store.ts` 中的发布记录契约。GitHub Packages 与静态注册表从同一套源文件装配独立的 COS 和 Cloudflare 包。
- Studio 复用 `sdk/editor/server.ts` 的本机敏感操作检查和安全项目文件写入。Cloudflare 发布对各目标验证历史产物，并保持既有两阶段上传顺序。
- 安装和移除共享 `sdk/scripts/package_installer.ts` 的锁定、归档验证与项目变更回滚。测试运行真实 Studio HTTP 及 Chromium 客户端，Cloudflare 存储请求由本地测试传输处理。
