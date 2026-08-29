import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  averageRuntime,
  CatalogueStore,
  needsLookup,
  seasonComplete,
  seasonShapes,
  tvdbIdOf,
} from '../../src/sheet/3-catalogue.ts';
import { runtimeDays } from '../../src/sheet/values.ts';
import { indexLibrary } from '../../src/sheet/1-index.ts';
import { libraryOf } from '../helpers.ts';

// --- shapes ----------------------------------------------------------------

test('specials never inflate a numbered season, which would block its end date forever', () => {
  const shapes = seasonShapes([
    { season: 1, episode: 1, type: 'episode', aired: true },
    { season: 1, episode: 2, type: 'episode', aired: true },
    { season: 1, episode: 3, type: 'special', aired: true },
    { season: 0, episode: 1, type: 'episode', aired: true },
  ]);
  assert.deepEqual([...shapes.keys()], [1]);
  assert.equal(shapes.get(1)?.total, 2);
});

// Silo S3: 7 aired of 10, all 7 watched. "Every aired episode watched" stamps
// an end date on a season with three episodes to come — permanent, because a
// dated season is never revisited.
test('a season still airing is not complete, however much of it has been watched', () => {
  const airing = { number: 3, total: 10, aired: 7 };
  assert.equal(seasonComplete(airing, 7), false);
  assert.equal(seasonComplete({ number: 3, total: 10, aired: 10 }, 10), true);
  assert.equal(seasonComplete({ number: 3, total: 10, aired: 10 }, 9), false);
  assert.equal(seasonComplete(undefined, 10), false);
});

// --- runtimes --------------------------------------------------------------

const eps = (...specs: Array<[number, number | null]>) => specs.map(([number, runtime]) => ({ number, runtime }));

test('a season average is the arithmetic mean, in whole minutes', () => {
  assert.equal(averageRuntime(eps([1, 24], [2, 24], [3, 25]), 3), 24);
  // 21 at 22m plus a 44m finale is 506 minutes; 23 x 22 = 506. A median
  // answers 22 and leaves every Length in the block short by 22 minutes.
  const long = eps(...Array.from({ length: 21 }, (_, i) => [i + 1, 22] as [number, number]), [22, 44]);
  assert.equal(averageRuntime(long, 22), 23);
});

test('a null runtime is unknown, not zero, and refuses the whole season', () => {
  // Counting the null as 0 answers 16 — a wrong-but-plausible number frozen
  // into a cell nothing revisits.
  assert.equal(averageRuntime(eps([1, 24], [2, null], [3, 24]), 3), null);
  assert.equal(averageRuntime(eps([1, 0], [2, 24]), 2), null);
  assert.equal(averageRuntime(eps([1, null], [2, null]), 2), null);
});

// The likelier "no data" path: TVDB answers a season it does not have with a
// 200 and an empty list, not a 404, so this never reaches classify.
test('an empty season is a settled null rather than a throw', () => {
  assert.equal(averageRuntime([], 6), null);
  assert.equal(averageRuntime(undefined, 6), null);
  assert.equal(averageRuntime(null, 6), null);
});

test('a count that disagrees with SIMKL refuses, in either direction', () => {
  assert.equal(averageRuntime(eps([1, 24], [2, 24]), 3), null, 'TVDB has fewer');
  assert.equal(averageRuntime(eps([1, 24], [2, 24], [3, 24]), 2), null, 'TVDB has more');
  assert.equal(averageRuntime(eps([1, 24]), 0), null, 'no SIMKL count is not a match');
});

// A null's refusal is recorded as settled, so preferring it over a real length
// in the same payload forfeits the cell for good.
test('a usable duplicate beats an unusable one, whichever came first', () => {
  assert.equal(averageRuntime([{ number: 1, runtime: null }, { number: 1, runtime: 24 }, { number: 2, runtime: 26 }], 2), 25);
  assert.equal(averageRuntime([{ number: 1, runtime: 24 }, { number: 1, runtime: null }, { number: 2, runtime: 26 }], 2), 25);
});

test('a film inside a numbered season is dropped, and a duplicate counted once', () => {
  // Dropped before the count check, so the season still matches SIMKL's two.
  assert.equal(averageRuntime([{ number: 1, runtime: 24 }, { number: 2, runtime: 24 }, { number: 3, runtime: 120, isMovie: 1 }], 2), 24);
  // Weighted twice, the mean would be 24 rather than 26.
  assert.equal(averageRuntime(eps([1, 24], [1, 24], [2, 28]), 2), 26);
});

test('a mean under half a minute yields no cell rather than a zero one', () => {
  assert.equal(runtimeDays(averageRuntime(eps([1, 0.2], [2, 0.2]), 2)), null);
});

test('the tvdb id is read as a number, and anything else is simply absent', () => {
  assert.equal(tvdbIdOf({ ids: { tvdb: '371572' } }), 371572);
  assert.equal(tvdbIdOf({ ids: { tvdb: ' 371572 ' } }), 371572);
  assert.equal(tvdbIdOf({ ids: {} }), null);
  assert.equal(tvdbIdOf({}), null);
  assert.equal(tvdbIdOf(undefined), null);
  assert.equal(tvdbIdOf({ ids: { tvdb: 'not-a-number' } }), null);
  assert.equal(tvdbIdOf({ ids: { tvdb: '0' } }), null);
});

// --- the store -------------------------------------------------------------

const NOW = Temporal.Instant.from('2026-08-20T12:00:00Z');
const index = () => indexLibrary(libraryOf({ id: 1, lastWatchedAt: '2026-08-19T21:00:00Z', seasons: { 1: ['2026-08-19T21:00:00Z'] } }));

const episodes = [
  { season: 1, episode: 1, type: 'episode', aired: true },
  { season: 1, episode: 2, type: 'episode', aired: true },
];

test('a fold reduces the payloads and stamps the title, so a quiet poll asks nothing', () => {
  const store = new CatalogueStore();
  store.foldCatalogue(
    [{ id: 1, episodes: true, detail: true }],
    { episodes: new Map([[1, episodes]]), details: new Map([[1, { status: 'ended', runtime: 45, ids: { tvdb: '99' } }]]), failed: [], unavailable: [] },
    index(),
    { at: NOW, tvdbEnabled: true },
  );

  const held = store.titles.get(1);
  assert.equal(held?.shapes.get(1)?.total, 2);
  assert.equal(held?.status, 'ended');
  assert.equal(held?.tvdbId, 99);
  assert.equal(needsLookup(store.stamps.get(1), index().get(1), NOW, null), false, 'stamped, so not due again');
});

// The stamping discipline: a retryable failure is never recorded, so the next
// poll asks again; anything settled always is.
test('a failed lookup is left unstamped so the next poll retries it', () => {
  const store = new CatalogueStore();
  store.foldCatalogue(
    [{ id: 1, episodes: true }],
    { episodes: new Map(), details: new Map(), failed: [1], unavailable: [] },
    index(),
    { at: NOW },
  );
  assert.equal(needsLookup(store.stamps.get(1), index().get(1), NOW, null), true);
});

// The join key turns the runtime feature on, so without a credential it is
// stored as an explicit null — settled, not pending — and the planner needs no
// second switch.
test('without a TVDB credential the join key folds in as null, not absent', () => {
  const store = new CatalogueStore();
  store.foldCatalogue(
    [{ id: 1, detail: true }],
    { episodes: new Map(), details: new Map([[1, { status: 'ended', ids: { tvdb: '99' } }]]), failed: [], unavailable: [] },
    index(),
    { at: NOW, tvdbEnabled: false },
  );
  assert.equal(store.titles.get(1)?.tvdbId, null);
});

test('a runtime fold records answers and settled nulls, and skips what stalled', () => {
  const store = new CatalogueStore();
  store.foldCatalogue(
    [{ id: 1, episodes: true }],
    { episodes: new Map([[1, episodes]]), details: new Map(), failed: [], unavailable: [] },
    index(),
    { at: NOW },
  );

  store.foldRuntimes(
    [
      { id: 1, tvdbId: 99, season: 1 },
      { id: 1, tvdbId: 99, season: 2 },
    ],
    // Season 1 answers usably; season 2's lookup failed retryably, so its key
    // stays absent and the row stays open.
    { episodes: new Map([['99:1', eps([1, 24], [2, 26])]]), failed: ['99:2'], unavailable: [] },
  );

  const held = store.titles.get(1);
  assert.equal(held?.seasonRuntimes.get(1), 25);
  assert.equal(held?.seasonRuntimes.has(2), false, 'a transient failure is not settled');
});

// The answer to a rejected credential: a typo never starts answering, and
// rows left pending would stop the sheet being dated — silently, for ever.
test('settling seasons as unusable records null for every pending request', () => {
  const store = new CatalogueStore();
  store.foldCatalogue(
    [{ id: 1, episodes: true }],
    { episodes: new Map([[1, episodes]]), details: new Map(), failed: [], unavailable: [] },
    index(),
    { at: NOW },
  );

  store.settleSeasonsUnusable([{ id: 1, tvdbId: 99, season: 1 }]);
  assert.equal(store.titles.get(1)?.seasonRuntimes.get(1), null, 'settled with nothing usable');
});

// --- the re-read gate ------------------------------------------------------

test('a title is re-read when its last watch moved, and only then', () => {
  const stamp = { watchedAt: Temporal.Instant.from('2026-08-19T21:00:00Z'), at: NOW };
  assert.equal(needsLookup(stamp, index().get(1), NOW, null), false, 'nothing moved');
  const moved = indexLibrary(libraryOf({ id: 1, lastWatchedAt: '2026-08-20T10:00:00Z', seasons: { 1: ['2026-08-20T10:00:00Z'] } }));
  assert.equal(needsLookup(stamp, moved.get(1), NOW, null), true, 'a watch is the trigger');
  assert.equal(needsLookup(undefined, index().get(1), NOW, null), true, 'never read is always due');
});

// The backstop for the change no watch produces: a renewal flips /tv/{id}
// status with no library activity.
test('the age ceiling re-reads a quiet title once it is stale', () => {
  const stamp = { watchedAt: Temporal.Instant.from('2026-08-19T21:00:00Z'), at: NOW.subtract({ hours: 25 }) };
  assert.equal(needsLookup(stamp, index().get(1), NOW, Temporal.Duration.from({ hours: 24 })), true);
  assert.equal(needsLookup(stamp, index().get(1), NOW, null), false, 'no ceiling, no re-read');
});
