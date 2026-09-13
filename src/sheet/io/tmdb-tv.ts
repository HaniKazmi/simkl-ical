/**
 * READ — a series' content ratings from TMDB, for the `Certificate` cell a new
 * show block writes.
 *
 * TMDB rather than the two upstreams already being asked: SIMKL's
 * `certification` is the US TV rating, and TVDB carries a GB rating on 19 of
 * the 189 series measured against TMDB's 179. Through `CERTIFICATE_AGES` the GB
 * entry agrees with 161 of those blocks; the 10 with no GB entry leave the cell
 * blank.
 *
 * Returns the payload raw; `3-catalogue.ts` picks the territory and maps the
 * rating, the same division `movies/io/tmdb.ts` keeps.
 *
 * One call is one series: `append_to_response` folds the ratings into the
 * detail response rather than costing a second request.
 */

import { apiGet, classify } from '../../api/tmdb/client.ts';
import { lookupPool, type PoolFailures } from '../../api/pool.ts';
import type { TmdbTv } from '../../api/tmdb/types.ts';

/** One series to look up. `id` is the SIMKL title the caller folds the answer back onto. */
export interface CertificateRequest {
  id: number;
  tmdbId: number;
}

export interface ShowCertificates extends PoolFailures<number> {
  /**
   * What each series returned, keyed by **SIMKL** id — the id the sheet holds.
   * An absent key is a lookup that has not answered, which leaves the block
   * uninserted rather than inserting it with a blank certificate.
   */
  shows: Map<number, TmdbTv>;
}

export const fetchShowCertificates = async (
  requests: CertificateRequest[],
  { signal, concurrency = 4 }: { signal?: AbortSignal; concurrency?: number } = {},
): Promise<ShowCertificates> => {
  const merged = new Map<number, CertificateRequest>();
  for (const request of requests) merged.set(request.id, request);

  const shows = new Map<number, TmdbTv>();

  const { failed, unavailable } = await lookupPool<CertificateRequest, number>(
    [...merged.values()],
    (request) => request.id,
    async ({ id, tmdbId }) => {
      const body = await apiGet<TmdbTv>(`/tv/${tmdbId}`, {
        component: 'show-facts',
        params: { append_to_response: 'content_ratings' },
        signal,
      });
      shows.set(id, body);
    },
    { concurrency, classify },
  );

  return { shows, failed, unavailable };
};
