//! Builtin registry — the Rust counterpart of js/src/builtins.js. Each
//! call site gets its own instance (a boxed FnMut holding its stream state);
//! window lengths are validated with the reference error message and locked
//! at the first call.

use crate::jsmath::{js_max, js_min, js_number_to_string, js_round, js_sign, js_to_fixed};
use crate::streams::*;

// str.* coercion: strings pass, numbers use the JS rendering, arrays render
// "[array]" (same as tostring and the + operator), anything else ''
fn js_str(v: Option<&Val>) -> String {
    match v {
        Some(Val::Str(s)) => s.clone(),
        Some(Val::Num(n)) => js_number_to_string(*n),
        Some(Val::Arr(_)) => "[array]".into(),
        _ => String::new(),
    }
}
use crate::time::{epoch_from_wall, parse_timestamp, wall_parts};
use crate::value::{CallCtx, Val};

pub type Builtin = Box<dyn FnMut(&CallCtx, &[Val]) -> Result<Val, String>>;

// bounded work per bar: an absurd period would eagerly allocate huge
// windows/weight tables — an untrusted script must not be able to
const MAX_PERIOD: usize = 100_000;
const MAX_ARRAY: usize = 100_000; // elements; same bound as MAX_PERIOD

fn num_arg(v: Option<&Val>, name: &str) -> Result<usize, String> {
    match v {
        Some(Val::Num(n)) if n.is_finite() => {
            let p = js_max(1.0, js_round(*n));
            if p > MAX_PERIOD as f64 {
                return Err(format!("{}: period too large (max {})", name, MAX_PERIOD));
            }
            Ok(p as usize)
        }
        _ => Err(format!("{}: expected a number", name)),
    }
}

fn arg_num(args: &[Val], k: usize) -> f64 {
    args.get(k).map(Val::num).unwrap_or(f64::NAN)
}

/// series+length builtin: length locked at first call
fn windowed(
    name: &'static str,
    dflt: Option<usize>,
    mk: impl Fn(usize) -> Box<dyn FnMut(f64) -> f64> + 'static,
) -> Builtin {
    let mut stream: Option<Box<dyn FnMut(f64) -> f64>> = None;
    let mut p0 = 0usize;
    Box::new(move |_ctx, args| {
        let p = match (args.get(1), dflt) {
            (Some(v), _) => num_arg(Some(v), name)?,
            (None, Some(d)) => d,
            (None, None) => return Err(format!("{}: expected a number", name)),
        };
        if stream.is_none() {
            p0 = p;
            stream = Some(mk(p));
        } else if p != p0 {
            return Err(format!("{}: length must not change between bars", name));
        }
        Ok(Val::Num((stream.as_mut().unwrap())(arg_num(args, 0))))
    })
}

/// bar-fed builtin whose single length argument (args[0]) is locked
type BarStreamFn = Box<dyn FnMut(&CallCtx) -> f64>;

fn bar_windowed(name: &'static str, mk: impl Fn(usize) -> BarStreamFn + 'static) -> Builtin {
    let mut stream: Option<BarStreamFn> = None;
    let mut p0 = 0usize;
    Box::new(move |ctx, args| {
        let p = num_arg(args.first(), name)?;
        if stream.is_none() {
            p0 = p;
            stream = Some(mk(p));
        } else if p != p0 {
            return Err(format!("{}: length must not change between bars", name));
        }
        Ok(Val::Num((stream.as_mut().unwrap())(ctx)))
    })
}

fn stateless(f: impl Fn(&CallCtx, &[Val]) -> Result<Val, String> + 'static) -> Builtin {
    Box::new(move |ctx, args| f(ctx, args))
}

fn math1(f: fn(f64) -> f64) -> Builtin {
    stateless(move |_ctx, args| Ok(Val::Num(f(arg_num(args, 0)))))
}

type StreamFn = Box<dyn FnMut(f64) -> f64>;

fn wstream(mk: impl Fn(usize) -> StreamFn + Copy + 'static) -> impl Fn(usize) -> StreamFn {
    mk
}

type ScriptArr = std::rc::Rc<std::cell::RefCell<Vec<Val>>>;

fn arr_of(v: Option<&Val>, name: &str) -> Result<ScriptArr, String> {
    match v {
        Some(Val::Arr(a)) => Ok(a.clone()),
        _ => Err(format!("{}: expected an array", name)),
    }
}

// element index: rounded, in-range, else None
fn arr_index(v: Option<&Val>, len: usize) -> Option<usize> {
    match v {
        Some(Val::Num(n)) if n.is_finite() => {
            let i = js_round(*n);
            if i >= 0.0 && (i as usize) < len {
                Some(i as usize)
            } else {
                None
            }
        }
        _ => None,
    }
}

// numeric aggregate skipping non-numbers/na; empty -> na
fn arr_aggregate(name: &'static str, f: impl Fn(&[f64]) -> f64 + 'static) -> Builtin {
    stateless(move |_ctx, args| {
        let arr = arr_of(args.first(), name)?;
        let nums: Vec<f64> = arr
            .borrow()
            .iter()
            .filter_map(|v| match v {
                Val::Num(n) if !n.is_nan() => Some(*n),
                _ => None,
            })
            .collect();
        Ok(Val::Num(if nums.is_empty() { f64::NAN } else { f(&nums) }))
    })
}

// Wilder's directional system parts: 0 = +DI, 1 = -DI, 2 = ADX
fn dmi_part(field: usize) -> Builtin {
    let mut s: Option<Dmi> = None;
    let mut p0 = 0usize;
    Box::new(move |ctx, args| {
        let name = ["diplus", "diminus", "adx"][field];
        let p = num_arg(args.first(), name)?;
        if s.is_none() {
            p0 = p;
            s = Some(Dmi::new(p));
        } else if p != p0 {
            return Err(format!("{}: length must not change between bars", name));
        }
        let (plus, minus, adx) = s.as_mut().unwrap().next(ctx.high, ctx.low, ctx.close);
        Ok(Val::Num([plus, minus, adx][field]))
    })
}

fn aroon_part(up: bool) -> Builtin {
    let mut s: Option<Aroon> = None;
    let mut p0 = 0usize;
    Box::new(move |ctx, args| {
        let name = if up { "aroonup" } else { "aroondown" };
        let p = num_arg(args.first(), name)?;
        if s.is_none() {
            p0 = p;
            s = Some(Aroon::new(p, up));
        } else if p != p0 {
            return Err(format!("{}: length must not change between bars", name));
        }
        Ok(Val::Num(s.as_mut().unwrap().next(if up {
            ctx.high
        } else {
            ctx.low
        })))
    })
}

// supertrend parts: 0 = line, 1 = direction
fn supertrend_part(field: usize) -> Builtin {
    let mut s: Option<Supertrend> = None;
    let mut key0 = (0usize, 0.0f64);
    Box::new(move |ctx, args| {
        let name = if field == 0 {
            "supertrend"
        } else {
            "supertrend_dir"
        };
        let p = num_arg(args.first(), name)?;
        let mult = match args.get(1) {
            Some(Val::Num(n)) if n.is_finite() => *n,
            _ => 3.0,
        };
        let key = (p, mult);
        if s.is_none() {
            key0 = key;
            s = Some(Supertrend::new(p, mult));
        } else if key != key0 {
            return Err(format!("{}: parameters must not change between bars", name));
        }
        let (line_v, dir) = s.as_mut().unwrap().next(ctx.high, ctx.low, ctx.close);
        Ok(Val::Num(if field == 0 { line_v } else { dir }))
    })
}

fn calendar(part: usize) -> Builtin {
    stateless(move |ctx, args| {
        let v = arg_num(args, 0);
        if v.is_nan() {
            return Ok(Val::nan());
        }
        let out = match wall_parts(v, ctx.tz) {
            Some((y, mo, d, h, mi, dow)) => [y, mo, d, dow, h, mi][part],
            None => f64::NAN,
        };
        Ok(Val::Num(out))
    })
}

pub fn make_builtin(name: &str) -> Option<Builtin> {
    let b: Builtin = match name {
        "sma" => windowed(
            "sma",
            None,
            wstream(|p| {
                let mut s = Sma::new(p);
                Box::new(move |v| s.next(v))
            }),
        ),
        "ema" => windowed(
            "ema",
            None,
            wstream(|p| {
                let mut s = EmaFrom::ema(p);
                Box::new(move |v| s.next(v))
            }),
        ),
        "wma" => windowed(
            "wma",
            None,
            wstream(|p| {
                let mut s = Wma::new(p);
                Box::new(move |v| s.next(v))
            }),
        ),
        "rsi" => windowed(
            "rsi",
            None,
            wstream(|p| {
                let mut s = Rsi::new(p);
                Box::new(move |v| s.next(v))
            }),
        ),
        "stdev" => windowed(
            "stdev",
            None,
            wstream(|p| {
                let mut s = Stdev::new(p);
                Box::new(move |v| s.next(v))
            }),
        ),
        "sum" => windowed(
            "sum",
            None,
            wstream(|p| {
                let mut s = SumStream::new(p);
                Box::new(move |v| s.next(v))
            }),
        ),
        "highest" => windowed(
            "highest",
            None,
            wstream(|p| {
                let mut s = Extreme::new(p, true, false);
                Box::new(move |v| s.next(v))
            }),
        ),
        "lowest" => windowed(
            "lowest",
            None,
            wstream(|p| {
                let mut s = Extreme::new(p, false, false);
                Box::new(move |v| s.next(v))
            }),
        ),
        "highestbars" => windowed(
            "highestbars",
            None,
            wstream(|p| {
                let mut s = Extreme::new(p, true, true);
                Box::new(move |v| s.next(v))
            }),
        ),
        "lowestbars" => windowed(
            "lowestbars",
            None,
            wstream(|p| {
                let mut s = Extreme::new(p, false, true);
                Box::new(move |v| s.next(v))
            }),
        ),
        "change" => windowed(
            "change",
            Some(1),
            wstream(|p| {
                let mut s = Change::new(p, false);
                Box::new(move |v| s.next(v))
            }),
        ),
        "mom" => windowed(
            "mom",
            Some(1),
            wstream(|p| {
                let mut s = Change::new(p, false);
                Box::new(move |v| s.next(v))
            }),
        ),
        "offset" => windowed(
            "offset",
            None,
            wstream(|p| {
                let mut s = Change::new(p, true);
                Box::new(move |v| s.next(v))
            }),
        ),
        "wilders" => windowed(
            "wilders",
            None,
            wstream(|p| {
                let mut s = EmaFrom::wilders(p);
                Box::new(move |v| s.next(v))
            }),
        ),
        "dema" => windowed(
            "dema",
            None,
            wstream(|p| {
                let mut s = Dema::dema(p);
                Box::new(move |v| s.next(v))
            }),
        ),
        "tema" => windowed(
            "tema",
            None,
            wstream(|p| {
                let mut s = Dema::tema(p);
                Box::new(move |v| s.next(v))
            }),
        ),
        "tma" => windowed(
            "tma",
            None,
            wstream(|p| {
                let mut s = Tma::new(p);
                Box::new(move |v| s.next(v))
            }),
        ),
        "hull" => windowed(
            "hull",
            None,
            wstream(|p| {
                let mut s = Hull::new(p);
                Box::new(move |v| s.next(v))
            }),
        ),
        "roc" => windowed(
            "roc",
            None,
            wstream(|p| {
                let mut s = Roc::new(p);
                Box::new(move |v| s.next(v))
            }),
        ),
        "linreg" => windowed(
            "linreg",
            None,
            wstream(|p| {
                let mut s = Linreg::new(p);
                Box::new(move |v| s.next(v))
            }),
        ),
        "rising" => windowed(
            "rising",
            None,
            wstream(|p| {
                let mut s = Rising::new(p, true);
                Box::new(move |v| s.next(v))
            }),
        ),
        "falling" => windowed(
            "falling",
            None,
            wstream(|p| {
                let mut s = Rising::new(p, false);
                Box::new(move |v| s.next(v))
            }),
        ),

        "crossover" => {
            let mut s = Cross::new(true);
            Box::new(move |_ctx, args| Ok(Val::Num(s.next(arg_num(args, 0), arg_num(args, 1)))))
        }
        "crossunder" => {
            let mut s = Cross::new(false);
            Box::new(move |_ctx, args| Ok(Val::Num(s.next(arg_num(args, 0), arg_num(args, 1)))))
        }
        "cross" => {
            // both streams must advance every bar
            let mut over = Cross::new(true);
            let mut under = Cross::new(false);
            Box::new(move |_ctx, args| {
                let o = over.next(arg_num(args, 0), arg_num(args, 1));
                let u = under.next(arg_num(args, 0), arg_num(args, 1));
                Ok(Val::Num(if o != 0.0 || u != 0.0 { 1.0 } else { 0.0 }))
            })
        }

        "tr" => {
            let mut s = Tr::new();
            Box::new(move |ctx, _args| Ok(Val::Num(s.next(ctx.high, ctx.low, ctx.close))))
        }
        "atr" => bar_windowed("atr", |p| {
            let mut tr = Tr::new();
            let mut w = EmaFrom::wilders(p);
            Box::new(move |ctx| w.next(tr.next(ctx.high, ctx.low, ctx.close)))
        }),
        "stoch" => bar_windowed("stoch", |p| {
            let mut s = Stoch::new(p);
            Box::new(move |ctx| s.next(ctx.close, ctx.high, ctx.low))
        }),
        "mfi" => bar_windowed("mfi", |p| {
            let mut s = Mfi::new(p);
            Box::new(move |ctx| s.next(ctx.high, ctx.low, ctx.close, ctx.volume))
        }),
        "obv" => {
            let mut s = Obv::new();
            Box::new(move |ctx, _args| Ok(Val::Num(s.next(ctx.close, ctx.volume))))
        }
        "vwap" => {
            // vwap() / vwap(src) / vwap(src, anchor) / vwap("week") — a string
            // first arg is the anchor with the default hlc3 source, so the
            // natural spelling of "weekly vwap" works. The anchor locks at
            // first call like every other stream parameter
            let mut s = Vwap::new();
            let mut locked: Option<String> = None;
            Box::new(move |ctx, args| {
                let anchor_arg = match (args.first(), args.get(1)) {
                    (Some(Val::Str(a)), _) => a.as_str(),
                    (_, Some(Val::Str(a))) => a.as_str(),
                    _ => "session",
                };
                match &locked {
                    None => locked = Some(anchor_arg.to_string()),
                    Some(l) if l == anchor_arg => {}
                    Some(_) => {
                        return Err("vwap: anchor must not change between bars".into());
                    }
                }
                let price = match args.first() {
                    None | Some(Val::Str(_)) => (ctx.high + ctx.low + ctx.close) / 3.0,
                    Some(v) => v.num(), // non-number source values feed NaN
                };
                let key = ctx.anchor_key(locked.as_deref().unwrap());
                Ok(Val::Num(s.next(price, ctx.volume, key)))
            })
        }
        "pivothigh" | "pivotlow" => {
            let is_high = name == "pivothigh";
            let nm: &'static str = if is_high { "pivothigh" } else { "pivotlow" };
            let mut stream: Option<Pivot> = None;
            let mut key0 = (0usize, 0usize);
            Box::new(move |ctx, args| {
                let l = num_arg(args.first(), nm)?;
                let r = num_arg(args.get(1), nm)?;
                if stream.is_none() {
                    key0 = (l, r);
                    stream = Some(Pivot::new(l, r, is_high));
                } else if key0 != (l, r) {
                    return Err(format!("{}: lengths must not change between bars", nm));
                }
                let v = if is_high { ctx.high } else { ctx.low };
                Ok(Val::Num(stream.as_mut().unwrap().next(v)))
            })
        }

        "cum" => {
            let mut acc = 0.0f64;
            Box::new(move |_ctx, args| {
                let v = arg_num(args, 0);
                acc += if v.is_nan() { 0.0 } else { v };
                Ok(Val::Num(acc))
            })
        }
        "valuewhen" => {
            let mut last = Val::nan();
            Box::new(move |_ctx, args| {
                if args.first().is_some_and(Val::truthy) {
                    last = args.get(1).cloned().unwrap_or(Val::nan());
                }
                Ok(last.clone())
            })
        }
        "barssince" => {
            let mut last: i64 = -1;
            Box::new(move |ctx, args| {
                if args.first().is_some_and(Val::truthy) {
                    last = ctx.i as i64;
                }
                Ok(Val::Num(if last < 0 {
                    f64::NAN
                } else {
                    (ctx.i as i64 - last) as f64
                }))
            })
        }

        "nz" => stateless(|_ctx, args| {
            let v = args.first().cloned().unwrap_or(Val::nan());
            let is_na = matches!(&v, Val::Num(n) if n.is_nan());
            if is_na {
                Ok(args.get(1).cloned().unwrap_or(Val::Num(0.0)))
            } else {
                Ok(v)
            }
        }),
        "na" => stateless(|_ctx, args| {
            let is_na = matches!(args.first(), Some(Val::Num(n)) if n.is_nan());
            Ok(Val::Num(if is_na { 1.0 } else { 0.0 }))
        }),
        "abs" => math1(f64::abs),
        "sqrt" => math1(f64::sqrt),
        "log" => math1(f64::ln),
        "exp" => math1(f64::exp),
        "round" => math1(js_round),
        "floor" => math1(f64::floor),
        "ceil" => math1(f64::ceil),
        "sign" => math1(js_sign),
        "pow" => stateless(|_ctx, args| Ok(Val::Num(arg_num(args, 0).powf(arg_num(args, 1))))),
        // variadic numeric args: at least one, non-numbers read as NaN
        "min" => stateless(|_ctx, args| {
            if args.is_empty() {
                return Err("min: expected at least one argument".into());
            }
            let mut it = args.iter().map(Val::num);
            let first = it.next().unwrap();
            Ok(Val::Num(it.fold(first, js_min)))
        }),
        "max" => stateless(|_ctx, args| {
            if args.is_empty() {
                return Err("max: expected at least one argument".into());
            }
            let mut it = args.iter().map(Val::num);
            let first = it.next().unwrap();
            Ok(Val::Num(it.fold(first, js_max)))
        }),
        "avg" => stateless(|_ctx, args| {
            if args.is_empty() {
                return Err("avg: expected at least one argument".into());
            }
            let mut it = args.iter().map(Val::num);
            let first = it.next().unwrap();
            let total = it.fold(first, |a, b| a + b);
            Ok(Val::Num(total / args.len() as f64))
        }),
        "iff" => stateless(|_ctx, args| {
            if args.first().is_some_and(Val::truthy) {
                Ok(args.get(1).cloned().unwrap_or(Val::nan()))
            } else {
                Ok(args.get(2).cloned().unwrap_or(Val::nan()))
            }
        }),
        "tostring" => stateless(|_ctx, args| {
            let v = args.first().cloned().unwrap_or(Val::nan());
            match v {
                Val::Str(s) => Ok(Val::Str(s)),
                Val::Arr(_) => Ok(Val::Str("[array]".into())),
                Val::Num(n) => {
                    if let Some(Val::Num(p)) = args.get(1) {
                        if p.is_finite() {
                            let prec = js_max(0.0, js_min(8.0, js_round(*p))) as usize;
                            return Ok(Val::Str(js_to_fixed(n, prec)));
                        }
                    }
                    Ok(Val::Str(if n.is_nan() {
                        "NaN".into()
                    } else {
                        js_number_to_string(n)
                    }))
                }
                other => Ok(Val::Str(format!("{:?}", other))),
            }
        }),

        // ---- round-2 indicators --------------------------------------------
        "adx" => dmi_part(2),
        "diplus" => dmi_part(0),
        "diminus" => dmi_part(1),
        "aroonup" => aroon_part(true),
        "aroondown" => aroon_part(false),
        "sar" => {
            let mut s: Option<Sar> = None;
            let mut key0 = (0.0, 0.0, 0.0);
            Box::new(move |ctx, args| {
                let g = |k: usize, d: f64| match args.get(k) {
                    Some(Val::Num(n)) if n.is_finite() => *n,
                    _ => d,
                };
                let key = (g(0, 0.02), g(1, 0.02), g(2, 0.2));
                if s.is_none() {
                    key0 = key;
                    s = Some(Sar::new(key.0, key.1, key.2));
                } else if key != key0 {
                    return Err("sar: parameters must not change between bars".into());
                }
                Ok(Val::Num(
                    s.as_mut().unwrap().next(ctx.high, ctx.low, ctx.close),
                ))
            })
        }
        "supertrend" => supertrend_part(0),
        "supertrend_dir" => supertrend_part(1),
        "cci" => {
            let mut s: Option<Cci> = None;
            let mut p0 = 0usize;
            Box::new(move |ctx, args| {
                let p = num_arg(args.first(), "cci")?;
                if s.is_none() {
                    p0 = p;
                    s = Some(Cci::new(p));
                } else if p != p0 {
                    return Err("cci: length must not change between bars".into());
                }
                Ok(Val::Num(
                    s.as_mut().unwrap().next(ctx.high, ctx.low, ctx.close),
                ))
            })
        }
        "willr" => {
            let mut s: Option<Willr> = None;
            let mut p0 = 0usize;
            Box::new(move |ctx, args| {
                let p = num_arg(args.first(), "willr")?;
                if s.is_none() {
                    p0 = p;
                    s = Some(Willr::new(p));
                } else if p != p0 {
                    return Err("willr: length must not change between bars".into());
                }
                Ok(Val::Num(
                    s.as_mut().unwrap().next(ctx.high, ctx.low, ctx.close),
                ))
            })
        }
        "correlation" => {
            let mut s: Option<Correlation> = None;
            let mut p0 = 0usize;
            Box::new(move |_ctx, args| {
                let p = num_arg(args.get(2), "correlation")?;
                if s.is_none() {
                    p0 = p;
                    s = Some(Correlation::new(p));
                } else if p != p0 {
                    return Err("correlation: length must not change between bars".into());
                }
                Ok(Val::Num(
                    s.as_mut().unwrap().next(arg_num(args, 0), arg_num(args, 1)),
                ))
            })
        }
        "percentile" => {
            let mut s: Option<Percentile> = None;
            let mut key0 = (0usize, 0.0f64);
            Box::new(move |_ctx, args| {
                let p = num_arg(args.get(1), "percentile")?;
                // clamp: an out-of-range rank would index past the sorted
                // window
                let q = match args.get(2) {
                    Some(Val::Num(n)) if n.is_finite() => js_max(0.0, js_min(100.0, *n)),
                    _ => 50.0,
                };
                let key = (p, q);
                if s.is_none() {
                    key0 = key;
                    s = Some(Percentile::new(p, q));
                } else if key != key0 {
                    return Err("percentile: parameters must not change between bars".into());
                }
                Ok(Val::Num(s.as_mut().unwrap().next(arg_num(args, 0))))
            })
        }
        "median" => {
            let mut s: Option<Percentile> = None;
            let mut p0 = 0usize;
            Box::new(move |_ctx, args| {
                let p = num_arg(args.get(1), "median")?;
                if s.is_none() {
                    p0 = p;
                    s = Some(Percentile::new(p, 50.0));
                } else if p != p0 {
                    return Err("median: length must not change between bars".into());
                }
                Ok(Val::Num(s.as_mut().unwrap().next(arg_num(args, 0))))
            })
        }
        "alma" => {
            let mut s: Option<Alma> = None;
            let mut key0 = (0usize, 0.0f64, 0.0f64);
            Box::new(move |_ctx, args| {
                let p = num_arg(args.get(1), "alma")?;
                let offset = match args.get(2) {
                    Some(Val::Num(n)) if n.is_finite() => *n,
                    _ => 0.85,
                };
                let sigma = match args.get(3) {
                    Some(Val::Num(n)) if n.is_finite() && *n > 0.0 => *n,
                    _ => 6.0,
                };
                let key = (p, offset, sigma);
                if s.is_none() {
                    key0 = key;
                    s = Some(Alma::new(p, offset, sigma));
                } else if key != key0 {
                    return Err("alma: parameters must not change between bars".into());
                }
                Ok(Val::Num(s.as_mut().unwrap().next(arg_num(args, 0))))
            })
        }

        // ---- trig / general math ------------------------------------------
        "sin" => math1(f64::sin),
        "cos" => math1(f64::cos),
        "tan" => math1(f64::tan),
        "asin" => math1(f64::asin),
        "acos" => math1(f64::acos),
        "atan" => math1(f64::atan),
        "atan2" => stateless(|_ctx, args| Ok(Val::Num(arg_num(args, 0).atan2(arg_num(args, 1))))),

        // ---- strings ------------------------------------------------------
        "str.format" => stateless(|_ctx, args| {
            let fmt = js_str(args.first());
            let mut out = String::new();
            let mut rest = fmt.as_str();
            while let Some(start) = rest.find('{') {
                out.push_str(&rest[..start]);
                let after = &rest[start + 1..];
                if let Some(end) = after.find('}') {
                    let digits = &after[..end];
                    if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
                        let k: usize = digits.parse().unwrap_or(usize::MAX);
                        out.push_str(&js_str(args.get(k + 1)));
                        rest = &after[end + 1..];
                        continue;
                    }
                }
                out.push('{');
                rest = after;
            }
            out.push_str(rest);
            Ok(Val::Str(out))
        }),
        "str.contains" => stateless(|_ctx, args| {
            Ok(Val::Num(
                if js_str(args.first()).contains(&js_str(args.get(1))) {
                    1.0
                } else {
                    0.0
                },
            ))
        }),
        "str.replace" => stateless(|_ctx, args| {
            let s = js_str(args.first());
            let from = js_str(args.get(1));
            if from.is_empty() {
                return Ok(Val::Str(s));
            }
            Ok(Val::Str(s.replace(&from, &js_str(args.get(2)))))
        }),
        "str.upper" => stateless(|_ctx, args| Ok(Val::Str(js_str(args.first()).to_uppercase()))),
        "str.lower" => stateless(|_ctx, args| Ok(Val::Str(js_str(args.first()).to_lowercase()))),
        "str.length" => stateless(|_ctx, args| {
            // UTF-16 code units, matching JS .length
            Ok(Val::Num(js_str(args.first()).encode_utf16().count() as f64))
        }),
        "str.split" => stateless(|_ctx, args| {
            let s = js_str(args.first());
            let sep = js_str(args.get(1));
            // an empty separator yields the whole string
            let parts: Vec<Val> = if sep.is_empty() {
                vec![Val::Str(s)]
            } else {
                s.split(&sep as &str)
                    .map(|p| Val::Str(p.to_string()))
                    .collect()
            };
            Ok(Val::Arr(std::rc::Rc::new(std::cell::RefCell::new(parts))))
        }),

        // ---- arrays: mutable reference values ------------------------------
        "array.new" => stateless(|_ctx, args| {
            let size = match args.first() {
                Some(Val::Num(n)) if n.is_finite() => js_max(0.0, js_round(*n)) as usize,
                _ => 0,
            };
            // hard cap: an unbounded size is a host OOM
            if size > MAX_ARRAY {
                return Err(format!("array.new: size too large (max {})", MAX_ARRAY));
            }
            let initial = args.get(1).cloned().unwrap_or(Val::nan());
            Ok(Val::Arr(std::rc::Rc::new(std::cell::RefCell::new(
                vec![initial; size],
            ))))
        }),
        "array.push" => stateless(|_ctx, args| {
            let arr = arr_of(args.first(), "array.push")?;
            let mut a = arr.borrow_mut();
            if a.len() >= MAX_ARRAY {
                return Err(format!("array.push: array too large (max {})", MAX_ARRAY));
            }
            a.push(args.get(1).cloned().unwrap_or(Val::nan()));
            Ok(Val::Num(0.0))
        }),
        "array.pop" => stateless(|_ctx, args| {
            Ok(arr_of(args.first(), "array.pop")?
                .borrow_mut()
                .pop()
                .unwrap_or(Val::nan()))
        }),
        "array.shift" => stateless(|_ctx, args| {
            let arr = arr_of(args.first(), "array.shift")?;
            let mut a = arr.borrow_mut();
            Ok(if a.is_empty() {
                Val::nan()
            } else {
                a.remove(0)
            })
        }),
        "array.unshift" => stateless(|_ctx, args| {
            let arr = arr_of(args.first(), "array.unshift")?;
            let mut a = arr.borrow_mut();
            if a.len() >= MAX_ARRAY {
                return Err(format!(
                    "array.unshift: array too large (max {})",
                    MAX_ARRAY
                ));
            }
            a.insert(0, args.get(1).cloned().unwrap_or(Val::nan()));
            Ok(Val::Num(0.0))
        }),
        "array.get" => stateless(|_ctx, args| {
            let arr = arr_of(args.first(), "array.get")?;
            let a = arr.borrow();
            // out-of-range reads are na, like history access
            Ok(match arr_index(args.get(1), a.len()) {
                Some(i) => a[i].clone(),
                None => Val::nan(),
            })
        }),
        "array.set" => stateless(|_ctx, args| {
            let arr = arr_of(args.first(), "array.set")?;
            let mut a = arr.borrow_mut();
            let len = a.len();
            match arr_index(args.get(1), len) {
                Some(i) => {
                    a[i] = args.get(2).cloned().unwrap_or(Val::nan());
                    Ok(Val::Num(0.0))
                }
                None => {
                    let shown = match args.get(1) {
                        Some(Val::Num(n)) => js_round(*n).to_string(),
                        _ => "NaN".into(),
                    };
                    Err(format!(
                        "array.set: index {} out of range (size {})",
                        shown, len
                    ))
                }
            }
        }),
        "array.size" => stateless(|_ctx, args| {
            Ok(Val::Num(
                arr_of(args.first(), "array.size")?.borrow().len() as f64
            ))
        }),
        "array.first" => stateless(|_ctx, args| {
            Ok(arr_of(args.first(), "array.first")?
                .borrow()
                .first()
                .cloned()
                .unwrap_or(Val::nan()))
        }),
        "array.last" => stateless(|_ctx, args| {
            Ok(arr_of(args.first(), "array.last")?
                .borrow()
                .last()
                .cloned()
                .unwrap_or(Val::nan()))
        }),
        "array.clear" => stateless(|_ctx, args| {
            arr_of(args.first(), "array.clear")?.borrow_mut().clear();
            Ok(Val::Num(0.0))
        }),
        "array.sum" => arr_aggregate("array.sum", |nums| nums.iter().fold(0.0, |a, b| a + b)),
        "array.avg" => arr_aggregate("array.avg", |nums| {
            nums.iter().fold(0.0, |a, b| a + b) / nums.len() as f64
        }),
        "array.min" => arr_aggregate("array.min", |nums| {
            nums.iter()
                .copied()
                .reduce(|a, b| if b < a { b } else { a })
                .unwrap()
        }),
        "array.max" => arr_aggregate("array.max", |nums| {
            nums.iter()
                .copied()
                .reduce(|a, b| if b > a { b } else { a })
                .unwrap()
        }),

        // ---- date/time: wall time in the session timezone -----------------
        "timestamp" => stateless(|ctx, args| match args.first() {
            Some(Val::Str(s)) => Ok(Val::Num(parse_timestamp(s, ctx.tz))),
            Some(Val::Num(y)) if y.is_finite() => {
                let g = |k: usize, d: f64| args.get(k).map(Val::num).unwrap_or(d);
                Ok(Val::Num(epoch_from_wall(
                    *y,
                    g(1, 1.0),
                    g(2, 1.0),
                    g(3, 0.0),
                    g(4, 0.0),
                    ctx.tz,
                )))
            }
            _ => Ok(Val::nan()),
        }),
        "year" => calendar(0),
        "month" => calendar(1),
        "dayofmonth" => calendar(2),
        "dayofweek" => calendar(3),
        "hour" => calendar(4),
        "minute" => calendar(5),

        _ => return None,
    };
    Some(b)
}
