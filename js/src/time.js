// Timezone-explicit time core for the scripting language. Every calendar
// semantic — timestamp parsing, year()/hour()/… extraction, session anchors —
// is defined against a single IANA zone (the session timezone), never the
// host's local clock, so a script produces identical results in a browser, a
// test runner, and a backend running in UTC.

export const DEFAULT_TIMEZONE = 'America/New_York';

// 'local' resolves to the host zone (the chart's "local" display setting);
// null/undefined falls back to the default exchange zone
export const resolveTimezone = (tz) => {
  if (!tz) return DEFAULT_TIMEZONE;
  if (tz === 'local') return Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz;
};

const fmtCache = new Map();
const fmtFor = (tz) => {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: false,
    });
    fmtCache.set(tz, f);
  }
  return f;
};

// UTC offset of `tz` at instant `ms`, cached per 15-minute bucket: offsets
// only change at DST transitions, which land on wall-clock hour boundaries,
// so a 15-minute grain is safe even for :30/:45-offset zones. The cache makes
// per-bar calendar extraction one Intl call per bucket instead of per bar.
const offsetCache = new Map();
const OFFSET_CACHE_MAX = 50000;
const tzOffset = (ms, tz) => {
  const key = `${tz}:${Math.floor(ms / 900000)}`;
  let off = offsetCache.get(key);
  if (off === undefined) {
    const parts = fmtFor(tz).formatToParts(ms);
    const get = (t) => +parts.find(p => p.type === t).value;
    const h = get('hour'); // some engines report midnight as 24
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), h === 24 ? 0 : h, get('minute'));
    off = wall - Math.floor(ms / 60000) * 60000; // Intl parts are minute-precision
    if (offsetCache.size >= OFFSET_CACHE_MAX) offsetCache.delete(offsetCache.keys().next().value);
    offsetCache.set(key, off);
  }
  return off;
};

// the instant shifted so getUTC* methods read `tz`'s wall clock
export const wallDate = (ms, tz) => new Date(ms + tzOffset(ms, tz));

// instant (ms epoch) of wall-clock y-mo-d h:mi in `tz`. Two-pass offset
// refinement handles DST: the first guess reads the offset at the naive UTC
// interpretation, the second re-reads it at the guessed instant.
export const epochFromWall = (y, mo, d, h, mi, tz) => {
  // every component must be finite — a NaN month would reach
  // formatToParts(NaN) inside tzOffset and throw instead of reading as na
  if (!(isFinite(y) && isFinite(mo) && isFinite(d) && isFinite(h) && isFinite(mi))) return NaN;
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let t = wall - tzOffset(wall, tz);
  t = wall - tzOffset(t, tz);
  return t;
};

// "2026-01-01 09:30" / "2026-01-01T09:30[:ss]" / "2026-01-01" -> ms epoch in
// `tz` (date-only strings mean midnight). Anything else is NaN, so scripts
// can treat "no date" via na(). Shared by timestamp() and input.time().
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
export const parseTimestamp = (v, tz) => {
  if (typeof v !== 'string') return NaN;
  const m = TS_RE.exec(v.trim());
  if (!m) return NaN;
  const t = epochFromWall(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), resolveTimezone(tz));
  return t + (m[6] ? +m[6] * 1000 : 0);
};
