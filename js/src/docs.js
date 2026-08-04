// Language reference, as data: [code, description] rows grouped by section.
// This is the documentation of record for the scripting language — the script
// editor renders it, and docs.test.js asserts it covers every builtin, draw
// function, keyword and source the runtime actually exposes.
export const HELP_SECTIONS = [
  {
    title: 'Functions',
    rows: [
      ['sma · ema · wma · rsi · stdev', 'indicators — fn(series, period)'],
      ['dema · tema · tma · hull · wilders · linreg', 'more moving averages / fits — fn(series, period)'],
      ['roc(s, p) · mom(s, p) · rising(s, p) · falling(s, p)', 'percent rate of change, momentum, and strict up/down runs over p bars'],
      ['atr(period) · tr() · stoch(period) · mfi(period) · obv() · vwap(src, anchor)', 'bar-driven indicators reading OHLCV directly; vwap anchors to the session-timezone day by default — vwap(hlc3, "week") or "month" for higher anchors'],
      ['array.new(size, initial) · array.push(a, v) · array.pop(a) · array.shift(a) · array.unshift(a, v)', 'mutable arrays — reference values: var a = array.new() keeps one array across bars, without var you get a fresh one each bar'],
      ['array.get(a, i) · array.set(a, i, v) · array.size(a) · array.first(a) · array.last(a) · array.clear(a)', 'element access — get reads na out of range, set errors; loop with for k = 0 to array.size(a) - 1'],
      ['array.sum(a) · array.avg(a) · array.min(a) · array.max(a)', 'numeric aggregates over the elements, skipping na'],
      ['pivothigh(left, right) · pivotlow(left, right)', 'the pivot price once confirmed by `right` newer bars, else na'],
      ['highest · lowest · sum · change · offset', 'rolling-window helpers — fn(series, period)'],
      ['highestbars(s, p) · lowestbars(s, p)', 'bars back to the window extreme (0 = the current bar)'],
      ['crossover(a, b) · crossunder(a, b) · cross(a, b)', '1 on the bar where a crosses b, else 0'],
      ['barssince(cond)', 'bars since cond was last true — 0 on the bar itself, na before the first; combine with [1] to latch alternating states'],
      ['valuewhen(cond, source)', 'the value of source at the most recent bar where cond was true — na before the first; e.g. an entry price at the last buy signal'],
      ['cum(series)', 'running cumulative sum over the whole tape — na counts as 0; e.g. cum(sellSig ? tradePnl : 0) totals realized P&L'],
      ['timestamp("2026-01-01 09:30") · timestamp(y, m, d, h, min)', 'a date/time as ms since epoch, read as wall time in the session timezone (default New York), comparable with < <= > >= against time'],
      ['year · month · dayofmonth · dayofweek · hour · minute', 'calendar parts of a ms timestamp, elementwise, in the session timezone (dayofweek 0=Sun…6=Sat) — e.g. hour(time) >= 10'],
      ['abs · sqrt · log · exp · round · floor · ceil · sign · pow', 'elementwise math'],
      ['nz(s, v) · na(s) · min · max · avg · iff(c, a, b)', 'utilities — nz replaces NaN, iff selects per bar'],
      ['tostring(x, 2)', 'number to text with optional decimals — e.g. infopanel("RSI " + tostring(r, 1))'],
      ['adx(p) · diplus(p) · diminus(p) · aroonup(p) · aroondown(p)', 'Wilder’s directional system and Aroon, reading the bars directly'],
      ['sar(0.02, 0.02, 0.2) · supertrend(p, mult) · supertrend_dir(p, mult)', 'parabolic SAR and Supertrend (line value / ±1 direction)'],
      ['cci(p) · willr(p) · correlation(a, b, p)', 'commodity channel index, Williams %R, and rolling Pearson correlation'],
      ['percentile(s, p, q) · median(s, p) · alma(s, p, offset, sigma)', 'sorted-window rank (linear interpolation), median, and the Arnaud Legoux MA'],
      ['sin · cos · tan · asin · acos · atan · atan2(y, x) · pi', 'trigonometry — angles in radians; pi is the constant'],
      ['str.format("rsi {0}", r) · str.contains · str.replace · str.upper · str.lower · str.length · str.split', 'text utilities — {0}-style placeholders; split returns an array'],
      ['security("1h", ema(close, 20))', 'evaluates the expression on higher-timeframe bars aggregated from the chart ("5m"…"4h", "1d", "1w") — non-repainting: the value only updates when the higher-TF bar completes'],
    ],
  },
  {
    title: 'Statements & state',
    rows: [
      ['x = expr', 'per-bar variable — recomputed every bar; the script body runs once per bar, top to bottom'],
      ['var x = expr · x := expr', 'var declares once and persists across bars; := reassigns it (also required to modify outer variables from inside a block)'],
      ['if cond … else if … else …', 'conditional statements — the body is an indented block; expressions in untaken branches still evaluate, statements do not'],
      ['for i = 0 to 9 by 1', 'bounded loop over an indented block (by defaults to 1, may be negative)'],
      ['while cond · break · continue', 'loop while cond holds; break exits the loop, continue skips to the next pass'],
      ['switch x · 1 => y := 1 · => y := 0', 'compares x against each arm with ==; the bare => arm is the default; arms are single-line statements'],
      ['f(x, y) => x + y', 'user function — single expression, or an indented block ending with the return expression; each call site keeps its own indicator state'],
      ['x[2]', 'history access — the value 2 bars back, works on any expression; the offset may vary per bar'],
    ],
  },
  {
    title: 'Drawing',
    rows: [
      ['study("Title", overlay=true, description="…")', 'names the script; overlay=false gives it its own pane; description shows on hover in the studies menu'],
      ['plot(series, color="#hex", title="…", width=2, style="line", linestyle="solid")', 'draws a line; styles: line, histogram, area, stepline, circles · linestyles: solid, dashed, dotted · capture it with a = plot(…) to use in fill'],
      ['hline(value, color="#hex")', 'horizontal level line'],
      ['fill(a, b, color="#hex", opacity=0.12)', 'shades the area between two plots (or raw series)'],
      ['plotshape(cond, shape="…", location="…", color="#hex", size=4)', 'marks bars where cond is true — shapes: triangleup, triangledown, circle, square, cross · locations: abovebar, belowbar, absolute'],
      ['plotbuy(cond, qty, price="close") · plotsell(cond, qty, price=…)', 'places a BUY/SELL trade marker on bars where cond is true; qty defaults to 1, color= overrides the green/red; price= anchors the marker — "open"/"high"/"low"/"close" or a number for a custom price (e.g. price=hl2)'],
      ['infopanel(value, title="…", color="#hex", precision=2)', 'adds a row to the info panel under the ticker chip showing the latest value — numbers format with precision decimals, strings (e.g. a ternary of labels) display as-is; color= may also be a ternary, the latest bar’s color applies'],
      ['barcolor(cond ? "#hex" : "#hex", when=cond)', 'recolors the price candles/line per bar; when= limits which bars'],
      ['bgcolor("#hex", when=cond, opacity=0.1)', 'vertical background wash behind bars where when is true'],
      ['input.int(9, "Length", minval=1) · input.float(0.85, "Offset", step=0.01, tooltip="…")', 'declares a user-tunable value and returns it; right-click the study on the chart to change inputs without editing the source'],
      ['input.bool(false, "Fast mode") · input.string("sma", "Mode", options="sma,ema,wma")', 'user-tunable toggle (returns 1/0) and text choice (options= is a comma-separated list rendered as a dropdown)'],
      ['input.time("2026-01-01 09:30", "Start date")', 'user-tunable date/time (picker in the study editor) returning a ms timestamp — na when unset, so `na(start) or time >= start` means "no limit until a date is chosen"'],
    ],
  },
  {
    title: 'Strategy & alerts',
    rows: [
      ['strategy.buy(when, qty) · strategy.sell(when, qty)', 'fills a market order at the close of bars where when is true; opposite-side orders net against the open position and realize P&L into the trade ledger'],
      ['strategy.buy(sig, qty=5, stop_loss=1.5, take_profit=3, trailing=2)', 'protective exits as price offsets from the average entry, checked against later bars’ ranges — stop wins when both hit inside one bar'],
      ['strategy.position_size · strategy.avg_price · strategy.open_pnl', 'live position state as of the start of the bar (after protective exits), marked at the current close'],
      ['strategy.realized_pnl · strategy.equity · strategy.trades · strategy.wins · strategy.losses', 'running account state; the full ledger and summary (win rate, profit factor, max drawdown) land in the result'],
      ['alertcondition(cond, title="…", message="close={{close}}")', 'declares an alert stream: 1 on bars where cond fires; {{open}}/{{close}}/{{time}}/{{bar_index}}-style placeholders render a per-fire message for backends'],
      ['strategy.config(initial_capital=10000, commission_percent=0.1, commission_cash=0, slippage=0.05, pyramiding=1)', 'backtest costs and limits, read once — slippage works against every fill, commissions subtract from net profit, pyramiding caps same-direction adds'],
      ['strategy.buy(sig, 10, limit=99.5, expires=20) · strategy.buy(sig, 10, stop=101)', 'pending entry orders: limit buys below / stop-entries above the market, checked on later bars (one working order per call site; expires= in bars)'],
      ['strategy.buy(sig, qty=5, qty_type="percent_of_equity")', 'position sizing: "shares" (default), "cash", or "percent_of_equity" resolved at the fill price'],
      ['line.new(x1, y1, x2, y2, …) · label.new(x, y, "txt", …) · box.new(x1, y1, x2, y2, bgcolor=…)', 'drawing objects in bar_index coordinates, created per bar where when= holds, capped at 500 each (oldest dropped); lines take color/width/style, labels text/color/size, boxes border and fill'],
    ],
  },
  {
    title: 'Data',
    rows: [
      ['open · high · low · close · volume', 'raw bar series'],
      ['hl2 · hlc3 · ohlc4 · bar_index', 'derived series'],
      ['time', 'bar timestamps as ms since epoch — compare with the ordinary operators, e.g. time >= timestamp("2026-01-01")'],
      ['current_datetime · date_today · market_open · market_close', '“now” scalars anchored to the latest bar: its timestamp, session-timezone midnight of its day, and the market session bounds on that day (default 09:30 / 16:00 New York)'],
      ['barstate.isfirst · barstate.islast', '1 on the first / latest bar of the tape — e.g. gate labels or alerts to the live bar'],
    ],
  },
  {
    title: 'Operators',
    rows: [
      ['+ − * / %', 'arithmetic, broadcasts scalars over series'],
      ['== != < <= > >=', 'comparisons — produce 1/0 series'],
      ['and · or · not', 'boolean logic'],
      ['cond ? a : b', 'ternary, chooses per bar when cond is a series'],
      ['true · false · na', 'literals — true/false are 1/0; bare na is the missing value (NaN), test for it with na(x)'],
    ],
  },
];

// Guided walkthrough for the docs panel's Getting Started tab: prose + code
// steps, in order. Each body item is { p } prose or { code } source (the
// panel runs code through the editor's syntax highlighter).
export const GETTING_STARTED = [
  {
    title: 'Your first script',
    body: [
      { p: 'A script runs once per bar, top to bottom, oldest bar first. Sources like close read the current bar, indicator calls update as the bars stream through them, and draw calls contribute that bar’s slice of the output. Start with a study() declaration and one plot:' },
      { code: 'study("My First Script", overlay=true)\nplot(ema(close, 20), color="#22d3ee", width=2)' },
      { p: 'overlay=true draws on the price chart; leave it off and the script gets its own pane below — right for oscillators like RSI. Save the script and add it to the chart like any other study.' },
    ],
  },
  {
    title: 'Series and history',
    body: [
      { p: 'Every expression produces one value per bar. A plain assignment is recomputed each bar, and square brackets look back: spread[1] is the previous bar’s value. Values that don’t exist yet — the lookback before bar 0, an sma still filling its window — read as na, and na stays quiet: plots skip it, comparisons against it are 0.' },
      { code: 'study("Range", overlay=false)\nspread = high - low\nwidening = spread > spread[1]\nplot(sma(spread, 10), title="avg range")\nplot(spread, style="histogram", color="#7d8590")' },
    ],
  },
  {
    title: 'Remembering state',
    body: [
      { p: 'var declares a variable once, on the first bar, and keeps its value from bar to bar — use := to update it. Together with if blocks (indentation-delimited, like Python) this is how you count, latch, and accumulate:' },
      { code: 'study("Up Bars", overlay=false)\nvar upBars = 0\nif close > open\n    upBars := upBars + 1\ninfopanel(upBars, title="up bars")\nplot(100 * upBars / (bar_index + 1), title="% up")' },
    ],
  },
  {
    title: 'Signals',
    body: [
      { p: 'crossover(a, b) is 1 on the exact bar a crosses above b — the building block of most entries. plotbuy/plotsell drop buy and sell markers on the chart, and plotshape marks any condition:' },
      { code: 'study("Cross Signals", overlay=true)\nfast = ema(close, 9)\nslow = ema(close, 21)\nplot(fast, color="#22d3ee")\nplot(slow, color="#f59e0b")\nplotbuy(crossover(fast, slow), 10)\nplotsell(crossunder(fast, slow), 10)' },
    ],
  },
  {
    title: 'Inputs',
    body: [
      { p: 'input.* declarations surface as controls in the study’s settings, so one script serves many configurations. The call returns the chosen value; defaults apply until the user changes them:' },
      { code: 'study("Tunable RSI", overlay=false)\nlen = input.int(14, "RSI length", minval=2)\nlevel = input.float(30, "Band", minval=5, maxval=45)\nr = rsi(close, len)\nplot(r, color="#a78bfa", width=2)\nhline(level)\nhline(100 - level)' },
    ],
  },
  {
    title: 'Backtesting',
    body: [
      { p: 'strategy.buy and strategy.sell turn signals into a simulated position: fills at the close of the signal bar, netted long/short, with optional protective exits (stop_loss, take_profit, trailing — all price offsets from entry). strategy.config sets capital and costs, and the result carries a full trade ledger with equity metrics:' },
      { code: 'study("Golden Cross", overlay=true)\nstrategy.config(initial_capital=10000, commission_percent=0.1)\nfast = sma(close, 20)\nslow = sma(close, 50)\nplot(fast, color="#22d3ee")\nplot(slow, color="#f59e0b")\nstrategy.buy(crossover(fast, slow), 25, qty_type="percent_of_equity", stop_loss=2)\nstrategy.sell(crossunder(fast, slow), 25, qty_type="percent_of_equity")' },
      { p: 'Read the live position from strategy.position_size, strategy.equity and friends — e.g. gate re-entries on strategy.position_size == 0.' },
    ],
  },
  {
    title: 'Going further',
    body: [
      { p: 'From here the Reference tab documents everything: higher-timeframe data with security("1h", …), alerts with {{close}}-style message placeholders, arrays, drawing objects (line.new, label.new, box.new), and the full indicator set. The Examples tab has complete scripts you can import into the editor and dissect.' },
    ],
  },
];
