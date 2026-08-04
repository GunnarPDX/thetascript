//! Python bindings: a thin JSON-string wrapper over theta_script_core::run_script.
//!
//!     import theta_script, json
//!     result = json.loads(theta_script.run_script_json(source, json.dumps(bars), json.dumps(opts)))
//!
//! JSON in/out keeps the ABI trivial and matches the language's wire
//! encoding (NaN -> null, ±Infinity -> "Infinity"/"-Infinity").

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;

/// Run a script. `bars_json` is a JSON array of
/// {date, open, high, low, close, volume} (date = ms epoch); `opts_json` is
/// {inputs?, timezone?, session?} or null/"". Returns the result object as a
/// JSON string.
#[pyfunction]
#[pyo3(signature = (source, bars_json, opts_json=None))]
fn run_script_json(source: &str, bars_json: &str, opts_json: Option<&str>) -> PyResult<String> {
    let bars_val: serde_json::Value = serde_json::from_str(bars_json)
        .map_err(|e| PyValueError::new_err(format!("bars_json: {}", e)))?;
    let opts_val: serde_json::Value = match opts_json {
        None | Some("") => serde_json::Value::Null,
        Some(s) => serde_json::from_str(s)
            .map_err(|e| PyValueError::new_err(format!("opts_json: {}", e)))?,
    };
    let bars = theta_script_core::bars_from_json(&bars_val);
    let opts = theta_script_core::opts_from_json(&opts_val);
    Ok(theta_script_core::run_script(source, &bars, opts).to_string())
}

/// The language/spec version this module implements.
#[pyfunction]
fn lang_version() -> &'static str {
    theta_script_core::LANG_VERSION
}

#[pymodule]
fn theta_script(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(run_script_json, m)?)?;
    m.add_function(wrap_pyfunction!(lang_version, m)?)?;
    Ok(())
}
