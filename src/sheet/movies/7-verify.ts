/**
 * VERIFY — did the write do exactly what the films plan said, and nothing else?
 * Pure. Decides whether the rollback in `io/apply.ts` runs.
 *
 * The rules live in `../7-verify.ts` and are shared with the show grid, because
 * they are the same rules: the comparison is on `userEnteredValue` so an
 * unplanned change means a concurrent human or wrong row alignment, an insert
 * is claimed only when every filled cell matches, and `landed` is answered from
 * the planned writes rather than from row growth. Two copies of that drift
 * apart in silence — hardening one leaves the other on the old behaviour, and
 * nothing fails.
 *
 * What is left here is the five answers this tab gives differently.
 */

import { verifyAgainst, type Verification, type VerifiedTab } from '../7-verify.ts';
import { MOVIE_HEADERS, parseMovieGrid, type MovieGrid, type MovieHeaderName } from './2-grid.ts';
import type { FilmPlan } from './4-plan.ts';
import type { SheetSnapshot } from '../io/spreadsheet.ts';

/**
 * The columns the cell diff inspects. Derived rather than listed, so a header
 * added to `MOVIE_HEADERS` is inspected the moment the sync can write it —
 * forgetting an entry here is a corruption nobody sees.
 *
 * `id` is excluded from the *diff* and checked by a rule of its own: it is the
 * key every row is matched by, so it earns more than a line in a loop that
 * skips unwritten columns. It stays in `headers` below, because a tab whose id
 * column moved is one nothing else can be trusted about.
 */
const INSPECTED: MovieHeaderName[] = MOVIE_HEADERS.filter((header) => header !== 'id');

const FILMS_TAB: VerifiedTab<MovieGrid, MovieHeaderName, FilmPlan> = {
  tab: 'the films tab',
  rowKind: 'film rows',
  parse: parseMovieGrid,
  columnsOf: (grid) => grid.columns,
  snapshotOf: (grid) => grid.snapshot,
  headers: MOVIE_HEADERS,
  inspected: INSPECTED,
  // A film row that lost every cell stops being one, and that film is inserted
  // again on the next poll.
  rowsOf: (grid) => grid.rows.map((row) => row.row),
};

export const verifyFilms = (before: MovieGrid, after: SheetSnapshot, plan: FilmPlan): Verification =>
  verifyAgainst(FILMS_TAB, before, after, plan);
