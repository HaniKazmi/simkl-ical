/**
 * Per-title catalogue lookups: what SIMKL says *exists*, as opposed to what the
 * library says was watched.
 *
 * Two endpoints, and neither substitutes for the other:
 *
 * - `/tv/episodes/{id}` gives the per-season list with an `aired` flag. It
 *   cannot be gated on "a season ended", because it is what discovers that.
 * - `/tv/{id}` (or `/anime/{id}`) gives `status`. An announced next season
 *   appears in the episode list with `aired: false`, but a show renewed but
 *   unscheduled — House of the Dragon — simply ends its episode list, which is
 *   indistinguishable from a finished show. Closing that gap is the entire
 *   reason this lookup exists.
 *
 * Both are unauthenticated and Cloudflare-cached by id, so modest parallelism
 * is allowed — unlike the sync endpoints, which must stay sequential.
 */

import { apiGet, classify } from '../simkl/client.ts';
import type { EpisodeDetail, ShowDetail } from '../simkl/types.ts';

/**
 * Cached across polls but not forever. A process-lifetime cache would freeze
 * `aired` at whatever it was when the container booted, so a season that
 * finished airing since would never be recognised as complete — the safe
 * direction, but a sync that quietly stops working.
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  at: number;
}

const episodeCache = new Map<number, CacheEntry<EpisodeDetail[]>>();
const detailCache = new Map<string, CacheEntry<ShowDetail>>();

/** Tests share a process; a cache that outlives one would leak between them. */
export const clearCache = (): void => {
  episodeCache.clear();
  detailCache.clear();
};

const fresh = <T>(entry: CacheEntry<T> | undefined, now: number): T | undefined =>
  entry && now - entry.at < CACHE_TTL_MS ? entry.value : undefined;

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
  apiGet<EpisodeDetail[]>(`/tv/episodes/${id}`, { signal });

const fetchDetail = (id: number, anime: boolean, signal?: AbortSignal): Promise<ShowDetail> =>
  apiGet<ShowDetail>(`/${anime ? 'anime' : 'tv'}/${id}`, { params: { extended: 'full' }, signal });

/**
 * Resolve a batch. Requests for the same id are merged, so asking for the
 * episode list and the detail of one show costs the two calls it should.
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
  const failed: number[] = [];
  const unavailable: number[] = [];
  const queue = [...merged.values()];
  const now = Date.now();

  const worker = async (): Promise<void> => {
    while (queue.length) {
      const request = queue.shift();
      if (!request) return;
      const { id, anime = false } = request;
      const detailKey = `${anime ? 'anime' : 'tv'}:${id}`;
      try {
        if (request.episodes) {
          const cached = fresh(episodeCache.get(id), now);
          const value = cached ?? (await fetchEpisodes(id, signal));
          if (!cached) episodeCache.set(id, { value, at: Date.now() });
          episodes.set(id, value);
        }
        if (request.detail) {
          const cached = fresh(detailCache.get(detailKey), now);
          const value = cached ?? (await fetchDetail(id, anime, signal));
          if (!cached) detailCache.set(detailKey, { value, at: Date.now() });
          details.set(id, value);
        }
      } catch (err) {
        // One missing title must not sink the sync, but an account-level
        // problem is not a fact about this title and must not be filed as one.
        const kind = classify(err);
        if (kind === 'account') throw err;
        (kind === 'gone' ? unavailable : failed).push(id);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { episodes, details, failed, unavailable };
};
