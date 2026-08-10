import { config } from './config.js';

/**
 * Local calendar date (YYYY-MM-DD) for an instant, in a given IANA zone.
 *
 * This is the highest-risk conversion in the project. `iso.slice(0, 10)` is
 * wrong for any show airing in the US evening: a 9pm Tuesday ET broadcast is
 * stamped 01:00Z Wednesday, and naive slicing would put it on the wrong day.
 * 'en-CA' is used because it formats as YYYY-MM-DD.
 */
export function localDate(iso, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/**
 * Film releases are a date, not a moment: every entry in movie_release.json is
 * stamped 04:00:00Z (midnight US Eastern) as a placeholder. Converting that
 * through a timezone would shift the date for anyone west of UTC-4, so the UTC
 * date is taken directly.
 */
export function releaseDate(iso) {
  return iso.slice(0, 10);
}

/** Library responses nest under the type key, and come back as {} when empty. */
export function extractItems(response) {
  if (!response || typeof response !== 'object') return [];
  if (Array.isArray(response)) return response;
  return response.shows ?? response.anime ?? response.movies ?? [];
}

/**
 * The library calls this field `ids.simkl`; the calendar calls it `simkl_id`.
 * Bridging the two names is the whole join.
 */
export function itemSimklId(item) {
  const ids = item?.show?.ids ?? item?.movie?.ids;
  return ids?.simkl ?? ids?.simkl_id ?? null;
}

export function idSet(response) {
  const set = new Set();
  for (const item of extractItems(response)) {
    const id = itemSimklId(item);
    if (id != null) set.add(Number(id));
  }
  return set;
}

const FINALE_LABEL = { 1: 'Mid-season finale', 2: 'Season finale', 3: 'Series finale' };

const pad = (n) => String(n).padStart(2, '0');

/** "S04E03", or "E08" for anime that SIMKL numbers without a season. */
export function episodeCode(season, episode) {
  if (season == null) return `E${pad(episode)}`;
  return `S${pad(season)}E${pad(episode)}`;
}

function buildEvent({ entry, meta, kind, date }) {
  const id = entry.simkl_id;
  const title = meta?.title ?? `SIMKL ${id}`;
  const url = meta?.url ? `https://simkl.com${meta.url}` : entry.episode?.url ?? null;

  if (kind === 'movie') {
    return {
      uid: `simkl-movie-${id}@simkl-ical`,
      kind,
      date,
      summary: title,
      showTitle: title,
      episodeTitle: null,
      network: meta?.network ?? null,
      runtime: meta?.runtime ?? null,
      finale: null,
      url,
    };
  }

  const code = episodeCode(entry.episode?.season, entry.episode?.episode);
  const finale = FINALE_LABEL[entry.finale_type] ?? null;

  return {
    // Derived, never random: a fresh UID on every render makes clients duplicate
    // events instead of updating them.
    uid: `simkl-${id}-${code.toLowerCase()}@simkl-ical`,
    kind,
    date,
    summary: `${title} – ${code}${finale ? ` (${finale})` : ''}`,
    showTitle: title,
    episodeTitle: entry.episode?.title ?? null,
    network: meta?.network ?? null,
    runtime: meta?.runtime ?? null,
    finale,
    url: entry.episode?.url ?? url,
  };
}

const isPremiere = (entry) => entry.episode?.season === 1 && entry.episode?.episode === 1;

/**
 * Join the CDN calendars against the user's library.
 *
 * Watching lists contribute every upcoming airing. Plan-to-watch contributes
 * premieres only — including every episode of an unstarted show would bury the
 * calendar in things the user has not begun.
 */
export function join(calendars, library, { timezone = config.timezone, now = new Date() } = {}) {
  const sets = {
    showsWatching: idSet(library.shows_watching),
    showsPlanned: idSet(library.shows_plantowatch),
    animeWatching: idSet(library.anime_watching),
    animePlanned: idSet(library.anime_plantowatch),
    moviesPlanned: idSet(library.movies_plantowatch),
  };

  const today = localDate(now.toISOString(), timezone);
  const events = new Map();

  const addEpisodes = (calendar, watching, planned, kind) => {
    for (const entry of calendar?.calendar ?? []) {
      const id = Number(entry.simkl_id);
      const inWatching = watching.has(id);
      const inPlanned = planned.has(id) && isPremiere(entry);
      if (!inWatching && !inPlanned) continue;

      const date = localDate(entry.date, timezone);
      if (date < today) continue; // upcoming only

      const event = buildEvent({ entry, meta: calendar.metadata?.[String(id)], kind, date });
      events.set(event.uid, event);
    }
  };

  addEpisodes(calendars.tv, sets.showsWatching, sets.showsPlanned, 'tv');
  addEpisodes(calendars.anime, sets.animeWatching, sets.animePlanned, 'anime');

  for (const entry of calendars.movies?.calendar ?? []) {
    const id = Number(entry.simkl_id);
    if (!sets.moviesPlanned.has(id)) continue;

    const date = releaseDate(entry.date);
    if (date < today) continue;

    const event = buildEvent({ entry, meta: calendars.movies.metadata?.[String(id)], kind: 'movie', date });
    events.set(event.uid, event);
  }

  return [...events.values()].sort((a, b) => a.date.localeCompare(b.date) || a.summary.localeCompare(b.summary));
}
