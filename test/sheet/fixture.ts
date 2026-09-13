/**
 * The sheet-grid fixture builder, shared by every suite that needs a grid.
 *
 * Rows are *named* — `fx.cell('fargoS2', …)`, not `cell(3, …)`. A bare index
 * means nothing to a reader and re-points silently when a row is added above
 * it, and a wrong row index is the catastrophic failure this subsystem exists
 * to prevent. `cell` also gives `previous` its real value from the snapshot; a
 * hand-built copy makes every "no longer holds what the plan was built on"
 * assertion pass vacuously.
 *
 * Not in `helpers.ts`, which would have to import plan types. The `test/**`
 * glob only collects `*.test.ts`, so this file never runs as a suite.
 */

import { a1, parseGrid, type Grid, type HeaderName, type ShowField } from '../../src/sheet/2-grid.ts';
import { artworkFormula, dateSerial, ROLLUP_FIELDS, showRowFormulas, SHOW_TYPE } from '../../src/sheet/values.ts';
import { emptyPlan, type BlockCell, type BlockInsert, type CellEdit, type Insert, type RowInsert, type SheetPlan } from '../../src/sheet/4-plan.ts';
import { indexLibrary, type TitleProgress } from '../../src/sheet/1-index.ts';
import { seasonShapes, type TitleCatalogue } from '../../src/sheet/3-catalogue.ts';
import type { ExtendedValue } from '../../src/api/google/types.ts';
import { daysAgo, libraryOf, seasonRow, SHEET_HEADERS, sheetSnapshot, showRow, type CellSpec, type ItemSpec } from '../helpers.ts';

export const H = SHEET_HEADERS;

/**
 * A date serial the guard accepts: today, so nothing is implausibly future.
 * Named in UTC rather than sliced off an instant.
 */
export const TODAY = dateSerial(Temporal.Now.plainDateISO('UTC'));

/** The same day as a season row's last-watched note. */
export const TODAY_NOTE = Temporal.Now.plainDateISO('UTC').toString();

export interface NamedRow {
  name: string | null;
  cells: CellSpec[];
}

export const show = (
  name: string | null,
  title: string,
  {
    status = 'Ended' as string | null,
    id = 1 as number | string | null,
    type = 'show',
    /** The `Franchise` cell. Blank sorts the block where its title puts it, which is what 62 hand judgements on the tab are not. */
    franchise = null as string | null,
  } = {},
): NamedRow => ({ name, cells: showRow(title, status, id, type, { franchise }) });

export const season = (
  name: string | null,
  number: number,
  episode: number | null,
  end: number | null,
  options: { id?: number | string | null; start?: number; runtime?: number | null; note?: string | null } = {},
): NamedRow => ({ name, cells: seasonRow(number, episode, end, options) });

/** An arbitrary row, for shapes `show`/`season` cannot say. */
export const raw = (name: string | null, cells: CellSpec[]): NamedRow => ({ name, cells });

export interface GridFixture {
  grid: Grid;
  /** The specs behind the snapshot, for suites that mutate a copy the way a real write would. */
  rows: CellSpec[][];
  /** Row name → snapshot row index. */
  at: Record<string, number>;
  /** Row name → the index just under it — where an insert between rows lands. */
  below: Record<string, number>;
  /** One past the last row: where an insert at the end of the sheet lands. */
  end: number;
  /** An edit whose `previous` comes from the snapshot, the way the planner builds one. */
  cell(row: string | number, field: HeaderName, value: ExtendedValue | undefined, previous?: ExtendedValue): CellEdit;
  /** A well-formed insert at a row index or just under a named row. */
  insertAt(row: string | number, season: number, options?: InsertOptions): RowInsert;
  /** A well-formed block insert: a show row at `row` and its first season row under it. */
  blockAt(row: string | number, options?: BlockOptions): BlockInsert;
  /** One cell of a block's fill, at the column its field resolves to. */
  blockCell(row: number, field: ShowField, value: ExtendedValue | undefined): BlockCell;
}

/**
 * What a well-formed block may be varied by. Every default is a value the
 * guard accepts, so a test that changes one is testing the rule it changed and
 * nothing else.
 */
export interface BlockOptions {
  title?: string;
  franchise?: string;
  id?: number;
  season?: number;
  status?: string | null;
  genre?: string | null;
  genres?: string | null;
  network?: string | null;
  certificate?: number | null;
  /** With a bucket the show row carries the artwork formula; without one it carries no such cell. */
  bucket?: string | null;
  /** The last-watched note the season row carries, and the end date instead of it. */
  note?: string | null;
  end?: number | null;
  runtime?: number | null;
}

export interface InsertOptions {
  title?: string;
  runtime?: number | null;
  end?: number | null;
  /** The last-watched note a row inserted open carries. */
  note?: string | null;
}

/** The header row is implicit: it is row 0 of every grid, never named. */
export const gridFixture = (...named: NamedRow[]): GridFixture => {
  const rows: CellSpec[][] = [H, ...named.map((r) => r.cells)];
  const at = Object.fromEntries(named.flatMap((r, i) => (r.name === null ? [] : [[r.name, i + 1]])));
  const below = Object.fromEntries(Object.entries(at).map(([name, index]) => [name, index + 1]));
  const grid = parseGrid(sheetSnapshot(rows));

  const indexOf = (row: string | number): number => {
    if (typeof row === 'number') return row;
    const index = at[row];
    if (index === undefined) throw new Error(`no fixture row named ${row}`);
    return index;
  };

  const cell = (row: string | number, field: HeaderName, value: ExtendedValue | undefined, previous?: ExtendedValue): CellEdit => {
    const index = indexOf(row);
    const column = grid.columns[field];
    return {
      row: index,
      column,
      field,
      previous: previous ?? grid.snapshot.rows[index]?.[column]?.userEnteredValue,
      value,
      address: a1(index, column),
      note: 'test',
    };
  };

  /**
   * The options are the states `planInsert` produces: `runtime: null` omits
   * the cell (a row left for its close to fill), `end` dates the row in the
   * same fill (a season already over), `note` is the last-watched date a row
   * inserted open carries. Nothing else: an insert writes no formula, since
   * every per-season total is a show-row roll-up.
   */
  const insertAt = (row: string | number, season: number, { title = 'Fargo', runtime = 45, end = null, note = null }: InsertOptions = {}): RowInsert => {
    const index = indexOf(row);
    return {
      kind: 'season',
      row: index,
      rows: 1,
      title,
      season,
      fill: (
        [
          ['Season', { numberValue: season }],
          ...(note === null ? [] : [['Note', { stringValue: note }] as [HeaderName, ExtendedValue]]),
          ['Episode', { numberValue: 4 }],
          ['Start', { numberValue: TODAY - 10 }],
          ...(runtime === null ? [] : [['Runtime', { numberValue: runtime }] as [HeaderName, ExtendedValue]]),
          ...(end === null ? [] : [['End', { numberValue: end }] as [HeaderName, ExtendedValue]]),
        ] as Array<[HeaderName, ExtendedValue]>
      ).map(([field, value]) => ({ row: index, column: grid.columns[field], field, previous: undefined, value, address: a1(index, grid.columns[field]), note: 'new' })),
      note: 'new row',
    };
  };

  const blockCell = (row: number, field: ShowField, value: ExtendedValue | undefined): BlockCell => {
    const column = grid.fields[field];
    if (column === undefined) throw new Error(`${field} is not a column on this fixture's tab`);
    return { row, column, field, previous: undefined, value, address: a1(row, column), note: 'new block' };
  };

  /**
   * The show row's cells and the season row's, in the shape `planBlocks`
   * builds them — the five roll-ups as the templates for the row they land on,
   * which is the one thing a hand-written literal here could get wrong in a way
   * no assertion would notice.
   */
  const blockAt = (
    row: string | number,
    {
      title = BLOCK_SHOW.title,
      franchise = BLOCK_SHOW.franchise,
      id = BLOCK_SHOW.id,
      season = 1,
      status = 'Watching' as string | null,
      genre = 'Drama' as string | null,
      genres = 'Sci-Fi, Thriller' as string | null,
      network = 'Apple TV+' as string | null,
      certificate = 15 as number | null,
      bucket = null as string | null,
      note = TODAY_NOTE as string | null,
      end = null as number | null,
      runtime = 45 as number | null,
    }: BlockOptions = {},
  ): BlockInsert => {
    const index = indexOf(row);
    const formulas = showRowFormulas(grid.columns, index);
    // Pushed rather than spread in conditionally: a spread of an empty array
    // has no element type to infer from, so every optional cell would need a
    // cast — and a cast is what would let a wrong field id through here, in the
    // one file every insert assertion is written against.
    const show: Array<[ShowField, ExtendedValue]> = [
      ['Show', { stringValue: title }],
      ['Franchise', { stringValue: franchise }],
      ['Type', { stringValue: SHOW_TYPE }],
      ['id', { stringValue: String(id) }],
    ];
    for (const field of ROLLUP_FIELDS) show.push([field, { formulaValue: formulas[field] }]);
    if (bucket !== null) show.push(['Banner', { formulaValue: artworkFormula(grid.columns.Show, index, bucket) }]);
    if (status !== null) show.push(['Status', { stringValue: status }]);
    if (genre !== null) show.push(['Genre', { stringValue: genre }]);
    if (genres !== null) show.push(['Genres', { stringValue: genres }]);
    if (network !== null) show.push(['Network', { stringValue: network }]);
    if (certificate !== null) show.push(['Certificate', { numberValue: certificate }]);

    const under: Array<[ShowField, ExtendedValue]> = [
      ['Season', { numberValue: season }],
      ['Episode', { numberValue: 2 }],
      ['Start', { numberValue: TODAY - 9 }],
    ];
    if (note !== null) under.push(['Note', { stringValue: note }]);
    if (runtime !== null) under.push(['Runtime', { numberValue: runtime }]);
    if (end !== null) under.push(['End', { numberValue: end }]);

    return {
      kind: 'block',
      row: index,
      rows: 2,
      id,
      title,
      franchise,
      season,
      fill: [
        ...show.map(([field, value]) => blockCell(index, field, value)),
        ...under.map(([field, value]) => blockCell(index + 1, field, value)),
      ],
      note: 'new block',
    };
  };

  return { grid, rows, at, below, end: rows.length, cell, insertAt, blockAt, blockCell };
};

export const planOf = (edits: CellEdit[] = [], insert: Insert | null = null): SheetPlan => ({ ...emptyPlan(), edits, insert });

/**
 * The show every block fixture adds: a TV series `fx` has no row for, whose
 * franchise sorts after Fargo's so `placeBlock` puts it under the last season
 * row rather than under the header.
 */
export const BLOCK_SHOW = { id: 900, title: 'Severance', franchise: 'Severance' } as const;

/**
 * One TV show the grid has no block for, with every fact a block needs already
 * answered — a season fully aired, part watched, its runtime in hand.
 *
 * The default is the state that *lands* a block, so every planner test varies
 * one input and asserts the block is held back for that reason alone. A season
 * part-watched rather than finished is deliberate: it exercises the open row
 * with its last-watched note, which is what a newly started show produces.
 */
export const blockLibrary = (
  catalogue: Partial<TitleCatalogue> = {},
  item: Partial<ItemSpec> = {},
): { index: Map<number, TitleProgress>; titles: Map<number, TitleCatalogue> } => ({
  index: indexLibrary(
    libraryOf({ id: BLOCK_SHOW.id, title: BLOCK_SHOW.title, status: 'watching', seasons: { 1: [daysAgo(9), daysAgo(2)] }, watched: 2, total: 9, ...item }),
  ),
  titles: new Map([
    [
      BLOCK_SHOW.id,
      {
        shapes: seasonShapes(Array.from({ length: 9 }, (_, i) => ({ season: 1, episode: i + 1, type: 'episode', aired: true }))),
        status: 'airing',
        runtime: 45,
        tvdbId: 111,
        tmdbId: 222,
        title: BLOCK_SHOW.title,
        network: 'Apple TV+',
        genres: ['Drama', 'Sci-Fi', 'Thriller'],
        certificate: 15,
        seasonRuntimes: new Map<number, number | null>([[1, 45]]),
        ...catalogue,
      },
    ],
  ]),
});

/**
 * The one fixture most suites plan against: one show, a closed season and an
 * open one. Suites needing another shape build their own with `gridFixture`.
 */
export const fx = gridFixture(
  show('fargo', 'Fargo', { status: 'Ended' }),
  season('fargoS1', 1, 6, 44000),
  season('fargoS2', 2, 3, null),
);
