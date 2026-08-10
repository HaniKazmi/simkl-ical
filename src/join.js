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
 * Film release dates arrive from /movies/{id} already as plain YYYY-MM-DD in
 * the viewer's country, so there is no instant to convert and no timezone to
 * apply. This only guards against a full ISO timestamp sneaking through.
 */
export function releaseDate(value) {
  return String(value).slice(0, 10);
}

/**
 * Shift a YYYY-MM-DD date by whole days. Arithmetic is done at UTC noon so a
 * DST transition can never push the result onto the neighbouring day.
 */
export function shiftDate(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d, 12));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
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

export function idSet(...responses) {
  const set = new Set();
  for (const response of responses) {
    for (const item of extractItems(response)) {
      const id = itemSimklId(item);
      if (id != null) set.add(Number(id));
    }
  }
  return set;
}

const FINALE_LABEL = { 1: 'Mid-season finale', 2: 'Season finale', 3: 'Series finale' };

/**
 * Human label for a film's release type. Presentation, so it lives here with
 * the rest of the event composition rather than in the module that fetches
 * releases — that was the one dependency pointing from domain logic into I/O.
 */
const RELEASE_LABEL = {
  1: 'Premiere',
  2: 'Limited release',
  3: 'In cinemas',
  4: 'Digital release',
  5: 'Physical release',
  6: 'TV',
};

export function releaseLabel(type) {
  return RELEASE_LABEL[type] ?? 'Release';
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * "S04E03", or "E08" for anime, which SIMKL numbers without a season.
 *
 * Returns null when there is no episode number at all — the anime calendar
 * carries occasional entries with no `episode` object, and formatting those
 * produced "Eundefined" in both the summary and the UID.
 */
export function episodeCode(season, episode) {
  if (episode == null) return null;
  if (season == null) return `E${pad(episode)}`;
  return `S${pad(season)}E${pad(episode)}`;
}

/**
 * The one event constructor, used by both the episode and film paths.
 *
 * `detail` is a single line of context — a broadcast network for episodes,
 * a release type for films. It was called `network`, which was a lie on half
 * its values.
 */
function makeEvent({ uid, kind, date, title, code = null, finale = null, detail = null, runtime = null, episodeTitle = null, url = null }) {
  return {
    // Derived, never random: a fresh UID on every render makes clients duplicate
    // events instead of updating them.
    uid,
    kind,
    date,
    summary: `${title}${code ? ` – ${code}` : ''}${finale ? ` (${finale})` : ''}`,
    episodeTitle,
    detail,
    runtime,
    finale,
    url,
  };
}

function buildEpisodeEvent({ entry, meta, kind, date }) {
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
    finale: FINALE_LABEL[entry.finale_type] ?? null,
    detail: meta?.network ?? null,
    runtime: meta?.runtime ?? null,
    episodeTitle: entry.episode?.title ?? null,
    url: entry.episode?.url ?? (meta?.url ? `https://simkl.com${meta.url}` : null),
  });
}

function buildFilmEvent(release) {
  return makeEvent({
    uid: `simkl-movie-${release.simkl_id}@simkl-ical`,
    kind: 'movie',
    date: releaseDate(release.date),
    title: release.title,
    detail: releaseLabel(release.releaseType),
    runtime: release.runtime ?? null,
    url: release.url ?? null,
  });
}

/**
 * First episode of a show.
 *
 * The season must be 1 *or absent*: SIMKL's anime calendar carries no season
 * field at all — 0 of 572 live entries have one — so requiring `season === 1`
 * meant anime plan-to-watch could never match anything.
 */
const isPremiere = (entry) => {
  const ep = entry.episode;
  if (!ep || ep.episode !== 1) return false;
  return ep.season == null || ep.season === 1;
};

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
export function join(
  calendars,
  library,
  { timezone = config.timezone, now = new Date(), movieReleases = new Map(), graceDays = config.graceDays } = {},
) {
  const sets = {
    // Completed sits alongside watching: SIMKL marks an ongoing show completed
    // once everything aired has been watched, so dropping it would lose the
    // next season of anything between series.
    showsAiring: idSet(library.shows_watching, library.shows_completed),
    showsPlanned: idSet(library.shows_plantowatch),
    animeAiring: idSet(library.anime_watching, library.anime_completed),
    animePlanned: idSet(library.anime_plantowatch),
    moviesPlanned: idSet(library.movies_plantowatch),
  };

  const today = localDate(now.toISOString(), timezone);
  const cutoff = shiftDate(today, -graceDays);
  const events = new Map();

  const addEpisodes = (calendar, watching, planned, kind) => {
    for (const entry of calendar?.calendar ?? []) {
      const id = Number(entry.simkl_id);
      const inWatching = watching.has(id);
      const inPlanned = planned.has(id) && isPremiere(entry);
      if (!inWatching && !inPlanned) continue;

      const date = localDate(entry.date, timezone);
      if (date < cutoff) continue;

      const event = buildEpisodeEvent({ entry, meta: calendar.metadata?.[String(id)], kind, date });
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

    const event = buildFilmEvent({ ...release, simkl_id: id });
    events.set(event.uid, event);
  }

  return [...events.values()].sort((a, b) => a.date.localeCompare(b.date) || a.summary.localeCompare(b.summary));
}
