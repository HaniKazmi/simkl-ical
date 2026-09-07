/**
 * PARSE — the books tab's snapshot → one row per book. Pure: no config, no
 * clock, no network.
 *
 * The books tab is flat, so this is the films parse's sibling rather than the
 * show grid's: a row is a book and a book is a row, with no block, no season
 * and no roll-up formula.
 *
 * **Nothing under `src/sheet/` reads this and the sync never runs it.** It
 * lives here rather than under `artwork/` because it is composed almost
 * entirely out of `2-grid.ts` — the header search, the column resolution, the
 * cell accessors — and because a reader asking how a tab of this spreadsheet
 * is parsed looks beside `parseGrid` and `parseMovieGrid`. `values.ts` already
 * sets the precedent, holding conventions only the artwork page reads.
 */

import type { CellData } from '../../api/google/types.ts';
import type { SheetSnapshot } from '../io/spreadsheet.ts';
import { findHeaderRow, GridError, isBlank, resolveColumns, titleText } from '../2-grid.ts';
import { parseMovieId } from '../movies/2-grid.ts';
import { ARTWORK_LABEL } from '../values.ts';

/**
 * The columns the artwork page reads, named as fields — eight of the tab's
 * sixteen.
 *
 * Only eight, where `MOVIE_HEADERS` names all sixteen. That tab lists every
 * column because its verifier must cover them: one outside the list is one a
 * concurrent hand could change mid-write with nothing noticing. Nothing
 * verifies this tab — a link write re-reads the single cell it touched — so
 * requiring `Pages` or `Hours` would only make renaming a column the page
 * never looks at a hard failure, which is the reasoning `HEADERS` already
 * follows on the show tab.
 */
export const BOOK_HEADERS = ['Name', 'Author', 'Franchise', 'Release Date', 'Start Date', 'End Date', 'id', 'Banner'] as const;

export type BookHeaderName = (typeof BOOK_HEADERS)[number];

export type BookColumnMap = Record<BookHeaderName, number>;

export const BOOK_LABELS: Record<BookHeaderName, string> = {
  Name: 'Title',
  Author: 'Author',
  Franchise: 'Franchise',
  'Release Date': 'Release Date',
  'Start Date': 'Start Date',
  'End Date': 'End Date',
  id: 'ID',
  Banner: ARTWORK_LABEL,
};

/**
 * What identifies this tab. `Title` alone is too weak — all three tabs carry
 * one — so the second marker is a column only this tab has. `Author` is that
 * column: the films tab's equivalent is `Director` and the show tab has
 * neither.
 */
export const BOOK_HEADER_MARKERS: readonly string[] = [BOOK_LABELS.Name, BOOK_LABELS.Author];

export interface BookRow {
  /** Zero-based index into `snapshot.rows`. */
  row: number;
  name: string | null;
  /** The Hardcover book id. Both the row's identity and its provider id. */
  id: number | null;
}

export interface BookGrid {
  snapshot: SheetSnapshot;
  columns: BookColumnMap;
  rows: BookRow[];
  /**
   * Ids on more than one row. A book the page cannot address unambiguously
   * must not be picked for, so these are forced to `no-id` at the index.
   */
  duplicates: Set<number>;
}

export const parseBookGrid = (snapshot: SheetSnapshot): BookGrid => {
  const { rows } = snapshot;
  const headerRow = findHeaderRow(rows, BOOK_HEADER_MARKERS);
  // The declared width, not the widest row: a truncated read presents a
  // displaced header as *missing*.
  const width = Math.max(snapshot.columnCount, ...rows.map((r) => r.length));
  const columns = resolveColumns(rows[headerRow] ?? [], width, BOOK_HEADERS, (header) => BOOK_LABELS[header]);

  const parsed: BookRow[] = [];
  const seen = new Set<number>();
  const duplicates = new Set<number>();

  for (let row = headerRow + 1; row < rows.length; row += 1) {
    const cells = rows[row] ?? [];
    // The sheet's empty tail. Every other row is a book, however little of it
    // is filled in.
    if (cells.every((cell) => isBlank(cell))) continue;

    // `parseMovieId` rather than a copy: it already reads both `stringValue`
    // and `numberValue`, and this tab needs the second where the films tab
    // stores every one of its ids as the first.
    const id = parseMovieId(cells[columns.id]);
    if (id !== null) {
      if (seen.has(id)) duplicates.add(id);
      else seen.add(id);
    }
    parsed.push({ row, name: titleText(cells[columns.Name]), id });
  }

  return { snapshot, columns, rows: parsed, duplicates };
};

/** The cell at a position in the grid. */
export const bookCellAt = (grid: BookGrid, row: number, column: number): CellData | undefined => grid.snapshot.rows[row]?.[column];

export { GridError };
