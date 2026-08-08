# theta-script

A small scripting language for chart studies and trade-signal scripts,
executed **once per bar**. As of v3 this package ships the language's
**Rust core compiled to WebAssembly** — the same engine behind the
Python and Elixir runtimes, so results are bit-identical everywhere
(enforced by a shared conformance corpus). Runs in the browser or Node.

**Docs:** [gunnarpdx.github.io/thetascript](https://gunnarpdx.github.io/thetascript/) ·
**Spec & repo:** [github.com/GunnarPDX/thetascript](https://github.com/GunnarPDX/thetascript)

## Install

```sh
npm install theta-script
```

## Usage

```js
import { init, runScript } from 'theta-script';

// Once, at app startup: fetches and compiles the wasm engine (~340 KB
// gzipped over the wire, cached by the browser after the first load).
await init();

// After that, runScript is synchronous — same call shape as ever:
const bars = [
  { date: 1767625200000, open: 100, high: 101, low: 99.5, close: 100.6, volume: 12000 },
  // …one object per bar, oldest first; date is ms since the Unix epoch
];

const result = runScript(`
study("Cross", overlay=true)
fast = ema(close, 9)
slow = ema(close, 21)
plot(fast, color="#22d3ee")
plot(slow, color="#f59e0b")
plotbuy(crossover(fast, slow), 10)
plotsell(crossunder(fast, slow), 10)
`, bars, { timezone: 'America/New_York' });

// result.plots / result.trades / result.strategy / result.inputs / result.error …
```

Host options (all optional): `inputs` (override map keyed by input label),
`timezone` (IANA name, or `'local'` for the host zone), `session`
(`{ open: 'HH:MM', close: 'HH:MM' }`, default 09:30/16:00). Execution is
deterministic: same script + bars + options ⇒ identical result anywhere.

The language is safe on untrusted input by construction — no recursion, no
unbounded loops, no I/O — with bounded work per run, so it's suitable for
running user-authored scripts.

`init()` with no argument resolves the `.wasm` asset relative to the
module (bundlers handle this); pass a URL, `Response`, bytes, or a
compiled `WebAssembly.Module` to override. In Node (or anywhere you have
the bytes already), `initSync(bytes)` is also available.

## Migrating from v2

- **Call `await init()` once before the first `runScript`.** Everything
  after that is synchronous, as before. `runScript` throws a clear error
  if the engine isn't loaded yet.
- **Results are now in the JSON wire encoding** used by every other
  runtime and the conformance fixtures: `NaN → null`,
  `±Infinity → "Infinity"/"-Infinity"`, `−0 → 0`. v2 returned raw `NaN`
  values in series; if your chart code checked `Number.isNaN(v)`, check
  `v === null` (or `v == null`) instead.
- The pure-JS v2 interpreter remains importable as **`theta-script/js`**
  (same sync `runScript`, raw `NaN` results) if you need the old
  behavior during migration.

## Extra entry points

```js
import { HELP_SECTIONS, GETTING_STARTED } from 'theta-script/docs'; // reference data + tutorial
import { EXAMPLES, DEFAULT_SCRIPT } from 'theta-script/examples';   // tested example scripts
import { runScript } from 'theta-script/js';                        // pure-JS v2 interpreter
```

## Learn more

- [Tutorial](https://gunnarpdx.github.io/thetascript/learn.html)
- [Language reference](https://gunnarpdx.github.io/thetascript/reference.html)
- [Examples](https://gunnarpdx.github.io/thetascript/examples.html)
- [Specification](https://gunnarpdx.github.io/thetascript/spec.html)

MIT licensed.
