// Conformance corpus runner and regenerator. Normal runs compare the live
// interpreter against the committed fixtures; UPDATE_CONFORMANCE=1 rewrites
// them (npm run conformance:update). The fixtures — tapes.json and
// expected/*.json — are the language contract every other implementation
// must satisfy (see README.md for the port-side runner contract).
import fs from 'fs';
import path from 'path';
import { runScript, LANG_VERSION } from '../src/interpreter.js';
import { TAPES } from './tapes.js';
import { CASES } from './cases.js';
import { encode } from './encode.js';

const UPDATE = !!process.env.UPDATE_CONFORMANCE;
const EXPECTED_DIR = path.join(__dirname, '..', '..', 'conformance', 'expected');
const TAPES_FILE = path.join(__dirname, '..', '..', 'conformance', 'tapes.json');
// JSON round-trip so both sides of every comparison have been through the
// same undefined-dropping, number-formatting pipeline as the stored files
const roundtrip = (v) => JSON.parse(JSON.stringify(v));

test('case names are unique and reference real tapes', () => {
  const names = CASES.map(c => c.name);
  expect(new Set(names).size).toBe(names.length);
  CASES.forEach(c => expect(TAPES[c.tape]).toBeDefined());
});

test('tapes.json matches the deterministic generators', () => {
  if (UPDATE) fs.writeFileSync(TAPES_FILE, `${JSON.stringify(TAPES, null, 2)}\n`);
  expect(JSON.parse(fs.readFileSync(TAPES_FILE, 'utf8'))).toEqual(roundtrip(TAPES));
});

describe('conformance corpus', () => {
  if (UPDATE) fs.mkdirSync(EXPECTED_DIR, { recursive: true });
  CASES.forEach(c => {
    // eslint-disable-next-line jest/valid-title -- data-driven case names
    test(c.name, () => {
      const result = runScript(c.script, TAPES[c.tape], c.opts || null);
      // err-* cases must fail, everything else must run clean
      const wantError = c.name.startsWith('err-');
      expect({ case: c.name, error: result.error })
        .toEqual({ case: c.name, error: wantError ? expect.any(String) : null });
      const got = roundtrip(encode(result));
      const file = path.join(EXPECTED_DIR, `${c.name}.json`);
      if (UPDATE) {
        const fixture = { lang: LANG_VERSION, name: c.name, tape: c.tape, opts: c.opts ?? null, script: c.script, expected: got };
        fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
      }
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      // metadata must match, not just outputs: a LANG_VERSION bump without
      // regeneration — or a cases.js edit whose output happens to coincide —
      // would otherwise pass silently while ports execute the stale embedded
      // script/opts from the fixture file
      expect(stored.lang).toBe(LANG_VERSION);
      expect(stored.script).toBe(c.script);
      expect(stored.tape).toBe(c.tape);
      expect(stored.opts).toEqual(roundtrip(c.opts ?? null));
      expect(got).toEqual(stored.expected);
    });
  });
});

test('expected/ holds exactly one fixture per case, no strays', () => {
  const files = fs.readdirSync(EXPECTED_DIR).filter(f => f.endsWith('.json')).sort();
  expect(files).toEqual(CASES.map(c => `${c.name}.json`).sort());
});
