import test from 'node:test';
import assert from 'node:assert/strict';
import { assetLists, uAssetsPathFor } from './build.mjs';

test('uBO web mirror addresses map to uAssets paths', () => {
  assert.equal(uAssetsPathFor('https://ublockorigin.github.io/uAssets/filters/filters.txt'), 'filters/filters.txt');
  assert.equal(uAssetsPathFor('https://ublockorigin.github.io/uAssets/thirdparties/easylist.txt'), 'thirdparties/easylist/easylist.txt');
  assert.equal(uAssetsPathFor('https://ublockorigin.github.io/uAssets/thirdparties/easylist-social.txt'), 'thirdparties/easylist/easylist-social.txt');
  assert.equal(uAssetsPathFor('https://ublockorigin.github.io/uAssets/thirdparties/easyprivacy.txt'), 'thirdparties/easylist/easyprivacy.txt');
  assert.equal(uAssetsPathFor('https://example.org/list.txt'), null);
});

test('asset lists: exclusions, order of sources, trust, shared files', () => {
  const sources = { uboAssets: { exclude: ['skip-me'], required: ['a'], minRules: { a: 10 } } };
  const lists = assetLists(sources, {
    a: { content: 'filters', title: 'A', contentURL: ['https://ublockorigin.github.io/uAssets/filters/a.txt', 'assets/ublock/a.min.txt'] },
    b: { content: 'filters', title: 'B', contentURL: ['https://example.org/b.txt', 'assets/thirdparties/x/b.txt'] },
    'skip-me': { content: 'filters', title: 'S', contentURL: 'https://example.org/s.txt' },
    c: { content: 'filters', title: 'C', obsolete: true, contentURL: 'https://example.org/c.txt' },
    d: { content: 'filters', title: 'D', contentURL: 'https://example.org/b.txt' },
    img: { content: 'internal', title: 'I', contentURL: 'assets/x.png' },
  });
  assert.deepEqual(lists.map(l => l.id), ['a', 'b']);
  assert.deepEqual(lists[0].candidates, [{ raw: 'filters/a.txt' }]);
  assert.equal(lists[0].trusted, true);
  assert.equal(lists[0].required, true);
  assert.equal(lists[0].minRules, 10);
  assert.deepEqual(lists[1].candidates, [{ url: 'https://example.org/b.txt' }, { raw: 'thirdparties/x/b.txt' }]);
  assert.equal(lists[1].trusted, false);
  assert.equal(lists[1].name, 'b.txt');
});
