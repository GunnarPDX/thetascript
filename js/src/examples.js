// Sample scripts: the editor's starting source for a new script, and the
// importable examples shown in its docs panel. examples.test.js runs every
// one of these against a synthetic tape, so each example is guaranteed to
// parse and execute on the current engine. tags are display metadata for the
// examples browser.

export const DEFAULT_SCRIPT = `study("My Script", overlay=true, description="")
fast = ema(close, 12)
slow = ema(close, 26)
plot(fast, color="#22d3ee", title="Fast EMA")
plot(slow, color="#f59e0b", title="Slow EMA")
`;

export const EXAMPLES = [
  {
    name: 'EMA Cross Signals',
    blurb: 'Two moving averages with triangle markers stamped on the bars where they cross.',
    tags: ['plotshape', 'crossover'],
    source: `study("EMA Cross Signals", description="Fast/slow EMA crosses with signal arrows", overlay=true)
fast = ema(close, 9)
slow = ema(close, 21)
plot(fast, color="#22d3ee", title="Fast")
plot(slow, color="#f59e0b", title="Slow")
plotshape(crossover(fast, slow), shape="triangleup", location="belowbar", color="#22c55e")
plotshape(crossunder(fast, slow), shape="triangledown", location="abovebar", color="#ef4444")
`,
  },
  {
    name: 'Bollinger Bands',
    blurb: 'Classic bands built from sma + stdev, with fill() shading the channel between plot references.',
    tags: ['fill', 'stdev'],
    source: `study("Bollinger Bands", description="SMA basis with 2-sigma bands and channel fill", overlay=true)
mid = sma(close, 20)
dev = stdev(close, 20) * 2
u = plot(mid + dev, color="#22d3ee", title="Upper")
l = plot(mid - dev, color="#22d3ee", title="Lower")
plot(mid, color="#f59e0b", title="Basis")
fill(u, l, color="#22d3ee", opacity=0.08)
`,
  },
  {
    name: 'RSI Pane',
    blurb: 'overlay=false gives the script its own pane; hline() marks the 70/30 zones.',
    tags: ['pane', 'hline'],
    source: `study("RSI", description="Relative Strength Index with 70/30 zones", overlay=false)
r = rsi(close, 14)
plot(r, color="#a78bfa", width=2)
hline(70, color="#ef4444")
hline(50)
hline(30, color="#22c55e")
`,
  },
  {
    name: 'Trend Bar Coloring',
    blurb: 'barcolor() repaints the price candles from a ternary color series — green above the trend, red below.',
    tags: ['barcolor'],
    source: `study("Trend Bars", description="Candles painted by their side of the 50 EMA", overlay=true)
trend = ema(close, 50)
plot(trend, color="#f59e0b", title="Trend")
barcolor(close > trend ? "#22c55e" : "#ef4444")
`,
  },
  {
    name: 'Overbought Zones',
    blurb: 'bgcolor() washes the background behind stretched bars; when= gates which bars get painted.',
    tags: ['bgcolor'],
    source: `study("Overbought Zones", description="Background washes where RSI is stretched", overlay=true)
r = rsi(close, 14)
plot(sma(close, 20), color="#38bdf8")
bgcolor("#ef4444", when=r > 70, opacity=0.14)
bgcolor("#22c55e", when=r < 30, opacity=0.14)
`,
  },
  {
    name: 'Session VWAP Bands',
    blurb: 'Session-anchored VWAP (resets each trading day in the chart timezone) with deviation bands and a cross-under alert.',
    tags: ['vwap', 'fill', 'alerts'],
    source: `study("Session VWAP", description="Session-anchored VWAP with deviation bands", overlay=true)
v = vwap()
dev = stdev(close, 30)
u = plot(v + dev * 2, color="#a78bfa", title="Upper")
lo = plot(v - dev * 2, color="#a78bfa", title="Lower")
plot(v, color="#f5b942", width=2, title="VWAP")
fill(u, lo, color="#a78bfa", opacity=0.07)
alertcondition(crossunder(close, v), title="Below VWAP", message="Price crossed under session VWAP")
`,
  },
  {
    name: 'Pivot Levels',
    blurb: 'Confirmed swing highs/lows from pivothigh()/pivotlow(), carried forward with valuewhen() as stepped support and resistance.',
    tags: ['pivots', 'stepline', 'valuewhen'],
    source: `study("Pivot Levels", description="Confirmed swing pivots carried forward as support/resistance", overlay=true)
left = input.int(3, "Left bars", minval=1)
right = input.int(3, "Right bars", minval=1)
ph = pivothigh(left, right)
pl = pivotlow(left, right)
res = valuewhen(not na(ph), ph)
sup = valuewhen(not na(pl), pl)
plot(res, color="#ec407a", style="stepline", linestyle="dashed", title="Resistance")
plot(sup, color="#26c6da", style="stepline", linestyle="dashed", title="Support")
plotshape(not na(ph), shape="triangledown", location="abovebar", color="#ec407a", size=3)
plotshape(not na(pl), shape="triangleup", location="belowbar", color="#26c6da", size=3)
`,
  },
  {
    name: 'Pivot Memory',
    blurb: 'Arrays as rolling memory: the last N confirmed swing highs/lows are kept in array.new() buffers and averaged into stepped support/resistance.',
    tags: ['arrays', 'pivots', 'stepline'],
    source: `study("Pivot Memory", description="Average of the last N confirmed swing pivots, from array memory", overlay=true)
keep = input.int(5, "Pivots to keep", minval=1, maxval=20)
var highs = array.new()
var lows = array.new()
ph = pivothigh(3, 3)
pl = pivotlow(3, 3)
if not na(ph)
    array.push(highs, ph)
if array.size(highs) > keep
    dropped = array.shift(highs)
if not na(pl)
    array.push(lows, pl)
if array.size(lows) > keep
    dropped = array.shift(lows)
plot(array.avg(highs), color="#ec407a", style="stepline", title="Avg resistance")
plot(array.avg(lows), color="#26c6da", style="stepline", title="Avg support")
infopanel(tostring(array.size(highs), 0) + "/" + tostring(array.size(lows), 0), title="Pivots stored")
`,
  },
  {
    name: 'Volume Dashboard',
    blurb: 'A pane with plot styles: volume as a histogram under its average line, plus OBV and money-flow readouts in the info panel.',
    tags: ['pane', 'histogram', 'obv', 'mfi'],
    source: `study("Volume Dashboard", description="Volume histogram with flow readouts", overlay=false)
plot(volume, style="histogram", color="#3b82f6", title="Volume")
plot(sma(volume, 20), color="#f59e0b", width=2, title="Average")
infopanel(obv(), title="OBV", precision=0)
infopanel(mfi(14), title="MFI", precision=1)
barcolor(volume > sma(volume, 20) * 2 ? "#26c6da" : na)
`,
  },
  {
    name: 'Trend Strength Meter',
    blurb: 'A user function with a for loop counts rising bars over a window; the background shades by strength and the info panel formats it with tostring().',
    tags: ['function', 'for', 'tostring'],
    source: `study("Trend Strength", description="Rising-bar ratio over a window, shading the background", overlay=true)
lookback = input.int(10, "Window", minval=2, maxval=50)
strength(n) =>
    s = 0.0
    for k = 0 to n - 1
        s := s + (close[k] > close[k + 1] ? 1 : 0)
    s / n
st = strength(lookback)
plot(ema(close, 20), color="#f5b942", title="Trend")
bgcolor("#26c6da", when=st > 0.65, opacity=0.12)
bgcolor("#ec407a", when=st < 0.35, opacity=0.12)
infopanel("Strength " + tostring(st * 100, 0) + "%", title="Trend", color=st > 0.5 ? "#26c6da" : "#ec407a")
`,
  },
  {
    name: 'Breakout Strategy',
    blurb: 'Buys 20-bar breakouts with an ATR-scaled stop-loss and take-profit; the strategy engine tracks fills, the ledger and P&L.',
    tags: ['strategy', 'stops', 'atr'],
    source: `study("Breakout Strategy", description="Channel breakouts with ATR-scaled protective exits", overlay=true)
lookback = input.int(20, "Lookback", minval=5)
stopMult = input.float(1.5, "Stop ATR mult", step=0.1, minval=0.1)
qty = input.float(10, "Qty", minval=0.01)
hh = highest(high, lookback)
plot(hh, color="#22d3ee", linestyle="dashed", title="Breakout level")
a = atr(14)
brk = close > hh[1]
strategy.buy(brk and strategy.position_size == 0, qty=qty, stop_loss=a * stopMult, take_profit=a * 3)
plotshape(brk, shape="triangleup", location="belowbar", color="#26c6da", size=3)
infopanel(strategy.trades, title="Trades", precision=0)
infopanel(strategy.realized_pnl, title="Realized P&L")
infopanel(strategy.open_pnl, title="Open P&L")
`,
  },
  {
    name: 'YesNo Auto Trader',
    blurb: 'A YesNo-style vote ensemble: six bullish votes paint the candles through the five trend states, and plotbuy()/plotsell() alternate — buy on the first blue candle, sell on the next red, repeat.',
    tags: ['plotbuy', 'barcolor', 'infopanel'],
    source: `study("YesNo Auto Trader", description="Vote-ensemble trend states; buys the first blue candle, sells the next red, and alternates", overlay=true)
n = input.int(21, "Length", minval=2)
qty = input.float(10, "Trade qty", minval=0.01)
startT = input.time("", "Start date")
active = na(startT) or time >= startT
fastE = ema(close, 9)
slowE = ema(close, n)
longS = sma(close, 50)
r = rsi(close, 14)
macdL = ema(close, 12) - ema(close, 26)
sig = ema(macdL, 9)
score = (close > slowE) + (fastE > slowE) + (macdL > sig) + (r > 50) + (close > longS) + (close > close[10])
plot(slowE, color="#f5b942", title="Trend")
barcolor(score >= 5 ? "#26c6da" : score >= 4 ? "#8adcea" : score >= 3 ? "#f5b942" : score >= 2 ? "#ec407a" : "#7e57c2")
blue = active and score >= 4
red = active and score <= 2
inLong = nz(barssince(blue), 9999) < nz(barssince(red), 9999)
buySig = blue and not inLong[1]
sellSig = red and inLong[1]
plotbuy(buySig, qty, color="#26c6da")
plotsell(sellSig, qty, color="#ec407a")
entry = valuewhen(buySig, close)
pnl = (close - entry) * qty
pnlPct = (close / entry - 1) * 100
pnlColor = not inLong ? "#8f8f98" : pnl >= 0 ? "#26c6da" : "#ec407a"
infopanel(score, title="Votes (of 6)", precision=0)
infopanel(inLong ? "long" : "flat", title="Position", color=inLong ? "#26c6da" : "#ec407a")
infopanel(inLong ? pnl : "—", title="Open P&L $", color=pnlColor)
infopanel(inLong ? pnlPct : "—", title="Open P&L %", color=pnlColor)
realized = cum(sellSig ? (close - entry) * qty : 0)
invested = cum(buySig ? close * qty : 0)
realizedPct = invested > 0 ? realized / invested * 100 : 0
realColor = realized >= 0 ? "#26c6da" : "#ec407a"
infopanel(realized, title="Total P&L $", color=realColor)
infopanel(realizedPct, title="Total P&L %", color=realColor)
wins = cum(sellSig and close > entry ? 1 : 0)
tradesN = cum(sellSig ? 1 : 0)
losses = tradesN - wins
infopanel(tradesN > 0 ? wins + "/" + losses : "—", title="Win/loss", color=tradesN > 0 ? (wins >= losses ? "#26c6da" : "#ec407a") : "#8f8f98")
`,
  },
  {
    name: 'Cross Strategy',
    blurb: 'A per-bar strategy: var/if state, a user function, strategy.buy/sell with a trailing stop, and alerts. The engine tracks the position, ledger and P&L.',
    tags: ['strategy', 'var', 'alerts'],
    source: `study("Cross Strategy", description="EMA cross entries with a trailing stop and alert conditions", overlay=true)
len = input.int(21, "Slow length", minval=2)
qty = input.float(10, "Qty", minval=0.01)
trail = input.float(2, "Trailing stop", minval=0.1)
smooth(x) => ema(x, 9)
fast = smooth(close)
slow = ema(close, len)
plot(fast, color="#22d3ee", title="Fast")
plot(slow, color="#f59e0b", title="Slow")
up = crossover(fast, slow)
down = crossunder(fast, slow)
strategy.buy(up, qty=qty, trailing=trail)
strategy.sell(down, qty=qty)
var wins0 = 0
if strategy.wins > wins0
    wins0 := strategy.wins
barcolor(strategy.position_size > 0 ? "#26c6da" : na)
infopanel(strategy.position_size, title="Position", precision=0)
infopanel(strategy.open_pnl, title="Open P&L")
infopanel(strategy.realized_pnl, title="Realized")
infopanel(tostring(strategy.wins, 0) + "/" + tostring(strategy.losses, 0), title="Win/loss")
alertcondition(up, title="Cross up", message="Fast EMA crossed above slow")
alertcondition(down, title="Cross down")
`,
  },
  {
    name: 'MACD Pane',
    blurb: 'MACD and signal lines in a pane, the gap between them shaded with a raw-series fill.',
    tags: ['pane', 'fill'],
    source: `study("MACD", description="MACD and signal with shaded divergence", overlay=false)
macd = ema(close, 12) - ema(close, 26)
signal = ema(macd, 9)
m = plot(macd, color="#22d3ee", title="MACD")
sg = plot(signal, color="#f59e0b", title="Signal")
fill(m, sg, color="#a78bfa", opacity=0.15)
hline(0)
`,
  },
];
