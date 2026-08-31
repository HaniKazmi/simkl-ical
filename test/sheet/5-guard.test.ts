import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPlanSafe, UnsafePlanError } from '../../src/sheet/5-guard.ts';
import { a1, type Grid } from '../../src/sheet/2-grid.ts';
import type { SheetPlan } from '../../src/sheet/4-plan.ts';
import type { HeaderName } from '../../src/sheet/2-grid.ts';
import { fx, gridFixture, H, planOf, raw, season, show, TODAY, TODAY_NOTE } from './fixture.ts';
import { dateSerial } from '../../src/sheet/values.ts';
import { plainDateIn } from '../../src/shared/dates.ts';

const refuses = (plan: SheetPlan, pattern: RegExp, against: Grid = fx.grid): void =>
  assert.throws(() => assertPlanSafe(plan, against), (err: Error) => err instanceof UnsafePlanError && pattern.test(err.message));

// The baseline the file varies from: this must pass, or every refusal below
// is vacuous.
test('an ordinary count advance on an open season is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([fx.cell('fargoS2', 'Episode', { numberValue: 8 })]), fx.grid));
});

// --- what may be written, and where ---------------------------------------

test('a formula target is refused unconditionally', () => {
  refuses(planOf([fx.cell('fargo', 'Episode', { numberValue: 9 })]), /is a formula/);
  refuses(planOf([fx.cell('fargoS2', 'Length', { numberValue: 1 })]), /not a field this sync may write/);
});

// The one field whose meaning depends on the row it lands on: the derived
// state above, when the season was last watched below. Neither value is
// writable where the other belongs.
test('Status is the derived state on a show row and a watch date on a season row', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([fx.cell('fargo', 'Status', { stringValue: 'Ended' })]), fx.grid));
  assert.doesNotThrow(() => assertPlanSafe(planOf([fx.cell('fargoS2', 'Status', { stringValue: TODAY_NOTE })]), fx.grid));
  refuses(planOf([fx.cell('fargoS2', 'Status', { stringValue: 'Ended' })]), /not a plausible last-watched date/);
  refuses(planOf([fx.cell('fargo', 'Status', { stringValue: TODAY_NOTE })]), /a state, not a watch date/);

  // A show row whose derived cells are literals, not formulas. The formula
  // guard cannot fire here, so the row-kind guard stands on its own.
  const literal = gridFixture(raw('fargo', ['Fargo', 'Ended', 1, 6, 45000, 44000, 6, 0.1, 1, 'show']), season('fargoS1', 1, 6, null));
  assert.throws(
    () => assertPlanSafe(planOf([{ ...literal.cell('fargo', 'End', { numberValue: TODAY }), previous: { numberValue: 44000 } }]), literal.grid),
    /only be written on a season row/,
  );
});

// The insert path's version of the closed-row refusal. A row created dated is
// closed from its first read, so every later edit to it is refused — a note
// put there in the same fill is one nothing can ever take away, the exact
// state the clear exists to prevent.
test('a row created with an end date may not also be given a note', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.insertAt(fx.end, 3, { status: TODAY_NOTE })), fx.grid));
  refuses(planOf([], fx.insertAt(fx.end, 3, { end: TODAY, status: TODAY_NOTE })), /may not also carry a watch note/);
});

// A note left behind on an open row is a date that stops being true; a note
// taken away from an open row is one nothing puts back this poll. Only `End`
// arriving makes it redundant, so only that batch may remove it.
test('a season’s watch note is only cleared by the batch that dates the row', () => {
  const noted = gridFixture(show('fargo', 'Fargo'), season('fargoS1', 1, 6, 44000), season('fargoS2', 2, 3, null, { status: TODAY_NOTE }));
  const clear = noted.cell('fargoS2', 'Status', undefined);
  refuses(planOf([clear]), /only be cleared on the row that is being closed/, noted.grid);
  assert.doesNotThrow(() => assertPlanSafe(planOf([noted.cell('fargoS2', 'End', { numberValue: TODAY }), clear]), noted.grid));
});

// The Status column on a season row is otherwise free space, and what a reader
// types there is not reconstructible. The row still closes — around the note,
// not through it.
test('text the sync did not write is neither overwritten nor cleared', () => {
  const typed = gridFixture(show('fargo', 'Fargo'), season('fargoS1', 1, 6, 44000), season('fargoS2', 2, 3, null, { status: 'rewatching with Sam' }));
  refuses(planOf([typed.cell('fargoS2', 'Status', { stringValue: TODAY_NOTE })]), /this sync did not write/, typed.grid);
  refuses(
    planOf([typed.cell('fargoS2', 'End', { numberValue: TODAY }), typed.cell('fargoS2', 'Status', undefined)]),
    /this sync did not write/,
    typed.grid,
  );
});

// Emptying a cell is how a note is removed, and the only thing that is ever
// removed: everywhere else an absent value is a planner that lost one.
test('no field but Status may be emptied', () => {
  refuses(planOf([fx.cell('fargoS2', 'Episode', undefined)]), /not a field this sync may empty/);
  refuses(planOf([fx.cell('fargoS2', 'End', undefined)]), /not a field this sync may empty/);
  // An insert fills a row; nothing there was ever a value to remove. Checked on
  // `Status` too, the one field an edit may empty: the whitelist has to be what
  // refuses it, not the value-shaped rule that would otherwise reach it first
  // and report an implausible date.
  const emptied = (insert: ReturnType<typeof fx.insertAt>, field: HeaderName) => ({
    ...insert,
    fill: insert.fill.map((f) => (f.field === field ? { ...f, value: undefined } : f)),
  });
  refuses(planOf([], emptied(fx.insertAt(fx.end, 3), 'Season')), /not a field this sync may empty/);
  refuses(planOf([], emptied(fx.insertAt(fx.end, 3, { status: TODAY_NOTE }), 'Status')), /not a field this sync may empty/);
});

// The same bound `End` gets, on the same fact one column earlier.
test('a watch note is bounded like the end date it becomes', () => {
  const soon = Temporal.Now.plainDateISO('UTC').add({ days: 3 }).toString();
  refuses(planOf([fx.cell('fargoS2', 'Status', { stringValue: soon })]), /not a plausible last-watched date/);
  refuses(planOf([fx.cell('fargoS2', 'Status', { stringValue: '1998-04-02' })]), /not a plausible last-watched date/);
  refuses(planOf([fx.cell('fargoS2', 'Status', { numberValue: TODAY })]), /not a plausible last-watched date/);
});

test('a field outside the whitelist is refused however plausible', () => {
  refuses(planOf([fx.cell('fargoS2', 'Season', { numberValue: 3 })]), /not a field this sync may write/);
  refuses(planOf([fx.cell('fargo', 'Show', { stringValue: 'Renamed' })]), /not a field this sync may write/);
  refuses(planOf([fx.cell('fargoS2', 'id', { numberValue: 7 })]), /not a field this sync may write/);
  refuses(planOf([fx.cell('fargo', 'Type', { stringValue: 'anime' })]), /not a field this sync may write/);
});

/**
 * A dated row settles every fact it settles once — except the two that are not
 * its own to settle. `Start` and `End` say what SIMKL says, so freezing them
 * would keep a stale copy rather than preserve a decision.
 */
test('a closed season is touched only by the fields that follow SIMKL', () => {
  refuses(planOf([blank.cell('fargoS1', 'Episode', { numberValue: 9 })]), /already has an end date/, blank.grid);
  refuses(planOf([blank.cell('fargoS1', 'Episodes', { numberValue: 45 / 1440 })]), /already has an end date/, blank.grid);
  refuses(planOf([blank.cell('fargoS1', 'Status', { stringValue: TODAY_NOTE })]), /already has an end date/, blank.grid);

  assert.doesNotThrow(() => assertPlanSafe(planOf([blank.cell('fargoS1', 'End', { numberValue: TODAY })]), blank.grid));
  assert.doesNotThrow(() => assertPlanSafe(planOf([blank.cell('fargoS1', 'Start', { numberValue: 43000 })]), blank.grid));
});

// The one thing the pair can say between them that neither says alone. The
// existing end date is read off the snapshot, since `SeasonRow` keeps only
// whether the row is closed.
test('a start date may not fall after the row’s end date', () => {
  refuses(planOf([blank.cell('fargoS1', 'Start', { numberValue: 44001 })]), /would fall after the row's end/, blank.grid);
  assert.doesNotThrow(() => assertPlanSafe(planOf([blank.cell('fargoS1', 'Start', { numberValue: 44000 })]), blank.grid));

  // Against the End this same batch writes, not the one the row holds now: a
  // row being closed and re-dated in one plan must be checked as it will read.
  const plan = planOf([blank.cell('fargoS2', 'Start', { numberValue: TODAY }), blank.cell('fargoS2', 'End', { numberValue: TODAY })]);
  assert.doesNotThrow(() => assertPlanSafe(plan, blank.grid));
  refuses(planOf([blank.cell('fargoS2', 'Start', { numberValue: TODAY }), blank.cell('fargoS2', 'End', { numberValue: 44000 })]), /would fall after the row's end/, blank.grid);
});

// A blank or hand-typed End names no day to be after, so there is nothing to
// compare — refusing there would refuse the whole plan over a cell the sync is
// not writing.
test('a start date is unbounded above where the end cell names no day', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([blank.cell('fargoS2', 'Start', { numberValue: TODAY })]), blank.grid));

  const tbd = gridFixture(show('fargo', 'Fargo'), season('fargoS1', 1, 6, null, { status: null }));
  const held = gridFixture(show('fargo', 'Fargo'), raw('fargoS1', [null, null, 1, 6, 43000, 'TBD', null, null, null, null]));
  assert.doesNotThrow(() => assertPlanSafe(planOf([tbd.cell('fargoS1', 'Start', { numberValue: TODAY })]), tbd.grid));
  assert.doesNotThrow(() => assertPlanSafe(planOf([held.cell('fargoS1', 'Start', { numberValue: TODAY })]), held.grid));
});

// Why a wrong-but-larger number is the dangerous failure: a smaller one is
// caught here, a larger one is not.
test('a count never goes backwards, or sideways', () => {
  refuses(planOf([fx.cell('fargoS2', 'Episode', { numberValue: 2 })]), /would not increase/);
  refuses(planOf([fx.cell('fargoS2', 'Episode', { numberValue: 3 })]), /would not increase/);
  refuses(planOf([fx.cell('fargoS2', 'Episode', { numberValue: 0 })]), /positive whole number/);
});

// The one way never-backwards can be defeated: a count typed as text carries
// only a stringValue, parses to no count, and a comparison against 0 would
// write a smaller number over a larger one.
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

// A mismatch means the plan was built against a different grid — the one
// failure that writes to the wrong places.
test('a cell that has moved under the plan is refused', () => {
  refuses(planOf([fx.cell('fargoS2', 'Episode', { numberValue: 8 }, { numberValue: 99 })]), /no longer holds what the plan was built on/);
});

// The column is the write coordinate; disagreeing with the resolved header map
// means writing the wrong cell.
test('a target whose column does not match the resolved header map is refused', () => {
  const displaced = { ...fx.cell('fargoS2', 'Episode', { numberValue: 8 }), column: 99 };
  refuses(planOf([displaced]), /does not match the resolved position/);
});

// --- budget ----------------------------------------------------------------

// Truncating would apply half of what is, by hypothesis, a wrong plan.
test('over budget refuses everything rather than trimming', () => {
  const many = Array.from({ length: 5 }, () => fx.cell('fargoS2', 'Episode', { numberValue: 8 }));
  assert.throws(() => assertPlanSafe(planOf(many), fx.grid, { maxEdits: 4 }), /exceeds SHEET_MAX_EDITS=4/);
  assert.throws(() => assertPlanSafe(planOf(many), fx.grid, { maxRows: 0 }), /exceeds SHEET_MAX_ROWS=0/);
});

// --- inserts ---------------------------------------------------------------

test('a well-formed insert below an existing season row is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.insertAt(fx.end, 3)), fx.grid));
});

// inheritFromBefore takes formats from the row above; a show row there makes a
// correct date serial render as 46265.
test('an insert with no season row above it is refused', () => {
  refuses(planOf([], fx.insertAt(fx.at.fargoS1!, 1)), /no season row above the insertion point/);
});

test('an insert outside its own block is refused', () => {
  const two = gridFixture(show('fargo', 'Fargo'), season('fargoS1', 1, 6, 44000), show('silo', 'Silo', { status: 'Watching' }), season('siloS1', 1, 3, null));
  const insert = { ...two.insertAt(two.end, 2), title: 'Fargo' };
  refuses(planOf([], insert), /not inside Fargo's block/, two.grid);
});

test('a fractional or season-zero row is never inserted', () => {
  refuses(planOf([], fx.insertAt(fx.end, 4.5)), /only whole numbered seasons/);
  refuses(planOf([], fx.insertAt(fx.end, 0)), /only whole numbered seasons/);
});

// A separate whitelist from the edits one: an insert fills six columns, so one
// shared list would either forbid it or widen ordinary edits.
test('an insert may only fill its own whitelist, and only its own row', () => {
  const insert = fx.insertAt(fx.end, 3);
  const strayField = { ...insert, fill: [...insert.fill, { ...insert.fill[0]!, field: 'id' as HeaderName, column: fx.grid.columns.id, address: a1(fx.end, fx.grid.columns.id) }] };
  refuses(planOf([], strayField), /not a field this sync may write/);

  const strayRow = { ...insert, fill: insert.fill.map((f, i) => (i === 0 ? { ...f, row: fx.at.fargoS2!, address: a1(fx.at.fargoS2!, f.column) } : f)) };
  refuses(planOf([], strayRow), /may only fill the row it creates/);

  const hasPrevious = { ...insert, fill: insert.fill.map((f, i) => (i === 0 ? { ...f, previous: { numberValue: 1 } } : f)) };
  refuses(planOf([], hasPrevious), /cannot have a previous value/);
});

// Past the snapshot's end both sides read undefined, so the value comparison
// would agree with itself and wave the write through.
test('a target beyond the end of the snapshot is refused', () => {
  refuses(planOf([{ ...fx.cell('fargoS2', 'Episode', { numberValue: 8 }), row: 99, address: a1(99, fx.grid.columns.Episode), previous: undefined }]), /outside the snapshot/);
});

// One-row-per-run is carried by the plan's type — `insert` is a single value,
// so a second insert is unrepresentable rather than refused. Plan indices are
// pre-write and `insertDimension` applies cumulatively, so a second insert
// would land a row off.
test('one insert alongside edits is still allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([fx.cell('fargoS2', 'Episode', { numberValue: 9 })], fx.insertAt(fx.end, 2)), fx.grid));
});

/**
 * The plausibility ceiling is tomorrow in the viewer's zone. Computed in UTC
 * it is a day late for anyone behind UTC, widening the bound to two days.
 * 02:00Z on the 15th is still the 14th in New York, so the local ceiling is
 * the 15th where a UTC one would be the 16th; the serial sits between.
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
 * Season rows with blank runtime cells — the state the write is for; the
 * shared fixture's rows carry one already. The second open row tells "an End
 * somewhere in the plan" from "an End on this row".
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

// Without this baseline the refusals below could pass for the wrong reason.
test('a runtime into a blank cell on the row being closed is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([endCell(), runtimeCell(49 / 1440)]), blank.grid));
});

// The planner writes the pair together or not at all. A runtime on a row left
// open fills a cell with nothing to close it, and the next poll finds it
// non-blank and never revisits it.
test('a runtime on a row nothing is closing is refused', () => {
  refuses(planOf([runtimeCell(49 / 1440)]), /only be written on the row that is being closed/, blank.grid);
  // An End elsewhere in the plan is not this row's.
  refuses(planOf([endCell('fargoS3'), runtimeCell(49 / 1440, 'fargoS2')]), /only be written on the row that is being closed/, blank.grid);
});

// A hand-typed runtime is a correction, and the row closes in the same batch,
// so an overwrite could never be undone.
test('a runtime over a cell that already holds one is refused', () => {
  // The shared fixture's open season carries 0.0153 already.
  refuses(planOf([fx.cell('fargoS2', 'End', { numberValue: TODAY }), fx.cell('fargoS2', 'Episodes', { numberValue: 49 / 1440 })]), /already holds a value/);
});

// At or above 1 the number is minutes where a day fraction belongs, and every
// Length in the block multiplies by 1440.
test('minutes written where a day fraction belongs are refused', () => {
  refuses(planOf([endCell(), runtimeCell(49)]), /not a plausible per-episode day fraction/, blank.grid);
  refuses(planOf([endCell(), runtimeCell(1)]), /not a plausible per-episode day fraction/, blank.grid);
  refuses(planOf([endCell(), runtimeCell(0)]), /not a plausible per-episode day fraction/, blank.grid);
  refuses(planOf([endCell(), runtimeCell(-1 / 1440)]), /not a plausible per-episode day fraction/, blank.grid);
  // Under half a minute rounds to nothing the sheet can show.
  refuses(planOf([endCell(), runtimeCell(0.4 / 1440)]), /not a plausible per-episode day fraction/, blank.grid);
});

// On the real sheet a show row's Episodes cell is a roll-up formula, so the
// formula rule fires first; strip the formula and the season-row rule catches
// it. Both paths are asserted — the formula alone would leave a show row with
// an empty runtime cell writable.
test('a runtime is refused on a show row, by whichever rule reaches it first', () => {
  refuses(planOf([fx.cell('fargo', 'Episodes', { numberValue: 49 / 1440 })]), /is a formula/);

  const bareShow = [...show(null, 'Fargo').cells];
  bareShow[H.indexOf('Episodes')] = null;
  const stripped = gridFixture(raw('fargo', bareShow), season('fargoS1', 1, 6, 44000), season('fargoS2', 2, 3, null, { episodes: null }));
  refuses(planOf([{ ...stripped.cell('fargo', 'Episodes', { numberValue: 49 / 1440 }), previous: undefined }]), /may only be written on a season row/, stripped.grid);
});

// A dated row is frozen for good: the runtime rides the batch that closes the
// row, never a later one.
test('a runtime is refused on a row that already has an end date', () => {
  refuses(planOf([runtimeCell(49 / 1440, 'fargoS1')]), /already has an end date/, blank.grid);
});

/**
 * The same grid under an `anime` type, or a show row with no id — the two
 * shapes whose season number means nothing to TVDB. Otherwise identical to
 * `blank`, so a refusal can only be the scope rule.
 */
const scoped = (type: string, id: number | null) =>
  gridFixture(
    show('fargo', 'Fargo', { id, type }),
    season('fargoS1', 1, 6, 44000),
    season('fargoS2', 2, 3, null, { episodes: null }),
    season('fargoS3', 3, 2, null, { episodes: null }),
  );

/**
 * The planner's scope decision, re-derived because it cannot be taken back:
 * the same batch dates the row, so the blank-cell rule stops protecting it the
 * instant the write lands. An anime block's season number addresses no TVDB
 * season — every cour is `season: 1` and a franchise shares one TVDB id.
 */
test('a runtime is refused in an anime block, and in a block whose show row has no id', () => {
  // Type decides the first case, not a missing id: this block has an id and is
  // still refused. A hand-maintained sheet can put a show-row id on an anime
  // block, which a bare "no ids" test reads as live-action.
  refuses(planOf([endCell(), runtimeCell(49 / 1440)]), /live-action block/, scoped('anime', 1).grid);
  refuses(planOf([endCell(), runtimeCell(49 / 1440)]), /live-action block/, scoped('show', null).grid);
});

/**
 * A row with its own id has a season number that is not the entry's — a split
 * cour, or Doctor Who's 2024 renumbering. Handing it to TVDB asks about a
 * season the row does not mean.
 */
test('a runtime is refused on a season row that carries its own id', () => {
  const owned = gridFixture(
    show('fargo', 'Fargo'),
    season('fargoS1', 1, 6, 44000),
    season('fargoS2', 2, 3, null, { episodes: null }),
    // Only the id separates this row from fargoS2, so the refusal can only be
    // the id rule.
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
 * The insert path has neither rule that protects an edit: no cell to find
 * blank, no `End` edit to ride — one fill creates and dates the row. Scope and
 * bounds are the whole guard here.
 */
test('an insert carrying a runtime and an End is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.insertAt(fx.end, 3, { end: TODAY })), fx.grid));
});

// The state a row left for its close goes in as: the insert whitelist is a
// whitelist, not a requirement.
test('an insert with no runtime cell at all is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.insertAt(fx.end, 3, { episodes: null })), fx.grid));
});

test('an insert’s runtime is bounded exactly as an edit’s is', () => {
  for (const bad of [49, 1, 0, -1 / 1440, 0.4 / 1440]) {
    refuses(planOf([], fx.insertAt(fx.end, 3, { episodes: bad })), /not a plausible per-episode day fraction/);
  }
});

// `checkCell` runs above the `existing` early-return, so it reaches a row that
// does not exist yet. A date serial is the one insert value a wrong bound
// writes silently: it renders as a plausible date whatever it holds.
test('an insert’s End is bounded exactly as an edit’s is', () => {
  refuses(planOf([], fx.insertAt(fx.end, 3, { end: TODAY + 5 })), /not a plausible date serial/);
  refuses(planOf([], fx.insertAt(fx.end, 3, { end: 1000 })), /not a plausible date serial/);
});

// Re-derived on the insert path too: the same fill dates the row, so nothing
// protects the cell a second time.
test('an insert carrying a runtime into a block TVDB cannot describe is refused', () => {
  const anime = gridFixture(show('bleach', 'Bleach', { status: 'Watching', type: 'anime' }), season('bleachS1', 1, 6, 44000), season('bleachS2', 2, 3, null));
  refuses(planOf([], anime.insertAt(anime.end, 3, { title: 'Bleach' })), /live-action block/, anime.grid);

  const idless = gridFixture(show('fargo', 'Fargo', { id: null }), season('fargoS1', 1, 6, 44000), season('fargoS2', 2, 3, null));
  refuses(planOf([], idless.insertAt(idless.end, 3)), /live-action block/, idless.grid);

  // Both blocks accept a row with no runtime, so the refusals above are the
  // runtime rule and nothing else.
  assert.doesNotThrow(() => assertPlanSafe(planOf([], anime.insertAt(anime.end, 3, { title: 'Bleach', episodes: null })), anime.grid));
  assert.doesNotThrow(() => assertPlanSafe(planOf([], idless.insertAt(idless.end, 3, { episodes: null })), idless.grid));
});

// Writes go out in fill order and the last wins, so a bound that only inspects
// the first runtime cell is no bound at all.
test('every runtime cell an insert carries is bounded, not just the first', () => {
  const insert = fx.insertAt(fx.end, 3);
  const first = insert.fill.find((c) => c.field === 'Episodes')!;
  refuses(
    planOf([], { ...insert, fill: [...insert.fill, { ...first, value: { numberValue: 49 } }] }),
    /not a plausible per-episode day fraction/,
  );
});
