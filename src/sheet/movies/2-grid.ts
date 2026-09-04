/**
 * PARSE — the films tab's snapshot → one row per film. Pure: no config, no
 * clock, no network.
 *
 * The films tab is flat. There is no block, no season and no roll-up formula:
 * a row is a film, and a film is a row. That is why this is a sibling of the
 * show grid's parse rather than a mode of it — the show grid's structure is
 * implicit in which cell is filled, and none of that reasoning has anything to
 * say here.
 */

import type { CellData } from '../../api/google/types.ts';
import type { SheetSnapshot } from '../io/spreadsheet.ts';
import { a1, findHeaderRow, GridError, isBlank, numberOf, resolveColumns, textOf } from '../2-grid.ts';

/**
 * The labels the films sync reads or writes — every column on the tab but the
 * one it never touches.
 *
 * `Anime` is deliberately absent, for the reason `HEADERS` gives for leaving
 * `Genre` out of the show grid: requiring a column nothing reads makes
 * renaming it a hard failure. The 22 rows carrying it came from SIMKL's anime
 * category, which this sync does not pull.
 */
export const MOVIE_HEADERS = [
  'Name',
  'Watch Date',
  'Score',
  'Cinema',
  'Runtime',
  'Genre',
  'Genres',
  'Rating',
  'Release Date',
  'Franchise',
  'Director',
  'id',
  'Banner',
] as const;

export type MovieHeaderName = (typeof MOVIE_HEADERS)[number];

export type MovieColumnMap = Record<MovieHeaderName, number>;

/**
 * The pair that identifies this tab's header row. `Name` alone is too weak —
 * a show grid has no `Name` column, but a future tab might.
 */
const MOVIE_HEADER_MARKERS = ['Name', 'Watch Date'] as const;

export interface MovieRow {
  /** Zero-based index into `snapshot.rows`. */
  row: number;
  /** The `Name` cell. Null when the row carries an id and nothing else. */
  name: string | null;
  /**
   * The SIMKL id, or null when the cell is blank or not a positive integer.
   *
   * The tab stores it as *text* — `{ stringValue: "53078" }` on all 348 rows —
   * so this reads either representation and the write emits the text one. A
   * row with no id is unmatched and is left entirely alone.
   */
  id: number | null;
}

export interface MovieGrid {
  snapshot: SheetSnapshot;
  columns: MovieColumnMap;
  rows: MovieRow[];
  /**
   * Ids appearing on more than one row. Such a row is skipped rather than
   * guessed at: writing a watch date to one of two rows claiming the same film
   * puts it on a coin toss.
   */
  duplicates: Set<number>;
}

/** The id cell, in either representation the tab uses. */
export const parseMovieId = (cell: CellData | undefined): number | null => {
  const text = textOf(cell);
  const n = text !== null ? Number(text) : numberOf(cell);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
};

export const parseMovieGrid = (snapshot: SheetSnapshot): MovieGrid => {
  const { rows } = snapshot;
  const headerRow = findHeaderRow(rows, MOVIE_HEADER_MARKERS);
  // The declared width, not the widest row: a truncated read presents a
  // displaced header as *missing*, which fail-closed turns into a disabled
  // sync.
  const width = Math.max(snapshot.columnCount, ...rows.map((r) => r.length));
  const columns = resolveColumns(rows[headerRow] ?? [], width, MOVIE_HEADERS);

  const parsed: MovieRow[] = [];
  const seen = new Map<number, number>();
  const duplicates = new Set<number>();

  for (let row = headerRow + 1; row < rows.length; row += 1) {
    const cells = rows[row] ?? [];
    // The sheet's empty tail. Every other row is a film, however little of it
    // is filled in — a row with a name and nothing else is one someone started
    // by hand, and the sync must see it so it does not insert a second.
    if (cells.every((cell) => isBlank(cell))) continue;

    const id = parseMovieId(cells[columns.id]);
    if (id !== null) {
      if (seen.has(id)) duplicates.add(id);
      else seen.set(id, row);
    }
    parsed.push({ row, name: textOf(cells[columns.Name]), id });
  }

  return { snapshot, columns, rows: parsed, duplicates };
};

/** The cell at a position in the grid the plan was built from. */
export const movieCellAt = (grid: MovieGrid, row: number, column: number): CellData | undefined =>
  grid.snapshot.rows[row]?.[column];

/** A1 for a film row's field. Reports and logs only; never sent. */
export const movieAddress = (grid: MovieGrid, row: number, field: MovieHeaderName): string => a1(row, grid.columns[field]);

export { GridError };
