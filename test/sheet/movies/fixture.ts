/**
 * Films-tab grids with **named rows**. A bare index re-points silently the
 * moment a row is added above it, and the failure that would hide is the one
 * this whole design exists to prevent.
 */

import { a1 } from '../../../src/sheet/2-grid.ts';
import { parseMovieGrid, type MovieGrid, type MovieHeaderName } from '../../../src/sheet/movies/2-grid.ts';
import { emptyFilmPlan, type FilmCellEdit, type FilmPlan, type FilmRowInsert } from '../../../src/sheet/movies/4-plan.ts';
import { dateSerial } from '../../../src/sheet/values.ts';
import { filmRow, MOVIE_SHEET_HEADERS, sheetSnapshot, type CellSpec, type FilmRowSpec } from '../../helpers.ts';
import type { ExtendedValue } from '../../../src/api/google/types.ts';

export const MH = MOVIE_SHEET_HEADERS;

/** A serial today, in UTC — the zone every fixture here plans in. */
export const TODAY = dateSerial(Temporal.Now.plainDateISO('UTC'));

export interface NamedFilmRow {
  name: string | null;
  cells: CellSpec[];
}

export const film = (name: string, spec: FilmRowSpec = {}): NamedFilmRow => ({
  name,
  cells: filmRow({ name: spec.name ?? name, ...spec }),
});

/** An arbitrary row, for shapes `film` cannot say. */
export const rawFilm = (name: string | null, cells: CellSpec[]): NamedFilmRow => ({ name, cells });

export interface FilmGridFixture {
  grid: MovieGrid;
  rows: CellSpec[][];
  /** Row name → snapshot row index. */
  at: Record<string, number>;
  /** One past the last row: where an insert at the end of the tab lands. */
  end: number;
  /** An edit whose `previous` comes from the snapshot, the way the planner builds one. */
  cell(row: string | number, field: MovieHeaderName, value: ExtendedValue | undefined, previous?: ExtendedValue): FilmCellEdit;
  /** A well-formed insert below the last row. */
  insert(options?: FilmInsertOptions): FilmRowInsert;
}

export interface FilmInsertOptions {
  row?: number;
  id?: number;
  title?: string;
  /** Extra cells beyond the three every film row must carry. */
  extra?: Array<[MovieHeaderName, ExtendedValue]>;
  /** Drop a mandatory cell, to prove the guard demands it. */
  without?: MovieHeaderName;
}

/** The header row is implicit: it is row 0 of every grid, never named. */
export const filmGrid = (...named: NamedFilmRow[]): FilmGridFixture => {
  const rows: CellSpec[][] = [MH, ...named.map((r) => r.cells)];
  const at = Object.fromEntries(named.flatMap((r, i) => (r.name === null ? [] : [[r.name, i + 1]])));
  const grid = parseMovieGrid(sheetSnapshot(rows));

  const indexOf = (row: string | number): number => {
    if (typeof row === 'number') return row;
    const index = at[row];
    if (index === undefined) throw new Error(`no fixture row named ${row}`);
    return index;
  };

  const cell = (
    row: string | number,
    field: MovieHeaderName,
    value: ExtendedValue | undefined,
    previous?: ExtendedValue,
  ): FilmCellEdit => {
    const index = indexOf(row);
    const column = grid.columns[field];
    return {
      row: index,
      column,
      field,
      previous: previous ?? grid.snapshot.rows[index]?.[column]?.userEnteredValue,
      value,
      address: a1(index, column),
      note: 'test',
    };
  };

  const insert = ({ row = rows.length, id = 999, title = 'A New Film', extra = [], without }: FilmInsertOptions = {}): FilmRowInsert => {
    const fields: Array<[MovieHeaderName, ExtendedValue]> = [
      ['Name', { stringValue: title }],
      ['Watch Date', { numberValue: TODAY - 1 }],
      ['id', { stringValue: String(id) }],
      ...extra,
    ].filter(([field]) => field !== without) as Array<[MovieHeaderName, ExtendedValue]>;

    return {
      row,
      id,
      title,
      fill: fields.map(([field, value]) => ({
        row,
        column: grid.columns[field],
        field,
        previous: undefined,
        value,
        address: a1(row, grid.columns[field]),
        note: 'new',
      })),
      note: `add ${title}`,
    };
  };

  return { grid, rows, at, end: rows.length, cell, insert };
};

export const filmPlanOf = (edits: FilmCellEdit[] = [], insert: FilmRowInsert | null = null): FilmPlan => ({
  ...emptyFilmPlan(),
  edits,
  insert,
});

/** The fixture most suites plan against: two films already on the tab. */
export const ffx = filmGrid(
  film('starWars', { name: 'Star Wars', id: 53078, watched: 39487, score: 8, runtime: 121, genre: 'Sci-Fi' }),
  film('nemo', { name: 'Finding Nemo', id: 53080, watched: 38395, score: 6, runtime: 100, genre: 'Adventure' }),
);
