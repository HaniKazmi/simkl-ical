/**
 * READ — a season's per-episode runtimes, from TVDB.
 *
 * In `io/` beside `catalogue.ts` and for the same reason: it is I/O the steps
 * run on rather than a step itself. Where the catalogue asks SIMKL what episodes
 * *exist*, this asks TVDB how long they are — the one thing SIMKL holds and its
 * API does not serve under any `extended` value.
 *
 * One call is one whole season. The response carries `links.page_size: 500` with
 * a null `next` on every season measured, up to a 28-episode anime cour, so the
 * `page` parameter is passed for the spec's sake and never walked.
 *
 * A season TVDB does not have answers `200` with an empty episode list rather
 * than a 404, so the commonest "no data" case arrives as a successful call and
 * is settled by `averageRuntime` returning null, not by the failure split.
 */

import { apiGet, classify } from '../../api/tvdb/client.ts';
import { averageRuntime } from '../1-progress.ts';
import { lookupPool } from '../../api/pool.ts';
import type { TvdbSeasonResponse } from '../../api/tvdb/types.ts';

/** One season to look up. `id` is the SIMKL title the caller folds the answer back onto. */
export interface RuntimeRequest {
  id: number;
  tvdbId: number;
  season: number;
  /** SIMKL's own episode count for this season — what the answer must agree with. */
  expected: number;
}

/** `${tvdbId}:${season}`. The identity of the *lookup*, which two titles could share. */
export const runtimeKeyOf = (tvdbId: number, season: number): string => `${tvdbId}:${season}`;

export interface SeasonRuntimes {
  /**
   * Average minutes per season, or null for "TVDB answered and there is nothing
   * usable here". Both are settled answers; a key that is simply *absent* is the
   * lookup having failed, which is what defers the row rather than closing it.
   */
  runtimes: Map<string, number | null>;
  failed: string[];
  unavailable: string[];
}

export const fetchSeasonRuntimes = async (
  requests: RuntimeRequest[],
  { signal, concurrency = 4 }: { signal?: AbortSignal; concurrency?: number } = {},
): Promise<SeasonRuntimes> => {
  // Two rows in different blocks can name the same title and season, and the
  // lookup is the same call either way.
  const merged = new Map<string, RuntimeRequest>();
  for (const request of requests) merged.set(runtimeKeyOf(request.tvdbId, request.season), request);

  const runtimes = new Map<string, number | null>();

  const { failed, unavailable } = await lookupPool<RuntimeRequest, string>(
    [...merged.values()],
    (request) => runtimeKeyOf(request.tvdbId, request.season),
    async ({ tvdbId, season, expected }) => {
      const body = await apiGet<TvdbSeasonResponse>(`/series/${tvdbId}/episodes/official`, {
        component: 'runtimes',
        params: { season, page: 0 },
        signal,
      });
      runtimes.set(runtimeKeyOf(tvdbId, season), averageRuntime(body.data?.episodes, expected));
    },
    { concurrency, classify },
  );

  return { runtimes, failed, unavailable };
};
