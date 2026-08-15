import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { SheetSync } from '../src/sheet-sync.ts';
import { clearTokenCache } from '../src/sheets/auth.ts';
import { clearCache } from '../src/sources/shows.ts';
import type { CellData, SheetRequest } from '../src/sheets/types.ts';
import { cellOf, daysAgo, jsonResponse, libraryOf, quiet, recorder, sheetSnapshot, SHEET_HEADERS, withConfig, withFetch, type CellSpec } from './helpers.ts';

const H = SHEET_HEADERS;

// A real key, because the assertion is really signed. Generated once: the
// alternative is stubbing node:crypto, which would test nothing.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const CREDENTIAL = Buffer.from(JSON.stringify({ client_email: 'sa@example.test', private_key: privateKey })).toString('base64');

const show = (title: string, status: string, id: number): CellSpec[] =>
  [title, status, { formula: '=LET(…)', value: 1 }, { formula: '=LET(…)', value: 6 }, 45000, { formula: '=LET(…)' }, { formula: '=LET(…)' }, { formula: '=LET(…)' }, id, 'show'];
const season = (n: number, episodes: number | null, end: number | null): CellSpec[] =>
  [null, null, n, episodes, 45000, end, 0.0153, { formula: '=G*F' }, null, null];

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

const server = ({ meddle, failWrite, failRollback }: ServerOptions = {}) => {
  const state: CellData[][] = GRID.map((row) => row.map(cellOf));
  let writes = 0;

  const apply = (request: SheetRequest): void => {
    if ('updateCells' in request) {
      const { range, rows } = request.updateCells;
      const row = state[range.startRowIndex ?? 0];
      if (row) row[range.startColumnIndex ?? 0] = rows[0]?.values?.[0] ?? {};
      return;
    }
    if ('insertDimension' in request) {
      state.splice(request.insertDimension.range.startIndex, 0, []);
      return;
    }
    state.splice(request.deleteDimension.range.startIndex, 1);
  };

  const handler = (url: string, init?: RequestInit): Response => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'sheet-token', expires_in: 3600 });

    if (url.includes(':batchUpdate')) {
      writes += 1;
      const isRollback = writes > 1;
      if (writes === failWrite || (isRollback && failRollback)) return new Response('{"error":{"message":"boom"}}', { status: 500 });
      for (const request of (JSON.parse(String(init?.body)) as { requests: SheetRequest[] }).requests) apply(request);
      if (!isRollback) meddle?.(state);
      return jsonResponse({});
    }

    if (url.includes('sheets.googleapis.com')) {
      return jsonResponse({
        sheets: [
          {
            properties: { sheetId: 1, title: 'Sheet1', gridProperties: { rowCount: state.length, columnCount: H.length } },
            data: [{ rowData: state.map((row) => ({ values: row })) }],
          },
        ],
      });
    }

    if (url.includes('/tv/episodes/')) return jsonResponse(EPISODES);
    if (url.includes('/tv/')) return jsonResponse({ status: 'airing', runtime: 45 });
    throw new Error(`unexpected request: ${url}`);
  };

  return { handler, state, writes: () => writes };
};

const run = async (mode: 'report' | 'apply', options: ServerOptions, assertions: (result: Awaited<ReturnType<SheetSync['run']>>, calls: string[], sheet: ReturnType<typeof server>, sync: SheetSync, log: ReturnType<typeof recorder>) => void | Promise<void>) => {
  clearTokenCache();
  clearCache();
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
    assert.equal(sheet.writes(), 1);
    assert.equal(sheet.state[3]?.[3]?.userEnteredValue?.numberValue, 5);
    // Read, write, read: nothing is written without a fresh read either side.
    const sheets = calls.filter((c) => c.startsWith('https://sheets.googleapis.com/v4/spreadsheets/'));
    assert.deepEqual(sheets.map((c) => (c.includes(':batchUpdate') ? 'write' : 'read')), ['read', 'write', 'read']);
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
    assert.equal(sheet.writes(), 2, 'the write and one rollback');
    // The meddled cell is back, and the planned edit stayed — verify does not
    // decide what to undo, the diff does.
    assert.equal(sheet.state[2]?.[3]?.userEnteredValue?.numberValue, 6);
    assert.deepEqual(calls.filter((c) => c.includes(':batchUpdate')).length, 2);
  });
});

test('a failed rollback freezes the process rather than writing again', async () => {
  await run('apply', { meddle: (state) => void (state[2]![3] = cellOf(99)), failRollback: true }, async (result, _calls, sheet, sync) => {
    assert.equal(result.status, 'frozen');
    assert.match(result.error ?? '', /^FROZEN:/);
    assert.match(result.error ?? '', /Restore by hand from Sheets version history/);

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
  clearCache();
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
