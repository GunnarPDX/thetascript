# theta-script

A small scripting language for chart studies and trade-signal scripts,
executed **once per bar**. One language, four conforming runtimes:

| Runtime | Where | Role |
|---|---|---|
| JavaScript | [`js/`](js/) | **Reference implementation** — defines the language, runs in the browser |
| Rust | [`rust/theta-script/`](rust/theta-script/) | Native core for backends |
| Python | [`rust/theta-script-py/`](rust/theta-script-py/) | PyO3 wheel over the Rust core |
| Elixir | [`elixir/theta_script/`](elixir/theta_script/) | Rustler NIF over the Rust core |

The language is defined by two artifacts, and only those two:

- [`spec/SPEC.md`](spec/SPEC.md) — the normative prose specification.
- [`conformance/`](conformance/) — the executable contract: deterministic
  input tapes plus one golden fixture per case. Every runtime must
  reproduce every fixture **bit-exactly** (transcendental math gets a 1e-9
  relative tolerance; see [`conformance/README.md`](conformance/README.md)).

## The language at a glance

```
study("Cross Strategy", overlay=true)
fast = ema(close, 9)
slow = ema(close, 21)
plot(fast, color="#22d3ee")
plot(slow, color="#f59e0b", width=2)
var entries = 0
if crossover(fast, slow)
    entries := entries + 1
strategy.buy(crossover(fast, slow), 10, trailing=2)
strategy.sell(crossunder(fast, slow), 10)
alertcondition(crossover(fast, slow), message="cross up")
```

**Execution model.** A script runs against an ordered array of OHLCV bars
(`{ date, open, high, low, close, volume }`, `date` in ms since epoch) and
produces one result object. The script body executes once per bar, top to
bottom: sources (`close`, `time`, …) read the current bar, plain
assignments recompute each bar, `var` declarations initialize on the first
bar and persist, and indicator builtins advance per-call-site incremental
state. Every top-level variable's history is readable with `x[k]` (`k`
bars back). Execution is deterministic: same script + bars + options ⇒
identical result on any host.

**Safety by construction.** The language is designed to be safe on
untrusted input: no recursion, no unbounded loops, no I/O, no aggregate
data structures. Work per run is bounded by `bars × statements ×
loop-limit`, and the per-bar model evaluates incrementally — a live tick
appends one bar of work, which is what a streaming backend wants.

**Features:**

- **Control flow** — `if`/`else if`/`else`, bounded `for`/`while` loops,
  `switch`, ternaries, indentation-delimited blocks. User-defined
  functions (`f(a, b) => expr` or a block body), top-level and
  non-recursive.
- **Indicator builtins**, instantiated per call site with incremental
  state: moving averages (`sma wma ema wilders dema tema tma hull alma`),
  oscillators and stats (`rsi stoch mfi stdev correlation percentile
  median linreg`), bar-fed indicators (`tr atr obv vwap` with session-day
  reset, `pivothigh pivotlow`), and series utilities (`highest lowest
  change roc offset cum sum valuewhen barssince crossover crossunder
  cross rising falling`). NaN warmup/poisoning semantics are specified
  per builtin ([spec §7](spec/SPEC.md)).
- **Draw functions** — `plot`, `fill`, shape/trade markers
  (`plotbuy`/`plotsell`, …), bar/background coloring, panel values, and
  drawing-object pools (`line.new`, `label.new`, `box.new`).
- **Inputs** — `input.int/float/bool/string/time` declarations surface
  typed, labeled controls to the host; the host passes overrides back and
  values lock on the first bar ([spec §9](spec/SPEC.md)).
- **Strategy engine** — `strategy.buy`/`strategy.sell` with market, limit
  and stop orders, share/cash/percent-of-equity sizing, stop-loss,
  take-profit and trailing exits, and a netted position with realized P&L
  ([spec §11](spec/SPEC.md)).
- **Alerts** — `alertcondition(cond, message=…)` records per-bar alert
  firings for the host.
- **Time model** — all calendar semantics use a configurable IANA session
  timezone (default `America/New_York`) with session open/close bounds;
  `timestamp(…)`, calendar extractors, and "now" scalars derived from the
  latest bar, never the host clock ([spec §8](spec/SPEC.md)).

**Errors are all-or-nothing:** on the first parse/validation/runtime
error the result carries `error` (with a `line <k>:` prefix where known)
and empty outputs — declarations recorded before the error (title,
inputs) are kept so hosts can still render controls
([spec §13](spec/SPEC.md)).

## The result object

Every runtime returns the same shape ([spec §12](spec/SPEC.md)):

```
{
  title, overlay, description,
  plots, fills, shapes, trades, panel,     // per-bar draw output
  barColors, bgColors, lines, labels, boxes,
  inputs,                                  // declared input records
  alerts,                                  // alertcondition firings
  strategy,                                // fills, equity, position, P&L — or null
  error                                    // string | null
}
```

All per-bar arrays have length `n`. On the JSON wire (Python/Elixir
bindings, conformance fixtures) IEEE-754 specials are encoded as
`NaN → null`, `±Infinity → "±Infinity"`, `−0 → 0`.

## Quick start

### JavaScript (reference)

```js
import { runScript } from 'theta-script';

const bars = [{ date: 1767625200000, open: 100, high: 101, low: 99.5, close: 100.6, volume: 12000 } /* … */];
const result = runScript(`
study("Cross", overlay=true)
fast = ema(close, 9)
slow = ema(close, 21)
plot(fast, color="#22d3ee")
plot(slow, color="#f59e0b")
plotbuy(crossover(fast, slow), 10)
plotsell(crossunder(fast, slow), 10)
`, bars, { timezone: 'America/New_York' });
// result.plots / result.trades / result.strategy / result.error …
```

Host options (all optional): `inputs` (override map keyed by input
label), `timezone` (IANA name, or `'local'` for the host zone),
`session` (`{ open: 'HH:MM', close: 'HH:MM' }`, default 09:30/16:00).

### Rust

```rust
use theta_script::{bars_from_json, opts_from_json, run_script};

let bars = bars_from_json(&serde_json::from_str(bars_json)?);
let opts = opts_from_json(&serde_json::from_str(opts_json)?);
let result: serde_json::Value = run_script(source, &bars, opts);
```

### Python

```python
import json, theta_script

result = json.loads(theta_script.run_script_json(
    source,
    json.dumps(bars),
    json.dumps({"timezone": "America/New_York"}),  # optional
))
theta_script.lang_version()  # e.g. "2.4.0"
```

### Elixir

```elixir
{:ok, result} = Jason.decode(ThetaScript.run_json(source, bars_json, opts_json))
ThetaScript.lang_version()  # e.g. "2.4.0"
```

The Python and Elixir bindings speak JSON strings in and wire-encoded
JSON out; both are thin wrappers over the Rust core, so all three native
runtimes share one implementation of the semantics.

## Documentation site

[`docs/`](docs/) is a static site for GitHub Pages: a landing page, a
guided tutorial, the full builtin reference, the tested example scripts,
and the rendered spec and conformance contract. It is generated — never
edited by hand — from the documentation of record (`js/src/docs.js`,
`js/src/examples.js`, `spec/SPEC.md`, `conformance/README.md`):

```sh
cd js && npm run docs:site   # regenerates docs/, commit the output
```

To publish: push to GitHub, then Settings → Pages → Deploy from a
branch → `main` / `docs/`. Regenerate whenever the source docs change
(the drift test in `js/test/docs.test.js` keeps `docs.js` itself honest).

## Running the test suites

```sh
# JavaScript reference + conformance corpus
cd js && npm install && npm test

# Rust core (runs the same corpus)
cd rust && cargo test

# Python binding (uv; or use python -m venv + pip install maturin)
cd rust/theta-script-py && uv venv && uv pip install -e . && .venv/bin/python test_conformance.py

# Elixir binding (builds the NIF via the path dependency)
cd elixir/theta_script && mix deps.get && mix test
```

## Conformance

[`conformance/`](conformance/) is what makes "four runtimes, one
language" enforceable rather than aspirational:

- **`tapes.json`** — named OHLCV bar arrays, the shared inputs. Generated
  using only exact double arithmetic (LCG + triangle waves, no
  transcendentals) so regeneration is bit-identical on any engine; the
  committed JSON is frozen data of record.
- **`expected/<case>.json`** — one golden fixture per case: the script,
  its tape and options, and the full expected result in wire encoding.
  Each fixture records the `lang` version it was generated under, and
  every port asserts its compiled-in version against that field — a
  missed version bump fails loudly.

A port is conforming iff it reproduces every fixture. Comparison happens
in encoded space with exact equality, except values derived from
transcendental functions, which get a 1e-9 relative tolerance (libm
differs across platforms). Details in
[`conformance/README.md`](conformance/README.md).

## Changing the language

The change discipline that keeps four runtimes in lockstep:

1. Implement in the JS reference first (`js/src/`), with docs rows in
   `docs.js` (a drift test enforces coverage of every builtin).
2. Add conformance cases in `js/test/cases.js`, then regenerate:
   `cd js && npm run conformance:update`. Diff `conformance/expected/`
   and prove pre-existing fixtures changed only as intended.
3. Bump `LANG_VERSION` in `js/src/interpreter.js` (and the versions in
   `js/package.json`, `rust/*/Cargo.toml`, `rust/theta-script-py/pyproject.toml`,
   `elixir/theta_script/mix.exs`) on **any** observable behavior change.
4. Port to the Rust core and re-run all four suites — the port runners
   assert their compiled-in version against every fixture's `lang` field,
   so a missed bump fails loudly.
5. Record the change in `spec/SPEC.md` §14.

## License

[MIT](LICENSE).
