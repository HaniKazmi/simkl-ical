/**
 * PARSE — snapshot → blocks. Pure: no config, no clock, no network.
 *
 * The spreadsheet half of PARSE, after `1-index.ts` has indexed the library
 * and found something worth reading the grid for.
 *
 * The sheet's structure is implicit — a row with the `Show` column filled
 * starts a block, and every row after it belongs to that block until the next
 * one. Everything downstream depends on getting that partition right, so this
 * module fails closed rather than guessing.
 */

import type { CellData, ExtendedValue } from '../api/google/types.ts';
import type { SheetSnapshot } from './io/spreadsheet.ts';

/**
 * The labels the sync needs. Columns are resolved by these, never by position:
 * the user rearranges them. Hardcoded on purpose — a rename should stop the
 * sync loudly rather than silently write to whatever now sits in that column.
 *
 * Deliberately only the ten that are read or written. Requiring `Genre` would
 * make renaming a column the sync never touches a hard failure.
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
 * `userEnteredValue.formulaValue` is the definitive test. A cell can *look*
 * like a formula result in `effectiveValue` and be a literal, and vice versa;
 * only what was typed says which.
 */
export const isFormulaValue = (value: ExtendedValue | undefined): boolean => typeof value?.formulaValue === 'string';

export const isFormula = (cell: CellData | undefined): boolean => isFormulaValue(cell?.userEnteredValue);

/**
 * Whether two cell values are the same. Structural, not `JSON.stringify` — key
 * order is not part of a value.
 *
 * One definition, because two consumers ask the same question for opposite
 * reasons: the guard uses it for "the sheet still holds what the plan was built
 * on", the verifier for "did anything change". `ExtendedValue` has five members
 * and this compares four; if only one copy of that decision ever learned about
 * `errorValue`, the guard would pass plans the verifier then reverts.
 */
export const sameValue = (a: ExtendedValue | undefined, b: ExtendedValue | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  return a.numberValue === b.numberValue && a.stringValue === b.stringValue && a.boolValue === b.boolValue && a.formulaValue === b.formulaValue;
};

/**
 * The computed value: a formula's result, or a literal's own value. Date
 * serials and counts arrive here as real numbers, which is the entire reason
 * the read asks for grid data rather than values.
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
 * either way, but every A1 reference in the report would be wrong — which is
 * precisely where a human checks the tool's work.
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
 * The header row's index, found by content rather than assumed to be row 1 —
 * the last positional dependency there would otherwise be.
 */
export const findHeaderRow = (rows: CellData[][]): number => {
  const limit = Math.min(rows.length, HEADER_SEARCH_ROWS);
  for (let row = 0; row < limit; row += 1) {
    const labels = new Set((rows[row] ?? []).map((cell) => fold(textOf(cell) ?? '')));
    if (labels.has('show') && labels.has('season')) return row;
  }
  throw new GridError(`No header row in the first ${HEADER_SEARCH_ROWS} rows — looked for one containing Show and Season.`);
};

/**
 * Column index per label. Every label must appear exactly once: missing,
 * renamed or duplicated writes nothing at all, because a duplicate makes
 * "which column is Episode" unanswerable and the wrong answer is a real edit
 * to the wrong cell.
 */
export const resolveColumns = (headerCells: CellData[], width: number): ColumnMap => {
  const found = new Map<string, number[]>();
  for (let column = 0; column < width; column += 1) {
    const label = fold(textOf(headerCells[column]) ?? '');
    if (!label) continue;
    found.set(label, [...(found.get(label) ?? []), column]);
  }

  const columns = {} as ColumnMap;
  const problems: string[] = [];
  for (const header of HEADERS) {
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
   * special: never inserted, and never added to. Callers test that themselves
   * with `Number.isInteger` — carrying a `fractional` flag alongside would be
   * a second copy of the same one-line rule.
   */
  season: number | null;
  /** Episodes *watched* — a count, not the highest episode number. */
  episode: number | null;
  /**
   * Whether the row has an end date, which freezes it forever.
   *
   * A flag rather than the serial, because the serial is never read and asking
   * `end !== null` of a parsed number gets the fail-safe backwards: a hand-typed
   * `TBD` is not blank but does not parse, so it would read as *open* and the
   * sync would overwrite the note with a date.
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
   * `show` or `anime`. Governs two things, both about what may be written: a
   * row may only be inserted into a `show` block, and only a `show` block's
   * season rows can be given a runtime — a SIMKL anime record numbers every
   * cour "season 1", so the row's number addresses no TVDB season.
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
 * Ids from one cell. `"522882,581835"` is a season whose cour was split across
 * two SIMKL entries; a single id arrives as a number, not a string.
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
  const headerRow = findHeaderRow(rows);
  // The declared width, not the widest row: a user who rearranges may also add
  // a column, and a truncated read presents a displaced header as *missing*,
  // which under the fail-closed rule disables the sync entirely.
  const width = Math.max(snapshot.columnCount, ...rows.map((r) => r.length));
  const columns = resolveColumns(rows[headerRow] ?? [], width);

  const blocks: ShowBlock[] = [];
  for (let row = headerRow + 1; row < rows.length; row += 1) {
    const cells = rows[row] ?? [];
    const showCell = cells[columns.Show];

    if (!isBlank(showCell)) {
      const title = textOf(showCell);
      // The show-row formulas roll up with MATCH("*", …), which matches text
      // cells only — a title stored as a number makes the block above it run
      // straight into this one and over-sum, with no error value to reveal it.
      // "24", "1899" and "1923" are real show names, so this is not theoretical.
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

    // Trailing blank rows are the sheet's empty tail, not data. So is a row
    // carrying nothing but an id: without a parsed Season it has no episode
    // count to advance and no shape to compare, yet `resolveRow` takes the
    // by-id branch — which never consults `season` — and a count gets planned
    // into a row that is not one.
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
      closed: !isBlank(cells[columns.End]),
      ids: parseIds(cells[columns.id]),
    });
  }

  return { snapshot, columns, blocks };
};

/**
 * Which SIMKL entries a season row maps to: **its own ids win, and a blank one
 * inherits the show row's**.
 *
 * Never inferred from `Type`. Both exceptions exist in the sheet today —
 * Doctor Who carries ids in *both* places (so precedence matters) and Parasyte
 * carries one *only* on a season row despite reading `Type=show` (so location
 * cannot be inferred).
 */
export const idsFor = (block: ShowBlock, season: SeasonRow): number[] => (season.ids.length ? season.ids : block.ids);

/**
 * Ids claimed by more than one row. Both claimants are unsafe to write.
 *
 * Show rows count as claimants, not just season rows: the same series entered
 * twice with the same id on both show rows is the likeliest way this happens in
 * a hand-maintained file, and every season row of *both* blocks would then
 * inherit it through `idsFor` — one title's progress driving edits in two
 * unrelated places.
 */
export const duplicateIds = (blocks: ShowBlock[]): Set<number> => {
  const owner = new Map<number, ShowBlock>();
  const duplicates = new Set<number>();
  for (const block of blocks) {
    // Claimed per block, so writing the series id on the show row *and*
    // repeating it on one of that show's own season rows is not a clash — it
    // says the same true thing twice. Counted per row it made every row in the
    // block report an id "claimed by more than one row", and the planner then
    // declined the Status and the insert over a conflict that did not exist.
    const ids = new Set([...block.ids, ...block.seasons.flatMap((season) => season.ids)]);
    for (const id of ids) {
      const first = owner.get(id);
      if (first !== undefined && first !== block) duplicates.add(id);
      else owner.set(id, block);
    }

    // Two *season* rows of one show naming the same id is a real ambiguity
    // though: one title's progress cannot say which of them to advance.
    const perSeason = new Map<number, number>();
    for (const season of block.seasons) {
      for (const id of new Set(season.ids)) perSeason.set(id, (perSeason.get(id) ?? 0) + 1);
    }
    for (const [id, claims] of perSeason) if (claims > 1) duplicates.add(id);
  }
  return duplicates;
};

/**
 * Whether a block's status and lookups run on the cour model: no id on the show
 * row, so each season row carries its own SIMKL entry and that entry's counters
 * describe the whole season. This is how anime is laid out — one SIMKL record
 * per cour — and it is a fact about where the ids sit, never about `Type`.
 */
export const usesCourModel = (block: ShowBlock): boolean => block.ids.length === 0;

/**
 * Whether a block's season numbers can address TVDB seasons at all — the scope
 * of the runtime write, and the one claim a row cannot take back once its cell
 * is filled and dated in the same batch.
 *
 * A stricter test than `!usesCourModel`, and the difference is deliberate: a
 * hand-maintained sheet can give an anime block a show-row id, which the cour
 * test would read as live-action. It is not — a SIMKL anime record numbers
 * every cour `season: 1` and all cours of a franchise share one TVDB id, so
 * the row's number addresses no TVDB season. Attack on Titan's six records all
 * point at tvdb 267440, whose season 1 holds 25 episodes against their
 * 25/12/12/16/12/2.
 */
export const runtimeScopeOk = (block: ShowBlock): boolean => block.type === 'show' && block.ids.length > 0;
