# neat-filters

Filter lists and scripting resources for NEAT's built-in content blocker
([adblock-rust](https://github.com/brave/adblock-rust) engine), rebuilt from uBlock Origin's
upstream sources every 6 hours by GitHub Actions. Releases are only created when something
actually changed.

NEAT (or any other client) reads a small `manifest.json`, downloads only the files whose hash
changed, verifies them, and hot-swaps its engine.

## Release layout

Every release (tag `vYYYY.MM.DD.HHmm`, UTC) contains **all** files, so
`releases/latest/download/<name>` is always valid and clients need no GitHub API call:

| File | What |
| --- | --- |
| `manifest.json` | version, upstream commits, sha256 / size / rule counts per file |
| `ubo-filters.txt`, `ubo-badware.txt`, `ubo-privacy.txt`, `ubo-quick-fixes.txt`, `ubo-unbreak.txt`, `ubo-resource-abuse.txt` | uBlock Origin's default lists (**trusted**) |
| `easylist.txt`, `easyprivacy.txt` | EasyList / EasyPrivacy (not trusted) |
| `peter-lowe.txt` | Peter Lowe's ad and tracking server list (hosts file, rewritten as rules; not trusted) |
| `urlhaus.txt` | URLhaus online malicious URL list (not trusted) |
| `popups.txt` | all `$popup` / `$popunder` rules converted to `$document`, for a **second** engine (see [Popup blocking](#popup-blocking)) |
| `resources.json` | adblock-rust `Resource[]`: uBO redirect resources, uBO scriptlets, Brave's extras |

The newest 30 releases are kept.

### Client update protocol

1. `GET https://github.com/<owner>/neat-filters/releases/latest/download/manifest.json`
   (send `If-None-Match` with the stored ETag; a `304` means nothing to do).
2. For each entry in `files` whose `sha256` differs from the local copy, download
   `.../releases/latest/download/<name>` into a temp file.
3. Verify size and sha256 against the manifest, then rename atomically.
4. Rebuild the engine off the UI thread, swap it in, keep the previous one as a fallback.

If the manifest changes between steps 1 and 2 (a new release landed), restart from step 1.

### Manifest

```jsonc
{
  "schema": 1,
  "version": "2026.10.21.0510",
  "generated": "2026-10-21T05:10:38.133Z",
  "upstream": { "uAssets": "<sha>", "uBlock": "<sha>", "braveResources": "<sha>" },
  "files": [
    { "name": "easylist.txt", "kind": "list", "title": "EasyList", "format": "standard",
      "role": "network", "trusted": false, "sha256": "…", "size": 2120696,
      "rules": { "network": 56749, "cosmetic": 24698 }, "invalidLines": 1 },
    { "name": "popups.txt", "kind": "list", "role": "popup", "trusted": false, "…": "…" },
    { "name": "resources.json", "kind": "resources", "sha256": "…", "size": 1025976, "count": 216 }
  ]
}
```

### Roles

`role: "network"` lists go into the main engine. `role: "popup"` lists go into a separate popup
engine. Clients that ignore unknown fields keep working; they just do not get popup blocking.

### Trusted lists

uBO "trusted" scriptlets (`trusted-*`, which can e.g. rewrite responses or set cookies) are
marked in `resources.json` with `"permission": 1`. Load a list with `trusted: true` using
`ParseOptions { permissions: PermissionMask::from_bits(1), .. }`, and every other list with the
default (no) permissions. Then only these vetted lists can use trusted scriptlets, and user-added
lists cannot.

## What the build does

`scripts/build.mjs`:

1. Pins the upstream commits (uAssets, uBlock, brave/adblock-resources) and records them in the manifest.
2. Downloads the lists from the pinned uAssets commit and resolves `!#include` / `!#if` / `!#else`
   / `!#endif` using the condition table in `sources.json` (`env`; Chromium desktop, no HTML
   filtering). Comments and headers are stripped so timestamp-only upstream changes do not change
   the published bytes. Then `denyallow` rules are expanded and `$popup` rules are split out
   (`scripts/transform.mjs`).
3. Builds `resources.json`: redirect resources via adblock-rust's `resource-assembler`
   (`tools/nf-tool`), uBO built-in scriptlets by importing uBlock's `scriptlets.js`, plus Brave's
   `dist/resources.json`.
4. Compares file hashes with the previous release's manifest. Nothing changed: stop.
5. Loads everything into a real adblock-rust engine (`nf-tool validate`): lists must parse,
   resources must deserialize, a few smoke requests must behave, and per-list rule counts are
   recorded.
6. Sanity checks: per-list minimum rule counts, and no list or the resource set may shrink by
   more than 30% versus the previous release. A failed check fails the run and keeps the last good
   release in place.

## Popup blocking

`$popup` rules are not network requests, so adblock-rust cannot apply them to normal traffic.
The build moves them (about 3100 rules, nearly all from EasyList) into `popups.txt` with `popup`
and `popunder` replaced by `document`. In NEAT:

1. Load every `role: "popup"` list into a **second** `Engine` (it needs no resources).
2. In WebView2's `NewWindowRequested`, build a request with the target URI as the URL, the opener
   page's URL as the source and type `document`, and ask the popup engine. If it says block, set
   `Handled = true` and do not open the window.
3. Optionally also block windows that are not user initiated (`IsUserInitiated == false`).
   That alone is not enough: most popunders are triggered from a click anywhere on the page, which
   counts as user initiated, so the list is what catches them.

`nf-tool validate` self-tests this rule shape (block, per-opener exception, unrelated target) on
every build.

## What is rewritten, and what is still dropped

- **`denyallow=`** (about 250 rules) is expanded: `*$script,3p,denyallow=a.com|b.net,domain=s.com`
  becomes `*$script,3p,domain=s.com` plus `@@||a.com^$script,3p,domain=s.com` and
  `@@||b.net^$script,3p,domain=s.com`. Rules that cannot be expanded faithfully (exceptions,
  options that cannot be copied onto the exception) are left as they were and counted as invalid.
- Everything else adblock-rust cannot parse is skipped and counted. `nf-tool validate` classifies
  each rejected line by the parser's own error. On the 2026-10-21 build about 800 lines remain
  (of roughly 175,000 rules): `urlskip=` 234, HTML filters `##^` 161, generic unhide `#@#` 57,
  value-less `redirect-rule` exceptions 41, `ipaddress=` 31, `cname` 29, `replace=` 17, `header=` 16,
  `uritransform=` 16, `reason=` 16, plus a handful of others. Per-list counts are in the manifest
  (`invalidLines`).

## Local build

Requires Node 22, Rust (stable) and git.

```sh
npm test                                   # preprocessor and transform unit tests
node scripts/build.mjs                     # writes dist/
node scripts/build.mjs --prev path/to/manifest.json
node scripts/build.mjs --force             # ignore "nothing changed"
```

## Adding a list

Add an entry to `lists` in `sources.json` (`name`, `title`, `path` inside the uAssets repo,
`trusted`, `minRules`). Lists hosted elsewhere need a small change in `buildLists`.

See [NOTICE.md](NOTICE.md) for upstream licenses.
