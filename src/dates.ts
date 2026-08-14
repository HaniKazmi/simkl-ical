/**
 * Calendar-date arithmetic, with no join or SIMKL semantics.
 *
 * These lived in join.ts, which meant sources/movies.ts had to import the whole
 * join — config, presentation strings, the event constructor — to get one date
 * helper, and made the dependency between the domain module and sources/ point
 * both ways.
 */

/**
 * Constructing an Intl.DateTimeFormat is ~20x the cost of using one (33.6µs
 * against 1.65µs, measured), and localDate is called once per calendar entry
 * that matched the library. The zone has to stay a parameter — join takes it as
 * an option and tests vary it — so the formatters are memoised per zone. There
 * is one per IANA zone the process ever sees, which in practice is one.
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
 * This is the highest-risk conversion in the project. `iso.slice(0, 10)` is
 * wrong for any show airing in the US evening: a 9pm Tuesday ET broadcast is
 * stamped 01:00Z Wednesday, and naive slicing would put it on the wrong day.
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
