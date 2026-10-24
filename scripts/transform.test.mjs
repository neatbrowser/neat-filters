import test from 'node:test';
import assert from 'node:assert/strict';
import { expandDenyallow, expandDenyallowLine, extractPopups, hostsToRules, isHostsFormat, splitNetworkRule } from './transform.mjs';

test('splitNetworkRule ignores cosmetic rules and non-option tails', () => {
  assert.equal(splitNetworkRule('example.com##a[href*="$popup"]'), null);
  assert.equal(splitNetworkRule('example.com#@#.ad'), null);
  assert.equal(splitNetworkRule('||x.com^'), null);
  assert.equal(splitNetworkRule('/regex$/'), null);
  assert.deepEqual(splitNetworkRule('@@||x.com^$script,3p'), {
    exception: true, pattern: '||x.com^', tokens: ['script', '3p'],
  });
});

test('denyallow becomes a blocking rule plus exceptions', () => {
  assert.deepEqual(
    expandDenyallowLine('*$script,3p,denyallow=a.com|b.net,domain=site.test'),
    [
      '*$script,3p,domain=site.test',
      '@@||a.com^$script,3p,domain=site.test',
      '@@||b.net^$script,3p,domain=site.test',
    ],
  );
});

test('denyallow rules that cannot be expanded faithfully are left alone', () => {
  const unchanged = [
    '@@*$script,denyallow=a.com,domain=s.test',            // exception rule
    '*$script,important,denyallow=a.com,domain=s.test',    // option we do not copy
    '*$denyallow=a.com',                                   // nothing left after removal
    '*$script,denyallow=~a.com,domain=s.test',             // negated domain
    '||x.com^$script,denyallow=a.com,replace=/a/b/',       // unsupported option remains
  ];
  for (const line of unchanged) assert.deepEqual(expandDenyallowLine(line), [line]);
});

test('expandDenyallow counts expansions and keeps other lines', () => {
  const r = expandDenyallow(['||x.com^', '*$script,3p,denyallow=a.com,domain=s.test', 'a.com##.ad']);
  assert.equal(r.expanded, 1);
  assert.deepEqual(r.lines, [
    '||x.com^',
    '*$script,3p,domain=s.test',
    '@@||a.com^$script,3p,domain=s.test',
    'a.com##.ad',
  ]);
});

test('popup rules move to the popup list with popup -> document', () => {
  const { kept, popups } = extractPopups([
    '||ads.com^',
    '||pop.example^$popup,3p',
    '@@||ok.example^$popup',
    '/apop/redirect/zone/*$doc,popup',
    '/earn.php?z=$popup,subdocument',
    '||under.example^$popunder',
    'site.com##a[href*="$popup"]',
    '||x.com^$script',
  ]);
  assert.deepEqual(kept, ['||ads.com^', 'site.com##a[href*="$popup"]', '||x.com^$script']);
  assert.deepEqual(popups, [
    '||pop.example^$document,3p',
    '@@||ok.example^$document',
    '/apop/redirect/zone/*$document',
    '/earn.php?z=$document,subdocument',
    '||under.example^$document',
  ]);
});

test('hosts files become blocking rules', () => {
  assert.deepEqual(
    hostsToRules([
      '# comment',
      '127.0.0.1 localhost',
      '127.0.0.1 ads.example.com   # trailing comment',
      '0.0.0.0 Track.Example.NET',
      '127.0.0.1 ads.example.com',
      '127.0.0.1 not a host line',
      '127.0.0.1 bad_host!',
      '',
    ]),
    ['||ads.example.com^', '||track.example.net^'],
  );
});

test('hosts format is told from filter syntax', () => {
  const hosts = Array.from({ length: 30 }, (_, i) => `0.0.0.0 h${i}.example`);
  assert.equal(isHostsFormat(['# c', ...hosts]), true);
  assert.equal(isHostsFormat(['||a.example^', '||b.example^$script', ...hosts.slice(0, 5)]), false);
  assert.equal(isHostsFormat(['! only comments', '||a.example^']), false);
});
