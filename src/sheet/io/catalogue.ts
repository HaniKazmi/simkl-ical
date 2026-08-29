/**
 * READ — per-title catalogue lookups, the sync's other input.
 *
 * In `io/` because it is I/O the steps run on rather than a step itself: what
 * SIMKL says *exists*, as opposed to what the library says was watched.
 *
 * Two endpoints, neither a substitute for the other:
 *
 * - `/tv/episodes/{id}` gives the per-season list with an `aired` flag. It
 *   cannot be gated on "a season ended", because it is what discovers that.
 * - `/tv/{id}` (or `/anime/{id}`) gives `status`. An announced next season
 *   appears in the episode list with `aired: false`, but a show renewed and
 *   unscheduled — House of the Dragon — simply ends its episode list,
 *   indistinguishable from a finished show. Closing that gap is why this
 *   lookup exists.
 *
 * Both are unauthenticated and Cloudflare-cached by id, so modest parallelism
 * is allowed — unlike the sync endpoints, which must stay sequential.
 */

import { apiGet, classify } from '../../api/simkl/client.ts';
import { lookupPool } from '../../api/pool.ts';
import type { EpisodeDetail, ShowDetail } from '../../api/simkl/types.ts';

/**
 * No cache here — the same division as `movies.ts`: the source fetches, the
 * caller decides when.
 *
 * `SheetSync` retains results across polls and knows which titles moved, so it
 * knows better than a blind TTL when to refetch. Two caching layers with
 * different policies breed "why is this stale" bugs: a TTL here would serve a
 * five-hour-old episode list for a show the caller decided to refresh
 * precisely because it changed.
 */

/** What a single title needs looked up. Both flags false is a no-op. */
export interface CatalogueRequest {
  id: number;
  /** Selects `/anime/{id}` over `/tv/{id}` for the detail lookup. */
  anime?: boolean;
  episodes?: boolean;
  detail?: boolean;
}

export interface Catalogue {
  episodes: Map<number, EpisodeDetail[]>;
  details: Map<number, ShowDetail>;
  /** Ids whose lookup errored in a way worth retrying — the run is incomplete. */
  failed: number[];
  /** Ids SIMKL says are gone. Retrying never helps, so these must not hold the sync back. */
  unavailable: number[];
}

const fetchEpisodes = (id: number, signal?: AbortSignal): Promise<EpisodeDetail[]> =>
  apiGet<EpisodeDetail[]>(`/tv/episodes/${id}`, { component: 'catalogue', signal });

// No `extended`: the per-title endpoints always return the whole record; the
// parameter is accepted and changes nothing.
const fetchDetail = (id: number, anime: boolean, signal?: AbortSignal): Promise<ShowDetail> =>
  apiGet<ShowDetail>(`/${anime ? 'anime' : 'tv'}/${id}`, { component: 'catalogue', signal });

/**
 * Resolve a batch. Requests for the same id are merged, so the episode list
 * and detail of one show cost the two calls they should.
 */
export const fetchCatalogue = async (
  requests: CatalogueRequest[],
  { signal, concurrency = 4 }: { signal?: AbortSignal; concurrency?: number } = {},
): Promise<Catalogue> => {
  const merged = new Map<number, CatalogueRequest>();
  for (const request of requests) {
    const existing = merged.get(request.id);
    merged.set(request.id, {
      id: request.id,
      anime: Boolean(existing?.anime || request.anime),
      episodes: Boolean(existing?.episodes || request.episodes),
      detail: Boolean(existing?.detail || request.detail),
    });
  }

  const episodes = new Map<number, EpisodeDetail[]>();
  const details = new Map<number, ShowDetail>();

  const { failed, unavailable } = await lookupPool(
    [...merged.values()],
    (request) => request.id,
    async ({ id, anime = false, ...want }) => {
      if (want.episodes) episodes.set(id, await fetchEpisodes(id, signal));
      if (want.detail) details.set(id, await fetchDetail(id, anime, signal));
    },
    { concurrency, classify },
  );

  return { episodes, details, failed, unavailable };
};
