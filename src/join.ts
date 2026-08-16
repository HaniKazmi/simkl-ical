import { config } from './shared/config.ts';
import { localDate, releaseDate, shiftDate } from './shared/dates.ts';
import { itemSimklId, itemStatus } from './simkl/item.ts';
import type {
  CalendarEntry,
  FinaleType,
  Library,
  LibraryItem,
  ListResponse,
  CalendarFile,
  CalendarType,
  MovieRelease,
  ShowMetadata,
} from './simkl/types.ts';

/** Library responses nest under the type key, and come back as {} when empty. */
export const extractItems = (response: ListResponse | LibraryItem[] | null | undefined): LibraryItem[] => {
  if (!response || typeof response !== 'object') return [];
  if (Array.isArray(response)) return response;
  return response.shows ?? response.anime ?? response.movies ?? [];
};

export { itemSimklId };

/**
 * Statuses that mean an item is only *still* in the list it was fetched from
 * because nothing has evicted it.
 *
 * SIMKL reports a move against the destination list alone, so a show moved from
 * watching to dropped sits in both — and `listSignature` advances only for the
 * destination, so the source list is never refetched. `item.status` is the one
 * field that says which is current, which is why `sheet/progress.ts` reads it
 * too. Without this a dropped or on-hold show keeps generating its future
 * episodes indefinitely, since a future date is always inside the window.
 *
 * `completed` is deliberately absent. It lingers the same way, but everything a
 * completed title contributes is already dated, so it ages out of the grace
 * window on its own — and SIMKL marks an ongoing show completed the moment you
 * catch up, which is exactly when its next season matters most.
 */
const MOVED_ON = new Set(['dropped', 'hold']);

export const idSet = (...responses: Array<ListResponse | LibraryItem[] | null | undefined>): Set<number> => {
  const set = new Set<number>();
  for (const response of responses) {
    for (const item of extractItems(response)) {
      if (MOVED_ON.has(itemStatus(item) ?? '')) continue;
      const id = itemSimklId(item);
      if (id !== null) set.add(id);
    }
  }
  return set;
};

const FINALE_LABEL: Record<FinaleType, string> = {
  1: 'Mid-season finale',
  2: 'Season finale',
  3: 'Series finale',
};

/**
 * Human label for a film's release type. Presentation, so it lives here with
 * the rest of the event composition rather than in the module that fetches
 * releases.
 */
const RELEASE_LABEL: Record<number, string> = {
  1: 'Premiere',
  2: 'Limited release',
  3: 'In cinemas',
  4: 'Digital release',
  5: 'Physical release',
  6: 'TV',
};

export const releaseLabel = (type: number | null | undefined): string =>
  (type != null ? RELEASE_LABEL[type] : undefined) ?? 'Release';

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * "S04E03", or "E08" for anime, which SIMKL numbers without a season. Null when
 * there is no episode number at all: the anime calendar carries occasional
 * entries with no `episode` object.
 */
export const episodeCode = (season: number | null | undefined, episode: number | null | undefined): string | null => {
  if (episode == null) return null;
  if (season == null) return `E${pad(episode)}`;
  return `S${pad(season)}E${pad(episode)}`;
};

export type EventKind = 'tv' | 'anime' | 'movie';

/**
 * The one event shape, declared rather than implied so the two constructors
 * below and the ICS renderer share a contract.
 */
export interface FeedEvent {
  uid: string;
  kind: EventKind;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  summary: string;
  episodeTitle: string | null;
  /** One line of context: a network for episodes, a release type for films. */
  detail: string | null;
  runtime: string | null;
  url: string | null;
}

interface MakeEventInput {
  uid: string;
  kind: EventKind;
  date: string;
  title: string;
  code?: string | null;
  finale?: string | null;
  detail?: string | null;
  runtime?: string | null;
  episodeTitle?: string | null;
  url?: string | null;
}

/** The one event constructor, used by both the episode and film paths. */
const makeEvent = ({
  uid,
  kind,
  date,
  title,
  code = null,
  finale = null,
  detail = null,
  runtime = null,
  episodeTitle = null,
  url = null,
}: MakeEventInput): FeedEvent => ({
  // Derived, never random: a fresh UID each render makes clients duplicate
  // events rather than update them.
  uid,
  kind,
  date,
  summary: `${title}${code ? ` – ${code}` : ''}${finale ? ` (${finale})` : ''}`,
  episodeTitle,
  detail,
  runtime,
  url,
});

interface EpisodeEventInput {
  entry: CalendarEntry;
  meta: ShowMetadata | undefined;
  kind: EventKind;
  date: string;
}

const buildEpisodeEvent = ({ entry, meta, kind, date }: EpisodeEventInput): FeedEvent => {
  const id = entry.simkl_id;
  const title = meta?.title ?? `SIMKL ${id}`;
  const code = episodeCode(entry.episode?.season, entry.episode?.episode);
  // Entries with no episode number still describe a real airing, so they keep
  // their slot — keyed on the date, which is the only thing distinguishing them.
  const suffix = code ? code.toLowerCase() : date.replace(/-/g, '');

  return makeEvent({
    uid: `simkl-${id}-${suffix}@simkl-ical`,
    kind,
    date,
    title,
    code,
    finale: entry.finale_type != null ? (FINALE_LABEL[entry.finale_type] ?? null) : null,
    detail: meta?.network ?? null,
    runtime: meta?.runtime ?? null,
    episodeTitle: entry.episode?.title ?? null,
    url: entry.episode?.url ?? (meta?.url ? `https://simkl.com${meta.url}` : null),
  });
};

const buildFilmEvent = (release: MovieRelease): FeedEvent =>
  makeEvent({
    uid: `simkl-movie-${release.simkl_id}@simkl-ical`,
    kind: 'movie',
    date: releaseDate(release.date),
    title: release.title,
    detail: releaseLabel(release.releaseType),
    runtime: release.runtime ?? null,
    url: release.url ?? null,
  });

/**
 * First episode of a show. The season must be 1 *or absent*: SIMKL's anime
 * calendar carries no season field at all, so requiring `season === 1` would
 * never match anything anime.
 */
const isPremiere = (entry: CalendarEntry): boolean => {
  const ep = entry.episode;
  if (!ep || ep.episode !== 1) return false;
  return ep.season == null || ep.season === 1;
};

export interface JoinOptions {
  timezone?: string;
  now?: Date;
  movieReleases?: Map<number, MovieRelease>;
  graceDays?: number;
}

/**
 * Join the CDN calendars against the user's library.
 *
 * Watching lists contribute every upcoming airing. Plan-to-watch contributes
 * premieres only — including every episode of an unstarted show would bury the
 * calendar in things the user has not begun.
 *
 * Entries stay for `graceDays` after airing. This is deliberately independent of
 * watch state: the feed is a record of what aired, so an episode should not
 * disappear the moment it does.
 */
export const join = (
  calendars: Partial<Record<CalendarType, CalendarFile>>,
  library: Library,
  {
    timezone = config.timezone,
    now = new Date(),
    movieReleases = new Map<number, MovieRelease>(),
    graceDays = config.graceDays,
  }: JoinOptions = {},
): FeedEvent[] => {
  const sets = {
    // Completed sits alongside watching: SIMKL marks an ongoing show completed
    // once everything aired has been watched, so dropping it loses the next
    // season of anything between series.
    showsAiring: idSet(library.shows_watching, library.shows_completed),
    showsPlanned: idSet(library.shows_plantowatch),
    animeAiring: idSet(library.anime_watching, library.anime_completed),
    animePlanned: idSet(library.anime_plantowatch),
    moviesPlanned: idSet(library.movies_plantowatch),
  };

  const today = localDate(now.toISOString(), timezone);
  const cutoff = shiftDate(today, -graceDays);
  const events = new Map<string, FeedEvent>();

  const addEpisodes = (
    calendar: CalendarFile | undefined,
    watching: Set<number>,
    planned: Set<number>,
    kind: EventKind,
  ): void => {
    const metadata = calendar?.metadata;
    for (const entry of calendar?.calendar ?? []) {
      const id = entry.simkl_id;
      const inWatching = watching.has(id);
      const inPlanned = planned.has(id) && isPremiere(entry);
      if (!inWatching && !inPlanned) continue;

      const date = localDate(entry.date, timezone);
      if (date < cutoff) continue;

      const event = buildEpisodeEvent({ entry, meta: metadata?.[String(id)], kind, date });
      events.set(event.uid, event);
    }
  };

  addEpisodes(calendars.tv, sets.showsAiring, sets.showsPlanned, 'tv');
  addEpisodes(calendars.anime, sets.animeAiring, sets.animePlanned, 'anime');

  // Films come from per-title lookups rather than the CDN calendar, so a
  // release six months out still appears instead of waiting for the 33-day
  // window to reach it.
  for (const id of sets.moviesPlanned) {
    const release = movieReleases.get(id);
    if (!release) continue;
    if (releaseDate(release.date) < cutoff) continue;

    const event = buildFilmEvent(release);
    events.set(event.uid, event);
  }

  return [...events.values()].sort((a, b) => a.date.localeCompare(b.date) || a.summary.localeCompare(b.summary));
};
