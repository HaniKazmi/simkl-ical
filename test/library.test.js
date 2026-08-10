import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSignature, listSignatures, staleLists, LISTS } from '../src/sources/library.js';

// Shape taken from a real /sync/activities response.
const activities = () => ({
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

const keysOf = (lists) => lists.map((l) => l.key).sort();

test('the list set covers watching, plan-to-watch and completed', () => {
  assert.deepEqual(keysOf(LISTS), [
    'anime_completed', 'anime_plantowatch', 'anime_watching',
    'movies_plantowatch',
    'shows_completed', 'shows_plantowatch', 'shows_watching',
  ]);
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
  assert.deepEqual(keysOf(staleLists(after, before)), ['shows_completed', 'shows_plantowatch', 'shows_watching']);
});

test('an unknown list counts as stale, so a cold start fetches everything', () => {
  assert.equal(staleLists(activities(), {}).length, LISTS.length);
  assert.equal(staleLists(activities(), undefined).length, LISTS.length);
});

test('signatures are stable regardless of API key order', () => {
  const a = activities();
  const reordered = { ...a, tv_shows: Object.fromEntries(Object.entries(a.tv_shows).reverse()) };
  assert.deepEqual(listSignatures(reordered), listSignatures(a));
});

test('missing categories and fields are tolerated', () => {
  assert.equal(typeof listSignature({}, { type: 'movies', status: 'watching' }), 'string');
  assert.deepEqual(listSignatures({}), listSignatures(null));
});
