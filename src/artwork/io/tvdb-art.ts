/**
 * READ — a series' poster listing from TVDB. Fetch only; `2-candidates.ts`
 * reduces it.
 *
 * `type=2` is a poster and `lang=eng` the English ones; both are server-side
 * filters, so the payload is the candidates and little else. A series the
 * key cannot see answers 404 like any other TVDB read, and reaches the page
 * as "no candidates" with the error beside it.
 */

import { apiGet } from '../../api/tvdb/client.ts';
import type { TvdbArtworksResponse } from '../../api/tvdb/types.ts';
import { TVDB_POSTER } from '../2-candidates.ts';

export const fetchShowPosters = (tvdbId: number, { signal }: { signal?: AbortSignal } = {}): Promise<TvdbArtworksResponse> =>
  apiGet<TvdbArtworksResponse>(`/series/${tvdbId}/artworks`, { component: 'artwork', params: { lang: 'eng', type: TVDB_POSTER }, signal });
