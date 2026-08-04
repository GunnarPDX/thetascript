// Built-in functions for the v2 (per-bar) scripting engine. Every builtin is
// instantiated once per call site: the evaluator calls BUILTIN_FACTORIES[name]()
// to get a closure and then invokes it once per bar as (ctx, args). Stateful
// indicators keep their window state inside the closure; ctx carries the bar,
// bar index, session timezone and per-bar day key.
//
// Window lengths are locked at the first call — an indicator whose length
// changes between bars has no coherent meaning, so it errors.

import {
  smaStream, wmaStream, emaStream, wildersStream, rsiStream,
  stdevStream, sumStream, highestStream, lowestStream, highestBarsStream,
  lowestBarsStream, changeStream, offsetStream, crossoverStream,
  crossunderStream, trStream, demaStream, temaStream, tmaStream, hullStream,
  rocStream, risingStream, stochStream, pivotStream, mfiStream, obvStream,
  vwapStream, linregStream, dmiStream, aroonStream, sarStream,
  supertrendStream, cciStream, willrStream, correlationStream,
  percentileStream, almaStream,
} from './streams.js';
import { parseTimestamp, wallDate, epochFromWall } from './time.js';

const truthy = (v) => !!v && !Number.isNaN(v);

// str.* coercion: strings pass, numbers use the JS rendering, arrays render
// "[array]" (same as tostring and the + operator), anything else ''
const jsStr = (v) => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (isScriptArray(v)) return '[array]';
  return '';
};

// v1-compatible length validation (message text is load-bearing for the
// error-case fixtures)
const MAX_PERIOD = 100000;

const num = (v, name) => {
  if (typeof v !== 'number' || !isFinite(v)) throw new Error(`${name}: expected a number`);
  const p = Math.max(1, Math.round(v));
  // bounded work per bar: an absurd period would eagerly allocate huge
  // windows/weight tables — an untrusted script must not be able to
  if (p > MAX_PERIOD) throw new Error(`${name}: period too large (max ${MAX_PERIOD})`);
  return p;
};

// variadic numeric args: at least one, non-numbers read as NaN (strings
// would otherwise compare lexicographically / concatenate)
const variadic = (args, name) => {
  if (!args.length) throw new Error(`${name}: expected at least one argument`);
  return args.map(v => (typeof v === 'number' ? v : NaN));
};

// indicator over (series, length) with the length locked at first call
const windowed = (mk, name, dfltLen) => () => {
  let stream = null, p0 = null;
  return (ctx, args) => {
    const raw = args.length > 1 ? args[1] : dfltLen;
    const p = num(raw, name);
    if (stream == null) { p0 = p; stream = mk(p); }
    else if (p !== p0) throw new Error(`${name}: length must not change between bars`);
    // strings would silently concatenate inside the accumulators
    const v = args[0];
    return stream(typeof v === 'number' ? v : NaN);
  };
};

// stateless per-bar function
const stateless = (fn) => () => fn;

const math1 = (f) => stateless((ctx, args) => f(args[0]));

// ---- arrays --------------------------------------------------------------
// Script arrays are mutable reference values: `var a = array.new()` persists
// one array across bars; without var a fresh array is created every bar.
// Elements are any scalar value; the numeric aggregates skip non-numbers/na.

export const isScriptArray = (v) => !!v && typeof v === 'object' && '__arr' in v;

const MAX_ARRAY = 100000; // elements; same bound as MAX_PERIOD

const arrOf = (v, name) => {
  if (!isScriptArray(v)) throw new Error(`${name}: expected an array`);
  return v.__arr;
};

const numsOf = (arr) => arr.filter(v => typeof v === 'number' && !Number.isNaN(v));

const aggregate = (name, f) => stateless((ctx, args) => {
  const nums = numsOf(arrOf(args[0], name));
  return nums.length ? f(nums) : NaN;
});

const ARRAY_FACTORIES = {
  'array.new': stateless((ctx, args) => {
    const size = typeof args[0] === 'number' && isFinite(args[0])
      ? Math.max(0, Math.round(args[0])) : 0;
    // hard cap: an unbounded size is a host OOM, which no try/catch survives
    if (size > MAX_ARRAY) throw new Error(`array.new: size too large (max ${MAX_ARRAY})`);
    const initial = args.length > 1 ? args[1] : NaN;
    return { __arr: new Array(size).fill(initial) };
  }),
  'array.push': stateless((ctx, args) => {
    const a = arrOf(args[0], 'array.push');
    if (a.length >= MAX_ARRAY) throw new Error(`array.push: array too large (max ${MAX_ARRAY})`);
    a.push(args.length > 1 ? args[1] : NaN);
    return 0;
  }),
  'array.pop': stateless((ctx, args) => {
    const arr = arrOf(args[0], 'array.pop');
    return arr.length ? arr.pop() : NaN;
  }),
  'array.shift': stateless((ctx, args) => {
    const arr = arrOf(args[0], 'array.shift');
    return arr.length ? arr.shift() : NaN;
  }),
  'array.unshift': stateless((ctx, args) => {
    const a = arrOf(args[0], 'array.unshift');
    if (a.length >= MAX_ARRAY) throw new Error(`array.unshift: array too large (max ${MAX_ARRAY})`);
    a.unshift(args.length > 1 ? args[1] : NaN);
    return 0;
  }),
  'array.get': stateless((ctx, args) => {
    const arr = arrOf(args[0], 'array.get');
    const i = typeof args[1] === 'number' ? Math.round(args[1]) : NaN;
    // out-of-range reads are na, like history access
    return i >= 0 && i < arr.length ? arr[i] : NaN;
  }),
  'array.set': stateless((ctx, args) => {
    const arr = arrOf(args[0], 'array.set');
    const i = typeof args[1] === 'number' ? Math.round(args[1]) : NaN;
    if (!(i >= 0 && i < arr.length)) throw new Error(`array.set: index ${i} out of range (size ${arr.length})`);
    arr[i] = args.length > 2 ? args[2] : NaN;
    return 0;
  }),
  'array.size': stateless((ctx, args) => arrOf(args[0], 'array.size').length),
  'array.first': stateless((ctx, args) => {
    const arr = arrOf(args[0], 'array.first');
    return arr.length ? arr[0] : NaN;
  }),
  'array.last': stateless((ctx, args) => {
    const arr = arrOf(args[0], 'array.last');
    return arr.length ? arr[arr.length - 1] : NaN;
  }),
  'array.clear': stateless((ctx, args) => {
    arrOf(args[0], 'array.clear').length = 0;
    return 0;
  }),
  'array.sum': aggregate('array.sum', (nums) => nums.reduce((a, b) => a + b, 0)),
  'array.avg': aggregate('array.avg', (nums) => nums.reduce((a, b) => a + b, 0) / nums.length),
  'array.min': aggregate('array.min', (nums) => nums.reduce((a, b) => (b < a ? b : a))),
  'array.max': aggregate('array.max', (nums) => nums.reduce((a, b) => (b > a ? b : a))),
};

export const BUILTIN_FACTORIES = {
  sma: windowed(smaStream, 'sma'),
  ema: windowed(emaStream, 'ema'),
  wma: windowed(wmaStream, 'wma'),
  rsi: windowed(rsiStream, 'rsi'),
  stdev: windowed(stdevStream, 'stdev'),
  sum: windowed(sumStream, 'sum'),
  highest: windowed(highestStream, 'highest'),
  lowest: windowed(lowestStream, 'lowest'),
  change: windowed(changeStream, 'change', 1),
  mom: windowed(changeStream, 'mom', 1),
  offset: windowed(offsetStream, 'offset'),
  wilders: windowed(wildersStream, 'wilders'),
  dema: windowed(demaStream, 'dema'),
  tema: windowed(temaStream, 'tema'),
  tma: windowed(tmaStream, 'tma'),
  hull: windowed(hullStream, 'hull'),
  roc: windowed(rocStream, 'roc'),
  linreg: windowed(linregStream, 'linreg'),
  rising: windowed((p) => risingStream(p, 1), 'rising'),
  falling: windowed((p) => risingStream(p, -1), 'falling'),
  highestbars: windowed(highestBarsStream, 'highestbars'),
  lowestbars: windowed(lowestBarsStream, 'lowestbars'),

  crossover: () => {
    const s = crossoverStream();
    return (ctx, args) => s(args[0], args[1]);
  },
  crossunder: () => {
    const s = crossunderStream();
    return (ctx, args) => s(args[0], args[1]);
  },
  cross: () => {
    const over = crossoverStream(), under = crossunderStream();
    return (ctx, args) => {
      // both streams must advance every bar — || would skip under's state
      // update whenever over fires
      const o = over(args[0], args[1]);
      const u = under(args[0], args[1]);
      return o || u ? 1 : 0;
    };
  },

  // bar-fed indicators read OHLCV from ctx.bar directly
  tr: () => {
    const s = trStream();
    return (ctx) => s(ctx.bar.high, ctx.bar.low, ctx.bar.close);
  },
  atr: () => {
    const tr = trStream();
    let w = null, p0 = null;
    return (ctx, args) => {
      const p = num(args[0], 'atr');
      if (w == null) { p0 = p; w = wildersStream(p); }
      else if (p !== p0) throw new Error('atr: length must not change between bars');
      return w(tr(ctx.bar.high, ctx.bar.low, ctx.bar.close));
    };
  },
  stoch: () => {
    let s = null, p0 = null;
    return (ctx, args) => {
      const p = num(args[0], 'stoch');
      if (s == null) { p0 = p; s = stochStream(p); }
      else if (p !== p0) throw new Error('stoch: length must not change between bars');
      return s(ctx.bar.close, ctx.bar.high, ctx.bar.low);
    };
  },
  mfi: () => {
    let s = null, p0 = null;
    return (ctx, args) => {
      const p = num(args[0], 'mfi');
      if (s == null) { p0 = p; s = mfiStream(p); }
      else if (p !== p0) throw new Error('mfi: length must not change between bars');
      return s(ctx.bar.high, ctx.bar.low, ctx.bar.close, ctx.bar.volume || 0);
    };
  },
  obv: () => {
    const s = obvStream();
    return (ctx) => s(ctx.bar.close, ctx.bar.volume || 0);
  },
  // vwap([src], [anchor]) — cumulative price*volume over volume, reset when
  // the anchor period rolls over in the session timezone: "session" (default,
  // calendar day), "week" (Monday start) or "month"
  vwap: () => {
    const s = vwapStream();
    let locked = null;
    return (ctx, args) => {
      // vwap() / vwap(src) / vwap(src, anchor) / vwap("week") — a string
      // first arg is the anchor with the default hlc3 source, so the natural
      // spelling of "weekly vwap" works. The anchor locks at first call like
      // every other stream parameter
      const anchorArg = typeof args[0] === 'string' ? args[0]
        : typeof args[1] === 'string' ? args[1] : 'session';
      if (locked == null) locked = anchorArg;
      else if (anchorArg !== locked) throw new Error('vwap: anchor must not change between bars');
      const price = args.length && typeof args[0] !== 'string'
        ? (typeof args[0] === 'number' ? args[0] : NaN)
        : (ctx.bar.high + ctx.bar.low + ctx.bar.close) / 3;
      return s(price, ctx.bar.volume || 0, ctx.anchorKey(locked));
    };
  },
  pivothigh: () => {
    let s = null, k0 = null;
    return (ctx, args) => {
      const l = num(args[0], 'pivothigh'), r = num(args[1], 'pivothigh');
      const key = `${l}:${r}`;
      if (s == null) { k0 = key; s = pivotStream(l, r, true); }
      else if (key !== k0) throw new Error('pivothigh: lengths must not change between bars');
      return s(ctx.bar.high);
    };
  },
  pivotlow: () => {
    let s = null, k0 = null;
    return (ctx, args) => {
      const l = num(args[0], 'pivotlow'), r = num(args[1], 'pivotlow');
      const key = `${l}:${r}`;
      if (s == null) { k0 = key; s = pivotStream(l, r, false); }
      else if (key !== k0) throw new Error('pivotlow: lengths must not change between bars');
      return s(ctx.bar.low);
    };
  },

  cum: () => {
    let acc = 0;
    return (ctx, args) => {
      const v = args[0];
      // non-numbers count as 0 like na — a string would corrupt acc into text
      acc += typeof v === 'number' && !Number.isNaN(v) ? v : 0;
      return acc;
    };
  },
  valuewhen: () => {
    let last = NaN;
    return (ctx, args) => {
      if (truthy(args[0])) last = args[1];
      return last;
    };
  },
  barssince: () => {
    let last = -1;
    return (ctx, args) => {
      if (truthy(args[0])) last = ctx.i;
      return last < 0 ? NaN : ctx.i - last;
    };
  },

  nz: stateless((ctx, args) => {
    const v = args[0], r = args.length > 1 ? args[1] : 0;
    return Number.isNaN(v) ? r : v;
  }),
  na: stateless((ctx, args) => (Number.isNaN(args[0]) ? 1 : 0)),
  abs: math1(Math.abs),
  sqrt: math1(Math.sqrt),
  log: math1(Math.log),
  exp: math1(Math.exp),
  round: math1(Math.round),
  floor: math1(Math.floor),
  ceil: math1(Math.ceil),
  sign: math1(Math.sign),
  pow: stateless((ctx, args) => Math.pow(args[0], args[1])),
  min: stateless((ctx, args) => variadic(args, 'min').reduce((a, b) => Math.min(a, b))),
  max: stateless((ctx, args) => variadic(args, 'max').reduce((a, b) => Math.max(a, b))),
  avg: stateless((ctx, args) => variadic(args, 'avg').reduce((a, b) => a + b) / args.length),
  iff: stateless((ctx, args) => {
    const v = truthy(args[0]) ? args[1] : args[2];
    return v === undefined ? NaN : v; // a missing branch reads na
  }),

  // number -> string; precision clamps to 0..8 like infopanel
  tostring: stateless((ctx, args) => {
    const v = args[0];
    if (typeof v === 'string') return v;
    if (isScriptArray(v)) return '[array]';
    if (typeof v !== 'number') return String(v);
    if (Number.isNaN(v)) return 'NaN';
    if (typeof args[1] === 'number' && isFinite(args[1])) {
      const prec = Math.max(0, Math.min(8, Math.round(args[1])));
      return v.toFixed(prec);
    }
    return String(v);
  }),

  // ---- date/time ---------------------------------------------------------
  // timestamps are ms since epoch, so the ordinary comparison operators work
  // on them. Both timestamp() forms read wall time in the session timezone
  timestamp: stateless((ctx, args) => {
    const [a, m = 1, d = 1, h = 0, mi = 0] = args;
    if (typeof a === 'string') return parseTimestamp(a, ctx.tz);
    if (typeof a === 'number' && isFinite(a)) return epochFromWall(a, m, d, h, mi, ctx.tz);
    return NaN;
  }),
  year: stateless((ctx, args) => (Number.isNaN(args[0]) ? NaN : wallDate(args[0], ctx.tz).getUTCFullYear())),
  month: stateless((ctx, args) => (Number.isNaN(args[0]) ? NaN : wallDate(args[0], ctx.tz).getUTCMonth() + 1)),
  dayofmonth: stateless((ctx, args) => (Number.isNaN(args[0]) ? NaN : wallDate(args[0], ctx.tz).getUTCDate())),
  dayofweek: stateless((ctx, args) => (Number.isNaN(args[0]) ? NaN : wallDate(args[0], ctx.tz).getUTCDay())),
  hour: stateless((ctx, args) => (Number.isNaN(args[0]) ? NaN : wallDate(args[0], ctx.tz).getUTCHours())),
  minute: stateless((ctx, args) => (Number.isNaN(args[0]) ? NaN : wallDate(args[0], ctx.tz).getUTCMinutes())),

  // ---- round-2 indicators ------------------------------------------------
  adx: dmiPart('adx'),
  diplus: dmiPart('plus'),
  diminus: dmiPart('minus'),
  aroonup: aroonPart(true),
  aroondown: aroonPart(false),
  sar: () => {
    let s = null, key0 = null;
    return (ctx, args) => {
      const start = typeof args[0] === 'number' && isFinite(args[0]) ? args[0] : 0.02;
      const inc = typeof args[1] === 'number' && isFinite(args[1]) ? args[1] : 0.02;
      const max = typeof args[2] === 'number' && isFinite(args[2]) ? args[2] : 0.2;
      const key = `${start}:${inc}:${max}`;
      if (s == null) { key0 = key; s = sarStream(start, inc, max); }
      else if (key !== key0) throw new Error('sar: parameters must not change between bars');
      return s(ctx.bar.high, ctx.bar.low, ctx.bar.close);
    };
  },
  supertrend: supertrendPart('line'),
  supertrend_dir: supertrendPart('dir'),
  cci: () => {
    let s = null, p0 = null;
    return (ctx, args) => {
      const p = num(args[0], 'cci');
      if (s == null) { p0 = p; s = cciStream(p); }
      else if (p !== p0) throw new Error('cci: length must not change between bars');
      return s(ctx.bar.high, ctx.bar.low, ctx.bar.close);
    };
  },
  willr: () => {
    let s = null, p0 = null;
    return (ctx, args) => {
      const p = num(args[0], 'willr');
      if (s == null) { p0 = p; s = willrStream(p); }
      else if (p !== p0) throw new Error('willr: length must not change between bars');
      return s(ctx.bar.high, ctx.bar.low, ctx.bar.close);
    };
  },
  correlation: () => {
    let s = null, p0 = null;
    return (ctx, args) => {
      const p = num(args[2], 'correlation');
      if (s == null) { p0 = p; s = correlationStream(p); }
      else if (p !== p0) throw new Error('correlation: length must not change between bars');
      const numv = (v) => (typeof v === 'number' ? v : NaN);
      return s(numv(args[0]), numv(args[1]));
    };
  },
  percentile: () => {
    let s = null, key0 = null;
    return (ctx, args) => {
      const p = num(args[1], 'percentile');
      // clamp: an out-of-range rank would index past the sorted window and
      // leak literal undefined into the engine
      const q = typeof args[2] === 'number' && isFinite(args[2])
        ? Math.max(0, Math.min(100, args[2])) : 50;
      const key = `${p}:${q}`;
      if (s == null) { key0 = key; s = percentileStream(p, q); }
      else if (key !== key0) throw new Error('percentile: parameters must not change between bars');
      return s(typeof args[0] === 'number' ? args[0] : NaN);
    };
  },
  median: () => {
    let s = null, p0 = null;
    return (ctx, args) => {
      const p = num(args[1], 'median');
      if (s == null) { p0 = p; s = percentileStream(p, 50); }
      else if (p !== p0) throw new Error('median: length must not change between bars');
      return s(typeof args[0] === 'number' ? args[0] : NaN);
    };
  },
  alma: () => {
    let s = null, key0 = null;
    return (ctx, args) => {
      const p = num(args[1], 'alma');
      const offset = typeof args[2] === 'number' && isFinite(args[2]) ? args[2] : 0.85;
      const sigma = typeof args[3] === 'number' && isFinite(args[3]) && args[3] > 0 ? args[3] : 6;
      const key = `${p}:${offset}:${sigma}`;
      if (s == null) { key0 = key; s = almaStream(p, offset, sigma); }
      else if (key !== key0) throw new Error('alma: parameters must not change between bars');
      return s(typeof args[0] === 'number' ? args[0] : NaN);
    };
  },

  // ---- trig / general math ----------------------------------------------
  sin: math1(Math.sin),
  cos: math1(Math.cos),
  tan: math1(Math.tan),
  asin: math1(Math.asin),
  acos: math1(Math.acos),
  atan: math1(Math.atan),
  atan2: stateless((ctx, args) => Math.atan2(
    typeof args[0] === 'number' ? args[0] : NaN,
    typeof args[1] === 'number' ? args[1] : NaN)),

  // ---- strings -----------------------------------------------------------
  'str.format': stateless((ctx, args) => {
    const fmt = jsStr(args[0]);
    return fmt.replace(/\{(\d+)\}/g, (m, k) => {
      const idx = +k + 1;
      return idx < args.length ? jsStr(args[idx]) : '';
    });
  }),
  'str.contains': stateless((ctx, args) => (jsStr(args[0]).includes(jsStr(args[1])) ? 1 : 0)),
  'str.replace': stateless((ctx, args) => {
    const from = jsStr(args[1]);
    if (from === '') return jsStr(args[0]);
    return jsStr(args[0]).split(from).join(jsStr(args[2]));
  }),
  'str.upper': stateless((ctx, args) => jsStr(args[0]).toUpperCase()),
  'str.lower': stateless((ctx, args) => jsStr(args[0]).toLowerCase()),
  'str.length': stateless((ctx, args) => jsStr(args[0]).length),
  'str.split': stateless((ctx, args) => {
    const str = jsStr(args[0]);
    const sep = jsStr(args[1]);
    // an empty separator yields the whole string (JS char-splitting differs
    // across runtimes for astral chars — spec'd out)
    return { __arr: sep === '' ? [str] : str.split(sep) };
  }),

  ...ARRAY_FACTORIES,
};

// Wilder's directional system: adx/diplus/diminus share the stream shape but
// each call site owns its own state
function dmiPart(field) {
  return () => {
    let s = null, p0 = null;
    return (ctx, args) => {
      const fname = field === 'adx' ? 'adx' : field === 'plus' ? 'diplus' : 'diminus';
      const p = num(args[0], fname);
      if (s == null) { p0 = p; s = dmiStream(p); }
      else if (p !== p0) throw new Error(`${fname}: length must not change between bars`);
      return s(ctx.bar.high, ctx.bar.low, ctx.bar.close)[field];
    };
  };
}

function supertrendPart(field) {
  return () => {
    let s = null, key0 = null;
    return (ctx, args) => {
      const name = field === 'line' ? 'supertrend' : 'supertrend_dir';
      const p = num(args[0], name);
      const mult = typeof args[1] === 'number' && isFinite(args[1]) ? args[1] : 3;
      const key = `${p}:${mult}`;
      if (s == null) { key0 = key; s = supertrendStream(p, mult); }
      else if (key !== key0) throw new Error(`${name}: parameters must not change between bars`);
      return s(ctx.bar.high, ctx.bar.low, ctx.bar.close)[field];
    };
  };
}

function aroonPart(up) {
  return () => {
    let s = null, p0 = null;
    return (ctx, args) => {
      const fname = up ? 'aroonup' : 'aroondown';
      const p = num(args[0], fname);
      if (s == null) { p0 = p; s = aroonStream(p, up); }
      else if (p !== p0) throw new Error(`${fname}: length must not change between bars`);
      return s(up ? ctx.bar.high : ctx.bar.low);
    };
  };
}

export const BUILTIN_NAMES = Object.keys(BUILTIN_FACTORIES);

// ---- sources -------------------------------------------------------------

// per-bar series sources, kept as full arrays: the evaluator reads arr[i] and
// serves history (`close[2]`) straight off them
export const makeSourceArrays = (bars) => {
  const src = {
    open: bars.map(b => b.open),
    high: bars.map(b => b.high),
    low: bars.map(b => b.low),
    close: bars.map(b => b.close),
    volume: bars.map(b => b.volume || 0),
    bar_index: bars.map((_, i) => i),
    time: bars.map(b => +b.date),
  };
  src.hl2 = bars.map(b => (b.high + b.low) / 2);
  src.hlc3 = bars.map(b => (b.high + b.low + b.close) / 3);
  src.ohlc4 = bars.map(b => (b.open + b.high + b.low + b.close) / 4);
  return src;
};

// "HH:MM" -> minutes past midnight, or dflt when absent/malformed
const sessionMinutes = (s, dflt) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  return m ? +m[1] * 60 + +m[2] : dflt;
};

// "now" scalars anchored to the latest bar (deterministic across reruns):
// date_today is session-timezone midnight of the latest bar's day,
// market_open/market_close are the session bounds on that day.
// session: { open: 'HH:MM', close: 'HH:MM' }, default the US equities session
export const makeNowScalars = (bars, tz, session) => {
  const cur = bars.length ? +bars[bars.length - 1].date : NaN;
  const out = { pi: Math.PI, current_datetime: cur, date_today: NaN, market_open: NaN, market_close: NaN };
  if (!Number.isNaN(cur)) {
    const w = wallDate(cur, tz);
    const y = w.getUTCFullYear(), mo = w.getUTCMonth() + 1, d = w.getUTCDate();
    const openM = sessionMinutes(session && session.open, 570);
    const closeM = sessionMinutes(session && session.close, 960);
    out.date_today = epochFromWall(y, mo, d, 0, 0, tz);
    out.market_open = epochFromWall(y, mo, d, Math.floor(openM / 60), openM % 60, tz);
    out.market_close = epochFromWall(y, mo, d, Math.floor(closeM / 60), closeM % 60, tz);
  }
  return out;
};

// engine-maintained scalar sources beyond the arrays: refreshed per bar
export const DYNAMIC_SOURCE_NAMES = [
  'barstate.isfirst', 'barstate.islast',
  'strategy.position_size', 'strategy.avg_price', 'strategy.open_pnl',
  'strategy.realized_pnl', 'strategy.equity', 'strategy.trades',
  'strategy.wins', 'strategy.losses',
];

// source-variable names, for tooling (syntax highlighter, docs drift test)
export const SOURCE_NAMES = [
  ...Object.keys(makeSourceArrays([])),
  ...Object.keys(makeNowScalars([])),
  ...DYNAMIC_SOURCE_NAMES,
];
