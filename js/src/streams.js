// Incremental (per-bar) indicator state machines for the v2 engine. Each
// stream is created per call site and fed one value per bar via next().
//
// CONTRACT: for the indicators that existed in v1 (sma, wma, ema, wilders,
// rsi, stdev, sum, highest, lowest, change, offset, crosses, tr/atr), a
// stream fed the same value sequence must perform the SAME floating-point
// operations in the SAME order as the batch implementations in ./math.js —
// the conformance corpus holds the outputs byte-identical across the v1→v2
// engine migration. Change these only together with math.js and a corpus
// regeneration.

// ring buffer of the last `cap` inputs, indexed by absolute position
class Ring {
  constructor(cap) {
    this.cap = cap;
    this.buf = new Array(cap);
    this.count = 0; // total values pushed
  }

  push(v) { this.buf[this.count++ % this.cap] = v; }

  // value at absolute index j (must be within the last `cap` pushes)
  at(j) { return this.buf[j % this.cap]; }
}

// mirrors math.js sma: running sum slid per bar, rebuilt ascending after a
// non-finite value leaves the window
export const smaStream = (p) => {
  const ring = new Ring(p + 1);
  let s = NaN, lastBad = -1, i = -1;
  return (v) => {
    i++;
    if (!isFinite(v)) lastBad = i;
    ring.push(v);
    if (i < p - 1) return NaN;
    const start = i - p + 1;
    if (lastBad >= start) { s = NaN; return NaN; }
    if (Number.isNaN(s)) {
      s = 0;
      for (let k = start; k <= i; k++) s += ring.at(k);
    } else {
      s += v - ring.at(start - 1);
    }
    return s / p;
  };
};

export const wmaStream = (p) => {
  const ring = new Ring(p + 1);
  const denom = (p * (p + 1)) / 2;
  let s = NaN, w = 0, lastBad = -1, i = -1;
  return (v) => {
    i++;
    if (!isFinite(v)) lastBad = i;
    ring.push(v);
    if (i < p - 1) return NaN;
    const start = i - p + 1;
    if (lastBad >= start) { s = NaN; return NaN; }
    if (Number.isNaN(s)) {
      s = 0; w = 0;
      for (let k = 0; k < p; k++) {
        const y = ring.at(start + k);
        s += y;
        w += y * (k + 1); // oldest bar weighs 1, newest weighs p
      }
    } else {
      w += p * v - s;
      s += v - ring.at(start - 1);
    }
    return w / denom;
  };
};

export const emaFromStream = (alpha) => {
  let prev = null;
  return (v) => {
    if (!isFinite(v)) return NaN;
    prev = prev == null ? v : alpha * v + (1 - alpha) * prev;
    return prev;
  };
};
export const emaStream = (p) => emaFromStream(2 / (p + 1));
export const wildersStream = (p) => emaFromStream(1 / p);

export const rsiStream = (p) => {
  let avgGain = 0, avgLoss = 0, prev = NaN, cnt = 0;
  return (v) => {
    // gap — carry accumulators past it. Non-finite (not just NaN): one
    // Infinity delta would park avgGain at Infinity forever
    if (!isFinite(v)) return NaN;
    if (Number.isNaN(prev)) { prev = v; return NaN; }
    const d = v - prev;
    prev = v;
    const gain = Math.max(d, 0), loss = Math.max(-d, 0);
    cnt++;
    if (cnt <= p) {
      avgGain += gain / p;
      avgLoss += loss / p;
      if (cnt < p) return NaN;
    } else {
      avgGain = (avgGain * (p - 1) + gain) / p;
      avgLoss = (avgLoss * (p - 1) + loss) / p;
    }
    return avgLoss === 0
      ? (avgGain === 0 ? 50 : 100) // dead-flat window is neutral, not maxed
      : 100 - 100 / (1 + avgGain / avgLoss);
  };
};

// population stdev, mirrors builtins.js v1 rollStdev (NaN counting + the
// float-noise clamp)
export const stdevStream = (p) => {
  const ring = new Ring(p + 1);
  let sum = 0, sumSq = 0, nans = 0, i = -1;
  return (v) => {
    i++;
    ring.push(v);
    // non-finite (not just NaN) counts as a gap: Infinity entering the
    // accumulator would leave it as Inf - Inf = NaN forever on eviction
    if (!isFinite(v)) nans++; else { sum += v; sumSq += v * v; }
    if (i >= p) {
      const old = ring.at(i - p);
      if (!isFinite(old)) nans--; else { sum -= old; sumSq -= old * old; }
    }
    if (i < p - 1) return NaN;
    if (nans) return NaN;
    const m = sum / p;
    const varr = sumSq / p - m * m;
    return varr <= (sumSq / p) * 1e-12 ? 0 : Math.sqrt(varr);
  };
};

export const sumStream = (p) => {
  const ring = new Ring(p + 1);
  let sum = 0, nans = 0, i = -1;
  return (v) => {
    i++;
    ring.push(v);
    if (!isFinite(v)) nans++; else sum += v; // non-finite = gap, like stdev
    if (i >= p) {
      const old = ring.at(i - p);
      if (!isFinite(old)) nans--; else sum -= old;
    }
    return i >= p - 1 ? (nans ? NaN : sum) : NaN;
  };
};

// monotonic deque; keep = (incoming, tail) => drop tail. Mirrors v1
// rollExtreme, including its NaN-poisoning window
export const extremeStream = (p, keep, wantIndex = false) => {
  const ring = new Ring(p + 1);
  const dq = []; // absolute indices
  let head = 0, nans = 0, i = -1;
  return (v) => {
    i++;
    ring.push(v);
    if (Number.isNaN(v)) nans++;
    else {
      while (dq.length > head && keep(v, ring.at(dq[dq.length - 1]))) dq.pop();
      dq.push(i);
    }
    if (i >= p && Number.isNaN(ring.at(i - p))) nans--;
    while (dq.length > head && dq[head] <= i - p) head++;
    // compact dead head entries or the deque grows without bound (it only
    // ever pop()s from the tail); amortized O(1), no FP-op change
    if (head > 2 * (p + 1)) { dq.splice(0, head); head = 0; }
    if (i < p - 1 || nans || dq.length === head) return NaN;
    return wantIndex ? i - dq[head] : ring.at(dq[head]);
  };
};
export const highestStream = (p) => extremeStream(p, (v, tail) => v >= tail);
export const lowestStream = (p) => extremeStream(p, (v, tail) => v <= tail);
// bars back to the window extreme (0 = current bar) — the deque keep uses
// strict comparison so ties report the most recent extreme
export const highestBarsStream = (p) => extremeStream(p, (v, tail) => v >= tail, true);
export const lowestBarsStream = (p) => extremeStream(p, (v, tail) => v <= tail, true);

export const changeStream = (p) => {
  const ring = new Ring(p + 1);
  let i = -1;
  return (v) => {
    i++;
    ring.push(v);
    return i < p ? NaN : v - ring.at(i - p);
  };
};

export const offsetStream = (p) => {
  const ring = new Ring(p + 1);
  let i = -1;
  return (v) => {
    i++;
    ring.push(v);
    return i < p ? NaN : ring.at(i - p);
  };
};

export const crossoverStream = () => {
  let pa = NaN, pb = NaN, first = true;
  return (a, b) => {
    const r = !first && a > b && pa <= pb ? 1 : 0;
    pa = a; pb = b; first = false;
    return r;
  };
};
export const crossunderStream = () => {
  let pa = NaN, pb = NaN, first = true;
  return (a, b) => {
    const r = !first && a < b && pa >= pb ? 1 : 0;
    pa = a; pb = b; first = false;
    return r;
  };
};

export const trStream = () => {
  let prevClose = NaN, first = true;
  return (high, low, close) => {
    const r = first ? high - low
      : Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    prevClose = close;
    first = false;
    return r;
  };
};

// ---- new in v2 -----------------------------------------------------------

export const demaStream = (p) => {
  const e1 = emaStream(p), e2 = emaStream(p);
  return (v) => {
    const a = e1(v), b = e2(a);
    return 2 * a - b;
  };
};

export const temaStream = (p) => {
  const e1 = emaStream(p), e2 = emaStream(p), e3 = emaStream(p);
  return (v) => {
    const a = e1(v), b = e2(a), c = e3(b);
    return 3 * a - 3 * b + c;
  };
};

export const tmaStream = (p) => {
  const s1 = smaStream(Math.ceil((p + 1) / 2));
  const s2 = smaStream(Math.floor(p / 2) + 1);
  return (v) => s2(s1(v));
};

export const hullStream = (p) => {
  const half = wmaStream(Math.max(1, Math.floor(p / 2)));
  const full = wmaStream(p);
  const smooth = wmaStream(Math.max(1, Math.round(Math.sqrt(p))));
  return (v) => {
    const h = half(v), f = full(v);
    return smooth(2 * h - f);
  };
};

// percent rate of change vs p bars ago (NaN during warmup / zero base)
export const rocStream = (p) => {
  const ring = new Ring(p + 1);
  let i = -1;
  return (v) => {
    i++;
    ring.push(v);
    if (i < p) return NaN;
    const base = ring.at(i - p);
    return base ? (100 * (v - base)) / base : NaN;
  };
};

// 1 iff the value strictly rose (fell) on each of the last p steps; NaN
// input breaks the run
export const risingStream = (p, dir) => {
  let prev = NaN, run = 0;
  return (v) => {
    if (Number.isNaN(v)) { prev = NaN; run = 0; return 0; }
    run = !Number.isNaN(prev) && (dir > 0 ? v > prev : v < prev) ? run + 1 : 0;
    prev = v;
    return run >= p ? 1 : 0;
  };
};

// stochastic %K over the bar range
export const stochStream = (p) => {
  const hh = highestStream(p), ll = lowestStream(p);
  return (close, high, low) => {
    const h = hh(high), l = ll(low);
    const range = h - l;
    return range > 0 ? (100 * (close - l)) / range : NaN;
  };
};

// confirmed pivot: value of the center bar once `right` newer bars exist and
// the center is the strict extreme of the window; NaN otherwise (and while
// any window value is NaN)
export const pivotStream = (left, right, isHigh) => {
  const size = left + right + 1;
  const ring = new Ring(size);
  let i = -1;
  return (v) => {
    i++;
    ring.push(v);
    if (i < size - 1) return NaN;
    const center = ring.at(i - right);
    if (Number.isNaN(center)) return NaN;
    for (let k = i - size + 1; k <= i; k++) {
      if (k === i - right) continue;
      const o = ring.at(k);
      if (Number.isNaN(o)) return NaN;
      if (isHigh ? o >= center : o <= center) return NaN;
    }
    return center;
  };
};

// money flow index over typical price * volume flows
export const mfiStream = (p) => {
  const pos = sumStream(p), neg = sumStream(p);
  let prevTp = NaN;
  return (high, low, close, volume) => {
    const tp = (high + low + close) / 3;
    const flow = tp * volume;
    const up = !Number.isNaN(prevTp) && tp > prevTp ? flow : 0;
    const dn = !Number.isNaN(prevTp) && tp < prevTp ? flow : 0;
    prevTp = tp;
    const ps = pos(up), ns = neg(dn);
    if (Number.isNaN(ps) || Number.isNaN(ns)) return NaN;
    return ns === 0 ? (ps === 0 ? 50 : 100) : 100 - 100 / (1 + ps / ns);
  };
};

// on-balance volume: cumulative signed volume, starting at 0
export const obvStream = () => {
  let prevClose = NaN, acc = 0;
  return (close, volume) => {
    if (!Number.isNaN(prevClose)) {
      if (close > prevClose) acc += volume;
      else if (close < prevClose) acc -= volume;
    }
    prevClose = close;
    return acc;
  };
};

// session-anchored VWAP: cumulative price*volume over volume, reset when the
// session-timezone calendar day of the bar changes (dayKey supplied by the
// caller, which owns the timezone)
export const vwapStream = () => {
  let key = null, pv = 0, vv = 0;
  return (price, volume, dayKey) => {
    if (dayKey !== key) { key = dayKey; pv = 0; vv = 0; }
    if (!Number.isNaN(price) && !Number.isNaN(volume)) {
      pv += price * volume;
      vv += volume;
    }
    return vv > 0 ? pv / vv : NaN;
  };
};

// least-squares fit over the window (x = 0..p-1, oldest first), evaluated at
// the newest bar (x = p-1). O(p) scan per bar; NaN in the window poisons it
export const linregStream = (p) => {
  const ring = new Ring(p);
  const sx = (p * (p - 1)) / 2;
  const sxx = ((p - 1) * p * (2 * p - 1)) / 6;
  const denom = p * sxx - sx * sx;
  let i = -1;
  return (v) => {
    i++;
    ring.push(v);
    if (i < p - 1) return NaN;
    if (p === 1) return v;
    let sy = 0, sxy = 0;
    for (let k = 0; k < p; k++) {
      const y = ring.at(i - p + 1 + k);
      if (!isFinite(y)) return NaN;
      sy += y;
      sxy += k * y;
    }
    const b = (p * sxy - sx * sy) / denom;
    const a = (sy - b * sx) / p;
    return a + b * (p - 1);
  };
};

// ---- round-2 indicators ---------------------------------------------------

export const dmiStream = (p) => {
  let prevH = NaN, prevL = NaN, prevC = NaN, first = true;
  const sTr = { prev: null };
  const sPlus = { prev: null };
  const sMinus = { prev: null };
  const sAdx = { prev: null };
  const alpha = 1 / p;
  const rma = (st, v) => {
    if (!isFinite(v)) return NaN;
    st.prev = st.prev == null ? v : alpha * v + (1 - alpha) * st.prev;
    return st.prev;
  };
  return (high, low, close) => {
    let out = { plus: NaN, minus: NaN, adx: NaN };
    if (first) {
      first = false;
    } else {
      const upMove = high - prevH;
      const downMove = prevL - low;
      const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
      const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
      const tr = Math.max(high - low, Math.abs(high - prevC), Math.abs(low - prevC));
      const trS = rma(sTr, tr);
      const plusS = rma(sPlus, plusDm);
      const minusS = rma(sMinus, minusDm);
      if (trS > 0) {
        const plus = (100 * plusS) / trS;
        const minus = (100 * minusS) / trS;
        const sum = plus + minus;
        const dx = sum > 0 ? (100 * Math.abs(plus - minus)) / sum : 0;
        out = { plus, minus, adx: rma(sAdx, dx) };
      }
    }
    prevH = high; prevL = low; prevC = close;
    return out;
  };
};

// aroon over a p+1-bar window: 100 * (p - bars since extreme) / p
export const aroonStream = (p, up) => {
  const ex = up ? highestBarsStream(p + 1) : lowestBarsStream(p + 1);
  return (v) => {
    const bars = ex(v);
    return Number.isNaN(bars) ? NaN : (100 * (p - bars)) / p;
  };
};

// Wilder's parabolic SAR
export const sarStream = (start, inc, max) => {
  let count = 0, prevH = NaN, prevL = NaN, prev2H = NaN, prev2L = NaN, prevC = NaN;
  let up = true, sar = NaN, ep = NaN, af = start;
  return (high, low, close) => {
    count += 1;
    if (count === 1) {
      prevH = high; prevL = low; prevC = close;
      return NaN;
    }
    if (count === 2) {
      up = close >= prevC;
      sar = up ? Math.min(low, prevL) : Math.max(high, prevH);
      ep = up ? Math.max(high, prevH) : Math.min(low, prevL);
      af = start;
      prev2H = prevH; prev2L = prevL; prevH = high; prevL = low;
      return sar;
    }
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, prevL, prev2L);
      if (low < sar) {
        up = false;
        sar = ep;
        ep = low;
        af = start;
      } else if (high > ep) {
        ep = high;
        af = Math.min(max, af + inc);
      }
    } else {
      sar = Math.max(sar, prevH, prev2H);
      if (high > sar) {
        up = true;
        sar = ep;
        ep = high;
        af = start;
      } else if (low < ep) {
        ep = low;
        af = Math.min(max, af + inc);
      }
    }
    prev2H = prevH; prev2L = prevL; prevH = high; prevL = low;
    return sar;
  };
};

// supertrend line + direction (+1 up / -1 down)
export const supertrendStream = (p, mult) => {
  const tr = trStream();
  const atr = emaFromStream(1 / p);
  let fUpper = NaN, fLower = NaN, dir = 1, prevClose = NaN;
  return (high, low, close) => {
    const a = atr(tr(high, low, close));
    if (Number.isNaN(a)) {
      prevClose = close;
      return { line: NaN, dir: NaN };
    }
    const mid = (high + low) / 2;
    const bUpper = mid + mult * a;
    const bLower = mid - mult * a;
    fUpper = Number.isNaN(fUpper) || bUpper < fUpper || prevClose > fUpper ? bUpper : fUpper;
    fLower = Number.isNaN(fLower) || bLower > fLower || prevClose < fLower ? bLower : fLower;
    if (dir > 0 && close < fLower) dir = -1;
    else if (dir < 0 && close > fUpper) dir = 1;
    prevClose = close;
    return { line: dir > 0 ? fLower : fUpper, dir };
  };
};

// commodity channel index over typical price
export const cciStream = (p) => {
  const ring = new Ring(p);
  let i = -1;
  return (high, low, close) => {
    const tp = (high + low + close) / 3;
    i++;
    ring.push(tp);
    if (i < p - 1) return NaN;
    let sum = 0;
    for (let k = 0; k < p; k++) {
      const v = ring.at(i - p + 1 + k);
      if (Number.isNaN(v)) return NaN;
      sum += v;
    }
    const mean = sum / p;
    let md = 0;
    for (let k = 0; k < p; k++) md += Math.abs(ring.at(i - p + 1 + k) - mean);
    md /= p;
    return md > 0 ? (tp - mean) / (0.015 * md) : NaN;
  };
};

// Williams %R
export const willrStream = (p) => {
  const hh = highestStream(p);
  const ll = lowestStream(p);
  return (high, low, close) => {
    const h = hh(high);
    const l = ll(low);
    const range = h - l;
    return range > 0 ? (-100 * (h - close)) / range : NaN;
  };
};

// Pearson correlation over the window; any NaN in either window poisons.
// Ring instead of push/shift arrays: same oldest-to-newest summation order,
// without the O(p) memmove every bar
export const correlationStream = (p) => {
  const ra = new Ring(p), rb = new Ring(p);
  let i = -1;
  return (a, b) => {
    i++;
    ra.push(a); rb.push(b);
    if (i < p - 1) return NaN;
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let k = 0; k < p; k++) {
      const x = ra.at(i - p + 1 + k), y = rb.at(i - p + 1 + k);
      if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
      sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
    }
    const cov = p * sab - sa * sb;
    const va = p * saa - sa * sa;
    const vb = p * sbb - sb * sb;
    return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
  };
};

// percentile with linear interpolation over the sorted window
export const percentileStream = (p, q) => {
  const ring = new Ring(p);
  let i = -1;
  return (v) => {
    i++;
    ring.push(v);
    if (i < p - 1) return NaN;
    const sorted = new Array(p);
    for (let k = 0; k < p; k++) {
      const x = ring.at(i - p + 1 + k);
      if (Number.isNaN(x)) return NaN;
      sorted[k] = x;
    }
    sorted.sort((a, b) => a - b);
    const rank = (q / 100) * (p - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
  };
};

// Arnaud Legoux MA: gaussian-weighted window, newest at k = p-1
export const almaStream = (p, offset, sigma) => {
  const m = offset * (p - 1);
  const sw = p / sigma;
  const weights = Array.from({ length: p }, (_, k) => Math.exp(-((k - m) * (k - m)) / (2 * sw * sw)));
  const norm = weights.reduce((a, b) => a + b, 0);
  const ring = new Ring(p);
  let i = -1;
  return (v) => {
    i++;
    ring.push(v);
    if (i < p - 1) return NaN;
    let sum = 0;
    for (let k = 0; k < p; k++) {
      const x = ring.at(i - p + 1 + k);
      if (Number.isNaN(x)) return NaN;
      sum += weights[k] * x;
    }
    return sum / norm;
  };
};
