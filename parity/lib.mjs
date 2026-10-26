import fs from 'node:fs';
import path from 'node:path';

/** The network lists of a release (not the popup list): [{ name, text }]. */
export function networkLists(dist) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
  return manifest.files
    .filter(f => f.kind === 'list' && f.role !== 'popup' && f.role !== 'document')
    .map(f => ({ name: f.name, text: fs.readFileSync(path.join(dist, f.name), 'utf8') }));
}

export function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/** Small deterministic generator, so a corpus can be made again. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
