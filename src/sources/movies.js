import { apiGet } from '../simkl/client.js';
import { config } from '../config.js';

/**
 * TMDB-style release types, as used by SIMKL's `release_dates`.
 * 1 is a premiere screening — often a week or more before anyone can buy a
 * ticket — so it is only ever a last resort.
 */
const RELEASE_TYPE = { PREMIERE: 1, LIMITED: 2, THEATRICAL: 3, DIGITAL: 4, PHYSICAL: 5, TV: 6 };
const PREFERENCE = [RELEASE_TYPE.THEATRICAL, RELEASE_TYPE.LIMITED, RELEASE_TYPE.DIGITAL, RELEASE_TYPE.TV];

function datesFor(movie, country) {
  const entry = (movie.release_dates ?? []).find((c) => c.iso_3166_1 === country);
  return entry?.results ?? [];
}

/**
 * Best release date for a film, in the viewer's country.
 *
 * Deliberately does not trust the top-level `released` field: it is
 * consistently two days earlier than every country's actual theatrical date
 * (Dune: Part Three reports 2026-12-16 against a real 2026-12-18), so using it
 * would put every film in the calendar early. It is kept only as a last resort
 * for titles with no per-country data at all.
 */
export function pickReleaseDate(movie, country = config.releaseCountry) {
  for (const source of [datesFor(movie, country), datesFor(movie, 'US')]) {
    for (const type of PREFERENCE) {
      const hit = source.find((r) => r.type === type && r.release_date);
      if (hit) return { date: hit.release_date.slice(0, 10), type, country: source === datesFor(movie, country) ? country : 'US' };
    }
    // Nothing but a premiere listed — better than falling through to `released`.
    const premiere = source.find((r) => r.release_date);
    if (premiere) return { date: premiere.release_date.slice(0, 10), type: premiere.type, country };
  }

  if (movie.released) return { date: movie.released.slice(0, 10), type: null, country: null };
  return null;
}

const TYPE_LABEL = {
  [RELEASE_TYPE.PREMIERE]: 'Premiere',
  [RELEASE_TYPE.LIMITED]: 'Limited release',
  [RELEASE_TYPE.THEATRICAL]: 'In cinemas',
  [RELEASE_TYPE.DIGITAL]: 'Digital release',
  [RELEASE_TYPE.PHYSICAL]: 'Physical release',
  [RELEASE_TYPE.TV]: 'TV',
};

export function releaseLabel(type) {
  return TYPE_LABEL[type] ?? 'Release';
}

/** Detail lookups need no token — client_id is enough, and they are CDN-cached by id. */
export function fetchMovie(id, { signal } = {}) {
  return apiGet(`/movies/${id}`, { params: { extended: 'full' }, signal });
}

/**
 * Release dates for a set of film ids, keyed by id.
 *
 * The CDN movie calendar only covers a rolling 33-day window, so a film six
 * months out never appears in it. Looking each one up directly sidesteps the
 * window entirely. Cloudflare caches these by id, so the docs allow modest
 * parallelism — capped low because the list is short anyway.
 */
export async function fetchMovieReleases(ids, { signal, concurrency = 4 } = {}) {
  const out = new Map();
  const queue = [...new Set(ids)];

  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        const movie = await fetchMovie(id, { signal });
        const release = pickReleaseDate(movie);
        if (!release) continue;
        out.set(Number(id), {
          simkl_id: Number(id),
          title: movie.title,
          date: release.date,
          releaseType: release.type,
          country: release.country,
          runtime: movie.runtime ? `${movie.runtime}m` : null,
          url: `https://simkl.com/movies/${id}`,
        });
      } catch {
        // One unavailable film must not sink the whole refresh.
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}
