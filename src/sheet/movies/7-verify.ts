/**
 * VERIFY — did the write do exactly what the films plan said, and nothing
 * else? Pure. Decides whether the rollback in `io/apply.ts` runs.
 *
 * The comparison is on `userEnteredValue`, never `effectiveValue`, for the
 * reason the show verifier gives: `userEnteredValue` changes only when someone
 * writes, so verification is an equality check and an unplanned change means
 * exactly one of two things — a concurrent human, or wrong row alignment. Both
 * mean stop.
 *
 * The films tab carries no formulas, so the formula-rewriting exemption an
 * insert needs on the show grid has nothing to exempt here. It is kept anyway:
 * the copy people read carries one in `Banner`, an insert would rewrite its
 * references the same way, and a rule that is absent because today's data does
 * not need it is a rule that fails the day the data changes.
 */

import { errorMessage } from '../../shared/errors.ts';
import { a1, isFormulaValue, sameValue } from '../2-grid.ts';
import { MOVIE_HEADERS, parseMovieGrid, type MovieGrid, type MovieHeaderName } from './2-grid.ts';
import type { FilmCellEdit, FilmPlan, FilmRowInsert } from './4-plan.ts';
import type { Verification } from '../7-verify.ts';
import type { CellData, ExtendedValue } from '../../api/google/types.ts';
import type { SheetSnapshot } from '../io/spreadsheet.ts';

/**
 * The columns the diff inspects. Derived rather than listed, so a header added
 * to `MOVIE_HEADERS` is inspected the moment the sync can write it — forgetting
 * an entry here is a corruption nobody sees.
 *
 * `id` is excluded from the *diff* and checked separately below: it is the key
 * every row is matched by, so it earns a rule of its own rather than a line in
 * a loop that skips unwritten columns.
 */
const INSPECTED: MovieHeaderName[] = MOVIE_HEADERS.filter((header) => header !== 'id');

/** Where a pre-existing row ends up once the inserts have been applied. */
const shiftRow = (row: number, insertRows: number[]): number => row + insertRows.filter((at) => at <= row).length;

const rewritten = (was: ExtendedValue | undefined, now: ExtendedValue | undefined): boolean => isFormulaValue(was) && isFormulaValue(now);

const cell = (snapshot: SheetSnapshot, row: number, column: number): CellData | undefined => snapshot.rows[row]?.[column];

const entered = (snapshot: SheetSnapshot, row: number, column: number): ExtendedValue | undefined =>
  cell(snapshot, row, column)?.userEnteredValue;

/**
 * Whether one planned edit is present. Checked at both the offset the cell
 * occupies if the insert landed and the one if it did not — a mismatched row
 * count is exactly when which applies is unknown. A cell that already held the
 * planned value is evidence of nothing.
 */
const editLanded = (after: SheetSnapshot, edit: FilmCellEdit, insertRows: number[]): boolean => {
  if (sameValue(edit.previous, edit.value)) return false;
  return [edit.row, shiftRow(edit.row, insertRows)].some((row) => sameValue(entered(after, row, edit.column), edit.value));
};

/**
 * Whether the row an insert was meant to create is there, and is *ours*. Every
 * filled cell must match: the answer decides what a rollback deletes, and a
 * partial match trades a rare manual repair for a rarer deletion of a row
 * nobody created.
 */
const insertLanded = (after: SheetSnapshot, insert: FilmRowInsert): boolean =>
  insert.fill.length > 0 && insert.fill.every((fill) => sameValue(entered(after, insert.row, fill.column), fill.value));

export const verifyFilms = (before: MovieGrid, after: SheetSnapshot, plan: FilmPlan): Verification => {
  const problems: string[] = [];
  const inserts = plan.insert ? [plan.insert] : [];
  const insertRows = inserts.map((i) => i.row);
  const inserted = new Set(insertRows);

  // The header must still mean what it meant: everything below is indexed by
  // columns resolved from the read *before* the write.
  let afterGrid: MovieGrid;
  try {
    afterGrid = parseMovieGrid(after);
  } catch (err) {
    return { ok: false, problems: [`the films tab no longer parses: ${errorMessage(err)}`], landed: true, deleteRows: [] };
  }
  for (const header of MOVIE_HEADERS) {
    if (afterGrid.columns[header] !== before.columns[header]) problems.push(`the ${header} column moved during the write`);
  }
  if (problems.length) return { ok: false, problems, landed: true, deleteRows: [] };

  const created = inserts.filter((insert) => insertLanded(after, insert)).map((insert) => insert.row);
  const landed = created.length > 0 || plan.edits.some((edit) => editLanded(after, edit, insertRows));

  const grew = after.rows.length - before.snapshot.rows.length;
  if (grew !== insertRows.length) {
    problems.push(`the films tab grew by ${grew} rows, not ${insertRows.length}`);
    return { ok: false, problems, landed, deleteRows: created };
  }

  // Keyed presence, never the value's truthiness — the discipline the show
  // verifier needs for a planned clear. Nothing on this tab is cleared today,
  // and keeping the shape means widening `EMPTIABLE` does not silently make
  // this wrong.
  const expected = new Map<string, ExtendedValue | undefined>();
  for (const edit of plan.edits) expected.set(`${shiftRow(edit.row, insertRows)}:${edit.column}`, edit.value);
  for (const insert of inserts) {
    for (const fill of insert.fill) expected.set(`${insert.row}:${fill.column}`, fill.value);
  }

  const columns = Object.values(before.columns);
  const inspected = new Set(INSPECTED.map((h) => before.columns[h]));
  const structural = insertRows.length > 0;

  // --- Pre-existing rows: every inspected cell unchanged, or changed to
  //     exactly what was planned.
  for (let row = 0; row < before.snapshot.rows.length; row += 1) {
    const target = shiftRow(row, insertRows);
    for (const column of columns) {
      const was = entered(before.snapshot, row, column);
      const now = entered(after, target, column);
      const key = `${target}:${column}`;

      // The id is written only on an insert and never on a row that already
      // exists, so any change to one means the rows are not the rows we think.
      // This is what a row deleted between the read and the write looks like:
      // every row below it shifts up, and every id in the column disagrees.
      if (column === before.columns.id && !sameValue(was, now)) {
        problems.push(`${a1(target, column)}: the id changed`);
        continue;
      }
      if (!inspected.has(column)) continue;

      if (expected.has(key)) {
        if (!sameValue(now, expected.get(key))) problems.push(`${a1(target, column)}: the planned write did not land`);
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
      if (expected.has(key)) {
        if (!sameValue(now, expected.get(key))) problems.push(`${a1(row, column)}: the planned write did not land`);
        expected.delete(key);
        continue;
      }
      if (now !== undefined) problems.push(`${a1(row, column)}: the inserted row carries a value nothing planned`);
    }
  }

  for (const key of expected.keys()) problems.push(`the write planned for ${key} is not in the films tab`);

  // --- The row set must be intact. A film row losing every cell stops being a
  //     row this parse sees, which would leave that film re-inserted next poll.
  const beforeRows = before.rows.map((row) => shiftRow(row.row, insertRows)).join(',');
  const afterRows = afterGrid.rows.filter((row) => !inserted.has(row.row)).map((row) => row.row).join(',');
  if (beforeRows !== afterRows) problems.push('the set of film rows changed');

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
