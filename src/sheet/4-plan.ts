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

import { config, tvdbConfigured } from '../shared/config.ts';
import {
  a1,
  duplicateIds,
  idsFor,
  isBlank,
  isFormula,
  numberOf,
  runtimeScopeOk,
  SHOW_FIELD_LABELS,
  SHOW_LABELS,
  showFieldColumn,
  usesCourModel,
  type BlockHeaderName,
  type Grid,
  type HeaderName,
  type SeasonRow,
  type ShowBlock,
  type ShowField,
} from './2-grid.ts';
import { courComplete, type SeasonProgress, type TitleProgress } from './1-index.ts';
import {
  artworkFormula,
  franchiseKeyFor,
  genresCell,
  MAX_SECONDARY_GENRES,
  maxSerial,
  ownsNote,
  placeBlock,
  plausibleSerial,
  recordedSerial,
  ROLLUP_FIELDS,
  runtimeMinutes,
  seasonKey,
  showRowFormulas,
  SHOW_TYPE,
  titleCell,
  titleKey,
  TRACKED_FIELDS,
  watchedNote,
  watchSerial,
} from './values.ts';
import type { Baseline, TrackedField } from './values.ts';
import { instantFrom, isoOf } from '../shared/dates.ts';
import { seasonAired, seasonComplete, type FactsCredential, type SeasonShape, type TitleCatalogue } from './3-catalogue.ts';
import type { RuntimeRequest } from './io/runtimes.ts';
import type { CatalogueRequest } from './io/catalogue.ts';
import type { SeriesRequest } from './io/tvdb-series.ts';
import type { CertificateRequest } from './io/tmdb-tv.ts';
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
 * A whole block: a show row and the first season row under it, created
 * together.
 *
 * Together, and never in two runs. A show row alone is a block with no
 * seasons, whose roll-up formulas count the *next* block's rows as their own;
 * a season row alone joins whichever block sits above it. Neither is a state
 * the sheet can be left in for a poll.
 */
export interface BlockInsert {
  kind: 'block';
  /** The show row. Rows at and below this index shift down by two. */
  row: number;
  /** Two rows: the show row at `row`, its first season row at `row + 1`. */
  rows: 2;
  /** The SIMKL id the show row's `id` cell carries — what every later run matches the block by. */
  id: number;
  /** What the `Show` cell is written with, so the guard re-derives against the value rather than the upstream. */
  title: string;
  /** What the `Franchise` cell is written with, and the key placement was decided on. */
  franchise: string;
  season: number;
  /** Cells on both rows. It has no `previous` — neither row existed. */
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
 * How many show-facts lookups one pass may make, per upstream.
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
 */
export const MAX_LOOKUPS_PER_PASS = 8;

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
  | 'no-format-row';

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
  /**
   * TVDB series whose genre list a new block is waiting on, and TMDB series
   * whose certificate it is. Two lists rather than one because they are two
   * upstreams with two credentials and two join keys; a block needs both, so a
   * single list could not say which half came back.
   *
   * Both are capped at `MAX_LOOKUPS_PER_PASS` and both empty once every block
   * candidate is answered — settled-with-nothing included.
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
   * The bucket a new show row's `Artwork` formula links into, or null for an
   * install with no artwork bucket, where the cell is left out entirely.
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
   * Which credential an upstream has rejected this process, or null.
   * `CatalogueStore.factsRejected` — a fact about the token, not about any
   * series, so no block is settled and no further lookup is asked for.
   */
  factsRejected?: FactsCredential | null;
}

const cellAt = (grid: Grid, row: number, column: number): CellData | undefined => grid.snapshot.rows[row]?.[column];

const num = (numberValue: number): ExtendedValue => ({ numberValue });
const str = (stringValue: string): ExtendedValue => ({ stringValue });

const edit = (grid: Grid, row: number, field: HeaderName, value: ExtendedValue | undefined, note: string): CellEdit => {
  const column = grid.columns[field];
  return { row, column, field, previous: cellAt(grid, row, column)?.userEnteredValue, value, address: a1(row, column), note };
};

/**
 * A cell on a row that does not exist yet. Never `edit`: the row is created by
 * the same batch, so reading a `previous` off the snapshot would read whatever
 * currently sits at that index — a real cell of a different row.
 */
const fillCell = (grid: Grid, row: number, field: HeaderName, value: ExtendedValue, note: string): CellEdit => ({
  row,
  column: grid.columns[field],
  field,
  previous: undefined,
  value,
  address: a1(row, grid.columns[field]),
  note,
});

// --- Eligibility -----------------------------------------------------------

/**
 * Every SIMKL id claimed anywhere in a block. Used only to ask "has anything
 * happened here recently", so a plain max is right.
 */
const blockIds = (block: ShowBlock): number[] => [...new Set([...block.ids, ...block.seasons.flatMap((s) => s.ids)])];

/**
 * Every SIMKL id the grid holds anywhere — show rows and season rows alike.
 *
 * The same reading of a block `planSync` uses for `seen`, exported so the films
 * half's placement rule asks this question exactly once rather than keeping a
 * second copy of what counts as "on the show tab".
 */
export const gridIds = (grid: Grid): Set<number> => new Set(grid.blocks.flatMap(blockIds));

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
    const last = resolved.at(-1) as TitleProgress;
    const lastNumber = numberedSeasons(last)[0];

    return {
      kind: 'resolved',
      // Summed across all ids: a split cour is one row.
      watched: resolved.reduce((total, p) => total + watchedIn(p), 0),
      // Only once *every* id is complete.
      complete: resolved.every((p) => courComplete(p)),
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
      //
      // Recency is a different question and the title-level field is the right
      // answer to it — ids go in release order and a second is only added once
      // the first is finished, so the last id is always the active one.
      lastWatchedAt: lastNumber === undefined ? null : (last.seasons.get(lastNumber)?.lastWatchedAt ?? null),
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
 * Every whole season a block already has a row for, independent of whether
 * that row resolved: a row the planner declined to read is still a row, and a
 * second row for the same season is the one insert mistake nothing downstream
 * could detect.
 */
const coveredSeasons = (block: ShowBlock): Set<number> =>
  new Set(block.seasons.map((s) => s.season).filter((n): n is number => n !== null && Number.isInteger(n)));

/**
 * Which season a title would gain a row for. `source` is the entry
 * `statusSource` named for an existing block, already resolved and cleared of
 * duplicate-id claims — one derivation of "which entry drives this block"
 * serves the Status write, the insert, and its runtime alike.
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
): InsertCandidate | null => {
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

  if (!isBlank(cellAt(grid, season.row, grid.columns.Runtime))) return { state: 'ineligible' };

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
 * Every season's first and last watch, keyed the way the record keys it.
 *
 * The whole library, not only the rows a pass reaches. Recording is not a write
 * and costs nothing, while the gap it closes is the one that matters: a first
 * sighting is silent by design, so a season observed for the first time on the
 * very run that first reaches it has its move swallowed — and a move is usually
 * what brought the row into the activity window in the first place. Recording
 * wide means every later move is a real move.
 *
 * Both fields, because both are facts the library already carries. What needs
 * a catalogue lookup is *writing* `End` — the row must be complete, and only
 * the episode list says so for a season resolved by number. Recording is a
 * different question and asks nothing: this is the day SIMKL currently reports,
 * whether or not the season is finished. Recorded here, a later disagreement is
 * a real move by one season; recorded only where a lookup had already been made
 * for some other reason, most seasons have nothing to disagree with and the
 * field can never be followed at all.
 *
 * An inserted row is recorded on the same run that writes it, which looks like
 * the banking this file is otherwise careful about and is not: an insert is
 * triggered by a row being absent, never by this comparison, so a failed one
 * re-plans on the next poll whatever the record says.
 */
export const observeWatches = (index: Map<number, TitleProgress>): Baseline => {
  const observed: Baseline = new Map();
  for (const progress of index.values()) {
    for (const season of progress.seasons.values()) {
      if (season.firstWatchedAt === null) continue;
      const entry: Record<string, string> = { Start: isoOf(season.firstWatchedAt) };
      if (season.lastWatchedAt !== null) entry.End = isoOf(season.lastWatchedAt);
      observed.set(seasonKey(progress.id, season.number), entry);
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
  { plan, grid, timezone, ceiling, baseline, observed, writing }: FollowContext,
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
    const record = (into: Baseline): void => void into.set(key, { ...into.get(key), [field]: isoOf(at) });

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
      record(observed);
      continue;
    }

    if (!moved) {
      // Everything not being written is observed, stated once so the
      // disjointness the mechanism rests on reads off one exit.
      record(observed);
      continue;
    }

    const before = watchedNote(instantFrom(baseline.get(key)?.[field]), timezone);
    plan.edits.push(edit(grid, season.row, field, num(serial), `${label}: ${SHOW_LABELS[field]} moved from ${before} to ${watchedNote(at, timezone)}`));
    // Into `writing`, and *withdrawn* from `observed`, which `observeWatches`
    // has already seeded with this very value: recorded before its write lands,
    // the next poll compares against it, finds nothing moved, and the change is
    // lost. The withdrawal is what keeps the two maps disjoint.
    //
    // It *replaces* the entry rather than deleting the field from it. `observed`
    // is a shallow copy of a seed the run reuses across every planning pass and
    // every re-read, so the entries are shared: deleting in place would strip
    // the field from the seed itself.
    record(writing);
    const seeded = { ...observed.get(key) };
    delete seeded[field];
    observed.set(key, seeded);
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
  { label, timezone, ceiling, writing, observed }: { label: string; timezone: string; ceiling: number; writing: Baseline; observed: Baseline },
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
  // Recorded like any other tracked write, and only once it lands. Without
  // this the closing run banks nothing, the next poll sees `End` for the first
  // time and records it silently, and a correction landing in between is lost
  // for good — the gap this whole mechanism exists to close.
  //
  // Withdrawn from `observed` for the same reason `followUpstream` withdraws:
  // `observeWatches` seeds this very value library-wide, and a value recorded
  // before its write lands is a change banked and never made. Replaced rather
  // than deleted in place, because the seed's entries are shared across every
  // planning pass of the run.
  if (resolved.key !== null && resolved.lastWatchedAt !== null) {
    writing.set(resolved.key, { ...writing.get(resolved.key), End: isoOf(resolved.lastWatchedAt) });
    const seeded = { ...observed.get(resolved.key) };
    delete seeded.End;
    observed.set(resolved.key, seeded);
  }
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
  grid: Grid,
  season: SeasonRow,
  lastWatchedAt: Temporal.Instant | null,
  { advanced, closing, label, timezone }: { advanced: boolean; closing: boolean; label: string; timezone: string },
): CellEdit | null => {
  const cell = cellAt(grid, season.row, grid.columns.Note);
  if (!ownsNote(cell, season.note)) return null;

  if (closing) {
    // Nothing of ours in a blank cell to take away.
    return isBlank(cell) ? null : edit(grid, season.row, 'Note', undefined, `${label}: dated, so its last-watched note is cleared`);
  }
  if (!advanced) return null;
  const text = watchedNote(lastWatchedAt, timezone);
  if (text === null || text === season.note) return null;
  return edit(grid, season.row, 'Note', str(text), `${label}: last watched ${text}`);
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
    starts,
    filed,
    showBucket = config.artworkShowBucket ?? null,
    facts = { tvdb: tvdbConfigured(config), tmdb: Boolean(config.tmdbApiKey) },
    factsRejected = null,
  }: PlanOptions = {},
): PlanResult => {
  const plan = emptyPlan();
  const demands: PlanDemands = { catalogue: [], runtimes: [], genres: [], certificates: [] };
  const cutoff = cutoffFrom(now, sinceDays);
  const duplicates = duplicateIds(grid.blocks);
  const seen = new Set<number>();
  // Copied, never used directly: a pass whose plan is discarded must not leave
  // its withdrawals in the caller's seed. The entries themselves are never
  // mutated in place — only replaced — so a shallow copy is enough.
  const observed = new Map(starts ?? observeWatches(index));
  const writing: Baseline = new Map();
  const follow: FollowContext = { plan, grid, timezone, ceiling: maxSerial(now, timezone), baseline, observed, writing };

  for (const block of grid.blocks) {
    const ids = blockIds(block);
    for (const id of ids) seen.add(id);

    // Recency gates the *expensive* half — the catalogue lookups, and every
    // write that reads the sheet cell rather than the record. The fields that
    // follow SIMKL are not gated on it at all: what makes them safe on a
    // dormant sheet is the baseline, which writes nothing it has not seen move,
    // and that is a better gate than a watch timestamp. It is also the only one
    // that answers the question actually being asked — a date corrected today
    // is a recent *change*, whatever day it was corrected to, and the watch
    // timestamp it moves may be years old and may not move at all.
    const recent = isRecent(ids, index, cutoff);
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
    if (recent && !anime) {
      for (const id of block.ids) demands.catalogue.push({ id, episodes: true, detail: true });
    }
    const sourceId = statusSource(block);
    if (recent && sourceId !== null) demands.catalogue.push({ id: sourceId, anime, detail: true });

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
      followUpstream(follow, season, resolved, label);
      // A move with nothing to write it from. `complete` already true means the
      // answer is in hand and `End` was eligible above; false out here means
      // the lookup nobody made for this dormant block, so ask for it.
      if (!recent && !wantsCompleteness && !resolved.complete && endMoved(season, resolved, follow)) {
        wantsCompleteness = true;
      }

      if (!recent || !within(resolved.lastWatchedAt, cutoff)) continue;
      if (season.closed) continue;

      // A hand-typed count — "12 (rewatch)", "~8" — parses to null, so the
      // comparison below would read it as 0 and plan an edit the guard
      // refuses unconditionally. Refusal is whole-plan, so one such cell
      // would stop every unrelated edit while the row stays inside the
      // activity window. Skipped here so the guard stays the backstop, and
      // the reason names the row instead of the planner.
      const existing = cellAt(grid, season.row, grid.columns.Episode);
      if (!isBlank(existing) && numberOf(existing) === null) {
        plan.skips.push({ code: 'non-numeric-count', message: `${label}: the ${SHOW_LABELS.Episode} cell holds something that is not a number, so the row is left alone` });
        continue;
      }
      const advanced = resolved.watched > (season.episode ?? 0);
      if (advanced) {
        plan.edits.push(edit(grid, season.row, 'Episode', num(resolved.watched), `${label}: ${season.episode ?? 0} -> ${resolved.watched} episodes`));
      }

      const closing = closeSeason(plan, demands, grid, block, season, resolved, index, titles, { label, timezone, ceiling: follow.ceiling, writing, observed });

      // Last, because what the note should say depends on whether this batch
      // dates the row — a row left open for another poll keeps carrying its
      // date, a row being closed hands the fact over to `End`.
      const note = watchNote(grid, season, resolved.lastWatchedAt, { advanced, closing, label, timezone });
      if (note) plan.edits.push(note);
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
      for (const id of block.ids) demands.catalogue.push({ id, episodes: true, detail: true });
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
    } else if (source) {
      const entry = titles.get(source.id);
      // Which model applies is decided by where the ids sit, never by whether
      // data arrived. Anime asks its own not-aired counter: one entry is one
      // cour. A live-action block with no shapes is a *failed lookup*, not a
      // cour — read as one it would answer with a count spanning the whole
      // show rather than the latest season. So it declines to write; the
      // lookup failure already asks for another poll.
      if (!anime && !entry?.shapes.size) {
        plan.skips.push({ code: 'no-episode-list', message: `${block.title}: no episode list came back, so ${SHOW_LABELS.Status} is left alone` });
      } else {
        const status = deriveStatus(source, {
          detailStatus: entry?.status,
          latestSeasonAiring: anime ? source.notAiredCount > 0 : latestSeasonAiring(entry?.shapes ?? new Map()),
        });
        if (status !== null && status !== block.status) {
          plan.edits.push(edit(grid, block.row, 'Status', str(status), `${block.title}: ${block.status ?? '(blank)'} -> ${status}`));
        }
      }

      // Anime is never inserted into, the same test the runtime write makes:
      // both put something into a row they cannot take back.
      const candidate = runtimeScopeOk(block) ? insertTarget(source, titles, cutoff, coveredSeasons(block)) : null;
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

  // Titles SIMKL knows with no row at all. Last, so the season rows planned
  // above have already taken the run's one insert slot where they wanted it: a
  // row joining a block that exists is worth more than a block that can wait a
  // poll, and both cannot land together because plan indices are pre-write.
  planBlocks({ grid, plan, demands, titles, cutoff, timezone, showBucket, facts, factsRejected }, index, seen, filed);

  return { plan, demands, observed, writing };
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
): SeasonFill | null => {
  const start = watchSerial(candidate.firstWatchedAt, timezone);
  if (start === null) return null;

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
  const end = complete && !waiting ? watchSerial(candidate.lastWatchedAt, timezone) : null;
  // The same rule the per-row path applies, so a row is never created in a
  // state that path would immediately have to correct: an open row carries its
  // last-watched date, a dated one leaves `End` to say it.
  const note = end === null ? watchedNote(candidate.lastWatchedAt, timezone) : null;

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
  { timezone }: { timezone: string },
): RowInsert | Skip | null => {
  const { season, complete } = candidate;
  const label = `${block.title} S${season.number}`;

  const filled = seasonCells(candidate, runtime, titles.get(candidate.source.id), timezone);
  if (filled === null) return { code: 'unusable-timestamp', message: `${label}: would be added, but its first watch timestamp is unusable` };

  // Keep Season ascending: before the first existing row with a higher
  // number, or after the last one.
  const whole = block.seasons.filter((s) => s.season !== null && Number.isInteger(s.season));
  const after = whole.find((s) => (s.season as number) > season.number);
  const row = after ? after.row : (block.seasons.at(-1)?.row ?? block.row) + 1;

  // inheritFromBefore takes formats from the row above. Without a season row
  // there, it inherits the *show* row's, and a correct date serial renders as
  // `46265`.
  if (!block.seasons.some((s) => s.row < row)) {
    return { code: 'no-format-row', message: `${label}: would be added, but there is no season row above the insertion point to inherit formats from` };
  }

  return {
    kind: 'season',
    row,
    rows: 1,
    title: block.title,
    season: season.number,
    fill: filled.cells.map(({ field, value }) => fillCell(grid, row, field, value, `${label}: new row`)),
    note: `${label}: new season row at ${row + 1}, ${season.watched} episodes${filled.end === null ? '' : ', ended'}${blankRuntimeNoteOf(filled, complete)}`,
  };
};

/**
 * Why a new season row's runtime cell went in blank, where that is not simply
 * "the season is still running". A row whose runtime nothing can supply is the
 * one a reader must finish by hand, so it says so rather than leaving an empty
 * cell to be noticed.
 */
const blankRuntimeNoteOf = ({ end, runtime, waiting }: SeasonFill, complete: boolean): string =>
  complete && end === null ? ', added open — its episode runtimes have not come back'
  // Blank with nothing outstanding is blank for good, dated or not: no join
  // key, or the key's answer is in and unusable. A row still waiting is not
  // this, and says nothing.
  : runtime === null && !waiting ? `, with no episode runtime to fill its ${SHOW_LABELS.Runtime} cell`
  : '';

// --- The block the tab does not have yet -------------------------------------

/**
 * The optional columns a new show row always fills. `Banner` is conditional on
 * a bucket and so is not here — a link with nothing behind it is a broken
 * image for the life of the row.
 */
const BLOCK_WRITE_FIELDS: readonly BlockHeaderName[] = ['Franchise', 'Genre', 'Genres', 'Network', 'Certificate'];

/** The note a title with no row gets when no block can be built for it. */
const missingRowNote = (progress: TitleProgress): string =>
  `${progress.title} (simkl ${progress.id}) has recent activity and no row — add it by hand if you want it tracked`;

/** Everything the block walk reads that does not vary between candidates. */
interface BlockContext {
  grid: Grid;
  plan: SheetPlan;
  demands: PlanDemands;
  titles: Map<number, TitleCatalogue>;
  cutoff: Temporal.Instant;
  timezone: string;
  showBucket: string | null;
  facts: { tvdb: boolean; tmdb: boolean };
  factsRejected: FactsCredential | null;
}

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

/**
 * Oldest first, a title with no watch date last, and the SIMKL id to break a
 * tie. The tie-break is not decoration: two shows started the same evening
 * would otherwise be ordered by whatever `Map` iteration gave, and which of
 * them takes the run's one insert slot would move between polls.
 */
const byFirstWatch = (a: TitleProgress, b: TitleProgress): number => {
  const [x, y] = [firstWatch(a), firstWatch(b)];
  if (x === null || y === null) return (x === null ? 1 : 0) - (y === null ? 1 : 0) || a.id - b.id;
  return Temporal.Instant.compare(x, y) || a.id - b.id;
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
 * **Recording needs nothing here.** The two tracked fields are recorded
 * library-wide by `observeWatches`, which walks the library and not the grid,
 * so a block's seasons are already in `observed` before this runs. And a block
 * is triggered by a row being *absent*, never by a comparison against the
 * baseline — so a failed insert re-plans identically on the next poll whatever
 * was recorded, which is exactly why `writing` gains nothing either.
 */
const planBlocks = (ctx: BlockContext, index: Map<number, TitleProgress>, seen: Set<number>, filed: Set<number> | undefined): void => {
  const { plan, grid, titles, cutoff } = ctx;

  const candidates: TitleProgress[] = [];
  for (const progress of index.values()) {
    if (seen.has(progress.id) || !within(progress.lastWatchedAt, cutoff)) continue;
    // An anime film with no block is not missing a row: the films tab holds it,
    // and this half still indexes it because 20 of them sit on show-tab rows.
    if (filed?.has(progress.id)) continue;
    if (progress.type !== 'shows') {
      plan.notes.push(missingRowNote(progress));
      continue;
    }
    candidates.push(progress);
  }
  candidates.sort(byFirstWatch);

  const seasonRows = new Set(grid.blocks.flatMap((block) => block.seasons.map((season) => season.row)));
  let notedColumns = false;
  let awaitingCredential = 0;
  let awaitingFixedCredential = 0;

  for (const progress of candidates) {
    const entry = titles.get(progress.id);
    // SIMKL's own title where the detail has answered, the library's until
    // then — 166 of 189 exact against the tab, 183 ignoring case and a leading
    // article. Both are normalised the same way, so the cell and the key below
    // cannot disagree about which show this is.
    const title = titleCell(entry?.title ?? progress.title);
    const label = `${title} (simkl ${progress.id})`;

    // 1. A block that already holds this title. **Both keys**, because the two
    //    are decided a pass apart: the library title is all the first pass has,
    //    and the detail's may differ by a `(US)` suffix or a leading article.
    //    The guard re-derives the collision against the title actually written,
    //    so one only the planner's later key sees would pass here and refuse
    //    the whole plan there.
    //
    //    Never matched the other way round: the sync refuses to duplicate a
    //    title, and never *attaches* itself to a row by name.
    const keys = new Set([titleKey(progress.title), titleKey(title)]);
    const holder = grid.blocks.find((block) => keys.has(titleKey(block.title)));
    if (holder) {
      const ids = blockIds(holder);
      if (ids.length === 0) {
        plan.skips.push({
          code: 'unlinked-block',
          message: `${label}: row ${holder.row + 1} holds that title and no id; type the id to link it`,
        });
      } else {
        plan.notes.push(`${label}: row ${holder.row + 1} already holds that title under id ${ids.join(', ')}, so no block is added`);
      }
      continue;
    }

    // 2. The columns a show row is written into. Optional on the tab by
    //    design — the artwork page parses a Shows tab with no Franchise column
    //    at all — so an unresolved one declines the block rather than failing
    //    the parse. One note per run: the answer is a fact about the header
    //    row, identical for every candidate.
    const unresolved = [...BLOCK_WRITE_FIELDS, ...(ctx.showBucket === null ? [] : (['Banner'] as const))].filter(
      (field) => grid.blockColumns[field] === undefined,
    );
    if (unresolved.length) {
      if (!notedColumns) {
        notedColumns = true;
        plan.notes.push(`a new show block needs ${unresolved.map((field) => SHOW_FIELD_LABELS[field]).join(', ')} on the tab, so none is added`);
      }
      continue;
    }

    // 3. The two credentials, before any lookup is asked for: a block needs
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
    if (ctx.factsRejected !== null) {
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
      plan.deferredInserts += 1;
      plan.notes.push(`${label}: a block waits for the next run — one insert is added per run`);
      continue;
    }

    // 4. What SIMKL holds. Both ids arrive on the same detail response, so
    //    either being absent is that call not having answered — the state the
    //    store leaves until `/tv/{id}` lands, and the one that must not be read
    //    as "no id", which would tell the operator to add by hand a block a
    //    poll would build.
    ctx.demands.catalogue.push({ id: progress.id, episodes: true, detail: true });
    if (entry === undefined || entry.tvdbId === undefined || entry.tmdbId === undefined) {
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

    // 5. The join keys themselves. Null is SIMKL answering that it holds
    //    none, which no poll changes, so the block is named once as one to add
    //    by hand rather than waited on forever.
    const { tvdbId, tmdbId } = entry;
    const noKey = [...(tvdbId === null ? ['TVDB'] : []), ...(tmdbId === null ? ['TMDB'] : [])];
    if (tvdbId === null || tmdbId === null) {
      plan.notes.push(`${label} has no ${noKey.join(' or ')} id, so its block has to be added by hand`);
      continue;
    }

    // 6. Which season the block's one row is for. No rows yet, so nothing is
    //    covered and the earliest watched season inside the window wins.
    const candidate = insertTarget(progress, titles, cutoff, new Set());
    if (!candidate) continue;
    const seasonLabel = `${label} S${candidate.season.number}`;

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
    const runtime = insertRuntimeOf(candidate, titles);
    const runtimePending = candidate.aired && runtime.target !== null && runtime.minutes === undefined;
    if (runtimePending && runtime.target !== null) ctx.demands.runtimes.push(runtime.target);

    const { genres, certificate } = entry;
    if (genres === undefined || certificate === undefined) {
      if (genres === undefined && ctx.demands.genres.length < MAX_LOOKUPS_PER_PASS) ctx.demands.genres.push({ id: progress.id, tvdbId });
      if (certificate === undefined && ctx.demands.certificates.length < MAX_LOOKUPS_PER_PASS) {
        ctx.demands.certificates.push({ id: progress.id, tmdbId });
      }
      const waitingOn = [...(genres === undefined ? ['TVDB'] : []), ...(certificate === undefined ? ['TMDB'] : [])];
      plan.skips.push({ code: 'awaiting-lookup', message: `${label}: waiting on ${waitingOn.join(' and ')} before a block can be added` });
      continue;
    }
    if (runtimePending) {
      plan.skips.push({ code: 'awaiting-runtimes', message: `${seasonLabel}: waiting on its episode runtimes before a block can be added` });
      continue;
    }

    // 8. Where it goes — Franchise order, which is the tab's own order.
    const franchise = franchiseKeyFor(title);
    const row = placeBlock(grid.blocks, franchise);
    if (row === null) {
      plan.skips.push({ code: 'no-format-row', message: `${seasonLabel}: would be added, but the tab holds no block to place it against` });
      continue;
    }
    // `inheritFromBefore` takes formats from the row above, and a block
    // sorting first would take the *header* row's: a correct date serial
    // renders as `46265`. The same rule the season insert applies one row down.
    if (!seasonRows.has(row - 1)) {
      plan.skips.push({
        code: 'no-format-row',
        message: `${seasonLabel}: would be added at row ${row + 1}, but there is no season row above it to inherit formats from`,
      });
      continue;
    }

    // 9. The cells. The season row is `seasonCells`' — the same six a season
    //     insert writes, because it is the same row.
    const filled = seasonCells(candidate, runtime, entry, ctx.timezone);
    if (filled === null) {
      plan.skips.push({ code: 'unusable-timestamp', message: `${seasonLabel}: would be added, but its first watch timestamp is unusable` });
      continue;
    }

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
      // three the secondaries. An empty `Genres` is omitted rather than
      // written blank, the way the films insert omits it.
      ...(genres === null || genres[0] === undefined ? [] : [{ field: 'Genre' as const, value: str(genres[0]) }]),
      ...(secondary === '' ? [] : [{ field: 'Genres' as const, value: str(secondary) }]),
      ...(entry.network ? [{ field: 'Network' as const, value: str(entry.network) }] : []),
      ...(certificate === null ? [] : [{ field: 'Certificate' as const, value: num(certificate) }]),
    ];

    const fill: BlockCell[] = [
      // Every column here resolved at step 2 or is one of the required ten, so
      // nothing is dropped. The filter is what keeps that a fact rather than an
      // assumption — and the guard requires each of the nine cells a show row
      // cannot do without, so a dropped one is refused rather than written.
      ...showRow.flatMap(({ field, value }) => {
        const column = showFieldColumn(grid, field);
        return column === undefined ? [] : [{ row, column, field, previous: undefined, value, address: a1(row, column), note }];
      }),
      ...filled.cells.map(({ field, value }) => fillCell(grid, row + 1, field, value, note)),
    ];

    const insert: BlockInsert = {
      kind: 'block',
      row,
      rows: 2,
      id: progress.id,
      title,
      franchise,
      season: candidate.season.number,
      fill,
      note: `${label}: new block at rows ${row + 1}-${row + 2}, S${candidate.season.number} with ${candidate.season.watched} episodes${
        filled.end === null ? '' : ', ended'
      }${blankRuntimeNoteOf(filled, candidate.complete)}`,
    };

    // Free by construction: a taken slot defers the block above, before any
    // lookup is asked for.
    plan.insert = insert;
  }

  if (awaitingCredential) {
    const keys = [...(ctx.facts.tvdb ? [] : ['TVDB_API_KEY']), ...(ctx.facts.tmdb ? [] : ['TMDB_API_KEY'])];
    plan.notes.push(`${awaitingCredential} show(s) have no row; set ${keys.join(' and ')} to have a block added for them`);
  }
  if (awaitingFixedCredential) {
    const key = ctx.factsRejected === 'tvdb' ? 'TVDB_API_KEY' : 'TMDB_API_KEY';
    plan.notes.push(`${awaitingFixedCredential} show(s) need a block and the credential was rejected; fix ${key} and restart`);
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
  inserts: plan.insert === null ? [] : [{ address: insertAddress(plan.insert), title: plan.insert.title, season: plan.insert.season, note: plan.insert.note }],
});

/**
 * Where an insert landed, for a record read months later beside the sheet. A
 * span says both its rows: a block is a show row and a season row, and "row
 * 610" would name half of what the run did.
 */
const insertAddress = (insert: Insert): string => (insert.rows === 1 ? `row ${insert.row + 1}` : `rows ${insert.row + 1}-${insert.row + insert.rows}`);

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
