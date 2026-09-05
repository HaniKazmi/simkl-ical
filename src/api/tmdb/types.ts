/**
 * Only what TMDB sends, and only the fields something here reads. `/movie/{id}`
 * carries forty-odd more; narrowing keeps this file evidence of what the sheet
 * depends on rather than a transcription of the schema.
 *
 * Written from live responses, like `simkl/types.ts`, which wins on payload
 * shape wherever the published docs disagree.
 */

export interface TmdbGenre {
  name?: string;
}

export interface TmdbCollection {
  name?: string;
}

/** `type`: 1 premiere, 2 limited, 3 theatrical, 4 digital, 5 physical, 6 TV. */
export interface TmdbRelease {
  type?: number;
  release_date?: string;
  /** The territory's own certificate — `12A` in GB, `PG-13` in US. Empty string when unrated. */
  certification?: string;
}

export interface TmdbReleaseGroup {
  iso_3166_1?: string;
  release_dates?: TmdbRelease[];
}

export interface TmdbCrew {
  job?: string;
  name?: string;
}

export interface TmdbBackdrop {
  file_path?: string;
  /**
   * The image's language, and `null` for one carrying no text at all. Only
   * `en` is asked for, so a null-language still never arrives — a poster or a
   * foreign-text frame is worse in this cell than a blank.
   */
  iso_639_1?: string | null;
  vote_average?: number;
}

export interface TmdbMovie {
  title?: string;
  genres?: TmdbGenre[];
  belongs_to_collection?: TmdbCollection | null;
  release_dates?: { results?: TmdbReleaseGroup[] };
  credits?: { crew?: TmdbCrew[] };
  images?: { backdrops?: TmdbBackdrop[] };
}

/**
 * One image from `/movie/{id}/images`, which carries what the appended
 * `images` on a film's detail does not: dimensions and the vote count.
 * Written from live responses like the rest.
 */
export interface TmdbImage {
  file_path?: string;
  iso_639_1?: string | null;
  width?: number;
  height?: number;
  aspect_ratio?: number;
  vote_average?: number;
  vote_count?: number;
}

/** `/movie/{id}/images?include_image_language=en,null`: posters, backdrops and logos. */
export interface TmdbImages {
  id?: number;
  backdrops?: TmdbImage[];
  posters?: TmdbImage[];
  logos?: TmdbImage[];
}
