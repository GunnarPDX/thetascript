//! Quick wall-clock benchmark: the two heaviest example scripts over a
//! 10k-bar synthetic tape, for comparison with the JS reference
//! (~228ms / ~112ms at 10k bars). Run with:
//!   cargo run --release --example bench

use theta_script::engine::BarData;
use std::time::Instant;

fn tape(n: usize) -> Vec<BarData> {
    (0..n)
        .map(|i| {
            let c = 100.0 + (i as f64 / 9.0).sin() * 8.0 + i as f64 * 0.001;
            BarData {
                date: 1_767_000_000_000.0 + i as f64 * 60_000.0,
                open: c - 0.4,
                high: c + 1.0,
                low: c - 1.0,
                close: c + 0.4,
                volume: 1000.0,
            }
        })
        .collect()
}

fn main() {
    let corpus = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/expected");
    let fixture: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(corpus.join("integration-auto-trader.json")).unwrap(),
    )
    .unwrap();
    let auto_trader = fixture["script"].as_str().unwrap();

    let bars = tape(10_000);
    let cases = [("YesNo Auto Trader", auto_trader)];
    for (name, script) in cases {
        // warm-up run, then timed
        let _ = theta_script::run_script(
            script,
            &bars,
            theta_script::opts_from_json(&serde_json::Value::Null),
        );
        let t0 = Instant::now();
        let res = theta_script::run_script(
            script,
            &bars,
            theta_script::opts_from_json(&serde_json::Value::Null),
        );
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        assert!(res["error"].is_null(), "{}: {}", name, res["error"]);
        println!("{}: {:.1}ms for 10k bars", name, ms);
    }
}
