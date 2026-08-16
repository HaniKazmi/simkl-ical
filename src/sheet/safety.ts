/**
 * The last thing between a plan and the spreadsheet. Pure.
 *
 * `assertPlanSafe` re-derives every claim the planner made, against the
 * snapshot the plan was built from, and throws rather than trimming: a plan
 * over budget is refused whole, because the interesting failure is "the planner
 * is wrong about something", and half of a wrong plan is still wrong.
 *
 * `toRequests` is the highest-value function here. batchUpdate applies requests
 * in array order, so that order is the difference between a correct write and a
 * one-row misalignment.
 */

import { config } from '../config.ts';
import { isBlank, isFormula, numberOf, sameValue, type Grid, type HeaderName } from './grid.ts';
import { shiftDate } from '../dates.ts';
import { dateSerial } from './progress.ts';
import type { CellEdit, SheetPlan } from './plan.ts';
import type { ExtendedValue, GridRange, SheetRequest } from '../sheets/types.ts';

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
}

export const assertPlanSafe = (
  plan: SheetPlan,
  grid: Grid,
  { maxEdits = config.sheetMaxEdits, maxRows = config.sheetMaxRows, now = new Date() }: SafetyLimits = {},
): void => {
  // Tomorrow, via the shared date arithmetic rather than slicing an instant.
  const maxSerial = dateSerial(shiftDate(now.toISOString().slice(0, 10), 1));
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

// --- Requests --------------------------------------------------------------

const oneCell = (sheetId: number, row: number, column: number): GridRange => ({
  sheetId,
  startRowIndex: row,
  endRowIndex: row + 1,
  startColumnIndex: column,
  endColumnIndex: column + 1,
});

/** `fields: 'userEnteredValue'` so number formats and conditional formatting survive. */
const writeCell = (sheetId: number, row: number, column: number, value: ExtendedValue | undefined): SheetRequest => ({
  updateCells: {
    range: oneCell(sheetId, row, column),
    // An absent value clears the cell, which is what a rollback of an inserted
    // value needs.
    rows: [{ values: [value === undefined ? {} : { userEnteredValue: value }] }],
    fields: 'userEnteredValue',
  },
});

/**
 * The plan as one ordered batch, in three groups:
 *
 *   a. edits to pre-existing rows, descending by row
 *   b. the insertDimension
 *   c. the new row's fill
 *
 * The fill shares a row index with the insert. Any rule of the form "edits
 * before inserts" therefore applies the fill to whatever currently sits at that
 * index and *then* inserts a blank row below it — overwriting a real row, which
 * is the exact failure this design exists to prevent.
 */
export const toRequests = (plan: SheetPlan, grid: Grid): SheetRequest[] => {
  const { sheetId } = grid.snapshot;
  const requests: SheetRequest[] = [];

  for (const cell of [...plan.edits].sort((a, b) => b.row - a.row || b.column - a.column)) {
    requests.push(writeCell(sheetId, cell.row, cell.column, cell.value));
  }
  for (const insert of plan.inserts) {
    requests.push({
      insertDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: insert.row, endIndex: insert.row + 1 },
        inheritFromBefore: true,
      },
    });
    for (const cell of insert.fill) requests.push(writeCell(sheetId, cell.row, cell.column, cell.value));
  }
  return requests;
};

/**
 * Prefix for the snapshot tabs the sync makes before writing. Strict, because
 * it is the sole basis on which a tab is later swept.
 */
export const BACKUP_PREFIX = '_sync-backup-';

/**
 * Where a snapshot is moved to when the run it belongs to freezes: out of the
 * swept namespace, and into a name that says what it is to whoever opens the
 * spreadsheet next.
 *
 * `frozen` is process state, so a restart forgets that a run told the user to
 * repair from a particular tab. Without the rename the next clean write would
 * sweep it away — and it is the only thing that makes the repair a copy rather
 * than an archaeology exercise in version history.
 */
export const REPAIR_PREFIX = '_sync-REPAIR-';

export const isBackupTab = (title: string): boolean => title.startsWith(BACKUP_PREFIX);

export const backupName = (now: Date): string => `${BACKUP_PREFIX}${now.toISOString().replaceAll(':', '-').replace('.', '-')}`;

export const repairName = (backup: string): string => backup.replace(BACKUP_PREFIX, REPAIR_PREFIX);

/** `fields: 'title'` so the tab keeps its position, colour and grid size. */
export const renameSheetRequest = (sheetId: number, title: string): SheetRequest => ({
  updateSheetProperties: { properties: { sheetId, title }, fields: 'title' },
});

/**
 * Snapshot the tab, as the first request of the write batch.
 *
 * First, and in the *same* batch, deliberately: batchUpdate applies in order
 * and atomically, so the copy captures the pre-write state and there is no
 * window in which the write landed but the snapshot did not. It duplicates
 * server-side, so a 1644-row tab costs no data transfer.
 */
export const backupRequest = (sheetId: number, name: string): SheetRequest => ({
  duplicateSheet: { sourceSheetId: sheetId, newSheetName: name },
});

export const deleteSheetRequest = (sheetId: number): SheetRequest => ({ deleteSheet: { sheetId } });

/**
 * Put the whole tab back from its snapshot, in one server-side request.
 *
 * Source and destination sit at identical coordinates, so the paste offset is
 * zero and no relative formula reference is adjusted — which is exactly what
 * makes this immune to the off-by-one that a cell-by-cell restore invites.
 *
 * The caller must delete any inserted rows first: this overwrites a range, it
 * does not shrink the grid, so an extra row would survive underneath it.
 */
export const restoreRequest = (fromSheetId: number, toSheetId: number, rowCount: number, columnCount: number): SheetRequest => ({
  copyPaste: {
    source: { sheetId: fromSheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: columnCount },
    destination: { sheetId: toSheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: columnCount },
    pasteType: 'PASTE_NORMAL',
  },
});

/**
 * Undo the structural half of a write: delete the rows it inserted.
 *
 * Descending, so no index shifts under the deletes. There is no cell-restore
 * counterpart — `SheetSync` restores from the snapshot tab instead, because
 * putting individual cells back cannot be made safe alongside a delete: the
 * delete rewrites the relative references in everything it shifts, including
 * text written moments earlier in the same batch.
 */
export const deleteRowRequests = (sheetId: number, rows: number[]): SheetRequest[] =>
  [...rows]
    .sort((a, b) => b - a)
    .map((row) => ({ deleteDimension: { range: { sheetId, dimension: 'ROWS' as const, startIndex: row, endIndex: row + 1 } } }));
