//! Helper binary used by `scripts/build.mjs`.
//!
//!   nf-tool assemble <web_accessible_resources_dir> <redirect-resources.js>
//!       Prints the uBO redirect resources as adblock-rust `Resource` JSON.
//!
//!   nf-tool bench <dist_dir> <hosts.txt> [source_url]
//!       Runs every host of the file (one per line, `#` comments allowed; a full URL is used
//!       as it is) through the real engine as a third-party request of several types and prints
//!       a JSON report: verdict per type, the rule that matched, and the list it came from.
//!
//!   nf-tool cosmetic <rules.txt> <page_url>
//!       Loads the rules of one file into an engine and prints what it says about the page
//!       (hide selectors, procedural actions, ...) as JSON. Used by the page script's tests.
//!
//!   nf-tool validate <dist_dir>
//!       Loads every list and the resources listed in `<dist_dir>/manifest.json` into real
//!       adblock-rust engines (one for network lists, one for `role: "popup"` lists), runs
//!       smoke tests and self-tests, and prints a JSON report. Exits non-zero on failure.

use adblock::lists::{parse_filter, FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::resources::resource_assembler::assemble_web_accessible_resources;
use adblock::resources::{PermissionMask, Resource};
use adblock::Engine;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::process::ExitCode;

/// Bit 0 = "trusted uBO list". Must match `TRUSTED_PERMISSION` in scripts/build.mjs.
const TRUSTED: PermissionMask = PermissionMask::from_bits(1);

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("assemble") if args.len() == 4 => assemble(&args[2], &args[3]),
        Some("validate") if args.len() == 3 => validate(&args[2]),
        Some("cosmetic") if args.len() == 4 => {
            let text = std::fs::read_to_string(&args[2]).unwrap_or_default();
            let engine = Engine::new_with_list_text(&text);
            let r = engine.url_cosmetic_resources(&args[3]);
            println!(
                "{}",
                json!({
                    "hide_selectors": r.hide_selectors,
                    "procedural_actions": r.procedural_actions,
                    "exceptions": r.exceptions,
                    "generichide": r.generichide,
                })
            );
            ExitCode::SUCCESS
        }
        Some("bench") if args.len() == 4 || args.len() == 5 => {
            bench(&args[2], &args[3], args.get(4).map(String::as_str).unwrap_or("https://superadblocktest.com/"))
        }
        _ => {
            eprintln!("usage: nf-tool assemble <web_accessible_dir> <redirect-resources.js>\n       nf-tool validate <dist_dir>\n       nf-tool bench <dist_dir> <hosts.txt> [source_url]");
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

/// Why did the engine reject this line? Uses the real parser: for an "unrecognised option" error,
/// every option in the line is probed on its own to find the one adblock-rust does not know.
fn classify(line: &str, supported: &mut HashMap<String, bool>) -> String {
    let err = match parse_filter(line, false, ParseOptions::default()) {
        Ok(_) => return "parses when retried alone".to_string(),
        Err(e) => e.to_string(),
    };
    if !err.ends_with("unrecognised option") {
        return err;
    }
    let first_dollar_free_tail = match line.rfind('$') {
        Some(i) => &line[i + 1..],
        None => return err,
    };
    for token in first_dollar_free_tail.split(',') {
        let t = token.trim_start_matches('~');
        let (name, has_value) = match t.split_once('=') {
            Some((n, _)) => (n, true),
            None => (t, false),
        };
        if name.is_empty() {
            continue;
        }
        let ok = *supported.entry(name.to_string()).or_insert_with(|| {
            let probe = if name == "method" {
                format!("||example.com^${name}=get")
            } else if has_value {
                format!("||example.com^${name}=example.com")
            } else {
                format!("||example.com^${name}")
            };
            parse_filter(&probe, false, ParseOptions::default()).is_ok()
        });
        if !ok {
            return format!("unsupported option: {name}");
        }
    }
    "unrecognised option (in combination)".to_string()
}

struct LoadedLists {
    engine_set: FilterSet,
    /// (source_index, name)
    names: Vec<(usize, String)>,
}

fn load_lists(dir: &Path, files: &[&Value], failures: &mut Vec<String>) -> LoadedLists {
    let mut set = FilterSet::new(true);
    let mut names = Vec::new();
    for f in files {
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
        names.push((record.source_index, name));
    }
    LoadedLists { engine_set: set, names }
}

fn blocked(engine: &Engine, url: &str, source: &str, ty: &str) -> Result<bool, String> {
    let req = Request::new(url, source, ty, "").map_err(|e| format!("bad request {url}: {e:?}"))?;
    let r = engine.check_network_request(&req);
    Ok(r.should_block() || r.redirect.is_some())
}

/// Checks the semantics the CI transforms rely on, independent of upstream list contents.
fn selftest(failures: &mut Vec<String>) -> Vec<Value> {
    let mut out = Vec::new();
    let mut check = |name: &str, res: Result<bool, String>, expect: bool| {
        let ok = matches!(res, Ok(v) if v == expect);
        if !ok {
            failures.push(format!("selftest failed: {name} ({res:?})"));
        }
        out.push(json!({ "name": name, "ok": ok }));
    };

    // denyallow expansion: block everything third-party-script on a site except allowed domains.
    let deny = Engine::new_with_list_text(
        "*$script,3p,domain=site.test\n@@||ok.example^$script,3p,domain=site.test\n",
    );
    check("denyallow: other third-party script is blocked on the site",
        blocked(&deny, "https://tracker.example/a.js", "https://site.test/", "script"), true);
    check("denyallow: allowed domain is not blocked",
        blocked(&deny, "https://ok.example/a.js", "https://site.test/", "script"), false);
    check("denyallow: other sites are unaffected",
        blocked(&deny, "https://tracker.example/a.js", "https://other.test/", "script"), false);
    check("denyallow: first-party script is unaffected",
        blocked(&deny, "https://site.test/a.js", "https://site.test/", "script"), false);

    // popup conversion: `$popup` rules become `$document` rules, checked against the new window URL.
    let popup = Engine::new_with_list_text(
        "||pop.example^$document,3p\n@@||pop.example^$document,domain=ok.test\n/ads/pop.$document,subdocument\n",
    );
    check("popup: popup target is blocked",
        blocked(&popup, "https://pop.example/x", "https://news.test/", "document"), true);
    check("popup: exception for an opener site works",
        blocked(&popup, "https://pop.example/x", "https://ok.test/", "document"), false);
    check("popup: unrelated target is allowed",
        blocked(&popup, "https://good.example/x", "https://news.test/", "document"), false);
    out
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

    let network_files: Vec<&Value> =
        files.iter().filter(|f| f["kind"] == "list" && f["role"] != "popup").collect();
    let popup_files: Vec<&Value> =
        files.iter().filter(|f| f["kind"] == "list" && f["role"] == "popup").collect();

    let LoadedLists { engine_set: network_set, names: network_names } =
        load_lists(dir, &network_files, &mut failures);
    let LoadedLists { engine_set: popup_set, names: popup_names } =
        load_lists(dir, &popup_files, &mut failures);

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

    let mut engine = Engine::new_with_filter_set(network_set);
    engine.use_resources(resources);
    let popup_engine = Engine::new_with_filter_set(popup_set);

    // Per-list statistics, with the reason for every rejected line
    let mut supported: HashMap<String, bool> = HashMap::new();
    let mut lists_report = serde_json::Map::new();
    let mut totals: BTreeMap<String, u32> = BTreeMap::new();
    for (eng, names) in [(&engine, &network_names), (&popup_engine, &popup_names)] {
        let info = eng.get_debug_info();
        for (idx, name) in names {
            let Some(s) = info.source_info.get(*idx) else {
                failures.push(format!("{name}: no statistics reported by the engine"));
                continue;
            };
            let mut by_cause: BTreeMap<String, u32> = BTreeMap::new();
            for line in &s.invalid_lines {
                *by_cause.entry(classify(line, &mut supported)).or_default() += 1;
            }
            for (k, v) in &by_cause {
                *totals.entry(k.clone()).or_default() += v;
            }
            lists_report.insert(
                name.clone(),
                json!({
                    "network": s.network_filter_count,
                    "cosmetic": s.cosmetic_filter_count,
                    "parseErrors": s.parse_error,
                    "invalidByCause": by_cause,
                    "invalidLines": s.invalid_lines.iter().take(10).collect::<Vec<_>>(),
                }),
            );
        }
    }

    // Smoke tests against the real lists: (description, url, source, type, expect_blocked)
    let cases: [(&str, &str, &str, &str, bool); 5] = [
        ("doubleclick gpt.js is blocked", "https://securepubads.g.doubleclick.net/tag/js/gpt.js", "https://example.com/", "script", true),
        ("adsbygoogle.js is blocked", "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js", "https://example.com/", "script", true),
        ("google-analytics analytics.js is blocked", "https://www.google-analytics.com/analytics.js", "https://example.com/", "script", true),
        ("example.com document is allowed", "https://example.com/", "https://example.com/", "document", false),
        ("same-site stylesheet is allowed", "https://example.com/style.css", "https://example.com/", "stylesheet", false),
    ];
    let mut smoke = Vec::new();
    for (desc, url, source, ty, expect_blocked) in cases {
        let res = blocked(&engine, url, source, ty);
        let ok = matches!(res, Ok(v) if v == expect_blocked);
        if !ok {
            failures.push(format!("smoke test failed: {desc} ({res:?})"));
        }
        smoke.push(json!({ "name": desc, "ok": ok }));
    }
    smoke.extend(selftest(&mut failures));

    // Scriptlet pipeline check (warning only: depends on upstream rules staying around).
    let yt = engine.url_cosmetic_resources("https://www.youtube.com/watch?v=x");
    if yt.injected_script.is_empty() {
        warnings.push("youtube.com produced no injected scriptlet; check resources and trusted permissions".into());
    }

    let report = json!({
        "lists": lists_report,
        "invalidByCauseTotal": totals,
        "resources": resource_count,
        "smoke": smoke,
        "youtubeInjectedScriptBytes": yt.injected_script.len(),
        "warnings": warnings,
        "failures": failures,
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    if failures.is_empty() { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

/// Request types tried for every host: what a page can send to it.
const BENCH_TYPES: [&str; 6] = ["script", "image", "xmlhttprequest", "ping", "other", "sub_frame"];

/// Loads every network list and the resources of a release, as `validate` does.
fn load_release(dir: &Path) -> Result<(Engine, Vec<(String, Vec<String>)>), String> {
    let manifest = read_json(&dir.join("manifest.json"))?;
    let files = manifest["files"].as_array().cloned().unwrap_or_default();
    let network_files: Vec<&Value> =
        files.iter().filter(|f| f["kind"] == "list" && f["role"] != "popup").collect();

    let mut failures = Vec::new();
    let LoadedLists { engine_set, .. } = load_lists(dir, &network_files, &mut failures);
    if !failures.is_empty() {
        return Err(failures.join("; "));
    }

    let mut resources: Vec<Resource> = Vec::new();
    for f in files.iter().filter(|f| f["kind"] == "resources") {
        let name = f["name"].as_str().unwrap_or_default();
        let text = std::fs::read_to_string(dir.join(name)).map_err(|e| format!("{name}: {e}"))?;
        resources.extend(serde_json::from_str::<Vec<Resource>>(&text).map_err(|e| format!("{name}: {e}"))?);
    }
    let mut engine = Engine::new_with_filter_set(engine_set);
    engine.use_resources(resources);

    // Rule text per list, to say where a matched rule came from.
    let mut texts = Vec::new();
    for f in network_files {
        let name = f["name"].as_str().unwrap_or_default().to_string();
        let text = std::fs::read_to_string(dir.join(&name)).map_err(|e| format!("{name}: {e}"))?;
        texts.push((name, text.lines().map(str::to_string).collect()));
    }
    Ok((engine, texts))
}

fn origin_lists(rule: &str, texts: &[(String, Vec<String>)]) -> Vec<String> {
    texts
        .iter()
        .filter(|(_, lines)| lines.iter().any(|l| l == rule))
        .map(|(n, _)| n.trim_end_matches(".txt").to_string())
        .collect()
}

fn bench(dir: &str, hosts_file: &str, source: &str) -> ExitCode {
    let (engine, texts) = match load_release(Path::new(dir)) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let corpus = match std::fs::read_to_string(hosts_file) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("{hosts_file}: {e}");
            return ExitCode::FAILURE;
        }
    };

    // full      every type a page can send is stopped
    // partial   some types are stopped, others reach the host
    // ping-only only `ping` is stopped (a generic `*$ping` rule), the host itself is not listed
    // none      nothing is stopped
    let (mut full, mut partial, mut ping_only, mut none) = (0u32, 0u32, 0u32, 0u32);
    let mut rows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw in corpus.lines() {
        let item = raw.split('#').next().unwrap_or("").trim();
        if item.is_empty() || !seen.insert(item.to_string()) {
            continue;
        }
        let url = if item.contains("://") { item.to_string() } else { format!("https://{item}/") };

        let mut per_type = serde_json::Map::new();
        let mut stopped_types: Vec<&str> = Vec::new();
        let mut redirected_types: Vec<&str> = Vec::new();
        let mut rule: Option<String> = None;
        let mut exception: Option<String> = None;
        for ty in BENCH_TYPES {
            let Ok(req) = Request::new(&url, source, ty, "") else {
                per_type.insert(ty.into(), json!("bad url"));
                continue;
            };
            let r = engine.check_network_request(&req);
            let v = if r.important || (r.filter.is_some() && r.exception.is_none() && r.redirect.is_none()) {
                "block"
            } else if r.redirect.is_some() {
                "redirect"
            } else if r.exception.is_some() {
                "allowed-by-exception"
            } else {
                "allow"
            };
            per_type.insert(ty.into(), json!(v));
            match v {
                "block" => stopped_types.push(ty),
                "redirect" => {
                    stopped_types.push(ty);
                    redirected_types.push(ty);
                }
                _ => {}
            }
            // Prefer the rule that explains a page-visible type over the generic `$ping` rule.
            if let Some(l) = r.filter.as_ref().and_then(|f| f.raw_line.clone()) {
                if rule.is_none() || ty != "ping" {
                    rule = Some(l);
                }
            }
            if exception.is_none() {
                exception = r.exception.as_ref().and_then(|f| f.raw_line.clone());
            }
        }
        let page_types = BENCH_TYPES.iter().filter(|t| **t != "ping").count();
        let page_stopped = stopped_types.iter().filter(|t| **t != "ping").count();
        let verdict = if page_stopped == page_types {
            full += 1;
            "full"
        } else if page_stopped > 0 {
            partial += 1;
            "partial"
        } else if stopped_types.contains(&"ping") {
            ping_only += 1;
            "ping-only"
        } else {
            none += 1;
            "none"
        };
        let lists = rule.as_deref().map(|l| origin_lists(l, &texts)).unwrap_or_default();
        rows.push(json!({
            "item": item,
            "verdict": verdict,
            "types": per_type,
            "redirectedTypes": redirected_types,
            "rule": rule,
            "exception": exception,
            "lists": lists,
        }));
    }

    let total = rows.len();
    let report = json!({
        "source": source,
        "total": total,
        "full": full,
        "partial": partial,
        "pingOnly": ping_only,
        "none": none,
        "fullPercent": if total == 0 { 0.0 } else { full as f64 * 100.0 / total as f64 },
        "hosts": rows,
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    ExitCode::SUCCESS
}
