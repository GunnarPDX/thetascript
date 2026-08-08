# theta-script-wasm

wasm-bindgen adapter over the [`theta-script`](../theta-script/) Rust core —
the engine shipped in the `theta-script` npm package (v3+). Thin JSON-string
wrapper, mirroring the NIF and PyO3 adapters.

Not published to crates.io or npm directly; the artifacts are built into the
npm package by [`js/scripts/build-wasm.mjs`](../../js/scripts/build-wasm.mjs):

```sh
cd js && npm run build:wasm
```

Toolchain: `rustup` stable with the `wasm32-unknown-unknown` target,
[`wasm-pack`](https://rustwasm.github.io/wasm-pack/), and binaryen's
`wasm-opt`. Note wasm-pack's bundled wasm-opt pass is disabled in
`Cargo.toml` (it rejects the bulk-memory ops modern rustc emits); the build
script runs binaryen's wasm-opt manually with the feature flags enabled.

The `'local'` timezone is resolved by the JS wrapper via `Intl` before
calling in; the core maps `'local'` to the spec default (see
`rust/theta-script/src/time.rs`).
