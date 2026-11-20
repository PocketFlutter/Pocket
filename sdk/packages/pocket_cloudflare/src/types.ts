export const CLOUDFLARE_CONCRETE_PLATFORMS = [
  "ios",
  "android",
  "macos",
  "windows",
  "linux",
  "web",
  "wechat",
] as const;

export type CloudflareConcretePlatform =
  (typeof CLOUDFLARE_CONCRETE_PLATFORMS)[number];

export type CloudflarePlatformSelector = CloudflareConcretePlatform | "*";

export type CloudflareRouteRole = "primary" | "fallback";

export type CloudflareR2Credentials = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  apiToken?: string;
};

export type CloudflareCredentialProvider =
  | CloudflareR2Credentials
  | (() => CloudflareR2Credentials | Promise<CloudflareR2Credentials>);

export type CloudflareBucketSummary = {
  bucket: string;
  publicBaseUrl?: string;
  alias?: string;
};

export type CloudflareAccountProfile = {
  profileId: string;
  accountId: string;
  label?: string;
  maskedAccountId: string;
  maskedAccessKeyId: string;
  hasSessionToken: boolean;
  hasApiToken: boolean;
  buckets: CloudflareBucketSummary[];
};

export type CloudflareTargetConfig = {
  profileId?: string;
  accountId: string;
  bucket: string;
  endpoint?: string;
  keyPrefix?: string;
  publicBaseUrl?: string;
  platforms?: readonly CloudflarePlatformSelector[];
  role?: CloudflareRouteRole;
  zoneId?: string;
  pagesProjectName?: string;
  workerScriptName?: string;
  apiBaseOrigin?: string;
  allowInsecureHttpForTesting?: boolean;
};

export type ResolvedCloudflareTarget = {
  profileId?: string;
  accountId: string;
  bucket: string;
  endpointOrigin: string;
  endpointHost: string;
  bucketPathPrefix: string;
  keyPrefix: string;
  publicBaseUrl: string;
  platforms: CloudflarePlatformSelector[];
  role: CloudflareRouteRole;
  zoneId?: string;
  pagesProjectName?: string;
  workerScriptName?: string;
  apiBaseOrigin: string;
  allowInsecureHttpForTesting: boolean;
};

export type ProjectCloudflareRouteConfig = {
  profileId: string;
  accountId?: string;
  bucket: string;
  endpoint?: string;
  keyPrefix?: string;
  publicBaseUrl: string;
  platforms: CloudflarePlatformSelector[];
  role?: CloudflareRouteRole;
  zoneId?: string;
  pagesProjectName?: string;
  workerScriptName?: string;
  allowInsecureHttpForTesting?: boolean;
};

export type EditorProjectCloudflareConfig = {
  enabled: boolean;
  syncOnPublish?: boolean;
  purgeCacheOnPublish?: boolean;
  targets: ProjectCloudflareRouteConfig[];
};

export type LocalCloudflareInspection = {
  available: boolean;
  source: "env" | "workspace" | "wrangler" | "none";
  sourceDetail: string;
  defaultProfileId?: string;
  profiles: CloudflareAccountProfile[];
};

export type CloudflareUploadProgress = {
  targetKey: string;
  profileId?: string;
  bucket: string;
  phase: "phase1" | "phase2" | "purge" | "installer" | "web";
  relativeKey: string;
  objectKey: string;
  action: "uploaded" | "skipped" | "purged";
  bytes: number;
  completedFiles: number;
  totalFiles: number;
};

export type CloudflarePublishFileRecord = {
  relativeKey: string;
  objectKey: string;
  size: number;
  sha256: string;
  cacheControl: string;
  contentType: string;
  phase: "phase1" | "phase2";
  action: "uploaded" | "skipped";
};

export type CloudflarePurgeSummary = {
  zoneId: string;
  purgedUrls: string[];
  batches: number;
};

export type CloudflareTargetPublishResult = {
  profileId?: string;
  accountId: string;
  bucket: string;
  keyPrefix: string;
  publicBaseUrl: string;
  platforms: CloudflarePlatformSelector[];
  role: CloudflareRouteRole;
  dryRun: boolean;
  uploadedFiles: number;
  skippedFiles: number;
  uploadedBytes: number;
  skippedBytes: number;
  files: CloudflarePublishFileRecord[];
  manifestUrls: string[];
  mutablePublicUrls: string[];
  cachePurge?: CloudflarePurgeSummary;
  publishedAt: string;
};

export type PlatformEndpointRoute = {
  primaryUrl: string;
  fallbackUrls: string[];
};

export type PlatformEndpointsDocument = {
  schemaVersion: 1;
  kind: "pocket-platform-endpoints";
  appId: string;
  hostVersion: string;
  packageVersion?: string;
  slot?: "test" | "stable";
  keyId?: string;
  publicKey?: string;
  trustRootKeyId?: string;
  trustRootPublicKey?: string;
  trustPolicyUrl?: string;
  routes: Partial<Record<CloudflarePlatformSelector, PlatformEndpointRoute>>;
  generatedAt: string;
};

export type CloudflareMatrixPublishResult = {
  dryRun: boolean;
  targets: CloudflareTargetPublishResult[];
  platformEndpoints?: PlatformEndpointsDocument;
  publishedAt: string;
};

export type NativeInstallerInput = {
  platform: CloudflareConcretePlatform;
  filePath: string;
  version: string;
  build: number;
  fileName?: string;
  releaseNotes?: string;
  minimumOsVersion?: string;
};

export type NativeInstallerRecord = {
  platform: CloudflareConcretePlatform;
  version: string;
  build: number;
  fileName: string;
  size: number;
  sha256: string;
  contentType: string;
  downloadUrl: string;
  fallbackDownloadUrls: string[];
  releaseNotes?: string;
  minimumOsVersion?: string;
  publishedAt: string;
};

export type NativeDownloadManifestPayload = {
  schemaVersion: 1;
  kind: "pocket-native-download-manifest";
  appId: string;
  channel: "test" | "stable";
  publishedAt: string;
  platforms: Partial<Record<CloudflareConcretePlatform, NativeInstallerRecord>>;
};

export type SignedNativeDownloadManifest = {
  schemaVersion: 1;
  kind: "pocket-signed-native-download-manifest";
  keyId?: string;
  signature?: string;
  payload: string;
  decoded: NativeDownloadManifestPayload;
};

export const CF_ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;
export const CF_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const R2_BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const CF_ZONE_ID_PATTERN = /^[a-f0-9]{32}$/i;
export const CF_PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]?$/i;

const VALID_PLATFORMS = new Set<string>([
  ...CLOUDFLARE_CONCRETE_PLATFORMS,
  "*",
]);

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function validateCloudflareAccountId(accountId: string): string {
  const trimmed = typeof accountId === "string" ? accountId.trim().toLowerCase() : "";
  if (!CF_ACCOUNT_ID_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid Cloudflare accountId "${accountId}": must be a 32-character hex ID`,
    );
  }
  return trimmed;
}

export function validateCloudflareProfileId(profileId: string): string {
  const trimmed = typeof profileId === "string" ? profileId.trim() : "";
  if (!CF_PROFILE_ID_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid Cloudflare profileId "${profileId}": must match ${CF_PROFILE_ID_PATTERN.source}`,
    );
  }
  return trimmed;
}

export function validateR2Bucket(bucket: string): string {
  const trimmed = typeof bucket === "string" ? bucket.trim() : "";
  if (!R2_BUCKET_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid Cloudflare R2 bucket "${bucket}": must match ${R2_BUCKET_PATTERN.source}`,
    );
  }
  return trimmed;
}

export function validateCloudflareZoneId(zoneId: string): string {
  const trimmed = typeof zoneId === "string" ? zoneId.trim().toLowerCase() : "";
  if (!CF_ZONE_ID_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid Cloudflare zoneId "${zoneId}": must be a 32-character hex ID`,
    );
  }
  return trimmed;
}

export function normalizeCloudflarePlatforms(
  platforms?: readonly string[] | string,
): CloudflarePlatformSelector[] {
  if (platforms === undefined || platforms === null) {
    return ["*"];
  }
  const rawItems =
    typeof platforms === "string"
      ? platforms
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean)
      : Array.isArray(platforms)
        ? platforms.map((item) =>
            typeof item === "string" ? item.trim().toLowerCase() : "",
          )
        : [];
  if (rawItems.length === 0) {
    throw new Error("Cloudflare target platforms list must not be empty");
  }
  const seen = new Set<CloudflarePlatformSelector>();
  for (const item of rawItems) {
    if (!VALID_PLATFORMS.has(item)) {
      throw new Error(
        `Unsupported Cloudflare target platform "${item}" (expected one of: ${[...VALID_PLATFORMS].join(", ")})`,
      );
    }
    seen.add(item as CloudflarePlatformSelector);
  }
  return [...seen];
}

export function normalizeR2KeyPrefix(raw?: string): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") {
    throw new Error("Cloudflare R2 keyPrefix must be a string");
  }
  if (hasControlCharacter(raw)) {
    throw new Error("Cloudflare R2 keyPrefix must not contain control characters");
  }
  if (raw.includes("\\")) {
    throw new Error("Cloudflare R2 keyPrefix must not contain backslashes");
  }
  if (raw.includes("%")) {
    throw new Error("Cloudflare R2 keyPrefix must not contain percent-encoded sequences");
  }
  if (raw.includes("?") || raw.includes("#")) {
    throw new Error("Cloudflare R2 keyPrefix must not contain query or fragment characters");
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "/") return "";
  const stripped = trimmed.replace(/^\/+|\/+$/g, "");
  if (!stripped) return "";
  if (stripped.includes("//")) {
    throw new Error("Cloudflare R2 keyPrefix must not contain empty path segments");
  }
  const segments = stripped.split("/");
  for (const segment of segments) {
    if (!segment || segment.trim() !== segment) {
      throw new Error(
        "Cloudflare R2 keyPrefix must not contain empty or whitespace-padded segments",
      );
    }
    if (segment === "." || segment === "..") {
      throw new Error("Cloudflare R2 keyPrefix must not contain '.' or '..' segments");
    }
    if (segment === "pocket") {
      throw new Error(
        'Cloudflare R2 keyPrefix must not contain a reserved "pocket" path segment',
      );
    }
  }
  return segments.join("/");
}

export function resolveCloudflareTarget(
  config: CloudflareTargetConfig,
): ResolvedCloudflareTarget {
  if (!config || typeof config !== "object") {
    throw new Error("Cloudflare target configuration is required");
  }
  const profileId = config.profileId?.trim()
    ? validateCloudflareProfileId(config.profileId)
    : undefined;
  const accountId = validateCloudflareAccountId(config.accountId);
  const bucket = validateR2Bucket(config.bucket);
  const keyPrefix = normalizeR2KeyPrefix(config.keyPrefix);
  const platforms = normalizeCloudflarePlatforms(config.platforms);
  const role: CloudflareRouteRole = config.role ?? "primary";
  if (role !== "primary" && role !== "fallback") {
    throw new Error(`Invalid Cloudflare target role "${String(config.role)}"`);
  }
  const zoneId = config.zoneId?.trim()
    ? validateCloudflareZoneId(config.zoneId)
    : undefined;
  const pagesProjectName = config.pagesProjectName?.trim() || undefined;
  if (pagesProjectName && !CF_PROJECT_NAME_PATTERN.test(pagesProjectName)) {
    throw new Error(`Invalid Cloudflare Pages project name "${pagesProjectName}"`);
  }
  const workerScriptName = config.workerScriptName?.trim() || undefined;
  if (workerScriptName && !CF_PROJECT_NAME_PATTERN.test(workerScriptName)) {
    throw new Error(`Invalid Cloudflare Worker script name "${workerScriptName}"`);
  }

  const allowInsecure = config.allowInsecureHttpForTesting === true;
  const rawEndpoint = config.endpoint?.trim()
    ? /^https?:\/\//i.test(config.endpoint.trim())
      ? config.endpoint.trim()
      : `https://${config.endpoint.trim()}`
    : `https://${accountId}.r2.cloudflarestorage.com`;

  let endpointUrl: URL;
  try {
    endpointUrl = new URL(rawEndpoint);
  } catch {
    throw new Error(`Invalid Cloudflare R2 endpoint URL: ${rawEndpoint}`);
  }
  if (endpointUrl.username || endpointUrl.password || endpointUrl.search || endpointUrl.hash) {
    throw new Error("Cloudflare R2 endpoint must not include credentials, query, or hash");
  }
  if (endpointUrl.pathname !== "/" && endpointUrl.pathname !== "") {
    throw new Error("Cloudflare R2 endpoint must be an origin without a path");
  }
  if (
    endpointUrl.protocol !== "https:" &&
    !(allowInsecure && endpointUrl.protocol === "http:")
  ) {
    throw new Error("Cloudflare R2 endpoint must use https://");
  }

  const apiBaseRaw = config.apiBaseOrigin?.trim() || "https://api.cloudflare.com";
  let apiBaseUrl: URL;
  try {
    apiBaseUrl = new URL(apiBaseRaw);
  } catch {
    throw new Error(`Invalid Cloudflare apiBaseOrigin: ${apiBaseRaw}`);
  }
  if (
    apiBaseUrl.protocol !== "https:" &&
    !(allowInsecure && apiBaseUrl.protocol === "http:")
  ) {
    throw new Error("Cloudflare apiBaseOrigin must use https://");
  }

  let publicBaseUrl: string;
  if (config.publicBaseUrl !== undefined && config.publicBaseUrl.trim() !== "") {
    const rawPublic = config.publicBaseUrl.trim();
    let parsedPublic: URL;
    try {
      parsedPublic = new URL(rawPublic);
    } catch {
      throw new Error(`Invalid Cloudflare publicBaseUrl: ${rawPublic}`);
    }
    if (parsedPublic.username || parsedPublic.password) {
      throw new Error("Cloudflare publicBaseUrl must not contain userinfo credentials");
    }
    if (parsedPublic.search || parsedPublic.hash) {
      throw new Error(
        "Cloudflare publicBaseUrl must not contain query parameters or fragments",
      );
    }
    if (
      parsedPublic.protocol !== "https:" &&
      !(allowInsecure && parsedPublic.protocol === "http:")
    ) {
      throw new Error("Cloudflare publicBaseUrl must use https://");
    }
    const cleanPath = parsedPublic.pathname.replace(/\/+$/g, "");
    const pathSegments = cleanPath
      .replace(/^\/+/g, "")
      .split("/")
      .filter(Boolean);
    if (pathSegments.includes("pocket")) {
      throw new Error(
        'Cloudflare publicBaseUrl pathname must not contain a reserved "pocket" path segment',
      );
    }
    publicBaseUrl = `${parsedPublic.origin}${cleanPath}`;
  } else {
    publicBaseUrl = `${endpointUrl.origin}/${bucket}${keyPrefix ? `/${keyPrefix}` : ""}`;
  }

  return {
    ...(profileId ? { profileId } : {}),
    accountId,
    bucket,
    endpointOrigin: endpointUrl.origin,
    endpointHost: endpointUrl.host,
    bucketPathPrefix: `/${bucket}`,
    keyPrefix,
    publicBaseUrl,
    platforms,
    role,
    ...(zoneId ? { zoneId } : {}),
    ...(pagesProjectName ? { pagesProjectName } : {}),
    ...(workerScriptName ? { workerScriptName } : {}),
    apiBaseOrigin: apiBaseUrl.origin,
    allowInsecureHttpForTesting: allowInsecure,
  };
}

export function validateCloudflareRouteMatrix(
  targets: readonly ResolvedCloudflareTarget[],
): void {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("At least one Cloudflare target route is required");
  }
  const primaryOwnerByPlatform = new Map<CloudflarePlatformSelector, string>();
  const seenPublicOrigins = new Map<string, string>();

  for (const target of targets) {
    const label = target.profileId
      ? `${target.profileId} (${target.bucket})`
      : `${target.accountId.slice(0, 8)}:${target.bucket}`;

    const duplicateKey = `${target.role}:${target.publicBaseUrl}`;
    if (seenPublicOrigins.has(duplicateKey)) {
      throw new Error(
        `Duplicate Cloudflare ${target.role} target publicBaseUrl "${target.publicBaseUrl}" between ${seenPublicOrigins.get(duplicateKey)} and ${label}`,
      );
    }
    seenPublicOrigins.set(duplicateKey, label);

    if (target.role === "primary") {
      for (const platform of target.platforms) {
        const existing = primaryOwnerByPlatform.get(platform);
        if (existing) {
          throw new Error(
            `Platform "${platform}" is assigned to multiple primary Cloudflare targets: ${existing} and ${label}. Mark secondary mirrors with role: "fallback".`,
          );
        }
        primaryOwnerByPlatform.set(platform, label);
      }
    }
  }

  if (primaryOwnerByPlatform.size === 0) {
    throw new Error(
      'Cloudflare route matrix requires at least one target with role: "primary"',
    );
  }
}

export function targetMatchesPlatform(
  target: Pick<ResolvedCloudflareTarget, "platforms">,
  platform: CloudflareConcretePlatform,
): boolean {
  return target.platforms.includes(platform) || target.platforms.includes("*");
}

function buildCanonicalEntryUrl(
  publicBaseUrl: string,
  options: {
    appId: string;
    hostVersion: string;
    slot?: "test" | "stable";
    routeVersion?: string;
  },
): string {
  const cleanBase = publicBaseUrl.replace(/\/+$/g, "");
  const encodedApp = encodeURIComponent(options.appId);
  const encodedHost = encodeURIComponent(options.hostVersion);
  if (options.slot) {
    return `${cleanBase}/${options.slot}/pocket/${encodedHost}/${encodedApp}/latest.json`;
  }
  if (options.routeVersion) {
    return `${cleanBase}/pocket/${encodedHost}/${encodedApp}/${encodeURIComponent(options.routeVersion)}/latest.json`;
  }
  return `${cleanBase}/pocket/${encodedHost}/${encodedApp}/latest.json`;
}

export function buildPlatformEndpointsDocument(options: {
  targets: readonly ResolvedCloudflareTarget[];
  appId: string;
  hostVersion: string;
  packageVersion?: string;
  slot?: "test" | "stable";
  routeVersion?: string;
  keyId?: string;
  publicKey?: string;
  trustRootKeyId?: string;
  trustRootPublicKey?: string;
  trustPolicyUrl?: string;
  generatedAt?: string;
}): PlatformEndpointsDocument {
  validateCloudflareRouteMatrix(options.targets);
  if (!options.appId?.trim()) {
    throw new Error("appId is required to build pocket-platform-endpoints");
  }
  if (!options.hostVersion?.trim()) {
    throw new Error("hostVersion is required to build pocket-platform-endpoints");
  }

  const routes: Partial<Record<CloudflarePlatformSelector, PlatformEndpointRoute>> = {};

  const resolveForSelector = (
    selector: CloudflarePlatformSelector,
  ): PlatformEndpointRoute | undefined => {
    const exactPrimary = options.targets.find(
      (t) => t.role === "primary" && t.platforms.includes(selector),
    );
    const wildcardPrimary =
      selector === "*"
        ? exactPrimary
        : options.targets.find(
            (t) => t.role === "primary" && t.platforms.includes("*"),
          );
    const chosenPrimary = exactPrimary ?? wildcardPrimary;
    if (!chosenPrimary) return undefined;

    const primaryUrl = buildCanonicalEntryUrl(chosenPrimary.publicBaseUrl, options);
    const fallbackTargets = [
      ...options.targets.filter(
        (t) => t.role === "fallback" && t.platforms.includes(selector),
      ),
      ...(selector === "*"
        ? []
        : options.targets.filter(
            (t) => t.role === "fallback" && t.platforms.includes("*"),
          )),
    ];

    const fallbackUrls: string[] = [];
    const seen = new Set<string>([primaryUrl]);
    for (const fb of fallbackTargets) {
      const url = buildCanonicalEntryUrl(fb.publicBaseUrl, options);
      if (!seen.has(url)) {
        seen.add(url);
        fallbackUrls.push(url);
      }
    }

    return { primaryUrl, fallbackUrls };
  };

  const wildcardRoute = resolveForSelector("*");
  if (wildcardRoute) {
    routes["*"] = wildcardRoute;
  }

  for (const platform of CLOUDFLARE_CONCRETE_PLATFORMS) {
    const hasExplicitTarget = options.targets.some((t) =>
      t.platforms.includes(platform),
    );
    if (!hasExplicitTarget && wildcardRoute) {
      continue;
    }
    const route = resolveForSelector(platform);
    if (route) {
      routes[platform] = route;
    }
  }

  return {
    schemaVersion: 1,
    kind: "pocket-platform-endpoints",
    appId: options.appId.trim(),
    hostVersion: options.hostVersion.trim(),
    ...(options.packageVersion?.trim()
      ? { packageVersion: options.packageVersion.trim() }
      : {}),
    ...(options.slot ? { slot: options.slot } : {}),
    ...(options.keyId?.trim() ? { keyId: options.keyId.trim() } : {}),
    ...(options.publicKey?.trim() ? { publicKey: options.publicKey.trim() } : {}),
    ...(options.trustRootKeyId?.trim()
      ? { trustRootKeyId: options.trustRootKeyId.trim() }
      : {}),
    ...(options.trustRootPublicKey?.trim()
      ? { trustRootPublicKey: options.trustRootPublicKey.trim() }
      : {}),
    ...(options.trustPolicyUrl?.trim()
      ? { trustPolicyUrl: options.trustPolicyUrl.trim() }
      : {}),
    routes,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  };
}

export type CloudflareStudioTargetSummary = {
  profileId?: string;
  accountId: string;
  bucket: string;
  keyPrefix: string;
  publicBaseUrl: string;
  platforms: CloudflarePlatformSelector[];
  role: CloudflareRouteRole;
  appConfigUrl: string;
  hostConfigUrl: string;
  uploadedFiles: number;
  skippedFiles: number;
  uploadedBytes: number;
  skippedBytes: number;
  purgedUrls?: number;
};

export type CloudflareStudioPublishSummary = {
  appConfigUrl: string;
  hostConfigUrl: string;
  slot: "test" | "stable";
  channel: string;
  releaseId: string;
  version: string;
  build: number;
  uploadedFiles: number;
  skippedFiles: number;
  uploadedBytes: number;
  skippedBytes: number;
  purgedZones: number;
  targets: CloudflareStudioTargetSummary[];
  platformEndpoints: PlatformEndpointsDocument;
  publishedAt: string;
};
