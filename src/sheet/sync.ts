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
 * The films tab runs the same protocol against its own numbered core in
 * `movies/`. One loop, `runTab`, drives both: what differs between the tabs is
 * how a grid is parsed, planned, guarded, described and verified, and every
 * one of those is a rule about what may be written, which lives in the tab's
 * own modules. What the loop holds — the read, the freshness budget, the
 * report/refuse/apply branches, the freeze latch, the journal — holds no such
 * rule, and a second copy of it is a second place the latch can be wrong.
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
import { readSnapshot, type SheetSnapshot } from './io/spreadsheet.ts';
import { fetchCatalogue, type CatalogueRequest } from './io/catalogue.ts';
import { fetchSeasonRuntimes, runtimeKeyOf, type RuntimeRequest } from './io/runtimes.ts';
import { classify } from '../api/tvdb/client.ts';
import { parseGrid, type Grid } from './2-grid.ts';
import { indexLibrary, type TitleProgress } from './1-index.ts';
import { CATALOGUE_MAX_AGE, CatalogueStore, needsLookup } from './3-catalogue.ts';
import { describePlan, emptyPlan, gridIds, observeWatches, planRecord, planSync, type PlanRecord, type PlanResult, type SheetPlan } from './4-plan.ts';
import { rowsTouched, toRequests, writesFor, type PlannedWrites } from './6-requests.ts';
import { verify, type Verification } from './7-verify.ts';
import { parseMovieGrid, type MovieGrid } from './movies/2-grid.ts';
import { animeFilmIds, indexFilms, type FilmProgress } from './movies/1-index.ts';
import { FilmStore } from './movies/3-catalogue.ts';
import { describeFilmPlan, emptyFilmPlan, filmPlanRecord, observeFilms, planFilms, type FilmPlan, type FilmPlanResult } from './movies/4-plan.ts';
import { assertFilmPlanSafe } from './movies/5-guard.ts';
import { verifyFilms } from './movies/7-verify.ts';
import { fetchFilms } from './movies/io/tmdb.ts';
import { classify as tmdbClassify } from '../api/tmdb/client.ts';
import { assertPlanSafe } from './5-guard.ts';
import { PlanRefusal, type SpentBudget } from './guard-core.ts';
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

const worseStatus = (a: SheetSyncStatus, b: SheetSyncStatus): SheetSyncStatus => (SEVERITY[a] <= SEVERITY[b] ? a : b);

/** One poll's result from its halves': the worse status, and both plans and errors. */
const worse = (a: SheetSyncResult, b: SheetSyncResult): SheetSyncResult => ({
  status: worseStatus(a.status, b.status),
  // Both halves' plans, so the caller's counts describe the whole poll.
  record: { edits: [...a.record.edits, ...b.record.edits], inserts: [...a.record.inserts, ...b.record.inserts] },
  // Both errors: one half failing must not hide the other's failure.
  error: [a.error, b.error].filter(Boolean).join('; ') || null,
  retry: a.retry || b.retry,
});

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

/**
 * What one poll's halves share, built fresh in `run()` and handed to each.
 *
 * Per-poll state lives here rather than on the instance so that "reset every
 * poll" is the shape of the code, not a list of assignments at the top of
 * `run()` that has to grow with every field. Each of these is an answer only
 * this poll may use: a show grid read a poll ago says nothing about where an
 * anime film may go now, and a budget spent a poll ago is not spent now.
 */
interface Poll {
  library: Library | null;
  signal: AbortSignal | undefined;
  /**
   * What earlier halves this poll sent to the sheet, counted against the same
   * budget. `SHEET_MAX_EDITS` is a blast radius for the poll, not an allowance
   * per tab: counted per tab, one poll writes twice it while each half reports
   * itself inside budget. Charged for what was *sent*, not what verified — a
   * batch that went out and could not be read back may well have landed.
   */
  spent: SpentBudget;
  /**
   * Every SIMKL id the show grid held when this poll read it, or null if it
   * was never read. Assigned the moment the grid parses, so a show half that
   * fails *after* the read still leaves a valid answer. The films half needs
   * it to place an anime film: on `Sheet1` already means leave it there. Null
   * fails closed — see `onShowGrid` in `movies/4-plan.ts`.
   */
  showGridIds: Set<number> | null;
  /** The worse of the halves recorded so far — what the status page shows mid-poll. */
  status: SheetSyncStatus;
}

/**
 * A plan and what came with it: the observations to record, and two facts the
 * loop turns into "ask for another poll".
 */
interface Planned<P> {
  plan: P;
  observed: Baseline;
  writing: Baseline;
  /** Retryable lookups that failed this run. */
  failures: number;
  /**
   * Whether the planner wanted lookups this run chose not to make. Work
   * exists for the next poll and nothing else will ask for it, so the loop
   * asks — but only where a write can drain it.
   */
  unfetched: boolean;
}

/** What the loop reads off a plan, whichever tab built it. */
interface TabPlan extends PlannedWrites {
  deferredInserts: number;
}

/**
 * Everything the loop needs to know about a tab, and nothing about which one it
 * is. Each half builds one per run, closing over what its planner needs.
 *
 * `G` and `P` are tied here and nowhere else: `plan` produces a `P` from a `G`,
 * and `guard`, `describe` and `verify` consume the same pair, so a films plan
 * cannot meet the show grid inside the loop. That is what lets `writesFor`
 * and `verifyAgainst` stay structural.
 */
interface TabSpec<G extends { snapshot: SheetSnapshot }, P extends TabPlan> {
  tab: SheetTab;
  /** The tab's title, as `readSnapshot` wants it. */
  sheetName: string;
  /** Prefix for log lines. */
  label: string;
  /** What an insert adds, for the deferral log line. */
  rowKind: string;
  parse: (snapshot: SheetSnapshot) => G;
  /** Called as soon as a grid parses, before planning can fail. */
  onParsed?: (grid: G) => void;
  /** Plan to a fixpoint, fetching what the plan is missing. */
  plan: (grid: G, attempt: number) => Promise<Planned<P>>;
  /** Throws a `PlanRefusal`; anything else is a bug and propagates. */
  guard: (plan: P, grid: G, spent: SpentBudget) => void;
  describe: (plan: P, grid: G) => string[];
  record: (plan: P) => PlanRecord;
  verify: (before: G, after: SheetSnapshot, plan: P) => Verification;
  /** A plan that writes nothing, for `verifyRestored`. */
  empty: () => P;
}

export class SheetSync {
  log: Logger;
  /**
   * Set when a rollback failed, never cleared in-process: the sheet is in a
   * state nobody has verified, so the only safe next write is none. Clearing
   * it is a restart, which is safe — after a restart there is no pending
   * rollback, only a fresh plan against a fresh read.
   */
  frozen: string | null = null;
  /** Which tab froze, so every later poll's record names the tab that needs repair. */
  private frozenTab: SheetTab = 'shows';
  lastRunAt: string | null = null;
  lastStatus: SheetSyncStatus = 'idle';
  /** What the upstreams have said so far, retained across polls — see `3-catalogue.ts`. */
  private store = new CatalogueStore();
  /** What TMDB has said about each film so far — see `movies/3-catalogue.ts`. */
  private films = new FilmStore();
  /**
   * What the run being recorded saw upstream, waiting on its outcome.
   *
   * Held here rather than threaded through `runTab`'s return paths, for the
   * reason the journal append is: the outcome is only known at the choke
   * point, and `writing` may only be recorded once the write it belongs to
   * has landed. One slot, because the halves run in sequence and each is
   * recorded before the next begins.
   */
  private pending: Pick<PlanResult, 'observed' | 'writing'> | null = null;

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
    const poll: Poll = { library, signal, spent: { edits: 0, rows: 0 }, showGridIds: null, status: 'idle' };
    if (this.frozen) {
      this.log.error(this.frozen);
      return await this.record(outcome('frozen', { error: this.frozen }), this.frozenTab, poll);
    }

    const shows = await this.half('shows', () => this.showsSpec(poll), poll);
    // The freeze latch is process-wide, so a show half that froze stops the
    // films half in the same poll rather than on the next one: the sheet is in
    // a state nobody has verified, and which tab that state is on does not make
    // another write safe.
    if (this.frozen || !moviesSyncConfigured()) return shows;
    return worse(shows, await this.half('films', () => this.filmsSpec(poll), poll));
  }

  /**
   * One tab's run, with the failure handling both share. A half whose library
   * holds nothing for it to plan is idle without reading the tab.
   */
  private async half<G extends { snapshot: SheetSnapshot }, P extends TabPlan>(
    tab: SheetTab,
    build: () => TabSpec<G, P> | null,
    poll: Poll,
  ): Promise<SheetSyncResult> {
    try {
      const spec = build();
      return await this.record(spec ? await this.runTab(spec, poll) : outcome('idle'), tab, poll);
    } catch (err) {
      const message = errorMessage(err);
      this.log.error(`sheet sync (${tab}) failed: ${message}`);
      // A failure that needs a human — a wrong SHEET_ID, an unshared
      // spreadsheet — is said every run through `errors.sheet`; asking for
      // another poll would only re-arm the retry indefinitely. The client
      // spec decides which failures those are; see `SheetsAccessError`.
      const permanent = err instanceof SheetsAccessError && err.needsHuman;
      return await this.record(outcome('failed', { error: message, retry: !permanent }), tab, poll);
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
  private async record(result: SheetSyncResult, tab: SheetTab, poll: Poll): Promise<SheetSyncResult> {
    this.lastRunAt = nowIso();
    // Worst-wins across the poll: a quiet films half reporting `idle` must not
    // overwrite a show grid that was refused.
    poll.status = worseStatus(poll.status, result.status);
    this.lastStatus = poll.status;
    await this.remember(result.status);
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
  private async remember(status: SheetSyncStatus): Promise<void> {
    const pending = this.pending;
    // Cleared before the await: a run that reached no plan — frozen, or a
    // throw out of the loop — must not record what the run before it saw.
    this.pending = null;
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

  /**
   * The protocol, for either tab: read, plan to a fixpoint, guard, write.
   *
   * A snapshot is read per attempt and the plan is thrown away with it when
   * FRESH sends the loop back to the read — re-planning is the point.
   */
  private async runTab<G extends { snapshot: SheetSnapshot }, P extends TabPlan>(spec: TabSpec<G, P>, poll: Poll): Promise<SheetSyncResult> {
    // Held across attempts so the exhausted path below reports the plan it
    // built rather than an empty one — the run whose detail matters most.
    let record: PlanRecord | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const snapshot = await readSnapshot(spec.sheetName, { signal: poll.signal });
      const grid = spec.parse(snapshot);
      spec.onParsed?.(grid);
      const { plan, observed, writing, failures, unfetched } = await spec.plan(grid, attempt);
      // Replaced per attempt, never merged: a FRESH re-read plans against a
      // different grid, and the observations of a pass whose plan was thrown
      // away describe rows this run is no longer acting on.
      this.pending = { observed, writing };
      record = spec.record(plan);

      // A failed lookup means some row's shape is unknown — exactly what leaves
      // it unwritten this run. A deferred row, or a lookup the run chose not
      // to make, is simpler: the work exists and only the one-per-run rule
      // holds it, so ask for another poll rather than waiting on unrelated
      // activity — but only when the deferral can drain, which needs a write.
      // Report mode never takes the first row, so asking there would re-read
      // and re-plan the whole grid forever.
      const lookupRetry = failures > 0;
      const retry = lookupRetry || (config.sheetSyncMode === 'apply' && (plan.deferredInserts > 0 || unfetched));
      if (plan.deferredInserts) this.log.info(`${plan.deferredInserts} more ${spec.rowKind} to add; the next poll will take the next one`);
      if (failures) this.log.warn(`${failures} lookup(s) failed; the ${spec.label} will retry on the next poll`);

      if (!plan.edits.length && !plan.insert) {
        const lines = spec.describe(plan, grid);
        if (lines.length) this.report(`${spec.label}: nothing to write`, lines);
        return outcome('idle', { retry });
      }

      try {
        spec.guard(plan, grid, poll.spent);
      } catch (err) {
        // The refusal is no reason to retry: the same inputs would refuse
        // again. A failed lookup is, independent of why the plan was refused.
        if (!(err instanceof PlanRefusal)) throw err;
        this.report(`${spec.label} REFUSED the plan: ${err.message}`, spec.describe(plan, grid), 'error');
        return outcome('refused', { record, error: err.message, retry: lookupRetry });
      }

      if (config.sheetSyncMode === 'report') {
        this.report(`${spec.label} (report mode): ${record.edits.length} edits, ${record.inserts.length} inserts — nothing written`, spec.describe(plan, grid));
        return outcome('reported', { record, retry });
      }

      // FRESH. Back to the read, not on to the write: re-planning is the point.
      if (performance.now() - snapshot.readAtMono > FRESH_MS) {
        this.log.warn(`the ${spec.sheetName} snapshot aged past ${FRESH_MS / 1000}s while planning; re-reading (attempt ${attempt})`);
        continue;
      }

      const applied = await applyPlan(
        {
          snapshot: grid.snapshot,
          requests: toRequests(writesFor(plan, grid)),
          describe: () => spec.describe(plan, grid),
          summary: `${plan.edits.length} edits and ${plan.insert ? 1 : 0} inserts`,
          verify: (after) => spec.verify(grid, after, plan),
          verifyRestored: (after) => spec.verify(grid, after, spec.empty()),
        },
        { log: this.log, signal: poll.signal },
      );
      // The batch went out, whatever became of it. Charged here rather than at
      // the guard, a plan the FRESH loop then discarded — or one report mode
      // never wrote — would still dock the next half's allowance.
      poll.spent = { edits: poll.spent.edits + plan.edits.length, rows: poll.spent.rows + rowsTouched(plan) };

      // A freeze is the one outcome with state: the message is latched so
      // every later run repeats it instead of writing.
      if (applied.status === 'frozen') {
        this.frozen = applied.error;
        this.frozenTab = spec.tab;
        this.log.error(applied.error ?? '');
        return outcome('frozen', { record, error: applied.error });
      }
      // A batch that never landed earns another poll on its own; a clean or
      // rolled-back run keeps whatever retry the planning phase earned — the
      // rolled-back work is not guaranteed to refuse again, since the
      // concurrent edit that triggered it was itself reverted by the restore.
      return outcome(applied.status, { record, error: applied.error, retry: applied.status === 'failed' ? true : retry });
    }

    const message = `could not plan ${spec.sheetName} against a fresh snapshot in ${MAX_ATTEMPTS} attempts`;
    this.log.warn(`${spec.label}: ${message}`);
    return outcome('failed', { record, error: message, retry: true });
  }

  // --- The show grid ---------------------------------------------------------

  /** The show grid's answers, or null when the library holds nothing to plan. */
  private showsSpec(poll: Poll): TabSpec<Grid, SheetPlan> | null {
    const index = indexLibrary(poll.library);
    if (index.size === 0) return null;

    // Built once: it is a projection of the library alone, and the library
    // cannot change while a run is in flight, so every planning pass after the
    // first would rebuild a byte-identical map.
    const starts = observeWatches(index);
    // The films tab's, so this half does not report each as a title with no
    // row — but only where that tab is being synced. Unconfigured, nothing
    // places them, and the note is the only thing that says so.
    const filed = moviesSyncConfigured() ? animeFilmIds(poll.library) : new Set<number>();

    // Lookups already made this run. A FRESH re-plan or later planning pass
    // must not re-issue them — failed ones included, which stay unstamped in
    // the store so the *next poll* retries them, but would otherwise stall
    // this run on exactly the fetches that aged its snapshot.
    const made: RunLookups = { catalogue: new Set(), runtimes: new Set(), failures: 0 };

    return {
      tab: 'shows',
      sheetName: config.sheetName,
      label: 'sheet sync',
      rowKind: 'row(s)',
      parse: parseGrid,
      onParsed: (grid) => {
        poll.showGridIds = gridIds(grid);
      },
      plan: async (grid, attempt) => {
        const result = await this.planToFixpoint(grid, index, starts, filed, made, attempt, poll.signal);
        return { ...result, failures: made.failures, unfetched: false };
      },
      guard: (plan, grid, spent) => assertPlanSafe(plan, grid, { spent }),
      describe: (plan, grid) => describePlan(plan, grid.columns),
      record: planRecord,
      verify,
      empty: emptyPlan,
    };
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

  // --- The films tab ---------------------------------------------------------

  /** The films tab's answers, or null when the library holds no film at all. */
  private filmsSpec(poll: Poll): TabSpec<MovieGrid, FilmPlan> | null {
    const index = indexFilms(poll.library);
    // The early-out, and it is narrower than it looks: `indexFilms` returns
    // every film whatever moved, so this fires only when the library holds none
    // at all. The tab is read on every other poll by design — baseline gating
    // and the missing-from-tab diff both need the grid.
    if (index.size === 0) return null;

    // Every id the library holds, so a row for an anime film reads as the show
    // half's rather than as unaccounted for.
    const held = new Set(poll.library?.keys() ?? []);

    // A projection of the library alone, which cannot change while a run is in
    // flight, so every planning pass after the first would rebuild it identically.
    const seed = observeFilms(index);
    // Lookups already made this run. A FRESH re-plan or a later pass must not
    // re-issue them — failed ones included, which stay unrecorded in the store
    // so the *next poll* retries them, but would otherwise stall this run on
    // exactly the fetches that aged its snapshot.
    const made = { films: new Set<number>(), failures: 0 };

    return {
      tab: 'films',
      sheetName: config.moviesSheetName,
      label: 'films sync',
      rowKind: 'film row(s)',
      parse: parseMovieGrid,
      plan: async (grid) => {
        const { result, unfetched } = await this.filmsToFixpoint(grid, index, seed, held, made, poll);
        return { ...result, failures: made.failures, unfetched };
      },
      guard: (plan, grid, spent) => assertFilmPlanSafe(plan, grid, { spent }),
      describe: (plan) => describeFilmPlan(plan),
      record: filmPlanRecord,
      verify: verifyFilms,
      empty: emptyFilmPlan,
    };
  }

  /**
   * Plan, fetch what the plan is missing, and re-plan, until the pass that
   * plans the insert.
   *
   * One row is inserted per run, so the lookups the films *behind* it still
   * need are the next poll's to make, and fetching them now would only spend
   * `MAX_LOOKUPS_PER_PASS` again on every pass to the ceiling. Two passes in
   * practice: one to learn which films have no row, one to plan the insert
   * with what TMDB answered; one, once the store holds the answer. Terminates
   * because every id fetched enters `made` and is never asked again this run.
   *
   * `unfetched` says demands were left standing, which the loop turns into
   * another poll — unless TMDB has rejected the credential, when no poll can
   * drain them and asking would re-read the tab every tick for nothing.
   */
  private async filmsToFixpoint(
    grid: MovieGrid,
    index: Map<number, FilmProgress>,
    seed: Baseline,
    held: Set<number>,
    made: { films: Set<number>; failures: number },
    poll: Poll,
  ): Promise<{ result: FilmPlanResult; unfetched: boolean }> {
    const now = Temporal.Now.instant();

    for (let pass = 1; ; pass += 1) {
      const result = planFilms(grid, index, this.films.films, {
        now,
        timezone: config.timezone,
        baseline: baseline(),
        seed,
        held,
        onShowGrid: poll.showGridIds,
        lookupsRejected: this.films.rejected,
      });
      // Reported once. Not settled: what is missing is SIMKL's id, not TMDB's
      // knowledge, so the film stays askable the moment SIMKL fills it in.
      for (const film of result.unidentifiable) {
        if (this.films.noteUnidentifiable(film)) {
          this.log.warn(`${film.title} (${film.id}) has no TMDB id in the library, so its row has to be added by hand`);
        }
      }

      const wanted = result.demands.filter((demand) => !made.films.has(demand.id));
      if (!wanted.length || result.plan.insert || this.films.rejected) {
        return { result, unfetched: wanted.length > 0 && !this.films.rejected };
      }
      if (pass > MAX_PASSES) {
        this.log.warn(`the films planner still wanted lookups after ${MAX_PASSES} passes; running with what it has`);
        return { result, unfetched: true };
      }
      for (const demand of wanted) made.films.add(demand.id);

      try {
        const fetched = await fetchFilms(wanted, { signal: poll.signal });
        this.films.fold(wanted, fetched);
        made.failures += fetched.failed.length;
        if (fetched.unavailable.length) {
          this.log.warn(`TMDB has no record for ${fetched.unavailable.length} film(s): ${fetched.unavailable.join(', ')}`);
        }
      } catch (err) {
        // An `account` failure — a rejected token — is rethrown by
        // `lookupPool` rather than filed as a hundred dead films. It is a fact
        // about the credential, not about any film, so it is recorded as one:
        // no film is settled, and no further lookup is made this process.
        // Filing the films as unobtainable would tell the operator to add by
        // hand rows TMDB could build the moment the token is fixed.
        if (tmdbClassify(err) !== 'account') throw err;
        this.films.reject();
        this.log.error(`TMDB rejected the credential; no film row will be built until it is fixed and the service restarted: ${errorMessage(err)}`);
      }
    }
  }

  private report(headline: string, lines: string[], level: 'info' | 'error' = 'info'): void {
    this.log[level](headline);
    for (const line of lines) this.log.info(line);
  }
}
