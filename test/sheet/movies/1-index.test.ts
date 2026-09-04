import { test } from 'node:test';
import assert from 'node:assert/strict';
import { animeFilmIds, filmIsWatched, indexFilms, tmdbIdOf } from '../../../src/sheet/movies/1-index.ts';
import { libraryOf } from '../../helpers.ts';

test('the films tab takes the movies category and anime films, and nothing else', () => {
  const library = libraryOf(
    { id: 1, type: 'movies', title: 'Dune', status: 'completed' },
    { id: 2, type: 'anime', title: 'Kingsglaive', animeType: 'movie' },
    { id: 3, type: 'shows', title: 'Fargo' },
    { id: 4, type: 'anime', title: 'Frieren', animeType: 'tv' },
  );
  assert.deepEqual([...indexFilms(library).keys()], [1, 2]);
});

test('an anime extra is not a film — an ova, special or ona stays with the show half', () => {
  // Each carries the same nested runtime and TMDB id a film does, so what
  // excludes them is `anime_type` and not a field they happen to lack.
  const library = libraryOf(
    { id: 1, type: 'anime', animeType: 'movie', status: 'completed' },
    { id: 2, type: 'anime', animeType: 'ova', status: 'completed' },
    { id: 3, type: 'anime', animeType: 'special', status: 'completed' },
    { id: 4, type: 'anime', animeType: 'ona', status: 'completed' },
  );
  assert.deepEqual([...indexFilms(library).keys()], [1]);
});

test('an anime film nests under `show`, where its runtime is the whole film', () => {
  const library = libraryOf({ id: 7, type: 'anime', title: 'Spirited Away', animeType: 'movie', status: 'completed', runtime: 125 });
  const film = indexFilms(library).get(7);
  assert.equal(film?.title, 'Spirited Away');
  assert.equal(film?.runtime, 125);
  assert.equal(film?.tmdbId, 7);
  assert.equal(film?.anime, true);
});

test('an ordinary film is not marked anime', () => {
  assert.equal(indexFilms(libraryOf({ id: 1, type: 'movies' })).get(1)?.anime, false);
});

test('animeFilmIds names the ids the films tab takes off the show half', () => {
  const library = libraryOf(
    { id: 1, type: 'movies', status: 'completed' },
    { id: 2, type: 'anime', animeType: 'movie', status: 'completed' },
    // Watched status is not the question: a `plantowatch` anime film is still
    // this tab's to place, so the show half must not report it either.
    { id: 3, type: 'anime', animeType: 'movie', status: 'plantowatch' },
    { id: 4, type: 'anime', animeType: 'special', status: 'completed' },
    { id: 5, type: 'shows' },
  );
  assert.deepEqual([...animeFilmIds(library)].sort((a, b) => a - b), [2, 3]);
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

test('a film with no usable title falls back to its id', () => {
  // `Name` and `Franchise` both take the title and the guard refuses either
  // empty, so an empty string here refuses the whole films plan — every
  // unrelated edit with it — on every poll for as long as SIMKL sends it.
  for (const title of ['', '   ']) {
    assert.equal(indexFilms(libraryOf({ id: 5, type: 'movies', title })).get(5)?.title, '5');
  }
  assert.equal(indexFilms(libraryOf({ id: 5, type: 'movies', title: 'Dune' })).get(5)?.title, 'Dune');
});
