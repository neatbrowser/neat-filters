// Rule transforms that make uBO-only syntax usable with adblock-rust.
//
//  - expandDenyallow: `*$script,3p,denyallow=a.com|b.com,domain=site` has no equivalent option in
//    adblock-rust, but it is exactly "block ..., except a.com and b.com". It is rewritten as one
//    blocking rule plus one exception rule per allowed domain.
//  - extractPopups: `$popup` rules are not network requests. They are moved to a separate list with
//    `popup` replaced by `document`, to be checked by the browser against the URL of a new
//    window (e.g. WebView2's NewWindowRequested) with the opener page as the source URL.

// Cosmetic rule markers before the first `$` (e.g. `example.com##.ad`, `a.com#@#.b`).
const COSMETIC_BEFORE_DOLLAR = /^[^$]*#[@?$%]*#/;
const OPTION_TOKEN = /^~?[A-Za-z0-9][A-Za-z0-9-]*(=.*)?$/;

// Options whose meaning is the same on a blocking rule and on its exception, so it is safe to
// copy them onto the generated exceptions.
const COPYABLE_OPTION =
  /^(~?(script|image|stylesheet|css|xhr|xmlhttprequest|subdocument|frame|font|media|object|other|ping|beacon|websocket|3p|1p|third-party|first-party)|(domain|from)=.+)$/;

const DENYALLOW_DOMAIN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/** @returns {{exception: boolean, pattern: string, tokens: string[]} | null} */
export function splitNetworkRule(line) {
  if (COSMETIC_BEFORE_DOLLAR.test(line)) return null;
  const idx = line.lastIndexOf('$');
  if (idx < 0) return null;
  const tokens = line.slice(idx + 1).split(',');
  if (!tokens.every(t => OPTION_TOKEN.test(t))) return null;
  const exception = line.startsWith('@@');
  return { exception, pattern: line.slice(exception ? 2 : 0, idx), tokens };
}

const join = (exception, pattern, tokens) => `${exception ? '@@' : ''}${pattern}$${tokens.join(',')}`;

/** @returns {string[]} replacement lines (the input line itself when it cannot be transformed) */
export function expandDenyallowLine(line) {
  const rule = splitNetworkRule(line);
  if (!rule || rule.exception) return [line];
  const deny = rule.tokens.find(t => t.startsWith('denyallow='));
  if (!deny) return [line];

  const rest = rule.tokens.filter(t => t !== deny);
  if (rest.length === 0 || !rest.every(t => COPYABLE_OPTION.test(t))) return [line];

  const domains = deny.slice('denyallow='.length).split('|');
  if (!domains.every(d => DENYALLOW_DOMAIN.test(d))) return [line];

  return [
    join(false, rule.pattern, rest),
    ...domains.map(d => join(true, `||${d}^`, rest)),
  ];
}

export function expandDenyallow(lines) {
  let expanded = 0;
  const out = [];
  for (const line of lines) {
    const r = line.includes('denyallow=') ? expandDenyallowLine(line) : [line];
    if (r.length > 1) expanded++;
    out.push(...r);
  }
  return { lines: out, expanded };
}

/** Splits popup rules out of a rule list. */
export function extractPopups(lines) {
  const kept = [];
  const popups = [];
  for (const line of lines) {
    const rule = (line.includes('pop') ? splitNetworkRule(line) : null);
    if (!rule || !rule.tokens.some(t => t === 'popup' || t === 'popunder')) {
      kept.push(line);
      continue;
    }
    const tokens = [];
    for (const t of rule.tokens) {
      const mapped = t === 'popup' || t === 'popunder' || t === 'doc' ? 'document' : t;
      if (!tokens.includes(mapped)) tokens.push(mapped);
    }
    popups.push(join(rule.exception, rule.pattern, tokens));
  }
  return { kept, popups };
}

/**
 * Turns a hosts-file list (`127.0.0.1 ads.example`, `0.0.0.0 ads.example`) into blocking rules
 * (`||ads.example^`), the way uBO reads such lists. Comments and `localhost` entries are dropped.
 * @returns {string[]}
 */
export function hostsToRules(lines) {
  const out = [];
  const seen = new Set();
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const m = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+(\S+)$/.exec(line);
    if (!m) continue;
    const host = m[1].toLowerCase();
    if (host === 'localhost' || host === 'localhost.localdomain' || host === 'local' || host === 'broadcasthost') continue;
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(host) || seen.has(host)) continue;
    seen.add(host);
    out.push(`||${host}^`);
  }
  return out;
}

/** True when a list is in hosts-file format (most of its non-comment lines are `0.0.0.0 host`). */
export function isHostsFormat(lines) {
  let hosts = 0;
  let other = 0;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '' || line.startsWith('!')) continue;
    if (/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+\S+$/.test(line)) hosts++;
    else other++;
  }
  return hosts >= 20 && hosts > other * 4;
}
