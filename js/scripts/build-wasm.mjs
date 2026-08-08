#!/usr/bin/env node
// Builds the wasm engine from rust/theta-script-wasm and installs the
// artifacts into js/wasm/ for publishing. Requires: rustup stable with the
// wasm32-unknown-unknown target, wasm-pack, and binaryen's wasm-opt.
//
// wasm-pack's own wasm-opt pass is disabled (it rejects the bulk-memory ops
// modern rustc emits); we run binaryen's wasm-opt here with the flags.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const jsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = join(jsDir, '..', 'rust', 'theta-script-wasm');
const pkgDir = join(crateDir, 'pkg');
const outDir = join(jsDir, 'wasm');

// rustup's cargo (which has the wasm32 target) must win over any other
// cargo on PATH (e.g. Homebrew's, which shares no rustup toolchains).
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', env, ...opts });

run('wasm-pack', ['build', '--release', '--target', 'web'], { cwd: crateDir });

const rawWasm = join(pkgDir, 'theta_script_wasm_bg.wasm');
run('wasm-opt', [
  rawWasm, '-o', rawWasm, '-Oz',
  '--enable-bulk-memory', '--enable-nontrapping-float-to-int',
]);

mkdirSync(outDir, { recursive: true });
for (const f of [
  'theta_script_wasm.js',
  'theta_script_wasm.d.ts',
  'theta_script_wasm_bg.wasm',
  'theta_script_wasm_bg.wasm.d.ts',
]) {
  copyFileSync(join(pkgDir, f), join(outDir, f));
}
const bytes = readFileSync(join(outDir, 'theta_script_wasm_bg.wasm'));
console.log(
  `\nwasm engine installed to js/wasm/: ` +
  `${(statSync(join(outDir, 'theta_script_wasm_bg.wasm')).size / 1024).toFixed(0)} KB raw, ` +
  `${(gzipSync(bytes, { level: 9 }).length / 1024).toFixed(0)} KB gzip`
);
