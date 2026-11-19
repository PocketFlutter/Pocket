import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { renderGitHubReleaseBody, validateReleaseNotes } from '../release_notes.mjs';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = resolve(sdkRoot, '..');

test('validates and renders RELEASE_0.1.26.md with verified Git commit links and doc URLs', () => {
  const validated = validateReleaseNotes({
    sdkRoot,
    repoRoot,
    version: '0.1.26',
    verifyGit: true,
  });

  expect(validated.version).toBe('0.1.26');
  expect(validated.categoryCount).toBe(3);
  expect(validated.itemCount).toBe(8);
  expect(validated.verifiedCommitCount).toBeGreaterThanOrEqual(14);
  expect(validated.commitMap['5b597a9']).toBe('5b597a9f252d419a7ce86f8b0ea207bff8cbe8dd');
  expect(validated.commitMap['cd350d3']).toBe('cd350d3cd0ac61056656c18feda74341d7bf2532');

  const commit = 'cd350d3cd0ac61056656c18feda74341d7bf2532';
  const body = renderGitHubReleaseBody({
    sdkRoot,
    repoRoot,
    version: '0.1.26',
    repo: 'PocketFlutter/Pocket',
    commit,
    runId: '44482715822',
    verifyGit: true,
  });

  expect(body).toContain('## Added');
  expect(body).toContain('## Changed');
  expect(body).toContain('## Fixed');
  expect(body).toContain('## Compatibility');
  expect(body).toContain('## Standalone SDK Packages & Quick Start');
  expect(body).toContain(
    '[`5b597a9`](https://github.com/PocketFlutter/Pocket/commit/5b597a9f252d419a7ce86f8b0ea207bff8cbe8dd)'
  );
  expect(body).toContain(
    '[`76f3b7d`](https://github.com/PocketFlutter/Pocket/commit/'
  );
  expect(body).toContain(
    '[`2f25492`](https://github.com/PocketFlutter/Pocket/commit/'
  );
  expect(body).toContain(
    `[JS API](https://github.com/PocketFlutter/Pocket/blob/${commit}/sdk/docs/JS_API.md)`
  );
  expect(body).toContain('(`99924de47c62fa36f526a8791055d91cbbdb3836`)');
  expect(body).not.toContain('commit/99924de47c62fa36f526a8791055d91cbbdb3836');
  expect(body).toContain('pocket-web-sdk-tools-win32-x64-0.1.26.tgz');
  expect(body).toContain('pocket-web-sdk-tools-darwin-arm64-0.1.26.tgz');
  expect(body).toContain(
    `Full release notes: https://github.com/PocketFlutter/Pocket/blob/${commit}/sdk/docs/RELEASE_0.1.26.md`
  );
  expect(body).toContain(
    `Distribution build: [Action 44482715822](https://github.com/PocketFlutter/Pocket/actions/runs/44482715822), commit ${commit}.`
  );
});

test('rejects malformed release notes and unverified commits', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pocket-release-notes-test-'));
  try {
    const tempSdk = join(tempRoot, 'sdk');
    const docsDir = join(tempSdk, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'API.md'), '# API\n\nSee [0.9.0](RELEASE_0.9.0.md).\n', 'utf8');
    writeFileSync(join(docsDir, 'JS_API.md'), '# JS API\n', 'utf8');

    // 1. Missing RELEASE_0.9.0.md
    expect(() =>
      validateReleaseNotes({ sdkRoot: tempSdk, repoRoot: tempRoot, version: '0.9.0', verifyGit: false })
    ).toThrow(/Missing release notes document/);

    // 2. Missing changelog category heading
    writeFileSync(
      join(docsDir, 'RELEASE_0.9.0.md'),
      '# Pocket Web SDK 0.9.0\n\n## Compatibility\n\nUnchanged.\n',
      'utf8'
    );
    expect(() =>
      validateReleaseNotes({ sdkRoot: tempSdk, repoRoot: tempRoot, version: '0.9.0', verifyGit: false })
    ).toThrow(/at least one changelog category heading/);

    // 3. Missing ## Compatibility
    writeFileSync(
      join(docsDir, 'RELEASE_0.9.0.md'),
      '# Pocket Web SDK 0.9.0\n\n## Added\n\n- New feature (`1234567`).\n',
      'utf8'
    );
    expect(() =>
      validateReleaseNotes({ sdkRoot: tempSdk, repoRoot: tempRoot, version: '0.9.0', verifyGit: false })
    ).toThrow(/## Compatibility/);

    // 4. Changelog bullet missing commit SHA
    writeFileSync(
      join(docsDir, 'RELEASE_0.9.0.md'),
      '# Pocket Web SDK 0.9.0\n\n## Added\n\n- Feature without commit reference.\n\n## Compatibility\n\nUnchanged.\n',
      'utf8'
    );
    expect(() =>
      validateReleaseNotes({ sdkRoot: tempSdk, repoRoot: tempRoot, version: '0.9.0', verifyGit: false })
    ).toThrow(/missing a commit SHA reference/);

    // 5. Broken relative .md link
    writeFileSync(
      join(docsDir, 'RELEASE_0.9.0.md'),
      '# Pocket Web SDK 0.9.0\n\n## Added\n\n- Feature (`1234567`). [Missing](NON_EXISTENT.md)\n\n## Compatibility\n\nUnchanged.\n',
      'utf8'
    );
    expect(() =>
      validateReleaseNotes({ sdkRoot: tempSdk, repoRoot: tempRoot, version: '0.9.0', verifyGit: false })
    ).toThrow(/Broken relative documentation link/);

    // 6. Missing link in docs/API.md
    writeFileSync(join(docsDir, 'API.md'), '# API\n\nNo link here.\n', 'utf8');
    writeFileSync(
      join(docsDir, 'RELEASE_0.9.0.md'),
      '# Pocket Web SDK 0.9.0\n\n## Added\n\n- Feature (`1234567`). [JS API](JS_API.md)\n\n## Compatibility\n\nUnchanged.\n',
      'utf8'
    );
    expect(() =>
      validateReleaseNotes({ sdkRoot: tempSdk, repoRoot: tempRoot, version: '0.9.0', verifyGit: false })
    ).toThrow(/docs\/API\.md must link to \(RELEASE_0\.9\.0\.md\)/);

    // 7. Nonexistent commit SHA with verifyGit: true in an initialized git repo
    writeFileSync(join(docsDir, 'API.md'), '# API\n\nSee [0.9.0](RELEASE_0.9.0.md).\n', 'utf8');
    execFileSync('git', ['init'], { cwd: tempRoot, stdio: 'ignore' });
    expect(() =>
      validateReleaseNotes({ sdkRoot: tempSdk, repoRoot: tempRoot, version: '0.9.0', verifyGit: true })
    ).toThrow(/does not exist in Git repository/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
