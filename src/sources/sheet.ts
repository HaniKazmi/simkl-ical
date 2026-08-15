/**
 * Reading and writing one tab of the spreadsheet. The only I/O in the sync.
 *
 * Reads use `spreadsheets.get?includeGridData=true` rather than `values.get`:
 * one request returns `userEnteredValue` (the definitive formula test),
 * `effectiveValue` (true date serials, no locale-formatted `'1,102'` to unpick)
 * and `formattedValue` for logs. Writes use `batchUpdate`, which is atomic and
 * ordered, leaves number formats alone, and sidesteps the locale trap entirely
 * by sending `{numberValue: 46265}` rather than a date string that `08/15` and
 * `15/08` misparse identically for the first twelve days of every month.
 */

import { config } from '../config.ts';
import { sheetsRequest } from '../sheets/client.ts';
import type { BatchUpdateResponse, CellData, SheetRequest, SpreadsheetResponse } from '../sheets/types.ts';

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

export const readSnapshot = async (
  { spreadsheetId = config.sheetId, title = config.sheetName, signal }: { spreadsheetId?: string; title?: string; signal?: AbortSignal } = {},
): Promise<SheetSnapshot> => {
  if (!spreadsheetId) throw new Error('SHEET_ID is not set.');

  const response = await sheetsRequest<SpreadsheetResponse>(encodeURIComponent(spreadsheetId), {
    // The tab name is a range, and one containing a space needs quoting.
    params: { includeGridData: 'true', ranges: `'${title.replaceAll("'", "''")}'` },
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
  { spreadsheetId = config.sheetId, signal }: { spreadsheetId?: string; signal?: AbortSignal } = {},
): Promise<BatchUpdateResponse> => {
  if (!spreadsheetId) throw new Error('SHEET_ID is not set.');
  if (!requests.length) return {};

  return await sheetsRequest<BatchUpdateResponse>(`${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    body: { requests, includeSpreadsheetInResponse: false },
    signal,
  });
};

/**
 * Every tab's id and title, and nothing else. Used to find backup tabs — both
 * the one this run made and any a frozen run left behind.
 */
export const listSheets = async (
  { spreadsheetId = config.sheetId, signal }: { spreadsheetId?: string; signal?: AbortSignal } = {},
): Promise<Array<{ sheetId: number; title: string }>> => {
  if (!spreadsheetId) throw new Error('SHEET_ID is not set.');
  const response = await sheetsRequest<SpreadsheetResponse>(encodeURIComponent(spreadsheetId), {
    params: { fields: 'sheets.properties(sheetId,title)' },
    retry: true,
    signal,
  });
  return (response.sheets ?? [])
    .map((sheet) => ({ sheetId: sheet.properties?.sheetId, title: sheet.properties?.title }))
    .filter((s): s is { sheetId: number; title: string } => typeof s.sheetId === 'number' && typeof s.title === 'string');
};
