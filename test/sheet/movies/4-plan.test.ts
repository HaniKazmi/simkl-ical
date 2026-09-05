import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexFilms } from '../../../src/sheet/movies/1-index.ts';
import { filmFacts } from '../../../src/sheet/movies/3-catalogue.ts';
import { MAX_LOOKUPS_PER_PASS, NOT_HELD, observeFilms, planFilms } from '../../../src/sheet/movies/4-plan.ts';
import { movieKey, type Baseline } from '../../../src/sheet/values.ts';
import { isoOf } from '../../../src/shared/dates.ts';
import type { FilmFacts } from '../../../src/sheet/movies/3-catalogue.ts';
import { cellOf, libraryOf, type ItemSpec } from '../../helpers.ts';
import { film, filmGrid, rawFilm, TODAY } from './fixture.ts';

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
  {
    baseline = new Map() as Baseline,
    known = new Map<number, FilmFacts | null>(),
    held,
    onShowGrid = new Set<number>(),
    lookupsRejected = false,
  }: { baseline?: Baseline; known?: Map<number, FilmFacts | null>; held?: Set<number>; onShowGrid?: Set<number> | null; lookupsRejected?: boolean } = {},
) => {
  const grid = filmGrid(...rows);
  const index = indexFilms(libraryOf(...items));
  return { grid, ...planFilms(grid.grid, index, known, { ...OPTS, baseline, held, onShowGrid, lookupsRejected, seed: observeFilms(index) }) };
};

const movie = (over: Partial<ItemSpec> & { id: number }): ItemSpec => ({ type: 'movies', status: 'completed', ...over });
const animeFilm = (over: Partial<ItemSpec> & { id: number }): ItemSpec => ({ type: 'anime', animeType: 'movie', status: 'completed', ...over });

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
  // The note says both sides as a reader would write them — a date in the
  // viewer's zone, never the serial the cell holds — the way the show grid's
  // note does; `41000` on a status page says nothing to anyone.
  assert.deepEqual(
    p.edits.map((e) => e.note),
    ['Show 1: Watch Date moved from 2009-07-06 to 2012-04-01', 'Show 1: Score moved from 5 to 9', 'Show 1: Runtime moved from 90 to 120'],
  );
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
  assert.equal(p.edits[0]?.note, 'Show 1: Score moved from none to 8');
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

test('a formula in a followed column is declined, not handed to the guard', () => {
  // The guard refuses a formula unconditionally and whole-plan, so without the
  // planner declining first, one formula in one cell would refuse every film
  // edit on every poll for as long as that cell held it.
  const baseline: Baseline = new Map([[movieKey(1), { Score: '5', 'Watch Date': watchedOn(40000), Runtime: '90' }]]);
  const grid = filmGrid(film('a', { id: 1, watched: 40000, score: 5, runtime: 90 }));
  const withFormula = { ...grid.grid, snapshot: { ...grid.grid.snapshot, rows: grid.grid.snapshot.rows.map((r) => [...r]) } };
  withFormula.snapshot.rows[1]![grid.grid.columns.Score] = cellOf({ formula: '=5', value: 5 });
  const index = indexFilms(libraryOf(movie({ id: 1, lastWatchedAt: watchedOn(40000), rating: 9, runtime: 90 })));
  const { plan: p } = planFilms(withFormula, index, new Map(), { ...OPTS, baseline, seed: observeFilms(index) });
  assert.equal(p.edits.length, 0);
  assert.equal(p.skips.find((s) => s.code === 'formula-cell')?.code, 'formula-cell');
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

test('a row for a film in no list at all is reported once', () => {
  const { plan: p } = plan([film('a', { id: 404 })], [movie({ id: 1 })], {});
  assert.equal(p.edits.length, 0);
  assert.equal(p.skips.find((s) => s.code === 'unknown-id')?.code, 'unknown-id');
});

test('a row the library holds under another type is silent, not unknown', () => {
  // The 22 anime films on the tab arrive under SIMKL's `anime` category and so
  // are in no film list. They belong to the show half, and a skip apiece every
  // poll would bury the rows that really are unaccounted for.
  const { plan: p } = plan([film('a', { id: 404 })], [movie({ id: 1 })], { held: new Set([404]) });
  assert.deepEqual(p.skips.filter((s) => s.code === 'unknown-id'), []);
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
  const { plan: p, demands } = plan([film('a', { id: 1 })], [movie({ id: 1 }), movie({ id: 2, tmdb: '550', lastWatchedAt: watchedOn(TODAY - 1) })]);
  assert.equal(p.insert, null);
  assert.deepEqual(demands.map((d) => [d.id, d.tmdbId]), [[2, 550]]);
  assert.equal(p.skips.find((s) => s.code === 'awaiting-lookup')?.code, 'awaiting-lookup');
});

test('a film whose row can never be built is not looked up', () => {
  // No lookup changes an undated watch or a full tab, so neither earns one:
  // a full tab is a standing state, and paying TMDB for it would be a burst
  // of lookups every poll for as long as it stands.
  const undated = plan([film('a', { id: 1 })], [movie({ id: 1 }), movie({ id: 2, tmdb: '550' })]);
  assert.deepEqual(undated.demands, []);
  assert.equal(undated.plan.skips.find((s) => s.code === 'unusable-value')?.code, 'unusable-value');

  const grid = filmGrid(film('a', { id: 1 }));
  const full = { ...grid.grid, snapshot: { ...grid.grid.snapshot, rowCount: grid.grid.rows.length + 1 } };
  const index = indexFilms(libraryOf(movie({ id: 1 }), movie({ id: 2, tmdb: '550', lastWatchedAt: watchedOn(TODAY - 1) })));
  const { demands } = planFilms(full, index, new Map(), { ...OPTS, seed: observeFilms(index) });
  assert.deepEqual(demands, []);
});

test('a rejected TMDB credential names the films waiting on it once, and files none as unbuildable', () => {
  const { plan: p, demands } = plan(
    [film('a', { id: 1 })],
    [movie({ id: 1 }), movie({ id: 2, tmdb: '550', lastWatchedAt: watchedOn(TODAY - 1) }), movie({ id: 3, tmdb: '551', lastWatchedAt: watchedOn(TODAY - 2) })],
    { lookupsRejected: true },
  );
  assert.deepEqual(demands, []);
  assert.deepEqual(p.skips.filter((s) => s.code === 'awaiting-lookup'), []);
  assert.equal(p.notes.filter((n) => /rejected the credential/.test(n)).length, 1);
  assert.match(p.notes.join(' '), /2 film\(s\) need a TMDB lookup/);
  assert.equal(p.notes.some((n) => /has no TMDB record/.test(n)), false);
});

test('a film TMDB has no record of is named once, not demanded every poll', () => {
  const known = new Map<number, FilmFacts | null>([[2, null]]);
  const { plan: p, demands } = plan([film('a', { id: 1 })], [movie({ id: 1 }), movie({ id: 2, title: 'Obscure', lastWatchedAt: watchedOn(TODAY - 1) })], { known });
  assert.equal(p.insert, null);
  assert.deepEqual(demands, []);
  assert.match(p.notes.join(' '), /Obscure .* has no TMDB record/);
});

test('a film SIMKL carries no TMDB id for is handed up, not demanded', () => {
  const { demands, unidentifiable } = plan([film('a', { id: 1 })], [movie({ id: 1 }), movie({ id: 2, title: 'No Id', tmdb: null, lastWatchedAt: watchedOn(TODAY - 1) })]);
  // Nothing to look it up by, so no request — and the caller reports it once
  // rather than the plan carrying a line every pass of every poll.
  assert.deepEqual(demands, []);
  assert.deepEqual(unidentifiable.map((f) => f.id), [2]);
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

test('a row someone started by hand is not given a second row beneath it', () => {
  // The parse keeps a row carrying only a name so the sync can see it; `onTab`
  // is keyed by id, so the name is the only handle on one that has none yet.
  const started = rawFilm('started', ['Dune: Part Two', null, null, null, null, null, null, null, null, null, null, null, null, null]);
  const known = new Map<number, FilmFacts | null>([[991, facts()]]);
  const { plan: p } = plan([started], [movie({ id: 991, title: 'Dune: Part Two', lastWatchedAt: watchedOn(TODAY - 1) })], { known });
  assert.equal(p.insert, null);
  // And said, not silently dropped: the match is by title, which is a
  // heuristic, and a hand row holds back every film of that title until its
  // id is typed. Only the report tells the operator which row to link.
  const skip = p.skips.find((s) => s.code === 'unlinked-row');
  assert.equal(skip?.row, 1);
  assert.match(skip?.reason ?? '', /Dune: Part Two \(991\): row 2 holds that title and no id/);
});

test('a hand-typed title Sheets stored as a number still holds its film back', () => {
  // "1917", "300" and "2012" are real film titles, and Sheets stores each as a
  // number. Read as text only, such a row would be nameless, and the film it
  // was started for would get a second row beneath it.
  const started = rawFilm('started', [1917, null, null, null, null, null, null, null, null, null, null, null, null, null]);
  const known = new Map<number, FilmFacts | null>([[991, facts()]]);
  const { plan: p } = plan([started], [movie({ id: 991, title: '1917', lastWatchedAt: watchedOn(TODAY - 1) })], { known });
  assert.equal(p.insert, null);
  assert.equal(p.skips.find((s) => s.code === 'unlinked-row')?.row, 1);
});

test('a film with no row left on the tab is named, not planned', () => {
  // A guard refusal is whole-plan, so a full tab would stop every followed
  // column on every other row until someone extended the grid.
  const grid = filmGrid(film('a', { id: 1 }));
  const full = { ...grid.grid, snapshot: { ...grid.grid.snapshot, rowCount: grid.grid.rows.length + 1 } };
  const index = indexFilms(libraryOf(movie({ id: 1 }), movie({ id: 2, title: 'No Room', lastWatchedAt: watchedOn(TODAY - 1) })));
  const known = new Map<number, FilmFacts | null>([[2, facts()]]);
  const { plan: p } = planFilms(full, index, known, { ...OPTS, seed: observeFilms(index) });
  assert.equal(p.insert, null);
  assert.match(p.notes.join(' '), /no row left for 1 film\(s\), No Room/);
});

test('a cold start asks about a bounded number of films, not all of them', () => {
  // Only one row lands per run, so a larger burst buys nothing — and costs a
  // request per unlisted film on every restart, inside a run whose snapshot
  // goes stale at 120s. It also bounds what a standing TMDB failure costs,
  // since a failed lookup records nothing and is asked again next poll.
  const many = Array.from({ length: 40 }, (_, i) => movie({ id: 100 + i, lastWatchedAt: watchedOn(TODAY - i - 1) }));
  const { plan: p, demands } = plan([film('a', { id: 1 })], [movie({ id: 1 }), ...many]);
  assert.equal(demands.length, MAX_LOOKUPS_PER_PASS);
  assert.equal(p.insert, null, 'and nothing is inserted until one of them answers');
  // Oldest-first still, so the queue drains in the order the tab reads.
  assert.deepEqual(demands.map((d) => d.id), [139, 138, 137, 136, 135, 134, 133, 132]);
});

// --- Placing an anime film ---------------------------------------------------

test('an anime film with no row anywhere is inserted, and marked as one', () => {
  const known = new Map<number, FilmFacts | null>([[2, facts()]]);
  const { plan: p } = plan(
    [film('a', { id: 1 })],
    [movie({ id: 1 }), animeFilm({ id: 2, title: 'Spirited Away', lastWatchedAt: watchedOn(TODAY - 2), runtime: 125 })],
    { known },
  );
  assert.equal(p.insert?.id, 2);
  const filled = Object.fromEntries(p.insert!.fill.map((c) => [c.field, c.value]));
  // Only ever `true`, the way `Cinema` is: the tab spells "no" as no cell.
  assert.deepEqual(filled.Anime, { boolValue: true });
  assert.deepEqual(filled.Runtime, { numberValue: 125 });
});

test('an ordinary film is not marked as anime', () => {
  const known = new Map<number, FilmFacts | null>([[2, facts()]]);
  const { plan: p } = plan([film('a', { id: 1 })], [movie({ id: 1 }), movie({ id: 2, lastWatchedAt: watchedOn(TODAY - 2) })], { known });
  assert.equal(p.insert?.id, 2);
  assert.equal(p.insert!.fill.some((c) => c.field === 'Anime'), false);
});

test('an anime film already on the show grid stays there rather than gaining a second row', () => {
  // The sheet's own placement is the only thing that answers this: nothing in
  // the record says whether a film belongs here or embedded in a `Sheet1`
  // block, and a wrong insert is a duplicate row on the one tab that already
  // holds legitimate cross-tab duplicates.
  const known = new Map<number, FilmFacts | null>([[2, facts()]]);
  const { plan: p } = plan(
    [film('a', { id: 1 })],
    [movie({ id: 1 }), animeFilm({ id: 2, lastWatchedAt: watchedOn(TODAY - 2) })],
    { known, onShowGrid: new Set([2]) },
  );
  assert.equal(p.insert, null);
  // And silently: everything past the insert filter reports, so gating after it
  // would trade the show half's "add it by hand" line for this half's.
  assert.deepEqual(p.notes, []);
});

test('a film on the show grid is placed anyway when it is not anime', () => {
  // An ordinary film sharing an id with a `Sheet1` row is not a placement
  // question — the rule is about anime only, and a wider gate would silently
  // stop inserting films whose id happens to collide.
  const known = new Map<number, FilmFacts | null>([[2, facts()]]);
  const { plan: p } = plan([film('a', { id: 1 })], [movie({ id: 1 }), movie({ id: 2, lastWatchedAt: watchedOn(TODAY - 2) })], {
    known,
    onShowGrid: new Set([2]),
  });
  assert.equal(p.insert?.id, 2);
});

test('no show grid this poll inserts no anime film, and no lookup is asked for it', () => {
  // Fails closed: the placement rule cannot be evaluated, so waiting a poll is
  // the cheap answer and a duplicate row is the standing one.
  const { plan: p, demands } = plan(
    [film('a', { id: 1 })],
    [movie({ id: 1 }), animeFilm({ id: 2, lastWatchedAt: watchedOn(TODAY - 2) })],
    { onShowGrid: null },
  );
  assert.equal(p.insert, null);
  assert.deepEqual(p.notes, []);
  assert.deepEqual(demands, []);
});

test('no show grid still inserts an ordinary film', () => {
  const known = new Map<number, FilmFacts | null>([[2, facts()]]);
  const { plan: p } = plan([film('a', { id: 1 })], [movie({ id: 1 }), movie({ id: 2, lastWatchedAt: watchedOn(TODAY - 2) })], {
    known,
    onShowGrid: null,
  });
  assert.equal(p.insert?.id, 2);
});

test('a gated anime film with a row of its own is still followed', () => {
  // The gate governs insertion only. Thirteen anime films hold a row on both
  // tabs, and each is an ordinary row of this tab's whose watch date, score and
  // runtime follow SIMKL like any other.
  const baseline: Baseline = new Map([[movieKey(2), { Score: '5' }]]);
  const { plan: p } = plan(
    [film('a', { id: 1 }), film('b', { id: 2, score: 5 })],
    [movie({ id: 1 }), animeFilm({ id: 2, rating: 9 })],
    { baseline, onShowGrid: new Set([2]) },
  );
  assert.deepEqual(
    p.edits.map((e) => [e.field, e.value]),
    [['Score', { numberValue: 9 }]],
  );
});
