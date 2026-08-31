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
 * The write surface is five columns — a season's `Episode`, its `Start` and
 * `End` dates, its runtime, and `Status`, which means one thing on a show row
 * (the derived state) and another on a season row (when it was last watched) —
 * plus inserting a season row. Everything else is hand-maintained or a formula
 * that rolls up by itself.
 *
 * `Start` and `End` are the two that **follow SIMKL**: written whenever what
 * SIMKL says has moved away from what the baseline recorded, on a dated row as
 * well as an open one. Every other write compares against the sheet cell, which
 * is the right comparison for it — a count and a watch note are facts about
 * their own row, while a start and an end date are facts about SIMKL, and only
 * a record of what SIMKL last said can tell a change from a standing
 * disagreement. See `followUpstream`.
 */

import { config } from '../shared/config.ts';
import {
  a1,
  columnLetter,
  duplicateIds,
  idsFor,
  isBlank,
  numberOf,
  runtimeScopeOk,
  usesCourModel,
  type ColumnMap,
  type Grid,
  type HeaderName,
  type SeasonRow,
  type ShowBlock,
} from './2-grid.ts';
import { courComplete, type SeasonProgress, type TitleProgress } from './1-index.ts';
import { maxSerial, ownsNote, plausibleSerial, recordedSerial, runtimeDays, seasonKey, TRACKED_FIELDS, watchedNote, watchSerial } from './values.ts';
import type { Baseline, TrackedField } from './values.ts';
import { instantFrom, isoOf } from '../shared/dates.ts';
import { seasonAired, seasonComplete, type SeasonShape, type TitleCatalogue } from './3-catalogue.ts';
import type { RuntimeRequest } from './io/runtimes.ts';
import type { CatalogueRequest } from './io/catalogue.ts';
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
  /** Where the new row lands. Rows at and below this index shift down by one. */
  row: number;
  title: string;
  season: number;
  /** Cells written into the new row. It has no `previous` — it did not exist. */
  fill: CellEdit[];
  note: string;
}

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
  | 'awaiting-runtimes'
  | 'no-episode-list'
  | 'no-format-row';

export interface Skip {
  code: SkipCode;
  message: string;
}

export interface SheetPlan {
  edits: CellEdit[];
  /**
   * At most one row per run, carried by the type: plan indices are pre-write
   * but `insertDimension` applies cumulatively, so a second insert would land
   * a row above where it was planned — and `verify` makes the same unshifted
   * assumption.
   */
  insert: RowInsert | null;
  /** Rows deliberately left alone, with the reason. Reported, never acted on. */
  skips: Skip[];
  /** Everything else worth a human's attention — new shows, new cours. */
  notes: string[];
  /**
   * Rows ready to add that did not fit under the one-per-run rule. Known
   * waiting work, so the sync asks for another poll rather than waiting for
   * something else to wake one.
   */
  deferredInserts: number;
}

export const emptyPlan = (): SheetPlan => ({ edits: [], insert: null, skips: [], notes: [], deferredInserts: 0 });

/** What the planner could not decide without: fetch these and re-plan. */
export interface PlanDemands {
  catalogue: CatalogueRequest[];
  runtimes: RuntimeRequest[];
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
   * `observeStarts(index)`, hoisted. It is a projection of the library alone,
   * and the library cannot change while a run is in flight — so the sync builds
   * it once rather than paying for it on every pass of the plan-fetch fixpoint.
   * Defaulted so the function stays self-sufficient.
   */
  starts?: Baseline;
}

const cellAt = (grid: Grid, row: number, column: number): CellData | undefined => grid.snapshot.rows[row]?.[column];

const num = (numberValue: number): ExtendedValue => ({ numberValue });
const str = (stringValue: string): ExtendedValue => ({ stringValue });

const edit = (grid: Grid, row: number, field: HeaderName, value: ExtendedValue | undefined, note: string): CellEdit => {
  const column = grid.columns[field];
  return { row, column, field, previous: cellAt(grid, row, column)?.userEnteredValue, value, address: a1(row, column), note };
};

// --- Eligibility -----------------------------------------------------------

/**
 * Every SIMKL id claimed anywhere in a block. Used only to ask "has anything
 * happened here recently", so a plain max is right.
 */
const blockIds = (block: ShowBlock): number[] => [...new Set([...block.ids, ...block.seasons.flatMap((s) => s.ids)])];

const latestOf = (progresses: TitleProgress[]): Temporal.Instant | null =>
  progresses.reduce<Temporal.Instant | null>(
    (latest, p) => (p.lastWatchedAt && (!latest || Temporal.Instant.compare(p.lastWatchedAt, latest) > 0) ? p.lastWatchedAt : latest),
    null,
  );

const within = (at: Temporal.Instant | null, cutoff: Temporal.Instant): boolean =>
  at !== null && Temporal.Instant.compare(at, cutoff) >= 0;

/**
 * The instant before which a block is out of scope.
 *
 * Hours rather than `{ days }`, which an `Instant` refuses: a day is a
 * calendar unit and an instant has no calendar. Also the behaviour wanted —
 * an exact span, so the window does not move by an hour twice a year.
 */
const cutoffFrom = (now: Temporal.Instant, sinceDays: number): Temporal.Instant => now.subtract({ hours: sinceDays * 24 });

/**
 * Has anything in this block been watched recently enough to touch? The
 * cut-off applies uniformly: a dormant sheet produces zero edits, and no run
 * can retro-edit years of history.
 */
const isRecent = (ids: number[], index: Map<number, TitleProgress>, cutoff: Temporal.Instant): boolean =>
  within(latestOf(ids.map((id) => index.get(id)).filter((p): p is TitleProgress => p !== undefined)), cutoff);

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
      lastWatchedAt: Temporal.Instant | null;
      firstWatchedAt: Temporal.Instant | null;
      /**
       * How the baseline names this row, or null where nothing can: `(SIMKL
       * id, SIMKL season)`, which is what the index keys the same season under
       * so the two agree. Derived here because only this function knows which
       * branch a row took, and a second derivation elsewhere is how a record
       * comes to describe a different season than the row it was read for.
       */
      key: string | null;
    };

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

    return {
      kind: 'resolved',
      // Summed across all ids: a split cour is one row.
      watched: resolved.reduce((total, p) => total + watchedIn(p), 0),
      // Only once *every* id is complete.
      complete: resolved.every((p) => courComplete(p)),
      // The first cour starts the row, as the last one ends it below.
      firstWatchedAt: number === undefined ? null : (first.seasons.get(number)?.firstWatchedAt ?? null),
      key: number === undefined ? null : seasonKey(first.id, number),
      // The last id ends the row and dates it. It is also the right *recency*
      // signal: ids go in release order, and a second is only added once the
      // first is finished, so the last id is always the active one —
      // mid-first-cour the row does not have the second id yet. A max across
      // the ids would say the same thing.
      lastWatchedAt: resolved.at(-1)?.lastWatchedAt ?? null,
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
    lastWatchedAt: watched.lastWatchedAt,
    firstWatchedAt: watched.firstWatchedAt,
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
 * Which season a block would gain a row for. `source` is the entry
 * `statusSource` named, already resolved and cleared of duplicate-id claims —
 * one derivation of "which entry drives this block" serves the Status write,
 * the insert, and its runtime alike.
 *
 * A season inserted complete is dated by the same fill that creates it, so
 * its runtime has one chance to be asked for — before the row exists. Hence
 * the insert path's own runtime demand. The insert must never *require* the
 * runtime to have arrived: a row whose number never comes back is inserted
 * open and closed by the per-row path a poll later, so a bug there costs a
 * poll rather than a cell.
 */
const insertTarget = (
  block: ShowBlock,
  source: TitleProgress,
  titles: Map<number, TitleCatalogue>,
  cutoff: Temporal.Instant,
): InsertCandidate | null => {
  // Anime is never inserted into: one SIMKL record is one cour, so its season
  // numbers do not address rows the user numbers by broadcast season. Same
  // tests as the runtime write — both put something into a row it cannot take
  // back.
  if (!runtimeScopeOk(block)) return null;

  // Every whole season the block already has a row for, independent of
  // whether that row resolved: a row the planner declined to read is still a
  // row, and a second row for the same season is the one insert mistake
  // nothing downstream could detect.
  const covered = new Set(block.seasons.map((s) => s.season).filter((n): n is number => n !== null && Number.isInteger(n)));

  const season = [...source.seasons.values()]
    .filter((s) => s.watched > 0 && !covered.has(s.number) && within(s.lastWatchedAt, cutoff))
    .sort((a, b) => a.number - b.number)[0];
  if (!season) return null;

  const shape = titles.get(source.id)?.shapes.get(season.number);
  return { source, season, aired: seasonAired(shape), complete: seasonComplete(shape, season.watched) };
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
    detailed: tvdbId !== undefined,
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

  if (!isBlank(cellAt(grid, season.row, grid.columns.Episodes))) return { state: 'ineligible' };

  // Absent means the detail has not answered; null means it answered "no
  // key". The store writes one or the other the moment `/tv/{id}` lands, so
  // `undefined` reliably means the call is still outstanding.
  const tvdbId = titles.get(id)?.tvdbId;
  if (tvdbId === undefined) return { state: 'pending' };
  // No key, so no season average is ever coming — but the row is still one
  // this sync may fill, and the show-wide length is the best there will be.
  if (tvdbId === null) return { state: 'settled', id };

  return { state: 'target', id, request: { id, tvdbId, season: season.season } };
};

// --- Closing a row ----------------------------------------------------------

type ResolvedRow = Extract<RowResolution, { kind: 'resolved' }>;

// --- Following SIMKL --------------------------------------------------------

/**
 * Every season's first watch, keyed the way the record keys it.
 *
 * The whole library, not only the rows a pass reaches. Recording is not a write
 * and costs nothing, while the gap it closes is the one that matters: a first
 * sighting is silent by design, so a season observed for the first time on the
 * very run that first reaches it has its move swallowed — and a move is usually
 * what brought the row into the activity window in the first place. Recording
 * wide means every later move is a real move.
 *
 * `End` cannot be recorded this way. It exists only once a season is known
 * complete, which takes a catalogue lookup, which is only asked for blocks
 * already in the window.
 *
 * An inserted row is recorded on the same run that writes it, which looks like
 * the banking this file is otherwise careful about and is not: an insert is
 * triggered by a row being absent, never by this comparison, so a failed one
 * re-plans on the next poll whatever the record says.
 */
export const observeStarts = (index: Map<number, TitleProgress>): Baseline => {
  const observed: Baseline = new Map();
  for (const progress of index.values()) {
    for (const season of progress.seasons.values()) {
      if (season.firstWatchedAt === null) continue;
      observed.set(seasonKey(progress.id, season.number), { Start: isoOf(season.firstWatchedAt) });
    }
  }
  return observed;
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
 *
 * The walk order in `TRACKED_FIELDS` is load-bearing: `End` is decided first so
 * that `Start`'s ordering check can consult the end this same batch plans,
 * rather than the one the cell holds on its way out.
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
const endAfter = (plan: SheetPlan, grid: Grid, row: number): number | null => {
  const planned = plan.edits.find((e) => e.row === row && e.field === 'End');
  const value = planned ? planned.value?.numberValue : numberOf(cellAt(grid, row, grid.columns.End));
  return typeof value === 'number' ? value : null;
};

const followUpstream = (
  { plan, grid, timezone, ceiling, baseline, observed, writing }: FollowContext,
  season: SeasonRow,
  resolved: ResolvedRow,
  label: string,
): void => {
  const key = resolved.key;
  if (key === null) return;

  for (const field of TRACKED_FIELDS) {
    const source = TRACKED_SOURCE[field];
    if (!source.on(season, resolved)) continue;

    const at = source.of(resolved);
    const serial = watchSerial(at, timezone);
    if (at === null || serial === null) continue;

    const was = recordedSerial(baseline.get(key)?.[field], timezone);
    const moved = was !== null && was !== serial;

    // A restamp the guard would refuse is stopped here rather than passed on:
    // refusal is whole-plan, so one upstream timestamp outside the writable
    // range would hold up every unrelated edit for as long as its row sat
    // inside the activity window.
    // A row whose end date the sync is not replacing may hold one that predates
    // what SIMKL now calls the first watch — a hand-typed date, or one this sync
    // wrote before the watch was corrected. Writing the start anyway would leave
    // the row saying it ended before it began, and letting the guard catch it
    // costs the whole plan on every poll for as long as the row sits inside the
    // activity window. One skip, naming the row, is the containable version.
    const end = field === 'Start' ? endAfter(plan, grid, season.row) : null;
    const inverted = end !== null && serial > end;

    if (moved && (!plausibleSerial(serial, ceiling) || inverted)) {
      const why = inverted ? `would fall after the end date the row holds` : `is outside the range this sync writes`;
      plan.skips.push({ code: 'unusable-timestamp', message: `${label}: SIMKL's ${field} date ${why}, so that cell is left alone` });
    } else if (moved) {
      const before = watchedNote(instantFrom(baseline.get(key)?.[field]), timezone);
      plan.edits.push(edit(grid, season.row, field, num(serial), `${label}: ${field} moved from ${before} to ${watchedNote(at, timezone)}`));
      // Into `writing`, and *withdrawn* from `observed`, which `observeStarts`
      // has already seeded with this very value: recorded before its write
      // lands, the next poll compares against it, finds nothing moved, and the
      // change is lost. The withdrawal is what keeps the two maps disjoint.
      //
      // The withdrawal *replaces* the entry rather than deleting the field from
      // it. `observed` is a shallow copy of a seed the run reuses across every
      // planning pass and every re-read, so the entries are shared: deleting in
      // place would strip the field from the seed itself, and the next pass
      // would plan against a library the run had quietly edited.
      writing.set(key, { ...writing.get(key), [field]: isoOf(at) });
      const seeded = { ...observed.get(key) };
      delete seeded[field];
      observed.set(key, seeded);
      continue;
    }

    // Everything not being written is observed, stated once: the disjointness
    // the whole mechanism rests on reads off a single exit rather than being
    // reconstructed from three. An unmoved value and a declined move are both
    // recorded — the second keeps the skip from repeating every poll, and a
    // later move back into range still reads as a move.
    observed.set(key, { ...observed.get(key), [field]: isoOf(at) });
  }
};

/** Everything `followUpstream` needs that does not vary between rows, built once per run. */
interface FollowContext {
  plan: SheetPlan;
  grid: Grid;
  timezone: string;
  ceiling: number;
  baseline: Baseline;
  observed: Baseline;
  writing: Baseline;
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
  plan: SheetPlan,
  demands: PlanDemands,
  grid: Grid,
  block: ShowBlock,
  season: SeasonRow,
  resolved: ResolvedRow,
  index: Map<number, TitleProgress>,
  titles: Map<number, TitleCatalogue>,
  { label, timezone, ceiling }: { label: string; timezone: string; ceiling: number },
): boolean => {
  if (!resolved.complete) return false;

  const serial = watchSerial(resolved.lastWatchedAt, timezone);
  // Bounded here, not only in the guard, for the reason `followUpstream` gives:
  // refusal is whole-plan, so a single upstream timestamp outside the writable
  // range would hold up every unrelated edit for as long as its row sat inside
  // the activity window. Both writers of `End` owe the same skip.
  if (serial === null || !plausibleSerial(serial, ceiling)) {
    plan.skips.push({ code: 'unusable-timestamp', message: `${label}: complete, but its last watch timestamp is unusable` });
    return false;
  }

  const runtime = runtimeAnswer(grid, block, season, index, titles);
  if (runtime.state === 'pending') {
    // Nothing to demand: without the detail there is no key to ask TVDB with,
    // and the block's catalogue demand already asks for it.
    plan.skips.push({ code: 'awaiting-runtimes', message: `${label}: complete, but its catalogue detail has not come back — left open for the next poll` });
    return false;
  }
  // One map read answers the whole state machine: `undefined` is unanswered,
  // `null` settled with nothing usable, a number the answer.
  const minutes = runtime.state === 'target' ? titles.get(runtime.id)?.seasonRuntimes.get(runtime.request.season) : null;
  if (runtime.state === 'target' && minutes === undefined) {
    demands.runtimes.push(runtime.request);
    plan.skips.push({ code: 'awaiting-runtimes', message: `${label}: complete, but its episode runtimes have not come back — left open for the next poll` });
    return false;
  }

  plan.edits.push(edit(grid, season.row, 'End', num(serial), `${label}: ended`));
  if (runtime.state === 'ineligible') return true;

  // Settled-with-nothing falls back to the show-wide runtime, same as a row
  // being created. This batch dates the row either way, so the choice is
  // between an approximate number and a cell nothing can ever fill — and it
  // must not depend on which run first saw the season, or two identical-looking
  // rows differ for a reason no reader could see. A title with no TVDB key at
  // all is that same case: no average is coming, so the show-wide length is
  // what the cell gets.
  const days = runtimeDays(minutes) ?? runtimeDays(titles.get(runtime.id)?.runtime);
  if (days === null) {
    plan.notes.push(`${label}: ended with no usable episode runtimes, so its Episodes cell is left blank`);
  } else {
    // The season's own average where TVDB answered, the show's usual episode
    // length where it did not.
    const measured = minutes === null ? "SIMKL's show-wide episode runtime" : `${minutes} min average episode runtime`;
    plan.edits.push(edit(grid, season.row, 'Episodes', num(days), `${label}: ${measured}`));
  }
  return true;
};

/**
 * The `Status` cell on a season row: when the season was last watched, and
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
 * A formula is declined by that predicate too, and it has to be: `season.status`
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
const statusNote = (
  grid: Grid,
  season: SeasonRow,
  lastWatchedAt: Temporal.Instant | null,
  { advanced, closing, label, timezone }: { advanced: boolean; closing: boolean; label: string; timezone: string },
): CellEdit | null => {
  const cell = cellAt(grid, season.row, grid.columns.Status);
  if (!ownsNote(cell, season.status)) return null;

  if (closing) {
    // Nothing of ours in a blank cell to take away.
    return isBlank(cell) ? null : edit(grid, season.row, 'Status', undefined, `${label}: dated, so its last-watched note is cleared`);
  }
  if (!advanced) return null;
  const text = watchedNote(lastWatchedAt, timezone);
  if (text === null || text === season.status) return null;
  return edit(grid, season.row, 'Status', str(text), `${label}: last watched ${text}`);
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
  { now = Temporal.Now.instant(), timezone = config.timezone, sinceDays = config.sheetSinceDays, baseline = new Map(), starts }: PlanOptions = {},
): PlanResult => {
  const plan = emptyPlan();
  const demands: PlanDemands = { catalogue: [], runtimes: [] };
  const cutoff = cutoffFrom(now, sinceDays);
  const duplicates = duplicateIds(grid.blocks);
  const seen = new Set<number>();
  // Copied, never used directly: a pass whose plan is discarded must not leave
  // its withdrawals in the caller's seed. The entries themselves are never
  // mutated in place — only replaced — so a shallow copy is enough.
  const observed = new Map(starts ?? observeStarts(index));
  const writing: Baseline = new Map();
  const follow: FollowContext = { plan, grid, timezone, ceiling: maxSerial(now, timezone), baseline, observed, writing };

  for (const block of grid.blocks) {
    const ids = blockIds(block);
    for (const id of ids) seen.add(id);

    if (!isRecent(ids, index, cutoff)) continue;
    const anime = usesCourModel(block);

    // The block's catalogue lookups. The episode list cannot be gated on "a
    // season ended" — it is what discovers that. Anime needs none: one entry
    // is one cour, so its own counters describe the season.
    if (!anime) {
      for (const id of block.ids) demands.catalogue.push({ id, episodes: true, detail: true });
    }
    const sourceId = statusSource(block);
    if (sourceId !== null) demands.catalogue.push({ id: sourceId, anime, detail: true });

    // Two rows describing the same season of the same title: both would be
    // planned the same count, silently, and only one rolls up into the show
    // row above. Keyed on the *effective* id because a blank season row
    // inherits the block's — an anime block whose rows each carry their own
    // id has one season 1 per title and is not this.
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
        plan.skips.push(resolution.skip);
        continue;
      }
      const resolved = resolution;

      if (!within(resolved.lastWatchedAt, cutoff)) continue;

      const label = `${block.title} S${season.season ?? '?'}`;
      if (season.season !== null && idsFor(block, season).some((id) => (claims.get(`${id}:${season.season}`) ?? 0) > 1)) {
        plan.skips.push({ code: 'duplicate-season', message: `${label}: more than one row describes this season, so neither is written` });
        continue;
      }

      // Before the dated-row test, and the only thing that comes before it: a
      // row with an end date is otherwise finished and left alone, but the
      // fields that follow SIMKL follow it on a dated row too. Everything
      // below writes a fact the row settled once.
      followUpstream(follow, season, resolved, label);
      if (season.closed) continue;

      // A hand-typed count — "12 (rewatch)", "~8" — parses to null, so the
      // comparison below would read it as 0 and plan an edit the guard
      // refuses unconditionally. Refusal is whole-plan, so one such cell
      // would stop every unrelated edit while the row stays inside the
      // activity window. Skipped here so the guard stays the backstop, and
      // the reason names the row instead of the planner.
      const existing = cellAt(grid, season.row, grid.columns.Episode);
      if (!isBlank(existing) && numberOf(existing) === null) {
        plan.skips.push({ code: 'non-numeric-count', message: `${label}: the Episode cell holds something that is not a number, so the row is left alone` });
        continue;
      }
      const advanced = resolved.watched > (season.episode ?? 0);
      if (advanced) {
        plan.edits.push(edit(grid, season.row, 'Episode', num(resolved.watched), `${label}: ${season.episode ?? 0} -> ${resolved.watched} episodes`));
      }

      const closing = closeSeason(plan, demands, grid, block, season, resolved, index, titles, { label, timezone, ceiling: follow.ceiling });

      // Last, because what the note should say depends on whether this batch
      // dates the row — a row left open for another poll keeps carrying its
      // date, a row being closed hands the fact over to `End`.
      const note = statusNote(grid, season, resolved.lastWatchedAt, { advanced, closing, label, timezone });
      if (note) plan.edits.push(note);
    }

    // --- Status, and the season-row insert
    //
    // Both are driven by the block's status source, so both are declined when
    // that id is claimed by another row — the same rule `resolveRow` applies.
    // Without it one title's progress writes Status on two unrelated blocks
    // and plans a new row in each.
    const source = (sourceId === null ? null : index.get(sourceId)) ?? null;
    if (sourceId !== null && duplicates.has(sourceId)) {
      plan.skips.push({ code: 'duplicate-id', message: `${block.title}: id ${sourceId} is claimed by more than one row, so Status and new rows are left alone` });
    } else if (source) {
      const entry = titles.get(source.id);
      // Which model applies is decided by where the ids sit, never by whether
      // data arrived. Anime asks its own not-aired counter: one entry is one
      // cour. A live-action block with no shapes is a *failed lookup*, not a
      // cour — read as one it would answer with a count spanning the whole
      // show rather than the latest season. So it declines to write; the
      // lookup failure already asks for another poll.
      if (!anime && !entry?.shapes.size) {
        plan.skips.push({ code: 'no-episode-list', message: `${block.title}: no episode list came back, so Status is left alone` });
      } else {
        const status = deriveStatus(source, {
          detailStatus: entry?.status,
          latestSeasonAiring: anime ? source.notAiredCount > 0 : latestSeasonAiring(entry?.shapes ?? new Map()),
        });
        if (status !== null && status !== block.status) {
          plan.edits.push(edit(grid, block.row, 'Status', str(status), `${block.title}: ${block.status ?? '(blank)'} -> ${status}`));
        }
      }

      const candidate = insertTarget(block, source, titles, cutoff);
      if (candidate) {
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
        if (candidate.aired && runtime.target && runtime.minutes === undefined) demands.runtimes.push(runtime.target);

        const insert = planInsert(grid, block, candidate, runtime, titles, { timezone });
        if (insert && 'code' in insert) plan.skips.push(insert);
        else if (insert) {
          // One row per run: starting two seasons between polls defers the
          // second. Not lost — the next run re-plans the whole sheet and
          // takes it — but it must say so: a silent deferral reads exactly
          // like a season the sync never noticed, the failure a report
          // exists to rule out.
          if (plan.insert === null) plan.insert = insert;
          else {
            plan.deferredInserts += 1;
            plan.notes.push(`${insert.title} S${insert.season} is ready to add — deferred, one row is added per run`);
          }
        }
      }
    }
  }

  // Titles SIMKL knows with no row at all. Reported, never added: a new show
  // is the user's call, and a new anime cour is a separate SIMKL title under
  // a romaji name that mostly does not match what the sheet calls the series.
  // Title matching is unreliable enough that this must never try.
  for (const progress of index.values()) {
    if (seen.has(progress.id) || !within(progress.lastWatchedAt, cutoff)) continue;
    plan.notes.push(`${progress.title} (simkl ${progress.id}) has recent activity and no row — add it by hand if you want it tracked`);
  }

  return { plan, demands, observed, writing };
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
  { source, season: candidate, aired, complete }: InsertCandidate,
  { target, minutes, detailed }: InsertRuntime,
  titles: Map<number, TitleCatalogue>,
  { timezone }: { timezone: string },
): RowInsert | Skip | null => {
  const label = `${block.title} S${candidate.number}`;
  const entry = titles.get(source.id);

  const start = watchSerial(candidate.firstWatchedAt, timezone);
  if (start === null) return { code: 'unusable-timestamp', message: `${label}: would be added, but its first watch timestamp is unusable` };

  // Keep Season ascending: before the first existing row with a higher
  // number, or after the last one.
  const whole = block.seasons.filter((s) => s.season !== null && Number.isInteger(s.season));
  const after = whole.find((s) => (s.season as number) > candidate.number);
  const row = after ? after.row : (block.seasons.at(-1)?.row ?? block.row) + 1;

  // inheritFromBefore takes formats from the row above. Without a season row
  // there, it inherits the *show* row's, and a correct date serial renders as
  // `46265`.
  if (!block.seasons.some((s) => s.row < row)) {
    return { code: 'no-format-row', message: `${label}: would be added, but there is no season row above the insertion point to inherit formats from` };
  }

  // What this row's runtime cell can hold, and whether this fill may date the
  // row. A row created and dated in one batch is never revisited, so its
  // `Episodes` cell has one chance to be right.
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
    target === null ? runtimeDays(entry?.runtime)
    : !aired ? null
    // Settled, either way. `runtimeDays` also rejects an average that is not
    // a length an episode has, and the show-wide number beats a cell nothing
    // can ever fill again.
    : minutes !== undefined ? (runtimeDays(minutes) ?? runtimeDays(entry?.runtime))
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
  const end = complete && !waiting ? watchSerial(candidate.lastWatchedAt, timezone) : null;
  // The same rule the per-row path applies, so a row is never created in a
  // state that path would immediately have to correct: an open row carries its
  // last-watched date, a dated one leaves `End` to say it.
  const note = end === null ? watchedNote(candidate.lastWatchedAt, timezone) : null;

  const cells: Array<{ field: HeaderName; value: ExtendedValue }> = [
    { field: 'Season', value: num(candidate.number) },
    { field: 'Episode', value: num(candidate.watched) },
    { field: 'Start', value: num(start) },
    ...(note === null ? [] : [{ field: 'Status' as const, value: str(note) }]),
    ...(runtime === null ? [] : [{ field: 'Episodes' as const, value: num(runtime) }]),
    {
      field: 'Length',
      // The sheet's convention: runtime x episodes watched. A formula, so it
      // keeps tracking the count like every other row.
      value: { formulaValue: `=${columnLetter(grid.columns.Episodes)}${row + 1}*${columnLetter(grid.columns.Episode)}${row + 1}` },
    },
    ...(end === null ? [] : [{ field: 'End' as const, value: num(end) }]),
  ];
  const fill: CellEdit[] = cells.map(({ field, value }) => ({
    row,
    column: grid.columns[field],
    field,
    // The row does not exist yet, so there is nothing it was.
    previous: undefined,
    value,
    address: a1(row, grid.columns[field]),
    note: `${label}: new row`,
  }));

  return {
    row,
    title: block.title,
    season: candidate.number,
    fill,
    // Why the cell went in blank, where that is not simply "the season is
    // still running". A row whose runtime nothing can supply is the one a
    // reader must finish by hand, so it says so rather than leaving an empty
    // cell to be noticed.
    note: `${label}: new season row at ${row + 1}, ${candidate.watched} episodes${end === null ? '' : ', ended'}${
      complete && end === null ? ', added open — its episode runtimes have not come back'
      // Blank with nothing outstanding is blank for good, dated or not: no
      // join key, or the key's answer is in and unusable. A row still waiting
      // is not this, and says nothing.
      : runtime === null && !waiting ? ', with no episode runtime to fill its Episodes cell'
      : ''
    }`,
  };
};

// --- What survives the run --------------------------------------------------

/**
 * One planned edit once the plan itself is gone: where it landed, which
 * column, and the planner's wording for what changed.
 */
export interface RecordedEdit {
  address: string;
  field: HeaderName;
  note: string;
}

export interface RecordedInsert {
  /** `row 610` rather than a cell — an insert has no single cell to point at. */
  address: string;
  title: string;
  season: number;
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
  edits: plan.edits.map(({ address, field, note }) => ({ address, field, note })),
  inserts: plan.insert === null ? [] : [{ address: `row ${plan.insert.row + 1}`, title: plan.insert.title, season: plan.insert.season, note: plan.insert.note }],
});

/** A human-readable rendering of a plan, for the log and for `report` mode. */
export const describePlan = (plan: SheetPlan, columns: ColumnMap): string[] => {
  const lines: string[] = [];
  for (const e of plan.edits) lines.push(`  edit   ${e.address.padEnd(7)} ${e.note}`);
  if (plan.insert) {
    lines.push(`  insert row ${plan.insert.row + 1}  ${plan.insert.note}`);
    for (const f of plan.insert.fill) lines.push(`           ${columnLetter(columns[f.field])} ${f.field}`);
  }
  for (const s of plan.skips) lines.push(`  skip   ${s.message}`);
  for (const n of plan.notes) lines.push(`  note   ${n}`);
  return lines;
};
