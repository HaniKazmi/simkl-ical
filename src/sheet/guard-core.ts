/**
 * The rules both tabs' guards re-derive the same way, in one copy.
 *
 * A guard is a checklist of named rules, each re-deriving one claim the
 * planner made against the snapshot the plan was built from. Most of those
 * rules are about the tab: which fields may be written, what a season row or a
 * film row must look like, what value a column accepts. Those live in
 * `5-guard.ts` and `movies/5-guard.ts`, whose whitelists are each tab's own
 * spec. What is here reads no field name and no tab rule: the budget, the
 * shape every written cell has, and the alignment check — is this address the
 * row the plan thinks it is — which is the one rule that catches a plan built
 * against a different grid, the one catastrophic failure the feature has.
 *
 * One copy because a rule like that hardened in one guard and not the other
 * fails nothing: the other tab stays on the old behaviour and no test notices.
 *
 * Every check takes the caller's `refuse`, so each guard throws its own error
 * class and the messages are the guard's to phrase.
 */

import type { ExtendedValue } from '../api/google/types.ts';
import { isFormula, sameValue } from './2-grid.ts';
import type { SheetSnapshot } from './io/spreadsheet.ts';
import type { PlannedWrites } from './6-requests.ts';
import { rowsTouched } from './6-requests.ts';

/**
 * What a guard throws. Each tab's guard subclasses it, so the loop that runs
 * both can tell a refusal — reported, and no reason to retry — from a bug,
 * which propagates.
 */
export class PlanRefusal extends Error {}

/**
 * Annotated as a type rather than inferred from an arrow: only a declared
 * `never` return makes TypeScript narrow at call sites, letting checks read as
 * straight-line assertions rather than defensive `?.` chains.
 */
export type Refuse = (message: string) => never;

/** What earlier halves of the poll already sent, counted against the same budget. */
export interface SpentBudget {
  edits: number;
  rows: number;
}

export const describeValue = (value: ExtendedValue | undefined): string => {
  if (value === undefined) return '(empty)';
  if (value.formulaValue !== undefined) return value.formulaValue;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.numberValue !== undefined) return String(value.numberValue);
  if (value.boolValue !== undefined) return String(value.boolValue);
  return JSON.stringify(value);
};

/**
 * Over budget refuses the whole plan; it never truncates. The budget is a
 * blast radius for the poll, not an allowance per tab, so what earlier halves
 * sent counts too.
 */
export const checkBudgets = (
  plan: PlannedWrites,
  { maxEdits, maxRows, spent }: { maxEdits: number; maxRows: number; spent: SpentBudget },
  refuse: Refuse,
): void => {
  const edits = plan.edits.length + spent.edits;
  if (edits > maxEdits) {
    refuse(`${edits} edits this poll exceeds SHEET_MAX_EDITS=${maxEdits}. Nothing written; the report lists every proposed edit.`);
  }
  const rows = rowsTouched(plan) + spent.rows;
  if (rows > maxRows) refuse(`${rows} distinct rows this poll exceeds SHEET_MAX_ROWS=${maxRows}.`);
};

/** What the shape and alignment rules read off a planned cell. */
export interface GuardedCell<H extends string> {
  row: number;
  column: number;
  field: H;
  address: string;
  previous: ExtendedValue | undefined;
  value: ExtendedValue | undefined;
}

/**
 * One cell write's shape, existing row or not: a whitelisted field, at the
 * column the header map resolves, holding a finite value — or absent, where the
 * field may be emptied. Absent empties the cell and nothing else does, so an
 * absent value outside the emptiable set is a planner that lost one.
 *
 * Returns the value for the caller's per-column rules, or undefined for an
 * accepted clear, which has no value to check.
 */
export const checkCellShape = <H extends string>(
  cell: GuardedCell<H>,
  { allowed, emptiable, columns }: { allowed: Set<H>; emptiable: Set<H>; columns: Record<H, number> },
  refuse: Refuse,
): ExtendedValue | undefined => {
  const where = `${cell.address} (${cell.field})`;

  if (!allowed.has(cell.field)) refuse(`${where}: not a field this sync may write.`);
  if (cell.column !== columns[cell.field]) {
    refuse(`${where}: column ${cell.column} does not match the resolved position of ${cell.field}.`);
  }

  const value = cell.value;
  if (value === undefined) {
    if (!emptiable.has(cell.field)) refuse(`${where}: not a field this sync may empty.`);
    return undefined;
  }
  if (value.numberValue !== undefined && !Number.isFinite(value.numberValue)) refuse(`${where}: not a finite number.`);
  return value;
};

/**
 * The alignment rules — what catches a plan built against a different grid,
 * the one failure that produces real writes in wrong places.
 *
 * The formula refusal is unconditional. On the show grid every derived cell on
 * a show row is a formula rolling up from the season rows, and writing one
 * replaces a live roll-up with a frozen number that nothing would ever notice;
 * the films tab carries none today, and the copy people read carries one in
 * `Banner`, so the rule has to hold rather than be assumed.
 */
export const checkCellAlignment = <H extends string>(cell: GuardedCell<H>, snapshot: SheetSnapshot, refuse: Refuse): void => {
  const where = `${cell.address} (${cell.field})`;

  // Bounds first: past the end both sides read as undefined, so the value
  // comparison would agree with itself and pass.
  if (cell.row < 0 || cell.row >= snapshot.rows.length) refuse(`${where}: row is outside the snapshot.`);
  const actual = snapshot.rows[cell.row]?.[cell.column];
  if (!sameValue(cell.previous, actual?.userEnteredValue)) {
    refuse(`${where}: the cell no longer holds what the plan was built on.`);
  }
  if (isFormula(actual)) refuse(`${where}: is a formula.`);
};
