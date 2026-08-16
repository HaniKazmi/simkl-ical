/**
 * Reading and writing one tab of the spreadsheet. The only I/O in the sync.
 *
 * Reads use `spreadsheets.get` with grid data rather than `values.get`: one
 * request returns `userEnteredValue` (the definitive formula test) and
 * `effectiveValue` (true date serials, no locale-formatted `'1,102'` to
 * unpick). Writes use `batchUpdate`, which is atomic and
 * ordered, leaves number formats alone, and sidesteps the locale trap entirely
 * by sending `{numberValue: 46265}` rather than a date string that `08/15` and
 * `15/08` misparse identically for the first twelve days of every month.
 */

import { config } from '../shared/config.ts';
import { sheetsRequest } from '../api/google/client.ts';
import type { BatchUpdateResponse, CellData, SheetRequest, SpreadsheetResponse } from '../api/google/types.ts';

/**
 * One tab, as read. `rows` is ragged — the API omits trailing blanks — so every
 * consumer indexes defensively rather than assuming a rectangle.
 */
export interface SheetSnapshot {
  sheetId: number;
  title: string;
  /** From `gridProperties`, not from the widest row: a short read must not look like a narrow sheet. */
  rowCount: number;
  columnCount: number;
  rows: CellData[][];
  /** When the read completed. The freshness gate compares against this. */
  readAt: number;
}

/** The configured spreadsheet, or a clear failure. One copy of the check. */
const target = (): string => {
  if (!config.sheetId) throw new Error('SHEET_ID is not set.');
  return encodeURIComponent(config.sheetId);
};

/**
 * Exactly the four things `parseGrid` and `verify` read, and nothing else.
 *
 * Without a mask the response carries every cell's full format block — font,
 * borders, number format, conditional formatting — for 1644 rows, all of it
 * parsed and discarded. Naming `userEnteredValue` keeps `formulaValue`, which
 * is the definitive formula test and the one field the whole design rests on.
 *
 * A field mask supersedes `includeGridData`, so asking for `data` here is what
 * makes the grid come back at all.
 */
const GRID_FIELDS =
  'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue))))';

export const readSnapshot = async ({ signal }: { signal?: AbortSignal } = {}): Promise<SheetSnapshot> => {
  const title = config.sheetName;
  const response = await sheetsRequest<SpreadsheetResponse>(target(), {
    // The tab name is a range, and one containing a space needs quoting.
    params: { ranges: `'${title.replaceAll("'", "''")}'`, fields: GRID_FIELDS },
    retry: true,
    signal,
  });

  const sheet = response.sheets?.find((s) => s.properties?.title === title) ?? response.sheets?.[0];
  const sheetId = sheet?.properties?.sheetId;
  if (!sheet || sheetId === undefined) {
    throw new Error(`No tab named ${title} in the spreadsheet.`);
  }

  const grid = sheet.data?.[0];
  // A non-zero startRow would silently shift every row index by that offset,
  // which is the one-row misalignment this whole design exists to prevent.
  if (grid?.startRow || grid?.startColumn) {
    throw new Error(`The read came back offset (startRow ${grid.startRow ?? 0}, startColumn ${grid.startColumn ?? 0}).`);
  }

  return {
    sheetId,
    title: sheet.properties?.title ?? title,
    rowCount: sheet.properties?.gridProperties?.rowCount ?? grid?.rowData?.length ?? 0,
    columnCount: sheet.properties?.gridProperties?.columnCount ?? 0,
    rows: (grid?.rowData ?? []).map((row) => row.values ?? []),
    readAt: Date.now(),
  };
};

/**
 * One batchUpdate. Never retried, and never split: the ordering within the
 * array is load-bearing, and a partially-sent plan is a corrupt sheet.
 *
 * The replies are returned because `duplicateSheet` reports the id of the tab
 * it created, and that id is what a rollback restores from.
 */
export const applyRequests = async (
  requests: SheetRequest[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<BatchUpdateResponse> => {
  if (!requests.length) return {};

  return await sheetsRequest<BatchUpdateResponse>(`${target()}:batchUpdate`, {
    method: 'POST',
    body: { requests, includeSpreadsheetInResponse: false },
    signal,
  });
};

/**
 * Every tab's id and title, and nothing else. Used to find backup tabs — both
 * the one this run made and any a frozen run left behind.
 */
export const listSheets = async ({ signal }: { signal?: AbortSignal } = {}): Promise<Array<{ sheetId: number; title: string }>> => {
  const response = await sheetsRequest<SpreadsheetResponse>(target(), {
    params: { fields: 'sheets.properties(sheetId,title)' },
    retry: true,
    signal,
  });
  return (response.sheets ?? [])
    .map((sheet) => ({ sheetId: sheet.properties?.sheetId, title: sheet.properties?.title }))
    .filter((s): s is { sheetId: number; title: string } => typeof s.sheetId === 'number' && typeof s.title === 'string');
};
