/**
 * Only what TVDB sends, and only the fields something here reads.
 *
 * `EpisodeBaseRecord` carries twenty-odd more — names, translations, images,
 * air dates, finale types. Narrowing to four keeps this file evidence of what
 * the code depends on rather than a transcription of the schema.
 */

/** One entry from `GET /series/{id}/episodes/official?season={n}`. */
export interface TvdbEpisode {
  /** Episode number within the season. The deduplication key. */
  number?: number;
  /**
   * Minutes, and nullable in the schema. Null means TVDB does not know one —
   * never a zero-length episode, which is why it is dropped from an average
   * rather than counted.
   */
  runtime?: number | null;
  /**
   * Set on a film filed inside a numbered season — the one contaminant asking
   * for a single season does not already exclude, since specials sit in season
   * 0 and the URL names the season.
   */
  isMovie?: number;
}

export interface TvdbSeasonResponse {
  data?: { episodes?: TvdbEpisode[] };
}

export interface TvdbLoginResponse {
  data?: { token?: string };
}
