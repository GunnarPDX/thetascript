import fs from 'fs';
import path from 'path';
import { LANG_VERSION } from '../src/interpreter.js';

// One language version, three declarations: src/names.js (LANG_VERSION),
// the Rust workspace crates, and every fixture's lang field. This pins the
// first two together; the port runners pin the fixtures. The npm package
// version is deliberately decoupled (3.x ships the wasm engine while the
// language stays at LANG_VERSION until observable behavior changes).
test('Rust core version equals LANG_VERSION', () => {
  const cargo = fs.readFileSync(
    path.join(__dirname, '..', '..', 'rust', 'theta-script', 'Cargo.toml'),
    'utf8'
  );
  expect(cargo).toMatch(new RegExp(`^version = "${LANG_VERSION.replace(/\./g, '\\.')}"$`, 'm'));
});

test('package major version is 3+ (wasm engine era)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  expect(Number(pkg.version.split('.')[0])).toBeGreaterThanOrEqual(3);
});
