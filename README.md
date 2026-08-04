# theta-script

A small, scripting language for chart studies and
trade-signal scripts, executed once per bar. One language, four conforming
runtimes:

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

## Quick start (JS)

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

## Running the test suites

```sh
# JavaScript reference + conformance corpus
cd js && npm install && npm test

# Rust core (runs the same corpus)
cd rust && cargo test

# Python binding
cd rust/theta-script-py && python -m venv .venv && source .venv/bin/activate
pip install maturin && maturin develop --release && python test_conformance.py

# Elixir binding (builds the NIF via the path dependency)
cd elixir/theta_script && mix deps.get && mix test
```

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

No license has been chosen yet.
# thetascript
