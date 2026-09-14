/**
 * PLAN — grid + library + catalogue → a plan, plus what it still needs. Pure,
 * and **never throws**: an unresolvable row becomes a skip with a reason. The
 * sync calls this from a path that must degrade rather than fail.
 *
 * The one planner, run to a fixpoint. Where a decision needs data the
 * catalogue does not hold, the planner emits a *demand* and plans the row
 * conservatively for this pass; the sync fetches, folds, and re-plans. What to
 * fetch and what to write are one computation, so they cannot disagree: a
 * separate what-to-fetch pass would have to mirror every rule here, and any
 * gap strands a row — demanded and never written, or waiting on a lookup
 * nothing requests.
 *
 * The write surface is six columns — a season row's `Episode`, its `Start` and
 * `End` dates, its runtime and its `Note` (when it was last watched), plus a
 * show row's `Status` — and inserting a season row. Everything else is
 * hand-maintained or a formula that rolls up by itself.
 *
 * `Start` and `End` are the two that **follow SIMKL**: written whenever what
 * SIMKL says has moved away from what the baseline recorded, on a dated row as
 * well as an open one. Every other write compares against the sheet cell, which
 * is the right comparison for it — a count and a watch note are facts about
 * their own row, while a start and an end date are facts about SIMKL, and only
 * a record of what SIMKL last said can tell a change from a standing
 * disagreement. See `followUpstream`.
 */

import { config, showArtworkBucket, tmdbConfigured, tvdbConfigured } from '../shared/config.ts';
import {
  a1,
  BLOCK_HEADERS,
  duplicateIds,
  idsFor,
  isBlank,
  isFormula,
  numberOf,
  runtimeScopeOk,
  SHOW_FIELD_LABELS,
  SHOW_LABELS,
  usesCourModel,
  type Grid,
  type HeaderName,
  type SeasonRow,
  type ShowBlock,
  type ShowField,
} from './2-grid.ts';
import { courComplete, type SeasonProgress, type TitleProgress } from './1-index.ts';
import {
  artworkFormula,
  bank,
  blockEnd,
  forget,
  BLOCK_SCAN_ROWS,
  franchiseKeyFor,
  genresCell,
  MAX_SECONDARY_GENRES,
  maxSerial,
  NOT_HELD,
  ownsNote,
  placeBlock,
  plausibleSerial,
  recordedCount,
  recordedSerial,
  ROLLUP_FIELDS,
  runtimeMinutes,
  seasonKey,
  showRowFormulas,
  SHOW_TYPE,
  titleCell,
  titleKey,
  titleRecordKey,
  TRACKED_FIELDS,
  watchedNote,
  watchedNoteSerial,
  watchSerial,
  withdraw,
} from './values.ts';
import type { Baseline, Forgetting, Recording, TrackedField } from './values.ts';
import { instantFrom, isoOf, later } from '../shared/dates.ts';
import { detailAnswered, seasonAired, seasonComplete, type FactsCredential, type SeasonShape, type TitleCatalogue } from './3-catalogue.ts';
import type { RuntimeRequest } from './io/runtimes.ts';
import type { CatalogueRequest } from './io/catalogue.ts';
import type { SeriesRequest } from './io/tvdb-series.ts';
import type { CertificateRequest } from './io/tmdb-tv.ts';
// The budget arithmetic, not a guard rule: the planner stops short of exactly
// the bound the guard refuses at, and a second copy of the counting is a plan
// refused whole over rows the planner thought it had room for.
import { admitPlan, admitTier, rowsRemaining, type Rationed } from './guard-core.ts';
import type { CellData, ExtendedValue } from '../api/google/types.ts';

// --- The plan's shapes ------------------------------------------------------

export interface CellEdit {
  /** Zero-based, in the snapshot the plan was built from. */
  row: number;
  column: number;
  field: HeaderName;
  /** The snapshot's `userEnteredValue`, for the guard and the rollback. */
  previous: ExtendedValue | undefined;
  /**
   * Absent empties the cell — the same encoding `writeCell` already uses to
   * undo an inserted value, and the only one that leaves a cell a later read
   * calls blank. Writing an empty string instead would leave the cell holding
   * something, and how Sheets echoes such a write decides whether VERIFY
   * recognises its own edit.
   */
  value: ExtendedValue | undefined;
  /** A1 for the report. Never sent — writes are index-based. */
  address: string;
  note: string;
}

export interface RowInsert {
  /**
   * What the plan's one insert slot holds. A consumer that has to branch reads
   * this rather than inferring the shape from the span's height, which says
   * how tall an insert is and never what it is.
   */
  kind: 'season';
  /** Where the new row lands. Rows at and below this index shift down by one. */
  row: number;
  /** One row: a season row joins a block that already exists. */
  rows: 1;
  title: string;
  season: number;
  /**
   * Whether the row lands in a state a later poll still has to finish —
   * `seasonCells`' `open`: a blank runtime cell something can still reach, or
   * a complete season the fill could not date.
   *
   * Read where the count is banked, and nowhere else. A row that lands finished
   * banks its count; a row that lands waiting withdraws it, because a
   * record-scoped row leaves scope the moment its count is recorded and the poll
   * that could close it would never look at the row again.
   */
  waiting: boolean;
  /** Cells written into the new row. It has no `previous` — it did not exist. */
  fill: CellEdit[];
  note: string;
}

/**
 * One cell of a new show row. A block writes six columns no season row has, so
 * its fill is keyed on `ShowField` rather than `HeaderName` — the same cell in
 * every other respect, which is what `Omit` states: a second shape here would
 * be a second thing BUILD and VERIFY have to read.
 */
export type BlockCell = Omit<CellEdit, 'field'> & { field: ShowField };

/**
 * A whole block: a show row and every season row the title needs, created
 * together.
 *
 * Together, and never in two runs. A show row alone is a block with no
 * seasons, whose roll-up formulas count the *next* block's rows as their own;
 * a season row alone joins whichever block sits above it. Neither is a state
 * the sheet can be left in for a poll.
 */
export interface BlockInsert {
  kind: 'block';
  /** The show row. Rows at and below this index shift down by the span's height. */
  row: number;
  /** The SIMKL id the show row's `id` cell carries — what every later run matches the block by. */
  id: number;
  /** What the `Show` cell is written with, so the guard re-derives against the value rather than the upstream. */
  title: string;
  /** What the `Franchise` cell is written with, and the key placement was decided on. */
  franchise: string;
  /**
   * Every season a row is created for, ascending, one per row after the show
   * row — and the whole of what the span is. The height is `1 + seasons.length`
   * wherever a height is wanted, never a field beside this one: carried twice, a
   * span could claim a height its season list does not have, and BUILD would
   * insert rows the guard never checked and VERIFY never inspected.
   *
   * Never empty, and never a row a run: a show row alone is a block whose
   * roll-up formulas count the *next* block's rows as their own, and a title
   * whose seasons arrived over several polls would have spent every one of those
   * polls in that state. A span is contiguous and applies as a single request,
   * so nothing shifts underneath it.
   */
  seasons: number[];
  /**
   * Which of those seasons landed on a row a later poll still has to finish —
   * `seasonCells`' `open`, per row.
   *
   * The same rule the season insert follows, stated per row because a block's
   * rows do not all answer the same: one season's runtime can be in hand while
   * the next is still out. Only these have their counts withdrawn.
   */
  waiting: number[];
  /** Cells on every row of the span. It has no `previous` — none of the rows existed. */
  fill: BlockCell[];
  note: string;
}

/**
 * The plan's one insert slot. A consumer that has to branch reads `kind`
 * rather than inferring the shape from the span's height, which says how tall
 * an insert is and never what it is.
 */
export type Insert = RowInsert | BlockInsert;

/**
 * The span an insert occupies, which is what BUILD writes, the budget counts
 * and VERIFY inspects.
 *
 * One derivation of a block's height, from the one field that says how many rows
 * it has. Every consumer downstream is structural over `{ row, rows, fill }` —
 * three modules that name no field of this union — so this is where the shape
 * they read is made.
 */
export const insertSpan = (insert: Insert): InsertSpan =>
  insert.kind === 'season' ? insert : { row: insert.row, rows: 1 + insert.seasons.length, fill: insert.fill };

/** One contiguous span of new rows and the cells that fill them. */
export interface InsertSpan {
  row: number;
  rows: number;
  fill: readonly (CellEdit | BlockCell)[];
}

/** The season a report names an insert by: its only one, or the first of the block's. */
export const insertSeason = (insert: Insert): number => (insert.kind === 'season' ? insert.season : (insert.seasons[0] as number));

/**
 * A plan as the writes it is, for BUILD, the budget and VERIFY.
 *
 * The cells go through whole rather than narrowed: VERIFY reads a `previous` off
 * each one and BUILD reads only where the value goes, so what satisfies both is
 * the cell itself.
 */
export const planWrites = (plan: SheetPlan): { edits: readonly CellEdit[]; insert: InsertSpan | null } => ({
  edits: plan.edits,
  insert: plan.insert === null ? null : insertSpan(plan.insert),
});

/**
 * How many lookups one **attempt** may make of each upstream a block's show row
 * waits on: TVDB's genres, TMDB's certificate, and TVDB's season runtimes.
 *
 * Only one row is inserted per run, so a larger burst buys nothing: what it
 * buys is a cold start on a full library issuing one request per unlisted
 * title — several hundred — inside a run whose snapshot goes stale at 120s,
 * and doing it again after every restart, since the store is process-local. A
 * handful covers the settled and unanswerable titles queued ahead of the next
 * insertable one; the rest arrive on later polls, which is the rate rows land
 * at anyway.
 *
 * It also bounds what a standing failure costs. A 403 that fails every request
 * — a suspended token, a WAF, a throttle — records nothing, so the same titles
 * are demanded next poll; capped, that is a handful of requests every half
 * hour rather than one per unlisted title.
 *
 * Per **attempt**, not per pass: the sync runs the planner to a fixpoint, and a
 * cap reset on every pass multiplies by the pass ceiling — four times this many
 * requests in one run, which is the burst the number exists to prevent.
 * `LookupBudget` is what carries the count across the passes of one attempt.
 */
export const MAX_LOOKUPS_PER_PASS = 8;

/**
 * How many **titles** one planning pass may ask SIMKL for details of.
 *
 * A different figure and a different period from the three above, because it
 * answers a different question. These asks are what a pass *reads the grid
 * with*: a block in scope is edited from the answer to its own ask in the same
 * run, so a pass that rationed them to a handful would skip rows it was in scope
 * to write. Measured on the live tab, a cold store with 18 recent blocks read 4
 * of them under an allowance of 8 and left the other 14 with "no episode list
 * came back". 32 is sized for a normal day with room to spare, so a pass reads
 * every block it means to write.
 *
 * Per **pass** rather than per attempt, which is what makes a backfill drain
 * rather than stall: a cold store with three hundred blocks in scope asks about
 * 32 a pass, up to the sync's pass ceiling, and the rest arrive on later polls.
 * Bounded either way — the ceiling on one attempt is 32 times that pass limit,
 * not one request per block on the tab.
 *
 * Counted in **titles**, not requests: a live-action block asks twice about the
 * same id, once for its episode list and once for the entry that decides its
 * `Status`, and `fetchCatalogue` merges the two. Counted per request, 18 blocks
 * would spend 36 of the allowance and the figure would mean half what it says.
 */
export const CATALOGUE_ASKS_PER_PASS = 32;

/**
 * What this attempt has already asked for, per upstream — mutable, and the one
 * thing a planning pass carries out of itself.
 *
 * A deliberate exception to this module being pure, and the narrowest one that
 * answers the question: what a pass may ask for depends on what its
 * predecessors asked for, and nothing else the planner returns can say that,
 * because a demand an earlier pass made has since been answered and is no
 * longer in any demand list. Defaulted per call, so a caller that does not
 * thread one gets a fresh budget and this pass's own behaviour.
 *
 * Four allowances rather than one: the four are four upstreams with four
 * credentials, and a single total would let a cold start's details starve the
 * genres of the one block the run can actually insert.
 *
 * `detail` is a set of title ids rather than a count, because its allowance is
 * counted in titles — see `CATALOGUE_ASKS_PER_PASS` — and it is the one the
 * caller clears between passes.
 */
export interface LookupBudget {
  detail: Set<number>;
  genres: number;
  certificates: number;
  runtimes: number;
}

export const emptyLookupBudget = (): LookupBudget => ({ detail: new Set(), genres: 0, certificates: 0, runtimes: 0 });

/**
 * A copy nothing written into reaches the original, for a candidate whose whole
 * plan may be dropped: an allowance charged for an ask nobody made is an ask the
 * next candidate cannot make. The set is rebuilt rather than spread, which a
 * shallow copy would share by reference.
 */
const copyLookupBudget = (budget: LookupBudget): LookupBudget => ({ ...budget, detail: new Set(budget.detail) });

/**
 * Start a pass with a fresh catalogue allowance, keeping what the attempt has
 * already spent on the three per-attempt upstreams. See
 * `CATALOGUE_ASKS_PER_PASS` for why the two periods differ.
 */
export const nextPass = (budget: LookupBudget): void => {
  budget.detail = new Set();
};

/**
 * Why a row was deliberately left alone. `code` is what a test or a grouping
 * asserts on; `message` names the row for a human.
 */
export type SkipCode =
  | 'duplicate-id'
  | 'unknown-id'
  | 'ambiguous-cour'
  | 'duplicate-season'
  | 'non-numeric-count'
  | 'unusable-timestamp'
  | 'season-fragment'
  | 'awaiting-runtimes'
  | 'awaiting-lookup'
  | 'unlinked-block'
  | 'no-episode-list'
  | 'no-format-row'
  | 'no-room';

export interface Skip {
  code: SkipCode;
  message: string;
}

export interface SheetPlan {
  edits: CellEdit[];
  /**
   * At most one insert per run, carried by the type: plan indices are
   * pre-write but `insertDimension` applies cumulatively, so a second insert
   * would land a row above where it was planned — and `verify` makes the same
   * unshifted assumption. One insert may still span more than one row, which
   * `rows` carries; a span is contiguous and applies as a single request, so
   * nothing shifts underneath it.
   */
  insert: Insert | null;
  /** Rows deliberately left alone, with the reason. Reported, never acted on. */
  skips: Skip[];
  /** Everything else worth a human's attention — new shows, new cours. */
  notes: string[];
  /**
   * Work this run could have done and rationed: a row ready to add that did not
   * fit under the one-per-run rule, a season waiting behind the one inserted, a
   * row whose count moved that the poll's budget had no room for.
   *
   * One number, because every consumer asks it one question — *is there work
   * only another poll will drain* — and answers it the same way whatever the
   * shape of the work. The report is where the shapes are told apart: each kind
   * writes its own note, naming the row or the budget that held it.
   */
  deferred: number;
}

export const emptyPlan = (): SheetPlan => ({ edits: [], insert: null, skips: [], notes: [], deferred: 0 });

/**
 * Oldest first, a title with no watch date last, and `tie` to settle two
 * watched the same day — both halves order their insert candidates this way, so
 * the sheet gains rows in the order the titles were started.
 *
 * The tie-break is not decoration. One row is added per run, so the comparator
 * decides which title that is, and two watched the same evening would otherwise
 * be ordered by whatever `Map` iteration gave: the pair would swap between
 * polls, and each poll would add whichever the sort happened to put first.
 */
export const compareWatched = (a: Temporal.Instant | null, b: Temporal.Instant | null, tie: number): number => {
  if (a === null || b === null) return (a === null ? 1 : 0) - (b === null ? 1 : 0) || tie;
  return Temporal.Instant.compare(a, b) || tie;
};

/** What the planner could not decide without: fetch these and re-plan. */
export interface PlanDemands {
  catalogue: CatalogueRequest[];
  runtimes: RuntimeRequest[];
  /**
   * TVDB series whose genre list a new block is waiting on, and TMDB series
   * whose certificate it is. Two lists rather than one because they are two
   * upstreams with two credentials and two join keys; a block needs both, so a
   * single list could not say which half came back.
   *
   * Every one of the four lists is written only by `demand` and capped through
   * `LookupBudget` — these two and `runtimes` at `MAX_LOOKUPS_PER_PASS` for the
   * attempt, `catalogue` at `CATALOGUE_ASKS_PER_PASS` titles for the pass. These
   * two empty once every block candidate is answered, settled-with-nothing
   * included. What is *not* charged is an ask the store has already answered —
   * `sync.ts` drops those inside `CATALOGUE_MAX_AGE` anyway, and counting them
   * would let a handful of settled titles spend the whole allowance on every
   * pass.
   */
  genres: SeriesRequest[];
  certificates: CertificateRequest[];
}

export interface PlanResult {
  plan: SheetPlan;
  demands: PlanDemands;
  /**
   * Tracked values this pass saw that it is **not** writing: first sightings,
   * unmoved values, and moves it declined. Safe to record whatever becomes of
   * the run, because recording them changes nothing that was going to happen.
   */
  observed: Baseline;
  /**
   * Tracked values this pass planned an edit for, recordable only once that
   * edit lands.
   *
   * Kept apart from `observed` rather than filtered out of it afterwards,
   * because the two are decided together in one place and so cannot come to
   * disagree. Recording one of these early is the failure this whole mechanism
   * has to avoid: the next poll would compare against the new value, find
   * nothing moved, and the change would be lost for good — the same reason the
   * library watermark advances only after the call that consumed it returns.
   */
  writing: Baseline;
  /**
   * Fields this pass is taking out of the record itself, which neither map
   * above can express: a row the activity window put in scope and the budget
   * held back, whose stored count already agrees with SIMKL's. Persisted on
   * every outcome, like `observed` — the deferral happened whatever became of
   * the batch. See `forget` in `values.ts`.
   */
  forgetting: Forgetting;
}

export interface PlanOptions {
  now?: Temporal.Instant;
  timezone?: string;
  sinceDays?: number;
  /**
   * What SIMKL last said, from `io/baseline.ts`. Absent for a key means it has
   * not been observed, so it is recorded and nothing is written — which is what
   * confines this to changes from now on rather than a reconciliation of every
   * disagreement the sheet already holds.
   */
  baseline?: Baseline;
  /**
   * Whether the record holds a title entry at all — what `titleIsNew` needs
   * beyond a per-title lookup, and the one question about the baseline no
   * lookup answers.
   *
   * Counted once a run rather than per pass or per title: it is a scan of the
   * whole file, it cannot change while a run is in flight, and every pass of
   * the plan-fetch fixpoint would otherwise rescan it. False by default, which
   * is the safe answer — nothing is new, so a caller that forgets to count
   * builds no block rather than one per title in the library.
   */
  anyTitleRecorded?: boolean;
  /**
   * `observeWatches(index)`, hoisted. It is a projection of the library alone,
   * and the library cannot change while a run is in flight — so the sync builds
   * it once rather than paying for it on every pass of the plan-fetch fixpoint.
   * Defaulted so the function stays self-sufficient.
   */
  starts?: Baseline;
  /**
   * Ids the missing-row note stays quiet about: the anime films, which the
   * films half places on its own tab.
   *
   * A set rather than a flag on `TitleProgress`, which is type-blind by
   * construction — both halves' indexes are built from the same records, and
   * which tab a title belongs on is not a fact about the title.
   */
  filed?: Set<number>;
  /**
   * The bucket a new show row's `Artwork` formula links into, or null, where
   * the cell is left out entirely. Null covers an install with no artwork
   * bucket *and* one whose bucket is named while the artwork page is not
   * served — only a served page can put an object behind the link, and
   * `showArtworkBucket` in `shared/config.ts` is that rule.
   *
   * Null rather than a missing cell decided downstream: the column is written
   * once and never revisited, so a link nothing can put an object behind is a
   * broken image for the life of the row — the same rule the films insert's
   * banner follows.
   */
  showBucket?: string | null;
  /**
   * Whether each show-facts credential is set. A block needs both — TVDB for
   * its genres, TMDB for its certificate — and without one it is not inserted
   * at all rather than inserted with the cell blank: those cells are written
   * once, and a blank one reads as a series with no genre rather than as an
   * install with no key. Gating rather than degrading, the films rule.
   */
  facts?: { tvdb: boolean; tmdb: boolean };
  /**
   * Which credentials an upstream has rejected this process.
   * `CatalogueStore.factsRejected` — a fact about the token, not about any
   * series, so no block is settled and no further lookup is asked for. Every
   * one of them, because the note has to name every key a restart needs fixed.
   */
  factsRejected?: ReadonlySet<FactsCredential>;
  /**
   * The block walk's lookup allowance for this attempt, shared across the
   * passes of the plan-fetch fixpoint. A fresh one per call by default, which
   * is the behaviour of a caller planning once.
   */
  lookupBudget?: LookupBudget;
  /**
   * What the **poll** has left of each budget, not what the config allows: the
   * ceiling minus whatever an earlier half already sent. `SHEET_MAX_EDITS` and
   * `SHEET_MAX_ROWS` are a blast radius for one poll, so a planner reading the
   * config figure would let two halves write twice it while each reported itself
   * inside budget.
   *
   * Read here so the planner can stop short of them rather than be refused at
   * them. A refusal is whole-plan and a record-scoped backlog has no window to
   * age out of, so a plan over budget is one refused on every poll for ever.
   * Held back instead, the same rows land a budget at a time.
   *
   * The show half runs first today, so what it sees is usually the whole
   * ceiling — which is exactly why it is passed rather than defaulted: nothing
   * here may depend on the order the driver runs the halves in.
   */
  maxEdits?: number;
  maxRows?: number;
}

const cellAt = (grid: Grid, row: number, column: number): CellData | undefined => grid.snapshot.rows[row]?.[column];

const num = (numberValue: number): ExtendedValue => ({ numberValue });
const str = (stringValue: string): ExtendedValue => ({ stringValue });

const edit = (grid: Grid, row: number, field: HeaderName, value: ExtendedValue | undefined, note: string): CellEdit => {
  const column = grid.columns[field];
  return { row, column, field, previous: cellAt(grid, row, column)?.userEnteredValue, value, address: a1(row, column), note };
};

/**
 * A cell on a row that does not exist yet, or null where the tab carries no
 * column for the field — which only the six optional ones can be, and which
 * every caller drops rather than writing a cell at no address.
 *
 * Never `edit`: the row is created by the same batch, so reading a `previous`
 * off the snapshot would read whatever currently sits at that index — a real
 * cell of a different row.
 */
const fillCell = <F extends ShowField>(
  grid: Grid,
  row: number,
  field: F,
  value: ExtendedValue,
  note: string,
): (Omit<CellEdit, 'field'> & { field: F }) | null => {
  const column = grid.fields[field];
  return column === undefined ? null : { row, column, field, previous: undefined, value, address: a1(row, column), note };
};

// --- Eligibility -----------------------------------------------------------

/**
 * Every SIMKL id claimed anywhere in a block. Used only to ask "has anything
 * happened here recently", so a plain max is right.
 */
const blockIds = (block: ShowBlock): number[] => [...new Set([...block.ids, ...block.seasons.flatMap((s) => s.ids)])];

/**
 * Every SIMKL id the grid holds anywhere — show rows and season rows alike.
 *
 * The same reading of a block `planSync` uses for `onGrid`, exported so the films
 * half's placement rule asks this question exactly once rather than keeping a
 * second copy of what counts as "on the show tab".
 */
export const gridIds = (grid: Grid): Set<number> => new Set(grid.blocks.flatMap(blockIds));

const latestOf = (progresses: TitleProgress[]): Temporal.Instant | null =>
  progresses.reduce<Temporal.Instant | null>((latest, p) => later(latest, p.lastWatchedAt), null);

const within = (at: Temporal.Instant | null, cutoff: Temporal.Instant): boolean =>
  at !== null && Temporal.Instant.compare(at, cutoff) >= 0;

/**
 * The instant before which a watch is out of the activity window's scope.
 *
 * Hours rather than `{ days }`, which an `Instant` refuses: a day is a calendar
 * unit and an instant has no calendar. Also the behaviour wanted — an exact
 * span, so the window does not move by an hour twice a year.
 */
const cutoffFrom = (now: Temporal.Instant, sinceDays: number): Temporal.Instant => now.subtract({ hours: sinceDays * 24 });

/**
 * Has anything in this block been watched recently enough to touch? The cut-off
 * applies uniformly: a dormant sheet produces zero edits, and no run can
 * retro-edit years of history.
 */
const watchedRecently = (ids: number[], index: Map<number, TitleProgress>, cutoff: Temporal.Instant): boolean =>
  within(latestOf(ids.map((id) => index.get(id)).filter((p): p is TitleProgress => p !== undefined)), cutoff);

// --- What this sync last saw SIMKL say -------------------------------------

/**
 * The record, read as the two questions the window cannot answer: has this
 * season's count moved, and has this title's status.
 *
 * A watch timestamp is a date the user set, so it says nothing about *when* a
 * change was made: marking a 2005 show's 87 episodes watched today stamps every
 * one at its air date, two decades outside the window, and a sheet gated on
 * watch dates alone would never learn the show exists. What is recent there is
 * the change, and SIMKL supplies no modification stamp — so the only reading of
 * "changed" with an answer is *different from what this service last recorded*,
 * which is what `io/baseline.ts` holds. That record survives a restart, where a
 * signal held in memory from a delta does not: a full pull carries no news of
 * what moved, so a change made while the process was down would be lost for
 * good.
 *
 * Looked up per question, never projected into maps of its own. The baseline is
 * already keyed exactly as these questions ask — a pass that copied it into two
 * more would have to be rebuilt whenever a withdrawal moved an entry underneath
 * it, and a stale copy answers "nothing moved" for a season the run itself
 * decided to leave for the next one.
 *
 * `anyTitle` is the one fact no single lookup can give, so it is counted once a
 * run and carried: see `PlanOptions.anyTitleRecorded`.
 */
interface Known {
  baseline: Baseline;
  /** Whether the record holds a title entry at all — `anyTitleRecorded`. */
  anyTitle: boolean;
}

/**
 * Whether this sync has ever seen this title.
 *
 * **The key existing is the whole test**, not a field under it. `Status` is the
 * only field a title entry ever carries, so a run that banks a `Status` edit
 * withdraws it and leaves `{}` — and `observed` is recorded on every outcome
 * where `writing` is recorded only on `applied`. Keyed on the field, a report-
 * mode poll that plans one `Status` edit would make its title unseen again, and
 * the next poll would read it as brand new: `titleIsNew`, every uncovered season
 * offered, and a hand-started block back-filled from S1.
 *
 * The one gate that makes the first run of this code silent. An install
 * upgrading into it has a baseline full of `Start` and `End` and not one title
 * entry, so every question below answers "no move" on that run, the whole
 * library is recorded, and the run after it is the first that can see a change
 * — which is the same first-sighting rule the tracked fields have always had.
 */
const titleKnown = (id: number, { baseline }: Known): boolean => baseline.has(titleRecordKey(id));

/**
 * Whether a title has appeared since the last observation: no record of its
 * own, while other titles have one.
 *
 * The second clause is what a fresh install needs — an empty record makes
 * nothing new, so a first poll does not try to build a block for every show in
 * the library — and it is asked of the *title* entries rather than of the file,
 * because a file holding only `Start` and `End` is exactly the install this
 * code has not run on yet.
 */
const titleIsNew = (id: number, known: Known): boolean => known.anyTitle && !titleKnown(id, known);

/**
 * Whether a season's watched count differs from what was recorded for it.
 *
 * Absent on a known title counts as differing, and that single rule answers two
 * questions the sheet asks separately: a season whose count moved, and a season
 * that has appeared since the last observation — `observeWatches` records every
 * watched season of every title in the same pass that records the title, so a
 * known title with an unrecorded season is one that gained it. Derived twice,
 * the two are free to disagree about a season a deferral withdrew.
 *
 * Unknown title is not a move, for the reason `titleKnown` gives.
 */
const countMoved = (id: number, season: number, watched: number, known: Known): boolean =>
  titleKnown(id, known) && recordedCount(known.baseline.get(seasonKey(id, season))?.Watched) !== watched;

/** Whether SIMKL's membership for a title differs from what was recorded. A recorded absence is `NOT_HELD`, so `hold` → none is a move. */
const statusMoved = (progress: TitleProgress, { baseline }: Known): boolean => {
  const was = baseline.get(titleRecordKey(progress.id))?.Status;
  return was !== undefined && was !== (progress.status ?? NOT_HELD);
};

/** Every season of a title the sheet could act on: something watched in it. */
const watchedSeasons = (progress: TitleProgress): SeasonProgress[] => [...progress.seasons.values()].filter((s) => s.watched > 0);

/**
 * Whether the window has reason to look at this block: watched inside it, or
 * changed since this sync last looked.
 *
 * Asked of the library and the record rather than of the rows, because the
 * commonest reason a block is in scope is a season it has *no* row for. A show
 * whose sheet block starts at S5 and whose S1–S4 were recorded long ago is a
 * block every row of which is dormant and which is nonetheless one season
 * behind SIMKL; read off the rows alone it would never be walked and the new
 * season would never land.
 */
const blockRecent = (ids: number[], index: Map<number, TitleProgress>, cutoff: Temporal.Instant, known: Known): boolean => {
  if (watchedRecently(ids, index, cutoff)) return true;
  return ids.some((id) => {
    const progress = index.get(id);
    if (progress === undefined) return false;
    if (statusMoved(progress, known)) return true;
    return watchedSeasons(progress).some((season) => countMoved(id, season.number, season.watched, known));
  });
};

// --- Row resolution --------------------------------------------------------

/**
 * What a season row resolves to. The route depends on **where its id sits**,
 * never on `Type`: a row carrying its own id *is* that SIMKL entry (an anime
 * cour, Doctor Who's 2024 renumbering, Parasyte) and its counters describe
 * the whole season; a row inheriting the show row's id is selected out of a
 * multi-season entry by season number.
 */
type RowResolution =
  | { kind: 'nothing' }
  | { kind: 'skip'; skip: Skip }
  | {
      kind: 'resolved';
      watched: number;
      complete: boolean;
      /**
       * Whether `complete` is an answer at all. A cour row answers from its own
       * counters; a row resolved by number answers from the episode list, and
       * with none in the store `complete` is false the same way it is for a
       * season half watched — which is the one reading a close must not make,
       * since a row recorded as unfinished on a failed lookup leaves scope the
       * moment its count lands.
       */
      settled: boolean;
      lastWatchedAt: Temporal.Instant | null;
      firstWatchedAt: Temporal.Instant | null;
      /**
       * What this row's count is made of, one entry per SIMKL season behind it,
       * keyed the way the record keys it.
       *
       * A list because a split cour is one row over two entries, each with a
       * count of its own: the row's number is their sum, and comparing that sum
       * against either entry's record reads every such row as moved forever.
       * Derived here for the reason `key` is — only this function knows which
       * branch the row took — and it is what a planned `Episode` banks, what a
       * deferred row withdraws, and what "has this row's count moved" is asked
       * of at its one read site.
       */
      counts: SeasonCount[];
      /**
       * How the baseline names this row, or null where nothing can: `(SIMKL
       * id, SIMKL season)`, which is what the index keys the same season under
       * so the two agree. Derived here because only this function knows which
       * branch a row took, and a second derivation elsewhere is how a record
       * comes to describe a different season than the row it was read for.
       */
      key: string | null;
    };

/**
 * One SIMKL season behind a row's count: how the record names it, and the two
 * numbers the record is asked about. Carried whole rather than reduced to a key
 * and an answer, so the question "has this moved" is asked where it is read — a
 * resolution that answered it in advance would answer against the record as it
 * stood before this run's own withdrawals.
 */
interface SeasonCount {
  key: string;
  id: number;
  season: number;
  watched: number;
}

const nothing: RowResolution = { kind: 'nothing' };
const skipped = (code: SkipCode, message: string): RowResolution => ({ kind: 'skip', skip: { code, message } });

const numberedSeasons = (progress: TitleProgress): number[] => [...progress.seasons.keys()];

const watchedIn = (progress: TitleProgress): number =>
  [...progress.seasons.values()].reduce((total, season) => total + season.watched, 0);

const resolveRow = (
  block: ShowBlock,
  season: SeasonRow,
  index: Map<number, TitleProgress>,
  titles: Map<number, TitleCatalogue>,
  duplicates: Set<number>,
): RowResolution => {
  const ids = idsFor(block, season);
  if (!ids.length) return nothing;

  const label = `${block.title} S${season.season ?? '?'} (row ${season.row + 1})`;

  const claimed = ids.filter((id) => duplicates.has(id));
  if (claimed.length) return skipped('duplicate-id', `${label}: id ${claimed.join(', ')} is claimed by more than one row`);

  const progresses = ids.map((id) => index.get(id));
  const missing = ids.filter((_, i) => !progresses[i]);
  // Poisoning the whole row matters: summing a two-id row over one survivor
  // yields half the true count, and monotonicity only blocks decreases — a
  // sheet value below that half would be quietly overwritten with a
  // wrong-but-larger number. The one multi-id failure the guards would not
  // otherwise catch.
  if (missing.length) return skipped('unknown-id', `${label}: SIMKL id ${missing.join(', ')} is in no list`);
  const resolved = progresses as TitleProgress[];

  if (season.ids.length) {
    // A cour entry stands for exactly one season. One reporting several means
    // no rule here can say which of its seasons this row means.
    const multi = resolved.filter((p) => numberedSeasons(p).length > 1);
    if (multi.length) {
      return skipped(
        'ambiguous-cour',
        `${label}: SIMKL entry ${multi.map((p) => p.id).join(', ')} covers ${multi.map((p) => numberedSeasons(p).length).join(', ')} seasons, so the row is ambiguous`,
      );
    }
    // The row's identity, and the one thing about it that must not move as the
    // row grows: a split cour gains its second id only once the first is
    // finished, so the *first* id is the one that was there from the start. A
    // key on the last would change the day a cour was added, orphaning what was
    // recorded and re-reading the whole row as never observed.
    const first = resolved[0] as TitleProgress;
    const number = numberedSeasons(first)[0];
    const last = resolved.at(-1) as TitleProgress;
    const lastNumber = numberedSeasons(last)[0];

    // One entry per cour, each against its own record: the row's count is their
    // sum, and no single entry's record is a thing that sum can be compared to.
    // Nothing watched is left out rather than recorded as zero, the same state
    // `observeWatches` gives such a season — a cour whose id was typed in before
    // it was watched otherwise reads as a row that has moved on every poll.
    const counts = resolved.flatMap((p) => {
      const n = numberedSeasons(p)[0];
      const watched = n === undefined ? 0 : (p.seasons.get(n)?.watched ?? 0);
      return n === undefined || watched === 0 ? [] : [{ key: seasonKey(p.id, n), watched, id: p.id, season: n }];
    });

    return {
      kind: 'resolved',
      // Summed across all ids: a split cour is one row.
      watched: resolved.reduce((total, p) => total + watchedIn(p), 0),
      // Only once *every* id is complete.
      complete: resolved.every((p) => courComplete(p)),
      settled: true,
      // The first cour starts the row, as the last one ends it below.
      firstWatchedAt: number === undefined ? null : (first.seasons.get(number)?.firstWatchedAt ?? null),
      key: number === undefined ? null : seasonKey(first.id, number),
      // The last id ends the row, and the date comes off that id's *season*
      // for the same reason `firstWatchedAt` above does: `TitleProgress.lastWatchedAt`
      // is `item.last_watched_at`, which SIMKL moves to whatever was written
      // last rather than to the latest episode. Re-dating a season's opening
      // episode therefore drags that field back to the opening day, and a row
      // taking `End` from it closes on its own `Start`. Measured on the live
      // library, 3 of 183 cour rows carry the two values apart.
      lastWatchedAt: lastNumber === undefined ? null : (last.seasons.get(lastNumber)?.lastWatchedAt ?? null),
      counts,
    };
  }

  if (season.season === null || !Number.isInteger(season.season)) return nothing;
  const progress = resolved[0] as TitleProgress;
  const watched = progress.seasons.get(season.season);
  if (!watched || watched.watched === 0) return nothing;

  return {
    kind: 'resolved',
    watched: watched.watched,
    complete: seasonComplete(titles.get(progress.id)?.shapes.get(season.season), watched.watched),
    settled: (titles.get(progress.id)?.shapes.size ?? 0) > 0,
    lastWatchedAt: watched.lastWatchedAt,
    firstWatchedAt: watched.firstWatchedAt,
    counts: [{ key: seasonKey(progress.id, season.season), id: progress.id, season: season.season, watched: watched.watched }],
    key: seasonKey(progress.id, season.season),
  };
};

// --- Status ----------------------------------------------------------------

/**
 * Which SIMKL entry decides a block's `Status`.
 *
 * The show row's own id when it has one. For anime it has none, so the latest
 * cour decides: the highest-numbered whole season row carrying an id, and the
 * last id on it.
 */
export const statusSource = (block: ShowBlock): number | null => {
  if (block.ids.length) return block.ids.at(-1) ?? null;
  const latest = block.seasons
    .filter((s) => s.ids.length && s.season !== null && Number.isInteger(s.season))
    .sort((a, b) => (a.season as number) - (b.season as number))
    .at(-1);
  return latest?.ids.at(-1) ?? null;
};

/**
 * The four-branch rule, in order. `null` means "no opinion" — `hold`,
 * `plantowatch` and absent-from-every-list are all *no information*, never a
 * reason to write.
 *
 * `Cancelled` is never produced: SIMKL cannot tell "axed" from "ended". It is
 * freely overwritten once there is recent activity — the one cost is that
 * resuming a cancelled show and finishing it yields `Ended`.
 */
export const deriveStatus = (
  progress: TitleProgress,
  { detailStatus, latestSeasonAiring }: { detailStatus?: string | null; latestSeasonAiring?: boolean } = {},
): string | null => {
  if (progress.status === 'dropped') return 'Abandoned';
  if (progress.status === 'hold' || progress.status === 'plantowatch') return null;

  const airedUnwatched = progress.totalCount - progress.notAiredCount - progress.watchedCount;
  if (airedUnwatched > 0 || latestSeasonAiring) return 'Watching';

  const status = detailStatus?.trim().toLowerCase();
  if (!status) return null;
  if (status === 'ended') return 'Ended';
  // `airing` and `tba` both mean more is coming — exactly Up To Date.
  return 'Up To Date';
};

/**
 * Whether the highest-numbered season SIMKL knows about is part-way through
 * airing — some out, some still to come.
 *
 * `aired > 0` matters. A season with nothing aired yet is an announced future
 * one, and a viewer caught up on everything released is *Up To Date* by the
 * user's definition ("all aired seasons over and watched, a new season coming
 * eventually"), not *Watching* with nothing to watch.
 */
const latestSeasonAiring = (shapes: Map<number, SeasonShape>): boolean => {
  const latest = [...shapes.values()].sort((a, b) => a.number - b.number).at(-1);
  return latest !== undefined && latest.aired > 0 && latest.aired < latest.total;
};

// --- The row a block does not have yet -------------------------------------

/** The season a block would gain a row for, and whether it is already over. */
interface InsertCandidate {
  /** The entry whose progress drives the row. `statusSource`, not `idsFor`. */
  source: TitleProgress;
  season: SeasonProgress;
  /**
   * Finished airing. Decides the *runtime*: episode lengths settle when the
   * last one airs, not when anyone finishes watching.
   */
  aired: boolean;
  /** Finished airing *and* finished being watched. What decides the `End` date. */
  complete: boolean;
}

/**
 * Every whole season a block already has a row for, independent of whether
 * that row resolved: a row the planner declined to read is still a row, and a
 * second row for the same season is the one insert mistake nothing downstream
 * could detect.
 */
const coveredSeasons = (block: ShowBlock): Set<number> =>
  new Set(block.seasons.map((s) => s.season).filter((n): n is number => n !== null && Number.isInteger(n)));

/**
 * Every season a title would gain a row for, out of the library and the record
 * alone: the watched seasons no row covers that either the window reaches or
 * the record says have moved, lowest number first.
 *
 * The second and third clauses are what put a back catalogue on the tab at all.
 * A title marked whole today has one timestamp per episode and none inside the
 * window, so a watch-date gate offers none of its seasons — where `countMoved`
 * sees every one of them differ from what was recorded, and `titleIsNew` covers
 * a title recorded for the first time, whose seasons have nothing to differ
 * from yet.
 *
 * Lowest number first: a block lands with its seasons in the order a reader
 * expects the rows in, and an existing block gains them in that order too.
 *
 * Apart from `insertTarget` because it asks nothing of the catalogue, so it
 * answers the same before a lookup as after — which is what lets the block walk
 * settle that a title has no row to gain before paying for its detail. One
 * copy, because a walk pre-screening on a predicate of its own would pay for
 * the lookups of every title this then declines, or report as unaddable a title
 * this would have placed.
 *
 * `fresh` is the caller's answer, and the two callers answer it differently.
 * The block walk passes `titleIsNew`: a title with no rows at all has seasons
 * with nothing to differ from, so newness is the only thing that can offer them.
 * The grid walk passes **false**. A block the tab already holds is one a reader
 * built to the height they wanted, and a title of theirs this sync has not
 * recorded is a first sighting — recorded, offered nothing — exactly as an
 * unrecorded count is. Reading newness there would back-fill a hand-started
 * block from S1 the first time its title was seen, which is the one edit no
 * later poll can undo.
 */
const insertableSeasons = (
  source: TitleProgress,
  cutoff: Temporal.Instant,
  covered: Set<number>,
  known: Known,
  fresh: boolean,
): SeasonProgress[] =>
  watchedSeasons(source)
    .filter((s) => !covered.has(s.number) && (within(s.lastWatchedAt, cutoff) || fresh || countMoved(source.id, s.number, s.watched, known)))
    .sort((a, b) => a.number - b.number);

/** The two catalogue facts a chosen season's row turns on, read off the shape the store holds. */
const candidateOf = (source: TitleProgress, season: SeasonProgress, titles: Map<number, TitleCatalogue>): InsertCandidate => {
  const shape = titles.get(source.id)?.shapes.get(season.number);
  return { source, season, aired: seasonAired(shape), complete: seasonComplete(shape, season.watched) };
};

/**
 * The season and the two catalogue facts about it, together. `source` is the
 * entry `statusSource` named for an existing block, already resolved and
 * cleared of duplicate-id claims — one derivation of "which entry drives this
 * block" serves the Status write, the insert, and its runtime alike.
 *
 * A season inserted complete is dated by the same fill that creates it, so
 * its runtime has one chance to be asked for — before the row exists. Hence
 * the insert path's own runtime demand. The insert must never *require* the
 * runtime to have arrived: a row whose number never comes back is inserted
 * open and closed by the per-row path a poll later, so a bug there costs a
 * poll rather than a cell.
 *
 * `covered` is the caller's, and so is the scope test that has to precede it
 * (`runtimeScopeOk` — anime is never inserted into, because one SIMKL record
 * is one cour and its season numbers do not address rows the user numbers by
 * broadcast season). A block being created has neither: it holds no rows yet,
 * and the type it will carry is `SHOW_TYPE` by construction.
 */
const insertTarget = (
  source: TitleProgress,
  titles: Map<number, TitleCatalogue>,
  cutoff: Temporal.Instant,
  covered: Set<number>,
  known: Known,
): InsertTarget | null => {
  // False, never `titleIsNew`: this block exists, so its height is the reader's
  // judgement and a title first seen today has nothing to back-fill from. See
  // `insertableSeasons`.
  const [season, ...rest] = insertableSeasons(source, cutoff, covered, known, false);
  return season === undefined ? null : { candidate: candidateOf(source, season, titles), behind: rest };
};

/** The row a title would gain, and which of its seasons are still waiting behind it. */
interface InsertTarget {
  candidate: InsertCandidate;
  /**
   * Seasons this title wants a row for beyond the one chosen. Counted as
   * deferred inserts, because that count is what arms the retry: an existing
   * block gains a season a run, and without it the run that adds one has
   * nothing deferred, so the rest would wait on the library's next unrelated
   * move rather than the next poll.
   *
   * Off the same `insertableSeasons` call the candidate came from, so the
   * seasons counted are by construction the ones the same rule would offer next
   * — a second derivation is free to count a season this would not place.
   */
  behind: SeasonProgress[];
}

/**
 * Say what the run cannot get to, and withdraw the counts of the seasons it
 * left behind.
 *
 * Withdrawing is what makes the deferral survive the run. `observeWatches`
 * records every watched season of every title, so a season left behind would
 * otherwise be recorded at the value the sheet never received: the next poll
 * would find its count unmoved, `insertableSeasons` would not offer it, and the
 * row would be lost until the season was watched again. The same discipline
 * `writing` follows for an edit, from the other side.
 *
 * Both insert paths defer the same way and the note has to read the same, since
 * a report is compared against the poll before it and a difference in wording
 * reads as a difference in state.
 */
const deferBehind = (plan: SheetPlan, keep: Recording, id: number, label: string, season: number, behind: readonly SeasonProgress[]): void => {
  if (!behind.length) return;
  plan.deferred += behind.length;
  holdSeasons(keep, id, behind);
  plan.notes.push(`${label}: ${behind.length} more season row(s) wait behind S${season} — they follow on later runs`);
};

/**
 * Leave these seasons unrecorded, without claiming this run could have done
 * them.
 *
 * The withdrawal alone, where `deferBehind` also counts: a placement refusal
 * waits on a hand edit — a season row above the insertion point, or a date SIMKL
 * has wrong — and nothing this service does will drain it, so a retry armed on
 * one would ask for another poll every poll for ever. The counts still have to
 * go: recorded at a value the sheet never received, the next poll finds them
 * unmoved and the rows are lost until the seasons are watched again.
 */
const holdSeasons = (keep: Recording, id: number, seasons: readonly SeasonProgress[]): void => {
  for (const season of seasons) withdraw(keep.observed, seasonKey(id, season.number), 'Watched');
};

// --- Where a row's decisions land --------------------------------------------

/**
 * Where one row's decisions land: the plan it adds to, the lookups it asks for
 * and the allowance they are charged against, and the two maps it banks and
 * withdraws in.
 *
 * A parameter rather than the run's own, because the admission step below builds
 * a candidate row into a target of its own and keeps it only if the whole run
 * still fits the poll's budgets. Everything a rejected row planned has to be
 * droppable together — the edits, the demands and what it banked — and a writer
 * reaching past this for any of them is a piece of a rejected row surviving it.
 */
interface WriteTarget extends Asker {
  plan: SheetPlan;
  keep: Recording;
}

/** What asking for a lookup needs: the lists it lands on, and the allowance it is charged against. */
interface Asker {
  demands: PlanDemands;
  budget: LookupBudget;
}

/**
 * One lookup, named by the allowance it is charged against. The four kinds are
 * the four fields of `LookupBudget`, so a kind that is not in it is a compile
 * error rather than an uncharged ask.
 */
type Demand =
  | { kind: 'detail'; request: CatalogueRequest }
  | { kind: 'runtimes'; request: RuntimeRequest }
  | { kind: 'genres'; request: SeriesRequest }
  | { kind: 'certificates'; request: CertificateRequest };

/**
 * Ask for a lookup, and charge the attempt's allowance for it.
 *
 * **One choke point, and every asker goes through it.** The block walk is not
 * the only place that asks: the grid walk asks for a catalogue per in-scope
 * block and a runtime per closing row, and once a record's disagreement can put
 * every block of a marked-whole library in scope at once — and keep them there
 * across polls, since nothing ages out of that — the grid walk is the larger of
 * the two. Charged uniformly, a pass asks for a bounded burst whatever the shape
 * of the work; charged on one side and not the other, the uncharged side is the
 * burst the cap exists to prevent — a cold store with 120 blocks in scope
 * issuing 240 requests at once.
 *
 * Dropping an ask costs nothing that is not re-earned: the demand set is a
 * function of the grid, the library and the store, so the next pass of the same
 * fixpoint — and failing that the next poll — asks again.
 *
 * `charge` is false for an ask the store has already answered. Such an ask is
 * one `sync.ts` drops inside `CATALOGUE_MAX_AGE` anyway, and counting it would
 * let a handful of settled titles sorted ahead spend the whole allowance on
 * every pass and starve everything behind them for good.
 *
 * Answers whether the ask went out, which is what a caller reads to tell "asked
 * and waiting" — work this run's own fixpoint drains — from "not asked", which
 * is work only another poll will do.
 */
const demand = ({ demands, budget }: Asker, ask: Demand, { charge = true }: { charge?: boolean } = {}): boolean => {
  if (ask.kind === 'detail') {
    // Charged per title, and free for a title this pass has already asked
    // about: a live-action block asks twice about the same id and
    // `fetchCatalogue` merges the two into one call.
    if (charge && !budget.detail.has(ask.request.id)) {
      if (budget.detail.size >= CATALOGUE_ASKS_PER_PASS) return false;
      budget.detail.add(ask.request.id);
    }
    demands.catalogue.push(ask.request);
    return true;
  }
  if (charge) {
    if (budget[ask.kind] >= MAX_LOOKUPS_PER_PASS) return false;
    budget[ask.kind] += 1;
  }
  if (ask.kind === 'runtimes') demands.runtimes.push(ask.request);
  else if (ask.kind === 'genres') demands.genres.push(ask.request);
  else demands.certificates.push(ask.request);
  return true;
};

/** Everything the insert's runtime decision reads, computed once per candidate. */
interface InsertRuntime {
  /** The TVDB lookup the row would need — null where none is possible. */
  target: RuntimeRequest | null;
  /** The average, `null` for settled-unusable, `undefined` for unanswered. */
  minutes: number | null | undefined;
  /**
   * Whether `/tv/{id}` has answered for this title. The store writes `tvdbId`
   * as a number or explicit null the moment the detail lands, so its absence
   * is the one reliable "not yet" — `runtime` and `status` are both
   * legitimately absent on a detail that did arrive.
   */
  detailed: boolean;
}

/**
 * Two of `runtimeAnswer`'s clauses are absent because a new row satisfies
 * them by construction: no cell yet, so the blank-cell test cannot fail, and
 * `id` is not in the insert's whitelist, so the row inherits the block's.
 * Scope is settled by `insertTarget`. No whole-season test either:
 * `seasonsOf` is the only producer of a `SeasonProgress` and drops everything
 * fractional or below 1, where a grid row's number is whatever was typed.
 */
const insertRuntimeOf = ({ source, season }: InsertCandidate, titles: Map<number, TitleCatalogue>): InsertRuntime => {
  const entry = titles.get(source.id);
  const tvdbId = entry?.tvdbId;
  const target = typeof tvdbId === 'number' ? { id: source.id, tvdbId, season: season.number } : null;
  return {
    target,
    minutes: target === null ? undefined : entry?.seasonRuntimes.get(target.season),
    detailed: detailAnswered(entry),
  };
};

// --- The runtime a closing row can still take ------------------------------

/**
 * What a closing row's runtime cell can still become. Three answers; the
 * middle one is why this is not a boolean:
 *
 * - `none` — nothing to wait for: out of scope, cell already filled, or the
 *   detail answered that no join key exists. The close may proceed.
 * - `pending` — in scope but `/tv/{id}` has not answered, so whether a key
 *   exists is unknown. The close must wait: dating now would forfeit the cell
 *   on what may be a transient 503, and the date comes from the watch
 *   timestamp, so waiting a poll costs nothing.
 * - `target` — a key to join on, and the lookup it needs.
 *
 * Every scope clause is load-bearing:
 *
 * - `runtimeScopeOk`: the block's numbers must mean something to TVDB, which
 *   anime's never do — every SIMKL anime record numbers its episodes season 1,
 *   and all cours of a franchise share one TVDB id. The episode count cannot
 *   disambiguate: Demon Slayer's TVDB seasons 3 and 4 both hold 11 episodes
 *   at different lengths.
 * - the row **inherits** the block's id. A row carrying its own id has a
 *   season number that is explicitly not the entry's — a split cour, Parasyte,
 *   Doctor Who's 2024 renumbering — exactly the number that cannot be handed
 *   to TVDB.
 * - a whole season number: `13.5` encodes a judgement no rule reproduces.
 * - only a blank cell is a target: a typed number is a deliberate correction,
 *   and nothing here can tell a better one from a worse one.
 */
type RuntimeAnswer =
  | { state: 'ineligible' }
  | { state: 'pending' }
  | { state: 'settled'; id: number }
  | { state: 'target'; id: number; request: RuntimeRequest };

const runtimeAnswer = (
  grid: Grid,
  block: ShowBlock,
  season: SeasonRow,
  index: Map<number, TitleProgress>,
  titles: Map<number, TitleCatalogue>,
): RuntimeAnswer => {
  if (!runtimeScopeOk(block)) return { state: 'ineligible' };
  if (season.ids.length) return { state: 'ineligible' };
  if (season.season === null || !Number.isInteger(season.season)) return { state: 'ineligible' };

  // The same id `resolveRow`'s by-season branch reads. Mirrored: a narrower
  // rule here than there would strand a row.
  const id = idsFor(block, season)[0];
  if (id === undefined || !index.has(id)) return { state: 'ineligible' };

  if (!isBlank(cellAt(grid, season.row, grid.columns.Runtime))) return { state: 'ineligible' };

  const entry = titles.get(id);
  if (!detailAnswered(entry)) return { state: 'pending' };
  const tvdbId = entry.tvdbId;
  // No key, so no season average is ever coming — but the row is still one
  // this sync may fill, and the show-wide length is the best there will be.
  if (tvdbId === null) return { state: 'settled', id };

  return { state: 'target', id, request: { id, tvdbId, season: season.season } };
};

// --- Closing a row ----------------------------------------------------------

type ResolvedRow = Extract<RowResolution, { kind: 'resolved' }>;

// --- Following SIMKL --------------------------------------------------------

/**
 * Everything SIMKL currently says that the sync measures a change against: each
 * season's first and last watch and its watched count, and each title's status.
 *
 * The whole library, not only the rows a pass reaches. Recording is not a write
 * and costs nothing, while the gap it closes is the one that matters: a first
 * sighting is silent by design, so a season observed for the first time on the
 * very run that first reaches it has its move swallowed — and a move is usually
 * what brought the row into the activity window in the first place. Recording
 * wide means every later move is a real move.
 *
 * Wide is also what makes the two new fields mean anything for a title the tab
 * has no block for. Scoped to the blocks on the grid, a back catalogue marked
 * whole would have no count to differ from and no title record to be new
 * against, and the one case the record exists to catch — a change today carried
 * by timestamps two decades old — would be invisible for exactly the titles
 * that need a block.
 *
 * `Start` and `End` because both are facts the library already carries. What
 * needs a catalogue lookup is *writing* `End` — the row must be complete, and
 * only the episode list says so for a season resolved by number. Recording is a
 * different question and asks nothing: this is the day SIMKL currently reports,
 * whether or not the season is finished.
 *
 * A title's entry carries `Status` and exists for every title, watched or not:
 * it is the record that the title was *seen*, which is what `titleIsNew` reads,
 * and a title with nothing watched is exactly the one that will later be marked
 * whole with old dates.
 *
 * An inserted row is recorded on the same run that writes it only where that
 * run banks it — see `Recording`. What is unconditional here is the seed; every
 * value this run means to write, or means a later run to write, is taken back
 * out of it.
 */
export const observeWatches = (index: Map<number, TitleProgress>): Baseline => {
  const observed: Baseline = new Map();
  for (const progress of index.values()) {
    const { title, seasons } = titleObservations(progress);
    observed.set(title.key, title.entry);
    for (const season of seasons) observed.set(season.key, season.entry);
  }
  return observed;
};

/** One entry of the seed: the key it lands under and the fields it holds. */
interface Observation {
  key: string;
  entry: Record<string, string>;
}

/**
 * What the seed holds for one title — the whole of it, and the only place that
 * shape is decided.
 *
 * One derivation because three callers ask the same question from three
 * directions: the seed sets these, a block walk that cannot build a title yet
 * withdraws them, and one that has said its final word puts them back. Derived
 * separately, a withdrawal would iterate a season the seed never recorded — a
 * season with a count and no first-watch date is one `observeWatches` skips —
 * and the two would disagree about which keys exist at all.
 */
const titleObservations = (progress: TitleProgress): { title: Observation; seasons: Observation[] } => {
  const seasons: Observation[] = [];
  for (const season of progress.seasons.values()) {
    if (season.firstWatchedAt === null) continue;
    const entry: Record<string, string> = { Start: isoOf(season.firstWatchedAt), Watched: String(season.watched) };
    if (season.lastWatchedAt !== null) entry.End = isoOf(season.lastWatchedAt);
    seasons.push({ key: seasonKey(progress.id, season.number), entry });
  }
  return { title: { key: titleRecordKey(progress.id), entry: { Status: progress.status ?? NOT_HELD } }, seasons };
};

/**
 * Where each tracked field's current value comes from, and when the row is
 * eligible for it. Keyed on `TrackedField`, so a column added to the set in
 * `values.ts` and not taught to the planner fails to compile — the direction
 * that matters, since the guard stops refusing that column on a dated row the
 * moment the set names it.
 *
 * `End` is eligible only on a row already dated. An open row's end date belongs
 * to `closeSeason`, which holds it back while the runtime question is open, and
 * a row this batch dates would otherwise be planned two `End` edits.
 */
const TRACKED_SOURCE: Record<TrackedField, { of: (resolved: ResolvedRow) => Temporal.Instant | null; on: (season: SeasonRow, resolved: ResolvedRow) => boolean }> = {
  Start: { of: (resolved) => resolved.firstWatchedAt, on: () => true },
  End: { of: (resolved) => resolved.lastWatchedAt, on: (season, resolved) => season.closed && resolved.complete },
};

/**
 * The end date this row will hold once the batch lands: the one being written
 * where the batch writes one, else what the cell holds now. Non-numeric reads
 * as no ordering to check — a hand-typed `TBD` names no day to be after.
 */
/**
 * What one tracked field would become: the value, the serial it renders to, and
 * whether that differs from what was recorded.
 */
interface Candidate {
  field: TrackedField;
  at: Temporal.Instant;
  serial: number;
  moved: boolean;
}

/**
 * The serial a row will hold for a field once the batch lands: the candidate
 * where one is moving, else what the cell holds now. Non-numeric reads as
 * nothing to compare — a hand-typed `TBD` names no day.
 */
const resulting = (candidates: Candidate[], field: TrackedField, grid: Grid, row: number): number | null => {
  const moving = candidates.find((c) => c.field === field && c.moved);
  if (moving) return moving.serial;
  const held = numberOf(cellAt(grid, row, grid.columns[field]));
  return typeof held === 'number' ? held : null;
};

/**
 * Whether this row's `End` has moved, decided without a lookup.
 *
 * The same comparison `followUpstream` makes, asked earlier: `End` is eligible
 * only on a complete season, and for a row resolved through the catalogue that
 * answer is behind a fetch. Deciding first whether there is anything to write
 * keeps the fetch to the seasons whose date actually changed — normally none,
 * because `observeWatches` records both fields library-wide and a library that
 * has not moved disagrees with nothing.
 *
 * A first sighting is not a move, exactly as it is not one in `followUpstream`.
 * It is already recorded by then, so the next real change is measured against
 * it — which is what confines this to changes from here on.
 *
 * `season.ids.length`, not the block's model: `resolveRow` picks the cour
 * branch per row, and a row carrying its own id takes `complete` from its
 * entry's counters. Asking the block's id for an episode list would name a
 * title that cannot answer for this row, and would ask again every day
 * forever, because nothing the answer contains can settle it.
 */
/**
 * Whether this block's catalogue lookup has come back at all.
 *
 * The distinction `resolved.complete` cannot make: a season is incomplete both
 * when nothing has been fetched and when the fetch said so. Only the first is
 * worth a lookup, and reading them as one turns a bounded seeding pass into a
 * queue of blocks re-asking a settled question forever, spending the allowance
 * on titles already answered while rows further down the sheet are never asked
 * about at all.
 *
 * An *entry*, not a season count. A row on this grid can be a film — the ones
 * embedded in a series block — and `/tv/episodes/{id}` answers a film with an
 * empty list, which is an answer. Keyed on the episode count those never
 * settle either.
 */
const endMoved = (season: SeasonRow, resolved: ResolvedRow, { baseline, timezone, ceiling }: FollowContext): boolean => {
  if (season.ids.length || !season.closed || resolved.key === null) return false;
  const serial = watchSerial(resolved.lastWatchedAt, timezone);
  // The same range `followUpstream` declines on. Asked here too so a timestamp
  // it is going to refuse does not first earn a lookup to refuse it with.
  if (serial === null || !plausibleSerial(serial, ceiling)) return false;
  const was = recordedSerial(baseline.get(resolved.key)?.End, timezone);
  return was !== null && was !== serial;
};

const followUpstream = (
  { plan, keep }: WriteTarget,
  { grid, timezone, ceiling, baseline }: FollowContext,
  season: SeasonRow,
  resolved: ResolvedRow,
  label: string,
): void => {
  const key = resolved.key;
  if (key === null) return;

  // Decided before any of it is emitted, because the one rule these two fields
  // have between them is about the *pair*: a start cannot fall after the end.
  // Checked per field as each was planned, the answer would depend on which was
  // considered first — and on a row where both move, on a value about to be
  // replaced.
  const candidates: Candidate[] = [];
  for (const field of TRACKED_FIELDS) {
    const source = TRACKED_SOURCE[field];
    if (!source.on(season, resolved)) continue;
    const at = source.of(resolved);
    const serial = watchSerial(at, timezone);
    if (at === null || serial === null) continue;
    const was = recordedSerial(baseline.get(key)?.[field], timezone);
    candidates.push({ field, at, serial, moved: was !== null && was !== serial });
  }

  const start = resulting(candidates, 'Start', grid, season.row);
  const end = resulting(candidates, 'End', grid, season.row);
  const inverted = start !== null && end !== null && start > end;

  // Whether this row and the season it resolved to describe the same episodes.
  //
  // A row matched by season *number* is only that season if it holds the same
  // ones, and the sheet numbers some shows its own way: a Netflix batch split
  // into parts gives Disenchantment five ten-episode rows against SIMKL's
  // 20/20/10, so its row 2 resolves to a season whose first and last watch
  // belong to rows 1 and 4. Following those dates writes a later part's date
  // onto an earlier part's row, and every row in such a block is wrong in the
  // same direction.
  //
  // Only on a closed row, where the count is the sheet's final word. An open
  // one legitimately lags — that disagreement is what the count write exists
  // to settle, and reading it as a mismatch would stop a season following
  // SIMKL for exactly as long as it was still being watched.
  const fragment = season.closed && season.episode !== null && season.episode !== resolved.watched;

  for (const { field, at, serial, moved } of candidates) {
    // Over the seed, never merely left to it: `observeWatches` records each
    // SIMKL season under its own key, and a split-cour row's dates come off two
    // different entries — its `End` is the *last* cour's, recorded under the
    // *first* cour's key. Left to the seed, the comparison above would find that
    // row moved on every poll for as long as the row exists.
    const observe = (): void => void keep.observed.set(key, { ...keep.observed.get(key), [field]: isoOf(at) });

    // Two reasons to decline a move, both leaving the value recorded. Declining
    // in the planner rather than at the guard is the point: refusal there is
    // whole-plan, so one bad row would hold up every unrelated edit on every
    // poll for as long as it sat in scope.
    //
    // Out of range is SIMKL's fault. Inverted is usually the sheet's — a row
    // holding a date typed by hand, or one written here before the watch it
    // came from was corrected — and writing anyway would leave the row saying
    // it ended before it began. A formula is the sheet's too, and the one the
    // guard refuses *unconditionally*: these two fields reach rows no window
    // takes back out of scope, so a formula in one of them would refuse every
    // plan the sheet ever makes rather than for as long as a row stayed
    // recent.
    const why = !plausibleSerial(serial, ceiling)
      ? 'is outside the range this sync writes'
      : isFormula(cellAt(grid, season.row, grid.columns[field]))
        ? 'would overwrite a formula'
        : fragment
          ? `covers ${resolved.watched} episodes where this row holds ${season.episode}`
          : inverted
            ? 'would leave the row starting after it ended'
            : null;

    if (moved && why !== null) {
      plan.skips.push({
        code: fragment ? 'season-fragment' : 'unusable-timestamp',
        message: `${label}: SIMKL's ${SHOW_LABELS[field]} ${why}, so that cell is left alone`,
      });
      observe();
      continue;
    }

    if (!moved) {
      // Everything not being written is observed, stated once so the
      // disjointness the mechanism rests on reads off one exit.
      observe();
      continue;
    }

    const before = watchedNote(instantFrom(baseline.get(key)?.[field]), timezone);
    plan.edits.push(edit(grid, season.row, field, num(serial), `${label}: ${SHOW_LABELS[field]} moved from ${before} to ${watchedNote(at, timezone)}`));
    // Into `writing`, and out of `observed`, which `observeWatches` has already
    // seeded with this very value: recorded before its write lands, the next
    // poll compares against it, finds nothing moved, and the change is lost.
    bank(keep, key, field, isoOf(at));
  }
};

/**
 * Everything `followUpstream` *reads* and that does not vary between rows, built
 * once per run.
 *
 * Read-only, and the plan and the record are not in it: a follow-up is a
 * candidate the admission step may hold back, so where it writes is the
 * `WriteTarget` it is handed and not a map it reaches for. Kept here, a rejected
 * row's edits would land in the run's own plan.
 */
interface FollowContext {
  grid: Grid;
  timezone: string;
  ceiling: number;
  baseline: Baseline;
}

/**
 * The `End` date and the runtime that rides with it, for a row that resolved
 * and is not already dated.
 *
 * `End` closes the row for good — the guard refuses every later edit to a
 * dated row — so a row whose runtime question is still open waits rather than
 * closing blind. The date is not lost by waiting: it comes from the watch
 * timestamp, so a row deferred three polls gets the identical serial three
 * polls later.
 *
 * Accumulates into the plan the way the rest of the walk does, and returns the
 * one thing the caller branches on: whether this batch dates the row, which is
 * what decides the fate of the watch note beside it.
 */
const closeSeason = (
  out: WriteTarget,
  grid: Grid,
  block: ShowBlock,
  season: SeasonRow,
  resolved: ResolvedRow,
  index: Map<number, TitleProgress>,
  titles: Map<number, TitleCatalogue>,
  { label, timezone, ceiling }: { label: string; timezone: string; ceiling: number },
): boolean => {
  const { plan, keep } = out;
  if (!resolved.complete && resolved.settled) return false;

  // The row stays open for another poll, so nothing about it may be recorded as
  // settled. Out of `writing` as well as `observed`: the `Episode` edit above
  // may have banked this very count, and a banked value is recorded the moment
  // the batch lands — after which the next poll finds the count unmoved, and a
  // row in scope on the record alone has no window to bring it back. The close
  // would then never happen.
  //
  // Above every exit that leaves the row open, because every one of them owes
  // it: an unusable timestamp is SIMKL's to correct, and a count recorded
  // against a row this run could not close is a close no poll ever makes.
  const holdOpen = (): false => {
    for (const { key } of resolved.counts) {
      withdraw(keep.observed, key, 'Watched');
      withdraw(keep.writing, key, 'Watched');
    }
    return false;
  };

  // No episode list, so whether the season is complete is unknown rather than
  // no — the absent-versus-settled distinction the runtime draws. Read as no,
  // the count would land and be recorded, and a season that was in fact
  // complete would leave scope undated; a poll whose lookup fails is exactly
  // the poll a forgotten or withdrawn count must survive.
  if (!resolved.settled) {
    plan.skips.push({ code: 'no-episode-list', message: `${label}: no episode list came back, so whether it is complete is unknown — left open for the next poll` });
    return holdOpen();
  }

  const serial = watchSerial(resolved.lastWatchedAt, timezone);
  // Bounded here, not only in the guard, for the reason `followUpstream` gives:
  // refusal is whole-plan, so a single upstream timestamp outside the writable
  // range would hold up every unrelated edit for as long as its row sat inside
  // the activity window. Both writers of `End` owe the same skip.
  if (serial === null || !plausibleSerial(serial, ceiling)) {
    plan.skips.push({ code: 'unusable-timestamp', message: `${label}: complete, but its last watch timestamp is unusable` });
    return holdOpen();
  }

  const runtime = runtimeAnswer(grid, block, season, index, titles);
  if (runtime.state === 'pending') {
    // Nothing to demand: without the detail there is no key to ask TVDB with,
    // and the block's catalogue demand already asks for it.
    plan.skips.push({ code: 'awaiting-runtimes', message: `${label}: complete, but its catalogue detail has not come back — left open for the next poll` });
    return holdOpen();
  }
  // One map read answers the whole state machine: `undefined` is unanswered,
  // `null` settled with nothing usable, a number the answer.
  const minutes = runtime.state === 'target' ? titles.get(runtime.id)?.seasonRuntimes.get(runtime.request.season) : null;
  if (runtime.state === 'target' && minutes === undefined) {
    // Whether the ask actually went out. Unasked is work this run chose not to
    // do — the allowance was spent — and that is what a deferral claims and what
    // arms the retry bringing a poll with a fresh allowance; asked and
    // unanswered drains inside this run's own fixpoint, and a lookup that failed
    // arms the retry through `made.failures` instead. The block walk counts an
    // unmade ask the same way.
    if (!demand(out, { kind: 'runtimes', request: runtime.request })) plan.deferred += 1;
    plan.skips.push({ code: 'awaiting-runtimes', message: `${label}: complete, but its episode runtimes have not come back — left open for the next poll` });
    return holdOpen();
  }

  plan.edits.push(edit(grid, season.row, 'End', num(serial), `${label}: ended`));
  // Recorded like any other tracked write, and only once it lands. Without
  // this the closing run banks nothing, the next poll sees `End` for the first
  // time and records it silently, and a correction landing in between is lost
  // for good — the gap this whole mechanism exists to close.
  //
  // Withdrawn from `observed` for the same reason `followUpstream` withdraws:
  // `observeWatches` seeds this very value library-wide, and a value recorded
  // before its write lands is a change banked and never made.
  if (resolved.key !== null && resolved.lastWatchedAt !== null) bank(keep, resolved.key, 'End', isoOf(resolved.lastWatchedAt));
  if (runtime.state === 'ineligible') return true;

  // Settled-with-nothing falls back to the show-wide runtime, same as a row
  // being created. This batch dates the row either way, so the choice is
  // between an approximate number and a cell nothing can ever fill — and it
  // must not depend on which run first saw the season, or two identical-looking
  // rows differ for a reason no reader could see. A title with no TVDB key at
  // all is that same case: no average is coming, so the show-wide length is
  // what the cell gets.
  const own = runtimeMinutes(minutes);
  const length = own ?? runtimeMinutes(titles.get(runtime.id)?.runtime);
  if (length === null) {
    plan.notes.push(`${label}: ended with no usable episode runtimes, so its ${SHOW_LABELS.Runtime} cell is left blank`);
  } else {
    // The season's own average where TVDB answered with one the column can
    // hold, the show's usual episode length where it did not — decided on the
    // value written, so the note never names an average the cell did not get.
    const measured = own === null ? "SIMKL's show-wide episode runtime" : `${own} min average episode runtime`;
    plan.edits.push(edit(grid, season.row, 'Runtime', num(length), `${label}: ${measured}`));
  }
  return true;
};

/**
 * The `Note` cell on a season row: when the season was last watched, and
 * nothing once the row is dated — the `End` column says the same thing more
 * precisely, and a row that never changes again should not keep a running note.
 *
 * **The note dates the count beside it, so it moves only when that count
 * does.** An open row whose `Episode` cell this run leaves alone is left alone
 * whole: nothing about it moved, so a fresh date would claim otherwise, and
 * `lastWatchedAt` drifts for reasons the count does not see — a scrobbler
 * restamping an episode, or a delta re-reporting the same watch. It also keeps
 * the note out of the run's budget in the way that matters: every note lands on
 * a row the plan already edits, so it costs an edit and never a row, and the
 * set of rows it can appear on is the set that moved rather than every row
 * watched inside the window. The insert path applies the same rule from the
 * other side — a row created open carries the date its first count is made of.
 *
 * The clear is not conditioned on it: a stale note on a closing row has to go
 * whether or not that same batch advanced the count.
 *
 * **Only ever this sync's own note**, which is what `ownsNote` decides: a blank
 * cell may be written into and a cell holding a date of exactly the shape
 * `watchedNote` produces may be moved on or taken away. Anything else in that
 * column a human typed, and the row closes around it rather than through it.
 * The guard re-derives the same predicate, one copy in `values.ts`.
 *
 * A formula is declined by that predicate too, and it has to be: `season.note`
 * is the cell's *result*, so a formula rendering a date reads as this sync's own
 * note and would be planned over. The guard refuses a formula target
 * unconditionally and refusal is whole-plan, so one such cell would stop every
 * unrelated edit for as long as its row sits inside the activity window.
 * Declined here so the guard stays the backstop.
 *
 * No scope test beyond the row resolving: the date comes from a watch
 * timestamp, so a cour row's number never has to address anything upstream —
 * unlike the runtime beside it.
 */
const watchNote = (
  { plan }: WriteTarget,
  grid: Grid,
  season: SeasonRow,
  lastWatchedAt: Temporal.Instant | null,
  { advanced, closing, label, timezone, ceiling }: { advanced: boolean; closing: boolean; label: string; timezone: string; ceiling: number },
): void => {
  const cell = cellAt(grid, season.row, grid.columns.Note);
  if (!ownsNote(cell, season.note)) return;

  if (closing) {
    // Nothing of ours in a blank cell to take away.
    if (!isBlank(cell)) plan.edits.push(edit(grid, season.row, 'Note', undefined, `${label}: dated, so its last-watched note is cleared`));
    return;
  }
  if (!advanced) return;
  const text = watchedNote(lastWatchedAt, timezone);
  if (text === null || text === season.note) return;
  // The same range `End` is bounded on — the note is the same fact one column
  // earlier in the row's life, and the guard checks it against the same pair. A
  // 1994 timestamp on a season SIMKL says was watched last week would otherwise
  // refuse the whole plan, and refusal is whole-plan on every poll for as long
  // as the row stays in scope. The count beside it still lands: the note is what
  // the timestamp cannot support, not the count.
  if (!plausibleSerial(watchedNoteSerial(text), ceiling)) {
    plan.skips.push({
      code: 'unusable-timestamp',
      message: `${label}: its last watch reads ${text}, which is outside the range this sync writes, so the note is left alone`,
    });
    return;
  }
  plan.edits.push(edit(grid, season.row, 'Note', str(text), `${label}: last watched ${text}`));
};

// --- The plan --------------------------------------------------------------

/**
 * Plan the whole sheet against what the catalogue holds, and say what more is
 * needed.
 *
 * `demands.catalogue` names every lookup the in-scope blocks run on, with no
 * memory of what was fetched — deciding what is *stale* is the store's job.
 * `demands.runtimes` names only the seasons whose close or insert is waiting
 * on an answer, so it empties once the store has them (or has settled that
 * none is coming).
 */
export const planSync = (
  grid: Grid,
  index: Map<number, TitleProgress>,
  titles: Map<number, TitleCatalogue>,
  {
    now = Temporal.Now.instant(),
    timezone = config.timezone,
    sinceDays = config.sheetSinceDays,
    baseline = new Map(),
    anyTitleRecorded = false,
    starts,
    filed,
    showBucket = showArtworkBucket(config),
    facts = { tvdb: tvdbConfigured(config), tmdb: tmdbConfigured(config) },
    factsRejected = new Set<FactsCredential>(),
    lookupBudget = emptyLookupBudget(),
    maxEdits = config.sheetMaxEdits,
    maxRows = config.sheetMaxRows,
  }: PlanOptions = {},
): PlanResult => {
  const plan = emptyPlan();
  const demands: PlanDemands = { catalogue: [], runtimes: [], genres: [], certificates: [] };
  const cutoff = cutoffFrom(now, sinceDays);
  const known: Known = { baseline, anyTitle: anyTitleRecorded };
  const duplicates = duplicateIds(grid.blocks);
  const onGrid = new Set<number>();
  // Copied, never used directly: a pass whose plan is discarded must not leave
  // its withdrawals in the caller's seed. The entries themselves are never
  // mutated in place — only replaced — so a shallow copy is enough.
  const observed = new Map(starts ?? observeWatches(index));
  const writing: Baseline = new Map();
  const forgetting: Forgetting = new Map();
  const keep: Recording = { observed, writing, forgetting };
  // Every write the walk finds, by the tier that decides which goes first. The
  // walk plans nothing directly: it builds candidates and the admission step
  // below takes them in tier order, while the poll's budgets have room.
  //
  // Four tiers, in the order the run would rather lose them — the last first:
  //
  // 1. `Start` and `End` following SIMKL. Bounded by what actually moved
  //    upstream, and the one pair of fields no window takes back out of scope,
  //    so a change held back here is one nothing else will look for.
  // 2. The rows the activity window reaches, and the block `Status` beside
  //    them. Bounded by what was watched, which is an ordinary week's viewing.
  // 3. The run's one insert — a season row, or a block.
  // 4. Rows in scope on the record alone. The unbounded one: a library marked
  //    whole puts every row of every block here at once.
  //
  // Admitted rather than planned outright, all four of them. A plan over either
  // budget is refused **whole**, and a refusal arms no retry, so a poll that
  // planned past the ceiling would write nothing at all — and a record-scoped
  // row has no window to age out of, so that refusal stands on every poll for
  // ever. Rationed, the same rows land a budget at a time.
  const follows: Rationed<WriteTarget>[] = [];
  const watched: Rationed<WriteTarget>[] = [];
  const inserts: Array<Rationed<WriteTarget> & { label: string }> = [];
  const backlog: Array<Rationed<WriteTarget> & { row: number }> = [];
  const run: WriteTarget = { plan, demands, budget: lookupBudget, keep };
  const follow: FollowContext = { grid, timezone, ceiling: maxSerial(now, timezone), baseline };

  /** How many more distinct rows this poll may touch, counted the way the guard counts them. */
  const rowsLeft = (): number => rowsRemaining(planWrites(plan), budgets);

  /**
   * The grid walk's catalogue ask: charged only while the store has not
   * answered, and counted as deferred where the allowance had no room.
   *
   * Uncharged once answered because these asks are what a pass reads the grid
   * with, and an answered title's ask is one `sync.ts` drops inside
   * `CATALOGUE_MAX_AGE` anyway: charged, the first `CATALOGUE_ASKS_PER_PASS`
   * blocks in grid order would spend the whole allowance on every pass and
   * every poll while writing nothing, and every block behind them would be
   * read as "no episode list came back" for as long as they stayed in scope —
   * which, for a block in scope on the record alone, is for ever. A refused
   * ask is a block this pass could not read, and `deferred` is what arms the
   * retry that brings a pass with a fresh allowance — counted once per title,
   * the unit the allowance names, since a live-action block asks twice about
   * one id.
   */
  const unasked = new Set<number>();
  const askDetail = (out: WriteTarget, request: CatalogueRequest): void => {
    if (demand(out, { kind: 'detail', request }, { charge: !detailAnswered(titles.get(request.id)) })) return;
    if (!unasked.has(request.id)) out.plan.deferred += 1;
    unasked.add(request.id);
  };

  /**
   * What is left of the poll's budgets, in the shape the guard counts them.
   *
   * `spent` is zero because what the planner was handed is already the ceiling
   * minus what an earlier half sent — see `PlanOptions.maxEdits`. The
   * arithmetic itself is `guard-core.ts`'s, so a run this stops short of is one
   * the guard would have taken and vice versa: two copies of the counting is a
   * poll refused whole over rows the planner thought it had room for.
   */
  const budgets = { maxEdits, maxRows, spent: { edits: 0, rows: 0 } };

  /**
   * The show half's admission step: a candidate built into a target of its own
   * and taken through `admitPlan` only if the whole run still fits the poll's
   * budgets.
   *
   * What the show half merges beyond the plan: the candidate's demands and the
   * allowance they were charged against, and what it banked. The demands ride
   * a copy of the budget, written back only on commit — a rejected row's
   * demands are dropped, and an allowance charged for an ask nobody made is an
   * ask the next candidate cannot make.
   *
   * `observed` is shared with the run rather than scratched, so a rejected row's
   * withdrawals stick: what it banked is gone from both maps, which is exactly
   * the state that makes the next poll see the row as moved. `writing` is fresh,
   * so nothing a rejected row banked is recorded when the batch lands.
   */
  const admit = (build: (out: WriteTarget) => void): boolean => {
    const scratch: WriteTarget = {
      plan: emptyPlan(),
      demands: { catalogue: [], runtimes: [], genres: [], certificates: [] },
      budget: copyLookupBudget(lookupBudget),
      // `forgetting` shared like `observed`: what a rejected build forgets has
      // to stick, or the record keeps the count the hold was about.
      keep: { observed, writing: new Map(), forgetting },
    };
    build(scratch);
    if (!admitPlan(plan, scratch.plan, budgets, insertSpan)) return false;

    demands.catalogue.push(...scratch.demands.catalogue);
    demands.runtimes.push(...scratch.demands.runtimes);
    demands.genres.push(...scratch.demands.genres);
    demands.certificates.push(...scratch.demands.certificates);
    for (const [key, entry] of scratch.keep.writing) writing.set(key, { ...writing.get(key), ...entry });
    Object.assign(lookupBudget, scratch.budget);
    return true;
  };

  /** What every tier's deferral note says about the room this poll had. */
  const room = `this poll has room for ${maxEdits} edit(s) across ${maxRows} row(s)`;

  for (const block of grid.blocks) {
    const ids = blockIds(block);
    for (const id of ids) onGrid.add(id);

    // Recency gates the *expensive* half — the catalogue lookups, and every
    // write that reads the sheet cell rather than the record. Watched inside
    // the window, or moved since this sync last recorded what SIMKL said: the
    // second is what answers the question actually asked, since a watch date is
    // a fact the user sets and a title marked whole today carries none inside
    // the window.
    //
    // The fields that follow SIMKL are not gated on this at all: what makes
    // them safe on a dormant sheet is the same record, read for a different
    // field — a corrected date moves no watch timestamp and no count, so no
    // gate here can see it.
    const recent = blockRecent(ids, index, cutoff, known);
    const anime = usesCourModel(block);

    // The block's catalogue lookups. The episode list cannot be gated on "a
    // season ended" — it is what discovers that. Anime needs none: one entry
    // is one cour, so its own counters describe the season.
    //
    // A dormant block can earn the same lookup a second way, below: `End`
    // follows SIMKL whatever the window says, and a row resolved through the
    // catalogue needs a completeness answer only the catalogue holds. Asking
    // here would fetch the whole sheet every poll, so the demand waits until a
    // row has been resolved and shown to want one.
    //
    // Charged only where the store has not answered, and a refused ask is
    // counted as deferred: what the allowance rations is *this pass's* reading
    // of the grid, so a block it had no room for is work the next pass — or
    // the retry the count arms — reads instead of "no episode list came back".
    if (recent && !anime) {
      for (const id of block.ids) askDetail(run, { id, episodes: true, detail: true });
    }
    const sourceId = statusSource(block);
    if (recent && sourceId !== null) {
      // On a live-action block this is a title the loop above already asked
      // about, and the allowance counts titles — so the second ask is free.
      askDetail(run, { id: sourceId, anime, detail: true });
    }

    // Two rows describing the same season of the same title: both would be
    // planned the same count, silently, and only one rolls up into the show
    // row above. Keyed on the *effective* id because a blank season row
    // inherits the block's — an anime block whose rows each carry their own
    // id has one season 1 per title and is not this.
    let wantsCompleteness = false;
    const claims = new Map<string, number>();
    for (const row of block.seasons) {
      if (row.season === null) continue;
      for (const id of new Set(idsFor(block, row))) {
        const key = `${id}:${row.season}`;
        claims.set(key, (claims.get(key) ?? 0) + 1);
      }
    }

    for (const season of block.seasons) {
      const resolution = resolveRow(block, season, index, titles, duplicates);
      if (resolution.kind === 'nothing') continue;
      if (resolution.kind === 'skip') {
        // Reported only for a block in scope. Every row now reaches
        // `resolveRow`, so without this a sheet holding one title SIMKL no
        // longer lists would name it on every poll for the life of the sheet —
        // and a row that cannot be resolved has no tracked field to follow, so
        // the reach-back gains nothing by saying so.
        if (recent) plan.skips.push(resolution.skip);
        continue;
      }
      const resolved = resolution;

      const label = `${block.title} S${season.season ?? '?'}`;
      if (season.season !== null && idsFor(block, season).some((id) => (claims.get(`${id}:${season.season}`) ?? 0) > 1)) {
        if (recent) plan.skips.push({ code: 'duplicate-season', message: `${label}: more than one row describes this season, so neither is written` });
        continue;
      }

      // Before both the recency test and the dated-row test, and the only
      // thing that is: a row with an end date is otherwise finished, and a row
      // outside the activity window is otherwise untouched, but the fields that
      // follow SIMKL follow it through either.
      //
      // `Start` comes off the library and needs nothing else. `End` is only
      // eligible on a complete season, and a row resolved through the
      // catalogue takes that answer from there — so a dormant row that looks
      // like it has an `End` to move asks for the lookup that would settle it.
      // Without that ask the field is not merely skipped out here but frozen:
      // never eligible means never recorded, and a value never recorded can
      // never be seen to move. A cour row settles completeness from its own
      // counters and asks for nothing.
      follows.push({ write: (out) => followUpstream(out, follow, season, resolved, label) });
      // A move with nothing to write it from. `complete` already true means the
      // answer is in hand and `End` was eligible above; false out here means
      // the lookup nobody made for this dormant block, so ask for it.
      if (!recent && !wantsCompleteness && !resolved.complete && endMoved(season, resolved, follow)) {
        wantsCompleteness = true;
      }

      // The row's own signals, not the block's: a block is in scope as soon as
      // one of its seasons moves, and a row whose own count agrees with SIMKL
      // and whose watching is years old has nothing here to write. Nothing is
      // written on the record alone either — each cell below is compared
      // against what the row already holds.
      const dated = within(resolved.lastWatchedAt, cutoff);
      const moved = resolved.counts.some((count) => countMoved(count.id, count.season, count.watched, known));
      if (!recent || !(dated || moved)) continue;
      if (season.closed) continue;

      // Into a target rather than straight into the run's own plan: a row the
      // admission step has to reject is built first and dropped whole, so what
      // it planned — its edits, its demands and what it banked — must be
      // separable from what the run is keeping.
      const write = (out: WriteTarget): void => {
        // A hand-typed count — "12 (rewatch)", "~8" — parses to null, so the
        // comparison below would read it as 0 and plan an edit the guard
        // refuses unconditionally. Refusal is whole-plan, so one such cell
        // would stop every unrelated edit while the row stays inside the
        // activity window. Skipped here so the guard stays the backstop, and
        // the reason names the row instead of the planner.
        const existing = cellAt(grid, season.row, grid.columns.Episode);
        if (!isBlank(existing) && numberOf(existing) === null) {
          out.plan.skips.push({ code: 'non-numeric-count', message: `${label}: the ${SHOW_LABELS.Episode} cell holds something that is not a number, so the row is left alone` });
          return;
        }
        const advanced = resolved.watched > (season.episode ?? 0);
        if (advanced) {
          out.plan.edits.push(edit(grid, season.row, 'Episode', num(resolved.watched), `${label}: ${season.episode ?? 0} -> ${resolved.watched} episodes`));
          // Banked against the edit, one entry per SIMKL season the row's count
          // is made of. Recorded before the write lands, the next poll would
          // find the count unmoved and a row left open by a failed batch would
          // never be advanced again.
          for (const { key, watched } of resolved.counts) bank(out.keep, key, 'Watched', String(watched));
        }

        const closing = closeSeason(out, grid, block, season, resolved, index, titles, { label, timezone, ceiling: follow.ceiling });

        // Last, because what the note should say depends on whether this batch
        // dates the row — a row left open for another poll keeps carrying its
        // date, a row being closed hands the fact over to `End`.
        watchNote(out, grid, season, resolved.lastWatchedAt, { advanced, closing, label, timezone, ceiling: follow.ceiling });
      };

      // A row dated inside the window goes ahead of one in scope on the record
      // alone, and that is the whole of the difference between them: both are
      // admitted, and either can be held back when the poll's budgets are full.
      // The dated set is bounded by what was actually watched, so it drains in
      // one poll and putting an ordinary week's viewing behind a backfill is
      // what the priority prevents; the record-scoped set is the unbounded one,
      // since a library marked whole puts every row of every block in it at
      // once.
      if (dated) {
        watched.push({
          write,
          // Forgotten, not withdrawn: a dated row's stored count may already
          // agree with SIMKL's — a first sighting recorded it, or the count
          // landed on a poll whose close was still waiting — and a withdrawal
          // leaves a stored value standing. Held back on that, the row is in
          // scope only until its watch date leaves the window, and then
          // nothing brings it back; forgotten, `countMoved` does.
          defer: () => {
            for (const { key } of resolved.counts) forget(keep, key, 'Watched');
          },
        });
      } else {
        backlog.push({
          row: season.row,
          write,
          // The count must not be recorded at a figure the sheet never
          // received: the next poll would find it unmoved, and a record-scoped
          // row has no window to bring it back, so it would never be written at
          // all. Unconditional on the build having banked anything — a row this
          // poll never built banked nothing.
          defer: () => {
            for (const { key } of resolved.counts) withdraw(observed, key, 'Watched');
          },
        });
      }
    }

    // Earned by a row, not by the window. Asked for here rather than beside
    // the recency demand above because it takes a resolved row to know a
    // block wants it, and asking on suspicion alone would fetch the whole
    // sheet every poll.
    //
    // The same shape the recent half asks for, episode list *and* detail. The
    // completeness answer is in `shapes` alone, but `foldCatalogue` stamps by
    // id and not by which flags the request carried, so an episodes-only
    // fetch would leave a title stamped fresh with no `status` and no
    // `tvdbId` — and `needsLookup` would then decline the detail this same
    // block needs the moment it turns recent, since its own `lastWatchedAt`
    // never moved. One flag cheaper is not worth a stamp that lies.
    //
    // `sync.ts` drops a request the store answered inside `CATALOGUE_MAX_AGE`,
    // so a season that stays unsettled — dated here, incomplete upstream —
    // costs one call a day rather than one a poll.
    if (wantsCompleteness) {
      for (const id of block.ids) askDetail(run, { id, episodes: true, detail: true });
    }

    if (!recent) continue;

    // --- Status, and the season-row insert
    //
    // Both are driven by the block's status source, so both are declined when
    // that id is claimed by another row — the same rule `resolveRow` applies.
    // Without it one title's progress writes Status on two unrelated blocks
    // and plans a new row in each.
    const source = (sourceId === null ? null : index.get(sourceId)) ?? null;
    if (sourceId !== null && duplicates.has(sourceId)) {
      plan.skips.push({ code: 'duplicate-id', message: `${block.title}: id ${sourceId} is claimed by more than one row, so ${SHOW_LABELS.Status} and new rows are left alone` });
      // A hold, not a decision: the hand edit that unclaims the id is what
      // resolves this, and a membership move made while the sheet held two rows
      // for one title must still be a move on the poll after that edit.
      // `observeWatches` seeds this very field library-wide, so leaving it there
      // records a value the sheet never received.
      withdraw(keep.observed, titleRecordKey(sourceId), 'Status');
    } else if (source) {
      const entry = titles.get(source.id);
      /**
       * Whether this run has said its final word about the title's `Status`.
       *
       * The same absent-versus-settled distinction the runtime draws.
       * Outstanding, the field is withdrawn and the next poll sees the same
       * move; settled, it is recorded — a title on `hold` has no derived status
       * and never will, and withdrawing there would keep its block in scope,
       * and paying for a lookup a day, for ever.
       */
      const answered = detailAnswered(entry);
      const hold = (): void => {
        if (!answered) withdraw(keep.observed, titleRecordKey(source.id), 'Status');
      };
      // Which model applies is decided by where the ids sit, never by whether
      // data arrived. Anime asks its own not-aired counter: one entry is one
      // cour. A live-action block with no shapes is a *failed lookup*, not a
      // cour — read as one it would answer with a count spanning the whole
      // show rather than the latest season. So it declines to write; the
      // lookup failure already asks for another poll.
      if (!anime && !entry?.shapes.size) {
        plan.skips.push({ code: 'no-episode-list', message: `${block.title}: no episode list came back, so ${SHOW_LABELS.Status} is left alone` });
        // A failed lookup, whatever `tvdbId` says: the block cannot be read
        // without an episode list, so nothing here is settled and the retry the
        // failure armed has to find the move still standing.
        withdraw(keep.observed, titleRecordKey(source.id), 'Status');
      } else {
        const status = deriveStatus(source, {
          detailStatus: entry?.status,
          latestSeasonAiring: anime ? source.notAiredCount > 0 : latestSeasonAiring(entry?.shapes ?? new Map()),
        });
        if (status === null) hold();
        else if (status !== block.status) {
          // A candidate beside the block's watch-dated rows, and in the same
          // tier: a title's membership moving is the block-level form of a row
          // watched inside the window, and it is one cell on a row the rest of
          // the block may already be editing.
          watched.push({
            write: (out) => {
              out.plan.edits.push(edit(grid, block.row, 'Status', str(status), `${block.title}: ${block.status ?? '(blank)'} -> ${status}`));
              // What is recorded is SIMKL's own membership, not the cell's derived
              // word for it: the record answers "has this title moved since I
              // looked", and the cell is compared against separately. Banked, so a
              // status move whose batch never landed is still a move next poll.
              bank(out.keep, titleRecordKey(source.id), 'Status', source.status ?? NOT_HELD);
            },
          });
        }
      }

      // Anime is never inserted into, the same test the runtime write makes:
      // both put something into a row they cannot take back.
      const target = runtimeScopeOk(block) ? insertTarget(source, titles, cutoff, coveredSeasons(block), known) : null;
      if (target) {
        const { candidate, behind } = target;
        const chosen = seasonKey(source.id, candidate.season.number);
        // The row this walk cannot reach: the season being inserted has no
        // row yet, and one arriving complete is dated by the same fill that
        // creates it — so its runtime is demanded before the row exists. One
        // derivation serves the demand and the fill below.
        const runtime = insertRuntimeOf(candidate, titles);
        // Gated on *airing*, not watching: a finished season has settled
        // runtimes however little has been seen. A hard rule, not an
        // optimisation — `averageRuntime` checks TVDB's count against
        // SIMKL's, and mid-air SIMKL's has not settled, so the answer would
        // be a null recorded as *settled* in a map with no age ceiling,
        // forfeiting the cell before the season has even ended.
        if (candidate.aired && runtime.target && runtime.minutes === undefined) demand(run, { kind: 'runtimes', request: runtime.target });

        const insert = planInsert(grid, block, candidate, runtime, titles, { timezone, ceiling: follow.ceiling });
        if (insert && 'code' in insert) {
          plan.skips.push(insert);
          // The chosen season **and** the ones behind it: `insertableSeasons`
          // offers them lowest first, so a season the placement refused is one
          // every season behind it is waiting on. Recorded, the next poll would
          // find the whole tail unmoved and none of those rows would ever be
          // added.
          holdSeasons(keep, source.id, [candidate.season, ...behind]);
        } else if (insert) {
          inserts.push({
            label: `${insert.title} S${insert.season}`,
            write: (out) => {
              out.plan.insert = insert;
              // Banked only where the row lands finished. A row created with a
              // blank runtime cell something can still fill is one a later poll
              // has to close, and a record-scoped row leaves scope the moment its
              // count is recorded — so recording it here is the close never made.
              if (insert.waiting) withdraw(out.keep.observed, chosen, 'Watched');
              else bank(out.keep, chosen, 'Watched', String(candidate.season.watched));
              deferBehind(out.plan, out.keep, source.id, block.title, candidate.season.number, behind);
            },
            // The chosen season **and** the ones behind it, exactly as a
            // placement refusal holds them: a season this run does not add is
            // one every season behind it is still waiting on, and a count
            // recorded at a figure the sheet never received is a row the next
            // poll finds unmoved and never adds.
            defer: () => {
              withdraw(observed, chosen, 'Watched');
              deferBehind(plan, keep, source.id, block.title, candidate.season.number, behind);
            },
          });
        }
      }
    }
  }

  // --- Admission, in tier order ---------------------------------------------
  //
  // Everything the walk found, taken while the poll's budgets have room. The
  // order is the order the run would rather keep the work in, and it is decided
  // against the run's *real* cost rather than against however much of the grid
  // the walk happened to have reached by the time a row came up.

  // 1. The two fields that follow SIMKL. A move here is one no window brings
  //    back into scope, so held back it waits on nothing but another poll.
  admitTier(plan, follows, admit, (count) => `${count} row(s) whose start or end date moved wait for a later poll — ${room}`);

  // 2. The rows the activity window reaches, and the block statuses beside
  //    them: an ordinary week's viewing, which must not sit behind a backfill.
  admitTier(plan, watched, admit, (count) => `${count} row(s) watched recently wait for a later poll — ${room}`);

  // 3. The run's one insert. A season row joining a block that already exists
  //    is worth more than a block that can wait a poll, so the walk's
  //    candidates are offered before `planBlocks` below — and both cannot land
  //    together, because plan indices are pre-write and `insertDimension`
  //    applies cumulatively.
  //
  //    Every candidate past the first is deferred by that rule alone; the first
  //    is deferred only when the poll has no room left for a row. Not lost
  //    either way, but it must say so: a silent deferral reads exactly like a
  //    season the sync never noticed, the failure a report exists to rule out.
  const [ready, ...alsoReady] = inserts;
  if (ready !== undefined && !admit(ready.write)) {
    plan.deferred += 1;
    ready.defer?.();
    plan.notes.push(`${ready.label} is ready to add — deferred, ${room}`);
  }
  for (const other of alsoReady) {
    plan.deferred += 1;
    other.defer?.();
    plan.notes.push(`${other.label} is ready to add — deferred, one row is added per run`);
  }

  // Titles SIMKL knows with no row at all, which is the other shape tier 3
  // takes. It takes the slot only where no season row wanted it, and the room it
  // measures itself against is what tiers 1 and 2 have left.
  planBlocks(
    { grid, plan, demands, titles, cutoff, timezone, ceiling: follow.ceiling, showBucket, facts, factsRejected, budget: lookupBudget, rowsLeft, known, keep, maxRows },
    index,
    onGrid,
    filed,
  );

  // 4. The rows in scope on the record alone, in grid order so the same ones
  //    are taken every run until they land rather than a different arbitrary
  //    subset each poll. Last because the set is unbounded: a library marked
  //    whole puts every row of every block in it at once, and nothing here ages
  //    out of scope the way a watch date does.
  backlog.sort((a, b) => a.row - b.row);
  admitTier(plan, backlog, admit, (count) => `${count} row(s) whose counts moved wait for a later poll — ${room}`);

  return { plan, demands, observed, writing, forgetting };
};

/**
 * What a new season row holds, and the three facts a caller's note is written
 * from. One derivation for both inserts: a season row created on its own and
 * the one created underneath a new show row are the same row, so a second copy
 * of these six cells is a second set of answers free to disagree.
 */
interface SeasonFill {
  cells: Array<{ field: HeaderName; value: ExtendedValue }>;
  /** The serial this fill dates the row with, null where it leaves the row open. */
  end: number | null;
  /** The minutes written into the runtime cell, null where the cell goes in blank. */
  runtime: number | null;
  /** Whether anything can still reach a blank runtime cell. */
  waiting: boolean;
  /** Whether the row is complete and undated because its last-watch stamp names no day the sync writes. */
  endUnusable: boolean;
  /**
   * Whether a later poll still has to close this row — either of the two
   * above. What the count decision reads: a row that lands open withdraws its
   * count, because a record-scoped row leaves scope the moment its count is
   * recorded and the poll that could close it would never look at the row
   * again.
   */
  open: boolean;
}

/**
 * The cells a season row is created with, or null where SIMKL's first-watch
 * timestamp names no day the sync writes. A row dated from an epoch stamp is
 * worse than no row, and there is nothing to fall back to.
 */
const seasonCells = (
  { season: candidate, aired, complete }: InsertCandidate,
  { target, minutes, detailed }: InsertRuntime,
  entry: TitleCatalogue | undefined,
  timezone: string,
  ceiling: number,
): SeasonFill | null => {
  const start = watchSerial(candidate.firstWatchedAt, timezone);
  // Bounded here, not only in the guard, for the reason `followUpstream` gives:
  // refusal is whole-plan, so one season SIMKL stamps in 1994 would hold up
  // every unrelated edit on every poll for as long as its title stayed in
  // scope — and a row in scope on the record alone has no window to age out of.
  if (start === null || !plausibleSerial(start, ceiling)) return null;

  // What this row's runtime cell can hold, and whether this fill may date the
  // row. A row created and dated in one batch is never revisited, so its
  // `Runtime` cell has one chance to be right.
  //
  // The runtime follows *airing*; the date below follows watching. A season
  // one episode into a finished run has settled lengths and no business being
  // dated — two different answers about the same row.
  //
  // Left blank only while something can still fill it: a season still airing
  // waits for the batch that closes the row, because a filled cell is one the
  // close can never correct. With no join key there is nothing to wait for,
  // so the show-wide runtime is the best there will ever be.
  const runtime =
    target === null ? runtimeMinutes(entry?.runtime)
    : !aired ? null
    // Settled, either way. `runtimeMinutes` also rejects an average that is not
    // a length an episode has, and the show-wide number beats a cell nothing
    // can ever fill again.
    : minutes !== undefined ? (runtimeMinutes(minutes) ?? runtimeMinutes(entry?.runtime))
    : null;

  // Whether anything can still reach this cell — a fact about the runtime
  // alone, so not bundled with the watching below. Dating the row while this
  // is open would freeze a blank cell, and the date is not lost by waiting:
  // the next poll writes the identical serial with the runtime beside it.
  //
  // Two ways to be waiting. An absent `tvdbId` is the detail call not having
  // answered; null is it answering "no key". Reading a failed lookup as a
  // settled "no key" dates the row on a 503 — the same absent-versus-settled
  // distinction `runtimeAnswer` draws for an existing row.
  const waiting = !detailed || (target !== null && minutes === undefined);
  const endSerial = complete && !waiting ? watchSerial(candidate.lastWatchedAt, timezone) : null;
  // A date the row is closed with for good, so it is bounded like the start —
  // but dropped rather than refusing the fill. The start is what the row
  // stands on; the end is a cell the close path writes on any later poll, and
  // that path already holds a row open over an unusable last-watch stamp, with
  // a skip naming it, until SIMKL's stamp is corrected. Refused here instead,
  // one season stamped past tomorrow would keep a fifteen-season block off the
  // tab for as long as the stamp stood, under a skip blaming the first watch.
  const endUnusable = endSerial !== null && !plausibleSerial(endSerial, ceiling);
  const end = endUnusable ? null : endSerial;
  // The same rule the per-row path applies, so a row is never created in a
  // state that path would immediately have to correct: an open row carries its
  // last-watched date, a dated one leaves `End` to say it.
  // Dropped rather than refusing the row: the note is a convenience on an open
  // row and `End` will say the same thing more precisely later, where a start
  // date out of range leaves the row with nothing to stand on.
  const noteText = end === null ? watchedNote(candidate.lastWatchedAt, timezone) : null;
  const note = plausibleSerial(watchedNoteSerial(noteText), ceiling) ? noteText : null;

  return {
    cells: [
      { field: 'Season', value: num(candidate.number) },
      { field: 'Episode', value: num(candidate.watched) },
      { field: 'Start', value: num(start) },
      ...(note === null ? [] : [{ field: 'Note' as const, value: str(note) }]),
      ...(runtime === null ? [] : [{ field: 'Runtime' as const, value: num(runtime) }]),
      ...(end === null ? [] : [{ field: 'End' as const, value: num(end) }]),
    ],
    end,
    runtime,
    waiting,
    endUnusable,
    open: waiting || endUnusable,
  };
};

/**
 * A season SIMKL says was watched and the block has no row for.
 *
 * Live-action only, whole seasons only. A fractional label — Doctor Who's
 * `13.5`, Attack On Titan's `1.5` — encodes a judgement no rule here could
 * reproduce, and SIMKL's season 0 is specials.
 */
const planInsert = (
  grid: Grid,
  block: ShowBlock,
  candidate: InsertCandidate,
  runtime: InsertRuntime,
  titles: Map<number, TitleCatalogue>,
  { timezone, ceiling }: { timezone: string; ceiling: number },
): RowInsert | Skip | null => {
  const { season, complete } = candidate;
  const label = `${block.title} S${season.number}`;

  const filled = seasonCells(candidate, runtime, titles.get(candidate.source.id), timezone, ceiling);
  if (filled === null) return { code: 'unusable-timestamp', message: `${label}: would be added, but its first watch timestamp is unusable` };

  // Keep Season ascending: before the first existing row with a higher
  // number, or after the last one.
  const whole = block.seasons.filter((s) => s.season !== null && Number.isInteger(s.season));
  const after = whole.find((s) => (s.season as number) > season.number);
  const row = after ? after.row : blockEnd(block) + 1;

  // inheritFromBefore takes formats from the row *immediately* above, so that
  // is the row the question is about: `parseGrid` keeps a block open across an
  // all-blank or id-only spacer row, and a season row anywhere above it carries
  // no formats to a row landing under the spacer — a correct date serial
  // renders as `46265`.
  if (!block.seasons.some((s) => s.row === row - 1)) {
    return { code: 'no-format-row', message: `${label}: would be added, but there is no season row above the insertion point to inherit formats from` };
  }

  return {
    kind: 'season',
    row,
    rows: 1,
    title: block.title,
    season: season.number,
    waiting: filled.open,
    fill: filled.cells.flatMap(({ field, value }) => fillCell(grid, row, field, value, `${label}: new row`) ?? []),
    note: `${label}: new season row at ${row + 1}, ${season.watched} episodes${filled.end === null ? '' : ', ended'}${blankRuntimeNoteOf(filled, complete)}`,
  };
};

/**
 * Why a new season row's runtime cell went in blank, where that is not simply
 * "the season is still running". A row whose runtime nothing can supply is the
 * one a reader must finish by hand, so it says so rather than leaving an empty
 * cell to be noticed.
 */
const blankRuntimeNoteOf = ({ end, runtime, waiting, endUnusable }: SeasonFill, complete: boolean): string =>
  endUnusable ? ', added open — its last watch timestamp is unusable, so it is left for the close to date'
  : complete && end === null ? ', added open — its episode runtimes have not come back'
  // Blank with nothing outstanding is blank for good, dated or not: no join
  // key, or the key's answer is in and unusable. A row still waiting is not
  // this, and says nothing.
  : runtime === null && !waiting ? `, with no episode runtime to fill its ${SHOW_LABELS.Runtime} cell`
  : '';

// --- The block the tab does not have yet -------------------------------------

/** The note a title with no row gets when no block can be built for it. */
const missingRowNote = (progress: TitleProgress): string =>
  `${labelOf(progress.title, progress.id)} has recent activity and no row — add it by hand if you want it tracked`;

/**
 * How every line about a block names the show: the title the row would carry
 * and the id the row would be matched by, because a title alone is ambiguous
 * exactly where this walk declines — two shows the tab files under one name.
 */
const labelOf = (title: string, id: number): string => `${title} (simkl ${id})`;

/** Everything the block walk reads that does not vary between candidates. */
interface BlockContext {
  grid: Grid;
  plan: SheetPlan;
  demands: PlanDemands;
  titles: Map<number, TitleCatalogue>;
  cutoff: Temporal.Instant;
  timezone: string;
  /** Tomorrow in the viewer's zone — the bound every serial a block writes is checked against, `maxSerial`. */
  ceiling: number;
  showBucket: string | null;
  facts: { tvdb: boolean; tmdb: boolean };
  factsRejected: ReadonlySet<FactsCredential>;
  budget: LookupBudget;
  /**
   * How many more distinct rows the poll may touch, counted the way the guard
   * counts them — `rowsRemaining`, the one derivation, so a block cut to it is
   * a block the guard admits. A function rather than a number: the block walk
   * runs once the tiers ahead of it have been admitted, and what a block has
   * room for is what the plan looks like by then.
   */
  rowsLeft: () => number;
  /** What SIMKL last said, read as the two questions the window cannot answer. */
  known: Known;
  /** Where this walk banks what a block writes, and withdraws what it leaves for a later run. */
  keep: Recording;
  /**
   * `SHEET_MAX_ROWS`, which bounds how tall a block may be. A block lands whole
   * or not at all, so a taller one is not trimmed at the guard, it is refused —
   * and refusal is whole-plan.
   */
  maxRows: number;
}

/**
 * Leave this title for a later run: nothing of what a block would write is
 * recorded, so the run that can build it still sees a title that has never been
 * seen and seasons whose counts have never been observed.
 *
 * Called once, at the top of the walk, so **withdrawal is the default** and only
 * an exit that has said its final word has to say anything. The exits are many
 * and the ones that come back are most of them; defaulted the other way, a new
 * exit added without a withdrawal beside it silently records a title the run
 * could not build, and the run that finally can walks past it.
 */
const withdrawBlock = ({ keep }: BlockContext, progress: TitleProgress): void => {
  const { title, seasons } = titleObservations(progress);
  withdraw(keep.observed, title.key, 'Status');
  for (const season of seasons) withdraw(keep.observed, season.key, 'Watched');
};

/**
 * Put back what the withdrawal above took: this run has said its final word
 * about the title, and nothing a later poll does will change the answer.
 *
 * The title is on the wrong tab, the tab already holds that name, SIMKL holds no
 * join key. Left withdrawn, each of those notes would be said on every poll for
 * the life of the sheet, and the title would stay in scope for a lookup a day.
 *
 * Only the two fields the withdrawal took. `Start` and `End` are
 * `followUpstream`'s and are still in the seed exactly as `observeWatches` put
 * them there.
 */
const recordBlock = ({ keep }: BlockContext, progress: TitleProgress): void => {
  const { title, seasons } = titleObservations(progress);
  const put = (key: string, field: string, value: string): void => void keep.observed.set(key, { ...keep.observed.get(key), [field]: value });
  put(title.key, 'Status', title.entry.Status as string);
  for (const season of seasons) put(season.key, 'Watched', season.entry.Watched as string);
};

/**
 * The earliest episode of any season this title has a watch date for. What
 * candidates are ordered by, so the sheet gains blocks in the order the shows
 * were started rather than in library order — and so two runs of the same
 * library choose the same block.
 */
const firstWatch = (progress: TitleProgress): Temporal.Instant | null =>
  [...progress.seasons.values()].reduce<Temporal.Instant | null>(
    (earliest, season) =>
      season.firstWatchedAt !== null && (earliest === null || Temporal.Instant.compare(season.firstWatchedAt, earliest) < 0)
        ? season.firstWatchedAt
        : earliest,
    null,
  );

const byFirstWatch = (a: TitleProgress, b: TitleProgress): number => compareWatched(firstWatch(a), firstWatch(b), a.id - b.id);

/**
 * A candidate every question has been answered for: the row it needs, the
 * upstream facts its cells are written from, and nothing left absent. Stated as
 * a type rather than re-derived inside `buildBlock`, so the qualifying walk
 * cannot hand it a title still waiting on a lookup.
 */
interface BlockReady {
  progress: TitleProgress;
  /** Answered on both cells only an upstream can fill — null there is settled-with-nothing, which lands the block blank. */
  entry: TitleCatalogue & { genres: string[] | null; certificate: number | null };
  /** What the `Show` cell is written with, and the key the collision test was decided on. */
  title: string;
  /**
   * Every season a row is created for, ascending, each with the runtime answer
   * its row is written from. Never empty: a block with no season row is a block
   * whose roll-ups read the next block's rows.
   */
  rows: Array<{ candidate: InsertCandidate; runtime: InsertRuntime }>;
}

/**
 * Where a block goes and what it holds: a show row, a season row for each
 * season the title needs, sixteen columns, and every one of them written once
 * and revisited by nothing.
 *
 * Qualify then build, the shape `planInsert` has. Both placement refusals and
 * the unusable timestamp come back as a `Skip` rather than being pushed from
 * in here, so the walk above keeps its one rule that every exit reports once.
 */
const buildBlock = (ctx: BlockContext, seasonRows: ReadonlySet<number>, { progress, entry, title, rows }: BlockReady): BlockInsert | Skip => {
  const { grid } = ctx;
  const first = rows[0] as { candidate: InsertCandidate; runtime: InsertRuntime };
  const label = labelOf(title, progress.id);
  // Named by its first season everywhere a refusal is read: the block is placed
  // and formatted as one thing, so every one of these answers the same for all
  // of its rows.
  const seasonLabel = `${label} S${first.candidate.season.number}`;
  const height = 1 + rows.length;

  // Franchise order, which is the tab's own order.
  const franchise = franchiseKeyFor(title);
  const row = placeBlock(grid.blocks, franchise);
  if (row === null) {
    return { code: 'no-format-row', message: `${seasonLabel}: would be added, but the tab holds no block to place it against` };
  }
  // Room in the declared grid, for every row of the span and for the window its
  // roll-ups read. The block-height helper is
  // `OFFSET(<Show cell>, 1, 0, BLOCK_SCAN_ROWS)`, and Sheets answers `#REF!`
  // for a window running past the last row of the tab — so a block landing
  // nearer than that to the end carries five roll-ups that error, VERIFY's
  // error-value pass finds them, and the write is rolled back on every poll
  // for as long as the tab stays that size.
  //
  // Declined here rather than left to the guard, the films half's rule: a
  // guard refusal is whole-plan, so a tab with no room would stop every edit
  // on every other row, every poll — and a full tab is a standing state until
  // someone extends it. A last block added by hand has the same exposure, and
  // a person reading `#REF!` in the cell fixes it, where this would retry in
  // silence.
  //
  // The window the helper names is rows `row + 1` through
  // `row + BLOCK_SCAN_ROWS`, so the strict bound is one row below this one —
  // and `insertDimension` grows the grid by the whole span, which is that many
  // more. Slack in the only direction that cannot produce a `#REF!`.
  if (row + height + BLOCK_SCAN_ROWS > grid.snapshot.rowCount) {
    return {
      code: 'no-room',
      message: `${seasonLabel}: would be added at row ${row + 1}, but the tab declares only ${grid.snapshot.rowCount} rows and a block's roll-ups read ${BLOCK_SCAN_ROWS} rows below its show row; add rows to the tab`,
    };
  }
  // `inheritFromBefore` takes formats from the row above, and a block sorting
  // first would take the *header* row's: a correct date serial renders as
  // `46265`. The same rule the season insert applies one row down.
  if (!seasonRows.has(row - 1)) {
    return {
      code: 'no-format-row',
      message: `${seasonLabel}: would be added at row ${row + 1}, but there is no season row above it to inherit formats from`,
    };
  }

  // Each season row is `seasonCells`' — the same six a season insert writes,
  // because it is the same row. One unusable first-watch timestamp refuses the
  // whole block rather than dropping its row: the rows are contiguous and the
  // roll-ups above them count a fixed window, so a block missing a row in the
  // middle is one no later run would fill, since nothing revisits a show row.
  const filled: SeasonFill[] = [];
  for (const { candidate, runtime } of rows) {
    const cells = seasonCells(candidate, runtime, entry, ctx.timezone, ctx.ceiling);
    if (cells === null) {
      return {
        code: 'unusable-timestamp',
        message: `${label} S${candidate.season.number}: would be added, but its first watch timestamp is unusable`,
      };
    }
    filled.push(cells);
  }
  const firstFill = filled[0] as SeasonFill;

  const { genres, certificate } = entry;
  const status = deriveStatus(progress, { detailStatus: entry.status, latestSeasonAiring: latestSeasonAiring(entry.shapes) });
  const formulas = showRowFormulas(grid.columns, row);
  const secondary = genres === null ? '' : genresCell(genres.slice(1, 1 + MAX_SECONDARY_GENRES));
  const note = `${label}: new block`;

  const showRow: Array<{ field: ShowField; value: ExtendedValue }> = [
    { field: 'Show', value: str(title) },
    { field: 'Franchise', value: str(franchise) },
    { field: 'Type', value: str(SHOW_TYPE) },
    // Text, matching all 189 show rows. A number here compares unequal to
    // every other id cell, so a later run would not recognise its own block.
    { field: 'id', value: str(String(progress.id)) },
    // The five cells that roll up from the season rows beneath them, and the
    // one exception to never writing a formula: this batch writes the formula
    // that does the rolling up, and nothing revisits the cell afterwards.
    ...ROLLUP_FIELDS.map((field) => ({ field, value: { formulaValue: formulas[field] } })),
    ...(ctx.showBucket === null ? [] : [{ field: 'Banner' as const, value: { formulaValue: artworkFormula(grid.columns.Show, row, ctx.showBucket) } }]),
    ...(status === null ? [] : [{ field: 'Status' as const, value: str(status) }]),
    // The first survivor of TVDB's own ordering is the primary and the next
    // three the secondaries. An empty `Genres` is omitted rather than written
    // blank, the way the films insert omits it.
    ...(genres === null || genres[0] === undefined ? [] : [{ field: 'Genre' as const, value: str(genres[0]) }]),
    ...(secondary === '' ? [] : [{ field: 'Genres' as const, value: str(secondary) }]),
    ...(entry.network ? [{ field: 'Network' as const, value: str(entry.network) }] : []),
    ...(certificate === null ? [] : [{ field: 'Certificate' as const, value: num(certificate) }]),
  ];

  return {
    kind: 'block',
    row,
    id: progress.id,
    title,
    franchise,
    seasons: rows.map(({ candidate }) => candidate.season.number),
    waiting: rows.flatMap(({ candidate }, offset) => ((filled[offset] as SeasonFill).open ? [candidate.season.number] : [])),
    fill: [
      // Every column here resolved before the walk reached this candidate, or
      // is one of the required ten, so nothing is dropped. `fillCell` answering
      // null is what keeps that a fact rather than an assumption — and the
      // guard requires each of the nine cells a show row cannot do without, so
      // a dropped one is refused rather than written.
      ...showRow.flatMap(({ field, value }) => fillCell(grid, row, field, value, note) ?? []),
      ...filled.flatMap((season, offset) =>
        season.cells.flatMap(({ field, value }) => fillCell(grid, row + 1 + offset, field, value, note) ?? []),
      ),
    ],
    // The first season in full, the rest counted: a block of fifteen rows would
    // otherwise put fifteen lines into a report read beside the sheet, where
    // the rows themselves already say what they hold.
    note: `${label}: new block at rows ${row + 1}-${row + height}, S${first.candidate.season.number} with ${
      first.candidate.season.watched
    } episodes${firstFill.end === null ? '' : ', ended'}${blankRuntimeNoteOf(firstFill, first.candidate.complete)}${
      rows.length === 1 ? '' : `, and ${rows.length - 1} more season row(s)`
    }`,
  };
};

/**
 * Titles SIMKL knows that the tab has no row for: a block for the first TV
 * show that can have one, and a note for every other.
 *
 * **TV only.** An anime block uses the cour model — a new cour is a separate
 * SIMKL title under a romaji name that mostly does not match what the sheet
 * calls the series — so a block inserted for one would duplicate a series
 * already filed as season N of an existing block. Title matching is unreliable
 * enough that this must never try, which is what keeps the hand-written note.
 *
 * Every exit reports once, and the order of the exits is the rule: a title held
 * back by a collision is not also reported as waiting on TVDB, and a run with
 * no credential says so once rather than once per show.
 *
 * **What a title's own record decides here.** A block is triggered by a row
 * being absent, so nothing it writes is measured against the baseline — but
 * whether the walk reaches the title at all is, and that means the walk has to
 * say what it has decided. **Withdrawal is the default**: every candidate is
 * withdrawn as the loop reaches it, and only an exit with a final word puts the
 * title back through `recordBlock` — the title is on the wrong tab, the tab
 * already holds that name, SIMKL holds no join key. Everything else expects to
 * come back, so the run that can build the block still sees an unseen title.
 * `writing` gains the title's `Status` and each inserted season's count only
 * where the block is actually planned, and only for a row that lands finished.
 */
const planBlocks = (ctx: BlockContext, index: Map<number, TitleProgress>, seen: Set<number>, filed: Set<number> | undefined): void => {
  const { plan, grid, titles, cutoff, known, keep } = ctx;

  const candidates: TitleProgress[] = [];
  for (const progress of index.values()) {
    if (seen.has(progress.id)) continue;
    // Something has been watched of it. Without this a `plantowatch` title
    // would qualify on `titleIsNew` alone, and every show on the watchlist
    // would be reported as a missing row on the first poll that knows what a
    // new title is.
    //
    // Neither test alone answers. The counter is zero on an anime *film*, which
    // this half indexes because 20 of them sit on show-tab rows, and the date is
    // what says one was watched; the date is null on a show watched only in
    // specials, which `seasonsOf` drops, and the counter is what says so. Both
    // reach the note below — a title with no season a row could be for is
    // exactly what it reports.
    if (progress.watchedCount === 0 && progress.lastWatchedAt === null) continue;
    const watched = watchedSeasons(progress);
    // Watched inside the window, or moved since this sync last looked. The
    // second is what puts a back catalogue on the tab at all: marking a 2005
    // show watched today stamps its episodes at their air dates, so its
    // `lastWatchedAt` is two decades out and the block it should gain would
    // never be walked for.
    const moved =
      within(progress.lastWatchedAt, cutoff) ||
      titleIsNew(progress.id, known) ||
      watched.some((season) => countMoved(progress.id, season.number, season.watched, known));
    if (!moved) continue;
    // An anime film with no block is not missing a row: the films tab holds it,
    // and this half still indexes it because 20 of them sit on show-tab rows.
    if (filed?.has(progress.id)) continue;
    if (progress.type !== 'shows') {
      plan.notes.push(missingRowNote(progress));
      continue;
    }
    candidates.push(progress);
  }
  // Nothing to walk, and nothing the walk would have said: both credential
  // notes below count candidates, so with none they are zero.
  if (candidates.length === 0) return;
  candidates.sort(byFirstWatch);

  const seasonRows = new Set(grid.blocks.flatMap((block) => block.seasons.map((season) => season.row)));

  // The first block on the tab under each title key — `find`'s answer, asked
  // once for the whole walk. First and not last: the note names the row that
  // holds the title, and a second row under the same name is a duplicate the
  // reader sorts out, not a row this can prefer.
  const holders = new Map<string, ShowBlock>();
  for (const block of grid.blocks) {
    const key = titleKey(block.title);
    if (!holders.has(key)) holders.set(key, block);
  }

  // The columns a show row is written into, and which of them the tab does not
  // carry. Optional by design — the artwork page parses a Shows tab with no
  // Franchise column at all — so an unresolved one declines every block rather
  // than failing the parse. A fact about the header row, so it is asked once:
  // the answer is identical for every candidate, and so is the note.
  const unresolved = BLOCK_HEADERS.filter((field) => field !== 'Banner' || ctx.showBucket !== null).filter(
    (field) => grid.fields[field] === undefined,
  );

  let notedColumns = false;
  let awaitingCredential = 0;
  let awaitingFixedCredential = 0;

  for (const progress of candidates) {
    // Withdrawn first, put back only by an exit with a final word. Most of the
    // exits below expect to come back, and a run that recorded what it could not
    // build would leave the run that can walking past a title it has already
    // seen with counts it has already observed.
    withdrawBlock(ctx, progress);
    const entry = titles.get(progress.id);
    // SIMKL's own title where the detail has answered, the library's until
    // then — 166 of 189 exact against the tab, 183 ignoring case and a leading
    // article. Both are normalised the same way, so the cell and the key below
    // cannot disagree about which show this is.
    const title = titleCell(entry?.title ?? progress.title);
    const label = labelOf(title, progress.id);

    // 1. A block that already holds this title. **Both keys**, because the two
    //    are decided a pass apart: the library title is all the first pass has,
    //    and the detail's may differ by a `(US)` suffix or a leading article.
    //    The guard re-derives the collision against the title actually written,
    //    so one only the planner's later key sees would pass here and refuse
    //    the whole plan there.
    //
    //    Never matched the other way round: the sync refuses to duplicate a
    //    title, and never *attaches* itself to a row by name.
    //    The lower row of the two answers, because a `find` over the tab would
    //    have stopped at the first block matching either.
    const holder = [holders.get(titleKey(progress.title)), holders.get(titleKey(title))]
      .filter((block): block is ShowBlock => block !== undefined)
      .sort((a, b) => a.row - b.row)[0];
    if (holder) {
      const ids = blockIds(holder);
      if (ids.length === 0) {
        plan.skips.push({
          code: 'unlinked-block',
          message: `${label}: row ${holder.row + 1} holds that title and no id; type the id to link it`,
        });
        // The hand edit that links the row is what resolves this, and it moves
        // nothing SIMKL says — so this exit keeps the withdrawal.
      } else {
        // A final word: the tab holds this title under an id of its own, and no
        // poll changes that. Recorded, so the note is said once.
        plan.notes.push(`${label}: row ${holder.row + 1} already holds that title under id ${ids.join(', ')}, so no block is added`);
        recordBlock(ctx, progress);
      }
      continue;
    }

    // 2. Which seasons the block's rows would be for. No rows yet, so nothing
    //    is covered and every watched season the window or the record reaches
    //    qualifies, lowest first.
    //
    //    Asked before any lookup, because no lookup changes it: the seasons are
    //    a projection of the library and the record alone. A title with nothing
    //    to insert is one whose recent watching is all specials — reported the
    //    way a title on the wrong tab is, and costing no request a poll for a
    //    detail nothing would use.
    const wanted = insertableSeasons(progress, cutoff, new Set(), known, titleIsNew(progress.id, known));
    const [chosen] = wanted;
    if (chosen === undefined) {
      // A final word: nothing this title has watched is a season a row could be
      // for, and no lookup changes that.
      plan.notes.push(missingRowNote(progress));
      recordBlock(ctx, progress);
      continue;
    }

    // 3. A column a show row needs that the tab does not carry, resolved above.
    //    One note per run, because one note is all there is to say.
    if (unresolved.length) {
      if (!notedColumns) {
        notedColumns = true;
        plan.notes.push(`a new show block needs ${unresolved.map((field) => SHOW_FIELD_LABELS[field]).join(', ')} on the tab, so none is added`);
      }
      continue;
    }

    // 4. The two credentials, before any lookup is asked for: a block needs
    //    both upstreams to answer, so either being unset holds every candidate
    //    back — counted and named once, because what the operator can do about
    //    it is one thing and not one thing per show — and a SIMKL detail fetched
    //    for a block nothing can build is a request a day per show for nothing.
    if (!ctx.facts.tvdb || !ctx.facts.tmdb) {
      awaitingCredential += 1;
      continue;
    }
    // A rejection is a fact about the token, not about any series, and both
    // keys are read at start-up — so nothing is demanded and nothing is
    // settled: the fix arrives with a restart.
    if (ctx.factsRejected.size) {
      awaitingFixedCredential += 1;
      continue;
    }

    // The slot. One insert per run, and the season rows of blocks that already
    //    exist are planned before this walk, so a taken slot is known here.
    //    Every block behind it defers before asking for anything: the lookups
    //    it needs are the next run's — fetched now, every pass to the ceiling
    //    would spend another round on rows this run cannot add — and the
    //    deferral is what arms the retry that brings that run soon rather than
    //    on the library's next move. Not lost, but it must say so: a silent
    //    deferral reads exactly like a show the sync never noticed.
    if (plan.insert !== null) {
      plan.deferred += 1;
      plan.notes.push(`${label}: a block waits for the next run — one insert is added per run`);
      continue;
    }

    // 5. What SIMKL holds. Both ids arrive on the same detail response, so
    //    either being absent is that call not having answered — the state the
    //    store leaves until `/tv/{id}` lands, and the one that must not be read
    //    as "no id", which would tell the operator to add by hand a block a
    //    poll would build.
    //
    //    Capped at `CATALOGUE_ASKS_PER_PASS`, the pass's own allowance, which
    //    the grid walk above shares: this list is the unbounded direction — one
    //    unlisted title per request, several hundred of them, inside a run whose
    //    snapshot goes stale at 120s. Only the *unanswered* asks count against
    //    it. An answered title's demand is one `sync.ts` drops inside
    //    `CATALOGUE_MAX_AGE`, and counting those would let a handful of
    //    settled-but-unbuildable titles sorted ahead — no TVDB id, no episode
    //    list — spend the whole allowance on every pass and starve every title
    //    behind them for good.
    const detailed = detailAnswered(entry);
    demand(ctx, { kind: 'detail', request: { id: progress.id, episodes: true, detail: true } }, { charge: !detailed });
    if (!detailed) {
      plan.skips.push({ code: 'awaiting-lookup', message: `${label}: waiting on SIMKL's detail before a block can be added` });
      continue;
    }
    // A live-action title with no episode list is a failed lookup, not a show
    // with no episodes: read as one, its season row would be inserted with a
    // count and a status derived from nothing.
    if (!entry.shapes.size) {
      plan.skips.push({ code: 'no-episode-list', message: `${label}: no episode list came back, so no block is added` });
      continue;
    }

    // 6. The join keys themselves. Null is SIMKL answering that it holds
    //    none, which no poll changes, so the block is named once as one to add
    //    by hand rather than waited on forever.
    const { tvdbId, tmdbId } = entry;
    if (tvdbId === null || tmdbId === null) {
      const noKey = [...(tvdbId === null ? ['TVDB'] : []), ...(tmdbId === null ? ['TMDB'] : [])];
      plan.notes.push(`${label} has no ${noKey.join(' or ')} id, so its block has to be added by hand`);
      recordBlock(ctx, progress);
      continue;
    }

    const seasonLabel = `${label} S${chosen.number}`;

    // 7. Everything the detail unlocks, asked for in one pass: the two cells
    //    only TVDB and TMDB can fill, and the season's episode runtimes. All
    //    three need only the join keys the detail carried, so demanding them
    //    together keeps a block to three planning passes — catalogue, then
    //    these, then the plan — where asking for the runtime only after the
    //    genres answered would spend the fourth, and the ceiling's whole
    //    headroom, on a dependency that does not exist.
    //
    //    For the cells, absent is unanswered and the block waits; null is
    //    answered-with-nothing, which lands the block with that cell blank —
    //    the same absent-versus-settled distinction `runtimeAnswer` draws, and
    //    for the same reason: every cell on a show row is written once, so
    //    closing one on a 503 forfeits it for good.
    //
    //    The runtime is demanded exactly as a season insert demands one —
    //    gated on *airing*, since a mid-air season's SIMKL count has not
    //    settled and `averageRuntime` checks TVDB's against it. Unlike a season
    //    insert, an unanswered runtime holds the **block** back rather than
    //    landing the row open. A season row inserted into an existing block is
    //    revisited by the per-row path, which fills the cell when the row
    //    closes; the show row above it is not revisited at all, so a block is
    //    built in one batch or not at all, and waiting a poll costs nothing
    //    but the poll.
    //
    //    Each of the three goes through `demand` and is charged against the
    //    attempt's allowance, which `runtimes` shares with the season path. The
    //    two are counted together because the season path is the volume side
    //    once a record's disagreement can put every row of a marked-whole
    //    library in scope at once and keep it there; what sharing costs is a
    //    burst of closing rows delaying one block's runtime by a poll, and one
    //    block lands per run anyway. The skip below is unconditional on the
    //    push: a block waits for its runtime whether or not this pass had an
    //    ask left to spend on it.
    //
    //    Per season, and the block is **cut** at the first one still waiting
    //    rather than held whole for all of them. A back catalogue of fifteen
    //    seasons wants fifteen answers where one attempt's allowance is eight,
    //    so a block held for every season would never land at all; cut, it
    //    lands with the seasons in hand and the rest arrive as ordinary season
    //    inserts, which `countMoved` finds again because their counts were
    //    never recorded. Cut at the first, not filtered: the rows are
    //    contiguous and a gap in the middle is one only a hand edit could fill.
    //
    //    Cut rather than landed open, too. A season row inside a block is
    //    revisited only while its title is in scope, and a record-scoped title
    //    leaves scope the moment its counts are recorded — so a row landing open
    //    inside a block that recorded the rest would be a row no later poll
    //    closes. What is cut off keeps its count unrecorded and comes back as an
    //    ordinary season insert.
    const answered: Array<{ candidate: InsertCandidate; runtime: InsertRuntime }> = [];
    // Whether this run *asked* for the answer it is waiting on. Unasked is work
    // the run chose not to do, which is the claim a deferral makes and what arms
    // the retry that brings the poll with a fresh allowance; asked and
    // unanswered drains inside this run's own fixpoint, and a lookup that failed
    // arms the retry through `made.failures` instead.
    let unasked = false;
    for (const season of wanted) {
      const candidate = candidateOf(progress, season, titles);
      const runtime = insertRuntimeOf(candidate, titles);
      if (candidate.aired && runtime.target !== null && runtime.minutes === undefined) {
        unasked = !demand(ctx, { kind: 'runtimes', request: runtime.target });
        break;
      }
      answered.push({ candidate, runtime });
    }

    const { genres, certificate } = entry;
    if (genres === undefined || certificate === undefined) {
      if (genres === undefined) demand(ctx, { kind: 'genres', request: { id: progress.id, tvdbId } });
      if (certificate === undefined) demand(ctx, { kind: 'certificates', request: { id: progress.id, tmdbId } });
      const waitingOn = [...(genres === undefined ? ['TVDB'] : []), ...(certificate === undefined ? ['TMDB'] : [])];
      plan.skips.push({ code: 'awaiting-lookup', message: `${label}: waiting on ${waitingOn.join(' and ')} before a block can be added` });
      continue;
    }
    // Nothing answered yet is the state a one-season block has always been held
    // in: the block waits whole, because there is no row it could land with.
    if (answered.length === 0) {
      // The season waiting is the first of `wanted`, which is the one
      // `seasonLabel` already names: the loop above breaks at the first
      // unanswered runtime, so answering none means it broke on the first.
      plan.skips.push({
        code: 'awaiting-runtimes',
        message: `${seasonLabel}: waiting on its episode runtimes before a block can be added`,
      });
      if (unasked) plan.deferred += 1;
      continue;
    }

    // 8. The block itself, now that every question it turns on is answered.
    //    `entry` is respelled with the two answers in it, which is what
    //    `BlockReady` asks for: the checks above narrowed the locals and not
    //    the record they came off, and a `buildBlock` free to read them as
    //    absent again would be a second reading of "is this block ready".
    //
    //    Capped at what the poll's row budget still allows, less the show row.
    //    `SHEET_MAX_ROWS` is a blast radius the guard refuses a plan *whole*
    //    for crossing, so a fifteen-season block planned over it is one
    //    refused every poll until the seasons age out — where a block cut to
    //    the room available lands, and the seasons cut off it are inserted a
    //    row a run after that.
    const room = ctx.rowsLeft() - 1;
    const rows = answered.slice(0, Math.max(0, room));
    if (rows.length === 0) {
      plan.skips.push({
        code: 'no-room',
        message: `${seasonLabel}: would be added, but this poll's edits already fill SHEET_MAX_ROWS=${ctx.maxRows}`,
      });
      // Every season that had an answer and no room, counted as the work it is:
      // the budget is the poll's, so what drains this is the next poll rather
      // than any move in the library, and `deferred` is what asks for one.
      plan.deferred += answered.length;
      continue;
    }
    const built = buildBlock(ctx, seasonRows, { progress, entry: { ...entry, genres, certificate }, title, rows });
    if ('code' in built) {
      plan.skips.push(built);
      // Withdrawn, like every other exit that has not said a final word. What
      // resolves a placement or a room refusal is an edit to the tab — a season
      // row above the insertion point, rows added past the last block — and the
      // record cannot see either, so a title recorded here is one the run after
      // that edit would walk past.
      continue;
    }
    // Free by construction: a taken slot defers the block above, before any
    // lookup is asked for.
    plan.insert = built;
    // Banked, never observed: what this block writes is only true of the sheet
    // once the batch lands, and a failed one must leave the title unseen.
    bank(keep, titleRecordKey(progress.id), 'Status', progress.status ?? NOT_HELD);
    // Per row, and only the ones landing finished: a row created with a blank
    // runtime cell a later poll can still fill has to stay in scope until it is
    // closed, and recording its count is what would take it out.
    const waiting = new Set(built.waiting);
    for (const { candidate } of rows) {
      const key = seasonKey(progress.id, candidate.season.number);
      if (waiting.has(candidate.season.number)) withdraw(keep.observed, key, 'Watched');
      else bank(keep, key, 'Watched', String(candidate.season.watched));
    }
    // What the block left: the seasons the row budget cut off, and everything
    // past the one the runtime loop stopped at. Unconditional on that loop
    // having stopped — it answers every season or breaks, so a run that answered
    // them all slices an empty tail.
    deferBehind(plan, keep, progress.id, label, chosen.number, [
      ...answered.slice(rows.length).map(({ candidate }) => candidate.season),
      ...wanted.slice(answered.length),
    ]);
  }

  if (awaitingCredential) {
    const keys = [...(ctx.facts.tvdb ? [] : ['TVDB_API_KEY']), ...(ctx.facts.tmdb ? [] : ['TMDB_API_KEY'])];
    plan.notes.push(`${awaitingCredential} show(s) have no row; set ${keys.join(' and ')} to have a block added for them`);
  }
  if (awaitingFixedCredential) {
    // Every rejected key, so one restart is enough: named one at a time, an
    // operator with both wrong fixes one, restarts, and is told about the other.
    const keys = [...(ctx.factsRejected.has('tvdb') ? ['TVDB_API_KEY'] : []), ...(ctx.factsRejected.has('tmdb') ? ['TMDB_API_KEY'] : [])];
    plan.notes.push(`${awaitingFixedCredential} show(s) need a block and the credential was rejected; fix ${keys.join(' and ')} and restart`);
  }
};

// --- What survives the run --------------------------------------------------

/**
 * One planned edit once the plan itself is gone: where it landed, which
 * column, and the planner's wording for what changed.
 */
export interface RecordedEdit {
  address: string;
  /**
   * Either tab's column, by the label a reader sees in the header row — never
   * the field id, because the record outlives the run and is read beside the
   * sheet. One record shape for both, because the journal and the status page
   * ask the same three questions of a films edit as of a show one — where it
   * landed, which column, and why — and this module does not name the other
   * tab's columns.
   */
  field: string;
  note: string;
}

export interface RecordedInsert {
  /** `row 610` rather than a cell — an insert has no single cell to point at. */
  address: string;
  title: string;
  /** Absent on a film row, which has no season to name. */
  season?: number;
  note: string;
}

export interface PlanRecord {
  edits: RecordedEdit[];
  inserts: RecordedInsert[];
}

/**
 * A plan reduced to what survives the run, for the journal and the status
 * page's history.
 *
 * Structured rather than `describePlan`'s strings: the page renders the cell,
 * column and wording as three columns, and a joined line cannot be split back.
 * Skips and notes are dropped — they answer "why was this row left alone",
 * which the page does not ask.
 *
 * Every count downstream is a `.length` of one of these, so a run cannot
 * report a plan size that disagrees with the plan it reports.
 */
export const planRecord = (plan: SheetPlan): PlanRecord => ({
  edits: plan.edits.map(({ address, field, note }) => ({ address, field: SHOW_LABELS[field], note })),
  inserts:
    plan.insert === null ? [] : [{ address: insertAddress(plan.insert), title: plan.insert.title, season: insertSeason(plan.insert), note: plan.insert.note }],
});

/**
 * Where an insert landed, for a record read months later beside the sheet. A
 * span says both its rows: a block is a show row and a season row, and "row
 * 610" would name half of what the run did.
 */
const insertAddress = (insert: Insert): string =>
  insert.kind === 'season' ? `row ${insert.row + 1}` : `rows ${insert.row + 1}-${insert.row + insertSpan(insert).rows}`;

/**
 * A human-readable rendering of a plan, for the log and for `report` mode.
 *
 * Takes no column map: every planned cell already carries the A1 it will be
 * written at, and a block fills six columns `ColumnMap` does not name at all.
 */
export const describePlan = (plan: SheetPlan): string[] => {
  const lines: string[] = [];
  for (const e of plan.edits) lines.push(`  edit   ${e.address.padEnd(7)} ${e.note}`);
  if (plan.insert) {
    lines.push(`  insert ${insertAddress(plan.insert)}  ${plan.insert.note}`);
    // The cell's own column, not a second lookup through `columns`: a block
    // fills six columns that map does not name, and the cell already carries
    // the index the write will use.
    for (const f of plan.insert.fill) lines.push(`           ${f.address.padEnd(5)} ${SHOW_FIELD_LABELS[f.field]}`);
  }
  for (const s of plan.skips) lines.push(`  skip   ${s.message}`);
  for (const n of plan.notes) lines.push(`  note   ${n}`);
  return lines;
};
