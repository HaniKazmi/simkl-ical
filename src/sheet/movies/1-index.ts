/**
 * INDEX — what SIMKL says about each film, reduced to the shape the films
 * planner needs. Pure.
 *
 * Runs before the films tab is read: `sync.ts` uses an empty index as its
 * early-out, so a poll in which no film moved never reads the tab at all.
 *
 * Only SIMKL's `movies` category. An anime film arrives under `anime` with an
 * `anime_type` of `movie`, and whether it belongs on this tab or embedded in a
 * `Sheet1` block is a curation call nothing in the record answers — so those
 * are left to the show half, which already indexes them.
 */

import { instantFrom } from '../../shared/dates.ts';
import { itemStatus } from '../../api/simkl/item.ts';
import type { Library } from '../../library.ts';

/**
 * A film's status is one of `completed`, `dropped` or `plantowatch` — SIMKL's
 * movies category carries no `watching` or `hold` key.
 */
export const WATCHED_STATUS = 'completed';

export interface FilmProgress {
  id: number;
  title: string;
  /** `item.status`, folded. Only `completed` earns a row. */
  status: string | null;
  /**
   * The one watch timestamp a film has. Films carry no episode list, so there
   * is no first-versus-last distinction to make.
   */
  watchedAt: Temporal.Instant | null;
  /**
   * The user's score, or null where SIMKL holds none — a real value, not an
   * absence. SIMKL holds one for 245 of the 347 films the tab already lists,
   * and it agrees with the `Score` column on every one of them.
   */
  rating: number | null;
  /** Whole minutes, straight off the library record. */
  runtime: number | null;
  /**
   * TMDB's id for this film, or null when the record carries none. Null means
   * no row can ever be built — every column but four comes from TMDB — which
   * the planner settles rather than re-asking each poll.
   */
  tmdbId: number | null;
}

/**
 * SIMKL sends the TMDB id as a string, the way it sends the TVDB one. A
 * non-numeric or absent value is "no TMDB id", never an error: the film simply
 * cannot be filed.
 */
export const tmdbIdOf = (raw: string | undefined): number | null => {
  if (typeof raw !== 'string') return null;
  const id = Number(raw.trim());
  return Number.isInteger(id) && id > 0 ? id : null;
};

/**
 * Every film in the library, keyed by SIMKL id — including `plantowatch` and
 * `dropped` ones, which are never inserted but whose ids must still be known,
 * so a row someone added by hand is recognised rather than duplicated.
 */
export const indexFilms = (library: Library | null | undefined): Map<number, FilmProgress> => {
  const out = new Map<number, FilmProgress>();
  for (const [id, { type, item }] of library ?? []) {
    if (type !== 'movies') continue;
    const movie = item.movie;
    out.set(id, {
      id,
      // `||`, not `??`: an empty or whitespace-only title is a value SIMKL can
      // send, and it reaches `Name` and `Franchise`, which the guard refuses as
      // non-empty — a whole-plan refusal that would freeze the tab for as long
      // as that record is in the library.
      title: movie?.title?.trim() || String(id),
      status: itemStatus(item),
      watchedAt: instantFrom(item.last_watched_at),
      rating: typeof item.user_rating === 'number' ? item.user_rating : null,
      runtime: typeof movie?.runtime === 'number' ? movie.runtime : null,
      tmdbId: tmdbIdOf(movie?.ids?.tmdb),
    });
  }
  return out;
};

/** Whether this film should have a row at all. */
export const filmIsWatched = (film: FilmProgress): boolean => film.status === WATCHED_STATUS;
