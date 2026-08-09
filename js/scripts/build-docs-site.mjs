// Builds the GitHub Pages site in ../docs from the documentation of record:
// js/src/docs.js (HELP_SECTIONS, GETTING_STARTED), js/src/examples.js
// (EXAMPLES), spec/SPEC.md and conformance/README.md. Run with
// `npm run docs:site`; commit the docs/ output.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP_SECTIONS, GETTING_STARTED } from '../src/docs.js';
import { EXAMPLES } from '../src/examples.js';
import { LANG_VERSION } from '../src/names.js';

// docs/og-card.png (the social-preview image referenced from every page) is
// a committed asset, not rebuilt here: render js/scripts/og-card.svg in a
// browser at 1200x630 and export. SVG-to-PNG CLI tools mangle it (the theta
// crossbar needs a userSpaceOnUse gradient; qlmanage also breaks aspect).
const SITE = 'https://gunnarpdx.github.io/thetascript/';
const REPO = 'https://github.com/GunnarPDX/thetascript';
const NPM = 'https://www.npmjs.com/package/theta-script';
const TAGLINE =
  'A small scripting language for chart studies and trade-signal scripts, ' +
  'executed once per bar — one Rust engine compiled to WebAssembly, native, ' +
  'Python and Elixir, kept bit-exact by a conformance corpus.';

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
  --bg: #fbfcfe; --bg-elev: #ffffff; --fg: #10151a; --muted: #5b6772;
  --line: #e3e8ee; --accent: #0e7490; --code-bg: #f4f6f9;
  --k: #cf222e; --s: #0a3069; --c: #6e7781; --n: #0550ae; --o: #8250df;
  --logo-1: #06b6d4; --logo-2: #8b5cf6;
  --nav-bg: rgb(255 255 255 / 0.78);
  --shadow: 0 1px 2px rgb(16 21 26 / 0.05), 0 10px 28px -14px rgb(16 21 26 / 0.18);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0e13; --bg-elev: #11161d; --fg: #e7edf3; --muted: #93a0ab;
    --line: #222a34; --accent: #3fd0ec; --code-bg: #10151d;
    --k: #ff7b72; --s: #a5d6ff; --c: #7d8590; --n: #79c0ff; --o: #d2a8ff;
    --logo-1: #22d3ee; --logo-2: #a78bfa;
    --nav-bg: rgb(11 14 19 / 0.72);
    --shadow: 0 0 0 1px rgb(255 255 255 / 0.03), 0 14px 36px -16px rgb(0 0 0 / 0.65);
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
::selection { background: color-mix(in srgb, var(--accent) 24%, transparent); }
.lg1 { stop-color: var(--logo-1); } .lg2 { stop-color: var(--logo-2); }
nav {
  position: sticky; top: 0; z-index: 10;
  display: flex; gap: 1.2rem; align-items: center; flex-wrap: wrap;
  padding: 0.65rem 1.25rem; border-bottom: 1px solid var(--line);
  background: var(--nav-bg);
  -webkit-backdrop-filter: blur(14px) saturate(1.5); backdrop-filter: blur(14px) saturate(1.5);
}
nav a { color: var(--muted); text-decoration: none; font-size: 0.95rem; transition: color 0.15s; }
nav a:hover { color: var(--fg); }
nav a[aria-current] { color: var(--accent); font-weight: 600; }
nav a.brand {
  display: inline-flex; align-items: center; gap: 0.5rem; margin-right: 0.6rem;
  color: var(--fg); font: 700 1.02rem/1 ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  letter-spacing: -0.01em;
}
nav a.brand:hover { color: var(--fg); }
nav a.brand svg { display: block; }
main { max-width: 60rem; margin: 0 auto; padding: 2.4rem 1.25rem 4rem; }
h1 {
  font-size: clamp(1.9rem, 4.5vw, 2.5rem); line-height: 1.2; letter-spacing: -0.028em;
  font-weight: 800; margin: 1rem 0; text-wrap: balance;
}
h1.hero-title { display: flex; align-items: center; gap: 0.75rem; margin-top: 1.6rem; }
h1.hero-title svg { flex: none; }
h2 {
  margin-top: 2.6rem; letter-spacing: -0.015em;
  border-bottom: 1px solid var(--line); padding-bottom: 0.4rem;
}
h1, h2, h3 { scroll-margin-top: 4.5rem; }
h1 code, h2 code, h3 code { background: none; padding: 0; }
a { color: var(--accent); text-underline-offset: 0.15em; }
p code, li code, td code, th code {
  background: var(--code-bg); border: 1px solid var(--line); border-radius: 5px;
  padding: 0.08em 0.32em; font-size: 0.86em;
}
pre {
  background: var(--code-bg); border: 1px solid var(--line); border-radius: 12px;
  padding: 1rem 1.2rem; overflow-x: auto; line-height: 1.5; box-shadow: var(--shadow);
}
pre code { font: 0.86rem/1.55 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; }
.k { color: var(--k); } .s { color: var(--s); } .c { color: var(--c); font-style: italic; }
.n { color: var(--n); } .o { color: var(--o); }
.tablewrap {
  overflow-x: auto; border: 1px solid var(--line); border-radius: 12px;
  background: var(--bg-elev); margin: 1.1rem 0;
}
table { border-collapse: collapse; width: 100%; margin: 0; font-size: 0.92rem; }
th, td {
  border: 0; border-bottom: 1px solid var(--line);
  padding: 0.55rem 0.85rem; text-align: left; vertical-align: top;
}
thead th { background: var(--code-bg); font-weight: 600; }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
.lede { font-size: 1.15rem; color: var(--muted); max-width: 46rem; text-wrap: pretty; }
.install code {
  display: inline-block; background: var(--code-bg); border: 1px solid var(--line);
  border-radius: 999px; padding: 0.45em 1.1em; font-size: 0.92rem;
}
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(12.5rem, 1fr)); gap: 1rem; margin: 2.2rem 0; }
.card {
  background: var(--bg-elev); border: 1px solid var(--line); border-radius: 14px;
  padding: 1.15rem 1.3rem; text-decoration: none; color: var(--fg); display: block;
  transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
}
.card:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  transform: translateY(-2px); box-shadow: var(--shadow);
}
.card h3 { margin: 0 0 0.35rem; color: var(--accent); letter-spacing: -0.01em; }
.card p { margin: 0; color: var(--muted); font-size: 0.93rem; }
.tags { color: var(--muted); font-size: 0.85rem; font-family: ui-monospace, monospace; }
.blurb { color: var(--muted); max-width: 44rem; }
.toc { display: flex; flex-wrap: wrap; gap: 0.45rem; margin: 1.6rem 0; }
.toc a {
  border: 1px solid var(--line); border-radius: 999px; background: var(--bg-elev);
  padding: 0.26rem 0.85rem; font-size: 0.88rem; text-decoration: none; color: var(--muted);
  transition: color 0.15s, border-color 0.15s;
}
.toc a:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); }
footer {
  border-top: 1px solid var(--line); color: var(--muted); font-size: 0.88rem;
  max-width: 60rem; margin: 0 auto; padding: 1.2rem 1.25rem 2.5rem;
}
.refrow th { font-family: ui-monospace, monospace; font-weight: 500; white-space: pre-wrap; width: 42%; background: none; }
`;

// --- the θ logomark: geometric strokes, gently italic (skewed ~7.5°),
// gradient-filled via CSS vars so it adapts to light/dark. One shared
// <defs> gradient is injected per page; the favicon bakes its colors in.
const THETA_BODY = (grad) =>
  `<g transform="translate(2.1 0) skewX(-7.5)" fill="none" stroke="url(#${grad})" stroke-width="3.2" stroke-linecap="round">` +
  `<ellipse cx="15" cy="16" rx="8.8" ry="12.4"/><path d="M6.6 16h16.8"/></g>`;
const thetaLogo = (size) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">${THETA_BODY('thetaGrad')}</svg>`;
const THETA_DEFS =
  `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>` +
  `<linearGradient id="thetaGrad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">` +
  `<stop class="lg1" offset="0"/><stop class="lg2" offset="1"/></linearGradient></defs></svg>`;
const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs>` +
      THETA_BODY('g') +
      `</svg>`,
  );

function page(file, title, body, { description } = {}) {
  const nav = NAV.map(([href, label]) =>
    href === 'index.html'
      ? `<a href="${href}" class="brand">${thetaLogo(20)}<span>theta-script</span></a>`
      : `<a href="${href}"${href === file ? ' aria-current="page"' : ''}>${label}</a>`,
  ).join('');
  const url = SITE + (file === 'index.html' ? '' : file);
  const ld =
    file === 'index.html'
      ? {
          '@context': 'https://schema.org',
          '@graph': [
            { '@type': 'WebSite', name: 'theta-script', url: SITE, description },
            {
              '@type': 'SoftwareSourceCode',
              name: 'theta-script',
              description: TAGLINE,
              url: SITE,
              version: LANG_VERSION,
              codeRepository: REPO,
              programmingLanguage: ['Rust', 'WebAssembly', 'JavaScript', 'Python', 'Elixir'],
              license: 'https://opensource.org/license/mit/',
            },
          ],
        }
      : {
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: title,
          description,
          url,
          inLanguage: 'en',
          isPartOf: { '@type': 'WebSite', name: 'theta-script', url: SITE },
        };
  writeFileSync(
    join(out, file),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
<link rel="canonical" href="${url}">
<meta property="og:site_name" content="theta-script">
<meta property="og:type" content="${file === 'index.html' ? 'website' : 'article'}">
<meta property="og:title" content="${esc(title)}">
${description ? `<meta property="og:description" content="${esc(description)}">` : ''}
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}og-card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
${description ? `<meta name="twitter:description" content="${esc(description)}">` : ''}
<meta name="twitter:image" content="${SITE}og-card.png">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fbfcfe">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0e13">
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
${THETA_DEFS}
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
<h1 class="hero-title">${thetaLogo(38)}<span>theta-script</span></h1>
<p class="lede">A small scripting language for chart studies and trade-signal
scripts, executed once per bar. One Rust engine behind every runtime —
WebAssembly in the browser, native on the server, Python and Elixir bindings —
held together by a normative spec and a bit-exact conformance corpus.</p>
<p class="install"><code>npm install theta-script</code></p>

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
<p>The same script produces bit-identical results in the browser (the Rust
core compiled to WebAssembly), on the server (native Rust), and through the
Python and Elixir bindings — one engine, compiled everywhere. That claim is
enforced, not aspirational: every runtime replays a shared corpus of golden
fixtures on every test run, and a retained pure-JS implementation reproduces
the same corpus independently, keeping the spec honest
(<a href="conformance.html">how conformance works</a>).</p>

<h2>Quick start</h2>
<h3>JavaScript</h3>
<pre><code>import { init, runScript } from 'theta-script';

await init(); // once, at app startup — loads the wasm engine

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
const specMd = readFileSync(join(root, 'spec', 'SPEC.md'), 'utf8');
const spec = markdown(specMd);
page(
  'spec.html',
  'theta-script language specification',
  `<div class="toc">${spec.toc.map((t) => `<a href="#${t.id}">${esc(t.text)}</a>`).join('')}</div>\n` +
    spec.html,
  { description: 'The normative theta-script language specification.' },
);

const confMd = readFileSync(join(root, 'conformance', 'README.md'), 'utf8');
const conf = markdown(confMd);
page('conformance.html', 'theta-script conformance corpus', conf.html, {
  description: 'How the theta-script conformance corpus keeps four runtimes bit-exact.',
});

// --- crawler & AI-agent artifacts: robots.txt, sitemap.xml, llms.txt,
// llms-full.txt. Note: this is a GitHub *project* page, so these serve
// under /thetascript/ — the domain-root robots.txt belongs to GitHub.
// Ours is still read by AI agents given the site URL, and the sitemap can
// be submitted to Search Console directly.
const PAGES = [...NAV.map(([href]) => href), 'conformance.html'];

writeFileSync(
  join(out, 'robots.txt'),
  `# theta-script docs — crawling welcome, including for AI training/answering.
# Machine-readable summaries: ${SITE}llms.txt and ${SITE}llms-full.txt
User-agent: *
Allow: /

Sitemap: ${SITE}sitemap.xml
`,
);

writeFileSync(
  join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.map((p) => `  <url><loc>${SITE}${p === 'index.html' ? '' : p}</loc></url>`).join('\n')}
</urlset>
`,
);

writeFileSync(
  join(out, 'llms.txt'),
  `# theta-script

> ${TAGLINE}

Language version ${LANG_VERSION} (npm package version is independent semver;
v3+ ships the Rust core compiled to WebAssembly). Scripts run against an
ordered OHLCV bar array and produce one JSON result object — plots, shapes,
trades, strategy P&L, alerts — deterministically: same script + bars +
options gives identical results in every runtime. Safe on untrusted input
by construction: no recursion, no unbounded loops, no I/O.

## Docs

- [Learn](${SITE}learn.html): seven-step tutorial from first plot to a backtested strategy
- [Language reference](${SITE}reference.html): every builtin, statement, draw call, source and operator
- [Examples](${SITE}examples.html): complete scripts, each run against the engine in CI
- [Specification](${SITE}spec.html): the normative language definition
- [Conformance](${SITE}conformance.html): how the shared corpus keeps every runtime bit-exact
- [Full documentation as one markdown file](${SITE}llms-full.txt): reference + tutorial + examples + spec, for LLM ingestion

## Source & packages

- [GitHub repository](${REPO}): spec, conformance corpus, and all runtimes
- [npm package](${NPM}): \`npm install theta-script\` — wasm engine, \`await init()\` then synchronous \`runScript(source, bars, opts)\`
`,
);

const rowsMd = (rows) =>
  rows.map((r) => `- \`${r[0].replace(/\n/g, ' ')}\` — ${r[1]}`).join('\n');
const stepMd = (b) => (b.p ? b.p : '```\n' + b.code.trimEnd() + '\n```');
writeFileSync(
  join(out, 'llms-full.txt'),
  `# theta-script — full documentation

> ${TAGLINE}

This file concatenates the complete documentation of record for LLM
ingestion. Canonical HTML: ${SITE} · Repository: ${REPO} · npm: ${NPM}

# Tutorial

${GETTING_STARTED.map((s) => `## ${s.title}\n\n${s.body.map(stepMd).join('\n\n')}`).join('\n\n')}

# Language reference

${HELP_SECTIONS.map((s) => `## ${s.title}\n\n${rowsMd(s.rows)}`).join('\n\n')}

# Examples

${EXAMPLES.map((e) => `## ${e.name}\n\n${e.blurb}\n\n\`\`\`\n${e.source.trimEnd()}\n\`\`\``).join('\n\n')}

${specMd.trimEnd()}

${confMd.trimEnd()}
`,
);
console.log('wrote robots.txt, sitemap.xml, llms.txt, llms-full.txt');

writeFileSync(join(out, '.nojekyll'), '');
console.log('wrote .nojekyll');
