import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  CF_ACCOUNT_ID_PATTERN,
  CF_PROFILE_ID_PATTERN,
  R2_BUCKET_PATTERN,
  validateCloudflareAccountId,
  validateCloudflareProfileId,
  type CloudflareAccountProfile,
  type CloudflareBucketSummary,
  type CloudflareR2Credentials,
  type LocalCloudflareInspection,
} from "./types.ts";

const MAX_CONFIG_FILE_BYTES = 256 * 1024;
export const WORKSPACE_CLOUDFLARE_CREDENTIALS_FILENAME =
  "cloudflare-credentials.json";

export function maskSecretValue(value: string): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return "";
  if (s.length >= 8) {
    return `${s.slice(0, 4)}****${s.slice(-4)}`;
  }
  return `${s.slice(0, 2)}****`;
}

export function maskAccountId(accountId: string): string {
  const s = typeof accountId === "string" ? accountId.trim().toLowerCase() : "";
  if (s.length >= 12) {
    return `${s.slice(0, 6)}...${s.slice(-4)}`;
  }
  return maskSecretValue(s);
}

function readSafeConfigFile(filePath: string): string | undefined {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(filePath);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
  if (stat.size <= 0 || stat.size > MAX_CONFIG_FILE_BYTES) return undefined;
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export type StoredCloudflareAccountEntry = {
  profileId: string;
  accountId: string;
  label?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  apiToken?: string;
  buckets?: CloudflareBucketSummary[];
};

type WorkspaceCloudflareVault = {
  schemaVersion: 1;
  defaultProfileId?: string;
  profiles: Record<string, StoredCloudflareAccountEntry>;
  updatedAt?: string;
};

export type LocalCloudflareOptions = {
  env?: NodeJS.ProcessEnv;
  workspaceKeysDir?: string;
  homeDir?: string;
  wranglerConfigPath?: string;
};

function sanitizeBuckets(raw: unknown): CloudflareBucketSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: CloudflareBucketSummary[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const bucket = typeof rec.bucket === "string" ? rec.bucket.trim() : "";
    if (!R2_BUCKET_PATTERN.test(bucket)) continue;
    const publicBaseUrl =
      typeof rec.publicBaseUrl === "string" && rec.publicBaseUrl.trim()
        ? rec.publicBaseUrl.trim().replace(/\/+$/g, "")
        : undefined;
    const alias =
      typeof rec.alias === "string" && rec.alias.trim()
        ? rec.alias.trim()
        : undefined;
    out.push({
      bucket,
      ...(publicBaseUrl ? { publicBaseUrl } : {}),
      ...(alias ? { alias } : {}),
    });
  }
  return out;
}

function sanitizeAccountEntry(
  raw: unknown,
  fallbackProfileId?: string,
): StoredCloudflareAccountEntry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const profileId =
    typeof rec.profileId === "string" && rec.profileId.trim()
      ? rec.profileId.trim()
      : fallbackProfileId?.trim() ?? "";
  const accountId =
    typeof rec.accountId === "string" ? rec.accountId.trim().toLowerCase() : "";
  const accessKeyId =
    typeof rec.accessKeyId === "string" ? rec.accessKeyId.trim() : "";
  const secretAccessKey =
    typeof rec.secretAccessKey === "string" ? rec.secretAccessKey.trim() : "";
  if (
    !CF_PROFILE_ID_PATTERN.test(profileId) ||
    !CF_ACCOUNT_ID_PATTERN.test(accountId) ||
    !accessKeyId ||
    !secretAccessKey
  ) {
    return undefined;
  }
  const sessionToken =
    typeof rec.sessionToken === "string" && rec.sessionToken.trim()
      ? rec.sessionToken.trim()
      : undefined;
  const apiToken =
    typeof rec.apiToken === "string" && rec.apiToken.trim()
      ? rec.apiToken.trim()
      : undefined;
  const label =
    typeof rec.label === "string" && rec.label.trim()
      ? rec.label.trim()
      : undefined;
  const buckets = sanitizeBuckets(rec.buckets);
  return {
    profileId,
    accountId,
    ...(label ? { label } : {}),
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    ...(apiToken ? { apiToken } : {}),
    ...(buckets.length > 0 ? { buckets } : {}),
  };
}

function toPublicProfile(
  entry: StoredCloudflareAccountEntry,
): CloudflareAccountProfile {
  return {
    profileId: entry.profileId,
    accountId: entry.accountId,
    ...(entry.label ? { label: entry.label } : {}),
    maskedAccountId: maskAccountId(entry.accountId),
    maskedAccessKeyId: maskSecretValue(entry.accessKeyId),
    hasSessionToken: Boolean(entry.sessionToken),
    hasApiToken: Boolean(entry.apiToken),
    buckets: entry.buckets ? [...entry.buckets] : [],
  };
}

function readEnvAccounts(env: NodeJS.ProcessEnv): {
  entries: StoredCloudflareAccountEntry[];
  defaultProfileId?: string;
  detail?: string;
} {
  const entries: StoredCloudflareAccountEntry[] = [];
  const multiJson = env.POCKET_CF_ACCOUNTS_JSON?.trim();
  if (multiJson) {
    try {
      const parsed = JSON.parse(multiJson) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const clean = sanitizeAccountEntry(item);
          if (clean) entries.push(clean);
        }
      } else if (parsed && typeof parsed === "object") {
        for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
          const clean = sanitizeAccountEntry(val, key);
          if (clean) entries.push(clean);
        }
      }
      if (entries.length > 0) {
        return {
          entries,
          defaultProfileId:
            env.POCKET_CF_DEFAULT_PROFILE?.trim() || entries[0]!.profileId,
          detail: "Environment variables (POCKET_CF_ACCOUNTS_JSON)",
        };
      }
    } catch {
      // Ignore malformed JSON and check flat env vars next.
    }
  }

  const accountId = (
    env.POCKET_CF_ACCOUNT_ID ??
    env.CLOUDFLARE_ACCOUNT_ID ??
    env.CF_ACCOUNT_ID ??
    ""
  )
    .trim()
    .toLowerCase();
  const accessKeyId = (
    env.POCKET_CF_ACCESS_KEY_ID ??
    env.R2_ACCESS_KEY_ID ??
    env.CLOUDFLARE_R2_ACCESS_KEY_ID ??
    ""
  ).trim();
  const secretAccessKey = (
    env.POCKET_CF_SECRET_ACCESS_KEY ??
    env.R2_SECRET_ACCESS_KEY ??
    env.CLOUDFLARE_R2_SECRET_ACCESS_KEY ??
    ""
  ).trim();
  const sessionToken = (
    env.POCKET_CF_SESSION_TOKEN ??
    env.R2_SESSION_TOKEN ??
    ""
  ).trim();
  const apiToken = (
    env.POCKET_CF_API_TOKEN ??
    env.CLOUDFLARE_API_TOKEN ??
    env.CF_API_TOKEN ??
    ""
  ).trim();
  const envBucket = (env.POCKET_CF_BUCKET ?? env.R2_BUCKET ?? "").trim();
  const envPublicUrl = (
    env.POCKET_CF_PUBLIC_BASE_URL ??
    env.R2_PUBLIC_BASE_URL ??
    ""
  ).trim();
  const profileId = (env.POCKET_CF_PROFILE_ID ?? "default").trim();

  const single = sanitizeAccountEntry({
    profileId,
    accountId,
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    ...(apiToken ? { apiToken } : {}),
    ...(R2_BUCKET_PATTERN.test(envBucket)
      ? {
          buckets: [
            {
              bucket: envBucket,
              ...(envPublicUrl ? { publicBaseUrl: envPublicUrl } : {}),
            },
          ],
        }
      : {}),
  });
  if (single) {
    return {
      entries: [single],
      defaultProfileId: single.profileId,
      detail: "Environment variables (CLOUDFLARE_ACCOUNT_ID / R2_ACCESS_KEY_ID)",
    };
  }
  return { entries: [] };
}

function readWorkspaceVault(workspaceKeysDir?: string): {
  entries: StoredCloudflareAccountEntry[];
  defaultProfileId?: string;
  detail?: string;
} {
  if (!workspaceKeysDir) return { entries: [] };
  let dirStat: ReturnType<typeof lstatSync> | undefined;
  try {
    dirStat = lstatSync(workspaceKeysDir);
  } catch {
    dirStat = undefined;
  }
  if (dirStat && dirStat.isSymbolicLink()) return { entries: [] };

  const filePath = join(
    resolve(workspaceKeysDir),
    WORKSPACE_CLOUDFLARE_CREDENTIALS_FILENAME,
  );
  const raw = readSafeConfigFile(filePath);
  if (!raw) return { entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { entries: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const entries: StoredCloudflareAccountEntry[] = [];

  if (obj.profiles && typeof obj.profiles === "object" && !Array.isArray(obj.profiles)) {
    for (const [k, v] of Object.entries(obj.profiles as Record<string, unknown>)) {
      const clean = sanitizeAccountEntry(v, k);
      if (clean) entries.push(clean);
    }
  } else {
    const legacySingle = sanitizeAccountEntry(obj, "default");
    if (legacySingle) entries.push(legacySingle);
  }

  if (entries.length === 0) return { entries: [] };
  const defaultProfileId =
    typeof obj.defaultProfileId === "string" &&
    entries.some((e) => e.profileId === obj.defaultProfileId)
      ? obj.defaultProfileId
      : entries[0]!.profileId;
  return {
    entries,
    defaultProfileId,
    detail: "Studio workspace multi-account vault",
  };
}

function detectWranglerTokenHint(options: LocalCloudflareOptions): string | undefined {
  const home = options.homeDir ?? homedir();
  const candidates = [
    options.wranglerConfigPath,
    join(home, ".wrangler", "config", "default.toml"),
    join(home, ".config", ".wrangler", "config", "default.toml"),
    join(home, "Library", "Preferences", ".wrangler", "config", "default.toml"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const candidate of new Set(candidates)) {
    const text = readSafeConfigFile(candidate);
    if (!text) continue;
    if (/^\s*(?:oauth_token|api_token)\s*=\s*["'][^"']+["']/m.test(text)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveMergedAccounts(options: LocalCloudflareOptions = {}): {
  entries: Map<string, StoredCloudflareAccountEntry>;
  inspection: LocalCloudflareInspection;
} {
  const env = options.env ?? process.env;
  const envData = readEnvAccounts(env);
  const wsData = readWorkspaceVault(options.workspaceKeysDir);
  const wranglerPath = detectWranglerTokenHint(options);

  const merged = new Map<string, StoredCloudflareAccountEntry>();
  for (const entry of wsData.entries) {
    merged.set(entry.profileId, entry);
  }
  // Environment variables take precedence over workspace profiles with the same profileId.
  for (const entry of envData.entries) {
    merged.set(entry.profileId, entry);
  }

  const profiles = [...merged.values()].map(toPublicProfile);
  const defaultProfileId =
    envData.defaultProfileId ?? wsData.defaultProfileId ?? profiles[0]?.profileId;

  if (envData.entries.length > 0) {
    return {
      entries: merged,
      inspection: {
        available: true,
        source: "env",
        sourceDetail: envData.detail ?? "Environment variables",
        ...(defaultProfileId ? { defaultProfileId } : {}),
        profiles,
      },
    };
  }

  if (wsData.entries.length > 0) {
    return {
      entries: merged,
      inspection: {
        available: true,
        source: "workspace",
        sourceDetail: wsData.detail ?? "Studio workspace credentials",
        ...(defaultProfileId ? { defaultProfileId } : {}),
        profiles,
      },
    };
  }

  if (wranglerPath) {
    return {
      entries: merged,
      inspection: {
        available: false,
        source: "wrangler",
        sourceDetail: `Wrangler OAuth detected (${wranglerPath}); R2 S3 Access Key pair still required for R2 object uploads`,
        profiles: [],
      },
    };
  }

  return {
    entries: merged,
    inspection: {
      available: false,
      source: "none",
      sourceDetail: "No local Cloudflare R2 credentials found",
      profiles: [],
    },
  };
}

export function inspectLocalCloudflareEnvironment(
  options: LocalCloudflareOptions = {},
): LocalCloudflareInspection {
  return resolveMergedAccounts(options).inspection;
}

export function resolveLocalCloudflareCredentials(
  selector: { profileId?: string; accountId?: string } = {},
  options: LocalCloudflareOptions = {},
): {
  profileId: string;
  credentials: CloudflareR2Credentials;
  inspection: LocalCloudflareInspection;
} {
  const { entries, inspection } = resolveMergedAccounts(options);
  if (entries.size === 0) {
    throw new Error(
      "Cloudflare R2 credentials were not found in environment variables or workspace keys",
    );
  }

  let matched: StoredCloudflareAccountEntry | undefined;
  if (selector.profileId?.trim()) {
    matched = entries.get(selector.profileId.trim());
    if (!matched) {
      throw new Error(
        `Cloudflare account profile "${selector.profileId}" was not found (available profiles: ${[...entries.keys()].join(", ")})`,
      );
    }
    if (
      selector.accountId?.trim() &&
      matched.accountId.toLowerCase() !== selector.accountId.trim().toLowerCase()
    ) {
      throw new Error(
        `Cloudflare profile "${selector.profileId}" belongs to account ${maskAccountId(matched.accountId)}, which does not match target accountId ${maskAccountId(selector.accountId)}`,
      );
    }
  } else if (selector.accountId?.trim()) {
    const targetAcc = selector.accountId.trim().toLowerCase();
    matched = [...entries.values()].find((e) => e.accountId === targetAcc);
    if (!matched) {
      throw new Error(
        `No Cloudflare credentials found for accountId ${maskAccountId(targetAcc)}`,
      );
    }
  } else {
    matched =
      (inspection.defaultProfileId
        ? entries.get(inspection.defaultProfileId)
        : undefined) ?? [...entries.values()][0];
  }

  if (!matched) {
    throw new Error("Unable to select a Cloudflare account profile");
  }

  return {
    profileId: matched.profileId,
    credentials: {
      accountId: matched.accountId,
      accessKeyId: matched.accessKeyId,
      secretAccessKey: matched.secretAccessKey,
      ...(matched.sessionToken ? { sessionToken: matched.sessionToken } : {}),
      ...(matched.apiToken ? { apiToken: matched.apiToken } : {}),
    },
    inspection,
  };
}

export type UpsertWorkspaceCloudflareProfileInput = {
  profileId: string;
  accountId: string;
  label?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  apiToken?: string;
  buckets?: CloudflareBucketSummary[];
  setDefault?: boolean;
};

function writeVaultAtomically(
  workspaceKeysDir: string,
  vault: WorkspaceCloudflareVault,
): string {
  const resolvedDir = resolve(workspaceKeysDir);
  if (existsSync(resolvedDir)) {
    const dirStat = lstatSync(resolvedDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error("workspace keys directory must be a real non-symlink directory");
    }
  } else {
    mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
  }

  const targetPath = join(resolvedDir, WORKSPACE_CLOUDFLARE_CREDENTIALS_FILENAME);
  try {
    const existingStat = lstatSync(targetPath);
    if (existingStat.isSymbolicLink()) {
      throw new Error("refusing to write Cloudflare credentials over a symbolic link");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const tempPath = join(
    dirname(targetPath),
    `.${WORKSPACE_CLOUDFLARE_CREDENTIALS_FILENAME}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tempPath, JSON.stringify(vault, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(tempPath, 0o600);
    } catch {
      // Ignore chmod errors on platforms without POSIX mode bits.
    }
    renameSync(tempPath, targetPath);
    try {
      chmodSync(targetPath, 0o600);
    } catch {
      // Ignore chmod errors on platforms without POSIX mode bits.
    }
  } finally {
    rmSync(tempPath, { force: true });
  }
  return targetPath;
}

export function upsertWorkspaceCloudflareProfile(
  workspaceKeysDir: string,
  input: UpsertWorkspaceCloudflareProfileInput,
): { path: string; profile: CloudflareAccountProfile } {
  const profileId = validateCloudflareProfileId(input.profileId);
  const accountId = validateCloudflareAccountId(input.accountId);
  const accessKeyId =
    typeof input.accessKeyId === "string" ? input.accessKeyId.trim() : "";
  const secretAccessKey =
    typeof input.secretAccessKey === "string" ? input.secretAccessKey.trim() : "";
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "accessKeyId and secretAccessKey are required to save Cloudflare R2 profile",
    );
  }

  const existing = readWorkspaceVault(workspaceKeysDir);
  const profiles: Record<string, StoredCloudflareAccountEntry> = {};
  for (const item of existing.entries) {
    profiles[item.profileId] = item;
  }

  const entry: StoredCloudflareAccountEntry = {
    profileId,
    accountId,
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    accessKeyId,
    secretAccessKey,
    ...(input.sessionToken?.trim() ? { sessionToken: input.sessionToken.trim() } : {}),
    ...(input.apiToken?.trim() ? { apiToken: input.apiToken.trim() } : {}),
    ...(input.buckets && input.buckets.length > 0
      ? { buckets: sanitizeBuckets(input.buckets) }
      : {}),
  };
  profiles[profileId] = entry;

  const defaultProfileId =
    input.setDefault === true || !existing.defaultProfileId
      ? profileId
      : existing.defaultProfileId;

  const path = writeVaultAtomically(workspaceKeysDir, {
    schemaVersion: 1,
    defaultProfileId,
    profiles,
    updatedAt: new Date().toISOString(),
  });

  return { path, profile: toPublicProfile(entry) };
}

export function removeWorkspaceCloudflareProfile(
  workspaceKeysDir: string,
  profileId: string,
): boolean {
  const cleanId = validateCloudflareProfileId(profileId);
  const existing = readWorkspaceVault(workspaceKeysDir);
  if (!existing.entries.some((e) => e.profileId === cleanId)) {
    return false;
  }
  const remaining = existing.entries.filter((e) => e.profileId !== cleanId);
  if (remaining.length === 0) {
    const targetPath = join(
      resolve(workspaceKeysDir),
      WORKSPACE_CLOUDFLARE_CREDENTIALS_FILENAME,
    );
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(targetPath);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) {
      throw new Error("refusing to delete symbolic link for workspace Cloudflare vault");
    }
    rmSync(targetPath, { force: true });
    return true;
  }

  const profiles: Record<string, StoredCloudflareAccountEntry> = {};
  for (const item of remaining) {
    profiles[item.profileId] = item;
  }
  const defaultProfileId =
    existing.defaultProfileId && existing.defaultProfileId !== cleanId
      ? existing.defaultProfileId
      : remaining[0]!.profileId;

  writeVaultAtomically(workspaceKeysDir, {
    schemaVersion: 1,
    defaultProfileId,
    profiles,
    updatedAt: new Date().toISOString(),
  });
  return true;
}
