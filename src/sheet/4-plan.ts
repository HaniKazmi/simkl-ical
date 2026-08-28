/**
 * PLAN — grid + library + catalogue → a plan, plus what it still needs. Pure,
 * and **never throws**: an unresolvable row becomes a skip with a reason, not
 * an exception. The sync calls this from inside a path that must degrade rather
 * than fail.
 *
 * The one planner, run to a fixpoint. Where a decision needs data the
 * catalogue does not hold — a title's episode list, a closing season's
 * runtimes — the planner emits a *demand* and plans the row conservatively for
 * this pass; the sync fetches, folds the answers into the store, and re-plans.
 * What to fetch and what to write are one computation, so they cannot disagree
 * — the failure that used to need two planning passes kept in step by hand.
 *
 * The write surface is three fields — a season's `Episode`, a season's `End`,
 * and a show's `Status` — plus inserting a season row. Everything else on the
 * sheet is either hand-maintained or a formula that rolls up by itself.
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
   * At most one row per run, carried by the type rather than checked: every
   * request index in a plan is pre-write, but `insertDimension` applies
   * cumulatively, so a second insert would land a row above where it was
   * planned — and `verify` makes the same unshifted assumption.
   */
  insert: RowInsert | null;
  /** Rows deliberately left alone, with the reason. Reported, never acted on. */
  skips: Skip[];
  /** Everything else worth a human's attention — new shows, new cours. */
  notes: string[];
  /**
   * Rows that were ready to add but did not fit under the one-per-run rule.
   * Work known to be waiting, so the sync asks for another poll rather than
   * letting it sit until something else happens to wake one.
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
 * happened here recently", so a plain max is right: season rows carry no order
 * relative to each other.
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
 * Hours rather than `{ days }`, which an `Instant` refuses outright: a day is
 * a calendar unit and an instant has no calendar. That is also the behaviour
 * wanted — an exact span, so the window does not move by an hour twice a year.
 */
const cutoffFrom = (now: Temporal.Instant, sinceDays: number): Temporal.Instant => now.subtract({ hours: sinceDays * 24 });

/**
 * Has anything in this block been watched recently enough to touch? The
 * cut-off applies uniformly, with no exemptions: a dormant sheet produces zero
 * edits, and no run can retro-edit years of history.
 */
const isRecent = (ids: number[], index: Map<number, TitleProgress>, cutoff: Temporal.Instant): boolean =>
  within(latestOf(ids.map((id) => index.get(id)).filter((p): p is TitleProgress => p !== undefined)), cutoff);

// --- Row resolution --------------------------------------------------------

/**
 * What a season row resolves to. How it got there depends on **where its id
 * sits**, never on `Type`: a row carrying its own id *is* that SIMKL entry (an
 * anime cour, Doctor Who's 2024 renumbering, Parasyte) and its own counters
 * describe the whole season, while a row inheriting the show row's id is
 * selected out of a multi-season entry by season number.
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
  // Poisoning the whole row matters more than it looks. Summing a two-id row
  // over one survivor yields half the true count, and monotonicity only blocks
  // decreases — so a sheet value below that half would be quietly overwritten
  // with a wrong-but-larger number. It is the one multi-id failure the guards
  // would not otherwise catch.
  if (missing.length) return skipped('unknown-id', `${label}: SIMKL id ${missing.join(', ')} is in no list`);
  const resolved = progresses as TitleProgress[];

  if (season.ids.length) {
    // A cour entry stands for exactly one season. One reporting several means
    // the row and the entry are not the same thing, and no rule here can say
    // which of its seasons this row means.
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
      // An ordered list, so the last id is the one that ends the row — and the
      // one that dates it. It is also the right *recency* signal, which looks
      // wrong until you know how the cell is maintained: ids go in release
      // order, and a second is only added once the first is finished. So the
      // last id is always the active one, and mid-first-cour the row simply
      // does not have the second id yet. A max across the ids would be the
      // obvious alternative and would say the same thing.
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
 * freely overwritten once there is recent activity, which is the user's call —
 * the one thing lost is that resuming a cancelled show and finishing it yields
 * `Ended`.
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
  // `airing` and `tba` both mean more is coming, which is exactly Up To Date.
  return 'Up To Date';
};

/**
 * Whether the highest-numbered season SIMKL knows about is part-way through
 * airing — some out, some still to come.
 *
 * `aired > 0` matters. A season listed with nothing aired yet is an announced
 * future one, and a viewer caught up on everything released is *Up To Date* by
 * the user's own definition ("all aired seasons are over and watched and a new
 * season is coming eventually"), not *Watching* with nothing to watch.
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
   * Finished airing. What decides the *runtime*, because episode lengths settle
   * when the last one airs and not when anyone finishes watching.
   */
  aired: boolean;
  /** Finished airing *and* finished being watched. What decides the `End` date. */
  complete: boolean;
}

/**
 * Which season a block would gain a row for.
 *
 * A season inserted complete is dated by the same fill that creates it, so its
 * runtime has exactly one chance to be asked for — before the row exists. That
 * is why the insert path emits a runtime demand of its own. The insert must
 * never *require* the runtime to have arrived, though: a row whose number never
 * comes back is inserted open and closed by the ordinary per-row path a poll
 * later, which keeps a bug there costing a poll rather than a cell.
 */
const insertTarget = (
  block: ShowBlock,
  index: Map<number, TitleProgress>,
  titles: Map<number, TitleCatalogue>,
  duplicates: Set<number>,
  cutoff: Temporal.Instant,
): InsertCandidate | null => {
  // Anime is never inserted into: one SIMKL record is one cour, so its season
  // numbers do not address rows in a block the user numbers by broadcast
  // season. The same pair of tests as the runtime write, because both put
  // something into a row it cannot take back.
  if (!runtimeScopeOk(block)) return null;

  // Declined when another row claims the same id, the rule `resolveRow` applies
  // to a season row: one title's progress cannot plan rows in two blocks.
  const sourceId = statusSource(block);
  if (sourceId === null || duplicates.has(sourceId)) return null;
  const source = index.get(sourceId);
  if (!source) return null;

  // Every whole season the block already has a row for, computed independently
  // of whether that row resolved. A row the planner declined to read is still a
  // row, and inserting a second one for the same season is the one insert
  // mistake nothing downstream could detect.
  const covered = new Set(block.seasons.map((s) => s.season).filter((n): n is number => n !== null && Number.isInteger(n)));

  const season = [...source.seasons.values()]
    .filter((s) => s.watched > 0 && !covered.has(s.number) && within(s.lastWatchedAt, cutoff))
    .sort((a, b) => a.number - b.number)[0];
  if (!season) return null;

  const shape = titles.get(source.id)?.shapes.get(season.number);
  return { source, season, aired: seasonAired(shape), complete: seasonComplete(shape, season.watched) };
};

/**
 * The TVDB lookup a prospective row would need, or null where none is possible.
 *
 * Two of `runtimeTarget`'s clauses are missing because a new row satisfies them
 * by construction: it has no cell yet, so the blank-cell test cannot fail, and
 * `id` is not in the insert's whitelist, so the row necessarily inherits the
 * block's. Scope is already settled by `insertTarget`. What is left is a whole
 * season number and a key to join on.
 */
const insertRuntimeTarget = (candidate: InsertCandidate, titles: Map<number, TitleCatalogue>): RuntimeRequest | null => {
  const { source, season } = candidate;
  // No whole-season test to make: `seasonsOf` is the only producer of a
  // `SeasonProgress` and drops everything fractional or below 1, where a grid
  // row's number is whatever someone typed into the cell.
  const tvdbId = titles.get(source.id)?.tvdbId;
  if (typeof tvdbId !== 'number') return null;
  return { id: source.id, tvdbId, season: season.number };
};

// --- The runtime a closing row can still take ------------------------------

/**
 * Whether a season row is one a TVDB season number can describe at all, and the
 * lookup it would need.
 *
 * All the clauses are load-bearing:
 *
 * - `runtimeScopeOk`: the block's numbers must mean something to TVDB, which
 *   anime's never do — every SIMKL anime record numbers its own episodes
 *   season 1, and all cours of a franchise share one TVDB id. The episode
 *   count cannot disambiguate either: Demon Slayer's TVDB seasons 3 and 4 both
 *   hold 11 episodes at different lengths.
 * - the row **inherits** the block's id. A row carrying its own id is one whose
 *   season number is explicitly not the entry's — a split cour, Parasyte,
 *   Doctor Who's 2024 renumbering — which is exactly the case where the number
 *   cannot be handed to TVDB.
 * - a whole season number, since `13.5` encodes a judgement no rule reproduces.
 * - a TVDB id to join on.
 * - only a blank cell is ever a target: a typed number is a deliberate
 *   correction, and nothing here can tell a better one from a worse one.
 */
const runtimeTarget = (
  grid: Grid,
  block: ShowBlock,
  season: SeasonRow,
  index: Map<number, TitleProgress>,
  titles: Map<number, TitleCatalogue>,
): RuntimeRequest | null => {
  if (!runtimeScopeOk(block)) return null;
  if (season.ids.length) return null;
  if (season.season === null || !Number.isInteger(season.season)) return null;

  // The same id `resolveRow` reads for its by-season branch. Mirrored rather
  // than re-derived: a narrower rule here than there is what would strand a row.
  const id = idsFor(block, season)[0];
  if (id === undefined || !index.has(id)) return null;

  const tvdbId = titles.get(id)?.tvdbId;
  if (typeof tvdbId !== 'number') return null;

  if (!isBlank(cellAt(grid, season.row, grid.columns.Episodes))) return null;

  return { id, tvdbId, season: season.season };
};

// --- The plan --------------------------------------------------------------

/**
 * Plan the whole sheet against what the catalogue currently holds, and say what
 * more is needed.
 *
 * `demands.catalogue` names every lookup the in-scope blocks run on, with no
 * memory of what was already fetched — deciding what is actually *stale* is the
 * store's job, not the planner's. `demands.runtimes` names only the seasons
 * whose close or insert is waiting on an answer, so it is empty once the store
 * has them (or has settled that none is coming).
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
    // season ended" — it is what discovers that. Anime needs none of it: one
    // entry is one cour, so its own counters already describe the season.
    if (!anime) {
      for (const id of block.ids) demands.catalogue.push({ id, episodes: true, detail: true });
    }
    const sourceId = statusSource(block);
    if (sourceId !== null) demands.catalogue.push({ id: sourceId, anime, detail: true });

    // Two rows describing the same season of the same title. One title's
    // progress cannot say which to advance, so both would be planned the same
    // count — the same number written twice, silently, and only one of them
    // rolls up into the show row above. Keyed on the *effective* id, because a
    // blank season row inherits the block's: an anime block whose rows each
    // carry their own id has one season 1 per title and is not this.
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

      // A season row with an end date is finished, by the user's decision. It
      // is never revisited — which is also why a wrongly-stamped end date could
      // never be corrected, and why `End` is so conservative.
      if (season.closed) continue;
      if (!within(resolved.lastWatchedAt, cutoff)) continue;

      const label = `${block.title} S${season.season ?? '?'}`;
      if (season.season !== null && idsFor(block, season).some((id) => (claims.get(`${id}:${season.season}`) ?? 0) > 1)) {
        plan.skips.push({ code: 'duplicate-season', message: `${label}: more than one row describes this season, so neither is written` });
        continue;
      }
      // A hand-typed count — "12 (rewatch)", "~8" — parses to null, so the
      // comparison below would read it as 0 and plan an edit the guard refuses
      // unconditionally. Refusal is whole-plan, so one such cell would stop
      // every unrelated edit in the run for as long as the row stays inside the
      // activity window. Skipped here so the guard stays the backstop rather
      // than the gate, and the reason names the row instead of the planner.
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

      // What this row's runtime cell can still become, decided before anything
      // is written. Writing `End` closes the row for good — the guard refuses
      // every later edit to a dated row — so a season whose runtime has been
      // *asked for and not answered* must wait rather than close blind. The date
      // is not lost by waiting: it comes from the watch timestamp, so a row
      // deferred three polls gets the identical serial three polls later.
      const target = runtimeTarget(grid, block, season, index, titles);
      // The map is the whole state machine, so one read answers it: `undefined`
      // is unanswered, `null` is settled with nothing usable, and a number is
      // the answer. A row with no target has nothing to wait for.
      const minutes = target === null ? null : titles.get(target.id)?.seasonRuntimes.get(target.season);
      if (minutes === undefined && target !== null) {
        demands.runtimes.push(target);
        plan.skips.push({ code: 'awaiting-runtimes', message: `${label}: complete, but its episode runtimes have not come back — left open for the next poll` });
        continue;
      }

      plan.edits.push(edit(grid, season.row, 'End', num(serial), `${label}: ended`));

      if (target !== null) {
        // Settled with nothing usable falls back to the show-wide runtime, the
        // same as a row being created does. This batch dates the row either way,
        // so the choice is between an approximate number and a cell nothing can
        // ever fill again — and it must not depend on which run first saw the
        // season, or two identical-looking rows differ for a reason no reader of
        // the sheet could see.
        const days = runtimeDays(minutes) ?? runtimeDays(titles.get(target.id)?.runtime);
        if (days === null) {
          plan.notes.push(`${label}: ended with no usable episode runtimes, so its Episodes cell is left blank`);
        } else {
          // Named for what it is: the season's own average where TVDB answered,
          // the show's usual episode length where it did not.
          const measured = minutes === null ? "SIMKL's show-wide episode runtime" : `${minutes} min average episode runtime`;
          plan.edits.push(edit(grid, season.row, 'Episodes', num(days), `${label}: ${measured}`));
        }
      }
    }

    // --- Status, and the season-row insert
    //
    // Both are driven by the block's status source, so both are declined when
    // that id is claimed by another row as well — the same rule `resolveRow`
    // applies to a season row. Without it one title's progress writes Status on
    // two unrelated blocks and plans a new row in each.
    const source = (sourceId === null ? null : index.get(sourceId)) ?? null;
    if (sourceId !== null && duplicates.has(sourceId)) {
      plan.skips.push({ code: 'duplicate-id', message: `${block.title}: id ${sourceId} is claimed by more than one row, so Status and new rows are left alone` });
    } else if (source) {
      const entry = titles.get(source.id);
      // Which model applies is decided by where the ids sit, never by whether
      // data happened to arrive. Anime asks its own not-aired counter because
      // one entry is one cour. A live-action block with no shapes is a *failed
      // lookup*, not a cour, and reading it as one would answer with a count
      // that spans the whole show rather than the latest season. So it declines
      // to write; the lookup failure already asks for another poll.
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

      const candidate = insertTarget(block, index, titles, duplicates, cutoff);
      if (candidate) {
        // The row this walk cannot reach: the season about to be inserted has
        // no row yet, and one that arrives complete is dated by the same fill
        // that creates it — so its runtime is demanded before the row exists.
        //
        // Gated on *airing*, not on watching: a season that has finished airing
        // has settled runtimes however little of it has been seen. The gate is
        // a hard rule rather than an optimisation — `averageRuntime` checks
        // TVDB's count against SIMKL's, and while a season is still airing
        // SIMKL's has not settled, so the answer would be a null recorded as
        // *settled* in a map with no age ceiling. That forfeits the cell before
        // the season has even ended.
        if (candidate.aired) {
          const key = insertRuntimeTarget(candidate, titles);
          if (key && titles.get(key.id)?.seasonRuntimes.get(key.season) === undefined) demands.runtimes.push(key);
        }

        const insert = planInsert(grid, block, candidate, titles, { timezone });
        if (insert && 'code' in insert) plan.skips.push(insert);
        else if (insert) {
          // One row per run: starting two seasons between polls defers the
          // second. It is not lost — the job re-plans the whole sheet every run
          // and the next one takes it — but it has to say so: a silent deferral
          // reads exactly like a season the sync never noticed, which is the
          // failure a report exists to rule out.
          if (plan.insert === null) plan.insert = insert;
          else {
            plan.deferredInserts += 1;
            plan.notes.push(`${insert.title} S${insert.season} is ready to add — deferred, one row is added per run`);
          }
        }
      }
    }
  }

  // Titles SIMKL knows about with no row at all. Reported, never added: a new
  // show is the user's call, and a new anime cour is a separate SIMKL title
  // under a romaji name that mostly does not match what the sheet calls the
  // series. Matching on title is unreliable enough that this must never try.
  for (const progress of index.values()) {
    if (seen.has(progress.id) || !within(progress.lastWatchedAt, cutoff)) continue;
    plan.notes.push(`${progress.title} (simkl ${progress.id}) has recent activity and no row — add it by hand if you want it tracked`);
  }

  return { plan, demands };
};

/**
 * A season SIMKL says was watched and the block has no row for.
 *
 * Live-action only, whole seasons only. A fractional label encodes a judgement
 * — Doctor Who's `13.5`, Attack On Titan's `1.5` — that no rule here could
 * reproduce, and SIMKL's season 0 is specials.
 */
const planInsert = (
  grid: Grid,
  block: ShowBlock,
  { source, season: candidate, aired, complete }: InsertCandidate,
  titles: Map<number, TitleCatalogue>,
  { timezone }: { timezone: string },
): RowInsert | Skip | null => {
  const label = `${block.title} S${candidate.number}`;
  const entry = titles.get(source.id);

  const start = watchSerial(candidate.firstWatchedAt, timezone);
  if (start === null) return { code: 'unusable-timestamp', message: `${label}: would be added, but its first watch timestamp is unusable` };

  // Keep Season ascending within the block: before the first existing row with
  // a higher number, or after the last one.
  const whole = block.seasons.filter((s) => s.season !== null && Number.isInteger(s.season));
  const after = whole.find((s) => (s.season as number) > candidate.number);
  const row = after ? after.row : (block.seasons.at(-1)?.row ?? block.row) + 1;

  // inheritFromBefore takes its formats from the row above. Without a season
  // row there, it inherits the *show* row's, and a correct date serial renders
  // as `46265`.
  if (!block.seasons.some((s) => s.row < row)) {
    return { code: 'no-format-row', message: `${label}: would be added, but there is no season row above the insertion point to inherit formats from` };
  }

  // What this row's runtime cell can hold, and whether this same fill may date
  // the row. A row created and dated in one batch is never revisited, so its
  // `Episodes` cell has exactly one chance to be right.
  const target = insertRuntimeTarget({ source, season: candidate, aired, complete }, titles);
  const minutes = target === null ? undefined : entry?.seasonRuntimes.get(target.season);
  // Whether `/tv/{id}` has answered for this title at all. The store writes
  // `tvdbId` as a number or an explicit null the moment the detail lands, so
  // its absence is the one reliable signal that it has not — `runtime` and
  // `status` are both legitimately absent on a detail that did arrive.
  const detailed = entry?.tvdbId !== undefined;

  // The runtime follows *airing*; the date below follows watching. A season one
  // episode into a finished run has settled episode lengths and no business
  // being dated, and those are two different answers about the same row.
  //
  // Left blank only while something can still fill it: a season still airing
  // waits for the batch that closes the row, because a filled cell is one the
  // close can never correct. With no join key there is nothing to wait for, so
  // the show-wide runtime is the best there will ever be.
  const runtime =
    target === null ? runtimeDays(entry?.runtime)
    : !aired ? null
    // Settled, either way. `runtimeDays` also rejects an average that is not a
    // length an episode has, and the show-wide number is better than a cell
    // nothing will ever be able to fill again.
    : minutes !== undefined ? (runtimeDays(minutes) ?? runtimeDays(entry?.runtime))
    : null;

  // Whether anything can still reach this cell — a fact about the runtime alone,
  // which is why it is not bundled with the watching below. Dating the row while
  // that is open would freeze a blank cell, and the date is not lost by waiting:
  // it comes from the watch timestamp, so the next poll writes the identical
  // serial with the runtime beside it.
  //
  // Two ways to be waiting, and the first is the one a null join key hides: an
  // absent `tvdbId` is the detail call not having answered, where null is it
  // answering that there is no key. Reading a failed lookup as a settled "no
  // key" dates the row on a 503 — the same absent-versus-settled distinction
  // `seasonRuntimes` draws, and the same cost for getting it wrong.
  const waiting = !detailed || (target !== null && minutes === undefined);
  const end = complete && !waiting ? watchSerial(candidate.lastWatchedAt, timezone) : null;

  const cells: Array<{ field: HeaderName; value: ExtendedValue }> = [
    { field: 'Season', value: num(candidate.number) },
    { field: 'Episode', value: num(candidate.watched) },
    { field: 'Start', value: num(start) },
    ...(runtime === null ? [] : [{ field: 'Episodes' as const, value: num(runtime) }]),
    {
      field: 'Length',
      // The sheet's own convention: runtime x episodes watched. Written as a
      // formula so it keeps tracking the count the way every other row does.
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
    // Why the cell went in blank, where that is not simply "the season is still
    // running". A row added without a runtime nothing can supply is the one a
    // reader has to finish by hand, so it says so rather than leaving an empty
    // cell to be noticed.
    note: `${label}: new season row at ${row + 1}, ${candidate.watched} episodes${end === null ? '' : ', ended'}${
      complete && end === null ? ', added open — its episode runtimes have not come back'
      // Blank with nothing left outstanding is blank for good, dated or not:
      // there is no join key, or the key's answer is in and unusable. A row
      // still waiting on an answer is not this, and says nothing.
      : runtime === null && !waiting ? ', with no episode runtime to fill its Episodes cell'
      : ''
    }`,
  };
};

// --- What survives the run --------------------------------------------------

/**
 * What one planned edit looks like once the plan itself is gone: where it
 * landed, which column, and the planner's own wording for what changed.
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
 * Structured rather than `describePlan`'s strings because the page renders the
 * cell, the column and the wording as three columns, and a joined line cannot
 * be split back into them. The skip and note lines are deliberately dropped:
 * those answer "why was this row left alone", which the page does not ask.
 *
 * Every count downstream is a `.length` of one of these, so a run cannot report
 * a plan size that disagrees with the plan it is reporting.
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
