/**
 * GUARD — the last thing between a plan and the spreadsheet. Pure.
 *
 * Fourth of READ → PARSE → PLAN → **GUARD** → BUILD → APPLY → VERIFY, and
 * numbered next to `5-requests.ts` to say the one thing that matters most about
 * it: nothing is built until this has passed.
 *
 * `assertPlanSafe` re-derives every claim the planner made, against the
 * snapshot the plan was built from, and throws rather than trimming: a plan
 * over budget is refused whole, because the interesting failure is "the planner
 * is wrong about something", and half of a wrong plan is still wrong.
 */

import { config } from '../shared/config.ts';
import { isBlank, isFormula, numberOf, sameValue, type Grid, type HeaderName } from './2-grid.ts';
import { localDateOf, shiftDate } from '../shared/dates.ts';
import { dateSerial } from './1-progress.ts';
import type { CellEdit, SheetPlan } from './3-plan.ts';
import type { ExtendedValue } from '../api/google/types.ts';

/** What the sync may write to a row that already exists. */
const EDIT_FIELDS = new Set<HeaderName>(['Status', 'Episode', 'End']);

/**
 * What it may write into a row it is creating. A *separate* whitelist on
 * purpose: an insert fills six columns, and folding the two together would
 * either forbid the insert or widen what an ordinary edit may touch.
 */
const INSERT_FIELDS = new Set<HeaderName>(['Season', 'Episode', 'Start', 'End', 'Episodes', 'Length']);

const MIN_SERIAL = dateSerial('2000-01-01');

export class UnsafePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePlanError';
  }
}

// Annotated on the variable, not the arrow: only that form makes TypeScript
// narrow at the call sites, which is what lets the checks below read as
// straight-line assertions rather than defensive `?.` chains.
const refuse: (message: string) => never = (message) => {
  throw new UnsafePlanError(message);
};

const describeValue = (value: ExtendedValue): string =>
  value.formulaValue ?? value.stringValue ?? (value.numberValue !== undefined ? String(value.numberValue) : JSON.stringify(value));

export interface SafetyLimits {
  maxEdits?: number;
  maxRows?: number;
  now?: Date;
  /**
   * The zone the `End` bound is computed in, and it must be the one `planSync`
   * used: the serials it writes are local dates, so a guard bounding them in a
   * different zone rejects or accepts a day either side of the right answer.
   */
  timezone?: string;
}

export const assertPlanSafe = (
  plan: SheetPlan,
  grid: Grid,
  { maxEdits = config.sheetMaxEdits, maxRows = config.sheetMaxRows, now = new Date(), timezone = config.timezone }: SafetyLimits = {},
): void => {
  // Tomorrow, in the viewer's zone. The slice would be a UTC date, which is a
  // day out for a fifth of the clock — and the +1 day here would absorb it,
  // making the bound quietly two days wide instead of one.
  const maxSerial = dateSerial(shiftDate(localDateOf(now, timezone), 1));
  const showRows = new Set(grid.blocks.map((b) => b.row));
  const seasonRows = new Map(grid.blocks.flatMap((b) => b.seasons.map((s) => [s.row, s] as const)));

  // --- Budget. Over budget refuses the whole plan; it never truncates.
  if (plan.edits.length > maxEdits) {
    refuse(`${plan.edits.length} edits exceeds SHEET_MAX_EDITS=${maxEdits}. Nothing written; the report lists every proposed edit.`);
  }
  // Not configurable, and not a budget. Every index in a plan is pre-write, but
  // `insertDimension` requests apply cumulatively — a second insert would land
  // one row above where it was planned, and `verify` makes the same unshifted
  // assumption, so the two would disagree with the sheet in different ways.
  if (plan.inserts.length > 1) {
    refuse(`${plan.inserts.length} inserts in one batch: request indices are pre-write and would not be shifted.`);
  }
  const rows = new Set([...plan.edits.map((e) => e.row), ...plan.inserts.map((i) => i.row)]);
  if (rows.size > maxRows) {
    refuse(`${rows.size} distinct rows exceeds SHEET_MAX_ROWS=${maxRows}.`);
  }

  const checkCell = (cell: CellEdit, allowed: Set<HeaderName>, existing: boolean): void => {
    const where = `${cell.address} (${cell.field})`;

    if (!allowed.has(cell.field)) refuse(`${where}: not a field this sync may write.`);
    if (cell.column !== grid.columns[cell.field]) {
      refuse(`${where}: column ${cell.column} does not match the resolved position of ${cell.field}.`);
    }

    const value = cell.value;
    if (value.numberValue !== undefined && !Number.isFinite(value.numberValue)) refuse(`${where}: not a finite number.`);
    if (cell.field === 'End' || cell.field === 'Start') {
      const serial = value.numberValue;
      if (serial === undefined || serial < MIN_SERIAL || serial > maxSerial) {
        refuse(`${where}: ${describeValue(value)} is not a plausible date serial.`);
      }
    }

    if (!existing) return;

    // Every address must exist in *this* snapshot, and hold exactly what the
    // plan recorded. A mismatch means the plan was built against a different
    // grid, which is the one failure that produces real writes in wrong places.
    // The bounds check comes first: past the end both sides read as undefined,
    // so the value comparison would agree with itself and pass.
    if (cell.row < 0 || cell.row >= grid.snapshot.rows.length) refuse(`${where}: row is outside the snapshot.`);
    const actual = grid.snapshot.rows[cell.row]?.[cell.column];
    if (!sameValue(cell.previous, actual?.userEnteredValue)) {
      refuse(`${where}: the cell no longer holds what the plan was built on.`);
    }
    // Unconditional, with no exceptions. Every derived cell on a show row is a
    // formula that rolls up from the season rows; writing one replaces a live
    // roll-up with a frozen number, and nothing would ever notice.
    if (isFormula(actual)) refuse(`${where}: is a formula.`);
  };

  for (const cell of plan.edits) {
    checkCell(cell, EDIT_FIELDS, true);
    const where = `${cell.address} (${cell.field})`;

    if (cell.field === 'Status') {
      if (!showRows.has(cell.row)) refuse(`${where}: Status may only be written on a show row.`);
      if (typeof cell.value.stringValue !== 'string' || !cell.value.stringValue) refuse(`${where}: Status must be non-empty text.`);
      continue;
    }

    const season = seasonRows.get(cell.row);
    if (!season) refuse(`${where}: ${cell.field} may only be written on a season row.`);
    // A dated season is closed by the user's decision and never revisited.
    if (season.closed) refuse(`${where}: the season already has an end date.`);

    if (cell.field === 'Episode') {
      const next = cell.value.numberValue;
      if (next === undefined || !Number.isInteger(next) || next < 1) refuse(`${where}: an episode count must be a positive whole number.`);
      // A count typed as text carries only `stringValue`, so it parses to no
      // count at all — and the never-backwards rule below would then compare
      // against 0 and write a *smaller* number over a larger one, which is the
      // one way that rule can be defeated. Unconditional, like a formula cell.
      const actual = grid.snapshot.rows[cell.row]?.[cell.column];
      if (!isBlank(actual) && numberOf(actual) === null) {
        refuse(`${where}: the cell holds something that is not a number, so a count cannot be compared against it.`);
      }
      // Never backwards. The user's rule, and the reason a wrong-but-larger
      // number is the dangerous failure rather than a wrong-but-smaller one.
      if (next <= (season.episode ?? 0)) refuse(`${where}: ${next} would not increase the count of ${season.episode ?? 0}.`);
    }
  }

  for (const insert of plan.inserts) {
    const where = `row ${insert.row + 1} (${insert.title} S${insert.season})`;
    if (!Number.isInteger(insert.season) || insert.season < 1) {
      // Fractional labels encode judgements no rule here reproduces, and
      // SIMKL's season 0 is specials, which the user maintains by hand.
      refuse(`${where}: only whole numbered seasons may be inserted.`);
    }
    // findLast, not find: the nearest block above is the one the new row lands
    // in, and inheritFromBefore takes its formats from the row immediately
    // above — a show row's formats render a correct date serial as `46265`.
    const block = grid.blocks.findLast((b) => b.row < insert.row);
    if (!block || block.title !== insert.title) refuse(`${where}: the insertion point is not inside ${insert.title}'s block.`);
    if (!block.seasons.some((s) => s.row < insert.row)) {
      refuse(`${where}: no season row above the insertion point to inherit formats from.`);
    }
    for (const cell of insert.fill) {
      if (cell.row !== insert.row) refuse(`${cell.address}: an insert may only fill the row it creates.`);
      if (cell.previous !== undefined) refuse(`${cell.address}: a new row cannot have a previous value.`);
      checkCell(cell, INSERT_FIELDS, false);
    }
  }
};
