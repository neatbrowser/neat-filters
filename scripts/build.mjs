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
import { expandDenyallow, extractPopups, hostsToRules, isHostsFormat } from './transform.mjs';

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

const FETCH_ATTEMPTS = Number(process.env.NF_FETCH_ATTEMPTS) || 4;

async function fetchText(url, attempts = FETCH_ATTEMPTS) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      log(`fetch failed (${attempt}/${attempts}) ${url}: ${e.message}`);
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

const UAssetsPages = 'https://ublockorigin.github.io/uAssets/';

/** uBO's own web mirror of uAssets -> the matching path in the uAssets repository (pinned), or null. */
export function uAssetsPathFor(url) {
  if (!url.startsWith(UAssetsPages)) return null;
  const p = url.slice(UAssetsPages.length);
  const m = /^thirdparties\/(easylist[^/]*|easyprivacy)\.txt$/.exec(p);
  return m ? `thirdparties/easylist/${m[1]}.txt` : p;
}

/**
 * The lists of uBO's assets.json (at the pinned uBlock commit), except those excluded, with the
 * places each can be fetched from in order of preference: what uBO itself downloads first, the
 * copy kept in uAssets last.
 */
export function assetLists(sources, assetsJson) {
  const cfg = sources.uboAssets;
  const exclude = new Set(cfg.exclude ?? []);
  const required = new Set(cfg.required ?? []);
  const out = [];
  const seen = new Set();
  for (const [id, a] of Object.entries(assetsJson)) {
    if (a.content !== 'filters' || a.obsolete || exclude.has(id)) continue;
    const candidates = [];
    const add = c => { if (!candidates.some(x => x.raw === c.raw && x.url === c.url)) candidates.push(c); };
    for (const u of [].concat(a.contentURL ?? [])) {
      if (/^https?:/.test(u)) {
        const raw = uAssetsPathFor(u);
        add(raw ? { raw } : { url: u });
      } else {
        const p = u.replace(/^assets\//, '');
        if (!p.startsWith('ublock/')) add({ raw: p });
      }
    }
    if (candidates.length === 0) continue;

    // Two entries of assets.json can name the same file (uBO shares one cookie-notice file);
    // the engine must not load it twice.
    const key = JSON.stringify(candidates[0]);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      id,
      name: `${id.toLowerCase()}.txt`,
      title: `${a.title} [${id}]`,
      candidates,
      // uBO's own lists (filters/*) may use trusted scriptlets; third-party lists may not.
      trusted: candidates[0].raw?.startsWith('filters/') === true,
      required: required.has(id),
      minRules: cfg.minRules?.[id] ?? 1,
    });
  }
  return out;
}

async function buildLists(sources, uAssetsSha, ublockDir, prev) {
  const cache = new Map();
  const load = async p => {
    if (!cache.has(p)) cache.set(p, fetchText(`${sources.uAssets.rawBase}/${uAssetsSha}/${p}`));
    return cache.get(p);
  };
  const unknown = new Set();
  const lists = [];
  const popups = new Set();
  let expandedTotal = 0;

  const assetsJson = JSON.parse(fs.readFileSync(path.join(ublockDir, 'assets/assets.json'), 'utf8'));
  const entries = [
    ...sources.lists.map(e => ({ ...e, candidates: [{ raw: e.path }], required: true })),
    ...assetLists(sources, assetsJson),
    // Lists that are not part of uBO's set (see `extraLists` in sources.json), tried address by address.
    ...(sources.extraLists ?? []).map(e => ({ ...e, candidates: e.urls.map(url => ({ url })), required: false })),
  ];
  const optionalDrop = sources.sanity?.optionalDropRatio ?? 0.5;
  const reused = [];
  const skipped = [];

  const process_ = async (entry, text, listPath, loader) => {
    const lines = await preprocess(text.replace(/^\uFEFF/, ''), { path: listPath, env: sources.env, load: loader, unknown });
    const rules = entry.format === 'hosts' || isHostsFormat(lines) ? hostsToRules(lines) : normalize(lines);
    const expanded = expandDenyallow(rules);
    const { kept, popups: found } = extractPopups(expanded.lines);
    return { kept, found, denyallow: expanded.expanded };
  };

  for (const entry of entries) {
    let result = null;
    let source = null;
    for (const c of entry.candidates) {
      try {
        let text;
        let listPath;
        let loader = load;
        if (c.raw !== undefined) {
          text = await load(c.raw);
          listPath = c.raw;
        } else {
          // A list on another site includes its helper files from the same place (uBO resolves
          // `!#include` relative to the list's address).
          text = await fetchText(c.url, Math.min(FETCH_ATTEMPTS, 3));
          const u = new URL(c.url);
          listPath = u.pathname.slice(1);
          loader = p => fetchText(`${u.origin}/${p}`, Math.min(FETCH_ATTEMPTS, 3));
        }
        result = await process_(entry, text, listPath, loader);
        source = c.raw !== undefined ? `${sources.uAssets.repo}/blob/${uAssetsSha}/${c.raw}` : c.url;
        break;
      } catch (e) {
        log(`${entry.name}: ${c.raw ?? c.url} unusable (${e.message.split('\n')[0]})`);
      }
    }

    // A source that fails or shrinks a lot must not take protection away: the list of the
    // previous release is kept instead (never for the lists that are required).
    const prevEntry = prev.files.get(entry.name);
    const prevTotal = prevEntry?.rules ? prevEntry.rules.network + prevEntry.rules.cosmetic : 0;
    const fresh = result ? result.kept.length : 0;
    const bad = !result || fresh < entry.minRules || (prevTotal > 0 && fresh < prevTotal * (1 - optionalDrop));
    if (bad && !entry.required) {
      const old = prevEntry && prev.read(entry.name);
      if (old) {
        log(`${entry.name}: ${result ? `shrank to ${fresh} rules from ${prevTotal}` : 'no source reachable'}; keeping the previous release's copy`);
        lists.push({ entry, body: old, source: prevEntry.source });
        reused.push(entry.name);
      } else {
        log(`${entry.name}: ${result ? `only ${fresh} rules` : 'no source reachable'} and no earlier copy; left out`);
        skipped.push(entry.name);
      }
      continue;
    }
    if (!result) throw new Error(`${entry.name}: no source could be fetched`);

    for (const p of result.found) popups.add(p);
    expandedTotal += result.denyallow;
    const body = result.kept.join('\n') + '\n';
    lists.push({ entry, body, source });
    log(`${entry.name}: ${body.length} bytes, ${result.denyallow} denyallow expanded, ${result.found.length} popup rules moved`);
  }
  if (unknown.size) log(`unknown !#if conditions treated as false: ${[...unknown].join(', ')}`);
  log(`denyallow rules expanded: ${expandedTotal}; popup rules: ${popups.size}; lists reused from the previous release: ${reused.length}; left out: ${skipped.length}`);

  // Popup rules (converted to `$document`) are published as their own list.
  const popupEntry = {
    name: sources.popups.name,
    title: sources.popups.title,
    role: 'popup',
    trusted: false,
    minRules: sources.popups.minRules,
  };
  lists.push({ entry: popupEntry, body: [...popups].join('\n') + '\n' });
  return { lists, reused, skipped };
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
  // Files of the previous release (next to its manifest), used when a source cannot be fetched.
  const prevDir = args.prev ? path.dirname(path.resolve(args.prev)) : null;
  const prevLists = {
    files: prevFiles,
    read: name => {
      const f = prevDir && path.join(prevDir, name);
      return f && fs.existsSync(f) && prevFiles.get(name)?.sha256 === sha256(fs.readFileSync(f))
        ? fs.readFileSync(f, 'utf8')
        : null;
    },
  };

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
  const { lists, reused, skipped } = await buildLists(sources, uAssetsSha, ublockDir, prevLists);
  const resourcesJson = await buildResources(sources, ublockDir, braveSha, toolBin);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const files = [];
  const minByName = new Map();
  const requiredNames = new Set(lists.filter(l => l.entry.required).map(l => l.entry.name));
  for (const { entry, body, source } of lists) {
    fs.writeFileSync(path.join(outDir, entry.name), body);
    minByName.set(entry.name, entry.minRules ?? 1);
    files.push({
      name: entry.name, kind: 'list', title: entry.title, format: 'standard',
      role: entry.role ?? 'network', tier: entry.tier ?? 'standard', trusted: entry.trusted === true, source, sha256: sha256(body), size: Buffer.byteLength(body),
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
      const min = minByName.get(f.name) ?? 1;
      if (total < min) problems.push(`${f.name}: only ${total} rules (minimum ${min})`);
      // Optional lists were already held to their own rule in buildLists (a big drop keeps the
      // previous copy); only the required ones can stop the release here.
      const before = requiredNames.has(f.name) ? prevFiles.get(f.name)?.rules : null;
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => {
    console.error(e.stack ?? e);
    process.exit(1);
  });
}
