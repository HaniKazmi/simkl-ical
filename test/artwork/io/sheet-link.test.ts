import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureLink, type LinkRequest } from '../../../src/artwork/io/sheet-link.ts';
import { clearTokenCache } from '../../../src/api/google/auth.ts';
import { sheetRuns } from '../../../src/sheet/io/journal.ts';
import { cellOf, filmRow, MOVIE_SHEET_HEADERS, quiet, SHEET_HEADERS, showRow, withConfig, withFetch, withFreshJournal, type CellSpec } from '../../helpers.ts';
import { CREDENTIAL, fakeSheets, type FakeSheetsOptions } from '../../sheet/fake-sheets.ts';

const MOVIE_BUCKET = 'movies-bucket';
const SHOW_BUCKET = 'shows-bucket';
const NEMO_LINK = 'https://storage.googleapis.com/movies-bucket/Finding Nemo';

const movies = (nemoBanner: CellSpec = null): CellSpec[][] => [
  MOVIE_SHEET_HEADERS,
  filmRow({ name: 'Star Wars', id: '53078', banner: 'https://image.tmdb.org/t/p/w1280/sw.jpg' }),
  [...filmRow({ name: 'Finding Nemo', id: '53080' }).slice(0, -1), nemoBanner],
];

const shows = (banner: CellSpec = null): CellSpec[][] => [
  [...SHEET_HEADERS, 'Banner'],
  [...showRow('Fargo', 'Watching', 3381), banner],
];

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
    withConfig({ sheetId: 'SID', sheetSyncMode: mode, googleKeyBase64: CREDENTIAL, artworkMovieBucket: MOVIE_BUCKET, artworkShowBucket: SHOW_BUCKET }, () =>
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
    assert.deepEqual(outcome, { status: 'written', address: 'N3', key: 'Finding Nemo', link: NEMO_LINK });
    assert.equal(batches(calls).length, 1);
    assert.deepEqual(sheet.batches, [['updateCells']]);
    const films = sheet.tabs.get(2)!;
    assert.equal(films[2]?.[MOVIE_SHEET_HEADERS.indexOf('Banner')]?.userEnteredValue?.stringValue, NEMO_LINK);
    // Both the sync's rows and this one are edits; the note says which this is.
    const [record] = sheetRuns();
    assert.equal(record?.tab, 'films');
    assert.equal(record?.status, 'applied');
    assert.deepEqual(record?.edits.map((e) => [e.address, e.field]), [['N3', 'Banner']]);
    assert.match(record?.edits[0]?.note ?? '', /^artwork: Finding Nemo → /);
  });
});

test('a show row is written in its Banner column, the one column of a show row the page may touch', async () => {
  await run('apply', { grid: shows(null) }, request({ kind: 'show', id: 3381, title: 'Fargo' }), (outcome, sheet) => {
    assert.deepEqual(outcome, { status: 'written', address: 'K2', key: 'Fargo', link: 'https://storage.googleapis.com/shows-bucket/Fargo' });
    assert.equal(sheet.state[1]?.[SHEET_HEADERS.length]?.userEnteredValue?.stringValue, 'https://storage.googleapis.com/shows-bucket/Fargo');
    assert.equal(sheetRuns()[0]?.tab, 'shows');
  });
});

test('report mode decides in full and writes nothing', async () => {
  await run('report', { movies: movies(null) }, request(), (outcome, _sheet, calls) => {
    assert.deepEqual(outcome, { status: 'reported', address: 'N3', key: 'Finding Nemo', link: NEMO_LINK });
    assert.deepEqual(batches(calls), []);
    assert.deepEqual(sheetRuns(), []);
  });
});

test('a formula is never written, whichever way it resolves', async () => {
  await run('apply', { movies: movies({ formula: '=CONCAT($O$1,A3)', value: NEMO_LINK }) }, request({ adopt: true }), (outcome, _sheet, calls) => {
    assert.deepEqual(outcome, { status: 'kept', address: 'N3', key: 'Finding Nemo', link: NEMO_LINK });
    assert.deepEqual(batches(calls), []);
  });
  await run('apply', { movies: movies({ formula: '=CONCAT($O$1,A3)', value: 'Finding Nemo' }) }, request({ adopt: true }), (outcome, _sheet, calls) => {
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
    assert.deepEqual(outcome, { status: 'written', address: 'N4', key: 'Finding Nemo', link: NEMO_LINK });
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
// refused rather than made over whatever is there now.
test('a cell that no longer holds what the page showed is refused', async () => {
  await run('apply', { movies: movies(null) }, request({ expectPrevious: cellOf('https://image.tmdb.org/t/p/w1280/old.jpg') }), (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'cell-changed');
    assert.deepEqual(batches(calls), []);
  });
});

test('a write the verify read does not find is failed, journalled, and not reverted', async () => {
  const meddleMovies = (films: ReturnType<typeof cellOf>[][]) => {
    films[2]![MOVIE_SHEET_HEADERS.indexOf('Banner')] = cellOf('someone else');
  };
  await run('apply', { movies: movies(null), meddleMovies }, request(), (outcome, _sheet, calls) => {
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.status === 'failed' ? outcome.detail : '', /N3 does not hold the link/);
    assert.equal(batches(calls).length, 1, 'no rollback batch');
    assert.equal(sheetRuns()[0]?.status, 'failed');
    assert.match(sheetRuns()[0]?.error ?? '', /N3/);
  });
});

test('a show tab without a Banner column refuses rather than guessing a column', async () => {
  await run('apply', { grid: [SHEET_HEADERS, showRow('Fargo', 'Watching', 3381)] }, request({ kind: 'show', id: 3381, title: 'Fargo' }), (outcome, _sheet, calls) => {
    assert.equal(outcome.status === 'refused' && outcome.reason, 'no-banner-column');
    assert.deepEqual(batches(calls), []);
  });
});
