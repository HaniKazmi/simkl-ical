/** Calendar-date arithmetic, with no join or SIMKL semantics. */

/**
 * An ISO instant, or null when the value is not one.
 *
 * Nullable rather than throwing because most of these come from upstream: a
 * payload of several thousand calendar entries, or a history file that may have
 * been hand-edited. One bad field must cost that entry, not the whole render.
 *
 * Strict where `Date.parse` is not, which is the point of routing everything
 * through here. `Date.parse` accepts `'2026'`, `'March 5'` and `'Dec 25 1995'`,
 * so a value that is not an instant at all becomes a plausible-looking one;
 * `Temporal.Instant.from` accepts ISO 8601 and nothing else.
 *
 * The one repair is SIMKL's: it occasionally emits `2026-08-14 21:03:12Z` with a
 * space where the `T` belongs. That is a known upstream quirk rather than a
 * malformed value, and rejecting it would drop real watch history.
 */
export const instantFrom = (raw: string | null | undefined): Temporal.Instant | null => {
  if (typeof raw !== 'string') return null;
  const iso = raw.trim().replace(' ', 'T');
  if (!iso) return null;
  try {
    return Temporal.Instant.from(iso);
  } catch {
    return null;
  }
};

/**
 * A calendar date from `YYYY-MM-DD`, throwing on anything else.
 *
 * A date that does not exist — `2026-02-30`, `2026-13-01` — throws rather than
 * being shifted onto a real one, which matters because a shifted event is worse
 * than a skipped one: it announces a day nobody published. That comes from the
 * ISO grammar, not from an `overflow` option; `overflow` governs property bags
 * like `{ year, month, day }`, and passing it here would be inert.
 *
 * Unpadded input (`2026-8-1`) is also refused. Every caller is fed padded output
 * from this codebase, so that is a guard against a new caller rather than a
 * shape anything currently sends.
 */
export const plainDateFrom = (ymd: string): Temporal.PlainDate => Temporal.PlainDate.from(ymd);

/**
 * The calendar date an instant falls on, in a given IANA zone.
 *
 * The highest-risk conversion in the project, and now a total function: naming
 * the zone is what makes it well-defined, and `Instant` cannot be turned into a
 * `PlainDate` without one. `2026-08-14T02:30:00Z` is the 13th in New York, which
 * is why `iso.slice(0, 10)` is wrong for any US evening broadcast.
 */
export const plainDateIn = (at: Temporal.Instant, timeZone: string): Temporal.PlainDate =>
  at.toZonedDateTimeISO(timeZone).toPlainDate();

/**
 * Film release dates arrive from /movies/{id} already as plain YYYY-MM-DD in
 * the viewer's country, so there is no instant to convert and no timezone to
 * apply. The slice only guards against a full ISO timestamp sneaking through;
 * keeping it states that intent rather than leaning on the parser to reject the
 * rest of the string.
 */
export const releaseDate = (value: string): Temporal.PlainDate => plainDateFrom(value.slice(0, 10));

/**
 * Age of an ISO timestamp in ms; never-set reads as infinitely old.
 *
 * Shared because both halves ask it of their own clocks — health of the poll
 * and the last render, the feed of when film dates were last resolved. A second
 * copy is the kind that drifts silently, since `null` meaning *infinitely* old
 * rather than zero is the whole point and is easy to get backwards.
 */
export const ageOf = (iso: string | null): number => {
  const at = instantFrom(iso);
  // Unusable reads as infinitely old, not as fresh. Every consumer compares
  // with `>`, so a timestamp that answered zero would silently claim the thing
  // it stamps is up to date.
  return at === null ? Infinity : Date.now() - at.epochMilliseconds;
};
