import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { indexLibrary } from '../../src/sheet/1-index.ts';
import { CATALOGUE_ASKS_PER_PASS, MAX_LOOKUPS_PER_ATTEMPT, MAX_PASSES, rationLookups, SheetSync } from '../../src/sheet/sync.ts';
import { clearTokenCache } from '../../src/api/google/auth.ts';
import { clearTokenCache as clearTvdbTokenCache } from '../../src/api/tvdb/auth.ts';
import { cellOf, col, daysAgo, jsonResponse, libraryOf, quiet, recorder, SHEET_COLUMNS, SHEET_HEADERS, todaySerial, withConfig, withFetch, withFreshJournal, type CellSpec, seasonRow, showRow } from '../helpers.ts';
import { CREDENTIAL, DEFAULT_GRID, fakeSheets, type FakeSheetsOptions } from './fake-sheets.ts';
import { sheetRuns } from '../../src/sheet/io/journal.ts';
import { baseline, saveBaseline } from '../../src/sheet/io/baseline.ts';
import { withSheetLock } from '../../src/sheet/io/lock.ts';
import { artworkFormula, dateSerial, seasonKey, showRowFormulas, titleRecordKey, type Baseline } from '../../src/sheet/values.ts';
import type { CellData } from '../../src/api/google/types.ts';
import type { Library } from '../../src/library.ts';
import { plainDateIn } from '../../src/shared/dates.ts';

const H = SHEET_HEADERS;

const show = showRow;
const season = seasonRow;

const server = fakeSheets;

/** The day `LIBRARY`'s season 2 was last watched, as its Status note reads. */
const LAST_WATCHED = plainDateIn(Temporal.Instant.from(daysAgo(6)), 'Europe/London').toString();

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

const run = async (
  mode: 'report' | 'apply',
  options: FakeSheetsOptions,
  assertions: (result: Awaited<ReturnType<SheetSync['run']>>, calls: string[], sheet: ReturnType<typeof server>, sync: SheetSync, log: ReturnType<typeof recorder>) => void | Promise<void>,
  library: Library = LIBRARY,
) => {
  clearTokenCache();
  const sheet = server(options);
  const log = recorder();
  await withConfig({ sheetId: 'SID', sheetSyncMode: mode, googleKeyBase64: CREDENTIAL, timezone: 'Europe/London' }, () =>
    withFetch(sheet.handler, async (calls) => {
      const sync = new SheetSync({ logger: log });
      const result = await sync.run(library);
      await assertions(result, calls, sheet, sync, log);
    }),
  );
};

// The point of the default mode: it can run against the real sheet before the
// service account has Editor access.
test('report mode plans in full and makes no mutating request', async () => {
  await run('report', {}, (result, calls, _sheet, _sync, log) => {
    assert.equal(result.status, 'reported');
    // The count, and the note of when the season was last watched.
    assert.deepEqual(result.record.edits.map((e) => e.field), ['Episodes', 'Seasons / Last Watched']);
    assert.ok(log.lines.some((l) => /Fargo S2: 3 -> 5 episodes/.test(l)), 'the report itself is logged');
    assert.deepEqual(calls.filter((c) => c.includes(':batchUpdate')), []);
  });
});

test('apply mode writes exactly what it planned and verifies it', async () => {
  await run('apply', {}, (result, calls, sheet) => {
    assert.equal(result.status, 'applied', result.error ?? '');
    assert.equal(result.error, null);
    assert.equal(sheet.state[3]?.[col(H, 'Episodes')]?.userEnteredValue?.numberValue, 5);
    assert.equal(sheet.state[3]?.[col(H, 'Seasons / Last Watched')]?.userEnteredValue?.stringValue, LAST_WATCHED, 'and the row says when it was last watched');
    // Snapshot and write in one atomic batch, a verify read, then the snapshot
    // is dropped.
    assert.deepEqual(sheet.batches, [['duplicateSheet', 'updateCells', 'updateCells'], ['deleteSheet']]);
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
  await run('apply', { meddle: (state) => void (state[2]![col(H, 'Episodes')] = cellOf(99)) }, (result, _calls, sheet) => {
    assert.equal(result.status, 'rolled-back');
    assert.match(result.error ?? '', /changed without being planned/);
    // The undone run reports what it planned rather than nothing.
    assert.equal(result.record.edits.length, 2);
    assert.match(result.record.edits[0]?.note ?? '', /Fargo S2: 3 -> 5 episodes/);
    // One wholesale paste from the snapshot, not a cell-by-cell repair.
    assert.deepEqual(sheet.batches, [['duplicateSheet', 'updateCells', 'updateCells'], ['copyPaste'], ['deleteSheet']]);
    // The restore undoes the whole write — the meddled cell and the planned
    // edit both.
    assert.equal(sheet.state[2]?.[col(H, 'Episodes')]?.userEnteredValue?.numberValue, 6);
    assert.equal(sheet.state[3]?.[col(H, 'Episodes')]?.userEnteredValue?.numberValue, 3, 'the planned edit is undone too');
    assert.equal(sheet.state[3]?.[col(H, 'Seasons / Last Watched')]?.userEnteredValue, undefined, 'note included');
  });
});

test('a failed rollback freezes the process rather than writing again', async () => {
  await run('apply', { meddle: (state) => void (state[2]![col(H, 'Episodes')] = cellOf(99)), failRollback: true }, async (result, _calls, sheet, sync) => {
    assert.equal(result.status, 'frozen');
    assert.match(result.error ?? '', /^FROZEN:/);
    assert.equal(result.record.edits.length, 2, 'the freeze reports the plan it froze on');

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
    assert.equal(result.record.edits.length, 2, 'a batch that never landed still had a plan');
    assert.equal(calls.filter((c) => c.includes(':batchUpdate')).length, 1);
    assert.equal(sheet.state[3]?.[col(H, 'Episodes')]?.userEnteredValue?.numberValue, 3, 'unchanged');
  });
});

// The one write that removes a value rather than replacing one, driven end to
// end: an empty `userEnteredValue` has to reach the sheet, and VERIFY has to
// recognise the emptied cell as the write it planned rather than as a
// concurrent hand — the difference between a clean run and a rollback.
test('closing a season empties its watch note, and the run verifies', async () => {
  const grid: CellSpec[][] = [H, show('Fargo', 'Watching', 3381), season(1, 6, 44000), season(2, 3, null, { note: '2024-01-01', runtime: null })];
  const episodes = [
    { season: 1, episode: 1, type: 'episode', aired: true },
    ...Array.from({ length: 2 }, (_, i) => ({ season: 2, episode: i + 1, type: 'episode', aired: true })),
  ];
  const watchedOut = libraryOf({
    id: 3381,
    title: 'Fargo',
    status: 'completed',
    seasons: { 1: [daysAgo(400)], 2: [daysAgo(4), daysAgo(2)] },
    watched: 3,
    total: 3,
  });

  await run(
    'apply',
    { grid, episodes },
    (result, _calls, sheet) => {
      assert.equal(result.status, 'applied', result.error ?? '');
      assert.ok(sheet.state[3]?.[col(H, 'End Date')]?.userEnteredValue?.numberValue, 'the row is dated');
      assert.equal(sheet.state[3]?.[col(H, 'Seasons / Last Watched')]?.userEnteredValue, undefined, 'and the note is gone, not blanked to an empty string');
    },
    watchedOut,
  );
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
  // The sheet already holds what SIMKL says. The blank Status cell is part of
  // the assertion: a note dates a count, so a row whose count does not move
  // gets none, and this run has nothing at all to write.
  sheet.state[3]![col(H, 'Episodes')] = cellOf(5);
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL, timezone: 'Europe/London' }, () =>
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

// A page write holds the lock from its read to its verify; the sync's own
// read must not begin until it is released, or the sync verifies a tab the
// page changed under it and rolls the page's write back.
test('a run waits for the sheet lock before its first read', async () => {
  clearTokenCache();
  const sheet = server();
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL, timezone: 'Europe/London' }, () =>
    withFetch(sheet.handler, async (calls) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = withSheetLock(() => held);
      const running = new SheetSync({ logger: quiet }).run(LIBRARY);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(
        calls.filter((c) => c.includes('/spreadsheets/')),
        [],
        'the sync read nothing while the lock was held',
      );
      release();
      await holder;
      const result = await running;
      assert.equal(result.status, 'applied');
    }),
  );
});

// The lock is held across the whole attempt, lookups included: releasing it
// between the read and the write is exactly the gap it exists to close.
test('a run holds the sheet lock until its verify has completed', async () => {
  clearTokenCache();
  const sheet = server();
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL, timezone: 'Europe/London' }, () =>
    withFetch(sheet.handler, async (calls) => {
      const running = new SheetSync({ logger: quiet }).run(LIBRARY);
      // Queued behind the run: it runs only once the run has released.
      const after = withSheetLock(async () => calls.length);
      const result = await running;
      assert.equal(result.status, 'applied');
      assert.equal(await after, calls.length, 'every request of the run had been made before the lock passed on');
      assert.ok(calls.some((c) => c.includes(':batchUpdate')));
    }),
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
      assert.equal(again.record.edits.length, 2);
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

  const sheet = server({ grid: rows, episodes, meddle: (state) => void (state[5]![col(H, 'Episodes')] = cellOf(999)) });
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
      assert.deepEqual([...sheet.titles.values()], ['Shows'], 'no backup tab left behind');
    }),
  );
});

// The snapshot makes a frozen sheet recoverable without version-history
// archaeology, so it must survive exactly when the rollback did not — renamed
// out of the swept namespace, because `frozen` is process state a restart
// forgets.
test('a failed rollback keeps the backup tab, renames it for repair, and names it', async () => {
  clearTokenCache();
  const sheet = server({ meddle: (state) => void (state[2]![col(H, 'Episodes')] = cellOf(99)), failRollback: true });
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async () => {
      const result = await new SheetSync({ logger: quiet }).run(LIBRARY);
      assert.equal(result.status, 'frozen');
      const titles = [...sheet.titles.values()];
      const repair = titles.find((t) => t.startsWith('_sync-REPAIR-'));
      assert.ok(repair, 'the snapshot tab survives a failed rollback');
      assert.deepEqual(titles.filter((t) => t.startsWith('_sync-backup-')), [], 'and is out of the swept namespace');
      assert.ok(result.error?.includes(repair), 'and the frozen message names it by its new name');
      assert.match(result.error ?? '', /copy it back over Shows/);
    }),
  );
});

// "No id" is not "no tab": a timeout loses the reply carrying the new sheetId
// while the duplicate sits right there. Left under the swept name, the repair
// target is deleted by the next clean run.
test('a snapshot whose id was lost is still found and renamed', async () => {
  clearTokenCache();
  const sheet = server({ meddle: (state) => void (state[2]![col(H, 'Episodes')] = cellOf(99)), hideReplies: true, failTabLists: 4 });
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
  const sheet = server({ meddle: (state) => void (state[2]![col(H, 'Episodes')] = cellOf(99)), hideReplies: true, failTabLists: 8 });
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
  sheet.titles.set(98, '_sync-REPAIR-1-2020-01-01T00-00-00-000Z');
  sheet.tabs.set(98, []);
  sheet.titles.set(99, '_sync-backup-1-2020-01-01T00-00-00-000Z');
  sheet.tabs.set(99, []);

  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async () => {
      assert.equal((await new SheetSync({ logger: quiet }).run(LIBRARY)).status, 'applied');
      assert.deepEqual([...sheet.titles.values()], ['Shows', '_sync-REPAIR-1-2020-01-01T00-00-00-000Z']);
    }),
  );
});

test('a clean run leaves no backup tab behind', async () => {
  clearTokenCache();
  const sheet = server();
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async () => {
      assert.equal((await new SheetSync({ logger: quiet }).run(LIBRARY)).status, 'applied');
      assert.deepEqual([...sheet.titles.values()], ['Shows']);
    }),
  );
});

// Any failure between the write and the verify read strands a snapshot tab. A
// clean run is the one moment the tab is known good, so it clears the lot.
test('a clean run sweeps snapshot tabs an earlier run left behind', async () => {
  clearTokenCache();
  const sheet = server();
  sheet.titles.set(99, '_sync-backup-1-2020-01-01T00-00-00-000Z');
  sheet.tabs.set(99, []);

  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async () => {
      assert.equal((await new SheetSync({ logger: quiet }).run(LIBRARY)).status, 'applied');
      assert.deepEqual([...sheet.titles.values()], ['Shows'], 'the orphan goes too');
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

/**
 * A backlog held back by the edit budget is the same claim a deferred row makes:
 * the work exists and only this run's own rationing holds it. Without the retry
 * a library marked whole would drain a budget every half hour at best, and at
 * worst sit until something unrelated woke a poll.
 */
test('a run that held rows back for the edit budget asks for another poll', async () => {
  clearTokenCache();
  const rows = 8;
  const grid: CellSpec[][] = [H, show('Long Show', 'Watching', 3381), ...Array.from({ length: rows }, (_, i) => season(i + 1, 0, null))];
  const library = libraryOf({
    id: 3381,
    title: 'Long Show',
    status: 'completed',
    seasons: Object.fromEntries(Array.from({ length: rows }, (_, i) => [i + 1, [daysAgo(500 + i), daysAgo(499 + i)]])),
    watched: rows * 2,
    total: rows * 2,
  });
  const episodes = Array.from({ length: rows }, (_, i) => [
    { season: i + 1, episode: 1, type: 'episode', aired: true },
    { season: i + 1, episode: 2, type: 'episode', aired: true },
  ]).flat();

  const sheet = server({ grid, episodes });
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL, sheetMaxEdits: 8 }, () =>
    withFetch(sheet.handler, async () => {
      // Every count recorded at zero, so every row has moved and none was
      // watched inside the window: the whole backlog is in scope at once.
      const seen: Baseline = new Map([[titleRecordKey(3381), { Status: 'watching' }]]);
      for (let n = 1; n <= rows; n += 1) seen.set(seasonKey(3381, n), { Watched: '0' });
      await saveBaseline(seen);

      const result = await new SheetSync({ logger: quiet }).run(library);
      assert.equal(result.status, 'applied', result.error ?? '');
      assert.ok(result.record.edits.length <= 8, 'inside the budget rather than refused whole');
      assert.equal(result.retry, true, 'and the rows it left ask for another poll');
    }),
  );
});

/**
 * The forget reaches the file. `PlanResult.forgetting` is pinned at the
 * planner and `saveBaseline`'s drop at the file; this is the link between them,
 * which nothing else exercises and which a dropped argument would sever
 * without a type error.
 */
test('a dated row the budget holds back has its count dropped from the record', async () => {
  const grid: CellSpec[][] = [H, show('Short Show', 'Ended', 3381), season(1, 2, null)];
  const library = libraryOf({
    id: 3381,
    title: 'Short Show',
    status: 'completed',
    seasons: { 1: [daysAgo(3), daysAgo(2)] },
    watched: 2,
    total: 2,
  });
  const episodes = [
    { season: 1, episode: 1, type: 'episode', aired: true },
    { season: 1, episode: 2, type: 'episode', aired: true },
  ];
  const sheet = server({ grid, episodes });
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'report', googleKeyBase64: CREDENTIAL, sheetMaxEdits: 0 }, () =>
    withFetch(sheet.handler, async () => {
      // Recorded at SIMKL's own count, so only the close is left to write and
      // only the window keeps the row in scope.
      await saveBaseline(new Map([[titleRecordKey(3381), { Status: 'completed' }], [seasonKey(3381, 1), { Watched: '2' }]]));

      const result = await new SheetSync({ logger: quiet }).run(library);
      assert.equal(result.status, 'idle', result.error ?? '');
      assert.equal(baseline().get(seasonKey(3381, 1))?.Watched, undefined, 'the held row is forgotten, so the record brings it back');
      assert.equal(baseline().has(seasonKey(3381, 1)), true, 'and the key still says the season was seen');
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
      assert.equal(recorded?.edits[0]?.address, 'K4');
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
const CLOSING_GRID: CellSpec[][] = [H, show('Fargo', 'Watching', 3381), season(1, 6, 44000), seasonRow(2, 3, null, { runtime: null })];

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
      assert.ok(row[col(H, 'End Date')]?.userEnteredValue?.numberValue, 'dated');
      assert.equal(row[col(H, 'Episode Length (min)')]?.userEnteredValue?.numberValue, 54, 'and carries the average');
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
      assert.equal(row[col(H, 'End Date')]?.userEnteredValue?.numberValue, undefined, 'still open');
      assert.equal(row[col(H, 'Episode Length (min)')]?.userEnteredValue, undefined, 'and still blank');
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
      assert.ok(row[col(H, 'End Date')]?.userEnteredValue?.numberValue, 'the season is dated');
      assert.equal(row[col(H, 'Episode Length (min)')]?.userEnteredValue?.numberValue, 48, 'on the show-wide length, since no average is coming');
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
      assert.equal(row[col(H, 'End Date')]?.userEnteredValue?.numberValue, undefined, 'that row waits');
      assert.equal(row[col(H, 'Episodes')]?.userEnteredValue?.numberValue, 10, 'but its count still advanced');
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
      assert.ok(row[col(H, 'End Date')]?.userEnteredValue?.numberValue, 'dated all the same');
      assert.equal(row[col(H, 'Episode Length (min)')]?.userEnteredValue?.numberValue, 48, 'on the show-wide length');
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
      assert.equal(row[col(H, 'Season')]?.userEnteredValue?.numberValue, 2, 'the row went in');
      assert.equal(row[col(H, 'Episode Length (min)')]?.userEnteredValue, undefined, 'left for the close to fill');
      assert.equal(row[col(H, 'End Date')]?.userEnteredValue, undefined, 'and not dated, because it is still running');
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
      assert.ok(row[col(H, 'End Date')]?.userEnteredValue?.numberValue, 'dated');
      assert.equal(row[col(H, 'Episode Length (min)')]?.userEnteredValue?.numberValue, 54, 'and carries its own average, not the show-wide 48');
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
      assert.equal(open[col(H, 'Season')]?.userEnteredValue?.numberValue, 2, 'the row still went in');
      assert.equal(open[col(H, 'End Date')]?.userEnteredValue, undefined, 'undated, so the cell is still fillable');
      assert.equal(open[col(H, 'Episode Length (min)')]?.userEnteredValue, undefined);

      answering = true;
      clearTvdbTokenCache();
      assert.equal((await sync.run(CLOSING_LIBRARY)).status, 'applied');
      const closed = addedRow(sheet);
      assert.ok(closed[col(H, 'End Date')]?.userEnteredValue?.numberValue, 'dated on the second poll');
      assert.equal(closed[col(H, 'Episode Length (min)')]?.userEnteredValue?.numberValue, 54, 'with the average beside it');
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
      assert.equal(addedRow(sheet)[col(H, 'Episode Length (min)')]?.userEnteredValue?.numberValue, 48);
      assert.equal(calls.filter((c) => c.includes('thetvdb.com')).length, 0);
    }),
  );
});

// --- following SIMKL, across runs -------------------------------------------

/**
 * Season 1 is dated in the default grid, so nothing else the planner does can
 * reach it. Its *last* watch is held fixed and only its first moves, so a
 * change is one field wide and the assertions name it exactly.
 */
const fargo = (first: number): Library =>
  libraryOf({
    id: 3381,
    title: 'Fargo',
    status: 'watching',
    seasons: {
      1: [daysAgo(first), ...Array.from({ length: 5 }, (_, i) => daysAgo(25 - i))],
      2: Array.from({ length: 5 }, (_, i) => daysAgo(10 - i)),
    },
    watched: 11,
    total: 16,
    notAired: 5,
  });

/**
 * The default grid dates season 1 in 2020, which no recent watch can sit
 * before — the guard refuses a start after the row's end, and rightly. Dated
 * today instead, so the row is closed and its dates are consistent.
 */
const DATED = DEFAULT_GRID.map((row, i) => (i === 2 ? season(1, 6, todaySerial('Europe/London')) : row));

/** Where season 1's `Start` cell sits in that grid. */
const S1_START = 'M3';

test('a change is written only once the value before it has been observed', async () => {
  await run(
    'apply',
    { grid: DATED },
    async (first, _calls, _sheet, sync) => {
      // First sight of season 1: recorded, and nothing written about it —
      // whatever its Start cell already held.
      assert.deepEqual(first.record.edits.map((e) => e.field), ['Episodes', 'Seasons / Last Watched']);

      // Now it moves, and the dated row takes the new date.
      const second = await sync.run(fargo(31));
      assert.equal(second.status, 'applied');
      assert.deepEqual(second.record.edits.map((e) => [e.address, e.field]), [[S1_START, 'Start Date']]);

      // Applied, so the new value is recorded and the same edit is not planned
      // a second time.
      const third = await sync.run(fargo(31));
      assert.deepEqual(third.record.edits, []);
    },
    fargo(30),
  );
});

/**
 * The asymmetry the whole mechanism rests on. A value is recorded only once the
 * write carrying it has landed — so a run that wrote nothing plans the same
 * edit again, rather than banking a change the sheet never received and finding
 * nothing moved ever after.
 */
test('a run that wrote nothing leaves the change to be planned again', async () => {
  await run(
    'report',
    { grid: DATED },
    async (_first, _calls, _sheet, sync) => {
      const reported = await sync.run(fargo(31));
      assert.equal(reported.status, 'reported');
      assert.ok(reported.record.edits.some((e) => e.address === S1_START));

      const again = await sync.run(fargo(31));
      assert.ok(again.record.edits.some((e) => e.address === S1_START), 'report mode wrote nothing, so the change is still pending');
    },
    fargo(30),
  );
});

// --- a block for a show with no row -----------------------------------------
//
// A TV show the tab has no block for, watched twice into a season that has
// finished airing — so a run must ask all three upstreams: SIMKL for the detail
// and the episode list, TVDB for the genres and the season's runtimes, TMDB for
// the content rating. Each test below withholds one of those answers.
//
// `Severance` sorts after `Fargo` under `compareFranchise`, so the block lands
// below the grid's one block rather than under the header, where
// `inheritFromBefore` would take the header's formats.

const NEW_SHOW = { id: 900, title: 'Severance' } as const;
const FIRST_WATCH = daysAgo(9);
const LAST_WATCH = daysAgo(2);

const NEW_SHOW_LIBRARY: Library = libraryOf({
  id: NEW_SHOW.id,
  title: NEW_SHOW.title,
  status: 'watching',
  seasons: { 1: [FIRST_WATCH, LAST_WATCH] },
  watched: 2,
  total: 9,
});

/** The detail every `/tv/{id}` answers with: the ids both show-facts lookups ride on. */
const NEW_SHOW_DETAIL = { title: NEW_SHOW.title, status: 'airing', runtime: 45, network: 'Apple TV+', ids: { tvdb: '111', tmdb: '222' } };

/** Season 1 fully aired, which is what makes the season runtime askable. */
const NEW_SHOW_EPISODES = Array.from({ length: 9 }, (_, i) => ({ season: 1, episode: i + 1, type: 'episode', aired: true }));

/**
 * TVDB's two answers, told apart by path. `/extended` carries the genre list
 * in TVDB's own genre-id order, which is the order the primary is picked out
 * of; `/episodes/official` is the season runtime, and its episode count must
 * agree with SIMKL's or the average is refused.
 */
const tvdbSeries = (genres: string[] = ['Drama', 'Science Fiction', 'Suspense'], minutes = 47) => (url: string) => {
  if (url.includes('/extended')) return jsonResponse({ data: { genres: genres.map((name, i) => ({ id: i, name })) } });
  if (url.includes('/episodes/official')) return jsonResponse({ data: { episodes: NEW_SHOW_EPISODES.map((e) => ({ number: e.episode, runtime: minutes })) } });
  throw new Error(`unexpected TVDB request: ${url}`);
};

const tmdbRating = (rating = '15') => () => jsonResponse({ content_ratings: { results: [{ iso_3166_1: 'GB', rating }] } });

const SHOW_BUCKET = 'shows-bucket';

/** Both keys, both buckets: everything a block needs, so a test can withhold one. */
const withBlockKeys = (over: Parameters<typeof withConfig>[0], fn: () => Promise<void>) =>
  withConfig(
    {
      sheetId: 'SID',
      sheetSyncMode: 'apply',
      googleKeyBase64: CREDENTIAL,
      timezone: 'Europe/London',
      tvdbApiKey: 'k',
      tmdbApiKey: 't',
      artworkMovieBucket: 'films-bucket',
      artworkShowBucket: SHOW_BUCKET,
      ...over,
    },
    fn,
  );

const blockServer = (over: Parameters<typeof server>[0] = {}) =>
  server({ grid: DEFAULT_GRID, episodes: NEW_SHOW_EPISODES, detail: NEW_SHOW_DETAIL, tvdb: tvdbSeries(), tmdb: tmdbRating(), ...over });

/** Upstream calls as origin + path, sorted: the two facts run in parallel, so raw order is a race. */
const upstream = (calls: string[]): string[] =>
  calls
    .filter((c) => !c.includes('googleapis.com'))
    .map((c) => `${new URL(c).origin}${new URL(c).pathname}`)
    .sort();

const cell = (rows: CellData[][], row: number, label: string) => rows[row]?.[col(H, label)]?.userEnteredValue;

test('a TV show with no block gets one, in one run, from three upstreams', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  const sheet = blockServer();
  await withFreshJournal(async () => {
    const log = recorder();
    await withBlockKeys({}, () =>
      withFetch(sheet.handler, async (calls) => {
        const result = await new SheetSync({ logger: log }).run(NEW_SHOW_LIBRARY);
        assert.equal(result.status, 'applied', result.error ?? '');

        // One call per upstream fact, and nothing asked twice.
        assert.deepEqual(upstream(calls), [
          'https://api.simkl.com/tv/900',
          'https://api.simkl.com/tv/episodes/900',
          'https://api.themoviedb.org/3/tv/222',
          'https://api4.thetvdb.com/v4/login',
          'https://api4.thetvdb.com/v4/series/111/episodes/official',
          'https://api4.thetvdb.com/v4/series/111/extended',
        ]);
        assert.ok(
          calls.some((c) => c.includes('/3/tv/222') && c.includes('append_to_response=content_ratings')),
          'the ratings ride the detail request rather than costing a second one',
        );
        assert.ok(calls.some((c) => c.includes('/episodes/official') && c.includes('season=1')));
        // Four planning passes is what a block costs — the runtime target is
        // only reached once the genres and the certificate are in hand.
        assert.doesNotMatch(log.lines.join('\n'), /still demanding lookups/);

        // Two rows, in franchise order: under Fargo's last season row.
        const rows = sheet.tab('Shows');
        assert.equal(rows.length, DEFAULT_GRID.length + 2);
        assert.equal(cell(rows, 4, 'Title')?.stringValue, 'Severance');
        assert.equal(cell(rows, 4, 'Franchise')?.stringValue, 'Severance');
        assert.equal(cell(rows, 4, 'Genre')?.stringValue, 'Drama', 'TVDB’s own order, mapped to the tab’s vocabulary');
        assert.equal(cell(rows, 4, 'Other Genres')?.stringValue, 'Sci-Fi, Thriller');
        assert.equal(cell(rows, 4, 'Network')?.stringValue, 'Apple TV+', 'SIMKL’s, through the spelling map');
        assert.equal(cell(rows, 4, 'Certificate')?.numberValue, 15, 'TMDB’s GB rating, as an age');
        assert.equal(cell(rows, 4, 'Type')?.stringValue, 'show');
        assert.equal(cell(rows, 4, 'Status')?.stringValue, 'Watching');
        // Text, as all 189 live show rows hold it: a number compares unequal to
        // every other id cell, so the next run would not recognise its own block.
        assert.deepEqual(cell(rows, 4, 'ID'), { stringValue: '900' });

        // The five roll-ups and the artwork link, byte for byte — the one place
        // the sync writes a formula, and a wrong reference here is a frozen
        // number nothing would ever notice.
        const formulas = showRowFormulas(SHEET_COLUMNS, 4);
        assert.equal(cell(rows, 4, 'Season')?.formulaValue, formulas.Season);
        assert.equal(cell(rows, 4, 'Episodes')?.formulaValue, formulas.Episode);
        assert.equal(cell(rows, 4, 'Start Date')?.formulaValue, formulas.Start);
        assert.equal(cell(rows, 4, 'End Date')?.formulaValue, formulas.End);
        assert.equal(cell(rows, 4, 'Seasons / Last Watched')?.formulaValue, formulas.Note);
        assert.equal(cell(rows, 4, 'Artwork')?.formulaValue, artworkFormula(SHEET_COLUMNS.Show, 4, SHOW_BUCKET));
        assert.equal(cell(rows, 4, 'Episode Length (min)'), undefined, 'blank on a show row, as on all 309 live ones');

        // The season row under it is a season insert's own: count, dates and
        // the note that dates the count.
        assert.equal(cell(rows, 5, 'Season')?.numberValue, 1);
        assert.equal(cell(rows, 5, 'Episodes')?.numberValue, 2);
        assert.equal(cell(rows, 5, 'Start Date')?.numberValue, dateSerial(plainDateIn(Temporal.Instant.from(FIRST_WATCH), 'Europe/London')));
        assert.equal(cell(rows, 5, 'Seasons / Last Watched')?.stringValue, plainDateIn(Temporal.Instant.from(LAST_WATCH), 'Europe/London').toString());
        assert.equal(cell(rows, 5, 'Episode Length (min)')?.numberValue, 47, 'the season’s own average, not SIMKL’s show-wide 45');
        assert.equal(cell(rows, 5, 'End Date'), undefined, 'part-watched, so the row goes in open');
        assert.equal(cell(rows, 5, 'ID'), undefined, 'the season row inherits the block’s id rather than repeating it');

        const recorded = sheetRuns().find((r) => r.tab === 'shows');
        assert.equal(recorded?.status, 'applied');
        assert.equal(recorded?.inserts[0]?.address, 'rows 5-6');
        assert.match(recorded?.inserts[0]?.note ?? '', /Severance \(simkl 900\): new block at rows 5-6, S1 with 2 episodes/);
      }),
    );
  });
});

/**
 * Marking a back catalogue watched stamps every episode at its air date, so the
 * library says nothing has happened here for years. What is recent is the title
 * having appeared in a record that already names others, and the block it earns
 * lands **whole** — a show row and every season row in one span, so the grid is
 * never left with a block whose roll-ups count the next block's rows.
 */
const MARKED_SEASONS = [1, 2, 3];

const MARKED_EPISODES = MARKED_SEASONS.flatMap((season) =>
  Array.from({ length: 9 }, (_, i) => ({ season, episode: i + 1, type: 'episode', aired: true })),
);

const MARKED_WHOLE: Library = libraryOf({
  id: NEW_SHOW.id,
  title: NEW_SHOW.title,
  status: 'completed',
  seasons: Object.fromEntries(MARKED_SEASONS.map((season) => [season, Array.from({ length: 9 }, (_, i) => daysAgo(900 - season * 10 - i))])),
  watched: 27,
  total: 27,
});

// The tab's outline: every block's season rows sit in a row group under its
// show row. Sheets extends a group when rows are inserted at its end, and a
// block goes in exactly there, so without the regroup the new show row and its
// seasons fold under the block above — 23 of the 23 blocks the sync inserted
// before the step landed that way. Seeded, because without a group for the
// insert to extend a passing test proves only that `addDimensionGroup` ran.
test('a new block gets a row group of its own, and the block above keeps the end of its group', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  // Fargo's two season rows are rows 2-3; Severance lands at rows 4-5.
  const sheet = blockServer({ rowGroups: [[2, 4]] });
  await withFreshJournal(async () => {
    await withBlockKeys({}, () =>
      withFetch(sheet.handler, async () => {
        const result = await new SheetSync({ logger: recorder() }).run(NEW_SHOW_LIBRARY);
        assert.equal(result.status, 'applied', result.error ?? '');
        assert.equal(cell(sheet.tab('Shows'), 4, 'Title')?.stringValue, 'Severance');
        assert.deepEqual(sheet.rowGroups(), [[2, 4], [5, 6]]);
      }),
    );
  });
});

// A season row added at the end of its block lands where the group already grew
// over it; the regroup over its own row must leave one group, not split it.
test('a season row joins its block’s row group', async () => {
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
  const sheet = server({ grid, episodes, rowGroups: [[2, 3]] });
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async () => {
      const result = await new SheetSync({ logger: recorder() }).run(library);
      assert.equal(result.status, 'applied', result.error ?? '');
      assert.equal(sheet.tabs.get(1)?.length, grid.length + 1, 'the row was added');
      assert.deepEqual(sheet.rowGroups(), [[2, 4]]);
    }),
  );
});

test('a show marked whole today gets its whole block, though every episode is stamped years back', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  const seasonsAsked: string[] = [];
  const sheet = blockServer({
    episodes: MARKED_EPISODES,
    tvdb: (url: string) => {
      if (url.includes('/extended')) return jsonResponse({ data: { genres: [{ id: 0, name: 'Drama' }] } });
      if (url.includes('/episodes/official')) {
        seasonsAsked.push(new URL(url).searchParams.get('season') ?? '?');
        return jsonResponse({ data: { episodes: Array.from({ length: 9 }, (_, i) => ({ number: i + 1, runtime: 47 })) } });
      }
      throw new Error(`unexpected TVDB request: ${url}`);
    },
  });
  await withFreshJournal(async () => {
    // Inside the config block: `withConfig` clears the baseline on entry, and
    // the record of some other title is what makes this one new.
    await withBlockKeys({}, () =>
      withFetch(sheet.handler, async () => {
        await saveBaseline(new Map([[titleRecordKey(4242), { Status: 'watching' }]]));
        const sync = new SheetSync({ logger: recorder() });
        const result = await sync.run(MARKED_WHOLE);
        assert.equal(result.status, 'applied', result.error ?? '');

        const rows = sheet.tab('Shows');
        assert.equal(rows.length, DEFAULT_GRID.length + 4, 'a show row and three season rows');
        assert.equal(cell(rows, 4, 'Title')?.stringValue, 'Severance');
        assert.deepEqual(
          [5, 6, 7].map((row) => cell(rows, row, 'Season')?.numberValue),
          [1, 2, 3],
        );
        assert.deepEqual(
          [5, 6, 7].map((row) => cell(rows, row, 'Episodes')?.numberValue),
          [9, 9, 9],
        );
        assert.deepEqual(seasonsAsked.sort(), ['1', '2', '3'], 'one episode-list call per season, so every row carries its own runtime');
      }),
    );
  });
});

// A cell on a show row is written once and never revisited, so a fact that did
// not come back leaves the whole block for the next poll rather than landing a
// row with a blank `Genre` for good.
test('a TVDB outage adds no block, asks for another poll, and the next one adds it', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  let answering = false;
  const sheet = blockServer({
    tvdb: (url: string) => (!answering && url.includes('/extended') ? new Response('boom', { status: 503 }) : tvdbSeries()(url)),
  });
  await withBlockKeys({}, () =>
    withFetch(sheet.handler, async () => {
      const sync = new SheetSync({ logger: quiet });
      const first = await sync.run(NEW_SHOW_LIBRARY);
      assert.equal(first.status, 'idle');
      assert.equal(first.retry, true, 'the work is known to be waiting');
      assert.equal(sheet.tab('Shows').length, DEFAULT_GRID.length, 'and no half-filled row was added');

      answering = true;
      assert.equal((await sync.run(NEW_SHOW_LIBRARY)).status, 'applied');
      assert.equal(cell(sheet.tab('Shows'), 4, 'Genre')?.stringValue, 'Drama', 'the block lands once TVDB answers');
    }),
  );
});

// A rejected key is a fact about the token and not about any series, and both
// keys are read at start-up: settling the waiting shows would file them as ones
// TMDB has nothing for, and asking again every poll settles nothing.
test('a TMDB 401 latches for the process, and nothing is asked of it again', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  let asked = 0;
  const sheet = blockServer({
    tmdb: () => {
      asked += 1;
      return new Response('{"status_message":"invalid token"}', { status: 401 });
    },
  });
  await withBlockKeys({}, () =>
    withFetch(sheet.handler, async () => {
      const log = recorder();
      const sync = new SheetSync({ logger: log });
      await sync.run(NEW_SHOW_LIBRARY);
      assert.ok(asked > 0, 'it was asked once');
      assert.match(log.lines.join('\n'), /TMDB rejected the credential/);

      const rejected = asked;
      log.lines.length = 0;
      const again = await sync.run(NEW_SHOW_LIBRARY);
      assert.equal(again.status, 'idle');
      assert.equal(asked, rejected, 'and never again this process');
      assert.match(log.lines.join('\n'), /1 show\(s\) need a block and the credential was rejected; fix TMDB_API_KEY and restart/);
      assert.equal(sheet.tab('Shows').length, DEFAULT_GRID.length);
    }),
  );
});

// The same rule against the other key. TVDB counts a 403 as `account` too,
// where TMDB does not — there it is a stricter reading of a wider class, and
// here it costs the same restart.
test('a TVDB 401 latches for the process, and nothing is asked of it again', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  let asked = 0;
  const sheet = blockServer({
    tvdb: (url: string) => {
      if (!url.includes('/extended')) return tvdbSeries()(url);
      asked += 1;
      return new Response('{"message":"unauthorized"}', { status: 401 });
    },
  });
  await withBlockKeys({}, () =>
    withFetch(sheet.handler, async () => {
      const log = recorder();
      const sync = new SheetSync({ logger: log });
      await sync.run(NEW_SHOW_LIBRARY);
      assert.ok(asked > 0, 'it was asked');
      assert.match(log.lines.join('\n'), /TVDB rejected the credential/);

      const rejected = asked;
      log.lines.length = 0;
      assert.equal((await sync.run(NEW_SHOW_LIBRARY)).status, 'idle');
      assert.equal(asked, rejected, 'and never again this process');
      assert.match(log.lines.join('\n'), /1 show\(s\) need a block and the credential was rejected; fix TVDB_API_KEY and restart/);
      assert.equal(sheet.tab('Shows').length, DEFAULT_GRID.length);
    }),
  );
});

// TMDB answers a throttled or blocked request with 403 as readily as a rejected
// token, so a 403 must not latch: the series waits a poll and is asked again.
test('a TMDB 403 is asked again on the next poll', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  let blocked = true;
  const sheet = blockServer({ tmdb: () => (blocked ? new Response('nope', { status: 403 }) : tmdbRating()()) });
  await withBlockKeys({}, () =>
    withFetch(sheet.handler, async (calls) => {
      const sync = new SheetSync({ logger: quiet });
      const first = await sync.run(NEW_SHOW_LIBRARY);
      assert.equal(first.retry, true, 'a transient failure asks for another poll');
      assert.equal(sheet.tab('Shows').length, DEFAULT_GRID.length);

      blocked = false;
      calls.length = 0;
      assert.equal((await sync.run(NEW_SHOW_LIBRARY)).status, 'applied');
      assert.ok(calls.some((c) => c.includes('/3/tv/222')), 'TMDB is asked again rather than settled');
      assert.equal(cell(sheet.tab('Shows'), 4, 'Certificate')?.numberValue, 15);
    }),
  );
});

// A block is two rows, so a rollback has to delete both: a delete that took
// only the show row would leave its season row orphaned under the block above,
// where the paste cannot reach it — the restore overwrites a range, it does not
// shrink the grid.
test('a block that does not verify is rolled back, both of its rows deleted first', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  const sheet = blockServer({ meddle: (state) => void (state[2]![col(H, 'Episodes')] = cellOf(99)) });
  const typed = () => JSON.stringify(sheet.tab('Shows').map((row) => row.map((c) => c.userEnteredValue ?? null)));
  const original = typed();

  await withBlockKeys({}, () =>
    withFetch(sheet.handler, async () => {
      const result = await new SheetSync({ logger: quiet }).run(NEW_SHOW_LIBRARY);
      assert.equal(result.status, 'rolled-back', result.error ?? '');
      assert.equal(result.record.inserts.length, 1, 'the undone run still reports the block it planned');

      assert.ok(sheet.batches[0]?.includes('insertDimension'), 'the write batch carried the insert');
      assert.deepEqual(sheet.batches[1], ['deleteDimension', 'deleteDimension'], 'both rows go, and the delete travels alone');
      assert.deepEqual(sheet.batches[2], ['copyPaste']);
      assert.equal(typed(), original, 'every cell holds exactly what it held before the write');
    }),
  );
});

// One insert per run, and a season row joining a block that exists wins it. The
// lookups the block still needs are then the *next* poll's: fetched now, every
// pass to the ceiling would spend another round on a row that cannot land.
test('a season insert takes the slot, and the block’s facts are left for the next poll', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  // Fargo has a row for season 1 only and has been watched into season 2,
  // which is still airing — so its insert needs no runtime lookup of its own.
  const grid: CellSpec[][] = [H, show('Fargo', 'Watching', 3381), season(1, 6, 44000)];
  const episodes = [
    ...NEW_SHOW_EPISODES,
    ...Array.from({ length: 5 }, (_, i) => ({ season: 2, episode: i + 1, type: 'episode', aired: i < 2 })),
  ];
  const library = libraryOf(
    { id: 3381, title: 'Fargo', status: 'watching', seasons: { 1: [daysAgo(400)], 2: [daysAgo(4), daysAgo(3)] }, watched: 3, total: 14, notAired: 3 },
    { id: NEW_SHOW.id, title: NEW_SHOW.title, status: 'watching', seasons: { 1: [FIRST_WATCH, LAST_WATCH] }, watched: 2, total: 9 },
  );

  const sheet = blockServer({ grid, episodes });
  await withBlockKeys({}, () =>
    withFetch(sheet.handler, async (calls) => {
      const sync = new SheetSync({ logger: quiet });
      const first = await sync.run(library);
      assert.equal(first.status, 'applied', first.error ?? '');
      assert.equal(first.record.inserts[0]?.address, 'row 4', 'the season row took the slot');
      assert.equal(first.retry, true, 'and the block the run left standing asks for another poll');
      assert.deepEqual(
        upstream(calls).filter((c) => c.includes('/series/') || c.includes('/3/tv/')),
        [],
        'nothing is asked of TVDB or TMDB for a block this run cannot insert',
      );

      calls.length = 0;
      const second = await sync.run(library);
      assert.equal(second.status, 'applied', second.error ?? '');
      assert.equal(second.record.inserts[0]?.address, 'rows 5-6', 'the next run adds the block');
      assert.equal(cell(sheet.tab('Shows'), 4, 'Title')?.stringValue, 'Severance');
    }),
  );
});

/**
 * SIMKL's details are the one allowance that is per **pass**, because they are
 * what a pass reads the grid and the library with rather than what one insert
 * waits on. A cold library past one pass's worth therefore drains across the
 * passes of the same run rather than stalling at the first — where the three
 * upstreams a block's show row waits on stay per attempt, which the
 * `rationLookups` tests below pin.
 */
test('a cold start drains its SIMKL details across the passes of one run', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  const count = CATALOGUE_ASKS_PER_PASS + 8;
  const unlisted = Array.from({ length: count }, (_, i) => ({
    id: 900 + i,
    title: `Unlisted ${i}`,
    status: 'watching',
    seasons: { 1: [FIRST_WATCH, LAST_WATCH] },
    watched: 2,
    total: 9,
  }));
  const sheet = blockServer();
  await withFreshJournal(async () => {
    await withBlockKeys({}, () =>
      withFetch(sheet.handler, async (calls) => {
        await new SheetSync({ logger: recorder() }).run(libraryOf(...unlisted));
        const asked = new Set(calls.filter((c) => c.startsWith('https://api.simkl.com/tv/') && !c.includes('/episodes/')));
        assert.equal(asked.size, count, 'every title is asked about, a pass’s worth at a time');
        assert.ok(count > CATALOGUE_ASKS_PER_PASS, 'the library holds more than one pass may ask about, or it proves nothing');
      }),
    );
  });
});

/**
 * The rationing, on its own. Two properties are the loop's to hold and are
 * pinned here directly: an answered title is dropped **before** the slice, so
 * it spends none of the allowance and the blocks behind it are read; and the
 * three upstreams a block waits on are capped for the whole attempt, not per
 * pass, or the pass ceiling multiplies the burst.
 */
const rationing = () => {
  const now = Temporal.Now.instant();
  const index = indexLibrary(
    libraryOf(...Array.from({ length: 40 }, (_, i) => ({ id: 900 + i, title: `Show ${i}`, status: 'watching', seasons: { 1: [FIRST_WATCH] }, watched: 1, total: 9 }))),
  );
  return { now, index, made: { catalogue: new Set<number>(), runtimes: new Set<string>(), genres: new Set<number>(), certificates: new Set<number>() } };
};

test('answered titles are dropped before the catalogue slice, so a cold one behind them is fetched', () => {
  const { now, index, made } = rationing();
  const ids = Array.from({ length: 40 }, (_, i) => 900 + i);
  const cold = 939;
  // Every title but the last answered a moment ago, at its current watch.
  const stamps = new Map(ids.filter((id) => id !== cold).map((id) => [id, { watchedAt: index.get(id)?.lastWatchedAt ?? null, at: now }]));
  const demands = { catalogue: ids.map((id) => ({ id, episodes: true, detail: true })), runtimes: [], genres: [], certificates: [] };
  const taken = rationLookups(demands, { made, stamps, index, now, attempt: 1, insertChosen: false });
  assert.deepEqual(taken.catalogue.map((r) => r.id), [cold], 'the one unanswered title, however many answered ones sort ahead of it');
  assert.equal(taken.unfetched, false);
});

test('a pass takes its allowance of titles and says the rest are unfetched', () => {
  const { now, index, made } = rationing();
  const ids = Array.from({ length: CATALOGUE_ASKS_PER_PASS + 8 }, (_, i) => 900 + i);
  const demands = { catalogue: ids.map((id) => ({ id, episodes: true, detail: true })), runtimes: [], genres: [], certificates: [] };
  const taken = rationLookups(demands, { made, stamps: new Map(), index, now, attempt: 1, insertChosen: false });
  assert.equal(taken.catalogue.length, CATALOGUE_ASKS_PER_PASS);
  assert.equal(taken.unfetched, true, 'which is what arms the retry if the passes run out first');
  // Fetched, the next pass takes the rest.
  for (const request of taken.catalogue) made.catalogue.add(request.id);
  const next = rationLookups(demands, { made, stamps: new Map(), index, now, attempt: 1, insertChosen: false });
  assert.equal(next.catalogue.length, 8);
  assert.equal(next.unfetched, false);
});

test('the three upstreams a block waits on are capped for the attempt, not per pass', () => {
  const { now, index, made } = rationing();
  const ids = Array.from({ length: 12 }, (_, i) => 900 + i);
  const demands = {
    catalogue: [],
    runtimes: ids.map((id) => ({ id, tvdbId: id, season: 1 })),
    genres: ids.map((id) => ({ id, tvdbId: id })),
    certificates: ids.map((id) => ({ id, tmdbId: id })),
  };
  const first = rationLookups(demands, { made, stamps: new Map(), index, now, attempt: 1, insertChosen: false });
  assert.equal(first.runtimes.length, MAX_LOOKUPS_PER_ATTEMPT);
  assert.equal(first.genres.length, MAX_LOOKUPS_PER_ATTEMPT);
  assert.equal(first.certificates.length, MAX_LOOKUPS_PER_ATTEMPT);
  assert.equal(first.unfetched, true);
  // What the loop does after fetching: the fetched keys enter `made`, which is the tally.
  for (const r of first.runtimes) made.runtimes.add(`${r.tvdbId}:${r.season}`);
  for (const r of first.genres) made.genres.add(r.id);
  for (const r of first.certificates) made.certificates.add(r.id);
  const second = rationLookups(demands, { made, stamps: new Map(), index, now, attempt: 1, insertChosen: false });
  assert.deepEqual([second.runtimes.length, second.genres.length, second.certificates.length], [0, 0, 0], 'the second pass of one attempt spends what the first left');
  assert.equal(second.unfetched, true, 'and the four left standing are the next poll’s');

  const fresh = rationLookups(demands, { made, stamps: new Map(), index, now, attempt: 2, insertChosen: false });
  assert.deepEqual([fresh.runtimes.length, fresh.genres.length, fresh.certificates.length], [0, 0, 0], 'a later attempt asks none of them');
  assert.equal(fresh.unfetched, true, 'but still says they are waiting');
});

/**
 * The pass ceiling abandons the fetches it stops at, and that is work only
 * another poll does: a backfill past `MAX_PASSES` bursts of the allowance
 * leaves its tail unasked, and with the ration reporting nothing left — the
 * tail fitted its slice — nothing else would arm the retry that drains it.
 */
test('a backfill past the pass ceiling still asks for another poll', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  // Blocks on the grid rather than titles with none: a block insert stops the
  // walk asking, where a grid of recent blocks asks for every one. Each row
  // already holds its count, so nothing is planned and only the abandoned
  // asks can arm the retry.
  const count = MAX_PASSES * CATALOGUE_ASKS_PER_PASS + 2;
  const ids = Array.from({ length: count }, (_, i) => 900 + i);
  const grid: CellSpec[][] = [H, ...ids.flatMap((id) => [show(`Show ${id}`, 'Watching', id), season(1, 2, null)])];
  const library = libraryOf(...ids.map((id) => ({ id, title: `Show ${id}`, status: 'watching', seasons: { 1: [FIRST_WATCH, LAST_WATCH] }, watched: 2, total: 9 })));
  const sheet = blockServer({ grid });
  await withFreshJournal(async () => {
    await withBlockKeys({}, () =>
      withFetch(sheet.handler, async (calls) => {
        const log = recorder();
        const result = await new SheetSync({ logger: log }).run(library);
        assert.equal(result.record.edits.length, 0, 'nothing to write, so nothing but the asks can arm a retry');
        const asked = new Set(calls.filter((c) => c.startsWith('https://api.simkl.com/tv/') && !c.includes('/episodes/')));
        assert.equal(asked.size, MAX_PASSES * CATALOGUE_ASKS_PER_PASS, 'the ceiling stops the run two titles short');
        assert.match(log.lines.join('\n'), /still demanding lookups after/);
        assert.equal(result.retry, true, 'and the two it abandoned are the next poll’s');
      }),
    );
  });
});

// Gating rather than degrading: those cells are written once, and a blank one
// reads as a series with no genre rather than as an install with no key. The
// gate sits above the SIMKL demand, so the show costs no request at all.
test('with either key unset nothing is added and nothing is looked up', async () => {
  for (const [missing, key] of [
    ['tvdbApiKey', 'TVDB_API_KEY'],
    ['tmdbApiKey', 'TMDB_API_KEY'],
  ] as const) {
    clearTokenCache();
    clearTvdbTokenCache();
    const sheet = blockServer();
    await withBlockKeys({ [missing]: undefined }, () =>
      withFetch(sheet.handler, async (calls) => {
        const log = recorder();
        const result = await new SheetSync({ logger: log }).run(NEW_SHOW_LIBRARY);
        assert.equal(result.status, 'idle');
        assert.match(log.lines.join('\n'), new RegExp(`1 show\\(s\\) have no row; set ${key} to have a block added for them`));
        assert.deepEqual(upstream(calls), [], `${key}: no upstream is asked about a show no block can be built for`);
        assert.equal(sheet.tab('Shows').length, DEFAULT_GRID.length);
      }),
    );
  }
});

/**
 * The FRESH re-read plans against a grid that changed underneath it, and a
 * block's two fact lookups can spend a minute apiece obeying `Retry-After`
 * against the 120s snapshot budget. So a demand that first appears on a later
 * attempt waits for the next poll, which costs nothing: the block lands a poll
 * later either way.
 *
 * The demand has to be *new* on attempt 2 for the gate to be what holds it —
 * `made` already blocks re-asking what attempt 1 asked. So the tab starts with
 * a block holding the same title under a different id, which holds the show
 * back with no demand at all, and that block disappears from the second read.
 */
test('a re-plan does not pick up the fact lookups a changed grid revealed', async () => {
  clearTokenCache();
  clearTvdbTokenCache();
  const grid: CellSpec[][] = [...DEFAULT_GRID, show('Severance', 'Watching', 777)];
  const sheet = blockServer({ grid });
  let reads = 0;
  const handler = (url: string, init?: RequestInit) => {
    if (url.includes('sheets.googleapis.com') && url.includes('ranges=')) {
      reads += 1;
      // Between attempt 1 and attempt 2 the row holding the title goes.
      if (reads === 2) sheet.tab('Shows').splice(4, 1);
    }
    return sheet.handler(url, init);
  };

  await withRunawayClock(() =>
    withBlockKeys({}, () =>
      withFetch(handler, async (calls) => {
        // Fargo's count has moved, so there is something to write and the run
        // reaches the freshness gate at all.
        const result = await new SheetSync({ logger: quiet }).run(
          libraryOf(
            { id: 3381, title: 'Fargo', status: 'watching', seasons: { 1: [daysAgo(400)], 2: Array.from({ length: 5 }, (_, i) => daysAgo(10 - i)) }, watched: 6, total: 16, notAired: 5 },
            { id: NEW_SHOW.id, title: NEW_SHOW.title, status: 'watching', seasons: { 1: [FIRST_WATCH, LAST_WATCH] }, watched: 2, total: 9 },
          ),
        );
        assert.equal(result.status, 'failed', 'the runaway clock never lets a write out');
        assert.ok(reads > 1, 'the grid really was re-read');
        assert.ok(calls.some((c) => c.includes('api.simkl.com/tv/900')), 'the catalogue the changed grid revealed is still read');
        assert.deepEqual(
          upstream(calls).filter((c) => c.includes('/series/') || c.includes('/3/tv/')),
          [],
          'but no block fact is fetched on a re-plan',
        );
      }),
    ),
  );
});
