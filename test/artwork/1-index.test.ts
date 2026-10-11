import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexArtwork, offersSeasons, seasonsToPick, showBannerColumn, summarise, type IndexInput } from '../../src/artwork/1-index.ts';
import { parseGrid } from '../../src/sheet/2-grid.ts';
import { parseBookGrid } from '../../src/sheet/books/2-grid.ts';
import { parseMovieGrid } from '../../src/sheet/movies/2-grid.ts';
import type { SheetRunRecord } from '../../src/sheet/io/journal.ts';
import { BOOK_SHEET_HEADERS, MOVIE_SHEET_HEADERS, SHEET_HEADERS, bookRow, col, daysAgo, filmRow, libraryOf, rowByLabel, seasonRow, sheetSnapshot, showRow, type CellSpec } from '../helpers.ts';

const BUCKETS = { movie: 'movies-bucket', show: 'shows-bucket', book: 'books-bucket' };
const SHOW_LINK = (key: string) => `https://storage.googleapis.com/shows-bucket/${key}`;
const MOVIE_LINK = (key: string) => `https://storage.googleapis.com/movies-bucket/${key}`;

const ARTWORK_COL = col(SHEET_HEADERS, 'Artwork');

/**
 * A show block: the show row with an `Artwork` cell, then season rows. The
 * cell is set directly rather than through `showRow`'s `artwork` option so a
 * formula object can go there too, the way the real sheet's 291 formula rows
 * do.
 */
const block = (title: string, id: number | null, artwork: CellSpec, ...seasons: CellSpec[][]): CellSpec[][] => {
  const show = showRow(title, 'Ended', id);
  show[ARTWORK_COL] = artwork;
  return [show, ...seasons];
};

const objects = (keys: string[]) => new Map(keys.map((k) => [k, { size: 1, updated: Temporal.Instant.from('2026-08-01T00:00:00Z') }]));

const stored = (movie: string[], show: string[], book: string[] = []) => ({
  movie: objects(movie),
  show: objects(show),
  book: objects(book),
});

const run = (over: Partial<SheetRunRecord>): SheetRunRecord => ({ at: daysAgo(3), status: 'applied', mode: 'apply', edits: [], inserts: [], error: null, repeats: 1, ...over });

const input = (over: Partial<IndexInput> = {}): IndexInput => ({
  shows: null,
  films: null,
  books: null,
  library: null,
  runs: [],
  stored: stored([], []),
  buckets: BUCKETS,
  ...over,
});

test('the show tab\'s Artwork column is resolved apart from the sync\'s headers, and its absence degrades', () => {
  const withBanner = parseGrid(sheetSnapshot([SHEET_HEADERS, ...block('Severance', 1, null)]));
  assert.equal(showBannerColumn(withBanner), ARTWORK_COL);
  const noArtwork = SHEET_HEADERS.filter((h) => h !== 'Artwork');
  const without = parseGrid(sheetSnapshot([noArtwork, rowByLabel(noArtwork, { Title: 'Severance', Status: 'Ended', ID: 1, Style: 'Realistic' })]));
  assert.equal(showBannerColumn(without), null);
  const [title] = indexArtwork(input({ shows: without }), { timezone: 'Europe/London' });
  assert.equal(title?.address, null);
  assert.equal(title?.state, 'unlinked');
});

test('every cell kind has a state, and the key follows the cell where it links the bucket', () => {
  const shows = parseGrid(
    sheetSnapshot([
      SHEET_HEADERS,
      ...block('Done', 1, { formula: '=CONCAT("https://storage.googleapis.com/shows-bucket/",A2)', value: SHOW_LINK('Done') }),
      ...block('Missing', 2, SHOW_LINK('Missing')),
      ...block('Typo', 3, SHOW_LINK('Typoo')),
      ...block('Blank', 4, null),
      ...block('Foreign', 5, 'https://artworks.thetvdb.com/x.jpg'),
      ...block('Proxy', 9, 'https://wsrv.nl/?url=x'),
      ...block('Local', 10, 'https://192.168.1.4/x.jpg'),
      ...block('Plain', 11, 'http://example.com/x.jpg'),
      ...block('Formula Elsewhere', 6, { formula: '=CONCAT("https://storage.googleapis.com/shows-bucket/",A99)', value: 'Formula Elsewhere' }),
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
  assert.equal(byTitle['Proxy']?.state, 'adopt', 'any https host is adoptable');
  assert.equal(byTitle['Local']?.state, 'unrecognised', 'a private address is not');
  assert.equal(byTitle['Plain']?.state, 'unrecognised', 'nor is http');
  assert.equal(byTitle['Formula Elsewhere']?.state, 'unrecognised');
  assert.equal(byTitle['Text']?.state, 'unrecognised');
  assert.equal(byTitle['No Id']?.state, 'no-id');
  assert.equal(byTitle['No Id']?.id, null);
  assert.equal(byTitle['Done']?.address, 'Q2');
});

test('a show\'s franchise comes from its own tab\'s column, and a tab without one degrades', () => {
  const withColumn = parseGrid(sheetSnapshot([SHEET_HEADERS, showRow('Loki', 'Ended', 1, 'Realistic', { franchise: 'Marvel' })]));
  const [loki] = indexArtwork(input({ shows: withColumn }), { timezone: 'Europe/London' });
  assert.equal(loki?.franchise, 'Marvel');
  assert.equal(loki?.context, 'Ended');
  assert.equal(loki?.releasedOn, null);
  const noFranchise = SHEET_HEADERS.filter((h) => h !== 'Franchise');
  const without = parseGrid(sheetSnapshot([noFranchise, rowByLabel(noFranchise, { Title: 'Loki', Status: 'Ended', ID: 1, Style: 'Realistic' })]));
  assert.equal(indexArtwork(input({ shows: without }), { timezone: 'Europe/London' })[0]?.franchise, null);
});

test('a cour block is keyed by its first season row\'s id, and a duplicated id is no id', () => {
  const shows = parseGrid(
    sheetSnapshot([
      SHEET_HEADERS,
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
  assert.equal(byTitle['Finding Nemo']?.address, 'P2');
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
  const shows = parseGrid(sheetSnapshot([SHEET_HEADERS, ...block('Twin', 1, null)]));
  const films = parseMovieGrid(sheetSnapshot([MOVIE_SHEET_HEADERS, filmRow({ name: 'Twin', id: '2' })]));
  const runs = [run({ tab: 'films', inserts: [{ address: 'row 2', title: 'Twin', note: '' }] })];
  const titles = indexArtwork(input({ shows, films, runs }), { timezone: 'Europe/London' });
  assert.equal(titles.find((t) => t.kind === 'movie')?.addedBySync?.toString().slice(0, 4), '2026');
  assert.equal(titles.find((t) => t.kind === 'show')?.addedBySync, null);
});

test('a bucket that could not be listed leaves existence unknown rather than reporting every object missing', () => {
  const films = parseMovieGrid(sheetSnapshot([MOVIE_SHEET_HEADERS, filmRow({ name: 'Linked', id: '1', banner: MOVIE_LINK('Linked') })]));
  const [title] = indexArtwork(input({ films, stored: { movie: null, show: null, book: null } }), { timezone: 'Europe/London' });
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
  const shows = parseGrid(sheetSnapshot([SHEET_HEADERS, ...block('E', 9, null)]));
  const runs = [
    run({ tab: 'films', at: daysAgo(2), inserts: [{ address: 'row 2', title: 'A', note: '' }] }),
    run({ tab: 'films', at: daysAgo(60), inserts: [{ address: 'row 3', title: 'B', note: '' }] }),
  ];
  const titles = indexArtwork(input({ films, shows, runs, stored: stored(['A'], []) }), { timezone: 'Europe/London' });
  assert.deepEqual(summarise(titles), {
    total: 5,
    needing: 3,
    addedRecently: 1,
    byState: { done: 1, 'missing-object': 0, unlinked: 2, adopt: 1, cover: 0, 'no-id': 1, unrecognised: 0 },
    byKind: { movie: 4, show: 1, book: 0 },
    seasonsToPick: 0,
  });
});

// --- Season rows -------------------------------------------------------------

/** A season row whose `Artwork` cell holds `artwork`, the way a reader typed it. */
const season = (n: number, artwork: CellSpec, { id }: { id?: number } = {}): CellSpec[] => seasonRow(n, 8, 45010, { id, artwork });

test('a show\'s season rows are read like its own cell, each under its own key', () => {
  const shows = parseGrid(
    sheetSnapshot([
      SHEET_HEADERS,
      ...block(
        'Doctor Who',
        3,
        SHOW_LINK('Doctor Who'),
        season(1, SHOW_LINK('Doctor Who S1')),
        season(1.5, null),
        season(2, SHOW_LINK('Doctor Who S2')),
        season(3, 'https://artworks.thetvdb.com/banners/seasons/3.jpg'),
        season(4, { formula: '=CONCAT("x",A1)', value: 'nothing' }),
        season(14, null, { id: 99 }),
      ),
    ]),
  );
  const [dw] = indexArtwork(input({ shows, stored: stored([], ['Doctor Who', 'Doctor Who S1']) }), { timezone: 'Europe/London' });
  assert.deepEqual(
    dw?.seasons.map((s) => [s.season, s.key, s.state, s.address, s.ownId]),
    [
      [1, 'Doctor Who S1', 'done', 'Q3', null],
      [1.5, 'Doctor Who S1.5', 'unlinked', 'Q4', null],
      [2, 'Doctor Who S2', 'missing-object', 'Q5', null],
      [3, 'Doctor Who S3', 'adopt', 'Q6', null],
      [4, 'Doctor Who S4', 'unrecognised', 'Q7', null],
      [14, 'Doctor Who S14', 'unlinked', 'Q8', 99],
    ],
  );
  // The title's own state is its own cell's, whatever its seasons hold.
  assert.equal(dw?.state, 'done');
});

// 858 of 911 season cells are blank, most of them on purpose: counted as
// needing, they would bury every film and show.
test('season states move no title count, and the season chip counts shows with one left to pick', () => {
  const shows = parseGrid(
    sheetSnapshot([
      SHEET_HEADERS,
      ...block('Two Blank', 1, SHOW_LINK('Two Blank'), season(1, null), season(2, null)),
      ...block('All Linked', 2, SHOW_LINK('All Linked'), season(1, SHOW_LINK('All Linked S1')), season(2, SHOW_LINK('All Linked S2'))),
      ...block('One Season', 3, SHOW_LINK('One Season'), season(1, null)),
      ...block('One Linked', 4, SHOW_LINK('One Linked'), season(1, 'https://example.com/x.jpg')),
      ...block('No Id', null, null, season(1, null), season(2, null)),
    ]),
  );
  const titles = indexArtwork(input({ shows, stored: stored([], ['Two Blank', 'All Linked', 'All Linked S1', 'All Linked S2', 'One Season', 'One Linked']) }), { timezone: 'Europe/London' });
  const summary = summarise(titles);
  assert.equal(summary.needing, 0, 'every show row is linked or has no id; the blank seasons count nothing');
  assert.equal(summary.byState.unlinked, 0);
  assert.equal(summary.byState['no-id'], 1);
  // Two Blank has blanks; One Linked is listed for its one season because the
  // cell holds a link, and that link is adoptable. One Season's blank season
  // is offered in its panel but is not the chip's work, and No Id has nothing
  // to write through.
  assert.equal(summary.seasonsToPick, 2);
  const byTitle = Object.fromEntries(titles.map((t) => [t.title, t]));
  assert.equal(seasonsToPick(byTitle['One Season']!), false);
  assert.equal(seasonsToPick(byTitle['One Linked']!), true);
  // The panel opens from one season row: Avatar: Seven Havens is one season in.
  assert.equal(offersSeasons(byTitle['One Season']!), true);
  assert.equal(offersSeasons({ seasons: [] }), false);
  assert.equal(seasonsToPick(byTitle['All Linked']!), false);
  assert.equal(seasonsToPick(byTitle['No Id']!), false);
});

test('a season row with no number has no key and is not listed', () => {
  const unnumbered = seasonRow(1, 8, 45010);
  unnumbered[col(SHEET_HEADERS, 'Season')] = 'TBD';
  const shows = parseGrid(sheetSnapshot([SHEET_HEADERS, ...block('Odd', 1, null, seasonRow(1, 8, 45010), unnumbered)]));
  const [odd] = indexArtwork(input({ shows }), { timezone: 'Europe/London' });
  assert.deepEqual(odd?.seasons.map((s) => s.key), ['Odd S1']);
});

test('films and books carry no seasons', () => {
  const films = parseMovieGrid(sheetSnapshot([MOVIE_SHEET_HEADERS, filmRow({ name: 'A', id: '1' })]));
  assert.deepEqual(indexArtwork(input({ films }), { timezone: 'Europe/London' })[0]?.seasons, []);
});

test('a book indexes off its own tab: the id is the provider id, the author is the context, and no sync ever inserted it', () => {
  const books = parseBookGrid(
    sheetSnapshot([
      BOOK_SHEET_HEADERS,
      bookRow({ name: '1984', author: 'George Orwell', id: 379760, franchise: '1984', released: 18057, ended: 40061, banner: 'https://wsrv.nl/?url=https://assets.hardcover.app/a.jpg' }),
    ]),
  );
  // A journal record for the books tab exists and still must not count: no
  // sync inserts here, so "added by the sync" can never be true of a book.
  const runs = [run({ tab: 'books', at: daysAgo(1), inserts: [{ address: 'row 2', title: '1984', note: '' }] })];
  const [book] = indexArtwork(input({ books, runs }), { timezone: 'Europe/London' });
  assert.equal(book?.kind, 'book');
  assert.equal(book?.id, 379760);
  // One number, not two: the `ID` cell is a Hardcover id and Hardcover is the
  // upstream, so nothing is resolved on demand the way a show's TVDB id is.
  assert.equal(book?.providerId, 379760);
  assert.equal(book?.context, 'George Orwell');
  assert.equal(book?.franchise, '1984');
  assert.equal(book?.addedBySync, null);
  assert.equal(book?.releasedOn?.toString(), '1949-06-08');
  // Every live cell on the tab links a Hardcover cover, most of them the one
  // this page exists to replace, so a linked book is a cover it holds rather
  // than artwork the row needs.
  assert.equal(book?.state, 'cover');
});

test('a book is dated by when it was finished, and by when it was started while it is still being read', () => {
  const books = (spec: { started?: number | null; ended?: number | null }) =>
    parseBookGrid(sheetSnapshot([BOOK_SHEET_HEADERS, bookRow({ id: 1, ...spec })]));
  const dayOf = (grid: ReturnType<typeof parseBookGrid>) =>
    indexArtwork(input({ books: grid }), { timezone: 'Europe/London' })[0]?.recentAt?.toZonedDateTimeISO('Europe/London').toPlainDate().toString();
  assert.equal(dayOf(books({ started: 40056, ended: 40061 })), '2009-09-05');
  assert.equal(dayOf(books({ started: 40056, ended: null })), '2009-08-31');
  assert.equal(dayOf(books({ started: null, ended: null })), undefined);
});

test('a book on two rows cannot be picked for, and a linked book cover is not adoptable', () => {
  const books = parseBookGrid(
    sheetSnapshot([
      BOOK_SHEET_HEADERS,
      bookRow({ name: 'Twice A', id: 7, banner: 'https://wsrv.nl/?url=https://assets.hardcover.app/a.jpg' }),
      bookRow({ name: 'Twice B', id: 7, banner: 'https://wsrv.nl/?url=https://assets.hardcover.app/b.jpg' }),
      bookRow({ name: 'Fine', id: 8, banner: 'https://wsrv.nl/?url=https://assets.hardcover.app/c.jpg' }),
    ]),
  );
  const films = parseMovieGrid(sheetSnapshot([MOVIE_SHEET_HEADERS, filmRow({ name: 'F', id: '1', banner: 'https://image.tmdb.org/t/p/w1280/x.jpg' })]));
  const titles = indexArtwork(input({ books, films }), { timezone: 'Europe/London' });
  assert.deepEqual(
    titles.filter((t) => t.kind === 'book').map((t) => [t.title, t.state]),
    [
      ['Fine', 'cover'],
      ['Twice A', 'no-id'],
      ['Twice B', 'no-id'],
    ],
  );
  const summary = summarise(titles);
  assert.equal(summary.byKind.book, 3);
  // The one linked cover is what the "Covers to pick" chip counts; a row with no id has no cover to pick.
  assert.equal(summary.byState.cover, 1);
  // Only the film: adopting a book copies the cover this page exists to
  // replace, so the one count the chip and the bulk button read leaves it out.
  assert.equal(summary.byState.adopt, 1);
});

test('a linked book cover neither counts as needing artwork nor sorts ahead of a film that does', () => {
  // Titled so the alphabetical tiebreak would put the book first: only the
  // needs-first rule puts the film ahead of it.
  const books = parseBookGrid(sheetSnapshot([BOOK_SHEET_HEADERS, bookRow({ name: 'Anathem', id: 8, banner: 'https://wsrv.nl/?url=https://assets.hardcover.app/c.jpg' })]));
  const films = parseMovieGrid(sheetSnapshot([MOVIE_SHEET_HEADERS, filmRow({ name: 'Zodiac', id: '1', banner: 'https://image.tmdb.org/t/p/w1280/x.jpg' })]));
  const titles = indexArtwork(input({ books, films }), { timezone: 'Europe/London' });
  assert.deepEqual(
    titles.map((t) => [t.title, t.state]),
    [
      ['Zodiac', 'adopt'],
      ['Anathem', 'cover'],
    ],
  );
  assert.equal(summarise(titles).needing, 1);
});
