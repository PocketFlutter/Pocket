import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SDK_VERSION } from './prebuilt_tools.mjs';

const DEFAULT_SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CHANGELOG_CATEGORIES = new Set([
  'Added',
  'Changed',
  'Fixed',
  'Performance',
  'Deprecated',
  'Removed',
  'Security',
  'Breaking Changes',
]);

function stripCodeFromMarkdown(text) {
  const withoutFences = text.replace(/^```[\s\S]*?^```/gm, '');
  return withoutFences.replace(/`[^`\n]+`/g, '');
}

function collectMarkdownLinks(text) {
  const cleaned = stripCodeFromMarkdown(text);
  const links = [];
  const regex = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let match;
  while ((match = regex.exec(cleaned)) !== null) {
    links.push({ label: match[1], target: match[2] });
  }
  return links;
}

function extractCommitShasFromBullet(bulletText) {
  const shas = [];
  const withoutFences = bulletText.replace(/^```[\s\S]*?^```/gm, '');
  const inlineCodeRegex = /`([0-9a-f]{7,40})`/g;
  let match;
  while ((match = inlineCodeRegex.exec(withoutFences)) !== null) {
    shas.push(match[1]);
  }
  const urlRegex = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/commit\/([0-9a-f]{7,40})/g;
  while ((match = urlRegex.exec(withoutFences)) !== null) {
    shas.push(match[1]);
  }
  return [...new Set(shas)];
}

function parseReleaseSections(content) {
  const lines = content.split(/\r?\n/);
  let firstNonEmptyIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      firstNonEmptyIdx = i;
      break;
    }
  }
  const titleLine = firstNonEmptyIdx >= 0 ? lines[firstNonEmptyIdx].trim() : '';
  const bodyLines = firstNonEmptyIdx >= 0 ? lines.slice(firstNonEmptyIdx + 1) : [];

  const sections = [];
  let current = null;
  let inFence = false;

  for (const line of bodyLines) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
    }
    const headingMatch = !inFence ? line.match(/^##\s+(.+?)\s*$/) : null;
    if (headingMatch) {
      if (current) sections.push(current);
      current = {
        heading: headingMatch[1],
        isCategory: CHANGELOG_CATEGORIES.has(headingMatch[1]),
        lines: [],
      };
      continue;
    }
    if (current) {
      current.lines.push(line);
    } else if (line.trim().length > 0) {
      throw new Error(`Unexpected content before first "## <Heading>" section in release notes: "${line}"`);
    }
  }
  if (current) sections.push(current);

  for (const section of sections) {
    section.rawBody = section.lines.join('\n').trim();
    const bullets = [];
    let currentBullet = null;
    let fence = false;
    for (const line of section.lines) {
      if (/^```/.test(line.trim())) {
        fence = !fence;
      }
      if (!fence && /^- /.test(line)) {
        if (currentBullet !== null) bullets.push(currentBullet.join('\n'));
        currentBullet = [line];
      } else if (currentBullet !== null) {
        currentBullet.push(line);
      }
    }
    if (currentBullet !== null) bullets.push(currentBullet.join('\n'));
    section.bullets = bullets;
  }

  return { titleLine, bodyText: bodyLines.join('\n').trim(), sections };
}

export function validateReleaseNotes({
  sdkRoot = DEFAULT_SDK_ROOT,
  repoRoot = resolve(sdkRoot, '..'),
  version = SDK_VERSION,
  verifyGit = true,
} = {}) {
  const resolvedSdkRoot = resolve(sdkRoot);
  const resolvedRepoRoot = resolve(repoRoot);

  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid release version "${version}"; expected X.Y.Z`);
  }

  const docsRoot = join(resolvedSdkRoot, 'docs');
  const releaseFileName = `RELEASE_${version}.md`;
  const releaseDocPath = join(docsRoot, releaseFileName);
  if (!existsSync(releaseDocPath) || !statSync(releaseDocPath).isFile()) {
    throw new Error(`Missing release notes document: ${releaseDocPath}`);
  }

  const content = readFileSync(releaseDocPath, 'utf8');
  if (!content.trim()) {
    throw new Error(`Release notes document is empty: ${releaseDocPath}`);
  }

  const { titleLine, sections } = parseReleaseSections(content);
  const expectedTitles = [`# Pocket Web SDK ${version}`, `# Pocket SDK ${version}`];
  if (!expectedTitles.includes(titleLine)) {
    throw new Error(
      `Invalid release notes title in ${releaseDocPath}: expected "${expectedTitles[0]}" or "${expectedTitles[1]}", got "${titleLine}"`
    );
  }

  const apiDocPath = join(docsRoot, 'API.md');
  if (!existsSync(apiDocPath) || !statSync(apiDocPath).isFile()) {
    throw new Error(`Missing API index document: ${apiDocPath}`);
  }
  const apiContent = readFileSync(apiDocPath, 'utf8');
  if (!apiContent.includes(`(${releaseFileName})`)) {
    throw new Error(`docs/API.md must link to (${releaseFileName})`);
  }

  const categorySections = sections.filter((s) => s.isCategory);
  if (categorySections.length === 0) {
    throw new Error(
      `Release notes ${releaseFileName} must include at least one changelog category heading (## Added, ## Changed, ## Fixed, etc.)`
    );
  }

  for (const section of categorySections) {
    if (section.bullets.length === 0) {
      throw new Error(`Changelog category "## ${section.heading}" in ${releaseFileName} must contain at least one "- " bullet`);
    }
  }

  const compatibilitySection = sections.find((s) => s.heading === 'Compatibility');
  if (!compatibilitySection || !compatibilitySection.rawBody) {
    throw new Error(`Release notes ${releaseFileName} must include a non-empty "## Compatibility" section`);
  }

  const citedShas = [];
  let itemCount = 0;
  for (const section of categorySections) {
    for (const bullet of section.bullets) {
      itemCount += 1;
      const shas = extractCommitShasFromBullet(bullet);
      if (shas.length === 0) {
        const preview = bullet.split('\n')[0].slice(0, 80);
        throw new Error(
          `Changelog bullet in "## ${section.heading}" of ${releaseFileName} is missing a commit SHA reference: "${preview}"`
        );
      }
      citedShas.push(...shas);
    }
  }

  const uniqueShas = [...new Set(citedShas)];
  const commitMap = {};
  const verifiedCommits = new Map();
  const canVerifyGit = Boolean(verifyGit && existsSync(join(resolvedRepoRoot, '.git')));

  for (const sha of uniqueShas) {
    if (canVerifyGit) {
      let fullSha = '';
      try {
        fullSha = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], {
          cwd: resolvedRepoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      } catch {
        throw new Error(`Commit SHA "${sha}" cited in ${releaseFileName} does not exist in Git repository ${resolvedRepoRoot}`);
      }
      if (!/^[0-9a-f]{40}$/.test(fullSha)) {
        throw new Error(`Commit SHA "${sha}" resolved to unexpected git object "${fullSha}"`);
      }
      commitMap[sha] = fullSha;
      verifiedCommits.set(sha, fullSha);
    } else {
      commitMap[sha] = sha;
    }
  }

  for (const { target } of collectMarkdownLinks(content)) {
    if (/^[a-zA-Z][\w+.-]*:/.test(target) || target.startsWith('#') || target.startsWith('/')) {
      continue;
    }
    const cleanPath = target.split('#')[0];
    if (!cleanPath) continue;
    const resolvedTarget = resolve(docsRoot, cleanPath);
    if (!resolvedTarget.startsWith(docsRoot) || !existsSync(resolvedTarget) || !statSync(resolvedTarget).isFile()) {
      throw new Error(`Broken relative documentation link "${target}" in ${releaseFileName}`);
    }
  }

  return {
    version,
    releaseDocPath,
    categoryCount: categorySections.length,
    itemCount,
    verifiedCommits,
    commitMap,
    verifiedCommitCount: verifiedCommits.size,
    content,
    sections,
  };
}

function rewriteRelativeLinksInLine(line, repo, commit) {
  const parts = line.split(/(`[^`]*`)/g);
  return parts
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`')) return part;
      return part.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (full, label, target) => {
        if (/^[a-zA-Z][\w+.-]*:/.test(target) || target.startsWith('#') || target.startsWith('/')) {
          return full;
        }
        return `[${label}](https://github.com/${repo}/blob/${commit}/sdk/docs/${target})`;
      });
    })
    .join('');
}

function rewriteCommitShasInCategoryLine(line, repo, commitMap) {
  return line.replace(/(^|[^\[])`([0-9a-f]{7,40})`/g, (full, prefix, sha) => {
    const fullSha = commitMap[sha] ?? sha;
    const shortSha = sha.slice(0, 7);
    return `${prefix}[\`${shortSha}\`](https://github.com/${repo}/commit/${fullSha})`;
  });
}

export function renderGitHubReleaseBody({
  sdkRoot = DEFAULT_SDK_ROOT,
  repoRoot = resolve(sdkRoot, '..'),
  version = SDK_VERSION,
  repo,
  commit,
  runId,
  verifyGit = true,
} = {}) {
  if (typeof repo !== 'string' || !repo.trim()) {
    throw new Error('renderGitHubReleaseBody requires a non-empty "repo" (e.g. "PocketFlutter/Pocket")');
  }
  if (typeof commit !== 'string' || !commit.trim()) {
    throw new Error('renderGitHubReleaseBody requires a non-empty "commit" SHA');
  }
  if (typeof runId !== 'string' && typeof runId !== 'number') {
    throw new Error('renderGitHubReleaseBody requires a non-empty "runId"');
  }
  const normalizedRepo = repo.trim();
  const normalizedCommit = commit.trim();
  const normalizedRunId = String(runId).trim();
  if (!normalizedRunId) {
    throw new Error('renderGitHubReleaseBody requires a non-empty "runId"');
  }

  const validated = validateReleaseNotes({ sdkRoot, repoRoot, version, verifyGit });

  const renderedSections = validated.sections.map((section) => {
    let inFence = false;
    const transformedLines = section.lines.map((line) => {
      if (/^```/.test(line.trim())) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      let updated = rewriteRelativeLinksInLine(line, normalizedRepo, normalizedCommit);
      if (section.isCategory) {
        updated = rewriteCommitShasInCategoryLine(updated, normalizedRepo, validated.commitMap);
      }
      return updated;
    });
    return `## ${section.heading}\n\n${transformedLines.join('\n').trim()}`;
  });

  const footer = [
    `Full release notes: https://github.com/${normalizedRepo}/blob/${normalizedCommit}/sdk/docs/RELEASE_${version}.md`,
    '',
    '## Standalone SDK Packages & Quick Start',
    '',
    'Standalone Pocket Web SDK, with a complete development package for each platform (each contains only its platform tools):',
    '',
    `- Windows x64: \`pocket-web-sdk-tools-win32-x64-${version}.tgz\``,
    `- macOS arm64: \`pocket-web-sdk-tools-darwin-arm64-${version}.tgz\``,
    '- `pocket-tools-*` contains compiler tools only; download it separately only if you already have the SDK.',
    '',
    'Node.js 24 LTS is recommended (minimum 22.22.2). Extract the complete SDK package for your platform and run:',
    '```sh',
    'npm run setup',
    'npm start',
    '```',
    'Studio runs at http://127.0.0.1:8791. Product development requires no Rust, Python, C/C++, or global Bun installation.',
    '',
    'Before publishing, the complete archives are installed on both platforms to verify doctor, Noble native module loading, real App/Game QJBC/PAK builds, input-driven Preview frames, and Studio startup/shutdown. Acceptance JSON and SHA256SUMS are attached.',
    '',
    'Windows DK-META2 device connections and notifications remain unverified. CI has no BLE devices; loading a native module does not establish hardware connectivity. Linux native BLE is currently unsupported. See docs/NPM_TOOLCHAIN.md and docs/WINDOWS_BUILD.md in the package for details.',
    '',
    `Distribution build: [Action ${normalizedRunId}](https://github.com/${normalizedRepo}/actions/runs/${normalizedRunId}), commit ${normalizedCommit}.`,
  ].join('\n');

  return `${renderedSections.join('\n\n')}\n\n${footer}\n`;
}

function parseCliArgs(argv) {
  const options = {
    mode: null,
    version: SDK_VERSION,
    sdkRoot: DEFAULT_SDK_ROOT,
    repo: '',
    commit: '',
    runId: '',
    output: '',
    verifyGit: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      options.mode = 'check';
    } else if (arg === '--render') {
      options.mode = 'render';
    } else if (arg === '--no-verify-git') {
      options.verifyGit = false;
    } else if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length);
    } else if (arg === '--version' && i + 1 < argv.length) {
      options.version = argv[++i];
    } else if (arg.startsWith('--sdk-root=')) {
      options.sdkRoot = resolve(arg.slice('--sdk-root='.length));
    } else if (arg === '--sdk-root' && i + 1 < argv.length) {
      options.sdkRoot = resolve(argv[++i]);
    } else if (arg.startsWith('--repo=')) {
      options.repo = arg.slice('--repo='.length);
    } else if (arg === '--repo' && i + 1 < argv.length) {
      options.repo = argv[++i];
    } else if (arg.startsWith('--commit=')) {
      options.commit = arg.slice('--commit='.length);
    } else if (arg === '--commit' && i + 1 < argv.length) {
      options.commit = argv[++i];
    } else if (arg.startsWith('--run-id=')) {
      options.runId = arg.slice('--run-id='.length);
    } else if (arg === '--run-id' && i + 1 < argv.length) {
      options.runId = argv[++i];
    } else if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
    } else if (arg === '--output' && i + 1 < argv.length) {
      options.output = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.mode) {
    throw new Error('Usage: node sdk/scripts/release_notes.mjs (--check | --render) [--version=X.Y.Z]');
  }
  return options;
}

const isEntrypoint = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isEntrypoint) {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    const repoRoot = resolve(opts.sdkRoot, '..');
    if (opts.mode === 'check') {
      const result = validateReleaseNotes({
        sdkRoot: opts.sdkRoot,
        repoRoot,
        version: opts.version,
        verifyGit: opts.verifyGit,
      });
      process.stdout.write(
        `Validated RELEASE_${result.version}.md: ${result.categoryCount} categories, ${result.itemCount} items, ${result.verifiedCommitCount} verified commits.\n`
      );
    } else {
      const body = renderGitHubReleaseBody({
        sdkRoot: opts.sdkRoot,
        repoRoot,
        version: opts.version,
        repo: opts.repo,
        commit: opts.commit,
        runId: opts.runId,
        verifyGit: opts.verifyGit,
      });
      if (opts.output) {
        writeFileSync(resolve(opts.output), body, 'utf8');
      } else {
        process.stdout.write(body);
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
