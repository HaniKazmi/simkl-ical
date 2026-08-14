import { apiGet, SimklAuthError, SimklError } from '../simkl/client.ts';
import { localDate } from '../join.ts';
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
 *
 * This used to be `results.find(r => r.release_date)` — the first entry of any
 * remaining type — so whether a viewer saw a premiere or a DVD date came down
 * to the order the API happened to return. Physical is a date you can act on;
 * a premiere is an invite-only screening, so it stays last.
 */
const LAST_RESORT = [RELEASE_TYPE.PHYSICAL, RELEASE_TYPE.PREMIERE];

/**
 * Statuses meaning this film id will never resolve, however often we ask —
 * typically a title merged into another id or deleted upstream. Deliberately
 * narrow: anything not listed here is treated as transient, because filing a
 * temporary problem as permanent drops the film for a whole day.
 */
const GONE = new Set([404, 410]);

const datesFor = (movie: MovieDetail, country: string): ReleaseDateResult[] =>
  movie.release_dates?.find((c) => c.iso_3166_1 === country)?.results ?? [];

/**
 * The relevant one of several dates for a single release type.
 *
 * A country routinely lists more than one entry per type — an original run and
 * a re-release, a festival showing and a wide opening. Array order carries no
 * meaning, so picking the first returned a 1977 original over a 2027
 * re-release; that date then fell behind the join's cutoff and the film simply
 * never appeared. What the viewer wants is the next one that has not happened
 * yet, falling back to the most recent past date when they all have.
 */
const relevantDate = (results: ReleaseDateResult[], type: number, today: string): string | undefined => {
  const dates = results
    .filter((r) => r.type === type && r.release_date)
    .map((r) => r.release_date.slice(0, 10))
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
 * Deliberately does not trust the top-level `released` field: it is
 * consistently two days earlier than every country's actual theatrical date
 * (Dune: Part Three reports 2026-12-16 against a real 2026-12-18), so using it
 * would put every film in the calendar early. It is kept only as a last resort
 * for titles with no per-country data at all.
 */
export const pickReleaseDate = (
  movie: MovieDetail,
  country: string = config.releaseCountry,
  { now = new Date() }: { now?: Date } = {},
): PickedRelease | null => {
  // Uppercased because the comparison is exact: RELEASE_COUNTRY=gb used to miss
  // every entry and fall silently through to the US dates.
  const wanted = country.toUpperCase();
  const territories = [
    { code: wanted, results: datesFor(movie, wanted) },
    { code: 'US', results: datesFor(movie, 'US') },
  ];
  // The viewer's local date, not UTC: "has this happened yet" is the same
  // question the join asks, and it answers it in config.timezone.
  const today = localDate(now.toISOString(), config.timezone);

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

  // `type` is a number, not a union, so an entry with an unrecognised or absent
  // one is real data we have no name for. Taking it still beats falling through
  // to `released`, which is consistently two days early.
  for (const territory of territories) {
    const known = new Set<number>([...PREFERENCE, ...LAST_RESORT]);
    const other = territory.results.find((r) => r.release_date && !known.has(r.type));
    if (other) return { date: other.release_date.slice(0, 10), type: other.type ?? null, country: territory.code };
  }

  if (movie.released) return { date: movie.released.slice(0, 10), type: null, country: null };
  return null;
};

export interface MovieLookups {
  releases: Map<number, MovieRelease>;
  /**
   * Ids whose lookup errored in a way worth retrying. Deliberately distinct
   * from an id that resolved with no announced release date: an unreleased film
   * with no date is a settled answer, and treating it as a failure made every
   * poll refetch the whole film list forever.
   */
  failed: number[];
  /**
   * Ids the API says are gone — a 404 or 410, typically a film merged into
   * another id or deleted upstream. Retrying cannot help, so these must not
   * hold the list stale: counting them as failures meant every poll refetched
   * the whole film list and re-looked-up every title, forever. Note how narrow
   * this is: a 429 reaches the caller only after apiGet has exhausted its own
   * retries, and filing that as "gone" would drop every film for a whole day.
   *
   * Optional so a caller describing "no lookups happened" can omit it;
   * fetchMovieReleases always populates it.
   */
  unavailable?: number[];
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
  { releases: fetched, failed, unavailable = [] }: MovieLookups,
): Reconciled => {
  // Both kinds of error keep whatever was already known — a cached date beats
  // no date. Only the retryable ones make the round incomplete.
  const keepPrevious = new Set([...failed, ...unavailable]);
  const releases = new Map<number, MovieRelease>();
  for (const id of ids) {
    const release = fetched.get(id) ?? (keepPrevious.has(id) ? previous.get(id) : undefined);
    if (release) releases.set(id, release);
  }
  return { releases, complete: failed.length === 0 };
};

/** Detail lookups need no token — client_id is enough, and they are CDN-cached by id. */
export const fetchMovie = (id: number, { signal }: { signal?: AbortSignal } = {}): Promise<MovieDetail> =>
  apiGet<MovieDetail>(`/movies/${id}`, { params: { extended: 'full' }, signal });

/**
 * Release dates for a set of film ids, keyed by id.
 *
 * The CDN movie calendar only covers a rolling 33-day window, so a film six
 * months out never appears in it. Looking each one up directly sidesteps the
 * window entirely. Cloudflare caches these by id, so the docs allow modest
 * parallelism — capped low because the list is short anyway.
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
        out.set(Number(id), {
          simkl_id: Number(id),
          title: movie.title,
          date: release.date,
          releaseType: release.type,
          runtime: movie.runtime ? `${movie.runtime}m` : null,
          url: `https://simkl.com/movies/${id}`,
        });
      } catch (err) {
        // A problem with the whole account or client id is not a fact about
        // this film, and must not be recorded as one — an auth failure filed
        // per-id would swallow the "re-run npm run login" message entirely.
        if (err instanceof SimklAuthError || (err instanceof SimklError && err.status === 412)) throw err;

        // One unavailable film must not sink the whole refresh. Only the
        // statuses that mean the id will never resolve are settled; everything
        // else stays retryable so the list is tried again. 408 and 429 in
        // particular reach here only after apiGet has already exhausted its
        // retries, and filing a rate-limit as "gone" would drop every film for
        // a full day.
        const status = err instanceof SimklError ? err.status : undefined;
        if (status !== undefined && GONE.has(status)) unavailable.push(id);
        else failed.push(id);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { releases: out, failed, unavailable };
};
