// Preprocessor for uBlock Origin style filter lists.
//
// Resolves `!#include`, `!#if` / `!#else` / `!#endif` the way uBO does at runtime, so the
// lists we publish are flat and contain only rules. Unknown conditions evaluate to false.

import path from 'node:path';

const MAX_INCLUDE_DEPTH = 8;

// Tiny recursive-descent evaluator for: !x, a && b, a || b, (expr)
export function evalCondition(expr, env, unknown = new Set()) {
  const tokens = expr.match(/&&|\|\||!|\(|\)|[A-Za-z0-9_]+/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseOr() {
    let v = parseAnd();
    while (peek() === '||') { next(); const r = parseAnd(); v = v || r; }
    return v;
  }
  function parseAnd() {
    let v = parseNot();
    while (peek() === '&&') { next(); const r = parseNot(); v = v && r; }
    return v;
  }
  function parseNot() {
    if (peek() === '!') { next(); return !parseNot(); }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = next();
    if (t === '(') {
      const v = parseOr();
      if (next() !== ')') throw new Error(`Unbalanced parenthesis in condition: ${expr}`);
      return v;
    }
    if (t === undefined) throw new Error(`Unexpected end of condition: ${expr}`);
    if (Object.hasOwn(env, t)) return Boolean(env[t]);
    unknown.add(t);
    return false;
  }

  const result = parseOr();
  if (pos !== tokens.length) throw new Error(`Trailing tokens in condition: ${expr}`);
  return result;
}

/**
 * @param {string} text         list text
 * @param {object} opts
 * @param {string} opts.path    path of this list (posix, relative to the source root)
 * @param {object} opts.env     condition table
 * @param {(p: string) => Promise<string>} opts.load   fetches an included file by path
 * @param {Set<string>} [opts.unknown]  collects unknown condition names
 * @param {number} [opts.depth]
 * @returns {Promise<string[]>} output lines
 */
export async function preprocess(text, opts) {
  const { path: listPath, env, load, unknown = new Set(), depth = 0 } = opts;
  if (depth > MAX_INCLUDE_DEPTH) throw new Error(`Include depth exceeded at ${listPath}`);

  const out = [];
  // Each frame: { parentActive, cond, inElse }
  const stack = [];
  const active = () => stack.every(f => (f.inElse ? !f.cond : f.cond));

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    if (line.startsWith('!#if ')) {
      const cond = evalCondition(line.slice(5).trim(), env, unknown);
      stack.push({ cond, inElse: false });
      continue;
    }
    if (line.startsWith('!#else')) {
      if (!stack.length) throw new Error(`Stray !#else in ${listPath}`);
      stack[stack.length - 1].inElse = true;
      continue;
    }
    if (line.startsWith('!#endif')) {
      if (!stack.length) throw new Error(`Stray !#endif in ${listPath}`);
      stack.pop();
      continue;
    }
    if (line.startsWith('!#include ')) {
      if (!active()) continue;
      const target = line.slice(10).trim();
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(listPath), target));
      if (resolved.startsWith('..')) throw new Error(`Include escapes source root: ${target}`);
      const included = await load(resolved);
      out.push(...await preprocess(included, { ...opts, path: resolved, depth: depth + 1, unknown }));
      continue;
    }
    if (active()) out.push(line);
  }
  if (stack.length) throw new Error(`Unterminated !#if in ${listPath}`);
  return out;
}

/**
 * Drops comments, list headers and blank lines, so that metadata-only upstream changes
 * (timestamps, versions, expiry) do not change the published file or its hash.
 */
export function normalize(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === '') continue;
    if (line.startsWith('!')) continue;
    if (/^\[(Adblock|uBlock)/i.test(line)) continue;
    out.push(line);
  }
  return out;
}
