/**
 * Whole-run tests for the films half — the read, the fixpoint, the guard, the
 * write and the verify, against the one in-memory Sheets server.
 *
 * Weighted here and in `5-guard.test.ts` on purpose: a one-row misalignment is
 * the only catastrophic failure this feature has.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SheetSync } from '../../../src/sheet/sync.ts';
import { clearTokenCache } from '../../../src/api/google/auth.ts';
import { sheetRuns } from '../../../src/sheet/io/journal.ts';
import { baseline } from '../../../src/sheet/io/baseline.ts';
import { dateSerial, movieKey } from '../../../src/sheet/values.ts';
import {
  filmRow,
  jsonResponse,
  libraryOf,
  quiet,
  recorder,
  withConfig,
  withFetch,
  withFreshJournal,
  type CellSpec,
  type ItemSpec,
} from '../../helpers.ts';
import { CREDENTIAL, DEFAULT_MOVIES, fakeSheets, type FakeSheetsOptions } from '../fake-sheets.ts';
import type { Library } from '../../../src/library.ts';
import type { CellData } from '../../../src/api/google/types.ts';

// In UTC, the zone every fixture here plans in, and computed without reading
// config — which the suite overrides per test.
const TODAY = dateSerial(Temporal.Now.plainDateISO('UTC'));

/** A TMDB body complete enough to build a row from. */
const TMDB_BODY = {
  title: 'A New Film',
  genres: [{ name: 'Adventure' }, { name: 'Science Fiction' }, { name: 'Animation' }],
  belongs_to_collection: { name: 'A New Film Collection' },
  release_dates: {
    results: [{ iso_3166_1: 'GB', release_dates: [{ type: 3, release_date: '2026-08-20T00:00:00.000Z', certification: '12A' }] }],
  },
  credits: { crew: [{ job: 'Director', name: 'A Director' }] },
  images: { backdrops: [{ file_path: '/a.jpg', iso_639_1: 'en', vote_average: 7 }] },
};

const tmdb = (body: unknown = TMDB_BODY) => () => jsonResponse(body);

const film = (over: Partial<ItemSpec> & { id: number }): ItemSpec => ({ type: 'movies', status: 'completed', ...over });

/** The two films already on the default tab, unchanged since they were recorded. */
const ON_TAB: ItemSpec[] = [
  film({ id: 53078, title: 'Star Wars', lastWatchedAt: '2008-02-09T19:00:00Z', rating: 8, runtime: 121 }),
  film({ id: 53080, title: 'Finding Nemo', lastWatchedAt: '2005-02-12T19:00:00Z', rating: 6, runtime: 100 }),
];

interface Harness {
  /** One poll. Returns its result; the baseline carries over between calls. */
  poll: (library: Library) => Promise<Awaited<ReturnType<SheetSync['run']>>>;
  calls: string[];
  sheet: ReturnType<typeof fakeSheets>;
  log: ReturnType<typeof recorder>;
}

/**
 * Every poll a test makes runs inside **one** `withConfig` block, because that
 * helper clears the baseline: a seed run in a block of its own is wiped before
 * the run meant to compare against it, and every "did this move" assertion
 * would pass vacuously.
 */
const harness = async (
  mode: 'report' | 'apply',
  options: FakeSheetsOptions,
  body: (h: Harness) => void | Promise<void>,
) => {
  clearTokenCache();
  const sheet = fakeSheets({ movies: DEFAULT_MOVIES, tmdb: tmdb(), ...options });
  const log = recorder();
  await withConfig(
    {
      sheetId: 'SID',
      sheetSyncMode: mode,
      googleKeyBase64: CREDENTIAL,
      // Every film fixture here is dated in UTC.
      timezone: 'UTC',
      tmdbApiKey: 'tmdb-token',
      moviesSheetName: 'Movies',
    },
    () =>
      withFetch(sheet.handler, async (calls) => {
        const sync = new SheetSync({ logger: log });
        await body({ poll: (library) => sync.run(library), calls, sheet, log });
      }),
  );
};

/** The common case: one poll, then assertions. */
const run = async (
  mode: 'report' | 'apply',
  options: FakeSheetsOptions,
  library: Library,
  assertions: (
    result: Awaited<ReturnType<SheetSync['run']>>,
    calls: string[],
    sheet: ReturnType<typeof fakeSheets>,
    log: ReturnType<typeof recorder>,
  ) => void | Promise<void>,
) => harness(mode, options, async ({ poll, calls, sheet, log }) => assertions(await poll(library), calls, sheet, log));

/** A library with no shows at all, so only the films half has anything to do. */
const filmsOnly = (...items: ItemSpec[]): Library => libraryOf(...items);

test('a first run over a full tab records everything and writes nothing', async () => {
  // The baseline discipline: 348 real rows, none of which this service has
  // seen before, so none of them is a change.
  await withFreshJournal(async () => {
    await run('apply', {}, filmsOnly(...ON_TAB), (result, calls) => {
      assert.equal(result.status, 'idle', result.error ?? '');
      assert.deepEqual(calls.filter((c) => c.includes(':batchUpdate')), []);
      assert.deepEqual(baseline().get(movieKey(53078)), {
        'Watch Date': '2008-02-09T19:00:00.000Z',
        Score: '8',
        Runtime: '121',
      });
    });
  });
});

test('a score that moved on SIMKL is written, and only that cell', async () => {
  await withFreshJournal(async () => {
    await harness('apply', {}, async ({ poll, sheet }) => {
      // Seed the baseline over the unchanged tab...
      assert.equal((await poll(filmsOnly(...ON_TAB))).status, 'idle');
      // ...then move one value.
      const result = await poll(filmsOnly({ ...ON_TAB[0]!, rating: 10 }, ON_TAB[1]!));
      assert.equal(result.status, 'applied', result.error ?? '');
      assert.deepEqual(result.record.edits.map((e) => e.field), ['Score']);
      assert.equal(sheet.films?.[1]?.[2]?.userEnteredValue?.numberValue, 10);
      // Nothing else on the row moved.
      assert.equal(sheet.films?.[1]?.[0]?.userEnteredValue?.stringValue, 'Star Wars');
      assert.equal(sheet.films?.[1]?.[4]?.userEnteredValue?.numberValue, 121);
    });
  });
});

test('a value is recorded only once the write carrying it has landed', async () => {
  await withFreshJournal(async () => {
    // The write fails, so the moved value must NOT be recorded: recorded early,
    // the next poll finds nothing moved and the change is lost for good.
    await harness('apply', { failWrite: 1 }, async ({ poll }) => {
      assert.equal((await poll(filmsOnly(...ON_TAB))).status, 'idle');
      const result = await poll(filmsOnly({ ...ON_TAB[0]!, rating: 10 }, ON_TAB[1]!));
      assert.equal(result.status, 'failed');
      assert.equal(baseline().get(movieKey(53078))?.Score, '8', 'still the value the sheet actually holds');
    });
  });
});

test('a new film is inserted below the last row, fully filled, and verifies', async () => {
  await withFreshJournal(async () => {
    const library = filmsOnly(...ON_TAB, film({ id: 999, title: 'A New Film', lastWatchedAt: '2026-08-25T20:00:00Z', rating: 7, runtime: 110 }));
    await run('apply', {}, library, (result, _calls, sheet) => {
      assert.equal(result.status, 'applied', result.error ?? '');
      assert.equal(result.record.inserts.length, 1);
      const row = sheet.films?.[3];
      assert.ok(row, 'the row is below the two already there');
      const cell = (i: number) => row?.[i]?.userEnteredValue;
      assert.deepEqual(cell(0), { stringValue: 'A New Film' });
      assert.deepEqual(cell(2), { numberValue: 7 });
      // GB theatrical on 2026-08-20, watched on the 25th: inside the window.
      assert.deepEqual(cell(3), { boolValue: true });
      assert.deepEqual(cell(4), { numberValue: 110 });
      // TMDB order, with Animation dropped for having nowhere to go.
      assert.deepEqual(cell(5), { stringValue: 'Adventure' });
      assert.deepEqual(cell(6), { stringValue: 'Sci-Fi' });
      assert.deepEqual(cell(7), { numberValue: 12 });
      // TMDB suffixes every collection name; the column does not.
      assert.deepEqual(cell(9), { stringValue: 'A New Film' });
      assert.deepEqual(cell(10), { stringValue: 'A Director' });
      // Text, matching every other id cell on the tab.
      assert.deepEqual(cell(11), { stringValue: '999' });
      assert.deepEqual(cell(13), { stringValue: 'https://image.tmdb.org/t/p/w1280/a.jpg' });
    });
  });
});

test('the insert goes out as insertDimension, so the row inherits its number formats', async () => {
  // Written straight into the blank tail instead, a date serial renders as
  // `28486`: the rows past the data carry a different format on Watch Date and
  // none at all on Release Date.
  await withFreshJournal(async () => {
    const library = filmsOnly(...ON_TAB, film({ id: 999, lastWatchedAt: '2026-08-25T20:00:00Z' }));
    await run('apply', {}, library, (result, _calls, sheet) => {
      assert.equal(result.status, 'applied', result.error ?? '');
      assert.ok(sheet.batches[0]?.includes('insertDimension'));
    });
  });
});

test('a film waits a poll rather than landing with blank TMDB cells', async () => {
  await withFreshJournal(async () => {
    const library = filmsOnly(...ON_TAB, film({ id: 999, lastWatchedAt: '2026-08-25T20:00:00Z' }));
    // A 503 is retryable, so nothing is recorded and the next poll asks again.
    const failing = { tmdb: () => new Response('{"status_message":"boom"}', { status: 503 }) };
    await run('apply', failing, library, (result, calls) => {
      assert.equal(result.status, 'idle');
      assert.deepEqual(calls.filter((c) => c.includes(':batchUpdate')), []);
      assert.ok(result.retry, 'and asks for another poll');
    });
  });
});

test('a film TMDB has no record of is settled, not re-requested every poll', async () => {
  await withFreshJournal(async () => {
    const library = filmsOnly(...ON_TAB, film({ id: 999, title: 'Obscure', lastWatchedAt: '2026-08-25T20:00:00Z' }));
    clearTokenCache();
    const sheet = fakeSheets({ movies: DEFAULT_MOVIES, tmdb: () => new Response('{"status_message":"not found"}', { status: 404 }) });
    await withConfig(
      { sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL, timezone: 'UTC', tmdbApiKey: 'tmdb-token', moviesSheetName: 'Movies' },
      () =>
        withFetch(sheet.handler, async (calls) => {
          const sync = new SheetSync({ logger: quiet });
          await sync.run(library);
          const first = calls.filter((c) => c.includes('themoviedb')).length;
          assert.equal(first, 1);
          await sync.run(library);
          assert.equal(calls.filter((c) => c.includes('themoviedb')).length, first, 'the second poll asks nothing');
        }),
    );
  });
});

test('report mode plans the insert in full and makes no mutating request', async () => {
  await withFreshJournal(async () => {
    const library = filmsOnly(...ON_TAB, film({ id: 999, lastWatchedAt: '2026-08-25T20:00:00Z' }));
    await run('report', {}, library, (result, calls) => {
      assert.equal(result.status, 'reported');
      assert.equal(result.record.inserts.length, 1);
      assert.deepEqual(calls.filter((c) => c.includes(':batchUpdate')), []);
    });
  });
});

test('a cell that changed under the write is rolled back, not left half-applied', async () => {
  await withFreshJournal(async () => {
    // A hand edit landing in the seconds-wide window between the batch and the
    // verify read. The films tab is the *second* tab the fake holds, so the
    // meddle has to reach it rather than Sheet1.
    // Someone retitles Finding Nemo while the write is out.
    const meddleMovies = (films: CellData[][]) => {
      films[2]![0] = { userEnteredValue: { stringValue: 'Renamed By Hand' } };
    };
    await harness('apply', { meddleMovies }, async ({ poll, sheet }) => {
      assert.equal((await poll(filmsOnly(...ON_TAB))).status, 'idle');
      const result = await poll(filmsOnly({ ...ON_TAB[0]!, rating: 10 }, ON_TAB[1]!));
      assert.equal(result.status, 'rolled-back', result.error ?? '');
      // The whole tab went back, the concurrent edit included — the accepted
      // cost of a wholesale paste, and the reason the window is kept short.
      assert.equal(sheet.films?.[1]?.[2]?.userEnteredValue?.numberValue, 8);
      assert.equal(sheet.films?.[2]?.[0]?.userEnteredValue?.stringValue, 'Finding Nemo');
    });
  });
});

test('the films run is journalled under its own tab', async () => {
  await withFreshJournal(async () => {
    const library = filmsOnly(...ON_TAB, film({ id: 999, lastWatchedAt: '2026-08-25T20:00:00Z' }));
    await run('apply', {}, library, () => {
      const films = sheetRuns().filter((r) => r.tab === 'films');
      assert.equal(films.length, 1);
      assert.equal(films[0]?.status, 'applied');
      // And the show half, which had nothing to do, wrote no record at all —
      // a quiet run says nothing rather than a line a poll.
      assert.deepEqual(sheetRuns().filter((r) => r.tab === 'shows'), []);
    });
  });
});

test('the films half is inert without a TMDB token', async () => {
  await withFreshJournal(async () => {
    clearTokenCache();
    const sheet = fakeSheets({ movies: DEFAULT_MOVIES });
    const library = filmsOnly(...ON_TAB, film({ id: 999, lastWatchedAt: '2026-08-25T20:00:00Z' }));
    await withConfig(
      { sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL, tmdbApiKey: undefined, moviesSheetName: 'Movies' },
      () =>
        withFetch(sheet.handler, async (calls) => {
          await new SheetSync({ logger: quiet }).run(library);
          // The tab is never even read: eight of its columns come from TMDB,
          // and a row inserted with those blank is worse than no row.
          assert.deepEqual(calls.filter((c) => c.includes('Movies')), []);
          assert.deepEqual(sheetRuns().filter((r) => r.tab === 'films'), []);
        }),
    );
  });
});

test('a row someone started by hand is not duplicated', async () => {
  await withFreshJournal(async () => {
    const started: CellSpec[][] = [...DEFAULT_MOVIES, filmRow({ name: 'A New Film', id: 999, watched: TODAY - 10 })];
    const library = filmsOnly(...ON_TAB, film({ id: 999, title: 'A New Film', lastWatchedAt: '2026-08-25T20:00:00Z' }));
    await run('apply', { movies: started }, library, (result) => {
      assert.equal(result.record.inserts.length, 0);
    });
  });
});

test('the films tab is read by name, never the show grid by accident', async () => {
  await withFreshJournal(async () => {
    await run('apply', {}, filmsOnly(...ON_TAB), (_result, calls) => {
      const reads = calls.filter((c) => c.includes('ranges=')).map((c) => decodeURIComponent(c));
      assert.ok(reads.some((c) => c.includes("'Movies'")));
      // And the show grid is not read at all: this library holds no shows, so
      // the show half early-outs before any request.
      assert.deepEqual(reads.filter((c) => c.includes("'Sheet1'")), []);
    });
  });
});
