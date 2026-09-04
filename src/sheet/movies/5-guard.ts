/**
 * GUARD — the last thing between a films plan and the spreadsheet. Pure.
 *
 * `assertFilmPlanSafe` is a checklist of named rules, each re-deriving one
 * claim the planner made against the snapshot the plan was built from. It
 * throws rather than trimming: the interesting failure is "the planner is
 * wrong", and half of a wrong plan is still wrong.
 *
 * The whitelists below are this module's own spec, never derived from what the
 * planner emits — derived, one bad emission would widen both at once. That is
 * what makes them a second, independent statement of the rule that matters
 * most here: **ten of this tab's columns are written when the row is created
 * and never again**. A plan that tries to rewrite a film's `Genre` or `Banner`
 * is refused whole, rather than being prevented only by the planner having
 * declined to build it.
 *
 * The value conventions it shares with the planner (`values.ts`) are one copy
 * on purpose: a bound that exists twice can disagree, and any gap is a
 * whole-plan refusal on good data.
 */

import { config } from '../../shared/config.ts';
import { isFormula, sameValue } from '../2-grid.ts';
import { maxSerial, plausibleSerial } from '../values.ts';
import {
  isCertificate,
  isGenre,
  MAX_SECONDARY_GENRES,
  plausibleReleaseSerial,
  plausibleRuntime,
  plausibleScore,
  releaseCeiling as releaseHorizon,
} from './values.ts';
import { nextFilmRow, type MovieGrid, type MovieHeaderName } from './2-grid.ts';
import type { FilmCellEdit, FilmPlan, FilmRowInsert } from './4-plan.ts';
import type { ExtendedValue } from '../../api/google/types.ts';

/**
 * What the sync may write to a row that already exists — the three columns
 * that follow SIMKL, and nothing else.
 */
export const EDIT_FIELDS = new Set<MovieHeaderName>(['Watch Date', 'Score', 'Runtime']);

/**
 * Nothing on this tab is ever emptied. Its own axis rather than a field name
 * spelled into the shape check, so the rule sits beside the fields it
 * qualifies — and so widening it is a deliberate act rather than a side effect
 * of adding a field somewhere else.
 */
const EMPTIABLE: Set<MovieHeaderName> = new Set();

/**
 * What it may write into a row it is creating. A *separate* whitelist: an
 * insert fills up to thirteen columns, and folding the two together would
 * either forbid the insert or let an ordinary edit reach every one of them.
 *
 * `Anime` is in neither. The rows carrying it came from SIMKL's anime
 * category, which this sync does not pull.
 */
export const INSERT_FIELDS = new Set<MovieHeaderName>([
  'Name',
  'Watch Date',
  'Score',
  'Cinema',
  'Runtime',
  'Genre',
  'Genres',
  'Rating',
  'Release Date',
  'Franchise',
  'Director',
  'id',
  'Banner',
]);

export class UnsafeFilmPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeFilmPlanError';
  }
}

// Annotated on the variable, not the arrow: only that form makes TypeScript
// narrow at call sites, letting the checks below read as straight-line
// assertions rather than defensive `?.` chains.
const refuse: (message: string) => never = (message) => {
  throw new UnsafeFilmPlanError(message);
};

const describeValue = (value: ExtendedValue | undefined): string =>
  value === undefined
    ? '(empty)'
    : (value.formulaValue ??
      value.stringValue ??
      (value.numberValue !== undefined ? String(value.numberValue) : (value.boolValue !== undefined ? String(value.boolValue) : JSON.stringify(value))));

export interface FilmSafetyLimits {
  maxEdits?: number;
  maxRows?: number;
  /**
   * Edits another tab has already planned this poll, which count against the
   * same budget.
   *
   * The budget is a blast radius for the whole poll, not an allowance per tab:
   * counted per tab, one poll writes twice `SHEET_MAX_EDITS` while each half
   * reports itself inside it.
   */
  spent?: { edits: number; rows: number };
  now?: Temporal.Instant;
  timezone?: string;
}

interface FilmGuardContext {
  grid: MovieGrid;
  serialCeiling: number;
  /** Wider than `serialCeiling`: a film can be watched before it opens here. */
  releaseCeiling: number;
  /** Row index → the film that row holds, for the rows a write may land on. */
  filmRows: Map<number, number>;
}

// --- Budgets ---------------------------------------------------------------

/** Over budget refuses the whole plan; it never truncates. */
const checkBudgets = (plan: FilmPlan, maxEdits: number, maxRows: number, spent: { edits: number; rows: number }): void => {
  const edits = plan.edits.length + spent.edits;
  if (edits > maxEdits) {
    refuse(`${edits} edits this poll exceeds SHEET_MAX_EDITS=${maxEdits}. Nothing written; the report lists every proposed edit.`);
  }
  const rows = new Set([...plan.edits.map((e) => e.row), ...(plan.insert ? [plan.insert.row] : [])]).size + spent.rows;
  if (rows > maxRows) refuse(`${rows} distinct rows this poll exceeds SHEET_MAX_ROWS=${maxRows}.`);
};

// --- Rules every written cell obeys ----------------------------------------

/** The vocabulary and bounds each column accepts, in one place per field. */
const checkValue = (field: MovieHeaderName, value: ExtendedValue, where: string, serialCeiling: number, releaseCeiling: number): void => {
  if (value.numberValue !== undefined && !Number.isFinite(value.numberValue)) refuse(`${where}: not a finite number.`);

  switch (field) {
    case 'Watch Date':
      if (!plausibleSerial(value.numberValue, serialCeiling)) refuse(`${where}: ${describeValue(value)} is not a plausible watch date.`);
      return;
    case 'Release Date':
      // A different floor from a watch date, and the reason is in `values.ts`:
      // films predate anything this sheet records watching.
      if (!plausibleReleaseSerial(value.numberValue, releaseCeiling)) {
        refuse(`${where}: ${describeValue(value)} is not a plausible release date.`);
      }
      return;
    case 'Score':
      if (value.numberValue === undefined || !plausibleScore(value.numberValue)) refuse(`${where}: ${describeValue(value)} is not a score of 1-10.`);
      return;
    case 'Runtime':
      if (value.numberValue === undefined || !plausibleRuntime(value.numberValue)) {
        refuse(`${where}: ${describeValue(value)} is not a runtime in whole minutes.`);
      }
      return;
    case 'Rating':
      if (value.numberValue === undefined || !isCertificate(value.numberValue)) {
        refuse(`${where}: ${describeValue(value)} is not a BBFC certificate age.`);
      }
      return;
    case 'Genre':
      if (typeof value.stringValue !== 'string' || !isGenre(value.stringValue)) {
        refuse(`${where}: ${describeValue(value)} is not one of the genres the renderer colours.`);
      }
      return;
    case 'Genres': {
      if (typeof value.stringValue !== 'string') refuse(`${where}: Genres must be text.`);
      // No secondaries is a real state — 27 rows on the tab hold it — and
      // `''.split(',')` is `['']`, which is not a genre. Refusing that would
      // make the planner's decision to omit the cell load-bearing for the
      // guard's correctness, which is the coupling these rules exist to avoid.
      if (!value.stringValue) return;
      const tokens = value.stringValue.split(',').map((token) => token.trim());
      if (tokens.length > MAX_SECONDARY_GENRES) refuse(`${where}: ${tokens.length} genres exceeds the ${MAX_SECONDARY_GENRES} this column holds.`);
      for (const token of tokens) if (!isGenre(token)) refuse(`${where}: ${token} is not one of the genres the renderer colours.`);
      return;
    }
    case 'Cinema':
      // Only ever true. The tab spells "no" as an absent cell, so a written
      // FALSE would be a value no hand-maintained row has ever held.
      if (value.boolValue !== true) refuse(`${where}: Cinema is only ever written as TRUE.`);
      return;
    case 'id':
      // Text, matching all 348 rows. A number here compares unequal to every
      // other id cell, so a later run would not recognise its own insert.
      if (typeof value.stringValue !== 'string' || !/^\d+$/.test(value.stringValue)) refuse(`${where}: id must be the SIMKL id as text.`);
      return;
    case 'Name':
    case 'Franchise':
    case 'Director':
    case 'Banner':
      if (typeof value.stringValue !== 'string' || !value.stringValue.trim()) refuse(`${where}: ${field} must be non-empty text.`);
      return;
  }
};

/**
 * One cell write's shape, existing row or not: a whitelisted field, at the
 * column the header map resolves, holding a value that column accepts.
 */
const checkCellShape = (cell: FilmCellEdit, allowed: Set<MovieHeaderName>, { grid, serialCeiling, releaseCeiling }: FilmGuardContext): void => {
  const where = `${cell.address} (${cell.field})`;

  if (!allowed.has(cell.field)) refuse(`${where}: not a field this sync may write.`);
  if (cell.column !== grid.columns[cell.field]) {
    refuse(`${where}: column ${cell.column} does not match the resolved position of ${cell.field}.`);
  }

  if (cell.value === undefined) {
    if (!EMPTIABLE.has(cell.field)) refuse(`${where}: not a field this sync may empty.`);
    return;
  }
  checkValue(cell.field, cell.value, where, serialCeiling, releaseCeiling);
};

/**
 * The alignment rules — what catches a plan built against a different grid,
 * the one failure that produces real writes in wrong places.
 */
const checkCellAlignment = (cell: FilmCellEdit, { grid }: FilmGuardContext): void => {
  const where = `${cell.address} (${cell.field})`;

  // Bounds first: past the end both sides read as undefined, so the value
  // comparison would agree with itself and pass.
  if (cell.row < 0 || cell.row >= grid.snapshot.rows.length) refuse(`${where}: row is outside the snapshot.`);
  const actual = grid.snapshot.rows[cell.row]?.[cell.column];
  if (!sameValue(cell.previous, actual?.userEnteredValue)) {
    refuse(`${where}: the cell no longer holds what the plan was built on.`);
  }
  // Unconditional. This tab carries no formula today, and the copy people read
  // carries one in `Banner` — so the rule has to hold rather than be assumed.
  if (isFormula(actual)) refuse(`${where}: is a formula.`);
};

// --- Edits -----------------------------------------------------------------

const checkEdit = (cell: FilmCellEdit, ctx: FilmGuardContext): void => {
  const where = `${cell.address} (${cell.field})`;

  // Which film this row holds, re-derived from the grid rather than trusted
  // from the plan. Alignment alone cannot catch a write aimed one row off:
  // every blank cell compares equal to every other, so `previous` matches and
  // the wrong film silently takes the value. Rows the parse cannot identify —
  // no id, or an id on two rows — are absent from the map and so unwritable,
  // which is the same answer the planner reaches and the guard must reach on
  // its own.
  const holds = ctx.filmRows.get(cell.row);
  if (holds === undefined) refuse(`${where}: row ${cell.row + 1} is not a row this sync can identify a film on.`);
  if (holds !== cell.id) refuse(`${where}: the plan is for film ${cell.id} but that row holds ${holds}.`);

  checkCellShape(cell, EDIT_FIELDS, ctx);
  checkCellAlignment(cell, ctx);
};

// --- The insert ------------------------------------------------------------

const checkInsert = (insert: FilmRowInsert, ctx: FilmGuardContext): void => {
  const { grid } = ctx;

  const expected = nextFilmRow(grid);
  // Room first, because the placement rule below pins the row to exactly one
  // value: asked second, this could only ever fire on the row placement had
  // already accepted, so it would never be reached and never be tested.
  // `rowCount` is a count, so the last usable 0-based index is one below it.
  if (expected >= grid.snapshot.rowCount) {
    refuse(`insert at row ${expected + 1}: the tab declares only ${grid.snapshot.rowCount} rows, so there is no row to add.`);
  }
  // Below every row the tab uses, or under the header when it holds none.
  // Inserting into the middle would shift every row beneath it, and this
  // plan's other edits carry pre-write indices.
  if (insert.row !== expected) {
    refuse(`insert at row ${insert.row + 1}: a film row is only ever added at row ${expected + 1}.`);
  }

  // No edit may touch the row being created: its index is pre-write, so an
  // edit sharing it addresses whatever currently sits there.
  for (const cell of insert.fill) {
    if (cell.row !== insert.row) refuse(`${cell.address} (${cell.field}): a fill cell must sit on the inserted row.`);
    if (cell.id !== insert.id) refuse(`${cell.address} (${cell.field}): the cell is for film ${cell.id} but the row is for ${insert.id}.`);
    if (cell.previous !== undefined) refuse(`${cell.address} (${cell.field}): the inserted row has no previous value.`);
    checkCellShape(cell, INSERT_FIELDS, ctx);
  }

  // The id is what every later run matches this row by. A row inserted without
  // one is a film the sync would insert again on the next poll, forever.
  const id = insert.fill.find((cell) => cell.field === 'id');
  if (!id) refuse(`insert at row ${insert.row + 1}: a film row must carry its SIMKL id.`);
  if (id.value?.stringValue !== String(insert.id)) {
    refuse(`insert at row ${insert.row + 1}: the id cell says ${describeValue(id.value)} but the plan is for ${insert.id}.`);
  }
  if (!insert.fill.some((cell) => cell.field === 'Name')) refuse(`insert at row ${insert.row + 1}: a film row must carry a name.`);
  if (!insert.fill.some((cell) => cell.field === 'Watch Date')) refuse(`insert at row ${insert.row + 1}: a film row must carry a watch date.`);

  const fields = insert.fill.map((cell) => cell.field);
  const duplicated = fields.find((field, i) => fields.indexOf(field) !== i);
  if (duplicated) refuse(`insert at row ${insert.row + 1}: ${duplicated} is filled twice.`);

  // A film already on the tab must never be inserted again.
  if (grid.rows.some((row) => row.id === insert.id)) {
    refuse(`insert at row ${insert.row + 1}: SIMKL id ${insert.id} is already on the tab.`);
  }
};

export const assertFilmPlanSafe = (
  plan: FilmPlan,
  grid: MovieGrid,
  {
    maxEdits = config.sheetMaxEdits,
    maxRows = config.sheetMaxRows,
    spent = { edits: 0, rows: 0 },
    now = Temporal.Now.instant(),
    timezone = config.timezone,
  }: FilmSafetyLimits = {},
): void => {
  const ctx: FilmGuardContext = {
    grid,
    serialCeiling: maxSerial(now, timezone),
    releaseCeiling: releaseHorizon(now, timezone),
    // Only rows carrying an id the tab does not repeat: an id-less row is one
    // someone typed by hand and a repeated id makes "which row is this film"
    // a coin toss, so neither may be written to.
    filmRows: new Map(
      grid.rows.filter((row) => row.id !== null && !grid.duplicates.has(row.id)).map((row) => [row.row, row.id as number]),
    ),
  };

  checkBudgets(plan, maxEdits, maxRows, spent);
  for (const cell of plan.edits) checkEdit(cell, ctx);
  if (plan.insert) checkInsert(plan.insert, ctx);
};
