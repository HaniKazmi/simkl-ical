/**
 * FETCH — film release dates, one lookup per title.
 *
 * First of **FETCH** → JOIN → RENDER → SAVE, alongside `calendar.ts`.
 */

import { apiGet } from '../../api/simkl/client.ts';
import { lookupPool } from '../../api/simkl/pool.ts';
import { plainDateIn, releaseDate } from '../../shared/dates.ts';
import { config } from '../../shared/config.ts';
import type { MovieDetail, ReleaseDateResult } from '../../api/simkl/types.ts';

/**
 * A film's resolved release date, as the feed holds it.
 *
 * Built here from `/movies/{id}` rather than sent by SIMKL in this shape, which
 * is why it does not live with the payload types: those are written from live
 * responses, and a field is optional there only because live data made it so.
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
 * TMDB-style release types, as used by SIMKL's `release_dates`.
 * 1 is a premiere screening — often a week or more before anyone can buy a
 * ticket — so it is only ever a last resort.
 */
const RELEASE_TYPE = { PREMIERE: 1, LIMITED: 2, THEATRICAL: 3, DIGITAL: 4, PHYSICAL: 5, TV: 6 } as const;
const PREFERENCE = [RELEASE_TYPE.THEATRICAL, RELEASE_TYPE.LIMITED, RELEASE_TYPE.DIGITAL, RELEASE_TYPE.TV];

/**
 * Consulted only once every territory has been tried at every preferred type.
 * Physical is a date you can act on; a premiere is an invite-only screening,
 * so it stays last.
 */
const LAST_RESORT = [RELEASE_TYPE.PHYSICAL, RELEASE_TYPE.PREMIERE];
const NAMED_TYPES = new Set<number>([...PREFERENCE, ...LAST_RESORT]);

const datesFor = (movie: MovieDetail, country: string): ReleaseDateResult[] =>
  movie.release_dates?.find((c) => c.iso_3166_1 === country)?.results ?? [];

/**
 * The relevant one of several dates for a single release type.
 *
 * A country routinely lists more than one entry per type — an original run and
 * a re-release, a festival showing and a wide opening — and array order carries
 * no meaning. The viewer wants the next date that has not happened yet, or the
 * most recent past one when they all have.
 */
const relevantDate = (results: ReleaseDateResult[], type: number, today: Temporal.PlainDate): Temporal.PlainDate | undefined => {
  const dates = results
    .filter((r) => r.type === type && r.release_date)
    .map((r) => releaseDate(r.release_date))
    .sort(Temporal.PlainDate.compare);
  return dates.find((d) => Temporal.PlainDate.compare(d, today) >= 0) ?? dates.at(-1);
};

export interface PickedRelease {
  date: Temporal.PlainDate;
  type: number | null;
  country: string | null;
}

/**
 * Best release date for a film, in the viewer's country.
 *
 * The top-level `released` field is a last resort only: it runs consistently
 * two days early against every country's real theatrical date.
 */
export const pickReleaseDate = (
  movie: MovieDetail,
  country: string = config.releaseCountry,
  // An option rather than read from config mid-body, matching join — it keeps
  // this a pure function.
  { now = Temporal.Now.instant(), timezone = config.timezone }: { now?: Temporal.Instant; timezone?: string } = {},
): PickedRelease | null => {
  // Uppercased because iso_3166_1 is matched exactly; deduplicated so a US
  // viewer does not walk the identical results twice at every step.
  const codes = [...new Set([country.toUpperCase(), 'US'])];
  const territories = codes.map((code) => ({ code, results: datesFor(movie, code) }));
  // The viewer's local date, not UTC — the same question the join asks.
  const today = plainDateIn(now, timezone);

  // A real release anywhere in the preference order beats a premiere anywhere,
  // so both territories are exhausted before the last resorts are considered.
  for (const types of [PREFERENCE, LAST_RESORT]) {
    for (const territory of territories) {
      for (const type of types) {
        const date = relevantDate(territory.results, type, today);
        if (date) return { date, type, country: territory.code };
      }
    }
  }

  // `type` is a number, not a union, so an unrecognised one is real data we
  // have no name for. Better than falling through to the unreliable `released`.
  for (const territory of territories) {
    const other = territory.results.find((r) => r.release_date && !NAMED_TYPES.has(r.type));
    if (other) return { date: releaseDate(other.release_date), type: other.type ?? null, country: territory.code };
  }

  if (movie.released) return { date: releaseDate(movie.released), type: null, country: null };
  return null;
};

export interface MovieLookups {
  releases: Map<number, MovieRelease>;
  /**
   * Ids whose lookup errored in a way worth retrying. Distinct from an id that
   * resolved with no announced date: an unreleased film is a settled answer,
   * and counting it as a failure would refetch the list on every poll.
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
 * How close a release has to be before its date is worth re-reading.
 *
 * A month is roughly the point at which a studio stops moving a date, so
 * anything further out answers the same thing every day. Not a config knob:
 * this is a fact about how release dates firm up, not an operator preference.
 */
export const FILM_HORIZON_DAYS = 30;

/**
 * Whether one film's release date is worth asking about again.
 *
 * Two questions, in order: has it been asked about recently, and is its date
 * close enough to still move? `refreshMs` is the floor, so a film is never
 * looked up more than once per interval however imminent it is — the poll runs
 * far more often than the dates change. Past that floor, only a film with no
 * known date or one dated inside the horizon is re-read; a date already past
 * counts, since it may have been pushed back. Everything further out waits for
 * the calendar to reach it.
 *
 * `release` absent means resolved with no announced date, which is the one
 * answer worth re-asking whatever the calendar says. `stamp` absent means never
 * asked; a retryable failure leaves the previous stamp unrefreshed, so the film
 * is still past the floor and the next poll asks again.
 *
 * The known hole: a film dated eight months out that is pulled *forward* to
 * next week is not noticed, because only today advances toward the stale date.
 *
 * Pure, and takes its bounds as options with config-backed defaults, so the rule
 * can be exercised at its edges without a populated `Feed`.
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
  // At or before the floor, there is nothing a re-read could learn.
  if (Temporal.Instant.compare(now, stamp.add(refresh)) <= 0) return false;
  if (!release) return true;
  const horizon = plainDateIn(now, timezone).add({ days: horizonDays });
  return Temporal.PlainDate.compare(release.date, horizon) <= 0;
};

/**
 * Fold a round of lookups into what we already had.
 *
 * `ids` is everything on plan-to-watch and decides what survives; `requested` is
 * the subset this round actually asked about. The two are different because a
 * round is deliberately partial — a film dated a year out is not re-read every
 * day — and conflating them drops the cached date of every film that was
 * skipped, which is most of them.
 *
 * So: a film no longer on the list goes. A film that was asked about and came
 * back with no announced date goes, because that is the true answer. A film that
 * was asked about and errored keeps what it had, and so does one that was never
 * asked.
 */
export const reconcileReleases = (
  previous: Map<number, MovieRelease>,
  ids: number[],
  requested: Set<number>,
  { releases: fetched, failed, unavailable }: MovieLookups,
): Reconciled => {
  // Both kinds of error keep what was already known — a cached date beats no
  // date. Only the retryable ones make the round incomplete.
  const errored = new Set([...failed, ...unavailable]);
  const releases = new Map<number, MovieRelease>();
  for (const id of ids) {
    const settled = requested.has(id) && !errored.has(id);
    const release = fetched.get(id) ?? (settled ? undefined : previous.get(id));
    if (release) releases.set(id, release);
  }
  return { releases, complete: failed.length === 0 };
};

/**
 * Detail lookups need no token — client_id is enough, and they are CDN-cached by
 * id. No `extended` either: this endpoint always returns the whole record, and
 * the parameter is accepted for compatibility while changing nothing.
 */
const fetchMovie = (id: number, { signal }: { signal?: AbortSignal } = {}): Promise<MovieDetail> =>
  apiGet<MovieDetail>(`/movies/${id}`, { component: 'films', signal });

/**
 * Release dates for a set of film ids, keyed by id.
 *
 * The CDN movie calendar covers only a rolling 33-day window, so a film six
 * months out never appears in it; per-title lookups sidestep that. Cloudflare
 * caches them by id, so modest parallelism is allowed.
 */
export const fetchMovieReleases = async (
  ids: number[],
  { signal, concurrency = 4 }: { signal?: AbortSignal; concurrency?: number } = {},
): Promise<MovieLookups> => {
  const out = new Map<number, MovieRelease>();

  const { failed, unavailable } = await lookupPool(
    [...new Set(ids)],
    (id) => id,
    async (id) => {
      const movie = await fetchMovie(id, { signal });
      const release = pickReleaseDate(movie);
      // No announced date is an answer, not a failure.
      if (!release) return;
      out.set(id, {
        simkl_id: id,
        title: movie.title,
        date: release.date,
        releaseType: release.type,
        runtime: movie.runtime ? `${movie.runtime}m` : null,
        url: `https://simkl.com/movies/${id}`,
      });
    },
    { concurrency },
  );

  return { releases: out, failed, unavailable };
};
