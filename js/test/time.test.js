import { runScript } from '../src/interpreter.js';
import { parseTimestamp, epochFromWall } from '../src/time.js';

// 50 one-minute bars starting Mon 2026-01-05 15:00 UTC (10:00 New York).
// All expectations are built with Date.UTC so the tests pass on any host,
// in any local timezone.
const T0 = Date.UTC(2026, 0, 5, 15, 0);
const BARS = Array.from({ length: 50 }, (_, i) => {
  const c = 100 + i;
  return { date: new Date(T0 + i * 60000), open: c, high: c + 1, low: c - 1, close: c, volume: 1000 };
});
const UTC = { timezone: 'UTC' };

test('time source and timestamp() gate signals by date', () => {
  const src = `study("T")
plotbuy(time >= timestamp(2026, 1, 5, 15, 30), 1)
plotsell(time >= timestamp("2026-01-05 15:30"), 1)
`;
  const res = runScript(src, BARS, UTC);
  expect(res.error).toBeNull();
  // both timestamp forms name the same cutoff: bar 30 of 50
  res.trades.forEach(tr => {
    const fired = tr.values.map((v, i) => (v ? i : -1)).filter(i => i >= 0);
    expect(fired[0]).toBe(30);
    expect(fired).toHaveLength(20);
  });
});

test('the default session timezone is New York, not the host clock', () => {
  // 10:30 New York on 2026-01-05 (EST, UTC-5) is 15:30 UTC — the same cutoff
  // as the UTC test above, reached with no timezone option at all
  const src = `study("T")
plotbuy(time >= timestamp("2026-01-05 10:30"), 1)
`;
  const res = runScript(src, BARS);
  expect(res.error).toBeNull();
  const fired = res.trades[0].values.map((v, i) => (v ? i : -1)).filter(i => i >= 0);
  expect(fired[0]).toBe(30);
});

test('input.time: na when unset, string override parses and filters', () => {
  const src = `study("T")
s = input.time("", "Start")
plotbuy(na(s) or time >= s, 1)
`;
  const res = runScript(src, BARS, UTC);
  expect(res.error).toBeNull();
  expect(res.inputs[0]).toMatchObject({ type: 'time', label: 'Start', text: '' });
  expect(Number.isNaN(res.inputs[0].value)).toBe(true);
  // unset date means no limit — every bar fires
  expect(res.trades[0].values.every(v => v === 1)).toBe(true);

  const over = runScript(src, BARS, { ...UTC, inputs: { Start: '2026-01-05T15:40' } });
  expect(over.inputs[0].value).toBe(Date.UTC(2026, 0, 5, 15, 40));
  expect(over.trades[0].values.filter(Boolean)).toHaveLength(10);
});

test('date-only strings parse as session-timezone midnight', () => {
  const src = `study("T")
plot(close)
infopanel(timestamp("2026-01-05"), title="t")
`;
  expect(runScript(src, BARS, UTC).panel[0].value).toBe(Date.UTC(2026, 0, 5));
  // New York midnight is 05:00 UTC in January (EST)
  expect(runScript(src, BARS).panel[0].value).toBe(Date.UTC(2026, 0, 5, 5, 0));
});

test('calendar extractors and now scalars track the latest bar', () => {
  const src = `study("T")
infopanel(hour(current_datetime), title="h")
infopanel(minute(current_datetime), title="m")
infopanel(dayofweek(current_datetime), title="dow")
infopanel(current_datetime >= market_open and current_datetime <= market_close ? "open" : "closed", title="mkt")
infopanel(date_today, title="midnight")
infopanel(market_open, title="open")
`;
  const res = runScript(src, BARS, UTC);
  expect(res.error).toBeNull();
  // latest bar: 2026-01-05 15:49 UTC, a Monday
  expect(res.panel[0].value).toBe(15);
  expect(res.panel[1].value).toBe(49);
  expect(res.panel[2].value).toBe(1);
  // 15:49 sits inside the default 09:30–16:00 session read on the UTC clock
  expect(res.panel[3].value).toBe('open');
  expect(res.panel[4].value).toBe(Date.UTC(2026, 0, 5));
  expect(res.panel[5].value).toBe(Date.UTC(2026, 0, 5, 9, 30));

  // default zone: the same bars read as New York wall time (10:49, EST)
  const ny = runScript(src, BARS);
  expect(ny.panel[0].value).toBe(10);
  expect(ny.panel[4].value).toBe(Date.UTC(2026, 0, 5, 5, 0)); // NY midnight
  expect(ny.panel[5].value).toBe(Date.UTC(2026, 0, 5, 14, 30)); // 09:30 NY
});

test('session config overrides the market open/close wall times', () => {
  const src = `study("T")
plot(close)
infopanel(market_open, title="open")
infopanel(market_close, title="close")
`;
  const res = runScript(src, BARS, { ...UTC, session: { open: '08:00', close: '17:15' } });
  expect(res.panel[0].value).toBe(Date.UTC(2026, 0, 5, 8, 0));
  expect(res.panel[1].value).toBe(Date.UTC(2026, 0, 5, 17, 15));
});

test('DST: New York wall times stay on the wall clock across the transition', () => {
  // EST (UTC-5) in January, EDT (UTC-4) in July
  expect(parseTimestamp('2026-01-05 09:30', 'America/New_York')).toBe(Date.UTC(2026, 0, 5, 14, 30));
  expect(parseTimestamp('2026-07-06 09:30', 'America/New_York')).toBe(Date.UTC(2026, 6, 6, 13, 30));
  // 2026-03-08 is the spring-forward day: midnight is still EST, 09:30 is
  // already EDT — 9.5 wall hours apart but only 8.5 real hours
  const mid = epochFromWall(2026, 3, 8, 0, 0, 'America/New_York');
  const open = epochFromWall(2026, 3, 8, 9, 30, 'America/New_York');
  expect(mid).toBe(Date.UTC(2026, 2, 8, 5, 0));
  expect(open).toBe(Date.UTC(2026, 2, 8, 13, 30));
});

test('parseTimestamp accepts date, date+time and seconds; rejects junk', () => {
  expect(parseTimestamp('2026-01-05T10:30:45', 'UTC')).toBe(Date.UTC(2026, 0, 5, 10, 30, 45));
  expect(Number.isNaN(parseTimestamp('', 'UTC'))).toBe(true);
  expect(Number.isNaN(parseTimestamp('not a date', 'UTC'))).toBe(true);
  expect(Number.isNaN(parseTimestamp(null, 'UTC'))).toBe(true);
});
