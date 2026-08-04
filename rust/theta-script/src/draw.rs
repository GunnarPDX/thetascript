//! Draw/declare call handlers — the Rust counterpart of DRAW_HANDLERS in
//! js/src/interpreter.js. Records are created on the first bar with
//! style args locked, then fed per-bar data.

use serde_json::{Map, Value};

use crate::encode::enc_val;
use crate::engine::{
    clamp_precision, lit_span, lock, plot_palette, valid_line_style, valid_plot_style, AlertRec,
    BgRec, Engine, FillRec, FillSide, PanelRec, PlotRec, ShapeRec, TradeRec,
};
use crate::parse::Expr;
use crate::value::Val;

// {{name}} placeholders in alert messages, rendered at fire time with the
// same number formatting as the JS reference (String(v))
fn render_alert_message(
    template: &str,
    fields: (f64, f64, f64, f64, f64, f64),
    i: usize,
) -> String {
    let (open, high, low, close, volume, time) = fields;
    let value_of = |name: &str| -> Option<f64> {
        match name {
            "open" => Some(open),
            "high" => Some(high),
            "low" => Some(low),
            "close" => Some(close),
            "volume" => Some(volume),
            "time" => Some(time),
            "bar_index" => Some(i as f64),
            _ => None,
        }
    };
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        if let Some(end) = after.find("}}") {
            let name = &after[..end];
            if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                match value_of(name) {
                    Some(v) => out.push_str(&crate::jsmath::js_number_to_string(v)),
                    None => {
                        out.push_str("{{");
                        out.push_str(name);
                        out.push_str("}}");
                    }
                }
                rest = &after[end + 2..];
                continue;
            }
        }
        out.push_str("{{");
        rest = after;
    }
    out.push_str(rest);
    out
}

pub fn is_draw_fn(name: &str) -> bool {
    matches!(
        name,
        "study"
            | "plot"
            | "hline"
            | "fill"
            | "plotshape"
            | "plotbuy"
            | "plotsell"
            | "infopanel"
            | "barcolor"
            | "bgcolor"
            | "alertcondition"
            | "strategy.buy"
            | "strategy.sell"
            | "strategy.config"
            | "line.new"
            | "label.new"
            | "box.new"
            | "input"
            | "input.int"
            | "input.float"
            | "input.time"
            | "input.bool"
            | "input.string"
    )
}

fn kw<'v>(kwargs: &'v [(&str, Val)], key: &str) -> Option<&'v Val> {
    kwargs.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
}

fn kw_node<'v>(nodes: &'v [(String, Expr)], key: &str) -> Option<&'v Expr> {
    nodes.iter().find(|(k, _)| k == key).map(|(_, e)| e)
}

fn kw_str(kwargs: &[(&str, Val)], key: &str) -> Option<String> {
    match kw(kwargs, key) {
        Some(Val::Str(s)) => Some(s.clone()),
        _ => None,
    }
}

fn kw_num(kwargs: &[(&str, Val)], key: &str) -> Option<f64> {
    match kw(kwargs, key) {
        Some(Val::Num(n)) => Some(*n),
        _ => None,
    }
}

fn arg_str(args: &[Val], k: usize) -> Option<&str> {
    args.get(k).and_then(Val::as_str)
}

#[allow(clippy::too_many_arguments)]
pub fn handle(
    eng: &mut Engine,
    id: usize,
    name: &str,
    arg_nodes: &[Expr],
    kwarg_nodes: &[(String, Expr)],
    args: &[Val],
    kwargs: &[(&str, Val)],
    line: usize,
) -> Result<Val, String> {
    match name {
        "study" => {
            let mut s = eng.take_draw_state(id);
            if !s.made {
                s.made = true;
                if let Some(t) = kw(kwargs, "title") {
                    eng.out.title = t.clone();
                } else if let Some(t) = arg_str(args, 0) {
                    eng.out.title = Val::Str(t.to_string());
                }
                if let Some(o) = kw(kwargs, "overlay") {
                    eng.out.overlay = o.truthy();
                }
                if let Some(Val::Str(d)) = kw(kwargs, "description") {
                    eng.out.description = Val::Str(d.clone());
                }
            }
            eng.put_draw_state(id, s);
            Ok(Val::Num(0.0))
        }

        "plot" => {
            let mut s = eng.take_draw_state(id);
            let color_val =
                kw(kwargs, "color")
                    .cloned()
                    .unwrap_or_else(|| match arg_str(args, 1) {
                        Some(a) if a.starts_with('#') => Val::Str(a.to_string()),
                        _ => Val::Null,
                    });
            let width_val = match kw_num(kwargs, "width") {
                Some(w) => Val::Num(w),
                None => match args.get(2) {
                    Some(Val::Num(w)) => Val::Num(*w),
                    _ => Val::Null,
                },
            };
            let title_val =
                kw(kwargs, "title")
                    .cloned()
                    .unwrap_or_else(|| match arg_str(args, 1) {
                        Some(a) if !a.starts_with('#') => Val::Str(a.to_string()),
                        _ => Val::Null,
                    });
            let style_val = kw(kwargs, "style")
                .cloned()
                .unwrap_or(Val::Str("line".into()));
            let ls_val = kw(kwargs, "linestyle")
                .cloned()
                .unwrap_or(Val::Str("solid".into()));
            let result = (|| {
                let color = lock(&mut s, "color", color_val, "plot color", line)?;
                let width = lock(&mut s, "width", width_val, "plot width", line)?;
                let _title = lock(&mut s, "title", title_val.clone(), "plot title", line)?;
                let style = lock(&mut s, "style", style_val, "plot style", line)?;
                let ls = lock(&mut s, "lineStyle", ls_val, "plot linestyle", line)?;
                let style_s = style.as_str().unwrap_or("").to_string();
                let ls_s = ls.as_str().unwrap_or("").to_string();
                if !valid_plot_style(&style_s) {
                    return Err(format!(
                        "line {}: unknown plot style '{}' — use line, histogram, area, stepline, circles",
                        line, style_s
                    ));
                }
                if !valid_line_style(&ls_s) {
                    return Err(format!(
                        "line {}: unknown linestyle '{}' — use solid, dashed, dotted",
                        line, ls_s
                    ));
                }
                Ok((color, width, style_s, ls_s))
            })();
            let (color, width, style_s, ls_s) = match result {
                Ok(v) => v,
                Err(e) => {
                    eng.put_draw_state(id, s);
                    return Err(e);
                }
            };
            if !s.made {
                s.made = true;
                let color_span = if matches!(kw(kwargs, "color"), Some(Val::Str(_))) {
                    kw_node(kwarg_nodes, "color").and_then(lit_span)
                } else if arg_str(args, 1).is_some_and(|a| a.starts_with('#')) {
                    arg_nodes.get(1).and_then(lit_span)
                } else {
                    None
                };
                let width_span = if kw_num(kwargs, "width").is_some() {
                    kw_node(kwarg_nodes, "width").and_then(lit_span)
                } else if matches!(args.get(2), Some(Val::Num(_))) {
                    arg_nodes.get(2).and_then(lit_span)
                } else {
                    None
                };
                let idx = eng.out.plots.len();
                eng.out.plots.push(PlotRec {
                    key: format!("p{}", idx),
                    title: title_val,
                    color: if matches!(color, Val::Null) {
                        Val::Str(plot_palette(idx).to_string())
                    } else {
                        color
                    },
                    width: match width {
                        Val::Num(w) => w,
                        _ => 2.0,
                    },
                    style: style_s,
                    line_style: ls_s,
                    color_span,
                    width_span,
                    values: vec![f64::NAN; eng.n],
                    is_hline: false,
                });
                s.rec = idx;
            }
            if !eng.decl_pass() {
                if let Some(Val::Num(v)) = args.first() {
                    let i = eng.bar_index();
                    eng.out.plots[s.rec].values[i] = *v;
                }
            }
            let r = Val::Ref(s.rec);
            eng.put_draw_state(id, s);
            Ok(r)
        }

        "hline" => {
            let mut s = eng.take_draw_state(id);
            let v = match args.first() {
                Some(Val::Num(n)) => *n,
                _ => f64::NAN,
            };
            if let Err(e) = lock(&mut s, "value", Val::Num(v), "hline value", line) {
                eng.put_draw_state(id, s);
                return Err(e);
            }
            if !s.made {
                s.made = true;
                let idx = eng.out.plots.len();
                eng.out.plots.push(PlotRec {
                    key: format!("p{}", idx),
                    title: kw(kwargs, "title").cloned().unwrap_or(Val::Null),
                    color: kw(kwargs, "color")
                        .cloned()
                        .unwrap_or(Val::Str("#8f8f98".into())),
                    width: kw_num(kwargs, "width").unwrap_or(1.0),
                    style: String::new(),
                    line_style: String::new(),
                    color_span: None,
                    width_span: None,
                    values: vec![v; eng.n],
                    is_hline: true,
                });
                s.rec = idx;
            }
            let r = Val::Ref(s.rec);
            eng.put_draw_state(id, s);
            Ok(r)
        }

        "fill" => {
            if args.len() < 2 {
                return Err(format!("line {}: fill needs two plots or series", line));
            }
            let mut s = eng.take_draw_state(id);
            if !s.made {
                s.made = true;
                let side = |v: &Val, n: usize| match v {
                    Val::Ref(idx) => (FillSide::Ref(*idx), true),
                    _ => (FillSide::Vals(vec![f64::NAN; n]), false),
                };
                let (a, a_ref) = side(&args[0], eng.n);
                let (b, b_ref) = side(&args[1], eng.n);
                s.a_ref = Some(a_ref);
                s.b_ref = Some(b_ref);
                s.rec = eng.out.fills.len();
                eng.out.fills.push(FillRec {
                    a,
                    b,
                    color: kw(kwargs, "color")
                        .cloned()
                        .unwrap_or(Val::Str("#3b82f6".into())),
                    opacity: kw_num(kwargs, "opacity").unwrap_or(0.12),
                });
            }
            if !eng.decl_pass() {
                let i = eng.bar_index();
                let rec = &mut eng.out.fills[s.rec];
                if s.a_ref == Some(false) {
                    if let FillSide::Vals(vals) = &mut rec.a {
                        vals[i] = args[0].num();
                    }
                }
                if s.b_ref == Some(false) {
                    if let FillSide::Vals(vals) = &mut rec.b {
                        vals[i] = args[1].num();
                    }
                }
            }
            eng.put_draw_state(id, s);
            Ok(Val::Num(0.0))
        }

        "plotshape" => {
            let mut s = eng.take_draw_state(id);
            let default_color = if kw_str(kwargs, "location").as_deref() == Some("belowbar") {
                "#22c55e"
            } else {
                "#ef4444"
            };
            let color_val = kw(kwargs, "color")
                .cloned()
                .unwrap_or(Val::Str(default_color.into()));
            let color = match lock(&mut s, "color", color_val, "plotshape color", line) {
                Ok(c) => c,
                Err(e) => {
                    eng.put_draw_state(id, s);
                    return Err(e);
                }
            };
            if !s.made {
                s.made = true;
                s.rec = eng.out.shapes.len();
                eng.out.shapes.push(ShapeRec {
                    values: vec![0.0; eng.n],
                    shape: kw(kwargs, "shape")
                        .cloned()
                        .unwrap_or(Val::Str("triangleup".into())),
                    location: kw(kwargs, "location")
                        .cloned()
                        .unwrap_or(Val::Str("abovebar".into())),
                    color,
                    size: kw_num(kwargs, "size").unwrap_or(4.0),
                });
            }
            if !eng.decl_pass() {
                let i = eng.bar_index();
                let v = args.first().cloned().unwrap_or(Val::nan());
                eng.out.shapes[s.rec].values[i] = match v {
                    Val::Num(n) => n,
                    other => {
                        if other.truthy() {
                            1.0
                        } else {
                            0.0
                        }
                    }
                };
            }
            eng.put_draw_state(id, s);
            Ok(Val::Num(0.0))
        }

        "plotbuy" | "plotsell" => {
            let mut s = eng.take_draw_state(id);
            let what: &str = if name == "plotbuy" {
                "plotbuy color"
            } else {
                "plotsell color"
            };
            let color = match lock(
                &mut s,
                "color",
                kw(kwargs, "color").cloned().unwrap_or(Val::Null),
                what,
                line,
            ) {
                Ok(c) => c,
                Err(e) => {
                    eng.put_draw_state(id, s);
                    return Err(e);
                }
            };
            // price=: an OHLC source name (locked), or a per-bar number = a
            // custom price series; the KIND is locked
            let price_kind: &'static str = match kw(kwargs, "price") {
                None => "close",
                Some(Val::Str(p)) => match p.as_str() {
                    "open" => "open",
                    "high" => "high",
                    "low" => "low",
                    "close" => "close",
                    _ => {
                        eng.put_draw_state(id, s);
                        return Err(format!(
                            "line {}: {} price must be \"open\", \"high\", \"low\", \"close\" or a number",
                            line, name
                        ));
                    }
                },
                Some(_) => "custom",
            };
            let price_what: &str = if name == "plotbuy" {
                "plotbuy price"
            } else {
                "plotsell price"
            };
            if let Err(e) = lock(
                &mut s,
                "priceSource",
                Val::Str(price_kind.into()),
                price_what,
                line,
            ) {
                eng.put_draw_state(id, s);
                return Err(e);
            }
            if !s.made {
                s.made = true;
                s.rec = eng.out.trades.len();
                eng.out.trades.push(TradeRec {
                    values: vec![0.0; eng.n],
                    qty: vec![f64::NAN; eng.n],
                    side: if name == "plotbuy" { "buy" } else { "sell" },
                    color,
                    price_source: price_kind,
                    prices: if price_kind == "custom" {
                        Some(vec![f64::NAN; eng.n])
                    } else {
                        None
                    },
                });
            }
            if !eng.decl_pass() {
                let i = eng.bar_index();
                let v = args.first().cloned().unwrap_or(Val::nan());
                let rec = &mut eng.out.trades[s.rec];
                rec.values[i] = match v {
                    Val::Num(n) => n,
                    other => {
                        if other.truthy() {
                            1.0
                        } else {
                            0.0
                        }
                    }
                };
                let q = kw(kwargs, "qty")
                    .cloned()
                    .unwrap_or_else(|| args.get(1).cloned().unwrap_or(Val::Num(1.0)));
                rec.qty[i] = match q {
                    Val::Num(n) => n,
                    _ => f64::NAN,
                };
                if let Some(prices) = &mut rec.prices {
                    prices[i] = match kw(kwargs, "price") {
                        Some(Val::Num(n)) => *n,
                        _ => f64::NAN,
                    };
                }
            }
            eng.put_draw_state(id, s);
            Ok(Val::Num(0.0))
        }

        "infopanel" => {
            let mut s = eng.take_draw_state(id);
            if !s.made {
                s.made = true;
                let precision = match kw_num(kwargs, "precision") {
                    Some(p) => clamp_precision(p),
                    None => 2.0,
                };
                let title =
                    kw(kwargs, "title")
                        .cloned()
                        .unwrap_or_else(|| match arg_str(args, 1) {
                            Some(t) => Val::Str(t.to_string()),
                            None => Val::Str(format!("Value {}", eng.out.panel.len() + 1)),
                        });
                s.rec = eng.out.panel.len();
                eng.out.panel.push(PanelRec {
                    title,
                    value: Val::nan(),
                    color: Val::Null,
                    precision,
                });
            }
            // latest executed bar wins: value and color overwrite every bar;
            // arrays are references, not displayable scalars — they read as na
            let rec = &mut eng.out.panel[s.rec];
            rec.value = match args.first() {
                Some(Val::Arr(_)) | None => Val::nan(),
                Some(v) => v.clone(),
            };
            rec.color = match kw_str(kwargs, "color") {
                Some(c) => Val::Str(c),
                None => Val::Null,
            };
            eng.put_draw_state(id, s);
            Ok(Val::Num(0.0))
        }

        "barcolor" | "bgcolor" => {
            let mut s = eng.take_draw_state(id);
            let is_bar = name == "barcolor";
            if !s.made {
                s.made = true;
                if is_bar {
                    s.rec = eng.out.bar_colors.len();
                    eng.out.bar_colors.push(vec![None; eng.n]);
                } else {
                    s.rec = eng.out.bg_colors.len();
                    eng.out.bg_colors.push(BgRec {
                        colors: vec![None; eng.n],
                        opacity: kw_num(kwargs, "opacity").unwrap_or(0.1),
                    });
                }
            }
            if !eng.decl_pass() {
                let gated = kw_node(kwarg_nodes, "when").is_some()
                    && !kw(kwargs, "when").is_some_and(Val::truthy);
                let color = if gated {
                    None
                } else {
                    arg_str(args, 0).map(str::to_string)
                };
                let i = eng.bar_index();
                if is_bar {
                    eng.out.bar_colors[s.rec][i] = color;
                } else {
                    eng.out.bg_colors[s.rec].colors[i] = color;
                }
            }
            eng.put_draw_state(id, s);
            Ok(Val::Num(0.0))
        }

        "alertcondition" => {
            let mut s = eng.take_draw_state(id);
            let title_val = kw(kwargs, "title").cloned().unwrap_or(Val::Null);
            let msg_val = match kw_str(kwargs, "message") {
                Some(m) => Val::Str(m),
                None => Val::Null,
            };
            let locked = (|| {
                lock(
                    &mut s,
                    "title",
                    title_val.clone(),
                    "alertcondition title",
                    line,
                )?;
                lock(
                    &mut s,
                    "message",
                    msg_val.clone(),
                    "alertcondition message",
                    line,
                )
            })();
            if let Err(e) = locked {
                eng.put_draw_state(id, s);
                return Err(e);
            }
            if !s.made {
                s.made = true;
                s.rec = eng.out.alerts.len();
                let has_placeholders = matches!(&msg_val, Val::Str(m) if m.contains("{{"));
                eng.out.alerts.push(AlertRec {
                    title: match title_val {
                        Val::Null => Val::Str(format!("Alert {}", eng.out.alerts.len() + 1)),
                        t => t,
                    },
                    message: msg_val,
                    values: vec![0.0; eng.n],
                    messages: if has_placeholders {
                        Some(vec![None; eng.n])
                    } else {
                        None
                    },
                });
            }
            if !eng.decl_pass() {
                let i = eng.bar_index();
                let fired = args.first().is_some_and(Val::truthy);
                let fields = eng.bar_fields();
                let rec = &mut eng.out.alerts[s.rec];
                rec.values[i] = if fired { 1.0 } else { 0.0 };
                if fired {
                    if let (Some(msgs), Val::Str(template)) = (&mut rec.messages, &rec.message) {
                        msgs[i] = Some(render_alert_message(template, fields, i));
                    }
                }
            }
            eng.put_draw_state(id, s);
            Ok(Val::Num(0.0))
        }

        "strategy.buy" | "strategy.sell" => {
            eng.strategy.used = true;
            if eng.decl_pass() {
                return Ok(Val::Num(0.0));
            }
            if kw(kwargs, "limit").is_some() && kw(kwargs, "stop").is_some() {
                return Err(format!(
                    "line {}: an order takes limit= or stop=, not both",
                    line
                ));
            }
            let qty_type: &'static str = match kw(kwargs, "qty_type") {
                None => "shares",
                Some(Val::Str(t)) => match t.as_str() {
                    "shares" => "shares",
                    "cash" => "cash",
                    "percent_of_equity" => "percent_of_equity",
                    _ => {
                        return Err(format!(
                        "line {}: qty_type must be \"shares\", \"cash\" or \"percent_of_equity\"",
                        line
                    ))
                    }
                },
                Some(_) => {
                    return Err(format!(
                        "line {}: qty_type must be \"shares\", \"cash\" or \"percent_of_equity\"",
                        line
                    ))
                }
            };
            let when = kw(kwargs, "when")
                .cloned()
                .unwrap_or_else(|| args.first().cloned().unwrap_or(Val::Num(1.0)));
            let qty = kw(kwargs, "qty")
                .cloned()
                .unwrap_or_else(|| args.get(1).cloned().unwrap_or(Val::Num(1.0)));
            if when.truthy() {
                let fin = |k: &str| kw_num(kwargs, k).filter(|v| v.is_finite());
                let limit = fin("limit");
                let stop = fin("stop");
                // a requested-but-non-finite price drops the order entirely —
                // a warmup NaN in a limit expression must not silently
                // degrade to a market fill
                if (kw(kwargs, "limit").is_some() && limit.is_none())
                    || (kw(kwargs, "stop").is_some() && stop.is_none())
                {
                    return Ok(Val::Num(0.0));
                }
                let req = crate::strategy::OrderReq {
                    key: id,
                    qty_arg: qty.num(),
                    qty_type,
                    limit,
                    stop,
                    expires: fin("expires")
                        .map(|v| crate::jsmath::js_max(1.0, crate::jsmath::js_round(v))),
                    stops: crate::strategy::Stops {
                        stop: kw_num(kwargs, "stop_loss"),
                        target: kw_num(kwargs, "take_profit"),
                        trail: kw_num(kwargs, "trailing"),
                    },
                };
                let i = eng.bar_index();
                let bar = eng.current_bar();
                eng.strategy.order(name == "strategy.buy", i, &bar, req);
            }
            Ok(Val::Num(0.0))
        }

        // backtest configuration, read once on the first bar
        "strategy.config" => {
            eng.strategy.used = true;
            let mut s = eng.take_draw_state(id);
            if !s.made {
                s.made = true;
                eng.strategy.configure(
                    kw_num(kwargs, "initial_capital"),
                    kw_num(kwargs, "commission_percent"),
                    kw_num(kwargs, "commission_cash"),
                    kw_num(kwargs, "slippage"),
                    kw_num(kwargs, "pyramiding"),
                );
            }
            eng.put_draw_state(id, s);
            Ok(Val::Num(0.0))
        }

        // ---- drawing objects: created per bar when `when` holds, capped ---
        "line.new" => {
            if eng.decl_pass()
                || (kw_node(kwarg_nodes, "when").is_some()
                    && !kw(kwargs, "when").is_some_and(Val::truthy))
            {
                return Ok(Val::Num(0.0));
            }
            let g = |k: usize| args.get(k).map(Val::num).unwrap_or(f64::NAN);
            let (x1, y1, x2, y2) = (g(0), g(1), g(2), g(3));
            if [x1, y1, x2, y2].iter().all(|v| v.is_finite()) {
                crate::engine::push_capped(
                    &mut eng.out.lines,
                    crate::engine::LineRec {
                        x1,
                        y1,
                        x2,
                        y2,
                        color: kw_str(kwargs, "color").unwrap_or_else(|| "#8f8f98".into()),
                        width: kw_num(kwargs, "width").unwrap_or(1.0),
                        line_style: kw_str(kwargs, "style").unwrap_or_else(|| "solid".into()),
                    },
                );
            }
            Ok(Val::Num(0.0))
        }
        "label.new" => {
            if eng.decl_pass()
                || (kw_node(kwarg_nodes, "when").is_some()
                    && !kw(kwargs, "when").is_some_and(Val::truthy))
            {
                return Ok(Val::Num(0.0));
            }
            let x = args.first().map(Val::num).unwrap_or(f64::NAN);
            let y = args.get(1).map(Val::num).unwrap_or(f64::NAN);
            if x.is_finite() && y.is_finite() {
                let text = match args.get(2) {
                    Some(Val::Str(t)) => t.clone(),
                    Some(Val::Num(n)) => crate::jsmath::js_number_to_string(*n),
                    _ => String::new(),
                };
                crate::engine::push_capped(
                    &mut eng.out.labels,
                    crate::engine::LabelRec {
                        x,
                        y,
                        text,
                        color: kw_str(kwargs, "color").unwrap_or_else(|| "#8f8f98".into()),
                        text_color: kw_str(kwargs, "textcolor"),
                        style: kw_str(kwargs, "style").unwrap_or_else(|| "down".into()),
                        size: kw_num(kwargs, "size").unwrap_or(10.0),
                    },
                );
            }
            Ok(Val::Num(0.0))
        }
        "box.new" => {
            if eng.decl_pass()
                || (kw_node(kwarg_nodes, "when").is_some()
                    && !kw(kwargs, "when").is_some_and(Val::truthy))
            {
                return Ok(Val::Num(0.0));
            }
            let g = |k: usize| args.get(k).map(Val::num).unwrap_or(f64::NAN);
            let (x1, y1, x2, y2) = (g(0), g(1), g(2), g(3));
            if [x1, y1, x2, y2].iter().all(|v| v.is_finite()) {
                crate::engine::push_capped(
                    &mut eng.out.boxes,
                    crate::engine::BoxRec {
                        x1,
                        y1,
                        x2,
                        y2,
                        color: kw_str(kwargs, "color").unwrap_or_else(|| "#8f8f98".into()),
                        bg_color: kw_str(kwargs, "bgcolor"),
                        width: kw_num(kwargs, "width").unwrap_or(1.0),
                    },
                );
            }
            Ok(Val::Num(0.0))
        }

        "input" | "input.int" | "input.float" | "input.bool" | "input.string" | "input.time" => {
            input_decl(eng, id, name, args, kwargs)
        }

        _ => Err(format!("line {}: unknown function '{}'", line, name)),
    }
}

fn label_of(eng: &Engine, args: &[Val], kwargs: &[(&str, Val)]) -> String {
    match kw(kwargs, "title") {
        Some(Val::Str(t)) => t.clone(),
        _ => match arg_str(args, 1) {
            Some(t) => t.to_string(),
            None => format!("Input {}", eng.out.inputs.len() + 1),
        },
    }
}

fn input_decl(
    eng: &mut Engine,
    id: usize,
    name: &str,
    args: &[Val],
    kwargs: &[(&str, Val)],
) -> Result<Val, String> {
    let mut s = eng.take_draw_state(id);
    if s.made {
        let v = s.value.clone();
        eng.put_draw_state(id, s);
        return Ok(v);
    }
    s.made = true;
    let label = label_of(eng, args, kwargs);
    // duplicate labels get an ordinal suffix so override lookups stay
    // distinct; the first occurrence keeps the plain label. Suffixes bump
    // until the key is actually free — a literal label "X (2)" must not
    // collide with the generated suffix for a later duplicate "X"
    let taken: std::collections::HashSet<&str> = eng
        .out
        .inputs
        .iter()
        .filter_map(|r| r.get("key").and_then(Value::as_str))
        .collect();
    let mut key = label.clone();
    let mut k = 2usize;
    while taken.contains(key.as_str()) {
        key = format!("{} ({})", label, k);
        k += 1;
    }

    let mut rec = Map::new();
    rec.insert("key".into(), Value::String(key.clone()));
    rec.insert("label".into(), Value::String(label));

    let over = eng.input_override(&key).cloned();
    let value: Val = match name {
        "input.time" => {
            let dflt = arg_str(args, 0).unwrap_or("").to_string();
            let raw = match &over {
                Some(Value::String(s)) => s.clone(),
                _ => dflt.clone(),
            };
            rec.insert("type".into(), "time".into());
            rec.insert("default".into(), Value::String(dflt));
            let v = crate::engine::parse_ts(&raw, eng.timezone());
            rec.insert("value".into(), enc_val(&Val::Num(v)));
            rec.insert("text".into(), Value::String(raw));
            Val::Num(v)
        }
        "input.bool" => {
            let dflt = if args.first().is_some_and(Val::truthy) {
                1.0
            } else {
                0.0
            };
            let raw = match &over {
                Some(Value::Bool(b)) => {
                    if *b {
                        1.0
                    } else {
                        0.0
                    }
                }
                Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
                _ => dflt,
            };
            let v = if Val::Num(raw).truthy() { 1.0 } else { 0.0 };
            rec.insert("type".into(), "bool".into());
            rec.insert("default".into(), enc_val(&Val::Num(dflt)));
            rec.insert("value".into(), enc_val(&Val::Num(v)));
            Val::Num(v)
        }
        "input.string" => {
            let dflt = arg_str(args, 0).unwrap_or("").to_string();
            let options: Option<Vec<String>> = kw_str(kwargs, "options").map(|o| {
                o.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            });
            let raw = match &over {
                Some(Value::String(s)) => s.clone(),
                _ => dflt.clone(),
            };
            let v = match &options {
                Some(opts) if !opts.contains(&raw) => dflt.clone(),
                _ => raw,
            };
            rec.insert("type".into(), "string".into());
            rec.insert("default".into(), Value::String(dflt));
            rec.insert("value".into(), Value::String(v.clone()));
            rec.insert(
                "options".into(),
                match options {
                    Some(o) => Value::Array(o.into_iter().map(Value::String).collect()),
                    None => Value::Null,
                },
            );
            Val::Str(v)
        }
        _ => {
            // input / input.int / input.float
            let ty = if name == "input.int" { "int" } else { "float" };
            let dflt = match args.first() {
                Some(Val::Num(n)) => *n,
                _ => 0.0,
            };
            let raw = match &over {
                Some(Value::Number(n)) => n.as_f64().unwrap_or(dflt),
                _ => dflt,
            };
            let mut v = if ty == "int" {
                crate::jsmath::js_round(raw)
            } else {
                raw
            };
            if let Some(minv) = kw_num(kwargs, "minval") {
                v = crate::jsmath::js_max(minv, v);
            }
            if let Some(maxv) = kw_num(kwargs, "maxval") {
                v = crate::jsmath::js_min(maxv, v);
            }
            rec.insert("type".into(), ty.into());
            rec.insert("default".into(), enc_val(&Val::Num(dflt)));
            rec.insert("value".into(), enc_val(&Val::Num(v)));
            if let Some(mv) = kw(kwargs, "minval") {
                rec.insert("minval".into(), enc_val(mv));
            }
            if let Some(mv) = kw(kwargs, "maxval") {
                rec.insert("maxval".into(), enc_val(mv));
            }
            if let Some(sv) = kw(kwargs, "step") {
                rec.insert("step".into(), enc_val(sv));
            }
            Val::Num(v)
        }
    };
    rec.insert(
        "tooltip".into(),
        match kw_str(kwargs, "tooltip") {
            Some(t) => Value::String(t),
            None => Value::Null,
        },
    );
    eng.out.inputs.push(Value::Object(rec));
    s.value = value.clone();
    eng.put_draw_state(id, s);
    Ok(value)
}
