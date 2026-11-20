# `@pocket/cloudflare` — Multi-Account Platform-Routed Cloudflare Publisher

Zero-third-party-dependency Cloudflare R2 (AWS Signature V4), Zone Cache Purge, Pages Direct Upload, Workers Static Assets, and Native Installer publisher for Pocket applications.

## Capabilities

1. **Pure TypeScript AWS SigV4 Signing (`@pocket/cloudflare/sign`)**:
   - Zero `node:*` imports — runs identically in Node.js, Bun, Browser, Web Worker, and QuickJS.
   - Implements `AWS4-HMAC-SHA256` request signing and presigned URLs for Cloudflare R2 (`region: "auto"`, `service: "s3"`).
2. **Multi-Account Local Credential Vault (`@pocket/cloudflare/local-config`)**:
   - Stores named account profiles (`profileId -> { accountId, accessKeyId, secretAccessKey, apiToken }`) in `<workspace>/keys/cloudflare-credentials.json` (`0o600` permissions, symlink-rejected, redacted in logs/errors) or `POCKET_CF_ACCOUNTS_JSON`.
3. **Multi-Account × Platform Matrix Routing (`@pocket/cloudflare/types`)**:
   - Assigns each Cloudflare account + R2 bucket to a platform list (`ios`, `android`, `macos`, `windows`, `linux`, `web`, `wechat`, `*`) and role (`primary` or `fallback`).
   - Enforces single-primary-per-platform invariants and emits `pocket-platform-endpoints` (`pocket-endpoints.json`) for automatic same-origin client routing and primary-to-fallback failover.
4. **Cross-Account Two-Phase Atomic OTA & Native Installer Publishing (`@pocket/cloudflare/publisher`)**:
   - **Phase 1**: Uploads immutable `blobs/<sha256>`, `bundles/bundle-<sha256>.(7z|zip)`, `bootstrap/*`, and platform-filtered native installers (`IPA/APK/DMG/MSIX`) across all matched accounts before any Phase 2 pointer updates.
   - **Phase 2**: Rebases `host.json` to each account's own `publicBaseUrl`, updates `latest.json` and signed `download-manifest.json` strictly last (`no-store`), and automatically purges Cloudflare Zone Cache (`POST /zones/<zoneId>/purge_cache`).
5. **Cloudflare Pages & Workers Static Assets Web Deployment (`@pocket/cloudflare/pages`)**:
   - Deploys `build_web.ts` artifacts directly to Cloudflare Pages Direct Upload, Cloudflare Workers Static Assets, or R2 static site paths.
