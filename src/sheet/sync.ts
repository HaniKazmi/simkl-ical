/**
 * The write protocol. The only thing in the project that writes to the sheet.
 *
 * It runs the numbered modules beside it, with the whole cycle inside one poll
 * so that what was planned and what was written describe the same grid:
 *
 *   INDEX     1-index.ts        — the library, and the early-out
 *   READ      io/spreadsheet.ts
 *   PARSE     2-grid.ts
 *   PLAN ⇄ FETCH                — 4-plan.ts asks, io/catalogue.ts and
 *             io/runtimes.ts answer, 3-catalogue.ts holds the answers; the
 *             loop runs until the planner demands nothing new
 *   GUARD     5-guard.ts        — nothing is built until this passes
 *   FRESH     a snapshot older than 120s restarts the cycle from the READ
 *   BUILD     6-requests.ts
 *   APPLY     io/spreadsheet.ts
 *   VERIFY    7-verify.ts
 *   ROLLBACK  6-requests.ts again, in separate batches
 *   FROZEN    no further writes this process
 *
 * `run()` never rejects: it is called from the refresh path, where nothing
 * may be fatal. Failures land in the returned result and, through it, in
 * `errors.sheet` and `/healthz`.
 */

import { config, moviesSyncConfigured } from '../shared/config.ts';
import { errorMessage } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import { SheetsAccessError } from '../api/google/client.ts';
import type { Library } from '../library.ts';
import { readSnapshot } from './io/spreadsheet.ts';
import { fetchCatalogue, type CatalogueRequest } from './io/catalogue.ts';
import { fetchSeasonRuntimes, runtimeKeyOf, type RuntimeRequest } from './io/runtimes.ts';
import { classify } from '../api/tvdb/client.ts';
import { parseGrid, type Grid } from './2-grid.ts';
import { indexLibrary, type TitleProgress } from './1-index.ts';
import { CATALOGUE_MAX_AGE, CatalogueStore, needsLookup } from './3-catalogue.ts';
import { describePlan, emptyPlan, gridIds, observeWatches, planRecord, planSync, type PlanRecord, type PlanResult, type SheetPlan } from './4-plan.ts';
import { toRequests, writesFor } from './6-requests.ts';
import { verify } from './7-verify.ts';
import { parseMovieGrid, type MovieGrid } from './movies/2-grid.ts';
import { animeFilmIds, indexFilms, type FilmProgress } from './movies/1-index.ts';
import { FilmStore } from './movies/3-catalogue.ts';
import { describeFilmPlan, emptyFilmPlan, filmPlanRecord, observeFilms, planFilms, type FilmPlanResult } from './movies/4-plan.ts';
import { assertFilmPlanSafe, UnsafeFilmPlanError } from './movies/5-guard.ts';
import { verifyFilms } from './movies/7-verify.ts';
import { fetchFilms } from './movies/io/tmdb.ts';
import { classify as tmdbClassify } from '../api/tmdb/client.ts';
import { assertPlanSafe, UnsafePlanError } from './5-guard.ts';
import { applyPlan } from './io/apply.ts';
import { appendSheetRun, loadSheetRuns } from './io/journal.ts';
import { baseline, loadBaseline, saveBaseline } from './io/baseline.ts';
import type { Baseline } from './values.ts';
import { nowIso } from '../shared/dates.ts';

/**
 * How old a snapshot may be when the write goes out. Past this the whole
 * cycle re-runs from the read — re-planning is the point: a plan built on a
 * discarded snapshot has stale row indices, and the guard would assert
 * against a grid that no longer exists.
 */
const FRESH_MS = 120_000;

/** Bounded so a pathologically slow catalogue fetch cannot loop forever. */
const MAX_ATTEMPTS = 3;

/**
 * Planning passes per attempt. Three suffice — catalogues, the runtimes they
 * reveal, the final plan — so hitting this means a demand is escaping the
 * `made` bookkeeping: worth a degraded run and a log line rather than a poll
 * that never returns.
 */
const MAX_PASSES = 4;

export type SheetSyncStatus = 'idle' | 'reported' | 'applied' | 'refused' | 'failed' | 'rolled-back' | 'frozen';

/** Which tab a run was against. Two per poll once the films half is configured. */
export type SheetTab = 'shows' | 'films';

/**
 * Worst-first. `/healthz` reports one status for a sync that runs against two
 * tabs, and the worse of the two is the only answer that cannot understate what
 * happened: a frozen films tab beside an applied show grid is a frozen sync,
 * and reporting `applied` would hide the one state that needs a human.
 *
 * A `Record` rather than an ordered array, so `tsc` requires every status to
 * have a rank. An array typed `SheetSyncStatus[]` need not *contain* them all,
 * and `indexOf` answers -1 for one it omits — which sorts ahead of `frozen`,
 * silently making a newly added status the worst thing that can happen.
 */
const SEVERITY: Record<SheetSyncStatus, number> = {
  frozen: 0,
  'rolled-back': 1,
  failed: 2,
  refused: 3,
  applied: 4,
  reported: 5,
  idle: 6,
};

const worse = (a: SheetSyncResult, b: SheetSyncResult | null): SheetSyncResult => {
  if (!b) return a;
  const worst = SEVERITY[a.status] <= SEVERITY[b.status] ? a : b;
  return {
    status: worst.status,
    // Both halves' plans, so the caller's counts describe the whole poll.
    record: { edits: [...a.record.edits, ...b.record.edits], inserts: [...a.record.inserts, ...b.record.inserts] },
    // Both errors: one half failing must not hide the other's failure.
    error: [a.error, b.error].filter(Boolean).join('; ') || null,
    retry: a.retry || b.retry,
  };
};

export interface SheetSyncResult {
  status: SheetSyncStatus;
  /** What the run planned — the projection the journal and the status page keep. */
  record: PlanRecord;
  /** For `errors.sheet`; null when the run was clean. */
  error: string | null;
  /** Whether the next poll should try again even if no list moved. */
  retry: boolean;
}

/** Which lookups this run has already made, and how many failed retryably. */
interface RunLookups {
  catalogue: Set<number>;
  runtimes: Set<string>;
  failures: number;
}

const outcome = (
  status: SheetSyncStatus,
  // Fresh arrays per result, not one shared empty: a single mutation would
  // otherwise reach every past result and every journal record built from
  // one.
  { record = { edits: [], inserts: [] }, error = null, retry = false }: Partial<Omit<SheetSyncResult, 'status'>> = {},
): SheetSyncResult => ({ status, record, error, retry });

export class SheetSync {
  log: Logger;
  /**
   * Set when a rollback failed, never cleared in-process: the sheet is in a
   * state nobody has verified, so the only safe next write is none. Clearing
   * it is a restart, which is safe — after a restart there is no pending
   * rollback, only a fresh plan against a fresh read.
   */
  frozen: string | null = null;
  lastRunAt: string | null = null;
  lastStatus: SheetSyncStatus = 'idle';
  /** What the upstreams have said so far, retained across polls — see `3-catalogue.ts`. */
  private store = new CatalogueStore();
  /** What TMDB has said about each film so far — see `movies/3-catalogue.ts`. */
  private films = new FilmStore();
  /**
   * What the run being recorded saw upstream, waiting on its outcome.
   *
   * Held here rather than threaded through `cycle`'s eight return paths, for
   * the reason the journal append is: the outcome is only known at the choke
   * point, and `writing` may only be recorded once the write it belongs to
   * has landed.
   */
  private pending = new Map<SheetTab, Pick<PlanResult, 'observed' | 'writing'>>();
  /**
   * What the show half planned this poll, spent against the same budget.
   *
   * `SHEET_MAX_EDITS` is a blast radius for the poll, not an allowance per tab:
   * counted per tab, one poll writes twice it while each half reports itself
   * inside budget.
   */
  private spent = { edits: 0, rows: 0 };
  /**
   * Whether the show half left a snapshot tab standing this poll.
   *
   * Only a `failed` run leaves one: it keeps the snapshot when the write may
   * have landed, so an operator has the pre-write grid. Sweeping is
   * spreadsheet-global, so the films half must not do it while that copy
   * stands.
   *
   * Latched until the show half *applies*, not merely until it stops failing.
   * Cleared on any other outcome, a run refused on the poll after the failure —
   * plausibly refused *because* the unverified write left the grid odd — would
   * let the films half sweep the very copy the failure preserved.
   */
  private keptBackup = false;
  /**
   * Every SIMKL id the show grid held when this poll read it, or null if it was
   * never read.
   *
   * Held here rather than returned, for the reason `pending` is: `cycle` has
   * eight return paths and `half` swallows what it throws. Reset per poll, and
   * assigned the moment a grid parses — so a show half that fails *after* the
   * read still leaves a valid answer, because a later PLAN or APPLY failure
   * does not unanswer what the read answered.
   *
   * The films half needs it to place an anime film: on `Sheet1` already means
   * leave it there. Null fails closed — see `onShowGrid` in `movies/4-plan.ts`.
   */
  private onShowGrid: Set<number> | null = null;

  constructor({ logger = console as Logger }: { logger?: Logger } = {}) {
    this.log = logger;
  }

  /**
   * Restore what survives a restart: the run history, read here rather than
   * by the caller so the half that writes the file knows when to read it.
   * Never throws — an unreadable history is no history.
   */
  async hydrate(): Promise<void> {
    // Two files, no shared state, on the path that blocks the first poll — so
    // they overlap. The baseline is the one piece of state here that *decides*
    // something; an unreadable one reads as nothing observed, so the next run
    // records afresh and writes nothing. See `io/baseline.ts`.
    await Promise.all([loadSheetRuns({ log: this.log }), loadBaseline({ log: this.log })]);
  }

  async run(library: Library | null, { signal }: { signal?: AbortSignal } = {}): Promise<SheetSyncResult> {
    if (config.sheetSyncMode === 'off') return outcome('idle');
    if (this.frozen) {
      this.log.error(this.frozen);
      return await this.record(outcome('frozen', { error: this.frozen }), 'shows');
    }

    this.spent = { edits: 0, rows: 0 };
    this.onShowGrid = null;
    const shows = await this.half('shows', () => this.cycle(library, signal));
    if (shows.status === 'failed') this.keptBackup = true;
    else if (shows.status === 'applied') this.keptBackup = false;
    // The freeze latch is process-wide, so a show half that froze stops the
    // films half in the same poll rather than on the next one: the sheet is in
    // a state nobody has verified, and which tab that state is on does not make
    // another write safe.
    const films =
      this.frozen || !moviesSyncConfigured() ? null : await this.half('films', () => this.filmsCycle(library, signal));
    return worse(shows, films);
  }

  /** One tab's run, with the failure handling both share. */
  private async half(tab: SheetTab, cycle: () => Promise<SheetSyncResult>): Promise<SheetSyncResult> {
    try {
      return await this.record(await cycle(), tab);
    } catch (err) {
      const message = errorMessage(err);
      this.log.error(`sheet sync (${tab}) failed: ${message}`);
      // A failure that needs a human — a wrong SHEET_ID, an unshared
      // spreadsheet — is said every run through `errors.sheet`; asking for
      // another poll would only re-arm the retry indefinitely. The client
      // spec decides which failures those are; see `SheetsAccessError`.
      const permanent = err instanceof SheetsAccessError && err.needsHuman;
      return await this.record(outcome('failed', { error: message, retry: !permanent }), tab);
    }
  }

  /**
   * The one choke point every terminal path funnels through, so the journal
   * append lives here rather than at each return site. Awaited: the append
   * cannot throw, and awaiting keeps a test's assertion about the file
   * deterministic.
   *
   * The `sheetSyncMode === 'off'` return in `run()` does not come through
   * here, so an inert install writes no file at all.
   */
  private async record(result: SheetSyncResult, tab: SheetTab): Promise<SheetSyncResult> {
    this.lastRunAt = nowIso();
    // Worst-wins across the poll. Shows runs first, so what this protects is
    // the show run's outcome from the films run that follows it: a quiet films
    // half reporting `idle` must not overwrite a show grid that was refused.
    this.lastStatus = tab === 'shows' ? result.status : worse(result, outcome(this.lastStatus)).status;
    await this.remember(result.status, tab);
    await appendSheetRun(
      {
        at: this.lastRunAt,
        status: result.status,
        tab,
        mode: config.sheetSyncMode,
        edits: result.record.edits,
        inserts: result.record.inserts,
        error: result.error,
      },
      { log: this.log },
    );
    return result;
  }

  /**
   * Fold what this run saw into the baseline, once its outcome is known.
   *
   * `observed` goes in whatever happened: it is what the run is *not* writing,
   * so recording it changes nothing that was going to happen. `writing` goes in
   * only on `applied`, and that asymmetry is the mechanism. Recorded early, the
   * next poll would compare against a value the sheet never received, find
   * nothing moved, and lose the change for good — so a refused, failed,
   * rolled-back or report-mode run leaves those fields exactly as it found
   * them, and re-plans the same edit next poll.
   */
  private async remember(status: SheetSyncStatus, tab: SheetTab): Promise<void> {
    const pending = this.pending.get(tab);
    // Cleared before the await: a run that reached no plan — frozen, or a
    // throw out of `cycle` — must not record what the run before it saw.
    this.pending.delete(tab);
    if (!pending) return;

    // Merged into `observed` in place: `this.pending` is already detached and
    // the map is unaliased, so a copy would buy no isolation and cost one pass
    // over every season the library holds.
    const { observed, writing } = pending;
    if (status === 'applied') {
      for (const [key, entry] of writing) observed.set(key, { ...observed.get(key), ...entry });
    }
    await saveBaseline(observed, { log: this.log });
  }

  private async cycle(library: Library | null, signal: AbortSignal | undefined): Promise<SheetSyncResult> {
    const index = indexLibrary(library);
    if (index.size === 0) return outcome('idle');

    // Built once: it is a projection of the library alone, and the library
    // cannot change while a run is in flight, so every planning pass after the
    // first would rebuild a byte-identical map.
    const starts = observeWatches(index);
    // The films tab's, so this half does not report each as a title with no row.
    const filed = animeFilmIds(library);

    // Lookups already made this run. A FRESH re-plan or later planning pass
    // must not re-issue them — failed ones included, which stay unstamped in
    // the store so the *next poll* retries them, but would otherwise stall
    // this run on exactly the fetches that aged its snapshot.
    const made: RunLookups = { catalogue: new Set(), runtimes: new Set(), failures: 0 };

    // Held across attempts so the exhausted path below reports the plan it
    // built rather than an empty one — the run whose detail matters most.
    let record: PlanRecord | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const snapshot = await readSnapshot(config.sheetName, { signal });
      const grid = parseGrid(snapshot);
      this.onShowGrid = gridIds(grid);
      const { plan, observed, writing } = await this.planToFixpoint(grid, index, starts, filed, made, attempt, signal);
      // Replaced per attempt, never merged: a FRESH re-read plans against a
      // different grid, and the observations of a pass whose plan was thrown
      // away describe rows this run is no longer acting on.
      this.pending.set('shows', { observed, writing });
      record = planRecord(plan);

      // A failed lookup means some season's shape or runtime is unknown —
      // exactly what leaves a row open this run. A deferred row is simpler:
      // the work exists and only the one-per-run rule holds it, so ask for
      // another poll rather than waiting on unrelated activity — but only
      // when the deferral can drain, which needs a write. Report mode never
      // takes the first row, so asking there would re-read and re-plan the
      // whole grid forever.
      const lookupRetry = made.failures > 0;
      const retry = lookupRetry || (config.sheetSyncMode === 'apply' && plan.deferredInserts > 0);
      if (plan.deferredInserts) this.log.info(`${plan.deferredInserts} more row(s) to add; the next poll will take the next one`);
      if (made.failures) this.log.warn(`${made.failures} lookup(s) failed; the sheet sync will retry on the next poll`);

      if (!plan.edits.length && !plan.insert) {
        const lines = describePlan(plan, grid.columns);
        if (lines.length) this.report('sheet sync: nothing to write', lines);
        return outcome('idle', { retry });
      }

      try {
        assertPlanSafe(plan, grid);
      } catch (err) {
        // The refusal is no reason to retry: the same inputs would refuse
        // again. A failed lookup is, independent of why the plan was refused.
        if (!(err instanceof UnsafePlanError)) throw err;
        this.report(`sheet sync REFUSED the plan: ${err.message}`, describePlan(plan, grid.columns), 'error');
        return outcome('refused', { record, error: err.message, retry: lookupRetry });
      }

      if (config.sheetSyncMode === 'report') {
        this.report(`sheet sync (report mode): ${record.edits.length} edits, ${record.inserts.length} inserts — nothing written`, describePlan(plan, grid.columns));
        return outcome('reported', { record, retry });
      }

      // FRESH. Back to the read, not on to the write: re-planning is the point.
      if (performance.now() - snapshot.readAtMono > FRESH_MS) {
        this.log.warn(`the sheet snapshot aged past ${FRESH_MS / 1000}s while planning; re-reading (attempt ${attempt})`);
        continue;
      }

      const applied = await this.apply(grid, plan, record, retry, signal);
      // Counted from what was written, not from what was planned. Charged at
      // the guard instead, a plan the FRESH loop then discarded — or one report
      // mode never wrote — would still dock the films half's allowance.
      if (applied.status === 'applied') {
        this.spent = {
          edits: plan.edits.length,
          rows: new Set([...plan.edits.map((e) => e.row), ...(plan.insert ? [plan.insert.row] : [])]).size,
        };
      }
      return applied;
    }

    const message = `could not plan against a fresh snapshot in ${MAX_ATTEMPTS} attempts`;
    this.log.warn(`sheet sync: ${message}`);
    return outcome('failed', { record, error: message, retry: true });
  }

  /**
   * Plan, fetch what the plan is missing, and re-plan, until a pass demands
   * nothing new.
   *
   * Terminates because every key fetched — or failed — enters `made` and is
   * never asked again this run, and the demand set is a function of grid,
   * library and store, which only gains answers. In practice three passes:
   * catalogues, the runtimes they revealed, a final plan. The pass ceiling is
   * a backstop on that argument, not part of it: a demand kind whose keys
   * escaped `made` would spin here inside the poll, and the timer that skips
   * ticks while a job runs would wedge the whole service over an optional
   * spreadsheet column.
   */
  private async planToFixpoint(
    grid: Grid,
    index: Map<number, TitleProgress>,
    starts: Baseline,
    filed: Set<number>,
    made: RunLookups,
    attempt: number,
    signal: AbortSignal | undefined,
  ): Promise<PlanResult> {
    // One instant for every pass: two passes disagreeing about which blocks
    // sit inside the activity cut-off would fetch a block and then plan it as
    // out of scope, or the reverse.
    const now = Temporal.Now.instant();

    for (let pass = 1; ; pass += 1) {
      const result = planSync(grid, index, this.store.titles, { now, baseline: baseline(), starts, filed });
      const { demands } = result;
      if (pass > MAX_PASSES) {
        this.log.warn(`sheet sync: still demanding lookups after ${MAX_PASSES} planning passes; continuing with what is in hand`);
        return result;
      }

      // The planner demands with no memory; staleness is the store's
      // question. The per-title stamp keeps a warm run at roughly 2 calls
      // instead of re-reading every eligible show each poll, since
      // `/sync/activities` resolves only to the list, never the title.
      const catalogue = demands.catalogue.filter(
        (request) => !made.catalogue.has(request.id) && needsLookup(this.store.stamps.get(request.id), index.get(request.id), now, CATALOGUE_MAX_AGE),
      );
      // First planning attempt only. A throttled TVDB season can spend a
      // minute obeying `Retry-After` against the 120s snapshot budget, so a
      // FRESH re-read must not pick up fresh runtime demands from a grid that
      // changed underneath it — the rows stay open and the next poll takes
      // them. `made` already blocks re-fetching what this run asked.
      const runtimes =
        attempt === 1 ? demands.runtimes.filter((request) => !made.runtimes.has(runtimeKeyOf(request.tvdbId, request.season))) : [];
      if (!catalogue.length && !runtimes.length) return result;

      // Different upstreams with no data dependency, so their latencies
      // overlap rather than stack against the snapshot budget.
      await Promise.all([
        catalogue.length ? this.readCatalogue(catalogue, index, made, signal) : null,
        runtimes.length ? this.readRuntimes(runtimes, made, signal) : null,
      ]);
    }
  }

  /** Fetch and fold one round of catalogue lookups, and mark them made. */
  private async readCatalogue(
    requests: CatalogueRequest[],
    index: Map<number, TitleProgress>,
    made: RunLookups,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const fetched = await fetchCatalogue(requests, { signal });
    this.store.foldCatalogue(requests, fetched, index);
    for (const { id } of requests) made.catalogue.add(id);
    made.failures += fetched.failed.length;

    // Titles, not requests: a live-action block emits two request records per
    // id — episode list and status lookup — which fetchCatalogue merges.
    // Counting records reads as twice as many shows as there are.
    const titles = new Set(requests.map((r) => r.id)).size;
    this.log.info(`sheet sync: re-read ${titles} title catalogues in ${fetched.episodes.size + fetched.details.size} calls`);
    if (fetched.unavailable.length) {
      this.log.warn(`${fetched.unavailable.length} SIMKL titles are gone upstream: ${fetched.unavailable.join(', ')}`);
    }
  }

  /** Fetch and fold one round of runtime lookups, and mark them made. */
  private async readRuntimes(requests: RuntimeRequest[], made: RunLookups, signal: AbortSignal | undefined): Promise<void> {
    for (const request of requests) made.runtimes.add(runtimeKeyOf(request.tvdbId, request.season));

    let fetched;
    try {
      fetched = await fetchSeasonRuntimes(requests, { signal });
    } catch (err) {
      // An account-level failure escapes the pool by design — it is not a
      // fact about any one season. It must not escape the *run*: that would
      // throw away the grid read and every SIMKL call this poll made, over an
      // optional column.
      //
      // Which kind decides what happens to the rows. A rejected key is
      // **settled** — no number of polls makes a typo answer — so those
      // seasons record null and close with the cell blank; the store explains
      // why. An outage is a wait: the rows stay open and the next poll
      // retries.
      const settled = classify(err) === 'account';
      this.log.warn(
        settled
          ? `sheet sync: TVDB rejected the credential (${errorMessage(err)}); ${requests.length} season(s) close without a runtime`
          : `sheet sync: TVDB is not answering (${errorMessage(err)}); ${requests.length} season(s) stay open`,
      );
      if (settled) this.store.settleSeasonsUnusable(requests);
      else made.failures += requests.length;
      return;
    }

    this.store.foldRuntimes(requests, fetched);
    made.failures += fetched.failed.length;

    this.log.info(`sheet sync: read ${requests.length} season runtime(s) from TVDB`);
    if (fetched.unavailable.length) {
      this.log.warn(`TVDB has no record for ${fetched.unavailable.length} season(s): ${fetched.unavailable.join(', ')}`);
    }
  }

  /**
   * Hand the checked plan to the write protocol and map its outcome onto the
   * run's result. A freeze is the one outcome with state: the message is
   * latched so every later run repeats it instead of writing.
   */
  private async apply(grid: Grid, plan: SheetPlan, record: PlanRecord, retry: boolean, signal: AbortSignal | undefined): Promise<SheetSyncResult> {
    const applied = await applyPlan(
      {
        snapshot: grid.snapshot,
        // Shows runs first, so nothing else has written this poll.
        maySweep: true,
        requests: toRequests(writesFor(plan, grid)),
        describe: () => describePlan(plan, grid.columns),
        summary: `${plan.edits.length} edits and ${plan.insert ? 1 : 0} inserts`,
        verify: (after) => verify(grid, after, plan),
        verifyRestored: (after) => verify(grid, after, emptyPlan()),
      },
      { log: this.log, signal },
    );
    if (applied.status === 'frozen') {
      this.frozen = applied.error;
      this.log.error(applied.error ?? '');
      return outcome('frozen', { record, error: applied.error });
    }
    // A batch that never landed earns another poll on its own; a clean or
    // rolled-back run keeps whatever retry the planning phase earned — the
    // rolled-back work is not guaranteed to refuse again, since the
    // concurrent edit that triggered it was itself reverted by the restore.
    return outcome(applied.status, { record, error: applied.error, retry: applied.status === 'failed' ? true : retry });
  }

  /**
   * The films tab's run: read, plan to a fixpoint, guard, write.
   *
   * The same protocol as `cycle` and deliberately not folded into it. What the
   * two share is the transport and the write-and-recover sequence, both already
   * shared through `readSnapshot` and `applyPlan`; what they do not share is a
   * single rule about what may be written, because a film row has no block, no
   * season and no roll-up formula to reason about.
   */
  private async filmsCycle(library: Library | null, signal: AbortSignal | undefined): Promise<SheetSyncResult> {
    const index = indexFilms(library);
    // The early-out, and it is narrower than it looks: `indexFilms` returns
    // every film whatever moved, so this fires only when the library holds none
    // at all. The tab is read on every other poll by design — baseline gating
    // and the missing-from-tab diff both need the grid.
    if (index.size === 0) return outcome('idle');

    // Every id the library holds, so a row for an anime film reads as the show
    // half's rather than as unaccounted for.
    const held = new Set(library?.keys() ?? []);

    // A projection of the library alone, which cannot change while a run is in
    // flight, so every planning pass after the first would rebuild it identically.
    const seed = observeFilms(index);
    // Lookups already made this run. A FRESH re-plan or a later pass must not
    // re-issue them — failed ones included, which stay unrecorded in the store
    // so the *next poll* retries them, but would otherwise stall this run on
    // exactly the fetches that aged its snapshot.
    const made = { films: new Set<number>(), failures: 0 };

    let record: PlanRecord | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const snapshot = await readSnapshot(config.moviesSheetName, { signal });
      const grid = parseMovieGrid(snapshot);
      const { plan, observed, writing } = await this.filmsToFixpoint(grid, index, seed, held, made, signal);
      // Replaced per attempt, never merged: a FRESH re-read plans against a
      // different grid, and the observations of a pass whose plan was thrown
      // away describe rows this run is no longer acting on.
      this.pending.set('films', { observed, writing });
      record = filmPlanRecord(plan);

      const lookupRetry = made.failures > 0;
      const retry = lookupRetry || (config.sheetSyncMode === 'apply' && plan.deferredInserts > 0);
      if (plan.deferredInserts) this.log.info(`${plan.deferredInserts} more film row(s) to add; the next poll will take the next one`);
      if (made.failures) this.log.warn(`${made.failures} TMDB lookup(s) failed; the films sync will retry on the next poll`);

      if (!plan.edits.length && !plan.insert) {
        const lines = describeFilmPlan(plan);
        if (lines.length) this.report('films sync: nothing to write', lines);
        return outcome('idle', { retry });
      }

      try {
        assertFilmPlanSafe(plan, grid, { spent: this.spent });
      } catch (err) {
        // The refusal is no reason to retry: the same inputs would refuse
        // again. A failed lookup is, independent of why the plan was refused.
        if (!(err instanceof UnsafeFilmPlanError)) throw err;
        this.report(`films sync REFUSED the plan: ${err.message}`, describeFilmPlan(plan), 'error');
        return outcome('refused', { record, error: err.message, retry: lookupRetry });
      }

      if (config.sheetSyncMode === 'report') {
        this.report(
          `films sync (report mode): ${record.edits.length} edits, ${record.inserts.length} inserts — nothing written`,
          describeFilmPlan(plan),
        );
        return outcome('reported', { record, retry });
      }

      // FRESH. Back to the read, not on to the write: re-planning is the point.
      if (performance.now() - snapshot.readAtMono > FRESH_MS) {
        this.log.warn(`the films snapshot aged past ${FRESH_MS / 1000}s while planning; re-reading (attempt ${attempt})`);
        continue;
      }

      const applied = await applyPlan(
        {
          snapshot: grid.snapshot,
          // Unless the show half left one standing on purpose.
          maySweep: !this.keptBackup,
          requests: toRequests(writesFor(plan, grid)),
          describe: () => describeFilmPlan(plan),
          summary: `${plan.edits.length} film edits and ${plan.insert ? 1 : 0} inserts`,
          verify: (after) => verifyFilms(grid, after, plan),
          verifyRestored: (after) => verifyFilms(grid, after, emptyFilmPlan()),
        },
        { log: this.log, signal },
      );
      if (applied.status === 'frozen') {
        this.frozen = applied.error;
        this.log.error(applied.error ?? '');
        return outcome('frozen', { record, error: applied.error });
      }
      return outcome(applied.status, { record, error: applied.error, retry: applied.status === 'failed' ? true : retry });
    }

    const message = `could not plan the films tab against a fresh snapshot in ${MAX_ATTEMPTS} attempts`;
    this.log.warn(`films sync: ${message}`);
    return outcome('failed', { record, error: message, retry: true });
  }

  /**
   * Plan, fetch what the plan is missing, and re-plan, until a pass demands
   * nothing new.
   *
   * Terminates because every id fetched — or settled — enters `made` and is
   * never asked again this run. Two passes in practice: one to learn which
   * films have no row, one to plan the insert with what TMDB answered.
   */
  private async filmsToFixpoint(
    grid: MovieGrid,
    index: Map<number, FilmProgress>,
    seed: Baseline,
    held: Set<number>,
    made: { films: Set<number>; failures: number },
    signal: AbortSignal | undefined,
  ): Promise<FilmPlanResult> {
    const now = Temporal.Now.instant();

    for (let pass = 1; ; pass += 1) {
      const result = planFilms(grid, index, this.films.films, {
        now,
        timezone: config.timezone,
        baseline: baseline(),
        seed,
        held,
        onShowGrid: this.onShowGrid,
      });
      // Reported once. Not settled: what is missing is SIMKL's id, not TMDB's
      // knowledge, so the film stays askable the moment SIMKL fills it in.
      for (const film of result.unidentifiable) {
        if (this.films.noteUnidentifiable(film)) {
          this.log.warn(`${film.title} (${film.id}) has no TMDB id in the library, so its row has to be added by hand`);
        }
      }
      if (pass > MAX_PASSES) {
        this.log.warn(`the films planner still wanted lookups after ${MAX_PASSES} passes; running with what it has`);
        return result;
      }

      const wanted = result.demands.filter((demand) => !made.films.has(demand.id));
      if (!wanted.length) return result;
      for (const demand of wanted) made.films.add(demand.id);

      try {
        const fetched = await fetchFilms(wanted, { signal });
        this.films.fold(wanted, fetched);
        made.failures += fetched.failed.length;
        if (fetched.unavailable.length) {
          this.log.warn(`TMDB has no record for ${fetched.unavailable.length} film(s): ${fetched.unavailable.join(', ')}`);
        }
      } catch (err) {
        // An `account` failure — a rejected token — is rethrown by
        // `lookupPool` rather than filed as a hundred dead films. Settling the
        // pending ones is the answer to *that* and never to an outage, which
        // would strand every film's row on one bad minute.
        if (tmdbClassify(err) !== 'account') throw err;
        this.log.error(`TMDB rejected the credential; no film row will be built this process: ${errorMessage(err)}`);
        this.films.settleUnusable(wanted);
      }
    }
  }

  private report(headline: string, lines: string[], level: 'info' | 'error' = 'info'): void {
    this.log[level](headline);
    for (const line of lines) this.log.info(line);
  }
}
