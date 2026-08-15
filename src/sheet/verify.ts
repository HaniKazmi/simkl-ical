/**
 * Did the write do exactly what the plan said, and nothing else? Pure.
 *
 * The comparison is on `userEnteredValue`, never `effectiveValue`. Writing a
 * season's `Episode` recalculates five formulas on the show row above it, so
 * `effectiveValue` moves in cells nobody wrote and cannot be compared at all.
 * `userEnteredValue` changes **only when someone writes** — which turns
 * verification into an equality check rather than a heuristic, and makes any
 * unplanned change mean one of exactly two things: a concurrent human, or us
 * being wrong about row alignment. Both mean stop.
 */

import { errorMessage } from '../errors.ts';
import { a1, parseGrid, type Grid, type HeaderName } from './grid.ts';
import type { Restore } from './safety.ts';
import type { SheetPlan } from './plan.ts';
import type { CellData, ExtendedValue } from '../sheets/types.ts';
import type { SheetSnapshot } from '../sources/sheet.ts';

/**
 * The columns the diff inspects. Scoping it to the edit columns alone would
 * leave four of the insert's six cells uninspected; scoping it to everything
 * would mean editing the banner URL in `W2` aborts a sync for no reason.
 */
const INSPECTED: HeaderName[] = ['Show', 'Status', 'Season', 'Episode', 'Start', 'End', 'Episodes', 'Length'];

/** Where a pre-existing row ends up once the inserts have been applied. */
export const shiftRow = (row: number, insertRows: number[]): number => row + insertRows.filter((at) => at <= row).length;

const same = (a: ExtendedValue | undefined, b: ExtendedValue | undefined): boolean => {
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  return a.numberValue === b.numberValue && a.stringValue === b.stringValue && a.boolValue === b.boolValue && a.formulaValue === b.formulaValue;
};

const cell = (snapshot: SheetSnapshot, row: number, column: number): CellData | undefined => snapshot.rows[row]?.[column];

const entered = (snapshot: SheetSnapshot, row: number, column: number): ExtendedValue | undefined =>
  cell(snapshot, row, column)?.userEnteredValue;

export interface Verification {
  ok: boolean;
  problems: string[];
  /** Cells to put back, in *post-insert* coordinates. Derived from what changed, not from the plan. */
  restores: Restore[];
  /** Rows the write created, and only ones this read positively identifies as ours. */
  deleteRows: number[];
}

export const verify = (before: Grid, after: SheetSnapshot, plan: SheetPlan): Verification => {
  const problems: string[] = [];
  const restores: Restore[] = [];
  const insertRows = plan.inserts.map((i) => i.row);
  const inserted = new Set(insertRows);

  // The header must still mean what it meant. Everything below is indexed by
  // columns resolved from the read *before* the write.
  let afterGrid: Grid;
  try {
    afterGrid = parseGrid(after);
  } catch (err) {
    return { ok: false, problems: [`the sheet no longer parses: ${errorMessage(err)}`], restores: [], deleteRows: [] };
  }
  for (const header of INSPECTED) {
    if (afterGrid.columns[header] !== before.columns[header]) {
      problems.push(`the ${header} column moved during the write`);
    }
  }
  if (problems.length) return { ok: false, problems, restores: [], deleteRows: [] };

  const grew = after.rows.length - before.snapshot.rows.length;
  if (grew !== insertRows.length) {
    problems.push(`the sheet grew by ${grew} rows, not ${insertRows.length}`);
    return { ok: false, problems, restores: [], deleteRows: [] };
  }

  const expected = new Map<string, ExtendedValue>();
  for (const edit of plan.edits) expected.set(`${shiftRow(edit.row, insertRows)}:${edit.column}`, edit.value);
  for (const insert of plan.inserts) {
    for (const fill of insert.fill) expected.set(`${insert.row}:${fill.column}`, fill.value);
  }

  const columns = Object.values(before.columns);
  const inspected = INSPECTED.map((h) => before.columns[h]);

  // --- Pre-existing rows: every inspected cell must be unchanged, or changed
  //     to exactly what was planned.
  for (let row = 0; row < before.snapshot.rows.length; row += 1) {
    const target = shiftRow(row, insertRows);
    for (const column of columns) {
      const was = entered(before.snapshot, row, column);
      const now = entered(after, target, column);
      const key = `${target}:${column}`;
      const plannedValue = expected.get(key);

      // The join key is never written by design, so any change to it means the
      // rows are not the rows we think they are.
      if (column === before.columns.id && !same(was, now)) {
        problems.push(`${a1(target, column)}: the id changed`);
        restores.push({ row: target, column, value: was });
        continue;
      }
      if (!inspected.includes(column)) continue;

      if (plannedValue) {
        if (!same(now, plannedValue)) problems.push(`${a1(target, column)}: the planned write did not land`);
        expected.delete(key);
        continue;
      }
      if (!same(was, now)) {
        problems.push(`${a1(target, column)}: changed without being planned`);
        restores.push({ row: target, column, value: was });
      }
    }
  }

  // --- Inserted rows: exactly the fill, and nothing else.
  for (const row of inserted) {
    for (const column of columns) {
      const now = entered(after, row, column);
      const key = `${row}:${column}`;
      const plannedValue = expected.get(key);
      if (plannedValue) {
        if (!same(now, plannedValue)) problems.push(`${a1(row, column)}: the inserted row's ${column} did not take`);
        expected.delete(key);
        continue;
      }
      if (now !== undefined) problems.push(`${a1(row, column)}: the inserted row carries a value nothing planned`);
    }
  }

  for (const key of expected.keys()) problems.push(`the write planned for ${key} is not in the sheet`);

  // --- The block structure must be intact. A show row whose title went missing
  //     silently merges two blocks, and every roll-up formula with it.
  const beforeShowRows = before.blocks.map((b) => shiftRow(b.row, insertRows)).join(',');
  const afterShowRows = afterGrid.blocks.map((b) => b.row).join(',');
  if (beforeShowRows !== afterShowRows) problems.push('the set of show rows changed');

  // --- A formula that broke. Free, because the read already carries it.
  for (let row = 0; row < after.rows.length; row += 1) {
    const source = inserted.has(row) ? undefined : row - insertRows.filter((at) => at <= row).length;
    for (const column of columns) {
      if (!cell(after, row, column)?.effectiveValue?.errorValue) continue;
      const had = source === undefined ? false : Boolean(cell(before.snapshot, source, column)?.effectiveValue?.errorValue);
      if (!had) problems.push(`${a1(row, column)}: now holds an error value`);
    }
  }

  return { ok: problems.length === 0, problems, restores, deleteRows: problems.length ? [...inserted] : [] };
};
