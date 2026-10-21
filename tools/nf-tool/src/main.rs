//! Helper binary used by `scripts/build.mjs`.
//!
//!   nf-tool assemble <web_accessible_resources_dir> <redirect-resources.js>
//!       Prints the uBO redirect resources as adblock-rust `Resource` JSON.
//!
//!   nf-tool validate <dist_dir>
//!       Loads every list and the resources listed in `<dist_dir>/manifest.json` into a real
//!       adblock-rust engine, runs smoke tests and prints a JSON report. Exits non-zero on failure.

use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::resources::resource_assembler::assemble_web_accessible_resources;
use adblock::resources::{PermissionMask, Resource};
use adblock::Engine;
use serde_json::{json, Value};
use std::path::Path;
use std::process::ExitCode;

/// Bit 0 = "trusted uBO list". Must match `TRUSTED_PERMISSION` in scripts/build.mjs.
const TRUSTED: PermissionMask = PermissionMask::from_bits(1);

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("assemble") if args.len() == 4 => assemble(&args[2], &args[3]),
        Some("validate") if args.len() == 3 => validate(&args[2]),
        _ => {
            eprintln!("usage: nf-tool assemble <web_accessible_dir> <redirect-resources.js>\n       nf-tool validate <dist_dir>");
            ExitCode::from(2)
        }
    }
}

fn assemble(dir: &str, redirect_js: &str) -> ExitCode {
    let resources = assemble_web_accessible_resources(Path::new(dir), Path::new(redirect_js));
    println!("{}", serde_json::to_string(&resources).expect("serialize resources"));
    ExitCode::SUCCESS
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

fn validate(dir: &str) -> ExitCode {
    let dir = Path::new(dir);
    let mut failures: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    let manifest = match read_json(&dir.join("manifest.json")) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let files = manifest["files"].as_array().cloned().unwrap_or_default();

    // Lists
    let mut set = FilterSet::new(true);
    let mut list_names: Vec<(usize, String)> = Vec::new();
    for f in files.iter().filter(|f| f["kind"] == "list") {
        let name = f["name"].as_str().unwrap_or_default().to_string();
        let text = match std::fs::read_to_string(dir.join(&name)) {
            Ok(t) => t,
            Err(e) => {
                failures.push(format!("{name}: cannot read ({e})"));
                continue;
            }
        };
        let opts = ParseOptions {
            permissions: if f["trusted"] == true { TRUSTED } else { PermissionMask::default() },
            ..Default::default()
        };
        let record = set.add_filter_list(text, opts);
        list_names.push((record.source_index, name));
    }

    // Resources
    let mut resources: Vec<Resource> = Vec::new();
    for f in files.iter().filter(|f| f["kind"] == "resources") {
        let name = f["name"].as_str().unwrap_or_default();
        let parsed = std::fs::read_to_string(dir.join(name))
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str::<Vec<Resource>>(&t).map_err(|e| e.to_string()));
        match parsed {
            Ok(r) => resources.extend(r),
            Err(e) => failures.push(format!("{name}: not valid adblock-rust resources ({e})")),
        }
    }
    let resource_count = resources.len();

    let mut engine = Engine::new_with_filter_set(set);
    engine.use_resources(resources);

    // Per-list statistics
    let info = engine.get_debug_info();
    let mut lists_report = serde_json::Map::new();
    for (idx, name) in &list_names {
        if let Some(s) = info.source_info.get(*idx) {
            lists_report.insert(
                name.clone(),
                json!({
                    "network": s.network_filter_count,
                    "cosmetic": s.cosmetic_filter_count,
                    "parseErrors": s.parse_error,
                    "invalidLines": s.invalid_lines.iter().take(10).collect::<Vec<_>>(),
                }),
            );
        } else {
            failures.push(format!("{name}: no statistics reported by the engine"));
        }
    }

    // Smoke tests: (description, url, source, type, expect_blocked)
    let cases: [(&str, &str, &str, &str, bool); 5] = [
        ("doubleclick gpt.js is blocked", "https://securepubads.g.doubleclick.net/tag/js/gpt.js", "https://example.com/", "script", true),
        ("adsbygoogle.js is blocked", "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js", "https://example.com/", "script", true),
        ("google-analytics analytics.js is blocked", "https://www.google-analytics.com/analytics.js", "https://example.com/", "script", true),
        ("example.com document is allowed", "https://example.com/", "https://example.com/", "document", false),
        ("same-site stylesheet is allowed", "https://example.com/style.css", "https://example.com/", "stylesheet", false),
    ];
    let mut smoke = Vec::new();
    for (desc, url, source, ty, expect_blocked) in cases {
        let ok = match Request::new(url, source, ty, "") {
            Ok(req) => {
                let r = engine.check_network_request(&req);
                let blocked = r.should_block() || r.redirect.is_some();
                blocked == expect_blocked
            }
            Err(e) => {
                failures.push(format!("smoke '{desc}': bad request ({e:?})"));
                false
            }
        };
        if !ok {
            failures.push(format!("smoke test failed: {desc}"));
        }
        smoke.push(json!({ "name": desc, "ok": ok }));
    }

    // Scriptlet pipeline check (warning only: depends on upstream rules staying around).
    let yt = engine.url_cosmetic_resources("https://www.youtube.com/watch?v=x");
    if yt.injected_script.is_empty() {
        warnings.push("youtube.com produced no injected scriptlet; check resources and trusted permissions".into());
    }

    let report = json!({
        "lists": lists_report,
        "resources": resource_count,
        "smoke": smoke,
        "youtubeInjectedScriptBytes": yt.injected_script.len(),
        "warnings": warnings,
        "failures": failures,
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    if failures.is_empty() { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}
