import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filmIsWatched, indexFilms, tmdbIdOf } from '../../../src/sheet/movies/1-index.ts';
import { libraryOf } from '../../helpers.ts';

test('only the movies category is indexed — an anime film belongs to the show half', () => {
  const library = libraryOf(
    { id: 1, type: 'movies', title: 'Dune', status: 'completed' },
    { id: 2, type: 'anime', title: 'Kingsglaive' },
    { id: 3, type: 'shows', title: 'Fargo' },
  );
  assert.deepEqual([...indexFilms(library).keys()], [1]);
});

test('every status is indexed, so a hand-added row is recognised rather than duplicated', () => {
  const library = libraryOf(
    { id: 1, type: 'movies', status: 'completed' },
    { id: 2, type: 'movies', status: 'plantowatch' },
    { id: 3, type: 'movies', status: 'dropped' },
  );
  const index = indexFilms(library);
  assert.equal(index.size, 3);
  // Only one of them earns a row.
  assert.deepEqual([...index.values()].filter(filmIsWatched).map((f) => f.id), [1]);
});

test('a null user_rating is a value, not an absence', () => {
  const index = indexFilms(libraryOf({ id: 1, type: 'movies', rating: null }, { id: 2, type: 'movies', rating: 8 }));
  assert.equal(index.get(1)?.rating, null);
  assert.equal(index.get(2)?.rating, 8);
});

test('the TMDB id arrives as text and is read as a number', () => {
  assert.equal(tmdbIdOf('11'), 11);
  assert.equal(tmdbIdOf(undefined), null);
  assert.equal(tmdbIdOf(''), null);
  assert.equal(tmdbIdOf('not-a-number'), null);
  assert.equal(tmdbIdOf('0'), null);
});

test('a film with no TMDB id is indexed, with nothing to look it up by', () => {
  const index = indexFilms(libraryOf({ id: 1, type: 'movies', tmdb: null }));
  assert.equal(index.get(1)?.tmdbId, null);
});

test('the runtime and watch stamp come off the library record, with no lookup', () => {
  const index = indexFilms(libraryOf({ id: 1, type: 'movies', runtime: 121, lastWatchedAt: '2008-02-09T19:00:00Z' }));
  assert.equal(index.get(1)?.runtime, 121);
  assert.equal(index.get(1)?.watchedAt?.toString(), '2008-02-09T19:00:00Z');
});

test('an empty library indexes to nothing — the early-out that skips the read', () => {
  assert.equal(indexFilms(null).size, 0);
  assert.equal(indexFilms(libraryOf({ id: 1, type: 'shows' })).size, 0);
});
