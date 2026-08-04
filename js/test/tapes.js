// Deterministic bar tapes for the conformance corpus. Generators use only
// exact double arithmetic — a minstd LCG and piecewise-linear (triangle)
// waves, no transcendentals — so regenerating on any engine or JS version
// reproduces tapes.json bit-for-bit. The committed tapes.json is still the
// artifact of record: ports read the JSON, never these generators.

// Park–Miller minstd: 16807 * x stays under 2^53, so the recurrence is exact
const lcg = (seed) => {
  let x = seed;
  return () => {
    x = (16807 * x) % 2147483647;
    return x / 2147483647;
  };
};

// zig-zag in [-1, 1] with the given period
const tri = (i, period) => {
  const ph = i % period;
  const half = period / 2;
  return ph < half ? (ph / half) * 2 - 1 : 1 - ((ph - half) / half) * 2;
};

const makeBars = (n, { start, stepMs, seed, base, amp, trend, volBase }) => {
  const rand = lcg(seed);
  const bars = [];
  for (let i = 0; i < n; i++) {
    const wob = (rand() - 0.5) * amp * 0.5;
    const mid = base + tri(i, 40) * amp + i * trend + wob;
    const spread = amp * 0.15 + rand() * amp * 0.1;
    const up = rand() < 0.5;
    const open = up ? mid - spread * 0.4 : mid + spread * 0.4;
    const close = up ? mid + spread * 0.4 : mid - spread * 0.4;
    bars.push({
      date: start + i * stepMs,
      open,
      high: Math.max(open, close) + spread * 0.3,
      low: Math.min(open, close) - spread * 0.3,
      close,
      volume: volBase + Math.floor(rand() * 5) * 250,
    });
  }
  return bars;
};

export const TAPES = {
  // 200 one-minute bars from 2026-01-05 14:30 UTC (09:30 New York, a Monday)
  wavy: makeBars(200, { start: Date.UTC(2026, 0, 5, 14, 30), stepMs: 60000, seed: 12345, base: 100, amp: 6, trend: 0.02, volBase: 1000 }),
  // 100 five-minute bars with a strong upward drift
  trend: makeBars(100, { start: Date.UTC(2026, 0, 6, 14, 30), stepMs: 300000, seed: 777, base: 50, amp: 1.5, trend: 0.12, volBase: 500 }),
  // 50 dead-flat one-minute bars: every price identical (stdev 0, rsi neutral)
  flat: Array.from({ length: 50 }, (_, i) => ({
    date: Date.UTC(2026, 0, 7, 14, 30) + i * 60000,
    open: 100, high: 100, low: 100, close: 100, volume: 1000,
  })),
  // 60 hourly bars spanning the 2026-03-08 US spring-forward DST transition
  dst: makeBars(60, { start: Date.UTC(2026, 2, 7, 12, 0), stepMs: 3600000, seed: 424242, base: 80, amp: 3, trend: 0, volBase: 800 }),
  // warmup edge cases
  single: makeBars(1, { start: Date.UTC(2026, 0, 5, 14, 30), stepMs: 60000, seed: 99, base: 100, amp: 6, trend: 0, volBase: 1000 }),
  empty: [],
};
