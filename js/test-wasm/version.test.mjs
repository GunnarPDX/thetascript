// Package-surface invariants for the wasm wrapper. The npm package version
// (3.x) is decoupled from LANG_VERSION (the language/spec version); the
// lockstep invariant lives in version.test.js (LANG_VERSION vs Rust core)
// and in init(), which refuses a wasm engine speaking a different lang.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSync, runScript, LANG_VERSION, DRAW_FN_NAMES, KEYWORD_NAMES } from '../index.js';
import { langVersion } from '../wasm/theta_script_wasm.js';

const jsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('runScript before init throws a clear error', () => {
  assert.throws(() => runScript('study("x")\nplot(close)', []), /await init\(\)/);
});

test('initSync loads the engine and pins LANG_VERSION', () => {
  initSync(fs.readFileSync(path.join(jsDir, 'wasm', 'theta_script_wasm_bg.wasm')));
  assert.equal(langVersion(), LANG_VERSION);
});

test('runScript produces wire-encoded output after init', () => {
  const bars = [{ date: 1500000000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];
  const result = runScript('study("t")\nplot(close)', bars);
  assert.equal(result.error, null);
  assert.equal(result.plots[0].values[0], 1.5);
});

test("timezone 'local' is resolved via Intl before reaching the engine", () => {
  const bars = [{ date: 1500000000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];
  const script = 'study("t")\nplot(hour(time))';
  const viaLocal = runScript(script, bars, { timezone: 'local' });
  const viaHostZone = runScript(script, bars, {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  assert.equal(viaLocal.error, null);
  assert.deepEqual(viaLocal.plots[0].values, viaHostZone.plots[0].values);
});

test('tooling constants stay exported', () => {
  assert.ok(DRAW_FN_NAMES.includes('plot'));
  assert.ok(KEYWORD_NAMES.includes('var'));
});
