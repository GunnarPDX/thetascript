//! Runs the shared conformance corpus (conformance/) against the
//! Rust core. Comparison happens in the wire-encoded space per the corpus
//! README: numbers must match exactly, with a 1e-9 relative tolerance
//! allowed (transcendental-derived values); err-* fixtures must error with
//! matching collections, message text ignored.

use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
}

struct Stats {
    numbers: usize,
    tolerated: usize,
}

fn num_close(a: f64, b: f64, stats: &mut Stats) -> bool {
    stats.numbers += 1;
    if a == b {
        return true;
    }
    let tol = 1e-9 * a.abs().max(b.abs());
    if (a - b).abs() <= tol {
        stats.tolerated += 1;
        return true;
    }
    false
}

fn compare(got: &Value, want: &Value, path: &str, stats: &mut Stats, diffs: &mut Vec<String>) {
    if diffs.len() > 5 {
        return; // enough detail per fixture
    }
    match (got, want) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            if !num_close(a, b, stats) {
                diffs.push(format!("{}: got {} want {}", path, a, b));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                diffs.push(format!("{}: array len {} vs {}", path, a.len(), b.len()));
                return;
            }
            for (k, (x, y)) in a.iter().zip(b).enumerate() {
                compare(x, y, &format!("{}[{}]", path, k), stats, diffs);
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            for (k, y) in b {
                match a.get(k) {
                    Some(x) => compare(x, y, &format!("{}.{}", path, k), stats, diffs),
                    None => diffs.push(format!("{}.{}: missing in result", path, k)),
                }
            }
            for k in a.keys() {
                if !b.contains_key(k) {
                    diffs.push(format!("{}.{}: unexpected key in result", path, k));
                }
            }
        }
        _ => {
            if got != want {
                diffs.push(format!("{}: got {} want {}", path, got, want));
            }
        }
    }
}

#[test]
fn conformance_corpus() {
    let dir = corpus_dir();
    let tapes: Value =
        serde_json::from_str(&fs::read_to_string(dir.join("tapes.json")).expect("tapes.json"))
            .unwrap();
    let mut files: Vec<PathBuf> = fs::read_dir(dir.join("expected"))
        .expect("expected/")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no fixtures found");

    let mut stats = Stats {
        numbers: 0,
        tolerated: 0,
    };
    let mut failures: Vec<String> = Vec::new();
    let mut passed = 0usize;

    for file in &files {
        let fixture: Value = serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap();
        let name = fixture["name"].as_str().unwrap().to_string();
        // every fixture must target the language version this crate implements
        assert_eq!(
            fixture["lang"].as_str(),
            Some(theta_script::LANG_VERSION),
            "{}: fixture lang {:?} != crate LANG_VERSION {}",
            name,
            fixture["lang"],
            theta_script::LANG_VERSION
        );
        let tape = fixture["tape"].as_str().unwrap();
        let bars = theta_script::bars_from_json(&tapes[tape]);
        let opts = theta_script::opts_from_json(&fixture["opts"]);
        let script = fixture["script"].as_str().unwrap();

        let mut got = theta_script::run_script(script, &bars, opts);
        let mut want = fixture["expected"].clone();

        let is_err = name.starts_with("err-");
        if is_err {
            if !got["error"].is_string() {
                failures.push(format!("{}: expected an error, got error=null", name));
                continue;
            }
            // message text is informative — mask it before the tree compare
            got["error"] = Value::Null;
            want["error"] = Value::Null;
        }

        let before = stats.tolerated;
        let mut diffs = Vec::new();
        compare(&got, &want, &name, &mut stats, &mut diffs);
        if diffs.is_empty() {
            passed += 1;
        } else {
            failures.push(diffs.join("\n"));
        }
        // CONFORMANCE_DETAIL=1 lists fixtures that needed tolerance at all
        if std::env::var("CONFORMANCE_DETAIL").is_ok() && stats.tolerated > before {
            println!(
                "  {}: {} values within tolerance",
                name,
                stats.tolerated - before
            );
        }
    }

    println!(
        "conformance: {}/{} fixtures passed; {} numbers compared, {} within tolerance (rest exact)",
        passed,
        files.len(),
        stats.numbers,
        stats.tolerated
    );
    assert!(
        failures.is_empty(),
        "conformance failures:\n{}",
        failures.join("\n---\n")
    );
}
