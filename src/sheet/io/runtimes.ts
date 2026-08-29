/**
 * READ — a season's episode list from TVDB, for the runtimes in it.
 *
 * In `io/` beside `catalogue.ts` for the same reason: I/O the steps run on,
 * not a step. The catalogue asks SIMKL what episodes exist; this asks TVDB how
 * long they are — the one thing SIMKL holds and its API does not serve under
 * any `extended` value.
 *
 * Returns the episodes raw; `SheetSync` reduces them, as it reduces
 * `catalogue.ts`'s payloads with `seasonShapes`. The reduction checks against
 * SIMKL's own episode count — a rule about two upstreams agreeing, with no
 * business in a module whose job is one HTTP call.
 *
 * One call is one whole season: `links.page_size` is 500 with a null `next` on
 * every season measured, up to a 28-episode anime cour, so `page` is passed
 * for the spec's sake and never walked.
 *
 * A season TVDB does not have answers `200` with an empty list, not a 404, so
 * the commonest "no data" case arrives as a successful call and is settled by
 * the reduction, not the failure split.
 */

import { apiGet, classify } from '../../api/tvdb/client.ts';
import { lookupPool, type PoolFailures } from '../../api/pool.ts';
import type { TvdbEpisode, TvdbSeasonResponse } from '../../api/tvdb/types.ts';

/** One season to look up. `id` is the SIMKL title the caller folds the answer back onto. */
export interface RuntimeRequest {
  id: number;
  tvdbId: number;
  season: number;
}

/** `${tvdbId}:${season}`. The identity of the *lookup*, which two titles could share. */
export const runtimeKeyOf = (tvdbId: number, season: number): string => `${tvdbId}:${season}`;

export interface SeasonRuntimes extends PoolFailures<string> {
  /**
   * The episodes each season returned. An **absent** key is a failed lookup,
   * which leaves the row open rather than closing it blank.
   */
  episodes: Map<string, TvdbEpisode[]>;
}

export const fetchSeasonRuntimes = async (
  requests: RuntimeRequest[],
  { signal, concurrency = 4 }: { signal?: AbortSignal; concurrency?: number } = {},
): Promise<SeasonRuntimes> => {
  // Two rows in different blocks can name the same title and season; the
  // lookup is the same call either way.
  const merged = new Map<string, RuntimeRequest>();
  for (const request of requests) merged.set(runtimeKeyOf(request.tvdbId, request.season), request);

  const episodes = new Map<string, TvdbEpisode[]>();

  const { failed, unavailable } = await lookupPool<RuntimeRequest, string>(
    [...merged.values()],
    (request) => runtimeKeyOf(request.tvdbId, request.season),
    async ({ tvdbId, season }) => {
      const body = await apiGet<TvdbSeasonResponse>(`/series/${tvdbId}/episodes/official`, {
        component: 'runtimes',
        params: { season, page: 0 },
        signal,
      });
      episodes.set(runtimeKeyOf(tvdbId, season), body.data?.episodes ?? []);
    },
    { concurrency, classify },
  );

  return { episodes, failed, unavailable };
};
