import { expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCosCli } from "../src/cli.ts";
import {
  clearWorkspaceCosCredentials,
  inspectLocalCosEnvironment,
  type LocalCosInspection,
  maskSecretId,
  parseCoscliYaml,
  parseCoscmdIni,
  resolveLocalCosCredentials,
  WORKSPACE_COS_CREDENTIALS_FILENAME,
  writeWorkspaceCosCredentials,
} from "../src/local_config.ts";

test("maskSecretId masks long and short IDs without leaking full secretId", () => {
  expect(maskSecretId("AKID1234567890ABCD")).toBe("AKID****ABCD");
  expect(maskSecretId("SHORT1")).toBe("SH****");
  expect(maskSecretId("")).toBe("");
});

test("parseCoscliYaml parses base credentials, comments, quotes, and multi-bucket profiles", () => {
  const yaml = `
# Tencent COS CLI configuration
cos:
  base:
    secretid: "AKID_YAML_12345678" # inline comment
    secretkey: 'SK_YAML_SECRET_999'
    sessiontoken: "TOKEN_YAML_ABC"
    protocol: https
  buckets:
    - name: alpha-1250000001
      alias: alpha-prod
      region: ap-guangzhou
      endpoint: cos.ap-guangzhou.myqcloud.com
    - name: 'beta-1250000002'
      alias: "beta-cdn"
      endpoint: "https://beta-1250000002.cos.ap-shanghai.myqcloud.com"
`;
  const parsed = parseCoscliYaml(yaml);
  expect(parsed.credentials).toEqual({
    secretId: "AKID_YAML_12345678",
    secretKey: "SK_YAML_SECRET_999",
    securityToken: "TOKEN_YAML_ABC",
  });
  expect(parsed.buckets).toEqual([
    {
      bucket: "alpha-1250000001",
      region: "ap-guangzhou",
      alias: "alpha-prod",
      endpoint: "https://alpha-1250000001.cos.ap-guangzhou.myqcloud.com",
    },
    {
      bucket: "beta-1250000002",
      region: "ap-shanghai",
      alias: "beta-cdn",
      endpoint: "https://beta-1250000002.cos.ap-shanghai.myqcloud.com",
    },
  ]);
});

test("parseCoscmdIni parses [common] credentials and bucket profile", () => {
  const ini = `
[common]
# comment line
secret_id = AKID_INI_87654321
secret_key = SK_INI_SECRET_111
token = INI_SESSION_TOKEN
bucket = gamma-1250000003
region = ap-beijing
schema = https
`;
  const parsed = parseCoscmdIni(ini);
  expect(parsed.credentials).toEqual({
    secretId: "AKID_INI_87654321",
    secretKey: "SK_INI_SECRET_111",
    securityToken: "INI_SESSION_TOKEN",
  });
  expect(parsed.buckets).toEqual([
    {
      bucket: "gamma-1250000003",
      region: "ap-beijing",
    },
  ]);
});

test("priority order (env > workspace > coscli > coscmd), bucket aggregation, 0o600 write/clear, symlink rejection, and redaction", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pocket-cos-local-config-"));
  try {
    const homeDir = join(tempRoot, "home");
    const keysDir = join(tempRoot, "keys");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(keysDir, { recursive: true });

    const yamlPath = join(homeDir, ".cos.yaml");
    const confPath = join(homeDir, ".cos.conf");

    writeFileSync(
      yamlPath,
      `cos:
  base:
    secretid: AKID_FROM_YAML_1111
    secretkey: SK_FROM_YAML_SECRET
  buckets:
    - name: yaml-bucket-1250000011
      region: ap-guangzhou
      alias: yaml-default
`,
      "utf8",
    );

    writeFileSync(
      confPath,
      `[common]
secret_id = AKID_FROM_CONF_2222
secret_key = SK_FROM_CONF_SECRET
bucket = conf-bucket-1250000022
region = ap-shanghai
`,
      "utf8",
    );

    // 1. Only coscli and coscmd present -> coscli wins, both buckets discovered
    const inspCoscli = inspectLocalCosEnvironment({
      env: {},
      homeDir,
      workspaceKeysDir: keysDir,
    });
    expect(inspCoscli.available).toBe(true);
    expect(inspCoscli.source).toBe("coscli");
    expect(inspCoscli.maskedSecretId).toBe("AKID****1111");
    expect(inspCoscli.discoveredBuckets.map((b) => b.bucket)).toEqual([
      "yaml-bucket-1250000011",
      "conf-bucket-1250000022",
    ]);
    expect(JSON.stringify(inspCoscli)).not.toContain("SK_FROM_YAML_SECRET");
    expect(JSON.stringify(inspCoscli)).not.toContain("AKID_FROM_YAML_1111");

    // 2. Write workspace credentials -> workspace wins over coscli, mode is 0o600
    const writtenPath = writeWorkspaceCosCredentials(keysDir, {
      secretId: "AKID_FROM_WKSP_3333",
      secretKey: "SK_FROM_WKSP_SECRET",
      securityToken: "WKSP_TOKEN_SECRET",
      bucket: "wksp-bucket-1250000033",
      region: "ap-chengdu",
    });
    if (process.platform !== "win32") {
      expect(lstatSync(writtenPath).mode & 0o777).toBe(0o600);
    }

    const inspWksp = inspectLocalCosEnvironment({
      env: {},
      homeDir,
      workspaceKeysDir: keysDir,
    });
    expect(inspWksp.source).toBe("workspace");
    expect(inspWksp.maskedSecretId).toBe("AKID****3333");
    expect(inspWksp.hasSecurityToken).toBe(true);
    expect(inspWksp.discoveredBuckets.map((b) => b.bucket)).toEqual([
      "wksp-bucket-1250000033",
      "yaml-bucket-1250000011",
      "conf-bucket-1250000022",
    ]);
    expect(JSON.stringify(inspWksp)).not.toContain("SK_FROM_WKSP_SECRET");
    expect(JSON.stringify(inspWksp)).not.toContain("WKSP_TOKEN_SECRET");

    // 3. Env credentials -> env wins over workspace, coscli, and coscmd while keeping all discovered buckets
    const resolvedEnv = resolveLocalCosCredentials({
      env: {
        TENCENTCLOUD_SECRET_ID: "AKID_FROM_ENV_4444",
        TENCENTCLOUD_SECRET_KEY: "SK_FROM_ENV_SECRET",
        COS_BUCKET: "env-bucket-1250000044",
        COS_REGION: "ap-hongkong",
      },
      homeDir,
      workspaceKeysDir: keysDir,
    });
    expect(resolvedEnv.inspection.source).toBe("env");
    expect(resolvedEnv.inspection.maskedSecretId).toBe("AKID****4444");
    expect(resolvedEnv.credentials.secretId).toBe("AKID_FROM_ENV_4444");
    expect(resolvedEnv.inspection.discoveredBuckets.map((b) => b.bucket)).toEqual([
      "env-bucket-1250000044",
      "wksp-bucket-1250000033",
      "yaml-bucket-1250000011",
      "conf-bucket-1250000022",
    ]);

    // 3b. TENCENT_COS_* env aliases work for credentials, token, bucket, region, and endpoint
    const resolvedTencentCosEnv = resolveLocalCosCredentials({
      env: {
        TENCENT_COS_SECRET_ID: "AKID_FROM_TCOS_5555",
        TENCENT_COS_SECRET_KEY: "SK_FROM_TCOS_SECRET",
        TENCENT_COS_SECURITY_TOKEN: "TCOS_TOKEN_5555",
        TENCENT_COS_BUCKET: "tcos-bucket-1250000055",
        TENCENT_COS_REGION: "ap-nanjing",
        TENCENT_COS_ENDPOINT: "https://tcos-bucket-1250000055.cos.ap-nanjing.myqcloud.com",
      },
      homeDir,
      workspaceKeysDir: keysDir,
    });
    expect(resolvedTencentCosEnv.inspection.source).toBe("env");
    expect(resolvedTencentCosEnv.inspection.sourceDetail).toContain("TENCENT_COS_SECRET_ID");
    expect(resolvedTencentCosEnv.credentials.secretId).toBe("AKID_FROM_TCOS_5555");
    expect(resolvedTencentCosEnv.credentials.securityToken).toBe("TCOS_TOKEN_5555");
    expect(resolvedTencentCosEnv.inspection.defaultBucket).toEqual({
      bucket: "tcos-bucket-1250000055",
      region: "ap-nanjing",
      endpoint: "https://tcos-bucket-1250000055.cos.ap-nanjing.myqcloud.com",
    });

    // 4. Clear workspace credentials -> falls back to coscli
    expect(clearWorkspaceCosCredentials(keysDir)).toBe(true);
    expect(clearWorkspaceCosCredentials(keysDir)).toBe(false);
    expect(
      inspectLocalCosEnvironment({ env: {}, homeDir, workspaceKeysDir: keysDir }).source,
    ).toBe("coscli");

    // 5. Symlink rejection on config files and workspace credentials
    const targetSecretFile = join(tempRoot, "outside-secret.json");
    writeFileSync(
      targetSecretFile,
      JSON.stringify({ secretId: "AKID_SYMLINK_9999", secretKey: "SK_SYMLINK" }),
    );
    const symlinkCredPath = join(keysDir, WORKSPACE_COS_CREDENTIALS_FILENAME);
    symlinkSync(targetSecretFile, symlinkCredPath);

    // Reading workspace credentials must ignore symlink
    const afterSymlink = inspectLocalCosEnvironment({
      env: {},
      homeDir,
      workspaceKeysDir: keysDir,
    });
    expect(afterSymlink.source).toBe("coscli");

    // Writing or clearing over a symlink must throw
    expect(() =>
      writeWorkspaceCosCredentials(keysDir, {
        secretId: "AKID_NEW_12345678",
        secretKey: "SK_NEW",
      }),
    ).toThrow(/symbolic link/);
    expect(() => clearWorkspaceCosCredentials(keysDir)).toThrow(/symbolic link/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runCosCli inspect --json succeeds cleanly and returns redacted LocalCosInspection", async () => {
  const keysDir = mkdtempSync(join(tmpdir(), "pocket-cos-cli-inspect-"));
  try {
    writeWorkspaceCosCredentials(keysDir, {
      secretId: "AKID_CLI_JSON_7777",
      secretKey: "SK_CLI_JSON_SECRET",
      securityToken: "TOKEN_CLI_JSON_SECRET",
      bucket: "cli-bucket-1250000077",
      region: "ap-guangzhou",
    });

    const result = (await runCosCli([
      "inspect",
      "--json",
      "--workspace-keys-dir",
      keysDir,
    ])) as LocalCosInspection;

    expect(result.available).toBe(true);
    expect(typeof result.source).toBe("string");
    expect(Array.isArray(result.discoveredBuckets)).toBe(true);
    expect(
      result.discoveredBuckets.some((b) => b.bucket === "cli-bucket-1250000077"),
    ).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("AKID_CLI_JSON_7777");
    expect(serialized).not.toContain("SK_CLI_JSON_SECRET");
    expect(serialized).not.toContain("TOKEN_CLI_JSON_SECRET");
  } finally {
    rmSync(keysDir, { recursive: true, force: true });
  }
});
