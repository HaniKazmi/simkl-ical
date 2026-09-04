/**
 * FOLD — what TMDB said about a film, reduced to the cells a row needs and
 * retained across polls.
 *
 * Much smaller than the show grid's catalogue, and deliberately so. Every
 * column this produces is written once when the row is inserted and never
 * revisited, so there is no refresh cadence to run and nothing here goes
 * stale in a way the sheet could see: a film that has been answered is
 * answered for the life of the process, and asking again could only produce a
 * value nothing would ever write.
 *
 * The absent-versus-null distinction is the same one `runtimeAnswer` makes.
 * **Absent** means the lookup has not answered, so the film waits a poll.
 * **Null** means it answered that nothing is obtainable — no TMDB id, or a
 * 404 — so the film is settled and never asked about again.
 */

import type { TmdbMovie } from '../../api/tmdb/types.ts';
import type { FilmProgress } from './1-index.ts';
import {
  bannerOf,
  certificateOf,
  directorOf,
  franchiseOf,
  genresCell,
  mappedGenres,
  MAX_SECONDARY_GENRES,
  openedInCinemas,
  releaseDateOf,
} from './values.ts';

/** One film's TMDB-derived cells, ready to be written. */
export interface FilmFacts {
  /** The primary genre. Null when nothing in TMDB's list maps into the vocabulary. */
  genre: string | null;
  /** The secondaries, already joined the way the cell spells them. Empty string for none. */
  genres: string;
  /** The BBFC certificate as a minimum age, or null to leave the cell blank. */
  certificate: number | null;
  releaseDate: Temporal.PlainDate | null;
  /** The day it opened in GB cinemas, which decides `Cinema` against the watch date. */
  openedInCinemas: Temporal.PlainDate | null;
  franchise: string;
  director: string | null;
  banner: string | null;
}

/**
 * A payload reduced. `title` is SIMKL's, not TMDB's: the `Name` column is what
 * the rest of the sheet and the library are keyed to a reader by, and the two
 * disagree on 18 of 347 rows.
 */
export const filmFacts = (movie: TmdbMovie | undefined, title: string): FilmFacts => {
  const genres = mappedGenres(movie);
  return {
    genre: genres[0] ?? null,
    genres: genresCell(genres.slice(1, 1 + MAX_SECONDARY_GENRES)),
    certificate: certificateOf(movie),
    releaseDate: releaseDateOf(movie),
    openedInCinemas: openedInCinemas(movie),
    franchise: franchiseOf(movie, title),
    director: directorOf(movie),
    banner: bannerOf(movie),
  };
};

/**
 * What TMDB has said so far, retained across polls. Process-local; a restart
 * re-asks, which costs one request per film still missing a row.
 */
export class FilmStore {
  /** Absent: unanswered. Null: settled, nothing obtainable. */
  readonly films = new Map<number, FilmFacts | null>();

  /**
   * Fold a round of lookups back in.
   *
   * The stamping rule is `foldCatalogue`'s, for its reason: a **settled**
   * answer is always recorded — "gone" included — because an unrecorded key
   * would be re-requested every poll forever; a **retryable** failure is never
   * recorded, so the next poll asks again.
   */
  fold(
    requests: readonly { id: number; title: string }[],
    { films, unavailable }: { films: Map<number, TmdbMovie>; unavailable: readonly number[] },
  ): void {
    for (const request of requests) {
      const movie = films.get(request.id);
      if (movie) this.films.set(request.id, filmFacts(movie, request.title));
    }
    // A 404 is TMDB not knowing this film, which no amount of asking changes.
    for (const id of unavailable) if (!this.films.has(id)) this.films.set(id, null);
  }

  /**
   * Settle every pending film as unobtainable. The answer to a **rejected
   * credential** only — never an outage, which would strand every film's row
   * on one bad minute.
   */
  settleUnusable(requests: readonly { id: number }[]): void {
    for (const request of requests) if (!this.films.has(request.id)) this.films.set(request.id, null);
  }

  /**
   * Films the library gives no TMDB id, reported once rather than every poll.
   *
   * Not `films.set(id, null)`: that is "TMDB has nothing and never will", and
   * what is missing here is SIMKL's *id*, which SIMKL fills in over time. Filed
   * as settled, a film mapped an hour later would wait for a restart. Kept
   * apart, so the next poll re-checks the library — free, since no lookup is
   * made either way — and only the report stays quiet.
   */
  noteUnidentifiable(film: FilmProgress): boolean {
    if (film.tmdbId !== null || this.unidentified.has(film.id)) return false;
    this.unidentified.add(film.id);
    return true;
  }

  /** Films already reported as carrying no TMDB id. Observational, never a gate. */
  private readonly unidentified = new Set<number>();
}
