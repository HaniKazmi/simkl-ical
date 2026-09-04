/**
 * PARSE — snapshot → blocks. Pure: no config, no clock, no network.
 *
 * The sheet's structure is implicit — a row with the `Show` column filled
 * starts a block, and every row after it belongs to that block until the next
 * one. Everything downstream depends on that partition, so this module fails
 * closed rather than guessing.
 */

import type { CellData, ExtendedValue } from '../api/google/types.ts';
import type { SheetSnapshot } from './io/spreadsheet.ts';

/**
 * The labels the sync needs. Columns are resolved by these, never by position:
 * the user rearranges them. Hardcoded so a rename stops the sync loudly
 * rather than writing to whatever now sits in that column.
 *
 * Only the ten that are read or written. Requiring `Genre` would make
 * renaming a column the sync never touches a hard failure.
 */
export const HEADERS = ['Show', 'Status', 'Season', 'Episode', 'Start', 'End', 'Episodes', 'Length', 'id', 'Type'] as const;

export type HeaderName = (typeof HEADERS)[number];

export type ColumnMap = Record<HeaderName, number>;

/** How far down to look for the header row, so a title row above it is survivable. */
const HEADER_SEARCH_ROWS = 5;

export class GridError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GridError';
  }
}

// --- Cell accessors --------------------------------------------------------

/**
 * `userEnteredValue.formulaValue` is the definitive test: `effectiveValue` can
 * look like a formula result and be a literal, and vice versa. Only what was
 * typed says which.
 */
export const isFormulaValue = (value: ExtendedValue | undefined): boolean => typeof value?.formulaValue === 'string';

export const isFormula = (cell: CellData | undefined): boolean => isFormulaValue(cell?.userEnteredValue);

/**
 * Whether two cell values are the same. Structural, not `JSON.stringify` — key
 * order is not part of a value.
 *
 * One definition for both consumers: the guard asks "does the sheet still hold
 * what the plan was built on", the verifier "did anything change".
 * `ExtendedValue` has five members and this compares four; if only one copy of
 * that decision learned about `errorValue`, the guard would pass plans the
 * verifier then reverts.
 */
export const sameValue = (a: ExtendedValue | undefined, b: ExtendedValue | undefined): boolean => {
  const [x, y] = [present(a), present(b)];
  if (x === undefined || y === undefined) return x === y;
  return x.numberValue === y.numberValue && x.stringValue === y.stringValue && x.boolValue === y.boolValue && x.formulaValue === y.formulaValue;
};

/**
 * A value with something in it. A cell holding nothing can arrive as an absent
 * `userEnteredValue` or as an empty one, and the two mean the same thing —
 * `isBlank` already reads them the same way.
 *
 * It matters for the one write that *removes* a value: read strictly, a cell
 * the sync emptied could come back looking like a write that did not land,
 * which rolls a correct batch back and plans the identical clear again on the
 * next poll.
 */
const present = (value: ExtendedValue | undefined): ExtendedValue | undefined =>
  value !== undefined && Object.keys(value).length > 0 ? value : undefined;

/**
 * The computed value: a formula's result, or a literal's own value. Date
 * serials and counts arrive as real numbers — the reason the read asks for
 * grid data rather than values.
 */
export const numberOf = (cell: CellData | undefined): number | null => {
  const n = cell?.effectiveValue?.numberValue ?? cell?.userEnteredValue?.numberValue;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

export const textOf = (cell: CellData | undefined): string | null => {
  const s = cell?.effectiveValue?.stringValue ?? cell?.userEnteredValue?.stringValue;
  const trimmed = s?.trim();
  return trimmed ? trimmed : null;
};

/** Whether anything at all was typed here — `{}` and an absent cell both read as empty. */
export const isBlank = (cell: CellData | undefined): boolean => {
  const value = cell?.userEnteredValue;
  if (!value) return true;
  if (typeof value.stringValue === 'string') return value.stringValue.trim() === '';
  return value.numberValue === undefined && value.boolValue === undefined && value.formulaValue === undefined;
};

// --- Addressing ------------------------------------------------------------

/**
 * A real base-26 conversion. `String.fromCharCode(65 + i)` yields `[` at index
 * 26 and this sheet already reaches `AE`. Writes are index-based and safe
 * either way, but every A1 reference in the report would be wrong — exactly
 * where a human checks the tool's work.
 */
export const columnLetter = (index: number): string => {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

/** A1 for a zero-based row and column. Reports and logs only; never sent. */
export const a1 = (row: number, column: number): string => `${columnLetter(column)}${row + 1}`;

// --- Header resolution -----------------------------------------------------

const fold = (label: string): string => label.trim().toLowerCase();

/**
 * The header row's index, found by content rather than assumed to be row 1.
 *
 * `required` is the pair of labels that identifies *this* tab's header, not
 * the whole set: a tab is recognised by the columns that make it that tab, and
 * demanding all of them would make a header row unfindable the moment one
 * column is renamed — turning a clear "X is missing" into "no header row at
 * all".
 *
 * Passed rather than defaulted, for the reason `resolveColumns` gives: two
 * tabs of different shapes read this, and a default is a shape one of them can
 * take by forgetting.
 */
export const findHeaderRow = (rows: CellData[][], required: readonly string[]): number => {
  const wanted = required.map(fold);
  const limit = Math.min(rows.length, HEADER_SEARCH_ROWS);
  for (let row = 0; row < limit; row += 1) {
    const labels = new Set((rows[row] ?? []).map((cell) => fold(textOf(cell) ?? '')));
    if (wanted.every((label) => labels.has(label))) return row;
  }
  throw new GridError(`No header row in the first ${HEADER_SEARCH_ROWS} rows — looked for one containing ${required.join(' and ')}.`);
};

/**
 * Column index per label. Every label must appear exactly once: a duplicate
 * makes "which column is Episode" unanswerable, and the wrong answer is a
 * real edit to the wrong cell.
 *
 * `headers` is required and `H` is inferred from it. A default would have to
 * be cast to `H` — there is no value that is every caller's header list — and
 * that cast is a hole: a films caller omitting the argument would compile and
 * receive the *show* grid's columns branded as movie columns, which is a wrong
 * column for every write and no error anywhere.
 */
export const resolveColumns = <H extends string>(headerCells: CellData[], width: number, headers: readonly H[]): Record<H, number> => {
  const found = new Map<string, number[]>();
  for (let column = 0; column < width; column += 1) {
    const label = fold(textOf(headerCells[column]) ?? '');
    if (!label) continue;
    found.set(label, [...(found.get(label) ?? []), column]);
  }

  const columns = {} as Record<H, number>;
  const problems: string[] = [];
  for (const header of headers) {
    const matches = found.get(fold(header)) ?? [];
    if (matches.length === 0) problems.push(`${header} is missing`);
    else if (matches.length > 1) problems.push(`${header} appears in ${matches.map((c) => columnLetter(c)).join(' and ')}`);
    else columns[header] = matches[0] as number;
  }
  if (problems.length) throw new GridError(`Cannot resolve the header row: ${problems.join('; ')}.`);
  return columns;
};

// --- Blocks ----------------------------------------------------------------

export interface SeasonRow {
  /** Zero-based index into `snapshot.rows`. */
  row: number;
  /**
   * The season label, or null if unparseable. A fractional one (`4.5`) is a
   * special: never inserted, never added to. Callers test with
   * `Number.isInteger`; a `fractional` flag would be a second copy of that
   * one-line rule.
   */
  season: number | null;
  /** Episodes *watched* — a count, not the highest episode number. */
  episode: number | null;
  /**
   * The `Status` cell's text. On a season row this carries the last watch
   * date, which the row's closing batch clears — so the planner needs to see
   * both what is there and that it is text, since only text it wrote itself
   * may be overwritten or removed.
   */
  status: string | null;
  /**
   * Whether the row has an end date, which freezes it forever.
   *
   * A flag rather than the serial: the serial is never read, and `end !== null`
   * on a parsed number gets the fail-safe backwards — a hand-typed `TBD` does
   * not parse, so it would read as *open* and the sync would overwrite the
   * note with a date.
   */
  closed: boolean;
  /** SIMKL ids, in release order. A row can carry several when a cour was split. */
  ids: number[];
}

export interface ShowBlock {
  row: number;
  title: string;
  status: string | null;
  /**
   * `show` or `anime`. Governs what may be written: rows are only inserted
   * into a `show` block, and only a `show` block's season rows can take a
   * runtime — a SIMKL anime record numbers every cour "season 1", so the
   * row's number addresses no TVDB season.
   */
  type: string | null;
  /** Ids on the *show* row. A season row's own id wins over these. */
  ids: number[];
  seasons: SeasonRow[];
}

export interface Grid {
  snapshot: SheetSnapshot;
  columns: ColumnMap;
  blocks: ShowBlock[];
}

/**
 * Ids from one cell. `"522882,581835"` is a cour split across two SIMKL
 * entries; a single id arrives as a number, not a string.
 */
export const parseIds = (cell: CellData | undefined): number[] => {
  const text = textOf(cell);
  if (text !== null) {
    return text
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  }
  const n = numberOf(cell);
  return n !== null && Number.isInteger(n) && n > 0 ? [n] : [];
};

export const parseGrid = (snapshot: SheetSnapshot): Grid => {
  const { rows } = snapshot;
  const headerRow = findHeaderRow(rows, ['Show', 'Season']);
  // The declared width, not the widest row: a truncated read presents a
  // displaced header as *missing*, which fail-closed turns into a disabled
  // sync.
  const width = Math.max(snapshot.columnCount, ...rows.map((r) => r.length));
  const columns = resolveColumns(rows[headerRow] ?? [], width, HEADERS);

  const blocks: ShowBlock[] = [];
  for (let row = headerRow + 1; row < rows.length; row += 1) {
    const cells = rows[row] ?? [];
    const showCell = cells[columns.Show];

    if (!isBlank(showCell)) {
      const title = textOf(showCell);
      // The show-row formulas roll up with MATCH("*", …), which matches text
      // only — a title stored as a number makes the block above run into this
      // one and over-sum, with no error value to reveal it. "24", "1899" and
      // "1923" are real show names.
      if (title === null) {
        throw new GridError(`${a1(row, columns.Show)} is not text. The show-row roll-up formulas would silently merge this block into the one above it.`);
      }
      blocks.push({
        row,
        title,
        status: textOf(cells[columns.Status]),
        type: textOf(cells[columns.Type])?.toLowerCase() ?? null,
        ids: parseIds(cells[columns.id]),
        seasons: [],
      });
      continue;
    }

    // Blank rows are the sheet's empty tail, not data. So is a row carrying
    // only an id: with no parsed Season it has nothing to advance or compare,
    // yet `resolveRow`'s by-id branch never consults `season`, so a count
    // would be planned into a row that is not one.
    if (cells.every((cell) => isBlank(cell))) continue;
    if (numberOf(cells[columns.Season]) === null && cells.every((cell, i) => i === columns.id || isBlank(cell))) continue;

    const block = blocks.at(-1);
    if (!block) {
      throw new GridError(`${a1(row, columns.Season)} is a season row with no show row above it.`);
    }

    block.seasons.push({
      row,
      season: numberOf(cells[columns.Season]),
      episode: numberOf(cells[columns.Episode]),
      status: textOf(cells[columns.Status]),
      closed: !isBlank(cells[columns.End]),
      ids: parseIds(cells[columns.id]),
    });
  }

  return { snapshot, columns, blocks };
};

/**
 * Which SIMKL entries a season row maps to: **its own ids win, a blank one
 * inherits the show row's**.
 *
 * Never inferred from `Type`. Both exceptions exist in the sheet — Doctor Who
 * carries ids in *both* places (precedence matters) and Parasyte carries one
 * *only* on a season row despite `Type=show` (location cannot be inferred).
 */
export const idsFor = (block: ShowBlock, season: SeasonRow): number[] => (season.ids.length ? season.ids : block.ids);

/**
 * Ids claimed by more than one row. Both claimants are unsafe to write.
 *
 * Show rows count as claimants too: the same series entered twice with the
 * same id on both show rows is the likeliest duplicate in a hand-maintained
 * file, and every season row of *both* blocks would inherit it through
 * `idsFor` — one title's progress driving edits in two unrelated places.
 */
export const duplicateIds = (blocks: ShowBlock[]): Set<number> => {
  const owner = new Map<number, ShowBlock>();
  const duplicates = new Set<number>();
  for (const block of blocks) {
    // Claimed per block: the series id on the show row *and* on one of its own
    // season rows says the same true thing twice, not a clash. Counted per row,
    // every row in the block would report a duplicate and the planner would
    // decline Status and the insert over a conflict that does not exist.
    const ids = new Set([...block.ids, ...block.seasons.flatMap((season) => season.ids)]);
    for (const id of ids) {
      const first = owner.get(id);
      if (first !== undefined && first !== block) duplicates.add(id);
      else owner.set(id, block);
    }

    // Two *season* rows of one show naming the same id is a real ambiguity:
    // one title's progress cannot say which to advance.
    const perSeason = new Map<number, number>();
    for (const season of block.seasons) {
      for (const id of new Set(season.ids)) perSeason.set(id, (perSeason.get(id) ?? 0) + 1);
    }
    for (const [id, claims] of perSeason) if (claims > 1) duplicates.add(id);
  }
  return duplicates;
};

/**
 * Whether a block's status and lookups run on the cour model: no id on the
 * show row, so each season row carries its own SIMKL entry whose counters
 * describe the whole season. This is how anime is laid out — one record per
 * cour — and it is a fact about where the ids sit, never about `Type`.
 */
export const usesCourModel = (block: ShowBlock): boolean => block.ids.length === 0;

/**
 * Whether a block's season numbers can address TVDB seasons at all — the scope
 * of the runtime write, a claim a row cannot take back once its cell is filled
 * and dated in the same batch.
 *
 * Stricter than `!usesCourModel` on purpose: a hand-maintained sheet can give
 * an anime block a show-row id, which the cour test would read as live-action.
 * It is not — a SIMKL anime record numbers every cour `season: 1` and all
 * cours of a franchise share one TVDB id. Attack on Titan's six records all
 * point at tvdb 267440, whose season 1 holds 25 episodes against their
 * 25/12/12/16/12/2.
 */
export const runtimeScopeOk = (block: ShowBlock): boolean => block.type === 'show' && block.ids.length > 0;
