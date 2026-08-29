import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SheetSync } from '../../src/sheet/sync.ts';
import { clearTokenCache } from '../../src/api/google/auth.ts';
import { clearTokenCache as clearTvdbTokenCache } from '../../src/api/tvdb/auth.ts';
import { cellOf, daysAgo, jsonResponse, libraryOf, quiet, recorder, SHEET_HEADERS, withConfig, withFetch, withFreshJournal, type CellSpec, seasonRow, showRow } from '../helpers.ts';
import { CREDENTIAL, fakeSheets, type FakeSheetsOptions } from './fake-sheets.ts';
import { sheetRuns } from '../../src/sheet/io/journal.ts';

const H = SHEET_HEADERS;

const show = showRow;
const season = seasonRow;

const server = fakeSheets;

const LIBRARY = libraryOf({
  id: 3381,
  title: 'Fargo',
  status: 'watching',
  // Season 2 is 5 of 10 aired, so the count advances and no end date is due.
  seasons: { 1: Array.from({ length: 6 }, (_, i) => daysAgo(400 + i)), 2: Array.from({ length: 5 }, (_, i) => daysAgo(10 - i)) },
  watched: 11,
  total: 16,
  notAired: 5,
});

const run = async (mode: 'report' | 'apply', options: FakeSheetsOptions, assertions: (result: Awaited<ReturnType<SheetSync['run']>>, calls: string[], sheet: ReturnType<typeof server>, sync: SheetSync, log: ReturnType<typeof recorder>) => void | Promise<void>) => {
  clearTokenCache();
  const sheet = server(options);
  const log = recorder();
  await withConfig({ sheetId: 'SID', sheetSyncMode: mode, googleKeyBase64: CREDENTIAL, timezone: 'Europe/London' }, () =>
    withFetch(sheet.handler, async (calls) => {
      const sync = new SheetSync({ logger: log });
      const result = await sync.run(LIBRARY);
      await assertions(result, calls, sheet, sync, log);
    }),
  );
};

// The point of the default mode: it can run against the real sheet before the
// service account has Editor access.
test('report mode plans in full and makes no mutating request', async () => {
  await run('report', {}, (result, calls, _sheet, _sync, log) => {
    assert.equal(result.status, 'reported');
    assert.equal(result.record.edits.length, 1);
    assert.ok(log.lines.some((l) => /Fargo S2: 3 -> 5 episodes/.test(l)), 'the report itself is logged');
    assert.deepEqual(calls.filter((c) => c.includes(':batchUpdate')), []);
  });
});

test('apply mode writes exactly what it planned and verifies it', async () => {
  await run('apply', {}, (result, calls, sheet) => {
    assert.equal(result.status, 'applied', result.error ?? '');
    assert.equal(result.error, null);
    assert.equal(sheet.state[3]?.[3]?.userEnteredValue?.numberValue, 5);
    // Snapshot and write in one atomic batch, a verify read, then the snapshot
    // is dropped.
    assert.deepEqual(sheet.batches, [['duplicateSheet', 'updateCells'], ['deleteSheet']]);
    const sheets = calls.filter((c) => c.startsWith('https://sheets.googleapis.com/v4/spreadsheets/'));
    assert.deepEqual(sheets.map((c) => (c.includes(':batchUpdate') ? 'write' : 'read')), ['read', 'write', 'read', 'read', 'write']);
    // `new URL('SID:batchUpdate', base)` reads `SID:` as a scheme and silently
    // sends the request elsewhere.
    assert.ok(sheets[1]?.startsWith('https://sheets.googleapis.com/v4/spreadsheets/SID:batchUpdate'), String(sheets[1]));
  });
});

// Rollback exists for one failure: the plan was wrong. So the rollback set
// comes from the observed diff, not the suspect plan.
test('a write that does not verify is rolled back exactly once', async () => {
  await run('apply', { meddle: (state) => void (state[2]![3] = cellOf(99)) }, (result, _calls, sheet) => {
    assert.equal(result.status, 'rolled-back');
    assert.match(result.error ?? '', /changed without being planned/);
    // The undone run reports what it planned rather than nothing.
    assert.equal(result.record.edits.length, 1);
    assert.match(result.record.edits[0]?.note ?? '', /Fargo S2: 3 -> 5 episodes/);
    // One wholesale paste from the snapshot, not a cell-by-cell repair.
    assert.deepEqual(sheet.batches, [['duplicateSheet', 'updateCells'], ['copyPaste'], ['deleteSheet']]);
    // The restore undoes the whole write — the meddled cell and the planned
    // edit both.
    assert.equal(sheet.state[2]?.[3]?.userEnteredValue?.numberValue, 6);
    assert.equal(sheet.state[3]?.[3]?.userEnteredValue?.numberValue, 3, 'the planned edit is undone too');
  });
});

test('a failed rollback freezes the process rather than writing again', async () => {
  await run('apply', { meddle: (state) => void (state[2]![3] = cellOf(99)), failRollback: true }, async (result, _calls, sheet, sync) => {
    assert.equal(result.status, 'frozen');
    assert.match(result.error ?? '', /^FROZEN:/);
    assert.equal(result.record.edits.length, 1, 'the freeze reports the plan it froze on');

    const writesBefore = sheet.writes();
    const again = await sync.run(LIBRARY);
    assert.equal(again.status, 'frozen');
    // A run that stops at the freeze check planned nothing, and says so.
    assert.deepEqual(again.record, { edits: [], inserts: [] });
    assert.equal(sheet.writes(), writesBefore, 'a frozen sync writes nothing further');
  });
});

// batchUpdate is atomic but not idempotent: a retried insertDimension inserts
// two rows, and a timeout can fire on a request the server already applied.
test('a 500 on the write is never retried, and the re-read settles what happened', async () => {
  await run('apply', { failWrite: 1 }, (result, calls, sheet) => {
    assert.equal(result.status, 'failed');
    assert.equal(result.retry, true, 'the next poll tries again');
    assert.equal(result.record.edits.length, 1, 'a batch that never landed still had a plan');
    assert.equal(calls.filter((c) => c.includes(':batchUpdate')).length, 1);
    assert.equal(sheet.state[3]?.[3]?.userEnteredValue?.numberValue, 3, 'unchanged');
  });
});

// A failed batch carrying an insert leaves the row count unchanged — the one
// shape where "did it land" is easy to answer backwards. Answered wrongly, the
// rollback finds no snapshot tab (it rode the same failed batch) and freezes
// the process over a sheet a transient 503 left untouched.
test('a 500 on a write that inserts a row fails cleanly instead of freezing', async () => {
  clearTokenCache();
  const grid: CellSpec[][] = [H, show('Fargo', 'Watching', 3381), season(1, 6, 44000)];
  const library = libraryOf({
    id: 3381,
    title: 'Fargo',
    status: 'watching',
    seasons: { 1: [daysAgo(400)], 2: [daysAgo(2)] },
    watched: 2,
    total: 2,
  });
  const episodes = [
    { season: 1, episode: 1, type: 'episode', aired: true },
    { season: 2, episode: 1, type: 'episode', aired: true },
  ];

  const sheet = server({ grid, episodes, failWrite: 1 });
  const log = recorder();
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async () => {
      const sync = new SheetSync({ logger: log });
      const result = await sync.run(library);
      assert.ok(sheet.batches[0]?.includes('insertDimension'), 'the failed batch really did carry an insert');
      assert.equal(result.status, 'failed');
      assert.equal(result.retry, true, 'the next poll tries again');
      assert.equal(sync.frozen, null, 'an untouched sheet is not a reason to stop writing forever');
      assert.equal(sheet.tabs.get(1)?.length, grid.length, 'and no row was added');
    }),
  );
});

test('a run with nothing to write is idle and writes nothing', async () => {
  clearTokenCache();
  const sheet = server();
  // The sheet already holds what SIMKL says.
  sheet.state[3]![3] = cellOf(5);
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async (calls) => {
      const result = await new SheetSync({ logger: quiet }).run(LIBRARY);
      assert.equal(result.status, 'idle');
      assert.deepEqual(calls.filter((c) => c.includes(':batchUpdate')), []);
    }),
  );
});

test('the sync is inert with no library, and off by mode', async () => {
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'off', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(
      () => {
        throw new Error('should not have been called');
      },
      async () => {
        assert.equal((await new SheetSync({ logger: quiet }).run(LIBRARY)).status, 'idle');
        await withConfig({ sheetSyncMode: 'apply' }, async () => {
          assert.equal((await new SheetSync({ logger: quiet }).run(null)).status, 'idle');
        });
      },
    ),
  );
});

// Nothing in the refresh path may be fatal, and this is called from it.
test('run never rejects, however the sheet misbehaves', async () => {
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(
      (url) => (url.startsWith('https://oauth2.googleapis.com/token') ? jsonResponse({ access_token: 't', expires_in: 3600 }) : new Response('nope', { status: 403 })),
      async () => {
        clearTokenCache();
        const result = await new SheetSync({ logger: quiet }).run(LIBRARY);
        assert.equal(result.status, 'failed');
        assert.match(result.error ?? '', /share the spreadsheet with the service account as Editor/);
        // A wrong SHEET_ID or an unshared spreadsheet needs a human; arming
        // the retry would defeat the quiet-poll early return. The error still
        // reaches errors.sheet and /healthz each run.
        assert.equal(result.retry, false);
      },
    ),
  );
});

// Same class, opposite conclusion: the transport clears the token cache on a
// 401, so the next poll signs a fresh assertion and recovers — if asked for.
test('a 401 asks for another poll, unlike the access errors it shares a class with', async () => {
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(
      (url) => (url.startsWith('https://oauth2.googleapis.com/token') ? jsonResponse({ access_token: 't', expires_in: 3600 }) : new Response('nope', { status: 401 })),
      async () => {
        clearTokenCache();
        const result = await new SheetSync({ logger: quiet }).run(LIBRARY);
        assert.equal(result.status, 'failed');
        assert.equal(result.retry, true);
      },
    ),
  );
});

// --- catalogue gating ------------------------------------------------------

const catalogueCalls = (calls: string[]) => calls.filter((c) => /api\.simkl\.com\/(tv|anime)\//.test(c));

// `/sync/activities` names a list, never a title, so without the gating a
// second poll with nothing moved would re-read every eligible show's catalogue.
test('a second run with nothing moved makes no catalogue requests at all', async () => {
  clearTokenCache();
  const sheet = server();
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'report', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async (calls) => {
      const sync = new SheetSync({ logger: quiet });

      await sync.run(LIBRARY);
      const cold = catalogueCalls(calls).length;
      assert.ok(cold > 0, 'a cold process reads the catalogue');

      calls.length = 0;
      const again = await sync.run(LIBRARY);
      assert.deepEqual(catalogueCalls(calls), []);
      // The plan is unchanged: the retained catalogue still feeds it in full.
      // The gate is on the network, not on what the planner sees.
      assert.equal(again.status, 'reported');
      assert.equal(again.record.edits.length, 1);
    }),
  );
});

test('a title that moved is re-read, and only that title', async () => {
  clearTokenCache();
  const sheet = server();
  const second = libraryOf(
    { id: 3381, title: 'Fargo', status: 'watching', seasons: { 1: [daysAgo(400)], 2: [daysAgo(9), daysAgo(1)] }, watched: 12, total: 16, notAired: 4 },
    { id: 7000, title: 'Silo', status: 'watching', seasons: { 1: [daysAgo(2)] }, watched: 1, total: 10, notAired: 0 },
  );

  await withConfig({ sheetId: 'SID', sheetSyncMode: 'report', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async (calls) => {
      const sync = new SheetSync({ logger: quiet });
      await sync.run(LIBRARY);

      calls.length = 0;
      await sync.run(second);
      // Fargo's last watch moved, so it is re-read. Silo has no row, so it is
      // reported, not read.
      assert.deepEqual([...new Set(catalogueCalls(calls).map((c) => c.split('?')[0]))], [
        'https://api.simkl.com/tv/episodes/3381',
        'https://api.simkl.com/tv/3381',
      ]);
    }),
  );
});

// Delete and restore must be separate batches: the delete rewrites the
// relative references in everything it shifts, including cells written earlier
// in the same batch.
test('a rollback involving an insert deletes first, then restores from the backup tab', async () => {
  clearTokenCache();
  // A Fargo block with no S2 row, so the plan inserts one mid-sheet.
  const rows: CellSpec[][] = [
    H,
    show('Fargo', 'Watching', 3381),
    [null, null, 1, 6, 45000, 44000, 0.0153, { formula: '=G3*D3' }, null, null],
    [null, null, 3, 4, 45500, 44900, 0.0153, { formula: '=G4*D4' }, null, null],
    show('Silo', 'Watching', 7000),
    [null, null, 1, 1, 45600, null, 0.0153, { formula: '=G6*D6' }, null, null],
  ];
  const library = libraryOf(
    { id: 3381, title: 'Fargo', status: 'watching', seasons: { 1: [daysAgo(400)], 2: [daysAgo(3), daysAgo(2)], 3: [daysAgo(300)] }, watched: 4, total: 4 },
    { id: 7000, title: 'Silo', status: 'watching', seasons: { 1: [daysAgo(5)] }, watched: 1, total: 10, notAired: 9 },
  );
  const episodes = [
    { season: 1, episode: 1, type: 'episode', aired: true },
    { season: 2, episode: 1, type: 'episode', aired: true },
    { season: 2, episode: 2, type: 'episode', aired: true },
    { season: 3, episode: 1, type: 'episode', aired: true },
  ];

  const sheet = server({ grid: rows, episodes, meddle: (state) => void (state[5]![3] = cellOf(999)) });
  const typed = () => JSON.stringify((sheet.tabs.get(1) ?? []).map((row) => row.map((cell) => cell.userEnteredValue ?? null)));
  const original = typed();

  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async () => {
      const result = await new SheetSync({ logger: quiet }).run(library);
      assert.equal(result.status, 'rolled-back', result.error ?? '');

      // Batch 1 snapshots and writes atomically. Batch 2 is the delete ALONE.
      // Batch 3 is the paste. Batch 4 drops the snapshot.
      assert.equal(sheet.batches[0]?.[0], 'duplicateSheet', 'the snapshot leads the write batch');
      assert.ok(sheet.batches[0]?.includes('insertDimension'), 'and the write follows it');
      assert.deepEqual(sheet.batches[1], ['deleteDimension'], 'the delete travels alone');
      assert.deepEqual(sheet.batches[2], ['copyPaste'], 'then one wholesale restore');
      assert.deepEqual(sheet.batches[3], ['deleteSheet'], 'and the snapshot is cleaned up');

      assert.equal(typed(), original, 'every cell holds exactly what it held before the write');
      assert.deepEqual([...sheet.titles.values()], ['Sheet1'], 'no backup tab left behind');
    }),
  );
});

// The snapshot makes a frozen sheet recoverable without version-history
// archaeology, so it must survive exactly when the rollback did not — renamed
// out of the swept namespace, because `frozen` is process state a restart
// forgets.
test('a failed rollback keeps the backup tab, renames it for repair, and names it', async () => {
  clearTokenCache();
  const sheet = server({ meddle: (state) => void (state[2]![3] = cellOf(99)), failRollback: true });
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async () => {
      const result = await new SheetSync({ logger: quiet }).run(LIBRARY);
      assert.equal(result.status, 'frozen');
      const titles = [...sheet.titles.values()];
      const repair = titles.find((t) => t.startsWith('_sync-REPAIR-'));
      assert.ok(repair, 'the snapshot tab survives a failed rollback');
      assert.deepEqual(titles.filter((t) => t.startsWith('_sync-backup-')), [], 'and is out of the swept namespace');
      assert.ok(result.error?.includes(repair), 'and the frozen message names it by its new name');
      assert.match(result.error ?? '', /copy it back over Sheet1/);
    }),
  );
});

// "No id" is not "no tab": a timeout loses the reply carrying the new sheetId
// while the duplicate sits right there. Left under the swept name, the repair
// target is deleted by the next clean run.
test('a snapshot whose id was lost is still found and renamed', async () => {
  clearTokenCache();
  const sheet = server({ meddle: (state) => void (state[2]![3] = cellOf(99)), hideReplies: true, failTabLists: 4 });
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async () => {
      const result = await new SheetSync({ logger: quiet }).run(LIBRARY);
      assert.equal(result.status, 'frozen', 'no id at rollback time means it cannot restore');
      const repair = [...sheet.titles.values()].find((t) => t.startsWith('_sync-REPAIR-'));
      assert.ok(repair, 'but the tab is found on the way into the freeze, and renamed');
      assert.ok(result.error?.includes(repair));
      assert.doesNotMatch(result.error ?? '', /BEFORE restarting/, 'so there is no deadline to warn about');
    }),
  );
});

// When even the rename fails, the message must carry the deadline rather than
// imply the tab will keep.
test('a snapshot that could not be renamed says so, and says to hurry', async () => {
  clearTokenCache();
  const sheet = server({ meddle: (state) => void (state[2]![3] = cellOf(99)), hideReplies: true, failTabLists: 8 });
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async () => {
      const result = await new SheetSync({ logger: quiet }).run(LIBRARY);
      assert.equal(result.status, 'frozen');
      const backup = [...sheet.titles.values()].find((t) => t.startsWith('_sync-backup-'));
      assert.ok(backup, 'the tab survives under its original name');
      assert.match(result.error ?? '', /BEFORE restarting/);
    }),
  );
});

// The point of the rename: after the restart that clears `frozen`, a clean run
// must not sweep the tab the user was told to repair from.
test('a repair snapshot survives a later clean run, which sweeps everything else', async () => {
  clearTokenCache();
  const sheet = server();
  sheet.titles.set(98, '_sync-REPAIR-2020-01-01T00-00-00-000Z');
  sheet.tabs.set(98, []);
  sheet.titles.set(99, '_sync-backup-2020-01-01T00-00-00-000Z');
  sheet.tabs.set(99, []);

  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async () => {
      assert.equal((await new SheetSync({ logger: quiet }).run(LIBRARY)).status, 'applied');
      assert.deepEqual([...sheet.titles.values()], ['Sheet1', '_sync-REPAIR-2020-01-01T00-00-00-000Z']);
    }),
  );
});

test('a clean run leaves no backup tab behind', async () => {
  clearTokenCache();
  const sheet = server();
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async () => {
      assert.equal((await new SheetSync({ logger: quiet }).run(LIBRARY)).status, 'applied');
      assert.deepEqual([...sheet.titles.values()], ['Sheet1']);
    }),
  );
});

// Any failure between the write and the verify read strands a snapshot tab. A
// clean run is the one moment the sheet is known good, so it clears the lot.
test('a clean run sweeps snapshot tabs an earlier run left behind', async () => {
  clearTokenCache();
  const sheet = server();
  sheet.titles.set(99, '_sync-backup-2020-01-01T00-00-00-000Z');
  sheet.tabs.set(99, []);

  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async () => {
      assert.equal((await new SheetSync({ logger: quiet }).run(LIBRARY)).status, 'applied');
      assert.deepEqual([...sheet.titles.values()], ['Sheet1'], 'the orphan goes too');
    }),
  );
});

// A deferred row is work known to be waiting, held back only by the one-row
// cap. Without the retry flag it sits until something unrelated wakes a poll —
// the daily film clock, at worst.
test('a run that deferred a row asks for another poll', async () => {
  clearTokenCache();
  const grid: CellSpec[][] = [
    H,
    show('Fargo', 'Watching', 3381),
    season(1, 6, 44000),
    show('Silo', 'Watching', 7000),
    season(1, 10, 44000),
  ];
  const library = libraryOf(
    { id: 3381, title: 'Fargo', status: 'watching', seasons: { 1: [daysAgo(400)], 2: [daysAgo(2)] }, watched: 2, total: 2 },
    { id: 7000, title: 'Silo', status: 'watching', seasons: { 1: [daysAgo(400)], 2: [daysAgo(3)] }, watched: 2, total: 2 },
  );
  const episodes = [
    { season: 1, episode: 1, type: 'episode', aired: true },
    { season: 2, episode: 1, type: 'episode', aired: true },
    { season: 2, episode: 2, type: 'episode', aired: false },
  ];

  const sheet = server({ grid, episodes });
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async () => {
      const result = await new SheetSync({ logger: quiet }).run(library);
      assert.equal(result.status, 'applied');
      assert.equal(result.record.inserts.length, 1, 'one row per run');
      assert.equal(result.retry, true, 'and the next poll is asked for');
    }),
  );

  // Report mode never inserts, so the deferral cannot drain — asking for
  // another poll would be an unbroken loop of full grid reads.
  const reporting = server({ grid, episodes });
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'report', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(reporting.handler, async () => {
      const result = await new SheetSync({ logger: quiet }).run(library);
      assert.equal(result.status, 'reported');
      assert.equal(result.retry, false, 'nothing a report can do would drain it');
    }),
  );
});

// The history survives restarts. `record()` is the one choke point every
// terminal path funnels through, so the append lives there, not at six call
// sites.
test('a run is recorded in the journal with what it planned', async () => {
  await withFreshJournal(async () => {
    await run('apply', {}, (result) => {
        assert.equal(result.status, 'applied');
        const [recorded, ...rest] = sheetRuns();
        assert.deepEqual(rest, [], 'one run, one record');
        assert.equal(recorded?.status, 'applied');
        assert.equal(recorded?.mode, 'apply');
        assert.equal(recorded?.error, null);
        assert.match(recorded?.edits[0]?.note ?? '', /Fargo S2: 3 -> 5 episodes/);
      assert.equal(recorded?.edits[0]?.address, 'D4');
    });
  });
});

// An install with no SHEET_ID leaves no trace on disk: the `off` return in
// run() never reaches `record()`.
test('an inert sync writes no journal', async () => {
  await withFreshJournal(async (dir) => {
    await withConfig({ sheetSyncMode: 'off' }, async () => {
      await new SheetSync({ logger: quiet }).run(LIBRARY);
    });
    assert.deepEqual(sheetRuns(), []);
    await assert.rejects(readFile(join(dir, 'sheet-runs.json'), 'utf8'));
  });
});

// --- the freshness gate ----------------------------------------------------

/**
 * Advance the monotonic clock faster than the run can plan. The freshness
 * window is two minutes, so a test cannot wait it out. Each reading is 5
 * minutes past the one before, so every snapshot is stale by the time its plan
 * is ready.
 */
const withRunawayClock = async (fn: () => Promise<void>): Promise<void> => {
  const real = performance.now.bind(performance);
  let ticks = 0;
  performance.now = () => real() + ticks++ * 300_000;
  try {
    await fn();
  } finally {
    performance.now = real;
  }
};

/**
 * A plan is built against row indices, so applying it to a grid that has moved
 * writes to the wrong rows. The gate compares two readings of the same clock —
 * a fixture stamping `readAtMono` from `Date.now()` reads as ~1.7e12 ms old,
 * always fresh, silently disabling this.
 */
test('a snapshot that ages past the freshness window is re-read, never written against', async () => {
  await withRunawayClock(() =>
    run('apply', {}, (result, calls, sheet, _sync, log) => {
      assert.equal(sheet.writes(), 0, 'nothing is written against a stale snapshot');

      const reads = calls.filter((url) => url.includes('ranges=')).length;
      assert.ok(reads > 1, `expected the grid to be re-read, saw ${reads} read(s)`);

      // Bounded: it gives up rather than re-reading forever.
      assert.equal(result.status, 'failed');
      assert.match(log.lines.join('\n'), /aged past/);
    }),
  );
});

// --- season runtimes -------------------------------------------------------

/** Fargo season 2 fully aired and fully watched, with a blank runtime cell. */
const CLOSING_GRID: CellSpec[][] = [H, show('Fargo', 'Watching', 3381), season(1, 6, 44000), seasonRow(2, 3, null, { episodes: null })];

const CLOSING_LIBRARY = libraryOf({
  id: 3381,
  title: 'Fargo',
  status: 'watching',
  seasons: { 1: Array.from({ length: 6 }, (_, i) => daysAgo(400 + i)), 2: Array.from({ length: 10 }, (_, i) => daysAgo(10 - i)) },
  watched: 16,
  total: 16,
  notAired: 0,
});

const tvdbSeason = (minutes: number, count = 10) => () =>
  jsonResponse({ data: { episodes: Array.from({ length: count }, (_, i) => ({ number: i + 1, runtime: minutes })) } });

/** Season 2 fully aired, so the row is due its end date this run. */
const CLOSING_EPISODES = [
  ...Array.from({ length: 6 }, (_, i) => ({ season: 1, episode: i + 1, type: 'episode', aired: true })),
  ...Array.from({ length: 10 }, (_, i) => ({ season: 2, episode: i + 1, type: 'episode', aired: true })),
];

const closingRun = (over: Parameters<typeof server>[0] = {}) =>
  server({ grid: CLOSING_GRID, episodes: CLOSING_EPISODES, detail: { status: 'ended', runtime: 48, ids: { tvdb: '269613' } }, ...over });

const withKey = (fn: () => Promise<void>) =>
  withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL, tvdbApiKey: 'k' }, fn);

test('a season closing writes its end date and its runtime in one verified batch', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  const sheet = closingRun({ tvdb: tvdbSeason(54) });
  await withKey(() =>
    withFetch(sheet.handler, async () => {
      assert.equal((await new SheetSync({ logger: quiet }).run(CLOSING_LIBRARY)).status, 'applied');
      const row = sheet.tabs.get(1)![3]!;
      assert.ok(row[H.indexOf('End')]?.userEnteredValue?.numberValue, 'dated');
      assert.equal(row[H.indexOf('Episodes')]?.userEnteredValue?.numberValue, 54 / 1440, 'and carries the average');
    }),
  );
});

// End is a one-way door, so a poll that cannot reach TVDB must leave the row
// open rather than close it blank for ever.
test('a TVDB outage leaves the row open and asks for another poll', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  const sheet = closingRun({ tvdb: () => new Response('boom', { status: 500 }) });
  await withKey(() =>
    withFetch(sheet.handler, async () => {
      const result = await new SheetSync({ logger: quiet }).run(CLOSING_LIBRARY);
      assert.equal(result.retry, true, 'the work is known to be waiting');
      const row = sheet.tabs.get(1)![3]!;
      assert.equal(row[H.indexOf('End')]?.userEnteredValue?.numberValue, undefined, 'still open');
      assert.equal(row[H.indexOf('Episodes')]?.userEnteredValue, undefined, 'and still blank');
    }),
  );
});

// An account-level TVDB failure escapes the pool by design — it is no fact
// about any one season — but must not escape the run: that would throw away
// the grid read and every SIMKL call over an optional column.
const loginFails = (status: number) => (over: Parameters<typeof server>[0] = {}) => {
  const sheet = closingRun(over);
  return {
    sheet,
    handler: (url: string, init?: RequestInit) =>
      url.startsWith('https://api4.thetvdb.com/v4/login') ? new Response('{"message":"nope"}', { status }) : sheet.handler(url, init),
  };
};

// A typo'd key will never start answering, so leaving rows pending would stop
// the sheet being dated at all — silently, for ever.
test('a rejected TVDB key settles: the season closes on the show-wide runtime', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  const { sheet, handler } = loginFails(401)();
  await withKey(() =>
    withFetch(handler, async () => {
      const result = await new SheetSync({ logger: quiet }).run(CLOSING_LIBRARY);
      assert.notEqual(result.status, 'failed', 'the run is not sunk by an optional lookup');
      assert.equal(result.retry, false, 'and does not re-ask for a poll that cannot help');
      const row = sheet.tabs.get(1)![3]!;
      assert.ok(row[H.indexOf('End')]?.userEnteredValue?.numberValue, 'the season is dated');
      assert.equal(row[H.indexOf('Episodes')]?.userEnteredValue?.numberValue, 48 / 1440, 'on the show-wide length, since no average is coming');
    }),
  );
});

// Same error class, opposite answer: `exchangeToken` raises an auth error for
// any non-ok login, so only the status separates an outage from a typo.
test('a login outage leaves the row open rather than settling it', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  const { sheet, handler } = loginFails(503)();
  await withKey(() =>
    withFetch(handler, async () => {
      const result = await new SheetSync({ logger: quiet }).run(CLOSING_LIBRARY);
      assert.equal(result.retry, true, 'worth asking again');
      const row = sheet.tabs.get(1)![3]!;
      assert.equal(row[H.indexOf('End')]?.userEnteredValue?.numberValue, undefined, 'that row waits');
      assert.equal(row[H.indexOf('Episode')]?.userEnteredValue?.numberValue, 10, 'but its count still advanced');
    }),
  );
});

// Without a key no season average is possible and nothing may reach TVDB —
// but the cell still gets SIMKL's show-wide length, as an inserted row does.
test('with no TVDB key the season closes on the show-wide runtime', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  const sheet = closingRun();
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL, tvdbApiKey: undefined }, () =>
    withFetch(sheet.handler, async (calls) => {
      assert.equal((await new SheetSync({ logger: quiet }).run(CLOSING_LIBRARY)).status, 'applied');
      assert.equal(calls.filter((c) => c.includes('thetvdb.com')).length, 0);
      const row = sheet.tabs.get(1)![3]!;
      assert.ok(row[H.indexOf('End')]?.userEnteredValue?.numberValue, 'dated all the same');
      assert.equal(row[H.indexOf('Episodes')]?.userEnteredValue?.numberValue, 48 / 1440, 'on the show-wide length');
    }),
  );
});

// A finished season's runtimes cannot change, so one answer is terminal.
test('a runtime already read is not looked up a second time', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  const sheet = closingRun({ tvdb: tvdbSeason(54) });
  await withKey(() =>
    withFetch(sheet.handler, async (calls) => {
      const sync = new SheetSync({ logger: quiet });
      await sync.run(CLOSING_LIBRARY);
      const first = calls.filter((c) => c.includes('/episodes/official')).length;
      await sync.run(CLOSING_LIBRARY);
      assert.equal(calls.filter((c) => c.includes('/episodes/official')).length, first, 'asked once');
    }),
  );
});

// A failed runtime lookup is left unrecorded so the next poll asks again — so
// a re-plan would re-issue exactly the lookups that aged the snapshot past
// FRESH_MS, and a throttled season can spend a minute apiece on Retry-After.
// Three rounds of that ends the run `failed`, losing the Episode and Status
// writes the poll already earned.
test('a re-plan does not re-issue the runtime lookups that aged the snapshot', () => {
  clearTokenCache();
  clearTvdbTokenCache();
  const sheet = closingRun({ tvdb: () => new Response('boom', { status: 500 }) });
  return withRunawayClock(() =>
    withKey(() =>
      withFetch(sheet.handler, async (calls) => {
        await new SheetSync({ logger: quiet }).run(CLOSING_LIBRARY);
        assert.ok(calls.filter((c) => c.includes('ranges=')).length > 1, 'the grid was re-read, so a re-plan happened');
        // Two calls: the client's own retry cap, spent on the first attempt.
        assert.equal(
          calls.filter((c) => c.includes('/episodes/official')).length,
          2,
          'TVDB was asked on the first planning attempt only',
        );
      }),
    ),
  );
});

// --- a new row, and the runtime it carries ---------------------------------

/** The same block with no row for season 2 at all, so the run must add one. */
const ADDING_GRID: CellSpec[][] = [H, show('Fargo', 'Watching', 3381), season(1, 6, 44000)];

const addingRun = (over: Parameters<typeof server>[0] = {}) =>
  server({ grid: ADDING_GRID, detail: { status: 'ended', runtime: 48, ids: { tvdb: '269613' } }, ...over });

/** The row the insert created, which lands directly below season 1. */
const addedRow = (sheet: ReturnType<typeof server>) => sheet.tabs.get(1)![3]!;

// `runtimeTarget` refuses a filled cell for ever, so a row added mid-season
// must go in blank or it can never carry its own average.
test('a season still running is added with a blank runtime cell, and nothing is asked of TVDB', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  const sheet = addingRun();
  await withKey(() =>
    withFetch(sheet.handler, async (calls) => {
      assert.equal((await new SheetSync({ logger: quiet }).run(LIBRARY)).status, 'applied');
      const row = addedRow(sheet);
      assert.equal(row[H.indexOf('Season')]?.userEnteredValue?.numberValue, 2, 'the row went in');
      assert.equal(row[H.indexOf('Episodes')]?.userEnteredValue, undefined, 'left for the close to fill');
      assert.equal(row[H.indexOf('End')]?.userEnteredValue, undefined, 'and not dated, because it is still running');
      assert.deepEqual(calls.filter((c) => c.includes('/episodes/official')), []);
    }),
  );
});

test('a season already over when its row is added is dated and averaged in the same batch', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  const sheet = addingRun({ episodes: CLOSING_EPISODES, tvdb: tvdbSeason(54) });
  await withKey(() =>
    withFetch(sheet.handler, async (calls) => {
      assert.equal((await new SheetSync({ logger: quiet }).run(CLOSING_LIBRARY)).status, 'applied');
      const row = addedRow(sheet);
      assert.ok(row[H.indexOf('End')]?.userEnteredValue?.numberValue, 'dated');
      assert.equal(row[H.indexOf('Episodes')]?.userEnteredValue?.numberValue, 54 / 1440, 'and carries its own average, not the show-wide 48');
      assert.equal(calls.filter((c) => c.includes('/episodes/official')).length, 1, 'asked about the row it was about to create');
    }),
  );
});

/**
 * The convergence proof for inserting a complete season open when its runtime
 * has not come back: dating it on the first poll would freeze a blank cell;
 * leaving it open costs one poll and nothing else, because the date comes from
 * the watch timestamp.
 */
test('a TVDB outage adds the row open, and the next poll dates it and fills the cell', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  let answering = false;
  const sheet = addingRun({
    episodes: CLOSING_EPISODES,
    tvdb: () => (answering ? tvdbSeason(54)() : new Response('boom', { status: 500 })),
  });
  await withKey(() =>
    withFetch(sheet.handler, async () => {
      const sync = new SheetSync({ logger: quiet });
      assert.equal((await sync.run(CLOSING_LIBRARY)).status, 'applied');
      const open = addedRow(sheet);
      assert.equal(open[H.indexOf('Season')]?.userEnteredValue?.numberValue, 2, 'the row still went in');
      assert.equal(open[H.indexOf('End')]?.userEnteredValue, undefined, 'undated, so the cell is still fillable');
      assert.equal(open[H.indexOf('Episodes')]?.userEnteredValue, undefined);

      answering = true;
      clearTvdbTokenCache();
      assert.equal((await sync.run(CLOSING_LIBRARY)).status, 'applied');
      const closed = addedRow(sheet);
      assert.ok(closed[H.indexOf('End')]?.userEnteredValue?.numberValue, 'dated on the second poll');
      assert.equal(closed[H.indexOf('Episodes')]?.userEnteredValue?.numberValue, 54 / 1440, 'with the average beside it');
    }),
  );
});

test('with no TVDB key a new row keeps SIMKL’s show-wide runtime', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  const sheet = addingRun();
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL, tvdbApiKey: undefined }, () =>
    withFetch(sheet.handler, async (calls) => {
      assert.equal((await new SheetSync({ logger: quiet }).run(LIBRARY)).status, 'applied');
      assert.equal(addedRow(sheet)[H.indexOf('Episodes')]?.userEnteredValue?.numberValue, 48 / 1440);
      assert.equal(calls.filter((c) => c.includes('thetvdb.com')).length, 0);
    }),
  );
});
