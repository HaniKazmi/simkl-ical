/**
 * FILMS — every rule about film release dates. Pure.
 *
 * First of FILMS → JOIN → RENDER: which of a film's dates counts, when one is
 * worth re-reading, and how a round of lookups folds into what is held. The
 * fetch is `io/movies.ts`.
 */

import { plainDateIn, releaseDate } from '../shared/dates.ts';
import { config } from '../shared/config.ts';
import type { MovieDetail, ReleaseDateResult } from '../api/simkl/types.ts';

/**
 * A film's resolved release date, as the feed holds it. Built here from
 * `/movies/{id}`, not sent by SIMKL in this shape — so it does not live with
 * the payload types, which are written from live responses.
 */
export interface MovieRelease {
  simkl_id: number;
  title: string;
  date: Temporal.PlainDate;
  releaseType: number | null;
  runtime: string | null;
  url: string;
}

/**
 * TMDB-style release types, as used by SIMKL's `release_dates`. 1 is a
 * premiere screening, often a week or more before tickets exist, so it is
 * only ever a last resort.
 */
const RELEASE_TYPE = { PREMIERE: 1, LIMITED: 2, THEATRICAL: 3, DIGITAL: 4, PHYSICAL: 5, TV: 6 } as const;
const PREFERENCE = [RELEASE_TYPE.THEATRICAL, RELEASE_TYPE.LIMITED, RELEASE_TYPE.DIGITAL, RELEASE_TYPE.TV];

/**
 * Tried only after every territory fails at every preferred type. Physical is
 * a date you can act on; a premiere is invite-only, so it stays last.
 */
const LAST_RESORT = [RELEASE_TYPE.PHYSICAL, RELEASE_TYPE.PREMIERE];
const NAMED_TYPES = new Set<number>([...PREFERENCE, ...LAST_RESORT]);

const datesFor = (movie: MovieDetail, country: string): ReleaseDateResult[] =>
  movie.release_dates?.find((c) => c.iso_3166_1 === country)?.results ?? [];

/**
 * The relevant one of several dates for a release type. A country routinely
 * lists more than one entry per type — an original run and a re-release — and
 * array order carries no meaning. Take the next date not yet passed, or the
 * most recent past one when they all have.
 */
const relevantDate = (results: ReleaseDateResult[], type: number, today: Temporal.PlainDate): Temporal.PlainDate | undefined => {
  const dates = results
    .filter((r) => r.type === type && r.release_date)
    .map((r) => releaseDate(r.release_date))
    .filter((d): d is Temporal.PlainDate => d !== null)
    .sort(Temporal.PlainDate.compare);
  return dates.find((d) => Temporal.PlainDate.compare(d, today) >= 0) ?? dates.at(-1);
};

export interface PickedRelease {
  date: Temporal.PlainDate;
  type: number | null;
  country: string | null;
}

/**
 * Best release date for a film, in the viewer's country. The top-level
 * `released` field is a last resort: it runs consistently two days early
 * against every country's real theatrical date.
 */
export const pickReleaseDate = (
  movie: MovieDetail,
  country: string = config.releaseCountry,
  // Options, not config reads mid-body: keeps this pure, matching join.
  { now = Temporal.Now.instant(), timezone = config.timezone }: { now?: Temporal.Instant; timezone?: string } = {},
): PickedRelease | null => {
  // Uppercased for the exact iso_3166_1 match; deduplicated so a US viewer
  // does not walk identical results twice.
  const codes = [...new Set([country.toUpperCase(), 'US'])];
  const territories = codes.map((code) => ({ code, results: datesFor(movie, code) }));
  // The viewer's local date, not UTC — the same question the join asks.
  const today = plainDateIn(now, timezone);

  // A real release anywhere beats a premiere anywhere, so both territories are
  // exhausted before the last resorts.
  for (const types of [PREFERENCE, LAST_RESORT]) {
    for (const territory of territories) {
      for (const type of types) {
        const date = relevantDate(territory.results, type, today);
        if (date) return { date, type, country: territory.code };
      }
    }
  }

  // `type` is a number, not a union, so an unrecognised one is real data with
  // no name — still better than the unreliable `released`.
  for (const territory of territories) {
    const other = territory.results.find((r) => r.release_date && !NAMED_TYPES.has(r.type));
    if (other) {
      const date = releaseDate(other.release_date);
      if (date) return { date, type: other.type ?? null, country: territory.code };
    }
  }

  if (movie.released) {
    const date = releaseDate(movie.released);
    if (date) return { date, type: null, country: null };
  }
  return null;
};

export interface MovieLookups {
  releases: Map<number, MovieRelease>;
  /**
   * Ids whose lookup errored retryably. Distinct from an id resolved with no
   * announced date: that is a settled answer, and counting it as a failure
   * would refetch the list on every poll.
   */
  failed: number[];
  /**
   * Ids the API says are gone — see classify in simkl/client.ts. Retrying
   * cannot help, so these must not hold the list stale.
   */
  unavailable: number[];
}

export interface Reconciled {
  releases: Map<number, MovieRelease>;
  complete: boolean;
}

/**
 * How close a release must be before its date is worth re-reading. A month is
 * roughly when a studio stops moving a date. Not a config knob: a fact about
 * release dates, not an operator preference.
 */
export const FILM_HORIZON_DAYS = 30;

/**
 * Whether one film's release date is worth asking about again.
 *
 * `refresh` is the floor: a film is never looked up more than once per
 * interval, since the poll runs far more often than dates change. Past the
 * floor, only a film with no known date or one dated inside the horizon is
 * re-read; a past date still counts, since it may have been pushed back.
 *
 * `release` absent means resolved with no announced date — worth re-asking
 * whatever the calendar says. `stamp` absent means never asked; a retryable
 * failure leaves the stamp unrefreshed, so the next poll asks again.
 *
 * The known hole: a film dated eight months out that is pulled *forward* to
 * next week is not noticed, because only today advances toward the stale date.
 *
 * Pure; bounds arrive as options with config-backed defaults.
 */
export const filmDue = (
  stamp: Temporal.Instant | undefined,
  release: MovieRelease | undefined,
  now: Temporal.Instant,
  {
    refresh = config.movieRefresh,
    horizonDays = FILM_HORIZON_DAYS,
    timezone = config.timezone,
  }: { refresh?: Temporal.Duration; horizonDays?: number; timezone?: string } = {},
): boolean => {
  if (stamp === undefined) return true;
  // At or before the floor, a re-read can learn nothing.
  if (Temporal.Instant.compare(now, stamp.add(refresh)) <= 0) return false;
  if (!release) return true;
  const horizon = plainDateIn(now, timezone).add({ days: horizonDays });
  return Temporal.PlainDate.compare(release.date, horizon) <= 0;
};

/**
 * Fold a round of lookups into what was already held.
 *
 * `ids` is everything on plan-to-watch and decides what survives; `requested`
 * is the subset this round asked about. A round is deliberately partial — a
 * film dated a year out is not re-read every day — and conflating the two
 * drops the cached date of every skipped film, which is most of them.
 *
 * A film off the list goes. One asked about that answered with no announced
 * date goes: that is the true answer. One that errored, or was never asked,
 * keeps what it had.
 */
export const reconcileReleases = (
  previous: Map<number, MovieRelease>,
  ids: number[],
  requested: Set<number>,
  { releases: fetched, failed, unavailable }: MovieLookups,
): Reconciled => {
  // Both error kinds keep the cached date — better than no date. Only the
  // retryable ones make the round incomplete.
  const errored = new Set([...failed, ...unavailable]);
  const releases = new Map<number, MovieRelease>();
  for (const id of ids) {
    const settled = requested.has(id) && !errored.has(id);
    const release = fetched.get(id) ?? (settled ? undefined : previous.get(id));
    if (release) releases.set(id, release);
  }
  return { releases, complete: failed.length === 0 };
};
