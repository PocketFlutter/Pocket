import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  checkNodeVersion,
  installStudio,
  platformTuple,
  selectStableRelease,
} from '../install_studio.mjs';

const VERSION = '0.1.21';
const TUPLE = 'darwin-arm64';
const ARCHIVE_NAME = `pocket-web-sdk-tools-${TUPLE}-${VERSION}.tgz`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'pocket-installer-test-'));
  roots.push(root);
  return root;
}

function tarEntry(path: string, data: Buffer | string = '', type = '0') {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${payload.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (payload.length % 512)) % 512);
  return Buffer.concat([header, payload, padding]);
}

function sdkArchive(path = 'package/') {
  const files: Array<[string, string]> = [
    ['package/package.json', JSON.stringify({
      name: `@pocket/web-sdk-tools-${TUPLE}`,
      version: VERSION,
      scripts: { setup: 'node scripts/toolchain.mjs setup', doctor: 'node scripts/toolchain.mjs doctor', start: 'node scripts/editor_service.mjs start' },
    })],
    ['package/provenance.json', JSON.stringify({
      sourceRepository: 'PocketFlutter/Pocket',
      sourceCommit: 'a'.repeat(40),
      pinnedPocketJsRevision: 'b'.repeat(40),
    })],
    ['package/scripts/prebuilt_tools.mjs', `export const SDK_VERSION = '${VERSION}';\nexport const UPSTREAM_REVISION = '${'b'.repeat(40)}';\n`],
    ['package/editor/server.ts', 'export {};\n'],
    ['package/scripts/editor_service.mjs', ''],
    ['package/scripts/studio_upgrade.mjs', ''],
    [`package/prebuilt/pocket-tools-${TUPLE}-${VERSION}.tgz`, 'fixture-tools'],
  ];
  const entries = path === 'package/'
    ? files.map(([name, value]) => tarEntry(name, value))
    : [tarEntry(path, 'unsafe')];
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function fetchFor(archive: Buffer, checksum?: string) {
  const digest = checksum ?? createHash('sha256').update(archive).digest('hex');
  const release = {
    tag_name: `sdk-v${VERSION}`,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: ARCHIVE_NAME,
        browser_download_url: `https://github.com/PocketFlutter/Pocket/releases/download/sdk-v${VERSION}/${ARCHIVE_NAME}`,
      },
      {
        name: `${ARCHIVE_NAME}.sha256`,
        browser_download_url: `https://github.com/PocketFlutter/Pocket/releases/download/sdk-v${VERSION}/${ARCHIVE_NAME}.sha256`,
      },
    ],
  };
  return async (rawUrl: string) => {
    if (rawUrl === `https://api.github.com/repos/PocketFlutter/Pocket/releases/tags/sdk-v${VERSION}`) {
      return new Response(JSON.stringify(release), { headers: { 'content-type': 'application/json' } });
    }
    if (rawUrl.endsWith(`${ARCHIVE_NAME}.sha256`)) {
      return new Response(`${digest}  ${ARCHIVE_NAME}\n`);
    }
    if (rawUrl.endsWith(ARCHIVE_NAME)) return new Response(archive);
    throw new Error(`unexpected test URL: ${rawUrl}`);
  };
}

function testOptions(targetDir: string, fetchImpl: typeof fetch) {
  const commands: Array<{ args: string[]; cwd: string }> = [];
  return {
    options: {
      targetDir,
      version: VERSION,
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl,
      runNpm: async (args: string[], cwd: string) => { commands.push({ args, cwd }); },
      noStart: true,
      log: () => {},
    },
    commands,
  };
}

describe('standalone Studio installer', () => {
  it('downloads only the named platform asset, verifies SHA-256 and installs into a fresh directory', async () => {
    const root = tempRoot();
    const targetDir = join(root, 'sdk');
    const archive = sdkArchive();
    const { options, commands } = testOptions(targetDir, fetchFor(archive) as typeof fetch);

    const result = await installStudio(options);

    expect(result).toMatchObject({ version: VERSION, started: false, reused: false });
    expect(readFileSync(join(targetDir, 'package.json'), 'utf8')).toContain(`@pocket/web-sdk-tools-${TUPLE}`);
    expect(commands.map(command => command.args)).toEqual([['run', 'setup'], ['run', 'doctor']]);
    const stagePrefix = join(realpathSync(root), '.pocket-studio-install-');
    expect(commands.every(command => command.cwd === targetDir || command.cwd.startsWith(stagePrefix))).toBe(true);
  });

  it('rejects a bad checksum before creating the installation directory', async () => {
    const root = tempRoot();
    const targetDir = join(root, 'sdk');
    const archive = sdkArchive();
    const { options } = testOptions(targetDir, fetchFor(archive, '0'.repeat(64)) as typeof fetch);

    await expect(installStudio(options)).rejects.toThrow(/SHA-256 不匹配/);
    expect(existsSync(targetDir)).toBe(false);
  });

  it('rejects unsafe tar paths and removes only its staging directory', async () => {
    const root = tempRoot();
    const targetDir = join(root, 'sdk');
    const archive = sdkArchive('package/../../outside.txt');
    const { options } = testOptions(targetDir, fetchFor(archive) as typeof fetch);

    await expect(installStudio(options)).rejects.toThrow(/路径穿越/);
    expect(existsSync(targetDir)).toBe(false);
    expect(existsSync(join(root, 'outside.txt'))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses an unrecognized nonempty destination without changing consumer files', async () => {
    const root = tempRoot();
    const targetDir = join(root, 'sdk');
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, 'workspace.txt'), 'keep me');
    const { options } = testOptions(targetDir, fetchFor(sdkArchive()) as typeof fetch);

    await expect(installStudio(options)).rejects.toThrow(/已拒绝覆盖/);
    expect(readFileSync(join(targetDir, 'workspace.txt'), 'utf8')).toBe('keep me');
  });

  it('reuses a managed installation, runs doctor/start, and preserves workspace files on repeat', async () => {
    const root = tempRoot();
    const targetDir = join(root, 'sdk');
    const first = testOptions(targetDir, fetchFor(sdkArchive()) as typeof fetch);
    await installStudio(first.options);
    mkdirSync(join(targetDir, 'workspace'), { recursive: true });
    writeFileSync(join(targetDir, 'workspace', 'consumer.md'), 'consumer data');
    const secondCommands: string[][] = [];

    const result = await installStudio({
      targetDir,
      platform: 'darwin',
      arch: 'arm64',
      runNpm: async args => { secondCommands.push(args); },
      log: () => {},
    });

    expect(result).toMatchObject({ version: VERSION, reused: true, started: true });
    expect(secondCommands).toEqual([['run', 'doctor'], ['run', 'start']]);
    expect(readFileSync(join(targetDir, 'workspace', 'consumer.md'), 'utf8')).toBe('consumer data');
  });

  it('does not mistake Git source checkouts for a standalone managed installation', async () => {
    const root = tempRoot();
    const targetDir = join(root, 'sdk');
    await installStudio(testOptions(targetDir, fetchFor(sdkArchive()) as typeof fetch).options);
    const marker = join(targetDir, '.git');
    mkdirSync(marker);
    writeFileSync(join(marker, 'keep'), 'git metadata');
    const rerun = {
      targetDir,
      platform: 'darwin',
      arch: 'arm64',
      runNpm: async () => {},
      noStart: true,
      log: () => {},
    };

    await expect(installStudio(rerun)).rejects.toThrow(/已拒绝覆盖/);
    expect(readFileSync(join(marker, 'keep'), 'utf8')).toBe('git metadata');
    rmSync(marker, { recursive: true });
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'demo'));

    await expect(installStudio(rerun)).rejects.toThrow(/已拒绝覆盖/);
    expect(existsSync(join(root, '.git'))).toBe(true);
    expect(existsSync(join(root, 'demo'))).toBe(true);
  });

  it('stages beside a target whose parent is a directory symlink', async () => {
    const root = tempRoot();
    const realParent = join(root, 'real-parent');
    const aliasParent = join(root, 'alias-parent');
    mkdirSync(realParent);
    symlinkSync(realParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir');
    const targetDir = join(aliasParent, 'sdk');
    const { options, commands } = testOptions(targetDir, fetchFor(sdkArchive()) as typeof fetch);

    await installStudio(options);

    expect(existsSync(join(targetDir, 'package.json'))).toBe(true);
    expect(existsSync(join(realParent, 'sdk', 'package.json'))).toBe(true);
    const stagePrefix = join(realpathSync(realParent), '.pocket-studio-install-');
    expect(commands).toHaveLength(2);
    expect(commands.every(command => command.cwd.startsWith(stagePrefix))).toBe(true);
  });

  it('runs CLI help when invoked through an installer path alias', () => {
    const root = tempRoot();
    const installerPath = fileURLToPath(new URL('../install_studio.mjs', import.meta.url));
    let aliasPath: string;
    if (process.platform === 'win32') {
      const scriptsAlias = join(root, 'scripts-alias');
      symlinkSync(dirname(installerPath), scriptsAlias, 'junction');
      aliasPath = join(scriptsAlias, basename(installerPath));
    } else {
      aliasPath = join(root, 'pocket-studio-install-main.mjs');
      symlinkSync(installerPath, aliasPath, 'file');
    }

    const result = spawnSync('node', [aliasPath, '--help'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Pocket Studio 独立 Web SDK 一键安装');
    expect(result.stderr).toBe('');
  });

  it('explains unsupported platforms and the Node.js minimum', async () => {
    expect(() => platformTuple('linux', 'x64')).toThrow(/仅支持 macOS Apple Silicon.*Windows x64/);
    expect(platformTuple('win32', 'x64')).toBe('win32-x64');
    expect(() => checkNodeVersion('22.22.1')).toThrow(/Node\.js >= 22\.22\.2/);
  });

  it('selects the highest stable release with this platform archive and SHA-256 sidecar', () => {
    const release = (version: string, prerelease = false) => ({
      tag_name: `sdk-v${version}`,
      draft: false,
      prerelease,
      assets: [
        { name: `pocket-web-sdk-tools-${TUPLE}-${version}.tgz`, browser_download_url: `https://github.com/PocketFlutter/Pocket/releases/download/sdk-v${version}/pocket-web-sdk-tools-${TUPLE}-${version}.tgz` },
        { name: `pocket-web-sdk-tools-${TUPLE}-${version}.tgz.sha256`, browser_download_url: `https://github.com/PocketFlutter/Pocket/releases/download/sdk-v${version}/pocket-web-sdk-tools-${TUPLE}-${version}.tgz.sha256` },
      ],
    });
    expect(selectStableRelease([release('0.1.21'), release('99.0.0', true), release('0.1.20')], TUPLE).version).toBe(VERSION);
    const offsite = release(VERSION);
    offsite.assets[0].browser_download_url = 'https://example.invalid/sdk.tgz';
    expect(() => selectStableRelease([offsite], TUPLE)).toThrow(/非官方 HTTPS/);
  });

  it('requires npm to be present without trying to install or replace it', async () => {
    const targetDir = join(tempRoot(), 'sdk');
    await expect(installStudio({
      targetDir,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: '22.22.2',
      spawn: () => ({ status: 1, error: null }),
    })).rejects.toThrow(/需要安装 npm/);
    expect(existsSync(targetDir)).toBe(false);
  });
});
