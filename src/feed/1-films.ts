/**
 * FILMS — every rule about film release dates. Pure.
 *
 * First of FILMS → JOIN → RENDER: which of a film's dates count, when one is
 * worth re-reading, and how a round of lookups folds into what is held. The
 * fetch is `io/movies.ts`.
 */

import { plainDateIn, releaseDate } from '../shared/dates.ts';
import { config } from '../shared/config.ts';
import type { MovieDetail, ReleaseDateResult } from '../api/simkl/types.ts';

/**
 * Which of a film's two lives a date belongs to. It keys the event's UID, so
 * the two strings are load-bearing: renaming one makes every subscribed
 * client drop that event and re-add it.
 */
export type ReleaseStage = 'cinema' | 'home';

/** One date a film has, and where it came from. */
export interface PickedRelease {
  date: Temporal.PlainDate;
  type: number | null;
  country: string | null;
  /**
   * Decided by the pick, never re-derived from `type`: the fallbacks below
   * answer with a type that names no stage, and `released` with no type at
   * all.
   */
  stage: ReleaseStage;
}

/**
 * A film's resolved release dates, as the feed holds it. Built here from
 * `/movies/{id}`, not sent by SIMKL in this shape — so it does not live with
 * the payload types, which are written from live responses.
 */
export interface MovieRelease {
  simkl_id: number;
  title: string;
  runtime: string | null;
  url: string;
  /**
   * Ascending, at most one per stage, and never empty: a film SIMKL has no
   * date for is not held at all, which is what `reconcileReleases` reads as a
   * settled answer rather than a failed lookup.
   */
  dates: PickedRelease[];
}

/**
 * TMDB-style release types, as used by SIMKL's `release_dates`. 1 is a
 * premiere screening, often a week or more before tickets exist, so it is
 * only ever a last resort.
 */
const RELEASE_TYPE = { PREMIERE: 1, LIMITED: 2, THEATRICAL: 3, DIGITAL: 4, PHYSICAL: 5, TV: 6 } as const;

/**
 * The two stages, each in its own preference order and each resolved
 * independently, which is what lets a film have two dates.
 *
 * One list would answer with the theatrical date for anything that has played
 * a cinema — `relevantDate` falls back to the most recent past date — and the
 * digital date would then be unreachable for exactly the films where it is
 * the only date left to act on. Plan-to-watch is mostly films already missed,
 * so that is most of the list.
 */
const CINEMA = [RELEASE_TYPE.THEATRICAL, RELEASE_TYPE.LIMITED];
const HOME = [RELEASE_TYPE.DIGITAL, RELEASE_TYPE.TV];

/**
 * Tried only when neither stage answered, so a film reaching these has
 * exactly one date and the two stages cannot collide. Physical is a date you
 * can act on; a premiere is invite-only, so it stays last.
 */
const LAST_RESORT: ReadonlyArray<readonly [number, ReleaseStage]> = [
  [RELEASE_TYPE.PHYSICAL, 'home'],
  [RELEASE_TYPE.PREMIERE, 'cinema'],
];
const NAMED_TYPES = new Set<number>([...CINEMA, ...HOME, ...LAST_RESORT.map(([type]) => type)]);

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

/**
 * Every date a film has that is worth an event, ascending: its cinema date,
 * its home date, or one fallback when it has neither.
 *
 * The top-level `released` field is the last resort of all: it runs
 * consistently two days early against every country's real theatrical date.
 */
export const pickReleases = (
  movie: MovieDetail,
  country: string = config.releaseCountry,
  // Options, not config reads mid-body: keeps this pure, matching join.
  { now = Temporal.Now.instant(), timezone = config.timezone }: { now?: Temporal.Instant; timezone?: string } = {},
): PickedRelease[] => {
  // Uppercased for the exact iso_3166_1 match; deduplicated so a US viewer
  // does not walk identical results twice.
  const codes = [...new Set([country.toUpperCase(), 'US'])];
  const territories = codes.map((code) => ({ code, results: datesFor(movie, code) }));
  // The viewer's local date, not UTC — the same question the join asks.
  const today = plainDateIn(now, timezone);

  // Territory outside type: the viewer's own country answers with whatever it
  // has before another territory is asked at all.
  const pickStage = (types: readonly number[], stage: ReleaseStage): PickedRelease | null => {
    for (const territory of territories) {
      for (const type of types) {
        const date = relevantDate(territory.results, type, today);
        if (date) return { date, type, country: territory.code, stage };
      }
    }
    return null;
  };

  const cinema = pickStage(CINEMA, 'cinema');
  const home = pickStage(HOME, 'home');
  // A day-and-date release lists the same day under both stages. Two rows on
  // one day for one film say less than one, so the cinema date carries it.
  if (cinema && home && cinema.date.equals(home.date)) return [cinema];
  if (cinema || home) {
    return [cinema, home].filter((r): r is PickedRelease => r !== null).sort((a, b) => Temporal.PlainDate.compare(a.date, b.date));
  }

  // A real release anywhere beats a premiere anywhere, so both territories are
  // exhausted at both stages before these are tried.
  for (const territory of territories) {
    for (const [type, stage] of LAST_RESORT) {
      const date = relevantDate(territory.results, type, today);
      if (date) return [{ date, type, country: territory.code, stage }];
    }
  }

  // `type` is a number, not a union, so an unrecognised one is real data with
  // no name — still better than the unreliable `released`. It names no stage
  // either, and a film here has one date, so `cinema` is the whole answer:
  // "when does this film exist", which is the question a lone date answers.
  for (const territory of territories) {
    const other = territory.results.find((r) => r.release_date && !NAMED_TYPES.has(r.type));
    if (other) {
      const date = releaseDate(other.release_date);
      if (date) return [{ date, type: other.type ?? null, country: territory.code, stage: 'cinema' }];
    }
  }

  if (movie.released) {
    const date = releaseDate(movie.released);
    if (date) return [{ date, type: null, country: null, stage: 'cinema' }];
  }
  return [];
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
 * The *earliest* of a film's dates is the one measured, so a film whose
 * cinema date has passed stays due at the floor — which is exactly the film
 * whose home date is still unannounced or still moving, and the reason that
 * date appears the day SIMKL learns it.
 *
 * No dates at all means resolved with none announced — worth re-asking
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
  const earliest = release?.dates[0];
  if (!earliest) return true;
  const horizon = plainDateIn(now, timezone).add({ days: horizonDays });
  return Temporal.PlainDate.compare(earliest.date, horizon) <= 0;
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
