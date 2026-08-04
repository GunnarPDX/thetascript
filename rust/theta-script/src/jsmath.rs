//! ECMAScript-compatible numeric semantics. The reference implementation is
//! JavaScript, so every place JS and Rust f64 helpers disagree (NaN handling
//! in min/max, rounding mode, sign of zero) goes through here.

/// JS `Math.round`: nearest integer, exact halves toward +∞.
/// (Rust's f64::round breaks ties away from zero.)
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// JS `Math.sign`: NaN -> NaN, ±0 -> ±0, else ±1.
pub fn js_sign(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 {
        x
    } else if x > 0.0 {
        1.0
    } else {
        -1.0
    }
}

/// JS `Math.max`: NaN poisons (Rust's f64::max ignores NaN).
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

/// JS `Math.min`: NaN poisons.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// ECMAScript Number-to-String: shortest round-trip decimal, integer form
/// for integral values, decimal notation for 1e-6 <= |v| < 1e21. Powers the
/// string `+` operator and `tostring()`.
pub fn js_number_to_string(v: f64) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v.is_infinite() {
        return if v > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if v == 0.0 {
        return "0".into(); // JS renders -0 as "0"
    }
    // integral values inside the decimal-notation range print without a dot
    if v.fract() == 0.0 && v.abs() < 1e21 {
        // f64 integrals up to 2^53 fit i64 exactly; beyond that {:.0} is exact
        return format!("{:.0}", v);
    }
    // shortest round-trip via Rust's float Display (Grisu/Ryū-based), then
    // adjust exponent formatting to the ECMAScript thresholds
    let s = format!("{}", v);
    if let Some(epos) = s.find(['e', 'E']) {
        let exp: i32 = s[epos + 1..].parse().unwrap_or(0);
        if (-7..21).contains(&exp) {
            // JS uses plain decimal notation in this range
            return format_decimal(v);
        }
        // JS writes e+21 / e-7 with an explicit sign
        let mantissa = &s[..epos];
        let sign = if exp >= 0 { "+" } else { "" };
        return format!("{}e{}{}", mantissa, sign, exp);
    }
    s
}

/// plain decimal expansion with enough digits to round-trip
fn format_decimal(v: f64) -> String {
    for prec in 1..=17 {
        let s = format!("{:.*}", prec, v);
        if s.parse::<f64>() == Ok(v) {
            let trimmed = s.trim_end_matches('0').trim_end_matches('.');
            return trimmed.to_string();
        }
    }
    format!("{}", v)
}

/// JS `Number.prototype.toFixed` for 0..=8 digits (the clamp the language
/// applies before calling it).
pub fn js_to_fixed(v: f64, digits: usize) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    format!("{:.*}", digits, v)
}
