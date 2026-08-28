/**
 * PLAN — grid + library + catalogue → a plan.
 *
 * Third of READ → PARSE → **PLAN** → GUARD → BUILD → APPLY → VERIFY. Pure, and
 * **never throws**: an
 * unresolvable row becomes a skip with a reason, not an exception. The sync
 * calls this from inside a path that must degrade rather than fail.
 *
 * The write surface is three fields — a season's `Episode`, a season's `End`,
 * and a show's `Status` — plus inserting a season row. Everything else on the
 * sheet is either hand-maintained or a formula that rolls up by itself.
 */

import { config } from '../shared/config.ts';
import { a1, columnLetter, duplicateIds, idsFor, isBlank, numberOf, type ColumnMap, type Grid, type HeaderName, type SeasonRow, type ShowBlock } from './2-grid.ts';
import { courComplete, runtimeDays, seasonAired, seasonComplete, watchSerial, type SeasonProgress, type SeasonShape, type TitleProgress } from './1-progress.ts';
import type { RuntimeRequest } from './io/runtimes.ts';
import type { CatalogueRequest } from './io/catalogue.ts';
import type { CellData, ExtendedValue } from '../api/google/types.ts';

/**
 * What one title's catalogue lookups reduce to. Everything the planner reads,
 * and nothing else: the raw `/tv/episodes/{id}` array is only ever fed to
 * `seasonShapes`, and the `extended=full` detail object is only ever asked for
 * `status` and `runtime`. Deriving at fold-in time computes the shapes once per
 * title instead of once per season row, and keeps per-episode descriptions and
 * images out of a map that lives for the life of the process.
 */
export interface TitleCatalogue {
  shapes: Map<number, SeasonShape>;
  status?: string;
  runtime?: number | null;
  /**
   * The join key to per-episode runtimes. Null where there is no path to one at
   * all — SIMKL carries no TVDB id, or there is no credential to ask with. The
   * planner needs no second switch for the feature, because a row it cannot look
   * up and a row there is no point looking up are the same row to every rule
   * here.
   */
  tvdbId?: number | null;
  /**
   * Season number to its average episode runtime in whole minutes, or null for
   * *asked, and there is no usable answer*.
   *
   * The null matters as much as the number. A key that is present says the
   * question is settled and the row may be closed; a key that is **absent** says
   * the lookup has not answered, and closing the row on that would forfeit the
   * cell forever — a dated row is never revisited. Two collections would let
   * those two states be confused; one map with a nullable value cannot.
   *
   * No age ceiling, unlike the catalogue's stamps: a finished season's runtimes
   * are terminal, where `/tv/{id}`'s `status` flips on a renewal.
   */
  seasonRuntimes: Map<number, number | null>;
}

export interface CatalogueView {
  titles: Map<number, TitleCatalogue>;
  /** Ids whose lookup errored in a way worth retrying. */
  failed: number[];
  unavailable: number[];
}

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

export interface SheetPlan {
  edits: CellEdit[];
  inserts: RowInsert[];
  /** Rows deliberately left alone, with the reason. Reported, never acted on. */
  skipped: string[];
  /** Everything else worth a human's attention — new shows, new cours. */
  notes: string[];
  /**
   * Rows that were ready to add but did not fit under the per-run cap. Work
   * known to be waiting, so the sync asks for another poll rather than letting
   * it sit until something else happens to wake one.
   */
  deferred: number;
}

export interface PlanOptions {
  now?: Temporal.Instant;
  timezone?: string;
  sinceDays?: number;
}

const cellAt = (grid: Grid, row: number, column: number): CellData | undefined => grid.snapshot.rows[row]?.[column];

const num = (numberValue: number): ExtendedValue => ({ numberValue });
const str = (stringValue: string): ExtendedValue => ({ stringValue });

const edit = (
  grid: Grid,
  row: number,
  field: HeaderName,
  value: ExtendedValue,
  note: string,
): CellEdit => {
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
 * One copy because `planLookups` and `planSync` must agree about which blocks
 * are in scope, and three hand-written copies of the same arithmetic is how
 * they would stop agreeing.
 */
const cutoffFrom = (now: Temporal.Instant, sinceDays: number): Temporal.Instant =>
  // Hours rather than `{ days }`, which an `Instant` refuses outright: a day is
  // a calendar unit and an instant has no calendar. That is also the behaviour
  // wanted — an exact span, so the window does not move by an hour twice a year.
  now.subtract({ hours: sinceDays * 24 });

/**
 * Has anything in this block been watched recently enough to touch?
 *
 * One definition on purpose: the cut-off is what stops any run retro-editing
 * years of history, and `planLookups` and `planSync` must never disagree about
 * which blocks are in scope.
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
interface ResolvedRow {
  watched: number;
  complete: boolean;
  lastWatchedAt: Temporal.Instant | null;
}

const numberedSeasons = (progress: TitleProgress): number[] => [...progress.seasons.keys()];

const watchedIn = (progress: TitleProgress): number =>
  [...progress.seasons.values()].reduce((total, season) => total + season.watched, 0);

/**
 * Resolve one season row, or explain why not. The string is a skip reason; a
 * `null` return means there is simply nothing here to do.
 */
const resolveRow = (
  block: ShowBlock,
  season: SeasonRow,
  index: Map<number, TitleProgress>,
  catalogue: CatalogueView,
  duplicates: Set<number>,
): ResolvedRow | string | null => {
  const ids = idsFor(block, season);
  if (!ids.length) return null;

  const label = `${block.title} S${season.season ?? '?'} (row ${season.row + 1})`;

  const claimed = ids.filter((id) => duplicates.has(id));
  if (claimed.length) return `${label}: id ${claimed.join(', ')} is claimed by more than one row`;

  const progresses = ids.map((id) => index.get(id));
  const missing = ids.filter((_, i) => !progresses[i]);
  // Poisoning the whole row matters more than it looks. Summing a two-id row
  // over one survivor yields half the true count, and monotonicity only blocks
  // decreases — so a sheet value below that half would be quietly overwritten
  // with a wrong-but-larger number. It is the one multi-id failure the guards
  // would not otherwise catch.
  if (missing.length) return `${label}: SIMKL id ${missing.join(', ')} is in no list`;
  const resolved = progresses as TitleProgress[];

  if (season.ids.length) {
    // A cour entry stands for exactly one season. One reporting several means
    // the row and the entry are not the same thing, and no rule here can say
    // which of its seasons this row means.
    const multi = resolved.filter((p) => numberedSeasons(p).length > 1);
    if (multi.length) {
      return `${label}: SIMKL entry ${multi.map((p) => p.id).join(', ')} covers ${multi.map((p) => numberedSeasons(p).length).join(', ')} seasons, so the row is ambiguous`;
    }
    return {
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

  if (season.season === null || !Number.isInteger(season.season)) return null;
  const progress = resolved[0] as TitleProgress;
  const watched = progress.seasons.get(season.season);
  if (!watched || watched.watched === 0) return null;

  return {
    watched: watched.watched,
    complete: seasonComplete(catalogue.titles.get(progress.id)?.shapes.get(season.season), watched.watched),
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

// --- Lookups ---------------------------------------------------------------

/**
 * What we already hold for one title's catalogue, and how current it is.
 *
 * `watchedAt` is the value `lastWatchedAt` had when the lookup was made, not
 * when it was stored — comparing it against the library's current value is the
 * whole gate.
 */
export interface CatalogueStamp {
  watchedAt: Temporal.Instant | null;
  /** When the lookup was made. */
  at: Temporal.Instant;
}

/**
 * Whether a title's catalogue needs re-reading.
 *
 * Watch activity is the trigger, because it is the trigger for everything this
 * sync writes. A season cannot become complete without being watched, and
 * watching moves `lastWatchedAt` — so the case that matters always fires.
 *
 * The age ceiling is the backstop for the case that does not: `/tv/{id}` status
 * flipping on a renewal, which produces no library activity at all. Same
 * reasoning as `movieRefresh`, and the same daily cadence — a studio moving a
 * release, or a network renewing a show, changes nothing you could gate on.
 */
export const needsLookup = (
  stamp: CatalogueStamp | undefined,
  progress: TitleProgress | undefined,
  now: Temporal.Instant,
  maxAge: Temporal.Duration | null,
): boolean => {
  if (!stamp) return true;
  // Same shape as `filmDue`'s floor, and now the same spelling: a stamp is stale
  // once `now` has passed it by the ceiling. Null means no ceiling at all, which
  // is what a caller that gates purely on watch activity wants.
  if (maxAge && Temporal.Instant.compare(now, stamp.at.add(maxAge)) > 0) return true;
  // By value. Two `Instant`s for the same moment are different objects, so `!==`
  // here would be true forever and every title would be re-read every poll.
  return !sameInstant(stamp.watchedAt, progress?.lastWatchedAt ?? null);
};

const sameInstant = (a: Temporal.Instant | null, b: Temporal.Instant | null): boolean =>
  a === null || b === null ? a === b : a.equals(b);

export interface LookupOptions extends PlanOptions {
  /** What is already held, keyed by SIMKL id. Empty on a cold process. */
  stamps?: Map<number, CatalogueStamp>;
  maxAge?: Temporal.Duration | null;
}

/**
 * Which catalogue lookups to actually make, decided before any are made.
 *
 * Two filters, and both matter. The cut-off drops 289 of 307 blocks, which is
 * what keeps a cold run at roughly 28 calls rather than 600. The per-title
 * stamp then drops everything that has not moved since it was last read, which
 * is what keeps a *warm* run at roughly 2 — without it, watching one episode
 * re-reads the catalogue of every eligible show, since `/sync/activities`
 * resolves only to the list and never to the title.
 */
export const planLookups = (
  grid: Grid,
  index: Map<number, TitleProgress>,
  { now = Temporal.Now.instant(), sinceDays = config.sheetSinceDays, stamps = new Map<number, CatalogueStamp>(), maxAge = null }: LookupOptions = {},
): CatalogueRequest[] => {
  const cutoff = cutoffFrom(now, sinceDays);
  const requests: CatalogueRequest[] = [];
  const due = (id: number): boolean => needsLookup(stamps.get(id), index.get(id), now, maxAge);

  for (const block of grid.blocks) {
    if (!isRecent(blockIds(block), index, cutoff)) continue;

    const anime = block.ids.length === 0;
    // The episode list cannot be gated on "a season ended" — it is what
    // discovers that. Anime needs none of it: one entry is one cour, so its own
    // counters already describe the season.
    if (!anime) {
      for (const id of block.ids) if (due(id)) requests.push({ id, episodes: true, detail: true });
    }
    const source = statusSource(block);
    if (source !== null && due(source)) requests.push({ id: source, anime, detail: true });
  }
  return requests;
};

// --- The row a block does not have yet -------------------------------------

/** The season a block would gain a row for, and whether it is already over. */
export interface InsertCandidate {
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
 * **Called by both passes**, and that is the point rather than a convenience.
 * `planRuntimeLookups` asks TVDB about a row that does not exist yet, and
 * `planInsert` builds that row. A season inserted complete is dated by the same
 * fill that creates it, so its runtime has exactly one chance to be asked for —
 * before the row exists. Two copies of this rule that drifted would send the
 * answer for a season nothing inserts.
 *
 * Disagreement is survivable here in a way it is not for `runtimeTarget`, and
 * the difference is worth knowing: a lookup nothing uses costs one cached call,
 * and a row whose number never arrived is inserted *open* and closed by the
 * ordinary per-row path a poll later. The insert must therefore never require
 * the runtime to have arrived — that is what keeps a bug here costing a poll
 * rather than a cell.
 */
const insertTarget = (
  block: ShowBlock,
  index: Map<number, TitleProgress>,
  catalogue: CatalogueView,
  duplicates: Set<number>,
  cutoff: Temporal.Instant,
): InsertCandidate | null => {
  // Anime is never inserted into: one SIMKL record is one cour, so its season
  // numbers do not address rows in a block the user numbers by broadcast season.
  if (block.type !== 'show' || block.ids.length === 0) return null;

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

  const shape = catalogue.titles.get(source.id)?.shapes.get(season.number);
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
const insertRuntimeTarget = (candidate: InsertCandidate, catalogue: CatalogueView): RuntimeRequest | null => {
  const { source, season } = candidate;
  // No whole-season test to make: `seasonsOf` is the only producer of a
  // `SeasonProgress` and drops everything fractional or below 1, where a grid
  // row's number is whatever someone typed into the cell.
  const tvdbId = catalogue.titles.get(source.id)?.tvdbId;
  if (typeof tvdbId !== 'number') return null;
  return { id: source.id, tvdbId, season: season.number };
};

// --- Runtime lookups -------------------------------------------------------

/**
 * Whether a season row is one a TVDB season number can describe at all, and the
 * lookup it would need.
 *
 * **Called by both passes**, and that is the point rather than a convenience.
 * `planRuntimeLookups` uses it to decide what to ask for and `planSync` uses it
 * to tell *settled — no runtime is obtainable here* from *asked, and waiting*.
 * If the two ever disagreed, a row would defer for ever: never requested, and
 * never closed either.
 *
 * All five clauses are load-bearing:
 *
 * - `type === 'show'` **and** ids on the show row. These are not redundant.
 *   `planSync` and `planLookups` read anime as "no block ids" alone, and that
 *   test disagrees with this one for an anime block someone gave a show-row id —
 *   a hand-maintained file, so nothing prevents one. Testing only the ids would
 *   class it live-action and ask TVDB for a season number that means something
 *   else there. `planInsert` guards itself with the same pair, for the same
 *   reason: both write something a row cannot take back.
 * - the row **inherits** the block's id. A row carrying its own id is one whose
 *   season number is explicitly not the entry's — a split cour, Parasyte, Doctor
 *   Who's 2024 renumbering — which is exactly the case where the number cannot
 *   be handed to TVDB.
 * - a whole season number, since `13.5` encodes a judgement no rule reproduces.
 * - a TVDB id to join on.
 *
 * Anime is excluded outright rather than guarded, because there is nothing to
 * guard with: every SIMKL anime record numbers its own episodes season 1
 * whatever cour it is, and all cours of a franchise share one TVDB id. Asking
 * for "season 1" returns the whole multi-cour season, and the episode count
 * cannot disambiguate either — Demon Slayer's TVDB seasons 3 and 4 both hold 11
 * episodes at different lengths.
 */
export const runtimeTarget = (
  grid: Grid,
  block: ShowBlock,
  season: SeasonRow,
  index: Map<number, TitleProgress>,
  catalogue: CatalogueView,
): RuntimeRequest | null => {
  if (block.type !== 'show' || block.ids.length === 0) return null;
  if (season.ids.length) return null;
  if (season.season === null || !Number.isInteger(season.season)) return null;

  // The same id `resolveRow` reads for its by-season branch. Mirrored rather
  // than re-derived: a narrower rule here than there is what would strand a row.
  const id = idsFor(block, season)[0];
  if (id === undefined || !index.has(id)) return null;

  const tvdbId = catalogue.titles.get(id)?.tvdbId;
  if (typeof tvdbId !== 'number') return null;

  // Only a blank cell is ever a target. Folded in here rather than tested at
  // each call site for the same reason as everything above it: a rule the two
  // passes have to agree on, kept in one place so they cannot stop agreeing.
  if (!isBlank(cellAt(grid, season.row, grid.columns.Episodes))) return null;

  return { id, tvdbId, season: season.season };
};

/**
 * Which season runtimes to look up, decided after the catalogue read and before
 * the plan.
 *
 * A second pass is needed because the question — which seasons are *completing*
 * — cannot be answered until `seasonShapes` has come back, and the blank-cell
 * test needs the grid. Fetching every season of every in-scope title instead
 * would be roughly 110 calls on a cold run against the 0–2 this makes, and would
 * re-read seasons the sheet closed long ago.
 *
 * Deliberately *not* a copy of every rule `planSync` applies before it writes:
 * the multi-row claim check and the non-numeric `Episode` check are both skipped
 * here, because a false positive costs one cached call and a false negative
 * costs nothing at all. Only `runtimeTarget` has to agree exactly.
 */
export const planRuntimeLookups = (
  grid: Grid,
  index: Map<number, TitleProgress>,
  catalogue: CatalogueView,
  { now = Temporal.Now.instant(), sinceDays = config.sheetSinceDays }: PlanOptions = {},
): RuntimeRequest[] => {
  const cutoff = cutoffFrom(now, sinceDays);
  const duplicates = duplicateIds(grid.blocks);
  const requests: RuntimeRequest[] = [];

  for (const block of grid.blocks) {
    if (!isRecent(blockIds(block), index, cutoff)) continue;

    for (const season of block.seasons) {
      // A dated row is finished by the user's decision and never revisited, so
      // there is no cell here left to fill.
      if (season.closed) continue;
      const key = runtimeTarget(grid, block, season, index, catalogue);
      if (!key) continue;

      const entry = catalogue.titles.get(key.id);
      // Terminal once answered — including a null answer, which is settled.
      if (entry?.seasonRuntimes.has(key.season)) continue;

      const resolved = resolveRow(block, season, index, catalogue, duplicates);
      if (resolved === null || typeof resolved === 'string') continue;
      if (!resolved.complete) continue;
      if (!within(resolved.lastWatchedAt, cutoff)) continue;

      requests.push(key);
    }

    // The row that is not there yet. The walk above is over rows the grid has,
    // so a season about to be inserted is never reached by it — and an insert
    // that arrives complete is dated by the same fill that creates it, so there
    // is no later batch to carry the cell.
    const candidate = insertTarget(block, index, catalogue, duplicates, cutoff);
    // Gated on *airing*, not on watching. A season that has finished airing has
    // settled runtimes however little of it has been seen, and a row added one
    // episode into a finished season is exactly the case that wants them.
    //
    // That it is gated at all is a hard rule rather than an optimisation:
    // `averageRuntime` checks TVDB's episode count against SIMKL's, and while a
    // season is still airing SIMKL's has not settled — so the answer would be a
    // null recorded as *settled*, and `seasonRuntimes` has no age ceiling. That
    // forfeits the cell before the season has even ended.
    if (candidate?.aired) {
      const key = insertRuntimeTarget(candidate, catalogue);
      if (key && !catalogue.titles.get(key.id)?.seasonRuntimes.has(key.season)) requests.push(key);
    }
  }
  return requests;
};

// --- The plan --------------------------------------------------------------

export const planSync = (
  grid: Grid,
  index: Map<number, TitleProgress>,
  catalogue: CatalogueView,
  { now = Temporal.Now.instant(), timezone = config.timezone, sinceDays = config.sheetSinceDays }: PlanOptions = {},
): SheetPlan => {
  const plan: SheetPlan = { edits: [], inserts: [], skipped: [], notes: [], deferred: 0 };
  const cutoff = cutoffFrom(now, sinceDays);
  const duplicates = duplicateIds(grid.blocks);
  const seen = new Set<number>();

  for (const block of grid.blocks) {
    const ids = blockIds(block);
    for (const id of ids) seen.add(id);

    // The cut-off applies uniformly, with no exemptions. A dormant sheet
    // produces zero edits, and no run can retro-edit years of history.
    if (!isRecent(ids, index, cutoff)) continue;
    const anime = block.ids.length === 0;

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
      const resolved = resolveRow(block, season, index, catalogue, duplicates);
      if (resolved === null) continue;
      if (typeof resolved === 'string') {
        plan.skipped.push(resolved);
        continue;
      }

      // A season row with an end date is finished, by the user's decision. It
      // is never revisited — which is also why a wrongly-stamped end date could
      // never be corrected, and why `End` is so conservative.
      if (season.closed) continue;
      if (!within(resolved.lastWatchedAt, cutoff)) continue;

      const label = `${block.title} S${season.season ?? '?'}`;
      if (season.season !== null && idsFor(block, season).some((id) => (claims.get(`${id}:${season.season}`) ?? 0) > 1)) {
        plan.skipped.push(`${label}: more than one row describes this season, so neither is written`);
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
        plan.skipped.push(`${label}: the Episode cell holds something that is not a number, so the row is left alone`);
        continue;
      }
      if (resolved.watched > (season.episode ?? 0)) {
        plan.edits.push(edit(grid, season.row, 'Episode', num(resolved.watched), `${label}: ${season.episode ?? 0} -> ${resolved.watched} episodes`));
      }

      if (!resolved.complete) continue;

      const serial = watchSerial(resolved.lastWatchedAt, timezone);
      if (serial === null) {
        plan.skipped.push(`${label}: complete, but its last watch timestamp is unusable`);
        continue;
      }

      // What this row's runtime cell can still become, decided before anything
      // is written. Writing `End` closes the row for good — the guard refuses
      // every later edit to a dated row — so a season whose runtime has been
      // *asked for and not answered* must wait rather than close blind. The date
      // is not lost by waiting: it comes from the watch timestamp, so a row
      // deferred three polls gets the identical serial three polls later.
      const target = runtimeTarget(grid, block, season, index, catalogue);
      // The map is the whole state machine, so one read answers it: `undefined`
      // is asked and unanswered, `null` is settled with nothing usable, and a
      // number is the answer. A row with no target has nothing to wait for.
      const minutes = target === null ? null : catalogue.titles.get(target.id)?.seasonRuntimes.get(target.season);
      if (minutes === undefined) {
        plan.skipped.push(`${label}: complete, but its episode runtimes have not come back — left open for the next poll`);
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
        const days = runtimeDays(minutes) ?? runtimeDays(catalogue.titles.get(target.id)?.runtime);
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
    const sourceId = statusSource(block);
    const source = (sourceId === null ? null : index.get(sourceId)) ?? null;
    if (sourceId !== null && duplicates.has(sourceId)) {
      plan.skipped.push(`${block.title}: id ${sourceId} is claimed by more than one row, so Status and new rows are left alone`);
    } else if (source) {
      const entry = catalogue.titles.get(source.id);
      // Which model applies is decided by where the ids sit — the same rule
      // `planLookups` uses — and never by whether data happened to arrive.
      // Anime asks its own not-aired counter because one entry is one cour. A
      // live-action block with no shapes is a *failed lookup*, not a cour, and
      // reading it as one would answer with a count that spans the whole show
      // rather than the latest season. So it declines to write; `retry` is
      // already set, and the next poll has the answer.
      if (!anime && !entry?.shapes.size) {
        plan.skipped.push(`${block.title}: no episode list came back, so Status is left alone`);
      } else {
        const status = deriveStatus(source, {
          detailStatus: entry?.status,
          latestSeasonAiring: anime ? source.notAiredCount > 0 : latestSeasonAiring(entry?.shapes ?? new Map()),
        });
        if (status !== null && status !== block.status) {
          plan.edits.push(edit(grid, block.row, 'Status', str(status), `${block.title}: ${block.status ?? '(blank)'} -> ${status}`));
        }
      }

      // Re-derived rather than threaded through from the branch above: this is
      // the same question `planRuntimeLookups` asked before the fetch, and one
      // answer to it is the only thing keeping the two passes in step.
      const candidate = insertTarget(block, index, catalogue, duplicates, cutoff);
      const insert = candidate && planInsert(grid, block, candidate, catalogue, { timezone });
      if (typeof insert === 'string') plan.skipped.push(insert);
      else if (insert) {
        // One row per run, and not a setting: every request index in a plan is
        // pre-write, but `insertDimension` applies cumulatively, so a second
        // insert would land a row above where it was planned. `assertPlanSafe`
        // refuses more than one for that reason, so this is an invariant of how
        // the requests are built rather than a number anyone may choose.
        //
        // Starting two seasons between polls therefore defers the second. It is
        // not lost — the job re-plans the whole sheet every run and the next one
        // takes it — but it has to say so: a silent deferral reads exactly like
        // a season the sync never noticed, which is the failure a report exists
        // to rule out.
        if (!plan.inserts.length) plan.inserts.push(insert);
        else {
          plan.deferred += 1;
          plan.notes.push(`${insert.title} S${insert.season} is ready to add — deferred, one row is added per run`);
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

  return plan;
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
  catalogue: CatalogueView,
  { timezone }: { timezone: string },
): RowInsert | string | null => {
  const label = `${block.title} S${candidate.number}`;
  const entry = catalogue.titles.get(source.id);

  const start = watchSerial(candidate.firstWatchedAt, timezone);
  if (start === null) return `${label}: would be added, but its first watch timestamp is unusable`;

  // Keep Season ascending within the block: before the first existing row with
  // a higher number, or after the last one.
  const whole = block.seasons.filter((s) => s.season !== null && Number.isInteger(s.season));
  const after = whole.find((s) => (s.season as number) > candidate.number);
  const row = after ? after.row : (block.seasons.at(-1)?.row ?? block.row) + 1;

  // inheritFromBefore takes its formats from the row above. Without a season
  // row there, it inherits the *show* row's, and a correct date serial renders
  // as `46265`.
  if (!block.seasons.some((s) => s.row < row)) {
    return `${label}: would be added, but there is no season row above the insertion point to inherit formats from`;
  }

  // What this row's runtime cell can hold, and whether this same fill may date
  // the row. A row created and dated in one batch is never revisited, so its
  // `Episodes` cell has exactly one chance to be right.
  const target = insertRuntimeTarget({ source, season: candidate, aired, complete }, catalogue);
  const minutes = target === null ? undefined : entry?.seasonRuntimes.get(target.season);
  // Whether `/tv/{id}` has answered for this title at all. `catalogueFor` writes
  // `tvdbId` as a number or an explicit null the moment the detail lands, so its
  // absence is the one reliable signal that it has not — `runtime` and `status`
  // are both legitimately absent on a detail that did arrive.
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
 * A plan reduced to what survives the run, for the status page's history.
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
  inserts: plan.inserts.map(({ row, title, season, note }) => ({ address: `row ${row + 1}`, title, season, note })),
});

/** A human-readable rendering of a plan, for the log and for `report` mode. */
export const describePlan = (plan: SheetPlan, columns: ColumnMap): string[] => {
  const lines: string[] = [];
  for (const e of plan.edits) lines.push(`  edit   ${e.address.padEnd(7)} ${e.note}`);
  for (const insert of plan.inserts) {
    lines.push(`  insert row ${insert.row + 1}  ${insert.note}`);
    for (const f of insert.fill) lines.push(`           ${columnLetter(columns[f.field])} ${f.field}`);
  }
  for (const s of plan.skipped) lines.push(`  skip   ${s}`);
  for (const n of plan.notes) lines.push(`  note   ${n}`);
  return lines;
};
