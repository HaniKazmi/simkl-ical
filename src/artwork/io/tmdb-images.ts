/**
 * READ — a film's image listing from TMDB. Fetch only; `2-candidates.ts`
 * reduces it.
 *
 * Both languages asked for at once: `en` carries the title across the frame
 * and `null` is textless, and a landscape tile can take either, so the choice
 * is the reader's rather than this module's.
 */

import { apiGet } from '../../api/tmdb/client.ts';
import type { TmdbImages } from '../../api/tmdb/types.ts';

export const fetchFilmImages = (tmdbId: number, { signal }: { signal?: AbortSignal } = {}): Promise<TmdbImages> =>
  apiGet<TmdbImages>(`/movie/${tmdbId}/images`, { component: 'artwork', params: { include_image_language: 'en,null' }, signal });
