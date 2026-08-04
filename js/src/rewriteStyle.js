// Write style edits from the study editor back into a script's source, using
// the literal spans runScript records on each plot (colorSpan/widthSpan).
// Plots whose color/width is a computed expression (or absent) have no span
// and keep using the per-script overrides instead.

// new color for one plot: splice the quoted literal when the source has one.
// Returns { source, rewritten } — rewritten=false means "use the override".
export const rewritePlotColor = (source, plot, color) => {
  if (!plot || !plot.colorSpan) return { source, rewritten: false };
  const [s, e] = plot.colorSpan;
  return { source: `${source.slice(0, s)}"${color}"${source.slice(e)}`, rewritten: true };
};

// new width for every plot that declares one in source. Splices run right to
// left so earlier spans stay valid. Returns { source, allRewritten } —
// allRewritten=true means no plot needs the shared width override.
export const rewritePlotWidths = (source, plots, width) => {
  const spans = plots
    .map(pl => pl.widthSpan)
    .filter(Boolean)
    .sort((a, b) => b[0] - a[0]);
  let out = source;
  spans.forEach(([s, e]) => {
    out = `${out.slice(0, s)}${width}${out.slice(e)}`;
  });
  return { source: out, allRewritten: spans.length === plots.length && plots.length > 0 };
};
