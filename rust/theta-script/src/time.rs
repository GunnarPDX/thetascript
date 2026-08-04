//! Timezone-explicit time core — the Rust counterpart of js/src/time.js.
//! All calendar semantics run in the session timezone via the IANA database
//! (chrono-tz). Offsets are exact here (no 15-minute bucket cache needed);
//! results agree with the JS implementation because real-zone offsets are
//! minute-multiples and the JS cache is transition-safe.

use chrono::{Offset, TimeZone, Utc};
use chrono_tz::Tz;

pub const DEFAULT_TIMEZONE: &str = "America/New_York";

pub fn resolve_timezone(tz: Option<&str>) -> Result<Tz, String> {
    let name = match tz {
        None | Some("") => DEFAULT_TIMEZONE,
        // 'local' resolves to the host zone in JS; conformance never uses it
        // and a backend should always pin a zone, so map it to the default
        Some("local") => DEFAULT_TIMEZONE,
        Some(s) => s,
    };
    name.parse::<Tz>()
        .map_err(|_| format!("unknown timezone '{}'", name))
}

/// UTC offset of `tz` at instant `ms`, in milliseconds.
fn tz_offset_ms(ms: f64, tz: Tz) -> f64 {
    let secs = (ms / 1000.0).floor() as i64;
    let dt = match Utc.timestamp_opt(secs, 0).single() {
        Some(d) => d,
        None => return f64::NAN,
    };
    let off = tz
        .offset_from_utc_datetime(&dt.naive_utc())
        .fix()
        .local_minus_utc();
    off as f64 * 1000.0
}

/// Wall-clock days since epoch in `tz` (floor of the shifted instant) —
/// the building block for week-anchor keys.
pub fn wall_epoch_days(ms: f64, tz: Tz) -> f64 {
    if ms.is_nan() {
        return f64::NAN;
    }
    let shifted = ms + tz_offset_ms(ms, tz);
    (shifted / 86_400_000.0).floor()
}

/// Wall-clock parts of instant `ms` in `tz`:
/// (year, month 1-12, day, hour, minute, weekday 0=Sunday).
pub fn wall_parts(ms: f64, tz: Tz) -> Option<(f64, f64, f64, f64, f64, f64)> {
    if ms.is_nan() {
        return None;
    }
    let shifted = ms + tz_offset_ms(ms, tz);
    if shifted.is_nan() {
        return None;
    }
    let days = (shifted / 86_400_000.0).floor();
    let in_day = shifted - days * 86_400_000.0;
    let (y, mo, d) = civil_from_days(days as i64);
    let hour = (in_day / 3_600_000.0).floor();
    let minute = ((in_day % 3_600_000.0) / 60_000.0).floor();
    // 1970-01-01 was a Thursday (weekday 4)
    let weekday = (days as i64 + 4).rem_euclid(7);
    Some((y as f64, mo as f64, d as f64, hour, minute, weekday as f64))
}

/// `Date.UTC(y, mo-1, d, h, mi)` with ECMAScript month/day normalization.
fn date_utc(y: f64, mo1: f64, d: f64, h: f64, mi: f64) -> f64 {
    if !y.is_finite() || !mo1.is_finite() || !d.is_finite() || !h.is_finite() || !mi.is_finite() {
        return f64::NAN;
    }
    let m0 = mo1.trunc() - 1.0;
    let year = y.trunc() + (m0 / 12.0).floor();
    let month = m0 - (m0 / 12.0).floor() * 12.0; // 0..11
    if year.abs() > 300_000.0 {
        return f64::NAN;
    }
    let days = days_from_civil(year as i64, month as u32 + 1, 1) as f64 + (d.trunc() - 1.0);
    days * 86_400_000.0 + h.trunc() * 3_600_000.0 + mi.trunc() * 60_000.0
}

/// Instant (ms epoch) of wall-clock y-mo-d h:mi in `tz`. Two-pass offset
/// refinement, identical to the JS reference (SPEC.md §8).
pub fn epoch_from_wall(y: f64, mo: f64, d: f64, h: f64, mi: f64, tz: Tz) -> f64 {
    // every component must be finite — a non-finite month/day/hour/minute
    // reads as na, matching the JS reference guard
    if !(y.is_finite() && mo.is_finite() && d.is_finite() && h.is_finite() && mi.is_finite()) {
        return f64::NAN;
    }
    let wall = date_utc(y, mo, d, h, mi);
    if wall.is_nan() {
        return f64::NAN;
    }
    let t = wall - tz_offset_ms(wall, tz);
    wall - tz_offset_ms(t, tz)
}

/// "YYYY-MM-DD[ HH:MM[:SS]]" (space or T) -> ms epoch in `tz`; else NaN.
pub fn parse_timestamp(v: &str, tz: Tz) -> f64 {
    let s = v.trim();
    let b: Vec<char> = s.chars().collect();
    let digits = |from: usize, n: usize| -> Option<f64> {
        if from + n > b.len() || !b[from..from + n].iter().all(|c| c.is_ascii_digit()) {
            return None;
        }
        b[from..from + n].iter().collect::<String>().parse().ok()
    };
    let (y, mo, d) = match (digits(0, 4), b.get(4), digits(5, 2), b.get(7), digits(8, 2)) {
        (Some(y), Some('-'), Some(mo), Some('-'), Some(d)) => (y, mo, d),
        _ => return f64::NAN,
    };
    if b.len() == 10 {
        return epoch_from_wall(y, mo, d, 0.0, 0.0, tz);
    }
    if !matches!(b.get(10), Some('T') | Some(' ')) {
        return f64::NAN;
    }
    // hour is 1 or 2 digits
    let (h, after_h) = match digits(11, 2) {
        Some(h) if b.get(13) == Some(&':') => (h, 13),
        _ => match digits(11, 1) {
            Some(h) if b.get(12) == Some(&':') => (h, 12),
            _ => return f64::NAN,
        },
    };
    let mi = match digits(after_h + 1, 2) {
        Some(mi) => mi,
        None => return f64::NAN,
    };
    let after_mi = after_h + 3;
    if b.len() == after_mi {
        return epoch_from_wall(y, mo, d, h, mi, tz);
    }
    if b.get(after_mi) == Some(&':') {
        if let Some(ss) = digits(after_mi + 1, 2) {
            if b.len() == after_mi + 3 {
                return epoch_from_wall(y, mo, d, h, mi, tz) + ss * 1000.0;
            }
        }
    }
    f64::NAN
}

/// "HH:MM" -> minutes past midnight, or `dflt` when absent/malformed.
pub fn session_minutes(s: Option<&str>, dflt: f64) -> f64 {
    let Some(s) = s else { return dflt };
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[0].len() > 2 || parts[1].len() != 2 {
        return dflt;
    }
    match (parts[0].parse::<f64>(), parts[1].parse::<f64>()) {
        (Ok(h), Ok(m))
            if parts[0].chars().all(|c| c.is_ascii_digit())
                && parts[1].chars().all(|c| c.is_ascii_digit()) =>
        {
            h * 60.0 + m
        }
        _ => dflt,
    }
}

// Howard Hinnant's civil-days algorithms
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = ((m + 9) % 12) as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
