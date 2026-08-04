// JSON wire encoding for corpus fixtures (SPEC.md §"Wire encoding"): JSON has
// no NaN, Infinity or -0, so numbers are mapped NaN -> null,
// Infinity -> "Infinity", -Infinity -> "-Infinity", -0 -> 0. Conformance
// comparison happens in this encoded space — implementations encode their own
// result the same way and diff the trees — so no decoder is needed and the
// null/NaN and string/"Infinity" ambiguities never bite.
export const encode = (v) => {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return null;
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    return v === 0 ? 0 : v; // normalize -0
  }
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') {
    const out = {};
    // undefined-valued keys are omitted (this is explicit wire format, not a
    // JSON.stringify accident — input records leave absent minval/maxval/step
    // undefined and ports simply never emit those keys)
    Object.keys(v).forEach(k => {
      if (v[k] !== undefined) out[k] = encode(v[k]);
    });
    return out;
  }
  // …while an undefined array element encodes as null, explicitly
  return v === undefined ? null : v; // strings, booleans, null
};
