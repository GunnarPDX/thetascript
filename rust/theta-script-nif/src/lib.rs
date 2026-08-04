//! Elixir NIF: a thin JSON-string wrapper over theta_script::run_script.
//! Loaded by the ThetaScript.Native module in elixir/theta_script.

/// The language caps expression nesting at 500 (SPEC §3), and the reference
/// parser/evaluator recurse ~10 native frames per nesting level — well within
/// the 8MB main-thread stacks every other host provides, but far beyond a
/// BEAM dirty scheduler's default stack (~320KB, where ~100 levels SIGBUS the
/// VM before the cap can fire). Run each script on a dedicated thread with an
/// explicit stack so the NIF has the same budget as the other runtimes.
const SCRIPT_STACK: usize = 8 * 1024 * 1024;

/// Run a script; JSON strings in, wire-encoded JSON result out. On invalid
/// argument JSON, returns {:error, reason}-shaped via rustler error.
#[rustler::nif(schedule = "DirtyCpu")]
fn run_script_json(source: &str, bars_json: &str, opts_json: &str) -> Result<String, String> {
    let bars_val: serde_json::Value =
        serde_json::from_str(bars_json).map_err(|e| format!("bars_json: {}", e))?;
    let opts_val: serde_json::Value = if opts_json.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(opts_json).map_err(|e| format!("opts_json: {}", e))?
    };
    let source = source.to_string();
    std::thread::Builder::new()
        .stack_size(SCRIPT_STACK)
        .spawn(move || {
            let bars = theta_script::bars_from_json(&bars_val);
            let opts = theta_script::opts_from_json(&opts_val);
            theta_script::run_script(&source, &bars, opts).to_string()
        })
        .map_err(|e| format!("script thread: {}", e))?
        .join()
        .map_err(|_| "script thread panicked".to_string())
}

#[rustler::nif]
fn lang_version() -> &'static str {
    theta_script::LANG_VERSION
}

rustler::init!("Elixir.ThetaScript.Native");
