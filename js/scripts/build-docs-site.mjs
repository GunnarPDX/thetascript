// Builds the GitHub Pages site in ../docs from the documentation of record:
// js/src/docs.js (HELP_SECTIONS, GETTING_STARTED), js/src/examples.js
// (EXAMPLES), spec/SPEC.md and conformance/README.md. Run with
// `npm run docs:site`; commit the docs/ output.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP_SECTIONS, GETTING_STARTED } from '../src/docs.js';
import { EXAMPLES } from '../src/examples.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'docs');
mkdirSync(out, { recursive: true });

const esc = (s) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// --- theta-script syntax highlighting (comments, strings, keywords, numbers)
const TOKEN =
  /(\/\/[^\n]*)|("[^"\n]*")|\b(var|if|else|for|to|by|while|switch|break|continue|and|or|not|true|false|na)\b|(=>|:=)|(\b\d+(?:\.\d+)?\b)/g;
function hl(code) {
  let html = '';
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    html += esc(code.slice(last, m.index));
    const [text] = m;
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : m[4] ? 'o' : 'n';
    html += `<span class="${cls}">${esc(text)}</span>`;
    last = m.index + text.length;
  }
  return html + esc(code.slice(last));
}

// --- minimal markdown renderer for SPEC.md / conformance README
function inline(md) {
  let s = esc(md);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s.,;:)]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
    // Documents rendered on this site link to each other; other repo-relative
    // paths can't resolve on the site, so they degrade to plain text.
    const [path, frag] = href.split('#');
    if (/SPEC\.md$/.test(path)) return `<a href="spec.html${frag ? '#' + frag : ''}">${text}</a>`;
    if (/conformance\/(README\.md)?$/.test(path)) return `<a href="conformance.html">${text}</a>`;
    if (/^https?:/.test(href)) return `<a href="${href}">${text}</a>`;
    return text;
  });
  return s;
}

const slug = (t) =>
  t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function markdown(md) {
  const lines = md.split('\n');
  const html = [];
  const toc = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      html.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    } else if (/^#{1,3} /.test(line)) {
      const level = line.match(/^#+/)[0].length;
      const text = line.replace(/^#+ /, '');
      const id = slug(text);
      if (level === 2) toc.push({ id, text });
      html.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++;
    } else if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      html.push(
        '<div class="tablewrap"><table><thead><tr>' +
          head.map((c) => `<th>${c}</th>`).join('') +
          '</tr></thead><tbody>' +
          body.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>',
      );
    } else if (/^[-*] /.test(line) || /^\d+\. /.test(line)) {
      const ordered = /^\d+\. /.test(line);
      const items = [];
      while (i < lines.length && (/^[-*] /.test(lines[i]) || /^\d+\. /.test(lines[i]))) {
        let item = lines[i].replace(/^([-*]|\d+\.) /, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.) /.test(lines[i]))
          item += ' ' + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
    } else if (line.trim() === '') {
      i++;
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() !== '' && !/^(#|```|\||[-*] |\d+\. )/.test(lines[i]))
        buf.push(lines[i++]);
      html.push(`<p>${inline(buf.join(' '))}</p>`);
    }
  }
  return { html: html.join('\n'), toc };
}

// --- page shell
const NAV = [
  ['index.html', 'Home'],
  ['learn.html', 'Learn'],
  ['reference.html', 'Reference'],
  ['examples.html', 'Examples'],
  ['spec.html', 'Spec'],
];

const CSS = `
:root {
  --bg: #ffffff; --fg: #1a1f24; --muted: #57606a; --line: #d8dee4;
  --accent: #0969da; --code-bg: #f6f8fa; --k: #cf222e; --s: #0a3069;
  --c: #6e7781; --n: #0550ae; --o: #8250df;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --line: #30363d;
    --accent: #58a6ff; --code-bg: #161b22; --k: #ff7b72; --s: #a5d6ff;
    --c: #8b949e; --n: #79c0ff; --o: #d2a8ff;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.65 system-ui, -apple-system, 'Segoe UI', sans-serif;
}
nav {
  position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--line);
  padding: 0.6rem 1rem; display: flex; gap: 1.1rem; align-items: baseline;
  flex-wrap: wrap; z-index: 10;
}
nav .brand { font-weight: 700; font-family: ui-monospace, monospace; margin-right: 0.5rem; }
nav a { color: var(--muted); text-decoration: none; font-size: 0.95rem; }
nav a.brand { color: var(--fg); font-size: 1rem; }
nav a[aria-current] { color: var(--accent); font-weight: 600; }
nav a:hover { color: var(--accent); }
main { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
h1 { font-size: 1.9rem; line-height: 1.25; margin: 1rem 0; }
h2 { margin-top: 2.2rem; padding-top: 0.4rem; }
h1 code, h2 code, h3 code { background: none; padding: 0; }
a { color: var(--accent); }
p code, li code, td code, th code {
  background: var(--code-bg); border: 1px solid var(--line); border-radius: 4px;
  padding: 0.08em 0.32em; font-size: 0.86em;
}
pre {
  background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px;
  padding: 0.9rem 1.1rem; overflow-x: auto; line-height: 1.5;
}
pre code { font: 0.86rem/1.55 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; }
.k { color: var(--k); } .s { color: var(--s); } .c { color: var(--c); font-style: italic; }
.n { color: var(--n); } .o { color: var(--o); }
.tablewrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.92rem; }
th, td { border: 1px solid var(--line); padding: 0.45rem 0.7rem; text-align: left; vertical-align: top; }
th { background: var(--code-bg); }
.lede { font-size: 1.12rem; color: var(--muted); max-width: 44rem; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 1rem; margin: 2rem 0; }
.card {
  border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.2rem;
  text-decoration: none; color: var(--fg); display: block;
}
.card:hover { border-color: var(--accent); }
.card h3 { margin: 0 0 0.35rem; color: var(--accent); }
.card p { margin: 0; color: var(--muted); font-size: 0.93rem; }
.tags { color: var(--muted); font-size: 0.85rem; font-family: ui-monospace, monospace; }
.blurb { color: var(--muted); max-width: 44rem; }
.toc { border: 1px solid var(--line); border-radius: 10px; padding: 0.9rem 1.2rem; margin: 1.4rem 0; column-width: 16rem; }
.toc a { display: block; text-decoration: none; padding: 0.12rem 0; font-size: 0.93rem; }
footer {
  border-top: 1px solid var(--line); color: var(--muted); font-size: 0.88rem;
  max-width: 60rem; margin: 0 auto; padding: 1.2rem 1.25rem 2.5rem;
}
.refrow th { font-family: ui-monospace, monospace; font-weight: 500; white-space: pre-wrap; width: 42%; }
`;

function page(file, title, body, { description } = {}) {
  const nav = NAV.map(
    ([href, label]) =>
      `<a href="${href}"${href === file ? ' aria-current="page"' : ''}${href === 'index.html' ? ' class="brand"' : ''}>${href === 'index.html' ? 'ThetaScript' : label}</a>`,
  ).join('');
  writeFileSync(
    join(out, file),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
<style>${CSS}</style>
</head>
<body>
<nav>${nav}</nav>
<main>
${body}
</main>
<footer>MIT licensed. Site generated from the repository's documentation of record
(<code>js/src/docs.js</code>, <code>js/src/examples.js</code>, <code>spec/SPEC.md</code>)
by <code>npm run docs:site</code>.</footer>
</body>
</html>
`,
  );
  console.log('wrote', file);
}

const code = (src) => `<pre><code>${hl(src.trimEnd())}</code></pre>`;

// --- index.html
const HERO_SCRIPT = `study("Cross Strategy", overlay=true)
fast = ema(close, 9)
slow = ema(close, 21)
plot(fast, color="#22d3ee")
plot(slow, color="#f59e0b", width=2)
var entries = 0
if crossover(fast, slow)
    entries := entries + 1
strategy.buy(crossover(fast, slow), 10, trailing=2)
strategy.sell(crossunder(fast, slow), 10)
alertcondition(crossover(fast, slow), message="cross up")`;

page(
  'index.html',
  'theta-script — a per-bar scripting language for chart studies',
  `
<h1>theta-script</h1>
<p class="lede">A small scripting language for chart studies and trade-signal
scripts, executed once per bar. One language, four conforming runtimes —
JavaScript, Rust, Python and Elixir — held together by a normative spec and a
bit-exact conformance corpus.</p>

${code(HERO_SCRIPT)}

<div class="cards">
  <a class="card" href="learn.html"><h3>Learn</h3><p>A seven-step walkthrough from your first plot to a backtested strategy.</p></a>
  <a class="card" href="reference.html"><h3>Reference</h3><p>Every builtin, statement, draw call, source and operator.</p></a>
  <a class="card" href="examples.html"><h3>Examples</h3><p>Complete scripts — every one runs against the current engine in CI.</p></a>
  <a class="card" href="spec.html"><h3>Specification</h3><p>The normative language definition, plus the conformance contract.</p></a>
</div>

<h2>Why another chart language?</h2>
<p>theta-script is designed to run untrusted user scripts safely, identically,
everywhere: <strong>no recursion, no unbounded loops, no I/O, no aggregate data
structures</strong> beyond bounded arrays. Work per run is bounded by
<code>bars × statements × loop-limit</code>, and the per-bar execution model
evaluates incrementally — a live tick appends one bar of work, which is what a
streaming backend wants.</p>
<p>The same script produces bit-identical results in the browser (JavaScript
reference), on the server (Rust core), and through the Python and Elixir
bindings. That claim is enforced, not aspirational: every runtime replays a
shared corpus of golden fixtures on every test run
(<a href="conformance.html">how conformance works</a>).</p>

<h2>Quick start</h2>
<h3>JavaScript</h3>
<pre><code>import { runScript } from 'theta-script';

const result = runScript(source, bars, { timezone: 'America/New_York' });
// result.plots / result.trades / result.strategy / result.error …</code></pre>
<h3>Rust</h3>
<pre><code>use theta_script::{bars_from_json, opts_from_json, run_script};

let result = run_script(source, &amp;bars, opts);</code></pre>
<h3>Python</h3>
<pre><code>import json, theta_script

result = json.loads(theta_script.run_script_json(source, json.dumps(bars), None))</code></pre>
<h3>Elixir</h3>
<pre><code>{:ok, result} = Jason.decode(ThetaScript.run_json(source, bars_json))</code></pre>
<p>Bars are <code>{ date, open, high, low, close, volume }</code> with
<code>date</code> in milliseconds since the Unix epoch. All four runtimes
return the same <a href="spec.html#12-result-object">result object</a>.</p>
`,
  { description: 'theta-script: a per-bar scripting language for chart studies and trade signals, with four conforming runtimes.' },
);

// --- learn.html (GETTING_STARTED)
page(
  'learn.html',
  'Learn theta-script',
  `
<h1>Learn theta-script</h1>
<p class="lede">The guided walkthrough from the script editor, in order. Each
snippet is a complete script you can run as-is.</p>
` +
    GETTING_STARTED.map(
      (step) => `
<h2 id="${slug(step.title)}">${esc(step.title)}</h2>
${step.body.map((b) => (b.p ? `<p>${esc(b.p)}</p>` : code(b.code))).join('\n')}`,
    ).join('\n'),
  { description: 'A seven-step guided introduction to the theta-script language.' },
);

// --- reference.html (HELP_SECTIONS)
page(
  'reference.html',
  'theta-script reference',
  `
<h1>Language reference</h1>
<p class="lede">Every builtin, statement, draw function, source and operator.
This page is generated from the same data the script editor's docs panel
renders; a drift test asserts it covers everything the runtime exposes. For
exact numeric semantics (warmup, NaN handling, locking), see the
<a href="spec.html">specification</a>.</p>
<div class="toc">${HELP_SECTIONS.map((s) => `<a href="#${slug(s.title)}">${esc(s.title)}</a>`).join('')}</div>
` +
    HELP_SECTIONS.map(
      (section) => `
<h2 id="${slug(section.title)}">${esc(section.title)}</h2>
<div class="tablewrap"><table>
${section.rows
  .map(
    (r) =>
      `<tr class="refrow"><th scope="row">${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`,
  )
  .join('\n')}
</table></div>`,
    ).join('\n'),
  { description: 'Complete reference for theta-script builtins, statements, drawing, strategy, data sources and operators.' },
);

// --- examples.html (EXAMPLES)
page(
  'examples.html',
  'theta-script examples',
  `
<h1>Examples</h1>
<p class="lede">Complete scripts, from indicator overlays to backtested
strategies. Every example on this page is executed against a synthetic tape by
the JS test suite, so each one is guaranteed to parse and run on the current
engine.</p>
<div class="toc">${EXAMPLES.map((e) => `<a href="#${slug(e.name)}">${esc(e.name)}</a>`).join('')}</div>
` +
    EXAMPLES.map(
      (ex) => `
<h2 id="${slug(ex.name)}">${esc(ex.name)}</h2>
<p class="tags">${ex.tags.map(esc).join(' · ')}</p>
<p class="blurb">${esc(ex.blurb)}</p>
${code(ex.source)}`,
    ).join('\n'),
  { description: 'Complete, tested theta-script example scripts.' },
);

// --- spec.html / conformance.html (rendered markdown)
const spec = markdown(readFileSync(join(root, 'spec', 'SPEC.md'), 'utf8'));
page(
  'spec.html',
  'theta-script language specification',
  `<div class="toc">${spec.toc.map((t) => `<a href="#${t.id}">${esc(t.text)}</a>`).join('')}</div>\n` +
    spec.html,
  { description: 'The normative theta-script language specification.' },
);

const conf = markdown(readFileSync(join(root, 'conformance', 'README.md'), 'utf8'));
page('conformance.html', 'theta-script conformance corpus', conf.html, {
  description: 'How the theta-script conformance corpus keeps four runtimes bit-exact.',
});

writeFileSync(join(out, '.nojekyll'), '');
console.log('wrote .nojekyll');
