import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexArtwork, showBannerColumn, summarise, type IndexInput } from '../../src/artwork/1-index.ts';
import { parseGrid } from '../../src/sheet/2-grid.ts';
import { parseMovieGrid } from '../../src/sheet/movies/2-grid.ts';
import type { SheetRunRecord } from '../../src/sheet/io/journal.ts';
import { daysAgo, filmRow, libraryOf, MOVIE_SHEET_HEADERS, seasonRow, SHEET_HEADERS, sheetSnapshot, showRow, type CellSpec } from '../helpers.ts';

const BUCKETS = { movie: 'movies-bucket', show: 'shows-bucket' };
const SHOW_LINK = (key: string) => `https://storage.googleapis.com/shows-bucket/${key}`;
const MOVIE_LINK = (key: string) => `https://storage.googleapis.com/movies-bucket/${key}`;

/** A show block: the show row with a `Banner` cell, then season rows. */
const block = (title: string, id: number | null, banner: CellSpec, ...seasons: CellSpec[][]): CellSpec[][] => [
  [...showRow(title, 'Ended', id), banner],
  ...seasons.map((s) => [...s, null]),
];

const stored = (movie: string[], show: string[]) => ({
  movie: new Map(movie.map((k) => [k, { size: 1, updated: Temporal.Instant.from('2026-08-01T00:00:00Z') }])),
  show: new Map(show.map((k) => [k, { size: 1, updated: Temporal.Instant.from('2026-08-01T00:00:00Z') }])),
});

const run = (over: Partial<SheetRunRecord>): SheetRunRecord => ({ at: daysAgo(3), status: 'applied', mode: 'apply', edits: [], inserts: [], error: null, repeats: 1, ...over });

const input = (over: Partial<IndexInput> = {}): IndexInput => ({
  shows: null,
  films: null,
  library: null,
  runs: [],
  stored: stored([], []),
  buckets: BUCKETS,
  ...over,
});

test('the show tab\'s Banner column is resolved apart from the sync\'s headers, and its absence degrades', () => {
  const withBanner = parseGrid(sheetSnapshot([[...SHEET_HEADERS, 'Banner'], ...block('Severance', 1, null)]));
  assert.equal(showBannerColumn(withBanner), SHEET_HEADERS.length);
  const without = parseGrid(sheetSnapshot([SHEET_HEADERS, showRow('Severance', 'Ended', 1)]));
  assert.equal(showBannerColumn(without), null);
  const [title] = indexArtwork(input({ shows: without }), { timezone: 'Europe/London' });
  assert.equal(title?.address, null);
  assert.equal(title?.state, 'unlinked');
});

test('every cell kind has a state, and the key follows the cell where it links the bucket', () => {
  const shows = parseGrid(
    sheetSnapshot([
      [...SHEET_HEADERS, 'Banner'],
      ...block('Done', 1, { formula: '=CONCAT($Z$2,A2)', value: SHOW_LINK('Done') }),
      ...block('Missing', 2, SHOW_LINK('Missing')),
      ...block('Typo', 3, SHOW_LINK('Typoo')),
      ...block('Blank', 4, null),
      ...block('Foreign', 5, 'https://artworks.thetvdb.com/x.jpg'),
      ...block('Proxy', 9, 'https://wsrv.nl/?url=x'),
      ...block('Formula Elsewhere', 6, { formula: '=CONCAT($Z$2,A7)', value: 'Formula Elsewhere' }),
      ...block('Text', 7, 'ask'),
      ...block('No Id', null, null, seasonRow(1, 3, null)),
    ]),
  );
  const titles = indexArtwork(input({ shows, stored: stored([], ['Done', 'Typoo']) }), { timezone: 'Europe/London' });
  const byTitle = Object.fromEntries(titles.map((t) => [t.title, t]));
  assert.equal(byTitle['Done']?.state, 'done');
  assert.equal(byTitle['Done']?.cell.kind, 'formula');
  assert.equal(byTitle['Missing']?.state, 'missing-object');
  assert.equal(byTitle['Typo']?.state, 'done');
  assert.equal(byTitle['Typo']?.key, 'Typoo', 'the cell decides the key');
  assert.equal(byTitle['Blank']?.state, 'unlinked');
  assert.equal(byTitle['Blank']?.key, 'Blank');
  assert.equal(byTitle['Foreign']?.state, 'adopt');
  assert.equal(byTitle['Proxy']?.state, 'unrecognised', 'a link on a host the page cannot fetch from is not adoptable');
  assert.equal(byTitle['Formula Elsewhere']?.state, 'unrecognised');
  assert.equal(byTitle['Text']?.state, 'unrecognised');
  assert.equal(byTitle['No Id']?.state, 'no-id');
  assert.equal(byTitle['No Id']?.id, null);
  assert.equal(byTitle['Done']?.address, 'K2');
});

test('a show\'s franchise comes from its own tab\'s column, and a tab without one degrades', () => {
  const withColumn = parseGrid(sheetSnapshot([[...SHEET_HEADERS, 'Banner', 'Franchise'], [...showRow('Loki', 'Ended', 1), null, 'Marvel']]));
  const [loki] = indexArtwork(input({ shows: withColumn }), { timezone: 'Europe/London' });
  assert.equal(loki?.franchise, 'Marvel');
  assert.equal(loki?.context, 'Ended');
  assert.equal(loki?.releasedOn, null);
  const without = parseGrid(sheetSnapshot([[...SHEET_HEADERS, 'Banner'], ...block('Loki', 1, null)]));
  assert.equal(indexArtwork(input({ shows: without }), { timezone: 'Europe/London' })[0]?.franchise, null);
});

test('a cour block is keyed by its first season row\'s id, and a duplicated id is no id', () => {
  const shows = parseGrid(
    sheetSnapshot([
      [...SHEET_HEADERS, 'Banner'],
      ...block('Cour Show', null, null, seasonRow(1, 12, 45000, { id: 11 }), seasonRow(1, 12, 45001, { id: 12 })),
      ...block('Twice A', 20, null),
      ...block('Twice B', 20, null),
    ]),
  );
  const titles = indexArtwork(input({ shows, library: libraryOf({ id: 11, title: 'Cour Show', tvdb: '371980' }) }), { timezone: 'Europe/London' });
  const cour = titles.find((t) => t.title === 'Cour Show');
  assert.equal(cour?.id, 11);
  assert.equal(cour?.providerId, 371980);
  assert.deepEqual(
    titles.filter((t) => t.title.startsWith('Twice')).map((t) => t.state),
    ['no-id', 'no-id'],
  );
});

test('films take their provider id from the library and their franchise from the tab', () => {
  const films = parseMovieGrid(
    sheetSnapshot([
      MOVIE_SHEET_HEADERS,
      filmRow({ name: 'Finding Nemo', id: '100', franchise: 'Pixar', released: 37904, banner: MOVIE_LINK('Finding Nemo') }),
      filmRow({ name: 'Unfiled', id: '101', banner: null }),
      filmRow({ name: 'Old Way', id: '102', banner: 'https://image.tmdb.org/t/p/w1280/x.jpg' }),
      filmRow({ name: 'Anime Film', id: '104', banner: null }),
      filmRow({ name: 'Dupe', id: '103' }),
      filmRow({ name: 'Dupe Again', id: '103' }),
      filmRow({ name: 'No Id Yet', id: null }),
    ]),
  );
  const titles = indexArtwork(
    input({
      films,
      library: libraryOf({ id: 100, type: 'movies', tmdb: '12' }, { id: 101, type: 'movies', tmdb: null }, { id: 104, type: 'anime', animeType: 'movie', tmdb: '77' }),
      stored: stored(['Finding Nemo'], []),
    }),
    { timezone: 'Europe/London' },
  );
  const byTitle = Object.fromEntries(titles.map((t) => [t.title, t]));
  assert.equal(byTitle['Finding Nemo']?.state, 'done');
  assert.equal(byTitle['Finding Nemo']?.providerId, 12);
  assert.equal(byTitle['Finding Nemo']?.franchise, 'Pixar');
  assert.equal(byTitle['Finding Nemo']?.releasedOn?.toString(), '2003-10-10');
  assert.equal(byTitle['Finding Nemo']?.context, null);
  assert.equal(byTitle['Finding Nemo']?.address, 'N2');
  assert.equal(byTitle['Unfiled']?.state, 'unlinked');
  assert.equal(byTitle['Unfiled']?.providerId, null);
  assert.equal(byTitle['Old Way']?.state, 'adopt');
  // An anime film is a show record with a film's shape; its TMDB id sits under `show`.
  assert.equal(byTitle['Anime Film']?.providerId, 77);
  assert.deepEqual([byTitle['Dupe']?.state, byTitle['Dupe Again']?.state, byTitle['No Id Yet']?.state], ['no-id', 'no-id', 'no-id']);
});

// The page is a work queue: what needs doing first, newest first within that.
test('titles sort needs-first, then by when they were last touched, then by name', () => {
  const films = parseMovieGrid(
    sheetSnapshot([
      MOVIE_SHEET_HEADERS,
      filmRow({ name: 'Done Old', id: '1', watched: 44000, banner: MOVIE_LINK('Done Old') }),
      filmRow({ name: 'Needs Old', id: '2', watched: 44000, banner: null }),
      filmRow({ name: 'Needs New', id: '3', watched: 46000, banner: null }),
      filmRow({ name: 'Needs Inserted', id: '4', watched: 44000, banner: MOVIE_LINK('Needs Inserted') }),
      filmRow({ name: 'Done New', id: '5', watched: 46000, banner: MOVIE_LINK('Done New') }),
      filmRow({ name: 'Needs Undated B', id: '6', watched: null, banner: null }),
      filmRow({ name: 'Needs Undated A', id: '7', watched: null, banner: null }),
    ]),
  );
  const runs = [run({ tab: 'films', at: daysAgo(1), inserts: [{ address: 'row 5', title: 'Needs Inserted', note: '' }] })];
  const titles = indexArtwork(input({ films, runs, stored: stored(['Done Old', 'Done New'], []) }), { timezone: 'Europe/London' });
  assert.deepEqual(
    titles.map((t) => t.title),
    ['Needs Inserted', 'Needs New', 'Needs Old', 'Needs Undated A', 'Needs Undated B', 'Done New', 'Done Old'],
  );
  assert.ok(titles[0]?.addedBySync, 'the journal supplies when the sync inserted a row');
  assert.equal(titles[0]?.state, 'missing-object');
});

// The journal is read for order only, and per tab: a show and a film of the
// same name are inserted by different halves.
// A reported or refused run records the insert it planned and did not make,
// and a page write is not a sync run; neither is "added by the sync".
test('only an applied sync run counts as the sync adding a row', () => {
  const films = parseMovieGrid(sheetSnapshot([MOVIE_SHEET_HEADERS, filmRow({ name: 'Planned', id: '1' }), filmRow({ name: 'Linked', id: '2' })]));
  const runs = [
    run({ tab: 'films', status: 'reported', mode: 'report', inserts: [{ address: 'row 2', title: 'Planned', note: '' }] }),
    run({ tab: 'films', status: 'applied', source: 'artwork', inserts: [{ address: 'row 3', title: 'Linked', note: '' }] }),
  ];
  const titles = indexArtwork(input({ films, runs }), { timezone: 'Europe/London' });
  assert.deepEqual(
    titles.map((t) => [t.title, t.addedBySync]),
    [
      ['Linked', null],
      ['Planned', null],
    ],
  );
});

test('an insert is matched to a title on its own tab', () => {
  const shows = parseGrid(sheetSnapshot([[...SHEET_HEADERS, 'Banner'], ...block('Twin', 1, null)]));
  const films = parseMovieGrid(sheetSnapshot([MOVIE_SHEET_HEADERS, filmRow({ name: 'Twin', id: '2' })]));
  const runs = [run({ tab: 'films', inserts: [{ address: 'row 2', title: 'Twin', note: '' }] })];
  const titles = indexArtwork(input({ shows, films, runs }), { timezone: 'Europe/London' });
  assert.equal(titles.find((t) => t.kind === 'movie')?.addedBySync?.toString().slice(0, 4), '2026');
  assert.equal(titles.find((t) => t.kind === 'show')?.addedBySync, null);
});

test('a bucket that could not be listed leaves existence unknown rather than reporting every object missing', () => {
  const films = parseMovieGrid(sheetSnapshot([MOVIE_SHEET_HEADERS, filmRow({ name: 'Linked', id: '1', banner: MOVIE_LINK('Linked') })]));
  const [title] = indexArtwork(input({ films, stored: { movie: null, show: null } }), { timezone: 'Europe/London' });
  assert.equal(title?.stored.exists, null);
  assert.equal(title?.state, 'done');
});

test('the summary counts what the chips show', () => {
  const films = parseMovieGrid(
    sheetSnapshot([
      MOVIE_SHEET_HEADERS,
      filmRow({ name: 'A', id: '1', banner: MOVIE_LINK('A') }),
      filmRow({ name: 'B', id: '2', banner: null }),
      filmRow({ name: 'C', id: '3', banner: 'https://image.tmdb.org/t/p/w1280/x.jpg' }),
      filmRow({ name: 'D', id: null }),
    ]),
  );
  const shows = parseGrid(sheetSnapshot([[...SHEET_HEADERS, 'Banner'], ...block('E', 9, null)]));
  const runs = [
    run({ tab: 'films', at: daysAgo(2), inserts: [{ address: 'row 2', title: 'A', note: '' }] }),
    run({ tab: 'films', at: daysAgo(60), inserts: [{ address: 'row 3', title: 'B', note: '' }] }),
  ];
  const titles = indexArtwork(input({ films, shows, runs, stored: stored(['A'], []) }), { timezone: 'Europe/London' });
  assert.deepEqual(summarise(titles), { total: 5, needing: 3, adoptable: 1, addedRecently: 1, noId: 1, shows: 1, films: 4 });
});
