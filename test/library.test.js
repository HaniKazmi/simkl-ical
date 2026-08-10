import { test } from 'node:test';
import assert from 'node:assert/strict';
import { membershipSignature, MEMBERSHIP_FIELDS, LISTS } from '../src/sources/library.js';

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
  anime: { all: '2026-08-09T22:17:35Z', playback: null, watching: '2026-08-08T11:32:04Z', completed: '2026-08-09T22:17:35Z' },
  // movies carries no `watching` or `hold` key at all.
  movies: { all: '2026-08-01T14:44:43Z', rated_at: '2026-08-01T14:25:00Z', plantowatch: '2026-07-25T14:17:58Z', completed: '2026-08-01T14:44:43Z' },
});

test('playback progress does not trip the refresh gate', () => {
  const before = membershipSignature(activities());
  const after = activities();
  after.tv_shows.playback = '2026-08-10T20:00:00Z';
  after.all = '2026-08-10T20:00:00Z';
  after.tv_shows.all = '2026-08-10T20:00:00Z';
  assert.equal(membershipSignature(after), before, 'a scrobbler must not cause a refetch');
});

test('rating something does not trip the refresh gate', () => {
  const before = membershipSignature(activities());
  const after = activities();
  after.tv_shows.rated_at = '2026-08-10T20:00:00Z';
  after.movies.rated_at = '2026-08-10T20:00:00Z';
  assert.equal(membershipSignature(after), before);
});

test('moving an item between lists does trip the gate', () => {
  const before = membershipSignature(activities());
  for (const field of MEMBERSHIP_FIELDS) {
    const after = activities();
    after.tv_shows[field] = '2026-08-10T23:00:00Z';
    assert.notEqual(membershipSignature(after), before, `${field} must be detected`);
  }
});

test('a change in any category is detected', () => {
  const before = membershipSignature(activities());
  for (const category of ['tv_shows', 'anime', 'movies']) {
    const after = activities();
    after[category].plantowatch = '2026-08-10T23:00:00Z';
    assert.notEqual(membershipSignature(after), before, `${category} must be detected`);
  }
});

test('the signature is stable regardless of API key order', () => {
  const a = activities();
  const reordered = { ...a, tv_shows: Object.fromEntries(Object.entries(a.tv_shows).reverse()) };
  assert.equal(membershipSignature(reordered), membershipSignature(a));
});

test('missing categories and fields are tolerated', () => {
  assert.equal(typeof membershipSignature({}), 'string');
  assert.equal(membershipSignature({}), membershipSignature(null));
  assert.equal(membershipSignature(undefined), membershipSignature({ tv_shows: {}, anime: {}, movies: {} }));
});

test('the five library lists are unchanged', () => {
  assert.deepEqual(
    LISTS.map((l) => `${l.type}/${l.status}`),
    ['shows/watching', 'shows/plantowatch', 'anime/watching', 'anime/plantowatch', 'movies/plantowatch'],
  );
});
