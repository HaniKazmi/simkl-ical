/**
 * Shapes of the SIMKL payloads this service consumes.
 *
 * Written from live responses, not the published docs, which the payloads
 * contradict in places. A field is optional or nullable here because live data
 * makes it so, never as defensive typing — there is no compiler at runtime, so
 * narrowing one is a crash.
 *
 * Only what SIMKL sends. A shape this service derives lives with the module
 * that derives it, so this rule stays true of everything here.
 */

// --- Calendar (public CDN) -------------------------------------------------

/** 1 mid-season, 2 season, 3 series. Null for an ordinary episode. */
export type FinaleType = 1 | 2 | 3;

export interface CalendarEpisode {
  /** Always null in the anime calendar — 0 of 572 live entries carry one. */
  season: number | null;
  episode: number;
  title: string | null;
  url: string;
}

export interface CalendarEntry {
  simkl_id: number;
  /** ISO 8601, always UTC with a Z suffix. A real instant, not a date. */
  date: string;
  finale_type: FinaleType | null;
  /**
   * Absent on some anime entries. Formatting a missing one yields
   * "Eundefined" in the summary and the UID.
   */
  episode?: CalendarEpisode;
}

export interface ShowMetadata {
  title: string;
  /** Site-relative, e.g. "/tv/3407/futurama" — needs the origin prepending. */
  url?: string;
  /** Null on some records, not merely absent. */
  network?: string | null;
  /** A display string such as "45m", not a number of minutes. Nullable. */
  runtime?: string | null;
  ids?: { simkl_id?: number; slug?: string; imdb?: string; tmdb?: string; tvdb?: string };
}

export interface CalendarFile {
  calendar: CalendarEntry[];
  /** Keyed by simkl_id as a string. */
  metadata: Record<string, ShowMetadata>;
}

export type CalendarType = 'tv' | 'anime';

// --- Sync (authenticated) --------------------------------------------------

/** The library nests ids under `ids.simkl`; the calendar calls it `simkl_id`. */
export interface LibraryIds {
  simkl?: number;
  simkl_id?: number;
  slug?: string;
  /**
   * A string, as SIMKL sends it — `"371572"`, not `371572`. The per-title
   * endpoints carry more (`imdb`, `tvdbslug`, `traktslug`); those are unread,
   * and listing them would make this file a transcription rather than evidence
   * of what is used.
   */
  tvdb?: string;
  /**
   * Also a string — `"11"`, not `11`. Present on every one of the 327 films an
   * `extended=full` library pull returns, which is what lets the sheet's films
   * half reach TMDB off the delta alone, with no per-title SIMKL call.
   */
  tmdb?: string;
}

export interface LibraryTitle {
  /** Absent from an `extended=simkl_ids_only` response, which carries ids alone. */
  title?: string;
  year?: number;
  /**
   * Minutes, and only on a film — where it is the whole film's length, not the
   * per-episode figure `ShowDetail.runtime` carries. It agrees with the sheet's
   * own `Runtime` column on all 346 rows that have one, which is why the films
   * half needs no per-title lookup for it.
   */
  runtime?: number | null;
  ids: LibraryIds;
}

/**
 * One watched episode, from `include_all_episodes=yes`.
 *
 * `watched_at` is nullable: the docs say unwatched rows can carry the show's
 * last-watched time. Live data does not appear to do it, but counting filters
 * on the field anyway — the whole sync rests on that number and the filter is
 * free.
 */
export interface WatchedEpisode {
  number: number;
  watched_at?: string | null;
}

/** Season 0 is specials, and is excluded from both sides of every comparison. */
export interface WatchedSeason {
  number: number;
  episodes?: WatchedEpisode[];
}

export interface LibraryItem {
  /** Shows and anime both nest under `show`; films under `movie`. */
  show?: LibraryTitle;
  movie?: LibraryTitle;
  /**
   * What kind of anime this is, on `anime` records only — a **top-level** key,
   * beside `show` rather than inside it. It is the one thing separating a film
   * from a cour: an anime film is a show record in every other respect, and
   * `LibraryEntry.type` says only which response key it arrived under, which is
   * `anime` for both.
   *
   * Measured across 216 records: 155 `tv`, 41 `movie`, 10 `ova`, 7 `special`,
   * 3 `ona`.
   */
  anime_type?: string;
  /**
   * The only membership there is: the library holds one record per id, and a
   * move replaces it.
   */
  status?: string;
  /** Always populated. "S07E06", or "E07" for anime. */
  last_watched?: string | null;
  /** Null once caught up, so it cannot be used as a progress signal. */
  next_to_watch?: string | null;
  /** ISO instant. Only present with `episode_watched_at=yes`. */
  last_watched_at?: string | null;
  watched_episodes_count?: number;
  total_episodes_count?: number;
  not_aired_episodes_count?: number;
  /**
   * The user's own score, 1-10, and null where they have not rated the title.
   * Null is a value here, not an absence: the films sheet records it, so that
   * rating something later reads as a move rather than as a first sighting.
   */
  user_rating?: number | null;
  /**
   * Only present with `include_all_episodes=yes`, which the completed and
   * dropped lists require — without it the key is absent entirely.
   */
  seasons?: WatchedSeason[];
}

/**
 * The wire shape of `/sync/all-items`, whatever the query. All keys optional:
 * nothing to report comes back as `{}`, not `{shows: []}` — a quiet poll's
 * delta is those two bytes.
 *
 * A type-less pull populates all three keys at once, so nothing may read this
 * as "the one key that is set".
 */
export interface AllItemsResponse {
  shows?: LibraryItem[];
  anime?: LibraryItem[];
  movies?: LibraryItem[];
}

export type SyncType = 'shows' | 'anime' | 'movies';


/**
 * Per-status last-modified timestamps. `movies` carries no `watching` or
 * `hold` key, hence the narrower type.
 */
export interface CategoryActivity {
  all?: string | null;
  rated_at?: string | null;
  playback?: string | null;
  plantowatch?: string | null;
  watching?: string | null;
  completed?: string | null;
  hold?: string | null;
  dropped?: string | null;
  removed_from_list?: string | null;
}

export interface Activities {
  all?: string;
  settings?: { all?: string | null };
  /** Note the name: the sync path says `shows`, activities says `tv_shows`. */
  tv_shows?: CategoryActivity;
  anime?: CategoryActivity;
  movies?: Omit<CategoryActivity, 'watching' | 'hold'>;
}

// --- Film detail -----------------------------------------------------------

export interface ReleaseDateResult {
  /** 1 premiere, 2 limited, 3 theatrical, 4 digital, 5 physical, 6 TV. */
  type: number;
  release_date: string;
}

export interface MovieDetail {
  title: string;
  year?: number;
  /**
   * Consistently two days earlier than the real theatrical date. Use
   * `release_dates` instead; this is a last resort.
   */
  released?: string;
  /** Minutes here, unlike the calendar's display string. */
  runtime?: number | null;
  release_dates?: Array<{ iso_3166_1: string; results: ReleaseDateResult[] }>;
  ids?: LibraryIds;
}

// --- Show detail -----------------------------------------------------------

/**
 * One entry from `/tv/episodes/{id}` — what SIMKL knows exists, not what the
 * library says was watched.
 *
 * `aired` distinguishes a season still running from a finished one; `type`
 * keeps a special out of a numbered season's total. Both optional: absent
 * means "do not conclude anything".
 */
export interface EpisodeDetail {
  season?: number | null;
  episode?: number;
  /** `episode` or `special`. Specials are counted nowhere. */
  type?: string;
  aired?: boolean;
  date?: string | null;
}

/**
 * `/tv/{id}` and `/anime/{id}`.
 *
 * Three fields are read. `status` separates a show that has ended from one
 * between seasons, which the episode list cannot express. `runtime` is the
 * show-wide "most common length", which a newly inserted season row takes for
 * its `Episodes` cell. `ids.tvdb` is the join key to the per-episode runtimes,
 * which SIMKL holds but does not serve.
 */
export interface ShowDetail {
  title?: string;
  /** `ended`, `airing`, `tba`, or something we have not seen. */
  status?: string;
  /** Minutes, and **per episode** — "most common length", not a season or series total. */
  runtime?: number | null;
  ids?: LibraryIds;
}


// --- Auth ------------------------------------------------------------------

export interface PinResponse {
  result?: string;
  message?: string;
  /** Literally the string "DEVICE_CODE" — a placeholder. Poll on user_code. */
  device_code?: string;
  user_code: string;
  verification_url?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  access_token?: string;
}
