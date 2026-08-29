import { test } from 'node:test';
import assert from 'node:assert/strict';
import { courComplete, indexLibrary, seasonsOf } from '../../src/sheet/1-index.ts';
import { libraryItem, libraryOf } from '../helpers.ts';

test('an episode with no watched_at is not counted', () => {
  const seasons = seasonsOf(libraryItem({ id: 1, seasons: { 1: ['2026-08-01T12:00:00Z', null, '2026-08-03T12:00:00Z'] } }));
  assert.equal(seasons.get(1)?.watched, 2);
  assert.equal(String(seasons.get(1)?.firstWatchedAt), '2026-08-01T12:00:00Z');
  assert.equal(String(seasons.get(1)?.lastWatchedAt), '2026-08-03T12:00:00Z');
});

// South Park: episodes[] holds 338 against a watched count of 331, and season 0
// holds exactly 7. Including it makes a complete season look incomplete forever.
test('season 0 is excluded from the watched counts', () => {
  const seasons = seasonsOf(libraryItem({ id: 1, seasons: { 0: ['2026-08-01T12:00:00Z'], 1: ['2026-08-02T12:00:00Z'] } }));
  assert.deepEqual([...seasons.keys()], [1]);
});

// One record per title, so a dropped show reads as dropped with nothing to
// reconcile — the status on the record is the whole answer.
test('the status on the record is what the index reports', () => {
  const index = indexLibrary(libraryOf({ id: 7, status: 'dropped', lastWatchedAt: '2026-08-01T00:00:00Z' }));
  assert.equal(index.get(7)?.status, 'dropped');
});

test('films are skipped by type — the whole block model is inapplicable', () => {
  const index = indexLibrary(libraryOf({ id: 99, title: 'Dune', type: 'movies' }, { id: 1 }));
  assert.deepEqual([...index.keys()], [1]);
});

test('a cour is complete on its own counters, since one anime entry is one season', () => {
  const progress = indexLibrary(libraryOf({ id: 1, watched: 12, total: 12, notAired: 0 })).get(1)!;
  assert.equal(courComplete(progress), true);
  assert.equal(courComplete({ ...progress, notAiredCount: 1 }), false);
  assert.equal(courComplete({ ...progress, watchedCount: 11 }), false);
});
