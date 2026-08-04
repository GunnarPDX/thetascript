import { runScript } from '../src/interpreter.js';
import { highestStream, lowestStream, sumStream, stdevStream } from '../src/streams.js';

const BARS = Array.from({ length: 30 }, (_, i) => ({
  date: new Date(2026, 0, 1, 9, 30 + i), rank: i,
  open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000,
}));

const SRC = `study("T", overlay=true)
len = input.int(9, "Length", minval=1)
off = input.float(0.85, "Offset", step=0.01, tooltip="explanation")
plot(sma(close, len) * off)
`;

test('inputs declare metadata and return defaults', () => {
  const res = runScript(SRC, BARS);
  expect(res.error).toBeNull();
  expect(res.inputs).toHaveLength(2);
  expect(res.inputs[0]).toMatchObject({ label: 'Length', type: 'int', default: 9, value: 9, minval: 1 });
  expect(res.inputs[1]).toMatchObject({ label: 'Offset', type: 'float', value: 0.85, step: 0.01, tooltip: 'explanation' });
});

test('overrides replace defaults and clamp to minval, ints round', () => {
  const res = runScript(SRC, BARS, { inputs: { Length: 4.6, Offset: -2 } });
  expect(res.inputs[0].value).toBe(5); // rounded
  expect(res.inputs[1].value).toBe(-2); // no minval on the float
  const clamped = runScript(SRC, BARS, { inputs: { Length: -3 } });
  expect(clamped.inputs[0].value).toBe(1); // minval=1
});

test('overridden input changes the plotted series', () => {
  const a = runScript(SRC, BARS, { inputs: { Length: 2 } });
  const b = runScript(SRC, BARS, { inputs: { Length: 20 } });
  expect(a.plots[0].values[25]).not.toBe(b.plots[0].values[25]);
});

test('duplicate input labels get distinct keys and separate overrides', () => {
  const src = `study("D")
a = input.int(9, "Length")
b = input.int(21, "Length")
plot(a + b)
`;
  const res = runScript(src, BARS);
  expect(res.error).toBeNull();
  expect(res.inputs.map(i => i.key)).toEqual(['Length', 'Length (2)']);
  expect(res.inputs.map(i => i.label)).toEqual(['Length', 'Length']);
  const over = runScript(src, BARS, { inputs: { Length: 5, 'Length (2)': 7 } });
  expect(over.inputs[0].value).toBe(5);
  expect(over.inputs[1].value).toBe(7);
  expect(over.plots[0].values[0]).toBe(12);
});

test('fill against an hline resolves to the hline level', () => {
  const src = `study("F", overlay=false)
r = rsi(close, 5)
p = plot(r)
h = hline(70)
fill(p, h, color="#fff")
hline(30)
`;
  const res = runScript(src, BARS);
  expect(res.error).toBeNull();
  expect(res.plots).toHaveLength(3); // plot + two hlines
  expect(res.fills).toHaveLength(1);
  expect(res.fills[0].b.every(v => v === 70)).toBe(true);
  expect(res.fills[0].a).toEqual(res.plots[0].values);
});

test('malformed numbers are parse errors; multi-line calls parse', () => {
  const bad = runScript('x = 1.2.3\nplot(close)', BARS);
  expect(bad.error).toMatch(/malformed number '1\.2\.3'/);
  // newlines inside an unclosed paren are plain whitespace (v2)
  const split = runScript('plot(close,\n  "#fff",\n  2)', BARS);
  expect(split.error).toBeNull();
  expect(split.plots[0].color).toBe('#fff');
  expect(split.plots[0].width).toBe(2);
});

test('AST cache returns consistent results (and cached errors) across runs', () => {
  const a = runScript(SRC, BARS, { inputs: { Length: 3 } });
  const b = runScript(SRC, BARS, { inputs: { Length: 3 } });
  expect(b.error).toBeNull();
  expect(b.plots[0].values).toEqual(a.plots[0].values);
  expect(b.inputs).toEqual(a.inputs);
  const c = runScript(SRC, BARS, { inputs: { Length: 12 } }); // same AST, new inputs
  expect(c.plots[0].values[29]).not.toBe(a.plots[0].values[29]);
  const e1 = runScript('x = 1.2.3', BARS);
  const e2 = runScript('x = 1.2.3', BARS);
  expect(e2.error).toBe(e1.error);
});

test('rolling streams match brute-force references', () => {
  // deterministic wiggly series with a NaN warmup and a NaN gap in the middle
  const s = Array.from({ length: 80 }, (_, i) =>
    (i < 3 || i === 40 ? NaN : 100 + Math.sin(i * 1.7) * 10 + (i % 7)));
  const brute = (vals, p, f) => vals.map((_, i) =>
    (i < p - 1 ? NaN : f(vals.slice(i - p + 1, i + 1))));
  const refs = {
    highest: [highestStream, (w) => Math.max(...w)],
    lowest: [lowestStream, (w) => Math.min(...w)],
    sum: [sumStream, (w) => w.reduce((a, b) => a + b, 0)],
    stdev: [stdevStream, (w) => {
      const m = w.reduce((a, b) => a + b, 0) / w.length;
      return Math.sqrt(w.reduce((a, b) => a + (b - m) * (b - m), 0) / w.length);
    }],
  };
  [1, 2, 5, 14].forEach(p => {
    Object.keys(refs).forEach(name => {
      const [mk, ref] = refs[name];
      const stream = mk(p);
      const got = s.map(v => stream(v));
      const want = brute(s, p, ref);
      got.forEach((v, i) => {
        if (Number.isNaN(want[i])) expect(v).toBeNaN();
        else expect(v).toBeCloseTo(want[i], 8);
      });
    });
  });
  // periods larger than the series stay NaN for the never-full window
  const big = highestStream(1000);
  expect(s.map(v => big(v)).every(Number.isNaN)).toBe(true);
});

test('plot width: named kw wins, numeric third positional works, default 2', () => {
  const src = `study("W", overlay=true)
plot(close)
plot(close, "#fff", 5)
plot(close, "#fff", 5, width=3)
`;
  const res = runScript(src, BARS);
  expect(res.error).toBeNull();
  expect(res.plots.map(p => p.width)).toEqual([2, 5, 3]);
});

test('style edits rewrite source literals when present, fall back otherwise', () => {
  // eslint-disable-next-line global-require
  const { rewritePlotColor, rewritePlotWidths } = require('../src/rewriteStyle.js');
  const src = `study("S", overlay=true)
plot(close, color="#ef4444", width=3)
plot(open, "#22c55e")
c = "#fff"
plot(high, color=c)
`;
  const res = runScript(src, BARS);
  expect(res.error).toBeNull();
  expect(res.plots[0].colorSpan).toBeTruthy();
  expect(res.plots[0].widthSpan).toBeTruthy();
  expect(res.plots[1].colorSpan).toBeTruthy();
  expect(res.plots[1].widthSpan).toBeNull();
  expect(res.plots[2].colorSpan).toBeNull(); // computed via variable — no span

  const { source: s1, rewritten } = rewritePlotColor(src, res.plots[0], '#3b82f6');
  expect(rewritten).toBe(true);
  expect(s1).toContain('color="#3b82f6"');
  expect(rewritePlotColor(src, res.plots[2], '#111').rewritten).toBe(false);

  const { source: s2, allRewritten } = rewritePlotWidths(src, res.plots, 5);
  expect(allRewritten).toBe(false); // two plots have no width literal
  expect(s2).toContain('width=5');

  // rewritten source still parses and reflects the new values
  const res2 = runScript(s2, BARS);
  expect(res2.error).toBeNull();
  expect(res2.plots[0].width).toBe(5);
  expect(res2.plots[0].color).toBe('#ef4444');
});
