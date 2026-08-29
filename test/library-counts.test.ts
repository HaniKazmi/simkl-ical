import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countDeltas, libraryCounts, totalCount, totalsByType } from '../src/library-counts.ts';
import { toLibrary, type Library } from '../src/library.ts';
import { libraryItem } from './helpers.ts';

test('counts name every type and status, including the empty ones', () => {
  const counts = libraryCounts(new Map() as Library);
  assert.deepEqual(Object.keys(counts.byType), ['shows', 'anime', 'movies']);
  assert.deepEqual(Object.keys(counts.byType.shows), ['watching', 'plantowatch', 'completed', 'hold', 'dropped']);
  assert.equal(totalCount(counts), 0);
});

// movies carries no watching or hold status at all.
test('the film statuses are only the three films can hold', () => {
  assert.deepEqual(Object.keys(libraryCounts(null).byType.movies), ['plantowatch', 'completed', 'dropped']);
});

test('counts split by type and status', () => {
  const library = toLibrary({
    shows: [libraryItem({ id: 1, status: 'watching' }), libraryItem({ id: 2, status: 'dropped' })],
    anime: [libraryItem({ id: 3, status: 'watching' })],
    movies: [libraryItem({ id: 4, status: 'plantowatch' })],
  });
  const counts = libraryCounts(library);
  assert.equal(counts.byType.shows.watching, 1);
  assert.equal(counts.byType.shows.dropped, 1);
  assert.equal(counts.byType.anime.watching, 1);
  assert.equal(counts.byType.movies.plantowatch, 1);
  assert.equal(counts.other, 0);
});

// So the rows always sum to the library total, whatever SIMKL adds later.
test('an unrecognised status lands in other rather than vanishing', () => {
  const library = toLibrary({ shows: [libraryItem({ id: 1, status: 'rewatching' })] });
  const counts = libraryCounts(library);
  assert.equal(counts.other, 1);
  assert.equal(totalCount(counts), library.size);
});

test('a library that was never fetched counts as zero, not as missing rows', () => {
  assert.deepEqual(Object.keys(libraryCounts(null).byType), ['shows', 'anime', 'movies']);
});

test('totals fold each type, with other alongside', () => {
  const library = toLibrary({
    shows: [libraryItem({ id: 1, status: 'watching' }), libraryItem({ id: 2, status: 'completed' })],
    movies: [libraryItem({ id: 4, status: 'plantowatch' })],
  });
  assert.deepEqual(totalsByType(libraryCounts(library)), [
    { type: 'shows', count: 2 },
    { type: 'anime', count: 0 },
    { type: 'movies', count: 1 },
    { type: 'other', count: 0 },
  ]);
});

// A count that did not move is not news, so zeroes are left out.
test('deltas name only the counts that moved, in a stable order', () => {
  const before = libraryCounts(toLibrary({ shows: [libraryItem({ id: 1, status: 'watching' })] }));
  const after = libraryCounts(
    toLibrary({ shows: [libraryItem({ id: 1, status: 'completed' })], movies: [libraryItem({ id: 4, status: 'plantowatch' })] }),
  );
  assert.deepEqual(countDeltas(before, after), [
    { type: 'shows', status: 'watching', delta: -1 },
    { type: 'shows', status: 'completed', delta: 1 },
    { type: 'movies', status: 'plantowatch', delta: 1 },
  ]);
  assert.deepEqual(countDeltas(after, after), []);
});
