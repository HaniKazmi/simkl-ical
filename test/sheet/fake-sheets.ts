/**
 * An in-memory Sheets server, shared by every whole-run suite.
 *
 * A spreadsheet of several tabs, because the write batch snapshots the target
 * into a new one first: modelling only Sheet1 would let duplicateSheet or
 * copyPaste no-op and every rollback assertion pass vacuously.
 *
 * One fake, not one per suite: it is coupled to the Google client's URL shapes
 * (`ranges=` separates the grid read from the tab listing), and a second copy
 * is a second place that coupling breaks silently.
 */

import { generateKeyPairSync } from 'node:crypto';
import type { CellData, SheetRequest } from '../../src/api/google/types.ts';
import { cellOf, jsonResponse, SHEET_HEADERS, seasonRow, showRow, type CellSpec } from '../helpers.ts';

// A real key, because the assertion is really signed; stubbing node:crypto
// would test nothing.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
export const CREDENTIAL = Buffer.from(JSON.stringify({ client_email: 'sa@example.test', private_key: privateKey })).toString('base64');

/** The default sheet: one show, a closed season, and season 2 in progress. */
export const DEFAULT_GRID: CellSpec[][] = [SHEET_HEADERS, showRow('Fargo', 'Watching', 3381), seasonRow(1, 6, 44000), seasonRow(2, 3, null)];

/** Season 2 is 5 of 10 aired, matching the default grid's open row. */
export const DEFAULT_EPISODES = [
  ...Array.from({ length: 6 }, (_, i) => ({ season: 1, episode: i + 1, type: 'episode', aired: true })),
  ...Array.from({ length: 10 }, (_, i) => ({ season: 2, episode: i + 1, type: 'episode', aired: i < 5 })),
];

export interface FakeSheetsOptions {
  /** Mutate the sheet behind our back on the write, so verify must fail. */
  meddle?: (state: CellData[][]) => void;
  /** Fail the nth batchUpdate (1-based). */
  failWrite?: number;
  failRollback?: boolean;
  /** Drop `replies` from the write's response, the way a timeout loses them. */
  hideReplies?: boolean;
  /** Fail the first N tab-listing *attempts*. A listing retries four times. */
  failTabLists?: number;
  grid?: CellSpec[][];
  episodes?: unknown;
  /** The SIMKL `/tv/{id}` detail body. */
  detail?: unknown;
  /** Answers TVDB season reads; without it any TVDB data request throws. */
  tvdb?: (url: string) => Response;
}

export const fakeSheets = ({
  meddle,
  failWrite,
  failRollback,
  hideReplies,
  failTabLists,
  episodes = DEFAULT_EPISODES,
  grid = DEFAULT_GRID,
  tvdb,
  detail,
}: FakeSheetsOptions = {}) => {
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
      // The write is the first batch; anything after is rollback or
      // housekeeping. `failRollback` models the *restore* failing, so tidying
      // up — dropping or renaming a tab — still works.
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
      // mask; only the grid read names a range.
      if (!url.includes('ranges=')) {
        tabLists += 1;
        if (failTabLists !== undefined && tabLists <= failTabLists) return new Response('{"error":{"message":"boom"}}', { status: 500 });
        return jsonResponse({ sheets: [...titles].map(([sheetId, title]) => ({ properties: { sheetId, title } })) });
      }
      const rows = tabs.get(1) ?? [];
      return jsonResponse({
        sheets: [
          {
            properties: { sheetId: 1, title: 'Sheet1', gridProperties: { rowCount: rows.length, columnCount: SHEET_HEADERS.length } },
            data: [{ rowData: rows.map((row) => ({ values: row })) }],
          },
        ],
      });
    }

    // Host-qualified, so another upstream falls through to the throw. `/tv/`
    // alone also matches TVDB's season path, which would hand it
    // `{status, runtime}` and make a test asserting nothing look green.
    if (url.startsWith('https://api.simkl.com/tv/episodes/')) return jsonResponse(episodes);
    if (url.startsWith('https://api.simkl.com/tv/')) return jsonResponse(detail ?? { status: 'airing', runtime: 45 });

    if (url.startsWith('https://api4.thetvdb.com/v4/login')) return jsonResponse({ data: { token: 'tvdb-token' } });
    if (url.startsWith('https://api4.thetvdb.com/')) {
      if (!tvdb) throw new Error(`unexpected TVDB request: ${url}`);
      return tvdb(url);
    }
    throw new Error(`unexpected request: ${url}`);
  };

  return { handler, state, tabs, titles, batches, writes: () => writes };
};

export type FakeSheets = ReturnType<typeof fakeSheets>;
