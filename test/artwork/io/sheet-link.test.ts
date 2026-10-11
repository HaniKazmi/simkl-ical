import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureLink, type LinkRequest } from '../../../src/artwork/io/sheet-link.ts';
import { clearTokenCache } from '../../../src/api/google/auth.ts';
import { sheetRuns } from '../../../src/sheet/io/journal.ts';
import { BOOK_SHEET_HEADERS, bookRow, cellOf, col, filmRow, MOVIE_SHEET_HEADERS, quiet, seasonRow, SHEET_HEADERS, showRow, withConfig, withFetch, withFreshJournal, type CellSpec } from '../../helpers.ts';
import { CREDENTIAL, fakeSheets, type FakeSheetsOptions } from '../../sheet/fake-sheets.ts';

const MOVIE_BUCKET = 'movies-bucket';
const BOOK_BUCKET = 'books-bucket';
const SHOW_BUCKET = 'shows-bucket';
const NEMO_LINK = 'https://storage.googleapis.com/movies-bucket/Finding Nemo';

const MOVIE_ARTWORK_COL = col(MOVIE_SHEET_HEADERS, 'Artwork');
const SHOW_ARTWORK_COL = col(SHEET_HEADERS, 'Artwork');

const movies = (nemoBanner: CellSpec = null): CellSpec[][] => {
  const nemo = filmRow({ name: 'Finding Nemo', id: '53080' });
  nemo[MOVIE_ARTWORK_COL] = nemoBanner;
  return [MOVIE_SHEET_HEADERS, filmRow({ name: 'Star Wars', id: '53078', banner: 'https://image.tmdb.org/t/p/w1280/sw.jpg' }), nemo];
};

const shows = (banner: string | null = null): CellSpec[][] => [SHEET_HEADERS, showRow('Fargo', 'Watching', 3381, 'Realistic', { artwork: banner })];

const request = (over: Partial<LinkRequest> = {}): LinkRequest => ({ kind: 'movie', id: 53080, title: 'Finding Nemo', adopt: false, expectPrevious: cellOf(null), ...over });

const run = async (
  mode: 'report' | 'apply',
  options: FakeSheetsOptions,
  req: LinkRequest,
  assertions: (outcome: Awaited<ReturnType<typeof ensureLink>>, sheet: ReturnType<typeof fakeSheets>, calls: string[]) => void | Promise<void>,
) => {
  clearTokenCache();
  const sheet = fakeSheets(options);
  await withFreshJournal(() =>
    withConfig({ sheetId: 'SID', sheetSyncMode: mode, googleKeyBase64: CREDENTIAL, artworkMovieBucket: MOVIE_BUCKET, artworkShowBucket: SHOW_BUCKET, booksSheetName: 'Books', artworkBookBucket: BOOK_BUCKET }, () =>
      withFetch(sheet.handler, async (calls) => {
        const outcome = await ensureLink(req, { log: quiet });
        await assertions(outcome, sheet, calls);
      }),
    ),
  );
};

const batches = (calls: string[]) => calls.filter((c) => c.includes(':batchUpdate'));

test('a blank cell is written once, verified, and journalled as a Banner edit', async () => {
  await run('apply', { movies: movies(null) }, request(), (outcome, sheet, calls) => {
    assert.deepEqual(outcome, { status: 'written', address: 'P3', key: 'Finding Nemo', link: NEMO_LINK });
    assert.equal(batches(calls).length, 1);
    assert.deepEqual(sheet.batches, [['updateCells']]);
    const films = sheet.tabs.get(2)!;
    assert.equal(films[2]?.[MOVIE_ARTWORK_COL]?.userEnteredValue?.stringValue, NEMO_LINK);
    // Both the sync's rows and this one are edits; the note says which this is.
    const [record] = sheetRuns();
    assert.equal(record?.tab, 'films');
    assert.equal(record?.status, 'applied');
    assert.deepEqual(record?.edits.map((e) => [e.address, e.field]), [['P3', 'Artwork']]);
    assert.equal(record?.edits[0]?.note, 'artwork: Finding Nemo');
  });
});

test('a show row is written in its Banner column, the one column of a show row the page may touch', async () => {
  await run('apply', { grid: shows(null) }, request({ kind: 'show', id: 3381, title: 'Fargo' }), (outcome, sheet) => {
    assert.deepEqual(outcome, { status: 'written', address: 'Q2', key: 'Fargo', link: 'https://storage.googleapis.com/shows-bucket/Fargo' });
    assert.equal(sheet.state[1]?.[SHOW_ARTWORK_COL]?.userEnteredValue?.stringValue, 'https://storage.googleapis.com/shows-bucket/Fargo');
    assert.equal(sheetRuns()[0]?.tab, 'shows');
  });
});

test('report mode decides in full and writes nothing', async () => {
  await run('report', { movies: movies(null) }, request(), (outcome, _sheet, calls) => {
    assert.deepEqual(outcome, { status: 'reported', address: 'P3', key: 'Finding Nemo', link: NEMO_LINK });
    assert.deepEqual(batches(calls), []);
    assert.deepEqual(sheetRuns(), []);
  });
});

test('a formula is never written, whichever way it resolves', async () => {
  const formula = { formula: '=CONCAT("https://storage.googleapis.com/movies-bucket/",A3)', value: NEMO_LINK };
  await run('apply', { movies: movies(formula) }, request({ adopt: true, expectPrevious: cellOf(formula) }), (outcome, _sheet, calls) => {
    assert.deepEqual(outcome, { status: 'kept', address: 'P3', key: 'Finding Nemo', link: NEMO_LINK });
    assert.deepEqual(batches(calls), []);
  });
  await run('apply', { movies: movies({ formula: '=CONCAT("https://storage.googleapis.com/movies-bucket/",A3)', value: 'Finding Nemo' }) }, request({ adopt: true }), (outcome, _sheet, calls) => {
    assert.equal(outcome.status, 'refused');
    assert.equal(outcome.status === 'refused' && outcome.reason, 'formula');
    assert.deepEqual(batches(calls), []);
  });
});

test('a foreign link is replaced only on adopt', async () => {
  const foreign = 'https://image.tmdb.org/t/p/w1280/nemo.jpg';
  await run('apply', { movies: movies(foreign) }, request({ expectPrevious: cellOf(foreign) }), (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'needs-adopt');
    assert.deepEqual(batches(calls), []);
  });
  await run('apply', { movies: movies(foreign) }, request({ adopt: true, expectPrevious: cellOf(foreign) }), (outcome, _sheet, calls) => {
    assert.equal(outcome.status, 'written');
    assert.equal(batches(calls).length, 1);
  });
});

// The row is found again by id under the lock, never by the index's row
// number: rows move between the page's read and the click.
test('a row that moved, went, or was duplicated is refused by id, not written by position', async () => {
  const moved: CellSpec[][] = [MOVIE_SHEET_HEADERS, filmRow({ name: 'Inserted Above', id: '99' }), ...movies(null).slice(1)];
  await run('apply', { movies: moved }, request(), (outcome) => {
    assert.deepEqual(outcome, { status: 'written', address: 'P4', key: 'Finding Nemo', link: NEMO_LINK });
  });
  await run('apply', { movies: movies(null) }, request({ id: 53080, title: 'Star Wars' }), (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'title-moved');
    assert.deepEqual(batches(calls), []);
  });
  await run('apply', { movies: movies(null) }, request({ id: 1 }), (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'not-found');
    assert.deepEqual(batches(calls), []);
  });
  const doubled: CellSpec[][] = [...movies(null), filmRow({ name: 'Finding Nemo (again)', id: '53080' })];
  await run('apply', { movies: doubled }, request(), (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'duplicate');
    assert.deepEqual(batches(calls), []);
  });
});

// The page showed one value; a hand edited the cell since. The write is
// refused rather than made over whatever is there now — and so is a keep:
// the object went up under the key the page's cell implied, and a cell that
// now names another key would be reported done for a link nothing was
// uploaded to.
test('a cell that no longer holds what the page showed is refused, for a keep as for a write', async () => {
  await run('apply', { movies: movies(null) }, request({ expectPrevious: cellOf('https://image.tmdb.org/t/p/w1280/old.jpg') }), (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'cell-changed');
    assert.deepEqual(batches(calls), []);
  });
  const typo = 'https://storage.googleapis.com/movies-bucket/Finding Nemoo';
  await run('apply', { movies: movies(typo) }, request({ expectPrevious: cellOf(null) }), (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'cell-changed');
    assert.deepEqual(batches(calls), []);
  });
});

// The batch is out; a read that fails after it must not say the write did
// not land. The same split the sync's apply protocol makes.
test('a read-back that fails after the write is unverified, not failed', async () => {
  const sheet = fakeSheets({ movies: movies(null) });
  clearTokenCache();
  await withFreshJournal(() =>
    withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL, artworkMovieBucket: MOVIE_BUCKET, artworkShowBucket: SHOW_BUCKET }, () =>
      withFetch(
        (url, init) => {
          if (url.includes(':batchUpdate')) {
            const response = sheet.handler(url, init);
            sheet.stopServing('Movies');
            return response;
          }
          return sheet.handler(url, init);
        },
        async (calls) => {
          const outcome = await ensureLink(request(), { log: quiet });
          assert.equal(outcome.status, 'unverified');
          assert.match(outcome.status === 'unverified' ? outcome.detail : '', /could not be read back after the write/);
          assert.equal(batches(calls).length, 1);
          assert.equal(sheet.films![2]?.[MOVIE_ARTWORK_COL]?.userEnteredValue?.stringValue, NEMO_LINK, 'the write did land');
          assert.equal(sheetRuns()[0]?.status, 'failed');
          assert.equal(sheetRuns()[0]?.source, 'artwork');
          assert.match(sheetRuns()[0]?.error ?? '', /read back/);
        },
      ),
    ),
  );
});

test('a page write is journalled under its own source', async () => {
  await run('apply', { movies: movies(null) }, request(), () => {
    assert.equal(sheetRuns()[0]?.source, 'artwork');
  });
});

test('a write the verify read does not find is failed, journalled, and not reverted', async () => {
  const meddleMovies = (films: ReturnType<typeof cellOf>[][]) => {
    films[2]![MOVIE_ARTWORK_COL] = cellOf('someone else');
  };
  await run('apply', { movies: movies(null), meddleMovies }, request(), (outcome, _sheet, calls) => {
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.status === 'failed' ? outcome.detail : '', /P3 does not hold the link/);
    assert.equal(batches(calls).length, 1, 'no rollback batch');
    assert.equal(sheetRuns()[0]?.status, 'failed');
    assert.match(sheetRuns()[0]?.error ?? '', /P3/);
  });
});

test('a show tab without a Banner column refuses rather than guessing a column', async () => {
  const noArtwork = SHEET_HEADERS.filter((h) => h !== 'Artwork');
  await run('apply', { grid: [noArtwork, showRow('Fargo', 'Watching', 3381).slice(0, noArtwork.length)] }, request({ kind: 'show', id: 3381, title: 'Fargo' }), (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'no-banner-column');
    assert.deepEqual(batches(calls), []);
  });
});

const BOOK_ARTWORK_COL = col(BOOK_SHEET_HEADERS, 'Artwork');
const WSRV = 'https://wsrv.nl/?url=https://assets.hardcover.app/edition/29258002/small.jpg';

const books = (banner: CellSpec = null): CellSpec[][] => {
  const orwell = bookRow({ name: '1984', id: 379760 });
  // Set directly rather than through the spec, so a formula object can go
  // there: only `formulaValue` distinguishes a formula, and a formula target
  // must be refused unconditionally.
  orwell[BOOK_ARTWORK_COL] = banner;
  return [BOOK_SHEET_HEADERS, bookRow({ name: 'Animal Farm', id: 12345 }), orwell];
};

test('a book row is found by its Hardcover id and written on its own tab, into its own bucket', async () => {
  await run(
    'apply',
    { books: books(WSRV) },
    { kind: 'book', id: 379760, title: '1984', adopt: true, expectPrevious: cellOf(WSRV) },
    (outcome, sheet, calls) => {
      assert.equal(outcome.status, 'written');
      assert.equal(outcome.status === 'written' && outcome.link, 'https://storage.googleapis.com/books-bucket/1984');
      // Row 3 of the books tab, not row 2: the row is found by id, never by
      // the index's row number, because rows move.
      assert.equal(outcome.status === 'written' && outcome.address, `${String.fromCharCode(65 + BOOK_ARTWORK_COL)}3`);
      assert.equal(sheet.tab('Books')[2]?.[BOOK_ARTWORK_COL]?.userEnteredValue?.stringValue, 'https://storage.googleapis.com/books-bucket/1984');
      // The films and show tabs are untouched.
      assert.equal(batches(calls).length, 1);
      const record = sheetRuns().at(-1);
      assert.equal(record?.tab, 'books');
      assert.equal(record?.source, 'artwork');
    },
  );
});

test('a book keeps a cell that already links its bucket, and refuses one whose title has moved', async () => {
  await run(
    'apply',
    { books: books('https://storage.googleapis.com/books-bucket/1984') },
    { kind: 'book', id: 379760, title: '1984', adopt: false, expectPrevious: cellOf('https://storage.googleapis.com/books-bucket/1984') },
    (outcome, _sheet, calls) => {
      assert.equal(outcome.status, 'kept');
      assert.equal(batches(calls).length, 0);
    },
  );
  await run(
    'apply',
    { books: books(WSRV) },
    { kind: 'book', id: 379760, title: 'Nineteen Eighty-Four', adopt: true, expectPrevious: cellOf(WSRV) },
    (outcome, _sheet, calls) => {
      assert.equal(outcome.status, 'refused');
      assert.equal(outcome.status === 'refused' && outcome.reason, 'title-moved');
      assert.equal(batches(calls).length, 0);
    },
  );
});

test('a book id on two rows is refused rather than written to either', async () => {
  await run(
    'apply',
    { books: [BOOK_SHEET_HEADERS, bookRow({ name: 'A', id: 7, banner: WSRV }), bookRow({ name: 'B', id: 7, banner: WSRV })] },
    { kind: 'book', id: 7, title: 'A', adopt: true, expectPrevious: cellOf(WSRV) },
    (outcome, _sheet, calls) => {
      assert.equal(outcome.status, 'refused');
      assert.equal(outcome.status === 'refused' && outcome.reason, 'duplicate');
      assert.equal(batches(calls).length, 0);
    },
  );
});

test('a formula in a book\'s Artwork cell is never written, adopt or not', async () => {
  await run(
    'apply',
    { books: books({ formula: '=IMAGE(A3)' }) },
    { kind: 'book', id: 379760, title: '1984', adopt: true, expectPrevious: cellOf({ formula: '=IMAGE(A3)' }) },
    (outcome, _sheet, calls) => {
      assert.equal(outcome.status, 'refused');
      assert.equal(outcome.status === 'refused' && outcome.reason, 'formula');
      assert.equal(batches(calls).length, 0);
    },
  );
});

// --- Season rows ---------------------------------------------------------------

const DW_S7_5 = 'https://storage.googleapis.com/shows-bucket/Doctor Who S7.5';

/** Doctor Who's block: the show row at row 2, then seasons 7, 7.5 and 8 at rows 3–5, each `Artwork` cell as given. */
const doctorWho = (cells: { show?: CellSpec; s7?: CellSpec; s75?: CellSpec; s8?: CellSpec } = {}, extra: CellSpec[][] = []): CellSpec[][] => {
  const show = showRow('Doctor Who', 'Watching', 3381);
  show[SHOW_ARTWORK_COL] = cells.show ?? 'https://storage.googleapis.com/shows-bucket/Doctor Who';
  return [SHEET_HEADERS, show, seasonRow(7, 13, 45000, { artwork: cells.s7 }), seasonRow(7.5, 2, 45001, { artwork: cells.s75 }), seasonRow(8, 12, 45002, { artwork: cells.s8 }), ...extra];
};

const seasonRequest = (over: Partial<LinkRequest> = {}): LinkRequest => ({ kind: 'show', id: 3381, title: 'Doctor Who', adopt: false, expectPrevious: cellOf(null), season: 7.5, ...over });

test('a season is written on its own row, under the season\'s key, and the show row is left alone', async () => {
  await run('apply', { grid: doctorWho() }, seasonRequest(), (outcome, sheet, calls) => {
    assert.deepEqual(outcome, { status: 'written', address: 'Q4', key: 'Doctor Who S7.5', link: DW_S7_5 });
    assert.equal(batches(calls).length, 1);
    assert.equal(sheet.state[3]?.[SHOW_ARTWORK_COL]?.userEnteredValue?.stringValue, DW_S7_5);
    assert.equal(sheet.state[1]?.[SHOW_ARTWORK_COL]?.userEnteredValue?.stringValue, 'https://storage.googleapis.com/shows-bucket/Doctor Who', 'the show row keeps its own link');
    for (const row of [2, 4]) assert.equal(sheet.state[row]?.[SHOW_ARTWORK_COL]?.userEnteredValue, undefined, `row ${row + 1} is untouched`);
    const [record] = sheetRuns();
    assert.deepEqual(record?.edits.map((e) => [e.address, e.field, e.note]), [['Q4', 'Artwork', 'artwork: Doctor Who S7.5']]);
  });
});

// The same checklist a show row's cell meets, against the season row's cell.
test('a season cell already linking the bucket is kept under the key it names, and a foreign one needs adopt', async () => {
  const typo = 'https://storage.googleapis.com/shows-bucket/Doctor%20Who%20S7.5b';
  await run('apply', { grid: doctorWho({ s75: typo }) }, seasonRequest({ expectPrevious: cellOf(typo) }), (outcome, _sheet, calls) => {
    assert.deepEqual(outcome, { status: 'kept', address: 'Q4', key: 'Doctor Who S7.5b', link: typo });
    assert.equal(batches(calls).length, 0);
  });
  const foreign = 'https://image.tmdb.org/t/p/original/x.jpg';
  await run('apply', { grid: doctorWho({ s75: foreign }) }, seasonRequest({ expectPrevious: cellOf(foreign) }), (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'needs-adopt');
    assert.equal(batches(calls).length, 0);
  });
});

test('a season the block does not hold, or holds twice, is refused rather than written', async () => {
  await run('apply', { grid: doctorWho() }, seasonRequest({ season: 9 }), (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'no-season');
    assert.equal(batches(calls).length, 0);
  });
  await run('apply', { grid: doctorWho({}, [seasonRow(7.5, 1, 45003)]) }, seasonRequest(), (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'duplicate-season');
    assert.equal(batches(calls).length, 0);
  });
});

test('a season write meets the show row\'s rules first: the block by id, its title, the cell the page showed', async () => {
  await run('apply', { grid: doctorWho() }, seasonRequest({ title: 'Torchwood' }), (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'title-moved');
    assert.equal(batches(calls).length, 0);
  });
  await run('apply', { grid: doctorWho() }, seasonRequest({ id: 1 }), (outcome) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'not-found');
  });
  await run('apply', { grid: doctorWho({ s75: 'https://example.com/typed-since.jpg' }) }, seasonRequest({ adopt: true }), (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'cell-changed');
    assert.equal(batches(calls).length, 0);
  });
});

test('only a show has season rows', async () => {
  await run('apply', { movies: movies(null) }, request({ season: 1 }), (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'no-season');
    assert.equal(batches(calls).length, 0);
  });
  await run('apply', { books: books(WSRV) }, { kind: 'book', id: 379760, title: '1984', adopt: true, expectPrevious: cellOf(WSRV), season: 1 }, (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'no-season');
    assert.equal(batches(calls).length, 0);
  });
});
