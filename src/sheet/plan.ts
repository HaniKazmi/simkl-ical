/**
 * Grid + library + catalogue → a plan. Pure, and **never throws**: an
 * unresolvable row becomes a skip with a reason, not an exception. The sync
 * calls this from inside a path that must degrade rather than fail.
 *
 * The write surface is three fields — a season's `Episode`, a season's `End`,
 * and a show's `Status` — plus inserting a season row. Everything else on the
 * sheet is either hand-maintained or a formula that rolls up by itself.
 */

import { config } from '../config.ts';
import { MS_PER_DAY } from '../dates.ts';
import { a1, columnLetter, duplicateIds, idsFor, type ColumnMap, type Grid, type HeaderName, type SeasonRow, type ShowBlock } from './grid.ts';
import { courComplete, runtimeDays, seasonComplete, watchSerial, type SeasonShape, type TitleProgress } from './progress.ts';
import type { CatalogueRequest } from '../sources/shows.ts';
import type { CellData, ExtendedValue } from '../sheets/types.ts';

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
  now?: Date;
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

const latestOf = (progresses: TitleProgress[]): string | null =>
  progresses.reduce<string | null>((latest, p) => (p.lastWatchedAt && (!latest || p.lastWatchedAt > latest) ? p.lastWatchedAt : latest), null);

const within = (iso: string | null, cutoffMs: number): boolean => iso !== null && Date.parse(iso) >= cutoffMs;

/**
 * Has anything in this block been watched recently enough to touch?
 *
 * One definition on purpose: the cut-off is what stops any run retro-editing
 * years of history, and `planLookups` and `planSync` must never disagree about
 * which blocks are in scope.
 */
const isRecent = (ids: number[], index: Map<number, TitleProgress>, cutoffMs: number): boolean =>
  within(latestOf(ids.map((id) => index.get(id)).filter((p): p is TitleProgress => p !== undefined)), cutoffMs);

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
  lastWatchedAt: string | null;
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
  watchedAt: string | null;
  /** When the lookup was made, in ms. */
  at: number;
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
 * reasoning as `movieRefreshMs`, and the same daily cadence — a studio moving a
 * release, or a network renewing a show, changes nothing you could gate on.
 */
export const needsLookup = (stamp: CatalogueStamp | undefined, progress: TitleProgress | undefined, nowMs: number, maxAgeMs: number): boolean => {
  if (!stamp) return true;
  if (nowMs - stamp.at > maxAgeMs) return true;
  return stamp.watchedAt !== (progress?.lastWatchedAt ?? null);
};

export interface LookupOptions extends PlanOptions {
  /** What is already held, keyed by SIMKL id. Empty on a cold process. */
  stamps?: Map<number, CatalogueStamp>;
  maxAgeMs?: number;
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
  { now = new Date(), sinceDays = config.sheetSinceDays, stamps = new Map<number, CatalogueStamp>(), maxAgeMs = Infinity }: LookupOptions = {},
): CatalogueRequest[] => {
  const cutoffMs = now.getTime() - sinceDays * MS_PER_DAY;
  const nowMs = now.getTime();
  const requests: CatalogueRequest[] = [];
  const due = (id: number): boolean => needsLookup(stamps.get(id), index.get(id), nowMs, maxAgeMs);

  for (const block of grid.blocks) {
    if (!isRecent(blockIds(block), index, cutoffMs)) continue;

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

// --- The plan --------------------------------------------------------------

export const planSync = (
  grid: Grid,
  index: Map<number, TitleProgress>,
  catalogue: CatalogueView,
  { now = new Date(), timezone = config.timezone, sinceDays = config.sheetSinceDays }: PlanOptions = {},
): SheetPlan => {
  const plan: SheetPlan = { edits: [], inserts: [], skipped: [], notes: [], deferred: 0 };
  const cutoffMs = now.getTime() - sinceDays * MS_PER_DAY;
  const duplicates = duplicateIds(grid.blocks);
  const seen = new Set<number>();

  for (const block of grid.blocks) {
    const ids = blockIds(block);
    for (const id of ids) seen.add(id);

    // The cut-off applies uniformly, with no exemptions. A dormant sheet
    // produces zero edits, and no run can retro-edit years of history.
    if (!isRecent(ids, index, cutoffMs)) continue;
    const anime = block.ids.length === 0;

    // Every whole season the block already has a row for, computed up front and
    // independently of whether that row resolved. A row the planner declined to
    // read is still a row, and inserting a second one for the same season is
    // the one insert mistake nothing downstream could detect.
    const covered = new Set(block.seasons.map((s) => s.season).filter((n): n is number => n !== null && Number.isInteger(n)));

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
      if (!within(resolved.lastWatchedAt, cutoffMs)) continue;

      const label = `${block.title} S${season.season ?? '?'}`;
      if (resolved.watched > (season.episode ?? 0)) {
        plan.edits.push(edit(grid, season.row, 'Episode', num(resolved.watched), `${label}: ${season.episode ?? 0} -> ${resolved.watched} episodes`));
      }

      if (resolved.complete) {
        const serial = watchSerial(resolved.lastWatchedAt, timezone);
        if (serial === null) {
          plan.skipped.push(`${label}: complete, but its last watch timestamp is unusable`);
        } else {
          plan.edits.push(edit(grid, season.row, 'End', num(serial), `${label}: ended`));
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

      const insert = planInsert(grid, block, source, covered, catalogue, { now, timezone, sinceDays });
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
    if (seen.has(progress.id) || !within(progress.lastWatchedAt, cutoffMs)) continue;
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
  source: TitleProgress | null,
  covered: Set<number>,
  catalogue: CatalogueView,
  { now, timezone, sinceDays }: Required<PlanOptions>,
): RowInsert | string | null => {
  if (block.type !== 'show' || !source || !block.ids.length) return null;
  const cutoffMs = now.getTime() - sinceDays * MS_PER_DAY;

  const candidates = [...source.seasons.values()]
    .filter((s) => s.watched > 0 && !covered.has(s.number) && within(s.lastWatchedAt, cutoffMs))
    .sort((a, b) => a.number - b.number);
  const candidate = candidates[0];
  if (!candidate) return null;

  const label = `${block.title} S${candidate.number}`;
  const entry = catalogue.titles.get(source.id);
  const runtime = runtimeDays(entry?.runtime);
  if (runtime === null) return `${label}: would be added, but SIMKL gives no episode runtime for the Episodes column`;

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

  const complete = seasonComplete(entry?.shapes.get(candidate.number), candidate.watched);
  const end = complete ? watchSerial(candidate.lastWatchedAt, timezone) : null;

  const cells: Array<{ field: HeaderName; value: ExtendedValue }> = [
    { field: 'Season', value: num(candidate.number) },
    { field: 'Episode', value: num(candidate.watched) },
    { field: 'Start', value: num(start) },
    { field: 'Episodes', value: num(runtime) },
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
    note: `${label}: new season row at ${row + 1}, ${candidate.watched} episodes${complete ? ', ended' : ''}`,
  };
};

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
