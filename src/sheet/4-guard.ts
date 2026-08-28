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
import { isBlank, isFormula, numberOf, sameValue, type Grid, type HeaderName, type ShowBlock } from './2-grid.ts';
import { plainDateFrom, plainDateIn } from '../shared/dates.ts';
import { dateSerial } from './1-progress.ts';
import type { CellEdit, SheetPlan } from './3-plan.ts';
import type { ExtendedValue } from '../api/google/types.ts';

/** What the sync may write to a row that already exists. */
const EDIT_FIELDS = new Set<HeaderName>(['Status', 'Episode', 'End', 'Episodes']);

/**
 * The bounds of a per-episode runtime, as the day fraction the column holds.
 * One whole minute to just under a day: at or above 1 the value is minutes
 * written where `runtimeDays`' output belongs, which multiplies every `Length`
 * in the block by 1440.
 */
const MIN_RUNTIME_DAYS = 1 / 1440;

/**
 * What it may write into a row it is creating. A *separate* whitelist on
 * purpose: an insert fills six columns, and folding the two together would
 * either forbid the insert or widen what an ordinary edit may touch.
 */
const INSERT_FIELDS = new Set<HeaderName>(['Season', 'Episode', 'Start', 'End', 'Episodes', 'Length']);

const MIN_SERIAL = dateSerial(plainDateFrom('2000-01-01'));

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

/**
 * The two runtime rules an insert and an edit must both satisfy, in one copy so
 * they cannot drift. The rules an insert *cannot* reuse are as telling: there is
 * no cell to find blank and no `End` edit to ride, because the row is created
 * and dated by a single fill. Scope and bounds are the whole of what the guard
 * can re-derive there, which is why they are extracted rather than repeated.
 */
const checkRuntimeScope = (where: string, block: ShowBlock): void => {
  // An anime block is refused because a SIMKL anime record numbers every cour
  // `season: 1` and all cours of a franchise share one TVDB id, so the row's
  // number addresses no TVDB season — Attack on Titan's six records all point at
  // tvdb 267440, whose season 1 holds 25 episodes against their 25/12/12/16/12/2.
  if (block.type !== 'show' || block.ids.length === 0) {
    refuse(`${where}: a runtime may only be written in a live-action block that carries ids on its show row.`);
  }
};

const checkRuntimeDays = (where: string, value: ExtendedValue): void => {
  const days = value.numberValue;
  if (days === undefined || !(days >= MIN_RUNTIME_DAYS) || days >= 1) {
    refuse(`${where}: ${describeValue(value)} is not a plausible per-episode day fraction.`);
  }
};

export interface SafetyLimits {
  maxEdits?: number;
  maxRows?: number;
  now?: Temporal.Instant;
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
  { maxEdits = config.sheetMaxEdits, maxRows = config.sheetMaxRows, now = Temporal.Now.instant(), timezone = config.timezone }: SafetyLimits = {},
): void => {
  // Tomorrow, in the viewer's zone. The slice would be a UTC date, which is a
  // day out for a fifth of the clock — and the +1 day here would absorb it,
  // making the bound quietly two days wide instead of one.
  const maxSerial = dateSerial(plainDateIn(now, timezone).add({ days: 1 }));
  const showRows = new Set(grid.blocks.map((b) => b.row));
  // The block comes along because the runtime rule below is about the block the
  // row sits in, not about the row: whether the season number means anything to
  // TVDB is a property of `type` and of where the id came from.
  const seasonRows = new Map(grid.blocks.flatMap((b) => b.seasons.map((s) => [s.row, { season: s, block: b }] as const)));

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

    const found = seasonRows.get(cell.row);
    if (!found) refuse(`${where}: ${cell.field} may only be written on a season row.`);
    const { season, block } = found;
    // A dated season is closed by the user's decision and never revisited. The
    // runtime write above is not an exception to this: it rides the batch that
    // closes the row, which the check there enforces.
    if (season.closed) refuse(`${where}: the season already has an end date.`);

    if (cell.field === 'Episodes') {
      // The scope `runtimeTarget` planned against, re-derived. Alone among the
      // claims here it is unrecoverable if the planner is ever wrong about it:
      // the row is dated by this same batch and the cell is no longer blank, so
      // both of the rules below stop applying to it for good.
      //
      // An anime block is refused because a SIMKL anime record numbers every
      // cour `season: 1` and all cours of a franchise share one TVDB id, so the
      // row's number addresses no TVDB season — Attack on Titan's six records
      // all point at tvdb 267440, whose season 1 holds 25 episodes against their
      // 25/12/12/16/12/2. A row carrying its *own* id is refused on the same
      // ground from the other direction: its season number is explicitly not the
      // entry's, which is what a split cour or a renumbering is.
      checkRuntimeScope(where, block);
      if (season.ids.length) {
        refuse(`${where}: the row carries its own id, so its season number is not the entry's to look up.`);
      }

      checkRuntimeDays(where, cell.value);
      // Blank only, and unconditional. A runtime typed by hand is a deliberate
      // correction and this has no way to tell a better number from a worse one.
      // `isBlank` rather than a `previous === undefined` test, so a
      // whitespace-only cell is read the way `2-grid.ts` reads it everywhere.
      if (!isBlank(grid.snapshot.rows[cell.row]?.[cell.column])) {
        refuse(`${where}: the cell already holds a value.`);
      }
      // The claim that makes the two rules above safe, re-derived rather than
      // trusted: a runtime is only ever written onto a row this same batch is
      // closing. That is why the closed-row refusal below is not a contradiction
      // — the snapshot it reads is from before the write — and without this
      // check, a plan that wrote a runtime onto a row it left open would pass,
      // and the cell would be filled with nothing to freeze it.
      if (!plan.edits.some((e) => e.row === cell.row && e.field === 'End')) {
        refuse(`${where}: a runtime may only be written on the row that is being closed.`);
      }
      continue;
    }

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

    // A runtime carried by an insert needs *more* care than one carried by an
    // edit, not less. The same fill creates the row and dates it, so neither the
    // blank-cell rule nor the closed-row rule ever stands between this number
    // and the sheet — and there is no `previous` to compare it against either.
    // Scope and bounds are all the guard can re-derive here, so it derives both.
    // The own-id rule needs no check: `id` is not in `INSERT_FIELDS`, so the row
    // this creates necessarily inherits the block's.
    const runtime = insert.fill.find((cell) => cell.field === 'Episodes');
    if (runtime) {
      checkRuntimeScope(`${runtime.address} (Episodes)`, block);
      checkRuntimeDays(`${runtime.address} (Episodes)`, runtime.value);
    }
    for (const cell of insert.fill) {
      if (cell.row !== insert.row) refuse(`${cell.address}: an insert may only fill the row it creates.`);
      if (cell.previous !== undefined) refuse(`${cell.address}: a new row cannot have a previous value.`);
      checkCell(cell, INSERT_FIELDS, false);
    }
  }
};
