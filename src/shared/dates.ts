/** Calendar-date arithmetic, with no join or SIMKL semantics. */

/**
 * Constructing an Intl.DateTimeFormat costs ~20x using one (33.6µs against
 * 1.65µs), and localDate runs once per matched calendar entry. The zone stays a
 * parameter, so formatters are memoised per zone — in practice, one.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // 'en-CA' is used because it formats as YYYY-MM-DD.
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

/**
 * Local calendar date (YYYY-MM-DD) for an instant, in a given IANA zone, or
 * null when the instant is not one.
 *
 * The highest-risk conversion in the project: `iso.slice(0, 10)` is wrong for
 * any US evening broadcast, which is stamped the following day in UTC.
 *
 * Nullable rather than throwing because the instants come from an upstream
 * feed of several thousand entries: `Intl.DateTimeFormat.format` raises a
 * `RangeError` on an Invalid Date rather than returning anything a NaN check
 * would catch, so one malformed `date` field anywhere in a CDN payload would
 * otherwise abort a whole render. Callers holding a value they generated
 * themselves can assert; callers reading upstream data must skip the entry.
 */
export const localDate = (iso: string | Date, timeZone: string): string | null => {
  const at = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return formatterFor(timeZone).format(at);
};

/**
 * Film release dates arrive from /movies/{id} already as plain YYYY-MM-DD in
 * the viewer's country, so there is no instant to convert and no timezone to
 * apply. This only guards against a full ISO timestamp sneaking through.
 */
export const releaseDate = (value: string): string => value.slice(0, 10);

export const MS_PER_DAY = 86_400_000;

/**
 * Age of an ISO timestamp in ms; never-set reads as infinitely old.
 *
 * Shared because both halves ask it of their own clocks — health of the poll
 * and the last render, the feed of when film dates were last resolved. A second
 * copy is the kind that drifts silently, since `null` meaning *infinitely* old
 * rather than zero is the whole point and is easy to get backwards.
 */
export const ageOf = (iso: string | null): number => {
  if (!iso) return Infinity;
  const at = Date.parse(iso);
  // Unparseable reads as infinitely old, not as fresh. Every consumer compares
  // with `>`, and NaN is false against everything — so a bad timestamp would
  // silently claim the thing it stamps is up to date.
  return Number.isNaN(at) ? Infinity : Date.now() - at;
};

/**
 * Shift a YYYY-MM-DD date by whole days. Arithmetic is done at UTC noon so a
 * DST transition can never push the result onto the neighbouring day.
 */
export const shiftDate = (ymd: string, days: number): string => {
  const [y, m, d] = parseYmd(ymd);
  const shifted = new Date(Date.UTC(y, m - 1, d, 12));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
};

/**
 * The three numbers of a YYYY-MM-DD date.
 *
 * One copy because four callers wrote the same `split('-').map(Number)` with
 * the same unchecked cast, and a cast is not a check: a malformed value yields
 * `NaN`s that flow into `Date.UTC` and surface much later as an Invalid Date.
 * Throwing here names the value instead.
 */
export const parseYmd = (ymd: string): [number, number, number] => {
  const parts = ymd.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new RangeError(`not a YYYY-MM-DD date: ${ymd}`);
  }
  return parts as [number, number, number];
};

/**
 * `localDate` for an instant the caller produced rather than read.
 *
 * Throwing is right here: a clock or a configured zone that will not format is
 * a fault in this process, not upstream data to be skipped, and the render is
 * already wrapped so it degrades the feed rather than the process.
 */
export const localDateOf = (at: Date, timeZone: string): string => {
  const date = localDate(at, timeZone);
  if (date === null) throw new RangeError(`cannot format ${String(at)} in ${timeZone}`);
  return date;
};
