/**
 * The rules both tabs' guards re-derive the same way, in one copy.
 *
 * A guard is a checklist of named rules, each re-deriving one claim the
 * planner made against the snapshot the plan was built from. Most of those
 * rules are about the tab: which fields may be written, what a season row or a
 * film row must look like, what value a column accepts. Those live in
 * `5-guard.ts` and `movies/5-guard.ts`, whose whitelists are each tab's own
 * spec. What is here names no field and belongs to neither tab: the budget, the
 * shape every written cell has, and the alignment check — is this address the
 * row the plan thinks it is — which is the one rule that catches a plan built
 * against a different grid, the one catastrophic failure the feature has. The
 * `Genres` value rule joins them because the two tabs hold that column under
 * one vocabulary, so each guard says which of its fields is a genre list and
 * this says what a genre list is.
 *
 * One copy because a rule like that hardened in one guard and not the other
 * fails nothing: the other tab stays on the old behaviour and no test notices.
 *
 * Every check takes the caller's `refuse`, so each guard throws its own error
 * class and the messages are the guard's to phrase.
 */

import type { ExtendedValue } from '../api/google/types.ts';
import { isFormula, sameValue } from './2-grid.ts';
import { isGenre, MAX_SECONDARY_GENRES } from './values.ts';
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
 * A `Genres` cell: a comma-separated list of the genres the renderer colours,
 * no longer than the column holds.
 *
 * No secondaries is a real state — 27 rows on the films tab hold it — and
 * `''.split(',')` is `['']`, which is not a genre. Refusing that would make
 * each planner's decision to omit the cell load-bearing for the guard's
 * correctness, which is the coupling these rules exist to avoid.
 */
export const checkGenresValue = (value: ExtendedValue | undefined, where: string, refuse: Refuse): void => {
  const text = value?.stringValue;
  if (typeof text !== 'string') refuse(`${where}: Genres must be text.`);
  if (!text) return;
  const tokens = text.split(',').map((token) => token.trim());
  if (tokens.length > MAX_SECONDARY_GENRES) refuse(`${where}: ${tokens.length} genres exceeds the ${MAX_SECONDARY_GENRES} this column holds.`);
  for (const token of tokens) if (!isGenre(token)) refuse(`${where}: ${token} is not one of the genres the renderer colours.`);
};

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
