import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGrid } from '../../src/sheet/1-grid.ts';
import { deriveStatus, needsLookup, planLookups, planSync, statusSource, type CatalogueView, type TitleCatalogue } from '../../src/sheet/3-plan.ts';
import { dateSerial, indexLibrary, seasonShapes } from '../../src/sheet/2-progress.ts';
import type { EpisodeDetail, ShowDetail } from '../../src/api/simkl/types.ts';
import { daysAgo, libraryItem, sheetSnapshot, SHEET_HEADERS, type CellSpec, type ItemSpec, seasonRow, showRow } from '../helpers.ts';

const H = SHEET_HEADERS;
const TZ = 'Europe/London';
const DAY = 86_400_000;

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
}

const scenario = ({ rows, items, episodes = {}, details = {}, failed = [] }: Scenario) => {
  const grid = parseGrid(sheetSnapshot([H, ...rows]));
  const index = indexLibrary({ shows_watching: { shows: items.map(libraryItem) } });
  const titles = new Map<number, TitleCatalogue>();
  const entry = (id: number) => titles.get(id) ?? titles.set(id, { shapes: new Map() }).get(id)!;
  for (const [id, list] of Object.entries(episodes)) entry(Number(id)).shapes = seasonShapes(list);
  for (const [id, detail] of Object.entries(details)) Object.assign(entry(Number(id)), detail);
  const catalogue: CatalogueView = { titles, failed, unavailable: [] };
  return { grid, index, catalogue, plan: () => planSync(grid, index, catalogue, { timezone: TZ }) };
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
  assert.equal(end?.value.numberValue, dateSerial(new Date(last).toLocaleDateString('en-CA', { timeZone: TZ })));
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

// Branch 1 reads item.status, never which list it arrived in: list membership
// goes stale, and the stale copy would rewrite Status to Abandoned every poll.
test('Abandoned comes from the item status, not from list membership', () => {
  const grid = parseGrid(sheetSnapshot([H, show('Beef', 'Ended', 700), season(1, 10, 44000)]));
  const index = indexLibrary({
    shows_dropped: { shows: [libraryItem({ id: 700, status: 'watching', seasons: { 1: watched(10) } })] },
  });
  // Real shapes, or the fail-closed rule below would make this pass vacuously.
  const titles = new Map([[700, { shapes: seasonShapes(eps(1, 10)), status: 'ended' }]]);
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

  const at = Date.now();
  const stamps = new Map(cold.map((r) => [r.id, { watchedAt: index.get(r.id)?.lastWatchedAt ?? null, at }]));
  assert.deepEqual(planLookups(grid, index, { stamps, maxAgeMs: DAY }), [], 'nothing moved, nothing re-read');

  // Only the title that moved.
  stamps.set(1, { watchedAt: '1999-01-01T00:00:00Z', at });
  assert.deepEqual([...new Set(planLookups(grid, index, { stamps, maxAgeMs: DAY }).map((r) => r.id))], [1]);
});

// The backstop for the case watch activity cannot catch: /tv/{id} status
// flipping on a renewal, which produces nothing in the library to gate on.
test('a stamp past its age ceiling is re-read even with no activity', () => {
  const { grid, index } = scenario({
    rows: [show('Fargo', 'Watching', 1), season(1, 1, null)],
    items: [{ id: 1, status: 'watching', seasons: { 1: watched(5) } }],
  });
  const unchanged = { watchedAt: index.get(1)?.lastWatchedAt ?? null };

  const fresh = new Map([[1, { ...unchanged, at: Date.now() - DAY / 2 }]]);
  assert.deepEqual(planLookups(grid, index, { stamps: fresh, maxAgeMs: DAY }), []);

  const old = new Map([[1, { ...unchanged, at: Date.now() - DAY * 2 }]]);
  assert.equal(planLookups(grid, index, { stamps: old, maxAgeMs: DAY }).length > 0, true);
});

test('the cut-off still wins over a stamp — an ineligible title is never read', () => {
  const { grid, index } = scenario({
    rows: [show('Dormant', 'Ended', 1), season(1, 10, 44000)],
    items: [{ id: 1, status: 'completed', seasons: { 1: watched(10, 500) } }],
  });
  assert.deepEqual(planLookups(grid, index, { stamps: new Map(), maxAgeMs: DAY }), []);
});

test('needsLookup reads unstamped, moved and aged as due, and nothing else', () => {
  const progress = indexLibrary({ shows_watching: { shows: [libraryItem({ id: 1, lastWatchedAt: '2026-08-01T00:00:00Z' })] } }).get(1);
  const now = Date.now();
  assert.equal(needsLookup(undefined, progress, now, DAY), true, 'never read');
  assert.equal(needsLookup({ watchedAt: '2026-08-01T00:00:00Z', at: now }, progress, now, DAY), false);
  assert.equal(needsLookup({ watchedAt: '2026-07-01T00:00:00Z', at: now }, progress, now, DAY), true, 'moved');
  assert.equal(needsLookup({ watchedAt: '2026-08-01T00:00:00Z', at: now - DAY * 2 }, progress, now, DAY), true, 'aged');
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
