/**
 * READ — a film's detail from TMDB, for the eight columns SIMKL does not carry.
 *
 * In `io/` for the same reason `catalogue.ts` is: I/O the steps run on, not a
 * step. Returns the payload raw; `3-catalogue.ts` reduces it, because "which
 * backdrop, which certificate, which genre is primary" are sheet rules with no
 * business in a module whose job is one HTTP call.
 *
 * One call is one whole film. `append_to_response` folds the release dates,
 * the credits and the images into the detail response, so a row's worth of
 * columns costs one request rather than four.
 */

import { apiGet, classify } from '../../../api/tmdb/client.ts';
import { lookupPool, type PoolFailures } from '../../../api/pool.ts';
import type { TmdbMovie } from '../../../api/tmdb/types.ts';

/** One film to look up. `id` is the SIMKL title the caller folds the answer back onto. */
export interface FilmRequest {
  id: number;
  tmdbId: number;
}

export interface FilmDetails extends PoolFailures<number> {
  /**
   * What each film returned, keyed by **SIMKL** id — the id the sheet holds.
   * An absent key is a lookup that has not answered, which leaves the film
   * uninserted rather than inserting it with blank cells.
   */
  films: Map<number, TmdbMovie>;
}

export const fetchFilms = async (
  requests: FilmRequest[],
  { signal, concurrency = 4 }: { signal?: AbortSignal; concurrency?: number } = {},
): Promise<FilmDetails> => {
  const merged = new Map<number, FilmRequest>();
  for (const request of requests) merged.set(request.id, request);

  const films = new Map<number, TmdbMovie>();

  const { failed, unavailable } = await lookupPool<FilmRequest, number>(
    [...merged.values()],
    (request) => request.id,
    async ({ id, tmdbId }) => {
      const body = await apiGet<TmdbMovie>(`/movie/${tmdbId}`, {
        component: 'movie-catalogue',
        // English images only. A null-language backdrop is usually a poster
        // crop and a foreign one carries the wrong title across it, so asking
        // for the rest would only be payload to filter back out.
        params: { append_to_response: 'release_dates,credits,images', include_image_language: 'en' },
        signal,
      });
      films.set(id, body);
    },
    { concurrency, classify },
  );

  return { films, failed, unavailable };
};
