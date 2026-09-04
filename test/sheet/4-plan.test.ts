import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPlanSafe } from '../../src/sheet/5-guard.ts';
import { parseGrid } from '../../src/sheet/2-grid.ts';
import { deriveStatus, observeWatches, planRecord, planSync, statusSource, type SheetPlan } from '../../src/sheet/4-plan.ts';
import { seasonShapes, type TitleCatalogue } from '../../src/sheet/3-catalogue.ts';
import { indexLibrary } from '../../src/sheet/1-index.ts';
import { dateSerial, seasonKey, type Baseline } from '../../src/sheet/values.ts';
import { isoOf, plainDateIn } from '../../src/shared/dates.ts';
import type { EpisodeDetail, ShowDetail } from '../../src/api/simkl/types.ts';
import type { RowInsert } from '../../src/sheet/4-plan.ts';
import { daysAgo, libraryOf, sheetSnapshot, SHEET_HEADERS, todaySerial, type CellSpec, type ItemSpec, seasonRow, showRow } from '../helpers.ts';

const H = SHEET_HEADERS;
const TZ = 'Europe/London';

const show = showRow;
const season = (n: number, episodes: number | null, end: number | null, id: number | string | null = null, status: string | null = null): CellSpec[] =>
  seasonRow(n, episodes, end, { id, status });

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
}

/**
 * A grid, a library, and a partially answered catalogue. A title with no
 * `details` entry is one whose `/tv/{id}` has not answered — the store writes
 * `tvdbId` (number or explicit null) the moment it lands, so absence is what
 * the planner reads as pending.
 */
const scenario = ({ rows, items, episodes = {}, details = {}, tvdbIds = {}, runtimes = {} }: Scenario) => {
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
  const result = (baseline?: Baseline) => planSync(grid, index, titles, { timezone: TZ, baseline });
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
    ['D4', 'Episode', 7],
    ['B4', 'Status', note(seen)],
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
  assert.deepEqual(plan().edits.filter((e) => e.field === 'Episode').map((e) => e.address), ['D5']);
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

const statusEdit = (plan: SheetPlan) => plan.edits.find((e) => e.field === 'Status' && e.row === 2);

// The note moves with the watching, so the same row re-planned after another
// episode says the later date rather than being left alone.
test('a note already in place is advanced, and an identical one is not rewritten', () => {
  const seen = watched(5);
  assert.equal(statusEdit(noting('2019-01-01').plan())?.value?.stringValue, note(seen));
  assert.equal(statusEdit(noting(note(seen)).plan()), undefined, 'nothing to say twice');
});

// `End` says the same thing, more precisely, and a row nothing revisits should
// not keep a running note.
test('the batch that dates a row takes its note away', () => {
  const done = noting('2019-01-01', FINISHED);
  const plan = done.plan();
  assert.ok(plan.edits.some((e) => e.field === 'End'), 'the row closes');
  const cleared = statusEdit(plan);
  // Both halves: `cleared?.value` alone reads the same whether the clear was
  // planned or no Status edit was planned at all.
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
    rows: [show('Silo', 'Watching', 900), seasonRow(1, 3, null, { episodes: null })],
    items: [{ id: 900, status: 'completed', seasons: { 1: seen }, watched: 10, total: 10, notAired: 0 }],
    episodes: { 900: eps(1, 10) },
    // No detail: `/tv/{id}` has not answered, so the close waits.
    details: {},
  });
  const plan = waiting.plan();
  assert.deepEqual(plan.edits.filter((e) => e.field === 'End'), []);
  assert.equal(statusEdit(plan)?.value?.stringValue, note(seen));
});

// `season.status` is the cell's *result*, so a formula rendering a date reads
// as this sync's own note. The guard refuses a formula target unconditionally
// and refusal is whole-plan, so planning over one would stop every unrelated
// edit for as long as the row stays in the window.
test('a formula rendering a date is left alone, and takes nothing else down with it', () => {
  const rendered: CellSpec[] = [null, { formula: '=TEXT(E3,"yyyy-mm-dd")', value: '2019-01-01' }, 1, 1, 45000, null, 0.0153, { formula: '=G3*D3' }, null, null];
  const formula = scenario({
    rows: [show('Silo', 'Watching', 900), rendered],
    items: [{ id: 900, status: 'watching', seasons: { 1: watched(5) }, watched: 5, total: 10, notAired: 5 }],
    episodes: { 900: eps(1, 10, 5) },
    details: { 900: { status: 'airing' } },
  });
  const plan = formula.plan();
  assert.equal(statusEdit(plan), undefined);
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
  const notes = plan.edits.filter((e) => e.field === 'Status' && e.value?.stringValue === note(seen));
  const counts = new Set(plan.edits.filter((e) => e.field === 'Episode').map((e) => e.row));
  assert.equal(notes.length, 3, 'one per row that moved, and none for the three that did not');
  assert.ok(notes.every((n) => counts.has(n.row)));
  assert.doesNotThrow(() => assertPlanSafe(plan, many.grid, { timezone: TZ }));
});

// The column is otherwise free space. What a reader typed there is not
// reconstructible, and the row still closes — around the note, not through it.
test('text the sync did not write is left where it is, closing row included', () => {
  assert.equal(statusEdit(noting('rewatching with Sam').plan()), undefined);
  const closing = noting('rewatching with Sam', FINISHED).plan();
  assert.ok(closing.edits.some((e) => e.field === 'End'), 'the row still closes');
  assert.equal(statusEdit(closing), undefined);
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

const fields = (insert: RowInsert | null): string[] => (insert?.fill ?? []).map((f) => f.field).sort();
const cellIn = (insert: RowInsert | null, field: string) => insert?.fill.find((f) => f.field === field)?.value;

// A blank cell keeps the row eligible for the per-season average later; a
// filled one the runtime rules refuse for ever.
test('a season still running is inserted with a blank Episodes cell, for its close to fill', () => {
  const { plan, runtimeDemands } = adding({ aired: 6 });
  const insert = plan().insert;
  assert.equal(insert?.season, 2);
  assert.deepEqual(fields(insert), ['Episode', 'Length', 'Season', 'Start', 'Status']);
  assert.equal(cellIn(insert, 'Episodes'), undefined, 'left for the season average');
  assert.equal(cellIn(insert, 'End'), undefined, 'and not dated, because it is still running');
  // Stops a settled null landing while SIMKL's episode count is still moving.
  assert.deepEqual(runtimeDemands(), [], 'and nothing is asked about a season still airing');
});

test('a season already over is inserted dated, carrying its own average', () => {
  const insert = adding({ runtimes: { 800: { 2: 49 } } }).plan().insert;
  assert.deepEqual(fields(insert), ['End', 'Episode', 'Episodes', 'Length', 'Season', 'Start']);
  assert.ok(Math.abs((cellIn(insert, 'Episodes')?.numberValue ?? 0) - 49 / 1440) < 1e-9, 'the TVDB average, not the show-wide 43');
  assert.ok((cellIn(insert, 'End')?.numberValue ?? 0) > 0);
});

// Dating the row now would freeze a blank cell. The date is not lost: it
// comes from the watch timestamp.
test('a season over but whose runtimes have not come back is inserted open', () => {
  const { plan } = adding();
  const insert = plan().insert;
  assert.deepEqual(fields(insert), ['Episode', 'Length', 'Season', 'Start', 'Status']);
  assert.equal(cellIn(insert, 'End'), undefined, 'not dated, so the next poll can still fill the cell');
  assert.match(insert?.note ?? '', /have not come back/);
});

// Settled means no number is coming. The show-wide guess beats a cell nothing
// can ever fill again.
test('a settled null closes the new row on SIMKL’s show-wide runtime', () => {
  const insert = adding({ runtimes: { 800: { 2: null } } }).plan().insert;
  assert.deepEqual(fields(insert), ['End', 'Episode', 'Episodes', 'Length', 'Season', 'Start']);
  assert.ok(Math.abs((cellIn(insert, 'Episodes')?.numberValue ?? 0) - 43 / 1440) < 1e-9);
});

// An average no episode could have is treated as the settled null, never a
// refusal: one title's bad upstream data must not cost the row.
test('an implausible average falls back rather than writing 1440 times the truth', () => {
  const insert = adding({ runtimes: { 800: { 2: 5000 } } }).plan().insert;
  assert.ok(Math.abs((cellIn(insert, 'Episodes')?.numberValue ?? 0) - 43 / 1440) < 1e-9);
});

// Without a join key the blank cell could never be filled, so the show-wide
// runtime is the best there will ever be.
test('with no TVDB id the new row keeps SIMKL’s show-wide runtime', () => {
  const { plan, runtimeDemands } = adding({ tvdbIds: {}, aired: 6 });
  const insert = plan().insert;
  assert.ok(Math.abs((cellIn(insert, 'Episodes')?.numberValue ?? 0) - 43 / 1440) < 1e-9);
  assert.deepEqual(runtimeDemands(), []);
});

// `ShowDetail.runtime` is show-wide, so one missing value speaks for every
// season. Refusing the row would withhold the known count, start date and
// season number over one blank cell a reader can fill by hand.
test('a title SIMKL gives no runtime for is added blank rather than refused', () => {
  const { plan } = adding({ tvdbIds: {}, details: { 800: { status: 'airing' } }, aired: 6 });
  const result = plan();
  assert.ok(result.insert, 'the row goes in');
  assert.equal(cellIn(result.insert, 'Episodes'), undefined);
  assert.match(result.insert?.note ?? '', /no episode runtime to fill its Episodes cell/);
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
  assert.deepEqual(fields(insert), ['Episode', 'Episodes', 'Length', 'Season', 'Start', 'Status']);
  assert.ok(Math.abs((cellIn(insert, 'Episodes')?.numberValue ?? 0) - 49 / 1440) < 1e-9, 'the season average, though only one episode is watched');
  assert.equal(cellIn(insert, 'End'), undefined, 'and nowhere near dated');
  assert.deepEqual(started().runtimeDemands(), [{ id: 800, tvdbId: 403245, season: 2 }], 'demanded on the run that adds the row');
  assert.deepEqual(runtimeDemands(), [], 'and not again once answered');
});

// The runtime is not back, so the cell waits — the row is undated for its own
// reason, and the close fills the cell either way.
test('a finished season just started, with no answer yet, is added blank and undated', () => {
  const insert = started().plan().insert;
  assert.deepEqual(fields(insert), ['Episode', 'Length', 'Season', 'Start', 'Status']);
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
  assert.equal(insert?.season, 2, 'the row still goes in');
  assert.equal(cellIn(insert, 'End'), undefined, 'undated, because a runtime may yet be obtainable');
  assert.equal(cellIn(insert, 'Episodes'), undefined);
  assert.match(insert?.note ?? '', /have not come back/);
});

// A dated row is never revisited, so a blank cell on one is blank for good;
// the report is the only place a reader learns to fill it in.
test('a row dated with a cell nothing can fill says so, whatever left it blank', () => {
  const insert = adding({ runtimes: { 800: { 2: null } }, details: { 800: { status: 'ended' } } }).plan().insert;
  assert.ok(cellIn(insert, 'End'), 'dated');
  assert.equal(cellIn(insert, 'Episodes'), undefined, 'and blank for good');
  assert.match(insert?.note ?? '', /no episode runtime to fill its Episodes cell/);
});

/**
 * `assertPlanSafe` refuses whole-plan, so a planner/guard bound disagreement
 * over one sub-minute length would drop every unrelated edit in the run, every
 * poll, for as long as the block stays in scope.
 */
test('a length the guard would refuse is never planned in the first place', () => {
  const { plan, grid } = adding({ tvdbIds: {}, details: { 800: { status: 'airing', runtime: 0.9 } }, aired: 6 });
  const result = plan();
  assert.equal(cellIn(result.insert, 'Episodes'), undefined, 'the cell is skipped rather than filled implausibly');
  assert.doesNotThrow(() => assertPlanSafe(result, grid), 'and the run is not refused whole over one title');
});

// What to fetch and what to write are one computation.
test('the demand names exactly the season the plan inserts', () => {
  const { plan, runtimeDemands } = adding();
  assert.deepEqual(runtimeDemands(), [{ id: 800, tvdbId: 403245, season: 2 }]);
  assert.equal(plan().insert?.season, 2);
});

// A null answer still counts as answered.
test('a season already answered is not demanded again', () => {
  assert.deepEqual(adding({ runtimes: { 800: { 2: null } } }).runtimeDemands(), []);
});

// --- status ----------------------------------------------------------------

test('the status rule runs in order, and says nothing where it knows nothing', () => {
  const base = { id: 1, title: 'X', status: 'watching', lastWatchedAt: null, watchedCount: 10, totalCount: 10, notAiredCount: 0, seasons: new Map() };

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
        { id: 1, title: 'X', status, lastWatchedAt: null, watchedCount: 10, totalCount: 10, notAiredCount: 0, seasons: new Map() },
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
      { id: 1600, title: 'Sousou no Frieren 2nd Season', status: 'watching', seasons: { 1: watched(4) } },
    ],
    details: { 1500: { status: 'ended' } },
  });
  const result = plan();
  assert.equal(result.insert, null);
  assert.match(result.notes.join('\n'), /Sousou no Frieren 2nd Season \(simkl 1600\) has recent activity and no row/);
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
  assert.equal(insert?.season, 11);
  // Row 5 in the UI is the row after S10 — not the show row, where
  // inheritFromBefore picks up the wrong formats.
  assert.equal(insert?.row, 4);
  assert.notEqual(insert?.row, grid.blocks[0]?.row);
  assert.deepEqual(insert?.fill.map((f) => f.field).sort(), ['Episode', 'Episodes', 'Length', 'Season', 'Start', 'Status']);
  assert.equal(insert?.fill.find((f) => f.field === 'Length')?.value?.formulaValue, '=G5*D5');
  assert.ok(Math.abs((insert?.fill.find((f) => f.field === 'Episodes')?.value?.numberValue ?? 0) - 22 / 1440) < 1e-9);
});

test('an inserted row lands where it keeps Season ascending', () => {
  const { plan } = scenario({
    rows: [show('Futurama', 'Up To Date', 3407), season(9, 13, 43000), season(11, 13, 44000)],
    items: [{ id: 3407, status: 'watching', seasons: { 9: watched(13, 900), 10: watched(6), 11: watched(13, 400) }, watched: 32, total: 32 }],
    episodes: { 3407: [...eps(9, 13), ...eps(10, 13), ...eps(11, 13)] },
    details: { 3407: { status: 'ended', runtime: 22 } },
  });
  const insert = plan().insert;
  assert.equal(insert?.season, 10);
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
// store's job. The demand set only has to name the titles the plan runs on.
test('an eligible block demands its episode list and detail every pass', () => {
  const { demands } = scenario({
    rows: [show('Fargo', 'Watching', 1), season(1, 1, null)],
    items: [{ id: 1, status: 'watching', seasons: { 1: watched(5) } }],
    episodes: { 1: eps(1, 10) },
    details: { 1: { status: 'airing' } },
  });
  // Already answered, and still demanded — the store filters, not the planner.
  assert.deepEqual(demands().catalogue, [
    { id: 1, episodes: true, detail: true },
    { id: 1, anime: false, detail: true },
  ]);
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
  assert.equal(first.insert?.season, 11);

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
  assert.equal(second.insert?.season, 2);

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
  assert.equal(result.deferredInserts, 1);
  assert.equal(twoNewSeasons([...before.slice(0, 2)]).plan().deferredInserts, 0, 'nothing deferred when it fits');
});

// The projection behind the status page's history; it outlives the run, so
// what it drops is dropped for good.
test('planRecord keeps where and what changed, and drops the diagnostics', () => {
  const plan: SheetPlan = {
    edits: [
      { row: 8, column: 3, field: 'Episode', previous: { numberValue: 3 }, value: { numberValue: 5 }, address: 'D9', note: 'Fargo S2: 3 -> 5 episodes' },
    ],
    insert: { row: 609, title: 'Fargo', season: 3, fill: [], note: 'Fargo: new season row at 610, 4 episodes' },
    skips: [{ code: 'duplicate-season', message: 'Severance S1: two rows claim season 1' }],
    notes: ['Andor: not on the sheet'],
    deferredInserts: 2,
  };

  assert.deepEqual(planRecord(plan), {
    edits: [{ address: 'D9', field: 'Episode', note: 'Fargo S2: 3 -> 5 episodes' }],
    // An insert has no single cell, so it points at the row it created.
    inserts: [{ address: 'row 610', title: 'Fargo', season: 3, note: 'Fargo: new season row at 610, 4 episodes' }],
  });
});

// `skips` and `notes` answer "why was this row left alone" — a per-show
// diagnostic the status page deliberately does not carry, in a file that
// survives restarts.
test('planRecord carries no skip or note lines', () => {
  const record = planRecord({ edits: [], insert: null, skips: [{ code: 'unknown-id', message: 'a skip' }], notes: ['a note'], deferredInserts: 1 });
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
      [null, null, 1, '12 (rewatch)', 44000, null, 0.0153, { formula: '=G3*D3' }, null, null],
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
      [null, null, 1, '12 (rewatch)', 44000, null, 0.0153, { formula: '=G3*D3' }, null, null],
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
    rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { episodes: null })],
    items: [{ id: 800, status: 'watching', seasons: { 1: watched(10) }, watched: 10, total: 10 }],
    episodes: { 800: eps(1, 10) },
    details: { 800: { status: 'ended', runtime: 43 } },
    tvdbIds: { 800: 403245 },
    ...over,
  });

const has = (plan: SheetPlan, field: string) => plan.edits.some((e) => e.field === field);
/** Closed with no runtime: the End landed and the Episodes cell was left alone. */
const closedBare = (plan: SheetPlan) => {
  assert.ok(has(plan, 'End'), 'the season is dated');
  assert.equal(has(plan, 'Episodes'), false, 'and carries no runtime');
};

test('a season closing with a blank runtime cell gets its average, in the same batch', () => {
  const plan = closing({ runtimes: { 800: { 1: 49 } } }).plan();
  const episodes = plan.edits.find((e) => e.field === 'Episodes');
  const end = plan.edits.find((e) => e.field === 'End');
  assert.ok(end, 'the season still closes');
  assert.ok(episodes, 'and carries its runtime');
  assert.equal(episodes.row, end.row, 'onto the row that is closing');
  // 49 minutes as the day fraction the Episodes column holds.
  assert.equal(episodes.value?.numberValue, 49 / 1440);
  assert.match(episodes.note, /49 min average/);
});

// A hand-typed runtime is a deliberate correction, and the row freezes when
// End lands — so an overwrite could never be undone.
test('a runtime already in the cell is never overwritten', () => {
  const plan = closing({
    rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { episodes: 0.0299 })],
    runtimes: { 800: { 1: 49 } },
  }).plan();
  assert.ok(plan.edits.some((e) => e.field === 'End'));
  assert.deepEqual(plan.edits.filter((e) => e.field === 'Episodes'), []);
});

// End is a one-way door: closing before the answer arrives forfeits the cell
// for good. The serial comes from the watch timestamp, so waiting is free.
test('a runtime still outstanding holds the End write rather than closing blind', () => {
  const plan = closing().plan();
  assert.equal(has(plan, 'End'), false, 'the row stays open');
  assert.equal(has(plan, 'Episodes'), false);
  const skip = plan.skips.find((s) => s.code === 'awaiting-runtimes');
  assert.match(skip?.message ?? '', /have not come back/);
});

// Settled means no season average is coming. The batch dates the row either
// way, so the choice is an approximate number or a cell nothing can ever fill
// again — and it cannot turn on which run created the row.
test('a settled null closes the season on the show-wide runtime', () => {
  const plan = closing({ runtimes: { 800: { 1: null } } }).plan();
  assert.ok(has(plan, 'End'), 'the season is dated');
  const cell = plan.edits.find((e) => e.field === 'Episodes');
  assert.ok(Math.abs((cell?.value?.numberValue ?? 0) - 43 / 1440) < 1e-9, 'and carries the show-wide length');
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
  const cell = plan.edits.find((e) => e.field === 'Episodes');
  assert.ok(Math.abs((cell?.value?.numberValue ?? 0) - 43 / 1440) < 1e-9, 'and carries the show-wide length');
  assert.deepEqual(plan.skips, [], 'never held open — no answer is coming');
  assert.deepEqual(bare.runtimeDemands(), [], 'and nothing is asked of TVDB');
});

// The invariant the fallback exists for. A cell must not depend on whether
// this run created the row or closed one already there, or two
// identical-looking rows differ for a reason no reader of the sheet could see.
test('a season with no tvdb id gets the same cell closed as it would inserted', () => {
  const closed = closing({ tvdbIds: {} }).plan().edits.find((e) => e.field === 'Episodes')?.value?.numberValue;
  const inserted = adding({ tvdbIds: {}, aired: 6 }).plan().insert?.fill.find((f) => f.field === 'Episodes')?.value?.numberValue;
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
  assert.deepEqual(closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { episodes: 0.03 })] }).runtimeDemands(), [], 'cell filled');
  assert.deepEqual(closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 10, 44000, { episodes: null })] }).runtimeDemands(), [], 'already dated');
});

// A SIMKL anime record numbers every cour "season 1" and all cours of a
// franchise share one TVDB id, so the row's season number means nothing there.
test('an anime block is never demanded, however its ids are arranged', () => {
  const anime = (type: string, showId: number | null, rowId: number | null) =>
    scenario({
      rows: [showRow('Frieren', 'Watching', showId, type), seasonRow(1, 27, null, { id: rowId, episodes: null })],
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
    rows: [show('Doctor Who', 'Watching', 810), seasonRow(14, 8, null, { id: 811, episodes: null })],
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
  const half = closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, 44000), seasonRow(1.5, 9, null, { episodes: null })] });
  assert.deepEqual(half.runtimeDemands(), []);
});

// A row treated as waiting whose lookup is never requested defers for ever.
// Plan and demands come out of one pass; the invariant is asserted over every
// closing shape.
test('every row the plan waits on is a season the same pass demanded', () => {
  const cases = [
    closing(),
    closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { episodes: null }), seasonRow(2, 3, null, { episodes: null })] }),
    closing({ items: [{ id: 800, status: 'completed', seasons: { 1: watched(10) }, watched: 10, total: 10 }] }),
    closing({ details: { 800: { status: 'airing', runtime: 43 } } }),
    closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { episodes: null }), seasonRow(1, 4, null, { episodes: null })] }),
    closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { episodes: null })], runtimes: { 800: { 2: 40 } } }),
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

  assert.deepEqual(seed.get(seasonKey(300, 1)), { Start: one[0], End: one.at(-1) });
  assert.deepEqual(seed.get(seasonKey(300, 2)), { Start: two[0], End: two.at(-1) });
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
  formulaEnd[5] = { formula: '=TODAY()', value: TODAY_SERIAL };
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
  assert.match(skipMessages(plan), /End date would leave the row starting after it ended/);
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
