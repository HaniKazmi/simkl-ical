/**
 * JOIN — calendars × library × releases → events. Pure.
 *
 * The second step of the feed pipeline: FETCH (io/) → **JOIN** → RENDER → SAVE.
 */

import { config } from '../shared/config.ts';
import { instantFrom, plainDateIn } from '../shared/dates.ts';
import { itemStatus } from '../api/simkl/item.ts';
import type {
  CalendarEntry,
  FinaleType,
  CalendarFile,
  CalendarType,
  ShowMetadata,
  SyncType,
} from '../api/simkl/types.ts';
import type { Library } from '../library.ts';
import type { MovieRelease } from './1-films.ts';

/**
 * Statuses whose upcoming episodes do not belong in the feed.
 *
 * `plantowatch` is here because planned titles are joined separately, against
 * the premiere rather than every airing. `completed` is deliberately absent:
 * everything a completed title contributes is already dated, so it ages out of
 * the grace window on its own — and SIMKL marks an ongoing show completed the
 * moment you catch up, which is exactly when its next season matters most.
 */
const NOT_AIRING = new Set(['dropped', 'hold', 'plantowatch']);

/** Ids of one type whose status the predicate accepts. Absent status reads as ''. */
const idsWhere = (
  library: Library | null | undefined,
  type: SyncType,
  keep: (status: string) => boolean,
): Set<number> => {
  const ids = new Set<number>();
  for (const [id, entry] of library ?? []) {
    if (entry.type === type && keep(itemStatus(entry.item) ?? '')) ids.add(id);
  }
  return ids;
};

/**
 * Shows or anime whose airings belong in the feed.
 *
 * Negative on purpose: `status` is optional on the wire, and a record carrying
 * none is still a title we hold, so including it is the answer we want.
 */
export const airingIds = (library: Library | null | undefined, type: SyncType): Set<number> =>
  idsWhere(library, type, (status) => !NOT_AIRING.has(status));

/**
 * Titles on plan-to-watch.
 *
 * Positive, and the asymmetry with `airingIds` is the point: the library holds
 * every film the user has ever completed, so a negative rule here would sweep
 * hundreds of watched films into the feed *and* into a per-title lookup each.
 * A film with no status is simply not planned — the safe direction.
 */
export const plannedIds = (library: Library | null | undefined, type: SyncType): Set<number> =>
  idsWhere(library, type, (status) => status === 'plantowatch');

/** The film-lookup input, so `Feed` needs no opinion about the library's shape. */
export const plannedFilmIds = (library: Library | null | undefined): number[] => [...plannedIds(library, 'movies')];

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
  /** The local calendar date it airs on. A date, not an instant: no zone applies. */
  date: Temporal.PlainDate;
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
  date: Temporal.PlainDate;
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
  date: Temporal.PlainDate;
}

const buildEpisodeEvent = ({ entry, meta, kind, date }: EpisodeEventInput): FeedEvent => {
  const id = entry.simkl_id;
  const title = meta?.title ?? `SIMKL ${id}`;
  const code = episodeCode(entry.episode?.season, entry.episode?.episode);
  // Entries with no episode number still describe a real airing, so they keep
  // their slot — keyed on the date, which is the only thing distinguishing them.
  const suffix = code ? code.toLowerCase() : `${date}`.replace(/-/g, '');

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
    date: release.date,
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
  now?: Temporal.Instant;
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
    now = Temporal.Now.instant(),
    movieReleases = new Map<number, MovieRelease>(),
    graceDays = config.graceDays,
  }: JoinOptions = {},
): FeedEvent[] => {
  const sets = {
    // Completed counts as airing: SIMKL marks an ongoing show completed once
    // everything aired has been watched, so excluding it loses the next season
    // of anything between series.
    showsAiring: airingIds(library, 'shows'),
    showsPlanned: plannedIds(library, 'shows'),
    animeAiring: airingIds(library, 'anime'),
    animePlanned: plannedIds(library, 'anime'),
    moviesPlanned: plannedIds(library, 'movies'),
  };

  const today = plainDateIn(now, timezone);
  const cutoff = today.subtract({ days: graceDays });
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

      // Upstream data, so a malformed `date` is skipped rather than thrown:
      // `instantFrom` answers null on anything that is not an ISO instant, and
      // one bad field in a payload of several thousand entries would otherwise
      // abort the whole render and stop the feed updating until the CDN fixed
      // itself. Measured at 0 of 5014 live entries — the skip is a guard, not a
      // routine path.
      const at = instantFrom(entry.date);
      if (at === null) continue;
      const date = plainDateIn(at, timezone);
      if (Temporal.PlainDate.compare(date, cutoff) < 0) continue;

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
    if (Temporal.PlainDate.compare(release.date, cutoff) < 0) continue;

    const event = buildFilmEvent(release);
    events.set(event.uid, event);
  }

  return [...events.values()].sort((a, b) => Temporal.PlainDate.compare(a.date, b.date) || a.summary.localeCompare(b.summary));
};
