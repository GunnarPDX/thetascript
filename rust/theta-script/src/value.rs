//! Per-bar runtime values. `Null` mirrors JavaScript's `null` in draw
//! records and style locks; it never appears in script expressions.

use chrono_tz::Tz;
use std::cell::Cell;

use std::cell::RefCell;
use std::rc::Rc;

#[derive(Clone, Debug, Default)]
pub enum Val {
    Num(f64),
    Str(String),
    Ref(usize), // plot-ref from plot()/hline()
    // script arrays are mutable reference values (array.* namespace)
    Arr(Rc<RefCell<Vec<Val>>>),
    #[default]
    Null,
}

impl Val {
    pub fn nan() -> Val {
        Val::Num(f64::NAN)
    }

    /// numeric view: strings/refs/null read as NaN (the reference feeds raw
    /// values into numeric contexts where JS coercion would; the corpus
    /// never exercises string coercion, which the spec marks UB)
    pub fn num(&self) -> f64 {
        match self {
            Val::Num(v) => *v,
            _ => f64::NAN,
        }
    }

    pub fn truthy(&self) -> bool {
        match self {
            Val::Num(v) => *v != 0.0 && !v.is_nan(),
            Val::Str(s) => !s.is_empty(),
            Val::Ref(_) | Val::Arr(_) => true,
            Val::Null => false,
        }
    }

    /// strict equality (`==` operator): same type, same value; arrays
    /// compare by reference identity
    pub fn strict_eq(&self, other: &Val) -> bool {
        match (self, other) {
            (Val::Num(a), Val::Num(b)) => a == b,
            (Val::Str(a), Val::Str(b)) => a == b,
            (Val::Ref(a), Val::Ref(b)) => a == b,
            (Val::Arr(a), Val::Arr(b)) => Rc::ptr_eq(a, b),
            (Val::Null, Val::Null) => true,
            _ => false,
        }
    }

    /// `Object.is` semantics for style locks: NaN equals NaN, -0 ≠ 0
    pub fn object_is(&self, other: &Val) -> bool {
        match (self, other) {
            (Val::Num(a), Val::Num(b)) => a.to_bits() == b.to_bits(),
            _ => self.strict_eq(other),
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Val::Str(s) => Some(s),
            _ => None,
        }
    }
}

/// per-bar context handed to builtin instances
pub struct CallCtx {
    pub i: usize,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub time_ms: f64,
    pub tz: Tz,
    day_key: Cell<f64>, // NaN = not yet computed this bar
    day_key_done: Cell<bool>,
}

impl CallCtx {
    pub fn new(tz: Tz) -> Self {
        CallCtx {
            i: 0,
            open: f64::NAN,
            high: f64::NAN,
            low: f64::NAN,
            close: f64::NAN,
            volume: f64::NAN,
            time_ms: f64::NAN,
            tz,
            day_key: Cell::new(f64::NAN),
            day_key_done: Cell::new(false),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn reset_bar(
        &mut self,
        i: usize,
        open: f64,
        high: f64,
        low: f64,
        close: f64,
        volume: f64,
        time_ms: f64,
    ) {
        self.i = i;
        self.open = open;
        self.high = high;
        self.low = low;
        self.close = close;
        self.volume = volume;
        self.time_ms = time_ms;
        self.day_key_done.set(false);
    }

    /// snapshot/restore the bar fields around a security() sub-evaluation
    pub fn save_bar(&self) -> (usize, f64, f64, f64, f64, f64, f64) {
        (
            self.i,
            self.open,
            self.high,
            self.low,
            self.close,
            self.volume,
            self.time_ms,
        )
    }

    pub fn restore_bar(&mut self, s: (usize, f64, f64, f64, f64, f64, f64)) {
        self.reset_bar(s.0, s.1, s.2, s.3, s.4, s.5, s.6);
    }

    /// session-timezone calendar day of the current bar (vwap resets)
    pub fn day_key(&self) -> f64 {
        if !self.day_key_done.get() {
            let key = match crate::time::wall_parts(self.time_ms, self.tz) {
                Some((y, mo, d, ..)) => y * 10_000.0 + mo * 100.0 + d,
                None => f64::NAN,
            };
            self.day_key.set(key);
            self.day_key_done.set(true);
        }
        self.day_key.get()
    }

    /// vwap reset key: session = calendar day, week = Monday-start week
    /// (wall days since epoch, +3 aligns Monday), month = calendar month
    pub fn anchor_key(&self, anchor: &str) -> f64 {
        match anchor {
            "week" => {
                let days = crate::time::wall_epoch_days(self.time_ms, self.tz);
                if days.is_nan() {
                    f64::NAN
                } else {
                    ((days + 3.0) / 7.0).floor()
                }
            }
            "month" => match crate::time::wall_parts(self.time_ms, self.tz) {
                Some((y, mo, ..)) => y * 100.0 + mo,
                None => f64::NAN,
            },
            _ => self.day_key(),
        }
    }
}
