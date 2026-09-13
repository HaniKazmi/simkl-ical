import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPlanSafe, UnsafePlanError } from '../../src/sheet/5-guard.ts';
import { a1, type Grid } from '../../src/sheet/2-grid.ts';
import type { SheetPlan } from '../../src/sheet/4-plan.ts';
import type { HeaderName } from '../../src/sheet/2-grid.ts';
import { fx, gridFixture, H, planOf, raw, season, show, TODAY, TODAY_NOTE } from './fixture.ts';
import { dateSerial } from '../../src/sheet/values.ts';
import { plainDateIn } from '../../src/shared/dates.ts';
import { rowByLabel } from '../helpers.ts';

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
});

// `Status` is the show row's derived state, and never a season row's to hold.
test('Status may only be written on a show row', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([fx.cell('fargo', 'Status', { stringValue: 'Ended' })]), fx.grid));
  refuses(planOf([fx.cell('fargoS2', 'Status', { stringValue: 'Ended' })]), /Status may only be written on a show row/);
});

test('Status is a state, not a watch date', () => {
  refuses(planOf([fx.cell('fargo', 'Status', { stringValue: TODAY_NOTE })]), /a state, not a watch date/);
});

// `Note` is the season row's last-watched date, and the show row's own `Note`
// cell is the block-height helper formula — the formula refusal catches it
// before the row-kind rule ever runs.
test('Note may only be written on a season row, and a show row’s Note cell is a formula', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([fx.cell('fargoS2', 'Note', { stringValue: TODAY_NOTE })]), fx.grid));
  refuses(planOf([fx.cell('fargo', 'Note', { stringValue: TODAY_NOTE })]), /is a formula/);
});

// The insert path's version of the closed-row refusal. A row created dated is
// closed from its first read, so every later edit to it is refused — a note
// put there in the same fill is one nothing can ever take away, the exact
// state the clear exists to prevent.
test('a row created with an end date may not also be given a note', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.insertAt(fx.end, 3, { note: TODAY_NOTE })), fx.grid));
  refuses(planOf([], fx.insertAt(fx.end, 3, { end: TODAY, note: TODAY_NOTE })), /may not also carry a watch note/);
});

// A note left behind on an open row is a date that stops being true; a note
// taken away from an open row is one nothing puts back this poll. Only `End`
// arriving makes it redundant, so only that batch may remove it.
test('a season’s watch note is only cleared by the batch that dates the row', () => {
  const noted = gridFixture(show('fargo', 'Fargo'), season('fargoS1', 1, 6, 44000), season('fargoS2', 2, 3, null, { note: TODAY_NOTE }));
  const clear = noted.cell('fargoS2', 'Note', undefined);
  refuses(planOf([clear]), /only be cleared on the row that is being closed/, noted.grid);
  assert.doesNotThrow(() => assertPlanSafe(planOf([noted.cell('fargoS2', 'End', { numberValue: TODAY }), clear]), noted.grid));
});

// The Note column on a season row is otherwise free space, and what a reader
// types there is not reconstructible. The row still closes — around the note,
// not through it.
test('text the sync did not write is neither overwritten nor cleared', () => {
  const typed = gridFixture(show('fargo', 'Fargo'), season('fargoS1', 1, 6, 44000), season('fargoS2', 2, 3, null, { note: 'rewatching with Sam' }));
  refuses(planOf([typed.cell('fargoS2', 'Note', { stringValue: TODAY_NOTE })]), /this sync did not write/, typed.grid);
  refuses(
    planOf([typed.cell('fargoS2', 'End', { numberValue: TODAY }), typed.cell('fargoS2', 'Note', undefined)]),
    /this sync did not write/,
    typed.grid,
  );
});

// Emptying a cell is how a note is removed, and the only thing that is ever
// removed: everywhere else an absent value is a planner that lost one.
test('no field but Note may be emptied', () => {
  refuses(planOf([fx.cell('fargoS2', 'Episode', undefined)]), /not a field this sync may empty/);
  refuses(planOf([fx.cell('fargoS2', 'End', undefined)]), /not a field this sync may empty/);
  // An insert fills a row; nothing there was ever a value to remove. Checked on
  // `Note` too, the one field an edit may empty: the whitelist has to be what
  // refuses it, not the value-shaped rule that would otherwise reach it first
  // and report an implausible date.
  const emptied = (insert: ReturnType<typeof fx.insertAt>, field: HeaderName) => ({
    ...insert,
    fill: insert.fill.map((f) => (f.field === field ? { ...f, value: undefined } : f)),
  });
  refuses(planOf([], emptied(fx.insertAt(fx.end, 3), 'Season')), /not a field this sync may empty/);
  refuses(planOf([], emptied(fx.insertAt(fx.end, 3, { note: TODAY_NOTE }), 'Note')), /not a field this sync may empty/);
});

// The same bound `End` gets, on the same fact one column earlier.
test('a watch note is bounded like the end date it becomes', () => {
  const soon = Temporal.Now.plainDateISO('UTC').add({ days: 3 }).toString();
  refuses(planOf([fx.cell('fargoS2', 'Note', { stringValue: soon })]), /not a plausible last-watched date/);
  refuses(planOf([fx.cell('fargoS2', 'Note', { stringValue: '1998-04-02' })]), /not a plausible last-watched date/);
  refuses(planOf([fx.cell('fargoS2', 'Note', { numberValue: TODAY })]), /not a plausible last-watched date/);
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
  refuses(planOf([blank.cell('fargoS1', 'Runtime', { numberValue: 45 })]), /already has an end date/, blank.grid);
  refuses(planOf([blank.cell('fargoS1', 'Note', { stringValue: TODAY_NOTE })]), /already has an end date/, blank.grid);

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

  const tbd = gridFixture(show('fargo', 'Fargo'), season('fargoS1', 1, 6, null, { note: null }));
  const held = gridFixture(show('fargo', 'Fargo'), raw('fargoS1', rowByLabel(H, { Season: 1, Episodes: 6, 'Start Date': 43000, 'End Date': 'TBD' })));
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
    raw('fargoS2', rowByLabel(H, { Season: 2, Episodes: '12', 'Start Date': 45000 })),
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
// The never-write-a-formula rule applied to the planned *value*: the target
// check cannot see it on an insert, which has no cell in the snapshot at all,
// and on an edit a formula written over a literal replaces a value with
// something that recalculates.
test('a planned formula is refused on an edit and on a season insert alike', () => {
  refuses(planOf([fx.cell('fargoS2', 'Episode', { formulaValue: '=1+1' })]), /a formula is never written/);
  const insert = fx.insertAt(fx.end, 3);
  const formula = { ...insert, fill: insert.fill.map((c) => (c.field === 'Episode' ? { ...c, value: { formulaValue: '=1+1' } } : c)) };
  refuses(planOf([], formula), /a formula is never written/);
});

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
  season('fargoS2', 2, 3, null, { runtime: null }),
  season('fargoS3', 3, 2, null, { runtime: null }),
);

const runtimeCell = (value: number, row = 'fargoS2') => blank.cell(row, 'Runtime', { numberValue: value });

/** The End edit a runtime always rides beside, on the same row. */
const endCell = (row = 'fargoS2') => blank.cell(row, 'End', { numberValue: TODAY });

// Without this baseline the refusals below could pass for the wrong reason.
test('a runtime into a blank cell on the row being closed is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([endCell(), runtimeCell(49)]), blank.grid));
});

// The planner writes the pair together or not at all. A runtime on a row left
// open fills a cell with nothing to close it, and the next poll finds it
// non-blank and never revisits it.
test('a runtime on a row nothing is closing is refused', () => {
  refuses(planOf([runtimeCell(49)]), /only be written on the row that is being closed/, blank.grid);
  // An End elsewhere in the plan is not this row's.
  refuses(planOf([endCell('fargoS3'), runtimeCell(49, 'fargoS2')]), /only be written on the row that is being closed/, blank.grid);
});

// A hand-typed runtime is a correction, and the row closes in the same batch,
// so an overwrite could never be undone.
test('a runtime over a cell that already holds one is refused', () => {
  // The shared fixture's open season carries 45 already.
  refuses(planOf([fx.cell('fargoS2', 'End', { numberValue: TODAY }), fx.cell('fargoS2', 'Runtime', { numberValue: 49 })]), /already holds a value/);
});

// The column holds whole minutes, so a day fraction is the wrong value
// entirely, not merely out of bounds: 49/1440 is 49 minutes to a reader of
// the old TIME format and 0.03 minutes to this column.
test('a day fraction written where whole minutes belong is refused', () => {
  refuses(planOf([endCell(), runtimeCell(49 / 1440)]), /not a per-episode runtime in whole minutes/, blank.grid);
});

test('a runtime outside the column’s bounds is refused, in whole minutes', () => {
  refuses(planOf([endCell(), runtimeCell(0)]), /not a per-episode runtime in whole minutes/, blank.grid);
  refuses(planOf([endCell(), runtimeCell(1440)]), /not a per-episode runtime in whole minutes/, blank.grid);
  refuses(planOf([endCell(), runtimeCell(-1)]), /not a per-episode runtime in whole minutes/, blank.grid);
  refuses(planOf([endCell(), runtimeCell(1.5)]), /not a per-episode runtime in whole minutes/, blank.grid);
  assert.doesNotThrow(() => assertPlanSafe(planOf([endCell(), runtimeCell(1)]), blank.grid));
  assert.doesNotThrow(() => assertPlanSafe(planOf([endCell('fargoS3'), runtimeCell(1439, 'fargoS3')]), blank.grid));
});

// A runtime is refused on a show row's own Runtime cell, which is blank on
// every real show row — the row-kind rule is what catches it, not the formula
// refusal `Note` hits above.
test('a runtime is refused on a show row', () => {
  refuses(planOf([fx.cell('fargo', 'Runtime', { numberValue: 45 })]), /may only be written on a season row/);
});

// A dated row is frozen for good: the runtime rides the batch that closes the
// row, never a later one.
test('a runtime is refused on a row that already has an end date', () => {
  refuses(planOf([runtimeCell(49, 'fargoS1')]), /already has an end date/, blank.grid);
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
    season('fargoS2', 2, 3, null, { runtime: null }),
    season('fargoS3', 3, 2, null, { runtime: null }),
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
  refuses(planOf([endCell(), runtimeCell(49)]), /live-action block/, scoped('anime', 1).grid);
  refuses(planOf([endCell(), runtimeCell(49)]), /live-action block/, scoped('show', null).grid);
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
    season('fargoS2', 2, 3, null, { runtime: null }),
    // Only the id separates this row from fargoS2, so the refusal can only be
    // the id rule.
    season('fargoS3', 3, 2, null, { runtime: null, id: 99 }),
  );
  assert.doesNotThrow(() =>
    assertPlanSafe(planOf([owned.cell('fargoS2', 'End', { numberValue: TODAY }), owned.cell('fargoS2', 'Runtime', { numberValue: 49 })]), owned.grid),
  );
  refuses(
    planOf([owned.cell('fargoS3', 'End', { numberValue: TODAY }), owned.cell('fargoS3', 'Runtime', { numberValue: 49 })]),
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
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.insertAt(fx.end, 3, { runtime: null })), fx.grid));
});

test('an insert’s runtime is bounded exactly as an edit’s is, in whole minutes', () => {
  for (const bad of [49 / 1440, 0, 1440, -1, 1.5]) {
    refuses(planOf([], fx.insertAt(fx.end, 3, { runtime: bad })), /not a per-episode runtime in whole minutes/);
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
  assert.doesNotThrow(() => assertPlanSafe(planOf([], anime.insertAt(anime.end, 3, { title: 'Bleach', runtime: null })), anime.grid));
  assert.doesNotThrow(() => assertPlanSafe(planOf([], idless.insertAt(idless.end, 3, { runtime: null })), idless.grid));
});

// Writes go out in fill order and the last wins, so a bound that only inspects
// the first runtime cell is no bound at all.
test('every runtime cell an insert carries is bounded, not just the first', () => {
  const insert = fx.insertAt(fx.end, 3);
  const first = insert.fill.find((c) => c.field === 'Runtime')!;
  refuses(
    planOf([], { ...insert, fill: [...insert.fill, { ...first, value: { numberValue: 1440 } }] }),
    /not a per-episode runtime in whole minutes/,
  );
});

// --- the block insert ------------------------------------------------------
//
// Every rule below has one test, and each asserts its own message: several of
// these are defence in depth behind the placement rule, which on a small grid
// implies both the block-boundary rule and the season-row-above rule. Asserting
// the message is what keeps "delete this rule and exactly one test fails" true
// for the rules placement subsumes.

/** Two blocks in franchise order, so a wrong placement is expressible. */
const twoBlocks = gridFixture(
  show('alien', 'Alien', { id: 10 }),
  season('alienS1', 1, 6, 44000),
  show('zoo', 'Zoo', { id: 20 }),
  season('zooS1', 1, 6, 44000),
);

// The baseline the section varies from: this must pass, or every refusal below
// is vacuous.
test('a well-formed block below the last season row is allowed', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.blockAt(fx.end)), fx.grid));
});

// A show row alone is a block whose roll-ups count the next block's rows as
// its own; a season row alone joins whichever block sits above it.
test('a block is exactly two rows', () => {
  refuses(planOf([], { ...fx.blockAt(fx.end), rows: 3 as 2 }), /a block is a show row and one season row/);
});

test('a block is never inserted at or above the header row', () => {
  refuses(planOf([], { ...fx.blockAt(fx.end), row: 0 }), /at or above the header row/);
});

// `rowCount` is the declared grid, and both rows of the span have to fit
// inside it. Asked before placement, which would otherwise be the only rule
// that could fire.
test('a block with no room left in the declared grid is refused', () => {
  refuses(planOf([], fx.blockAt(13)), /there is no room for a block/);
});

// A row landing mid-block splits it, and every roll-up above the split starts
// counting the wrong rows.
test('a block inside another block rather than between two is refused', () => {
  refuses(planOf([], fx.blockAt(fx.at.fargoS2!)), /is inside a block rather than between two/);
});

// inheritFromBefore takes formats from the row above, and a show row's render
// a correct date serial as 46265. Row 1 is a block boundary and its row above
// is the header, so this is the rule that fires and not the one before it.
test('a block with no season row above it is refused', () => {
  refuses(planOf([], fx.blockAt(fx.at.fargo!)), /no season row above the insertion point/);
});

// The tab is in Franchise order. Row 5 of the two-block grid is a boundary
// with a season row above it, so both earlier rules pass and only the order
// itself refuses.
test('a block placed anywhere but where Franchise order puts it is refused', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([], twoBlocks.blockAt(3)), twoBlocks.grid));
  refuses(planOf([], twoBlocks.blockAt(5)), /Franchise order puts Severance at row 4, not 6/, twoBlocks.grid);
});

// Both are a duplicate block: the same show twice, with two ids or two rows
// under one name.
test('a block for an id already on the grid is refused', () => {
  refuses(planOf([], fx.blockAt(fx.end, { id: 1 })), /SIMKL id 1 is already on the tab/);
});

test('a block for a title the tab already holds is refused', () => {
  refuses(planOf([], fx.blockAt(fx.end, { title: 'Fargo', franchise: 'Fargo' })), /row 2 already holds Fargo/);
});

test('a block may only fill the two rows it creates, and neither has a previous value', () => {
  const block = fx.blockAt(fx.end);
  const stray = { ...block, fill: [...block.fill, fx.blockCell(fx.end + 4, 'Network', { stringValue: 'BBC' })] };
  refuses(planOf([], stray), /may only fill the two rows it creates/);

  const previous = { ...block, fill: block.fill.map((c, i) => (i === 0 ? { ...c, previous: { stringValue: 'x' } } : c)) };
  refuses(planOf([], previous), /cannot have a previous value/);
});

// `Episode Length (min)` is blank on all 309 show rows: an episode length is a
// season's, and the show row's cell is not a roll-up of them.
test('a show row may not carry a field outside its own whitelist', () => {
  const block = fx.blockAt(fx.end);
  refuses(planOf([], { ...block, fill: [...block.fill, fx.blockCell(fx.end, 'Runtime', { numberValue: 45 })] }), /not a field a new show row may carry/);
});

// The one exception to never writing a formula is the template for the row it
// lands on. Anything else in that cell is a frozen number where a live roll-up
// belongs, and nothing revisits a show row to notice.
test('a roll-up cell must be exactly the template for the row the block lands on', () => {
  const block = fx.blockAt(fx.end);
  const wrong = block.fill.map((c) => (c.field === 'Episode' && c.row === fx.end ? fx.blockCell(fx.end, 'Episode', { formulaValue: '=SUM(K5:K9)' }) : c));
  refuses(planOf([], { ...block, fill: wrong }), /is not the roll-up formula this row takes/);

  // The template for a *different* row is the failure a hand-written literal
  // invites: the helper it names would count another block's height.
  const shifted = block.fill.map((c) => (c.field === 'Note' && c.row === fx.end ? { ...c, value: fx.blockAt(fx.at.fargoS1!).fill.find((f) => f.field === 'Note')!.value } : c));
  refuses(planOf([], { ...block, fill: shifted }), /is not the roll-up formula this row takes/);
});

test('a literal cell carrying a formula is refused', () => {
  const block = fx.blockAt(fx.end);
  const formula = block.fill.map((c) => (c.field === 'Network' ? { ...c, value: { formulaValue: '=A1' } } : c));
  refuses(planOf([], { ...block, fill: formula }), /a formula is never written/);
});

// A link with nothing behind it is a broken image for the life of the row.
test('an artwork link is refused unless the run has a bucket to link into', () => {
  refuses(planOf([], fx.blockAt(fx.end, { bucket: 'shows' })), /no artwork bucket configured/);
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.blockAt(fx.end, { bucket: 'shows' })), fx.grid, { showBucket: 'shows' }));
  // The bucket the run holds, not whichever the planner named.
  assert.throws(
    () => assertPlanSafe(planOf([], fx.blockAt(fx.end, { bucket: 'other' })), fx.grid, { showBucket: 'shows' }),
    /is not the roll-up formula this row takes/,
  );
});

test('a show row missing any cell nothing will come back to fill is refused', () => {
  const block = fx.blockAt(fx.end);
  const without = (field: string) => ({ ...block, fill: block.fill.filter((c) => !(c.row === fx.end && c.field === field)) });
  refuses(planOf([], without('id')), /a show row must carry ID/);
  refuses(planOf([], without('Show')), /a show row must carry Title/);
  refuses(planOf([], without('Franchise')), /a show row must carry Franchise/);
  refuses(planOf([], without('Type')), /a show row must carry Type/);
  refuses(planOf([], without('Note')), /a show row must carry Seasons \/ Last Watched/);
});

// The cells are checked against the insert's own claims, not the upstream's:
// the title decides the collision test and the franchise decides the row.
test('the title and franchise cells must say what the block was placed as', () => {
  const block = fx.blockAt(fx.end);
  refuses(planOf([], { ...block, title: 'Severance', fill: block.fill.map((c) => (c.field === 'Show' ? { ...c, value: { stringValue: 'Severence' } } : c)) }), /but the block is for Severance/);
  refuses(planOf([], { ...block, fill: block.fill.map((c) => (c.field === 'Franchise' ? { ...c, value: { stringValue: 'Apple' } } : c)) }), /but the block was placed under Severance/);
});

// Only `show` is ever inserted: an anime block uses the cour model, where a
// new cour is a separate SIMKL title.
test('a block is always typed show', () => {
  const block = fx.blockAt(fx.end);
  refuses(planOf([], { ...block, fill: block.fill.map((c) => (c.field === 'Type' ? { ...c, value: { stringValue: 'anime' } } : c)) }), /is not show/);
});

// Text, matching all 189 show rows: a number compares unequal to every other
// id cell, so a later run would not recognise its own block.
test('the id cell is the SIMKL id as text, and the block’s own', () => {
  const block = fx.blockAt(fx.end);
  refuses(planOf([], { ...block, fill: block.fill.map((c) => (c.field === 'id' ? { ...c, value: { numberValue: 900 } } : c)) }), /id must be the SIMKL id as text/);
  refuses(planOf([], { ...block, fill: block.fill.map((c) => (c.field === 'id' ? { ...c, value: { stringValue: '901' } } : c)) }), /but the block is for 900/);
});

// A closed set, unlike an edit's: nothing revisits an inserted show row, so a
// status outside the five the tab holds colours as nothing for good.
test('a block’s status is one of the five the tab holds', () => {
  const block = fx.blockAt(fx.end);
  refuses(planOf([], fx.blockAt(fx.end, { status: 'Airing' })), /is not a status this tab holds/);
  refuses(planOf([], { ...block, fill: block.fill.map((c) => (c.field === 'Status' ? { ...c, value: { numberValue: 1 } } : c)) }), /Status must be non-empty text/);
  // Omitted entirely is a real state: `deriveStatus` has no opinion on a show
  // on hold, and the cell stays blank.
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.blockAt(fx.end, { status: null })), fx.grid));
});

test('a block’s certificate is a BBFC age', () => {
  refuses(planOf([], fx.blockAt(fx.end, { certificate: 16 })), /is not a BBFC certificate age/);
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.blockAt(fx.end, { certificate: null })), fx.grid));
});

test('a block’s genres are ones the renderer colours, and no more than three secondaries', () => {
  refuses(planOf([], fx.blockAt(fx.end, { genre: 'Crime' })), /Crime is not one of the genres/);
  refuses(planOf([], fx.blockAt(fx.end, { genres: 'Action, Comedy, Drama, Horror' })), /4 genres exceeds the 3/);
  refuses(planOf([], fx.blockAt(fx.end, { genres: 'Sci-Fi, Anime' })), /Anime is not one of the genres/);
  // 27 rows on the films tab hold no secondaries at all, and the show tab does
  // the same: `''.split(',')` is `['']`, which is not a genre.
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.blockAt(fx.end, { genres: '' })), fx.grid));
});

// The vocabulary is open — 76 distinct networks across the tab — so the rule
// is that the cell says something, not which broadcaster it names.
test('a block’s network is non-empty text', () => {
  refuses(planOf([], fx.blockAt(fx.end, { network: '  ' })), /Network must be non-empty text/);
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.blockAt(fx.end, { network: 'A Channel Nobody Has Heard Of' })), fx.grid));
});

// Per row, because `Start` on the show row and `Start` on the season row are
// the same field id at two different columns.
test('a field filled twice on one row is refused, and the same field on both rows is not', () => {
  const block = fx.blockAt(fx.end);
  const twice = { ...block, fill: [...block.fill, fx.blockCell(fx.end, 'Network', { stringValue: 'BBC' })] };
  refuses(planOf([], twice), /Network is filled twice on row 5/);
  assert.ok(block.fill.filter((c) => c.field === 'Start').length === 2, 'Start is on both rows of a well-formed block');
});

// The season row under a new show row is an ordinary inserted season row, held
// to the identical whitelist — `id` is not on it, so the row inherits the show
// row's rather than naming a season of its own.
test('the season row of a block may only carry a season row’s fields', () => {
  const block = fx.blockAt(fx.end);
  const status = { ...block, fill: [...block.fill, fx.blockCell(fx.end + 1, 'Status', { stringValue: 'Ended' })] };
  refuses(planOf([], status), /not a field a new season row may carry/);
  const id = { ...block, fill: [...block.fill, fx.blockCell(fx.end + 1, 'id', { stringValue: '900' })] };
  refuses(planOf([], id), /not a field a new season row may carry/);
});

test('the season row’s number is a whole season, and the one the block was built for', () => {
  refuses(planOf([], fx.blockAt(fx.end, { season: 0 })), /only whole numbered seasons/);
  refuses(planOf([], fx.blockAt(fx.end, { season: 1.5 })), /only whole numbered seasons/);
  const block = fx.blockAt(fx.end);
  const wrong = { ...block, fill: block.fill.map((c) => (c.field === 'Season' && c.row === fx.end + 1 ? { ...c, value: { numberValue: 4 } } : c)) };
  refuses(planOf([], wrong), /the season cell says 4 but the block is for S1/);
});

test('a block with no season row cell at all is refused', () => {
  const block = fx.blockAt(fx.end);
  refuses(planOf([], { ...block, fill: block.fill.filter((c) => !(c.row === fx.end + 1 && c.field === 'Season')) }), /must carry the season row it was built for/);
});

// A dated row is never revisited, so a note created beside an End is one
// nothing can ever remove — the state the clear exists to prevent.
test('a block’s season row may not be created dated and noted at once', () => {
  refuses(planOf([], fx.blockAt(fx.end, { end: TODAY - 1 })), /may not also carry a watch note/);
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.blockAt(fx.end, { end: TODAY - 1, note: null })), fx.grid));
});

// The same bound an edit's note gets: the note is a last-watched date, which
// is the same fact `End` carries one column later in the row's life.
test('a block’s last-watched note is bounded like a watch date', () => {
  refuses(planOf([], fx.blockAt(fx.end, { note: '2099-01-01' })), /is not a plausible last-watched date/);
  refuses(planOf([], fx.blockAt(fx.end, { note: 'started it' })), /is not a plausible last-watched date/);
});

test('a block’s season runtime is bounded in whole minutes', () => {
  refuses(planOf([], fx.blockAt(fx.end, { runtime: 1440 })), /not a per-episode runtime in whole minutes/);
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.blockAt(fx.end, { runtime: null })), fx.grid));
});

// The scope rule reads the *planned* show row, because the block is not in the
// grid yet. `0` is a whole number and a digits string, so it passes every value
// rule and still names no SIMKL entry — which is exactly what the runtime write
// may not be given.
test('a block’s runtime is refused where the planned show row names no SIMKL entry', () => {
  refuses(planOf([], fx.blockAt(fx.end, { id: 0 })), /live-action block that carries ids on its show row/);
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.blockAt(fx.end, { id: 0, runtime: null })), fx.grid));
});

// The budget is the poll's blast radius, and a block is two of its rows.
test('a block counts both of its rows against SHEET_MAX_ROWS', () => {
  assert.doesNotThrow(() => assertPlanSafe(planOf([], fx.blockAt(fx.end)), fx.grid, { maxRows: 2 }));
  assert.throws(() => assertPlanSafe(planOf([], fx.blockAt(fx.end)), fx.grid, { maxRows: 1 }), /2 distinct rows this poll exceeds SHEET_MAX_ROWS=1/);
});
