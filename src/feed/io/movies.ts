/**
 * FETCH — film release dates, one lookup per title. The CDN movie calendar
 * covers only a rolling 33-day window, so a film six months out never appears
 * in it. Every rule about what the answers mean lives in `1-films.ts`.
 */

import { apiGet, classify } from '../../api/simkl/client.ts';
import { lookupPool } from '../../api/pool.ts';
import { pickReleases, type MovieLookups, type MovieRelease } from '../1-films.ts';
import type { MovieDetail } from '../../api/simkl/types.ts';

/**
 * Needs no token — client_id is enough, and responses are CDN-cached by id.
 * No `extended`: this endpoint always returns the whole record, and the
 * parameter changes nothing.
 */
const fetchMovie = (id: number, { signal }: { signal?: AbortSignal } = {}): Promise<MovieDetail> =>
  apiGet<MovieDetail>(`/movies/${id}`, { component: 'films', signal });

/**
 * Release dates for a set of film ids, keyed by id. Cloudflare caches the
 * lookups by id, so modest parallelism is fine.
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
      const dates = pickReleases(movie);
      // No announced date is an answer, not a failure.
      if (dates.length === 0) return;
      out.set(id, {
        simkl_id: id,
        title: movie.title,
        runtime: movie.runtime ? `${movie.runtime}m` : null,
        url: `https://simkl.com/movies/${id}`,
        dates,
      });
    },
    { concurrency, classify },
  );

  return { releases: out, failed, unavailable };
};
