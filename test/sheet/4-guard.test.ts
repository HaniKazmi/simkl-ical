import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPlanSafe, UnsafePlanError } from '../../src/sheet/4-guard.ts';
import { a1, parseGrid, type Grid } from '../../src/sheet/2-grid.ts';
import type { CellEdit, SheetPlan } from '../../src/sheet/3-plan.ts';
import type { HeaderName } from '../../src/sheet/2-grid.ts';
import { seasonRow, SHEET_HEADERS, sheetSnapshot } from '../helpers.ts';
import { cell, grid, H, insertAt, planOf, season, show, TODAY } from './fixtures.ts';
import { dateSerial } from '../../src/sheet/1-progress.ts';
import { plainDateIn } from '../../src/shared/dates.ts';

const refuses = (plan: SheetPlan, pattern: RegExp, against: Grid = grid): void =>
  assert.throws(() => assertPlanSafe(plan, against), (err: Error) => err instanceof UnsafePlanError && pattern.test(err.message));

// The baseline the rest of the file varies from: this must pass, or every
// assertion below is vacuous.
test('an ordinary count advance on an open season is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([cell(3, 'Episode', { numberValue: 8 })]), grid));
});

// --- what may be written, and where ---------------------------------------

test('a formula target is refused unconditionally', () => {
  refuses(planOf([cell(1, 'Episode', { numberValue: 9 })]), /is a formula/);
  refuses(planOf([cell(3, 'Length', { numberValue: 1 })]), /not a field this sync may write/);
});

test('Status may only be written on a show row, and the other two only on season rows', () => {
  refuses(planOf([cell(3, 'Status', { stringValue: 'Ended' })]), /only be written on a show row/);

  // A show row whose derived cells are literals rather than formulas — the
  // sheet's pre-conversion state. The formula guard cannot fire here, so this
  // is what proves the row-kind guard stands on its own.
  const literal = parseGrid(sheetSnapshot([H, ['Fargo', 'Ended', 1, 6, 45000, 44000, 6, 0.1, 1, 'show'], season(1, 6, null)]));
  assert.throws(
    () => assertPlanSafe(planOf([{ ...cell(1, 'End', { numberValue: TODAY }), previous: { numberValue: 44000 } }]), literal),
    /only be written on a season row/,
  );
});

test('a field outside the whitelist is refused however plausible', () => {
  refuses(planOf([cell(3, 'Start', { numberValue: TODAY })]), /not a field this sync may write/);
  refuses(planOf([cell(3, 'Season', { numberValue: 3 })]), /not a field this sync may write/);
  refuses(planOf([cell(1, 'Show', { stringValue: 'Renamed' })]), /not a field this sync may write/);
  refuses(planOf([cell(3, 'id', { numberValue: 7 })]), /not a field this sync may write/);
});

test('a closed season is never touched, whatever the field', () => {
  refuses(planOf([cell(2, 'Episode', { numberValue: 9 })]), /already has an end date/, blankRuntime);
  refuses(planOf([cell(2, 'End', { numberValue: TODAY })]), /already has an end date/, blankRuntime);
});

// The user's rule, and the reason a wrong-but-*larger* number is the dangerous
// failure: a smaller one is caught here, a larger one is not.
test('a count never goes backwards, or sideways', () => {
  refuses(planOf([cell(3, 'Episode', { numberValue: 2 })]), /would not increase/);
  refuses(planOf([cell(3, 'Episode', { numberValue: 3 })]), /would not increase/);
  refuses(planOf([cell(3, 'Episode', { numberValue: 0 })]), /positive whole number/);
});

// The one way the never-backwards rule can be defeated. A count typed as text
// carries only a stringValue, so it parses to no count at all — and both the
// planner and the guard would then compare against 0 and cheerfully write a
// smaller number over a larger one.
test('a hand-entered count stored as text is refused rather than overwritten', () => {
  const texty = parseGrid(sheetSnapshot([H, show('Fargo', 'Ended'), season(1, 6, 44000), [null, null, 2, '12', 45000, null, 0.0153, { formula: '=G4*D4' }, null, null]]));
  const edit: CellEdit = {
    row: 3,
    column: texty.columns.Episode,
    field: 'Episode',
    previous: texty.snapshot.rows[3]?.[texty.columns.Episode]?.userEnteredValue,
    value: { numberValue: 5 },
    address: a1(3, texty.columns.Episode),
    note: 'test',
  };
  assert.throws(() => assertPlanSafe(planOf([edit]), texty), (err: Error) => err instanceof UnsafePlanError && /not a number/.test(err.message));
});

test('an implausible date serial is refused at both ends', () => {
  refuses(planOf([cell(3, 'End', { numberValue: 1000 })]), /not a plausible date serial/);
  refuses(planOf([cell(3, 'End', { numberValue: TODAY + 5 })]), /not a plausible date serial/);
  refuses(planOf([cell(3, 'End', { stringValue: '2026-08-15' })]), /not a plausible date serial/);
  assert.doesNotThrow(() => assertPlanSafe(planOf([cell(3, 'End', { numberValue: TODAY })]), grid));
});

// A mismatch means the plan was built against a different grid, which is the one
// failure that produces real writes in the wrong places.
test('a cell that has moved under the plan is refused', () => {
  refuses(planOf([cell(3, 'Episode', { numberValue: 8 }, { numberValue: 99 })]), /no longer holds what the plan was built on/);
});

// The column is the write coordinate, so a plan whose column disagrees with the
// resolved header map would write to the wrong cell.
test('a target whose column does not match the resolved header map is refused', () => {
  const displaced = { ...cell(3, 'Episode', { numberValue: 8 }), column: 99 };
  refuses(planOf([displaced]), /does not match the resolved position/);
});

// --- budget ----------------------------------------------------------------

// Over budget refuses the whole plan. Truncating would apply half of what is,
// by hypothesis, a wrong plan.
test('over budget refuses everything rather than trimming', () => {
  const many = Array.from({ length: 5 }, () => cell(3, 'Episode', { numberValue: 8 }));
  assert.throws(() => assertPlanSafe(planOf(many), grid, { maxEdits: 4 }), /exceeds SHEET_MAX_EDITS=4/);
  assert.throws(() => assertPlanSafe(planOf(many), grid, { maxRows: 0 }), /exceeds SHEET_MAX_ROWS=0/);
});

// --- inserts ---------------------------------------------------------------

test('a well-formed insert below an existing season row is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([], [insertAt(4, 3)]), grid));
});

// inheritFromBefore takes its formats from the row above. Without a season row
// there it inherits the show row's, and a correct date serial renders as 46265.
test('an insert with no season row above it is refused', () => {
  refuses(planOf([], [insertAt(2, 1)]), /no season row above the insertion point/);
});

test('an insert outside its own block is refused', () => {
  const two = parseGrid(sheetSnapshot([H, show('Fargo', 'Ended'), season(1, 6, 44000), show('Silo', 'Watching'), season(1, 3, null)]));
  const insert = { ...insertAt(2, 2), row: 4 };
  assert.throws(() => assertPlanSafe(planOf([], [{ ...insert, fill: insert.fill.map((f) => ({ ...f, row: 4 })) }]), two), /not inside Fargo's block/);
});

test('a fractional or season-zero row is never inserted', () => {
  refuses(planOf([], [insertAt(4, 4.5)]), /only whole numbered seasons/);
  refuses(planOf([], [insertAt(4, 0)]), /only whole numbered seasons/);
});

// A separate whitelist from the edits one: an insert fills six columns, and
// folding the two together would either forbid it or widen ordinary edits.
test('an insert may only fill its own whitelist, and only its own row', () => {
  const insert = insertAt(4, 3);
  const strayField = { ...insert, fill: [...insert.fill, { ...insert.fill[0]!, field: 'Status' as HeaderName, column: grid.columns.Status, address: a1(4, grid.columns.Status) }] };
  refuses(planOf([], [strayField]), /not a field this sync may write/);

  const strayRow = { ...insert, fill: insert.fill.map((f, i) => (i === 0 ? { ...f, row: 3, address: a1(3, f.column) } : f)) };
  refuses(planOf([], [strayRow]), /may only fill the row it creates/);

  const hasPrevious = { ...insert, fill: insert.fill.map((f, i) => (i === 0 ? { ...f, previous: { numberValue: 1 } } : f)) };
  refuses(planOf([], [hasPrevious]), /cannot have a previous value/);
});


// Past the end of the snapshot both sides read as undefined, so the value
// comparison would agree with itself and wave the write through.
test('a target beyond the end of the snapshot is refused', () => {
  refuses(planOf([{ ...cell(3, 'Episode', { numberValue: 8 }), row: 99, address: a1(99, grid.columns.Episode), previous: undefined }]), /outside the snapshot/);
});

// The one-row-per-run rule is an invariant, not a budget, and the guard is its
// only enforcement: plan indices are pre-write while `insertDimension` requests
// apply cumulatively, so a second insert lands a row above where it was planned
// and `verify` — which makes the same unshifted assumption — disagrees with the
// sheet in a different way again. The planner emits one; nothing proved the
// guard is the backstop if it ever emitted two.
test('two inserts in one batch are refused however well-formed each is', () => {
  refuses(planOf([], [insertAt(4, 2), insertAt(9, 3, 'Veep')]), /2 inserts in one batch/);
});

test('two inserts are refused even for the same show', () => {
  refuses(planOf([], [insertAt(4, 2), insertAt(5, 3)]), /inserts in one batch/);
});

test('one insert alongside edits is still allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([cell(3, 'Episode', { numberValue: 9 })], [insertAt(4, 2)]), grid));
});

/**
 * The plausibility ceiling is *tomorrow in the viewer's zone*, and the zone is
 * the whole point: computed in UTC it is a day late for anyone behind UTC, which
 * makes the bound two days wide instead of one and lets a serial the sync should
 * never write pass the guard.
 *
 * 02:00Z on the 15th is still the 14th in New York, so the local ceiling is the
 * 15th where a UTC one would be the 16th. The serial below sits exactly between.
 */
test('the plausibility ceiling is tomorrow in the viewer zone, not in UTC', () => {
  const now = Temporal.Instant.from('2026-08-15T02:00:00Z');
  const dayAfterLocalTomorrow = dateSerial(plainDateIn(now, 'UTC').add({ days: 1 }));

  assert.throws(
    () => assertPlanSafe(planOf([cell(3, 'End', { numberValue: dayAfterLocalTomorrow })]), grid, { now, timezone: 'America/New_York' }),
    /not a plausible date serial/,
  );
  assert.doesNotThrow(
    () => assertPlanSafe(planOf([cell(3, 'End', { numberValue: dayAfterLocalTomorrow })]), grid, { now, timezone: 'UTC' }),
    'the same serial is inside the ceiling for a viewer already on that date',
  );
});

// --- the runtime cell ------------------------------------------------------

/**
 * The fixture grid's season rows carry a runtime already, which is the state
 * this write must refuse. A blank one is the state it is for.
 *
 * Row 2 is the closed season, row 3 the open one — the same indices every other
 * assertion in this file uses.
 */
const blankRuntime = parseGrid(
  sheetSnapshot([
    H,
    show('Fargo', 'Ended'),
    season(1, 6, 44000),
    seasonRow(2, 3, null, { episodes: null }),
    // A second open row, so "an End somewhere in the plan" can be told from "an
    // End on this row".
    seasonRow(3, 2, null, { episodes: null }),
  ]),
);

const runtimeCell = (value: number, row = 3): CellEdit => ({
  row,
  column: blankRuntime.columns.Episodes,
  field: 'Episodes',
  previous: blankRuntime.snapshot.rows[row]?.[blankRuntime.columns.Episodes]?.userEnteredValue,
  value: { numberValue: value },
  address: a1(row, blankRuntime.columns.Episodes),
  note: 'test',
});

/** The End edit a runtime always rides beside, on the same row. */
const endCell = (row = 3): CellEdit => ({
  row,
  column: blankRuntime.columns.End,
  field: 'End',
  previous: blankRuntime.snapshot.rows[row]?.[blankRuntime.columns.End]?.userEnteredValue,
  value: { numberValue: TODAY },
  address: a1(row, blankRuntime.columns.End),
  note: 'test',
});

// The baseline: without this the refusals below could all be passing for the
// wrong reason.
test('a runtime into a blank cell on the row being closed is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([endCell(), runtimeCell(49 / 1440)]), blankRuntime));
});

// The planner writes the two together or not at all, and the row freezes on the
// End. A runtime on a row left open would fill a cell with nothing to close it,
// and the next poll would find it non-blank and never revisit it.
test('a runtime on a row nothing is closing is refused', () => {
  refuses(planOf([runtimeCell(49 / 1440)]), /only be written on the row that is being closed/, blankRuntime);
  // An End elsewhere in the plan is not this row's.
  refuses(planOf([endCell(4), runtimeCell(49 / 1440, 3)]), /only be written on the row that is being closed/, blankRuntime);
});

// The rule the whole feature rests on: a hand-typed runtime is a correction, and
// the row closes in the same batch, so an overwrite could never be undone.
test('a runtime over a cell that already holds one is refused', () => {
  // Row 3 of the shared fixture carries 0.0153.
  refuses(planOf([cell(3, 'End', { numberValue: TODAY }), cell(3, 'Episodes', { numberValue: 49 / 1440 })]), /already holds a value/);
});

// At or above 1 the number is minutes where a day fraction belongs, which
// multiplies every Length in the block by 1440.
test('minutes written where a day fraction belongs are refused', () => {
  refuses(planOf([endCell(), runtimeCell(49)]), /not a plausible per-episode day fraction/, blankRuntime);
  refuses(planOf([endCell(), runtimeCell(1)]), /not a plausible per-episode day fraction/, blankRuntime);
  refuses(planOf([endCell(), runtimeCell(0)]), /not a plausible per-episode day fraction/, blankRuntime);
  refuses(planOf([endCell(), runtimeCell(-1 / 1440)]), /not a plausible per-episode day fraction/, blankRuntime);
  // Under half a minute rounds to nothing the sheet can show.
  refuses(planOf([endCell(), runtimeCell(0.4 / 1440)]), /not a plausible per-episode day fraction/, blankRuntime);
});

// Two rules, and which one fires depends on the cell. On the real sheet a show
// row's Episodes cell is a roll-up formula, so the unconditional formula rule
// gets there first; strip the formula and the season-row rule catches it. Both
// paths are asserted, because relying on the formula alone would leave a show
// row with an empty runtime cell writable.
test('a runtime is refused on a show row, by whichever rule reaches it first', () => {
  refuses(planOf([cell(1, 'Episodes', { numberValue: 49 / 1440 })]), /is a formula/);

  const bareShow = [...show('Fargo', 'Ended')];
  bareShow[SHEET_HEADERS.indexOf('Episodes')] = null;
  const stripped = parseGrid(sheetSnapshot([H, bareShow, season(1, 6, 44000), seasonRow(2, 3, null, { episodes: null })]));
  refuses(planOf([{ ...runtimeCell(49 / 1440, 1), previous: undefined }]), /may only be written on a season row/, stripped);
});

// A dated row is frozen for good, and this is that invariant asserted from the
// new direction: the runtime rides the batch that closes the row, never a later one.
test('a runtime is refused on a row that already has an end date', () => {
  refuses(planOf([runtimeCell(49 / 1440, 2)]), /already has an end date/, blankRuntime);
});
