/**
 * Only what TVDB sends, and only the fields something here reads.
 *
 * `EpisodeBaseRecord` carries twenty-odd more — names, translations, images,
 * air dates, finale types. Narrowing keeps this file evidence of what the code
 * depends on, not a transcription of the schema.
 */

/** One entry from `GET /series/{id}/episodes/official?season={n}`. */
export interface TvdbEpisode {
  /** Episode number within the season. The deduplication key. */
  number?: number;
  /**
   * Minutes, nullable. Null means TVDB does not know one — never a zero-length
   * episode — so it is dropped from an average rather than counted.
   */
  runtime?: number | null;
  /**
   * Set on a film filed inside a numbered season — the one contaminant a
   * single-season request does not exclude, since specials sit in season 0
   * and the URL names the season.
   */
  isMovie?: number;
}

export interface TvdbSeasonResponse {
  data?: { episodes?: TvdbEpisode[] };
}

/**
 * `GET /series/{id}/extended`, which carries the whole series record. The sheet
 * reads the genre list; the artwork page reads the name and the season list,
 * asking `short=true`, which leaves out characters and artworks — 26 kB for
 * Doctor Who against 374 kB for the full record and its 899 artworks.
 *
 * The genre order is TVDB's own genre-id order on all 189 series measured, and
 * that order is what decides a block's primary genre — see `mappedTvdbGenres`,
 * which keeps it.
 */
export interface TvdbSeriesResponse {
  data?: { name?: string; genres?: { id?: number; name?: string }[]; seasons?: TvdbSeason[] };
}

export interface TvdbLoginResponse {
  data?: { token?: string };
}

/**
 * One artwork from `/series/{id}/artworks`. `type` is TVDB's own numbering:
 * 1 banner, 2 poster, 3 background, 5 icon, 7 season poster, 22 clear art,
 * 23 clear logo. `image` is a full `artworks.thetvdb.com` URL, and
 * `thumbnail` its `_t` sibling.
 *
 * Sizes, measured across 52 series: every series poster is 680×1000 (1,612 of
 * 1,612), and season posters are 400×578 (1,904 of 2,828) or 680×1000.
 */
export interface TvdbArtwork {
  id?: number;
  image?: string;
  thumbnail?: string;
  language?: string | null;
  type?: number;
  score?: number;
  width?: number;
  height?: number;
  includesText?: boolean;
  /**
   * On a season poster, the TVDB season it belongs to — an id, not a number.
   * `/series/{id}/extended` says which number and which order it is, and
   * every one measured on four series is in that list.
   */
  seasonId?: number;
}

/** `/series/{id}/artworks?type=2`: every language, since an anime often has only a Japanese poster. */
export interface TvdbArtworksResponse {
  status?: string;
  data?: { id?: number; name?: string; artworks?: TvdbArtwork[] };
}

/**
 * One season of a series, from `/series/{id}/extended?short=true`. A series
 * carries one list per ordering — `type.type` is `official` for aired order,
 * and `dvd`, `absolute`, `alternate` and a few rarer ones beside it — so a
 * season number names a season only within one ordering. `image` is TVDB's
 * default poster for the season, and on four series measured it is always one
 * of that season's `type=7` artworks.
 */
export interface TvdbSeason {
  id?: number;
  number?: number;
  type?: { type?: string; name?: string };
  image?: string | null;
}
