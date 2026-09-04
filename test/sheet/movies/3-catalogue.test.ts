import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filmFacts, FilmStore } from '../../../src/sheet/movies/3-catalogue.ts';
import { indexFilms } from '../../../src/sheet/movies/1-index.ts';
import { libraryOf } from '../../helpers.ts';
import type { TmdbMovie } from '../../../src/api/tmdb/types.ts';

const MOVIE: TmdbMovie = {
  title: 'Not This One',
  genres: [{ name: 'Adventure' }, { name: 'Animation' }, { name: 'Comedy' }],
  belongs_to_collection: { name: 'Pixar Collection' },
  release_dates: { results: [{ iso_3166_1: 'GB', release_dates: [{ type: 3, release_date: '2003-10-10', certification: 'U' }] }] },
  credits: { crew: [{ job: 'Director', name: 'Andrew Stanton' }] },
  images: { backdrops: [{ file_path: '/nemo.jpg', iso_639_1: 'en', vote_average: 6 }] },
};

test('a payload reduces to the cells a row needs', () => {
  const facts = filmFacts(MOVIE, 'Finding Nemo');
  assert.equal(facts.genre, 'Adventure');
  assert.equal(facts.genres, 'Comedy');
  assert.equal(facts.certificate, 3);
  assert.equal(facts.releaseDate?.toString(), '2003-10-10');
  assert.equal(facts.openedInCinemas?.toString(), '2003-10-10');
  assert.equal(facts.franchise, 'Pixar');
  assert.equal(facts.director, 'Andrew Stanton');
  assert.equal(facts.banner, 'https://image.tmdb.org/t/p/w1280/nemo.jpg');
});

test('the title used is the library one, not TMDB own — the rest of the sheet is keyed to it', () => {
  // 18 of 347 rows carry a hand title, and the library is what a reader
  // matches them against.
  assert.equal(filmFacts(MOVIE, 'Finding Nemo').franchise, 'Pixar');
});

test('an answered film is retained, and asked about only once', () => {
  const store = new FilmStore();
  assert.equal(store.films.has(1), false);
  store.fold([{ id: 1, title: 'Finding Nemo' }], { films: new Map([[1, MOVIE]]), unavailable: [] });
  assert.equal(store.films.get(1)?.genre, 'Adventure');
});

test('a 404 is a settled answer, recorded so it is never re-requested', () => {
  const store = new FilmStore();
  store.fold([{ id: 1, title: 'Obscure' }], { films: new Map(), unavailable: [1] });
  assert.equal(store.films.get(1), null);
  assert.ok(store.films.has(1));
});

test('a retryable failure is not recorded, so the next poll asks again', () => {
  // The stamping split: an unrecorded settled answer would be re-requested
  // every poll forever, and a recorded transient one strands the row.
  const store = new FilmStore();
  store.fold([{ id: 1, title: 'Timed Out' }], { films: new Map(), unavailable: [] });
  assert.equal(store.films.has(1), false);
});

test('a rejected credential settles every pending film, and only those', () => {
  const store = new FilmStore();
  store.fold([{ id: 1, title: 'Known' }], { films: new Map([[1, MOVIE]]), unavailable: [] });
  store.settleUnusable([{ id: 1 }, { id: 2 }]);
  assert.equal(store.films.get(1)?.genre, 'Adventure', 'an answered film keeps its answer');
  assert.equal(store.films.get(2), null);
});

test('a film with no TMDB id is reported once, and never settled', () => {
  // What is missing is SIMKL's id, not TMDB's knowledge, and SIMKL fills ids
  // in over time. Settled, a film mapped an hour later would wait for a
  // restart; noted, the next poll re-checks the library for free.
  const store = new FilmStore();
  const film = indexFilms(libraryOf({ id: 7, type: 'movies', tmdb: null })).get(7)!;
  assert.equal(store.noteUnidentifiable(film), true, 'reported the first time');
  assert.equal(store.noteUnidentifiable(film), false, 'and not again');
  assert.equal(store.films.has(7), false, 'but never recorded as unobtainable');
});

test('a film that has a TMDB id is not reported, so it is demanded', () => {
  const store = new FilmStore();
  const film = indexFilms(libraryOf({ id: 7, type: 'movies', tmdb: '550' })).get(7)!;
  assert.equal(store.noteUnidentifiable(film), false);
  assert.equal(store.films.has(7), false);
});
