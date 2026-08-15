/**
 * The slice of the Google Sheets v4 API this service uses.
 *
 * Written from live responses, like `simkl/types.ts`. Everything is optional
 * because the API omits rather than nulls: a blank cell is `{}`, a trailing run
 * of blanks is absent entirely, and a row of them may be `{}` with no `values`
 * key. Every consumer indexes defensively.
 */

export interface ErrorValue {
  type: string;
  message?: string;
}

/**
 * A cell's value in one of Sheets' representations. Exactly one field is set,
 * except that `errorValue` accompanies a formula that failed.
 */
export interface ExtendedValue {
  numberValue?: number;
  stringValue?: string;
  boolValue?: boolean;
  formulaValue?: string;
  errorValue?: ErrorValue;
}

export interface CellData {
  /**
   * What a human typed — a literal, or the formula text. The only field worth
   * diffing: it changes when someone writes and at no other time.
   */
  userEnteredValue?: ExtendedValue;
  /**
   * What the formula evaluated to. True date serials and counts, with no
   * locale-formatted `'1,102'` to unpick — but it also moves on every recalc,
   * so it can never be used as evidence that nobody wrote anything.
   */
  effectiveValue?: ExtendedValue;
}

export interface RowData {
  values?: CellData[];
}

export interface GridData {
  startRow?: number;
  startColumn?: number;
  rowData?: RowData[];
}

export interface GridProperties {
  rowCount?: number;
  columnCount?: number;
}

export interface SheetProperties {
  sheetId?: number;
  title?: string;
  gridProperties?: GridProperties;
}

export interface SheetResponse {
  properties?: SheetProperties;
  data?: GridData[];
}

export interface SpreadsheetResponse {
  spreadsheetId?: string;
  sheets?: SheetResponse[];
}

/**
 * Half-open on the end, and zero-based — `{startRowIndex: 4, endRowIndex: 5}`
 * is row 5 in the UI. Every range this service writes is exactly one cell.
 */
export interface GridRange {
  sheetId: number;
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
}

export interface UpdateCellsRequest {
  updateCells: {
    range: GridRange;
    rows: RowData[];
    /** Always `userEnteredValue`, so number formats and conditional formatting survive. */
    fields: string;
  };
}

export interface InsertDimensionRequest {
  insertDimension: {
    range: { sheetId: number; dimension: 'ROWS' | 'COLUMNS'; startIndex: number; endIndex: number };
    /**
     * Formats come from the row above. Requires a season row above it in the
     * same block — inheriting a show row's formats renders a correct date
     * serial as `46265`.
     */
    inheritFromBefore?: boolean;
  };
}

export interface DeleteDimensionRequest {
  deleteDimension: {
    range: { sheetId: number; dimension: 'ROWS' | 'COLUMNS'; startIndex: number; endIndex: number };
  };
}

/**
 * A server-side copy of a whole tab. The nearest thing the API offers to the
 * UI's named versions, which are exposed nowhere: Sheets v4 has no revision
 * surface at all, and Drive v3 revisions can only be listed, fetched, deleted
 * or pinned — never named, created, or reverted to.
 */
export interface DuplicateSheetRequest {
  duplicateSheet: { sourceSheetId: number; insertSheetIndex?: number; newSheetId?: number; newSheetName?: string };
}

export interface DeleteSheetRequest {
  deleteSheet: { sheetId: number };
}

/**
 * Copies a range from one tab onto another, server-side — no cell values cross
 * the wire. Relative formula references are adjusted by the paste offset, which
 * is zero when source and destination sit at the same coordinates.
 */
export interface CopyPasteRequest {
  copyPaste: { source: GridRange; destination: GridRange; pasteType: 'PASTE_NORMAL'; pasteOrientation?: 'NORMAL' };
}

export type SheetRequest =
  | UpdateCellsRequest
  | InsertDimensionRequest
  | DeleteDimensionRequest
  | DuplicateSheetRequest
  | DeleteSheetRequest
  | CopyPasteRequest;

export interface BatchUpdateResponse {
  replies?: Array<{ duplicateSheet?: { properties?: SheetProperties } }>;
}
