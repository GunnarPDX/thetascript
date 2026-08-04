// Strategy engine for strategy.buy()/strategy.sell(): a netted position with
// average-price accounting, protective exits (stop-loss / take-profit /
// trailing), pending limit/stop entry orders, commission & slippage
// modeling, position sizing modes, and an equity-curve summary.
//
// Deterministic and bar-driven: market fills happen at the bar's close;
// pending orders and protective exits are checked against LATER bars' ranges
// (never the placement bar's) using completed-bar anchors — no lookahead.
// With the default config (no commission/slippage) the fill arithmetic is
// identical to the pre-config engine.

export class StrategyEngine {
  constructor(n) {
    this.n = n;
    this.used = false;
    // config (strategy.config, locked on first call)
    this.initialCapital = 10000;
    this.commissionPercent = 0;
    this.commissionCash = 0;
    this.slippage = 0;
    this.pyramiding = null; // max same-direction entries per episode; null = unlimited
    // position
    this.size = 0; // + long, - short
    this.avg = NaN;
    this.entryBar = null;
    this.stopPts = null;
    this.targetPts = null;
    this.trailPts = null;
    this.hiSince = -Infinity; // favorable extremes since entry, completed bars
    this.loSince = Infinity;
    this.entriesInEpisode = 0;
    // pending entry orders, keyed by call site (one working order each)
    this.pending = new Map(); // key -> { buy, qtyArg, qtyType, limit, stop, placedBar, expires, stops }
    // accounting
    this.realized = 0;
    this.commissions = 0;
    this.grossProfit = 0;
    this.grossLoss = 0;
    this.wins = 0;
    this.losses = 0;
    this.trades = [];
    this.peak = 0;
    this.maxDrawdown = 0;
    // capital-based equity curve stats
    this.capPeak = -Infinity;
    this.maxDrawdownPct = 0;
    this.eqPrev = NaN;
    this.sumR = 0;
    this.sumR2 = 0;
    this.nR = 0;
    // chart markers (same schema as plotbuy/plotsell output), allocated on
    // the first fill — most scripts never place an order
    this.buyValues = null;
    this.buyQty = null;
    this.sellValues = null;
    this.sellQty = null;
  }

  configure(cfg) {
    // costs clamp at 0 — negative slippage/commission would be a scriptable
    // rebate; non-positive capital is ignored (metrics divide by it)
    if (typeof cfg.initial_capital === 'number' && isFinite(cfg.initial_capital) && cfg.initial_capital > 0) this.initialCapital = cfg.initial_capital;
    if (typeof cfg.commission_percent === 'number' && isFinite(cfg.commission_percent)) this.commissionPercent = Math.max(0, cfg.commission_percent);
    if (typeof cfg.commission_cash === 'number' && isFinite(cfg.commission_cash)) this.commissionCash = Math.max(0, cfg.commission_cash);
    if (typeof cfg.slippage === 'number' && isFinite(cfg.slippage)) this.slippage = Math.max(0, cfg.slippage);
    if (typeof cfg.pyramiding === 'number' && isFinite(cfg.pyramiding)) this.pyramiding = Math.max(1, Math.round(cfg.pyramiding));
  }

  // slippage always works against the fill
  fillPrice(raw, buySide) {
    return buySide ? raw + this.slippage : raw - this.slippage;
  }

  charge(qty, price) {
    this.commissions += this.commissionCash + (this.commissionPercent / 100) * qty * price;
  }

  // resolve a sizing request into shares at the fill price
  resolveQty(qtyArg, qtyType, price, close) {
    if (typeof qtyArg !== 'number' || !isFinite(qtyArg) || qtyArg <= 0) return 0;
    if (qtyType === 'cash') return price > 0 ? qtyArg / price : 0;
    if (qtyType === 'percent_of_equity') {
      const equity = this.initialCapital + this.realized - this.commissions + this.openPnl(close);
      return price > 0 && equity > 0 ? (equity * qtyArg) / 100 / price : 0;
    }
    return qtyArg; // shares
  }

  marker(side, i, qty) {
    if (!this.buyValues) {
      this.buyValues = new Array(this.n).fill(0);
      this.buyQty = new Array(this.n).fill(NaN);
      this.sellValues = new Array(this.n).fill(0);
      this.sellQty = new Array(this.n).fill(NaN);
    }
    const values = side === 'buy' ? this.buyValues : this.sellValues;
    const qtys = side === 'buy' ? this.buyQty : this.sellQty;
    values[i] = 1;
    qtys[i] = Number.isNaN(qtys[i]) ? qty : qtys[i] + qty;
  }

  closeQty(i, rawPrice, qty, reason) {
    const long = this.size > 0;
    const price = this.fillPrice(rawPrice, !long); // closing long sells, closing short buys
    const pnl = (long ? price - this.avg : this.avg - price) * qty;
    this.realized += pnl;
    this.charge(qty, price);
    if (pnl > 0) { this.grossProfit += pnl; this.wins++; }
    else if (pnl < 0) { this.grossLoss += -pnl; this.losses++; }
    this.trades.push({
      side: long ? 'long' : 'short',
      entryBar: this.entryBar,
      entryPrice: this.avg,
      exitBar: i,
      exitPrice: price,
      qty,
      pnl,
      reason,
    });
    this.marker(long ? 'sell' : 'buy', i, qty);
    this.size += long ? -qty : qty;
    if (this.size === 0) {
      this.avg = NaN;
      this.entryBar = null;
      this.stopPts = null;
      this.targetPts = null;
      this.trailPts = null;
      this.hiSince = -Infinity;
      this.loSince = Infinity;
      this.entriesInEpisode = 0;
    }
  }

  openQty(side, i, rawPrice, qty, stops) {
    const buy = side === 'buy';
    // pyramiding caps same-direction adds per position episode
    if (this.size !== 0 && this.pyramiding != null && this.entriesInEpisode >= this.pyramiding) return;
    const price = this.fillPrice(rawPrice, buy);
    const delta = buy ? qty : -qty;
    if (this.size === 0) {
      this.avg = price;
      this.entryBar = i;
    } else {
      // same-direction add: volume-weighted average entry
      this.avg = (this.avg * Math.abs(this.size) + price * qty) / (Math.abs(this.size) + qty);
    }
    this.size += delta;
    this.entriesInEpisode += 1;
    this.charge(qty, price);
    this.stopPts = typeof stops.stop === 'number' && isFinite(stops.stop) ? stops.stop : this.stopPts;
    this.targetPts = typeof stops.target === 'number' && isFinite(stops.target) ? stops.target : this.targetPts;
    this.trailPts = typeof stops.trail === 'number' && isFinite(stops.trail) ? stops.trail : this.trailPts;
    if (Math.abs(this.size) === qty) {
      // opening from flat: the fill price seeds both anchors
      this.hiSince = price;
      this.loSince = price;
    } else {
      // pyramiding add: never loosen the trail — only extend the extreme
      this.hiSince = Math.max(this.hiSince, price);
      this.loSince = Math.min(this.loSince, price);
    }
    this.marker(side, i, qty);
  }

  // strategy.buy / strategy.sell at bar i. Market orders fill at close;
  // limit=/stop= register a pending order (one per call site — a new signal
  // replaces the previous working order) checked from the NEXT bar.
  order(buy, i, bar, req) {
    this.used = true;
    if (req.limit != null || req.stop != null) {
      this.pending.set(req.key, {
        buy,
        qtyArg: req.qtyArg,
        qtyType: req.qtyType,
        limit: req.limit,
        stop: req.stop,
        placedBar: i,
        expires: req.expires,
        stops: req.stops,
      });
      return;
    }
    const qty = this.resolveQty(req.qtyArg, req.qtyType, this.fillPrice(bar.close, buy), bar.close);
    if (qty <= 0) return;
    this.executeNetted(buy, i, bar.close, qty, req.stops);
  }

  executeNetted(buy, i, rawPrice, qty, stops) {
    let remaining = qty;
    const closing = buy ? this.size < 0 : this.size > 0;
    if (closing) {
      const c = Math.min(remaining, Math.abs(this.size));
      this.closeQty(i, rawPrice, c, 'signal');
      remaining -= c;
    }
    if (remaining > 0) this.openQty(buy ? 'buy' : 'sell', i, rawPrice, remaining, stops);
  }

  // pending limit/stop entries: triggered by this bar's range, gap-through
  // fills at the open
  processPending(i, bar) {
    if (!this.pending.size) return;
    for (const [key, o] of this.pending) {
      if (i <= o.placedBar) continue;
      if (o.expires != null && i - o.placedBar > o.expires) {
        this.pending.delete(key);
        continue;
      }
      let raw = null;
      if (o.limit != null) {
        // limit: buy below the market, sell above
        if (o.buy && bar.low <= o.limit) raw = Math.min(bar.open, o.limit);
        if (!o.buy && bar.high >= o.limit) raw = Math.max(bar.open, o.limit);
      } else if (o.stop != null) {
        // stop entry: buy above the market, sell below
        if (o.buy && bar.high >= o.stop) raw = Math.max(bar.open, o.stop);
        if (!o.buy && bar.low <= o.stop) raw = Math.min(bar.open, o.stop);
      }
      if (raw == null) continue;
      this.pending.delete(key);
      const qty = this.resolveQty(o.qtyArg, o.qtyType, this.fillPrice(raw, o.buy), bar.close);
      if (qty > 0) this.executeNetted(o.buy, i, raw, qty, o.stops);
    }
  }

  // protective exits first (position protection wins), then pending entries
  preBar(i, bar) {
    this.checkProtective(i, bar);
    this.processPending(i, bar);
  }

  checkProtective(i, bar) {
    if (this.size === 0 || this.entryBar == null || i <= this.entryBar) return;
    const long = this.size > 0;
    let stopPrice = null;
    if (this.stopPts != null) stopPrice = long ? this.avg - this.stopPts : this.avg + this.stopPts;
    if (this.trailPts != null) {
      const trail = long ? this.hiSince - this.trailPts : this.loSince + this.trailPts;
      stopPrice = stopPrice == null ? trail : (long ? Math.max(stopPrice, trail) : Math.min(stopPrice, trail));
    }
    if (stopPrice != null && (long ? bar.low <= stopPrice : bar.high >= stopPrice)) {
      const fill = long ? Math.min(bar.open, stopPrice) : Math.max(bar.open, stopPrice);
      this.closeQty(i, fill, Math.abs(this.size), 'stop');
      return;
    }
    if (this.targetPts != null) {
      const target = long ? this.avg + this.targetPts : this.avg - this.targetPts;
      if (long ? bar.high >= target : bar.low <= target) {
        const fill = long ? Math.max(bar.open, target) : Math.min(bar.open, target);
        this.closeQty(i, fill, Math.abs(this.size), 'target');
      }
    }
  }

  openPnl(close) {
    return this.size === 0 ? 0
      : (this.size > 0 ? close - this.avg : this.avg - close) * Math.abs(this.size);
  }

  capEquity(close) {
    return this.initialCapital + this.realized - this.commissions + this.openPnl(close);
  }

  // trailing anchors, P&L drawdown, and the capital equity-curve stats
  postBar(i, bar) {
    // the entry bar's extremes happened before (or straddling) the fill —
    // folding them in would let a pre-entry spike arm the trailing stop
    if (this.size !== 0 && this.entryBar != null && i > this.entryBar) {
      this.hiSince = Math.max(this.hiSince, bar.high);
      this.loSince = Math.min(this.loSince, bar.low);
    }
    const equity = this.realized + this.openPnl(bar.close);
    this.peak = Math.max(this.peak, equity);
    this.maxDrawdown = Math.max(this.maxDrawdown, this.peak - equity);
    const cap = this.capEquity(bar.close);
    this.capPeak = Math.max(this.capPeak, cap);
    if (this.capPeak > 0) {
      this.maxDrawdownPct = Math.max(this.maxDrawdownPct, (this.capPeak - cap) / this.capPeak);
    }
    if (Number.isNaN(this.eqPrev)) {
      this.eqPrev = cap;
    } else {
      // |base|: with equity below zero a recovery must count positive
      const r = this.eqPrev !== 0 ? (cap - this.eqPrev) / Math.abs(this.eqPrev) : 0;
      this.sumR += r;
      this.sumR2 += r * r;
      this.nR += 1;
      this.eqPrev = cap;
    }
  }

  // scalar sources visible to the script; state as of the start of the bar
  // (after protective exits and pending fills), marked at the current close.
  // Written through a callback — building an object per bar was measurable
  // allocation churn on long tapes
  writeSources(close, set) {
    const openPnl = this.openPnl(close);
    set('strategy.position_size', this.size);
    set('strategy.avg_price', this.size === 0 ? NaN : this.avg);
    set('strategy.open_pnl', openPnl);
    set('strategy.realized_pnl', this.realized);
    set('strategy.equity', this.realized + openPnl);
    set('strategy.trades', this.trades.length);
    set('strategy.wins', this.wins);
    set('strategy.losses', this.losses);
  }

  finalize(lastClose, firstTime, lastTime) {
    if (!this.used) return { strategy: null, markers: [] };
    const openPnlRaw = this.openPnl(Number.isNaN(lastClose) ? NaN : lastClose);
    const openPnl = Number.isNaN(openPnlRaw) ? 0 : openPnlRaw;
    const closed = this.trades.length;
    const endEquity = this.initialCapital + this.realized - this.commissions + openPnl;
    const years = (lastTime - firstTime) / (365.25 * 86400000);
    const cagrPct = years > 0 && this.initialCapital > 0 && endEquity > 0
      ? (Math.pow(endEquity / this.initialCapital, 1 / years) - 1) * 100 : NaN;
    let sharpe = NaN;
    if (this.nR > 1) {
      const mean = this.sumR / this.nR;
      const varr = this.sumR2 / this.nR - mean * mean;
      const sd = varr > 0 ? Math.sqrt(varr) : 0;
      sharpe = sd > 0 ? mean / sd : NaN;
    }
    const strategy = {
      trades: this.trades,
      open: this.size === 0 ? null : {
        side: this.size > 0 ? 'long' : 'short',
        qty: Math.abs(this.size),
        avgPrice: this.avg,
        entryBar: this.entryBar,
      },
      summary: {
        realized: this.realized,
        openPnl,
        netProfit: this.realized + openPnl - this.commissions,
        trades: closed,
        wins: this.wins,
        losses: this.losses,
        winRate: closed ? this.wins / closed : NaN,
        grossProfit: this.grossProfit,
        grossLoss: this.grossLoss,
        profitFactor: this.grossLoss > 0 ? this.grossProfit / this.grossLoss
          : (this.grossProfit > 0 ? Infinity : NaN),
        maxDrawdown: this.maxDrawdown,
        // capital-based equity metrics (strategy.config initial_capital)
        initialCapital: this.initialCapital,
        commissions: this.commissions,
        endEquity,
        returnPct: this.initialCapital !== 0 ? (endEquity / this.initialCapital - 1) * 100 : NaN,
        cagrPct,
        sharpe, // per-bar, unannualized
        maxDrawdownPct: this.maxDrawdownPct * 100,
      },
    };
    // chart markers ride the same trades channel plotbuy/plotsell uses, so
    // strategies render with zero renderer changes; color null = theme default
    const markers = [];
    if (this.buyValues?.some(Boolean)) markers.push({ values: this.buyValues, qty: this.buyQty, side: 'buy', color: null, priceSource: 'close' });
    if (this.sellValues?.some(Boolean)) markers.push({ values: this.sellValues, qty: this.sellQty, side: 'sell', color: null, priceSource: 'close' });
    return { strategy, markers };
  }
}
