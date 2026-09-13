/**
 * READ — a series' genre list from TVDB, for the two genre cells a new show
 * block writes.
 *
 * In `io/` beside `runtimes.ts` for its reason: I/O the steps run on, not a
 * step. TVDB rather than TMDB or SIMKL because only TVDB sends the list in a
 * *significance* order the tab picks by — its own genre-id order on all 189
 * series measured, where SIMKL sorts alphabetically and TMDB's TV vocabulary
 * has no Horror, Thriller or Romance at all.
 *
 * Returns the names raw, in the order sent. `3-catalogue.ts` reduces them with
 * `mappedTvdbGenres`, because which names the tab has a column for is a rule
 * about the sheet with no business in a module whose job is one HTTP call.
 *
 * One call is one series: the extended record carries the whole genre list, so
 * there is nothing to page.
 */

import { apiGet, classify } from '../../api/tvdb/client.ts';
import { keyedLookup, type PoolFailures } from '../../api/pool.ts';
import type { TvdbSeriesResponse } from '../../api/tvdb/types.ts';

/** One series to look up. `id` is the SIMKL title the caller folds the answer back onto. */
export interface SeriesRequest {
  id: number;
  tvdbId: number;
}

export interface SeriesGenres extends PoolFailures<number> {
  /**
   * TVDB's genre names in the order sent, keyed by **SIMKL** id — the id the
   * sheet holds. An **absent** key is a lookup that has not answered, which
   * leaves the block uninserted rather than inserting it with a blank genre;
   * an empty array is a series TVDB files under nothing.
   */
  genres: Map<number, string[]>;
}

export const fetchSeriesGenres = async (
  requests: SeriesRequest[],
  { signal, concurrency = 4 }: { signal?: AbortSignal; concurrency?: number } = {},
): Promise<SeriesGenres> => {
  const { answers, failed, unavailable } = await keyedLookup(
    requests,
    async ({ tvdbId }) => {
      const body = await apiGet<TvdbSeriesResponse>(`/series/${tvdbId}/extended`, { component: 'show-facts', signal });
      // The names alone, since that is what the mapping reads. A record with
      // no name is dropped: it is a field missing from the payload, not a
      // genre TVDB named.
      return body.data?.genres?.flatMap((genre) => (genre.name ? [genre.name] : [])) ?? [];
    },
    { concurrency, classify },
  );

  return { genres: answers, failed, unavailable };
};
