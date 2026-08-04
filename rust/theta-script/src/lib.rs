//! theta-script: Rust core for the open-financial-charts scripting language.
//!
//! The normative definition lives in spec/SPEC.md (repo root) and the
//! executable contract in conformance/. `run_script` mirrors the
//! JavaScript reference implementation's `runScript`, producing the result
//! object directly in the JSON wire encoding.

pub mod builtins;
pub mod draw;
pub mod encode;
pub mod engine;
pub mod jsmath;
pub mod parse;
pub mod strategy;
pub mod streams;
pub mod time;
pub mod value;

pub const LANG_VERSION: &str = "2.4.0";

use encode::{enc, enc_f64s, enc_opt_span, enc_opt_strings, enc_val};
use engine::{BarData, Engine, FillSide, Opts, Out};
use serde_json::{json, Map, Value};

/// Parse a bars array (tape JSON) into BarData.
pub fn bars_from_json(v: &Value) -> Vec<BarData> {
    let num =
        |m: &Map<String, Value>, k: &str| m.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN);
    v.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_object)
                .map(|m| BarData {
                    date: num(m, "date"),
                    open: num(m, "open"),
                    high: num(m, "high"),
                    low: num(m, "low"),
                    close: num(m, "close"),
                    volume: m.get("volume").and_then(Value::as_f64).unwrap_or(0.0),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Opts from a fixture's `opts` value ({inputs, timezone, session} or null).
pub fn opts_from_json(v: &Value) -> Opts {
    let obj = v.as_object();
    let get = |k: &str| obj.and_then(|m| m.get(k));
    Opts {
        inputs: get("inputs").and_then(Value::as_object).cloned(),
        timezone: get("timezone").and_then(Value::as_str).map(str::to_string),
        session_open: get("session")
            .and_then(Value::as_object)
            .and_then(|s| s.get("open"))
            .and_then(Value::as_str)
            .map(str::to_string),
        session_close: get("session")
            .and_then(Value::as_object)
            .and_then(|s| s.get("close"))
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn encode_out(
    out: &Out,
    strategy: Value,
    extra_trades: Vec<Value>,
    error: Option<String>,
) -> Value {
    let errored = error.is_some();
    let empty = |v: Value| if errored { json!([]) } else { v };
    let plots = Value::Array(
        out.plots
            .iter()
            .map(|p| {
                let mut m = Map::new();
                m.insert("key".into(), Value::String(p.key.clone()));
                m.insert("title".into(), enc_val(&p.title));
                m.insert("color".into(), enc_val(&p.color));
                m.insert("width".into(), enc(p.width));
                if !p.is_hline {
                    m.insert("style".into(), Value::String(p.style.clone()));
                    m.insert("lineStyle".into(), Value::String(p.line_style.clone()));
                    m.insert("colorSpan".into(), enc_opt_span(p.color_span));
                    m.insert("widthSpan".into(), enc_opt_span(p.width_span));
                }
                m.insert("values".into(), enc_f64s(&p.values));
                Value::Object(m)
            })
            .collect(),
    );
    let side = |s: &FillSide| match s {
        FillSide::Ref(idx) => enc_f64s(&out.plots[*idx].values),
        FillSide::Vals(v) => enc_f64s(v),
    };
    let fills = Value::Array(
        out.fills
            .iter()
            .map(|f| json!({ "a": side(&f.a), "b": side(&f.b), "color": enc_val(&f.color), "opacity": enc(f.opacity) }))
            .collect(),
    );
    let shapes = Value::Array(
        out.shapes
            .iter()
            .map(|sh| {
                json!({
                    "values": enc_f64s(&sh.values),
                    "shape": enc_val(&sh.shape),
                    "location": enc_val(&sh.location),
                    "color": enc_val(&sh.color),
                    "size": enc(sh.size),
                })
            })
            .collect(),
    );
    let mut trades: Vec<Value> = out
        .trades
        .iter()
        .map(|t| {
            let mut m = Map::new();
            m.insert("values".into(), enc_f64s(&t.values));
            m.insert("qty".into(), enc_f64s(&t.qty));
            m.insert("side".into(), Value::String(t.side.into()));
            m.insert("color".into(), enc_val(&t.color));
            m.insert("priceSource".into(), Value::String(t.price_source.into()));
            if let Some(p) = &t.prices {
                m.insert("prices".into(), enc_f64s(p));
            }
            Value::Object(m)
        })
        .collect();
    trades.extend(extra_trades);
    let panel = Value::Array(
        out.panel
            .iter()
            .map(|p| {
                json!({
                    "title": enc_val(&p.title),
                    "value": enc_val(&p.value),
                    "color": enc_val(&p.color),
                    "precision": enc(p.precision),
                })
            })
            .collect(),
    );
    let bar_colors = Value::Array(
        out.bar_colors
            .iter()
            .map(|arr| enc_opt_strings(arr))
            .collect(),
    );
    let bg_colors = Value::Array(
        out.bg_colors
            .iter()
            .map(|b| json!({ "colors": enc_opt_strings(&b.colors), "opacity": enc(b.opacity) }))
            .collect(),
    );
    let alerts = Value::Array(
        out.alerts
            .iter()
            .map(|a| {
                let mut m = Map::new();
                m.insert("title".into(), enc_val(&a.title));
                m.insert("message".into(), enc_val(&a.message));
                m.insert("values".into(), enc_f64s(&a.values));
                if let Some(msgs) = &a.messages {
                    m.insert(
                        "messages".into(),
                        Value::Array(
                            msgs.iter()
                                .map(|v| match v {
                                    Some(s) => Value::String(s.clone()),
                                    None => Value::Null,
                                })
                                .collect(),
                        ),
                    );
                }
                Value::Object(m)
            })
            .collect(),
    );
    let lines = Value::Array(
        out.lines
            .iter()
            .map(|r| json!({ "x1": enc(r.x1), "y1": enc(r.y1), "x2": enc(r.x2), "y2": enc(r.y2), "color": r.color, "width": enc(r.width), "lineStyle": r.line_style }))
            .collect(),
    );
    let labels = Value::Array(
        out.labels
            .iter()
            .map(|r| {
                json!({
                    "x": enc(r.x), "y": enc(r.y), "text": r.text, "color": r.color,
                    "textColor": match &r.text_color { Some(c) => Value::String(c.clone()), None => Value::Null },
                    "style": r.style, "size": enc(r.size),
                })
            })
            .collect(),
    );
    let boxes = Value::Array(
        out.boxes
            .iter()
            .map(|r| {
                json!({
                    "x1": enc(r.x1), "y1": enc(r.y1), "x2": enc(r.x2), "y2": enc(r.y2),
                    "color": r.color,
                    "bgColor": match &r.bg_color { Some(c) => Value::String(c.clone()), None => Value::Null },
                    "width": enc(r.width),
                })
            })
            .collect(),
    );
    json!({
        "title": enc_val(&out.title),
        "overlay": out.overlay,
        "description": enc_val(&out.description),
        "plots": empty(plots),
        "fills": empty(fills),
        "shapes": empty(shapes),
        "trades": empty(Value::Array(trades)),
        "panel": empty(panel),
        "barColors": empty(bar_colors),
        "bgColors": empty(bg_colors),
        "inputs": Value::Array(out.inputs.clone()),
        "alerts": empty(alerts),
        "lines": empty(lines),
        "labels": empty(labels),
        "boxes": empty(boxes),
        "strategy": if errored { Value::Null } else { strategy },
        "error": match error {
            Some(e) => Value::String(e),
            None => Value::Null,
        },
    })
}

/// Run a script and return the result object in the wire encoding.
pub fn run_script(source: &str, bars: &[BarData], opts: Opts) -> Value {
    let tz = match time::resolve_timezone(opts.timezone.as_deref()) {
        Ok(tz) => tz,
        Err(e) => {
            let out = Out {
                overlay: true,
                ..Out::default()
            };
            return encode_out(&out, Value::Null, vec![], Some(e));
        }
    };
    let ast = match parse::parse(source) {
        Ok(a) => a,
        Err(e) => {
            let out = Out {
                overlay: true,
                ..Out::default()
            };
            return encode_out(&out, Value::Null, vec![], Some(e));
        }
    };
    let mut engine = Engine::new(&ast, bars, tz, opts);
    let run_result = engine.run();
    let draws_nothing = engine.out.plots.is_empty()
        && engine.out.shapes.is_empty()
        && engine.out.trades.is_empty()
        && engine.out.panel.is_empty()
        && engine.out.bar_colors.is_empty()
        && engine.out.bg_colors.is_empty()
        && engine.out.alerts.is_empty()
        && engine.out.lines.is_empty()
        && engine.out.labels.is_empty()
        && engine.out.boxes.is_empty()
        && !engine.strategy.used;
    let error = match run_result {
        Err(e) => Some(e),
        Ok(()) if draws_nothing => Some(
            "script draws nothing — add a plot(), plotshape(), plotbuy(), plotsell(), infopanel(), barcolor() or bgcolor()"
                .to_string(),
        ),
        Ok(()) => None,
    };
    let last_close = if bars.is_empty() {
        f64::NAN
    } else {
        bars[bars.len() - 1].close
    };
    let (strategy, markers) = if error.is_some() {
        (Value::Null, vec![])
    } else {
        let t0 = if bars.is_empty() {
            f64::NAN
        } else {
            bars[0].date
        };
        let t1 = if bars.is_empty() {
            f64::NAN
        } else {
            bars[bars.len() - 1].date
        };
        engine.strategy.finalize(last_close, t0, t1, &enc)
    };
    encode_out(&engine.out, strategy, markers, error)
}
