import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const sdkRoot = fileURLToPath(new URL("../", import.meta.url));
const registry = "https://npm.pkg.github.com";
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const writeJson = (path, value) => writeFileSync(path, json(value));
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function run(command, args, cwd, { allowMissing = false } = {}) {
  const npmExecPath = process.env.npm_execpath;
  const npmCli = npmExecPath && /(?:^|[\\/])npm-cli\.js$/.test(npmExecPath)
    ? npmExecPath
    : join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const useNpmCli = command === "npm" && existsSync(npmCli);
  const result = spawnSync(useNpmCli ? process.execPath : command, useNpmCli ? [npmCli, ...args] : args, {
    cwd,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout;
  if (allowMissing && /^npm (?:error|ERR!) code (?:E404|ETARGET)\s*$/m.test(result.stderr)) return null;
  throw new Error(`${command} ${args[0]} failed in ${cwd}\n${result.stderr || result.stdout}`);
}

function nextPatch(version) {
  const match = exactVersion.exec(version);
  if (!match) throw new Error(`Cannot increment non-stable package version ${version}`);
  return `${match[1]}.${match[2]}.${BigInt(match[3]) + 1n}`;
}

function manifestChanges(root, catalog, versions) {
  const changes = new Map();
  const lockPath = join(root, "package-lock.json");
  const lock = readJson(lockPath);
  const finalVersions = new Map(catalog.map(({ name, version }) => [
    name.replace("@pocketflutter/", "@pocket/"), versions[name] ?? version,
  ]));
  const update = (manifest) => {
    const version = finalVersions.get(manifest.name);
    if (version) manifest.version = version;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const dependencies = manifest[field] ?? {};
      for (const [name, pinned] of Object.entries(dependencies)) {
        const planned = finalVersions.get(name);
        if (planned && exactVersion.test(pinned)) dependencies[name] = planned;
      }
    }
  };

  const paths = ["", ...catalog.map(({ name }) => `packages/pocket_${name.split("/")[1]}`)];
  const originalLock = JSON.stringify(lock);
  for (const path of paths) {
    const manifestPath = join(root, path, "package.json");
    const manifest = readJson(manifestPath);
    const original = JSON.stringify(manifest);
    const lockEntry = lock.packages[path];
    if (!lockEntry) throw new Error(`Missing SDK lockfile package entry: ${path || "."}`);
    update(manifest);
    update(lockEntry);
    if (JSON.stringify(manifest) !== original) changes.set(manifestPath, json(manifest));
  }
  if (JSON.stringify(lock) !== originalLock) changes.set(lockPath, json(lock));

  // Preserve Bun's lockfile formatting and update only workspace versions and exact pins.
  const bunLocks = [
    join(root, "bun.lock"),
    join(root, "../demo/js/bun.lock"),
    join(root, "../demo/js/apps/lantern/bun.lock"),
  ];
  for (const path of bunLocks) {
    const before = readFileSync(path, "utf8");
    const dependencyPin = /"(@pocket\/[a-z0-9_]+)"(\s*:\s*)"([^"]+)"/g;
    const workspaceVersion = /("name": "(@pocket\/[a-z0-9_]+)",\s+"version": )"([^"]+)"/g;
    const after = before
      .replace(dependencyPin, (entry, name, separator, pinned) => {
        const planned = finalVersions.get(name);
        return planned && exactVersion.test(pinned) ? `"${name}"${separator}"${planned}"` : entry;
      })
      .replace(workspaceVersion, (entry, prefix, name) => {
        const planned = finalVersions.get(name);
        return planned ? `${prefix}"${planned}"` : entry;
      });
    if (after !== before) changes.set(path, after);
  }
  return changes;
}

export function releaseSdkPackages({
  root = sdkRoot,
  mode = "dry-run",
  fetchPublished,
} = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "pocket-sdk-packages-"));
  try {
    const cache = new Map();
    const versions = {};
    const versionsPath = join(scratch, "versions.json");
    const remoteDir = join(scratch, "remote");
    mkdirSync(remoteDir);

    function publishedTar({ name, version }) {
      const spec = `${name}@${version}`;
      if (!cache.has(spec)) {
        const output = fetchPublished
          ? fetchPublished(name, version)
          : run("npm", ["pack", spec, "--registry", registry, "--ignore-scripts", "--prefer-online",
            "--pack-destination", remoteDir, "--json"], scratch, { allowMissing: true });
        const archive = fetchPublished ? output : output && join(remoteDir, JSON.parse(output)[0].filename);
        cache.set(spec, archive ? gunzipSync(readFileSync(archive)) : null);
      }
      return cache.get(spec);
    }

    function pack(round) {
      writeJson(versionsPath, versions);
      const stage = join(scratch, `stage-${round}`);
      const script = join(root, "scripts", "package_github_packages.mjs");
      return JSON.parse(run(process.execPath, [script, "--out", stage, "--versions", versionsPath], scratch))
        .map((entry) => {
          const output = run("npm", ["pack", "--ignore-scripts", "--json"], entry.directory);
          const archive = join(entry.directory, JSON.parse(output)[0].filename);
          return { ...entry, archive };
        });
    }

    const original = pack(0);
    let staged = original;
    for (let round = 1; ; round += 1) {
      let changed = false;
      let collision;
      for (const entry of staged) {
        const published = publishedTar(entry);
        if (!published || published.equals(gunzipSync(readFileSync(entry.archive)))) continue;
        if (Object.hasOwn(versions, entry.name)) {
          collision = entry;
          continue;
        }
        versions[entry.name] = nextPatch(entry.version);
        changed = true;
      }
      if (!changed) {
        if (collision) {
          throw new Error(`${collision.name}@${collision.version} is already published with different contents. Select a new workspace version.`);
        }
        break;
      }
      staged = pack(round);
    }

    const changes = manifestChanges(root, original, versions);
    const packages = staged.map((entry, index) => ({
      name: entry.name,
      current: original[index].version,
      version: entry.version,
      status: publishedTar(entry) ? "published" : "pending",
    }));
    const plan = { packages, manifests: [...changes.keys()].map((path) => relative(join(root, ".."), path)) };
    if (mode === "apply") {
      for (const [path, value] of changes) writeFileSync(path, value);
    } else if (mode === "publish") {
      if (changes.size) {
        throw new Error("Workspace package versions require updates. Run release_sdk_packages.mjs --apply and commit its manifest changes.");
      }
      for (const entry of staged) {
        if (publishedTar(entry)) continue;
        process.stdout.write(run("npm", ["publish", entry.archive, "--registry", registry, "--ignore-scripts"], scratch));
      }

      const consumer = join(scratch, "consumer");
      mkdirSync(consumer);
      writeJson(join(consumer, "package.json"), {
        name: "pocket-packages-consumer",
        private: true,
        type: "module",
        dependencies: Object.fromEntries(staged.map(({ name, version }) => [
          name.replace("@pocketflutter/", "@pocket/"), `npm:${name}@${version}`,
        ])),
      });
      writeFileSync(join(consumer, ".npmrc"), `@pocketflutter:registry=${registry}\n`);
      process.stdout.write(run("npm", ["install", "--ignore-scripts", "--no-audit", "--prefer-online"], consumer));
      process.stdout.write(run("bun", [join(root, "scripts", "verify_github_packages.ts"), consumer], scratch));
    }
    return plan;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [option, ...extra] = process.argv.slice(2);
  if (extra.length || (option && !["--apply", "--publish"].includes(option))) {
    throw new Error("Usage: node sdk/scripts/release_sdk_packages.mjs [--apply | --publish]");
  }
  console.log(JSON.stringify(releaseSdkPackages({ mode: option?.slice(2) }), null, 2));
}
