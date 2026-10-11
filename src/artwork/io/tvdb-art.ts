/**
 * READ — a series' poster listings from TVDB. Fetch only; `2-candidates.ts`
 * reduces them.
 *
 * `type=2` is a series poster and `type=7` a season poster, each a server-side
 * filter, so the payload is the candidates and little else. No language
 * filter: an anime often has only a Japanese poster, and `2-candidates.ts`
 * ranks English first rather than dropping the rest. A series the key cannot
 * see answers 404 like any other TVDB read, and reaches the page as "no
 * candidates" with the error beside it.
 */

import { apiGet } from '../../api/tvdb/client.ts';
import type { TvdbArtworksResponse, TvdbSeriesResponse } from '../../api/tvdb/types.ts';
import { TVDB_POSTER, TVDB_SEASON_POSTER } from '../2-candidates.ts';

export const fetchShowPosters = (tvdbId: number, { signal }: { signal?: AbortSignal } = {}): Promise<TvdbArtworksResponse> =>
  apiGet<TvdbArtworksResponse>(`/series/${tvdbId}/artworks`, { component: 'artwork', params: { type: TVDB_POSTER }, signal });

/**
 * Everything a season panel offers from one series, in three calls: the season
 * list that says which number and ordering each poster's `seasonId` is, the
 * season posters, and the series' own posters.
 *
 * Three rather than the one `/series/{id}/extended` without `short`, which
 * carries all of it: for Doctor Who that is 374 kB and 899 artworks, every
 * background, banner and clear logo included, against 26 kB for the season
 * list alone.
 */
export const fetchSeasonPosters = async (
  tvdbId: number,
  { signal }: { signal?: AbortSignal } = {},
): Promise<{ seasons: TvdbSeriesResponse; posters: TvdbArtworksResponse; series: TvdbArtworksResponse }> => {
  const [seasons, posters, series] = await Promise.all([
    apiGet<TvdbSeriesResponse>(`/series/${tvdbId}/extended`, { component: 'artwork', params: { short: 'true' }, signal }),
    apiGet<TvdbArtworksResponse>(`/series/${tvdbId}/artworks`, { component: 'artwork', params: { type: TVDB_SEASON_POSTER }, signal }),
    fetchShowPosters(tvdbId, { signal }),
  ]);
  return { seasons, posters, series };
};
