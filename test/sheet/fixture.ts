/**
 * The sheet-grid fixture builder, shared by every suite that needs a grid.
 *
 * Rows are *named*, and every helper takes the name: `fx.cell('fargoS2', …)`
 * rather than `cell(3, …)`. A bare index means nothing to a reader and
 * re-points silently when a row is added above it — and the guard suite is
 * where a wrong row index is the catastrophic failure the whole subsystem
 * exists to prevent. `cell` is also the only thing giving `previous` its real
 * value from the snapshot; a hand-built copy makes every "no longer holds what
 * the plan was built on" assertion pass vacuously.
 *
 * Not in `helpers.ts`, which would have to import plan types to host this. The
 * `test/**` glob only collects `*.test.ts`, so this file is never run as a suite.
 */

import { a1, parseGrid, type Grid, type HeaderName } from '../../src/sheet/2-grid.ts';
import { dateSerial } from '../../src/sheet/values.ts';
import type { CellEdit, RowInsert, SheetPlan } from '../../src/sheet/4-plan.ts';
import type { ExtendedValue } from '../../src/api/google/types.ts';
import { seasonRow, SHEET_HEADERS, sheetSnapshot, showRow, type CellSpec } from '../helpers.ts';

export const H = SHEET_HEADERS;

/**
 * A date serial the guard will accept: today, so nothing is implausibly future.
 * Named in UTC rather than sliced off an instant, which is the same value said
 * out loud instead of by accident.
 */
export const TODAY = dateSerial(Temporal.Now.plainDateISO('UTC'));

export interface NamedRow {
  name: string | null;
  cells: CellSpec[];
}

export const show = (
  name: string | null,
  title: string,
  { status = 'Ended' as string | null, id = 1 as number | string | null, type = 'show' } = {},
): NamedRow => ({ name, cells: showRow(title, status, id, type) });

export const season = (
  name: string | null,
  number: number,
  episode: number | null,
  end: number | null,
  options: { id?: number | string | null; start?: number; episodes?: number | null } = {},
): NamedRow => ({ name, cells: seasonRow(number, episode, end, options) });

/** An arbitrary row, for shapes `show`/`season` cannot say. */
export const raw = (name: string | null, cells: CellSpec[]): NamedRow => ({ name, cells });

export interface GridFixture {
  grid: Grid;
  /** The specs behind the snapshot, for suites that mutate a copy the way a real write would. */
  rows: CellSpec[][];
  /** Row name → snapshot row index. */
  at: Record<string, number>;
  /** Row name → the index just under it — where an insert between rows lands. */
  below: Record<string, number>;
  /** One past the last row: where an insert at the end of the sheet lands. */
  end: number;
  /** An edit whose `previous` comes from the snapshot, the way the planner builds one. */
  cell(row: string | number, field: HeaderName, value: ExtendedValue, previous?: ExtendedValue): CellEdit;
  /** A well-formed insert at a row index or just under a named row. */
  insertAt(row: string | number, season: number, options?: InsertOptions): RowInsert;
}

export interface InsertOptions {
  title?: string;
  episodes?: number | null;
  end?: number | null;
}

/** The header row is implicit: it is row 0 of every grid, never named. */
export const gridFixture = (...named: NamedRow[]): GridFixture => {
  const rows: CellSpec[][] = [H, ...named.map((r) => r.cells)];
  const at = Object.fromEntries(named.flatMap((r, i) => (r.name === null ? [] : [[r.name, i + 1]])));
  const below = Object.fromEntries(Object.entries(at).map(([name, index]) => [name, index + 1]));
  const grid = parseGrid(sheetSnapshot(rows));

  const indexOf = (row: string | number): number => {
    if (typeof row === 'number') return row;
    const index = at[row];
    if (index === undefined) throw new Error(`no fixture row named ${row}`);
    return index;
  };

  const cell = (row: string | number, field: HeaderName, value: ExtendedValue, previous?: ExtendedValue): CellEdit => {
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

  /**
   * The two options are the states `planInsert` produces: `episodes: null`
   * omits the cell, which is what a row left for its close to fill looks like,
   * and `end` dates the row in the same fill, which is what a season already
   * over gets.
   */
  const insertAt = (row: string | number, season: number, { title = 'Fargo', episodes = 0.0153, end = null }: InsertOptions = {}): RowInsert => {
    const index = indexOf(row);
    return {
      row: index,
      title,
      season,
      fill: (
        [
          ['Season', { numberValue: season }],
          ['Episode', { numberValue: 4 }],
          ['Start', { numberValue: TODAY - 10 }],
          ...(episodes === null ? [] : [['Episodes', { numberValue: episodes }] as [HeaderName, ExtendedValue]]),
          ['Length', { formulaValue: `=G${index + 1}*D${index + 1}` }],
          ...(end === null ? [] : [['End', { numberValue: end }] as [HeaderName, ExtendedValue]]),
        ] as Array<[HeaderName, ExtendedValue]>
      ).map(([field, value]) => ({ row: index, column: grid.columns[field], field, previous: undefined, value, address: a1(index, grid.columns[field]), note: 'new' })),
      note: 'new row',
    };
  };

  return { grid, rows, at, below, end: rows.length, cell, insertAt };
};

export const planOf = (edits: CellEdit[] = [], insert: RowInsert | null = null): SheetPlan => ({
  edits,
  insert,
  skips: [],
  notes: [],
  deferredInserts: 0,
});

/**
 * The one fixture most suites plan against: one show, a closed season and an
 * open one. Suites needing another shape build their own with `gridFixture`.
 */
export const fx = gridFixture(
  show('fargo', 'Fargo', { status: 'Ended' }),
  season('fargoS1', 1, 6, 44000),
  season('fargoS2', 2, 3, null),
);
