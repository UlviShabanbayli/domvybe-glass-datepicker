// Calendar arithmetic on whole "day numbers" (days since 1970-01-01, UTC based) so DST never shifts a date.
export const DAY = 86400000;
export const dn = (y, m, d) => Math.round(Date.UTC(y, m, d) / DAY);
export const ymd = (n) => { const t = new Date(n * DAY); return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() }; };
export const dow = (n) => ((n + 4) % 7 + 7) % 7;                 // 0 = Sunday (1970-01-01 was a Thursday)
export const mIndex = (y, m) => y * 12 + m;                        // month index
export const mOf = (n) => { const { y, m } = ymd(n); return mIndex(y, m); };
export const ym = (mi) => ({ y: Math.floor(mi / 12), m: ((mi % 12) + 12) % 12 });
export const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
export const today = () => { const t = new Date(); return dn(t.getFullYear(), t.getMonth(), t.getDate()); };

// the 7-column grid of one month: lead blanks, day count, rows (4–6)
export function monthGrid(mi) {
  const { y, m } = ym(mi);
  const first = dn(y, m, 1), lead = dow(first), days = daysIn(y, m);
  return { mi, y, m, first, lead, days, rows: Math.ceil((lead + days) / 7), last: first + days - 1 };
}
// cell index (0..41) of a date inside a month grid, or -1
export const cellOf = (g, n) => (n < g.first || n > g.last ? -1 : g.lead + (n - g.first));

// move by whole months keeping the day (clamped to the month's length)
export function addMonths(n, k) {
  const { y, m, d } = ymd(n);
  const t = mIndex(y, m) + k, { y: y2, m: m2 } = ym(t);
  return dn(y2, m2, Math.min(d, daysIn(y2, m2)));
}

const L = 'en-US';
const fMonth = new Intl.DateTimeFormat(L, { month: 'long', timeZone: 'UTC' });
const fShort = new Intl.DateTimeFormat(L, { month: 'short', timeZone: 'UTC' });
const fLong = new Intl.DateTimeFormat(L, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fWd = new Intl.DateTimeFormat(L, { weekday: 'short', timeZone: 'UTC' });
const fWdL = new Intl.DateTimeFormat(L, { weekday: 'long', timeZone: 'UTC' });
const at = (n) => new Date(n * DAY);
export const monthName = (mi) => { const { y, m } = ym(mi); return fMonth.format(at(dn(y, m, 1))); };
export const longDate = (n) => fLong.format(at(n));
export const iso = (n) => { const { y, m, d } = ymd(n); return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };
export const fromIso = (s) => { const r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return r ? dn(+r[1], +r[2] - 1, +r[3]) : null; };
// Sunday-first weekday labels
export const WEEKDAYS = [...Array(7)].map((_, i) => ({ short: fWd.format(at(3 + i)), long: fWdL.format(at(3 + i)) })); // 1970-01-04 is a Sunday

// "Oct 14 – 21", "Oct 28 – Nov 3", "Dec 28, 2026 – Jan 3, 2027"
export function rangeLabel(a, b) {
  const A = ymd(a), B = ymd(b), ma = fShort.format(at(a)), mb = fShort.format(at(b));
  if (a === b) return `${ma} ${A.d}`;
  if (A.y !== B.y) return `${ma} ${A.d}, ${A.y} – ${mb} ${B.d}, ${B.y}`;
  if (A.m !== B.m) return `${ma} ${A.d} – ${mb} ${B.d}`;
  return `${ma} ${A.d} – ${B.d}`;
}
