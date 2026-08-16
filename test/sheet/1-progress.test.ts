import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  courComplete,
  dateSerial,
  indexLibrary,
  runtimeDays,
  seasonComplete,
  seasonShapes,
  seasonsOf,
  watchSerial,
} from '../../src/sheet/1-progress.ts';
import { libraryItem, libraryOf } from '../helpers.ts';
import { instantFrom, plainDateFrom } from '../../src/shared/dates.ts';

// --- dates -----------------------------------------------------------------

test('a date serial counts days from the sheet epoch', () => {
  assert.equal(dateSerial(plainDateFrom('1899-12-30')), 0);
  assert.equal(dateSerial(plainDateFrom('1900-01-01')), 2);
  assert.equal(dateSerial(plainDateFrom('2026-08-15')), 46249);
});

// The highest-risk conversion in the project: iso.slice(0, 10) is wrong for any
// US evening broadcast, which is stamped the following day in UTC.
test('a late-evening watch lands on the local date, not the UTC one', () => {
  assert.equal(watchSerial(instantFrom('2026-08-14T23:54:25Z'), 'Europe/London'), dateSerial(plainDateFrom('2026-08-15')));
  assert.equal(watchSerial(instantFrom('2026-08-15T02:54:25Z'), 'America/New_York'), dateSerial(plainDateFrom('2026-08-14')));
});

// The parse is the step that can fail, so it is the step that answers null;
// the conversion after it is total. The planner never throws, so an unusable
// timestamp costs that episode's date rather than the run.
test('an unusable timestamp is refused at the parse, and never reaches the serial', () => {
  for (const bad of ['not a date', '', '2026', 'March 5', null, undefined]) {
    assert.equal(instantFrom(bad), null, `${bad} should not parse`);
    assert.equal(watchSerial(instantFrom(bad), 'Europe/London'), null);
  }
});

// SIMKL occasionally emits a space where the T belongs, and Date.parse on that
// is implementation-defined.
test('a space-separated timestamp is normalised rather than rejected', () => {
  assert.equal(instantFrom('2026-08-14 21:03:12Z')?.toString(), '2026-08-14T21:03:12Z');
  assert.equal(watchSerial(instantFrom('2026-08-14 21:03:12Z'), 'Europe/London'), dateSerial(plainDateFrom('2026-08-14')));
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
