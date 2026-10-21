# Notices

The files published by this repository are derived from the following upstream works. Their
licenses apply to the corresponding output files.

| Upstream | Used for | License |
| --- | --- | --- |
| [uBlockOrigin/uAssets](https://github.com/uBlockOrigin/uAssets) | `ubo-*.txt`, and the mirrored EasyList / EasyPrivacy copies | GPL-3.0 (see its `LICENSE`) |
| [gorhill/uBlock](https://github.com/gorhill/uBlock) | redirect resources and scriptlets in `resources.json` | GPL-3.0 |
| [EasyList / EasyPrivacy](https://easylist.to/) | `easylist.txt`, `easyprivacy.txt` | see https://easylist.to/pages/licence.html |
| [brave/adblock-resources](https://github.com/brave/adblock-resources) | Brave's extra resources in `resources.json` | MPL-2.0 |

Build tooling uses [adblock-rust](https://github.com/brave/adblock-rust) (MPL-2.0).

Each release's `manifest.json` records the exact upstream commits it was built from.
