import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { SheetSync } from '../src/sheet-sync.ts';
import { clearTokenCache } from '../src/sheets/auth.ts';
import type { CellData, SheetRequest } from '../src/sheets/types.ts';
import { cellOf, daysAgo, jsonResponse, libraryOf, quiet, recorder, sheetSnapshot, SHEET_HEADERS, withConfig, withFetch, type CellSpec, seasonRow, showRow } from './helpers.ts';

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
}

/**
 * A spreadsheet of several tabs, because the write batch now snapshots the
 * target into a new one first. Modelling only Sheet1 would let a duplicateSheet
 * or copyPaste silently no-op and every rollback assertion below pass vacuously.
 */
const server = ({ meddle, failWrite, failRollback, episodes = EPISODES, grid = GRID }: ServerOptions & { episodes?: unknown; grid?: CellSpec[][] } = {}) => {
  const tabs = new Map<number, CellData[][]>([[1, grid.map((row) => row.map(cellOf))]]);
  const titles = new Map<number, string>([[1, 'Sheet1']]);
  const state = tabs.get(1)!;
  let nextSheetId = 2;
  let writes = 0;
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
      // it is rollback or housekeeping.
      const isRollback = writes > 1;
      if (writes === failWrite || (isRollback && failRollback && !requests.every((r) => 'deleteSheet' in r))) {
        return new Response('{"error":{"message":"boom"}}', { status: 500 });
      }
      const replies = requests.map(apply);
      if (!isRollback) meddle?.(state);
      return jsonResponse({ replies });
    }

    if (url.includes('sheets.googleapis.com')) {
      // The metadata-only read that finds backup tabs.
      if (url.includes('fields=')) {
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
    assert.equal(result.edits, 1);
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
    assert.deepEqual(sheets.map((c) => (c.includes(':batchUpdate') ? 'write' : 'read')), ['read', 'write', 'read', 'write']);
    // Pinned because `new URL('SID:batchUpdate', base)` reads `SID:` as a
    // scheme and silently sends the request somewhere else entirely.
    assert.ok(sheets[1]?.startsWith('https://sheets.googleapis.com/v4/spreadsheets/SID:batchUpdate'), sheets[1]);
  });
});

// Rollback exists for one failure: our plan was wrong. That is why the rollback
// set comes from the observed diff — the plan is the thing under suspicion.
test('a write that does not verify is rolled back exactly once', async () => {
  await run('apply', { meddle: (state) => void (state[2]![3] = cellOf(99)) }, (result, calls, sheet) => {
    assert.equal(result.status, 'rolled-back');
    assert.match(result.error ?? '', /changed without being planned/);
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

    const writesBefore = sheet.writes();
    const again = await sync.run(LIBRARY);
    assert.equal(again.status, 'frozen');
    assert.equal(sheet.writes(), writesBefore, 'a frozen sync writes nothing further');
  });
});

// batchUpdate is atomic but not idempotent: a retried insertDimension inserts
// two rows, and a timeout can fire on a request the server already applied.
test('a 500 on the write is never retried, and the re-read settles what happened', async () => {
  await run('apply', { failWrite: 1 }, (result, calls, sheet) => {
    assert.equal(result.status, 'failed');
    assert.equal(result.retry, true, 'the next poll tries again');
    assert.equal(calls.filter((c) => c.includes(':batchUpdate')).length, 1);
    assert.equal(sheet.state[3]?.[3]?.userEnteredValue?.numberValue, 3, 'unchanged');
  });
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
      assert.equal(again.edits, 1);
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

// The path that corrupted the first real apply run. A rollback that must both
// delete an inserted row and put cells back has to do them in separate batches:
// the delete rewrites the relative references in everything it shifts,
// including anything written earlier in the same batch.
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
// version history, so it must survive precisely when the rollback did not.
test('a failed rollback keeps the backup tab and names it', async () => {
  clearTokenCache();
  const sheet = server({ meddle: (state) => void (state[2]![3] = cellOf(99)), failRollback: true });
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(sheet.handler, async () => {
      const result = await new SheetSync({ logger: quiet }).run(LIBRARY);
      assert.equal(result.status, 'frozen');
      const backup = [...sheet.titles.values()].find((t) => t.startsWith('_sync-backup-'));
      assert.ok(backup, 'the snapshot tab survives a failed rollback');
      assert.ok(result.error?.includes(backup), 'and the frozen message names it');
      assert.match(result.error ?? '', /copy it back over Sheet1/);
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
