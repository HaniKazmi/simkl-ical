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
import { appendSheetRun, sheetRuns } from '../../../src/sheet/io/journal.ts';
import { baseline } from '../../../src/sheet/io/baseline.ts';
import { dateSerial, movieKey } from '../../../src/sheet/values.ts';
import {
  daysAgo,
  filmRow,
  jsonResponse,
  libraryOf,
  quiet,
  recorder,
  withConfig,
  withFetch,
  withFreshJournal,
  seasonRow,
  showRow,
  type CellSpec,
  type ItemSpec,
} from '../../helpers.ts';
import { CREDENTIAL, DEFAULT_GRID, DEFAULT_MOVIES, fakeSheets, type FakeSheetsOptions } from '../fake-sheets.ts';
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
  sync: SheetSync;
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
        await body({ poll: (library) => sync.run(library), calls, sheet, log, sync });
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
    sync: SheetSync,
  ) => void | Promise<void>,
) => harness(mode, options, async ({ poll, calls, sheet, log, sync }) => assertions(await poll(library), calls, sheet, log, sync));

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

test('a rejected TMDB credential is said once about the token, and files no film as unbuildable', async () => {
  // A 401 is a fact about the token, not about any film. Settled as films
  // TMDB has nothing for, the report would tell the operator to add by hand
  // rows TMDB could build the moment the token is fixed — eight more of them
  // every poll. Held as a fact about the token, no further lookup is made
  // this process and no poll is asked for, since none could drain it.
  await withFreshJournal(async () => {
    const library = filmsOnly(...ON_TAB, film({ id: 999, title: 'Blocked', lastWatchedAt: '2026-08-25T20:00:00Z' }));
    await harness('apply', { tmdb: () => new Response('{"status_message":"Invalid API key"}', { status: 401 }) }, async ({ poll, calls, log }) => {
      const first = await poll(library);
      assert.equal(first.status, 'idle', first.error ?? '');
      assert.equal(first.retry, false, 'no poll can drain a rejected token');
      const asked = calls.filter((c) => c.includes('themoviedb')).length;
      assert.ok(asked >= 1);
      assert.equal(log.lines.some((l) => /Blocked .*has no TMDB record/.test(l)), false, log.lines.join('\n'));
      assert.equal(log.lines.some((l) => /1 film\(s\) need a TMDB lookup and TMDB rejected the credential/.test(l)), true, log.lines.join('\n'));
      await poll(library);
      assert.equal(calls.filter((c) => c.includes('themoviedb')).length, asked, 'the second poll asks nothing');
    });
  });
});

test('a backlog is looked up one burst at a time, and drains without stalling', async () => {
  // One row lands per run, so the lookups the films behind it need are the
  // next poll's to make. Fetched now, every pass to the ceiling would spend
  // another `MAX_LOOKUPS_PER_PASS` and log the pass ceiling as a bookkeeping
  // bug on healthy data. The trap on the other side: with nothing fetched
  // ahead, the poll that inserts the last film the store knows has nothing
  // deferred to ask for another poll with, and the rest of the backlog waits
  // on unrelated library activity — unless the lookups it chose not to make
  // count as work.
  await withFreshJournal(async () => {
    // Nine films past a burst of eight, watched on distinct days.
    const backlog = Array.from({ length: 9 }, (_, i) =>
      film({ id: 100 + i, title: `Backlog ${i}`, tmdb: String(500 + i), lastWatchedAt: `2026-08-${String(10 + i).padStart(2, '0')}T20:00:00Z` }),
    );
    const library = filmsOnly(...ON_TAB, ...backlog);
    const tmdbCalls = (calls: string[]) => calls.filter((c) => c.includes('themoviedb')).length;
    await harness('apply', {}, async ({ poll, calls, sheet, log }) => {
      const first = await poll(library);
      assert.equal(first.status, 'applied', first.error ?? '');
      assert.equal(tmdbCalls(calls), 8, 'one burst, not one per pass');
      assert.equal(log.lines.some((l) => /still wanted lookups/.test(l)), false, log.lines.join('\n'));
      assert.equal(first.retry, true);

      // Polls 2–8 insert what the store already holds and ask TMDB nothing.
      let last = first;
      for (let n = 2; n <= 8; n += 1) last = await poll(library);
      assert.equal(tmdbCalls(calls), 8);
      assert.equal(last.retry, true, 'the ninth film is still unfetched, so the poll asks for another');

      // Poll 9 fetches the one film left and lands it.
      const ninth = await poll(library);
      assert.equal(ninth.status, 'applied', ninth.error ?? '');
      assert.equal(tmdbCalls(calls), 9);
      assert.equal(sheet.films?.length, 3 + 9, 'every film has its row');
      assert.equal((await poll(library)).retry, false, 'and nothing is left to ask for');
    });
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

test('a freeze on the films tab is recorded under the films tab on every later poll', async () => {
  // The repair message names the tab, and so must the run history: a frozen
  // run repeats on every poll for the life of the process, and a history that
  // filed those under the show grid would drop the films label on exactly the
  // entry that says which tab needs a human.
  await withFreshJournal(async () => {
    const meddleMovies = (films: CellData[][]) => {
      films[2]![0] = { userEnteredValue: { stringValue: 'Renamed By Hand' } };
    };
    await harness('apply', { meddleMovies, failRollback: true }, async ({ poll, sync }) => {
      assert.equal((await poll(filmsOnly(...ON_TAB))).status, 'idle');
      assert.equal((await poll(filmsOnly({ ...ON_TAB[0]!, rating: 10 }, ON_TAB[1]!))).status, 'frozen');
      assert.equal(sheetRuns().at(-1)?.tab, 'films');
      assert.equal((await poll(filmsOnly(...ON_TAB))).status, 'frozen');
      assert.equal(sheetRuns().at(-1)?.tab, 'films', 'the repeat is filed where the freeze was');
      assert.ok(sync.frozen);
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

test('a films tab the spreadsheet lacks fails the films half for a human, and arms no retry', async () => {
  // The default name is `Movies`; a spreadsheet whose tab is called `Films`
  // has a configuration problem no poll fixes. Reported as retryable, the
  // orchestrator would re-read Sheet1 and fail the Movies read on every tick.
  await withFreshJournal(async () => {
    await harness('apply', {}, async ({ poll }) => {
      await withConfig({ moviesSheetName: 'Films' }, async () => {
        const result = await poll(filmsOnly(...ON_TAB));
        assert.equal(result.status, 'failed');
        assert.match(result.error ?? '', /Unable to parse range/);
        assert.equal(result.retry, false);
      });
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

// --- Both halves in one poll ------------------------------------------------
//
// Every test above uses a library with no shows, so the show half early-outs
// and the two-tab interaction never happens. These are the cases only a poll
// that writes both tabs can reach.

/** The show grid the shared fake serves, plus a library that moves one season. */
const SHOW = {
  id: 3381,
  title: 'Fargo',
  status: 'watching',
  seasons: { 1: Array.from({ length: 6 }, (_, i) => daysAgo(400 + i)), 2: Array.from({ length: 5 }, (_, i) => daysAgo(10 - i)) },
  watched: 11,
  total: 16,
  notAired: 5,
} satisfies ItemSpec;

test('a poll that writes both tabs journals one record each, labelled', async () => {
  await withFreshJournal(async () => {
    await run('apply', {}, libraryOf(SHOW, ...ON_TAB), (result) => {
      assert.equal(result.status, 'applied', result.error ?? '');
      assert.deepEqual(sheetRuns().map((r) => r.tab), ['shows']);
      // The films half had nothing to write, so it says nothing — but the show
      // half did, and its record is not overwritten by the quiet one.
      assert.equal(sheetRuns()[0]?.status, 'applied');
    });
  });
});

test('two halves failing the same way stay two records', async () => {
  // The collapse this guards against: same status, same mode, same error text,
  // empty edits and inserts. Only the tab tells them apart, and without it the
  // second took the first's place and its label.
  await withFreshJournal(async () => {
    await appendSheetRun({ at: '2026-09-04T12:00:00.000Z', tab: 'shows', status: 'failed', mode: 'apply', edits: [], inserts: [], error: 'the sheet could not be read' });
    await appendSheetRun({ at: '2026-09-04T12:00:01.000Z', tab: 'films', status: 'failed', mode: 'apply', edits: [], inserts: [], error: 'the sheet could not be read' });
    assert.deepEqual(sheetRuns().map((r) => `${r.tab}x${r.repeats}`), ['showsx1', 'filmsx1']);
    // And on the next poll each collapses into its own tab's record, not
    // into the record before it — which is the other tab's. Compared against
    // that, a state repeating on both tabs never collapses, and two records a
    // poll evict the real history in 25 polls.
    await appendSheetRun({ at: '2026-09-04T12:30:00.000Z', tab: 'shows', status: 'failed', mode: 'apply', edits: [], inserts: [], error: 'the sheet could not be read' });
    await appendSheetRun({ at: '2026-09-04T12:30:01.000Z', tab: 'films', status: 'failed', mode: 'apply', edits: [], inserts: [], error: 'the sheet could not be read' });
    assert.deepEqual(sheetRuns().map((r) => `${r.tab}x${r.repeats}`), ['showsx2', 'filmsx2']);
    assert.equal(sheetRuns()[0]?.at, '2026-09-04T12:00:00.000Z', 'the first sighting is kept as when the state began');
  });
});

test('a quiet films half does not erase what the show half reported', async () => {
  // `lastStatus` is what /healthz reports as `sheet.status`, and the show half
  // runs first — so the films `idle` that follows it must not overwrite the
  // show run's outcome. Taking the last half's status outright reports a poll
  // that wrote the show grid as having done nothing.
  await withFreshJournal(async () => {
    await run('apply', {}, libraryOf(SHOW, ...ON_TAB), (result, _calls, _sheet, _log, sync) => {
      assert.equal(result.status, 'applied', result.error ?? '');
      assert.equal(sync.lastStatus, 'applied');
      // The films half really did run, and really was quiet.
      assert.deepEqual(sheetRuns().map((r) => r.tab), ['shows']);
    });
  });
});

/** The show library, with `watched` episodes of season 2 seen. */
const showWatching = (watched: number): ItemSpec => ({
  id: 3381,
  title: 'Fargo',
  status: 'watching',
  seasons: { 1: Array.from({ length: 6 }, (_, i) => daysAgo(400 + i)), 2: Array.from({ length: watched }, (_, i) => daysAgo(10 - i)) },
  watched: 6 + watched,
  total: 16,
  notAired: 5,
});

test('a poll where both halves write charges one shared budget', async () => {
  // Both halves writing in one poll is the only state that reaches the budget
  // threading, the backup gate and the films side of the status merge — and
  // every other test here leaves one half idle.
  await withFreshJournal(async () => {
    await harness('apply', {}, async ({ poll, sheet }) => {
      // Poll 1: the show half writes; the films half records its baseline.
      assert.equal((await poll(libraryOf(showWatching(5), ...ON_TAB))).status, 'applied');
      // Poll 2: both have something to write.
      const result = await poll(libraryOf(showWatching(6), { ...ON_TAB[0]!, rating: 10 }, ON_TAB[1]!));
      assert.equal(result.status, 'applied', result.error ?? '');
      assert.deepEqual(sheetRuns().map((r) => r.tab).slice(-2), ['shows', 'films']);
      assert.equal(sheet.films?.[1]?.[2]?.userEnteredValue?.numberValue, 10, 'the films edit landed');
      assert.equal(sheet.state[3]?.[3]?.userEnteredValue?.numberValue, 6, 'and so did the show edit');
    });
  });
});

test('the two halves cannot together exceed one poll budget', async () => {
  await withFreshJournal(async () => {
    // Two show edits plus one films edit, against a budget of two.
    await withConfig({ sheetMaxEdits: 2 }, () =>
      harness('apply', {}, async ({ poll }) => {
        assert.equal((await poll(libraryOf(showWatching(5), ...ON_TAB))).status, 'applied');
        const result = await poll(libraryOf(showWatching(6), { ...ON_TAB[0]!, rating: 10 }, ON_TAB[1]!));
        // The show half spends the budget; the films half is refused whole
        // rather than trimmed, and asks for another poll.
        assert.equal(result.status, 'refused', result.error ?? '');
        assert.match(result.error ?? '', /exceeds SHEET_MAX_EDITS=2/);
      }),
    );
  });
});

test('a films write sweeps its own snapshots and nothing else', async () => {
  // Sweeping is per tab, by the id in the snapshot's name. A failed show write
  // keeps its snapshot as the operator's only copy of the pre-write grid, and
  // a films write verifying clean says nothing about `Sheet1` — so it must not
  // take it, while still removing every copy of its own tab, or each such
  // poll leaves a full-tab copy standing.
  await withFreshJournal(async () => {
    // Each write is followed by a sweep batch, so poll 2's show write is
    // the third: poll 1 writes and sweeps, then poll 2 writes.
    await harness('apply', { failWrite: 3 }, async ({ poll, sheet }) => {
      await poll(libraryOf(showWatching(5), ...ON_TAB));
      // Stand in for the snapshot a failed show write keeps — the fake
      // discards its own when the row count agrees nothing happened — and an
      // older films snapshot a failure between write and read-back stranded.
      sheet.titles.set(98, '_sync-backup-1-2026-09-04T12-00-00-000Z');
      sheet.tabs.set(98, []);
      sheet.titles.set(99, '_sync-backup-2-2026-09-04T11-00-00-000Z');
      sheet.tabs.set(99, []);
      const result = await poll(libraryOf(showWatching(6), { ...ON_TAB[0]!, rating: 10 }, ON_TAB[1]!));
      assert.equal(result.status, 'failed', 'the show half failed');
      assert.equal(sheetRuns().at(-1)?.status, 'applied', 'and the films half wrote');
      assert.ok(sheet.titles.has(98), 'the show grid\'s snapshot stands');
      assert.deepEqual(
        [...sheet.titles.values()].filter((t) => t.startsWith('_sync-backup-2-')),
        [],
        'and every films snapshot went, this run\'s and the stranded one',
      );
    });
  });
});

test('a kept show snapshot survives a films write from a fresh process', async () => {
  // Nothing in the process says the snapshot is there — a restart has no
  // memory of the failure that kept it. The name does, so a films write in the
  // next process leaves it exactly as one in the same poll would.
  await withFreshJournal(async () => {
    await harness('apply', {}, async ({ poll, sheet }) => {
      sheet.titles.set(99, '_sync-backup-1-2026-09-04T12-00-00-000Z');
      sheet.tabs.set(99, []);
      // A first poll of a new process: the show half is idle — the grid
      // already holds three episodes — and the films half records; a second
      // where only the films half writes.
      await poll(libraryOf(showWatching(3), ...ON_TAB));
      await poll(libraryOf(showWatching(3), { ...ON_TAB[0]!, rating: 9 }, ON_TAB[1]!));
      assert.equal(sheetRuns().at(-1)?.tab, 'films', 'the films half wrote');
      assert.ok(sheet.titles.has(99), 'and left the show grid\'s snapshot alone');
    });
  });
});

test('a show write that went out charges the films half, whatever became of it', async () => {
  // `spent` counts what was sent, not what verified. A batch that errored or
  // could not be read back may well have landed, and the budget is a blast
  // radius for the poll: charged only on `applied`, such a poll writes the
  // budget twice while each half reports itself inside it.
  await withFreshJournal(async () => {
    await withConfig({ sheetMaxEdits: 2 }, () =>
      harness('apply', { failWrite: 3 }, async ({ poll }) => {
        assert.equal((await poll(libraryOf(showWatching(5), ...ON_TAB))).status, 'applied');
        // The show half plans two edits and its batch fails; the films half's
        // one edit would be inside the budget on its own.
        const result = await poll(libraryOf(showWatching(6), { ...ON_TAB[0]!, rating: 10 }, ON_TAB[1]!));
        assert.equal(result.status, 'failed', 'the show half failed');
        assert.equal(sheetRuns().at(-1)?.tab, 'films');
        assert.equal(sheetRuns().at(-1)?.status, 'refused', 'and the films half is refused on the budget the show half spent');
        assert.match(sheetRuns().at(-1)?.error ?? '', /3 edits this poll exceeds SHEET_MAX_EDITS=2/);
      }),
    );
  });
});

test('a plan report mode never wrote, or the freshness loop discarded, charges nothing', async () => {
  // Charged at the guard instead, a show plan that was reported and not
  // written would dock the films half's allowance for edits that never went
  // out.
  await withFreshJournal(async () => {
    await withConfig({ sheetMaxEdits: 2 }, () =>
      harness('report', {}, async ({ poll }) => {
        // Poll 1 records the films baseline; poll 2 has two show edits and one
        // films edit to report, against a budget of two.
        await poll(libraryOf(showWatching(6), ...ON_TAB));
        const result = await poll(libraryOf(showWatching(6), { ...ON_TAB[0]!, rating: 10 }, ON_TAB[1]!));
        assert.equal(result.status, 'reported', result.error ?? '');
        assert.deepEqual(sheetRuns().slice(-2).map((r) => [r.tab, r.status]), [['shows', 'reported'], ['films', 'reported']]);
      }),
    );
  });
});

// --- Placing an anime film ---------------------------------------------------

// `SHOW` above is what gives these an answer: with it in the library the show
// half reads `Sheet1` instead of taking its early-out.
const animeFilm = (over: Partial<ItemSpec> = {}): ItemSpec => ({
  id: 999,
  type: 'anime',
  animeType: 'movie',
  title: 'A New Film',
  status: 'completed',
  lastWatchedAt: '2026-08-25T20:00:00Z',
  rating: 7,
  runtime: 110,
  ...over,
});

test('an anime film on no Sheet1 block is inserted on the films tab, marked as anime', async () => {
  await withFreshJournal(async () => {
    await run('apply', {}, libraryOf(SHOW, animeFilm()), (result, _calls, sheet) => {
      assert.equal(result.status, 'applied', result.error ?? '');
      const row = sheet.films?.[3];
      assert.deepEqual(row?.[0]?.userEnteredValue, { stringValue: 'A New Film' });
      assert.deepEqual(row?.[11]?.userEnteredValue, { stringValue: '999' });
      // The column this tab has always carried by hand, now written.
      assert.deepEqual(row?.[12]?.userEnteredValue, { boolValue: true });
    });
  });
});

test('an anime film already on a Sheet1 block is left there rather than given a second row', async () => {
  await withFreshJournal(async () => {
    // The same library, and the only difference is that `Sheet1` holds the id.
    const grid = [...DEFAULT_GRID, showRow('Kara no Kyoukai', 'Completed', null, 'anime'), seasonRow(1, 7, 45100, { id: 999 })];
    await run('report', { grid }, libraryOf(SHOW, animeFilm()), (result, _calls, _sheet, log) => {
      assert.equal(result.record.inserts.length, 0);
      // And silently. Everything past the insert filter reports, so a gate
      // below it would move the show half's note here rather than remove it.
      assert.equal(log.lines.some((l) => /A New Film/.test(l)), false, log.lines.join('\n'));
    });
  });
});

test('a poll whose Sheet1 read failed inserts no anime film at all', async () => {
  // The reachable way to have no answer, and the only one an anime film can
  // reach: its own presence in the library is what stops the show half taking
  // its early-out, so a failed read is what is left. Fails closed — one poll's
  // delay against a duplicate row that stands.
  await withFreshJournal(async () => {
    await run('report', { failReadOf: 'Sheet1' }, libraryOf(SHOW, animeFilm()), (result) => {
      assert.equal(result.record.inserts.length, 0);
    });
  });
});

test('an ordinary film is inserted even when the Sheet1 read failed', async () => {
  // The gate is about anime alone. A wider one would stop inserting films
  // whenever the other half had a bad poll.
  await withFreshJournal(async () => {
    const library = libraryOf(SHOW, ...ON_TAB, film({ id: 999, title: 'A New Film', lastWatchedAt: '2026-08-25T20:00:00Z' }));
    await run('report', { failReadOf: 'Sheet1' }, library, (result) => {
      assert.equal(result.record.inserts.length, 1);
    });
  });
});

test('the ids Sheet1 held do not carry over into a poll that failed to read it', async () => {
  // Every value is from this poll or there is none. A set left standing from a
  // poll ago answers the placement question about a grid nobody read, and it
  // fails in the expensive direction: an insert permitted.
  await withFreshJournal(async () => {
    await harness('report', {}, async ({ poll, sheet }) => {
      // A first poll that reads `Sheet1` and finds no anime film on it.
      await poll(libraryOf(SHOW));
      sheet.stopServing('Sheet1');
      const second = await poll(libraryOf(SHOW, animeFilm()));
      assert.equal(second.record.inserts.length, 0);
    });
  });
});

test('the show half does not report an anime film as a title missing a row', async () => {
  // It still indexes them — 20 sit on `Sheet1` rows, which would read as
  // `unknown-id` skips the moment it stopped.
  await withFreshJournal(async () => {
    await run('report', {}, libraryOf(SHOW, animeFilm()), (_result, _calls, _sheet, log) => {
      assert.equal(log.lines.some((l) => /has recent activity and no row/.test(l)), false, log.lines.join('\n'));
    });
  });
});

test('with no films tab synced, an anime film with no row is still reported by the show half', async () => {
  // The note goes quiet because the films tab places the film. Without a TMDB
  // token nothing does, and the note is the only thing that says a watched
  // film is on neither tab.
  await withFreshJournal(async () => {
    await harness('report', {}, async ({ poll, log }) => {
      await withConfig({ tmdbApiKey: undefined }, async () => {
        await poll(libraryOf(SHOW, animeFilm()));
      });
      assert.equal(log.lines.some((l) => /A New Film .*has recent activity and no row/.test(l)), true, log.lines.join('\n'));
    });
  });
});
