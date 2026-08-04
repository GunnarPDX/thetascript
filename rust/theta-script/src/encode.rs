//! Wire encoding (conformance/README.md): JSON has no NaN/Infinity/-0, so
//! numbers map NaN -> null, ±Infinity -> "Infinity"/"-Infinity", -0 -> 0.

use serde_json::{Number, Value};

use crate::value::Val;

pub fn enc(v: f64) -> Value {
    if v.is_nan() {
        return Value::Null;
    }
    if v.is_infinite() {
        return Value::String(if v > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        });
    }
    let v = if v == 0.0 { 0.0 } else { v }; // normalize -0
    match Number::from_f64(v) {
        Some(n) => Value::Number(n),
        None => Value::Null,
    }
}

pub fn enc_val(v: &Val) -> Value {
    match v {
        Val::Num(n) => enc(*n),
        Val::Str(s) => Value::String(s.clone()),
        Val::Null => Value::Null,
        // plot-refs and arrays are runtime references, never output values
        Val::Ref(_) | Val::Arr(_) => Value::Null,
    }
}

pub fn enc_f64s(vals: &[f64]) -> Value {
    Value::Array(vals.iter().map(|v| enc(*v)).collect())
}

pub fn enc_opt_span(span: Option<(usize, usize)>) -> Value {
    match span {
        Some((a, b)) => Value::Array(vec![Value::from(a), Value::from(b)]),
        None => Value::Null,
    }
}

pub fn enc_opt_strings(vals: &[Option<String>]) -> Value {
    Value::Array(
        vals.iter()
            .map(|v| match v {
                Some(s) => Value::String(s.clone()),
                None => Value::Null,
            })
            .collect(),
    )
}
