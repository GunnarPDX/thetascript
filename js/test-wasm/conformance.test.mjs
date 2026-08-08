// Runs the shared conformance corpus (conformance/) against the shipped
// package surface: index.js wrapper + js/wasm engine — the same artifacts
// `npm publish` ships. Comparison policy matches the other port runners:
// exact match in encoded space, 1e-9 relative tolerance for numbers
// (transcendental libm differences).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSync, runScript, LANG_VERSION } from '../index.js';

const jsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const confDir = path.join(jsDir, '..', 'conformance');

initSync(fs.readFileSync(path.join(jsDir, 'wasm', 'theta_script_wasm_bg.wasm')));

const tapes = JSON.parse(fs.readFileSync(path.join(confDir, 'tapes.json'), 'utf8'));
const expectedDir = path.join(confDir, 'expected');

const TOL = 1e-9;
const diffs = [];
const near = (a, b) => {
  if (a === b) return true;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) < TOL;
};
const deepEq = (a, b, p) => {
  if (typeof a === 'number' && typeof b === 'number') {
    if (!near(a, b)) diffs.push(`${p}: ${a} != ${b}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { diffs.push(`${p}: len ${a.length} != ${b.length}`); return; }
    a.forEach((v, i) => deepEq(v, b[i], `${p}[${i}]`));
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) { diffs.push(`${p}: keys [${ka}] != [${kb}]`); return; }
    ka.forEach((k) => deepEq(a[k], b[k], `${p}.${k}`));
    return;
  }
  if (a !== b) diffs.push(`${p}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};

for (const file of fs.readdirSync(expectedDir).sort()) {
  const fixture = JSON.parse(fs.readFileSync(path.join(expectedDir, file), 'utf8'));
  test(`wasm conformance: ${fixture.name}`, () => {
    assert.equal(fixture.lang, LANG_VERSION, 'fixture lang matches LANG_VERSION');
    const got = runScript(fixture.script, tapes[fixture.tape] ?? [], fixture.opts);
    const before = diffs.length;
    deepEq(got, fixture.expected, fixture.name);
    assert.deepEqual(diffs.slice(before), [], 'wasm output matches fixture');
  });
}
