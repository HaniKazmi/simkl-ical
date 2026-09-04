import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexFilms } from '../../../src/sheet/movies/1-index.ts';
import { filmFacts } from '../../../src/sheet/movies/3-catalogue.ts';
import { NOT_HELD, observeFilms, planFilms } from '../../../src/sheet/movies/4-plan.ts';
import { movieKey, type Baseline } from '../../../src/sheet/values.ts';
import { isoOf } from '../../../src/shared/dates.ts';
import type { FilmFacts } from '../../../src/sheet/movies/3-catalogue.ts';
import { libraryOf, type ItemSpec } from '../../helpers.ts';
import { film, filmGrid, TODAY } from './fixture.ts';

const NOW = Temporal.Instant.from('2026-09-04T12:00:00Z');
const OPTS = { now: NOW, timezone: 'UTC' as const };

/**
 * A serial as a date the library can carry, so both sides speak the same day.
 * Through `isoOf`, because the baseline records what `isoOf` writes and a
 * narrower string would compare unequal to itself.
 */
const watchedOn = (serial: number): string =>
  isoOf(Temporal.PlainDate.from('1899-12-30').add({ days: serial }).toZonedDateTime({ timeZone: 'UTC' }).toInstant());

const facts = (over: Partial<FilmFacts> = {}): FilmFacts => ({ ...filmFacts({}, 'A Film'), ...over });

const plan = (
  rows: Parameters<typeof filmGrid>,
  items: ItemSpec[],
  { baseline = new Map() as Baseline, known = new Map<number, FilmFacts | null>() } = {},
) => {
  const grid = filmGrid(...rows);
  const index = indexFilms(libraryOf(...items));
  return { grid, ...planFilms(grid.grid, index, known, { ...OPTS, baseline, seed: observeFilms(index) }) };
};

const movie = (over: Partial<ItemSpec> & { id: number }): ItemSpec => ({ type: 'movies', status: 'completed', ...over });

// --- Following SIMKL on a row that already exists ----------------------------

test('a first sighting is recorded and writes nothing', () => {
  // What keeps this to changes from here on rather than a reconciliation of
  // every standing mismatch on 348 rows.
  const { plan: p, observed, writing } = plan(
    [film('a', { id: 1, watched: 40000, score: 5, runtime: 90 })],
    [movie({ id: 1, lastWatchedAt: watchedOn(41000), rating: 9, runtime: 120 })],
  );
  assert.equal(p.edits.length, 0);
  assert.equal(writing.size, 0);
  assert.deepEqual(observed.get(movieKey(1)), { 'Watch Date': watchedOn(41000), Score: '9', Runtime: '120' });
});

test('a value that moved away from what was recorded is written', () => {
  const baseline: Baseline = new Map([[movieKey(1), { 'Watch Date': watchedOn(40000), Score: '5', Runtime: '90' }]]);
  const { plan: p, writing, observed } = plan(
    [film('a', { id: 1, watched: 40000, score: 5, runtime: 90 })],
    [movie({ id: 1, lastWatchedAt: watchedOn(41000), rating: 9, runtime: 120 })],
    { baseline },
  );
  assert.deepEqual(
    p.edits.map((e) => [e.field, e.value]),
    [['Watch Date', { numberValue: 41000 }], ['Score', { numberValue: 9 }], ['Runtime', { numberValue: 120 }]],
  );
  // Planned, so recordable only once the write lands — and withdrawn from the
  // set that is recorded whatever happened.
  assert.deepEqual(writing.get(movieKey(1)), { 'Watch Date': watchedOn(41000), Score: '9', Runtime: '120' });
  assert.deepEqual(observed.get(movieKey(1)), {});
});

test('an unmoved value is recorded and not written', () => {
  const baseline: Baseline = new Map([[movieKey(1), { 'Watch Date': watchedOn(40000), Score: '5', Runtime: '90' }]]);
  const { plan: p, writing } = plan(
    [film('a', { id: 1, watched: 40000, score: 5, runtime: 90 })],
    [movie({ id: 1, lastWatchedAt: watchedOn(40000), rating: 5, runtime: 90 })],
    { baseline },
  );
  assert.equal(p.edits.length, 0);
  assert.equal(writing.size, 0);
});

test('a score SIMKL did not hold before is written once it does', () => {
  // The recorded-absence rule. Were a null left unrecorded, rating a film later
  // would be a first sighting — silent then, and silent for good.
  const baseline: Baseline = new Map([[movieKey(1), { Score: NOT_HELD, 'Watch Date': watchedOn(40000), Runtime: '90' }]]);
  const { plan: p } = plan(
    [film('a', { id: 1, watched: 40000, score: null, runtime: 90 })],
    [movie({ id: 1, lastWatchedAt: watchedOn(40000), rating: 8, runtime: 90 })],
    { baseline },
  );
  assert.deepEqual(p.edits.map((e) => [e.field, e.value]), [['Score', { numberValue: 8 }]]);
});

test('a score SIMKL stopped holding empties nothing — the cell keeps what it has', () => {
  const baseline: Baseline = new Map([[movieKey(1), { Score: '8', 'Watch Date': watchedOn(40000), Runtime: '90' }]]);
  const { plan: p } = plan(
    [film('a', { id: 1, watched: 40000, score: 8, runtime: 90 })],
    [movie({ id: 1, lastWatchedAt: watchedOn(40000), rating: null, runtime: 90 })],
    { baseline },
  );
  assert.equal(p.edits.length, 0);
  assert.equal(p.skips[0]?.code, 'unusable-value');
});

test('a watch restamped within the same day moves nothing the sheet can show', () => {
  // A scrobbler moves `last_watched_at` by seconds; the comparison is on the
  // rendered day, so the cell is left alone.
  const baseline: Baseline = new Map([[movieKey(1), { 'Watch Date': '2026-09-01T09:00:00Z', Score: NOT_HELD, Runtime: '90' }]]);
  const { plan: p } = plan(
    [film('a', { id: 1, watched: 46266, score: null, runtime: 90 })],
    [movie({ id: 1, lastWatchedAt: '2026-09-01T21:33:07Z', rating: null, runtime: 90 })],
    { baseline },
  );
  assert.equal(p.edits.length, 0);
});

test('a value outside the range its column accepts is declined, not written', () => {
  const baseline: Baseline = new Map([[movieKey(1), { Score: '5', 'Watch Date': watchedOn(40000), Runtime: '90' }]]);
  const { plan: p } = plan(
    [film('a', { id: 1, watched: 40000, score: 5, runtime: 90 })],
    [movie({ id: 1, lastWatchedAt: watchedOn(40000), rating: 99, runtime: 90 })],
    { baseline },
  );
  assert.equal(p.edits.length, 0);
  assert.match(p.skips[0]?.reason ?? '', /outside the range/);
});

test('a row whose id is on the tab twice is skipped rather than guessed at', () => {
  const baseline: Baseline = new Map([[movieKey(1), { Score: '1', 'Watch Date': watchedOn(40000), Runtime: '90' }]]);
  const { plan: p } = plan(
    [film('a', { id: 1, score: 5 }), film('b', { id: 1, score: 5 })],
    [movie({ id: 1, lastWatchedAt: watchedOn(40000), rating: 9, runtime: 90 })],
    { baseline },
  );
  assert.equal(p.edits.length, 0);
  assert.deepEqual(p.skips.map((s) => s.code), ['duplicate-id', 'duplicate-id']);
});

test('a row for a film no longer in the library is left alone', () => {
  const { plan: p } = plan([film('a', { id: 404 })], [movie({ id: 1 })], {});
  assert.equal(p.edits.length, 0);
  assert.equal(p.skips.find((s) => s.code === 'unknown-id')?.code, 'unknown-id');
});

// --- The insert --------------------------------------------------------------

test('a watched film with no row gets one, below the last', () => {
  const known = new Map<number, FilmFacts | null>([[2, facts({ genre: 'Drama', genres: 'Thriller', certificate: 15, director: 'A Director', franchise: 'Solo', banner: 'https://image.tmdb.org/t/p/w1280/a.jpg' })]]);
  const { grid, plan: p } = plan(
    [film('a', { id: 1 })],
    [movie({ id: 1 }), movie({ id: 2, title: 'New Film', lastWatchedAt: watchedOn(TODAY - 2), rating: 7, runtime: 110 })],
    { known },
  );
  assert.equal(p.insert?.id, 2);
  assert.equal(p.insert?.row, grid.end);
  const filled = Object.fromEntries(p.insert!.fill.map((c) => [c.field, c.value]));
  assert.deepEqual(filled.Name, { stringValue: 'New Film' });
  // Text, matching every other id cell on the tab.
  assert.deepEqual(filled.id, { stringValue: '2' });
  assert.deepEqual(filled['Watch Date'], { numberValue: TODAY - 2 });
  assert.deepEqual(filled.Score, { numberValue: 7 });
  assert.deepEqual(filled.Runtime, { numberValue: 110 });
  assert.deepEqual(filled.Genre, { stringValue: 'Drama' });
  assert.deepEqual(filled.Rating, { numberValue: 15 });
});

test('a film waits a poll rather than landing with blank TMDB cells', () => {
  const { plan: p, demands } = plan([film('a', { id: 1 })], [movie({ id: 1 }), movie({ id: 2, tmdb: '550' })]);
  assert.equal(p.insert, null);
  assert.deepEqual(demands.map((d) => [d.id, d.tmdbId]), [[2, 550]]);
  assert.equal(p.skips.find((s) => s.code === 'awaiting-lookup')?.code, 'awaiting-lookup');
});

test('a film TMDB has no record of is named once, not demanded every poll', () => {
  const known = new Map<number, FilmFacts | null>([[2, null]]);
  const { plan: p, demands } = plan([film('a', { id: 1 })], [movie({ id: 1 }), movie({ id: 2, title: 'Obscure' })], { known });
  assert.equal(p.insert, null);
  assert.deepEqual(demands, []);
  assert.match(p.notes.join(' '), /Obscure .* has no TMDB record/);
});

test('a film SIMKL carries no TMDB id for is never demanded', () => {
  const { plan: p, demands } = plan([film('a', { id: 1 })], [movie({ id: 1 }), movie({ id: 2, tmdb: null })]);
  assert.deepEqual(demands, []);
  assert.equal(p.skips.find((s) => s.code === 'not-in-tmdb')?.code, 'not-in-tmdb');
});

test('only a completed film earns a row', () => {
  const known = new Map<number, FilmFacts | null>([[2, facts()], [3, facts()]]);
  const { plan: p, demands } = plan(
    [film('a', { id: 1 })],
    [movie({ id: 1 }), movie({ id: 2, status: 'plantowatch' }), movie({ id: 3, status: 'dropped' })],
    { known },
  );
  assert.equal(p.insert, null);
  assert.deepEqual(demands, []);
});

test('one row per run, oldest first, and the rest are deferred', () => {
  const known = new Map<number, FilmFacts | null>([[2, facts()], [3, facts()]]);
  const { plan: p } = plan(
    [film('a', { id: 1 })],
    [
      movie({ id: 1 }),
      movie({ id: 3, title: 'Later', lastWatchedAt: watchedOn(TODAY - 1) }),
      movie({ id: 2, title: 'Earlier', lastWatchedAt: watchedOn(TODAY - 30) }),
    ],
    { known },
  );
  assert.equal(p.insert?.title, 'Earlier');
  assert.equal(p.deferredInserts, 1);
  assert.match(p.notes.join(' '), /1 more film/);
});

test('a film watched but never dated gets no row — a 1970 date is worse than none', () => {
  const known = new Map<number, FilmFacts | null>([[2, facts()]]);
  const { plan: p } = plan([film('a', { id: 1 })], [movie({ id: 1 }), movie({ id: 2, lastWatchedAt: '1970-01-01T00:00:00Z' })], { known });
  assert.equal(p.insert, null);
  assert.match(p.skips.find((s) => s.code === 'unusable-value')?.reason ?? '', /watch date/);
});

test('Cinema is set only when the film opened here and was watched inside the window', () => {
  const opened = Temporal.PlainDate.from('1899-12-30').add({ days: TODAY - 5 });
  const inWindow = new Map<number, FilmFacts | null>([[2, facts({ openedInCinemas: opened })]]);
  const { plan: p } = plan([film('a', { id: 1 })], [movie({ id: 1 }), movie({ id: 2, lastWatchedAt: watchedOn(TODAY - 1) })], { known: inWindow });
  assert.deepEqual(p.insert?.fill.find((c) => c.field === 'Cinema')?.value, { boolValue: true });

  // A streaming premiere watched on release week: no GB opening, no tick.
  const never = new Map<number, FilmFacts | null>([[2, facts({ openedInCinemas: null })]]);
  const { plan: q } = plan([film('a', { id: 1 })], [movie({ id: 1 }), movie({ id: 2, lastWatchedAt: watchedOn(TODAY - 1) })], { known: never });
  assert.equal(q.insert?.fill.some((c) => c.field === 'Cinema'), false);
});

test('a film already on the tab is never inserted, whatever its status', () => {
  const known = new Map<number, FilmFacts | null>([[1, facts()]]);
  const { plan: p, demands } = plan([film('a', { id: 1 })], [movie({ id: 1 })], { known });
  assert.equal(p.insert, null);
  assert.deepEqual(demands, []);
});

test('a blank cell a film row has no value for is simply not filled', () => {
  const known = new Map<number, FilmFacts | null>([[2, facts({ genre: null, genres: '', certificate: null, director: null, banner: null })]]);
  const { plan: p } = plan([film('a', { id: 1 })], [movie({ id: 1 }), movie({ id: 2, rating: null, lastWatchedAt: watchedOn(TODAY - 1) })], { known });
  const fields = p.insert!.fill.map((c) => c.field);
  for (const absent of ['Genre', 'Genres', 'Rating', 'Director', 'Banner', 'Score']) assert.equal(fields.includes(absent as never), false);
});
