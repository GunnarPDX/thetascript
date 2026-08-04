import { BUILTIN_NAMES, SOURCE_NAMES } from '../src/builtins.js';
import { DRAW_FN_NAMES, KEYWORD_NAMES, runScript } from '../src/interpreter.js';
import { GETTING_STARTED, HELP_SECTIONS } from '../src/docs.js';

// the docs are data, so drift is testable: every name the runtime exposes
// must appear in some help row's code cell
test('help sections document every builtin, draw function, keyword and source', () => {
  const codes = HELP_SECTIONS.flatMap(sec => sec.rows.map(([code]) => code)).join('\n');
  const names = [
    ...BUILTIN_NAMES,
    ...DRAW_FN_NAMES,
    ...KEYWORD_NAMES,
    ...SOURCE_NAMES,
  ];
  const missing = names.filter(name =>
    !new RegExp(`\\b${name.replace(/\./g, '\\.')}\\b`).test(codes));
  expect(missing).toEqual([]);
});

// the walkthrough's code steps are real scripts — every one must run
test('every getting-started snippet runs without error', () => {
  const bars = Array.from({ length: 120 }, (_, i) => {
    const mid = 100 + Math.sin(i / 7) * 5 + i * 0.03;
    return {
      date: new Date(Date.UTC(2026, 0, 1, 9, 30 + i)), rank: i,
      open: mid - 0.4, high: mid + 1, low: mid - 1, close: mid + 0.4,
      volume: 1000 + (i % 5) * 300,
    };
  });
  GETTING_STARTED.forEach(sec => sec.body.forEach(item => {
    if (!item.code) return;
    const res = runScript(item.code, bars, {});
    expect(`${sec.title}: ${res.error}`).toBe(`${sec.title}: null`);
  }));
});
