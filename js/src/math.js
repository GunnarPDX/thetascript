// Core indicator math shared by the scripting language's builtins and the
// chart's built-in studies (src/studies/math.js re-exports these), so scripts
// and studies agree bar-for-bar. Every helper takes plain number arrays (or
// bar objects where OHLC is needed) and returns a same-length array, NaN
// during warmup.
//
// The rolling helpers are O(n): they slide an accumulator instead of
// rescanning the window per bar. Non-finite inputs (warmup NaNs from nested
// smoothers, script series) poison a window the same way per-window scans
// would — the accumulators are rebuilt once the window is clean again, so
// outputs match the brute-force versions.

export const sma = (vals, n) => {
  const out = new Array(vals.length).fill(NaN);
  let s = NaN;
  let lastBad = -1; // index of the most recent non-finite input
  for (let i = 0; i < vals.length; i++) {
    if (!isFinite(vals[i])) lastBad = i;
    if (i < n - 1) continue;
    const start = i - n + 1;
    if (lastBad >= start) { s = NaN; continue; }
    if (Number.isNaN(s)) {
      s = 0;
      for (let k = start; k <= i; k++) s += vals[k];
    } else {
      s += vals[i] - vals[start - 1];
    }
    out[i] = s / n;
  }
  return out;
};

export const wma = (vals, n) => {
  const out = new Array(vals.length).fill(NaN);
  const denom = (n * (n + 1)) / 2;
  let s = NaN, w = 0;
  let lastBad = -1;
  for (let i = 0; i < vals.length; i++) {
    if (!isFinite(vals[i])) lastBad = i;
    if (i < n - 1) continue;
    const start = i - n + 1;
    if (lastBad >= start) { s = NaN; continue; }
    if (Number.isNaN(s)) {
      s = 0; w = 0;
      for (let k = 0; k < n; k++) {
        const y = vals[start + k];
        s += y;
        w += y * (k + 1); // oldest bar weighs 1, newest weighs n
      }
    } else {
      // slide: every weight drops by one (subtract the old plain sum), the
      // new bar enters at full weight n
      w += n * vals[i] - s;
      s += vals[i] - vals[start - 1];
    }
    out[i] = w / denom;
  }
  return out;
};

export const emaFrom = (vals, alpha) => {
  const out = new Array(vals.length).fill(NaN);
  let prev = null;
  vals.forEach((v, i) => {
    if (!isFinite(v)) return;
    prev = prev == null ? v : alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  });
  return out;
};

export const ema = (vals, n) => emaFrom(vals, 2 / (n + 1));
export const wilders = (vals, n) => emaFrom(vals, 1 / n);

export const rsi = (vals, n) => {
  const out = new Array(vals.length).fill(NaN);
  let avgGain = 0, avgLoss = 0, prev = NaN, cnt = 0;
  vals.forEach((v, i) => {
    // gap in the input — carry accumulators past it. Non-finite, not just
    // NaN: one Infinity delta would park avgGain at Infinity forever
    // (keep in step with streams.js rsiStream — FP-op-identical pair)
    if (!isFinite(v)) return;
    if (Number.isNaN(prev)) { prev = v; return; }
    const d = v - prev;
    prev = v;
    const gain = Math.max(d, 0), loss = Math.max(-d, 0);
    cnt++;
    if (cnt <= n) {
      avgGain += gain / n;
      avgLoss += loss / n;
      if (cnt < n) return;
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
    }
    out[i] = avgLoss === 0
      ? (avgGain === 0 ? 50 : 100) // dead-flat window is neutral, not maxed
      : 100 - 100 / (1 + avgGain / avgLoss);
  });
  return out;
};

export const trueRanges = (series) => series.map((d, i) => {
  if (i === 0) return d.high - d.low;
  const pc = series[i - 1].close;
  return Math.max(d.high - d.low, Math.abs(d.high - pc), Math.abs(d.low - pc));
});

export const atr = (series, n) => wilders(trueRanges(series), n);
