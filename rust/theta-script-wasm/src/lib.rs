//! wasm adapter: a thin JSON-string wrapper over theta_script::run_script,
//! mirroring the NIF and PyO3 adapters. The JS wrapper package is expected
//! to resolve `'local'` timezones via Intl before calling in, since the
//! core maps `'local'` to the spec default.

use wasm_bindgen::prelude::*;

/// Run a script; JSON strings in, wire-encoded JSON result out.
/// `opts_json` may be empty (treated as null).
#[wasm_bindgen(js_name = runScriptJson)]
pub fn run_script_json(source: &str, bars_json: &str, opts_json: &str) -> Result<String, JsError> {
    let bars_val: serde_json::Value =
        serde_json::from_str(bars_json).map_err(|e| JsError::new(&format!("bars_json: {}", e)))?;
    let opts_val: serde_json::Value = if opts_json.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(opts_json).map_err(|e| JsError::new(&format!("opts_json: {}", e)))?
    };
    let bars = theta_script_core::bars_from_json(&bars_val);
    let opts = theta_script_core::opts_from_json(&opts_val);
    Ok(theta_script_core::run_script(source, &bars, opts).to_string())
}

#[wasm_bindgen(js_name = langVersion)]
pub fn lang_version() -> String {
    theta_script_core::LANG_VERSION.to_string()
}
