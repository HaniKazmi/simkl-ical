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
 * The write surface is three fields — a season's `Episode`, a season's `End`,
 * a show's `Status` — plus inserting a season row. Everything else is
 * hand-maintained or a formula that rolls up by itself.
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
import { runtimeDays, watchSerial } from './values.ts';
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
  value: ExtendedValue;
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
}

export interface PlanOptions {
  now?: Temporal.Instant;
  timezone?: string;
  sinceDays?: number;
}

const cellAt = (grid: Grid, row: number, column: number): CellData | undefined => grid.snapshot.rows[row]?.[column];

const num = (numberValue: number): ExtendedValue => ({ numberValue });
const str = (stringValue: string): ExtendedValue => ({ stringValue });

const edit = (grid: Grid, row: number, field: HeaderName, value: ExtendedValue, note: string): CellEdit => {
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
  | { kind: 'resolved'; watched: number; complete: boolean; lastWatchedAt: Temporal.Instant | null };

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
    return {
      kind: 'resolved',
      // Summed across all ids: a split cour is one row.
      watched: resolved.reduce((total, p) => total + watchedIn(p), 0),
      // Only once *every* id is complete.
      complete: resolved.every((p) => courComplete(p)),
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
type RuntimeAnswer = { state: 'none' } | { state: 'pending' } | { state: 'target'; request: RuntimeRequest };

const runtimeAnswer = (
  grid: Grid,
  block: ShowBlock,
  season: SeasonRow,
  index: Map<number, TitleProgress>,
  titles: Map<number, TitleCatalogue>,
): RuntimeAnswer => {
  if (!runtimeScopeOk(block)) return { state: 'none' };
  if (season.ids.length) return { state: 'none' };
  if (season.season === null || !Number.isInteger(season.season)) return { state: 'none' };

  // The same id `resolveRow`'s by-season branch reads. Mirrored: a narrower
  // rule here than there would strand a row.
  const id = idsFor(block, season)[0];
  if (id === undefined || !index.has(id)) return { state: 'none' };

  if (!isBlank(cellAt(grid, season.row, grid.columns.Episodes))) return { state: 'none' };

  // Absent means the detail has not answered; null means it answered "no
  // key". The store writes one or the other the moment `/tv/{id}` lands, so
  // `undefined` reliably means the call is still outstanding.
  const tvdbId = titles.get(id)?.tvdbId;
  if (tvdbId === undefined) return { state: 'pending' };
  if (tvdbId === null) return { state: 'none' };

  return { state: 'target', request: { id, tvdbId, season: season.season } };
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
  { now = Temporal.Now.instant(), timezone = config.timezone, sinceDays = config.sheetSinceDays }: PlanOptions = {},
): PlanResult => {
  const plan = emptyPlan();
  const demands: PlanDemands = { catalogue: [], runtimes: [] };
  const cutoff = cutoffFrom(now, sinceDays);
  const duplicates = duplicateIds(grid.blocks);
  const seen = new Set<number>();

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

      // A season row with an end date is finished, by the user's decision,
      // and never revisited — so a wrongly-stamped end date could never be
      // corrected, which is why `End` is so conservative.
      if (season.closed) continue;
      if (!within(resolved.lastWatchedAt, cutoff)) continue;

      const label = `${block.title} S${season.season ?? '?'}`;
      if (season.season !== null && idsFor(block, season).some((id) => (claims.get(`${id}:${season.season}`) ?? 0) > 1)) {
        plan.skips.push({ code: 'duplicate-season', message: `${label}: more than one row describes this season, so neither is written` });
        continue;
      }
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
      if (resolved.watched > (season.episode ?? 0)) {
        plan.edits.push(edit(grid, season.row, 'Episode', num(resolved.watched), `${label}: ${season.episode ?? 0} -> ${resolved.watched} episodes`));
      }

      if (!resolved.complete) continue;

      const serial = watchSerial(resolved.lastWatchedAt, timezone);
      if (serial === null) {
        plan.skips.push({ code: 'unusable-timestamp', message: `${label}: complete, but its last watch timestamp is unusable` });
        continue;
      }

      // Decided before anything is written: `End` closes the row for good —
      // the guard refuses every later edit to a dated row — so a row whose
      // runtime question is open must wait rather than close blind. The date
      // is not lost by waiting: it comes from the watch timestamp, so a row
      // deferred three polls gets the identical serial three polls later.
      const runtime = runtimeAnswer(grid, block, season, index, titles);
      if (runtime.state === 'pending') {
        // Nothing to demand: without the detail there is no key to ask TVDB
        // with, and the catalogue demand above already asks for it.
        plan.skips.push({ code: 'awaiting-runtimes', message: `${label}: complete, but its catalogue detail has not come back — left open for the next poll` });
        continue;
      }
      const target = runtime.state === 'target' ? runtime.request : null;
      // One map read answers the whole state machine: `undefined` is
      // unanswered, `null` settled with nothing usable, a number the answer.
      // A row with no target has nothing to wait for.
      const minutes = target === null ? null : titles.get(target.id)?.seasonRuntimes.get(target.season);
      if (minutes === undefined && target !== null) {
        demands.runtimes.push(target);
        plan.skips.push({ code: 'awaiting-runtimes', message: `${label}: complete, but its episode runtimes have not come back — left open for the next poll` });
        continue;
      }

      plan.edits.push(edit(grid, season.row, 'End', num(serial), `${label}: ended`));

      if (target !== null) {
        // Settled-with-nothing falls back to the show-wide runtime, same as a
        // row being created. This batch dates the row either way, so the
        // choice is between an approximate number and a cell nothing can ever
        // fill — and it must not depend on which run first saw the season, or
        // two identical-looking rows differ for a reason no reader could see.
        const days = runtimeDays(minutes) ?? runtimeDays(titles.get(target.id)?.runtime);
        if (days === null) {
          plan.notes.push(`${label}: ended with no usable episode runtimes, so its Episodes cell is left blank`);
        } else {
          // The season's own average where TVDB answered, the show's usual
          // episode length where it did not.
          const measured = minutes === null ? "SIMKL's show-wide episode runtime" : `${minutes} min average episode runtime`;
          plan.edits.push(edit(grid, season.row, 'Episodes', num(days), `${label}: ${measured}`));
        }
      }
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

  return { plan, demands };
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

  const cells: Array<{ field: HeaderName; value: ExtendedValue }> = [
    { field: 'Season', value: num(candidate.number) },
    { field: 'Episode', value: num(candidate.watched) },
    { field: 'Start', value: num(start) },
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
