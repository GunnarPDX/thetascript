// Conformance corpus case definitions. Each case is one script run against a
// named tape (tapes.js) with optional runScript opts; conformance.test.js
// snapshots the full runScript output into expected/<name>.json. Cases pin
// their timezone (or rely on the spec default, America/New_York) — never
// 'local' — so fixtures are host-independent.
//
// Grouped: language semantics, builtins, time model, inputs, draw functions,
// edge tapes, errors. err-* cases expect error to be non-null; the message
// text is informative, not normative (SPEC.md §Errors).

import { EXAMPLES } from '../src/examples.js';

export const CASES = [
  // ---- semantics ---------------------------------------------------------
  {
    name: 'sem-arithmetic-broadcast',
    tape: 'wavy',
    script: `study("t")
plot(close * 2 + high / 4 - 1)
plot(-close)
plot(close % 7)
plot(10 - 3 * 2)
`,
  },
  {
    name: 'sem-precedence-logic',
    tape: 'wavy',
    script: `study("t")
plot(close > open and volume > 1000 ? high : low)
plot(not (close > open))
plot(close > open or close > close[1] ? 1 : 0)
x = 1 > 2 ? 10 : 20
plot(x)
`,
  },
  {
    name: 'sem-history-offsets',
    tape: 'wavy',
    script: `study("t")
plot(close[1])
plot((high - low)[3])
plot(close[-1])
n = 2
plot(close[n])
plot(close[500])
`,
  },
  {
    // v2: history offsets may vary per bar
    name: 'sem-dynamic-history',
    tape: 'wavy',
    script: `study("t")
plot(close[bar_index % 5])
plot(close[volume / 1000])
`,
  },
  {
    // v2: newlines inside an unclosed paren are plain whitespace
    name: 'sem-multiline-call',
    tape: 'wavy',
    script: `study("t")
plot(sma(close, 10),
  color="#22d3ee",
  width=3,
  title="split across lines")
`,
  },
  {
    name: 'sem-modulo-divzero',
    tape: 'wavy',
    script: `study("t")
plot((bar_index - 5) % 3)
plot(1 / (close - close))
plot((close - close) / (close - close))
plot(0 - 1 / (close - close))
`,
  },
  {
    name: 'sem-nan-truthiness',
    tape: 'wavy',
    script: `study("t")
s = close[1]
plot(s > 0 ? 1 : 0)
plot(s and true ? 1 : 0)
plot(na(s))
plot(nz(s, -5))
plot(na)
`,
  },
  {
    name: 'sem-strings-equality',
    tape: 'wavy',
    script: `study("t")
dir = close > close[1] ? "up" : "down"
plot(dir == "up" ? 1 : 0)
plot(dir != "down" ? 1 : 0)
plot(close == "100" ? 1 : 0)
infopanel(dir, title="Dir")
`,
  },
  {
    name: 'sem-ternary-scalar-vs-series',
    tape: 'wavy',
    script: `study("t")
plot(close > open ? high : low)
plot(2 > 1 ? close : open)
plot(1 < 0 ? close : open)
`,
  },

  // ---- builtins ----------------------------------------------------------
  {
    name: 'fn-moving-averages',
    tape: 'wavy',
    script: `study("t")
plot(sma(close, 5))
plot(ema(close, 5))
plot(wma(close, 5))
plot(rsi(close, 14))
plot(stdev(close, 10))
plot(sma(close, 1))
`,
  },
  {
    name: 'fn-atr-tr',
    tape: 'wavy',
    script: `study("t")
plot(atr(5))
plot(tr())
plot(atr(1))
`,
  },
  {
    name: 'fn-rolling-windows',
    tape: 'wavy',
    script: `study("t")
plot(highest(close, 5))
plot(lowest(close, 5))
plot(sum(volume, 5))
plot(change(close))
plot(change(close, 5))
plot(offset(close, 3))
plot(highest(close, 1000))
`,
  },
  {
    name: 'fn-nested-warmup',
    tape: 'wavy',
    script: `study("t")
plot(sma(sma(close, 5), 5))
plot(ema(change(close, 3), 4))
plot(stdev(close[2], 5))
`,
  },
  {
    name: 'fn-crosses',
    tape: 'wavy',
    script: `study("t")
f = ema(close, 5)
s = ema(close, 20)
plot(crossover(f, s))
plot(crossunder(f, s))
plot(cross(f, s))
plot(cross(close, 100))
`,
  },
  {
    name: 'fn-accumulators',
    tape: 'wavy',
    script: `study("t")
up = close > open
plot(cum(up ? 1 : 0))
plot(cum(close[1]))
plot(barssince(crossover(close, sma(close, 10))))
plot(valuewhen(crossover(close, sma(close, 10)), close))
`,
  },
  {
    name: 'fn-math-elementwise',
    tape: 'wavy',
    script: `study("t")
plot(abs(close - open))
plot(sqrt(volume))
plot(log(close - 200))
plot(exp(close / 100))
plot(round(close))
plot(floor(close))
plot(ceil(close))
plot(sign(close - open))
plot(pow(close - open, 2))
`,
  },
  {
    name: 'fn-min-max-avg-iff',
    tape: 'wavy',
    script: `study("t")
plot(min(open, close, 100))
plot(max(open, close, 100))
plot(avg(open, high, low, close))
plot(iff(close > open, 1, -1))
plot(iff(1, close, open))
plot(nz(close[10], close))
`,
  },

  // ---- time model --------------------------------------------------------
  {
    name: 'time-timestamp-utc',
    tape: 'wavy',
    opts: { timezone: 'UTC' },
    script: `study("t")
plot(time >= timestamp("2026-01-05 15:30") ? 1 : 0)
plot(time >= timestamp(2026, 1, 5, 15, 30) ? 1 : 0)
infopanel(timestamp("2026-01-05"), title="midnight", precision=0)
`,
  },
  {
    name: 'time-timestamp-ny-default',
    tape: 'wavy',
    script: `study("t")
plot(time >= timestamp("2026-01-05 10:30") ? 1 : 0)
infopanel(timestamp("2026-01-05"), title="ny-midnight", precision=0)
infopanel(date_today, title="today", precision=0)
infopanel(market_open, title="open", precision=0)
infopanel(market_close, title="close", precision=0)
`,
  },
  {
    name: 'time-dst-calendar',
    tape: 'dst',
    script: `study("t")
plot(hour(time))
plot(minute(time))
plot(dayofweek(time))
plot(dayofmonth(time))
plot(month(time))
plot(year(time))
`,
  },
  {
    name: 'time-session-custom',
    tape: 'wavy',
    opts: { timezone: 'UTC', session: { open: '08:00', close: '17:15' } },
    script: `study("t")
plot(close)
infopanel(market_open, title="open", precision=0)
infopanel(market_close, title="close", precision=0)
infopanel(current_datetime, title="now", precision=0)
`,
  },

  // ---- inputs ------------------------------------------------------------
  {
    name: 'input-defaults-metadata',
    tape: 'wavy',
    script: `study("t")
len = input.int(9, "Length", minval=2, maxval=50)
off = input.float(0.85, "Offset", step=0.01, tooltip="why")
start = input.time("2026-01-05 15:00", "Start")
plot(sma(close, len) * off)
plot(time >= start ? 1 : 0)
`,
  },
  {
    name: 'input-overrides-clamp',
    tape: 'wavy',
    opts: { timezone: 'UTC', inputs: { Length: 100.6, Offset: -2, Start: '2026-01-05T15:40' } },
    script: `study("t")
len = input.int(9, "Length", minval=2, maxval=50)
off = input.float(0.85, "Offset", step=0.01)
start = input.time("", "Start")
plot(sma(close, len) * off)
plot(time >= start ? 1 : 0)
`,
  },
  {
    name: 'input-duplicate-labels',
    tape: 'wavy',
    opts: { inputs: { Length: 5, 'Length (2)': 7 } },
    script: `study("t")
a = input.int(9, "Length")
b = input.int(21, "Length")
plot(a + b)
`,
  },

  // ---- draw functions ----------------------------------------------------
  {
    name: 'draw-plot-styling',
    tape: 'wavy',
    script: `study("t")
plot(close, color="#ef4444", width=3, title="kw")
plot(open, "#22c55e")
plot(high, "titled", 4)
c = "#ffffff"
plot(low, color=c)
plot(hl2)
plot(hlc3)
plot(ohlc4)
plot(42)
`,
  },
  {
    name: 'draw-hline-fill',
    tape: 'wavy',
    script: `study("t", overlay=false)
r = rsi(close, 14)
p = plot(r, title="rsi")
h = hline(70, color="#ef4444", width=2)
hline(30)
fill(p, h, color="#22d3ee", opacity=0.2)
fill(r, 50)
fill(p, h)
`,
  },
  {
    name: 'draw-plotshape-variants',
    tape: 'wavy',
    script: `study("t")
up = crossover(close, sma(close, 10))
dn = crossunder(close, sma(close, 10))
plotshape(up, shape="triangleup", location="belowbar", color="#22c55e", size=6)
plotshape(dn, shape="triangledown", location="abovebar")
plotshape(up, shape="circle", location="absolute")
plotshape(dn, shape="square")
plotshape(up, shape="cross", location="belowbar")
plotshape(1)
`,
  },
  {
    name: 'draw-trades',
    tape: 'wavy',
    script: `study("t")
buy = crossover(close, sma(close, 10))
sell = crossunder(close, sma(close, 10))
plotbuy(buy)
plotsell(sell, 5)
plotbuy(buy, qty=volume / 1000, color="#26c6da")
plotsell(sell, "oops")
`,
  },
  {
    name: 'draw-infopanel-variants',
    tape: 'wavy',
    script: `study("t")
plot(close)
infopanel(close, title="Last", color="#26c6da", precision=1)
infopanel(close > close[1] ? "up" : "down", title="Dir", color=close > close[1] ? "#22c55e" : "#ef4444")
infopanel(rsi(close, 14))
infopanel(close, precision=99)
infopanel(close, precision=-3)
infopanel("static")
`,
  },
  {
    name: 'draw-barcolor-bgcolor',
    tape: 'wavy',
    script: `study("t")
plot(close)
barcolor(close > open ? "#22c55e" : "#ef4444")
barcolor("#ffffff", when=volume > 1500)
barcolor(close > open ? "#111111" : na)
bgcolor("#ef4444", when=rsi(close, 14) > 60, opacity=0.3)
bgcolor("#22c55e")
`,
  },
  {
    name: 'draw-study-meta',
    tape: 'wavy',
    script: `study("Positional Name", overlay=false, description="a described study")
plot(close)
`,
  },
  {
    name: 'draw-study-kw-title',
    tape: 'wavy',
    script: `study("ignored", title="KW Title")
plot(close)
`,
  },
  {
    name: 'integration-auto-trader',
    tape: 'trend',
    opts: { timezone: 'UTC', inputs: { Length: 13, 'Trade qty': 2.5 } },
    script: EXAMPLES.find(e => e.name === 'YesNo Auto Trader').source,
  },

  // ---- edge tapes --------------------------------------------------------
  {
    name: 'edge-single-bar',
    tape: 'single',
    script: `study("t")
plot(close)
plot(sma(close, 5))
plot(close[1])
plot(crossover(close, open))
plot(cum(close))
infopanel(close, title="last")
`,
  },
  {
    name: 'edge-empty-tape',
    tape: 'empty',
    script: `study("t")
plot(close)
plotbuy(crossover(close, open))
infopanel(close, title="last")
`,
  },
  {
    name: 'edge-flat-tape',
    tape: 'flat',
    script: `study("t")
plot(stdev(close, 10))
plot(rsi(close, 14))
plot(atr(5))
plot(highest(close, 5) - lowest(close, 5))
plot(sign(change(close)))
`,
  },

  // ---- v2: statements, state, functions ----------------------------------
  {
    name: 'v2-var-persistence',
    tape: 'wavy',
    script: `study("t")
var count = 0
var peak = close
if close > open
    count := count + 1
if close > peak
    peak := close
plot(count)
plot(peak)
infopanel(count, title="up bars", precision=0)
`,
  },
  {
    name: 'v2-if-else-chain',
    tape: 'wavy',
    script: `study("t")
r = rsi(close, 14)
var zone = 0
if r > 70
    zone := 1
else if r < 30
    zone := 0 - 1
else
    zone := 0
plot(zone)
`,
  },
  {
    name: 'v2-for-loop',
    tape: 'wavy',
    script: `study("t")
s = 0.0
for k = 0 to 9
    s := s + close[k]
plot(s / 10)
d = 0.0
for k = 4 to 0 by 0 - 1
    d := d + high[k] - low[k]
plot(d)
`,
  },
  {
    name: 'v2-user-functions',
    tape: 'wavy',
    script: `study("t")
double(x) => x * 2
band(src, len, mult) =>
    m = sma(src, len)
    dev = stdev(src, len) * mult
    m + dev
plot(double(close) - close)
plot(band(close, 10, 2))
plot(band(hl2, 20, 1.5))
`,
  },
  {
    name: 'v2-fn-state-per-callsite',
    tape: 'wavy',
    script: `study("t")
smooth(x) => ema(x, 5)
plot(smooth(close))
plot(smooth(volume))
`,
  },
  {
    name: 'v2-barstate',
    tape: 'wavy',
    script: `study("t")
plot(barstate.isfirst)
plot(barstate.islast)
plotshape(barstate.islast, shape="circle", location="absolute")
`,
  },
  {
    name: 'v2-tostring-inputs',
    tape: 'wavy',
    opts: { inputs: { Mode: 'wma', Fast: true } },
    script: `study("t")
mode = input.string("sma", "Mode", options="sma,ema,wma")
fast = input.bool(false, "Fast")
useLen = fast ? 5 : 20
plot(mode == "wma" ? wma(close, useLen) : mode == "ema" ? ema(close, useLen) : sma(close, useLen))
infopanel(mode, title="Mode")
infopanel(tostring(close, 2), title="Close")
infopanel(tostring(rsi(close, 14), 1), title="RSI")
`,
  },
  {
    name: 'v2-new-mas',
    tape: 'wavy',
    script: `study("t")
plot(dema(close, 10))
plot(tema(close, 10))
plot(hull(close, 10))
plot(tma(close, 10))
plot(wilders(close, 10))
plot(linreg(close, 10))
`,
  },
  {
    name: 'v2-new-oscillators',
    tape: 'wavy',
    script: `study("t")
plot(roc(close, 5))
plot(mom(close, 5))
plot(stoch(14))
plot(mfi(14))
plot(obv())
`,
  },
  {
    name: 'v2-pivots-extremes',
    tape: 'wavy',
    script: `study("t")
plot(pivothigh(3, 3))
plot(pivotlow(3, 3))
plot(highestbars(close, 10))
plot(lowestbars(close, 10))
plot(rising(close, 3))
plot(falling(close, 3))
`,
  },
  {
    name: 'v2-vwap-sessions',
    tape: 'dst',
    script: `study("t")
plot(vwap())
plot(vwap(close))
`,
  },
  {
    name: 'v2-vwap-anchors',
    tape: 'dst',
    script: `study("t")
plot(vwap(hlc3, "session"))
plot(vwap(hlc3, "week"))
plot(vwap(hlc3, "month"))
`,
  },
  {
    name: 'v2-arrays-basic',
    tape: 'wavy',
    script: `study("t")
var buf = array.new()
array.push(buf, close)
if array.size(buf) > 10
    dropped = array.shift(buf)
plot(array.avg(buf))
plot(array.size(buf))
plot(array.min(buf))
plot(array.max(buf))
plot(array.sum(buf))
infopanel(array.last(buf), title="last")
infopanel(array.first(buf), title="first")
`,
  },
  {
    name: 'v2-arrays-refs',
    tape: 'wavy',
    script: `study("t")
var a = array.new(3, 0)
b = a
array.set(b, bar_index % 3, close)
plot(array.get(a, 0))
plot(array.get(a, 1))
plot(array.get(a, 2))
fresh = array.new(2, close)
plot(array.get(fresh, 0) + array.get(fresh, 1))
plot(array.get(fresh, 5))
total = 0.0
for k = 0 to array.size(a) - 1
    total := total + array.get(a, k)
plot(total)
`,
  },
  {
    name: 'v2-plot-styles',
    tape: 'wavy',
    script: `study("t", overlay=false)
plot(volume, style="histogram", color="#22d3ee")
plot(sma(close, 10), style="area")
plot(close, style="stepline", linestyle="dashed")
plot(rsi(close, 14), style="circles", width=3)
`,
  },
  {
    name: 'v2-strategy-basic',
    tape: 'wavy',
    script: `study("t")
fast = ema(close, 5)
slow = ema(close, 20)
strategy.buy(crossover(fast, slow), 10)
strategy.sell(crossunder(fast, slow), 10)
plot(strategy.position_size)
plot(strategy.realized_pnl)
plot(strategy.equity)
infopanel(strategy.trades, title="trades", precision=0)
infopanel(strategy.wins, title="wins", precision=0)
`,
  },
  {
    name: 'v2-strategy-stops',
    tape: 'wavy',
    script: `study("t")
sig = crossover(close, sma(close, 20))
strategy.buy(sig, qty=5, stop_loss=1.5, take_profit=3, trailing=2)
plot(strategy.position_size)
plot(strategy.open_pnl)
`,
  },
  {
    name: 'v2-trade-prices',
    tape: 'wavy',
    script: `study("t")
buy = crossover(close, sma(close, 10))
sell = crossunder(close, sma(close, 10))
plotbuy(buy, 2, price="low")
plotsell(sell, 2, price="high")
plotbuy(buy, 1, price=hl2)
plotsell(sell, 1)
plotbuy(buy, 3, price="open")
`,
  },
  {
    name: 'v2-control-flow',
    tape: 'wavy',
    script: `study("t")
s = 0.0
k = 0
while k < 30
    k := k + 1
    if k % 2 == 0
        continue
    if k > 15
        break
    s := s + k
plot(s)
r = 0
switch bar_index % 3
    0 => r := 10
    1 => r := 11
    => r := 12
plot(r)
`,
  },
  {
    name: 'v2-security-mtf',
    tape: 'wavy',
    script: `study("t")
plot(security("5m", close))
plot(security("5m", high))
plot(security("15m", sma(close, 3)))
plot(security("1h", ema(close, 2)))
`,
  },
  {
    name: 'v2-security-daily',
    tape: 'dst',
    script: `study("t")
plot(security("1d", close))
plot(security("1d", tr()))
plot(security("1w", close))
plot(security("4h", hlc3))
`,
  },
  {
    name: 'v2-strategy-depth',
    tape: 'wavy',
    script: `study("t")
strategy.config(initial_capital=50000, commission_percent=0.1, commission_cash=0.5, slippage=0.02, pyramiding=1)
up = crossover(close, sma(close, 10))
down = crossunder(close, sma(close, 10))
strategy.buy(up, qty=5, qty_type="percent_of_equity")
strategy.buy(up, qty=5, qty_type="percent_of_equity")
strategy.sell(down, qty=2000, qty_type="cash")
plot(strategy.position_size)
plot(strategy.equity)
`,
  },
  {
    name: 'v2-strategy-pending',
    tape: 'wavy',
    script: `study("t")
strategy.buy(bar_index == 5, 10, limit=close - 1.5)
strategy.sell(bar_index == 60, 10, stop=close - 1.5, expires=15)
strategy.buy(bar_index == 120, 10, stop=close + 1, expires=30)
plot(strategy.position_size)
plot(strategy.realized_pnl)
`,
  },
  {
    name: 'v2-draw-objects',
    tape: 'wavy',
    script: `study("t")
piv = pivothigh(2, 2)
label.new(bar_index, high + 1, tostring(high, 1), color="#ec407a", when=not na(piv))
line.new(bar_index - 5, close[5], bar_index, close, color="#26c6da", style="dashed", when=bar_index % 40 == 0)
box.new(bar_index - 3, high, bar_index, low, bgcolor="#22c55e", when=bar_index % 50 == 25)
plot(close)
`,
  },
  {
    name: 'v2-indicators-directional',
    tape: 'wavy',
    script: `study("t")
plot(adx(14))
plot(diplus(14))
plot(diminus(14))
plot(aroonup(10))
plot(aroondown(10))
plot(cci(14))
plot(willr(14))
`,
  },
  {
    name: 'v2-indicators-overlay',
    tape: 'wavy',
    script: `study("t")
plot(sar(0.02, 0.02, 0.2))
plot(supertrend(10, 3))
plot(supertrend_dir(10, 3))
plot(correlation(close, volume, 10))
plot(percentile(close, 10, 90))
plot(median(close, 10))
plot(alma(close, 9))
`,
  },
  {
    name: 'v2-trig-strings',
    tape: 'wavy',
    script: `study("t")
plot(sin(close / 10) + cos(close / 10))
plot(tan(pi / 8))
plot(atan2(high - low, 1))
plot(asin(1) + acos(1) + atan(1))
plot(str.length(str.format("c={0} v={1}", close, volume)))
parts = str.split("a,b,c,d", ",")
plot(array.size(parts))
infopanel(str.upper("up") + "/" + str.lower("DOWN"), title="U")
infopanel(str.replace("x.y.z", ".", "-"), title="R")
infopanel(str.contains("hello", "ell"), title="C")
`,
  },
  {
    name: 'v2-alert-placeholders',
    tape: 'wavy',
    script: `study("t")
r = rsi(close, 14)
plot(r)
alertcondition(crossover(r, 60), title="Hot", message="rsi over 60: close={{close}} hi={{high}} t={{time}} i={{bar_index}}")
alertcondition(crossover(r, 60), title="Plain", message="no placeholders")
`,
  },
  {
    name: 'v2-alerts',
    tape: 'wavy',
    script: `study("t")
r = rsi(close, 14)
plot(r)
alertcondition(crossover(r, 70), title="Overbought", message="RSI crossed above 70")
alertcondition(crossunder(r, 30), title="Oversold")
`,
  },

  // ---- errors (message text informative, not normative) ------------------
  { name: 'err-unknown-variable', tape: 'wavy', script: 'plot(closee)\n' },
  { name: 'err-unknown-function', tape: 'wavy', script: 'plot(smaa(close, 5))\n' },
  { name: 'err-malformed-number', tape: 'wavy', script: 'x = 1.2.3\nplot(close)\n' },
  { name: 'err-unterminated-string', tape: 'wavy', script: 'plot(close, color="#fff\n' },
  { name: 'err-plot-color-series', tape: 'wavy', script: 'plot(close, color=close > open ? "#fff" : "#000")\n' },
  { name: 'err-trade-color-series', tape: 'wavy', script: 'plotbuy(close > open, color=close > open ? "#fff" : "#000")\n' },
  { name: 'err-trade-price-invalid', tape: 'wavy', script: 'plotbuy(close > open, price="typo")\n' },
  { name: 'err-trade-price-kind-change', tape: 'wavy', script: 'plotbuy(close > open, price=close > open ? "open" : "high")\n' },
  { name: 'err-break-outside-loop', tape: 'wavy', script: 'break\nplot(close)\n' },
  { name: 'err-security-nested', tape: 'wavy', script: 'plot(security("5m", security("1h", close)))\n' },
  { name: 'err-security-in-block', tape: 'wavy', script: 'x = 1\nif x > 0\n    y = security("5m", close)\nplot(close)\n' },
  { name: 'err-security-bad-tf', tape: 'wavy', script: 'plot(security("zz", close))\n' },
  { name: 'err-order-limit-and-stop', tape: 'wavy', script: 'strategy.buy(true, 1, limit=1, stop=2)\n' },
  { name: 'err-qty-type', tape: 'wavy', script: 'strategy.buy(true, 1, qty_type="lots")\n' },
  { name: 'err-fill-one-arg', tape: 'wavy', script: 'p = plot(close)\nfill(p)\n' },
  { name: 'err-draws-nothing', tape: 'wavy', script: 'x = sma(close, 5)\n' },
  { name: 'err-empty-script', tape: 'wavy', script: '' },
  { name: 'err-bad-period', tape: 'wavy', script: 'plot(sma(close, "9"))\n' },
  { name: 'err-reassign-undeclared', tape: 'wavy', script: 'x := 5\nplot(close)\n' },
  { name: 'err-var-plain-reassign', tape: 'wavy', script: 'var x = 1\nx = 2\nplot(close)\n' },
  { name: 'err-assign-source', tape: 'wavy', script: 'close = 5\nplot(close)\n' },
  { name: 'err-draw-in-block', tape: 'wavy', script: 'if close > open\n    plot(close)\n' },
  {
    name: 'err-fn-recursion',
    tape: 'wavy',
    script: 'f(x) => f(x) + 1\nplot(f(close))\n',
  },
  { name: 'err-array-set-oob', tape: 'wavy', script: 'var a = array.new(2)\narray.set(a, 5, 1)\nplot(close)\n' },
  { name: 'err-array-type', tape: 'wavy', script: 'array.push(close, 1)\nplot(close)\n' },
  {
    name: 'err-loop-limit',
    tape: 'single',
    script: 'x = 0.0\nfor k = 0 to 200000\n    x := x + 1\nplot(x)\n',
  },
  {
    name: 'err-length-change',
    tape: 'wavy',
    script: 'plot(sma(close, bar_index + 1))\n',
  },

  // ---- 2.4.0: correctness-release coverage --------------------------------
  {
    name: 'v2-fn-scoping',
    tape: 'wavy',
    // the function sees its params and the script scope; := from inside a
    // function writes the script variable, never a caller block-local
    script: 'g = 10\nbump(v) => v + g\ntotal = 0.0\nif close > open\n    total := bump(close) - close\nplot(total)\n',
  },
  {
    name: 'v2-vwap-anchor-arg',
    tape: 'dst',
    // a string first arg is the anchor with the default hlc3 source
    script: 'plot(vwap("week"))\nplot(vwap(close, "session"))\n',
  },
  {
    name: 'v2-percentile-clamp',
    tape: 'wavy',
    // out-of-range ranks clamp to the window extremes instead of leaking
    // undefined
    script: 'plot(percentile(close, 4, 200))\nplot(percentile(close, 4, -50))\nplot(highest(close, 4))\nplot(lowest(close, 4))\n',
  },
  {
    name: 'v2-window-infinity',
    tape: 'wavy',
    // an Infinity poisons rolling windows only while it is inside them —
    // sum/stdev/rsi all recover once it slides out
    script: 'x = bar_index == 5 ? 1 / 0 : close\nplot(sum(x, 3))\nplot(stdev(x, 3))\nplot(rsi(x, 4))\n',
  },
  {
    name: 'v2-numeric-coercion',
    tape: 'wavy',
    // strings feeding numeric machinery read as NaN instead of silently
    // concatenating; arrays render "[array]" in string contexts
    script: 'a = array.new(2)\nplot(sma(tostring(close), 3))\nplot(cum("x"))\nplot(str.length("pre" + a))\nplot(min("5", 3))\nplot(iff(false, 1))\n',
  },
  {
    name: 'v2-kwarg-eval-order',
    tape: 'wavy',
    // kwargs evaluate before positional args: the push in title= lands
    // before array.size reads, so the plot pins 1 every bar
    script: 'a = array.new(0)\nplot(array.size(a), title=tostring(array.push(a, close)))\n',
  },
  {
    name: 'v2-strategy-trailing-anchor',
    tape: 'wavy',
    // trailing anchors: the entry bar's own range never arms the trail, and
    // the pyramiding add at bar 20 must not loosen the armed extreme
    script: 'strategy.config(pyramiding=3)\nstrategy.buy(bar_index == 10 or bar_index == 20, 5, trailing=2.5)\nplot(strategy.position_size)\nplot(strategy.equity)\n',
  },
  {
    name: 'v2-strategy-short-stops',
    tape: 'wavy',
    // short-side protective exits: stop above, target below, trailing from
    // the low watermark
    script: 'strategy.sell(bar_index == 5, 10, stop_loss=3, take_profit=4)\nstrategy.sell(bar_index == 90, 10, trailing=2)\nplot(strategy.position_size)\nplot(strategy.realized_pnl)\n',
  },
  {
    name: 'v2-strategy-pending-pct',
    tape: 'wavy',
    // percent_of_equity resolved at a pending fill, expiry, and the
    // NaN-limit no-op (close[1] is na on bar 0 — the order is dropped, not
    // filled at market)
    script: 'strategy.config(initial_capital=20000)\nstrategy.buy(bar_index == 0, 10, limit=close[1] - 1)\nstrategy.buy(bar_index == 30, 40, qty_type="percent_of_equity", limit=close - 0.3, expires=15)\nstrategy.sell(bar_index == 120, 100, qty_type="percent_of_equity")\nplot(strategy.position_size)\nplot(strategy.trades)\n',
  },
  {
    name: 'v2-timestamp-edge',
    tape: 'wavy',
    // NaN components read na; the spring-forward gap and fall-back
    // ambiguity resolve deterministically via the two-pass offset refinement
    script: 'plot(timestamp(2026, na, 1))\nplot(timestamp("2026-03-08 02:30"))\nplot(timestamp("2026-11-01 01:30"))\nplot(timestamp(2026, 3, 8, 2, 30))\n',
  },
  { name: 'err-array-too-big', tape: 'single', script: 'a = array.new(3000000000)\nplot(close)\n' },
  { name: 'err-period-too-big', tape: 'single', script: 'plot(sma(close, 200000))\n' },
  { name: 'err-security-zero-tf', tape: 'wavy', script: 'plot(security("0m", close))\n' },
  { name: 'err-fn-param-commas', tape: 'single', script: 'f(a b) => a + b\nplot(f(1, 2))\n' },
  { name: 'err-dup-kwarg', tape: 'single', script: 'plot(close, color="#fff", color="#000")\n' },
  {
    name: 'err-depth',
    tape: 'single',
    script: `plot(${'('.repeat(501)}close${')'.repeat(501)})\n`,
  },
  { name: 'err-while-security', tape: 'wavy', script: 'k = 0\nwhile security("5m", volume) > k\n    k := k + 5000\nplot(k)\n' },
  {
    name: 'err-var-redecl',
    tape: 'single',
    // errors on the single-bar tape too — declaration conflicts must not
    // depend on bar count
    script: 'x = 1\nvar x = 2\nplot(x)\n',
  },
  {
    name: 'err-fn-block-local-leak',
    tape: 'wavy',
    // the function body must NOT resolve the caller's block-local `t`
    script: 'g() => t + 1\nx = 0.0\nif close > 0\n    t = 5\n    x := g()\nplot(x)\n',
  },
  { name: 'err-vwap-anchor-change', tape: 'wavy', script: 'plot(vwap(close, bar_index == 0 ? "week" : "month"))\n' },
  { name: 'err-min-empty', tape: 'single', script: 'plot(min())\n' },
];
