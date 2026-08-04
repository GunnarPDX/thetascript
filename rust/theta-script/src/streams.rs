//! Incremental (per-bar) indicator state machines — a direct port of
//! js/src/streams.js. CONTRACT: identical floating-point operations in
//! identical order to the JS reference, so arithmetic-only indicators match
//! bit-for-bit and transcendental ones stay within the corpus tolerance.

use crate::jsmath::js_max;

pub struct Ring {
    cap: usize,
    buf: Vec<f64>,
    count: usize,
}

impl Ring {
    pub fn new(cap: usize) -> Self {
        Ring {
            cap,
            buf: vec![f64::NAN; cap],
            count: 0,
        }
    }

    pub fn push(&mut self, v: f64) {
        let idx = self.count % self.cap;
        self.buf[idx] = v;
        self.count += 1;
    }

    pub fn at(&self, j: usize) -> f64 {
        self.buf[j % self.cap]
    }
}

// mirrors math.js sma: running sum slid per bar, rebuilt ascending after a
// non-finite value leaves the window
pub struct Sma {
    p: usize,
    ring: Ring,
    s: f64,
    last_bad: i64,
    i: i64,
}

impl Sma {
    pub fn new(p: usize) -> Self {
        Sma {
            p,
            ring: Ring::new(p + 1),
            s: f64::NAN,
            last_bad: -1,
            i: -1,
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        self.i += 1;
        if !v.is_finite() {
            self.last_bad = self.i;
        }
        self.ring.push(v);
        let p = self.p as i64;
        if self.i < p - 1 {
            return f64::NAN;
        }
        let start = self.i - p + 1;
        if self.last_bad >= start {
            self.s = f64::NAN;
            return f64::NAN;
        }
        if self.s.is_nan() {
            self.s = 0.0;
            for k in start..=self.i {
                self.s += self.ring.at(k as usize);
            }
        } else {
            self.s += v - self.ring.at((start - 1) as usize);
        }
        self.s / self.p as f64
    }
}

pub struct Wma {
    p: usize,
    ring: Ring,
    denom: f64,
    s: f64,
    w: f64,
    last_bad: i64,
    i: i64,
}

impl Wma {
    pub fn new(p: usize) -> Self {
        let pf = p as f64;
        Wma {
            p,
            ring: Ring::new(p + 1),
            denom: (pf * (pf + 1.0)) / 2.0,
            s: f64::NAN,
            w: 0.0,
            last_bad: -1,
            i: -1,
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        self.i += 1;
        if !v.is_finite() {
            self.last_bad = self.i;
        }
        self.ring.push(v);
        let p = self.p as i64;
        if self.i < p - 1 {
            return f64::NAN;
        }
        let start = self.i - p + 1;
        if self.last_bad >= start {
            self.s = f64::NAN;
            return f64::NAN;
        }
        if self.s.is_nan() {
            self.s = 0.0;
            self.w = 0.0;
            for k in 0..self.p {
                let y = self.ring.at((start as usize) + k);
                self.s += y;
                self.w += y * (k as f64 + 1.0); // oldest weighs 1, newest p
            }
        } else {
            self.w += self.p as f64 * v - self.s;
            self.s += v - self.ring.at((start - 1) as usize);
        }
        self.w / self.denom
    }
}

pub struct EmaFrom {
    alpha: f64,
    prev: Option<f64>,
}

impl EmaFrom {
    pub fn new(alpha: f64) -> Self {
        EmaFrom { alpha, prev: None }
    }

    pub fn ema(p: usize) -> Self {
        EmaFrom::new(2.0 / (p as f64 + 1.0))
    }

    pub fn wilders(p: usize) -> Self {
        EmaFrom::new(1.0 / p as f64)
    }

    pub fn next(&mut self, v: f64) -> f64 {
        if !v.is_finite() {
            return f64::NAN;
        }
        let e = match self.prev {
            None => v,
            Some(prev) => self.alpha * v + (1.0 - self.alpha) * prev,
        };
        self.prev = Some(e);
        e
    }
}

pub struct Rsi {
    p: f64,
    avg_gain: f64,
    avg_loss: f64,
    prev: f64,
    cnt: usize,
}

impl Rsi {
    pub fn new(p: usize) -> Self {
        Rsi {
            p: p as f64,
            avg_gain: 0.0,
            avg_loss: 0.0,
            prev: f64::NAN,
            cnt: 0,
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        // gap — carry accumulators past it. Non-finite (not just NaN): one
        // Infinity delta would park avg_gain at Infinity forever
        if !v.is_finite() {
            return f64::NAN;
        }
        if self.prev.is_nan() {
            self.prev = v;
            return f64::NAN;
        }
        let d = v - self.prev;
        self.prev = v;
        let gain = js_max(d, 0.0);
        let loss = js_max(-d, 0.0);
        self.cnt += 1;
        if self.cnt as f64 <= self.p {
            self.avg_gain += gain / self.p;
            self.avg_loss += loss / self.p;
            if (self.cnt as f64) < self.p {
                return f64::NAN;
            }
        } else {
            self.avg_gain = (self.avg_gain * (self.p - 1.0) + gain) / self.p;
            self.avg_loss = (self.avg_loss * (self.p - 1.0) + loss) / self.p;
        }
        if self.avg_loss == 0.0 {
            if self.avg_gain == 0.0 {
                50.0
            } else {
                100.0
            }
        } else {
            100.0 - 100.0 / (1.0 + self.avg_gain / self.avg_loss)
        }
    }
}

// population stdev with NaN counting + the float-noise clamp
pub struct Stdev {
    p: usize,
    ring: Ring,
    sum: f64,
    sum_sq: f64,
    nans: i64,
    i: i64,
}

impl Stdev {
    pub fn new(p: usize) -> Self {
        Stdev {
            p,
            ring: Ring::new(p + 1),
            sum: 0.0,
            sum_sq: 0.0,
            nans: 0,
            i: -1,
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        self.i += 1;
        self.ring.push(v);
        // non-finite (not just NaN) counts as a gap: Infinity entering the
        // accumulator would leave it as Inf - Inf = NaN forever on eviction
        if !v.is_finite() {
            self.nans += 1;
        } else {
            self.sum += v;
            self.sum_sq += v * v;
        }
        let p = self.p as i64;
        if self.i >= p {
            let old = self.ring.at((self.i - p) as usize);
            if !old.is_finite() {
                self.nans -= 1;
            } else {
                self.sum -= old;
                self.sum_sq -= old * old;
            }
        }
        if self.i < p - 1 || self.nans > 0 {
            return f64::NAN;
        }
        let pf = self.p as f64;
        let m = self.sum / pf;
        let varr = self.sum_sq / pf - m * m;
        if varr <= (self.sum_sq / pf) * 1e-12 {
            0.0
        } else {
            varr.sqrt()
        }
    }
}

pub struct SumStream {
    p: usize,
    ring: Ring,
    sum: f64,
    nans: i64,
    i: i64,
}

impl SumStream {
    pub fn new(p: usize) -> Self {
        SumStream {
            p,
            ring: Ring::new(p + 1),
            sum: 0.0,
            nans: 0,
            i: -1,
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        self.i += 1;
        self.ring.push(v);
        if !v.is_finite() {
            self.nans += 1; // non-finite = gap, like stdev
        } else {
            self.sum += v;
        }
        let p = self.p as i64;
        if self.i >= p {
            let old = self.ring.at((self.i - p) as usize);
            if !old.is_finite() {
                self.nans -= 1;
            } else {
                self.sum -= old;
            }
        }
        if self.i >= p - 1 && self.nans == 0 {
            self.sum
        } else {
            f64::NAN
        }
    }
}

// monotonic deque of absolute indices; `ge` picks highest (>=) vs lowest (<=)
pub struct Extreme {
    p: usize,
    ring: Ring,
    dq: Vec<usize>,
    head: usize,
    nans: i64,
    i: i64,
    ge: bool,
    want_index: bool,
}

impl Extreme {
    pub fn new(p: usize, ge: bool, want_index: bool) -> Self {
        Extreme {
            p,
            ring: Ring::new(p + 1),
            dq: Vec::new(),
            head: 0,
            nans: 0,
            i: -1,
            ge,
            want_index,
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        self.i += 1;
        self.ring.push(v);
        if v.is_nan() {
            self.nans += 1;
        } else {
            while self.dq.len() > self.head {
                let tail = self.ring.at(*self.dq.last().unwrap());
                let drop = if self.ge { v >= tail } else { v <= tail };
                if drop {
                    self.dq.pop();
                } else {
                    break;
                }
            }
            self.dq.push(self.i as usize);
        }
        let p = self.p as i64;
        if self.i >= p && self.ring.at((self.i - p) as usize).is_nan() {
            self.nans -= 1;
        }
        while self.dq.len() > self.head && self.dq[self.head] as i64 <= self.i - p {
            self.head += 1;
        }
        // compact dead head entries or the deque grows without bound (it
        // only ever pops from the tail); amortized O(1), no FP-op change
        if self.head > 2 * (self.p + 1) {
            self.dq.drain(0..self.head);
            self.head = 0;
        }
        if self.i < p - 1 || self.nans > 0 || self.dq.len() == self.head {
            return f64::NAN;
        }
        if self.want_index {
            (self.i as usize - self.dq[self.head]) as f64
        } else {
            self.ring.at(self.dq[self.head])
        }
    }
}

pub struct Change {
    p: usize,
    ring: Ring,
    i: i64,
    offset_only: bool,
}

impl Change {
    pub fn new(p: usize, offset_only: bool) -> Self {
        Change {
            p,
            ring: Ring::new(p + 1),
            i: -1,
            offset_only,
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        self.i += 1;
        self.ring.push(v);
        if self.i < self.p as i64 {
            return f64::NAN;
        }
        let old = self.ring.at((self.i - self.p as i64) as usize);
        if self.offset_only {
            old
        } else {
            v - old
        }
    }
}

pub struct Cross {
    pa: f64,
    pb: f64,
    first: bool,
    over: bool,
}

impl Cross {
    pub fn new(over: bool) -> Self {
        Cross {
            pa: f64::NAN,
            pb: f64::NAN,
            first: true,
            over,
        }
    }

    pub fn next(&mut self, a: f64, b: f64) -> f64 {
        let r = if self.first {
            0.0
        } else if self.over {
            if a > b && self.pa <= self.pb {
                1.0
            } else {
                0.0
            }
        } else if a < b && self.pa >= self.pb {
            1.0
        } else {
            0.0
        };
        self.pa = a;
        self.pb = b;
        self.first = false;
        r
    }
}

pub struct Tr {
    prev_close: f64,
    first: bool,
}

#[allow(clippy::new_without_default)]
impl Tr {
    pub fn new() -> Self {
        Tr {
            prev_close: f64::NAN,
            first: true,
        }
    }

    pub fn next(&mut self, high: f64, low: f64, close: f64) -> f64 {
        let r = if self.first {
            high - low
        } else {
            js_max(
                high - low,
                js_max(
                    (high - self.prev_close).abs(),
                    (low - self.prev_close).abs(),
                ),
            )
        };
        self.prev_close = close;
        self.first = false;
        r
    }
}

// ---- composed / new-in-v2 streams ---------------------------------------

pub struct Dema {
    e1: EmaFrom,
    e2: EmaFrom,
    triple: Option<EmaFrom>,
}

#[allow(clippy::self_named_constructors)]
impl Dema {
    pub fn dema(p: usize) -> Self {
        Dema {
            e1: EmaFrom::ema(p),
            e2: EmaFrom::ema(p),
            triple: None,
        }
    }

    pub fn tema(p: usize) -> Self {
        Dema {
            e1: EmaFrom::ema(p),
            e2: EmaFrom::ema(p),
            triple: Some(EmaFrom::ema(p)),
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        let a = self.e1.next(v);
        let b = self.e2.next(a);
        match &mut self.triple {
            None => 2.0 * a - b,
            Some(e3) => {
                let c = e3.next(b);
                3.0 * a - 3.0 * b + c
            }
        }
    }
}

pub struct Tma {
    s1: Sma,
    s2: Sma,
}

impl Tma {
    pub fn new(p: usize) -> Self {
        let p1 = ((p as f64 + 1.0) / 2.0).ceil() as usize;
        let p2 = (p as f64 / 2.0).floor() as usize + 1;
        Tma {
            s1: Sma::new(p1.max(1)),
            s2: Sma::new(p2.max(1)),
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        let a = self.s1.next(v);
        self.s2.next(a)
    }
}

pub struct Hull {
    half: Wma,
    full: Wma,
    smooth: Wma,
}

impl Hull {
    pub fn new(p: usize) -> Self {
        let half = ((p as f64 / 2.0).floor() as usize).max(1);
        let sm = (crate::jsmath::js_round((p as f64).sqrt()) as usize).max(1);
        Hull {
            half: Wma::new(half),
            full: Wma::new(p),
            smooth: Wma::new(sm),
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        let h = self.half.next(v);
        let f = self.full.next(v);
        self.smooth.next(2.0 * h - f)
    }
}

pub struct Roc {
    p: usize,
    ring: Ring,
    i: i64,
}

impl Roc {
    pub fn new(p: usize) -> Self {
        Roc {
            p,
            ring: Ring::new(p + 1),
            i: -1,
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        self.i += 1;
        self.ring.push(v);
        if self.i < self.p as i64 {
            return f64::NAN;
        }
        let base = self.ring.at((self.i - self.p as i64) as usize);
        // truthiness gate like the JS reference: 0 and NaN both yield NaN
        if base == 0.0 || base.is_nan() {
            f64::NAN
        } else {
            (100.0 * (v - base)) / base
        }
    }
}

pub struct Rising {
    p: usize,
    up: bool,
    prev: f64,
    run: usize,
}

impl Rising {
    pub fn new(p: usize, up: bool) -> Self {
        Rising {
            p,
            up,
            prev: f64::NAN,
            run: 0,
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        if v.is_nan() {
            self.prev = f64::NAN;
            self.run = 0;
            return 0.0;
        }
        let stepped = !self.prev.is_nan()
            && if self.up {
                v > self.prev
            } else {
                v < self.prev
            };
        self.run = if stepped { self.run + 1 } else { 0 };
        self.prev = v;
        if self.run >= self.p {
            1.0
        } else {
            0.0
        }
    }
}

pub struct Stoch {
    hh: Extreme,
    ll: Extreme,
}

impl Stoch {
    pub fn new(p: usize) -> Self {
        Stoch {
            hh: Extreme::new(p, true, false),
            ll: Extreme::new(p, false, false),
        }
    }

    pub fn next(&mut self, close: f64, high: f64, low: f64) -> f64 {
        let h = self.hh.next(high);
        let l = self.ll.next(low);
        let range = h - l;
        if range > 0.0 {
            (100.0 * (close - l)) / range
        } else {
            f64::NAN
        }
    }
}

pub struct Pivot {
    left: usize,
    right: usize,
    is_high: bool,
    ring: Ring,
    i: i64,
}

impl Pivot {
    pub fn new(left: usize, right: usize, is_high: bool) -> Self {
        Pivot {
            left,
            right,
            is_high,
            ring: Ring::new(left + right + 1),
            i: -1,
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        self.i += 1;
        self.ring.push(v);
        let size = (self.left + self.right + 1) as i64;
        if self.i < size - 1 {
            return f64::NAN;
        }
        let center = self.ring.at((self.i - self.right as i64) as usize);
        if center.is_nan() {
            return f64::NAN;
        }
        for k in (self.i - size + 1)..=self.i {
            if k == self.i - self.right as i64 {
                continue;
            }
            let o = self.ring.at(k as usize);
            if o.is_nan() {
                return f64::NAN;
            }
            let beats = if self.is_high {
                o >= center
            } else {
                o <= center
            };
            if beats {
                return f64::NAN;
            }
        }
        center
    }
}

pub struct Mfi {
    pos: SumStream,
    neg: SumStream,
    prev_tp: f64,
}

impl Mfi {
    pub fn new(p: usize) -> Self {
        Mfi {
            pos: SumStream::new(p),
            neg: SumStream::new(p),
            prev_tp: f64::NAN,
        }
    }

    pub fn next(&mut self, high: f64, low: f64, close: f64, volume: f64) -> f64 {
        let tp = (high + low + close) / 3.0;
        let flow = tp * volume;
        let up = if !self.prev_tp.is_nan() && tp > self.prev_tp {
            flow
        } else {
            0.0
        };
        let dn = if !self.prev_tp.is_nan() && tp < self.prev_tp {
            flow
        } else {
            0.0
        };
        self.prev_tp = tp;
        let ps = self.pos.next(up);
        let ns = self.neg.next(dn);
        if ps.is_nan() || ns.is_nan() {
            return f64::NAN;
        }
        if ns == 0.0 {
            if ps == 0.0 {
                50.0
            } else {
                100.0
            }
        } else {
            100.0 - 100.0 / (1.0 + ps / ns)
        }
    }
}

pub struct Obv {
    prev_close: f64,
    acc: f64,
}

#[allow(clippy::new_without_default)]
impl Obv {
    pub fn new() -> Self {
        Obv {
            prev_close: f64::NAN,
            acc: 0.0,
        }
    }

    pub fn next(&mut self, close: f64, volume: f64) -> f64 {
        if !self.prev_close.is_nan() {
            if close > self.prev_close {
                self.acc += volume;
            } else if close < self.prev_close {
                self.acc -= volume;
            }
        }
        self.prev_close = close;
        self.acc
    }
}

pub struct Vwap {
    key: f64,
    pv: f64,
    vv: f64,
    started: bool,
}

#[allow(clippy::new_without_default)]
impl Vwap {
    pub fn new() -> Self {
        Vwap {
            key: f64::NAN,
            pv: 0.0,
            vv: 0.0,
            started: false,
        }
    }

    pub fn next(&mut self, price: f64, volume: f64, day_key: f64) -> f64 {
        // JS compares dayKey !== key: NaN keys never compare equal, so a NaN
        // day key resets every bar — f64 == gives exactly that
        let same = self.started && day_key == self.key;
        if !same {
            self.key = day_key;
            self.pv = 0.0;
            self.vv = 0.0;
            self.started = true;
        }
        if !price.is_nan() && !volume.is_nan() {
            self.pv += price * volume;
            self.vv += volume;
        }
        if self.vv > 0.0 {
            self.pv / self.vv
        } else {
            f64::NAN
        }
    }
}

pub struct Linreg {
    p: usize,
    ring: Ring,
    i: i64,
    sx: f64,
    denom: f64,
}

impl Linreg {
    pub fn new(p: usize) -> Self {
        let pf = p as f64;
        let sx = (pf * (pf - 1.0)) / 2.0;
        let sxx = ((pf - 1.0) * pf * (2.0 * pf - 1.0)) / 6.0;
        Linreg {
            p,
            ring: Ring::new(p.max(1)),
            i: -1,
            sx,
            denom: pf * sxx - sx * sx,
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        self.i += 1;
        self.ring.push(v);
        if self.i < self.p as i64 - 1 {
            return f64::NAN;
        }
        if self.p == 1 {
            return v;
        }
        let mut sy = 0.0;
        let mut sxy = 0.0;
        for k in 0..self.p {
            let y = self.ring.at((self.i - self.p as i64 + 1) as usize + k);
            if !y.is_finite() {
                return f64::NAN;
            }
            sy += y;
            sxy += k as f64 * y;
        }
        let pf = self.p as f64;
        let b = (pf * sxy - self.sx * sy) / self.denom;
        let a = (sy - b * self.sx) / pf;
        a + b * (pf - 1.0)
    }
}

// ---- round-2 indicators ---------------------------------------------------

/// Wilder's directional system: +DI / -DI / ADX from RMA-smoothed TR and DMs
pub struct Dmi {
    alpha: f64,
    prev_h: f64,
    prev_l: f64,
    prev_c: f64,
    first: bool,
    s_tr: Option<f64>,
    s_plus: Option<f64>,
    s_minus: Option<f64>,
    s_adx: Option<f64>,
}

impl Dmi {
    pub fn new(p: usize) -> Self {
        Dmi {
            alpha: 1.0 / p as f64,
            prev_h: f64::NAN,
            prev_l: f64::NAN,
            prev_c: f64::NAN,
            first: true,
            s_tr: None,
            s_plus: None,
            s_minus: None,
            s_adx: None,
        }
    }

    fn rma(alpha: f64, st: &mut Option<f64>, v: f64) -> f64 {
        if !v.is_finite() {
            return f64::NAN;
        }
        let out = match *st {
            None => v,
            Some(prev) => alpha * v + (1.0 - alpha) * prev,
        };
        *st = Some(out);
        out
    }

    pub fn next(&mut self, high: f64, low: f64, close: f64) -> (f64, f64, f64) {
        let mut out = (f64::NAN, f64::NAN, f64::NAN);
        if self.first {
            self.first = false;
        } else {
            let up_move = high - self.prev_h;
            let down_move = self.prev_l - low;
            let plus_dm = if up_move > down_move && up_move > 0.0 {
                up_move
            } else {
                0.0
            };
            let minus_dm = if down_move > up_move && down_move > 0.0 {
                down_move
            } else {
                0.0
            };
            let tr = crate::jsmath::js_max(
                high - low,
                crate::jsmath::js_max((high - self.prev_c).abs(), (low - self.prev_c).abs()),
            );
            let tr_s = Self::rma(self.alpha, &mut self.s_tr, tr);
            let plus_s = Self::rma(self.alpha, &mut self.s_plus, plus_dm);
            let minus_s = Self::rma(self.alpha, &mut self.s_minus, minus_dm);
            if tr_s > 0.0 {
                let plus = (100.0 * plus_s) / tr_s;
                let minus = (100.0 * minus_s) / tr_s;
                let sum = plus + minus;
                let dx = if sum > 0.0 {
                    (100.0 * (plus - minus).abs()) / sum
                } else {
                    0.0
                };
                out = (plus, minus, Self::rma(self.alpha, &mut self.s_adx, dx));
            }
        }
        self.prev_h = high;
        self.prev_l = low;
        self.prev_c = close;
        out
    }
}

/// aroon over a p+1-bar window: 100 * (p - bars since extreme) / p
pub struct Aroon {
    p: f64,
    ex: Extreme,
}

impl Aroon {
    pub fn new(p: usize, up: bool) -> Self {
        Aroon {
            p: p as f64,
            ex: Extreme::new(p + 1, up, true),
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        let bars = self.ex.next(v);
        if bars.is_nan() {
            f64::NAN
        } else {
            (100.0 * (self.p - bars)) / self.p
        }
    }
}

/// Wilder's parabolic SAR
pub struct Sar {
    start: f64,
    inc: f64,
    max: f64,
    count: usize,
    prev_h: f64,
    prev_l: f64,
    prev2_h: f64,
    prev2_l: f64,
    prev_c: f64,
    up: bool,
    sar: f64,
    ep: f64,
    af: f64,
}

impl Sar {
    pub fn new(start: f64, inc: f64, max: f64) -> Self {
        Sar {
            start,
            inc,
            max,
            count: 0,
            prev_h: f64::NAN,
            prev_l: f64::NAN,
            prev2_h: f64::NAN,
            prev2_l: f64::NAN,
            prev_c: f64::NAN,
            up: true,
            sar: f64::NAN,
            ep: f64::NAN,
            af: 0.0,
        }
    }

    pub fn next(&mut self, high: f64, low: f64, close: f64) -> f64 {
        self.count += 1;
        if self.count == 1 {
            self.prev_h = high;
            self.prev_l = low;
            self.prev_c = close;
            return f64::NAN;
        }
        if self.count == 2 {
            self.up = close >= self.prev_c;
            self.sar = if self.up {
                low.min(self.prev_l)
            } else {
                crate::jsmath::js_max(high, self.prev_h)
            };
            self.ep = if self.up {
                crate::jsmath::js_max(high, self.prev_h)
            } else {
                low.min(self.prev_l)
            };
            self.af = self.start;
            self.prev2_h = self.prev_h;
            self.prev2_l = self.prev_l;
            self.prev_h = high;
            self.prev_l = low;
            return self.sar;
        }
        self.sar += self.af * (self.ep - self.sar);
        if self.up {
            self.sar = self.sar.min(self.prev_l).min(self.prev2_l);
            if low < self.sar {
                self.up = false;
                self.sar = self.ep;
                self.ep = low;
                self.af = self.start;
            } else if high > self.ep {
                self.ep = high;
                self.af = self.max.min(self.af + self.inc);
            }
        } else {
            self.sar =
                crate::jsmath::js_max(crate::jsmath::js_max(self.sar, self.prev_h), self.prev2_h);
            if high > self.sar {
                self.up = true;
                self.sar = self.ep;
                self.ep = high;
                self.af = self.start;
            } else if low < self.ep {
                self.ep = low;
                self.af = self.max.min(self.af + self.inc);
            }
        }
        self.prev2_h = self.prev_h;
        self.prev2_l = self.prev_l;
        self.prev_h = high;
        self.prev_l = low;
        self.sar
    }
}

/// supertrend line + direction (+1 up / -1 down)
pub struct Supertrend {
    mult: f64,
    tr: Tr,
    atr: EmaFrom,
    f_upper: f64,
    f_lower: f64,
    dir: f64,
    prev_close: f64,
}

impl Supertrend {
    pub fn new(p: usize, mult: f64) -> Self {
        Supertrend {
            mult,
            tr: Tr::new(),
            atr: EmaFrom::wilders(p),
            f_upper: f64::NAN,
            f_lower: f64::NAN,
            dir: 1.0,
            prev_close: f64::NAN,
        }
    }

    pub fn next(&mut self, high: f64, low: f64, close: f64) -> (f64, f64) {
        let a = self.atr.next(self.tr.next(high, low, close));
        if a.is_nan() {
            self.prev_close = close;
            return (f64::NAN, f64::NAN);
        }
        let mid = (high + low) / 2.0;
        let b_upper = mid + self.mult * a;
        let b_lower = mid - self.mult * a;
        self.f_upper =
            if self.f_upper.is_nan() || b_upper < self.f_upper || self.prev_close > self.f_upper {
                b_upper
            } else {
                self.f_upper
            };
        self.f_lower =
            if self.f_lower.is_nan() || b_lower > self.f_lower || self.prev_close < self.f_lower {
                b_lower
            } else {
                self.f_lower
            };
        if self.dir > 0.0 && close < self.f_lower {
            self.dir = -1.0;
        } else if self.dir < 0.0 && close > self.f_upper {
            self.dir = 1.0;
        }
        self.prev_close = close;
        (
            if self.dir > 0.0 {
                self.f_lower
            } else {
                self.f_upper
            },
            self.dir,
        )
    }
}

/// commodity channel index over typical price
pub struct Cci {
    p: usize,
    ring: Ring,
    i: i64,
}

impl Cci {
    pub fn new(p: usize) -> Self {
        Cci {
            p,
            ring: Ring::new(p),
            i: -1,
        }
    }

    pub fn next(&mut self, high: f64, low: f64, close: f64) -> f64 {
        let tp = (high + low + close) / 3.0;
        self.i += 1;
        self.ring.push(tp);
        if self.i < self.p as i64 - 1 {
            return f64::NAN;
        }
        let start = (self.i - self.p as i64 + 1) as usize;
        let mut sum = 0.0;
        for k in 0..self.p {
            let v = self.ring.at(start + k);
            if v.is_nan() {
                return f64::NAN;
            }
            sum += v;
        }
        let mean = sum / self.p as f64;
        let mut md = 0.0;
        for k in 0..self.p {
            md += (self.ring.at(start + k) - mean).abs();
        }
        md /= self.p as f64;
        if md > 0.0 {
            (tp - mean) / (0.015 * md)
        } else {
            f64::NAN
        }
    }
}

/// Williams %R
pub struct Willr {
    hh: Extreme,
    ll: Extreme,
}

impl Willr {
    pub fn new(p: usize) -> Self {
        Willr {
            hh: Extreme::new(p, true, false),
            ll: Extreme::new(p, false, false),
        }
    }

    pub fn next(&mut self, high: f64, low: f64, close: f64) -> f64 {
        let h = self.hh.next(high);
        let l = self.ll.next(low);
        let range = h - l;
        if range > 0.0 {
            (-100.0 * (h - close)) / range
        } else {
            f64::NAN
        }
    }
}

/// Pearson correlation over the window; any NaN in either window poisons.
/// Ring instead of shift-vectors: same oldest-to-newest summation order,
/// without the O(p) memmove every bar
pub struct Correlation {
    p: usize,
    ra: Ring,
    rb: Ring,
    i: i64,
}

impl Correlation {
    pub fn new(p: usize) -> Self {
        Correlation {
            p,
            ra: Ring::new(p),
            rb: Ring::new(p),
            i: -1,
        }
    }

    pub fn next(&mut self, a: f64, b: f64) -> f64 {
        self.i += 1;
        self.ra.push(a);
        self.rb.push(b);
        if self.i < self.p as i64 - 1 {
            return f64::NAN;
        }
        let start = (self.i - self.p as i64 + 1) as usize;
        let pf = self.p as f64;
        let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for k in 0..self.p {
            let x = self.ra.at(start + k);
            let y = self.rb.at(start + k);
            if x.is_nan() || y.is_nan() {
                return f64::NAN;
            }
            sa += x;
            sb += y;
            saa += x * x;
            sbb += y * y;
            sab += x * y;
        }
        let cov = pf * sab - sa * sb;
        let va = pf * saa - sa * sa;
        let vb = pf * sbb - sb * sb;
        if va > 0.0 && vb > 0.0 {
            cov / (va * vb).sqrt()
        } else {
            f64::NAN
        }
    }
}

/// percentile with linear interpolation over the sorted window
pub struct Percentile {
    p: usize,
    q: f64,
    ring: Ring,
    i: i64,
}

impl Percentile {
    pub fn new(p: usize, q: f64) -> Self {
        Percentile {
            p,
            q,
            ring: Ring::new(p),
            i: -1,
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        self.i += 1;
        self.ring.push(v);
        if self.i < self.p as i64 - 1 {
            return f64::NAN;
        }
        let start = (self.i - self.p as i64 + 1) as usize;
        let mut sorted = Vec::with_capacity(self.p);
        for k in 0..self.p {
            let x = self.ring.at(start + k);
            if x.is_nan() {
                return f64::NAN;
            }
            sorted.push(x);
        }
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let rank = (self.q / 100.0) * (self.p as f64 - 1.0);
        let lo = rank.floor() as usize;
        let hi = rank.ceil() as usize;
        if lo == hi {
            return sorted[lo];
        }
        sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo as f64)
    }
}

/// Arnaud Legoux MA: gaussian-weighted window, newest at k = p-1
pub struct Alma {
    p: usize,
    weights: Vec<f64>,
    norm: f64,
    ring: Ring,
    i: i64,
}

impl Alma {
    pub fn new(p: usize, offset: f64, sigma: f64) -> Self {
        let m = offset * (p as f64 - 1.0);
        let sw = p as f64 / sigma;
        let weights: Vec<f64> = (0..p)
            .map(|k| (-((k as f64 - m) * (k as f64 - m)) / (2.0 * sw * sw)).exp())
            .collect();
        let norm = weights.iter().fold(0.0, |a, b| a + b);
        Alma {
            p,
            weights,
            norm,
            ring: Ring::new(p),
            i: -1,
        }
    }

    pub fn next(&mut self, v: f64) -> f64 {
        self.i += 1;
        self.ring.push(v);
        if self.i < self.p as i64 - 1 {
            return f64::NAN;
        }
        let start = (self.i - self.p as i64 + 1) as usize;
        let mut sum = 0.0;
        for k in 0..self.p {
            let x = self.ring.at(start + k);
            if x.is_nan() {
                return f64::NAN;
            }
            sum += self.weights[k] * x;
        }
        sum / self.norm
    }
}
