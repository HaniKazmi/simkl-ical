/**
 * The one sheet-plan fixture, shared by every suite that needs a grid to plan
 * against.
 *
 * Here rather than in `test/helpers.ts` for the reason that file gives about
 * `showRow`/`seasonRow`, one level up: `grid` is a positional array keyed to
 * `SHEET_HEADERS`, and every suite hard-codes row indices against it — `cell(3,
 * …)` means "the open season", `cell(2, …)` means "the closed one". A second
 * copy that drifts re-points every index in the file that has it, silently, and
 * `4-guard` is where a wrong row index is the catastrophic failure the whole
 * subsystem exists to prevent. `cell` is also the only thing giving `previous`
 * its real value from the snapshot; a drifted copy makes every "no longer holds
 * what the plan was built on" assertion pass vacuously.
 *
 * Not in `helpers.ts` itself, which would have to start importing
 * `SheetPlan`/`CellEdit`/`RowInsert` from `3-plan.ts` to host these. The
 * `test/**` glob only collects `*.test.ts`, so this file is never run as a suite.
 */

import { a1, parseGrid, type Grid, type HeaderName } from '../../src/sheet/2-grid.ts';
import { dateSerial } from '../../src/sheet/1-progress.ts';
import type { CellEdit, RowInsert, SheetPlan } from '../../src/sheet/3-plan.ts';
import type { ExtendedValue } from '../../src/api/google/types.ts';
import { sheetSnapshot, SHEET_HEADERS, type CellSpec, seasonRow, showRow } from '../helpers.ts';

export const H = SHEET_HEADERS;

/** A date serial the guard will accept: today, so nothing is implausibly future. */
export const TODAY = dateSerial(new Date().toISOString().slice(0, 10));

export const show = (title: string, status: string): CellSpec[] => showRow(title, status, 1);
export const season = seasonRow;

/** row 0 header | 1 show | 2 season 1 (closed) | 3 season 2 (open) */
export const ROWS: CellSpec[][] = [H, show('Fargo', 'Ended'), season(1, 6, 44000), season(2, 3, null)];

export const grid: Grid = parseGrid(sheetSnapshot(ROWS));

/** An edit whose `previous` comes from the snapshot, the way the planner builds one. */
export const cell = (row: number, field: HeaderName, value: ExtendedValue, previous?: ExtendedValue): CellEdit => ({
  row,
  column: grid.columns[field],
  field,
  previous: previous ?? grid.snapshot.rows[row]?.[grid.columns[field]]?.userEnteredValue,
  value,
  address: a1(row, grid.columns[field]),
  note: 'test',
});

export const planOf = (edits: CellEdit[] = [], inserts: RowInsert[] = []): SheetPlan => ({
  edits,
  inserts,
  skipped: [],
  notes: [],
  deferred: 0,
});

/** A well-formed insert: every column the whitelist allows, and nothing else. */
export const insertAt = (row: number, season: number, title = 'Fargo'): RowInsert => ({
  row,
  title,
  season,
  fill: (
    [
      ['Season', { numberValue: season }],
      ['Episode', { numberValue: 4 }],
      ['Start', { numberValue: TODAY - 10 }],
      ['Episodes', { numberValue: 0.0153 }],
      ['Length', { formulaValue: `=G${row + 1}*D${row + 1}` }],
    ] as Array<[HeaderName, ExtendedValue]>
  ).map(([field, value]) => ({ row, column: grid.columns[field], field, previous: undefined, value, address: a1(row, grid.columns[field]), note: 'new' })),
  note: 'new row',
});
