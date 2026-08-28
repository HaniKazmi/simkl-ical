import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPlanSafe, UnsafePlanError } from '../../src/sheet/4-guard.ts';
import { a1, type Grid } from '../../src/sheet/2-grid.ts';
import type { SheetPlan } from '../../src/sheet/3-plan.ts';
import type { HeaderName } from '../../src/sheet/2-grid.ts';
import { fx, gridFixture, H, planOf, raw, season, show, TODAY } from './fixture.ts';
import { dateSerial } from '../../src/sheet/1-progress.ts';
import { plainDateIn } from '../../src/shared/dates.ts';

const refuses = (plan: SheetPlan, pattern: RegExp, against: Grid = fx.grid): void =>
  assert.throws(() => assertPlanSafe(plan, against), (err: Error) => err instanceof UnsafePlanError && pattern.test(err.message));

// The baseline the rest of the file varies from: this must pass, or every
// assertion below is vacuous.
test('an ordinary count advance on an open season is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([fx.cell('fargoS2', 'Episode', { numberValue: 8 })]), fx.grid));
});

// --- what may be written, and where ---------------------------------------

test('a formula target is refused unconditionally', () => {
  refuses(planOf([fx.cell('fargo', 'Episode', { numberValue: 9 })]), /is a formula/);
  refuses(planOf([fx.cell('fargoS2', 'Length', { numberValue: 1 })]), /not a field this sync may write/);
});

test('Status may only be written on a show row, and the other two only on season rows', () => {
  refuses(planOf([fx.cell('fargoS2', 'Status', { stringValue: 'Ended' })]), /only be written on a show row/);

  // A show row whose derived cells are literals rather than formulas — the
  // sheet's pre-conversion state. The formula guard cannot fire here, so this
  // is what proves the row-kind guard stands on its own.
  const literal = gridFixture(raw('fargo', ['Fargo', 'Ended', 1, 6, 45000, 44000, 6, 0.1, 1, 'show']), season('fargoS1', 1, 6, null));
  assert.throws(
    () => assertPlanSafe(planOf([{ ...literal.cell('fargo', 'End', { numberValue: TODAY }), previous: { numberValue: 44000 } }]), literal.grid),
    /only be written on a season row/,
  );
});

test('a field outside the whitelist is refused however plausible', () => {
  refuses(planOf([fx.cell('fargoS2', 'Start', { numberValue: TODAY })]), /not a field this sync may write/);
  refuses(planOf([fx.cell('fargoS2', 'Season', { numberValue: 3 })]), /not a field this sync may write/);
  refuses(planOf([fx.cell('fargo', 'Show', { stringValue: 'Renamed' })]), /not a field this sync may write/);
  refuses(planOf([fx.cell('fargoS2', 'id', { numberValue: 7 })]), /not a field this sync may write/);
});

test('a closed season is never touched, whatever the field', () => {
  refuses(planOf([blank.cell('fargoS1', 'Episode', { numberValue: 9 })]), /already has an end date/, blank.grid);
  refuses(planOf([blank.cell('fargoS1', 'End', { numberValue: TODAY })]), /already has an end date/, blank.grid);
});

// The user's rule, and the reason a wrong-but-*larger* number is the dangerous
// failure: a smaller one is caught here, a larger one is not.
test('a count never goes backwards, or sideways', () => {
  refuses(planOf([fx.cell('fargoS2', 'Episode', { numberValue: 2 })]), /would not increase/);
  refuses(planOf([fx.cell('fargoS2', 'Episode', { numberValue: 3 })]), /would not increase/);
  refuses(planOf([fx.cell('fargoS2', 'Episode', { numberValue: 0 })]), /positive whole number/);
});

// The one way the never-backwards rule can be defeated. A count typed as text
// carries only a stringValue, so it parses to no count at all — and both the
// planner and the guard would then compare against 0 and cheerfully write a
// smaller number over a larger one.
test('a hand-entered count stored as text is refused rather than overwritten', () => {
  const texty = gridFixture(
    show('fargo', 'Fargo'),
    season('fargoS1', 1, 6, 44000),
    raw('fargoS2', [null, null, 2, '12', 45000, null, 0.0153, { formula: '=G4*D4' }, null, null]),
  );
  refuses(planOf([texty.cell('fargoS2', 'Episode', { numberValue: 5 })]), /not a number/, texty.grid);
});

test('an implausible date serial is refused at both ends', () => {
  refuses(planOf([fx.cell('fargoS2', 'End', { numberValue: 1000 })]), /not a plausible date serial/);
  refuses(planOf([fx.cell('fargoS2', 'End', { numberValue: TODAY + 5 })]), /not a plausible date serial/);
  refuses(planOf([fx.cell('fargoS2', 'End', { stringValue: '2026-08-15' })]), /not a plausible date serial/);
  assert.doesNotThrow(() => assertPlanSafe(planOf([fx.cell('fargoS2', 'End', { numberValue: TODAY })]), fx.grid));
});

// A mismatch means the plan was built against a different grid, which is the one
// failure that produces real writes in the wrong places.
test('a cell that has moved under the plan is refused', () => {
  refuses(planOf([fx.cell('fargoS2', 'Episode', { numberValue: 8 }, { numberValue: 99 })]), /no longer holds what the plan was built on/);
});

// The column is the write coordinate, so a plan whose column disagrees with the
// resolved header map would write to the wrong cell.
test('a target whose column does not match the resolved header map is refused', () => {
  const displaced = { ...fx.cell('fargoS2', 'Episode', { numberValue: 8 }), column: 99 };
  refuses(planOf([displaced]), /does not match the resolved position/);
});

// --- budget ----------------------------------------------------------------

// Over budget refuses the whole plan. Truncating would apply half of what is,
// by hypothesis, a wrong plan.
test('over budget refuses everything rather than trimming', () => {
  const many = Array.from({ length: 5 }, () => fx.cell('fargoS2', 'Episode', { numberValue: 8 }));
  assert.throws(() => assertPlanSafe(planOf(many), fx.grid, { maxEdits: 4 }), /exceeds SHEET_MAX_EDITS=4/);
  assert.throws(() => assertPlanSafe(planOf(many), fx.grid, { maxRows: 0 }), /exceeds SHEET_MAX_ROWS=0/);
});

// --- inserts ---------------------------------------------------------------

test('a well-formed insert below an existing season row is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([], [fx.insertAt(fx.end, 3)]), fx.grid));
});

// inheritFromBefore takes its formats from the row above. Without a season row
// there it inherits the show row's, and a correct date serial renders as 46265.
test('an insert with no season row above it is refused', () => {
  refuses(planOf([], [fx.insertAt(fx.at.fargoS1!, 1)]), /no season row above the insertion point/);
});

test('an insert outside its own block is refused', () => {
  const two = gridFixture(show('fargo', 'Fargo'), season('fargoS1', 1, 6, 44000), show('silo', 'Silo', { status: 'Watching' }), season('siloS1', 1, 3, null));
  const insert = { ...two.insertAt(two.end, 2), title: 'Fargo' };
  refuses(planOf([], [insert]), /not inside Fargo's block/, two.grid);
});

test('a fractional or season-zero row is never inserted', () => {
  refuses(planOf([], [fx.insertAt(fx.end, 4.5)]), /only whole numbered seasons/);
  refuses(planOf([], [fx.insertAt(fx.end, 0)]), /only whole numbered seasons/);
});

// A separate whitelist from the edits one: an insert fills six columns, and
// folding the two together would either forbid it or widen ordinary edits.
test('an insert may only fill its own whitelist, and only its own row', () => {
  const insert = fx.insertAt(fx.end, 3);
  const strayField = { ...insert, fill: [...insert.fill, { ...insert.fill[0]!, field: 'Status' as HeaderName, column: fx.grid.columns.Status, address: a1(fx.end, fx.grid.columns.Status) }] };
  refuses(planOf([], [strayField]), /not a field this sync may write/);

  const strayRow = { ...insert, fill: insert.fill.map((f, i) => (i === 0 ? { ...f, row: fx.at.fargoS2!, address: a1(fx.at.fargoS2!, f.column) } : f)) };
  refuses(planOf([], [strayRow]), /may only fill the row it creates/);

  const hasPrevious = { ...insert, fill: insert.fill.map((f, i) => (i === 0 ? { ...f, previous: { numberValue: 1 } } : f)) };
  refuses(planOf([], [hasPrevious]), /cannot have a previous value/);
});

// Past the end of the snapshot both sides read as undefined, so the value
// comparison would agree with itself and wave the write through.
test('a target beyond the end of the snapshot is refused', () => {
  refuses(planOf([{ ...fx.cell('fargoS2', 'Episode', { numberValue: 8 }), row: 99, address: a1(99, fx.grid.columns.Episode), previous: undefined }]), /outside the snapshot/);
});

// The one-row-per-run rule is an invariant, not a budget, and the guard is its
// only enforcement: plan indices are pre-write while `insertDimension` requests
// apply cumulatively, so a second insert lands a row above where it was planned
// and `verify` — which makes the same unshifted assumption — disagrees with the
// sheet in a different way again. The planner emits one; nothing proved the
// guard is the backstop if it ever emitted two.
test('two inserts in one batch are refused however well-formed each is', () => {
  refuses(planOf([], [fx.insertAt(fx.end, 2), fx.insertAt(9, 3, { title: 'Veep' })]), /2 inserts in one batch/);
});

test('two inserts are refused even for the same show', () => {
  refuses(planOf([], [fx.insertAt(fx.end, 2), fx.insertAt(fx.end + 1, 3)]), /inserts in one batch/);
});

test('one insert alongside edits is still allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([fx.cell('fargoS2', 'Episode', { numberValue: 9 })], [fx.insertAt(fx.end, 2)]), fx.grid));
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
    () => assertPlanSafe(planOf([fx.cell('fargoS2', 'End', { numberValue: dayAfterLocalTomorrow })]), fx.grid, { now, timezone: 'America/New_York' }),
    /not a plausible date serial/,
  );
  assert.doesNotThrow(
    () => assertPlanSafe(planOf([fx.cell('fargoS2', 'End', { numberValue: dayAfterLocalTomorrow })]), fx.grid, { now, timezone: 'UTC' }),
    'the same serial is inside the ceiling for a viewer already on that date',
  );
});

// --- the runtime cell ------------------------------------------------------

/**
 * The shared fixture's season rows carry a runtime already, which is the state
 * this write must refuse. A blank one is the state it is for. The second open
 * row exists so "an End somewhere in the plan" can be told from "an End on
 * this row".
 */
const blank = gridFixture(
  show('fargo', 'Fargo'),
  season('fargoS1', 1, 6, 44000),
  season('fargoS2', 2, 3, null, { episodes: null }),
  season('fargoS3', 3, 2, null, { episodes: null }),
);

const runtimeCell = (value: number, row = 'fargoS2') => blank.cell(row, 'Episodes', { numberValue: value });

/** The End edit a runtime always rides beside, on the same row. */
const endCell = (row = 'fargoS2') => blank.cell(row, 'End', { numberValue: TODAY });

// The baseline: without this the refusals below could all be passing for the
// wrong reason.
test('a runtime into a blank cell on the row being closed is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([endCell(), runtimeCell(49 / 1440)]), blank.grid));
});

// The planner writes the two together or not at all, and the row freezes on the
// End. A runtime on a row left open would fill a cell with nothing to close it,
// and the next poll would find it non-blank and never revisit it.
test('a runtime on a row nothing is closing is refused', () => {
  refuses(planOf([runtimeCell(49 / 1440)]), /only be written on the row that is being closed/, blank.grid);
  // An End elsewhere in the plan is not this row's.
  refuses(planOf([endCell('fargoS3'), runtimeCell(49 / 1440, 'fargoS2')]), /only be written on the row that is being closed/, blank.grid);
});

// The rule the whole feature rests on: a hand-typed runtime is a correction, and
// the row closes in the same batch, so an overwrite could never be undone.
test('a runtime over a cell that already holds one is refused', () => {
  // The shared fixture's open season carries 0.0153 already.
  refuses(planOf([fx.cell('fargoS2', 'End', { numberValue: TODAY }), fx.cell('fargoS2', 'Episodes', { numberValue: 49 / 1440 })]), /already holds a value/);
});

// At or above 1 the number is minutes where a day fraction belongs, which
// multiplies every Length in the block by 1440.
test('minutes written where a day fraction belongs are refused', () => {
  refuses(planOf([endCell(), runtimeCell(49)]), /not a plausible per-episode day fraction/, blank.grid);
  refuses(planOf([endCell(), runtimeCell(1)]), /not a plausible per-episode day fraction/, blank.grid);
  refuses(planOf([endCell(), runtimeCell(0)]), /not a plausible per-episode day fraction/, blank.grid);
  refuses(planOf([endCell(), runtimeCell(-1 / 1440)]), /not a plausible per-episode day fraction/, blank.grid);
  // Under half a minute rounds to nothing the sheet can show.
  refuses(planOf([endCell(), runtimeCell(0.4 / 1440)]), /not a plausible per-episode day fraction/, blank.grid);
});

// Two rules, and which one fires depends on the cell. On the real sheet a show
// row's Episodes cell is a roll-up formula, so the unconditional formula rule
// gets there first; strip the formula and the season-row rule catches it. Both
// paths are asserted, because relying on the formula alone would leave a show
// row with an empty runtime cell writable.
test('a runtime is refused on a show row, by whichever rule reaches it first', () => {
  refuses(planOf([fx.cell('fargo', 'Episodes', { numberValue: 49 / 1440 })]), /is a formula/);

  const bareShow = [...show(null, 'Fargo').cells];
  bareShow[H.indexOf('Episodes')] = null;
  const stripped = gridFixture(raw('fargo', bareShow), season('fargoS1', 1, 6, 44000), season('fargoS2', 2, 3, null, { episodes: null }));
  refuses(planOf([{ ...stripped.cell('fargo', 'Episodes', { numberValue: 49 / 1440 }), previous: undefined }]), /may only be written on a season row/, stripped.grid);
});

// A dated row is frozen for good, and this is that invariant asserted from the
// new direction: the runtime rides the batch that closes the row, never a later one.
test('a runtime is refused on a row that already has an end date', () => {
  refuses(planOf([runtimeCell(49 / 1440, 'fargoS1')]), /already has an end date/, blank.grid);
});

/**
 * The same grid under an `anime` type, and under a show row with no id — the two
 * shapes whose season number means nothing to TVDB. Identical in every other
 * respect to `blank`, so a refusal here can only be the scope rule.
 */
const scoped = (type: string, id: number | null) =>
  gridFixture(
    show('fargo', 'Fargo', { id, type }),
    season('fargoS1', 1, 6, 44000),
    season('fargoS2', 2, 3, null, { episodes: null }),
    season('fargoS3', 3, 2, null, { episodes: null }),
  );

/**
 * The scope the planner decided, re-derived here because it is the one claim in
 * this file that cannot be taken back: the row is dated by the same batch, so
 * the blank-cell rule stops protecting it the instant this write lands.
 *
 * An anime block's season number addresses no TVDB season — every cour of a
 * SIMKL anime record is `season: 1` and a franchise shares one TVDB id — so a
 * number fetched for it describes some other season at some other length.
 */
test('a runtime is refused in an anime block, and in a block whose show row has no id', () => {
  // The type is what decides the first one, not a missing id: this block *has*
  // an id, and is still refused. Nothing stops an anime block carrying a
  // show-row id on a hand-maintained sheet, and it is the case a bare "no ids"
  // test — which is how `planSync` and `planLookups` read anime — gets backwards.
  refuses(planOf([endCell(), runtimeCell(49 / 1440)]), /live-action block/, scoped('anime', 1).grid);
  refuses(planOf([endCell(), runtimeCell(49 / 1440)]), /live-action block/, scoped('show', null).grid);
});

/**
 * A row with its own id is one whose season number is explicitly *not* the
 * entry's — a split cour, or Doctor Who's 2024 renumbering. Handing that number
 * to TVDB asks about a season the row does not mean.
 */
test('a runtime is refused on a season row that carries its own id', () => {
  const owned = gridFixture(
    show('fargo', 'Fargo'),
    season('fargoS1', 1, 6, 44000),
    season('fargoS2', 2, 3, null, { episodes: null }),
    // The id is the only thing separating this row from fargoS2 above — so the
    // refusal below can only be the id rule.
    season('fargoS3', 3, 2, null, { episodes: null, id: 99 }),
  );
  assert.doesNotThrow(() =>
    assertPlanSafe(planOf([owned.cell('fargoS2', 'End', { numberValue: TODAY }), owned.cell('fargoS2', 'Episodes', { numberValue: 49 / 1440 })]), owned.grid),
  );
  refuses(
    planOf([owned.cell('fargoS3', 'End', { numberValue: TODAY }), owned.cell('fargoS3', 'Episodes', { numberValue: 49 / 1440 })]),
    /carries its own id/,
    owned.grid,
  );
});

// --- a runtime carried by an insert ----------------------------------------

/**
 * The insert path has neither of the two rules that protect an edit: there is no
 * cell to find blank and no `End` edit to ride, because one fill creates the row
 * and dates it. Scope and bounds are the whole of the guard here, so both are
 * asserted from the same baseline the edits tests use.
 */
test('an insert carrying a runtime and an End is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([], [fx.insertAt(fx.end, 3, { end: TODAY })]), fx.grid));
});

// The state a row left for its close to fill goes in as. Pins that the insert
// whitelist is a whitelist and not a requirement.
test('an insert with no runtime cell at all is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([], [fx.insertAt(fx.end, 3, { episodes: null })]), fx.grid));
});

test('an insert’s runtime is bounded exactly as an edit’s is', () => {
  for (const bad of [49, 1, 0, -1 / 1440, 0.4 / 1440]) {
    refuses(planOf([], [fx.insertAt(fx.end, 3, { episodes: bad })]), /not a plausible per-episode day fraction/);
  }
});

// An insert's End is bounded by `checkCell`, which runs above the `existing`
// early-return and so reaches a row that does not exist yet. A date serial is
// the one insert value a wrong bound writes silently: it renders as a plausible
// date whatever number it holds.
test('an insert’s End is bounded exactly as an edit’s is', () => {
  refuses(planOf([], [fx.insertAt(fx.end, 3, { end: TODAY + 5 })]), /not a plausible date serial/);
  refuses(planOf([], [fx.insertAt(fx.end, 3, { end: 1000 })]), /not a plausible date serial/);
});

// The claim the row cannot take back, re-derived on the insert path too: the
// same fill dates the row, so nothing protects the cell a second time.
test('an insert carrying a runtime into a block TVDB cannot describe is refused', () => {
  const anime = gridFixture(show('bleach', 'Bleach', { status: 'Watching', type: 'anime' }), season('bleachS1', 1, 6, 44000), season('bleachS2', 2, 3, null));
  refuses(planOf([], [anime.insertAt(anime.end, 3, { title: 'Bleach' })]), /live-action block/, anime.grid);

  const idless = gridFixture(show('fargo', 'Fargo', { id: null }), season('fargoS1', 1, 6, 44000), season('fargoS2', 2, 3, null));
  refuses(planOf([], [idless.insertAt(idless.end, 3)]), /live-action block/, idless.grid);

  // The same two blocks accept a row that carries no runtime, so the refusals
  // above are the runtime rule rather than anything else about the block.
  assert.doesNotThrow(() => assertPlanSafe(planOf([], [anime.insertAt(anime.end, 3, { title: 'Bleach', episodes: null })]), anime.grid));
  assert.doesNotThrow(() => assertPlanSafe(planOf([], [idless.insertAt(idless.end, 3, { episodes: null })]), idless.grid));
});

// The write requests go out in fill order and the last one wins, so a bound that
// inspects the first runtime cell and waves a second through is no bound at all.
test('every runtime cell an insert carries is bounded, not just the first', () => {
  const insert = fx.insertAt(fx.end, 3);
  const first = insert.fill.find((c) => c.field === 'Episodes')!;
  refuses(
    planOf([], [{ ...insert, fill: [...insert.fill, { ...first, value: { numberValue: 49 } }] }]),
    /not a plausible per-episode day fraction/,
  );
});
