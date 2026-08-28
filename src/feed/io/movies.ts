/**
 * FETCH — film release dates, one lookup per title.
 *
 * The CDN movie calendar covers only a rolling 33-day window, so a film six
 * months out never appears in it; per-title lookups sidestep that. Every rule
 * about what the answers mean lives in `1-films.ts`.
 */

import { apiGet, classify } from '../../api/simkl/client.ts';
import { lookupPool } from '../../api/pool.ts';
import { pickReleaseDate, type MovieLookups, type MovieRelease } from '../1-films.ts';
import type { MovieDetail } from '../../api/simkl/types.ts';

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
    { concurrency, classify },
  );

  return { releases: out, failed, unavailable };
};
