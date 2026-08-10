import { apiGet } from '../simkl/client.ts';
import { config } from '../config.ts';
import type { MovieDetail, MovieRelease, ReleaseDateResult } from '../simkl/types.ts';

/**
 * TMDB-style release types, as used by SIMKL's `release_dates`.
 * 1 is a premiere screening — often a week or more before anyone can buy a
 * ticket — so it is only ever a last resort.
 */
const RELEASE_TYPE = { PREMIERE: 1, LIMITED: 2, THEATRICAL: 3, DIGITAL: 4, PHYSICAL: 5, TV: 6 } as const;
const PREFERENCE = [RELEASE_TYPE.THEATRICAL, RELEASE_TYPE.LIMITED, RELEASE_TYPE.DIGITAL, RELEASE_TYPE.TV];

const datesFor = (movie: MovieDetail, country: string): ReleaseDateResult[] =>
  movie.release_dates?.find((c) => c.iso_3166_1 === country)?.results ?? [];

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
export const pickReleaseDate = (movie: MovieDetail, country: string = config.releaseCountry): PickedRelease | null => {
  const territories = [
    { code: country, results: datesFor(movie, country) },
    { code: 'US', results: datesFor(movie, 'US') },
  ];

  // A real release anywhere in the preference order beats a premiere anywhere,
  // so both territories are exhausted before premieres are considered at all.
  for (const territory of territories) {
    for (const type of PREFERENCE) {
      const hit = territory.results.find((r) => r.type === type && r.release_date);
      if (hit) return { date: hit.release_date.slice(0, 10), type, country: territory.code };
    }
  }

  // Nothing but a premiere listed — still better than the unreliable `released`.
  for (const territory of territories) {
    const premiere = territory.results.find((r) => r.release_date);
    if (premiere) return { date: premiere.release_date.slice(0, 10), type: premiere.type, country: territory.code };
  }

  if (movie.released) return { date: movie.released.slice(0, 10), type: null, country: null };
  return null;
};

export interface Reconciled {
  releases: Map<number, MovieRelease>;
  complete: boolean;
}

/**
 * Fold a round of lookups into what we already had.
 *
 * Films no longer on the list are dropped; ids that failed this time keep their
 * previous value rather than vanishing. `complete` reports whether every id
 * resolved — the caller uses it to decide whether to record the list as current
 * or leave it stale so the next poll retries.
 */
export const reconcileReleases = (
  previous: Map<number, MovieRelease>,
  ids: number[],
  fetched: Map<number, MovieRelease>,
): Reconciled => {
  const releases = new Map<number, MovieRelease>();
  for (const id of ids) {
    const release = fetched.get(id) ?? previous.get(id);
    if (release) releases.set(id, release);
  }
  return { releases, complete: fetched.size === ids.length };
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
): Promise<Map<number, MovieRelease>> => {
  const out = new Map<number, MovieRelease>();
  const queue = [...new Set(ids)];

  const worker = async (): Promise<void> => {
    while (queue.length) {
      const id = queue.shift();
      if (id === undefined) return;
      try {
        const movie = await fetchMovie(id, { signal });
        const release = pickReleaseDate(movie);
        if (!release) continue;
        out.set(Number(id), {
          simkl_id: Number(id),
          title: movie.title,
          date: release.date,
          releaseType: release.type,
          country: release.country,
          runtime: movie.runtime ? `${movie.runtime}m` : null,
          url: `https://simkl.com/movies/${id}`,
        });
      } catch {
        // One unavailable film must not sink the whole refresh.
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
};
