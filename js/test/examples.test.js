import { runScript } from '../src/interpreter.js';
import { DEFAULT_SCRIPT, EXAMPLES } from '../src/examples.js';

// wavy tape long enough to clear every example's warmup (50-bar SMA, RSI,
// MACD); UTC bar dates so the date-keyed tests pass on any host
const BARS = Array.from({ length: 200 }, (_, i) => {
  const mid = 100 + Math.sin(i / 9) * 8 + i * 0.05;
  return {
    date: new Date(Date.UTC(2026, 0, 1, 9, 30 + i)), rank: i,
    open: mid - 0.4, high: mid + 1, low: mid - 1, close: mid + 0.4,
    volume: 1000 + (i % 5) * 300,
  };
});

test('the default script and every editor example run without error', () => {
  [{ name: 'default', source: DEFAULT_SCRIPT }, ...EXAMPLES].forEach(ex => {
    const res = runScript(ex.source, BARS);
    expect(`${ex.name}: ${res.error}`).toBe(`${ex.name}: null`);
  });
});

test('auto trader example strictly alternates buys and sells, buy first', () => {
  const ex = EXAMPLES.find(e => e.name === 'YesNo Auto Trader');
  const res = runScript(ex.source, BARS);
  expect(res.trades).toHaveLength(2);
  const [buy, sell] = res.trades;
  expect(buy.side).toBe('buy');
  expect(sell.side).toBe('sell');
  // interleave the fire bars: the wavy tape must produce several trades, the
  // first must be a buy, and no side may ever fire twice in a row
  const fires = [];
  BARS.forEach((_, i) => {
    if (buy.values[i]) fires.push('buy');
    if (sell.values[i]) fires.push('sell');
  });
  expect(fires.length).toBeGreaterThan(2);
  expect(fires[0]).toBe('buy');
  fires.forEach((side, k) => {
    if (k > 0) expect(side).not.toBe(fires[k - 1]);
  });
  // qty input flows through to every marker
  expect(buy.qty[BARS.length - 1]).toBe(10);
  // info panel: votes, position, open P&L pair, total (realized) P&L pair, win rate
  expect(res.panel).toHaveLength(7);
  expect(res.panel.map(p => p.title)).toEqual([
    'Votes (of 6)', 'Position', 'Open P&L $', 'Open P&L %', 'Total P&L $', 'Total P&L %', 'Win/loss',
  ]);
  const [, pos, pnlCash, pnlPct, totCash, totPct, winLoss] = res.panel;
  if (pos.value === 'long') {
    expect(typeof pnlCash.value).toBe('number');
    expect(typeof pnlPct.value).toBe('number');
    expect(Math.sign(pnlCash.value)).toBe(Math.sign(pnlPct.value));
  } else {
    expect(pnlCash.value).toBe('—');
    expect(pnlPct.value).toBe('—');
  }
  // recompute realized P&L and win rate from the fired markers: each sell
  // closes the round trip opened by the preceding buy, at 10 shares per trade
  let expected = 0, entry = null, wins = 0, closed = 0;
  BARS.forEach((b, i) => {
    if (buy.values[i]) entry = b.close;
    if (sell.values[i] && entry != null) {
      expected += (b.close - entry) * 10;
      closed += 1;
      if (b.close > entry) wins += 1;
      entry = null;
    }
  });
  expect(totCash.value).toBeCloseTo(expected);
  expect(Math.sign(totCash.value)).toBe(Math.sign(totPct.value));
  if (closed > 0) expect(winLoss.value).toBe(`${wins}/${closed - wins}`);
  else expect(winLoss.value).toBe('—');
});

test('auto trader start-date input suppresses all trades before it', () => {
  const ex = EXAMPLES.find(e => e.name === 'YesNo Auto Trader');
  // bar 100 of the tape is 2026-01-01 11:10 UTC
  const res = runScript(ex.source, BARS, { timezone: 'UTC', inputs: { 'Start date': '2026-01-01T11:10' } });
  expect(res.error).toBeNull();
  const fired = res.trades.flatMap(tr => tr.values.map((v, i) => (v ? i : -1)).filter(i => i >= 0));
  expect(fired.length).toBeGreaterThan(0);
  fired.forEach(i => expect(i).toBeGreaterThanOrEqual(100));
});

test('infopanel rows resolve titles, latest values, and string labels', () => {
  const src = `study("P", overlay=true)
plot(close)
infopanel(close, title="Last", color="#26c6da", precision=1)
infopanel(close > close[1] ? "up" : "down", title="Dir", color=close > close[1] ? "#22c55e" : "#ef4444")
infopanel(rsi(close, 14))
`;
  const res = runScript(src, BARS);
  expect(res.error).toBeNull();
  expect(res.panel).toHaveLength(3);
  expect(res.panel[0]).toMatchObject({ title: 'Last', color: '#26c6da', precision: 1 });
  expect(res.panel[0].value).toBeCloseTo(BARS[BARS.length - 1].close);
  expect(['up', 'down']).toContain(res.panel[1].value);
  // a per-bar color ternary resolves to the latest bar's color, matching the value
  expect(res.panel[1].color).toBe(res.panel[1].value === 'up' ? '#22c55e' : '#ef4444');
  expect(res.panel[2].title).toBe('Value 3'); // untitled rows get an ordinal
});
