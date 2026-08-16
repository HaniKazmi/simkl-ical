import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SheetSync } from '../../src/sheet/sync.ts';
import { clearTokenCache } from '../../src/api/google/auth.ts';
import type { CellData, SheetRequest } from '../../src/api/google/types.ts';
import { cellOf, daysAgo, jsonResponse, libraryOf, quiet, recorder, SHEET_HEADERS, withConfig, withFetch, withFreshJournal, type CellSpec, seasonRow, showRow } from '../helpers.ts';
import { sheetRuns } from '../../src/sheet/io/journal.ts';

const H = SHEET_HEADERS;

// A real key, because the assertion is really signed. Generated once: the
// alternative is stubbing node:crypto, which would test nothing.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const CREDENTIAL = Buffer.from(JSON.stringify({ client_email: 'sa@example.test', private_key: privateKey })).toString('base64');

const show = showRow;
const season = seasonRow;

const GRID: CellSpec[][] = [H, show('Fargo', 'Watching', 3381), season(1, 6, 44000), season(2, 3, null)];

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

const EPISODES = [
  ...Array.from({ length: 6 }, (_, i) => ({ season: 1, episode: i + 1, type: 'episode', aired: true })),
  ...Array.from({ length: 10 }, (_, i) => ({ season: 2, episode: i + 1, type: 'episode', aired: i < 5 })),
];

interface ServerOptions {
  /** Mutate the sheet behind our back on the write, so verify must fail. */
  meddle?: (state: CellData[][]) => void;
  /** Fail the nth batchUpdate (1-based). */
  failWrite?: number;
  failRollback?: boolean;
  /** Drop `replies` from the write's response, the way a timeout loses them. */
  hideReplies?: boolean;
  /** Fail the first N tab-listing *attempts*. A listing retries four times. */
  failTabLists?: number;
}

/**
 * A spreadsheet of several tabs, because the write batch now snapshots the
 * target into a new one first. Modelling only Sheet1 would let a duplicateSheet
 * or copyPaste silently no-op and every rollback assertion below pass vacuously.
 */
const server = ({ meddle, failWrite, failRollback, hideReplies, failTabLists, episodes = EPISODES, grid = GRID }: ServerOptions & { episodes?: unknown; grid?: CellSpec[][] } = {}) => {
  const tabs = new Map<number, CellData[][]>([[1, grid.map((row) => row.map(cellOf))]]);
  const titles = new Map<number, string>([[1, 'Sheet1']]);
  const state = tabs.get(1)!;
  let nextSheetId = 2;
  let writes = 0;
  let tabLists = 0;
  const batches: string[][] = [];

  const clone = (rows: CellData[][]): CellData[][] => rows.map((row) => row.map((cell) => structuredClone(cell)));

  const apply = (request: SheetRequest): { duplicateSheet?: { properties: { sheetId: number } } } => {
    if ('updateCells' in request) {
      const { range, rows } = request.updateCells;
      const row = tabs.get(range.sheetId)?.[range.startRowIndex ?? 0];
      if (row) row[range.startColumnIndex ?? 0] = rows[0]?.values?.[0] ?? {};
      return {};
    }
    if ('insertDimension' in request) {
      tabs.get(request.insertDimension.range.sheetId)?.splice(request.insertDimension.range.startIndex, 0, []);
      return {};
    }
    if ('deleteDimension' in request) {
      tabs.get(request.deleteDimension.range.sheetId)?.splice(request.deleteDimension.range.startIndex, 1);
      return {};
    }
    if ('duplicateSheet' in request) {
      const { sourceSheetId, newSheetName } = request.duplicateSheet;
      const id = nextSheetId++;
      tabs.set(id, clone(tabs.get(sourceSheetId) ?? []));
      titles.set(id, newSheetName ?? `Copy ${id}`);
      return { duplicateSheet: { properties: { sheetId: id } } };
    }
    if ('deleteSheet' in request) {
      tabs.delete(request.deleteSheet.sheetId);
      titles.delete(request.deleteSheet.sheetId);
      return {};
    }
    if ('updateSheetProperties' in request) {
      const { sheetId, title } = request.updateSheetProperties.properties;
      if (sheetId !== undefined && title) titles.set(sheetId, title);
      return {};
    }
    // copyPaste, at a zero offset: the destination becomes the source.
    const { source, destination } = request.copyPaste;
    const from = tabs.get(source.sheetId) ?? [];
    const to = tabs.get(destination.sheetId);
    if (to) {
      to.length = 0;
      to.push(...clone(from));
    }
    return {};
  };

  const handler = (url: string, init?: RequestInit): Response => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'sheet-token', expires_in: 3600 });

    if (url.includes(':batchUpdate')) {
      writes += 1;
      const requests = (JSON.parse(String(init?.body)) as { requests: SheetRequest[] }).requests;
      batches.push(requests.map((r) => Object.keys(r)[0] ?? '?'));
      // The write is the first batch carrying a cell or a row; anything after
      // it is rollback or housekeeping. `failRollback` models the *restore*
      // failing, so tidying up — dropping a tab, renaming one — still works.
      const isRollback = writes > 1;
      const housekeeping = requests.every((r) => 'deleteSheet' in r || 'updateSheetProperties' in r);
      if (writes === failWrite || (isRollback && failRollback && !housekeeping)) {
        return new Response('{"error":{"message":"boom"}}', { status: 500 });
      }
      const replies = requests.map(apply);
      if (!isRollback) meddle?.(state);
      return jsonResponse(hideReplies && !isRollback ? {} : { replies });
    }

    if (url.includes('sheets.googleapis.com')) {
      // The metadata-only read that finds backup tabs. Both reads carry a field
      // mask now; only the grid read names a range.
      if (!url.includes('ranges=')) {
        tabLists += 1;
        if (failTabLists !== undefined && tabLists <= failTabLists) return new Response('{"error":{"message":"boom"}}', { status: 500 });
        return jsonResponse({ sheets: [...titles].map(([sheetId, title]) => ({ properties: { sheetId, title } })) });
      }
      const rows = tabs.get(1) ?? [];
      return jsonResponse({
        sheets: [
          {
            properties: { sheetId: 1, title: 'Sheet1', gridProperties: { rowCount: rows.length, columnCount: H.length } },
            data: [{ rowData: rows.map((row) => ({ values: row })) }],
          },
        ],
      });
    }

    if (url.includes('/tv/episodes/')) return jsonResponse(episodes);
    if (url.includes('/tv/')) return jsonResponse({ status: 'airing', runtime: 45 });
    throw new Error(`unexpected request: ${url}`);
  };

  return { handler, state, tabs, titles, batches, writes: () => writes };
};

const run = async (mode: 'report' | 'apply', options: ServerOptions, assertions: (result: Awaited<ReturnType<SheetSync['run']>>, calls: string[], sheet: ReturnType<typeof server>, sync: SheetSync, log: ReturnType<typeof recorder>) => void | Promise<void>) => {
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

// The whole point of the default mode: it can be pointed at the real sheet
// before the service account is ever given Editor access.
test('report mode plans in full and makes no mutating request', async () => {
  await run('report', {}, (result, calls) => {
    assert.equal(result.status, 'reported');
    assert.equal(result.plan.edits.length, 1);
    assert.ok(result.lines.some((l) => /Fargo S2: 3 -> 5 episodes/.test(l)));
    assert.deepEqual(calls.filter((c) => c.includes(':batchUpdate')), []);
  });
});

test('apply mode writes exactly what it planned and verifies it', async () => {
  await run('apply', {}, (result, calls, sheet) => {
    assert.equal(result.status, 'applied', result.error ?? '');
    assert.equal(result.error, null);
    assert.equal(sheet.state[3]?.[3]?.userEnteredValue?.numberValue, 5);
    // Snapshot and write in one atomic batch, then a read, then the snapshot is
    // dropped. Nothing is written without a fresh read either side of it.
    assert.deepEqual(sheet.batches, [['duplicateSheet', 'updateCells'], ['deleteSheet']]);
    const sheets = calls.filter((c) => c.startsWith('https://sheets.googleapis.com/v4/spreadsheets/'));
    assert.deepEqual(sheets.map((c) => (c.includes(':batchUpdate') ? 'write' : 'read')), ['read', 'write', 'read', 'read', 'write']);
    // Pinned because `new URL('SID:batchUpdate', base)` reads `SID:` as a
    // scheme and silently sends the request somewhere else entirely.
    assert.ok(sheets[1]?.startsWith('https://sheets.googleapis.com/v4/spreadsheets/SID:batchUpdate'), String(sheets[1]));
  });
});

// Rollback exists for one failure: our plan was wrong. That is why the rollback
// set comes from the observed diff — the plan is the thing under suspicion.
test('a write that does not verify is rolled back exactly once', async () => {
  await run('apply', { meddle: (state) => void (state[2]![3] = cellOf(99)) }, (result, _calls, sheet) => {
    assert.equal(result.status, 'rolled-back');
    assert.match(result.error ?? '', /changed without being planned/);
    // The run that had to be undone is the one whose detail matters most, so it
    // reports what it planned rather than reporting nothing.
    assert.equal(result.plan.edits.length, 1);
    assert.match(result.plan.edits[0]?.note ?? '', /Fargo S2: 3 -> 5 episodes/);
    // One wholesale paste from the snapshot, not a cell-by-cell repair.
    assert.deepEqual(sheet.batches, [['duplicateSheet', 'updateCells'], ['copyPaste'], ['deleteSheet']]);
    // The meddled cell is back, and so is the planned edit — a restore from the
    // snapshot undoes the whole write, not just the part that surprised us.
    assert.equal(sheet.state[2]?.[3]?.userEnteredValue?.numberValue, 6);
    assert.equal(sheet.state[3]?.[3]?.userEnteredValue?.numberValue, 3, 'the planned edit is undone too');
  });
});

test('a failed rollback freezes the process rather than writing again', async () => {
  await run('apply', { meddle: (state) => void (state[2]![3] = cellOf(99)), failRollback: true }, async (result, _calls, sheet, sync) => {
    assert.equal(result.status, 'frozen');
    assert.match(result.error ?? '', /^FROZEN:/);
    assert.equal(result.plan.edits.length, 1, 'the freeze reports the plan it froze on');

    const writesBefore = sheet.writes();
    const again = await sync.run(LIBRARY);
    assert.equal(again.status, 'frozen');
    // A run that stops at the freeze check planned nothing, and says so.
    assert.deepEqual(again.plan, { edits: [], inserts: [] });
    assert.equal(sheet.writes(), writesBefore, 'a frozen sync writes nothing further');
  });
});

// batchUpdate is atomic but not idempotent: a retried insertDimension inserts
// two rows, and a timeout can fire on a request the server already applied.
test('a 500 on the write is never retried, and the re-read settles what happened', async () => {
  await run('apply', { failWrite: 1 }, (result, calls, sheet) => {
    assert.equal(result.status, 'failed');
    assert.equal(result.retry, true, 'the next poll tries again');
    assert.equal(result.plan.edits.length, 1, 'a batch that never landed still had a plan');
    assert.equal(calls.filter((c) => c.includes(':batchUpdate')).length, 1);
    assert.equal(sheet.state[3]?.[3]?.userEnteredValue?.numberValue, 3, 'unchanged');
  });
});

// An atomic failure on a plan containing an insert leaves the row count
// unchanged, which is the one shape in which "did it land" is easy to answer
// backwards. Getting it wrong here costs everything: the snapshot tab rode the
// same failed batch, so the rollback finds nothing and freezes the process for
// good — over a sheet a single transient 503 left completely untouched.
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
        // A wrong SHEET_ID or an unshared spreadsheet needs a human. Arming the
        // retry would defeat the quiet-poll early return every two hours for a
        // week; the error still reaches errors.sheet and /healthz each run.
        assert.equal(result.retry, false);
      },
    ),
  );
});

// The same class, the opposite conclusion: the transport clears the token cache
// on its way out of a 401, so the next poll signs a fresh assertion and recovers
// by itself — but only if it is asked for one.
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

// The claim the gating exists to make. `/sync/activities` names a list, never a
// title, so a second poll with nothing moved would otherwise re-read every
// eligible show's catalogue from scratch.
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
      // And the plan is unchanged, because the retained catalogue still feeds
      // it in full — the gate is on the network, not on what the planner sees.
      assert.equal(again.status, 'reported');
      assert.equal(again.plan.edits.length, 1);
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
      // reported rather than read at all.
      assert.deepEqual([...new Set(catalogueCalls(calls).map((c) => c.split('?')[0]))], [
        'https://api.simkl.com/tv/episodes/3381',
        'https://api.simkl.com/tv/3381',
      ]);
    }),
  );
});

// A rollback that must both delete an inserted row and put cells back has to do
// them in separate batches: the delete rewrites the relative references in
// everything it shifts, including anything written earlier in the same batch.
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

      // Batch 1 snapshots and writes, in that order and atomically. Batch 2 is
      // the delete ALONE. Batch 3 is the paste. Batch 4 drops the snapshot.
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

// The snapshot is what makes a frozen sheet recoverable without archaeology in
// version history, so it must survive precisely when the rollback did not — and
// it is renamed out of the swept namespace on the way, because `frozen` is
// process state and a restart forgets all of this.
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

// "No id" is not "no tab". A timeout loses the reply that carries the new
// sheetId, and the listing that would recover it can fail on its own — while
// the duplicate, riding the same atomic batch, is sitting right there. Leaving
// it under the swept name hands the user a repair target the next clean run
// deletes.
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

// And when even that cannot be done, the message has to carry the deadline the
// user is working to rather than implying the tab will keep.
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

// The whole point of the rename: the restart that clears `frozen` must not let
// the next clean write take the tab the user was told to repair from.
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

// A snapshot left lying around on every successful run would be clutter, and
// clutter that looks like a failure.
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

// The write batch always makes a snapshot, and any failure between the write
// and the verify read leaves it behind with nothing to remove it. A clean run
// is the one moment the sheet is known good, so it clears the lot.
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
// cap. Without the retry flag it would sit until some unrelated thing woke the
// next poll — the daily film clock, at worst.
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
      assert.equal(result.plan.inserts.length, 1, 'one row per run');
      assert.equal(result.retry, true, 'and the next poll is asked for');
    }),
  );

  // Report mode never takes the first row either, so the deferral cannot drain
  // and asking for another poll is an unbroken loop of full grid reads — in the
  // default mode, on a sheet nobody has ever written to.
  const reporting = server({ grid, episodes });
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'report', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(reporting.handler, async () => {
      const result = await new SheetSync({ logger: quiet }).run(library);
      assert.equal(result.status, 'reported');
      assert.equal(result.retry, false, 'nothing a report can do would drain it');
    }),
  );
});

// The history exists so a restart does not erase what the sync did. `record()`
// is the one choke point every terminal path funnels through, which is why the
// append lives there rather than at six call sites.
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

// An install with no SHEET_ID must leave no trace on disk at all: the `off`
// return in run() deliberately never reaches `record()`.
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
 * Advance the monotonic clock faster than the run can plan.
 *
 * The freshness window is two minutes, so a test cannot wait it out — the clock
 * has to move instead. Swapping `performance.now` is the move `withFetch` makes
 * on `fetch`, for the same reason: the seam is a global.
 *
 * Every reading is 5 minutes past the one before, so a snapshot is stale by the
 * time its plan is ready, on every attempt.
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
 * A plan is built against row indices, so applying it to a grid that has since
 * moved writes to the wrong rows. The gate is what makes that unreachable, and
 * it compares two readings of the *same* clock — a fixture stamping `readAtMono`
 * from `Date.now()` would read as a difference of ~1.7e12 ms, which is always
 * fresh, and would disable this silently.
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
