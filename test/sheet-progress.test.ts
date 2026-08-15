import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  courComplete,
  dateSerial,
  indexLibrary,
  normaliseInstant,
  runtimeDays,
  seasonComplete,
  seasonShapes,
  seasonsOf,
  watchSerial,
} from '../src/sheet/progress.ts';
import { libraryItem, libraryOf } from './helpers.ts';

// --- dates -----------------------------------------------------------------

test('a date serial counts days from the sheet epoch', () => {
  assert.equal(dateSerial('1899-12-30'), 0);
  assert.equal(dateSerial('1900-01-01'), 2);
  assert.equal(dateSerial('2026-08-15'), 46249);
});

// The highest-risk conversion in the project: iso.slice(0, 10) is wrong for any
// US evening broadcast, which is stamped the following day in UTC.
test('a late-evening watch lands on the local date, not the UTC one', () => {
  assert.equal(watchSerial('2026-08-14T23:54:25Z', 'Europe/London'), dateSerial('2026-08-15'));
  assert.equal(watchSerial('2026-08-15T02:54:25Z', 'America/New_York'), dateSerial('2026-08-14'));
});

// localDate ends in Intl.DateTimeFormat.prototype.format, which *throws* on an
// invalid Date rather than yielding NaN — so the guard must run before the
// conversion, not after it.
test('an unusable timestamp returns null rather than throwing', () => {
  assert.equal(watchSerial('not a date', 'Europe/London'), null);
  assert.equal(watchSerial(null, 'Europe/London'), null);
  assert.equal(watchSerial(undefined, 'Europe/London'), null);
  assert.equal(watchSerial('', 'Europe/London'), null);
});

// SIMKL occasionally emits a space where the T belongs, and Date.parse on that
// is implementation-defined.
test('a space-separated timestamp is normalised rather than rejected', () => {
  assert.equal(normaliseInstant('2026-08-14 21:03:12Z'), '2026-08-14T21:03:12Z');
  assert.equal(watchSerial('2026-08-14 21:03:12Z', 'Europe/London'), dateSerial('2026-08-14'));
});

test('a runtime in minutes becomes the day fraction the sheet holds', () => {
  assert.ok(Math.abs((runtimeDays(41) ?? 0) - 0.0284722) < 1e-6);
  assert.equal(runtimeDays(0), null);
  assert.equal(runtimeDays(null), null);
});

// --- counting --------------------------------------------------------------

test('an episode with no watched_at is not counted', () => {
  const seasons = seasonsOf(libraryItem({ id: 1, seasons: { 1: ['2026-08-01T12:00:00Z', null, '2026-08-03T12:00:00Z'] } }));
  assert.equal(seasons.get(1)?.watched, 2);
  assert.equal(seasons.get(1)?.firstWatchedAt, '2026-08-01T12:00:00Z');
  assert.equal(seasons.get(1)?.lastWatchedAt, '2026-08-03T12:00:00Z');
});

// South Park: episodes[] holds 338 against a watched count of 331, and season 0
// holds exactly 7. Including it makes a complete season look incomplete forever.
test('season 0 is excluded from the watched counts', () => {
  const seasons = seasonsOf(libraryItem({ id: 1, seasons: { 0: ['2026-08-01T12:00:00Z'], 1: ['2026-08-02T12:00:00Z'] } }));
  assert.deepEqual([...seasons.keys()], [1]);
});

test('a title in two lists keeps the entry with the later activity', () => {
  // A move is only reported against the list it moved *to*, so an un-dropped
  // show sits in both until something else evicts it.
  const index = indexLibrary({
    shows_dropped: { shows: [libraryItem({ id: 7, status: 'dropped', lastWatchedAt: '2025-01-01T00:00:00Z' })] },
    shows_watching: { shows: [libraryItem({ id: 7, status: 'watching', lastWatchedAt: '2026-08-01T00:00:00Z' })] },
  });
  assert.equal(index.get(7)?.status, 'watching');
});

test('films are skipped — the whole block model is inapplicable', () => {
  const index = indexLibrary({ movies_plantowatch: { movies: [{ movie: { title: 'Dune', ids: { simkl: 99 } } }] }, ...libraryOf({ id: 1 }) });
  assert.deepEqual([...index.keys()], [1]);
});

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

// Silo S3: 7 aired of 10, all watched. "Every aired episode watched" stamps a
// permanent end date on a season with three episodes still to come — permanent,
// because a dated season is never revisited.
test('a season still airing is not complete, however much of it has been watched', () => {
  const airing = { number: 3, total: 10, aired: 7 };
  assert.equal(seasonComplete(airing, 7), false);
  assert.equal(seasonComplete({ number: 3, total: 10, aired: 10 }, 10), true);
  assert.equal(seasonComplete({ number: 3, total: 10, aired: 10 }, 9), false);
  assert.equal(seasonComplete(undefined, 10), false);
});

test('a cour is complete on its own counters, since one anime entry is one season', () => {
  const progress = indexLibrary(libraryOf({ id: 1, watched: 12, total: 12, notAired: 0 })).get(1)!;
  assert.equal(courComplete(progress), true);
  assert.equal(courComplete({ ...progress, notAiredCount: 1 }), false);
  assert.equal(courComplete({ ...progress, watchedCount: 11 }), false);
});
