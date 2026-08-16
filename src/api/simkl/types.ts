/**
 * Shapes of the SIMKL payloads this service consumes.
 *
 * These are written from live responses, not the published docs, which the
 * payloads contradict in several places. Where a field is optional or nullable
 * here it is because live data makes it so, never as defensive typing — there
 * is no compiler at runtime, so narrowing one is a crash rather than an error.
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
   * Absent on some anime entries. Formatting a missing one yields "Eundefined"
   * in both the summary and the UID.
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
}

export interface LibraryTitle {
  /** Absent from an `extended=simkl_ids_only` response, which carries ids alone. */
  title?: string;
  year?: number;
  ids: LibraryIds;
}

/**
 * One watched episode, from `include_all_episodes=yes`.
 *
 * `watched_at` is nullable because the docs say unwatched rows can be filled in
 * with the show's last-watched time. Live data does not appear to do it, but
 * counting filters on the field regardless: the whole sync rests on that number
 * and the filter is free.
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
   * Per-item and authoritative — the only membership there is, since the
   * library holds one record per id and a move replaces it.
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
   * Only present with `include_all_episodes=yes`, which is required for the
   * completed and dropped lists — without it the key is absent entirely.
   */
  seasons?: WatchedSeason[];
}

/**
 * The wire shape of `/sync/all-items`, whatever the query. All keys optional:
 * nothing to report comes back as `{}`, not `{shows: []}` — which is what a
 * `date_from` delta returns on a quiet poll, all two bytes of it.
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
export type SyncStatus = 'watching' | 'plantowatch' | 'completed' | 'hold' | 'dropped';

/**
 * One library record, and the type it belongs to.
 *
 * `type` is the only thing not derivable from the item: an anime record is a
 * show record with an extra `anime_type` field, and both nest their title under
 * `show`. Which top-level key of the response it arrived under is the answer,
 * and it is needed downstream — the feed picks a calendar with it, the sheet
 * skips films with it.
 *
 * `status` is deliberately *not* copied up here. `itemStatus` reads it from the
 * item, and a second copy is one that can disagree with the payload it was
 * built from — the class of bug this whole model exists to remove.
 */
export interface LibraryEntry {
  type: SyncType;
  item: LibraryItem;
}

/**
 * The user's library: one authoritative record per SIMKL id.
 *
 * A delta returns each changed item once, carrying its current `status`, so an
 * item cannot be present twice and cannot disagree with itself. List membership
 * is not a thing this model can represent, which is the point.
 */
export type Library = Map<number, LibraryEntry>;

/**
 * Per-status last-modified timestamps. `movies` carries no `watching` or `hold`
 * key at all, hence the narrower type.
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
   * Unreliable — consistently two days earlier than the real theatrical date.
   * Use `release_dates` instead; this is a last resort only.
   */
  released?: string;
  /** Minutes here, unlike the calendar's display string. */
  runtime?: number | null;
  release_dates?: Array<{ iso_3166_1: string; results: ReleaseDateResult[] }>;
  ids?: LibraryIds;
}

// --- Show detail -----------------------------------------------------------

/**
 * One entry from `/tv/episodes/{id}` — what SIMKL knows exists, as opposed to
 * what the library says was watched.
 *
 * `aired` is the field that distinguishes a season still running from a
 * finished one, and `type` is what keeps a special out of a numbered season's
 * total. Both are optional: absent means "do not conclude anything".
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
 * `/tv/{id}` and `/anime/{id}`. Only `status` is consulted: it is the one
 * signal that separates a show that has ended from one merely between seasons,
 * which the episode list cannot express.
 */
export interface ShowDetail {
  title?: string;
  /** `ended`, `airing`, `tba`, or something we have not seen. */
  status?: string;
  /** Minutes, and **per episode** — "most common length", not a season or series total. */
  runtime?: number | null;
  ids?: LibraryIds;
}

/** A film's resolved release, as stored and persisted. */
export interface MovieRelease {
  simkl_id: number;
  title: string;
  date: string;
  releaseType: number | null;
  runtime: string | null;
  url: string;
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
