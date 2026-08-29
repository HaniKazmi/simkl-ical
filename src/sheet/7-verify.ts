/**
 * VERIFY — did the write do exactly what the plan said, and nothing else?
 * Pure. Decides whether the rollback in `sync.ts` runs.
 *
 * The comparison is on `userEnteredValue`, never `effectiveValue`. Writing a
 * season's `Episode` recalculates five formulas on the show row above, so
 * `effectiveValue` moves in cells nobody wrote and cannot be compared.
 * `userEnteredValue` changes only when someone writes — while the grid holds
 * still — so verification is an equality check, and an unplanned change means
 * exactly one of two things: a concurrent human, or wrong row alignment. Both
 * mean stop. The one exception is a row insert, which makes Sheets rewrite
 * formula text on its own; see `rewritten`.
 */

import { errorMessage } from '../shared/errors.ts';
import { a1, HEADERS, isFormulaValue, parseGrid, sameValue, type Grid, type HeaderName } from './2-grid.ts';
import type { CellEdit, RowInsert, SheetPlan } from './4-plan.ts';
import type { CellData, ExtendedValue } from '../api/google/types.ts';
import type { SheetSnapshot } from './io/spreadsheet.ts';

/**
 * The columns the diff inspects. The edit columns alone would leave four of
 * the insert's six cells uninspected; everything would mean editing the
 * banner URL in `W2` aborts a sync for no reason.
 *
 * Derived rather than listed: forgetting an entry here is a corruption nobody
 * sees — a new header in `HEADERS` would be written by the sync and never
 * inspected. `id` and `Type` are excluded: the sync writes neither, and both
 * carry hand-maintained values a user edits between polls.
 */
const INSPECTED: HeaderName[] = HEADERS.filter((header) => header !== 'id' && header !== 'Type');

/** Where a pre-existing row ends up once the inserts have been applied. */
export const shiftRow = (row: number, insertRows: number[]): number => row + insertRows.filter((at) => at <= row).length;

/**
 * Whether a formula's text changing is Sheets' doing rather than ours.
 *
 * **`userEnteredValue` is only stable while the grid is.** Inserting a row
 * shifts every row beneath it and Sheets rewrites the relative A1 references
 * in every affected formula — `=I609*F609` becomes `=I610*F610`, each show
 * row's five roll-ups likewise. Correct behaviour, nothing to verify.
 * Treating it as unplanned flags a thousand cells and, far worse, invites a
 * rollback to write the pre-insert text back — which the accompanying delete
 * then rewrites *again*, one row off.
 *
 * So across a structural change a formula is checked for still *being* a
 * formula, not for its text. Literals stay strictly compared — what actually
 * catches a misalignment, since every literal on a season row would move.
 */
const rewritten = (was: ExtendedValue | undefined, now: ExtendedValue | undefined): boolean => isFormulaValue(was) && isFormulaValue(now);

const cell = (snapshot: SheetSnapshot, row: number, column: number): CellData | undefined => snapshot.rows[row]?.[column];

const entered = (snapshot: SheetSnapshot, row: number, column: number): ExtendedValue | undefined =>
  cell(snapshot, row, column)?.userEnteredValue;

/**
 * Whether one planned edit is present.
 *
 * Checked at both the offset the cell occupies if the insert landed and the
 * one if it did not — a mismatched row count is exactly when which applies is
 * unknown. A cell that already held the planned value is evidence of nothing,
 * so it does not count.
 */
const editLanded = (after: SheetSnapshot, edit: CellEdit, insertRows: number[]): boolean => {
  if (sameValue(edit.previous, edit.value)) return false;
  return [edit.row, shiftRow(edit.row, insertRows)].some((row) => sameValue(entered(after, row, edit.column), edit.value));
};

/**
 * Whether the row an insert was meant to create is there, and is *ours*.
 *
 * Every filled cell must match: `insertDimension` puts the row at exactly the
 * index it was given, so anything short of a full match there is a
 * pre-existing row — and the answer decides what a rollback deletes.
 *
 * Strict on purpose, with a known cost: a concurrent edit to one cell of the
 * new row leaves the insert unrecognised, the rollback deletes nothing, the
 * paste cannot shrink the grid, and the run freezes with the row still there.
 * That is the safe direction. A partial match trades a rare manual repair for
 * a rarer deletion of a row nobody created.
 */
const insertLanded = (after: SheetSnapshot, insert: RowInsert): boolean =>
  insert.fill.length > 0 && insert.fill.every((cell) => sameValue(entered(after, insert.row, cell.column), cell.value));

export interface Verification {
  ok: boolean;
  problems: string[];
  /**
   * Whether any part of the write reached the sheet.
   *
   * Answered from the planned writes — are they present? — because that is
   * the actual question. Two tempting proxies get it wrong. Counting
   * *unplanned* changes is backwards for a batch that landed and broke a
   * formula: nothing unplanned moved, yet the write is there. Row growth is
   * worse: for a plan with an insert, a batch that failed atomically leaves
   * the count unchanged, so growth reads "nothing landed" only by coincidence
   * and "it landed" whenever a human inserts a row in the same window — and a
   * false "it landed" sends the caller looking for a snapshot tab that rode
   * the same failed batch, a permanent freeze over an untouched sheet.
   * `batchUpdate` is atomic, so no planned write present means the batch
   * never went out, whatever the row count says. Conservatively true only
   * when the sheet could not be inspected at all.
   */
  landed: boolean;
  /** Rows the write created, and only ones this read positively identifies as ours. */
  deleteRows: number[];
}

export const verify = (before: Grid, after: SheetSnapshot, plan: SheetPlan): Verification => {
  const problems: string[] = [];
  const inserts = plan.insert ? [plan.insert] : [];
  const insertRows = inserts.map((i) => i.row);
  const inserted = new Set(insertRows);

  // The header must still mean what it meant: everything below is indexed by
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

  // Answered before the row-by-row diff because the `grew` mismatch below
  // returns early and needs them: `landed` decides whether there is a
  // rollback at all, and `created` is the only row a rollback may delete.
  const created = inserts.filter((insert) => insertLanded(after, insert)).map((insert) => insert.row);
  const landed = created.length > 0 || plan.edits.some((edit) => editLanded(after, edit, insertRows));

  const grew = after.rows.length - before.snapshot.rows.length;
  if (grew !== insertRows.length) {
    problems.push(`the sheet grew by ${grew} rows, not ${insertRows.length}`);
    return { ok: false, problems, landed, deleteRows: created };
  }

  const expected = new Map<string, ExtendedValue>();
  for (const edit of plan.edits) expected.set(`${shiftRow(edit.row, insertRows)}:${edit.column}`, edit.value);
  for (const insert of inserts) {
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

      // The join key is never written by design, so any change means the rows
      // are not the rows we think. No formula exemption — nothing to exempt:
      // on the live sheet 0 of 1644 `id` cells are formulas. 21 `Start` cells
      // are, which is a different column.
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
