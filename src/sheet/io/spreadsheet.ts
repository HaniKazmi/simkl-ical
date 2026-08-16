/**
 * READ and APPLY — one tab of the spreadsheet, and the only Google I/O in the
 * sync. In `io/` rather than numbered because it is used at both ends of the
 * pipeline: the read that starts a cycle and the batch that ends it.
 *
 * Reads use `spreadsheets.get` with grid data rather than `values.get`: one
 * request returns `userEnteredValue` (the definitive formula test) and
 * `effectiveValue` (true date serials, no locale-formatted `'1,102'` to
 * unpick). Writes use `batchUpdate`, which is atomic and
 * ordered, leaves number formats alone, and sidesteps the locale trap entirely
 * by sending `{numberValue: 46265}` rather than a date string that `08/15` and
 * `15/08` misparse identically for the first twelve days of every month.
 */

import { config } from '../../shared/config.ts';
import { sheetsRequest } from '../../api/google/client.ts';
import type { BatchUpdateResponse, CellData, SheetRequest, SpreadsheetResponse } from '../../api/google/types.ts';

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
  /**
   * When the read completed, on the monotonic clock. The freshness gate compares
   * against this, and its window is two minutes — close enough to a plausible
   * clock step that wall time could call a fresh snapshot stale, or worse, a
   * stale one fresh. Never rendered, so it has no reason to be a wall-clock time.
   *
   * The clock is in the name because the type cannot carry it: both clocks are
   * `number`, and a fixture assigning `Date.now()` here reads as a difference of
   * ~1.7e12 ms, which is always "fresh" and silently disables the gate.
   */
  readAtMono: number;
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
    component: 'spreadsheet',
    // The tab name is a range, and one containing a space needs quoting.
    params: { ranges: `'${title.replaceAll("'", "''")}'`, fields: GRID_FIELDS },
    retry: true,
    signal,
  });

  // By name only. Falling back to the first tab is safe solely because
  // `params.ranges` constrains the response to one — and if that mask were ever
  // loosened, the sync would read, plan against and write to whatever came
  // back first, which after a frozen run is a `_sync-REPAIR-…` snapshot. The
  // title below defaults to the *configured* name, so the mismatch would not
  // even show up in the log.
  const sheet = response.sheets?.find((s) => s.properties?.title === title);
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
    // Both floored: a rollback pastes over exactly these dimensions, and a zero
    // restores nothing while reporting success — the confirming verify then
    // fails and the run freezes, in the one path where freezing is worst.
    rowCount: Math.max(sheet.properties?.gridProperties?.rowCount ?? grid?.rowData?.length ?? 0, grid?.rowData?.length ?? 0),
    columnCount: Math.max(
      sheet.properties?.gridProperties?.columnCount ?? 0,
      ...(grid?.rowData ?? []).map((row) => row.values?.length ?? 0),
      0,
    ),
    rows: (grid?.rowData ?? []).map((row) => row.values ?? []),
    readAtMono: performance.now(),
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
    component: 'spreadsheet',
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
    component: 'spreadsheet',
    params: { fields: 'sheets.properties(sheetId,title)' },
    retry: true,
    signal,
  });
  return (response.sheets ?? [])
    .map((sheet) => ({ sheetId: sheet.properties?.sheetId, title: sheet.properties?.title }))
    .filter((s): s is { sheetId: number; title: string } => typeof s.sheetId === 'number' && typeof s.title === 'string');
};
