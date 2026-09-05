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

export interface TvdbLoginResponse {
  data?: { token?: string };
}

/**
 * One artwork from `/series/{id}/artworks`. `type` is TVDB's own numbering:
 * 1 banner, 2 poster (680×1000, thumbnail 340×500), 3 background, 5 icon,
 * 22 clear art, 23 clear logo. `image` is a full `artworks.thetvdb.com`
 * URL, and `thumbnail` its `_t` sibling.
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
}

/** `/series/{id}/artworks?lang=eng&type=2`. */
export interface TvdbArtworksResponse {
  status?: string;
  data?: { id?: number; name?: string; artworks?: TvdbArtwork[] };
}
