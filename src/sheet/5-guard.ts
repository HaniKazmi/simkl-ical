/**
 * GUARD — the last thing between a plan and the spreadsheet. Pure.
 *
 * `assertPlanSafe` is a checklist of named rules, each re-deriving one claim
 * the planner made against the snapshot the plan was built from. It throws
 * rather than trimming: the interesting failure is "the planner is wrong",
 * and half of a wrong plan is still wrong.
 *
 * It checks the alignment class *independently* — is this address the row the
 * plan thinks it is — because a misalignment is the one catastrophic failure
 * the subsystem has. The value conventions it shares with the planner
 * (`values.ts`, `runtimeScopeOk`) are one copy on purpose: a bound that
 * exists twice can disagree, and any gap is a whole-plan refusal on good
 * data.
 */

import { config } from '../shared/config.ts';
import { isBlank, isFormula, numberOf, runtimeScopeOk, sameValue, type Grid, type HeaderName, type SeasonRow, type ShowBlock } from './2-grid.ts';
import { maxSerial, ownsNote, plausibleRuntimeDays, plausibleSerial, watchedNoteSerial } from './values.ts';
import type { CellEdit, RowInsert, SheetPlan } from './4-plan.ts';
import type { ExtendedValue } from '../api/google/types.ts';

/** What the sync may write to a row that already exists. */
const EDIT_FIELDS = new Set<HeaderName>(['Status', 'Episode', 'End', 'Episodes']);

/**
 * What may be *emptied* rather than replaced, per whitelist. Its own axis for
 * the same reason the whitelists are two: a new row is filled, never cleared,
 * so an absent value there is a planner that lost one — and a set keeps the
 * rule beside the fields it qualifies, rather than as a field name spelled into
 * the shape check both whitelists share.
 */
const EMPTIABLE_EDITS = new Set<HeaderName>(['Status']);
const EMPTIABLE_INSERTS = new Set<HeaderName>();

/**
 * What it may write into a row it is creating. A *separate* whitelist: an
 * insert fills six columns, and folding the two together would either forbid
 * the insert or widen what an ordinary edit may touch. The whitelists are the
 * guard's own spec, never derived from what the planner emits — derived, one
 * bad emission would widen both at once.
 */
const INSERT_FIELDS = new Set<HeaderName>(['Season', 'Status', 'Episode', 'Start', 'End', 'Episodes', 'Length']);

export class UnsafePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePlanError';
  }
}

// Annotated on the variable, not the arrow: only that form makes TypeScript
// narrow at call sites, letting the checks below read as straight-line
// assertions rather than defensive `?.` chains.
const refuse: (message: string) => never = (message) => {
  throw new UnsafePlanError(message);
};

const describeValue = (value: ExtendedValue | undefined): string =>
  value === undefined ? '(empty)' : (value.formulaValue ?? value.stringValue ?? (value.numberValue !== undefined ? String(value.numberValue) : JSON.stringify(value)));

export interface SafetyLimits {
  maxEdits?: number;
  maxRows?: number;
  now?: Temporal.Instant;
  /**
   * The zone the `End` bound is computed in — must be the one `planSync`
   * used: the serials are local dates, so a guard bounding them in a
   * different zone is off by a day either side.
   */
  timezone?: string;
}

/** Everything the per-cell rules need to know about the grid, resolved once. */
interface GuardContext {
  grid: Grid;
  /** Tomorrow in the viewer's zone — see `maxSerial`. */
  serialCeiling: number;
  showRows: Set<number>;
  /**
   * The block comes along because the runtime rule is about the block, not
   * the row: whether the season number means anything to TVDB is a property
   * of `type` and where the id came from.
   */
  seasonRows: Map<number, { season: SeasonRow; block: ShowBlock }>;
}

// --- Budgets ----------------------------------------------------------------

/** Over budget refuses the whole plan; it never truncates. */
const checkBudgets = (plan: SheetPlan, maxEdits: number, maxRows: number): void => {
  if (plan.edits.length > maxEdits) {
    refuse(`${plan.edits.length} edits exceeds SHEET_MAX_EDITS=${maxEdits}. Nothing written; the report lists every proposed edit.`);
  }
  const rows = new Set([...plan.edits.map((e) => e.row), ...(plan.insert ? [plan.insert.row] : [])]);
  if (rows.size > maxRows) {
    refuse(`${rows.size} distinct rows exceeds SHEET_MAX_ROWS=${maxRows}.`);
  }
};

// --- Rules every written cell obeys -----------------------------------------

/**
 * One cell write's shape, existing row or not: a whitelisted field, at the
 * column the header map resolves, holding a plausible value.
 */
const checkCellShape = (cell: CellEdit, allowed: Set<HeaderName>, emptiable: Set<HeaderName>, { grid, serialCeiling }: GuardContext): void => {
  const where = `${cell.address} (${cell.field})`;

  if (!allowed.has(cell.field)) refuse(`${where}: not a field this sync may write.`);
  if (cell.column !== grid.columns[cell.field]) {
    refuse(`${where}: column ${cell.column} does not match the resolved position of ${cell.field}.`);
  }

  const value = cell.value;
  // Absent empties the cell — nothing else does, so an absent value outside the
  // emptiable set is a planner that lost one.
  if (value === undefined) {
    if (!emptiable.has(cell.field)) refuse(`${where}: not a field this sync may empty.`);
    return;
  }
  if (value.numberValue !== undefined && !Number.isFinite(value.numberValue)) refuse(`${where}: not a finite number.`);
  if ((cell.field === 'End' || cell.field === 'Start') && !plausibleSerial(value.numberValue, serialCeiling)) {
    refuse(`${where}: ${describeValue(value)} is not a plausible date serial.`);
  }
};

/**
 * The alignment rules — what catches a plan built against a different grid,
 * the one failure that produces real writes in wrong places.
 */
const checkCellAlignment = (cell: CellEdit, { grid }: GuardContext): void => {
  const where = `${cell.address} (${cell.field})`;

  // Bounds first: past the end both sides read as undefined, so the value
  // comparison would agree with itself and pass.
  if (cell.row < 0 || cell.row >= grid.snapshot.rows.length) refuse(`${where}: row is outside the snapshot.`);
  const actual = grid.snapshot.rows[cell.row]?.[cell.column];
  if (!sameValue(cell.previous, actual?.userEnteredValue)) {
    refuse(`${where}: the cell no longer holds what the plan was built on.`);
  }
  // Unconditional. Every derived cell on a show row is a formula rolling up
  // from the season rows; writing one replaces a live roll-up with a frozen
  // number, and nothing would ever notice.
  if (isFormula(actual)) refuse(`${where}: is a formula.`);
};

// --- Per-field rules for edits ----------------------------------------------

/**
 * On a show row `Status` is the derived state — text, and never emptied.
 *
 * A last-watched date is refused here rather than accepted as text: the column
 * carries two different facts, and the only way the season row's fact reaches
 * a show row is a planner that lost track of which row it was writing.
 */
const checkShowStatusEdit = (cell: CellEdit, where: string): void => {
  if (typeof cell.value?.stringValue !== 'string' || !cell.value.stringValue) refuse(`${where}: Status must be non-empty text.`);
  if (watchedNoteSerial(cell.value.stringValue) !== null) refuse(`${where}: a show row's Status is a state, not a watch date.`);
};

/**
 * On a season row `Status` is the last-watched date, so the value is bounded
 * exactly as `End` is — the same fact, one column earlier in the row's life.
 */
const checkWatchedNote = (where: string, value: ExtendedValue | undefined, ceiling: number): void => {
  if (!plausibleSerial(watchedNoteSerial(value?.stringValue), ceiling)) {
    refuse(`${where}: ${describeValue(value)} is not a plausible last-watched date.`);
  }
};

/**
 * Whether this batch dates the row — the claim that makes every write a
 * closing row carries safe. One copy: the runtime and the note's removal both
 * ride that batch, and a rule that drifted in one would keep passing in the
 * other, silently.
 */
const closesRow = (plan: SheetPlan, row: number): boolean => plan.edits.some((e) => e.row === row && e.field === 'End');

const checkSeasonStatusEdit = (cell: CellEdit, where: string, plan: SheetPlan, season: SeasonRow, ctx: GuardContext): void => {
  // Overwriting text a human typed is the one way this write can destroy
  // something nothing can reconstruct. `ownsNote` is the predicate the planner
  // declines on, re-derived here against the snapshot.
  if (!ownsNote(ctx.grid.snapshot.rows[cell.row]?.[cell.column], season.status)) {
    refuse(`${where}: the cell holds something this sync did not write.`);
  }

  if (cell.value === undefined) {
    // Emptying rides the batch that dates the row, the same way the runtime
    // write does: `End` is what makes the note redundant, so a plan that
    // removed it while leaving the row open would just lose the date.
    if (!closesRow(plan, cell.row)) {
      refuse(`${where}: a season's Status may only be cleared on the row that is being closed.`);
    }
    return;
  }
  checkWatchedNote(where, cell.value, ctx.serialCeiling);
};

const checkEpisodeEdit = (cell: CellEdit, where: string, season: SeasonRow, ctx: GuardContext): void => {
  const next = cell.value?.numberValue;
  if (next === undefined || !Number.isInteger(next) || next < 1) refuse(`${where}: an episode count must be a positive whole number.`);
  // A count typed as text carries only `stringValue`, so it parses to no
  // count — the never-backwards rule below would then compare against 0 and
  // write a *smaller* number over a larger one, the one way that rule can be
  // defeated. Unconditional, like a formula cell.
  const actual = ctx.grid.snapshot.rows[cell.row]?.[cell.column];
  if (!isBlank(actual) && numberOf(actual) === null) {
    refuse(`${where}: the cell holds something that is not a number, so a count cannot be compared against it.`);
  }
  // Never backwards — the user's rule, and why a wrong-but-larger number is
  // the dangerous failure rather than a wrong-but-smaller one.
  if (next <= (season.episode ?? 0)) refuse(`${where}: ${next} would not increase the count of ${season.episode ?? 0}.`);
};

/**
 * The two runtime rules an insert and an edit must both satisfy. An insert
 * cannot reuse the others: no cell to find blank, no `End` edit to ride —
 * the row is created and dated by a single fill. Scope and bounds are all
 * the guard can re-derive there.
 */
const checkRuntimeScope = (where: string, block: ShowBlock): void => {
  // The one planner claim a row cannot take back: the row is dated by the
  // same batch, so the blank-cell rule stops protecting the cell the instant
  // the write lands. `runtimeScopeOk` carries the reasoning.
  if (!runtimeScopeOk(block)) {
    refuse(`${where}: a runtime may only be written in a live-action block that carries ids on its show row.`);
  }
};

const checkRuntimeDays = (where: string, value: ExtendedValue | undefined): void => {
  // Bounds live in `values.ts` beside `runtimeDays`, the conversion that
  // produces every value this checks. At or above 1 the number is minutes
  // where a day fraction belongs, multiplying every `Length` in the block by
  // 1440.
  if (!plausibleRuntimeDays(value?.numberValue)) {
    refuse(`${where}: ${describeValue(value)} is not a plausible per-episode day fraction.`);
  }
};

const checkRuntimeEdit = (cell: CellEdit, where: string, plan: SheetPlan, season: SeasonRow, block: ShowBlock, ctx: GuardContext): void => {
  checkRuntimeScope(where, block);
  // A row carrying its own id has a season number that is explicitly not the
  // entry's — a split cour, Doctor Who's 2024 renumbering — exactly the
  // number that cannot be handed to TVDB.
  if (season.ids.length) {
    refuse(`${where}: the row carries its own id, so its season number is not the entry's to look up.`);
  }

  checkRuntimeDays(where, cell.value);
  // Blank only, unconditional: a hand-typed runtime is a deliberate
  // correction, and this cannot tell a better number from a worse one.
  // `isBlank` rather than `previous === undefined`, so a whitespace-only cell
  // reads the way `2-grid.ts` reads it everywhere.
  if (!isBlank(ctx.grid.snapshot.rows[cell.row]?.[cell.column])) {
    refuse(`${where}: the cell already holds a value.`);
  }
  // The claim that makes the two rules above safe, re-derived: a runtime is
  // only written onto a row this same batch closes. The closed-row refusal is
  // no contradiction — its snapshot is from before the write. Without this
  // check, a plan writing a runtime onto a row it left open would pass, and
  // the cell would be filled with nothing to freeze it.
  if (!closesRow(plan, cell.row)) {
    refuse(`${where}: a runtime may only be written on the row that is being closed.`);
  }
};

const checkEdit = (cell: CellEdit, plan: SheetPlan, ctx: GuardContext): void => {
  checkCellShape(cell, EDIT_FIELDS, EMPTIABLE_EDITS, ctx);
  checkCellAlignment(cell, ctx);
  const where = `${cell.address} (${cell.field})`;

  // `Status` is the one field with a meaning per row kind, so which row it
  // landed on picks the rule rather than being a rule itself.
  if (cell.field === 'Status' && ctx.showRows.has(cell.row)) {
    checkShowStatusEdit(cell, where);
    return;
  }

  const found = ctx.seasonRows.get(cell.row);
  if (!found) refuse(`${where}: ${cell.field} may only be written on a season row.`);
  const { season, block } = found;
  // A dated season is closed by the user's decision and never revisited.
  // Neither the runtime write nor clearing the watch note is an exception:
  // both ride the batch that closes the row, against a snapshot from before it.
  if (season.closed) refuse(`${where}: the season already has an end date.`);

  if (cell.field === 'Status') checkSeasonStatusEdit(cell, where, plan, season, ctx);
  if (cell.field === 'Episodes') checkRuntimeEdit(cell, where, plan, season, block, ctx);
  if (cell.field === 'Episode') checkEpisodeEdit(cell, where, season, ctx);
};

// --- The insert -------------------------------------------------------------

const checkInsertPlacement = (insert: RowInsert, where: string, ctx: GuardContext): ShowBlock => {
  if (!Number.isInteger(insert.season) || insert.season < 1) {
    // Fractional labels encode judgements no rule reproduces, and SIMKL's
    // season 0 is specials, maintained by hand.
    refuse(`${where}: only whole numbered seasons may be inserted.`);
  }
  // findLast, not find: the nearest block above is where the new row lands,
  // and inheritFromBefore takes formats from the row immediately above — a
  // show row's formats render a correct date serial as `46265`.
  const block = ctx.grid.blocks.findLast((b) => b.row < insert.row);
  if (!block || block.title !== insert.title) refuse(`${where}: the insertion point is not inside ${insert.title}'s block.`);
  if (!block.seasons.some((s) => s.row < insert.row)) {
    refuse(`${where}: no season row above the insertion point to inherit formats from.`);
  }
  return block;
};

const checkInsert = (insert: RowInsert, ctx: GuardContext): void => {
  const where = `row ${insert.row + 1} (${insert.title} S${insert.season})`;
  const block = checkInsertPlacement(insert, where, ctx);

  // Shape first, so the field-specific rules below run against a cell whose
  // field, column and emptiability the whitelists have already settled.
  for (const cell of insert.fill) {
    if (cell.row !== insert.row) refuse(`${cell.address}: an insert may only fill the row it creates.`);
    if (cell.previous !== undefined) refuse(`${cell.address}: a new row cannot have a previous value.`);
    // No alignment: the row does not exist in the snapshot, so there is nothing
    // to compare. `checkInsertPlacement` pinning the row to its block covers
    // the bounds an alignment check would add.
    checkCellShape(cell, INSERT_FIELDS, EMPTIABLE_INSERTS, ctx);
  }

  // A runtime carried by an insert needs *more* care than one on an edit: the
  // same fill creates the row and dates it, so neither the blank-cell rule
  // nor the closed-row rule stands between this number and the sheet, and
  // there is no `previous` to compare. Scope and bounds are all the guard can
  // re-derive here, so it derives both. The own-id rule needs no check: `id`
  // is not in `INSERT_FIELDS`, so the row inherits the block's.
  // Every such cell, not the first: requests are written in order and the
  // last wins, so checking one while writing two is a bound that does not
  // bind.
  for (const runtime of insert.fill.filter((cell) => cell.field === 'Episodes')) {
    checkRuntimeScope(`${runtime.address} (Episodes)`, block);
    checkRuntimeDays(`${runtime.address} (Episodes)`, runtime.value);
  }

  // The same bound an edit's note gets, plus the rule the edit path gets from
  // the closed-row refusal: a dated row is never revisited, so a note created
  // beside an `End` date is one nothing can ever remove — the exact state the
  // clear exists to prevent. Nothing else stands between the value and the
  // sheet here: the row has no cell to be blank and no note of its own to
  // recognise.
  const dated = insert.fill.some((cell) => cell.field === 'End');
  for (const note of insert.fill.filter((cell) => cell.field === 'Status')) {
    if (dated) refuse(`${note.address} (Status): a row created with an end date may not also carry a watch note.`);
    checkWatchedNote(`${note.address} (Status)`, note.value, ctx.serialCeiling);
  }
};

export const assertPlanSafe = (
  plan: SheetPlan,
  grid: Grid,
  { maxEdits = config.sheetMaxEdits, maxRows = config.sheetMaxRows, now = Temporal.Now.instant(), timezone = config.timezone }: SafetyLimits = {},
): void => {
  const ctx: GuardContext = {
    grid,
    serialCeiling: maxSerial(now, timezone),
    showRows: new Set(grid.blocks.map((b) => b.row)),
    seasonRows: new Map(grid.blocks.flatMap((b) => b.seasons.map((s) => [s.row, { season: s, block: b }] as const))),
  };

  checkBudgets(plan, maxEdits, maxRows);
  for (const cell of plan.edits) checkEdit(cell, plan, ctx);
  if (plan.insert) checkInsert(plan.insert, ctx);
};
