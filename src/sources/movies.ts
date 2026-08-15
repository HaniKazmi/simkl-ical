import { apiGet, classify } from '../simkl/client.ts';
import { localDate, releaseDate } from '../dates.ts';
import { config } from '../config.ts';
import type { MovieDetail, MovieRelease, ReleaseDateResult } from '../simkl/types.ts';

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
const relevantDate = (results: ReleaseDateResult[], type: number, today: string): string | undefined => {
  const dates = results
    .filter((r) => r.type === type && r.release_date)
    .map((r) => releaseDate(r.release_date))
    .sort();
  return dates.find((d) => d >= today) ?? dates.at(-1);
};

export interface PickedRelease {
  date: string;
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
  { now = new Date(), timezone = config.timezone }: { now?: Date; timezone?: string } = {},
): PickedRelease | null => {
  // Uppercased because iso_3166_1 is matched exactly; deduplicated so a US
  // viewer does not walk the identical results twice at every step.
  const codes = [...new Set([country.toUpperCase(), 'US'])];
  const territories = codes.map((code) => ({ code, results: datesFor(movie, code) }));
  // The viewer's local date, not UTC — the same question the join asks.
  const today = localDate(now.toISOString(), timezone);

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
 * Fold a round of lookups into what we already had.
 *
 * Films no longer on the list are dropped. An id whose lookup errored keeps its
 * previous value rather than vanishing; an id that simply has no announced date
 * is allowed to disappear, because that is the true answer.
 */
export const reconcileReleases = (
  previous: Map<number, MovieRelease>,
  ids: number[],
  { releases: fetched, failed, unavailable }: MovieLookups,
): Reconciled => {
  // Both kinds of error keep what was already known — a cached date beats no
  // date. Only the retryable ones make the round incomplete.
  const keepPrevious = new Set([...failed, ...unavailable]);
  const releases = new Map<number, MovieRelease>();
  for (const id of ids) {
    const release = fetched.get(id) ?? (keepPrevious.has(id) ? previous.get(id) : undefined);
    if (release) releases.set(id, release);
  }
  return { releases, complete: failed.length === 0 };
};

/** Detail lookups need no token — client_id is enough, and they are CDN-cached by id. */
const fetchMovie = (id: number, { signal }: { signal?: AbortSignal } = {}): Promise<MovieDetail> =>
  apiGet<MovieDetail>(`/movies/${id}`, { params: { extended: 'full' }, signal });

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
  const failed: number[] = [];
  const unavailable: number[] = [];
  const queue = [...new Set(ids)];

  const worker = async (): Promise<void> => {
    while (queue.length) {
      const id = queue.shift();
      if (id === undefined) return;
      try {
        const movie = await fetchMovie(id, { signal });
        const release = pickReleaseDate(movie);
        // No announced date is an answer, not a failure.
        if (!release) continue;
        out.set(id, {
          simkl_id: id,
          title: movie.title,
          date: release.date,
          releaseType: release.type,
          runtime: movie.runtime ? `${movie.runtime}m` : null,
          url: `https://simkl.com/movies/${id}`,
        });
      } catch (err) {
        // One unavailable film must not sink the refresh, but an account-level
        // problem is not a fact about this film and must not be filed as one.
        const kind = classify(err);
        if (kind === 'account') throw err;
        (kind === 'gone' ? unavailable : failed).push(id);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { releases: out, failed, unavailable };
};
