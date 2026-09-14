/**
 * The rules both tabs' guards re-derive the same way, in one copy.
 *
 * A guard is a checklist of named rules, each re-deriving one claim the
 * planner made against the snapshot the plan was built from. Most of those
 * rules are about the tab: which fields may be written, what a season row or a
 * film row must look like, what value a column accepts. Those live in
 * `5-guard.ts` and `movies/5-guard.ts`, whose whitelists are each tab's own
 * spec. What is here names no field and belongs to neither tab: the budget, and
 * the admission step both planners take a candidate through against it; the
 * shape every written cell has; and the alignment check — is this address the
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
import type { PlannedCell, PlannedWrites } from './6-requests.ts';
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
 * Which budget a set of writes crosses, and by how much, or null where it
 * crosses neither.
 *
 * The two count different things. `maxEdits` counts cells written into rows
 * that already exist — an insert's fill is not among them, so a fifteen-season
 * block is a hundred cells and zero edits. `maxRows` counts every distinct row
 * touched, an insert's whole span included, and is the one bound an insert
 * meets. An operator lowering `SHEET_MAX_EDITS` therefore caps what a poll may
 * change on the rows the sheet has, and `SHEET_MAX_ROWS` how much it may add.
 *
 * **One arithmetic, for the guard's refusal and both planners' admission step.**
 * Each planner takes rows while the run still fits, and the guard refuses a run
 * that does not — so a second copy of the counting would let the two disagree:
 * loose in the planner, every poll is refused whole over rows the guard counted
 * differently; loose in the guard, the blast radius is not the number it names.
 * The two budgets bind on different backlogs, which is why both are counted — a
 * hundred rows each gaining one cell cross `SHEET_MAX_ROWS` first, where a
 * handful of closing rows at four cells apiece cross `SHEET_MAX_EDITS` first.
 */
export const budgetProblem = (
  plan: PlannedWrites,
  { maxEdits, maxRows, spent }: { maxEdits: number; maxRows: number; spent: SpentBudget },
): string | null => {
  const edits = plan.edits.length + spent.edits;
  if (edits > maxEdits) {
    return `${edits} edits this poll exceeds SHEET_MAX_EDITS=${maxEdits}. Nothing written; the report lists every proposed edit.`;
  }
  const rows = rowsTouched(plan) + spent.rows;
  return rows > maxRows ? `${rows} distinct rows this poll exceeds SHEET_MAX_ROWS=${maxRows}.` : null;
};

/** What a budget is measured against: the poll's two ceilings, and what an earlier half already sent. */
export interface Budgets {
  maxEdits: number;
  maxRows: number;
  spent: SpentBudget;
}

/**
 * How many more distinct rows a plan may touch before it crosses the row
 * budget — `budgetProblem`'s arithmetic read the other way round, for the one
 * caller that sizes a write to the room rather than measuring a finished one:
 * a block lands whole or not at all, so the block walk cuts it to this before
 * building it. Derived anywhere else, the two counts disagree exactly where
 * `rowsTouched` folds a span row onto an edited one, and the guard then refuses
 * whole a block the planner sized.
 */
export const rowsRemaining = (plan: PlannedWrites, { maxRows, spent }: Budgets): number => maxRows - spent.rows - rowsTouched(plan);

/** The parts of a plan the admission step reads and merges — what both tabs' plans hold. */
export interface Admissible<E extends PlannedCell, I extends { row: number }, S> {
  edits: E[];
  insert: I | null;
  skips: S[];
  notes: string[];
  deferred: number;
}

/**
 * One piece of work a run may not have room for: what it would write, and what
 * has to happen if the poll's budgets cannot take it.
 *
 * Built as a closure rather than as a finished edit set, because what a
 * candidate costs is only known once it is built, and a per-row figure guessed
 * in advance is wrong in the direction that matters: too low admits a row whose
 * cells the guard then refuses *whole*, which is the outcome the admission step
 * exists to prevent.
 *
 * `defer` is what a candidate owes when it is held back — the withdrawals no
 * build ran to make. Optional, because most candidates owe nothing: the
 * admission step shares `observed` with the run, so anything a rejected build
 * banked is already out of the record and the next poll sees it as moved.
 */
export interface Rationed<T> {
  write: (out: T) => void;
  defer?: () => void;
}

/**
 * Take a candidate's plan into the run's only if the whole run still fits the
 * poll's budgets. **One admission for both tabs**, on the same arithmetic the
 * guard refuses at, so what either planner stops short of is exactly what the
 * guard would have refused.
 *
 * Both budgets are measured, because they bind on different backlogs: a
 * hundred rows each gaining one cell cross `SHEET_MAX_ROWS` first, where a
 * handful of closing rows at four cells apiece cross `SHEET_MAX_EDITS` first.
 * The run's insert or the candidate's, never both: only the insert tier
 * proposes one, and it admits a single candidate. Counted here rather than off
 * the run alone, or a span would pass a rows check that never measured it and
 * then be dropped when the candidate committed.
 *
 * The candidate's skips are merged whatever the verdict: they are observations
 * about the row — a hand-typed count, a stamp out of range — and a poll with no
 * room for the row still owes the report its diagnosis, where dropping them
 * leaves only the tier's aggregate line until a poll with room re-plans it.
 * Its notes are not: a note may describe a write, and a rejected candidate is
 * making none.
 */
export const admitPlan = <E extends PlannedCell, I extends { row: number }, S>(
  run: Admissible<E, I, S>,
  candidate: Admissible<E, I, S>,
  budgets: Budgets,
  span: (insert: I) => NonNullable<PlannedWrites['insert']>,
): boolean => {
  run.skips.push(...candidate.skips);
  const edits = [...run.edits, ...candidate.edits];
  const insert = run.insert ?? candidate.insert;
  if (budgetProblem({ edits, insert: insert === null ? null : span(insert) }, budgets) !== null) return false;

  run.edits = edits;
  run.insert = insert;
  run.notes.push(...candidate.notes);
  run.deferred += candidate.deferred;
  return true;
};

/**
 * Take a tier's candidates in order, while the poll's budgets have room, and
 * leave the rest for a later poll.
 *
 * Every candidate is built, even once a budget is full, and there is no cheap
 * exit to be had: a candidate's cost is known only once it is built, and one
 * that turns out to write nothing — a row whose dates did not move, a count
 * cell holding text — has to be admitted rather than counted as work waiting,
 * or the run asks for another poll to do nothing on. Building is pure and the
 * run's own plan never grows past the budget, so the measurement stays small
 * whatever the backlog.
 *
 * What a held-back candidate must do is leave nothing of itself recorded — a
 * value recorded at a figure the sheet never received is a change the next
 * poll finds unmoved and loses for good. That is `Rationed.defer`, and the
 * admission step has already done it for anything the rejected build banked,
 * since the two share `observed`.
 *
 * One note per tier, not one per row: a library marked whole would otherwise
 * put a line per row into a report read beside the sheet.
 */
export const admitTier = <T>(
  plan: { deferred: number; notes: string[] },
  candidates: readonly Rationed<T>[],
  admit: (build: (out: T) => void) => boolean,
  held: (count: number) => string,
): void => {
  let count = 0;
  for (const candidate of candidates) {
    if (admit(candidate.write)) continue;
    plan.deferred += 1;
    count += 1;
    candidate.defer?.();
  }
  if (count) plan.notes.push(held(count));
};

/**
 * Over budget refuses the whole plan; it never truncates. The budget is a
 * blast radius for the poll, not an allowance per tab, so what earlier halves
 * sent counts too.
 */
export const checkBudgets = (
  plan: PlannedWrites,
  budget: { maxEdits: number; maxRows: number; spent: SpentBudget },
  refuse: Refuse,
): void => {
  const problem = budgetProblem(plan, budget);
  if (problem !== null) refuse(problem);
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
 * Where a planned cell says it goes, against where the header map puts its
 * field: a field the tab does not carry has no position to write at, and a
 * column that disagrees with the resolved one is a value landing in whatever
 * column now sits there.
 *
 * Its own check because one caller reaches it without the rest of the shape
 * rules: the batch that creates a show row writes the roll-up formulas, which
 * are compared against a template rather than refused as formulas — and a
 * template checked at an unverified column counts a block's height off the
 * wrong column for the life of the row.
 */
export const checkCellPosition = <H extends string>(
  cell: GuardedCell<H>,
  columns: Partial<Record<H, number>>,
  refuse: Refuse,
): void => {
  const where = `${cell.address} (${cell.field})`;
  const column = columns[cell.field];
  if (column === undefined) refuse(`${where}: ${cell.field} has no resolved column on this tab.`);
  if (cell.column !== column) {
    refuse(`${where}: column ${cell.column} does not match the resolved position of ${cell.field}.`);
  }
};

/**
 * One cell write's shape, existing row or not: a whitelisted field, at the
 * column the header map resolves, holding a finite literal — or absent, where
 * the field may be emptied. Absent empties the cell and nothing else does, so
 * an absent value outside the emptiable set is a planner that lost one.
 *
 * **A planned formula is refused unconditionally**, which is the
 * never-write-a-formula rule applied to the value rather than to the target.
 * On the show grid every derived cell on a show row rolls up from the season
 * rows beneath it, so a formula written into one replaces a live roll-up with
 * a frozen number that nothing would ever notice — and an insert has no target
 * cell at all for `checkCellAlignment` to catch it on. The one exception is the
 * batch that *creates* a show row, which writes the roll-ups themselves; those
 * cells are checked against the template instead of coming through here.
 *
 * `columns` is partial because a tab need not carry every field this can be
 * asked about: the six block columns are optional on the Shows tab, and a field
 * whose column is unresolved has no position to write at.
 *
 * Returns the value for the caller's per-column rules, or undefined for an
 * accepted clear, which has no value to check.
 */
export const checkCellShape = <H extends string>(
  cell: GuardedCell<H>,
  { allowed, emptiable, columns }: { allowed: Set<H>; emptiable: Set<H>; columns: Partial<Record<H, number>> },
  refuse: Refuse,
): ExtendedValue | undefined => {
  const where = `${cell.address} (${cell.field})`;

  if (!allowed.has(cell.field)) refuse(`${where}: not a field this sync may write.`);
  checkCellPosition(cell, columns, refuse);

  const value = cell.value;
  if (value === undefined) {
    if (!emptiable.has(cell.field)) refuse(`${where}: not a field this sync may empty.`);
    return undefined;
  }
  if (value.formulaValue !== undefined) refuse(`${where}: a formula is never written.`);
  if (value.numberValue !== undefined && !Number.isFinite(value.numberValue)) refuse(`${where}: not a finite number.`);
  return value;
};

/**
 * The alignment rules — what catches a plan built against a different grid,
 * the one failure that produces real writes in wrong places.
 *
 * The formula refusal is unconditional. On the show grid every derived cell on
 * a show row is a formula rolling up from the season rows — its artwork link
 * included — and writing one replaces a live roll-up with a frozen number that
 * nothing would ever notice; the films tab carries no formula today, and one
 * hand-written cell is all it takes, so the rule has to hold rather than be
 * assumed.
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
