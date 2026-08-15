import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSignature, listSignatures, staleLists, LISTS } from '../src/sources/library.ts';
import type { Activities, ListDefinition } from '../src/simkl/types.ts';

/** The fixture always populates every category, so tests can mutate them freely. */
type FullActivities = Activities & Required<Pick<Activities, 'tv_shows' | 'anime' | 'movies'>>;

// Shape taken from a real /sync/activities response.
const activities = (): FullActivities => ({
  all: '2026-08-10T11:52:03Z',
  settings: { all: '2026-07-26T13:06:36Z' },
  tv_shows: {
    all: '2026-08-10T11:52:03Z',
    rated_at: '2026-07-12T21:48:41Z',
    playback: '2026-08-08T22:59:34Z',
    plantowatch: '2026-07-12T22:46:29Z',
    watching: '2026-08-10T11:52:03Z',
    completed: '2026-08-01T14:34:35Z',
    hold: '2026-07-12T19:05:00Z',
    dropped: '2026-07-26T13:03:25Z',
    removed_from_list: '2026-07-12T22:46:29Z',
  },
  anime: { all: '2026-08-09T22:17:35Z', playback: null, watching: '2026-08-08T11:32:04Z', plantowatch: '2026-07-26T10:48:53Z', completed: '2026-08-09T22:17:35Z', removed_from_list: '2026-08-01T14:49:38Z' },
  // movies carries no `watching` or `hold` key at all.
  movies: { all: '2026-08-01T14:44:43Z', rated_at: '2026-08-01T14:25:00Z', plantowatch: '2026-07-25T14:17:58Z', completed: '2026-08-01T14:44:43Z', removed_from_list: '2026-07-26T11:01:42Z' },
});

const keysOf = (lists: ListDefinition[]): string[] => lists.map((l) => l.key).sort();

// hold and dropped are here for the sheet sync, not the feed: `join` reads
// library keys by name, so a wider fetch cannot leak into it.
test('the list set covers every show and anime status, and plan-to-watch films', () => {
  assert.deepEqual(keysOf(LISTS), [
    'anime_completed', 'anime_dropped', 'anime_hold', 'anime_plantowatch', 'anime_watching',
    'movies_plantowatch',
    'shows_completed', 'shows_dropped', 'shows_hold', 'shows_plantowatch', 'shows_watching',
  ]);
});

// Against literal expected signatures, not listSignatures' own output —
// comparing f(a) to f(a) passes even for a function returning a constant.
test('a signature is built from the status and removal timestamps only', () => {
  const acts = activities();
  assert.equal(
    listSignature(acts, { type: 'shows', status: 'watching' }),
    `watching=${acts.tv_shows.watching}|removed=${acts.tv_shows.removed_from_list}`,
  );
  assert.equal(
    listSignature(acts, { type: 'movies', status: 'plantowatch' }),
    `plantowatch=${acts.movies.plantowatch}|removed=${acts.movies.removed_from_list}`,
  );
});

test('signatures differ between lists that share a category', () => {
  const acts = activities();
  const watching = listSignature(acts, { type: 'shows', status: 'watching' });
  const completed = listSignature(acts, { type: 'shows', status: 'completed' });
  assert.notEqual(watching, completed, 'otherwise every list in a category gates together');
});

test('nothing is stale when nothing changed', () => {
  const a = activities();
  assert.deepEqual(staleLists(a, listSignatures(a)), []);
});

test('playback progress marks nothing stale', () => {
  const before = listSignatures(activities());
  const after = activities();
  after.tv_shows.playback = '2026-08-10T20:00:00Z';
  after.tv_shows.all = '2026-08-10T20:00:00Z';
  after.all = '2026-08-10T20:00:00Z';
  assert.deepEqual(staleLists(after, before), [], 'a scrobbler must not cause a refetch');
});

test('rating something marks nothing stale', () => {
  const before = listSignatures(activities());
  const after = activities();
  after.tv_shows.rated_at = '2026-08-10T20:00:00Z';
  after.movies.rated_at = '2026-08-10T20:00:00Z';
  assert.deepEqual(staleLists(after, before), []);
});

// The whole point of per-list gating: the common action should be cheap.
test('marking a TV episode watched refetches only shows/watching', () => {
  const before = listSignatures(activities());
  const after = activities();
  after.tv_shows.watching = '2026-08-10T20:00:00Z';
  assert.deepEqual(keysOf(staleLists(after, before)), ['shows_watching']);
});

test('marking an anime episode watched leaves the 118KB completed list alone', () => {
  const before = listSignatures(activities());
  const after = activities();
  after.anime.watching = '2026-08-10T20:00:00Z';
  const stale = keysOf(staleLists(after, before));
  assert.deepEqual(stale, ['anime_watching']);
  assert.ok(!stale.includes('anime_completed'));
});

test('a film list change is isolated to movies', () => {
  const before = listSignatures(activities());
  const after = activities();
  after.movies.plantowatch = '2026-08-10T20:00:00Z';
  assert.deepEqual(keysOf(staleLists(after, before)), ['movies_plantowatch']);
});

test('completing a show refetches the completed list', () => {
  const before = listSignatures(activities());
  const after = activities();
  after.tv_shows.completed = '2026-08-10T20:00:00Z';
  assert.deepEqual(keysOf(staleLists(after, before)), ['shows_completed']);
});

// A removal is only reported against removed_from_list, never against the
// status the item left, so it has to invalidate the whole category.
test('a removal invalidates every list in its category only', () => {
  const before = listSignatures(activities());
  const after = activities();
  after.tv_shows.removed_from_list = '2026-08-10T20:00:00Z';
  assert.deepEqual(keysOf(staleLists(after, before)), [
    'shows_completed', 'shows_dropped', 'shows_hold', 'shows_plantowatch', 'shows_watching',
  ]);
});

test('an unknown list counts as stale, so a cold start fetches everything', () => {
  assert.equal(staleLists(activities(), {}).length, LISTS.length);
  assert.equal(staleLists(activities(), undefined).length, LISTS.length);
});

// The fields the signature deliberately ignores must really be ignored: a
// scrobbler reporting progress must not trigger a byte-identical re-render.
test('only the fields that can move an item between lists count', () => {
  const before = listSignatures(activities());

  for (const noise of ['all', 'rated_at', 'playback'] as const) {
    const acts = activities();
    acts.tv_shows[noise] = '2027-01-01T00:00:00Z';
    assert.deepEqual(listSignatures(acts), before, `${noise} must not invalidate anything`);
  }
});

test('a missing category degrades to an empty signature rather than throwing', () => {
  // `movies` carries no `watching` key at all, so this is a real shape.
  assert.equal(listSignature({}, { type: 'movies', status: 'watching' }), 'watching=|removed=');
  assert.equal(listSignature(null, { type: 'shows', status: 'watching' }), 'watching=|removed=');
});

test('an absent activities payload makes every list stale, not none', () => {
  // The safe direction: knowing nothing must mean "refetch", never "skip".
  assert.equal(staleLists(null, listSignatures(activities())).length, LISTS.length);
});
