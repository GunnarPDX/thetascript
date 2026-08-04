# theta-script

A small scripting language for chart studies and trade-signal scripts,
executed **once per bar** — this package is the JavaScript reference
implementation. It runs in the browser or Node, has no runtime
dependencies, and produces bit-identical results to the language's Rust,
Python and Elixir runtimes (enforced by a shared conformance corpus).

**Docs:** [gunnarpdx.github.io/thetascript](https://gunnarpdx.github.io/thetascript/) ·
**Spec & repo:** [github.com/GunnarPDX/thetascript](https://github.com/GunnarPDX/thetascript)

## Install

```sh
npm install theta-script
```

## Usage

```js
import { runScript } from 'theta-script';

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

## Extra entry points

```js
import { HELP_SECTIONS, GETTING_STARTED } from 'theta-script/docs'; // reference data + tutorial
import { EXAMPLES, DEFAULT_SCRIPT } from 'theta-script/examples';   // tested example scripts
```

## Learn more

- [Tutorial](https://gunnarpdx.github.io/thetascript/learn.html)
- [Language reference](https://gunnarpdx.github.io/thetascript/reference.html)
- [Examples](https://gunnarpdx.github.io/thetascript/examples.html)
- [Specification](https://gunnarpdx.github.io/thetascript/spec.html)

MIT licensed.
