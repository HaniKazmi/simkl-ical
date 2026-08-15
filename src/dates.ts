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
 * Local calendar date (YYYY-MM-DD) for an instant, in a given IANA zone.
 *
 * The highest-risk conversion in the project: `iso.slice(0, 10)` is wrong for
 * any US evening broadcast, which is stamped the following day in UTC.
 */
export const localDate = (iso: string, timeZone: string): string => formatterFor(timeZone).format(new Date(iso));

/**
 * Film release dates arrive from /movies/{id} already as plain YYYY-MM-DD in
 * the viewer's country, so there is no instant to convert and no timezone to
 * apply. This only guards against a full ISO timestamp sneaking through.
 */
export const releaseDate = (value: string): string => value.slice(0, 10);

/**
 * Shift a YYYY-MM-DD date by whole days. Arithmetic is done at UTC noon so a
 * DST transition can never push the result onto the neighbouring day.
 */
export const shiftDate = (ymd: string, days: number): string => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d, 12));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
};
