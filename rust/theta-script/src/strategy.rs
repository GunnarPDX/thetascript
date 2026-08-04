//! Strategy engine — a direct port of js/src/strategy.js (v2.3):
//! netted position, protective exits, pending limit/stop entries,
//! commission & slippage, sizing modes, and equity-curve metrics. The
//! arithmetic order matches the reference exactly.

use crate::jsmath::js_max;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub struct Bar {
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
}

#[derive(Clone)]
struct TradeRow {
    side: &'static str,
    entry_bar: usize,
    entry_price: f64,
    exit_bar: usize,
    exit_price: f64,
    qty: f64,
    pnl: f64,
    reason: &'static str,
}

#[derive(Clone)]
pub struct Stops {
    pub stop: Option<f64>,
    pub target: Option<f64>,
    pub trail: Option<f64>,
}

pub struct OrderReq {
    pub key: usize,
    pub qty_arg: f64,
    pub qty_type: &'static str,
    pub limit: Option<f64>,
    pub stop: Option<f64>,
    pub expires: Option<f64>,
    pub stops: Stops,
}

#[derive(Clone)]
struct PendingOrder {
    buy: bool,
    qty_arg: f64,
    qty_type: &'static str,
    limit: Option<f64>,
    stop: Option<f64>,
    placed_bar: usize,
    expires: Option<f64>,
    stops: Stops,
}

pub struct StrategyEngine {
    pub used: bool,
    initial_capital: f64,
    commission_percent: f64,
    commission_cash: f64,
    slippage: f64,
    pyramiding: Option<f64>,
    size: f64,
    avg: f64,
    entry_bar: Option<usize>,
    stop_pts: Option<f64>,
    target_pts: Option<f64>,
    trail_pts: Option<f64>,
    hi_since: f64,
    lo_since: f64,
    entries_in_episode: f64,
    // pending orders keyed by call site — BTreeMap for deterministic order
    pending: BTreeMap<usize, PendingOrder>,
    realized: f64,
    commissions: f64,
    gross_profit: f64,
    gross_loss: f64,
    wins: f64,
    losses: f64,
    trades: Vec<TradeRow>,
    peak: f64,
    max_drawdown: f64,
    cap_peak: f64,
    max_drawdown_pct: f64,
    eq_prev: f64,
    sum_r: f64,
    sum_r2: f64,
    n_r: f64,
    buy_values: Vec<f64>,
    buy_qty: Vec<f64>,
    sell_values: Vec<f64>,
    sell_qty: Vec<f64>,
}

impl StrategyEngine {
    pub fn new(n: usize) -> Self {
        StrategyEngine {
            used: false,
            initial_capital: 10000.0,
            commission_percent: 0.0,
            commission_cash: 0.0,
            slippage: 0.0,
            pyramiding: None,
            size: 0.0,
            avg: f64::NAN,
            entry_bar: None,
            stop_pts: None,
            target_pts: None,
            trail_pts: None,
            hi_since: f64::NEG_INFINITY,
            lo_since: f64::INFINITY,
            entries_in_episode: 0.0,
            pending: BTreeMap::new(),
            realized: 0.0,
            commissions: 0.0,
            gross_profit: 0.0,
            gross_loss: 0.0,
            wins: 0.0,
            losses: 0.0,
            trades: Vec::new(),
            peak: 0.0,
            max_drawdown: 0.0,
            cap_peak: f64::NEG_INFINITY,
            max_drawdown_pct: 0.0,
            eq_prev: f64::NAN,
            sum_r: 0.0,
            sum_r2: 0.0,
            n_r: 0.0,
            buy_values: vec![0.0; n],
            buy_qty: vec![f64::NAN; n],
            sell_values: vec![0.0; n],
            sell_qty: vec![f64::NAN; n],
        }
    }

    pub fn configure(
        &mut self,
        initial_capital: Option<f64>,
        commission_percent: Option<f64>,
        commission_cash: Option<f64>,
        slippage: Option<f64>,
        pyramiding: Option<f64>,
    ) {
        // costs clamp at 0 — negative slippage/commission would be a
        // scriptable rebate; non-positive capital is ignored (metrics divide
        // by it)
        if let Some(v) = initial_capital.filter(|v| v.is_finite() && *v > 0.0) {
            self.initial_capital = v;
        }
        if let Some(v) = commission_percent.filter(|v| v.is_finite()) {
            self.commission_percent = js_max(0.0, v);
        }
        if let Some(v) = commission_cash.filter(|v| v.is_finite()) {
            self.commission_cash = js_max(0.0, v);
        }
        if let Some(v) = slippage.filter(|v| v.is_finite()) {
            self.slippage = js_max(0.0, v);
        }
        if let Some(v) = pyramiding.filter(|v| v.is_finite()) {
            self.pyramiding = Some(js_max(1.0, crate::jsmath::js_round(v)));
        }
    }

    fn fill_price(&self, raw: f64, buy_side: bool) -> f64 {
        if buy_side {
            raw + self.slippage
        } else {
            raw - self.slippage
        }
    }

    fn charge(&mut self, qty: f64, price: f64) {
        self.commissions += self.commission_cash + (self.commission_percent / 100.0) * qty * price;
    }

    fn resolve_qty(&self, qty_arg: f64, qty_type: &str, price: f64, close: f64) -> f64 {
        if !qty_arg.is_finite() || qty_arg <= 0.0 {
            return 0.0;
        }
        if qty_type == "cash" {
            return if price > 0.0 { qty_arg / price } else { 0.0 };
        }
        if qty_type == "percent_of_equity" {
            let equity =
                self.initial_capital + self.realized - self.commissions + self.open_pnl(close);
            return if price > 0.0 && equity > 0.0 {
                (equity * qty_arg) / 100.0 / price
            } else {
                0.0
            };
        }
        qty_arg
    }

    fn marker(&mut self, buy: bool, i: usize, qty: f64) {
        let (values, qtys) = if buy {
            (&mut self.buy_values, &mut self.buy_qty)
        } else {
            (&mut self.sell_values, &mut self.sell_qty)
        };
        values[i] = 1.0;
        qtys[i] = if qtys[i].is_nan() { qty } else { qtys[i] + qty };
    }

    fn close_qty(&mut self, i: usize, raw_price: f64, qty: f64, reason: &'static str) {
        let long = self.size > 0.0;
        let price = self.fill_price(raw_price, !long);
        let pnl = (if long {
            price - self.avg
        } else {
            self.avg - price
        }) * qty;
        self.realized += pnl;
        self.charge(qty, price);
        if pnl > 0.0 {
            self.gross_profit += pnl;
            self.wins += 1.0;
        } else if pnl < 0.0 {
            self.gross_loss += -pnl;
            self.losses += 1.0;
        }
        self.trades.push(TradeRow {
            side: if long { "long" } else { "short" },
            entry_bar: self.entry_bar.unwrap_or(0),
            entry_price: self.avg,
            exit_bar: i,
            exit_price: price,
            qty,
            pnl,
            reason,
        });
        self.marker(!long, i, qty);
        self.size += if long { -qty } else { qty };
        if self.size == 0.0 {
            self.avg = f64::NAN;
            self.entry_bar = None;
            self.stop_pts = None;
            self.target_pts = None;
            self.trail_pts = None;
            self.hi_since = f64::NEG_INFINITY;
            self.lo_since = f64::INFINITY;
            self.entries_in_episode = 0.0;
        }
    }

    fn open_qty(&mut self, buy: bool, i: usize, raw_price: f64, qty: f64, stops: &Stops) {
        if self.size != 0.0 {
            if let Some(p) = self.pyramiding {
                if self.entries_in_episode >= p {
                    return;
                }
            }
        }
        let price = self.fill_price(raw_price, buy);
        let delta = if buy { qty } else { -qty };
        if self.size == 0.0 {
            self.avg = price;
            self.entry_bar = Some(i);
        } else {
            self.avg = (self.avg * self.size.abs() + price * qty) / (self.size.abs() + qty);
        }
        self.size += delta;
        self.entries_in_episode += 1.0;
        self.charge(qty, price);
        let keep = |v: Option<f64>, old: Option<f64>| match v {
            Some(x) if x.is_finite() => Some(x),
            _ => old,
        };
        self.stop_pts = keep(stops.stop, self.stop_pts);
        self.target_pts = keep(stops.target, self.target_pts);
        self.trail_pts = keep(stops.trail, self.trail_pts);
        if self.size.abs() == qty {
            // opening from flat: the fill price seeds both anchors
            self.hi_since = price;
            self.lo_since = price;
        } else {
            // pyramiding add: never loosen the trail — only extend the extreme
            self.hi_since = js_max(self.hi_since, price);
            self.lo_since = crate::jsmath::js_min(self.lo_since, price);
        }
        self.marker(buy, i, qty);
    }

    pub fn order(&mut self, buy: bool, i: usize, bar: &Bar, req: OrderReq) {
        self.used = true;
        if req.limit.is_some() || req.stop.is_some() {
            self.pending.insert(
                req.key,
                PendingOrder {
                    buy,
                    qty_arg: req.qty_arg,
                    qty_type: req.qty_type,
                    limit: req.limit,
                    stop: req.stop,
                    placed_bar: i,
                    expires: req.expires,
                    stops: req.stops,
                },
            );
            return;
        }
        let qty = self.resolve_qty(
            req.qty_arg,
            req.qty_type,
            self.fill_price(bar.close, buy),
            bar.close,
        );
        if qty <= 0.0 {
            return;
        }
        self.execute_netted(buy, i, bar.close, qty, &req.stops);
    }

    fn execute_netted(&mut self, buy: bool, i: usize, raw_price: f64, qty: f64, stops: &Stops) {
        let mut remaining = qty;
        let closing = if buy {
            self.size < 0.0
        } else {
            self.size > 0.0
        };
        if closing {
            let c = remaining.min(self.size.abs());
            self.close_qty(i, raw_price, c, "signal");
            remaining -= c;
        }
        if remaining > 0.0 {
            self.open_qty(buy, i, raw_price, remaining, stops);
        }
    }

    fn process_pending(&mut self, i: usize, bar: &Bar) {
        if self.pending.is_empty() {
            return;
        }
        let keys: Vec<usize> = self.pending.keys().copied().collect();
        for key in keys {
            let o = self.pending.get(&key).unwrap().clone();
            if i <= o.placed_bar {
                continue;
            }
            if let Some(exp) = o.expires {
                if (i - o.placed_bar) as f64 > exp {
                    self.pending.remove(&key);
                    continue;
                }
            }
            let mut raw: Option<f64> = None;
            if let Some(limit) = o.limit {
                // limit: buy below the market, sell above
                if o.buy && bar.low <= limit {
                    raw = Some(bar.open.min(limit));
                }
                if !o.buy && bar.high >= limit {
                    raw = Some(js_max(bar.open, limit));
                }
            } else if let Some(stop) = o.stop {
                // stop entry: buy above the market, sell below
                if o.buy && bar.high >= stop {
                    raw = Some(js_max(bar.open, stop));
                }
                if !o.buy && bar.low <= stop {
                    raw = Some(bar.open.min(stop));
                }
            }
            let Some(raw) = raw else { continue };
            self.pending.remove(&key);
            let qty = self.resolve_qty(
                o.qty_arg,
                o.qty_type,
                self.fill_price(raw, o.buy),
                bar.close,
            );
            if qty > 0.0 {
                self.execute_netted(o.buy, i, raw, qty, &o.stops);
            }
        }
    }

    /// protective exits first (position protection wins), then pending entries
    pub fn pre_bar(&mut self, i: usize, bar: &Bar) {
        self.check_protective(i, bar);
        self.process_pending(i, bar);
    }

    fn check_protective(&mut self, i: usize, bar: &Bar) {
        let Some(entry_bar) = self.entry_bar else {
            return;
        };
        if self.size == 0.0 || i <= entry_bar {
            return;
        }
        let long = self.size > 0.0;
        let mut stop_price: Option<f64> =
            self.stop_pts
                .map(|p| if long { self.avg - p } else { self.avg + p });
        if let Some(t) = self.trail_pts {
            let trail = if long {
                self.hi_since - t
            } else {
                self.lo_since + t
            };
            stop_price = Some(match stop_price {
                None => trail,
                Some(sp) => {
                    if long {
                        js_max(sp, trail)
                    } else {
                        sp.min(trail)
                    }
                }
            });
        }
        if let Some(sp) = stop_price {
            if (long && bar.low <= sp) || (!long && bar.high >= sp) {
                let fill = if long {
                    bar.open.min(sp)
                } else {
                    js_max(bar.open, sp)
                };
                self.close_qty(i, fill, self.size.abs(), "stop");
                return;
            }
        }
        if let Some(tp) = self.target_pts {
            let target = if long { self.avg + tp } else { self.avg - tp };
            if (long && bar.high >= target) || (!long && bar.low <= target) {
                let fill = if long {
                    js_max(bar.open, target)
                } else {
                    bar.open.min(target)
                };
                self.close_qty(i, fill, self.size.abs(), "target");
            }
        }
    }

    pub fn open_pnl(&self, close: f64) -> f64 {
        if self.size == 0.0 {
            0.0
        } else {
            (if self.size > 0.0 {
                close - self.avg
            } else {
                self.avg - close
            }) * self.size.abs()
        }
    }

    fn cap_equity(&self, close: f64) -> f64 {
        self.initial_capital + self.realized - self.commissions + self.open_pnl(close)
    }

    pub fn post_bar(&mut self, i: usize, bar: &Bar) {
        // the entry bar's extremes happened before (or straddling) the fill —
        // folding them in would let a pre-entry spike arm the trailing stop
        if self.size != 0.0 && self.entry_bar.is_some_and(|eb| i > eb) {
            self.hi_since = js_max(self.hi_since, bar.high);
            self.lo_since = self.lo_since.min(bar.low);
        }
        let equity = self.realized + self.open_pnl(bar.close);
        self.peak = js_max(self.peak, equity);
        self.max_drawdown = js_max(self.max_drawdown, self.peak - equity);
        let cap = self.cap_equity(bar.close);
        self.cap_peak = js_max(self.cap_peak, cap);
        if self.cap_peak > 0.0 {
            self.max_drawdown_pct =
                js_max(self.max_drawdown_pct, (self.cap_peak - cap) / self.cap_peak);
        }
        if self.eq_prev.is_nan() {
            self.eq_prev = cap;
        } else {
            // |base|: with equity below zero a recovery must count positive
            let r = if self.eq_prev != 0.0 {
                (cap - self.eq_prev) / self.eq_prev.abs()
            } else {
                0.0
            };
            self.sum_r += r;
            self.sum_r2 += r * r;
            self.n_r += 1.0;
            self.eq_prev = cap;
        }
    }

    pub fn sources(&self, close: f64) -> Vec<(&'static str, f64)> {
        vec![
            ("strategy.position_size", self.size),
            (
                "strategy.avg_price",
                if self.size == 0.0 { f64::NAN } else { self.avg },
            ),
            ("strategy.open_pnl", self.open_pnl(close)),
            ("strategy.realized_pnl", self.realized),
            ("strategy.equity", self.realized + self.open_pnl(close)),
            ("strategy.trades", self.trades.len() as f64),
            ("strategy.wins", self.wins),
            ("strategy.losses", self.losses),
        ]
    }

    pub fn finalize(
        &self,
        last_close: f64,
        first_time: f64,
        last_time: f64,
        enc: &dyn Fn(f64) -> Value,
    ) -> (Value, Vec<Value>) {
        if !self.used {
            return (Value::Null, Vec::new());
        }
        let open_pnl_raw = self.open_pnl(last_close);
        let open_pnl = if open_pnl_raw.is_nan() {
            0.0
        } else {
            open_pnl_raw
        };
        let closed = self.trades.len() as f64;
        let end_equity = self.initial_capital + self.realized - self.commissions + open_pnl;
        let years = (last_time - first_time) / (365.25 * 86_400_000.0);
        let cagr_pct = if years > 0.0 && self.initial_capital > 0.0 && end_equity > 0.0 {
            ((end_equity / self.initial_capital).powf(1.0 / years) - 1.0) * 100.0
        } else {
            f64::NAN
        };
        let mut sharpe = f64::NAN;
        if self.n_r > 1.0 {
            let mean = self.sum_r / self.n_r;
            let varr = self.sum_r2 / self.n_r - mean * mean;
            let sd = if varr > 0.0 { varr.sqrt() } else { 0.0 };
            if sd > 0.0 {
                sharpe = mean / sd;
            }
        }
        let trades: Vec<Value> = self
            .trades
            .iter()
            .map(|t| {
                json!({
                    "side": t.side,
                    "entryBar": t.entry_bar,
                    "entryPrice": enc(t.entry_price),
                    "exitBar": t.exit_bar,
                    "exitPrice": enc(t.exit_price),
                    "qty": enc(t.qty),
                    "pnl": enc(t.pnl),
                    "reason": t.reason,
                })
            })
            .collect();
        let open = if self.size == 0.0 {
            Value::Null
        } else {
            json!({
                "side": if self.size > 0.0 { "long" } else { "short" },
                "qty": enc(self.size.abs()),
                "avgPrice": enc(self.avg),
                "entryBar": self.entry_bar.unwrap_or(0),
            })
        };
        let profit_factor = if self.gross_loss > 0.0 {
            self.gross_profit / self.gross_loss
        } else if self.gross_profit > 0.0 {
            f64::INFINITY
        } else {
            f64::NAN
        };
        let mut summary = Map::new();
        summary.insert("realized".into(), enc(self.realized));
        summary.insert("openPnl".into(), enc(open_pnl));
        summary.insert(
            "netProfit".into(),
            enc(self.realized + open_pnl - self.commissions),
        );
        summary.insert("trades".into(), enc(closed));
        summary.insert("wins".into(), enc(self.wins));
        summary.insert("losses".into(), enc(self.losses));
        summary.insert(
            "winRate".into(),
            enc(if closed > 0.0 {
                self.wins / closed
            } else {
                f64::NAN
            }),
        );
        summary.insert("grossProfit".into(), enc(self.gross_profit));
        summary.insert("grossLoss".into(), enc(self.gross_loss));
        summary.insert("profitFactor".into(), enc(profit_factor));
        summary.insert("maxDrawdown".into(), enc(self.max_drawdown));
        summary.insert("initialCapital".into(), enc(self.initial_capital));
        summary.insert("commissions".into(), enc(self.commissions));
        summary.insert("endEquity".into(), enc(end_equity));
        summary.insert(
            "returnPct".into(),
            enc(if self.initial_capital != 0.0 {
                (end_equity / self.initial_capital - 1.0) * 100.0
            } else {
                f64::NAN
            }),
        );
        summary.insert("cagrPct".into(), enc(cagr_pct));
        summary.insert("sharpe".into(), enc(sharpe));
        summary.insert("maxDrawdownPct".into(), enc(self.max_drawdown_pct * 100.0));
        let strategy = json!({ "trades": trades, "open": open, "summary": Value::Object(summary) });

        let mut markers = Vec::new();
        if self.buy_values.iter().any(|v| *v != 0.0) {
            markers.push(json!({
                "values": self.buy_values.iter().map(|v| enc(*v)).collect::<Vec<_>>(),
                "qty": self.buy_qty.iter().map(|v| enc(*v)).collect::<Vec<_>>(),
                "side": "buy",
                "color": Value::Null,
                "priceSource": "close",
            }));
        }
        if self.sell_values.iter().any(|v| *v != 0.0) {
            markers.push(json!({
                "values": self.sell_values.iter().map(|v| enc(*v)).collect::<Vec<_>>(),
                "qty": self.sell_qty.iter().map(|v| enc(*v)).collect::<Vec<_>>(),
                "side": "sell",
                "color": Value::Null,
                "priceSource": "close",
            }));
        }
        (strategy, markers)
    }
}
