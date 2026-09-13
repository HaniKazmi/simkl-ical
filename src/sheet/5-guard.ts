/**
 * GUARD — the last thing between a plan and the spreadsheet. Pure.
 *
 * `assertPlanSafe` is a checklist of named rules, each re-deriving one claim
 * the planner made against the snapshot the plan was built from. It throws
 * rather than trimming: the interesting failure is "the planner is wrong",
 * and half of a wrong plan is still wrong.
 *
 * It checks the alignment class *independently* — is this address the row the
 * plan thinks it is — because a misalignment is the one catastrophic failure
 * the subsystem has. That rule, the budget and the shape every written cell has
 * are `guard-core.ts`, shared with the films tab's guard; what is here is every
 * rule about *this* grid. The value conventions it shares with the planner
 * (`values.ts`, `runtimeScopeOk`) are one copy on purpose: a bound that
 * exists twice can disagree, and any gap is a whole-plan refusal on good
 * data.
 */

import { config, showArtworkBucket } from '../shared/config.ts';
import {
  isBlank,
  isHeaderName,
  numberOf,
  parseIds,
  runtimeScopeOk,
  SHOW_FIELD_LABELS,
  SHOW_LABELS,
  type Grid,
  type HeaderName,
  type SeasonRow,
  type ShowBlock,
  type ShowField,
} from './2-grid.ts';
import {
  artworkFormula,
  blockEnd,
  genreListProblem,
  isCertificate,
  isGenre,
  isStatus,
  isTracked,
  maxSerial,
  ownsNote,
  placeBlock,
  plausibleRuntime,
  plausibleSerial,
  ROLLUP_FIELDS,
  showRowFormulas,
  SHOW_TYPE,
  titleKey,
  watchedNoteSerial,
  type RollupField,
} from './values.ts';
import { gridIds, type BlockCell, type BlockInsert, type CellEdit, type Insert, type RowInsert, type SheetPlan } from './4-plan.ts';
import type { ExtendedValue } from '../api/google/types.ts';
import {
  checkBudgets,
  checkCellAlignment,
  checkCellPosition,
  checkCellShape,
  describeValue,
  PlanRefusal,
  type Refuse,
  type SpentBudget,
} from './guard-core.ts';

/** What the sync may write to a row that already exists. */
const EDIT_FIELDS = new Set<HeaderName>(['Status', 'Note', 'Episode', 'Start', 'End', 'Runtime']);

/**
 * What may be *emptied* rather than replaced, per whitelist. Its own axis for
 * the same reason the whitelists are two: a new row is filled, never cleared,
 * so an absent value there is a planner that lost one — and a set keeps the
 * rule beside the fields it qualifies, rather than as a field name spelled into
 * the shape check both whitelists share.
 */
const EMPTIABLE_EDITS = new Set<HeaderName>(['Note']);
const EMPTIABLE_INSERTS = new Set<HeaderName>();

/**
 * What it may write into a row it is creating. A *separate* whitelist: an
 * insert fills up to six columns, and folding the two together would either
 * forbid the insert or widen what an ordinary edit may touch. `Status` is not
 * here: it is the show row's derived state, and an insert creates a season
 * row. The whitelists are the guard's own spec, never derived from what the
 * planner emits — derived, one bad emission would widen both at once.
 */
const INSERT_FIELDS = new Set<HeaderName>(['Season', 'Note', 'Episode', 'Start', 'End', 'Runtime']);

export class UnsafePlanError extends PlanRefusal {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePlanError';
  }
}

const refuse: Refuse = (message) => {
  throw new UnsafePlanError(message);
};

export interface SafetyLimits {
  maxEdits?: number;
  maxRows?: number;
  /** What earlier halves of the poll already sent — see `checkBudgets`. */
  spent?: SpentBudget;
  now?: Temporal.Instant;
  /**
   * The zone the `End` bound is computed in — must be the one `planSync`
   * used: the serials are local dates, so a guard bounding them in a
   * different zone is off by a day either side.
   */
  timezone?: string;
  /**
   * The bucket a new show row's artwork formula links into, or null — which
   * covers an install with no bucket *and* one whose bucket is named while the
   * artwork page is not served, since only a served page can put an object
   * behind the link. `showArtworkBucket` in `shared/config.ts` is that rule, and
   * it is the planner's own option too, so the two cannot disagree about
   * whether the cell may be written at all.
   */
  showBucket?: string | null;
}

/** Everything the per-cell rules need to know about the grid, resolved once. */
interface GuardContext {
  grid: Grid;
  /** Tomorrow in the viewer's zone — see `maxSerial`. */
  serialCeiling: number;
  showBucket: string | null;
  showRows: Set<number>;
  /**
   * The block comes along because the runtime rule is about the block, not
   * the row: whether the season number means anything to TVDB is a property
   * of `type` and where the id came from.
   */
  seasonRows: Map<number, { season: SeasonRow; block: ShowBlock }>;
}

// --- Rules every written cell obeys -----------------------------------------

/**
 * The shape rules the core checks, plus the one both date columns share: a
 * serial no later than tomorrow in the viewer's zone.
 */
const checkShape = (cell: BlockCell, allowed: Set<ShowField>, emptiable: Set<ShowField>, { grid, serialCeiling }: GuardContext): void => {
  const value = checkCellShape(cell, { allowed, emptiable, columns: grid.fields }, refuse);
  if (value === undefined) return;
  if ((cell.field === 'End' || cell.field === 'Start') && !plausibleSerial(value.numberValue, serialCeiling)) {
    refuse(`${cell.address} (${cell.field}): ${describeValue(value)} is not a plausible date serial.`);
  }
};

// --- Per-field rules for edits ----------------------------------------------

/**
 * `Status` is the block's derived state — text, and never emptied.
 *
 * A date is refused rather than accepted as text: a state is one of four
 * words, and a value shaped like the season note is a planner writing the
 * wrong fact into the column.
 */
const checkStatusEdit = (value: ExtendedValue | undefined, where: string): void => {
  if (typeof value?.stringValue !== 'string' || !value.stringValue) refuse(`${where}: Status must be non-empty text.`);
  if (watchedNoteSerial(value.stringValue) !== null) refuse(`${where}: Status is a state, not a watch date.`);
};

/**
 * A season row's `Note` is the last-watched date, so the value is bounded
 * exactly as `End` is — the same fact, one column earlier in the row's life.
 */
const checkWatchedNote = (where: string, value: ExtendedValue | undefined, ceiling: number): void => {
  if (!plausibleSerial(watchedNoteSerial(value?.stringValue), ceiling)) {
    refuse(`${where}: ${describeValue(value)} is not a plausible last-watched date.`);
  }
};

/**
 * The `End` this batch writes to a row, if it writes one — which is the same
 * question as "does this batch date the row", asked for its value instead of
 * its answer. One definition for both readings: the runtime write, the note's
 * removal and the date-ordering rule all turn on it, and a predicate that
 * drifted from the lookup would keep passing while the other refused.
 */
const plannedEnd = (plan: SheetPlan, row: number): CellEdit | undefined => plan.edits.find((e) => e.row === row && e.field === 'End');

const closesRow = (plan: SheetPlan, row: number): boolean => plannedEnd(plan, row) !== undefined;

const checkNoteEdit = (cell: CellEdit, where: string, plan: SheetPlan, season: SeasonRow, ctx: GuardContext): void => {
  // Overwriting text a human typed is the one way this write can destroy
  // something nothing can reconstruct. `ownsNote` is the predicate the planner
  // declines on, re-derived here against the snapshot.
  if (!ownsNote(ctx.grid.snapshot.rows[cell.row]?.[cell.column], season.note)) {
    refuse(`${where}: the cell holds something this sync did not write.`);
  }

  if (cell.value === undefined) {
    // Emptying rides the batch that dates the row, the same way the runtime
    // write does: `End` is what makes the note redundant, so a plan that
    // removed it while leaving the row open would just lose the date.
    if (!closesRow(plan, cell.row)) {
      refuse(`${where}: a season's Note may only be cleared on the row that is being closed.`);
    }
    return;
  }
  checkWatchedNote(where, cell.value, ctx.serialCeiling);
};

/**
 * A season's `Start` is the day its first episode was watched, so it cannot sit
 * after the day its last one was — the one thing these two dates can say
 * between them that neither can say alone. Both bounds are already checked by
 * `checkCellShape`; this is the ordering.
 *
 * The row's `End` comes off the snapshot rather than off `SeasonRow`, which
 * carries only the boolean `closed`. A cell holding something that is not a
 * serial — a hand-typed `TBD` — names no day to be after, so there is nothing
 * to compare and the check does not apply. Refusing there would refuse the
 * whole plan over a cell the sync is not writing.
 */
const checkStartEdit = (cell: CellEdit, where: string, plan: SheetPlan, ctx: GuardContext): void => {
  // The planned `End` where this batch writes one, so the pair is checked as
  // the row will hold it rather than as it holds it now.
  const planned = plannedEnd(plan, cell.row);
  const end = planned ? planned.value?.numberValue : numberOf(ctx.grid.snapshot.rows[cell.row]?.[ctx.grid.columns.End]);
  if (typeof end !== 'number') return;

  const start = cell.value?.numberValue;
  if (typeof start === 'number' && start > end) {
    refuse(`${where}: a start of ${start} would fall after the row's end of ${end}.`);
  }
};

const checkEpisodeEdit = (cell: CellEdit, where: string, season: SeasonRow, ctx: GuardContext): void => {
  const next = cell.value?.numberValue;
  if (next === undefined || !Number.isInteger(next) || next < 1) refuse(`${where}: an episode count must be a positive whole number.`);
  // A count typed as text carries only `stringValue`, so it parses to no
  // count — the never-backwards rule below would then compare against 0 and
  // write a *smaller* number over a larger one, the one way that rule can be
  // defeated. Unconditional, like a formula cell.
  const actual = ctx.grid.snapshot.rows[cell.row]?.[cell.column];
  if (!isBlank(actual) && numberOf(actual) === null) {
    refuse(`${where}: the cell holds something that is not a number, so a count cannot be compared against it.`);
  }
  // Never backwards — the user's rule, and why a wrong-but-larger number is
  // the dangerous failure rather than a wrong-but-smaller one.
  if (next <= (season.episode ?? 0)) refuse(`${where}: ${next} would not increase the count of ${season.episode ?? 0}.`);
};

/**
 * The two runtime rules an insert and an edit must both satisfy. An insert
 * cannot reuse the others: no cell to find blank, no `End` edit to ride —
 * the row is created and dated by a single fill. Scope and bounds are all
 * the guard can re-derive there.
 */
const checkRuntimeScope = (where: string, block: Pick<ShowBlock, 'type' | 'ids'>): void => {
  // The one planner claim a row cannot take back: the row is dated by the
  // same batch, so the blank-cell rule stops protecting the cell the instant
  // the write lands. `runtimeScopeOk` carries the reasoning.
  if (!runtimeScopeOk(block)) {
    refuse(`${where}: a runtime may only be written in a live-action block that carries ids on its show row.`);
  }
};

const checkRuntimeMinutes = (where: string, value: ExtendedValue | undefined): void => {
  // Bounds live in `values.ts` beside `runtimeMinutes`, the conversion that
  // produces every value this checks. Whole minutes, so a day fraction or an
  // unrounded mean is refused as the payload error it is rather than landing
  // in a cell a reader reads as minutes.
  if (value?.numberValue === undefined || !plausibleRuntime(value.numberValue)) {
    refuse(`${where}: ${describeValue(value)} is not a per-episode runtime in whole minutes.`);
  }
};

const checkRuntimeEdit = (cell: CellEdit, where: string, plan: SheetPlan, season: SeasonRow, block: ShowBlock, ctx: GuardContext): void => {
  checkRuntimeScope(where, block);
  // A row carrying its own id has a season number that is explicitly not the
  // entry's — a split cour, Doctor Who's 2024 renumbering — exactly the
  // number that cannot be handed to TVDB.
  if (season.ids.length) {
    refuse(`${where}: the row carries its own id, so its season number is not the entry's to look up.`);
  }

  checkRuntimeMinutes(where, cell.value);
  // Blank only, unconditional: a hand-typed runtime is a deliberate
  // correction, and this cannot tell a better number from a worse one.
  // `isBlank` rather than `previous === undefined`, so a whitespace-only cell
  // reads the way `2-grid.ts` reads it everywhere.
  if (!isBlank(ctx.grid.snapshot.rows[cell.row]?.[cell.column])) {
    refuse(`${where}: the cell already holds a value.`);
  }
  // The claim that makes the two rules above safe, re-derived: a runtime is
  // only written onto a row this same batch closes. The closed-row refusal is
  // no contradiction — its snapshot is from before the write. Without this
  // check, a plan writing a runtime onto a row it left open would pass, and
  // the cell would be filled with nothing to freeze it.
  if (!closesRow(plan, cell.row)) {
    refuse(`${where}: a runtime may only be written on the row that is being closed.`);
  }
};

const checkEdit = (cell: CellEdit, plan: SheetPlan, ctx: GuardContext): void => {
  checkShape(cell, EDIT_FIELDS, EMPTIABLE_EDITS, ctx);
  checkCellAlignment(cell, ctx.grid.snapshot, refuse);
  const where = `${cell.address} (${SHOW_LABELS[cell.field]})`;

  // The two row kinds have disjoint write surfaces, so the row a write landed
  // on is itself a rule: a `Status` anywhere but a show row, or anything else
  // anywhere but a season row, is a planner that lost track of which row it
  // was writing.
  if (cell.field === 'Status') {
    if (!ctx.showRows.has(cell.row)) refuse(`${where}: Status may only be written on a show row.`);
    checkStatusEdit(cell.value, where);
    return;
  }

  const found = ctx.seasonRows.get(cell.row);
  if (!found) refuse(`${where}: ${cell.field} may only be written on a season row.`);
  const { season, block } = found;
  // A dated season settled every fact it settled once, and none of them is
  // revisited — the runtime write and the note's removal included, which look
  // like exceptions but ride the batch that closes the row and are checked
  // against a snapshot from before it.
  //
  // The fields that follow SIMKL are the exception, and the only one. What
  // they hold is not the row's decision but SIMKL's, so freezing them would
  // not preserve a judgement, it would only keep a stale copy of an upstream
  // fact. The planner writes one solely when the recorded value moved.
  if (season.closed && !isTracked(cell.field)) refuse(`${where}: the season already has an end date.`);

  if (cell.field === 'Note') checkNoteEdit(cell, where, plan, season, ctx);
  if (cell.field === 'Runtime') checkRuntimeEdit(cell, where, plan, season, block, ctx);
  if (cell.field === 'Episode') checkEpisodeEdit(cell, where, season, ctx);
  if (cell.field === 'Start') checkStartEdit(cell, where, plan, ctx);
};

// --- The insert -------------------------------------------------------------

const checkInsertPlacement = (insert: RowInsert, where: string, ctx: GuardContext): ShowBlock => {
  if (!Number.isInteger(insert.season) || insert.season < 1) {
    // Fractional labels encode judgements no rule reproduces, and SIMKL's
    // season 0 is specials, maintained by hand.
    refuse(`${where}: only whole numbered seasons may be inserted.`);
  }
  // findLast, not find: the nearest block above is where the new row lands.
  const block = ctx.grid.blocks.findLast((b) => b.row < insert.row);
  if (!block || block.title !== insert.title) refuse(`${where}: the insertion point is not inside ${insert.title}'s block.`);
  // `inheritFromBefore` takes formats from the row *immediately* above, and a
  // show row's render a correct date serial as `46265` — so does a spacer row,
  // which `parseGrid` keeps a block open across. The same question the block
  // insert asks one row up.
  if (!ctx.seasonRows.has(insert.row - 1)) {
    refuse(`${where}: no season row above the insertion point to inherit formats from.`);
  }
  return block;
};

/**
 * Every rule a season row being *created* obeys, whichever insert creates it.
 * A season row joining a block that exists and the one written under a new show
 * row are the same row, so they are held to one checklist — kept as two, a rule
 * hardened on one path leaves the other on the old behaviour and nothing fails.
 *
 * `block` is the two facts the runtime's scope turns on. For a season insert
 * they come off the grid; for a block they come off the show row the same batch
 * writes, which is what makes the rule answerable a row before the row exists.
 */
const checkSeasonRowFill = (fill: readonly BlockCell[], block: Pick<ShowBlock, 'type' | 'ids'>, ctx: GuardContext): void => {
  // Shape first, so the field-specific rules below run against a cell whose
  // field, column and emptiability the whitelists have already settled.
  //
  // No alignment: the row does not exist in the snapshot, so there is nothing
  // to compare. Each caller pins the row it creates to a block, which covers
  // the bounds an alignment check would add.
  for (const cell of fill) checkShape(cell, INSERT_FIELDS, EMPTIABLE_INSERTS, ctx);

  // A runtime carried by an insert needs *more* care than one on an edit: the
  // same fill creates the row and dates it, so neither the blank-cell rule
  // nor the closed-row rule stands between this number and the sheet, and
  // there is no `previous` to compare. Scope and bounds are all the guard can
  // re-derive here, so it derives both. The own-id rule needs no check: `id`
  // is not in `INSERT_FIELDS`, so the row inherits the block's.
  // Every such cell, not the first: requests are written in order and the
  // last wins, so checking one while writing two is a bound that does not
  // bind.
  for (const runtime of fill.filter((cell) => cell.field === 'Runtime')) {
    checkRuntimeScope(`${runtime.address} (Runtime)`, block);
    checkRuntimeMinutes(`${runtime.address} (Runtime)`, runtime.value);
  }

  // The same bound an edit's note gets, plus the rule the edit path gets from
  // the closed-row refusal: a dated row is never revisited, so a note created
  // beside an `End` date is one nothing can ever remove — the exact state the
  // clear exists to prevent. Nothing else stands between the value and the
  // sheet here: the row has no cell to be blank and no note of its own to
  // recognise.
  const dated = fill.some((cell) => cell.field === 'End');
  for (const note of fill.filter((cell) => cell.field === 'Note')) {
    if (dated) refuse(`${note.address} (Note): a row created with an end date may not also carry a watch note.`);
    checkWatchedNote(`${note.address} (Note)`, note.value, ctx.serialCeiling);
  }
};

const checkSeasonInsert = (insert: RowInsert, ctx: GuardContext): void => {
  const where = `row ${insert.row + 1} (${insert.title} S${insert.season})`;
  // A season row is one row, and `spanRows` is what the budget counts, VERIFY
  // inspects and a rollback deletes. Stated here rather than left to the
  // literal type: the plan reaches the guard as data, and a span the plan
  // called one row while filling two would be verified over one and rolled
  // back over one, leaving the other standing.
  if (insert.rows !== 1) refuse(`${where}: a season insert is one row, never ${insert.rows}.`);
  const block = checkInsertPlacement(insert, where, ctx);

  for (const cell of insert.fill) {
    if (cell.row !== insert.row) refuse(`${cell.address}: an insert may only fill the row it creates.`);
    if (cell.previous !== undefined) refuse(`${cell.address}: a new row cannot have a previous value.`);
  }

  checkSeasonRowFill(insert.fill, block, ctx);
};

// --- The block insert --------------------------------------------------------

/**
 * What a new show row may carry: every column on the tab except the runtime,
 * which is blank on all 309 show rows — the episode length belongs to a season.
 *
 * This module's own spec, never derived from what the planner emits: derived,
 * one bad emission would widen both at once. Same reason the two insert
 * whitelists above are two.
 */
const BLOCK_SHOW_FIELDS = new Set<ShowField>([
  'Show',
  'Franchise',
  'Type',
  'id',
  'Status',
  'Genre',
  'Genres',
  'Network',
  'Certificate',
  'Banner',
  ...ROLLUP_FIELDS,
]);

/** A block is filled, never cleared, so an absent value there is a planner that lost one. */
const EMPTIABLE_BLOCK = new Set<ShowField>();

/**
 * The cells a show row cannot be created without. A block missing its `id` is
 * one the sync inserts again on every poll; missing a roll-up, it is a block
 * whose totals are blank for good, since nothing revisits a show row.
 */
const BLOCK_REQUIRED: readonly ShowField[] = ['Show', 'Franchise', 'Type', 'id', ...ROLLUP_FIELDS];

const isRollup = (field: ShowField): field is RollupField => (ROLLUP_FIELDS as readonly ShowField[]).includes(field);

/**
 * Whether the cell is a formula rather than a value — the five roll-ups and the
 * artwork link, and nothing else on a show row.
 *
 * The single exception to never writing a formula, and the reason it is safe:
 * this batch writes the formula that does the rolling up, at the row it is
 * being written to, and nothing revisits the cell afterwards. So each is
 * checked against the template for *that* row rather than let through
 * `checkCellShape`, which refuses a formula unconditionally.
 *
 * A predicate rather than a `Set`, because the answer has to narrow: it is what
 * lets `templateFor` take a parameter whose null can only mean "no bucket".
 */
const isTemplate = (field: ShowField): field is RollupField | 'Banner' => isRollup(field) || field === 'Banner';

/**
 * The exact text a template cell must hold, or null for a `Banner` with no
 * bucket to link into — which is the only thing null can mean here, because
 * the parameter admits nothing else. Widened to `ShowField` it would also mean
 * "not a template field at all", and the one caller's refusal would then read
 * an unrelated field as a missing bucket.
 */
const templateFor = (field: RollupField | 'Banner', row: number, ctx: GuardContext): string | null =>
  isRollup(field) ? showRowFormulas(ctx.grid.columns, row)[field]
  : ctx.showBucket !== null ? artworkFormula(ctx.grid.columns.Show, row, ctx.showBucket)
  : null;

const checkTemplateCell = (cell: BlockCell & { field: RollupField | 'Banner' }, where: string, ctx: GuardContext): void => {
  // A link with no bucket behind it is a broken image for the life of the row,
  // and the row is never revisited to fix it.
  const expected = templateFor(cell.field, cell.row, ctx);
  if (expected === null) refuse(`${where}: an artwork link cannot be written with no artwork bucket configured.`);
  // Byte-equal, and *only* a formula: the four cells that read the block-height
  // helper name it by its resolved column letter, so a template built against a
  // different header map counts a block's height off whatever column now sits
  // there, and every total on the row is quietly wrong for its whole life.
  const value = cell.value;
  if (value?.formulaValue !== expected || Object.keys(value).length !== 1) {
    refuse(`${where}: ${describeValue(value)} is not the roll-up formula this row takes.`);
  }
};

/** The vocabulary and bound each show-row column accepts, in one place per field. */
const checkShowValue = (cell: BlockCell, value: ExtendedValue, where: string, insert: BlockInsert): void => {
  const text = value.stringValue;
  switch (cell.field) {
    case 'Show':
      // Against the insert's own title, not the upstream's: the title decides
      // the collision test and the franchise below it, so a cell holding
      // anything else is a row filed under a name the placement never saw.
      if (typeof text !== 'string' || !text.trim()) refuse(`${where}: a show row must carry a title.`);
      if (text !== insert.title) refuse(`${where}: the title cell says ${describeValue(value)} but the block is for ${insert.title}.`);
      return;
    case 'Franchise':
      if (typeof text !== 'string' || !text.trim()) refuse(`${where}: a show row must carry a franchise.`);
      if (text !== insert.franchise) refuse(`${where}: the franchise cell says ${describeValue(value)} but the block was placed under ${insert.franchise}.`);
      return;
    case 'Type':
      // Only `show` is ever inserted: an anime block uses the cour model, where
      // a new cour is a separate SIMKL title.
      if (text !== SHOW_TYPE) refuse(`${where}: ${describeValue(value)} is not ${SHOW_TYPE}.`);
      return;
    case 'id':
      // Text, matching all 189 show rows. A number here compares unequal to
      // every other id cell, so a later run would not recognise its own block.
      if (typeof text !== 'string' || !/^\d+$/.test(text)) refuse(`${where}: id must be the SIMKL id as text.`);
      if (text !== String(insert.id)) refuse(`${where}: the id cell says ${describeValue(value)} but the block is for ${insert.id}.`);
      return;
    case 'Status':
      checkStatusEdit(value, where);
      // Closed set, unlike an edit's: a row created outside the five values the
      // tab holds colours as nothing, and no later poll revisits an inserted
      // block to correct it.
      if (!isStatus(text as string)) refuse(`${where}: ${describeValue(value)} is not a status this tab holds.`);
      return;
    case 'Certificate':
      if (value.numberValue === undefined || !isCertificate(value.numberValue)) {
        refuse(`${where}: ${describeValue(value)} is not a BBFC certificate age.`);
      }
      return;
    case 'Genre':
      if (typeof text !== 'string' || !isGenre(text)) refuse(`${where}: ${describeValue(value)} is not one of the genres the renderer colours.`);
      return;
    case 'Genres': {
      const list = value.stringValue;
      if (typeof list !== 'string') refuse(`${where}: Genres must be text.`);
      const problem = genreListProblem(list);
      if (problem !== null) refuse(`${where}: ${problem}.`);
      return;
    }
    case 'Network':
      // Non-empty text and nothing more: the vocabulary is open — 76 distinct
      // networks across the tab — so a closed set would refuse a real one.
      if (typeof text !== 'string' || !text.trim()) refuse(`${where}: Network must be non-empty text.`);
      return;
    default:
      // Every roll-up and `Banner` went through `checkTemplateCell`, and
      // nothing else is in `BLOCK_SHOW_FIELDS`.
      refuse(`${where}: not a field a new show row carries a value for.`);
  }
};

const checkShowRowCell = (cell: BlockCell, where: string, insert: BlockInsert, ctx: GuardContext): void => {
  if (!BLOCK_SHOW_FIELDS.has(cell.field)) refuse(`${where}: not a field a new show row may carry.`);
  if (isTemplate(cell.field)) {
    // The position rule on its own, because these cells skip `checkCellShape`
    // — a template built against a different header map counts a block's
    // height off whatever column now sits there.
    checkCellPosition(cell, ctx.grid.fields, refuse);
    checkTemplateCell({ ...cell, field: cell.field }, where, ctx);
    return;
  }
  const value = checkCellShape(cell, { allowed: BLOCK_SHOW_FIELDS, emptiable: EMPTIABLE_BLOCK, columns: ctx.grid.fields }, refuse);
  if (value !== undefined) checkShowValue(cell, value, where, insert);
};

/**
 * What the season row under a new show row is asked that an ordinary inserted
 * season row is not: the column vocabulary in this tab's own words, and that
 * the row is for the season the block was built for. Everything else about it
 * is `checkSeasonRowFill`, the one checklist both inserts run — it is the same
 * row, written by the same planner code, and a block that could fill columns a
 * season insert cannot would be a second write surface with no reason to exist.
 */
const checkBlockSeasonCell = (cell: BlockCell, where: string, insert: BlockInsert): void => {
  // `id` is not in `INSERT_FIELDS`, which is what stops the season row carrying
  // one: it inherits the show row's, and an id of its own would make its season
  // number the entry's rather than the block's.
  if (!isHeaderName(cell.field) || !INSERT_FIELDS.has(cell.field)) refuse(`${where}: not a field a new season row may carry.`);

  if (cell.field === 'Season') {
    const season = cell.value?.numberValue;
    if (season === undefined || !Number.isInteger(season) || season < 1) refuse(`${where}: only whole numbered seasons may be inserted.`);
    if (season !== insert.season) refuse(`${where}: the season cell says ${season} but the block is for S${insert.season}.`);
  }
};

/**
 * A whole block: a show row and the first season row under it.
 *
 * The checklist is longer than the season insert's because there is more that
 * cannot be taken back. Every cell on a show row is written once and revisited
 * by nothing, and the row's placement decides the order of the whole tab — so
 * the guard re-derives the placement from the grid rather than trusting the
 * index the plan carries.
 */
const checkBlockInsert = (insert: BlockInsert, ctx: GuardContext): void => {
  const { grid } = ctx;
  const where = `rows ${insert.row + 1}-${insert.row + insert.rows} (${insert.title} S${insert.season})`;
  // Which row a cell landed on decides every rule that applies to it, so the
  // split is made once. A cell on neither row is in neither list and is
  // refused by the bounds check in the routing loop below.
  const showFill = insert.fill.filter((cell) => cell.row === insert.row);
  const seasonFill = insert.fill.filter((cell) => cell.row === insert.row + 1);

  // A show row with no season under it is a block whose roll-ups count the
  // *next* block's rows as their own, and a season row with no show row above
  // it joins whichever block it landed under.
  if (insert.rows !== 2) refuse(`${where}: a block is a show row and one season row, never ${insert.rows}.`);
  // Above the header there is no block at all, and the header row is not one
  // the sync may push down.
  if (insert.row < 1) refuse(`${where}: a block cannot be inserted at or above the header row.`);
  // `rowCount` is a count, so the last usable 0-based index is one below it.
  if (insert.row + insert.rows > grid.snapshot.rowCount) {
    refuse(`${where}: the tab declares only ${grid.snapshot.rowCount} rows, so there is no room for a block.`);
  }

  // Between two blocks, never inside one: a row landing mid-block splits it,
  // and every roll-up above the split silently starts counting the wrong rows.
  if (!grid.blocks.some((block) => block.row === insert.row || blockEnd(block) + 1 === insert.row)) {
    refuse(`${where}: row ${insert.row + 1} is inside a block rather than between two.`);
  }
  // `inheritFromBefore` takes formats from the row above, and a show row's
  // render a correct date serial as `46265`.
  if (!ctx.seasonRows.has(insert.row - 1)) refuse(`${where}: no season row above the insertion point to inherit formats from.`);
  // The placement itself, re-derived: the tab is in Franchise order, and a
  // block in the wrong place is a tab that no longer sorts.
  const placed = placeBlock(grid.blocks, insert.franchise);
  if (placed !== insert.row) refuse(`${where}: Franchise order puts ${insert.franchise} at row ${(placed ?? -1) + 1}, not ${insert.row + 1}.`);

  // Two ways the tab already holds this show, and both would be a duplicate
  // block: the id somewhere on the grid, or a block under the same title key.
  if (gridIds(grid).has(insert.id)) refuse(`${where}: SIMKL id ${insert.id} is already on the tab.`);
  const key = titleKey(insert.title);
  const holder = grid.blocks.find((block) => titleKey(block.title) === key);
  if (holder) refuse(`${where}: row ${holder.row + 1} already holds ${holder.title}.`);

  for (const cell of insert.fill) {
    const cellWhere = `${cell.address} (${SHOW_FIELD_LABELS[cell.field]})`;
    if (cell.row !== insert.row && cell.row !== insert.row + 1) refuse(`${cellWhere}: a block may only fill the two rows it creates.`);
    if (cell.previous !== undefined) refuse(`${cellWhere}: a new row cannot have a previous value.`);
    if (cell.row === insert.row) checkShowRowCell(cell, cellWhere, insert, ctx);
    else checkBlockSeasonCell(cell, cellWhere, insert);
  }

  // Per row, not per block: `Season` on the season row and `Start` on the show
  // row are the same field id at two different columns, and counted together
  // the second would read as a repeat of the first.
  for (const [row, fill] of [[insert.row, showFill], [insert.row + 1, seasonFill]] as const) {
    const fields = fill.map((cell) => cell.field);
    const duplicated = fields.find((field, i) => fields.indexOf(field) !== i);
    if (duplicated) refuse(`${where}: ${SHOW_FIELD_LABELS[duplicated]} is filled twice on row ${row + 1}.`);
  }

  const filled = new Set(showFill.map((cell) => cell.field));
  for (const field of BLOCK_REQUIRED) {
    if (!filled.has(field)) refuse(`${where}: a show row must carry ${SHOW_FIELD_LABELS[field]}.`);
  }

  if (!seasonFill.some((cell) => cell.field === 'Season')) refuse(`${where}: a block must carry the season row it was built for.`);

  // The runtime's scope, re-derived from the **planned show row**: the block is
  // not in the grid yet, so `runtimeScopeOk` has nothing to read. The two facts
  // it asks for are both on the fill — the type this row will carry, and
  // whether it carries an id at all — and reading them off the plan is what
  // makes the same rule answerable a row before the row exists.
  const planned: Pick<ShowBlock, 'type' | 'ids'> = {
    type: showFill.find((cell) => cell.field === 'Type')?.value?.stringValue?.toLowerCase() ?? null,
    ids: parseIds({ userEnteredValue: showFill.find((cell) => cell.field === 'id')?.value }),
  };
  checkSeasonRowFill(seasonFill, planned, ctx);
};

const checkInsert = (insert: Insert, ctx: GuardContext): void => {
  if (insert.kind === 'block') checkBlockInsert(insert, ctx);
  else checkSeasonInsert(insert, ctx);
};

export const assertPlanSafe = (
  plan: SheetPlan,
  grid: Grid,
  {
    maxEdits = config.sheetMaxEdits,
    maxRows = config.sheetMaxRows,
    spent = { edits: 0, rows: 0 },
    now = Temporal.Now.instant(),
    timezone = config.timezone,
    showBucket = showArtworkBucket(config),
  }: SafetyLimits = {},
): void => {
  const ctx: GuardContext = {
    grid,
    serialCeiling: maxSerial(now, timezone),
    showBucket,
    showRows: new Set(grid.blocks.map((b) => b.row)),
    seasonRows: new Map(grid.blocks.flatMap((b) => b.seasons.map((s) => [s.row, { season: s, block: b }] as const))),
  };

  checkBudgets(plan, { maxEdits, maxRows, spent }, refuse);
  for (const cell of plan.edits) checkEdit(cell, plan, ctx);
  if (plan.insert) checkInsert(plan.insert, ctx);
};
