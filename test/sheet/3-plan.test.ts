import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPlanSafe } from '../../src/sheet/4-guard.ts';
import { parseGrid } from '../../src/sheet/2-grid.ts';
import { deriveStatus, needsLookup, planLookups, planRecord, planRuntimeLookups, planSync, statusSource, type CatalogueView, type SheetPlan, type TitleCatalogue } from '../../src/sheet/3-plan.ts';
import { dateSerial, indexLibrary, seasonShapes } from '../../src/sheet/1-progress.ts';
import { plainDateIn } from '../../src/shared/dates.ts';
import type { EpisodeDetail, ShowDetail } from '../../src/api/simkl/types.ts';
import type { RowInsert } from '../../src/sheet/3-plan.ts';
import { daysAgo, libraryOf, sheetSnapshot, SHEET_HEADERS, type CellSpec, type ItemSpec, seasonRow, showRow } from '../helpers.ts';

const H = SHEET_HEADERS;
const TZ = 'Europe/London';
const DAY = Temporal.Duration.from({ hours: 24 });

const show = showRow;
const season = (n: number, episodes: number | null, end: number | null, id: number | string | null = null): CellSpec[] =>
  seasonRow(n, episodes, end, { id });

/** `n` episodes of which `aired` have aired, all in one season. */
const eps = (number: number, total: number, aired = total): EpisodeDetail[] =>
  Array.from({ length: total }, (_, i) => ({ season: number, episode: i + 1, type: 'episode', aired: i < aired }));

const watched = (count: number, days = 3): string[] => Array.from({ length: count }, (_, i) => daysAgo(days + count - i));

interface Scenario {
  rows: CellSpec[][];
  items: ItemSpec[];
  episodes?: Record<number, EpisodeDetail[]>;
  details?: Record<number, ShowDetail>;
  failed?: number[];
  /** SIMKL id -> TVDB id, as the detail lookup would have folded it in. */
  tvdbIds?: Record<number, number>;
  /** SIMKL id -> season -> average minutes, or null for "asked, nothing usable". */
  runtimes?: Record<number, Record<number, number | null>>;
}

const scenario = ({ rows, items, episodes = {}, details = {}, failed = [], tvdbIds = {}, runtimes = {} }: Scenario) => {
  const grid = parseGrid(sheetSnapshot([H, ...rows]));
  const index = indexLibrary(libraryOf(...items));
  const titles = new Map<number, TitleCatalogue>();
  const entry = (id: number) => titles.get(id) ?? titles.set(id, { shapes: new Map(), seasonRuntimes: new Map() }).get(id)!;
  for (const [id, list] of Object.entries(episodes)) entry(Number(id)).shapes = seasonShapes(list);
  for (const [id, detail] of Object.entries(details)) Object.assign(entry(Number(id)), detail);
  for (const [id, tvdbId] of Object.entries(tvdbIds)) entry(Number(id)).tvdbId = tvdbId;
  for (const [id, seasons] of Object.entries(runtimes)) {
    for (const [n, minutes] of Object.entries(seasons)) entry(Number(id)).seasonRuntimes.set(Number(n), minutes);
  }
  const catalogue: CatalogueView = { titles, failed, unavailable: [] };
  return {
    grid,
    index,
    catalogue,
    plan: () => planSync(grid, index, catalogue, { timezone: TZ }),
    lookups: () => planRuntimeLookups(grid, index, catalogue),
  };
};

// --- the core case ---------------------------------------------------------

// The first run's single largest edit, and the shape of nearly every edit: a
// count advancing on an open season, with nothing at all on the show row.
test('a part-watched open season advances its count and touches nothing else', () => {
  const { plan } = scenario({
    rows: [show('Malcolm in the Middle', 'Watching', 100), season(6, 22, 44000), season(7, 1, null)],
    items: [{ id: 100, status: 'completed', seasons: { 6: watched(22, 400), 7: watched(7) }, watched: 29, total: 44 }],
    episodes: { 100: [...eps(6, 22), ...eps(7, 22)] },
    details: { 100: { status: 'ended', runtime: 22 } },
  });
  const result = plan();
  assert.deepEqual(result.edits.map((e) => [e.address, e.field, e.value.numberValue ?? e.value.stringValue]), [['D4', 'Episode', 7]]);
  assert.equal(result.inserts.length, 0);
});

// The whole sheet is derived from formulas on the show row; the sync must never
// write one, so a run that produces any show-row edit but Status is a bug.
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

// The rule applies uniformly, with no exemptions. A dormant sheet produces zero
// edits, and no run can retro-edit years of history.
test('a show with no recent activity produces nothing at all, show row included', () => {
  const { plan } = scenario({
    rows: [show('The Sandman', 'Ended', 200), season(2, 1, null)],
    items: [{ id: 200, status: 'completed', seasons: { 2: watched(11, 400) }, watched: 11, total: 11 }],
    episodes: { 200: eps(2, 11) },
    details: { 200: { status: 'ended' } },
  });
  const result = plan();
  assert.deepEqual(result.edits, []);
  assert.deepEqual(result.inserts, []);
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

// Silo S3: 7 aired of 10, all watched. The naive "every aired episode watched"
// test stamps a permanent end date on a season with three episodes to come.
test('a season still airing is never dated, however much of it has been watched', () => {
  const { plan } = scenario({
    rows: [show('Silo', 'Watching', 300), season(2, 10, 44000), season(3, 3, null)],
    items: [{ id: 300, status: 'watching', seasons: { 2: watched(10, 400), 3: watched(7) }, watched: 17, total: 20, notAired: 3 }],
    episodes: { 300: [...eps(2, 10), ...eps(3, 10, 7)] },
    details: { 300: { status: 'airing' } },
  });
  const result = plan();
  assert.deepEqual(result.edits.filter((e) => e.field === 'End'), []);
  assert.deepEqual(result.edits.filter((e) => e.field === 'Episode').map((e) => e.value.numberValue), [7]);
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
  assert.equal(end?.value.numberValue, dateSerial(plainDateIn(Temporal.Instant.from(last), TZ)));
});

// A dated season is closed by the user's decision — which is also why a wrongly
// stamped date could never be corrected, and why `End` is so conservative.
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
 * One block, one uncovered season, and every knob the runtime decision reads.
 * `aired` short of `total` is what makes the season still be running, which is
 * the difference between the blank cell and the filled one.
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

const fields = (insert: RowInsert | undefined): string[] => (insert?.fill ?? []).map((f) => f.field).sort();
const cellIn = (insert: RowInsert | undefined, field: string) => insert?.fill.find((f) => f.field === field)?.value;

// The headline. A blank cell is what makes the row eligible for the per-season
// average later; a filled one is refused by `runtimeTarget` for ever.
test('a season still running is inserted with a blank Episodes cell, for its close to fill', () => {
  const { plan, lookups } = adding({ aired: 6 });
  const [insert] = plan().inserts;
  assert.equal(insert?.season, 2);
  assert.deepEqual(fields(insert), ['Episode', 'Length', 'Season', 'Start']);
  assert.equal(cellIn(insert, 'Episodes'), undefined, 'left for the season average');
  assert.equal(cellIn(insert, 'End'), undefined, 'and not dated, because it is still running');
  // The gate that stops a settled null being recorded for a season whose SIMKL
  // episode count has not finished moving.
  assert.deepEqual(lookups(), [], 'and nothing is asked about a season still airing');
});

test('a season already over is inserted dated, carrying its own average', () => {
  const [insert] = adding({ runtimes: { 800: { 2: 49 } } }).plan().inserts;
  assert.deepEqual(fields(insert), ['End', 'Episode', 'Episodes', 'Length', 'Season', 'Start']);
  assert.ok(Math.abs((cellIn(insert, 'Episodes')?.numberValue ?? 0) - 49 / 1440) < 1e-9, 'the TVDB average, not the show-wide 43');
  assert.ok((cellIn(insert, 'End')?.numberValue ?? 0) > 0);
});

// The row is created and dated by one fill, so dating it now would freeze a
// blank cell. The date is not lost: it comes from the watch timestamp.
test('a season over but whose runtimes have not come back is inserted open', () => {
  const { plan } = adding();
  const [insert] = plan().inserts;
  assert.deepEqual(fields(insert), ['Episode', 'Length', 'Season', 'Start']);
  assert.equal(cellIn(insert, 'End'), undefined, 'not dated, so the next poll can still fill the cell');
  assert.match(insert?.note ?? '', /have not come back/);
});

// Settled means no number is coming. The show-wide guess is worse than the
// season's own average and better than a cell nothing can ever fill again.
test('a settled null closes the new row on SIMKL’s show-wide runtime', () => {
  const [insert] = adding({ runtimes: { 800: { 2: null } } }).plan().inserts;
  assert.deepEqual(fields(insert), ['End', 'Episode', 'Episodes', 'Length', 'Season', 'Start']);
  assert.ok(Math.abs((cellIn(insert, 'Episodes')?.numberValue ?? 0) - 43 / 1440) < 1e-9);
});

// An average no episode could have. Treated as the settled null above, never as
// a refusal: one title's bad upstream data must not cost the row.
test('an implausible average falls back rather than writing 1440 times the truth', () => {
  const [insert] = adding({ runtimes: { 800: { 2: 5000 } } }).plan().inserts;
  assert.ok(Math.abs((cellIn(insert, 'Episodes')?.numberValue ?? 0) - 43 / 1440) < 1e-9);
});

// The inert path. Without a join key a blank cell could never be filled by
// anything, so the show-wide runtime is the best there will ever be.
test('with no TVDB id the new row keeps SIMKL’s show-wide runtime', () => {
  const { plan, lookups } = adding({ tvdbIds: {}, aired: 6 });
  const [insert] = plan().inserts;
  assert.ok(Math.abs((cellIn(insert, 'Episodes')?.numberValue ?? 0) - 43 / 1440) < 1e-9);
  assert.deepEqual(lookups(), []);
});

// The refusal this replaced named no action and repeated every poll for ever.
// A row with a cell to fill by hand is worth more than no row at all.
test('a title SIMKL gives no runtime for is added blank rather than refused', () => {
  const { plan } = adding({ tvdbIds: {}, details: { 800: { status: 'airing' } }, aired: 6 });
  const { inserts, skipped } = plan();
  assert.equal(inserts.length, 1, 'the row goes in');
  assert.equal(cellIn(inserts[0], 'Episodes'), undefined);
  assert.match(inserts[0]?.note ?? '', /no episode runtime from SIMKL/);
  assert.deepEqual(skipped.filter((s) => /episode runtime/.test(s)), [], 'and nothing is refused for it');
});

// The two passes agreeing, asserted directly: the season asked about before the
// fetch is the season the plan then inserts.
test('the lookup asks about exactly the season the plan inserts', () => {
  const { plan, lookups } = adding();
  assert.deepEqual(lookups(), [{ id: 800, tvdbId: 403245, season: 2 }]);
  assert.equal(plan().inserts[0]?.season, 2);
});

// Once answered the question is settled, including when the answer was null.
test('a season already answered is not asked about again', () => {
  assert.deepEqual(adding({ runtimes: { 800: { 2: null } } }).lookups(), []);
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

  // hold, plantowatch and absent-from-every-list are all *no information*,
  // never a reason to write.
  assert.equal(deriveStatus({ ...base, status: 'hold' }, { detailStatus: 'ended' }), null);
  assert.equal(deriveStatus({ ...base, status: 'plantowatch' }, { detailStatus: 'ended' }), null);
  assert.equal(deriveStatus(base, {}), null);
});

// SIMKL cannot tell "axed" from "ended", so Cancelled is never produced — but
// it is freely overwritten once there is recent activity.
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
  assert.deepEqual(plan().edits.map((e) => [e.field, e.value.stringValue]), [['Status', 'Ended']]);
});

// Branch 1 reads item.status. A show the sheet already calls Ended, still being
// watched, must not be rewritten to Abandoned.
test('Abandoned comes from the item status', () => {
  const grid = parseGrid(sheetSnapshot([H, show('Beef', 'Ended', 700), season(1, 10, 44000)]));
  const index = indexLibrary(libraryOf({ id: 700, status: 'watching', seasons: { 1: watched(10) } }));
  // Real shapes, or the fail-closed rule below would make this pass vacuously.
  const titles = new Map([[700, { shapes: seasonShapes(eps(1, 10)), status: 'ended', seasonRuntimes: new Map() }]]);
  const plan = planSync(grid, index, { titles, failed: [], unavailable: [] }, { timezone: TZ });
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
  assert.match(result.skipped.join('\n'), /SIMKL id 12345 is in no list/);
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

test("a split cour's count is summed across every id", () => {
  const episode = splitCour().plan().edits.find((e) => e.field === 'Episode');
  assert.equal(episode?.value.numberValue, 26);
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
  assert.match(result.skipped.join('\n'), /SIMKL id 581835 is in no list/);
});

// --- anime -----------------------------------------------------------------

test('an anime cour is completed on its own counters, with no episode lookup', () => {
  const { plan, grid, index } = scenario({
    rows: [show('Frieren', 'Watching', null, 'anime'), season(1, 2, null, 1500)],
    items: [{ id: 1500, status: 'completed', seasons: { 1: watched(11) }, watched: 11, total: 11 }],
    details: { 1500: { status: 'ended' } },
  });
  const result = plan();
  assert.deepEqual(result.edits.map((e) => e.field).sort(), ['End', 'Episode', 'Status']);
  // No /tv/episodes lookup is asked for: one anime entry is one cour.
  assert.deepEqual(planLookups(grid, index).filter((r) => r.episodes), []);
});

// A new cour is a separate SIMKL title with its own romaji name; attributing it
// to a block needs the fuzzy matching that took 24 hand-written overrides.
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
  assert.deepEqual(result.inserts, []);
  assert.match(result.notes.join('\n'), /Sousou no Frieren 2nd Season \(simkl 1600\) has recent activity and no row/);
});

// A cour entry stands for exactly one season. One reporting several means the
// row and the entry are not the same thing, and no rule here says which.
test('a season row whose own id spans several seasons is refused as ambiguous', () => {
  const { plan } = scenario({
    rows: [show('Doctor Who', 'Ended', null), season(14, 1, null, 2463827)],
    items: [{ id: 2463827, status: 'watching', seasons: { 1: watched(8), 2: watched(8) }, watched: 16, total: 16 }],
  });
  assert.match(plan().skipped.join('\n'), /covers 2 seasons, so the row is ambiguous/);
});

// --- insertion -------------------------------------------------------------

test('a newly started season is inserted after the last season row, not at the show row', () => {
  const { plan, grid } = scenario({
    rows: [show('Futurama', 'Up To Date', 3407), season(9, 13, 43000), season(10, 13, 44000)],
    items: [{ id: 3407, status: 'watching', seasons: { 9: watched(13, 900), 10: watched(13, 400), 11: watched(6) }, watched: 32, total: 36, notAired: 4 }],
    episodes: { 3407: [...eps(9, 13), ...eps(10, 13), ...eps(11, 10, 6)] },
    details: { 3407: { status: 'airing', runtime: 22 } },
  });
  const [insert] = plan().inserts;
  assert.equal(insert?.season, 11);
  // Row 5 in the UI is the row after S10 — not the show row, where
  // inheritFromBefore would pick up the wrong formats.
  assert.equal(insert?.row, 4);
  assert.notEqual(insert?.row, grid.blocks[0]?.row);
  assert.deepEqual(insert?.fill.map((f) => f.field).sort(), ['Episode', 'Episodes', 'Length', 'Season', 'Start']);
  assert.equal(insert?.fill.find((f) => f.field === 'Length')?.value.formulaValue, '=G5*D5');
  assert.ok(Math.abs((insert?.fill.find((f) => f.field === 'Episodes')?.value.numberValue ?? 0) - 22 / 1440) < 1e-9);
});

test('an inserted row lands where it keeps Season ascending', () => {
  const { plan } = scenario({
    rows: [show('Futurama', 'Up To Date', 3407), season(9, 13, 43000), season(11, 13, 44000)],
    items: [{ id: 3407, status: 'watching', seasons: { 9: watched(13, 900), 10: watched(6), 11: watched(13, 400) }, watched: 32, total: 32 }],
    episodes: { 3407: [...eps(9, 13), ...eps(10, 13), ...eps(11, 13)] },
    details: { 3407: { status: 'ended', runtime: 22 } },
  });
  const [insert] = plan().inserts;
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
  assert.deepEqual(result.inserts, []);
  assert.match(result.skipped.join('\n'), /no season row above the insertion point/);
});

// Anime is refused because a new cour is a separate title; specials because a
// fractional label encodes a judgement no rule here reproduces.
test('anime blocks are never inserted into', () => {
  const { plan } = scenario({
    rows: [show('Frieren', 'Watching', null, 'anime'), season(1, 11, 44000, 1500)],
    items: [{ id: 1500, status: 'watching', seasons: { 1: watched(11, 3), 2: watched(4) }, watched: 15, total: 15 }],
    details: { 1500: { status: 'airing', runtime: 24 } },
  });
  assert.deepEqual(plan().inserts, []);
});

test('SIMKL season 0 is never inserted — specials are maintained by hand', () => {
  const { plan } = scenario({
    rows: [show('Futurama', 'Up To Date', 3407), season(10, 13, 44000)],
    items: [{ id: 3407, status: 'watching', seasons: { 0: watched(3), 10: watched(13, 400) }, watched: 13, total: 13 }],
    episodes: { 3407: eps(10, 13) },
    details: { 3407: { status: 'ended', runtime: 22 } },
  });
  assert.deepEqual(plan().inserts, []);
});

// --- idempotence -----------------------------------------------------------

// The job re-plans the whole sheet every run, so the second run over an applied
// result is the cheapest proof it converges.
test('running again over the applied result produces nothing', () => {
  const items: ItemSpec[] = [{ id: 100, status: 'completed', seasons: { 7: watched(7) }, watched: 7, total: 22, notAired: 0 }];
  const before = scenario({
    rows: [show('Malcolm in the Middle', 'Watching', 100), season(6, 22, 44000), season(7, 1, null)],
    items,
    episodes: { 100: [...eps(6, 22), ...eps(7, 22)] },
    details: { 100: { status: 'ended', runtime: 22 } },
  });
  assert.equal(before.plan().edits.length, 1);

  const after = scenario({
    rows: [show('Malcolm in the Middle', 'Watching', 100), season(6, 22, 44000), season(7, 7, null)],
    items,
    episodes: { 100: [...eps(6, 22), ...eps(7, 22)] },
    details: { 100: { status: 'ended', runtime: 22 } },
  });
  assert.deepEqual(after.plan().edits, []);
});

// --- lookups ---------------------------------------------------------------

// The cut-off is what keeps this at roughly 28 calls rather than 600.
test('only eligible blocks are looked up', () => {
  const { grid, index } = scenario({
    rows: [show('Recent', 'Watching', 1), season(1, 1, null), show('Dormant', 'Ended', 2), season(1, 10, 44000)],
    items: [
      { id: 1, status: 'watching', seasons: { 1: watched(5) } },
      { id: 2, status: 'completed', seasons: { 1: watched(10, 500) } },
    ],
  });
  assert.deepEqual([...new Set(planLookups(grid, index).map((r) => r.id))], [1]);
});

// A row the planner declined to read is still a row. Inserting a second one for
// the same season is the one insert mistake nothing downstream could detect —
// the guard sees a well-formed insert into the right block.
test('a season row that failed to resolve still blocks an insert for that season', () => {
  const { plan } = scenario({
    // S11 has an id of its own that resolves to nothing, so the row is skipped.
    rows: [show('Futurama', 'Up To Date', 3407), season(10, 13, 44000), season(11, 1, null, 999999)],
    items: [{ id: 3407, status: 'watching', seasons: { 10: watched(13, 400), 11: watched(6) }, watched: 19, total: 19 }],
    episodes: { 3407: [...eps(10, 13), ...eps(11, 10, 6)] },
    details: { 3407: { status: 'airing', runtime: 22 } },
  });
  const result = plan();
  assert.deepEqual(result.inserts, []);
  assert.match(result.skipped.join('\n'), /SIMKL id 999999 is in no list/);
});

// --- lookup gating ---------------------------------------------------------

// /sync/activities resolves to the list and never to the title, so without a
// per-title gate watching one episode re-reads the catalogue of every eligible
// show. This is what keeps a warm run at ~2 calls rather than ~28.
test('a title whose watch time has not moved is not looked up again', () => {
  const { grid, index } = scenario({
    rows: [show('Fargo', 'Watching', 1), season(1, 1, null), show('Silo', 'Watching', 2), season(1, 1, null)],
    items: [
      { id: 1, status: 'watching', seasons: { 1: watched(5) } },
      { id: 2, status: 'watching', seasons: { 1: watched(5) } },
    ],
  });

  const cold = planLookups(grid, index);
  assert.deepEqual([...new Set(cold.map((r) => r.id))], [1, 2], 'a cold process reads everything eligible');

  const at = Temporal.Now.instant();
  const stamps = new Map(cold.map((r) => [r.id, { watchedAt: index.get(r.id)?.lastWatchedAt ?? null, at }]));
  assert.deepEqual(planLookups(grid, index, { stamps, maxAge: DAY }), [], 'nothing moved, nothing re-read');

  // Only the title that moved.
  stamps.set(1, { watchedAt: Temporal.Instant.from('1999-01-01T00:00:00Z'), at });
  assert.deepEqual([...new Set(planLookups(grid, index, { stamps, maxAge: DAY }).map((r) => r.id))], [1]);
});

// The backstop for the case watch activity cannot catch: /tv/{id} status
// flipping on a renewal, which produces nothing in the library to gate on.
test('a stamp past its age ceiling is re-read even with no activity', () => {
  const { grid, index } = scenario({
    rows: [show('Fargo', 'Watching', 1), season(1, 1, null)],
    items: [{ id: 1, status: 'watching', seasons: { 1: watched(5) } }],
  });
  const unchanged = { watchedAt: index.get(1)?.lastWatchedAt ?? null };

  const fresh = new Map([[1, { ...unchanged, at: Temporal.Now.instant().subtract({ hours: 12 }) }]]);
  assert.deepEqual(planLookups(grid, index, { stamps: fresh, maxAge: DAY }), []);

  const old = new Map([[1, { ...unchanged, at: Temporal.Now.instant().subtract({ hours: 48 }) }]]);
  assert.equal(planLookups(grid, index, { stamps: old, maxAge: DAY }).length > 0, true);
});

test('the cut-off still wins over a stamp — an ineligible title is never read', () => {
  const { grid, index } = scenario({
    rows: [show('Dormant', 'Ended', 1), season(1, 10, 44000)],
    items: [{ id: 1, status: 'completed', seasons: { 1: watched(10, 500) } }],
  });
  assert.deepEqual(planLookups(grid, index, { stamps: new Map(), maxAge: DAY }), []);
});

test('needsLookup reads unstamped, moved and aged as due, and nothing else', () => {
  const progress = indexLibrary(libraryOf({ id: 1, lastWatchedAt: '2026-08-01T00:00:00Z' })).get(1);
  const now = Temporal.Now.instant();
  assert.equal(needsLookup(undefined, progress, now, DAY), true, 'never read');
  assert.equal(needsLookup({ watchedAt: Temporal.Instant.from('2026-08-01T00:00:00Z'), at: now }, progress, now, DAY), false);
  assert.equal(needsLookup({ watchedAt: Temporal.Instant.from('2026-07-01T00:00:00Z'), at: now }, progress, now, DAY), true, 'moved');
  assert.equal(needsLookup({ watchedAt: Temporal.Instant.from('2026-08-01T00:00:00Z'), at: now.subtract({ hours: 48 }) }, progress, now, DAY), true, 'aged');
  // A title that has dropped out of the library entirely still compares.
  assert.equal(needsLookup({ watchedAt: null, at: now }, undefined, now, DAY), false);
});

// A live-action block with no episode shapes is a *failed lookup*, not a cour.
// Reading it as one answers with `notAiredCount`, which spans the whole show
// rather than the latest season — so Status fails closed the way End already
// does, and the run's `retry` flag brings it back next poll.
test('a live-action show whose episode list did not arrive gets no Status', () => {
  const { plan } = scenario({
    rows: [show('Silo', 'Ended', 300), season(1, 1, null)],
    items: [{ id: 300, status: 'watching', seasons: { 1: watched(10) }, watched: 10, total: 10, notAired: 0 }],
    // No `episodes` entry: the /tv/episodes lookup failed.
    details: { 300: { status: 'ended' } },
    failed: [300],
  });
  const result = plan();
  assert.deepEqual(result.edits.filter((e) => e.field === 'Status'), []);
  assert.match(result.skipped.join('\n'), /Silo: no episode list came back, so Status is left alone/);

  // With the list present the same inputs do produce it, so the guard above is
  // the missing data and not something else.
  const withList = scenario({
    rows: [show('Silo', 'Ended', 300), season(1, 1, null)],
    items: [{ id: 300, status: 'watching', seasons: { 1: watched(10) }, watched: 10, total: 10, notAired: 0 }],
    episodes: { 300: eps(1, 10) },
    details: { 300: { status: 'airing' } },
  });
  assert.deepEqual(withList.plan().edits.filter((e) => e.field === 'Status').map((e) => e.value.stringValue), ['Up To Date']);
});

// Anime legitimately has no episode list — one entry is one cour — so it must
// keep deriving Status from its own not-aired counter.
test('an anime block still gets a Status without any episode list', () => {
  const { plan } = scenario({
    rows: [show('Frieren', 'Watching', null, 'anime'), season(1, 11, 44000, 1500)],
    items: [{ id: 1500, status: 'completed', seasons: { 1: watched(11, 3) }, watched: 11, total: 11, notAired: 0 }],
    details: { 1500: { status: 'ended' } },
  });
  assert.deepEqual(plan().edits.filter((e) => e.field === 'Status').map((e) => e.value.stringValue), ['Ended']);
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

// One insert per run keeps the rollback trivially correct, so two seasons
// started between polls cannot both land at once. What matters is that the
// second is not lost: the job re-plans the whole sheet every run, so the next
// one picks it up.
test('two new seasons insert one per run, and the second survives to the next', () => {
  const before: CellSpec[][] = [
    show('Futurama', 'Watching', 3407),
    season(10, 13, 44000),
    show('Silo', 'Watching', 300),
    season(1, 10, 44000),
  ];

  const first = twoNewSeasons(before).plan();
  assert.equal(first.inserts.length, 1, 'never more than one per run');
  assert.equal(first.inserts[0]?.title, 'Futurama');
  assert.equal(first.inserts[0]?.season, 11);

  // The sheet as it stands after that insert lands.
  const after: CellSpec[][] = [
    show('Futurama', 'Watching', 3407),
    season(10, 13, 44000),
    season(11, 6, null),
    show('Silo', 'Watching', 300),
    season(1, 10, 44000),
  ];
  const second = twoNewSeasons(after).plan();
  assert.equal(second.inserts.length, 1);
  assert.equal(second.inserts[0]?.title, 'Silo');
  assert.equal(second.inserts[0]?.season, 2);

  // And a third run has nothing left to insert.
  const settled: CellSpec[][] = [...after, season(2, 4, null)];
  assert.deepEqual(twoNewSeasons(settled).plan().inserts, []);
});

// Deferring it silently is the part that would bite: the report says "1 insert"
// and nothing tells you a second season is waiting.
test('a season deferred past the per-run cap is reported', () => {
  const before: CellSpec[][] = [
    show('Futurama', 'Watching', 3407),
    season(10, 13, 44000),
    show('Silo', 'Watching', 300),
    season(1, 10, 44000),
  ];
  const result = twoNewSeasons(before).plan();
  assert.match(result.notes.concat(result.skipped).join('\n'), /Silo S2/, 'the deferred season is named');
  // Counted, not just mentioned: this is what makes the sync ask for another
  // poll instead of waiting on unrelated watch activity to wake one.
  assert.equal(result.deferred, 1);
  assert.equal(twoNewSeasons([...before.slice(0, 2)]).plan().deferred, 0, 'nothing deferred when it fits');
});

// The projection the status page's history is built from. It outlives the run,
// so what it drops is dropped for good.
test('planRecord keeps where and what changed, and drops the diagnostics', () => {
  const plan: SheetPlan = {
    edits: [
      { row: 8, column: 3, field: 'Episode', previous: { numberValue: 3 }, value: { numberValue: 5 }, address: 'D9', note: 'Fargo S2: 3 -> 5 episodes' },
    ],
    inserts: [{ row: 609, title: 'Fargo', season: 3, fill: [], note: 'Fargo: new season row at 610, 4 episodes' }],
    skipped: ['Severance S1: two rows claim season 1'],
    notes: ['Andor: not on the sheet'],
    deferred: 2,
  };

  assert.deepEqual(planRecord(plan), {
    edits: [{ address: 'D9', field: 'Episode', note: 'Fargo S2: 3 -> 5 episodes' }],
    // An insert has no single cell, so it points at the row it created.
    inserts: [{ address: 'row 610', title: 'Fargo', season: 3, note: 'Fargo: new season row at 610, 4 episodes' }],
  });
});

// `skipped` and `notes` answer "why was this row left alone", which is the
// per-show diagnostic the status page deliberately does not carry. Widening the
// record to include them turns a change log into a question the page cannot
// answer well, and does it in a file that survives restarts.
test('planRecord carries no skip or note lines', () => {
  const record = planRecord({ edits: [], inserts: [], skipped: ['a skip'], notes: ['a note'], deferred: 1 });
  assert.deepEqual(record, { edits: [], inserts: [] });
  assert.ok(!JSON.stringify(record).includes('a skip'));
  assert.ok(!JSON.stringify(record).includes('a note'));
});

// --- rows the planner declines rather than handing to the guard -------------
//
// `assertPlanSafe` refuses a whole plan, by design. So anything the planner can
// see will be refused has to be declined here instead, or one hand-annotated
// cell stops every unrelated edit in the run for as long as that row stays
// inside the activity window.

test('a season whose Episode cell holds text is skipped, not planned', () => {
  const { plan } = scenario({
    rows: [
      show('Fargo', 'Watching', 100),
      // A count the user annotated by hand: it carries a stringValue, so it
      // parses to no number at all.
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
  assert.ok(
    result.skipped.some((line) => /not a number/.test(line)),
    `the row should be skipped with a reason, got ${JSON.stringify(result.skipped)}`,
  );
});

// The point of the skip: the rest of the run still happens.
test('one unusable Episode cell does not stop the other rows', () => {
  const { grid, index, catalogue } = scenario({
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
  const result = planSync(grid, index, catalogue, { timezone: TZ });

  const episodeEdits = result.edits.filter((e) => e.field === 'Episode');
  assert.equal(episodeEdits.length, 1, 'the healthy row is still planned');
  assert.equal(episodeEdits[0]?.row, 4, 'and it is the healthy one');
  // The whole point: this plan passes the guard rather than being refused.
  assert.doesNotThrow(() => assertPlanSafe(result, grid));
});

// A hand-maintained file can end up with two rows for one season — a paste that
// duplicated a row, or a split someone abandoned. One title's progress cannot
// say which to advance, so both would take the same count: the same number
// written twice, and only one of them rolling up into the show row.
test('two rows describing one season are both skipped, not both written', () => {
  const { plan } = scenario({
    rows: [show('Fargo', 'Watching', 100), season(1, 2, null), season(1, 2, null)],
    items: [{ id: 100, status: 'watching', seasons: { 1: watched(3) }, watched: 3, total: 10 }],
    episodes: { 100: eps(1, 10) },
  });
  const result = plan();

  assert.deepEqual(result.edits.filter((e) => e.field === 'Episode'), []);
  assert.ok(
    result.skipped.some((line) => /more than one row describes this season/.test(line)),
    `expected a skip naming the clash, got ${JSON.stringify(result.skipped)}`,
  );
});

// The same clash written the other way: one row names the block's id outright
// and the other inherits it. Both resolve to the same title and season.
test('an explicit id and an inherited one are the same claim', () => {
  const { plan } = scenario({
    rows: [show('Fargo', 'Watching', 100), season(1, 2, null, 100), season(1, 2, null)],
    items: [{ id: 100, status: 'watching', seasons: { 1: watched(3) }, watched: 3, total: 10 }],
    episodes: { 100: eps(1, 10) },
  });
  assert.deepEqual(plan().edits.filter((e) => e.field === 'Episode'), []);
});

// And the shape that is *not* a clash: an anime block whose rows each carry
// their own SIMKL id has one season 1 per title.
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
  assert.equal(episodes.value.numberValue, 49 / 1440);
  assert.match(episodes.note, /49 min average/);
});

// A runtime typed by hand is a deliberate correction, and the row freezes the
// moment End lands — so an overwrite could never be undone.
test('a runtime already in the cell is never overwritten', () => {
  const plan = closing({
    rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { episodes: 0.0299 })],
    runtimes: { 800: { 1: 49 } },
  }).plan();
  assert.ok(plan.edits.some((e) => e.field === 'End'));
  assert.deepEqual(plan.edits.filter((e) => e.field === 'Episodes'), []);
});

// End is a one-way door: the guard refuses every later edit to a dated row, so
// closing before the answer arrives forfeits the cell for good. The serial comes
// from the watch timestamp, so waiting costs nothing.
test('a runtime still outstanding holds the End write rather than closing blind', () => {
  const plan = closing().plan();
  assert.equal(has(plan, 'End'), false, 'the row stays open');
  assert.equal(has(plan, 'Episodes'), false);
  assert.match(plan.skipped.join(' '), /have not come back/);
});

test('a settled null closes the season and leaves the cell blank', () => {
  const plan = closing({ runtimes: { 800: { 1: null } } }).plan();
  closedBare(plan);
  assert.match(plan.notes.join(' '), /no usable episode runtimes/);
});

// No join key is the one state that means "no runtime is obtainable here",
// whether SIMKL carries no id or there is no credential to ask with — the shell
// withholds it in both cases. Read as *pending* instead, every season in the
// sheet would stop being dated, which is why this asserts the skips are empty
// rather than only that the End landed.
test('a row with no tvdb id closes exactly as it did before this existed', () => {
  const bare = closing({ tvdbIds: {} });
  closedBare(bare.plan());
  assert.deepEqual(bare.plan().skipped, []);
  assert.deepEqual(bare.lookups(), []);
});

// --- which seasons are asked about -----------------------------------------

test('the lookup asks for the completing season, with SIMKL’s own count to check against', () => {
  assert.deepEqual(closing().lookups(), [{ id: 800, tvdbId: 403245, season: 1 }]);
});

test('an answer already held is never asked for again, including a null one', () => {
  assert.deepEqual(closing({ runtimes: { 800: { 1: 49 } } }).lookups(), []);
  assert.deepEqual(closing({ runtimes: { 800: { 1: null } } }).lookups(), []);
});

test('a part-watched season, a filled cell and a dated row are all left alone', () => {
  const open = closing({ items: [{ id: 800, status: 'watching', seasons: { 1: watched(4) }, watched: 4, total: 10 }] });
  assert.deepEqual(open.lookups(), [], 'not complete');
  assert.deepEqual(closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { episodes: 0.03 })] }).lookups(), [], 'cell filled');
  assert.deepEqual(closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 10, 44000, { episodes: null })] }).lookups(), [], 'already dated');
});

// A SIMKL anime record numbers every cour "season 1" and all cours of a
// franchise share one TVDB id, so the row's season number means nothing there.
test('an anime block is never asked about, however its ids are arranged', () => {
  const anime = (type: string, showId: number | null, rowId: number | null) =>
    scenario({
      rows: [showRow('Frieren', 'Watching', showId, type), seasonRow(1, 27, null, { id: rowId, episodes: null })],
      items: [{ id: 900, status: 'watching', seasons: { 1: watched(28) }, watched: 28, total: 28 }],
      episodes: { 900: eps(1, 28) },
      details: { 900: { status: 'ended', runtime: 30 } },
      tvdbIds: { 900: 424536 },
    });
  assert.deepEqual(anime('anime', null, 900).lookups(), [], 'ids on the cour row, as anime is kept');
  // The hole an id-location test alone leaves: Type says anime, but someone put
  // an id on the show row, so "no block ids" reads it as live-action.
  assert.deepEqual(anime('anime', 900, null).lookups(), [], 'Type is what settles it');
});

test('a row carrying its own id is never asked about — its number is not the entry’s', () => {
  const own = scenario({
    rows: [show('Doctor Who', 'Watching', 810), seasonRow(14, 8, null, { id: 811, episodes: null })],
    items: [
      // The show-row entry's own watched season is the one the row already
      // covers, so nothing here is insertable and the only thing left to ask
      // about is the row itself — which is the rule under test.
      { id: 810, status: 'watching', seasons: { 14: watched(8) }, watched: 8, total: 8 },
      { id: 811, status: 'completed', seasons: { 1: watched(8) }, watched: 8, total: 8 },
    ],
    episodes: { 810: eps(1, 8), 811: eps(1, 8) },
    details: { 810: { status: 'ended' }, 811: { status: 'ended' } },
    tvdbIds: { 810: 449991, 811: 449991 },
  });
  assert.deepEqual(own.lookups(), []);
});

test('a fractional season is never asked about', () => {
  // Season 1 has a row of its own, closed, so the only thing the block could ask
  // about is the fractional row — and the only reason it does not is the rule.
  const half = closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, 44000), seasonRow(1.5, 9, null, { episodes: null })] });
  assert.deepEqual(half.lookups(), []);
});

// The invariant that stops the two predicates drifting apart. A row the planner
// treats as *pending* but the lookup never requests would defer for ever.
test('every row the plan waits on is a row the lookup asked about', () => {
  const cases = [
    closing(),
    closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { episodes: null }), seasonRow(2, 3, null, { episodes: null })] }),
    closing({ items: [{ id: 800, status: 'completed', seasons: { 1: watched(10) }, watched: 10, total: 10 }] }),
    closing({ details: { 800: { status: 'airing', runtime: 43 } } }),
    closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { episodes: null }), seasonRow(1, 4, null, { episodes: null })] }),
    closing({ rows: [show('Silo', 'Watching', 800), seasonRow(1, 9, null, { episodes: null })], runtimes: { 800: { 2: 40 } } }),
  ];
  for (const [i, c] of cases.entries()) {
    const asked = new Set(c.lookups().map((r) => r.season));
    for (const line of c.plan().skipped) {
      if (!line.includes('have not come back')) continue;
      // "Silo S1: complete, but …" — the season the planner is waiting on.
      const season = Number(/ S(\d+):/.exec(line)?.[1]);
      assert.ok(
        asked.has(season),
        `case ${i}: waiting on S${season} that the lookup never requested — it would defer for ever\n  ${line}`,
      );
    }
  }
});
