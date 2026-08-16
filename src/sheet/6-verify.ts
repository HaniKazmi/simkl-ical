/**
 * VERIFY — did the write do exactly what the plan said, and nothing else? Pure.
 *
 * Last of READ → PARSE → PLAN → GUARD → BUILD → APPLY → **VERIFY**, and what
 * decides whether the rollback in `sync.ts` runs.
 *
 * The comparison is on `userEnteredValue`, never `effectiveValue`. Writing a
 * season's `Episode` recalculates five formulas on the show row above it, so
 * `effectiveValue` moves in cells nobody wrote and cannot be compared at all.
 * `userEnteredValue` changes only when someone writes — while the grid holds
 * still. That makes verification an equality check rather than a heuristic, and
 * makes an unplanned change mean one of exactly two things: a concurrent human,
 * or us being wrong about row alignment. Both mean stop. The one exception is a
 * row insert, which makes Sheets rewrite formula text on its own; see
 * `rewritten` below.
 */

import { errorMessage } from '../shared/errors.ts';
import { a1, isFormulaValue, parseGrid, sameValue, type Grid, type HeaderName } from './2-grid.ts';
import type { CellEdit, RowInsert, SheetPlan } from './3-plan.ts';
import type { CellData, ExtendedValue } from '../api/google/types.ts';
import type { SheetSnapshot } from './io/spreadsheet.ts';

/**
 * The columns the diff inspects. Scoping it to the edit columns alone would
 * leave four of the insert's six cells uninspected; scoping it to everything
 * would mean editing the banner URL in `W2` aborts a sync for no reason.
 */
const INSPECTED: HeaderName[] = ['Show', 'Status', 'Season', 'Episode', 'Start', 'End', 'Episodes', 'Length'];

/** Where a pre-existing row ends up once the inserts have been applied. */
export const shiftRow = (row: number, insertRows: number[]): number => row + insertRows.filter((at) => at <= row).length;

/**
 * Whether a formula's text changing is Sheets' doing rather than ours.
 *
 * **`userEnteredValue` is only stable while the grid is.** Inserting a row
 * shifts every row beneath it and Sheets rewrites the relative A1 references in
 * every affected formula to match — `=I609*F609` becomes `=I610*F610`, and each
 * show row's five roll-ups likewise. That is correct behaviour and there is
 * nothing to verify about it. Treating it as an unplanned change flags a
 * thousand cells and, far worse, invites a rollback to write the pre-insert
 * text back — which the accompanying delete then rewrites *again*, one row off.
 *
 * So across a structural change a formula is checked for still being a formula,
 * not for its text. Literals stay strictly compared, which is what actually
 * catches a misalignment: every literal on a season row would move with it.
 */
const rewritten = (was: ExtendedValue | undefined, now: ExtendedValue | undefined): boolean => isFormulaValue(was) && isFormulaValue(now);

const cell = (snapshot: SheetSnapshot, row: number, column: number): CellData | undefined => snapshot.rows[row]?.[column];

const entered = (snapshot: SheetSnapshot, row: number, column: number): ExtendedValue | undefined =>
  cell(snapshot, row, column)?.userEnteredValue;

/**
 * Whether one planned edit is present.
 *
 * Checked at both the offset the cell would occupy if the insert landed and the
 * one it would occupy if it did not — a mismatched row count is exactly the
 * case where which of the two applies is unknown. A cell that already held the
 * planned value is evidence of nothing, so it does not count.
 */
const editLanded = (after: SheetSnapshot, edit: CellEdit, insertRows: number[]): boolean => {
  if (sameValue(edit.previous, edit.value)) return false;
  return [edit.row, shiftRow(edit.row, insertRows)].some((row) => sameValue(entered(after, row, edit.column), edit.value));
};

/**
 * Whether the row an insert was meant to create is there, and is *ours*.
 *
 * Every filled cell must match. `insertDimension` puts the row at exactly the
 * index it was given, so anything short of a full match at that index is a
 * pre-existing row — and the whole reason for asking is that the answer decides
 * what a rollback deletes.
 *
 * Strict on purpose, with a known cost: a concurrent edit to one cell of the
 * brand-new row leaves the insert unrecognised, so the rollback deletes nothing,
 * the paste cannot shrink the grid, and the run freezes with the row still
 * there. That is the safe direction. Loosening it to a partial match trades a
 * rare manual repair for a rarer deletion of a row nobody created.
 */
const insertLanded = (after: SheetSnapshot, insert: RowInsert): boolean =>
  insert.fill.length > 0 && insert.fill.every((cell) => sameValue(entered(after, insert.row, cell.column), cell.value));

export interface Verification {
  ok: boolean;
  problems: string[];
  /**
   * Whether any part of the write reached the sheet.
   *
   * Answered from the planned writes themselves — are they present? — because
   * that is the actual question. Two tempting proxies both get it wrong.
   * Counting *unplanned* changes is backwards for a batch that landed and broke
   * a formula: nothing unplanned moved, yet the write is very much there. Row
   * growth is worse: for a plan containing an insert, a batch that failed
   * atomically leaves the count unchanged, so growth reads as "nothing landed"
   * only by coincidence and as "it landed" whenever a human inserts a row in
   * the same window — and a false "it landed" sends the caller looking for a
   * snapshot tab that rode the same failed batch, which is a permanent freeze
   * over an untouched sheet. `batchUpdate` is atomic, so none of the planned
   * writes being present means the batch never went out, whatever the row count
   * says. Conservatively true only when the sheet could not be inspected at all.
   */
  landed: boolean;
  /** Rows the write created, and only ones this read positively identifies as ours. */
  deleteRows: number[];
}

export const verify = (before: Grid, after: SheetSnapshot, plan: SheetPlan): Verification => {
  const problems: string[] = [];
  const insertRows = plan.inserts.map((i) => i.row);
  const inserted = new Set(insertRows);

  // The header must still mean what it meant. Everything below is indexed by
  // columns resolved from the read *before* the write.
  let afterGrid: Grid;
  try {
    afterGrid = parseGrid(after);
  } catch (err) {
    return { ok: false, problems: [`the sheet no longer parses: ${errorMessage(err)}`], landed: true, deleteRows: [] };
  }
  for (const header of INSPECTED) {
    if (afterGrid.columns[header] !== before.columns[header]) {
      problems.push(`the ${header} column moved during the write`);
    }
  }
  if (problems.length) return { ok: false, problems, landed: true, deleteRows: [] };

  // Both answered before the row-by-row diff, because the `grew` mismatch below
  // returns early and needs them: whether anything landed decides if there is a
  // rollback to do at all, and `created` is the only row a rollback may delete.
  const created = plan.inserts.filter((insert) => insertLanded(after, insert)).map((insert) => insert.row);
  const landed = created.length > 0 || plan.edits.some((edit) => editLanded(after, edit, insertRows));

  const grew = after.rows.length - before.snapshot.rows.length;
  if (grew !== insertRows.length) {
    problems.push(`the sheet grew by ${grew} rows, not ${insertRows.length}`);
    return { ok: false, problems, landed, deleteRows: created };
  }

  const expected = new Map<string, ExtendedValue>();
  for (const edit of plan.edits) expected.set(`${shiftRow(edit.row, insertRows)}:${edit.column}`, edit.value);
  for (const insert of plan.inserts) {
    for (const fill of insert.fill) expected.set(`${insert.row}:${fill.column}`, fill.value);
  }

  const columns = Object.values(before.columns);
  const inspected = new Set(INSPECTED.map((h) => before.columns[h]));
  // Only an insert moves rows, and only moved rows get their formulas rewritten.
  const structural = insertRows.length > 0;

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
      // rows are not the rows we think they are. No formula exemption, because
      // there is nothing to exempt: on the live sheet 0 of 1644 `id` cells are
      // formulas. 21 `Start` cells are, which is a different column.
      if (column === before.columns.id && !sameValue(was, now)) {
        problems.push(`${a1(target, column)}: the id changed`);
        continue;
      }
      if (!inspected.has(column)) continue;

      if (plannedValue) {
        if (!sameValue(now, plannedValue)) problems.push(`${a1(target, column)}: the planned write did not land`);
        expected.delete(key);
        continue;
      }
      if (structural && rewritten(was, now)) continue;
      if (!sameValue(was, now)) problems.push(`${a1(target, column)}: changed without being planned`);
    }
  }

  // --- Inserted rows: exactly the fill, and nothing else.
  for (const row of inserted) {
    for (const column of columns) {
      const now = entered(after, row, column);
      const key = `${row}:${column}`;
      const plannedValue = expected.get(key);
      if (plannedValue) {
        if (!sameValue(now, plannedValue)) problems.push(`${a1(row, column)}: the inserted row's ${column} did not take`);
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

  return { ok: problems.length === 0, problems, landed, deleteRows: problems.length ? created : [] };
};
