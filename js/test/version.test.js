import fs from 'fs';
import path from 'path';
import { LANG_VERSION } from '../src/interpreter.js';

// one version, three declarations: the JS package, the Rust workspace, and
// every fixture's lang field. This pins the first; the port runners pin the
// rest against the fixtures.
test('package version equals LANG_VERSION', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  expect(pkg.version).toBe(LANG_VERSION);
});
