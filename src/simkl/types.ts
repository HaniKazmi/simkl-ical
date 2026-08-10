/**
 * Shapes of the SIMKL payloads this service consumes.
 *
 * These are written from live responses, not the published docs, which differ
 * in several places that cost real debugging time. Where a field is optional or
 * nullable here it is because it genuinely is — each one has caused a bug.
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
   * Absent on some anime entries. Formatting a missing one produced
   * "Eundefined" in both summaries and UIDs.
   */
  episode?: CalendarEpisode;
}

export interface ShowMetadata {
  title: string;
  /** Site-relative, e.g. "/tv/3407/futurama" — needs the origin prepending. */
  url?: string;
  network?: string;
  /** A display string such as "45m", not a number of minutes. */
  runtime?: string;
  ids?: { simkl_id?: number; slug?: string; imdb?: string; tmdb?: string; tvdb?: string };
}

export interface CalendarFile {
  calendar: CalendarEntry[];
  /** Keyed by simkl_id as a string. */
  metadata: Record<string, ShowMetadata>;
}

/** A merged calendar, as returned by fetchCalendar. */
export interface MergedCalendar extends CalendarFile {
  type: CalendarType;
  lastModified: string | null;
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
  title: string;
  year?: number;
  ids: LibraryIds;
}

export interface LibraryItem {
  /** Shows and anime both nest under `show`; films under `movie`. */
  show?: LibraryTitle;
  movie?: LibraryTitle;
  status?: string;
  /** Always populated. "S07E06", or "E07" for anime. */
  last_watched?: string | null;
  /** Null once caught up, so it cannot be used as a progress signal. */
  next_to_watch?: string | null;
  watched_episodes_count?: number;
  total_episodes_count?: number;
  not_aired_episodes_count?: number;
}

/**
 * All keys optional: an empty list comes back as `{}`, not `{shows: []}`.
 */
export interface ListResponse {
  shows?: LibraryItem[];
  anime?: LibraryItem[];
  movies?: LibraryItem[];
}

export type ListKey =
  | 'shows_watching'
  | 'shows_plantowatch'
  | 'shows_completed'
  | 'anime_watching'
  | 'anime_plantowatch'
  | 'anime_completed'
  | 'movies_plantowatch';

export type Library = Partial<Record<ListKey, ListResponse>>;

export type SyncType = 'shows' | 'anime' | 'movies';
export type SyncStatus = 'watching' | 'plantowatch' | 'completed' | 'hold' | 'dropped';

export interface ListDefinition {
  key: ListKey;
  type: SyncType;
  status: SyncStatus;
}

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

/** A film's resolved release, as stored and persisted. */
export interface MovieRelease {
  simkl_id: number;
  title: string;
  date: string;
  releaseType: number | null;
  country: string | null;
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
