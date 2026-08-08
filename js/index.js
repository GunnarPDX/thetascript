// theta-script v3: the engine is the Rust core (rust/theta-script) compiled
// to wasm — the same code that backs the Python and Elixir runtimes. This
// wrapper owns loading, the JSON boundary, and host concerns (Intl).
//
//   import { init, runScript } from 'theta-script';
//   await init();                        // once, at app startup
//   const result = runScript(src, bars); // sync everywhere after that
//
// Results are in the conformance wire encoding (see conformance/README.md):
// NaN -> null, ±Infinity -> "Infinity"/"-Infinity", -0 -> 0 — identical
// across the wasm, Python, and Elixir runtimes. The pure-JS interpreter
// remains importable as 'theta-script/js' for v2 behavior.
import wasmInit, { initSync as wasmInitSync, runScriptJson, langVersion } from './wasm/theta_script_wasm.js';
import { LANG_VERSION } from './src/names.js';
export { LANG_VERSION, DRAW_FN_NAMES, KEYWORD_NAMES } from './src/names.js';

let ready = false;

const finishInit = () => {
  const v = langVersion();
  if (v !== LANG_VERSION) {
    throw new Error(`theta-script: wasm engine speaks lang ${v} but this wrapper expects ${LANG_VERSION}`);
  }
  ready = true;
};

// Load and compile the engine. With no argument the wasm is fetched relative
// to this module (bundlers resolve it as an asset); pass a URL/Request/
// Response/BufferSource/WebAssembly.Module to override.
export const init = async (input) => {
  if (ready) return;
  await wasmInit(input === undefined ? undefined : { module_or_path: input });
  finishInit();
};

// Synchronous alternative for hosts that already have the bytes in hand
// (Node tests, inlined-bytes setups); takes BufferSource or Module.
export const initSync = (input) => {
  if (ready) return;
  wasmInitSync({ module: input });
  finishInit();
};

// 'local' resolves against the host clock's zone — Intl is a host capability,
// so it's resolved here; the wasm core only accepts concrete IANA zones.
const resolveOpts = (opts) => {
  if (!opts || opts.timezone !== 'local') return opts;
  return { ...opts, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
};

export const runScript = (source, bars, opts = null) => {
  if (!ready) {
    throw new Error('theta-script: engine not loaded — await init() once before calling runScript()');
  }
  const o = resolveOpts(opts);
  return JSON.parse(runScriptJson(source, JSON.stringify(bars ?? []), o ? JSON.stringify(o) : ''));
};
