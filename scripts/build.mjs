#!/usr/bin/env node
// neat-filters build script.
//
//   node scripts/build.mjs [--prev prev/manifest.json] [--out dist] [--force]
//
// 1. Pins upstream commits (uAssets, uBlock, brave/adblock-resources).
// 2. Downloads the lists from the pinned uAssets commit, resolves !#include / !#if and strips
//    comments, so a metadata-only upstream change does not change the published bytes.
// 3. Builds the adblock-rust resources (uBO redirect resources + scriptlets + Brave extras).
// 4. Hashes everything and compares with the previous manifest. Nothing changed -> exit early.
// 5. Validates the result in a real adblock-rust engine (tools/nf-tool) and applies sanity checks.
// 6. Writes dist/manifest.json. With GITHUB_OUTPUT set, reports `changed` and `version`.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalize, preprocess } from './preprocess.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Bit 0 = "trusted uBO list / trusted scriptlet". Must match TRUSTED in tools/nf-tool/src/main.rs.
const TRUSTED_PERMISSION = 1;
const MANIFEST_SCHEMA = 1;

// ---------------------------------------------------------------- helpers

function parseArgs(argv) {
  const o = { out: 'dist', prev: null, force: false, now: null, cache: '.cache', notes: '.cache/release-notes.md' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (['--out', '--prev', '--now', '--cache', '--notes'].includes(a)) o[a.slice(2)] = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

const log = (...a) => console.error('[build]', ...a);
const sha256 = data => createHash('sha256').update(data).digest('hex');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  return r;
}

function runChecked(cmd, args, opts) {
  const r = run(cmd, args, opts);
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})\n${r.stderr}`);
  }
  return r.stdout;
}

async function fetchText(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      log(`fetch failed (${attempt}/4) ${url}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`Cannot download ${url}: ${lastErr?.message}`);
}

function lsRemoteHead(repoUrl) {
  const out = runChecked('git', ['ls-remote', repoUrl, 'HEAD']);
  const sha = out.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Cannot resolve HEAD of ${repoUrl}`);
  return sha;
}

function checkoutShallow(repoUrl, dir) {
  if (fs.existsSync(path.join(dir, '.git'))) {
    runChecked('git', ['-C', dir, 'fetch', '--depth', '1', 'origin', 'HEAD']);
    runChecked('git', ['-C', dir, 'reset', '--hard', 'FETCH_HEAD']);
  } else {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    runChecked('git', ['clone', '--depth', '1', repoUrl, dir], { env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } });
  }
  return runChecked('git', ['-C', dir, 'rev-parse', 'HEAD']).trim();
}

function versionFrom(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}.${p(date.getUTCMonth() + 1)}.${p(date.getUTCDate())}.${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

// ---------------------------------------------------------------- lists

async function buildLists(sources, uAssetsSha) {
  const cache = new Map();
  const load = async p => {
    if (!cache.has(p)) cache.set(p, fetchText(`${sources.uAssets.rawBase}/${uAssetsSha}/${p}`));
    return cache.get(p);
  };
  const unknown = new Set();
  const lists = [];
  for (const entry of sources.lists) {
    const text = await load(entry.path);
    const lines = await preprocess(text, { path: entry.path, env: sources.env, load, unknown });
    const body = normalize(lines).join('\n') + '\n';
    lists.push({ entry, body });
    log(`${entry.name}: ${body.length} bytes`);
  }
  if (unknown.size) log(`unknown !#if conditions treated as false: ${[...unknown].join(', ')}`);
  return lists;
}

// ---------------------------------------------------------------- resources

async function buildResources(sources, ublockDir, braveSha, toolBin) {
  const excluded = new Set(sources.excludeResources ?? []);

  // 1. uBO redirect resources (images, noop files, google-analytics stubs...)
  const assembled = JSON.parse(runChecked(toolBin, [
    'assemble',
    path.join(ublockDir, 'src/web_accessible_resources'),
    path.join(ublockDir, 'src/js/redirect-resources.js'),
  ]));

  // 2. uBO built-in scriptlets (ES module in the uBlock repo)
  const mod = await import(pathToFileURL(path.join(ublockDir, 'src/js/resources/scriptlets.js')).href);
  const builtins = mod.builtinScriptlets;
  if (!Array.isArray(builtins) || builtins.length < 50) throw new Error('uBO builtinScriptlets looks wrong');
  const byName = new Map(builtins.map(s => [s.name, s]));
  const scriptlets = builtins.map(s => {
    for (const dep of s.dependencies ?? []) {
      if (!byName.has(dep)) log(`warning: scriptlet ${s.name} is missing dependency ${dep}`);
    }
    const r = {
      name: s.name,
      aliases: s.aliases ?? [],
      kind: { mime: 'application/javascript' },
      content: Buffer.from(s.fn.toString()).toString('base64'),
      dependencies: s.dependencies ?? [],
    };
    // Scriptlets uBO marks as "trusted" are only usable from lists that carry the trusted permission.
    if (s.requiresTrust) r.permission = TRUSTED_PERMISSION;
    return r;
  });

  // 3. Brave's own extras (YouTube fixes etc.)
  const braveUrl = `${sources.braveResources.rawBase}/${braveSha}/${sources.braveResources.path}`;
  const brave = JSON.parse(await fetchText(braveUrl));

  // Later sources win on a name clash, same order Brave uses.
  const merged = new Map();
  for (const r of [...assembled, ...brave, ...scriptlets]) {
    if (excluded.has(r.name)) continue;
    if (merged.has(r.name)) log(`warning: duplicate resource ${r.name}, later source wins`);
    merged.set(r.name, r);
  }
  const all = [...merged.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  log(`resources: ${assembled.length} redirect + ${scriptlets.length} scriptlets + ${brave.length} brave -> ${all.length}`);
  return JSON.stringify(all);
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'sources.json'), 'utf8'));
  const outDir = path.resolve(ROOT, args.out);
  const cacheDir = path.resolve(ROOT, args.cache);
  const now = args.now ? new Date(args.now) : new Date();
  const version = versionFrom(now);

  const prev = args.prev && fs.existsSync(args.prev) ? JSON.parse(fs.readFileSync(args.prev, 'utf8')) : null;
  const prevFiles = new Map((prev?.files ?? []).map(f => [f.name, f]));

  // Pin upstreams
  const uAssetsSha = lsRemoteHead(sources.uAssets.repo);
  const braveSha = lsRemoteHead(sources.braveResources.repo);
  const ublockDir = path.join(cacheDir, 'ublock');
  const uBlockSha = checkoutShallow(sources.uBlock.repo, ublockDir);
  log(`upstream: uAssets ${uAssetsSha.slice(0, 10)}, uBlock ${uBlockSha.slice(0, 10)}, brave ${braveSha.slice(0, 10)}`);

  // Rust helper
  const toolManifest = path.join(ROOT, 'tools/nf-tool/Cargo.toml');
  runChecked('cargo', ['build', '--release', '--locked', '--quiet', '--manifest-path', toolManifest]);
  const toolBin = path.join(ROOT, 'tools/nf-tool/target/release/nf-tool');

  // Build content
  const lists = await buildLists(sources, uAssetsSha);
  const resourcesJson = await buildResources(sources, ublockDir, braveSha, toolBin);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const files = [];
  for (const { entry, body } of lists) {
    fs.writeFileSync(path.join(outDir, entry.name), body);
    files.push({
      name: entry.name, kind: 'list', title: entry.title, format: 'standard',
      trusted: entry.trusted, sha256: sha256(body), size: Buffer.byteLength(body),
    });
  }
  fs.writeFileSync(path.join(outDir, 'resources.json'), resourcesJson);
  files.push({
    name: 'resources.json', kind: 'resources', title: 'uBO scriptlets and redirect resources',
    sha256: sha256(resourcesJson), size: Buffer.byteLength(resourcesJson),
  });
  files.sort((a, b) => (a.name < b.name ? -1 : 1));

  // Anything new?
  const changedNames = files
    .filter(f => prevFiles.get(f.name)?.sha256 !== f.sha256)
    .map(f => f.name);
  const removed = [...prevFiles.keys()].filter(n => !files.some(f => f.name === n));
  const changed = changedNames.length > 0 || removed.length > 0 || args.force;
  if (!changed) {
    log('no changes since the previous release');
    fs.rmSync(outDir, { recursive: true, force: true });
    setOutput('changed', 'false');
    return;
  }
  log(`changed: ${changedNames.join(', ') || '(forced)'}${removed.length ? `; removed: ${removed.join(', ')}` : ''}`);

  const manifest = {
    schema: MANIFEST_SCHEMA,
    version,
    generated: now.toISOString(),
    upstream: { uAssets: uAssetsSha, uBlock: uBlockSha, braveResources: braveSha },
    files,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // Validate in a real engine
  const v = run(toolBin, ['validate', outDir]);
  process.stderr.write(v.stderr ?? '');
  let report;
  try { report = JSON.parse(v.stdout); } catch { throw new Error(`validator produced no report:\n${v.stdout}\n${v.stderr}`); }
  if (v.status !== 0) throw new Error(`validation failed:\n${report.failures.join('\n')}`);
  for (const w of report.warnings) log(`warning: ${w}`);

  // Sanity checks and counts
  const problems = [];
  const maxDrop = sources.sanity?.maxRuleDropRatio ?? 0.3;
  for (const f of files) {
    if (f.kind === 'list') {
      const r = report.lists[f.name];
      f.rules = { network: r.network, cosmetic: r.cosmetic };
      f.invalidLines = r.parseErrors;
      const total = r.network + r.cosmetic;
      const min = sources.lists.find(l => l.name === f.name)?.minRules ?? 1;
      if (total < min) problems.push(`${f.name}: only ${total} rules (minimum ${min})`);
      const before = prevFiles.get(f.name)?.rules;
      if (before) {
        const prevTotal = before.network + before.cosmetic;
        if (prevTotal > 0 && total < prevTotal * (1 - maxDrop)) {
          problems.push(`${f.name}: rules dropped from ${prevTotal} to ${total} (more than ${maxDrop * 100}%)`);
        }
      }
    } else if (f.kind === 'resources') {
      f.count = report.resources;
      const before = prevFiles.get(f.name)?.count;
      if (before && report.resources < before * (1 - maxDrop)) {
        problems.push(`${f.name}: resources dropped from ${before} to ${report.resources}`);
      }
      if (report.resources < 100) problems.push(`${f.name}: only ${report.resources} resources`);
    }
  }
  if (problems.length) throw new Error(`sanity check failed:\n - ${problems.join('\n - ')}`);

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // Release notes
  const rows = files.map(f => {
    const n = f.kind === 'list' ? `${f.rules.network} network, ${f.rules.cosmetic} cosmetic` : `${f.count} resources`;
    return `| \`${f.name}\` | ${n} | ${changedNames.includes(f.name) ? 'changed' : ''} |`;
  });
  const notes = [
    `neat-filters ${version}`,
    '',
    '| File | Content | |',
    '| --- | --- | --- |',
    ...rows,
    '',
    'Upstream commits:',
    `- uAssets: \`${uAssetsSha}\``,
    `- uBlock: \`${uBlockSha}\``,
    `- brave/adblock-resources: \`${braveSha}\``,
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(path.resolve(ROOT, args.notes)), { recursive: true });
  fs.writeFileSync(path.resolve(ROOT, args.notes), notes);

  setOutput('changed', 'true');
  setOutput('version', version);
  log(`done: ${version}`);
}

main().catch(e => {
  console.error(e.stack ?? e);
  process.exit(1);
});
