# theta-script (Rust core)

Rust implementation of the open-financial-charts scripting language, spec **v2.0.0**.
The normative definition is [`spec/SPEC.md`](../../spec/SPEC.md)
and the executable contract is the conformance corpus at
[`conformance/`](../../conformance/); the JavaScript
interpreter in `js/` remains the reference implementation and the
corpus generator.

## Status

- Full v2 language: per-bar execution, `var`/`:=`, `if`/`for`, user
  functions with per-call-site indicator state, dynamic history, all
  builtins, inputs, draw functions, plot styles, alerts, and the strategy
  engine (netting, stop/target/trailing exits, ledger, summary).
- **Conformance: 68/68 fixtures pass.** Of ~31.7k numeric comparisons,
  everything is bit-identical to the JS reference except ~25 values from the
  transcendental builtins (`log`/`exp`/`pow`), which fall inside the
  corpus's 1e-9 relative tolerance for libm differences.
- Timezone semantics via `chrono-tz` (IANA database), matching the
  reference's DST behavior exactly. JS numeric quirks (`Math.round` ties,
  NaN-poisoning `min`/`max`, number-to-string) live in `src/jsmath.rs`.
- Literal spans (`colorSpan`/`widthSpan`) are recorded in UTF-16 code units
  to match JavaScript string indices byte-for-byte.

```bash
cargo test                      # runs the conformance corpus
CONFORMANCE_DETAIL=1 cargo test --test conformance -- --nocapture
cargo run --release --example bench
```

## API

```rust
let bars = theta_script::bars_from_json(&tape_json);   // [{date, open, high, low, close, volume}]
let opts = theta_script::opts_from_json(&opts_json);   // {inputs?, timezone?, session?}
let result: serde_json::Value = theta_script::run_script(source, &bars, opts);
```

`run_script` returns the full result object in the wire encoding
(NaN → null, ±Infinity → "Infinity"/"-Infinity"): plots, fills, shapes,
trades, panel, barColors, bgColors, inputs, alerts, strategy, error — the
same shape the JS `runScript` produces.

## Bindings

- **Python** — [`../theta-script-py`](../theta-script-py/): PyO3 abi3 wheel
  (Python ≥ 3.9). `maturin develop --release`, then
  `theta_script.run_script_json(source, bars_json, opts_json)`.
  `python test_conformance.py` runs the full corpus through the wheel.
- **Elixir** — [`../theta-script-nif`](../theta-script-nif/) +
  [`elixir/theta_script`](../../elixir/theta_script/): Rustler NIF on a dirty CPU
  scheduler. `ThetaScript.run_json(source, bars_json, opts_json)`;
  `mix test` runs the corpus through the NIF.

Both bindings reproduce the corpus with the same stats as this crate's
native harness (68/68, ~25 tolerance-assisted transcendental values).

## Next steps

- Optionally wasm-bindgen for a single-source browser build.
- **Performance**: the current tree-walking evaluator runs the heaviest
  example ~2x faster than the JS reference (≈122ms vs ≈228ms per 10k bars).
  Headroom: compile the AST to closures, arena-allocate `Val`, intern
  strings. The per-bar model also supports true incremental append for live
  ticks — one bar of work per update — which no host uses yet.
- Keep this crate in lockstep with the corpus: any `LANG_VERSION` bump on
  the JS side means regenerating fixtures and re-running `cargo test` here.
