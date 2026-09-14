import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPlanSafe } from '../../src/sheet/5-guard.ts';
import { parseGrid } from '../../src/sheet/2-grid.ts';
import {
  deriveStatus,
  insertSeason,
  insertSpan,
  planWrites,
  observeWatches,
  planRecord,
  planSync,
  statusSource,
  type PlanOptions,
  type SheetPlan,
} from '../../src/sheet/4-plan.ts';
import { rowsTouched } from '../../src/sheet/6-requests.ts';
import { anyTitleRecorded, artworkFormula, BLOCK_SCAN_ROWS, ROLLUP_FIELDS, showRowFormulas } from '../../src/sheet/values.ts';
import { BLOCK_SHOW, blockLibrary, gridFixture, season as namedSeason, raw as namedRaw, show as namedShow } from './fixture.ts';
import { seasonShapes, type TitleCatalogue } from '../../src/sheet/3-catalogue.ts';
import { indexLibrary } from '../../src/sheet/1-index.ts';
import { dateSerial, seasonKey, titleRecordKey, type Baseline, type BaselineEntry } from '../../src/sheet/values.ts';
import { isoOf, plainDateIn } from '../../src/shared/dates.ts';
import type { EpisodeDetail, ShowDetail } from '../../src/api/simkl/types.ts';
import type { Insert } from '../../src/sheet/4-plan.ts';
import { col, daysAgo, libraryOf, rowByLabel, sheetSnapshot, SHEET_HEADERS, todaySerial, type CellSpec, type ItemSpec, seasonRow, showRow } from '../helpers.ts';

const H = SHEET_HEADERS;
const TZ = 'Europe/London';

// What an insert says about itself through the derivations every consumer uses,
// so a test reads a block's height the way BUILD and VERIFY do rather than off a
// field beside the season list.
const seasonOf = (insert: Insert | null) => (insert === null ? undefined : insertSeason(insert));
const spanOf = (insert: Insert | null) => (insert === null ? undefined : insertSpan(insert).rows);

const show = showRow;
const season = (n: number, episode: number | null, end: number | null, id: number | string | null = null, seasonNote: string | null = null): CellSpec[] =>
  seasonRow(n, episode, end, { id, note: seasonNote });

/** The last-watched note a row watched at these timestamps should carry. */
const note = (timestamps: string[]): string => plainDateIn(Temporal.Instant.from(timestamps.at(-1) as string), TZ).toString();

/** `n` episodes of which `aired` have aired, all in one season. */
const eps = (number: number, total: number, aired = total): EpisodeDetail[] =>
  Array.from({ length: total }, (_, i) => ({ season: number, episode: i + 1, type: 'episode', aired: i < aired }));

const watched = (count: number, days = 3): string[] => Array.from({ length: count }, (_, i) => daysAgo(days + count - i));

interface Scenario {
  rows: CellSpec[][];
  items: ItemSpec[];
  episodes?: Record<number, EpisodeDetail[]>;
  details?: Record<number, ShowDetail>;
  /** SIMKL id -> TVDB id, as the detail lookup would have folded it in. */
  tvdbIds?: Record<number, number>;
  /** SIMKL id -> season -> average minutes, or null for "asked, nothing usable". */
  runtimes?: Record<number, Record<number, number | null>>;
  /** Ids the missing-row note stays quiet about — the films tab's. */
  filed?: Set<number>;
}

/**
 * A grid, a library, and a partially answered catalogue. A title with no
 * `details` entry is one whose `/tv/{id}` has not answered — the store writes
 * `tvdbId` (number or explicit null) the moment it lands, so absence is what
 * the planner reads as pending.
 */
const scenario = ({ rows, items, episodes = {}, details = {}, tvdbIds = {}, runtimes = {}, filed }: Scenario) => {
  const grid = parseGrid(sheetSnapshot([H, ...rows]));
  const index = indexLibrary(libraryOf(...items));
  const titles = new Map<number, TitleCatalogue>();
  const entry = (id: number) => titles.get(id) ?? titles.set(id, { shapes: new Map(), seasonRuntimes: new Map() }).get(id)!;
  for (const [id, list] of Object.entries(episodes)) entry(Number(id)).shapes = seasonShapes(list);
  for (const [id, detail] of Object.entries(details)) Object.assign(entry(Number(id)), detail, { tvdbId: null });
  for (const [id, tvdbId] of Object.entries(tvdbIds)) entry(Number(id)).tvdbId = tvdbId;
  for (const [id, seasons] of Object.entries(runtimes)) {
    for (const [n, minutes] of Object.entries(seasons)) entry(Number(id)).seasonRuntimes.set(Number(n), minutes);
  }
  // `anyTitleRecorded` off the baseline the test seeded, the way `sync.ts`
  // counts it off the record it loaded.
  const result = (baseline?: Baseline) =>
    planSync(grid, index, titles, { timezone: TZ, baseline, anyTitleRecorded: anyTitleRecorded(baseline ?? new Map()), filed });
  return {
    grid,
    index,
    titles,
    /** The whole result; the three below are the parts callers usually want. */
    result,
    plan: () => result().plan,
    demands: () => result().demands,
    runtimeDemands: () => result().demands.runtimes,
  };
};

const skipMessages = (plan: SheetPlan): string => plan.skips.map((s) => s.message).join('\n');

// --- the core case ---------------------------------------------------------

// The shape of nearly every edit: a count advancing on an open season, with
// its last watch noted beside it and nothing on the show row.
test('a part-watched open season advances its count and notes when it was last watched', () => {
  const seen = watched(7);
  const { plan } = scenario({
    rows: [show('Malcolm in the Middle', 'Watching', 100), season(6, 22, 44000), season(7, 1, null)],
    items: [{ id: 100, status: 'completed', seasons: { 6: watched(22, 400), 7: seen }, watched: 29, total: 44 }],
    episodes: { 100: [...eps(6, 22), ...eps(7, 22)] },
    details: { 100: { status: 'ended', runtime: 22 } },
  });
  const result = plan();
  assert.deepEqual(result.edits.map((e) => [e.address, e.field, e.value?.numberValue ?? e.value?.stringValue]), [
    ['K4', 'Episode', 7],
    ['O4', 'Note', note(seen)],
  ]);
  assert.equal(result.insert, null);
});

// Show-row cells are formula roll-ups; any show-row edit but Status is a bug.
test('nothing but Status is ever planned for a show row', () => {
  const { plan, grid } = scenario({
    rows: [show('Futurama', 'Up To Date', 3407), season(10, 13, 44000)],
    items: [{ id: 3407, status: 'watching', seasons: { 10: watched(13, 400), 11: watched(6) }, watched: 19, total: 23, notAired: 4 }],
    episodes: { 3407: [...eps(10, 13), ...eps(11, 10, 6)] },
    details: { 3407: { status: 'airing', runtime: 22 } },
  });
  const showRow = grid.blocks[0]!.row;
  const onShowRow = plan().edits.filter((e) => e.row === showRow);
  assert.deepEqual(onShowRow.map((e) => e.field), ['Status']);
});

// --- the cut-off -----------------------------------------------------------

// The cut-off has no exemptions: a dormant sheet produces zero edits, so no
// run can retro-edit years of history.
test('a show with no recent activity produces nothing at all, show row included', () => {
  const { plan } = scenario({
    rows: [show('The Sandman', 'Ended', 200), season(2, 1, null)],
    items: [{ id: 200, status: 'completed', seasons: { 2: watched(11, 400) }, watched: 11, total: 11 }],
    episodes: { 200: eps(2, 11) },
    details: { 200: { status: 'ended' } },
  });
  const result = plan();
  assert.deepEqual(result.edits, []);
  assert.equal(result.insert, null);
});

test('within an eligible show, a dormant season is still left alone', () => {
  const { plan } = scenario({
    rows: [show('Doctor Who', 'Ended', 8530), season(12, 10, 43000), season(13, 1, null), season(14, 1, null, 2463827)],
    items: [
      { id: 8530, status: 'watching', seasons: { 12: watched(10, 900), 13: watched(8, 600) }, watched: 18, total: 18 },
      { id: 2463827, status: 'watching', seasons: { 1: watched(8, 4) }, watched: 8, total: 8 },
    ],
    episodes: { 8530: [...eps(12, 10), ...eps(13, 8)] },
    details: { 8530: { status: 'ended' }, 2463827: { status: 'ended' } },
  });
  // S14 is recent and advances; S13 was last watched 600 days ago and does not.
  assert.deepEqual(plan().edits.filter((e) => e.field === 'Episode').map((e) => e.address), ['K5']);
});

/**
 * The window asks whether something happened here lately, and a watch date
 * cannot answer it: marking a 2005 show's episodes watched today stamps each at
 * its air date, so every one of them is years outside the window while the
 * change itself is today's. What is recent is the *change*, and the only record
 * of it is what this sync itself last observed.
 */
const marked = (): Scenario => ({
  rows: [show('The Sandman', 'Ended', 200), season(2, 1, null)],
  items: [{ id: 200, status: 'completed', seasons: { 2: watched(11, 400) }, watched: 11, total: 11 }],
  episodes: { 200: eps(2, 11) },
  details: { 200: { status: 'ended' } },
});

/** A baseline as it stands after a run that saw the title with `count` episodes of season 2 watched. */
const recorded = (count: number, extra: BaselineEntry = {}): Baseline =>
  new Map([
    [titleRecordKey(200), { Status: 'completed' }],
    [seasonKey(200, 2), { Watched: String(count), ...extra }],
  ]);

test('a season whose count differs from what was recorded is in scope, whatever its watch dates say', () => {
  const counts = scenario(marked())
    .result(recorded(1))
    .plan.edits.filter((e) => e.field === 'Episode');
  assert.deepEqual(
    counts.map((e) => [e.address, e.value?.numberValue]),
    [['K3', 11]],
  );
});

/**
 * What keeps the wider signal idempotent: the record decides which rows are
 * read, and each cell is still compared against what the row holds — so a title
 * marked whole today writes only the rows that disagree.
 */
test('a row already agreeing with SIMKL takes no edit from its count having moved', () => {
  // Open and still airing, so nothing but the comparisons can decline it: the
  // count matches, the season cannot close, and the note dates a count that did
  // not move.
  const agreed = scenario({
    ...marked(),
    rows: [show('The Sandman', 'Watching', 200), season(2, 11, null)],
    items: [{ id: 200, status: 'watching', seasons: { 2: watched(11, 400) }, watched: 11, total: 12, notAired: 1 }],
    episodes: { 200: eps(2, 12, 11) },
  });
  assert.deepEqual(
    agreed
      .result(new Map([[titleRecordKey(200), { Status: 'watching' }], [seasonKey(200, 2), { Watched: '1' }]]))
      .plan.edits.filter((e) => e.row === 2),
    [],
  );
});

/**
 * The first sighting rule, at the level of the whole feature: an install
 * upgrading into this code has a baseline of `Start` and `End` and not one title
 * entry, so nothing has moved and nothing is written. Every count and status is
 * recorded instead, and the run *after* it is the first that can see a change.
 */
test('a baseline with no title entry makes nothing recent, and records what it saw', () => {
  // `Start` and `End` at exactly what SIMKL says, which is the state an install
  // upgrading into this code is in: the two tracked fields have been followed
  // for months and the two new ones have never been recorded at all.
  const seen = watched(11, 400);
  const first = scenario(marked()).result(
    new Map([[seasonKey(200, 2), { Start: seen[0] as string, End: seen.at(-1) as string }]]),
  );
  assert.deepEqual(first.plan.edits, []);
  assert.deepEqual(first.plan.notes, []);
  assert.equal(first.observed.get(titleRecordKey(200))?.Status, 'completed');
  assert.equal(first.observed.get(seasonKey(200, 2))?.Watched, '11');
  assert.equal(first.writing.size, 0, 'nothing is banked, because nothing is written');
});

/** A fresh install's empty record is the same state: everything is a first sighting. */
test('an empty baseline makes nothing recent', () => {
  assert.deepEqual(scenario(marked()).result(new Map()).plan.edits, []);
});

/**
 * A title is known when its key exists, and `Status` is the only field a title
 * entry ever carries — so the run that plans a `Status` edit banks that field
 * and leaves the entry empty. Read as a missing title, such an entry makes the
 * title new again on the next poll, which is the one reading that back-fills
 * rows nobody asked for.
 */
test('a banked Status leaves the title known', () => {
  const banked = scenario({
    rows: [show('The Sandman', 'Watching', 200), season(2, 11, null)],
    items: [{ id: 200, status: 'dropped', seasons: { 2: watched(11, 400) }, watched: 11, total: 11 }],
    episodes: { 200: eps(2, 11) },
    details: { 200: { status: 'ended' } },
  }).result(new Map([[titleRecordKey(200), { Status: 'watching' }], [seasonKey(200, 2), { Watched: '11' }]]));
  assert.deepEqual(banked.observed.get(titleRecordKey(200)), {}, 'the entry is present and empty, not gone');

  // That entry, and nothing else about the title: the block is dormant, so its
  // count is the only thing that can bring it back into scope — and a count
  // only compares against something for a title this sync has seen.
  const known = scenario(marked()).result(new Map([[titleRecordKey(200), {}]]));
  assert.deepEqual(
    known.plan.edits.filter((e) => e.field === 'Episode').map((e) => [e.address, e.value?.numberValue]),
    [['K3', 11]],
  );
});

/**
 * A block the tab already holds was built to the height its reader wanted, so
 * the seasons they left out are not rows the sync may add. Newness is the block
 * *walk*'s reason to offer every watched season of a title with no rows at all;
 * on an existing block it would back-fill a hand-started grid from S1 the first
 * time the title was seen, and nothing revisits an inserted row.
 */
test('a hand-started block is offered no season its reader left out', () => {
  const hand = scenario({
    rows: [show('Buffy the Vampire Slayer', 'Watching', 201), season(1, 22, 44000), season(5, 22, 44100)],
    items: [
      {
        id: 201,
        status: 'completed',
        // S1 inside the window is what puts the block in scope at all; S2-S4
        // are years old and have never been recorded, so only newness could
        // offer them.
        seasons: { 1: watched(22, 3), 2: watched(22, 400), 3: watched(22, 400), 4: watched(22, 400), 5: watched(22, 400) },
        watched: 110,
        total: 110,
      },
    ],
    episodes: { 201: [1, 2, 3, 4, 5].flatMap((n) => eps(n, 22)) },
    details: { 201: { status: 'ended', runtime: 42 } },
    // Another title recorded, which is what makes an unrecorded one *new*
    // rather than a first run where nothing is.
  }).result(new Map([[titleRecordKey(300), { Status: 'completed' }]]));
  assert.equal(hand.plan.insert, null, 'no row is added for S2');
  assert.equal(hand.plan.deferred, 0, 'and none waits behind it');
});

/**
 * Banked, never observed. Recorded on the pass that plans the edit, the next
 * poll would find the count unmoved and a batch that never landed would leave
 * the row one episode short for good.
 */
test("a planned count is banked against its write, not recorded as seen", () => {
  const { plan, observed, writing } = scenario(marked()).result(recorded(1));
  assert.ok(plan.edits.some((e) => e.field === 'Episode'));
  assert.equal(writing.get(seasonKey(200, 2))?.Watched, '11');
  assert.equal(observed.get(seasonKey(200, 2))?.Watched, undefined);
});

/**
 * A status that moved is the block's own signal: nothing was watched, so no row
 * is in scope, and the one cell a title-level move can reach is the show row's.
 */
test('a status move with no count move edits Status alone', () => {
  const moved = scenario({
    rows: [show('The Sandman', 'Watching', 200), season(2, 11, null)],
    items: [{ id: 200, status: 'dropped', seasons: { 2: watched(11, 400) }, watched: 11, total: 11 }],
    episodes: { 200: eps(2, 11) },
    details: { 200: { status: 'ended' } },
  }).result(new Map([[titleRecordKey(200), { Status: 'watching' }], [seasonKey(200, 2), { Watched: '11' }]]));
  assert.deepEqual(
    moved.plan.edits.map((e) => [e.field, e.value?.stringValue]),
    [['Status', 'Abandoned']],
  );
  assert.equal(moved.writing.get(titleRecordKey(200))?.Status, 'dropped', 'and the membership is banked against that write');
});

/**
 * A library marked whole puts every row of every block in scope at once, and a
 * plan over `SHEET_MAX_EDITS` is refused **whole** — so without a cap nothing
 * at all would be written, on every poll, until the rows aged out of the
 * window. Held back instead, the same rows land a budget at a time.
 *
 * The rows admitted are taken in grid order, and each of them costs up to four
 * cells, so the cap leaves that much clear rather than filling to the edge.
 */
const wideBacklog = (rows: number): Scenario => ({
  rows: [show('Long Show', 'Watching', 700), ...Array.from({ length: rows }, (_, i) => season(i + 1, 0, null))],
  items: [
    {
      id: 700,
      status: 'completed',
      seasons: Object.fromEntries(Array.from({ length: rows }, (_, i) => [i + 1, watched(3, 500 + i)])),
      watched: rows * 3,
      total: rows * 3,
    },
  ],
  episodes: { 700: Array.from({ length: rows }, (_, i) => eps(i + 1, 3)).flat() },
  details: { 700: { status: 'ended', runtime: 40 } },
});

/** Every season recorded at zero, so every row's count has moved and none was watched inside the window. */
const allAtZero = (rows: number): Baseline => {
  const seen: Baseline = new Map([[titleRecordKey(700), { Status: 'completed' }]]);
  for (let n = 1; n <= rows; n += 1) seen.set(seasonKey(700, n), { Watched: '0' });
  return seen;
};

test('a backlog of rows whose counts moved is drained under the edit budget, never refused', () => {
  const rows = 15;
  const { grid, index, titles } = scenario(wideBacklog(rows));
  const { plan } = planSync(grid, index, titles, { timezone: TZ, baseline: allAtZero(rows), maxEdits: 12 });

  assert.ok(plan.edits.length <= 12, `${plan.edits.length} edits is inside the budget`);
  assert.ok(plan.deferred > 0, 'and the rest are known waiting work, which is what asks for another poll');
  assert.match(plan.notes.join('\n'), /row\(s\) whose counts moved wait for a later poll/);
  // The whole point: a plan the guard would refuse writes nothing at all, on
  // every poll, for as long as the backlog stands.
  assert.doesNotThrow(() => assertPlanSafe(plan, grid, { timezone: TZ, maxEdits: 12 }));

  // Grid order, so the drain takes the same rows every run until they land:
  // the show row's Status, then an unbroken run from the top of the block.
  const touched = [...new Set(plan.edits.map((e) => e.row))].sort((a, b) => a - b);
  assert.deepEqual(touched, Array.from({ length: touched.length }, (_, i) => i + 1));
  assert.ok(touched.length < rows, 'and stops short of the whole backlog');
});

/**
 * The two budgets bind on different backlogs, and one admission step covers
 * both: a backlog of rows each gaining a single cell crosses `SHEET_MAX_ROWS`
 * long before `SHEET_MAX_EDITS`, so a step bounding edits alone would plan a
 * batch the guard refuses **whole** — on every poll, since a record-scoped row
 * has no window to age out of.
 */
test('a backlog of one-edit rows drains under the row budget, not only the edit budget', () => {
  const rows = 15;
  const { grid, index, titles } = scenario(wideBacklog(rows));
  const limits = { maxEdits: 40, maxRows: 6 };
  const { plan } = planSync(grid, index, titles, { timezone: TZ, baseline: allAtZero(rows), ...limits });

  assert.ok(plan.edits.length > 0, 'rows are written rather than the whole plan being refused');
  assert.ok(rowsTouched(planWrites(plan)) <= limits.maxRows, `${rowsTouched(planWrites(plan))} rows is inside the row budget`);
  assert.ok(plan.deferred > 0, 'and the rest ask for another poll');
  assert.doesNotThrow(() => assertPlanSafe(plan, grid, { timezone: TZ, ...limits }));
});

/**
 * The budgets are a blast radius for the **poll**, not for one tab, so what a
 * planner is given is what is left of them. Counted per tab, one poll writes
 * twice the ceiling while each half reports itself inside budget.
 */
test('what an earlier half already sent shrinks what this one admits', () => {
  const rows = 15;
  const { grid, index, titles } = scenario(wideBacklog(rows));
  const whole = planSync(grid, index, titles, { timezone: TZ, baseline: allAtZero(rows), maxEdits: 40, maxRows: 12 }).plan;
  // Six rows of the poll's twelve already sent by an earlier half.
  const rest = planSync(grid, index, titles, { timezone: TZ, baseline: allAtZero(rows), maxEdits: 40, maxRows: 6 }).plan;
  assert.ok(rowsTouched(planWrites(rest)) < rowsTouched(planWrites(whole)), 'the second plan is the smaller one');
  assert.ok(rest.deferred > whole.deferred, 'and says so');
});

/**
 * Every write the run plans goes through the same admission step, the rows the
 * activity window reaches included. A week of heavy viewing is bounded, but not
 * by the poll's budgets — and a plan over either is refused **whole**, which
 * writes nothing at all and arms no retry.
 */
const datedRows = (rows: number): Scenario => ({
  ...wideBacklog(rows),
  items: [
    {
      id: 700,
      status: 'completed',
      seasons: Object.fromEntries(Array.from({ length: rows }, (_, i) => [i + 1, watched(3, 3 + i)])),
      watched: rows * 3,
      total: rows * 3,
    },
  ],
});

test('a poll of watch-dated rows is rationed rather than refused', () => {
  const rows = 15;
  const { grid, index, titles } = scenario(datedRows(rows));
  const limits = { maxEdits: 40, maxRows: 6 };
  const { plan } = planSync(grid, index, titles, { timezone: TZ, ...limits });

  assert.ok(plan.edits.length > 0, 'rows are written rather than the whole plan being refused');
  assert.ok(rowsTouched(planWrites(plan)) <= limits.maxRows, `${rowsTouched(planWrites(plan))} rows is inside the row budget`);
  assert.ok(plan.deferred > 0, 'and the rest are work another poll drains, which is what arms the retry');
  assert.match(plan.notes.join('\n'), /row\(s\) watched recently wait for a later poll/);
  assert.doesNotThrow(() => assertPlanSafe(plan, grid, { timezone: TZ, ...limits }));
});

/**
 * A guard refusal is whole-plan and the record-scoped backlog has no window to
 * age out of, so a timestamp the guard would refuse has to be declined here
 * instead: planned, it stops every unrelated edit on the sheet, on every poll,
 * for as long as its title stays in scope.
 */
const outOfRange = (stamps: string[], { aired = 2, total = 2 } = {}) =>
  scenario({
    rows: [show('Old Show', 'Watching', 702), season(1, 2, 44000)],
    items: [{ id: 702, status: 'completed', seasons: { 1: ['1994-06-01T20:00:00Z', '1994-06-08T20:00:00Z'], 2: stamps }, watched: 4, total: 2 + total }],
    episodes: { 702: [...eps(1, 2), ...eps(2, total, aired)] },
    details: { 702: { status: 'ended', runtime: 40 } },
    // S2 has no row and its count has never been recorded, so `countMoved`
    // offers it — with a timestamp outside the range the guard accepts.
  }).result(new Map([[titleRecordKey(702), { Status: 'completed' }], [seasonKey(702, 1), { Watched: '2' }]]));

test('a season whose dates fall outside the range this sync writes is skipped, and its count is left unrecorded', () => {
  // A first watch three decades back, on a season still airing so the row would
  // be inserted open and the start date is the only serial in the fill.
  const before = outOfRange(['1994-06-01T20:00:00Z', '1994-06-08T20:00:00Z'], { aired: 2, total: 3 });
  assert.equal(before.plan.insert, null, 'no row is planned from a date the guard would refuse');
  assert.match(before.plan.skips.find((s) => s.code === 'unusable-timestamp')?.message ?? '', /Old Show S2/);
  assert.equal(before.observed.get(seasonKey(702, 2))?.Watched, undefined, 'and its count stays unrecorded, so a corrected date is still a move');

  // The other end: a hand-typed watch date years ahead, on a season complete
  // enough for the fill to date the row it creates. The start is what the row
  // stands on, where the end is a cell the close path writes on any later
  // poll and already holds a row open over — so the row lands open and
  // undated rather than not at all, with its count withdrawn so the close
  // still finds it in scope.
  const ahead = outOfRange([daysAgo(10), '2031-01-01T20:00:00Z']);
  const insert = ahead.plan.insert;
  assert.ok(insert !== null && insert.kind === 'season', 'the row is added');
  assert.ok(!insert.fill.some((c) => c.field === 'End'), 'undated');
  assert.ok(!insert.fill.some((c) => c.field === 'Note'), 'and with no note either, since it reads the same stamp');
  assert.equal(insert.open, true);
  assert.match(insert.note, /last watch timestamp is unusable/);
  assert.equal(ahead.observed.get(seasonKey(702, 2))?.Watched, undefined, 'its count stays unrecorded, so the close is still owed');
});

/**
 * The note holds the same fact `End` will, one column earlier in the row's
 * life, and the guard bounds it the same way — so an unusable timestamp costs
 * the note and not the count beside it.
 */
test('a last-watched note outside the writable range is declined while the count still lands', () => {
  const ancient = ['1994-06-01T20:00:00Z', '1994-06-08T20:00:00Z', '1994-06-15T20:00:00Z'];
  const { plan: p } = scenario({
    rows: [show('Old Show', 'Watching', 703), season(1, 1, null)],
    // Still airing, so the row stays open and the note is what would be written.
    items: [{ id: 703, status: 'watching', seasons: { 1: ancient }, watched: 3, total: 4, notAired: 1 }],
    episodes: { 703: eps(1, 4, 3) },
    details: { 703: { status: 'airing', runtime: 40 } },
  }).result(new Map([[titleRecordKey(703), { Status: 'watching' }], [seasonKey(703, 1), { Watched: '1' }]]));

  assert.deepEqual(p.edits.map((e) => e.field), ['Episode'], 'the count lands, the note does not');
  assert.match(p.skips.find((s) => s.code === 'unusable-timestamp')?.message ?? '', /last watch reads 1994-06-15/);
});

/**
 * The tiers are the order the run would rather lose the work in. `Start` and
 * `End` first: a move there is one no window brings back into scope, so held
 * back it waits on nothing but another poll. Then the rows the window reaches,
 * then the run's one insert, then the rows in scope on the record alone — the
 * unbounded set, which a library marked whole fills at once.
 */
const tiered = (): Scenario => ({
  // S1 closed and agreeing, so only its dates can move; S2 open, watched this
  // week and still running; S3 open, watched two years ago, its count moved in
  // the record; S4 watched this week with no row at all.
  rows: [
    show('Tiers', 'Watching', 700),
    season(1, 3, todaySerial(TZ) - 800),
    season(2, 1, null),
    season(3, 1, null),
  ],
  items: [
    {
      id: 700,
      status: 'completed',
      seasons: { 1: watched(3, 800), 2: watched(3, 3), 3: watched(3, 700), 4: watched(3, 3) },
      watched: 12,
      total: 13,
    },
  ],
  episodes: { 700: [...eps(1, 3), ...eps(2, 4), ...eps(3, 3), ...eps(4, 3)] },
  details: { 700: { status: 'ended', runtime: 40 } },
});

/** S1's `Start` a day off what SIMKL says, S3's count two short, and the title seen. */
const tieredBaseline = (): Baseline =>
  new Map([
    [titleRecordKey(700), { Status: 'completed' }],
    [seasonKey(700, 1), { Start: daysAgo(802), Watched: '3' }],
    [seasonKey(700, 2), { Watched: '3' }],
    [seasonKey(700, 3), { Watched: '1' }],
    [seasonKey(700, 4), { Watched: '3' }],
  ]);

test('the tiers are taken in order: dates, then dated rows, then the insert, then the backlog', () => {
  const { grid, index, titles } = scenario(tiered());
  const at = (maxRows: number) => planSync(grid, index, titles, { timezone: TZ, baseline: tieredBaseline(), maxEdits: 40, maxRows }).plan;

  const dates = at(1);
  assert.deepEqual(dates.edits.map((e) => [e.address, e.field]), [['M3', 'Start']], 'the one row that fits is the date that moved');
  assert.equal(dates.insert, null);

  const andWatched = at(2);
  assert.deepEqual(
    andWatched.edits.map((e) => e.field),
    ['Start', 'Episode', 'Note'],
    'the second row is the one watched this week',
  );
  assert.equal(andWatched.insert, null, 'and the insert still waits');

  const andInsert = at(3);
  assert.equal(seasonOf(andInsert.insert), 4, 'the third row is the season with no row at all');
  assert.deepEqual(new Set(andInsert.edits.map((e) => e.row)), new Set([2, 3]), 'and the backlog row is untouched');

  const all = at(4);
  assert.ok(
    all.edits.some((e) => e.row === 4 && e.field === 'Episode'),
    'the record-scoped row is last, and lands once there is room for it',
  );
  assert.equal(all.deferred, 0);
});

/**
 * A row the poll has no room for is held back, not planned and refused: the
 * insert is one row, and a run that planned it past `SHEET_MAX_ROWS` would be
 * refused whole — losing every edit beside it and arming no retry.
 */
test('an insert the poll has no room for is deferred, and asks for another poll', () => {
  const { grid, index, titles } = scenario(tiered());
  const { plan } = planSync(grid, index, titles, { timezone: TZ, baseline: tieredBaseline(), maxEdits: 40, maxRows: 2 });
  assert.equal(plan.insert, null);
  assert.ok(plan.deferred > 0, 'which is what arms the retry that brings the poll with room');
  assert.match(plan.notes.join('\n'), /Tiers S4 is ready to add — deferred, this poll has room for/);
});

/**
 * A row the poll has no room for reports nothing of its own: the rows a full
 * budget rejects are the unbounded set, and one line per rejected season would
 * put a library marked whole into a report read beside the sheet, against the
 * one aggregate line its tier writes. The diagnosis is not lost, only late —
 * the poll that admits the row reports it.
 */
test('a row held back on budget leaves its skips to the poll that admits it', () => {
  // The count advances, so the row costs an edit and a full budget rejects it;
  // the close behind that edit meets a stamp the sync cannot write.
  const { grid, index, titles } = scenario({
    rows: [show('Old Show', 'Ended', 704), season(1, 1, null)],
    items: [{ id: 704, status: 'completed', seasons: { 1: [daysAgo(10), '2031-01-01T20:00:00Z'] }, watched: 2, total: 2 }],
    episodes: { 704: eps(1, 2) },
    details: { 704: { status: 'ended', runtime: 40 } },
  });
  const baseline = new Map([[titleRecordKey(704), { Status: 'completed' }], [seasonKey(704, 1), { Watched: '1' }]]);
  const roomy = planSync(grid, index, titles, { timezone: TZ, baseline });
  const full = planSync(grid, index, titles, { timezone: TZ, baseline, maxEdits: 0 });
  assert.ok(roomy.plan.edits.some((e) => e.field === 'Episode'), 'with room the count lands');
  assert.deepEqual(full.plan.edits, [], 'with none it is held back');
  assert.equal(full.plan.deferred, 1);
  assert.equal(full.plan.skips.some((s) => s.code === 'unusable-timestamp'), false, 'and its stamp waits for the poll that takes the row');
  assert.match(roomy.plan.skips.find((s) => s.code === 'unusable-timestamp')?.message ?? '', /Old Show S1/, 'which reports it');
});

/**
 * A row resolved by number with no episode list in the store reads as
 * incomplete the same way a half-watched season does, and the one reading a
 * close must not make is "unfinished, so nothing to do": the count would land
 * and be recorded, and a season that was in fact complete would leave scope
 * undated. Held open instead, so a poll whose lookup fails is one a withdrawn
 * or forgotten count survives.
 */
test('a row whose episode list has not come back is held open, not recorded as unfinished', () => {
  const { grid, index, titles } = scenario({
    rows: [show('Old Show', 'Ended', 706), season(1, 2, null)],
    items: [{ id: 706, status: 'completed', seasons: { 1: ['2024-01-01T20:00:00Z', '2024-01-08T20:00:00Z'] }, watched: 2, total: 2 }],
  });
  // In scope on the record alone — the count was forgotten — with a cold store.
  const forgotten = new Map([[titleRecordKey(706), { Status: 'completed' }], [seasonKey(706, 1), {}]]);
  const { plan, observed } = planSync(grid, index, titles, { timezone: TZ, baseline: forgotten });
  assert.deepEqual(plan.edits, [], 'nothing to write yet');
  assert.match(plan.skips.find((s) => s.code === 'no-episode-list' && /S1/.test(s.message))?.message ?? '', /whether it is complete is unknown/);
  assert.equal(observed.get(seasonKey(706, 1))?.Watched, undefined, 'and the count stays unrecorded, so the next poll still finds the row');
});

/**
 * A hold outlives the window as easily as a full budget does, and the row it
 * leaves open may already be recorded at SIMKL's count — one that landed while
 * the season was airing, on a season that has since become complete with
 * nothing watched since. Withdrawn, that stored count stands and the row
 * leaves scope with its watch date; forgotten, the record brings it back.
 */
test('a row held open by a hold has its count forgotten, not withdrawn', () => {
  const { grid, index, titles } = scenario({
    rows: [show('Old Show', 'Ended', 708), season(1, 2, null)],
    // Watched inside the window, count already recorded, and a cold store: the
    // close cannot tell whether the season is complete, so it holds.
    items: [{ id: 708, status: 'completed', seasons: { 1: [daysAgo(20), daysAgo(10)] }, watched: 2, total: 2 }],
  });
  const agreed = new Map([[titleRecordKey(708), { Status: 'completed' }], [seasonKey(708, 1), { Watched: '2' }]]);
  const { plan, forgetting } = planSync(grid, index, titles, { timezone: TZ, baseline: agreed });
  assert.deepEqual(plan.edits, []);
  assert.deepEqual([...(forgetting.get(seasonKey(708, 1)) ?? [])], ['Watched'], 'the held row is forgotten');
});

/**
 * Answered with nothing is an answer. A title SIMKL says is gone, or one whose
 * list holds only specials, folds to a present, empty map, and a row of it
 * reads as unfinished the way a half-watched season does: its count lands and
 * is recorded, and the row leaves scope. Read as outstanding instead, the row
 * would be held open and the block re-asked about once a day for the life of
 * the sheet.
 */
test('a row whose episode list answered empty is recorded as unfinished, not held open', () => {
  const { grid, index, titles } = scenario({
    rows: [show('Gone Show', 'Ended', 707), season(1, 2, null)],
    items: [{ id: 707, status: 'completed', seasons: { 1: ['2024-01-01T20:00:00Z', '2024-01-08T20:00:00Z'] }, watched: 2, total: 2 }],
    episodes: { 707: [] },
    details: { 707: { status: 'ended' } },
  });
  const forgotten = new Map([[titleRecordKey(707), { Status: 'completed' }], [seasonKey(707, 1), {}]]);
  const { plan, observed } = planSync(grid, index, titles, { timezone: TZ, baseline: forgotten });
  assert.equal(plan.skips.some((s) => s.code === 'no-episode-list' && /S1/.test(s.message)), false, 'the row is not held');
  assert.equal(observed.get(seasonKey(707, 1))?.Watched, '2', 'and its count is recorded, so the row leaves scope');
});

/**
 * A dated row the budget holds back is in scope only until its watch date
 * leaves the window, and its stored count may already agree with SIMKL's — a
 * first sighting recorded it, or the count landed on a poll whose close was
 * still waiting. A withdrawal leaves that stored count standing, so once the
 * window closes nothing would bring the row back and a complete row would stay
 * undated for good. Forgetting the count makes it absent on a known title,
 * which reads as moved: the record brings the row back where the window cannot.
 */
test('a dated row held back on budget is forgotten, so the record brings it back once the window cannot', () => {
  // Complete, count already recorded at SIMKL's figure, and dated inside the
  // window: the close is all the row has to write.
  const inWindow = scenario({
    rows: [show('Old Show', 'Ended', 705), season(1, 2, null)],
    items: [{ id: 705, status: 'completed', seasons: { 1: [daysAgo(20), daysAgo(10)] }, watched: 2, total: 2 }],
    episodes: { 705: eps(1, 2) },
    details: { 705: { status: 'ended', runtime: 40 } },
    tvdbIds: { 705: 1 },
    runtimes: { 705: { 1: 40 } },
  });
  const agreed = new Map([[titleRecordKey(705), { Status: 'completed' }], [seasonKey(705, 1), { Watched: '2' }]]);
  const held = planSync(inWindow.grid, inWindow.index, inWindow.titles, { timezone: TZ, baseline: agreed, maxEdits: 0 });
  assert.deepEqual(held.plan.edits, [], 'held back');
  assert.deepEqual([...(held.forgetting.get(seasonKey(705, 1)) ?? [])], ['Watched'], 'and its count is forgotten, not withdrawn');
  assert.equal(held.observed.get(seasonKey(705, 1))?.Watched, undefined);

  // The same row with its watch dates two years back — out of the window. With
  // the count still recorded nothing puts the row in scope; with it forgotten
  // the record does, and the close lands.
  const aged = scenario({
    rows: [show('Old Show', 'Ended', 705), season(1, 2, null)],
    items: [{ id: 705, status: 'completed', seasons: { 1: ['2024-01-01T20:00:00Z', '2024-01-08T20:00:00Z'] }, watched: 2, total: 2 }],
    episodes: { 705: eps(1, 2) },
    details: { 705: { status: 'ended', runtime: 40 } },
    tvdbIds: { 705: 1 },
    runtimes: { 705: { 1: 40 } },
  });
  const stillRecorded = new Map([[titleRecordKey(705), { Status: 'completed' }], [seasonKey(705, 1), { Watched: '2' }]]);
  assert.deepEqual(aged.result(stillRecorded).plan.edits, [], 'recorded at the same figure, the row is out of scope');
  const forgotten = new Map([[titleRecordKey(705), { Status: 'completed' }], [seasonKey(705, 1), {}]]);
  assert.deepEqual(aged.result(forgotten).plan.edits.map((e) => e.field), ['End'], 'forgotten, the close is made');
});

/**
 * A row in scope only because its count moved has no window to bring it back:
 * once the count is recorded it is out of scope for good. So a batch that leaves
 * such a row **open** — waiting on a runtime the close needs — must record
 * nothing about it, or the poll that could finally close it never looks at the
 * row again.
 *
 * Two polls sharing one record, the way the service does: what the first
 * observed and what its write banked both go in, and the second plans against
 * that.
 */
const heldOpen = (episode: number, runtime?: number): Scenario => ({
  // A blank runtime cell, which is the only state the runtime write may touch —
  // and so the only one that can hold the close open.
  rows: [show('Kept Open', 'Watching', 800), seasonRow(1, episode, null, { runtime: null })],
  items: [{ id: 800, status: 'completed', seasons: { 1: watched(6, 500) }, watched: 6, total: 6 }],
  episodes: { 800: eps(1, 6) },
  details: { 800: { status: 'ended', runtime: 40 } },
  tvdbIds: { 800: 111 },
  runtimes: runtime === undefined ? {} : { 800: { 1: runtime } },
});

test('a record-scoped row held open on a pending runtime is closed by the next poll', () => {
  const recorded: Baseline = new Map([[titleRecordKey(800), { Status: 'completed' }], [seasonKey(800, 1), { Watched: '2' }]]);

  // Poll one: the count advances, the close waits on TVDB, and nothing about
  // the count is recorded — not as observed, and not banked against the write.
  const first = scenario(heldOpen(2)).result(recorded);
  assert.deepEqual(
    first.plan.edits.filter((e) => e.row > 1).map((e) => e.field),
    ['Episode', 'Note'],
    'the count advances and the row stays open, carrying its last-watched note',
  );
  assert.equal(first.plan.skips.find((skip) => skip.code === 'awaiting-runtimes')?.message.includes('left open'), true);
  assert.equal(first.observed.get(seasonKey(800, 1))?.Watched, undefined, 'nothing recorded for a row left open');
  assert.equal(first.writing.get(seasonKey(800, 1))?.Watched, undefined, 'and nothing banked, which would record it on apply');

  // What the record holds after that poll applied: everything observed, plus
  // everything banked.
  const after: Baseline = new Map(recorded);
  for (const [key, entry] of [...first.observed, ...first.writing]) after.set(key, { ...after.get(key), ...entry });

  // Poll two: the sheet now holds the count, so nothing advances — and the row
  // is still in scope, because its count was never recorded. The runtime has
  // answered, so the row closes.
  const second = scenario(heldOpen(6, 45)).result(after);
  assert.deepEqual(second.plan.edits.filter((e) => e.row > 1).map((e) => e.field).sort(), ['End', 'Runtime']);
  assert.equal(second.writing.get(seasonKey(800, 1))?.End !== undefined, true, 'and the close is banked against its own write');
});

/**
 * A row deferred by the cap has its count withdrawn, not recorded. Recorded at
 * the value the sheet never received, the next poll would find it unmoved and
 * the row would never be written at all.
 */
test('a row the edit budget held back is in neither what the run records nor what it banks', () => {
  const rows = 15;
  const { grid, index, titles } = scenario(wideBacklog(rows));
  const { plan, observed, writing } = planSync(grid, index, titles, { timezone: TZ, baseline: allAtZero(rows), maxEdits: 12 });

  // Season n sits at grid row n + 1: the header, then the show row, then the
  // season rows in order.
  const written = new Set(plan.edits.map((e) => e.row));
  for (let n = 1; n <= rows; n += 1) {
    const recordedHere = observed.get(seasonKey(700, n))?.Watched;
    if (written.has(n + 1)) {
      assert.equal(writing.get(seasonKey(700, n))?.Watched, '3', `S${n} is banked against its write`);
      assert.equal(recordedHere, undefined, `S${n} is not also recorded as seen`);
    } else {
      assert.equal(recordedHere, undefined, `S${n} waits, so its count stays unrecorded`);
      assert.equal(writing.get(seasonKey(700, n))?.Watched, undefined, `S${n} banks nothing`);
    }
  }
});

/** A row watched inside the window is never held back: that set is bounded by what was watched, and holding one would put an ordinary week's viewing behind a backfill. */
test('a row watched inside the window is written even when the backlog is over budget', () => {
  const rows = 15;
  const base = wideBacklog(rows);
  const recent = scenario({
    ...base,
    items: [{ ...(base.items[0] as ItemSpec), seasons: { ...(base.items[0] as ItemSpec).seasons, 15: watched(3, 2) } }],
  });
  const { plan } = planSync(recent.grid, recent.index, recent.titles, { timezone: TZ, baseline: allAtZero(rows), maxEdits: 12 });
  assert.ok(
    plan.edits.some((e) => e.row === 16 && e.field === 'Episode'),
    'the recently watched row is in, whatever the backlog ahead of it did',
  );
  assert.ok(plan.edits.length <= 12, 'and the plan is still inside the budget');
});

/**
 * A recorded absence is not an absent record. SIMKL holding no status for a
 * title is a state, so it is recorded as one — left unrecorded, a title
 * dropping off every list and the record never having seen the title would read
 * the same, and the move back onto a list would be a first sighting.
 */
test('a title SIMKL now holds no status for has moved, and is recorded as holding none', () => {
  const none = scenario({
    rows: [show('The Sandman', 'Watching', 200), season(2, 11, null)],
    items: [{ id: 200, status: null, seasons: { 2: watched(11, 400) }, watched: 11, total: 11 }],
    episodes: { 200: eps(2, 11) },
    details: { 200: { status: 'ended' } },
  }).result(new Map([[titleRecordKey(200), { Status: 'watching' }], [seasonKey(200, 2), { Watched: '11' }]]));

  assert.deepEqual(
    none.plan.edits.map((e) => [e.field, e.value?.stringValue]),
    [['Status', 'Ended']],
    'the block is in scope on the membership move alone',
  );
  assert.equal(none.writing.get(titleRecordKey(200))?.Status, '-', 'and the absence itself is what is banked');
});

/**
 * A title whose status and counts both agree with the record is a title nothing
 * has to look at — no catalogue lookup, no note, no edit — however long the
 * sheet has been running.
 */
test('a block agreeing with the record earns no lookup', () => {
  const quiet = scenario(marked()).result(recorded(11));
  assert.deepEqual(quiet.plan.edits, []);
  assert.deepEqual(quiet.demands.catalogue, []);
});

// --- end dates -------------------------------------------------------------

// Silo S3: 7 aired of 10, all 7 watched. "Every aired episode watched" would
// stamp a permanent end date on a season with three episodes to come.
test('a season still airing is never dated, however much of it has been watched', () => {
  const { plan } = scenario({
    rows: [show('Silo', 'Watching', 300), season(2, 10, 44000), season(3, 3, null)],
    items: [{ id: 300, status: 'watching', seasons: { 2: watched(10, 400), 3: watched(7) }, watched: 17, total: 20, notAired: 3 }],
    episodes: { 300: [...eps(2, 10), ...eps(3, 10, 7)] },
    details: { 300: { status: 'airing' } },
  });
  const result = plan();
  assert.deepEqual(result.edits.filter((e) => e.field === 'End'), []);
  assert.deepEqual(result.edits.filter((e) => e.field === 'Episode').map((e) => e.value?.numberValue), [7]);
});

test('a fully aired, fully watched season is dated on its last watch', () => {
  const last = daysAgo(2);
  const { plan } = scenario({
    rows: [show('House of the Dragon', 'Watching', 400), season(3, 1, null)],
    items: [{ id: 400, status: 'watching', seasons: { 3: [...watched(7, 10), last] }, watched: 8, total: 8 }],
    episodes: { 400: eps(3, 8) },
    details: { 400: { status: 'airing' } },
  });
  const end = plan().edits.find((e) => e.field === 'End');
  assert.equal(end?.value?.numberValue, dateSerial(plainDateIn(Temporal.Instant.from(last), TZ)));
});

// --- the last-watched note --------------------------------------------------

/** A season one episode short of over, so the row stays open across variants. */
const noting = (status: string | null, { episode = 3, ...over }: Partial<Scenario> & { episode?: number } = {}) =>
  scenario({
    rows: [show('Silo', 'Watching', 900), season(1, episode, null, null, status)],
    items: [{ id: 900, status: 'watching', seasons: { 1: watched(5) }, watched: 5, total: 10, notAired: 5 }],
    episodes: { 900: eps(1, 10, 5) },
    details: { 900: { status: 'airing' } },
    ...over,
  });

/** What `noting`'s season needs to be over rather than still running. */
const FINISHED: Partial<Scenario> = {
  items: [{ id: 900, status: 'completed', seasons: { 1: watched(10) }, watched: 10, total: 10, notAired: 0 }],
  episodes: { 900: eps(1, 10) },
  details: { 900: { status: 'ended' } },
};

const noteEdit = (plan: SheetPlan) => plan.edits.find((e) => e.field === 'Note' && e.row === 2);

// The note moves with the watching, so the same row re-planned after another
// episode says the later date rather than being left alone.
test('a note already in place is advanced, and an identical one is not rewritten', () => {
  const seen = watched(5);
  assert.equal(noteEdit(noting('2019-01-01').plan())?.value?.stringValue, note(seen));
  assert.equal(noteEdit(noting(note(seen)).plan()), undefined, 'nothing to say twice');
});

// `End` says the same thing, more precisely, and a row nothing revisits should
// not keep a running note.
test('the batch that dates a row takes its note away', () => {
  const done = noting('2019-01-01', FINISHED);
  const plan = done.plan();
  assert.ok(plan.edits.some((e) => e.field === 'End'), 'the row closes');
  const cleared = noteEdit(plan);
  // Both halves: `cleared?.value` alone reads the same whether the clear was
  // planned or no Note edit was planned at all.
  assert.ok(cleared, 'the note is written off');
  assert.equal(cleared.value, undefined, 'by emptying the cell, not by writing into it');
  assert.doesNotThrow(() => assertPlanSafe(plan, done.grid, { timezone: TZ }));
});

// A row held open for another poll is still a row being watched, so the note
// it carries has to stay true.
test('a row left open on an outstanding runtime keeps its note', () => {
  const seen = watched(10);
  const waiting = scenario({
    // A blank runtime cell, so the close has something to wait for.
    rows: [show('Silo', 'Watching', 900), seasonRow(1, 3, null, { runtime: null })],
    items: [{ id: 900, status: 'completed', seasons: { 1: seen }, watched: 10, total: 10, notAired: 0 }],
    episodes: { 900: eps(1, 10) },
    // No detail: `/tv/{id}` has not answered, so the close waits.
    details: {},
  });
  const plan = waiting.plan();
  assert.deepEqual(plan.edits.filter((e) => e.field === 'End'), []);
  assert.equal(noteEdit(plan)?.value?.stringValue, note(seen));
});

// `season.note` is the cell's *result*, so a formula rendering a date reads
// as this sync's own note. The guard refuses a formula target unconditionally
// and refusal is whole-plan, so planning over one would stop every unrelated
// edit for as long as the row stays in the window.
test('a formula rendering a date is left alone, and takes nothing else down with it', () => {
  const rendered: CellSpec[] = rowByLabel(H, {
    Season: 1,
    Episodes: 1,
    'Start Date': 45000,
    'Episode Length (min)': 45,
    'Seasons / Last Watched': { formula: '=TEXT(M3,"yyyy-mm-dd")', value: '2019-01-01' },
  });
  const formula = scenario({
    rows: [show('Silo', 'Watching', 900), rendered],
    items: [{ id: 900, status: 'watching', seasons: { 1: watched(5) }, watched: 5, total: 10, notAired: 5 }],
    episodes: { 900: eps(1, 10, 5) },
    details: { 900: { status: 'airing' } },
  });
  const plan = formula.plan();
  assert.equal(noteEdit(plan), undefined);
  assert.deepEqual(plan.edits.filter((e) => e.field === 'Episode').map((e) => e.value?.numberValue), [5], 'the count still advances');
  assert.doesNotThrow(() => assertPlanSafe(plan, formula.grid, { timezone: TZ }));
});

// The note dates the count beside it. A row whose count this run leaves alone
// is left alone whole — `lastWatchedAt` drifts for reasons the count does not
// see, and a fresh date on an unmoved row would claim something happened.
test('a row whose count does not move keeps the note it has', () => {
  const settled = noting('2019-01-01', { episode: 5 });
  assert.deepEqual(settled.plan().edits.filter((e) => e.row === 2), [], 'the row is left alone whole');
});

// Every note therefore lands on a row the plan already edits: it costs an edit
// and never a distinct row, and the rows it can appear on are the ones that
// moved rather than every row watched inside the window. That is what keeps a
// budget the guard enforces by refusing *everything* out of reach.
test('a note only ever lands on a row the run is already editing', () => {
  const seen = watched(5);
  const rows: CellSpec[][] = [];
  const items: ItemSpec[] = [];
  for (let i = 0; i < 6; i += 1) {
    // Three rows behind SIMKL, three already level with it.
    rows.push(show(`Show ${i}`, 'Watching', 900 + i), season(1, i < 3 ? 2 : 5, null));
    items.push({ id: 900 + i, status: 'watching', seasons: { 1: seen }, watched: 5, total: 10, notAired: 5 });
  }
  const many = scenario({
    rows,
    items,
    episodes: Object.fromEntries(items.map((i) => [i.id, eps(1, 10, 5)])),
    details: Object.fromEntries(items.map((i) => [i.id, { status: 'airing' }])),
  });

  const plan = many.plan();
  const notes = plan.edits.filter((e) => e.field === 'Note' && e.value?.stringValue === note(seen));
  const counts = new Set(plan.edits.filter((e) => e.field === 'Episode').map((e) => e.row));
  assert.equal(notes.length, 3, 'one per row that moved, and none for the three that did not');
  assert.ok(notes.every((n) => counts.has(n.row)));
  assert.doesNotThrow(() => assertPlanSafe(plan, many.grid, { timezone: TZ }));
});

// The column is otherwise free space. What a reader typed there is not
// reconstructible, and the row still closes — around the note, not through it.
test('text the sync did not write is left where it is, closing row included', () => {
  assert.equal(noteEdit(noting('rewatching with Sam').plan()), undefined);
  const closing = noting('rewatching with Sam', FINISHED).plan();
  assert.ok(closing.edits.some((e) => e.field === 'End'), 'the row still closes');
  assert.equal(noteEdit(closing), undefined);
});

// A date records the user's decision, and a wrong one could never be
// corrected — hence `End`'s conservatism.
test('a season that already has an end date is never revisited', () => {
  const { plan } = scenario({
    rows: [show('Fargo', 'Ended', 500), season(1, 4, 44000)],
    items: [{ id: 500, status: 'completed', seasons: { 1: watched(6) }, watched: 6, total: 6 }],
    episodes: { 500: eps(1, 6) },
    details: { 500: { status: 'ended' } },
  });
  assert.deepEqual(plan().edits.filter((e) => e.row === 2), []);
});

// --- insertion, and the runtime the new row carries -------------------------

/**
 * One block, one uncovered season. `aired` short of `total` keeps the season
 * running, which decides between the blank Episodes cell and the filled one.
 */
const adding = (over: Partial<Scenario> & { aired?: number } = {}) => {
  const { aired = 10, ...rest } = over;
  return scenario({
    rows: [show('Silo', 'Watching', 800), season(1, 10, 44000)],
    items: [{ id: 800, status: 'watching', seasons: { 1: watched(10, 900), 2: watched(aired) }, watched: 10 + aired, total: 10 + 10 }],
    episodes: { 800: [...eps(1, 10), ...eps(2, 10, aired)] },
    details: { 800: { status: 'airing', runtime: 43 } },
    tvdbIds: { 800: 403245 },
    ...rest,
  });
};

const fields = (insert: Insert | null): string[] => (insert?.fill ?? []).map((f) => f.field).sort();
const cellIn = (insert: Insert | null, field: string) => insert?.fill.find((f) => f.field === field)?.value;

// A blank cell keeps the row eligible for the per-season average later; a
// filled one the runtime rules refuse for ever.
test('a season still running is inserted with a blank Episodes cell, for its close to fill', () => {
  const { plan, runtimeDemands } = adding({ aired: 6 });
  const insert = plan().insert;
  assert.equal(seasonOf(insert), 2);
  assert.deepEqual(fields(insert), ['Episode', 'Note', 'Season', 'Start']);
  assert.equal(cellIn(insert, 'Runtime'), undefined, 'left for the season average');
  assert.equal(cellIn(insert, 'End'), undefined, 'and not dated, because it is still running');
  // Stops a settled null landing while SIMKL's episode count is still moving.
  assert.deepEqual(runtimeDemands(), [], 'and nothing is asked about a season still airing');
});

test('a season already over is inserted dated, carrying its own average', () => {
  const insert = adding({ runtimes: { 800: { 2: 49 } } }).plan().insert;
  assert.deepEqual(fields(insert), ['End', 'Episode', 'Runtime', 'Season', 'Start']);
  assert.ok(cellIn(insert, 'Runtime')?.numberValue === 49, 'the TVDB average, not the show-wide 43');
  assert.ok((cellIn(insert, 'End')?.numberValue ?? 0) > 0);
});

// Dating the row now would freeze a blank cell. The date is not lost: it
// comes from the watch timestamp.
test('a season over but whose runtimes have not come back is inserted open', () => {
  const { plan } = adding();
  const insert = plan().insert;
  assert.deepEqual(fields(insert), ['Episode', 'Note', 'Season', 'Start']);
  assert.equal(cellIn(insert, 'End'), undefined, 'not dated, so the next poll can still fill the cell');
  assert.match(insert?.note ?? '', /have not come back/);
});

// Settled means no number is coming. The show-wide guess beats a cell nothing
// can ever fill again.
test('a settled null closes the new row on SIMKL’s show-wide runtime', () => {
  const insert = adding({ runtimes: { 800: { 2: null } } }).plan().insert;
  assert.deepEqual(fields(insert), ['End', 'Episode', 'Runtime', 'Season', 'Start']);
  assert.ok(cellIn(insert, 'Runtime')?.numberValue === 43);
});

// An average no episode could have is treated as the settled null, never a
// refusal: one title's bad upstream data must not cost the row.
test('an implausible average falls back to the show-wide runtime rather than being written', () => {
  const insert = adding({ runtimes: { 800: { 2: 5000 } } }).plan().insert;
  assert.equal(cellIn(insert, 'Runtime')?.numberValue, 43);
});

// Without a join key the blank cell could never be filled, so the show-wide
// runtime is the best there will ever be.
test('with no TVDB id the new row keeps SIMKL’s show-wide runtime', () => {
  const { plan, runtimeDemands } = adding({ tvdbIds: {}, aired: 6 });
  const insert = plan().insert;
  assert.ok(cellIn(insert, 'Runtime')?.numberValue === 43);
  assert.deepEqual(runtimeDemands(), []);
});

// `ShowDetail.runtime` is show-wide, so one missing value speaks for every
// season. Refusing the row would withhold the known count, start date and
// season number over one blank cell a reader can fill by hand.
test('a title SIMKL gives no runtime for is added blank rather than refused', () => {
  const { plan } = adding({ tvdbIds: {}, details: { 800: { status: 'airing' } }, aired: 6 });
  const result = plan();
  assert.ok(result.insert, 'the row goes in');
  assert.equal(cellIn(result.insert, 'Runtime'), undefined);
  assert.match(result.insert?.note ?? '', /no episode runtime to fill its Episode Length \(min\) cell/);
  assert.deepEqual(result.skips.filter((s) => /episode runtime/.test(s.message)), [], 'and nothing is refused for it');
});

/**
 * A season finished long ago, one episode in: runtimes settled, end date
 * nowhere near due. Gating the runtime on watching instead would leave a
 * binge-started season with a blank cell and a Length of zero throughout.
 */
const started = (over: Partial<Scenario> = {}) =>
  scenario({
    rows: [show('Silo', 'Watching', 800), season(1, 10, 44000)],
    items: [{ id: 800, status: 'watching', seasons: { 1: watched(10, 900), 2: watched(1) }, watched: 11, total: 20 }],
    episodes: { 800: [...eps(1, 10), ...eps(2, 10)] },
    details: { 800: { status: 'ended', runtime: 43 } },
    tvdbIds: { 800: 403245 },
    ...over,
  });

test('a finished season just started is asked about, and carries its average undated', () => {
  const { plan, runtimeDemands } = started({ runtimes: { 800: { 2: 49 } } });
  const insert = plan().insert;
  assert.deepEqual(fields(insert), ['Episode', 'Note', 'Runtime', 'Season', 'Start']);
  assert.ok(cellIn(insert, 'Runtime')?.numberValue === 49, 'the season average, though only one episode is watched');
  assert.equal(cellIn(insert, 'End'), undefined, 'and nowhere near dated');
  assert.deepEqual(started().runtimeDemands(), [{ id: 800, tvdbId: 403245, season: 2 }], 'demanded on the run that adds the row');
  assert.deepEqual(runtimeDemands(), [], 'and not again once answered');
});

// The runtime is not back, so the cell waits — the row is undated for its own
// reason, and the close fills the cell either way.
test('a finished season just started, with no answer yet, is added blank and undated', () => {
  const insert = started().plan().insert;
  assert.deepEqual(fields(insert), ['Episode', 'Note', 'Season', 'Start']);
});

/**
 * `/tv/{id}` never answered: the episode list says the season is over, but no
 * `tvdbId` or show-wide runtime came. Absent is not null — null settles the
 * question, absence leaves it open.
 */
test('a title whose detail has not answered is added open, not dated blank', () => {
  const { plan } = scenario({
    rows: [show('Silo', 'Watching', 800), season(1, 10, 44000)],
    items: [{ id: 800, status: 'watching', seasons: { 1: watched(10, 900), 2: watched(10) }, watched: 20, total: 20 }],
    episodes: { 800: [...eps(1, 10), ...eps(2, 10)] },
    details: {},
  });
  const insert = plan().insert;
  assert.equal(seasonOf(insert), 2, 'the row still goes in');
  assert.equal(cellIn(insert, 'End'), undefined, 'undated, because a runtime may yet be obtainable');
  assert.equal(cellIn(insert, 'Runtime'), undefined);
  assert.match(insert?.note ?? '', /have not come back/);
});

// A dated row is never revisited, so a blank cell on one is blank for good;
// the report is the only place a reader learns to fill it in.
test('a row dated with a cell nothing can fill says so, whatever left it blank', () => {
  const insert = adding({ runtimes: { 800: { 2: null } }, details: { 800: { status: 'ended' } } }).plan().insert;
  assert.ok(cellIn(insert, 'End'), 'dated');
  assert.equal(cellIn(insert, 'Runtime'), undefined, 'and blank for good');
  assert.match(insert?.note ?? '', /no episode runtime to fill its Episode Length \(min\) cell/);
});

/**
 * `assertPlanSafe` refuses whole-plan, so a planner/guard bound disagreement
 * over one sub-minute length would drop every unrelated edit in the run, every
 * poll, for as long as the block stays in scope.
 */
test('a length the guard would refuse is never planned in the first place', () => {
  const { plan, grid } = adding({ tvdbIds: {}, details: { 800: { status: 'airing', runtime: 0.3 } }, aired: 6 });
  const result = plan();
  assert.equal(cellIn(result.insert, 'Runtime'), undefined, 'the cell is skipped rather than filled implausibly');
  assert.doesNotThrow(() => assertPlanSafe(result, grid), 'and the run is not refused whole over one title');
});

// What to fetch and what to write are one computation.
test('the demand names exactly the season the plan inserts', () => {
  const { plan, runtimeDemands } = adding();
  assert.deepEqual(runtimeDemands(), [{ id: 800, tvdbId: 403245, season: 2 }]);
  assert.equal(seasonOf(plan().insert), 2);
});

// A null answer still counts as answered.
test('a season already answered is not demanded again', () => {
  assert.deepEqual(adding({ runtimes: { 800: { 2: null } } }).runtimeDemands(), []);
});

// --- status ----------------------------------------------------------------

test('the status rule runs in order, and says nothing where it knows nothing', () => {
  const base = { id: 1, type: 'shows' as const, title: 'X', status: 'watching', lastWatchedAt: null, watchedCount: 10, totalCount: 10, notAiredCount: 0, seasons: new Map() };

  assert.equal(deriveStatus({ ...base, status: 'dropped' }), 'Abandoned');
  assert.equal(deriveStatus({ ...base, watchedCount: 8 }), 'Watching');
  assert.equal(deriveStatus(base, { latestSeasonAiring: true }), 'Watching');
  assert.equal(deriveStatus(base, { detailStatus: 'ended' }), 'Ended');
  assert.equal(deriveStatus(base, { detailStatus: 'airing' }), 'Up To Date');
  assert.equal(deriveStatus(base, { detailStatus: 'tba' }), 'Up To Date');

  // hold, plantowatch and absent-from-every-list are all no information,
  // never a reason to write.
  assert.equal(deriveStatus({ ...base, status: 'hold' }, { detailStatus: 'ended' }), null);
  assert.equal(deriveStatus({ ...base, status: 'plantowatch' }, { detailStatus: 'ended' }), null);
  assert.equal(deriveStatus(base, {}), null);
});

// SIMKL cannot tell "axed" from "ended", so Cancelled is never produced — but
// recent activity freely overwrites it.
test('Cancelled is never produced, and is overwritten when activity resumes', () => {
  const produced = new Set<string>();
  for (const detailStatus of ['ended', 'airing', 'tba', 'cancelled', 'canceled']) {
    for (const status of ['watching', 'completed', 'dropped']) {
      const derived = deriveStatus(
        { id: 1, type: 'shows' as const, title: 'X', status, lastWatchedAt: null, watchedCount: 10, totalCount: 10, notAiredCount: 0, seasons: new Map() },
        { detailStatus },
      );
      if (derived) produced.add(derived);
    }
  }
  assert.deepEqual([...produced].sort(), ['Abandoned', 'Ended', 'Up To Date']);

  const { plan } = scenario({
    rows: [show('Firefly', 'Cancelled', 600), season(1, 14, 44000)],
    items: [{ id: 600, status: 'completed', seasons: { 1: watched(14) }, watched: 14, total: 14 }],
    episodes: { 600: eps(1, 14) },
    details: { 600: { status: 'ended' } },
  });
  assert.deepEqual(plan().edits.map((e) => [e.field, e.value?.stringValue]), [['Status', 'Ended']]);
});

// Abandoned reads item.status. A show the sheet calls Ended, still being
// watched, must not become Abandoned.
test('Abandoned comes from the item status', () => {
  const grid = parseGrid(sheetSnapshot([H, show('Beef', 'Ended', 700), season(1, 10, 44000)]));
  const index = indexLibrary(libraryOf({ id: 700, status: 'watching', seasons: { 1: watched(10) } }));
  // Real shapes, or the fail-closed rule below would make this pass vacuously.
  const titles = new Map<number, TitleCatalogue>([[700, { shapes: seasonShapes(eps(1, 10)), status: 'ended', seasonRuntimes: new Map() }]]);
  const { plan } = planSync(grid, index, titles, { timezone: TZ });
  assert.deepEqual(plan.edits, []);
});

// --- ids -------------------------------------------------------------------

test('a season row with no matching SIMKL entry is reported, never guessed at', () => {
  const { plan } = scenario({
    rows: [show('Ghost', 'Ended', 900), season(1, 1, null, 12345)],
    items: [{ id: 900, status: 'watching', seasons: { 1: watched(4) } }],
    details: { 900: { status: 'ended' } },
  });
  const result = plan();
  assert.deepEqual(result.edits.filter((e) => e.field !== 'Status'), []);
  const skip = result.skips.find((s) => s.code === 'unknown-id');
  assert.match(skip?.message ?? '', /SIMKL id 12345 is in no list/);
});

test('the status source is the show row id, or the latest cour when there is none', () => {
  const live = parseGrid(sheetSnapshot([H, show('Fargo', 'Ended', 3381), season(1, 6, 44000, 999)]));
  assert.equal(statusSource(live.blocks[0]!), 3381);

  const anime = parseGrid(sheetSnapshot([H, show('Frieren', 'Ended', null, 'anime'), season(1, 14, 44000, 11), season(2, 14, null, '12,13')]));
  assert.equal(statusSource(anime.blocks[0]!), 13);
});

// --- split cours -----------------------------------------------------------

const splitCour = (overrides: Partial<Record<'aEnd' | 'bEnd', boolean>> = {}) =>
  scenario({
    rows: [show('Ajin: Demi-Human', 'Ended', null, 'anime'), season(1, 20, null, '522882,581835')],
    items: [
      { id: 522882, status: 'completed', seasons: { 1: watched(13, 40) }, watched: 13, total: 13, notAired: overrides.aEnd === false ? 1 : 0 },
      { id: 581835, status: 'completed', seasons: { 1: watched(13, 3) }, watched: 13, total: 13, notAired: overrides.bEnd === false ? 1 : 0 },
    ],
    details: { 581835: { status: 'ended' } },
  });

// `TitleProgress.lastWatchedAt` is `item.last_watched_at`, which SIMKL moves to
// whatever was written last rather than to the latest episode: re-dating a
// season's opening episode drags it back to the opening day. A row taking `End`
// from it would then close on its own `Start`. 3 of 183 cour rows on the live
// library carry the two values apart.
test("a cour row is dated on its season's last episode, not the record's own timestamp", () => {
  const first = daysAgo(60);
  const last = daysAgo(9);
  const { plan } = scenario({
    rows: [show('Koukyoushihen: Eureka Seven', 'Ended', null, 'anime'), season(1, 12, null, 38597)],
    items: [
      {
        id: 38597,
        status: 'completed',
        // What SIMKL reports once the opening episode is the most recent write.
        lastWatchedAt: first,
        seasons: { 1: [first, ...watched(10, 20), last] },
        watched: 12,
        total: 12,
      },
    ],
    details: { 38597: { status: 'ended' } },
  });
  const end = plan().edits.find((e) => e.field === 'End');
  assert.equal(end?.value?.numberValue, dateSerial(plainDateIn(Temporal.Instant.from(last), TZ)));
  assert.notEqual(end?.value?.numberValue, dateSerial(plainDateIn(Temporal.Instant.from(first), TZ)));
});

test("a split cour's count is summed across every id", () => {
  const episode = splitCour().plan().edits.find((e) => e.field === 'Episode');
  assert.equal(episode?.value?.numberValue, 26);
});

test("a split cour ends on the last id's timestamp, and only once every id is complete", () => {
  assert.ok(splitCour().plan().edits.some((e) => e.field === 'End'));
  // One half still airing means the row is not finished, whatever the other says.
  assert.deepEqual(splitCour({ aEnd: false }).plan().edits.filter((e) => e.field === 'End'), []);
});

/**
 * A split cour is one row over two SIMKL entries, and each entry has a record
 * of its own. The row's count is their sum, so comparing that sum against
 * either entry's record reads every such row as moved on every poll — a block
 * permanently in scope, its catalogue demanded daily, for nothing.
 */
test("a split cour's counts are compared and banked per id, never against the sum", () => {
  const settled: Baseline = new Map([
    [titleRecordKey(522882), { Status: 'completed' }],
    [titleRecordKey(581835), { Status: 'completed' }],
    [seasonKey(522882, 1), { Watched: '13' }],
    [seasonKey(581835, 1), { Watched: '13' }],
  ]);
  // Both halves watched long ago, so the record is the only thing that can put
  // the row in scope.
  const dormant = () =>
    scenario({
      rows: [show('Ajin: Demi-Human', 'Ended', null, 'anime'), season(1, 20, null, '522882,581835')],
      items: [
        { id: 522882, status: 'completed', seasons: { 1: watched(13, 900) }, watched: 13, total: 13 },
        { id: 581835, status: 'completed', seasons: { 1: watched(13, 880) }, watched: 13, total: 13 },
      ],
      details: { 581835: { status: 'ended' } },
    });

  // Both agree with the record: nothing moved, so the row is out of scope.
  assert.deepEqual(dormant().result(settled).plan.edits, []);

  // One half moves. The row's count is 26, which matches neither record on its
  // own — only the per-id comparison sees the 12 → 13.
  const moved = dormant().result(new Map([...settled, [seasonKey(581835, 1), { Watched: '12' }]]));
  assert.equal(moved.plan.edits.find((e) => e.field === 'Episode')?.value?.numberValue, 26);
  assert.equal(moved.writing.get(seasonKey(522882, 1))?.Watched, '13', 'and both halves are banked at their own count');
  assert.equal(moved.writing.get(seasonKey(581835, 1))?.Watched, '13');
});

// The one multi-id failure the guards would not otherwise catch: summing over
// the survivors yields half the true count, and monotonicity only blocks
// decreases — so a wrong-but-larger number would be waved straight through.
test('an unresolved half poisons the whole row rather than summing the survivors', () => {
  const { plan } = scenario({
    rows: [show('Ajin: Demi-Human', 'Ended', null, 'anime'), season(1, 20, null, '522882,581835')],
    items: [{ id: 522882, status: 'completed', seasons: { 1: watched(13, 3) }, watched: 13, total: 13 }],
  });
  const result = plan();
  assert.deepEqual(result.edits, []);
  assert.match(skipMessages(result), /SIMKL id 581835 is in no list/);
});

// --- anime -----------------------------------------------------------------

test('an anime cour is completed on its own counters, with no episode lookup', () => {
  const { plan, demands } = scenario({
    rows: [show('Frieren', 'Watching', null, 'anime'), season(1, 2, null, 1500)],
    items: [{ id: 1500, status: 'completed', seasons: { 1: watched(11) }, watched: 11, total: 11 }],
    details: { 1500: { status: 'ended' } },
  });
  const result = plan();
  assert.deepEqual(result.edits.map((e) => e.field).sort(), ['End', 'Episode', 'Status']);
  // No /tv/episodes lookup is demanded: one anime entry is one cour.
  assert.deepEqual(demands().catalogue.filter((r) => r.episodes), []);
});

// A new cour is a separate SIMKL title with its own romaji name; matching it
// to a block needs fuzzy matching that takes 24 hand-written overrides.
test('a title with no row anywhere is reported, never added', () => {
  const { plan } = scenario({
    rows: [show('Frieren', 'Watching', null, 'anime'), season(1, 11, 44000, 1500)],
    items: [
      { id: 1500, title: 'Frieren', status: 'completed', seasons: { 1: watched(11, 3) }, watched: 11, total: 11 },
      { id: 1600, type: 'anime' as const, title: 'Sousou no Frieren 2nd Season', status: 'watching', seasons: { 1: watched(4) } },
    ],
    details: { 1500: { status: 'ended' } },
  });
  const result = plan();
  assert.equal(result.insert, null);
  assert.match(result.notes.join('\n'), /Sousou no Frieren 2nd Season \(simkl 1600\) has recent activity and no row/);
});

// The films tab places these, and this half keeps indexing them because 20 sit
// on `Sheet1` rows — dropping them from the index would replace one note with
// an `unknown-id` skip on each of those.
test('an anime film the films tab places is not a title missing a row', () => {
  const args = {
    rows: [show('Frieren', 'Watching', null, 'anime'), season(1, 11, 44000, 1500)],
    items: [
      { id: 1500, title: 'Frieren', status: 'completed', seasons: { 1: watched(11, 3) }, watched: 11, total: 11 },
      { id: 1600, type: 'anime' as const, title: 'Spirited Away', status: 'completed', seasons: { 1: watched(1) } },
    ],
    details: { 1500: { status: 'ended' } },
  };
  assert.match(scenario(args).plan().notes.join('\n'), /Spirited Away/);
  assert.deepEqual(scenario({ ...args, filed: new Set([1600]) }).plan().notes, []);
});

// A cour entry stands for exactly one season; one reporting several means the
// row and the entry disagree, and no rule says which wins.
test('a season row whose own id spans several seasons is refused as ambiguous', () => {
  const { plan } = scenario({
    rows: [show('Doctor Who', 'Ended', null), season(14, 1, null, 2463827)],
    items: [{ id: 2463827, status: 'watching', seasons: { 1: watched(8), 2: watched(8) }, watched: 16, total: 16 }],
  });
  const skip = plan().skips.find((s) => s.code === 'ambiguous-cour');
  assert.match(skip?.message ?? '', /covers 2 seasons, so the row is ambiguous/);
});

// --- insertion -------------------------------------------------------------

test('a newly started season is inserted after the last season row, not at the show row', () => {
  const { plan, grid } = scenario({
    rows: [show('Futurama', 'Up To Date', 3407), season(9, 13, 43000), season(10, 13, 44000)],
    items: [{ id: 3407, status: 'watching', seasons: { 9: watched(13, 900), 10: watched(13, 400), 11: watched(6) }, watched: 32, total: 36, notAired: 4 }],
    episodes: { 3407: [...eps(9, 13), ...eps(10, 13), ...eps(11, 10, 6)] },
    details: { 3407: { status: 'airing', runtime: 22 } },
  });
  const insert = plan().insert;
  assert.equal(seasonOf(insert), 11);
  // Row 5 in the UI is the row after S10 — not the show row, where
  // inheritFromBefore picks up the wrong formats.
  assert.equal(insert?.row, 4);
  assert.notEqual(insert?.row, grid.blocks[0]?.row);
  assert.deepEqual(insert?.fill.map((f) => f.field).sort(), ['Episode', 'Note', 'Runtime', 'Season', 'Start']);
  assert.equal(insert?.fill.find((f) => f.field === 'Runtime')?.value?.numberValue, 22);
});

/**
 * A title marked whole has one timestamp per episode and none inside the
 * window, so gating each season on its own watch date offers none of them. What
 * the record sees is every count differing from what it holds, and a season it
 * holds nothing for at all — which on a title it has seen is one that appeared.
 */
const wholeSeries = (): Scenario => ({
  rows: [show('Silo', 'Watching', 800), season(1, 10, 44000)],
  items: [{ id: 800, status: 'watching', seasons: { 1: watched(10, 900), 2: watched(10, 880), 3: watched(10, 860) }, watched: 30, total: 30 }],
  episodes: { 800: [...eps(1, 10), ...eps(2, 10), ...eps(3, 10)] },
  details: { 800: { status: 'ended', runtime: 43 } },
  tvdbIds: { 800: 403245 },
  runtimes: { 800: { 2: 43, 3: 43 } },
});

/** The record as it stands after a run that saw S1 alone — the state a hand-started block leaves. */
const sawSeasonOne = (): Baseline =>
  new Map([
    [titleRecordKey(800), { Status: 'watching' }],
    [seasonKey(800, 1), { Watched: '10' }],
  ]);

test('a season unrecorded among recorded siblings is insertable, watched whenever', () => {
  assert.equal(seasonOf(scenario(wholeSeries()).result(sawSeasonOne()).plan.insert), 2, 'S3 waits for the run after, as any second insert does');
  assert.equal(scenario(wholeSeries()).result(sawSeasonOne()).plan.insert?.row, 3, 'under S1');
});

/**
 * The deadlock the sibling rule exists to break: a block someone started by
 * hand at S5, whose earlier seasons were all recorded long ago, gains the
 * season SIMKL has just added rather than being offered S1 forever and refused
 * for having no row above it.
 */
test('a hand-started block gains the season that appeared, not the lowest one it lacks', () => {
  const started = scenario({
    rows: [show('Silo', 'Watching', 800), season(5, 10, 44000)],
    items: [
      {
        id: 800,
        status: 'watching',
        seasons: { 1: watched(10, 900), 2: watched(10, 880), 3: watched(10, 860), 4: watched(10, 840), 5: watched(10, 820), 6: watched(10, 800) },
        watched: 60,
        total: 60,
      },
    ],
    episodes: { 800: [1, 2, 3, 4, 5, 6].flatMap((n) => eps(n, 10)) },
    details: { 800: { status: 'ended', runtime: 43 } },
    tvdbIds: { 800: 403245 },
    runtimes: { 800: { 6: 43 } },
  });
  const seen: Baseline = new Map([[titleRecordKey(800), { Status: 'watching' }]]);
  for (const n of [1, 2, 3, 4, 5]) seen.set(seasonKey(800, n), { Watched: '10' });
  const insert = started.result(seen).plan.insert;
  assert.equal(seasonOf(insert), 6);
  assert.equal(insert?.row, 3, 'under S5, the only season row the block has');
});

/**
 * A row refused for having nothing above it to inherit formats from waits on a
 * hand edit, not on this service — so it is said and left, and the count behind
 * it is *not* recorded, or the run after that edit would find nothing moved.
 */
test('a season refused for having no format row is a skip, not a deferral', () => {
  const spaced = gridFixture(
    namedShow('fargo', 'Fargo', { status: 'Watching' }),
    namedSeason('fargoS1', 1, 6, 44000),
    namedRaw('spacer', new Array(H.length).fill(null)),
    namedSeason('fargoS3', 3, 4, 44500),
  );
  const index = indexLibrary(
    libraryOf({ id: 1, title: 'Fargo', status: 'watching', seasons: { 1: watched(6, 900), 2: watched(2, 880), 3: watched(4, 860) }, watched: 12, total: 12 }),
  );
  const titles = new Map<number, TitleCatalogue>([[1, { shapes: seasonShapes(eps(2, 2)), status: 'ended', runtime: 45, seasonRuntimes: new Map() }]]);
  // S1 and S3 recorded, S2 not: the season that appeared is the one offered,
  // and it would land under a spacer row that carries no formats.
  const seen: Baseline = new Map([
    [titleRecordKey(1), { Status: 'watching' }],
    [seasonKey(1, 1), { Watched: '6' }],
    [seasonKey(1, 3), { Watched: '4' }],
  ]);

  const { plan, observed } = planSync(spaced.grid, index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true }, baseline: seen });
  assert.equal(plan.insert, null);
  assert.deepEqual(
    plan.skips.map((skip) => skip.code),
    ['no-format-row'],
  );
  assert.equal(plan.deferred, 0, 'nothing this service does will drain it, so no retry is armed');
  assert.equal(observed.get(seasonKey(1, 2))?.Watched, undefined, 'and the count stays unrecorded, so the hand edit is enough');
});

/**
 * `insertableSeasons` offers the lowest number first, so a season the placement
 * refused is one every season behind it is waiting on. Recorded, the next poll
 * would find the whole tail unmoved and none of those rows would ever be added.
 */
test('a season refused for having no format row leaves the seasons behind it insertable', () => {
  const spaced = gridFixture(
    namedShow('fargo', 'Fargo', { status: 'Watching' }),
    namedSeason('fargoS1', 1, 6, 44000),
    namedRaw('spacer', new Array(H.length).fill(null)),
    namedSeason('fargoS4', 4, 4, 44500),
  );
  const index = indexLibrary(
    libraryOf({
      id: 1,
      title: 'Fargo',
      status: 'watching',
      seasons: { 1: watched(6, 900), 2: watched(2, 880), 3: watched(3, 870), 4: watched(4, 860) },
      watched: 15,
      total: 15,
    }),
  );
  const titles = new Map<number, TitleCatalogue>([[1, { shapes: seasonShapes([...eps(2, 2), ...eps(3, 3)]), status: 'ended', runtime: 45, seasonRuntimes: new Map() }]]);
  const seen: Baseline = new Map([
    [titleRecordKey(1), { Status: 'watching' }],
    [seasonKey(1, 1), { Watched: '6' }],
    [seasonKey(1, 4), { Watched: '4' }],
  ]);

  const { plan, observed } = planSync(spaced.grid, index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true }, baseline: seen });
  assert.deepEqual(
    plan.skips.map((skip) => skip.code),
    ['no-format-row'],
  );
  assert.equal(observed.get(seasonKey(1, 2))?.Watched, undefined, 'the season refused stays unrecorded');
  assert.equal(observed.get(seasonKey(1, 3))?.Watched, undefined, 'and so does the one waiting behind it');
});

/**
 * A season SIMKL lists and nothing has been seen of has no row to gain. Read as
 * insertable it would put an empty row under every block whose title moved.
 */
test('a season with nothing watched is not insertable, whatever else moved', () => {
  const unwatched = scenario({
    ...wholeSeries(),
    items: [{ id: 800, status: 'watching', seasons: { 1: watched(10, 900), 2: [null, null] }, watched: 10, total: 20 }],
    episodes: { 800: [...eps(1, 10), ...eps(2, 10)] },
  }).result(sawSeasonOne());
  assert.equal(unwatched.plan.insert, null);
  assert.equal(unwatched.plan.deferred, 0, 'and nothing is counted as waiting behind it');
});

/**
 * A row created with a blank runtime cell something can still reach is a row a
 * later poll has to close — and a record-scoped row leaves scope the moment its
 * count is recorded, so banking the count here is the close never made.
 */
const joiningSeason = (answered: boolean): Scenario => ({
  rows: [show('Joining', 'Watching', 810), seasonRow(1, 6, 44000)],
  items: [{ id: 810, status: 'completed', seasons: { 1: watched(6, 900), 2: watched(6, 880) }, watched: 12, total: 12 }],
  episodes: { 810: [...eps(1, 6), ...eps(2, 6)] },
  // With no `details` entry the store has not written `tvdbId` at all, which is
  // the insert's reading of "the detail has not answered".
  ...(answered ? { details: { 810: { status: 'ended', runtime: 40 } }, tvdbIds: { 810: 111 }, runtimes: { 810: { 2: 45 } } } : {}),
});

const sawOnlySeasonOne: Baseline = new Map([[titleRecordKey(810), { Status: 'completed' }], [seasonKey(810, 1), { Watched: '6' }]]);

test('a season row inserted in a state a later poll must finish keeps its count unrecorded', () => {
  const open = scenario(joiningSeason(false)).result(sawOnlySeasonOne);
  assert.equal(seasonOf(open.plan.insert), 2);
  assert.equal((open.plan.insert as { open: boolean }).open, true, 'its runtime cell is blank and something can still fill it');
  assert.equal(open.observed.get(seasonKey(810, 2))?.Watched, undefined, 'so the row comes back next poll to be closed');
  assert.equal(open.writing.get(seasonKey(810, 2))?.Watched, undefined, 'banked, it would be recorded the moment the batch landed');

  // The same row with every answer in hand lands finished, and banks.
  const done = scenario(joiningSeason(true)).result(sawOnlySeasonOne);
  assert.equal((done.plan.insert as { open: boolean }).open, false);
  assert.equal(done.writing.get(seasonKey(810, 2))?.Watched, '6', 'a row that needs nothing more banks against its own write');
});

/**
 * A season left behind has its count withdrawn, not recorded. Recorded at the
 * value the sheet never received, the next poll would find it unmoved and the
 * row would be lost until the season was watched again.
 */
test('a season deferred behind another is in neither what the run records nor what it banks', () => {
  const { plan, observed, writing } = scenario(wholeSeries()).result(sawSeasonOne());
  assert.equal(seasonOf(plan.insert), 2);
  assert.equal(plan.deferred, 1, 'S3');
  assert.equal(writing.get(seasonKey(800, 2))?.Watched, '10', 'the row this run plans is banked');
  assert.equal(observed.get(seasonKey(800, 3))?.Watched, undefined, 'the one behind it is withdrawn');
  assert.equal(writing.get(seasonKey(800, 3)), undefined);
});

test('an inserted row lands where it keeps Season ascending', () => {
  const { plan } = scenario({
    rows: [show('Futurama', 'Up To Date', 3407), season(9, 13, 43000), season(11, 13, 44000)],
    items: [{ id: 3407, status: 'watching', seasons: { 9: watched(13, 900), 10: watched(6), 11: watched(13, 400) }, watched: 32, total: 32 }],
    episodes: { 3407: [...eps(9, 13), ...eps(10, 13), ...eps(11, 13)] },
    details: { 3407: { status: 'ended', runtime: 22 } },
  });
  const insert = plan().insert;
  assert.equal(seasonOf(insert), 10);
  assert.equal(insert?.row, 3, 'between S9 and S11');
});

test('a season with no row above it in the block is reported rather than inserted', () => {
  const { plan } = scenario({
    rows: [show('Futurama', 'Up To Date', 3407)],
    items: [{ id: 3407, status: 'watching', seasons: { 1: watched(6) }, watched: 6, total: 6 }],
    episodes: { 3407: eps(1, 6) },
    details: { 3407: { status: 'airing', runtime: 22 } },
  });
  const result = plan();
  assert.equal(result.insert, null);
  const skip = result.skips.find((s) => s.code === 'no-format-row');
  assert.match(skip?.message ?? '', /no season row above the insertion point/);
});

// Anime: a new cour is a separate title. Specials: a fractional label encodes
// a judgement no rule here reproduces.
test('anime blocks are never inserted into', () => {
  const { plan } = scenario({
    rows: [show('Frieren', 'Watching', null, 'anime'), season(1, 11, 44000, 1500)],
    items: [{ id: 1500, status: 'watching', seasons: { 1: watched(11, 3), 2: watched(4) }, watched: 15, total: 15 }],
    details: { 1500: { status: 'airing', runtime: 24 } },
  });
  assert.equal(plan().insert, null);
});

test('SIMKL season 0 is never inserted — specials are maintained by hand', () => {
  const { plan } = scenario({
    rows: [show('Futurama', 'Up To Date', 3407), season(10, 13, 44000)],
    items: [{ id: 3407, status: 'watching', seasons: { 0: watched(3), 10: watched(13, 400) }, watched: 13, total: 13 }],
    episodes: { 3407: eps(10, 13) },
    details: { 3407: { status: 'ended', runtime: 22 } },
  });
  assert.equal(plan().insert, null);
});

// --- idempotence -----------------------------------------------------------

// The job re-plans the whole sheet every run; a second run over the applied
// result is the cheapest proof it converges.
test('running again over the applied result produces nothing', () => {
  const seen = watched(7);
  const items: ItemSpec[] = [{ id: 100, status: 'completed', seasons: { 7: seen }, watched: 7, total: 22, notAired: 0 }];
  const before = scenario({
    rows: [show('Malcolm in the Middle', 'Watching', 100), season(6, 22, 44000), season(7, 1, null)],
    items,
    episodes: { 100: [...eps(6, 22), ...eps(7, 22)] },
    details: { 100: { status: 'ended', runtime: 22 } },
  });
  assert.equal(before.plan().edits.length, 2);

  const after = scenario({
    rows: [show('Malcolm in the Middle', 'Watching', 100), season(6, 22, 44000), season(7, 7, null, null, note(seen))],
    items,
    episodes: { 100: [...eps(6, 22), ...eps(7, 22)] },
    details: { 100: { status: 'ended', runtime: 22 } },
  });
  assert.deepEqual(after.plan().edits, []);
});

// --- demands ---------------------------------------------------------------

// The cut-off keeps a run at roughly 28 calls rather than 600: an out-of-scope
// block demands nothing, however stale its catalogue. A dormant block asks only
// where its recorded `End` and SIMKL's disagree — one season's worth of lookup
// for one season's worth of change, never a pass over the sheet, because
// `observeWatches` records both fields library-wide for free.
test('only eligible blocks demand catalogue lookups', () => {
  const settled = scenario({
    rows: [show('Recent', 'Watching', 1), season(1, 1, null), show('Dormant', 'Ended', 2), season(1, 10, 44000)],
    items: [
      { id: 1, status: 'watching', seasons: { 1: watched(5) } },
      { id: 2, status: 'completed', seasons: { 1: watched(10, 500) } },
    ],
  });
  // The same array the scenario built its library from, not a second call that
  // happens to reduce to the same day.
  assert.deepEqual([...new Set(settled.demands().catalogue.map((r) => r.id))], [1]);

  // It asks only once its record and SIMKL disagree — the same shape the recent
  // half asks for, so the stamp it earns means what every other stamp means.
  const dormantSeen = watched(10, 500);
  const stale: Baseline = new Map([[seasonKey(2, 1), { Start: dormantSeen[0] as string, End: daysAgo(2000) }]]);
  assert.deepEqual(settled.result(stale).demands.catalogue.filter((r) => r.id === 2), [{ id: 2, episodes: true, detail: true }]);
});

// The planner demands with no memory — filtering already-fetched is the
// store's job. The demand set only has to name the titles the plan runs on,
// once each: the block's two asks about one id fold into one entry.
test('an eligible block demands its episode list and detail every pass', () => {
  const { demands } = scenario({
    rows: [show('Fargo', 'Watching', 1), season(1, 1, null)],
    items: [{ id: 1, status: 'watching', seasons: { 1: watched(5) } }],
    episodes: { 1: eps(1, 10) },
    details: { 1: { status: 'airing' } },
  });
  // Already answered, and still demanded — the store filters, not the planner.
  assert.deepEqual(demands().catalogue, [{ id: 1, episodes: true, detail: true }]);
});

// An unresolved row is still a row. A second insert for the same season is the
// one insert mistake nothing downstream detects — the guard sees a well-formed
// insert into the right block.
test('a season row that failed to resolve still blocks an insert for that season', () => {
  const { plan } = scenario({
    // S11 has an id of its own that resolves to nothing, so the row is skipped.
    rows: [show('Futurama', 'Up To Date', 3407), season(10, 13, 44000), season(11, 1, null, 999999)],
    items: [{ id: 3407, status: 'watching', seasons: { 10: watched(13, 400), 11: watched(6) }, watched: 19, total: 19 }],
    episodes: { 3407: [...eps(10, 13), ...eps(11, 10, 6)] },
    details: { 3407: { status: 'airing', runtime: 22 } },
  });
  const result = plan();
  assert.equal(result.insert, null);
  assert.match(skipMessages(result), /SIMKL id 999999 is in no list/);
});

// A live-action block with no episode shapes is a failed lookup, not a cour.
// Reading it as one answers with `notAiredCount`, which spans the whole show,
// not the latest season — so Status fails closed like End, and the run's
// `retry` flag brings it back next poll.
test('a live-action show whose episode list did not arrive gets no Status', () => {
  const { plan } = scenario({
    rows: [show('Silo', 'Ended', 300), season(1, 1, null)],
    items: [{ id: 300, status: 'watching', seasons: { 1: watched(10) }, watched: 10, total: 10, notAired: 0 }],
    // No `episodes` entry: the /tv/episodes lookup failed.
    details: { 300: { status: 'ended' } },
  });
  const result = plan();
  assert.deepEqual(result.edits.filter((e) => e.field === 'Status' && e.row === 1), [], 'nothing on the show row');
  const skip = result.skips.find((s) => s.code === 'no-episode-list');
  assert.match(skip?.message ?? '', /Silo: no episode list came back, so Status is left alone/);

  // With the list present the same inputs do produce a Status, so the missing
  // data is what gates.
  const withList = scenario({
    rows: [show('Silo', 'Ended', 300), season(1, 1, null)],
    items: [{ id: 300, status: 'watching', seasons: { 1: watched(10) }, watched: 10, total: 10, notAired: 0 }],
    episodes: { 300: eps(1, 10) },
    details: { 300: { status: 'airing' } },
  });
  assert.deepEqual(withList.plan().edits.filter((e) => e.field === 'Status' && e.row === 1).map((e) => e.value?.stringValue), ['Up To Date']);
});

/**
 * Every hold withdraws. A failure leaves the field unwritten and arms a retry,
 * so the poll that retries has to find the move still standing — and
 * `observeWatches` seeds `Status` library-wide, so a branch that says nothing
 * records SIMKL's current membership as though the cell already held it.
 */
test('a block whose episode list did not arrive leaves its Status withdrawn', () => {
  const { result } = scenario({
    rows: [show('Silo', 'Ended', 300), season(1, 1, null)],
    // No `episodes` entry: the /tv/episodes lookup failed.
    items: [{ id: 300, status: 'watching', seasons: { 1: watched(10) }, watched: 10, total: 10 }],
    details: { 300: { status: 'ended' } },
  });
  const { observed } = result(new Map([[titleRecordKey(300), { Status: 'completed' }]]));
  assert.equal(observed.get(titleRecordKey(300))?.Status, undefined, 'so the move is still a move next poll');
});

test('a block whose id another row claims leaves its Status withdrawn', () => {
  // The same id on two show rows: neither block may write, and the hand edit
  // that unclaims it moves nothing SIMKL says.
  const { result } = scenario({
    rows: [show('Silo', 'Ended', 300), season(1, 10, 44000), show('Silo (again)', 'Ended', 300), season(1, 10, 44000)],
    items: [{ id: 300, status: 'watching', seasons: { 1: watched(10) }, watched: 10, total: 10 }],
    episodes: { 300: eps(1, 10) },
    details: { 300: { status: 'ended' } },
  });
  const { plan, observed } = result(new Map([[titleRecordKey(300), { Status: 'completed' }]]));
  assert.ok(plan.skips.some((skip) => skip.code === 'duplicate-id'));
  assert.equal(observed.get(titleRecordKey(300))?.Status, undefined);
});

/**
 * A `Status` with no opinion is two different states. The detail still out is a
 * hold — nothing is settled, so nothing is recorded. The detail answered and
 * the title on `hold` is a final word: recorded, because no poll changes it and
 * a withdrawal would keep the block in scope, at a lookup a day, for ever.
 */
test('a Status nothing can derive withdraws while the detail is out, and records once it answers', () => {
  const held = (details?: Record<number, ShowDetail>) =>
    scenario({
      rows: [show('Frieren', 'Watching', null, 'anime'), season(1, 11, 44000, 1500)],
      items: [{ id: 1500, status: 'hold', seasons: { 1: watched(11, 3) }, watched: 11, total: 11 }],
      ...(details ? { details } : {}),
    }).result(new Map([[titleRecordKey(1500), { Status: 'completed' }]]));

  assert.equal(held().observed.get(titleRecordKey(1500))?.Status, undefined, 'the detail is still out, so nothing is settled');
  assert.equal(held({ 1500: { status: 'ended' } }).observed.get(titleRecordKey(1500))?.Status, 'hold', 'answered, and a hold has no status to derive');
});

/**
 * The close is held for another poll, so the count that would have gone with it
 * must not be recorded — from `writing` as well as `observed`, because the
 * `Episode` edit beside it banked that very count and a banked value is
 * recorded the moment the batch lands.
 */
test('a complete season with an unusable last watch leaves its count unrecorded', () => {
  const ancient = ['1994-06-01T20:00:00Z', '1994-06-08T20:00:00Z', '1994-06-15T20:00:00Z'];
  const { plan, observed, writing } = scenario({
    rows: [show('Old Show', 'Ended', 704), season(1, 1, null)],
    items: [{ id: 704, status: 'completed', seasons: { 1: ancient }, watched: 3, total: 3 }],
    episodes: { 704: eps(1, 3) },
    details: { 704: { status: 'ended', runtime: 40 } },
  }).result(new Map([[titleRecordKey(704), { Status: 'completed' }], [seasonKey(704, 1), { Watched: '1' }]]));

  assert.deepEqual(plan.edits.map((e) => e.field), ['Episode'], 'the count advances and the row stays open');
  assert.match(plan.skips.find((s) => s.code === 'unusable-timestamp')?.message ?? '', /last watch timestamp is unusable/);
  assert.equal(observed.get(seasonKey(704, 1))?.Watched, undefined, 'nothing recorded for a row left open');
  assert.equal(writing.get(seasonKey(704, 1))?.Watched, undefined, 'and nothing banked, which would record it on apply');
});

// Anime legitimately has no episode list — one entry is one cour — so Status
// derives from its own not-aired counter.
test('an anime block still gets a Status without any episode list', () => {
  const { plan } = scenario({
    rows: [show('Frieren', 'Watching', null, 'anime'), season(1, 11, 44000, 1500)],
    items: [{ id: 1500, status: 'completed', seasons: { 1: watched(11, 3) }, watched: 11, total: 11, notAired: 0 }],
    details: { 1500: { status: 'ended' } },
  });
  assert.deepEqual(plan().edits.filter((e) => e.field === 'Status' && e.row === 1).map((e) => e.value?.stringValue), ['Ended']);
});

// --- more pending inserts than one run may make -----------------------------

const twoNewSeasons = (rows: CellSpec[][]) =>
  scenario({
    rows,
    items: [
      { id: 3407, title: 'Futurama', status: 'watching', seasons: { 10: watched(13, 400), 11: watched(6) }, watched: 19, total: 19 },
      { id: 300, title: 'Silo', status: 'watching', seasons: { 1: watched(10, 400), 2: watched(4) }, watched: 14, total: 14 },
    ],
    episodes: { 3407: [...eps(10, 13), ...eps(11, 10, 6)], 300: [...eps(1, 10), ...eps(2, 10, 4)] },
    details: { 3407: { status: 'airing', runtime: 22 }, 300: { status: 'airing', runtime: 45 } },
  });

// Every season still waiting counts as deferred, because that count arms the
// retry: a title marked whole gains its seasons one per run, and the run that
// adds one would otherwise have nothing deferred and leave the rest to the
// library's next unrelated move.
test('the seasons waiting behind the one inserted are counted as deferred', () => {
  const plan = scenario({
    rows: [show('Futurama', 'Watching', 3407), season(10, 13, 44000)],
    items: [{ id: 3407, title: 'Futurama', status: 'watching', seasons: { 10: watched(13, 400), 11: watched(6), 12: watched(4), 13: watched(2) }, watched: 25, total: 25 }],
    episodes: { 3407: [...eps(10, 13), ...eps(11, 6), ...eps(12, 4), ...eps(13, 2)] },
    details: { 3407: { status: 'airing', runtime: 22 } },
  }).plan();
  assert.equal(plan.insert?.kind, 'season');
  assert.equal(plan.insert?.season, 11, 'lowest first');
  assert.equal(plan.deferred, 2, 'S12 and S13 wait');
  assert.match(plan.notes.join('\n'), /Futurama: 2 more season row\(s\) wait behind S11/);
});

/**
 * A new block takes every season in one span, so there is nothing behind it to
 * wait — unlike a season joining a block that already exists, which lands one
 * row a run. A show row with no season row under it is a block whose roll-ups
 * count the next block's rows, so a block arriving a row at a time would spend
 * a poll in that state for every season it has.
 */
test('a new block takes every season its show has, in one span', () => {
  const { index, titles } = blockLibrary({}, { seasons: { 1: [daysAgo(9), daysAgo(2)], 2: [daysAgo(8)], 3: [daysAgo(7)] }, watched: 4, total: 9 });
  const { plan } = planSync(blockGrid.grid, index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true } });
  assert.equal(plan.insert?.kind, 'block');
  assert.equal(seasonOf(plan.insert), 1);
  assert.deepEqual((plan.insert as { seasons: number[] }).seasons, [1, 2, 3]);
  assert.equal(spanOf(plan.insert), 4);
  assert.equal(plan.deferred, 0, 'nothing is left behind');
});

// One insert per run keeps the rollback trivially correct. The second season
// is not lost: the job re-plans the whole sheet, so the next run picks it up.
test('two new seasons insert one per run, and the second survives to the next', () => {
  const before: CellSpec[][] = [
    show('Futurama', 'Watching', 3407),
    season(10, 13, 44000),
    show('Silo', 'Watching', 300),
    season(1, 10, 44000),
  ];

  const first = twoNewSeasons(before).plan();
  assert.equal(first.insert?.title, 'Futurama', 'never more than one per run');
  assert.equal(seasonOf(first.insert), 11);

  // The sheet as it stands after that insert lands.
  const after: CellSpec[][] = [
    show('Futurama', 'Watching', 3407),
    season(10, 13, 44000),
    season(11, 6, null),
    show('Silo', 'Watching', 300),
    season(1, 10, 44000),
  ];
  const second = twoNewSeasons(after).plan();
  assert.equal(second.insert?.title, 'Silo');
  assert.equal(seasonOf(second.insert), 2);

  // And a third run has nothing left to insert.
  const settled: CellSpec[][] = [...after, season(2, 4, null)];
  assert.equal(twoNewSeasons(settled).plan().insert, null);
});

// Deferring silently is what bites: the report says "1 insert" and nothing
// names the waiting season.
test('a season deferred past the per-run cap is reported', () => {
  const before: CellSpec[][] = [
    show('Futurama', 'Watching', 3407),
    season(10, 13, 44000),
    show('Silo', 'Watching', 300),
    season(1, 10, 44000),
  ];
  const result = twoNewSeasons(before).plan();
  assert.match(result.notes.join('\n'), /Silo S2/, 'the deferred season is named');
  // Counted, not just mentioned: the count makes the sync ask for another
  // poll rather than wait on unrelated watch activity.
  assert.equal(result.deferred, 1);
  assert.equal(twoNewSeasons([...before.slice(0, 2)]).plan().deferred, 0, 'nothing deferred when it fits');
});

// The projection behind the status page's history; it outlives the run, so
// what it drops is dropped for good.
test('planRecord keeps where and what changed, and drops the diagnostics', () => {
  const plan: SheetPlan = {
    edits: [
      { row: 8, column: 3, field: 'Episode', previous: { numberValue: 3 }, value: { numberValue: 5 }, address: 'K9', note: 'Fargo S2: 3 -> 5 episodes' },
    ],
    insert: { kind: 'season', row: 609, rows: 1, open: false, title: 'Fargo', season: 3, fill: [], note: 'Fargo: new season row at 610, 4 episodes' },
    skips: [{ code: 'duplicate-season', message: 'Severance S1: two rows claim season 1' }],
    notes: ['Andor: not on the sheet'],
    deferred: 2,
  };

  assert.deepEqual(planRecord(plan), {
    edits: [{ address: 'K9', field: 'Episodes', note: 'Fargo S2: 3 -> 5 episodes' }],
    // An insert has no single cell, so it points at the row it created.
    inserts: [{ address: 'row 610', title: 'Fargo', season: 3, note: 'Fargo: new season row at 610, 4 episodes' }],
  });
});

// `skips` and `notes` answer "why was this row left alone" — a per-show
// diagnostic the status page deliberately does not carry, in a file that
// survives restarts.
test('planRecord carries no skip or note lines', () => {
  const record = planRecord({ edits: [], insert: null, skips: [{ code: 'unknown-id', message: 'a skip' }], notes: ['a note'], deferred: 1 });
  assert.deepEqual(record, { edits: [], inserts: [] });
  assert.ok(!JSON.stringify(record).includes('a skip'));
  assert.ok(!JSON.stringify(record).includes('a note'));
});

// --- rows the planner declines rather than handing to the guard -------------
//
// `assertPlanSafe` refuses a whole plan, so anything the planner can see will
// be refused must be declined here — or one hand-annotated cell stops every
// unrelated edit while the row stays inside the activity window.

test('a season whose Episode cell holds text is skipped, not planned', () => {
  const { plan } = scenario({
    rows: [
      show('Fargo', 'Watching', 100),
      // A hand-annotated count: a stringValue, so it parses to no number.
      rowByLabel(H, { Season: 1, Episodes: '12 (rewatch)', 'Start Date': 44000, 'Episode Length (min)': 45 }),
    ],
    items: [{ id: 100, status: 'watching', seasons: { 1: watched(14) }, watched: 14, total: 14 }],
    episodes: { 100: eps(1, 14) },
  });
  const result = plan();

  assert.deepEqual(
    result.edits.filter((e) => e.field === 'Episode'),
    [],
    'no Episode edit, so the guard is never asked to refuse the run',
  );
  const skip = result.skips.find((s) => s.code === 'non-numeric-count');
  assert.match(skip?.message ?? '', /not a number/, `the row should be skipped with a reason, got ${JSON.stringify(result.skips)}`);
});

// The point of the skip: the rest of the run still happens.
test('one unusable Episode cell does not stop the other rows', () => {
  const { grid, index, titles } = scenario({
    rows: [
      show('Fargo', 'Watching', 100),
      rowByLabel(H, { Season: 1, Episodes: '12 (rewatch)', 'Start Date': 44000, 'Episode Length (min)': 45 }),
      show('Veep', 'Watching', 200),
      season(1, 2, null),
    ],
    items: [
      { id: 100, status: 'watching', seasons: { 1: watched(14) }, watched: 14, total: 14 },
      { id: 200, status: 'watching', seasons: { 1: watched(5) }, watched: 5, total: 10 },
    ],
    episodes: { 100: eps(1, 14), 200: eps(1, 10) },
  });
  const { plan } = planSync(grid, index, titles, { timezone: TZ });

  const episodeEdits = plan.edits.filter((e) => e.field === 'Episode');
  assert.equal(episodeEdits.length, 1, 'the healthy row is still planned');
  assert.equal(episodeEdits[0]?.row, 4, 'and it is the healthy one');
  // The plan passes the guard rather than being refused.
  assert.doesNotThrow(() => assertPlanSafe(plan, grid));
});

// A hand-maintained file can hold two rows for one season. Progress cannot say
// which to advance, so both would take the same count — and only one of them
// rolls up into the show row.
test('two rows describing one season are both skipped, not both written', () => {
  const { plan } = scenario({
    rows: [show('Fargo', 'Watching', 100), season(1, 2, null), season(1, 2, null)],
    items: [{ id: 100, status: 'watching', seasons: { 1: watched(3) }, watched: 3, total: 10 }],
    episodes: { 100: eps(1, 10) },
  });
  const result = plan();

  assert.deepEqual(result.edits.filter((e) => e.field === 'Episode'), []);
  const skip = result.skips.find((s) => s.code === 'duplicate-season');
  assert.match(skip?.message ?? '', /more than one row describes this season/, `expected a skip naming the clash, got ${JSON.stringify(result.skips)}`);
});

// The same clash the other way: one row names the block's id, the other
// inherits it. Both resolve to the same title and season.
test('an explicit id and an inherited one are the same claim', () => {
  const { plan } = scenario({
    rows: [show('Fargo', 'Watching', 100), season(1, 2, null, 100), season(1, 2, null)],
    items: [{ id: 100, status: 'watching', seasons: { 1: watched(3) }, watched: 3, total: 10 }],
    episodes: { 100: eps(1, 10) },
  });
  assert.deepEqual(plan().edits.filter((e) => e.field === 'Episode'), []);
});

// Not a clash: an anime block whose rows each carry their own SIMKL id has one
// season 1 per title.
test('separate titles each with a season 1 are not a clash', () => {
  const { plan } = scenario({
    rows: [show('Some Anime', 'Watching'), season(1, 2, null, 200), season(1, 2, null, 300)],
    items: [
      { id: 200, status: 'watching', seasons: { 1: watched(5) }, watched: 5, total: 12 },
      { id: 300, status: 'watching', seasons: { 1: watched(4) }, watched: 4, total: 12 },
    ],
  });
  assert.equal(plan().edits.filter((e) => e.field === 'Episode').length, 2, 'both advance');
});

// --- season runtimes -------------------------------------------------------

/** A live-action block whose only open season completes this run. */
const closing = (over: Partial<Scenario> = {}) =>
  scenario({
    rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { runtime: null })],
    items: [{ id: 800, status: 'watching', seasons: { 1: watched(10) }, watched: 10, total: 10 }],
    episodes: { 800: eps(1, 10) },
    details: { 800: { status: 'ended', runtime: 43 } },
    tvdbIds: { 800: 403245 },
    ...over,
  });

const has = (plan: SheetPlan, field: string) => plan.edits.some((e) => e.field === field);
/** Closed with no runtime: the End landed and the Runtime cell was left alone. */
const closedBare = (plan: SheetPlan) => {
  assert.ok(has(plan, 'End'), 'the season is dated');
  assert.equal(has(plan, 'Runtime'), false, 'and carries no runtime');
};

test('a season closing with a blank runtime cell gets its average, in the same batch', () => {
  const plan = closing({ runtimes: { 800: { 1: 49 } } }).plan();
  const episodes = plan.edits.find((e) => e.field === 'Runtime');
  const end = plan.edits.find((e) => e.field === 'End');
  assert.ok(end, 'the season still closes');
  assert.ok(episodes, 'and carries its runtime');
  assert.equal(episodes.row, end.row, 'onto the row that is closing');
  assert.equal(episodes.value?.numberValue, 49);
  assert.match(episodes.note, /49 min average/);
});

// A hand-typed runtime is a deliberate correction, and the row freezes when
// End lands — so an overwrite could never be undone.
test('a runtime already in the cell is never overwritten', () => {
  const plan = closing({
    rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { runtime: 43 })],
    runtimes: { 800: { 1: 49 } },
  }).plan();
  assert.ok(plan.edits.some((e) => e.field === 'End'));
  assert.deepEqual(plan.edits.filter((e) => e.field === 'Runtime'), []);
});

// End is a one-way door: closing before the answer arrives forfeits the cell
// for good. The serial comes from the watch timestamp, so waiting is free.
test('a runtime still outstanding holds the End write rather than closing blind', () => {
  const plan = closing().plan();
  assert.equal(has(plan, 'End'), false, 'the row stays open');
  assert.equal(has(plan, 'Runtime'), false);
  const skip = plan.skips.find((s) => s.code === 'awaiting-runtimes');
  assert.match(skip?.message ?? '', /have not come back/);
});

// Settled means no season average is coming. The batch dates the row either
// way, so the choice is an approximate number or a cell nothing can ever fill
// again — and it cannot turn on which run created the row.
test('a settled null closes the season on the show-wide runtime', () => {
  const plan = closing({ runtimes: { 800: { 1: null } } }).plan();
  assert.ok(has(plan, 'End'), 'the season is dated');
  const cell = plan.edits.find((e) => e.field === 'Runtime');
  assert.equal(cell?.value?.numberValue, 43, 'and carries the show-wide length');
});

test('a season with neither an average nor a show-wide length closes blank, and says so', () => {
  const plan = closing({ runtimes: { 800: { 1: null } }, details: { 800: { status: 'ended' } } }).plan();
  closedBare(plan);
  assert.match(plan.notes.join(' '), /no usable episode runtimes/);
});

// No join key means no season average is ever coming — no SIMKL tvdb id, or
// no credential; the store withholds it either way. The row is still one this
// sync may fill, so it closes on the show-wide length. Read as pending
// instead, every season in the sheet would stop being dated, hence asserting
// the skips are empty.
test('a row with no tvdb id closes on the show-wide runtime', () => {
  const bare = closing({ tvdbIds: {} });
  const plan = bare.plan();
  assert.ok(has(plan, 'End'), 'the season is dated');
  const cell = plan.edits.find((e) => e.field === 'Runtime');
  assert.equal(cell?.value?.numberValue, 43, 'and carries the show-wide length');
  assert.deepEqual(plan.skips, [], 'never held open — no answer is coming');
  assert.deepEqual(bare.runtimeDemands(), [], 'and nothing is asked of TVDB');
});

// The invariant the fallback exists for. A cell must not depend on whether
// this run created the row or closed one already there, or two
// identical-looking rows differ for a reason no reader of the sheet could see.
test('a season with no tvdb id gets the same cell closed as it would inserted', () => {
  const closed = closing({ tvdbIds: {} }).plan().edits.find((e) => e.field === 'Runtime')?.value?.numberValue;
  const inserted = adding({ tvdbIds: {}, aired: 6 }).plan().insert?.fill.find((f) => f.field === 'Runtime')?.value?.numberValue;
  assert.ok(closed, 'the closing row carries a runtime');
  assert.equal(closed, inserted, 'and it is the one the insert would have written');
});

/**
 * Absent is not null: episodes arrived but `/tv/{id}` did not, so the runtime
 * question is unanswered, not settled. The catalogue task fetches episodes
 * before the detail, so a transient failure leaves exactly this state — and a
 * dated row is never revisited, so dating on it forfeits the cell on a 503.
 */
test('a row whose detail has not answered holds its close open', () => {
  const undetailed = closing({ details: {}, tvdbIds: {} });
  const plan = undetailed.plan();
  assert.equal(has(plan, 'End'), false, 'the row stays open');
  const skip = plan.skips.find((s) => s.code === 'awaiting-runtimes');
  assert.match(skip?.message ?? '', /detail has not come back/);
  // No runtime demand — no key to ask TVDB with; the catalogue demand brings
  // the answer.
  assert.deepEqual(undetailed.runtimeDemands(), []);
  assert.equal(plan.edits.some((e) => e.field === 'Episode'), true, 'the count still advances');
});

// --- which seasons are demanded --------------------------------------------

test('the demand names the completing season, with SIMKL’s own count to check against', () => {
  assert.deepEqual(closing().runtimeDemands(), [{ id: 800, tvdbId: 403245, season: 1 }]);
});

test('an answer already held is never demanded again, including a null one', () => {
  assert.deepEqual(closing({ runtimes: { 800: { 1: 49 } } }).runtimeDemands(), []);
  assert.deepEqual(closing({ runtimes: { 800: { 1: null } } }).runtimeDemands(), []);
});

test('a part-watched season, a filled cell and a dated row are all left alone', () => {
  const open = closing({ items: [{ id: 800, status: 'watching', seasons: { 1: watched(4) }, watched: 4, total: 10 }] });
  assert.deepEqual(open.runtimeDemands(), [], 'not complete');
  assert.deepEqual(closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { runtime: 43 })] }).runtimeDemands(), [], 'cell filled');
  assert.deepEqual(closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 10, 44000, { runtime: null })] }).runtimeDemands(), [], 'already dated');
});

// A SIMKL anime record numbers every cour "season 1" and all cours of a
// franchise share one TVDB id, so the row's season number means nothing there.
test('an anime block is never demanded, however its ids are arranged', () => {
  const anime = (type: string, showId: number | null, rowId: number | null) =>
    scenario({
      rows: [showRow('Frieren', 'Watching', showId, type), seasonRow(1, 27, null, { id: rowId, runtime: null })],
      items: [{ id: 900, status: 'watching', seasons: { 1: watched(28) }, watched: 28, total: 28 }],
      episodes: { 900: eps(1, 28) },
      details: { 900: { status: 'ended', runtime: 30 } },
      tvdbIds: { 900: 424536 },
    });
  assert.deepEqual(anime('anime', null, 900).runtimeDemands(), [], 'ids on the cour row, as anime is kept');
  // Type says anime but the id sits on the show row, so an id-location rule
  // alone would read it as live-action.
  assert.deepEqual(anime('anime', 900, null).runtimeDemands(), [], 'Type is what settles it');
});

test('a row carrying its own id is never demanded — its number is not the entry’s', () => {
  const own = scenario({
    rows: [show('Doctor Who', 'Watching', 810), seasonRow(14, 8, null, { id: 811, runtime: null })],
    items: [
      // The show-row entry's watched season is already covered, so the row
      // itself is the only thing left to ask about.
      { id: 810, status: 'watching', seasons: { 14: watched(8) }, watched: 8, total: 8 },
      { id: 811, status: 'completed', seasons: { 1: watched(8) }, watched: 8, total: 8 },
    ],
    episodes: { 810: eps(1, 8), 811: eps(1, 8) },
    details: { 810: { status: 'ended' }, 811: { status: 'ended' } },
    tvdbIds: { 810: 449991, 811: 449991 },
  });
  assert.deepEqual(own.runtimeDemands(), []);
});

test('a fractional season is never demanded', () => {
  // Season 1's own row is closed, so only the fractional row could be asked
  // about.
  const half = closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, 44000), seasonRow(1.5, 9, null, { runtime: null })] });
  assert.deepEqual(half.runtimeDemands(), []);
});

// A row treated as waiting whose lookup is never requested defers for ever.
// Plan and demands come out of one pass; the invariant is asserted over every
// closing shape.
test('every row the plan waits on is a season the same pass demanded', () => {
  const cases = [
    closing(),
    closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { runtime: null }), seasonRow(2, 3, null, { runtime: null })] }),
    closing({ items: [{ id: 800, status: 'completed', seasons: { 1: watched(10) }, watched: 10, total: 10 }] }),
    closing({ details: { 800: { status: 'airing', runtime: 43 } } }),
    closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { runtime: null }), seasonRow(1, 4, null, { runtime: null })] }),
    closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { runtime: null })], runtimes: { 800: { 2: 40 } } }),
  ];
  for (const [i, c] of cases.entries()) {
    const { plan, demands } = planSync(c.grid, c.index, c.titles, { timezone: TZ });
    const asked = new Set(demands.runtimes.map((r) => r.season));
    for (const skip of plan.skips) {
      if (skip.code !== 'awaiting-runtimes') continue;
      // "Silo S1: complete, but …" — the season the planner is waiting on.
      const season = Number(/ S(\d+):/.exec(skip.message)?.[1]);
      assert.ok(asked.has(season), `case ${i}: waiting on S${season} that was never demanded — it would defer for ever\n  ${skip.message}`);
    }
  }
});

// --- following SIMKL --------------------------------------------------------

/** A serial the guard accepts beside a recent watch, so the row's pair is consistent. */
const TODAY_SERIAL = todaySerial(TZ);

/**
 * A season the sheet already dated, watched recently enough to be in scope.
 * The dated row is the point: everything else the planner does stops at one,
 * and `Start` and `End` are what carry on past it.
 */
const dated = (timestamps: string[], end: number | null = TODAY_SERIAL) =>
  scenario({
    rows: [show('Fargo', 'Ended', 300), season(1, timestamps.length, end)],
    items: [{ id: 300, status: 'completed', seasons: { 1: timestamps }, watched: timestamps.length, total: timestamps.length }],
    episodes: { 300: eps(1, timestamps.length) },
    details: { 300: { status: 'ended', runtime: 45 } },
  });

const KEY = seasonKey(300, 1);
const seen = watched(6, 5);
const FIRST = seen[0] as string;
const LAST = seen.at(-1) as string;

/** Noon UTC on the same London day: an instant that moved without the date moving. */
const sameDay = (iso: string): string => `${plainDateIn(Temporal.Instant.from(iso), TZ).toString()}T12:00:00Z`;

const baselineOf = (entry: Record<string, string>): Baseline => new Map([[KEY, entry]]);

/**
 * The whole basis of "from now on". A value never observed is indistinguishable
 * from one that never moved, so the first sighting records and writes nothing —
 * whatever the cell happens to hold. Reconciling that disagreement is the thing
 * this deliberately does not do.
 */
test('a first sighting is recorded and never written, however far the cell disagrees', () => {
  const { result } = dated(seen);
  const { plan, observed } = result();
  assert.deepEqual(plan.edits, []);
  assert.equal(observed.get(KEY)?.Start, FIRST);
});

test('a start date that moved is written onto a row the sheet already dated', () => {
  const { result } = dated(seen);
  const { plan, observed, writing } = result(baselineOf({ Start: daysAgo(30) }));
  assert.deepEqual(plan.edits.map((e) => [e.field, e.value?.numberValue]), [['Start', dateSerial(plainDateIn(Temporal.Instant.from(FIRST), TZ))]]);
  // The value it is writing is held apart from what it merely saw: recorded
  // before the write lands, the next poll finds nothing moved and the change
  // is lost for good.
  assert.equal(writing.get(KEY)?.Start, FIRST);
  assert.equal(observed.get(KEY)?.Start, undefined);
});

test('a start date that did not move is written nowhere', () => {
  const { plan } = dated(seen).result(baselineOf({ Start: FIRST }));
  assert.deepEqual(plan.edits, []);
});

/**
 * A scrobbler restamping an episode moves the timestamp by seconds and moves
 * nothing the sheet can show. Comparing instants rather than the days they
 * render as would plan this same write on every poll.
 */
test('a restamp within the same day is not a change', () => {
  const { plan, observed } = dated(seen).result(baselineOf({ Start: sameDay(FIRST) }));
  assert.deepEqual(plan.edits, []);
  assert.equal(observed.get(KEY)?.Start, FIRST);
});

test('an end date that moved is written onto a dated row', () => {
  const { plan } = dated(seen).result(baselineOf({ Start: FIRST, End: daysAgo(30) }));
  assert.deepEqual(plan.edits.map((e) => [e.field, e.value?.numberValue]), [['End', dateSerial(plainDateIn(Temporal.Instant.from(LAST), TZ))]]);
});

/**
 * An open row's end date belongs to `closeSeason`, which holds it back while
 * the runtime question is open. Following it here as well would plan the same
 * cell twice in one batch.
 */
test('an open row’s end date is closed once, not followed', () => {
  const { plan } = dated(seen, null).result(baselineOf({ Start: FIRST, End: daysAgo(30) }));
  assert.deepEqual(plan.edits.filter((e) => e.field === 'End').length, 1);
});

/** Everything the row settled once stays settled; only the two upstream facts move. */
test('a dated row still takes no count, runtime or note', () => {
  const { grid, result } = dated(seen);
  const { plan } = result(baselineOf({ Start: daysAgo(30), End: daysAgo(30) }));
  assert.deepEqual([...new Set(plan.edits.map((e) => e.field))].sort(), ['End', 'Start']);
  assert.doesNotThrow(() => assertPlanSafe(plan, grid));
});

/**
 * The guard refuses a whole plan, so a single upstream timestamp outside the
 * writable range would hold up every unrelated edit for as long as its row sat
 * in the activity window. Stopped in the planner, and recorded even so, or the
 * skip repeats on every poll.
 */
test('an upstream date outside the writable range is skipped rather than planned', () => {
  // Through `isoOf`, because that is the width every stored timestamp keeps.
  const future = isoOf(Temporal.Now.instant().add({ hours: 24 * 5 }));
  // An open row, so the range is the only thing wrong with the date: on a dated
  // one the ordering rule would reach it first, for a different reason.
  const { result } = dated([future], null);
  const { plan, observed } = result(baselineOf({ Start: daysAgo(30) }));
  assert.deepEqual(plan.edits, []);
  assert.match(skipMessages(plan), /outside the range this sync writes/);
  assert.equal(observed.get(KEY)?.Start, future);
});

/**
 * Recorded for the whole library, not only the rows a pass reaches. A season
 * first observed on the very run that first reaches it would have its move
 * swallowed — and a move is usually what brought the row into scope.
 */
test('every season in the library is recorded, including those no row covers', () => {
  const { result } = scenario({
    rows: [show('Fargo', 'Ended', 300), season(1, 6, 44000)],
    items: [
      { id: 300, status: 'completed', seasons: { 1: seen }, watched: 6, total: 6 },
      { id: 999, status: 'completed', seasons: { 4: watched(3, 900) }, watched: 3, total: 3 },
    ],
    episodes: { 300: eps(1, 6) },
  });
  const { observed } = result();
  assert.equal(observed.has(seasonKey(999, 4)), true);
});

// --- following SIMKL, for anime ---------------------------------------------

/** Six watches whose first moves and whose last is held fixed. */
const runFrom = (first: number): string[] => [daysAgo(first), ...Array.from({ length: 5 }, (_, i) => daysAgo(25 - i))];

/**
 * An anime block: no id on the show row, each cour carrying its own. The sheet
 * numbers cours in sequence, so this row says season 2 — while the SIMKL entry
 * behind it numbers its only season 1.
 */
const animeCour = (first: number) =>
  scenario({
    rows: [show('Frieren', 'Ended', null, 'anime'), season(2, 6, TODAY_SERIAL, 1500)],
    items: [{ id: 1500, status: 'completed', seasons: { 1: runFrom(first) }, watched: 6, total: 6 }],
  });

/**
 * The key is `(SIMKL id, SIMKL season)`, so it agrees with what `observeWatches`
 * records off the index. Keyed on the *sheet's* season number instead, an anime
 * row would look up `1500:2`, find nothing there ever, and re-record itself on
 * every poll — never writing, and never saying why.
 */
test('an anime cour is recorded under SIMKL’s season number, not the sheet’s', () => {
  const { observed } = animeCour(30).result();
  assert.equal(observed.has(seasonKey(1500, 1)), true);
  assert.equal(observed.has(seasonKey(1500, 2)), false);
});

test('an anime cour follows a start date that moved, on a row the sheet dated', () => {
  const { grid, result } = animeCour(31);
  const { plan } = result(new Map([[seasonKey(1500, 1), { Start: daysAgo(30) }]]));
  assert.deepEqual(plan.edits.map((e) => [e.field, e.value?.numberValue]), [['Start', dateSerial(plainDateIn(Temporal.Instant.from(daysAgo(31)), TZ))]]);
  // The runtime write and the insert are live-action only; following SIMKL is
  // not, and the guard has to agree with the planner about that.
  assert.doesNotThrow(() => assertPlanSafe(plan, grid));
});

/**
 * A split cour gains its second id only once the first has finished, so keying
 * on the last id would change the key on the day a cour was added — orphaning
 * everything recorded and reading the whole row as never observed. The first id
 * is the one that was there from the start.
 */
test('a split cour keeps the key it had before the second half existed', () => {
  const half = scenario({
    rows: [show('Ajin: Demi-Human', 'Ended', null, 'anime'), season(1, 13, TODAY_SERIAL, 522882)],
    items: [{ id: 522882, status: 'completed', seasons: { 1: runFrom(31) }, watched: 13, total: 13 }],
  });
  const both = scenario({
    rows: [show('Ajin: Demi-Human', 'Ended', null, 'anime'), season(1, 26, TODAY_SERIAL, '522882,581835')],
    items: [
      { id: 522882, status: 'completed', seasons: { 1: runFrom(31) }, watched: 13, total: 13 },
      { id: 581835, status: 'completed', seasons: { 1: watched(13, 3) }, watched: 13, total: 13 },
    ],
  });

  const recorded = new Map([[seasonKey(522882, 1), { Start: daysAgo(30) }]]);
  const before = half.result(recorded).plan.edits.map((e) => [e.field, e.value?.numberValue]);
  const after = both.result(recorded).plan.edits.filter((e) => e.field === 'Start').map((e) => [e.field, e.value?.numberValue]);
  assert.deepEqual(after, before, 'the second id arriving does not move the key or the value');
});

/**
 * The sync builds the seed once and hands the same map to every planning pass
 * and every re-read, and `planSync` only shallow-copies it — so what makes that
 * copy safe is that planning never edits an entry, it replaces it. Withdrawing a
 * field by deleting it in place would strip it from the seed itself, leaving a
 * discarded pass to decide what later passes see.
 */
/**
 * Both fields, library-wide, from the library alone. What needs a lookup is
 * *writing* `End` — the row must be complete, and only the episode list says
 * so for a season resolved by number. Recording asks nothing, and recording
 * wide is what makes a later disagreement a real move by one season rather
 * than a first sighting on every season nobody happened to look up.
 */
test('every season records both its first and its last watch', () => {
  // Captured once: `watched` reads the clock, so a second call for the
  // assertion would differ from the fixture by a millisecond.
  const one = watched(6, 900);
  const two = watched(4, 100);
  const index = indexLibrary(libraryOf({ id: 300, status: 'completed', seasons: { 1: one, 2: two }, watched: 10, total: 10 }));
  const seed = observeWatches(index);

  assert.deepEqual(seed.get(seasonKey(300, 1)), { Start: one[0], Watched: '6', End: one.at(-1) });
  assert.deepEqual(seed.get(seasonKey(300, 2)), { Start: two[0], Watched: '4', End: two.at(-1) });
  // The title's own entry, which is the record that it was *seen* — what makes
  // a title appearing later a new one, and a plantowatch title with nothing
  // watched carries it too.
  assert.deepEqual(seed.get(titleRecordKey(300)), { Status: 'completed' });
});

test('planning does not edit the seed it was handed', () => {
  // An **open** row: on a dated one the `End` step replaces the entry before
  // `Start` withdraws from it, so the sharing this guards is already broken and
  // the assertion would hold whatever the withdrawal did.
  const { grid, index, titles } = dated(seen, null);
  const starts = observeWatches(index);
  const before = JSON.stringify([...starts]);

  // A moved Start, so the withdrawal this guards actually runs.
  planSync(grid, index, titles, { timezone: TZ, baseline: baselineOf({ Start: daysAgo(30) }), starts });
  assert.equal(JSON.stringify([...starts]), before);
});

/**
 * A row dated before SIMKL now says its first episode was watched — a date
 * typed by hand, or one this sync wrote before the watch was corrected. The
 * write is dropped for that row alone.
 *
 * The guard refuses such a pair, and refusal is whole-plan: left to it, one
 * inconsistent row would stop every unrelated edit on every poll for as long as
 * it sat inside the activity window, since a refused run records nothing and
 * plans the same edit again.
 */
test('a start date that would fall after the row’s end is skipped, not planned', () => {
  const { grid, result } = dated(seen, 44000);
  const { plan } = result(baselineOf({ Start: daysAgo(30) }));
  assert.deepEqual(plan.edits, []);
  assert.match(skipMessages(plan), /starting after it ended/);
  assert.doesNotThrow(() => assertPlanSafe(plan, grid));
});

/**
 * Both writers of `End` owe the same bound. A season completing with a
 * timestamp outside the writable range is one row skipped, never a plan the
 * guard refuses whole.
 */
test('an open season completing on an unusable timestamp is skipped, not planned', () => {
  const future = isoOf(Temporal.Now.instant().add({ hours: 24 * 5 }));
  const { grid, result } = dated([future], null);
  const { plan } = result();
  assert.deepEqual(plan.edits.filter((e) => e.field === 'End'), []);
  assert.doesNotThrow(() => assertPlanSafe(plan, grid));
});

/**
 * The question the activity window answers is "has this been watched lately",
 * which is not the question a corrected date asks. Fixing the date you started
 * a season in 2018 is a change made *today*; it moves no watch timestamp, and
 * the season it belongs to may never be watched again.
 *
 * What keeps this safe on a dormant sheet is the baseline, not the window: a
 * value never seen move is never written, so a sheet nobody touches still plans
 * nothing. `Start` costs no lookup, so reaching back adds no upstream call.
 */
test('a start date that moved is written however long ago the season was watched', () => {
  const old = watched(6, 900);
  const { grid, result } = scenario({
    rows: [show('Fargo', 'Ended', 300), season(1, 6, TODAY_SERIAL)],
    items: [{ id: 300, status: 'completed', seasons: { 1: old }, watched: 6, total: 6 }],
  });
  // `End` already recorded at the day SIMKL still reports, so the only thing
  // moving is `Start` — which comes off the library and settles nothing.
  const { plan, demands } = result(new Map([[seasonKey(300, 1), { Start: daysAgo(1200), End: old.at(-1) as string }]]));

  assert.deepEqual(plan.edits.map((e) => e.field), ['Start']);
  assert.doesNotThrow(() => assertPlanSafe(plan, grid));
  // The window still gates everything that costs a call: a block nobody has
  // watched lately is not looked up just to compare a date already in hand.
  assert.deepEqual(demands.catalogue, []);
});

// --- reaching back for `End` ------------------------------------------------
//
// `End` is eligible only on a complete season, and a row resolved through the
// catalogue takes that answer from there. Gating the lookup on the window
// freezes the field rather than merely skipping it: never eligible means never
// recorded, and a value never recorded can never be seen to move.
//
// The demand is decided from the library and the record alone, which is what
// keeps it bounded — a dormant row asks only when the day SIMKL reports is not
// the day already written down for it.

/** The same block as `dated`, with the catalogue unanswered: what a poll leaves. */
const dormant = (timestamps: string[]) =>
  scenario({
    rows: [show('Fargo', 'Ended', 300), season(1, timestamps.length, TODAY_SERIAL)],
    items: [{ id: 300, status: 'completed', seasons: { 1: timestamps }, watched: timestamps.length, total: timestamps.length }],
  });

test('a dormant season whose end date moved upstream asks for the completeness answer', () => {
  const old = watched(6, 900);
  const { grid, index, titles } = dormant(old);
  const stale: Baseline = new Map([[KEY, { Start: old[0] as string, End: daysAgo(1200) }]]);
  const { plan, demands } = planSync(grid, index, titles, { timezone: TZ, baseline: stale });

  assert.deepEqual(demands.catalogue, [{ id: 300, episodes: true, detail: true }]);
  // Nothing yet: the answer that makes `End` eligible has not come back. The
  // sync re-plans once it has, which is what the fixpoint is for.
  assert.deepEqual(plan.edits.filter((e) => e.field === 'End'), []);
});

test('the same season writes its end date once the answer is in hand', () => {
  const old = watched(6, 900);
  const { grid, result } = dated(old, TODAY_SERIAL);
  const stale: Baseline = new Map([[KEY, { Start: old[0] as string, End: daysAgo(1200) }]]);
  const { plan, demands } = result(stale);

  assert.deepEqual(plan.edits.map((e) => e.field), ['End']);
  assert.doesNotThrow(() => assertPlanSafe(plan, grid));
  // Answered, so nothing more is asked for.
  assert.deepEqual(demands.catalogue, []);
});

/**
 * The demand's two bounds, each the difference between one lookup and a daily
 * one forever. A row carrying its own id takes `complete` from that entry's
 * own counters, so no episode list can settle it — and the id the block would
 * name is not even the id the row resolved through. An open row has no `End`
 * to follow at all.
 */
test('a season row carrying its own id asks for nothing, whatever its block looks like', () => {
  const old = watched(6, 900);
  const { grid, index, titles } = scenario({
    rows: [show('Fargo', 'Ended', 300), season(1, 6, TODAY_SERIAL, 555)],
    items: [
      { id: 300, status: 'completed', seasons: { 1: old }, watched: 6, total: 6 },
      { id: 555, status: 'watching', seasons: { 1: old }, watched: 6, total: 10, notAired: 4 },
    ],
  });
  const stale: Baseline = new Map([[seasonKey(555, 1), { Start: old[0] as string, End: daysAgo(1200) }]]);

  assert.deepEqual(planSync(grid, index, titles, { timezone: TZ, baseline: stale }).demands.catalogue, []);
});

/**
 * The reachable half of the range check out here is the floor: a stamp before
 * `MIN_SERIAL` is both dormant and unwritable, and SIMKL really does serve
 * them — an episode marked watched with no date carries the epoch. Above the
 * ceiling is unreachable on this path, a future stamp being recent by
 * definition.
 */
test('a timestamp below the range this sync writes earns no lookup to refuse it with', () => {
  const epoch = '1970-01-01T00:00:01Z';
  const { grid, index, titles } = dormant([epoch]);
  const stale: Baseline = new Map([[KEY, { Start: epoch, End: daysAgo(1200) }]]);

  assert.deepEqual(planSync(grid, index, titles, { timezone: TZ, baseline: stale }).demands.catalogue, []);
});

test('an undated season asks for nothing — it has no end date to follow', () => {
  const old = watched(6, 900);
  const { grid, index, titles } = scenario({
    rows: [show('Fargo', 'Ended', 300), season(1, 6, null)],
    items: [{ id: 300, status: 'completed', seasons: { 1: old }, watched: 6, total: 6 }],
  });

  assert.deepEqual(planSync(grid, index, titles, { timezone: TZ, baseline: new Map() }).demands.catalogue, []);
});

/**
 * These two fields reach rows the window never takes back out of scope, so a
 * refusal earned out here is not one that ages out: the guard refuses a
 * formula target whole-plan, which would hold up every unrelated edit on the
 * sheet on every poll from then on. Declined in the planner, with the value
 * still recorded so the row settles.
 */
test('a formula in a dated end cell is declined, not planned onto', () => {
  const old = watched(6, 900);
  const formulaEnd = season(1, 6, TODAY_SERIAL);
  formulaEnd[col(H, 'End Date')] = { formula: '=TODAY()', value: TODAY_SERIAL };
  const { grid, index, titles } = scenario({
    rows: [show('Fargo', 'Ended', 300), formulaEnd],
    items: [{ id: 300, status: 'completed', seasons: { 1: old }, watched: 6, total: 6 }],
    episodes: { 300: eps(1, 6) },
    details: { 300: { status: 'ended', runtime: 45 } },
  });
  const stale: Baseline = new Map([[seasonKey(300, 1), { Start: old[0] as string, End: daysAgo(1200) }]]);
  const { plan, observed } = planSync(grid, index, titles, { timezone: TZ, baseline: stale });

  assert.deepEqual(plan.edits.filter((e) => e.field === 'End'), []);
  assert.match(skipMessages(plan), /would overwrite a formula/);
  // Recorded anyway, so the row settles instead of asking again every poll.
  assert.equal(observed.get(seasonKey(300, 1))?.End, old.at(-1));
});


/**
 * A row matched by season *number* is only that season if it holds the same
 * episodes. The sheet numbers some shows its own way — a Netflix batch split
 * into parts gives ten-episode rows against a twenty-episode SIMKL season — so
 * that season's first and last watch belong to other rows, and following them
 * writes a later part's date onto an earlier part's row.
 */
test('a closed row holding fewer episodes than its SIMKL season does not follow its dates', () => {
  const part = watched(10, 900);
  const whole = [...watched(10, 1200), ...part];
  const { result } = scenario({
    rows: [show('Disenchantment', 'Ended', 300), season(1, 10, TODAY_SERIAL)],
    items: [{ id: 300, status: 'completed', seasons: { 1: whole }, watched: 20, total: 20 }],
    episodes: { 300: eps(1, 20) },
    details: { 300: { status: 'ended', runtime: 25 } },
  });
  const stale: Baseline = new Map([[seasonKey(300, 1), { Start: daysAgo(1300), End: daysAgo(1300) }]]);
  const { plan, observed, writing } = result(stale);

  assert.deepEqual(plan.edits, []);
  assert.deepEqual([...new Set(plan.skips.map((s) => s.code))], ['season-fragment']);
  assert.match(skipMessages(plan), /covers 20 episodes where this row holds 10/);
  // Recorded, so the row settles rather than reporting itself every poll.
  assert.equal(writing.size, 0);
  assert.equal(observed.get(seasonKey(300, 1))?.End, whole.at(-1));
});

/**
 * The counterpart, and the reason the test is on `closed` alone: an open row's
 * count lags SIMKL by design — that gap is what the count write settles — so
 * reading it as a mismatch would stop a season following SIMKL for exactly as
 * long as it was still being watched.
 */
test('an open row whose count lags SIMKL still follows its start date', () => {
  const seen = watched(6, 5);
  const { grid, result } = scenario({
    rows: [show('Fargo', 'Watching', 300), season(1, 2, null)],
    items: [{ id: 300, status: 'watching', seasons: { 1: seen }, watched: 6, total: 10, notAired: 4 }],
    episodes: { 300: eps(1, 10, 6) },
    details: { 300: { status: 'continuing', runtime: 45 } },
  });
  const stale: Baseline = new Map([[seasonKey(300, 1), { Start: daysAgo(400) }]]);
  const { plan } = result(stale);

  assert.ok(plan.edits.some((e) => e.field === 'Start'), 'the start date still follows');
  assert.equal(plan.skips.filter((s) => s.code === 'season-fragment').length, 0);
  assert.doesNotThrow(() => assertPlanSafe(plan, grid));
});


test('a dormant season whose end date agrees with the record asks for nothing', () => {
  const old = watched(6, 900);
  const { grid, index, titles } = dormant(old);
  const agreed: Baseline = new Map([[KEY, { Start: old[0] as string, End: old.at(-1) as string }]]);

  assert.deepEqual(planSync(grid, index, titles, { timezone: TZ, baseline: agreed }).demands.catalogue, []);
});

/**
 * Reaching back far enough to *record* a value is the point; writing one
 * nobody has seen move is not. A season never observed while it was recent can
 * otherwise never be followed at all, because `moved` is measured against a
 * record that never gets written.
 */
test('a dormant season with no recorded end date is observed, never written', () => {
  const old = watched(6, 900);
  const { result } = dated(old, TODAY_SERIAL);
  const startOnly: Baseline = new Map([[KEY, { Start: old[0] as string }]]);
  const { plan, observed, writing } = result(startOnly);

  assert.deepEqual(plan.edits.filter((e) => e.field === 'End'), []);
  assert.equal(writing.get(KEY)?.End, undefined);
  assert.equal(observed.get(KEY)?.End, old.at(-1));
});

/** The counterpart: nothing else reaches back with it. */
test('an out-of-window row still takes no count, note or status', () => {
  const old = watched(6, 900);
  const { plan } = scenario({
    rows: [show('Fargo', 'Watching', 300), season(1, 2, null)],
    items: [{ id: 300, status: 'completed', seasons: { 1: old }, watched: 6, total: 6 }],
  }).result();
  assert.deepEqual(plan.edits, []);
  assert.equal(plan.insert, null);
});

/**
 * The mirror of the start rule, and the reason the pair is decided before
 * either half is emitted: an end date that moves *below* the start the row
 * holds inverts it just as surely, and a check attached to `Start` alone never
 * runs on a batch that only moves `End`.
 */
test('an end date that would fall before the row’s start is skipped, not planned', () => {
  const { grid, result } = scenario({
    rows: [show('Fargo', 'Ended', 300), season(1, 2, TODAY_SERIAL, null, null)],
    items: [{ id: 300, status: 'completed', seasons: { 1: [daysAgo(3000), daysAgo(2999)] }, watched: 2, total: 2 }],
    episodes: { 300: eps(1, 2) },
  });
  const { plan } = result(new Map([[seasonKey(300, 1), { Start: daysAgo(3000), End: daysAgo(1) }]]));
  assert.deepEqual(plan.edits, []);
  assert.match(skipMessages(plan), /End Date would leave the row starting after it ended/);
  assert.doesNotThrow(() => assertPlanSafe(plan, grid));
});

/**
 * Every row now reaches `resolveRow`, including blocks far outside the activity
 * window. A sheet holding one title SIMKL no longer lists would otherwise name
 * it on every poll for the life of the sheet — and an unresolvable row has no
 * tracked field to follow, so saying so buys nothing.
 */
test('a row that cannot be resolved is reported only while its block is in scope', () => {
  const gone = (watchedDaysAgo: number) =>
    scenario({
      rows: [show('Gone Show', 'Ended', 999999), season(1, 6, TODAY_SERIAL)],
      items: [{ id: 300, status: 'completed', seasons: { 1: [daysAgo(watchedDaysAgo)] }, watched: 1, total: 1 }],
    }).plan();

  assert.deepEqual(gone(900).skips, [], 'nothing recent in the block, so nothing to say about it');
  // The same unresolvable row inside the window is still worth naming: there,
  // the sync would otherwise be expected to write to it.
  const inScope = scenario({
    rows: [show('Gone Show', 'Ended', 999999), season(1, 6, TODAY_SERIAL, 999999)],
    items: [{ id: 999999, status: 'completed', seasons: { 1: [daysAgo(3)] }, watched: 1, total: 1 }],
  });
  assert.doesNotThrow(() => assertPlanSafe(inScope.plan(), inScope.grid));
});

/**
 * The run that closes a season records the date it wrote, like any other
 * tracked write. Without it the closing run banks nothing, the next poll sees
 * `End` for the first time and records it silently, and a correction landing in
 * between is lost for good.
 */
test('the batch that dates a row records the date it wrote', () => {
  const { result } = dated(seen, null);
  const { plan, writing } = result();
  assert.ok(plan.edits.some((e) => e.field === 'End'), 'the row is closed by this batch');
  assert.equal(writing.get(KEY)?.End, LAST);
  // In `writing`, never `observed`: a value recorded before its write lands is
  // a change banked and never made.
  assert.equal(result().observed.get(KEY)?.End, undefined);
});

// --- a block the tab does not have yet -------------------------------------

/**
 * One TV show the grid has no block for, with every fact answered — the state
 * that lands a block. Each test below varies one input and asserts the block
 * is held back for that reason alone.
 *
 * `facts` is passed explicitly because `test/helpers.ts` blanks both
 * credentials on import: left to the config default every test here would land
 * on the "set the keys" note and look like it had passed.
 */
const blocks = (catalogue: Partial<TitleCatalogue> = {}, options: PlanOptions = {}, item: Partial<ItemSpec> = {}) =>
  planSync(blockGrid.grid, blockLibrary(catalogue, item).index, blockLibrary(catalogue, item).titles, {
    timezone: TZ,
    facts: { tvdb: true, tmdb: true },
    showBucket: null,
    // Off the baseline the test seeded, exactly as `sync.ts` counts it off the
    // record it loaded — a fixture that answered this on its own would let a
    // test seed a record and get a different reading of it than the service.
    anyTitleRecorded: anyTitleRecorded(options.baseline ?? new Map()),
    ...options,
  });

const blockGrid = gridFixture(namedShow('fargo', 'Fargo'), namedSeason('fargoS1', 1, 6, 44000), namedSeason('fargoS2', 2, 3, null));

/** `blockLibrary`'s answered catalogue entry under another id and title — every fact a block needs. */
const blockFacts = (id: number, title: string): [number, TitleCatalogue] => [id, blockLibrary({ title }).titles.get(900)!];

const valueOf = (insert: Insert | null, row: number, field: string) =>
  insert?.fill.find((f) => f.row === row && f.field === field)?.value;

test('a TV show the tab has no block for becomes a show row and its first season row', () => {
  const { plan } = blocks();
  const insert = plan.insert;
  assert.equal(insert?.kind, 'block');
  assert.equal(spanOf(insert), 2);
  // Under Fargo's last season row: Severance sorts after Fargo, and the row
  // above has to be a season row for the formats to inherit.
  assert.equal(insert?.row, blockGrid.end);
  assert.equal(insert?.title, 'Severance');
  assert.equal(insert?.franchise, 'Severance');
  assert.equal(seasonOf(insert), 1);

  const show = blockGrid.end;
  assert.equal(valueOf(insert, show, 'Show')?.stringValue, 'Severance');
  assert.equal(valueOf(insert, show, 'Franchise')?.stringValue, 'Severance');
  assert.equal(valueOf(insert, show, 'Type')?.stringValue, 'show');
  assert.equal(valueOf(insert, show, 'id')?.stringValue, '900', 'text, as all 189 show rows hold it');
  assert.equal(valueOf(insert, show, 'Status')?.stringValue, 'Watching');
  assert.equal(valueOf(insert, show, 'Genre')?.stringValue, 'Drama');
  assert.equal(valueOf(insert, show, 'Genres')?.stringValue, 'Sci-Fi, Thriller');
  assert.equal(valueOf(insert, show, 'Network')?.stringValue, 'Apple TV+');
  assert.equal(valueOf(insert, show, 'Certificate')?.numberValue, 15);
  // The five roll-ups, as the templates for the row they land on.
  const formulas = showRowFormulas(blockGrid.grid.columns, show);
  for (const field of ROLLUP_FIELDS) assert.equal(valueOf(insert, show, field)?.formulaValue, formulas[field]);

  assert.equal(valueOf(insert, show + 1, 'Season')?.numberValue, 1);
  assert.equal(valueOf(insert, show + 1, 'Episode')?.numberValue, 2);
  assert.equal(valueOf(insert, show + 1, 'id'), undefined, 'the season row inherits the show row’s id');
});

// The guard refuses one, so the planner must never build one. Both halves ask
// the same question and neither may answer it alone.
test('a planned block passes the guard', () => {
  const { plan } = blocks();
  assert.doesNotThrow(() => assertPlanSafe(plan, blockGrid.grid, { timezone: TZ }));
});

// The column is written once and never revisited, so a link with nothing
// behind it is a broken image for the life of the row.
test('the artwork formula is written only where a bucket is configured', () => {
  assert.equal(valueOf(blocks().plan.insert, blockGrid.end, 'Banner'), undefined);
  const withBucket = blocks({}, { showBucket: 'art' }).plan.insert;
  assert.equal(valueOf(withBucket, blockGrid.end, 'Banner')?.formulaValue, artworkFormula(blockGrid.grid.columns.Show, blockGrid.end, 'art'));
  assert.doesNotThrow(() => assertPlanSafe(blocks({}, { showBucket: 'art' }).plan, blockGrid.grid, { timezone: TZ, showBucket: 'art' }));
});

// The season row a block creates is an ordinary inserted season row, written
// by the same code: a block whose row differed from the one a season insert
// would build is two answers to one question.
test('a block’s season row holds exactly what a season insert into the same block would', () => {
  const existing = gridFixture(
    namedShow('sev', 'Severance', { id: 900, status: 'Watching' }),
    namedSeason('sevS0', 0, 5, 44000),
  );
  const { index, titles } = blockLibrary();
  const seasonInsert = planSync(existing.grid, index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true } }).plan.insert;
  assert.equal(seasonInsert?.kind, 'season');

  const cells = (insert: Insert | null, row: number) =>
    Object.fromEntries((insert?.fill ?? []).filter((f) => f.row === row).map((f) => [f.field, f.value]));
  assert.deepEqual(cells(blocks().plan.insert, blockGrid.end + 1), cells(seasonInsert, seasonInsert?.row ?? -1));
});

// --- what a block waits for -------------------------------------------------

test('a block waits while SIMKL’s detail has not answered', () => {
  const { plan, demands } = blocks({ tvdbId: undefined, tmdbId: undefined, title: undefined });
  assert.equal(plan.insert, null);
  assert.equal(plan.skips.find((s) => s.code === 'awaiting-lookup')?.message.includes("SIMKL's detail"), true);
  assert.deepEqual(demands.catalogue, [{ id: 900, episodes: true, detail: true }]);
});

// A live-action title with no episode list is a failed lookup, not a show with
// no episodes: read as one, the season row's count and status come from
// nothing.
test('a block waits while no episode list came back', () => {
  const { plan } = blocks({ shapes: new Map() });
  assert.equal(plan.insert, null);
  assert.equal(plan.skips.find((s) => s.code === 'no-episode-list')?.message.includes('no episode list'), true);
});

test('a block waits on TVDB’s genres and TMDB’s certificate, and asks for both', () => {
  const both = blocks({ genres: undefined, certificate: undefined });
  assert.equal(both.plan.insert, null);
  assert.match(both.plan.skips.find((s) => s.code === 'awaiting-lookup')?.message ?? '', /waiting on TVDB and TMDB/);
  assert.deepEqual(both.demands.genres, [{ id: 900, tvdbId: 111 }]);
  assert.deepEqual(both.demands.certificates, [{ id: 900, tmdbId: 222 }]);

  // Answered with nothing is not the same as unanswered: the block lands with
  // those cells blank, which is what a series TVDB or TMDB has nothing for
  // looks like for the life of the row.
  const settled = blocks({ genres: null, certificate: null });
  assert.equal(settled.plan.insert?.kind, 'block');
  assert.deepEqual(settled.demands.genres, []);
  assert.equal(valueOf(settled.plan.insert, blockGrid.end, 'Genre'), undefined);
  assert.equal(valueOf(settled.plan.insert, blockGrid.end, 'Certificate'), undefined);
});

// Gated on airing, not watching: mid-air SIMKL's episode count has not
// settled, and `averageRuntime` checks TVDB's against it. Unlike a season
// insert, a block waits rather than landing with the cell blank — nothing
// revisits a show row, so the block is built in one batch or not at all.
test('a block waits on the season runtime an aired season can still be given', () => {
  const { plan, demands } = blocks({ seasonRuntimes: new Map() });
  assert.equal(plan.insert, null);
  assert.match(plan.skips.find((s) => s.code === 'awaiting-runtimes')?.message ?? '', /episode runtimes/);
  assert.deepEqual(demands.runtimes, [{ id: 900, tvdbId: 111, season: 1 }]);
  assert.equal(plan.deferred, 0, 'the ask is out, so this run drains it inside its own fixpoint');
});

// --- what a block is refused for --------------------------------------------

// A new cour is a separate SIMKL title under a romaji name that mostly does
// not match what the sheet calls the series, so an inserted anime block would
// duplicate a series already filed as season N of an existing one.
test('anime keeps the add-it-by-hand note rather than becoming a block', () => {
  const { plan } = blocks({}, {}, { type: 'anime' });
  assert.equal(plan.insert, null);
  assert.match(plan.notes.join('\n'), /Severance \(simkl 900\) has recent activity and no row/);
});

// The question a block turns on first is whether there is a row to add at all,
// and the answer is a projection of the library: asked after the lookups, a
// title whose recent watching is all specials costs a SIMKL detail, TVDB's
// genres and TMDB's certificate every poll, for a block nothing would build.
test('a show with no numbered season inside the window is reported, never added, and costs no lookup', () => {
  // SIMKL's season 0 is specials, which `seasonsOf` drops — so a title watched
  // only there has no season a row could be for.
  const specials = blocks({ genres: undefined, certificate: undefined }, {}, { seasons: { 0: [daysAgo(9), daysAgo(2)] } });
  assert.equal(specials.plan.insert, null);
  assert.match(specials.plan.notes.join('\n'), /Severance \(simkl 900\) has recent activity and no row/);
  assert.deepEqual(specials.demands.catalogue, [], 'nothing is asked of SIMKL for a title with no row to gain');
  assert.deepEqual(specials.demands.genres, []);
  assert.deepEqual(specials.demands.certificates, []);
});

// `last_watched_at` is what SIMKL moves when anything about the record is
// written, and the walk reads it to decide whether a title is worth looking at
// — but which season a row would be for is decided by the episode stamps, and
// those can all sit outside the window the title's own stamp is inside.
test('a show whose episodes were all watched outside the window is reported, never added', () => {
  const stale = blocks({ genres: undefined, certificate: undefined }, {}, { seasons: { 1: [daysAgo(400), daysAgo(300)] }, lastWatchedAt: daysAgo(2) });
  assert.equal(stale.plan.insert, null);
  assert.match(stale.plan.notes.join('\n'), /Severance \(simkl 900\) has recent activity and no row/);
  assert.deepEqual(stale.demands.catalogue, []);
});

/**
 * The same rule one level up, and the whole point of the feature: a back
 * catalogue marked watched today is a change made today, and the tab has no row
 * for it at all. Its episode stamps are the air dates SIMKL gave them, so
 * nothing about the watching is recent — what is recent is the title having
 * appeared in a record that already names others.
 *
 * The block lands **whole**: one row per season, in one span. A row a run would
 * leave the show row above counting the next block's rows for a poll, and
 * fifteen polls of that for a fifteen-season show.
 */
const BACK_CATALOGUE = { seasons: { 1: [daysAgo(900), daysAgo(880)], 2: [daysAgo(870)], 3: [daysAgo(860)] }, lastWatchedAt: daysAgo(870) };

test('a title with no record at all gains its whole block, whatever its episode stamps say', () => {
  const shapes = seasonShapes([1, 2, 3].flatMap((n) => Array.from({ length: 9 }, (_, i) => ({ season: n, episode: i + 1, type: 'episode' as const, aired: true }))));
  const runtimes = new Map<number, number | null>([
    [1, 45],
    [2, 45],
    [3, 45],
  ]);

  // An empty record makes nothing new: a fresh install does not build a block
  // for every show in the library on its first poll.
  const fresh = blocks({ shapes, seasonRuntimes: runtimes }, { baseline: new Map() }, BACK_CATALOGUE);
  assert.equal(fresh.plan.insert, null);
  assert.deepEqual(fresh.plan.notes, [], 'and a dormant sheet says nothing rather than repeating itself every poll');

  // A record that names some other title makes this one new.
  const known: Baseline = new Map([[titleRecordKey(4242), { Status: 'watching' }]]);
  const { plan, observed, writing } = blocks({ shapes, seasonRuntimes: runtimes }, { baseline: known }, BACK_CATALOGUE);
  assert.equal(plan.insert?.kind, 'block');
  assert.deepEqual((plan.insert as { seasons: number[] }).seasons, [1, 2, 3]);
  assert.equal(spanOf(plan.insert), 4, 'a show row and three season rows, in one span');
  assert.equal(plan.deferred, 0, 'nothing is left behind');

  // Every season row carries its own number, ascending down the span.
  // Below the show row, whose own `Season` cell is the roll-up formula.
  const seasonCells = plan.insert?.fill.filter((cell) => cell.field === 'Season' && cell.row > (plan.insert?.row ?? 0)) ?? [];
  assert.deepEqual(
    seasonCells.map((cell) => [cell.row - (plan.insert?.row ?? 0), cell.value?.numberValue]),
    [
      [1, 1],
      [2, 2],
      [3, 3],
    ],
  );

  // Banked against the write, not recorded as seen: a batch that never landed
  // must leave the title unseen so the next poll builds it again.
  assert.equal(writing.get(titleRecordKey(BLOCK_SHOW.id))?.Status, 'watching');
  assert.equal(observed.get(titleRecordKey(BLOCK_SHOW.id))?.Status, undefined);
  for (const n of [1, 2, 3]) assert.ok(writing.get(seasonKey(BLOCK_SHOW.id, n))?.Watched !== undefined, `S${n} is banked`);
});

/**
 * `titleIsNew` fires on every title the record has not seen, which on the poll
 * after this code ships is none and on every poll after that is whatever SIMKL
 * added. A watchlist entry is one of those, and it has no season a row could be
 * for — read as a candidate, every show on the watchlist would be reported as a
 * missing row.
 */
test('a title with nothing watched at all is no candidate, however new it is', () => {
  const known: Baseline = new Map([[titleRecordKey(4242), { Status: 'watching' }]]);
  const planned = blocks({}, { baseline: known }, { status: 'plantowatch', seasons: { 1: [null, null] }, watched: 0, lastWatchedAt: null });
  assert.equal(planned.plan.insert, null);
  assert.deepEqual(planned.plan.notes, []);
  assert.deepEqual(planned.plan.skips, []);
});

/**
 * A block the run could not build leaves nothing recorded, or the run that
 * *can* build it would find a title it has already seen and walk past.
 */
test('a block held back for a credential leaves the title unrecorded', () => {
  const known: Baseline = new Map([[titleRecordKey(4242), { Status: 'watching' }]]);
  const { plan, observed } = blocks({}, { baseline: known, facts: { tvdb: false, tmdb: true } }, BACK_CATALOGUE);
  assert.equal(plan.insert, null);
  assert.match(plan.notes.join('\n'), /set TVDB_API_KEY/);
  assert.equal(observed.get(titleRecordKey(BLOCK_SHOW.id))?.Status, undefined);
  assert.equal(observed.get(seasonKey(BLOCK_SHOW.id, 1))?.Watched, undefined);
});

/**
 * `SHEET_MAX_ROWS` is a blast radius the guard refuses a plan *whole* for
 * crossing, so a block taller than the room left is cut rather than planned and
 * refused every poll until the seasons age out. What is cut off is deferred,
 * which arms the retry that brings the next run.
 */
test('a block taller than the row budget is cut to fit, and says what it left', () => {
  const shapes = seasonShapes([1, 2, 3].flatMap((n) => Array.from({ length: 9 }, (_, i) => ({ season: n, episode: i + 1, type: 'episode' as const, aired: true }))));
  const runtimes = new Map<number, number | null>([
    [1, 45],
    [2, 45],
    [3, 45],
  ]);
  const known: Baseline = new Map([[titleRecordKey(4242), { Status: 'watching' }]]);
  const { plan, observed } = blocks({ shapes, seasonRuntimes: runtimes }, { baseline: known, maxRows: 3 }, BACK_CATALOGUE);
  assert.deepEqual((plan.insert as { seasons: number[] }).seasons, [1, 2]);
  assert.equal(spanOf(plan.insert), 3);
  assert.equal(plan.deferred, 1, 'S3');
  assert.equal(observed.get(seasonKey(BLOCK_SHOW.id, 3))?.Watched, undefined, 'so the next run still sees it as unrecorded');
});

/**
 * The same rule the season insert follows, stated per row: a block's rows do not
 * all answer alike, and only the ones a later poll has to finish keep their
 * counts unrecorded.
 *
 * A season still airing is not held back for its runtime — the block would never
 * land — so it goes in with that cell blank and something still able to reach
 * it.
 */
test('a block row whose runtime nothing has answered keeps its count unrecorded', () => {
  const { plan, observed, writing } = blocks({ shapes: seasonShapes(eps(1, 9, 4)), seasonRuntimes: new Map() });
  assert.equal(plan.insert?.kind, 'block');
  assert.deepEqual((plan.insert as { open: number[] }).open, [1], 'its runtime cell is blank and the close can still fill it');
  assert.equal(observed.get(seasonKey(BLOCK_SHOW.id, 1))?.Watched, undefined, 'so the row comes back to be closed');
  assert.equal(writing.get(seasonKey(BLOCK_SHOW.id, 1))?.Watched, undefined);
  assert.equal(writing.get(titleRecordKey(BLOCK_SHOW.id))?.Status !== undefined, true, 'the title itself is still banked against the block');
});

/**
 * What resolves a room refusal is an edit to the tab — rows added past the last
 * block, or a budget a later poll has more of — and the record cannot see
 * either. So nothing about the title is recorded, and the run that finally has
 * the room still finds a title it has never seen.
 */
test('a block refused for want of room is still new on the next run', () => {
  const known: Baseline = new Map([[titleRecordKey(4242), { Status: 'watching' }]]);
  const { plan, observed } = blocks({}, { baseline: known, maxRows: 1 });
  assert.equal(plan.insert, null);
  assert.equal(plan.skips.find((skip) => skip.code === 'no-room')?.message.includes('SHEET_MAX_ROWS'), true);
  // What drains a room refusal is the next poll's budget, not any move in the
  // library, so the seasons it held back are counted as work waiting.
  assert.ok(plan.deferred > 0, 'and the poll asks for another');
  assert.equal(observed.get(titleRecordKey(BLOCK_SHOW.id))?.Status, undefined, 'so the title is new again next run');
  assert.equal(observed.get(seasonKey(BLOCK_SHOW.id, 1))?.Watched, undefined);
});

// A hand block "Last Of Us" has to hold "The Last of Us" back: what a false
// match costs is one note, where a missed one costs a duplicate block.
test('a title the tab already holds under a different id is held back', () => {
  const held = gridFixture(namedShow('sev', 'The Severance', { id: 55 }), namedSeason('sevS1', 1, 6, 44000));
  const { index, titles } = blockLibrary();
  const { plan, observed } = planSync(held.grid, index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true } });
  assert.equal(plan.insert, null);
  assert.match(plan.notes.join('\n'), /row 2 already holds that title under id 55/);
  // A final word, so it is recorded: the tab holds the title under an id of its
  // own and no poll changes that.
  assert.equal(observed.get(titleRecordKey(BLOCK_SHOW.id))?.Status, 'watching');
});

test('a title on a block carrying no id at all is skipped, naming the row to link', () => {
  const unlinked = gridFixture(namedShow('sev', 'Severance', { id: null }), namedSeason('sevS1', 1, 6, 44000));
  const { index, titles } = blockLibrary();
  const { plan } = planSync(unlinked.grid, index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true } });
  assert.equal(plan.insert, null);
  const skip = plan.skips.find((s) => s.code === 'unlinked-block');
  assert.match(skip?.message ?? '', /row 2 holds that title and no id; type the id to link it/);
});

// The six are optional on the tab by design — the artwork page parses a Shows
// tab with no Franchise column at all — so an unresolved one declines the
// block rather than failing the parse.
test('a tab missing a column a show row is written into gets one note and no block', () => {
  const headers = SHEET_HEADERS.filter((label) => label !== 'Network');
  const grid = parseGrid(sheetSnapshot([headers, showRow('Fargo', 'Ended', 1), seasonRow(1, 6, 44000)]));
  const { index, titles } = blockLibrary();
  const { plan } = planSync(grid, index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true } });
  assert.equal(plan.insert, null);
  assert.equal(plan.notes.filter((n) => n.includes('a new show block needs Network')).length, 1);
});

// Gating rather than degrading, the films rule: those cells are written once,
// and a blank one reads as a series with no genre rather than an install with
// no key.
test('a run with a credential unset names the key once and adds nothing', () => {
  const { plan, demands } = blocks({ genres: undefined, certificate: undefined }, { facts: { tvdb: false, tmdb: true } });
  assert.equal(plan.insert, null);
  assert.deepEqual(plan.notes, ['1 show(s) have no row; set TVDB_API_KEY to have a block added for them']);
  assert.deepEqual(demands.genres, [], 'nothing is asked of an upstream there is no key for');
});

// The credential gate sits above the SIMKL demand, so a show no block can be
// built for costs no request at all — not one a day, for ever, for a detail
// nothing can use.
test('a show waiting on an unset credential is not even looked up', () => {
  for (const facts of [{ tvdb: false, tmdb: true }, { tvdb: true, tmdb: false }]) {
    const { demands } = blocks({ genres: undefined, certificate: undefined }, { facts });
    assert.deepEqual(demands.catalogue, [], `${JSON.stringify(facts)}: nothing is asked of SIMKL either`);
  }
});

// A rejection is a fact about the token, and both keys are read at start-up:
// no block is settled, nothing further is asked, and the fix arrives with a
// restart.
test('a rejected credential names the key to fix and asks for nothing', () => {
  const { plan, demands } = blocks({ genres: undefined }, { factsRejected: new Set(['tvdb'] as const) });
  assert.equal(plan.insert, null);
  assert.deepEqual(plan.notes, ['1 show(s) need a block and the credential was rejected; fix TVDB_API_KEY and restart']);
  assert.deepEqual(demands.genres, []);
});

// One restart has to fix everything standing in the way: named one at a time,
// the operator corrects a key, restarts, and is told about the other.
test('both credentials rejected are named in one note', () => {
  const { plan } = blocks({ genres: undefined }, { factsRejected: new Set(['tvdb', 'tmdb'] as const) });
  assert.equal(plan.insert, null);
  assert.deepEqual(plan.notes, ['1 show(s) need a block and the credential was rejected; fix TVDB_API_KEY and TMDB_API_KEY and restart']);
});

// Null is SIMKL answering that it holds no id, which no poll changes.
//
// "Once" is what the recording does: withdrawal is the default in this walk, so
// a final word has to put the title back, or the note is said on every poll for
// the life of the sheet and the title stays in scope for a lookup a day.
test('a show SIMKL holds no TVDB or TMDB id for is named once, not waited on', () => {
  const { plan, demands, observed } = blocks({ tvdbId: null, tmdbId: null, genres: undefined, certificate: undefined });
  assert.equal(plan.insert, null);
  assert.match(plan.notes.join('\n'), /has no TVDB or TMDB id, so its block has to be added by hand/);
  assert.deepEqual(demands.genres, []);
  assert.deepEqual(demands.certificates, []);
  assert.equal(observed.get(titleRecordKey(BLOCK_SHOW.id))?.Status, 'watching', 'and recorded, so the next poll is quiet about it');
  assert.equal(observed.get(seasonKey(BLOCK_SHOW.id, 1))?.Watched, '2');
});

// --- placement --------------------------------------------------------------

const placedIn = (tab: ReturnType<typeof gridFixture>, title: string) => {
  const { index, titles } = blockLibrary({ title }, { title });
  return planSync(tab.grid, index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true } }).plan.insert;
};

test('a block lands in Franchise order', () => {
  const tab = gridFixture(
    namedShow('alien', 'Alien', { id: 10 }),
    namedSeason('alienS1', 1, 6, 44000),
    namedShow('zoo', 'Zoo', { id: 20 }),
    namedSeason('zooS1', 1, 6, 44000),
  );
  assert.equal(placedIn(tab, 'Severance')?.row, tab.at.zoo, 'above the first franchise sorting after it');
  assert.equal(placedIn(tab, 'Zulu')?.row, tab.end, 'below everything when nothing sorts after it');
});

// The article has to be a whole word — `Theodore` is not an article away from
// `odore` — and the cell the block is placed by is the one it writes.
test('a block sorts by its title minus a leading article, and says so in its Franchise cell', () => {
  const tab = gridFixture(
    namedShow('alien', 'Alien', { id: 10 }),
    namedSeason('alienS1', 1, 6, 44000),
    namedShow('zoo', 'Zoo', { id: 20 }),
    namedSeason('zooS1', 1, 6, 44000),
  );
  const insert = placedIn(tab, 'The Severance');
  assert.equal(insert?.kind, 'block');
  assert.equal(insert?.row, tab.at.zoo, 'where Severance goes, not where The goes');
  assert.equal(insert?.title, 'The Severance');
  assert.equal(valueOf(insert, tab.at.zoo as number, 'Franchise')?.stringValue, 'Severance');
});

// Within a franchise the tab's order is loose — 15 inversions across 309
// blocks — so no comparison can find a position inside the group, and the new
// block goes after the last one of it.
test('a block sharing a franchise goes after the last block of it', () => {
  const tab = gridFixture(
    namedShow('alien', 'Alien', { id: 10 }),
    namedSeason('alienS1', 1, 6, 44000),
    namedShow('zoo', 'Zoo', { id: 20, franchise: 'Severance' }),
    namedSeason('zooS1', 1, 6, 44000),
  );
  assert.equal(placedIn(tab, 'Severance')?.row, tab.end);
});

// `inheritFromBefore` takes formats from the row above, and the header row's
// render a correct date serial as `46265`.
test('a block that would sort first, under the header, is declined', () => {
  const tab = gridFixture(namedShow('zoo', 'Zoo', { id: 20 }), namedSeason('zooS1', 1, 6, 44000));
  const { index, titles } = blockLibrary();
  const { plan } = planSync(tab.grid, index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true } });
  assert.equal(plan.insert, null);
  assert.match(plan.skips.find((s) => s.code === 'no-format-row')?.message ?? '', /no season row above it to inherit formats from/);
});

// The block-height helper is `OFFSET(<Show cell>, 1, 0, BLOCK_SCAN_ROWS)`, and
// Sheets answers `#REF!` for a window past the last row of the tab — so a block
// landing nearer than that to the end carries five roll-ups that error, and
// VERIFY rolls the write back on every poll until the tab is extended.
test('a block needs the rows its roll-ups scan below it, and is declined without them', () => {
  const { index, titles } = blockLibrary();
  const declaring = (rowCount: number) => ({ ...blockGrid.grid, snapshot: { ...blockGrid.grid.snapshot, rowCount } });
  const plan = (rowCount: number) =>
    planSync(declaring(rowCount), index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true }, showBucket: null }).plan;

  const needed = blockGrid.end + 2 + BLOCK_SCAN_ROWS;
  const tight = plan(needed - 1);
  assert.equal(tight.insert, null);
  assert.match(
    tight.skips.find((s) => s.code === 'no-room')?.message ?? '',
    /declares only \d+ rows and a block's roll-ups read 40 rows below its show row; add rows to the tab/,
  );
  // A skip, not a refusal: a full tab is a standing state until someone
  // extends it, and a guard refusal would stop every edit on every other row.
  assert.equal(plan(needed).insert?.kind, 'block');
});

// A block is placed relative to the blocks already there, so a tab holding
// none has nothing to sort against — and no season row anywhere to inherit
// number formats from either. The first block on a tab is the reader's.
test('a tab with no blocks at all has nothing to place a block against', () => {
  const empty = parseGrid(sheetSnapshot([SHEET_HEADERS]));
  const { index, titles } = blockLibrary();
  const { plan } = planSync(empty, index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true } });
  assert.equal(plan.insert, null);
  assert.match(plan.skips.find((s) => s.code === 'no-format-row')?.message ?? '', /the tab holds no block to place it against/);
});

// `parseGrid` keeps a block open across an all-blank spacer row, and
// `inheritFromBefore` copies the row *immediately* above the insertion point —
// so a season row anywhere above it carries no number format to a row landing
// under the spacer, and a correct date serial renders as `46265`.
test('a season row that would land under a spacer row inside the block is declined', () => {
  const spaced = gridFixture(
    namedShow('fargo', 'Fargo', { status: 'Watching' }),
    namedSeason('fargoS1', 1, 6, 44000),
    namedRaw('spacer', new Array(H.length).fill(null)),
    namedSeason('fargoS3', 3, 4, 44500),
  );
  const index = indexLibrary(
    libraryOf({
      id: 1,
      title: 'Fargo',
      status: 'watching',
      seasons: { 1: [daysAgo(400)], 2: [daysAgo(9), daysAgo(2)], 3: [daysAgo(300)] },
      watched: 4,
      total: 4,
    }),
  );
  const titles = new Map<number, TitleCatalogue>([[1, { shapes: seasonShapes(eps(2, 2)), status: 'ended', runtime: 45, seasonRuntimes: new Map() }]]);

  const { plan } = planSync(spaced.grid, index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true } });
  assert.equal(plan.insert, null);
  assert.match(plan.skips.find((s) => s.code === 'no-format-row')?.message ?? '', /no season row above the insertion point/);
});

// --- one insert per run -----------------------------------------------------

// Plan indices are pre-write and `insertDimension` applies cumulatively, so a
// second insert would land a row high. A season row joining a block that
// already exists is planned in the walk above and wins.
test('a season row for an existing block takes the slot ahead of a new block', () => {
  const tab = gridFixture(
    namedShow('fargo', 'Fargo', { id: 1, status: 'Watching' }),
    namedSeason('fargoS1', 1, 6, 44000),
  );
  const { index, titles } = blockLibrary();
  index.set(1, indexLibrary(libraryOf({ id: 1, title: 'Fargo', status: 'watching', seasons: { 1: watched(6, 400), 2: watched(3) }, watched: 9, total: 9 })).get(1)!);
  titles.set(1, { shapes: seasonShapes([...eps(1, 6), ...eps(2, 3)]), status: 'ended', runtime: 45, tvdbId: 5, tmdbId: 6, seasonRuntimes: new Map([[2, 45]]) });

  const { plan } = planSync(tab.grid, index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true } });
  assert.equal(plan.insert?.kind, 'season');
  assert.equal(plan.deferred, 1);
  assert.match(plan.notes.join('\n'), /Severance \(simkl \d+\): a block waits for the next run/);
});

// The lookups a deferred block needs are the next run's: fetched now, every
// pass to the ceiling would spend another round on rows this run cannot add.
// The gate is the planner's, not the sync's — the block's runtime demand lands
// in the same list as a closing row's, which the sync cannot hold back.
test('a block behind a taken slot demands nothing, not even its season runtime', () => {
  const tab = gridFixture(
    namedShow('fargo', 'Fargo', { id: 1, status: 'Watching' }),
    namedSeason('fargoS1', 1, 6, 44000),
  );
  const { index, titles } = blockLibrary({ genres: undefined, certificate: undefined, seasonRuntimes: new Map() });
  index.set(1, indexLibrary(libraryOf({ id: 1, title: 'Fargo', status: 'watching', seasons: { 1: watched(6, 400), 2: watched(3) }, watched: 9, total: 9 })).get(1)!);
  titles.set(1, { shapes: seasonShapes([...eps(1, 6), ...eps(2, 3)]), status: 'ended', runtime: 45, tvdbId: 5, tmdbId: 6, seasonRuntimes: new Map([[2, 45]]) });

  const { plan, demands } = planSync(tab.grid, index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true } });
  assert.equal(plan.insert?.kind, 'season');
  assert.equal(plan.deferred, 1);
  assert.deepEqual(demands.genres, []);
  assert.deepEqual(demands.certificates, []);
  assert.equal(demands.runtimes.some((request) => request.id === BLOCK_SHOW.id), false, 'the season runtime waits with the block');
});

// Oldest first, so the sheet gains blocks in the order the shows were started
// — and so two runs of the same library choose the same one.
test('two blocks ready at once are ordered by their first watch, and the second is deferred', () => {
  const index = indexLibrary(
    libraryOf(
      { id: 900, title: 'Severance', status: 'watching', seasons: { 1: [daysAgo(9), daysAgo(2)] }, watched: 2, total: 9 },
      { id: 901, title: 'Utopia', status: 'watching', seasons: { 1: [daysAgo(30), daysAgo(3)] }, watched: 2, total: 9 },
    ),
  );
  const titles = new Map<number, TitleCatalogue>([blockFacts(900, 'Severance'), blockFacts(901, 'Utopia')]);

  const { plan } = planSync(blockGrid.grid, index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true } });
  assert.equal(plan.insert?.title, 'Utopia', 'started three weeks earlier');
  assert.equal(plan.deferred, 1);
  assert.match(plan.notes.join('\n'), /Severance \(simkl \d+\): a block waits for the next run/);
});

// One row lands per run, so the comparator decides which title that is. Two
// started the same evening would otherwise be ordered by whatever the library
// map gave, and the pair would swap between polls — each poll adding whichever
// the sort happened to put first.
test('two blocks first watched the same day are ordered by id, whatever order the library gives', () => {
  const item = (id: number, title: string) => ({ id, title, status: 'watching', seasons: { 1: [daysAgo(9), daysAgo(2)] }, watched: 2, total: 9 });
  const titles = new Map<number, TitleCatalogue>([blockFacts(900, 'Severance'), blockFacts(901, 'Utopia')]);

  for (const order of [
    [item(900, 'Severance'), item(901, 'Utopia')],
    [item(901, 'Utopia'), item(900, 'Severance')],
  ]) {
    const { plan } = planSync(blockGrid.grid, indexLibrary(libraryOf(...order)), titles, { timezone: TZ, facts: { tvdb: true, tmdb: true } });
    assert.equal(plan.insert?.title, 'Severance', 'the lower id');
  }
});

// `hold` and `plantowatch` are no information, never a reason to write — so
// the cell is left out rather than guessed at, and stays a reader's to fill.
test('a block for a show on hold carries no Status cell', () => {
  const { plan } = blocks({}, {}, { status: 'hold' });
  assert.equal(plan.insert?.kind, 'block');
  assert.equal(valueOf(plan.insert, blockGrid.end, 'Status'), undefined);
});

// One request per upstream per title, and every title the walk reaches: how
// many of them one pass fetches is the fetch loop's question, so the planner
// asks for all of them and the loop's slice means what it says.
test('the planner asks for every lookup it wants, once per key', () => {
  const ids = Array.from({ length: 12 }, (_, i) => 900 + i);
  const index = indexLibrary(libraryOf(...ids.map((id) => ({ id, title: `Show ${id}`, status: 'watching', seasons: { 1: [daysAgo(9), daysAgo(2)] }, watched: 2, total: 9 }))));
  const titles = new Map<number, TitleCatalogue>(
    ids.map((id) => [
      id,
      // A TVDB id of its own each: a runtime ask is keyed by TVDB season, so
      // two titles sharing one would rightly fold into one ask.
      { ...blockLibrary({ genres: undefined, certificate: undefined, seasonRuntimes: new Map() }).titles.get(900)!, title: `Show ${id}`, tvdbId: id },
    ]),
  );
  const { demands } = planSync(blockGrid.grid, index, titles, { timezone: TZ, facts: { tvdb: true, tmdb: true } });
  assert.equal(demands.genres.length, 12);
  assert.equal(demands.certificates.length, 12);
  assert.equal(demands.runtimes.length, 12);
  assert.equal(demands.catalogue.length, 12, 'a title whose detail is already in hand is still asked for; the loop is what drops it');
  assert.equal(new Set(demands.catalogue.map((r) => r.id)).size, 12, 'and once each');
});

// `rows N-M`, because a block is a show row and a season row and "row 610"
// would name half of what the run did.
test('a block is recorded as the span it occupies', () => {
  const record = planRecord(blocks().plan);
  assert.deepEqual(record.inserts.map((i) => i.address), [`rows ${blockGrid.end + 1}-${blockGrid.end + 2}`]);
  assert.equal(record.inserts[0]?.title, 'Severance');
  assert.equal(record.inserts[0]?.season, 1);
});

/**
 * A block on the grid is edited from the answer to its own catalogue asks in
 * the run that reads it, so every in-scope block is asked for — and counted in
 * **titles**: a live-action block asks twice about one id, for its episode list
 * and for the entry that decides its `Status`, and `demand` folds the two into
 * one entry so the fetch loop's slice of this list is a slice of titles.
 */
test('the grid walk asks about every in-scope block, once per title', () => {
  const ids = Array.from({ length: 18 }, (_, i) => 700 + i);
  const rows = ids.flatMap((id) => [show(`Show ${id}`, 'Watching', id), season(1, 1, null)]);
  const items = ids.map((id) => ({ id, title: `Show ${id}`, status: 'watching', seasons: { 1: watched(3) }, watched: 3, total: 3 }));
  const { grid, index, titles } = scenario({ rows, items });

  const cold = planSync(grid, index, titles, { timezone: TZ });
  assert.deepEqual(cold.demands.catalogue.map((request) => request.id), ids, 'every recent block, once each, in grid order');
  assert.ok(cold.demands.catalogue.every((request) => request.episodes && request.detail), 'with both asks folded into the one entry');
});

