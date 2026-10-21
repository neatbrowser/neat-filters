import test from 'node:test';
import assert from 'node:assert/strict';
import { evalCondition, preprocess, normalize } from './preprocess.mjs';

const env = { a: true, b: false, c: true };

test('evalCondition basics', () => {
  assert.equal(evalCondition('a', env), true);
  assert.equal(evalCondition('b', env), false);
  assert.equal(evalCondition('!b', env), true);
  assert.equal(evalCondition('a && b', env), false);
  assert.equal(evalCondition('a || b', env), true);
  assert.equal(evalCondition('!(a && b) && c', env), true);
  assert.equal(evalCondition('a && b || c', env), true);
});

test('unknown conditions are false and recorded', () => {
  const unknown = new Set();
  assert.equal(evalCondition('nope', env, unknown), false);
  assert.equal(evalCondition('!nope', env, unknown), true);
  assert.deepEqual([...unknown], ['nope']);
});

test('if / else / endif, nested', async () => {
  const text = [
    'r1',
    '!#if a',
    'r2',
    '!#if b',
    'r3',
    '!#else',
    'r4',
    '!#endif',
    '!#else',
    'r5',
    '!#endif',
    'r6',
  ].join('\n');
  const out = await preprocess(text, { path: 'x.txt', env, load: async () => '' });
  assert.deepEqual(out, ['r1', 'r2', 'r4', 'r6']);
});

test('include is resolved relative to the including list and skipped in inactive branches', async () => {
  const files = {
    'dir/inc.txt': 'i1\n!#include sub/deep.txt',
    'dir/sub/deep.txt': 'd1',
  };
  const loaded = [];
  const load = async p => { loaded.push(p); return files[p]; };
  const text = '!#include inc.txt\n!#if b\n!#include never.txt\n!#endif\nend';
  const out = await preprocess(text, { path: 'dir/main.txt', env, load });
  assert.deepEqual(out, ['i1', 'd1', 'end']);
  assert.deepEqual(loaded, ['dir/inc.txt', 'dir/sub/deep.txt']);
});

test('include may not escape the source root', async () => {
  await assert.rejects(
    preprocess('!#include ../../x.txt', { path: 'a/b.txt', env, load: async () => '' }),
    /escapes/,
  );
});

test('unterminated and stray directives throw', async () => {
  await assert.rejects(preprocess('!#if a\nx', { path: 'x', env, load: async () => '' }), /Unterminated/);
  await assert.rejects(preprocess('!#endif', { path: 'x', env, load: async () => '' }), /Stray/);
});

test('normalize drops comments, headers, blanks, CRs', () => {
  const lines = ['[Adblock Plus 2.0]', '! Title: x', '! Last modified: now', '', '||ads.example^', 'a.com##.ad  ', '!#if x'];
  assert.deepEqual(normalize(lines), ['||ads.example^', 'a.com##.ad']);
});
