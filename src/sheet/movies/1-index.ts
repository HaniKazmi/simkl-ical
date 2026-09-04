/**
 * INDEX — what SIMKL says about each film, reduced to the shape the films
 * planner needs. Pure.
 *
 * Runs before the films tab is read: `sync.ts` uses an empty index as its
 * early-out, so a poll in which no film moved never reads the tab at all.
 *
 * SIMKL's `movies` category, plus the `anime` records whose `anime_type` is
 * `movie`. Whether an anime film belongs here or embedded in a `Sheet1` block
 * is a curation call the record does not answer, so the planner reads the
 * sheet's own placement instead — see `onShowGrid` in `4-plan.ts`.
 *
 * An anime film is therefore in *both* halves' indexes, and that is not a
 * duplication to tidy away: 20 of them sit on `Sheet1` rows, which the show
 * half skips as `unknown-id` every poll the moment `indexLibrary` stops
 * holding them.
 */

import { instantFrom } from '../../shared/dates.ts';
import { itemStatus } from '../../api/simkl/item.ts';
import type { Library } from '../../library.ts';
import type { LibraryItem } from '../../api/simkl/types.ts';

/**
 * A film's status is one of `completed`, `dropped` or `plantowatch` — SIMKL's
 * movies category carries no `watching` or `hold` key.
 */
export const WATCHED_STATUS = 'completed';

/**
 * The one `anime_type` this tab takes. `ova`, `special` and `ona` stay with the
 * show half: they are extras hanging off a series rather than films in their
 * own right, and the sheet files them that way.
 */
export const ANIME_FILM = 'movie';

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
  /** Whether this arrived under `anime`, which is what fills the column. */
  anime: boolean;
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

const isAnimeFilm = (type: string, item: LibraryItem): boolean => type === 'anime' && item.anime_type === ANIME_FILM;

/**
 * The ids this tab takes off the show half's hands.
 *
 * The show half still indexes these — 20 sit on `Sheet1` rows — but must stop
 * reporting the rest as titles missing a row, which is what they stopped being
 * the moment this tab started placing them.
 */
export const animeFilmIds = (library: Library | null | undefined): Set<number> => {
  const out = new Set<number>();
  for (const [id, { type, item }] of library ?? []) if (isAnimeFilm(type, item)) out.add(id);
  return out;
};

/**
 * Every film in the library, keyed by SIMKL id — including `plantowatch` and
 * `dropped` ones, which are never inserted but whose ids must still be known,
 * so a row someone added by hand is recognised rather than duplicated.
 */
export const indexFilms = (library: Library | null | undefined): Map<number, FilmProgress> => {
  const out = new Map<number, FilmProgress>();
  for (const [id, { type, item }] of library ?? []) {
    const anime = isAnimeFilm(type, item);
    if (type !== 'movies' && !anime) continue;
    // Anime nests its title under `show`, the way every other anime record
    // does, and carries `runtime` there as the whole film's length.
    const movie = item.movie ?? item.show;
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
      anime,
    });
  }
  return out;
};

/** Whether this film should have a row at all. */
export const filmIsWatched = (film: FilmProgress): boolean => film.status === WATCHED_STATUS;
