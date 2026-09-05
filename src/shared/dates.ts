/** Calendar-date arithmetic, with no join or SIMKL semantics. */

/**
 * An ISO instant, or null when the value is not one.
 *
 * Nullable rather than throwing: most values come from upstream — thousands
 * of calendar entries, a possibly hand-edited history file — and one bad
 * field must cost that entry, not the whole render.
 *
 * Strict where `Date.parse` is not: `Date.parse` accepts `'2026'`, `'March
 * 5'` and `'Dec 25 1995'`, turning a non-instant into a plausible one;
 * `Temporal.Instant.from` accepts ISO 8601 and nothing else.
 *
 * The one repair is SIMKL's: it occasionally emits `2026-08-14 21:03:12Z`
 * with a space where the `T` belongs. Rejecting that would drop real watch
 * history.
 *
 * A zone is required: a zone-less value is refused rather than read as local
 * time, which for a watch timestamp would mean an episode uncounted and a
 * lower number in the sheet. Measured across a live library — 10244 watch
 * timestamps, all `YYYY-MM-DDTHH:MM:SSZ`, none zone-less, none
 * space-separated — so the repair and the strictness are both guards, not
 * routine paths.
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
 * A date that does not exist — `2026-02-30`, `2026-13-01` — throws rather
 * than shifting onto a real one: a shifted event announces a day nobody
 * published, which is worse than a skipped one. That strictness comes from
 * the ISO grammar, not an `overflow` option — `overflow` governs property
 * bags and would be inert here.
 *
 * Unpadded input (`2026-8-1`) is also refused — a guard against a new
 * caller; everything here feeds it padded output.
 */
export const plainDateFrom = (ymd: string): Temporal.PlainDate => Temporal.PlainDate.from(ymd);

/**
 * The calendar date an instant falls on, in a given IANA zone.
 *
 * The highest-risk conversion in the project, made total by requiring the
 * zone: `2026-08-14T02:30:00Z` is the 13th in New York, which is why
 * `iso.slice(0, 10)` is wrong for any US evening broadcast.
 *
 * No cache because it constructs no formatter. Over a real 4377-entry
 * `tv.json` in `America/New_York`, parse-and-convert costs 0.79 µs an entry
 * against 0.85 µs for a memoised `Intl.DateTimeFormat` — and 29 µs for an
 * unmemoised one, the trap a formatter-based version has to keep dodging.
 */
export const plainDateIn = (at: Temporal.Instant, timeZone: string): Temporal.PlainDate =>
  at.toZonedDateTimeISO(timeZone).toPlainDate();

/**
 * Film release dates arrive from /movies/{id} already as plain YYYY-MM-DD in
 * the viewer's country — no instant to convert, no timezone to apply. The
 * slice guards against a full ISO timestamp sneaking through.
 *
 * Nullable for the same reason `instantFrom` is: TMDB-derived records really
 * carry partial dates like `2013-00-00`. Throwing would escape the per-title
 * lookup, be classified transient, and leave that film re-requested on every
 * poll for the life of the process.
 */
export const releaseDate = (value: string): Temporal.PlainDate | null => {
  try {
    return plainDateFrom(value.slice(0, 10));
  } catch {
    return null;
  }
};

/**
 * An instant as the ISO string persisted and published fields carry.
 *
 * One place decides the shape, because it must match across files written at
 * different times: `Instant.toString()` omits a zero fractional part, so a
 * timestamp stamped on the second would be narrower than its neighbours.
 * Pinned milliseconds also match `Date.toISOString()`, so nothing on disk or
 * in the `/healthz` contract changes width.
 */
export const isoOf = (at: Temporal.Instant): string => at.toString({ smallestUnit: 'millisecond' });

/** The current instant, for a field that is reported rather than computed with. */
export const nowIso = (): string => isoOf(Temporal.Now.instant());

/**
 * Age of an ISO timestamp in ms; never-set reads as infinitely old.
 *
 * Shared because both halves ask it of their own clocks, and `null` meaning
 * *infinitely* old rather than zero is easy to get backwards in a second
 * copy.
 */
export const ageOf = (iso: string | null): number => {
  const at = instantFrom(iso);
  // Unusable reads as infinitely old, not fresh: every consumer compares with
  // `>`, so answering zero would claim the thing it stamps is up to date.
  return at === null ? Infinity : Temporal.Now.instant().epochMilliseconds - at.epochMilliseconds;
};

/**
 * Coarse on purpose: two units read at a glance, and `4d 6h 12m 3s` reports
 * precision the timers do not have. `round` splits the units; the only
 * arithmetic left is choosing which two to print. Days and below throughout,
 * so no `relativeTo` anchor is needed and a day is exactly 24 hours.
 */
export const duration = (span: Temporal.Duration): string => {
  const total = span.total('milliseconds');
  if (total <= 0) return '0s';
  const { days, hours, minutes, seconds } = span.round({ largestUnit: 'day', smallestUnit: 'second' });
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
};
