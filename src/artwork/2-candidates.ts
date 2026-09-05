/**
 * CANDIDATES — an upstream's image listing, reduced to what the page offers.
 * Pure: both payload shapes in, one candidate shape out, in the order the
 * page shows them.
 *
 * The filter is the site's: a film tile is 16:9 and a show tile 680×1000, so
 * an image of another shape would be cropped on display and is not offered.
 * The order is a starting point, not a verdict — the page exists because the
 * top-ranked image is the right one perhaps a third of the time.
 */

import type { TmdbImages } from '../api/tmdb/types.ts';
import type { TvdbArtworksResponse } from '../api/tvdb/types.ts';

export interface Candidate {
  /** Full size, and what is downloaded on a pick. */
  url: string;
  /** What the page's tile shows. */
  thumb: string;
  width: number;
  height: number;
  /** The upstream's own ranking figure — TMDB's vote average, TVDB's score. */
  score: number;
  /** TMDB's vote count; null for TVDB, which has none. */
  votes: number | null;
  /** `en`, `eng`, or null for an image carrying no text. */
  language: string | null;
  source: 'tmdb' | 'tvdb';
}

/** TMDB's CDN. `w1280` is the width every banner on the tab uses; `w300` is the tile. */
const TMDB_IMAGE = 'https://image.tmdb.org/t/p';
const TMDB_FULL = 'w1280';
const TMDB_THUMB = 'w300';

const FILM_RATIO = 16 / 9;
const SHOW_RATIO = 680 / 1000;
const RATIO_TOLERANCE = 0.01;

/** TVDB artwork type 2 is a series poster. */
export const TVDB_POSTER = 2;

const near = (ratio: number, target: number): boolean => Math.abs(ratio - target) <= RATIO_TOLERANCE;

/**
 * English backdrops first, ranked by how many people voted before how they
 * voted — ranked by average alone, a one-vote ten leads every list. Textless
 * backdrops (`null` language) follow, since a landscape tile can carry either
 * and the choice is the reader's.
 */
export const filmCandidates = (images: TmdbImages | undefined): Candidate[] => {
  const out: Candidate[] = [];
  for (const image of images?.backdrops ?? []) {
    if (!image.file_path || !image.width || !image.height) continue;
    if (image.iso_639_1 !== 'en' && image.iso_639_1 !== null && image.iso_639_1 !== undefined) continue;
    if (!near(image.width / image.height, FILM_RATIO)) continue;
    out.push({
      url: `${TMDB_IMAGE}/${TMDB_FULL}${image.file_path}`,
      thumb: `${TMDB_IMAGE}/${TMDB_THUMB}${image.file_path}`,
      width: image.width,
      height: image.height,
      score: image.vote_average ?? 0,
      votes: image.vote_count ?? 0,
      language: image.iso_639_1 ?? null,
      source: 'tmdb',
    });
  }
  return out.sort((a, b) => Number(b.language === 'en') - Number(a.language === 'en') || (b.votes ?? 0) - (a.votes ?? 0) || b.score - a.score || b.width - a.width);
};

/**
 * Posters at the authored size first — 680×1000 exactly, which is what the
 * site renders — English before any other language, then TVDB's score. Other
 * languages are offered rather than dropped because for an anime the Japanese
 * poster is often the only one there is, and the choice is the reader's.
 */
export const showCandidates = (artworks: TvdbArtworksResponse | undefined): Candidate[] => {
  const out: Candidate[] = [];
  for (const art of artworks?.data?.artworks ?? []) {
    if (!art.image || !art.width || !art.height) continue;
    if (art.type !== TVDB_POSTER) continue;
    if (!near(art.width / art.height, SHOW_RATIO)) continue;
    out.push({
      url: art.image,
      thumb: art.thumbnail ?? art.image,
      width: art.width,
      height: art.height,
      score: art.score ?? 0,
      votes: null,
      language: art.language ?? null,
      source: 'tvdb',
    });
  }
  const authored = (c: Candidate): number => Number(c.width === 680 && c.height === 1000);
  const english = (c: Candidate): number => Number(c.language === 'eng');
  return out.sort((a, b) => english(b) - english(a) || authored(b) - authored(a) || b.score - a.score);
};
