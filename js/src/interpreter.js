// Per-bar evaluator for the scripting language (v2 execution model). The
// script body runs once per bar, top to bottom: variables hold per-bar
// values, `var` declarations persist across bars, `x[k]` reads history, and
// indicator builtins keep incremental per-call-site state (./streams.js).
//
//   study("MACD Cross", overlay=true)
//   fast = ema(close, 12)
//   slow = ema(close, 26)
//   plot(fast, color="#22d3ee", title="Fast")
//   if crossover(fast, slow) — statements; expressions stay eager
//       ...
//
// Compatibility contract: for scripts using only v1 features, this engine
// produces byte-identical output to the v1 whole-series evaluator — the
// conformance corpus (conformance/) enforces it.

import { parse, validate } from './parse.js';
import {
  BUILTIN_FACTORIES, makeSourceArrays, makeNowScalars, DYNAMIC_SOURCE_NAMES,
  isScriptArray,
} from './builtins.js';
import { resolveTimezone, parseTimestamp, wallDate } from './time.js';
import { StrategyEngine } from './strategy.js';

export { LANG_VERSION, DRAW_FN_NAMES, KEYWORD_NAMES } from './names.js';

const PLOT_COLORS = ['#22d3ee', '#f59e0b', '#a78bfa', '#22c55e', '#ec4899', '#38bdf8'];
const PLOT_STYLES = new Set(['line', 'histogram', 'area', 'stepline', 'circles']);
const LINE_STYLES = new Set(['solid', 'dashed', 'dotted']);
const LOOP_LIMIT = 100000; // loop iterations per bar, across all for/while loops

const truthy = (v) => !!v && !Number.isNaN(v);

const EMPTY_KW = Object.freeze(Object.create(null));

// string-context rendering for `+` concatenation: arrays read "[array]"
// (matching tostring and str.*), never JS's "[object Object]"
const concatOperand = (v) => (typeof v === 'object' && v !== null && '__arr' in v ? '[array]' : v);

const BIN_OPS = {
  '+': (x, y) => {
    if (typeof x === 'string' || typeof y === 'string') return concatOperand(x) + concatOperand(y);
    // numeric +: non-numbers read as NaN (§4), matching what JS coercion
    // already does for them under - * / — plus is the one op where JS would
    // instead produce "[object Object]" concatenation
    return typeof x === 'number' && typeof y === 'number' ? x + y : NaN;
  },
  '-': (x, y) => x - y,
  '*': (x, y) => x * y, '/': (x, y) => x / y, '%': (x, y) => x % y,
  '<': (x, y) => (x < y ? 1 : 0), '<=': (x, y) => (x <= y ? 1 : 0),
  '>': (x, y) => (x > y ? 1 : 0), '>=': (x, y) => (x >= y ? 1 : 0),
  '==': (x, y) => (x === y ? 1 : 0), '!=': (x, y) => (x !== y ? 1 : 0),
  and: (x, y) => (truthy(x) && truthy(y) ? 1 : 0),
  or: (x, y) => (truthy(x) || truthy(y) ? 1 : 0),
};

// parse cache: runScript is called on every live tick with the same source,
// so parse+validate once per distinct script. Errors are cached too.
const AST_CACHE = new Map();
const AST_CACHE_MAX = 50;
const parseCached = (src) => {
  let entry = AST_CACHE.get(src);
  if (!entry) {
    try {
      const ast = parse(src);
      validate(ast);
      entry = { ast };
    } catch (e) {
      entry = { error: e };
    }
    if (AST_CACHE.size >= AST_CACHE_MAX) AST_CACHE.delete(AST_CACHE.keys().next().value);
    AST_CACHE.set(src, entry);
  }
  if (entry.error) throw entry.error;
  return entry.ast;
};

// source spans of plain literals — the study editor rewrites these in place
// when the user restyles a line. Computed expressions have no span.
const litSpan = (nd) => (nd && nd.k === 'lit' && nd.start != null ? [nd.start, nd.end] : null);

// aggregated-bar source reads for security() sub-contexts
const secSource = (bar, name, idx) => {
  switch (name) {
    case 'open': return bar.open;
    case 'high': return bar.high;
    case 'low': return bar.low;
    case 'close': return bar.close;
    case 'volume': return bar.volume;
    case 'time': return bar.time;
    case 'bar_index': return idx;
    case 'hl2': return (bar.high + bar.low) / 2;
    case 'hlc3': return (bar.high + bar.low + bar.close) / 3;
    case 'ohlc4': return (bar.open + bar.high + bar.low + bar.close) / 4;
    default: return NaN;
  }
};

// "5m"/"90m"/"1h"/"4h" -> bucket ms; "1d"/"1w" use session-timezone anchors
const parseSecurityTf = (tf, line) => {
  const m = /^(\d+)([mhdw])$/.exec(tf || '');
  if (!m) throw new Error(`line ${line}: security timeframe must look like "5m", "1h", "1d" or "1w"`);
  const count = +m[1];
  if (count < 1) throw new Error(`line ${line}: security timeframe must look like "5m", "1h", "1d" or "1w"`);
  if (m[2] === 'm') return { bucketMs: count * 60000 };
  if (m[2] === 'h') return { bucketMs: count * 3600000 };
  if (count !== 1) throw new Error(`line ${line}: security day/week timeframes must be "1d" or "1w"`);
  return { anchor: m[2] === 'd' ? 'session' : 'week' };
};

// style args are read on the first bar and locked; Object.is so NaN == NaN
const lock = (state, key, val, what, line) => {
  if (!(key in state.locked)) state.locked[key] = val;
  else if (!Object.is(state.locked[key], val)) {
    throw new Error(`line ${line}: ${what} must not change between bars`);
  }
  return state.locked[key];
};

class Engine {
  constructor(ast, bars, out, { inputs, tz, session }) {
    this.ast = ast;
    this.bars = bars;
    this.n = bars.length;
    this.out = out;
    this.inputs = inputs;
    this.tz = tz;
    this.arrays = makeSourceArrays(bars);
    this.now = makeNowScalars(bars, tz, session);
    this.scope = new Map();
    Object.keys(this.arrays).forEach(name => this.scope.set(name, { kind: 'src', arr: this.arrays[name] }));
    Object.keys(this.now).forEach(name => this.scope.set(name, { kind: 'const', value: this.now[name] }));
    DYNAMIC_SOURCE_NAMES.forEach(name => this.scope.set(name, { kind: 'const', value: NaN }));
    this.commitSlots = [];
    this.states = new Map();
    this.strategy = new StrategyEngine(this.n);
    this.frames = [];
    // lexical barrier for user-function calls: readVar/reassign never scan
    // frames below this index, so a function body cannot see (or write) the
    // caller's block-locals — only its own frames, then the script scope
    this.frameFloor = 0;
    this.setConstFn = (k, v) => this.setConst(k, v);
    this.ctxPath = '';
    this.i = 0;
    this.declPass = false;
    this.loopIters = 0;
    this.dayKeyVal = undefined;
    this.secMode = null; // active security() sub-context, or null
    const engine = this;
    // per-bar context handed to builtins (bar/i mutated per bar)
    this.cc = {
      bar: null, i: 0, tz,
      dayKey: () => engine.anchorKey('session'),
      anchorKey: (anchor) => engine.anchorKey(anchor),
    };
  }

  // vwap reset key for the current bar, in the session timezone:
  // session = calendar day, week = Monday-start week, month = calendar month.
  // Inside a security() sub-context the aggregated bar's time applies.
  anchorKey(anchor) {
    let w;
    if (this.secMode) {
      const t = this.secMode.bars[this.secMode.idx].time;
      w = Number.isNaN(t) ? null : wallDate(t, this.tz);
    } else {
      if (this.dayKeyVal === undefined) {
        const t = this.declPass ? NaN : this.arrays.time[this.i];
        this.dayKeyVal = Number.isNaN(t) ? null : wallDate(t, this.tz);
      }
      w = this.dayKeyVal;
    }
    if (w == null) return NaN;
    if (anchor === 'week') {
      // wall-clock days since epoch; +3 aligns Monday starts (day 0 was a
      // Thursday), so the key increments every Monday
      return Math.floor((Math.floor(w.getTime() / 86400000) + 3) / 7);
    }
    if (anchor === 'month') return w.getUTCFullYear() * 100 + (w.getUTCMonth() + 1);
    return w.getUTCFullYear() * 10000 + (w.getUTCMonth() + 1) * 100 + w.getUTCDate();
  }

  state(key, init) {
    let s = this.states.get(key);
    if (!s) {
      s = init();
      this.states.set(key, s);
    }
    return s;
  }

  setConst(name, value) {
    this.scope.get(name).value = value;
  }

  run() {
    if (this.n === 0) {
      // declaration pass: with no bars nothing executes per bar, but hosts
      // still need the declarations (plots, inputs, title) — run the body
      // once with every source reading na
      this.declPass = true;
      this.cc.bar = { open: NaN, high: NaN, low: NaN, close: NaN, volume: NaN };
      this.strategy.writeSources(NaN, this.setConstFn);
      this.execAll();
      this.finalize();
      return;
    }
    for (let i = 0; i < this.n; i++) {
      this.i = i;
      this.cc.i = i;
      this.cc.bar = this.bars[i];
      this.dayKeyVal = undefined;
      this.loopIters = 0;
      const bar = this.bars[i];
      this.strategy.preBar(i, bar);
      this.setConst('barstate.isfirst', i === 0 ? 1 : 0);
      this.setConst('barstate.islast', i === this.n - 1 ? 1 : 0);
      this.strategy.writeSources(bar.close, this.setConstFn);
      this.execAll();
      this.strategy.postBar(i, bar);
      this.commitSlots.forEach(slot => { slot.hist[i] = slot.value; });
    }
    this.finalize();
  }

  finalize() {
    const lastClose = this.n ? this.bars[this.n - 1].close : NaN;
    const t0 = this.n ? this.arrays.time[0] : NaN;
    const t1 = this.n ? this.arrays.time[this.n - 1] : NaN;
    const { strategy, markers } = this.strategy.finalize(lastClose, t0, t1);
    this.out.strategy = strategy;
    markers.forEach(m => this.out.trades.push(m));
  }

  execAll() {
    this.ast.stmts.forEach(st => this.execStmt(st));
  }

  execStmt(st) {
    switch (st.k) {
      case 'expr':
        this.evalExpr(st.expr);
        return;
      case 'assign': {
        const v = this.evalExpr(st.expr);
        if (this.frames.length) {
          // block/function locals: `=` declares in the current block; use :=
          // to write through to an outer variable
          this.frames[this.frames.length - 1].set(st.name, { value: v });
          return;
        }
        const slot = this.scope.get(st.name);
        if (slot && (slot.kind === 'src' || slot.kind === 'const')) {
          throw new Error(`line ${st.line}: cannot assign to built-in source '${st.name}'`);
        }
        if (!slot) {
          const fresh = { kind: 'dyn', value: v, hist: new Array(this.n).fill(NaN) };
          this.scope.set(st.name, fresh);
          this.commitSlots.push(fresh);
        } else if (slot.kind === 'per') {
          throw new Error(`line ${st.line}: '${st.name}' is declared with var — use := to reassign it`);
        } else {
          slot.value = v;
        }
        return;
      }
      case 'reassign': {
        const v = this.evalExpr(st.expr);
        for (let f = this.frames.length - 1; f >= this.frameFloor; f--) {
          const b = this.frames[f].get(st.name);
          if (b) { b.value = v; return; }
        }
        const slot = this.scope.get(st.name);
        if (!slot) throw new Error(`line ${st.line}: cannot reassign undeclared variable '${st.name}'`);
        if (slot.kind === 'src' || slot.kind === 'const') throw new Error(`line ${st.line}: cannot reassign built-in '${st.name}'`);
        slot.value = v;
        return;
      }
      case 'vardecl': {
        if (this.frames.length) {
          // block-scope var: persists across bars, keyed by declaration site
          const s = this.state(`${this.ctxPath}v${st.id}`, () => ({ inited: false, value: NaN }));
          if (!s.inited) { s.value = this.evalExpr(st.expr); s.inited = true; }
          this.frames[this.frames.length - 1].set(st.name, s);
          return;
        }
        const slot = this.scope.get(st.name);
        if (slot && slot.kind === 'per') {
          if (slot.declId !== st.id) throw new Error(`line ${st.line}: variable '${st.name}' is already declared`);
          return; // subsequent bar — the init expression only runs once
        }
        if (slot && (slot.kind === 'src' || slot.kind === 'const')) {
          throw new Error(`line ${st.line}: cannot declare over built-in source '${st.name}'`);
        }
        if (slot) {
          // a plain `x = …` earlier in the script already owns the name —
          // erroring immediately keeps the error independent of bar count
          throw new Error(`line ${st.line}: variable '${st.name}' is already declared`);
        }
        const fresh = {
          kind: 'per', declId: st.id, value: this.evalExpr(st.expr),
          hist: new Array(this.n).fill(NaN),
        };
        this.scope.set(st.name, fresh);
        this.commitSlots.push(fresh);
        return;
      }
      case 'if': {
        const branch = truthy(this.evalExpr(st.cond)) ? st.then : st.els;
        return branch ? this.execBlock(branch) : undefined;
      }
      case 'while': {
        for (;;) {
          if (!truthy(this.evalExpr(st.cond))) return;
          if (++this.loopIters > LOOP_LIMIT) throw new Error(`line ${st.line}: loop iteration limit exceeded`);
          const sig = this.execBlock(st.body);
          if (sig === 'break') return;
        }
      }
      case 'switch': {
        // tests evaluate in order until one matches (conditional, like
        // statement blocks); the matched arm's statement runs, then done
        const subject = this.evalExpr(st.subject);
        for (const arm of st.arms) {
          if (arm.test === null) return this.execStmt(arm.stmt);
          // strict same-type equality, like `==` (§6): NaN matches nothing
          if (this.evalExpr(arm.test) === subject) return this.execStmt(arm.stmt);
        }
        return;
      }
      case 'break': return 'break';
      case 'continue': return 'continue';
      case 'for': {
        const from = this.evalExpr(st.from);
        const to = this.evalExpr(st.to);
        const by = st.by ? this.evalExpr(st.by) : 1;
        if (typeof from !== 'number' || typeof to !== 'number' || typeof by !== 'number') {
          throw new Error(`line ${st.line}: for loop bounds must be numbers`);
        }
        if (by === 0) throw new Error(`line ${st.line}: for loop step must not be zero`);
        const frame = new Map();
        const binding = { value: from };
        frame.set(st.name, binding);
        this.frames.push(frame);
        try {
          outer: for (let v = from; by > 0 ? v <= to : v >= to; v += by) {
            if (++this.loopIters > LOOP_LIMIT) throw new Error(`line ${st.line}: loop iteration limit exceeded`);
            binding.value = v;
            for (const inner of st.body) {
              const sig = this.execStmt(inner);
              if (sig === 'break') break outer;
              if (sig === 'continue') break;
            }
          }
        } finally {
          this.frames.pop();
        }
        return;
      }
      case 'fndef':
        return;
      default:
        throw new Error('bad statement');
    }
  }

  // returns a flow signal: undefined | 'break' | 'continue'
  execBlock(stmts) {
    this.frames.push(new Map());
    try {
      for (const st of stmts) {
        const sig = this.execStmt(st);
        if (sig) return sig;
      }
    } finally {
      this.frames.pop();
    }
    return undefined;
  }

  readVar(name, line) {
    for (let f = this.frames.length - 1; f >= this.frameFloor; f--) {
      const b = this.frames[f].get(name);
      if (b) return b.value;
    }
    const slot = this.scope.get(name);
    if (!slot) throw new Error(`line ${line}: unknown variable '${name}'`);
    if (slot.kind === 'src') {
      if (this.secMode) return secSource(this.secMode.bars[this.secMode.idx], name, this.secMode.idx);
      return this.declPass ? NaN : slot.arr[this.i];
    }
    return slot.value;
  }

  evalExpr(node) {
    switch (node.k) {
      case 'lit': return node.v;
      case 'var': return this.readVar(node.name, node.line);
      case 'un': {
        const v = this.evalExpr(node.a);
        return node.op === '-' ? -v : (truthy(v) ? 0 : 1);
      }
      case 'bin': return BIN_OPS[node.op](this.evalExpr(node.a), this.evalExpr(node.b));
      case 'cond': {
        // all three operands evaluate every bar so indicator state inside
        // either branch stays gap-free; only the value is selected
        const c = this.evalExpr(node.c);
        const a = this.evalExpr(node.a);
        const b = this.evalExpr(node.b);
        return truthy(c) ? a : b;
      }
      case 'hist': return this.evalHist(node);
      case 'call': return this.evalCall(node);
      default: throw new Error('bad node');
    }
  }

  evalHist(node) {
    const off = this.evalExpr(node.off);
    if (typeof off !== 'number') throw new Error(`line ${node.line}: history offset must be a number`);
    const o = Math.round(off);
    const base = node.base;
    const idx = this.secMode ? this.secMode.idx : this.i;
    if (base.k === 'var') {
      // simple-variable history reads committed values directly — gap-free
      // and cheap. Frame locals fall through to the buffered path.
      let frameLocal = false;
      for (let f = this.frames.length - 1; f >= 0; f--) if (this.frames[f].has(base.name)) { frameLocal = true; break; }
      if (!frameLocal) {
        const slot = this.scope.get(base.name);
        if (!slot) throw new Error(`line ${base.line}: unknown variable '${base.name}'`);
        if (this.declPass) return NaN;
        if (!(o >= 0) || idx - o < 0) return NaN; // negative = future, NaN offset
        if (slot.kind === 'src') {
          if (this.secMode) return secSource(this.secMode.bars[idx - o], base.name, idx - o);
          return slot.arr[idx - o];
        }
        if (slot.kind === 'const') return slot.value; // scalars broadcast
        return o === 0 ? slot.value : slot.hist[idx - o];
      }
    }
    // arbitrary-expression history: per-call-site buffer of the base's
    // per-bar values. Bars where this expression didn't run stay na.
    const s = this.state(`${this.ctxPath}h${node.id}`, () => ({ buf: new Array(this.n).fill(NaN) }));
    const v = this.evalExpr(base);
    if (this.declPass) return o === 0 ? v : NaN;
    s.buf[idx] = v;
    if (!(o >= 0) || idx - o < 0) return NaN;
    return s.buf[idx - o];
  }

  // security(tf, expr): aggregate chart bars into tf buckets and evaluate
  // the expression once per CONFIRMED bucket, in a sub-context where the
  // sources read the aggregated bar. Non-repainting by construction: the
  // value only changes when a higher-TF bar completes; na before the first.
  evalSecurity(node) {
    if (node.args.length < 2) throw new Error(`line ${node.line}: security needs a timeframe and an expression`);
    const st = this.state(`${this.ctxPath}q${node.id}`, () => ({
      locked: {}, bucketKey: undefined, agg: null, auxBars: [], value: NaN,
    }));
    const tfV = this.evalExpr(node.args[0]);
    const tf = lock(st, 'tf', tfV, 'security timeframe', node.line);
    if (typeof tf !== 'string') throw new Error(`line ${node.line}: security timeframe must be a string`);
    if (st.spec === undefined) st.spec = parseSecurityTf(tf, node.line);
    if (this.declPass) return NaN;
    const bar = this.bars[this.i];
    const t = this.arrays.time[this.i];
    const key = st.spec.bucketMs != null
      ? Math.floor(t / st.spec.bucketMs)
      : this.anchorKey(st.spec.anchor);
    if (st.bucketKey === undefined) {
      st.bucketKey = key;
      st.agg = { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume || 0, time: t };
    } else if (key !== st.bucketKey) {
      // the previous bucket just completed — evaluate the expression on it
      st.auxBars.push(st.agg);
      st.value = this.evalInSecurityCtx(node, st.auxBars);
      st.bucketKey = key;
      st.agg = { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume || 0, time: t };
    } else {
      const a = st.agg;
      if (bar.high > a.high) a.high = bar.high;
      if (bar.low < a.low) a.low = bar.low;
      a.close = bar.close;
      a.volume += bar.volume || 0;
    }
    return st.value;
  }

  evalInSecurityCtx(node, auxBars) {
    const prevSec = this.secMode;
    const prevCtx = this.ctxPath;
    const prevBar = this.cc.bar;
    const prevI = this.cc.i;
    const idx = auxBars.length - 1;
    this.secMode = { bars: auxBars, idx };
    this.ctxPath = `${prevCtx}s${node.id}/`;
    this.cc.bar = auxBars[idx];
    this.cc.i = idx;
    try {
      return this.evalExpr(node.args[1]);
    } finally {
      this.secMode = prevSec;
      this.ctxPath = prevCtx;
      this.cc.bar = prevBar;
      this.cc.i = prevI;
    }
  }

  evalCall(node) {
    if (node.name === 'security') return this.evalSecurity(node);
    // kwargs evaluate before positional args (documented, §6); null-proto so
    // a kwarg named __proto__ stays an ordinary key. The shared frozen empty
    // object skips an allocation for the common kwarg-less call
    let kw = EMPTY_KW;
    const nk = node.kwargKeys;
    if (nk.length) {
      kw = Object.create(null);
      for (let k = 0; k < nk.length; k++) kw[nk[k]] = this.evalExpr(node.kwargs[nk[k]]);
    }
    const args = node.args.map(a => this.evalExpr(a));
    const fn = this.ast.fns[node.name];
    if (fn) return this.callUserFn(node, fn, args);
    const draw = DRAW_HANDLERS[node.name];
    if (draw) return draw(this, node, args, kw);
    const factory = BUILTIN_FACTORIES[node.name];
    if (!factory) throw new Error(`line ${node.line}: unknown function '${node.name}'`);
    const inst = this.state(`${this.ctxPath}b${node.id}`, factory);
    return inst(this.cc, args);
  }

  callUserFn(node, fn, args) {
    if (Object.keys(node.kwargs).length) {
      throw new Error(`line ${node.line}: ${fn.name}() takes positional arguments only`);
    }
    if (args.length !== fn.params.length) {
      throw new Error(`line ${node.line}: ${fn.name}() expects ${fn.params.length} argument${fn.params.length === 1 ? '' : 's'}, got ${args.length}`);
    }
    const frame = new Map();
    fn.params.forEach((p, k) => frame.set(p, { value: args[k] }));
    const prevFloor = this.frameFloor;
    this.frameFloor = this.frames.length; // the param frame stays visible
    this.frames.push(frame);
    const prevCtx = this.ctxPath;
    this.ctxPath = `${prevCtx}${node.id}/`;
    try {
      fn.body.forEach(s => this.execStmt(s));
      return this.evalExpr(fn.ret);
    } finally {
      this.ctxPath = prevCtx;
      this.frames.pop();
      this.frameFloor = prevFloor;
    }
  }
}

// ---------------------------------------------------------- draw functions
// Each handler owns one record per call site: created on the first bar with
// style args locked, then fed per-bar data. All are restricted to top-level
// statements by validate(), so they run exactly once per bar.

// input.*() declarations run once, on the first bar: the record is built,
// the override resolved, and the locked value returned on every later bar.
// build() -> { label, type, default, resolve(key) -> { value, extra } };
// `extra` keys land between `value` and `tooltip` (the v1 record layout).
const inputRecord = (eng, node, kw, build) => {
  const s = eng.state(`d${node.id}`, () => ({ done: false, value: NaN }));
  if (!s.done) {
    const spec = build();
    // duplicate labels get an ordinal suffix so override lookups stay
    // distinct; the first occurrence keeps the plain label. Suffixes bump
    // until the key is actually free — a literal label "X (2)" must not
    // collide with the generated suffix for a later duplicate "X"
    const taken = new Set(eng.out.inputs.map(inp => inp.key));
    let key = spec.label;
    for (let k = 2; taken.has(key); k++) key = `${spec.label} (${k})`;
    const { value, extra } = spec.resolve(key);
    s.value = value;
    eng.out.inputs.push({
      key, label: spec.label, type: spec.type, default: spec.default, value,
      ...extra,
      tooltip: typeof kw.tooltip === 'string' ? kw.tooltip : null,
    });
    s.done = true;
  }
  return s.value;
};

const DRAW_HANDLERS = {
  study: (eng, node, args, kw) => {
    const s = eng.state(`d${node.id}`, () => ({ done: false }));
    if (s.done) return 0;
    s.done = true;
    eng.out.title = kw.title ?? (typeof args[0] === 'string' ? args[0] : eng.out.title);
    if ('overlay' in kw) eng.out.overlay = truthy(kw.overlay);
    if (typeof kw.description === 'string') eng.out.description = kw.description;
    return 0;
  },

  plot: (eng, node, args, kw) => {
    const s = eng.state(`d${node.id}`, () => ({ locked: {} }));
    const color = lock(s, 'color', kw.color ?? (typeof args[1] === 'string' && `${args[1]}`.startsWith('#') ? args[1] : null), 'plot color', node.line);
    const width = lock(s, 'width', typeof kw.width === 'number' ? kw.width : (typeof args[2] === 'number' ? args[2] : null), 'plot width', node.line);
    const title = lock(s, 'title', kw.title ?? (typeof args[1] === 'string' && !`${args[1]}`.startsWith('#') ? args[1] : null), 'plot title', node.line);
    const style = lock(s, 'style', kw.style ?? 'line', 'plot style', node.line);
    const lineStyle = lock(s, 'lineStyle', kw.linestyle ?? 'solid', 'plot linestyle', node.line);
    if (!PLOT_STYLES.has(style)) throw new Error(`line ${node.line}: unknown plot style '${style}' — use ${[...PLOT_STYLES].join(', ')}`);
    if (!LINE_STYLES.has(lineStyle)) throw new Error(`line ${node.line}: unknown linestyle '${lineStyle}' — use ${[...LINE_STYLES].join(', ')}`);
    if (!s.rec) {
      const colorSpan = typeof kw.color === 'string' ? litSpan(node.kwargs.color)
        : (typeof args[1] === 'string' && `${args[1]}`.startsWith('#') ? litSpan(node.args[1]) : null);
      const widthSpan = typeof kw.width === 'number' ? litSpan(node.kwargs.width)
        : (typeof args[2] === 'number' ? litSpan(node.args[2]) : null);
      s.rec = {
        key: `p${eng.out.plots.length}`,
        title,
        color: color ?? PLOT_COLORS[eng.out.plots.length % PLOT_COLORS.length],
        width: width ?? 2,
        style,
        lineStyle,
        colorSpan,
        widthSpan,
        values: new Array(eng.n).fill(NaN),
      };
      s.ref = { __plot: eng.out.plots.length };
      eng.out.plots.push(s.rec);
    }
    if (!eng.declPass) {
      const v = args[0];
      if (typeof v === 'number') s.rec.values[eng.i] = v;
    }
    return s.ref;
  },

  hline: (eng, node, args, kw) => {
    const s = eng.state(`d${node.id}`, () => ({ locked: {} }));
    lock(s, 'value', typeof args[0] === 'number' ? args[0] : NaN, 'hline value', node.line);
    if (!s.rec) {
      // a plot-shaped record (like v1) so fill(plotRef, hlineRef) resolves
      s.rec = {
        key: `p${eng.out.plots.length}`,
        title: kw.title ?? null,
        color: kw.color ?? '#8f8f98',
        width: typeof kw.width === 'number' ? kw.width : 1,
        values: new Array(eng.n).fill(typeof args[0] === 'number' ? args[0] : NaN),
      };
      s.ref = { __plot: eng.out.plots.length };
      eng.out.plots.push(s.rec);
    }
    return s.ref;
  },

  fill: (eng, node, args, kw) => {
    if (args.length < 2) throw new Error(`line ${node.line}: fill needs two plots or series`);
    const s = eng.state(`d${node.id}`, () => ({ locked: {} }));
    const isRef = (v) => v && typeof v === 'object' && '__plot' in v;
    if (!s.rec) {
      s.aRef = isRef(args[0]);
      s.bRef = isRef(args[1]);
      s.rec = {
        a: s.aRef ? eng.out.plots[args[0].__plot].values : new Array(eng.n).fill(NaN),
        b: s.bRef ? eng.out.plots[args[1].__plot].values : new Array(eng.n).fill(NaN),
        color: kw.color ?? '#3b82f6',
        opacity: typeof kw.opacity === 'number' ? kw.opacity : 0.12,
      };
      eng.out.fills.push(s.rec);
    }
    if (!eng.declPass) {
      if (!s.aRef) s.rec.a[eng.i] = typeof args[0] === 'number' ? args[0] : NaN;
      if (!s.bRef) s.rec.b[eng.i] = typeof args[1] === 'number' ? args[1] : NaN;
    }
    return 0;
  },

  plotshape: (eng, node, args, kw) => {
    const s = eng.state(`d${node.id}`, () => ({ locked: {} }));
    const color = lock(s, 'color', kw.color ?? (kw.location === 'belowbar' ? '#22c55e' : '#ef4444'), 'plotshape color', node.line);
    if (!s.rec) {
      s.rec = {
        values: new Array(eng.n).fill(0),
        shape: kw.shape ?? 'triangleup',
        location: kw.location ?? 'abovebar',
        color,
        size: typeof kw.size === 'number' ? kw.size : 4,
      };
      eng.out.shapes.push(s.rec);
    }
    if (!eng.declPass) {
      const v = args[0];
      s.rec.values[eng.i] = typeof v === 'number' ? v : (truthy(v) ? 1 : 0);
    }
    return 0;
  },

  infopanel: (eng, node, args, kw) => {
    const s = eng.state(`d${node.id}`, () => ({ locked: {} }));
    if (!s.rec) {
      const precision = typeof kw.precision === 'number'
        ? Math.max(0, Math.min(8, Math.round(kw.precision))) : 2;
      s.rec = {
        title: kw.title ?? (typeof args[1] === 'string' ? args[1] : `Value ${eng.out.panel.length + 1}`),
        value: NaN,
        color: null,
        precision,
      };
      eng.out.panel.push(s.rec);
    }
    // the panel shows the latest executed bar: value and color simply
    // overwrite each bar, so the final run's last bar wins. Arrays are
    // references, not displayable scalars — they read as na
    s.rec.value = isScriptArray(args[0]) ? NaN : args[0];
    s.rec.color = typeof kw.color === 'string' ? kw.color : null;
    return 0;
  },

  barcolor: (eng, node, args, kw) => {
    const s = eng.state(`d${node.id}`, () => ({}));
    if (!s.arr) {
      s.arr = new Array(eng.n).fill(null);
      eng.out.barColors.push(s.arr);
    }
    if (!eng.declPass) {
      const gated = 'when' in node.kwargs && !truthy(kw.when);
      s.arr[eng.i] = gated || typeof args[0] !== 'string' ? null : args[0];
    }
    return 0;
  },

  bgcolor: (eng, node, args, kw) => {
    const s = eng.state(`d${node.id}`, () => ({ locked: {} }));
    if (!s.rec) {
      s.rec = {
        colors: new Array(eng.n).fill(null),
        opacity: typeof kw.opacity === 'number' ? kw.opacity : 0.1,
      };
      eng.out.bgColors.push(s.rec);
    }
    if (!eng.declPass) {
      const gated = 'when' in node.kwargs && !truthy(kw.when);
      s.rec.colors[eng.i] = gated || typeof args[0] !== 'string' ? null : args[0];
    }
    return 0;
  },

  alertcondition: (eng, node, args, kw) => {
    const s = eng.state(`d${node.id}`, () => ({ locked: {} }));
    lock(s, 'title', kw.title ?? null, 'alertcondition title', node.line);
    const template = lock(s, 'message', typeof kw.message === 'string' ? kw.message : null, 'alertcondition message', node.line);
    if (!s.rec) {
      s.rec = {
        title: kw.title ?? `Alert ${eng.out.alerts.length + 1}`,
        message: template,
        values: new Array(eng.n).fill(0),
      };
      // a template with {{placeholders}} also renders a per-fire message
      if (typeof template === 'string' && template.includes('{{')) {
        s.rec.messages = new Array(eng.n).fill(null);
      }
      eng.out.alerts.push(s.rec);
    }
    if (!eng.declPass) {
      const fired = truthy(args[0]);
      s.rec.values[eng.i] = fired ? 1 : 0;
      if (fired && s.rec.messages) {
        s.rec.messages[eng.i] = renderAlertMessage(s.rec.message, eng.bars[eng.i], eng.i);
      }
    }
    return 0;
  },

  'input.int': (eng, node, args, kw) => inputRecord(eng, node, kw, () => intFloat(eng, node, args, kw, 'int')),
  'input.float': (eng, node, args, kw) => inputRecord(eng, node, kw, () => intFloat(eng, node, args, kw, 'float')),
  input: (eng, node, args, kw) => inputRecord(eng, node, kw, () => intFloat(eng, node, args, kw, 'float')),

  'input.time': (eng, node, args, kw) => inputRecord(eng, node, kw, () => {
    const dflt = typeof args[0] === 'string' ? args[0] : '';
    const label = kw.title ?? (typeof args[1] === 'string' ? args[1] : `Input ${eng.out.inputs.length + 1}`);
    return {
      label, type: 'time', default: dflt,
      resolve: (key) => {
        // overrides are the raw date string; the script receives the parsed
        // ms epoch (na when unset/unparseable)
        const raw = eng.inputs && typeof eng.inputs[key] === 'string' ? eng.inputs[key] : dflt;
        return { value: parseTimestamp(raw, eng.tz), extra: { text: raw } };
      },
    };
  }),

  'input.bool': (eng, node, args, kw) => inputRecord(eng, node, kw, () => {
    const dflt = truthy(args[0]) ? 1 : 0;
    const label = kw.title ?? (typeof args[1] === 'string' ? args[1] : `Input ${eng.out.inputs.length + 1}`);
    return {
      label, type: 'bool', default: dflt,
      resolve: (key) => {
        const raw = eng.inputs && (typeof eng.inputs[key] === 'number' || typeof eng.inputs[key] === 'boolean')
          ? eng.inputs[key] : dflt;
        return { value: truthy(typeof raw === 'boolean' ? (raw ? 1 : 0) : raw) ? 1 : 0, extra: {} };
      },
    };
  }),

  'input.string': (eng, node, args, kw) => inputRecord(eng, node, kw, () => {
    const dflt = typeof args[0] === 'string' ? args[0] : '';
    const label = kw.title ?? (typeof args[1] === 'string' ? args[1] : `Input ${eng.out.inputs.length + 1}`);
    // options is a comma-separated list (the language has no array literals)
    const options = typeof kw.options === 'string'
      ? kw.options.split(',').map(s => s.trim()).filter(Boolean) : null;
    return {
      label, type: 'string', default: dflt,
      resolve: (key) => {
        const raw = eng.inputs && typeof eng.inputs[key] === 'string' ? eng.inputs[key] : dflt;
        return { value: options && !options.includes(raw) ? dflt : raw, extra: { options } };
      },
    };
  }),

  // ---- drawing objects: created per bar when `when` holds, capped -------
  'line.new': (eng, node, args, kw) => {
    if (eng.declPass) return 0;
    if ('when' in node.kwargs && !truthy(kw.when)) return 0;
    const [x1, y1, x2, y2] = args.map(v => (typeof v === 'number' ? v : NaN));
    if (![x1, y1, x2, y2].every(Number.isFinite)) return 0;
    pushCapped(eng.out.lines, {
      x1, y1, x2, y2,
      color: typeof kw.color === 'string' ? kw.color : '#8f8f98',
      width: typeof kw.width === 'number' ? kw.width : 1,
      lineStyle: typeof kw.style === 'string' ? kw.style : 'solid',
    });
    return 0;
  },
  'label.new': (eng, node, args, kw) => {
    if (eng.declPass) return 0;
    if ('when' in node.kwargs && !truthy(kw.when)) return 0;
    const x = typeof args[0] === 'number' ? args[0] : NaN;
    const y = typeof args[1] === 'number' ? args[1] : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    const t = args[2];
    pushCapped(eng.out.labels, {
      x, y,
      text: typeof t === 'string' ? t : typeof t === 'number' ? String(t) : '',
      color: typeof kw.color === 'string' ? kw.color : '#8f8f98',
      textColor: typeof kw.textcolor === 'string' ? kw.textcolor : null,
      style: typeof kw.style === 'string' ? kw.style : 'down',
      size: typeof kw.size === 'number' ? kw.size : 10,
    });
    return 0;
  },
  'box.new': (eng, node, args, kw) => {
    if (eng.declPass) return 0;
    if ('when' in node.kwargs && !truthy(kw.when)) return 0;
    const [x1, y1, x2, y2] = args.map(v => (typeof v === 'number' ? v : NaN));
    if (![x1, y1, x2, y2].every(Number.isFinite)) return 0;
    pushCapped(eng.out.boxes, {
      x1, y1, x2, y2,
      color: typeof kw.color === 'string' ? kw.color : '#8f8f98',
      bgColor: typeof kw.bgcolor === 'string' ? kw.bgcolor : null,
      width: typeof kw.width === 'number' ? kw.width : 1,
    });
    return 0;
  },

  'strategy.buy': (eng, node, args, kw) => strategyOrder(eng, node, args, kw, 'buy'),
  'strategy.sell': (eng, node, args, kw) => strategyOrder(eng, node, args, kw, 'sell'),

  // backtest configuration, read once on the first bar
  'strategy.config': (eng, node, args, kw) => {
    eng.strategy.used = true;
    const s = eng.state(`d${node.id}`, () => ({ done: false }));
    if (!s.done) {
      s.done = true;
      eng.strategy.configure(kw);
    }
    return 0;
  },
};

const QTY_TYPES = ['shares', 'cash', 'percent_of_equity'];

const strategyOrder = (eng, node, args, kw, side) => {
  eng.strategy.used = true;
  if (eng.declPass) return 0;
  if (kw.limit !== undefined && kw.stop !== undefined) {
    throw new Error(`line ${node.line}: an order takes limit= or stop=, not both`);
  }
  const qtyType = kw.qty_type === undefined ? 'shares' : kw.qty_type;
  if (!QTY_TYPES.includes(qtyType)) {
    throw new Error(`line ${node.line}: qty_type must be "shares", "cash" or "percent_of_equity"`);
  }
  const when = 'when' in kw ? kw.when : (args.length ? args[0] : 1);
  const qty = 'qty' in kw ? kw.qty : (args.length > 1 ? args[1] : 1);
  if (truthy(when)) {
    const limit = typeof kw.limit === 'number' && isFinite(kw.limit) ? kw.limit : null;
    const stop = typeof kw.stop === 'number' && isFinite(kw.stop) ? kw.stop : null;
    // a requested-but-non-finite price drops the order entirely — a warmup
    // NaN in a limit expression must not silently degrade to a market fill
    if ((kw.limit !== undefined && limit == null) || (kw.stop !== undefined && stop == null)) return 0;
    eng.strategy.order(side === 'buy', eng.i, eng.cc.bar, {
      key: `o${node.id}`,
      qtyArg: qty,
      qtyType,
      limit,
      stop,
      expires: typeof kw.expires === 'number' && isFinite(kw.expires) ? Math.max(1, Math.round(kw.expires)) : null,
      stops: { stop: kw.stop_loss, target: kw.take_profit, trail: kw.trailing },
    });
  }
  return 0;
};

const intFloat = (eng, node, args, kw, type) => {
  const dflt = typeof args[0] === 'number' ? args[0] : 0;
  const label = kw.title ?? (typeof args[1] === 'string' ? args[1] : `Input ${eng.out.inputs.length + 1}`);
  return {
    label, type, default: dflt,
    resolve: (key) => {
      const raw = eng.inputs && typeof eng.inputs[key] === 'number' ? eng.inputs[key] : dflt;
      let v = type === 'int' ? Math.round(raw) : raw;
      if (typeof kw.minval === 'number') v = Math.max(kw.minval, v);
      if (typeof kw.maxval === 'number') v = Math.min(kw.maxval, v);
      return { value: v, extra: { minval: kw.minval, maxval: kw.maxval, step: kw.step } };
    },
  };
};


// plotbuy / plotsell share one handler
const TRADE_PRICE_SOURCES = ['open', 'high', 'low', 'close'];

// drawing objects cap: oldest dropped
const MAX_DRAW_OBJECTS = 500;
const pushCapped = (arr, obj) => {
  arr.push(obj);
  if (arr.length > MAX_DRAW_OBJECTS) arr.shift();
};

// {{name}} placeholders in alert messages, rendered at fire time
const ALERT_FIELDS = ['open', 'high', 'low', 'close', 'volume', 'time', 'bar_index'];
const renderAlertMessage = (template, bar, i) => template.replace(/\{\{(\w+)\}\}/g, (m, name) => {
  if (!ALERT_FIELDS.includes(name)) return m;
  const v = name === 'time' ? +bar.date
    : name === 'bar_index' ? i
      : name === 'volume' ? (bar.volume || 0)
        : bar[name];
  return String(v);
});

['plotbuy', 'plotsell'].forEach(name => {
  DRAW_HANDLERS[name] = (eng, node, args, kw) => {
    const s = eng.state(`d${node.id}`, () => ({ locked: {} }));
    const color = lock(s, 'color', kw.color ?? null, `${name} color`, node.line);
    // price=: an OHLC source name (locked), or a per-bar number = a custom
    // price series. The KIND is locked — a string one bar and a number the
    // next has no coherent meaning
    const priceKind = kw.price === undefined ? 'close'
      : typeof kw.price === 'string' ? kw.price : 'custom';
    if (priceKind !== 'custom' && !TRADE_PRICE_SOURCES.includes(priceKind)) {
      throw new Error(`line ${node.line}: ${name} price must be "open", "high", "low", "close" or a number`);
    }
    const priceSource = lock(s, 'priceSource', priceKind, `${name} price`, node.line);
    if (!s.rec) {
      s.rec = {
        values: new Array(eng.n).fill(0),
        qty: new Array(eng.n).fill(NaN),
        side: name === 'plotbuy' ? 'buy' : 'sell',
        // null = unstyled; the renderer supplies its theme's buy/sell colors
        color,
        priceSource,
      };
      if (priceSource === 'custom') s.rec.prices = new Array(eng.n).fill(NaN);
      eng.out.trades.push(s.rec);
    }
    if (!eng.declPass) {
      const v = args[0];
      s.rec.values[eng.i] = typeof v === 'number' ? v : (truthy(v) ? 1 : 0);
      const q = 'qty' in kw ? kw.qty : (args.length > 1 ? args[1] : 1);
      s.rec.qty[eng.i] = typeof q === 'number' ? q : NaN;
      if (priceSource === 'custom') {
        s.rec.prices[eng.i] = typeof kw.price === 'number' ? kw.price : NaN;
      }
    }
    return 0;
  };
});

// opts:
//  - inputs: { [key]: value } overrides for the script's input.*()
//    declarations (persisted per script by the chart's input editor)
//  - timezone: IANA zone for all calendar/session semantics — timestamp(),
//    hour(), market_open, input.time. Defaults to America/New_York; 'local'
//    resolves to the host zone
//  - session: { open: 'HH:MM', close: 'HH:MM' } market session bounds for
//    market_open/market_close (default 09:30–16:00)
export const runScript = (source, bars, opts = null) => {
  const { inputs = null, timezone = null, session = null } = opts || {};
  const out = {
    title: null, overlay: true, description: null,
    plots: [], fills: [], shapes: [], trades: [], panel: [],
    barColors: [], bgColors: [], inputs: [], alerts: [],
    lines: [], labels: [], boxes: [], strategy: null,
    error: null,
  };
  try {
    const ast = parseCached(source || '');
    const tz = resolveTimezone(timezone);
    const engine = new Engine(ast, bars, out, { inputs, tz, session });
    engine.run();
    if (!out.plots.length && !out.shapes.length && !out.trades.length && !out.panel.length
      && !out.barColors.length && !out.bgColors.length && !out.alerts.length
      && !out.lines.length && !out.labels.length && !out.boxes.length && !engine.strategy.used) {
      throw new Error('script draws nothing — add a plot(), plotshape(), plotbuy(), plotsell(), infopanel(), barcolor() or bgcolor()');
    }
    return out;
  } catch (e) {
    return {
      ...out, plots: [], fills: [], shapes: [], trades: [], panel: [],
      barColors: [], bgColors: [], alerts: [], lines: [], labels: [], boxes: [],
      strategy: null, error: e.message,
    };
  }
};
