/**
 * The write protocol. The only thing in the project that writes to the sheet.
 *
 * It runs the numbered modules beside it, in their number order, with the whole
 * cycle inside one poll so that what was planned and what was written describe
 * the same grid:
 *
 *   INDEX     1-progress.ts     — the library, and the early-out
 *   READ      io/spreadsheet.ts, io/catalogue.ts
 *   PARSE     2-grid.ts
 *   PLAN      3-plan.ts
 *   GUARD     4-guard.ts        — nothing is built until this passes
 *   FRESH     a snapshot older than 120s restarts the cycle from the READ
 *   BUILD     5-requests.ts
 *   APPLY     io/spreadsheet.ts
 *   VERIFY    6-verify.ts
 *   ROLLBACK  5-requests.ts again, in separate batches
 *   FROZEN    no further writes this process
 *
 * `run()` never rejects: it is called from the refresh path, where nothing may
 * be fatal. Failures land in the returned result and, through it, in
 * `errors.sheet` and `/healthz`.
 */

import { config, tvdbConfigured } from '../shared/config.ts';
import { errorMessage } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import { SheetsAccessError } from '../api/google/client.ts';
import type { Library } from '../library.ts';
// The steps, in the order this file runs them.
import { applyRequests, readSnapshot, type SheetSnapshot } from './io/spreadsheet.ts';
import { fetchCatalogue } from './io/catalogue.ts';
import { fetchSeasonRuntimes, runtimeKeyOf } from './io/runtimes.ts';
import { classify } from '../api/tvdb/client.ts';
import { parseGrid, type Grid } from './2-grid.ts';
import { averageRuntime, indexLibrary, seasonShapes, tvdbIdOf, type TitleProgress } from './1-progress.ts';
import { describePlan, planLookups, planRecord, planRuntimeLookups, planSync, type CatalogueStamp, type CatalogueView, type PlanRecord, type SheetPlan, type TitleCatalogue } from './3-plan.ts';
import { assertPlanSafe, UnsafePlanError } from './4-guard.ts';
import { backupRequest, deleteRowRequests, restoreRequest, toRequests } from './5-requests.ts';
import { backupName, discardBackup, findBackup, isBackupTab, markForRepair, sweepBackups } from './backups.ts';
import { verify, type Verification } from './6-verify.ts';
import { appendSheetRun, loadSheetRuns } from './io/journal.ts';
import { nowIso } from '../shared/dates.ts';

/**
 * How old a snapshot may be when the write goes out. Past this the snapshot is
 * discarded and the whole cycle re-runs from the read — re-planning is the
 * point, because a plan built on a discarded snapshot has stale row indices and
 * the guard would be asserting against a grid that no longer exists.
 */
const FRESH_MS = 120_000;

/** Bounded so a pathologically slow catalogue fetch cannot loop forever. */
const MAX_ATTEMPTS = 3;

/**
 * How long a title's catalogue is trusted without any watch activity to
 * prompt a re-read. Daily, for the reason `movieRefresh` is daily: a network
 * renewing a show produces nothing in your library to gate on.
 */
const CATALOGUE_MAX_AGE = Temporal.Duration.from({ hours: 24 });

export type SheetSyncStatus = 'idle' | 'reported' | 'applied' | 'refused' | 'failed' | 'rolled-back' | 'frozen';

export interface SheetSyncResult {
  status: SheetSyncStatus;
  /**
   * What the run planned, kept as records rather than two counts.
   *
   * The counts it replaces were passed by hand at each return site, and three
   * of the six — `failed`, `frozen`, `rolled-back` — did not pass them, so the
   * runs whose detail matters most reported having planned nothing. A `.length`
   * cannot be forgotten.
   */
  plan: PlanRecord;
  /** The report: every proposed edit, skip and note, one per line. */
  lines: string[];
  /** For `errors.sheet`; null when the run was clean. */
  error: string | null;
  /** Whether the next poll should try again even if no list moved. */
  retry: boolean;
}

const idle = (overrides: Partial<SheetSyncResult> = {}): SheetSyncResult => ({
  status: 'idle',
  // Fresh arrays per result rather than one shared empty: a single mutation
  // anywhere would otherwise reach every past result and every journal record
  // built from one.
  plan: { edits: [], inserts: [] },
  lines: [],
  error: null,
  retry: false,
  ...overrides,
});

export class SheetSync {
  log: Logger;
  /**
   * Set when a rollback failed, and never cleared in-process. The sheet is in a
   * state nobody has verified, so the only safe next write is none. Clearing it
   * is a restart, which is safe: after a restart there is no pending rollback,
   * only a fresh plan against a fresh read.
   */
  frozen: string | null = null;
  lastRunAt: string | null = null;
  lastStatus: SheetSyncStatus = 'idle';
  /**
   * Catalogue results retained across polls, so the planner always sees a
   * complete picture even though only the titles that moved were re-read.
   *
   * Reduced to what the planner reads — per-season shapes, `status`, `runtime`
   * — rather than the raw payloads, so this does not accumulate per-episode
   * descriptions and images for the life of the process.
   *
   * The gating belongs here rather than in a cache under `fetchCatalogue`: the
   * decision needs the library, and the source has no business knowing about
   * it. Process-local, so a restart re-reads everything — which is the right
   * answer after a restart anyway.
   */
  private retained = new Map<number, TitleCatalogue>();
  private stamps = new Map<number, CatalogueStamp>();

  constructor({ logger = console as Logger }: { logger?: Logger } = {}) {
    this.log = logger;
  }

  /**
   * Restore what survives a restart: the run history, which is read here rather
   * than by the caller so the half that writes the file is the one that knows
   * when to read it. Never throws — an unreadable history is no history.
   */
  hydrate(): Promise<void> {
    return loadSheetRuns({ log: this.log });
  }

  async run(library: Library | null, { signal }: { signal?: AbortSignal } = {}): Promise<SheetSyncResult> {
    if (config.sheetSyncMode === 'off') return idle();
    if (this.frozen) {
      this.log.error(this.frozen);
      return await this.record(idle({ status: 'frozen', error: this.frozen }));
    }

    try {
      return await this.record(await this.cycle(library, signal));
    } catch (err) {
      const message = errorMessage(err);
      this.log.error(`sheet sync failed: ${message}`);
      // A wrong SHEET_ID or an unshared spreadsheet needs a human, so asking
      // for another poll only re-arms the retry every poll indefinitely. It
      // still lands in `errors.sheet` and `/healthz` on every run — "say it
      // once" here means stop the retry loop, not stop reporting.
      //
      // A 401 is not that, despite sharing the class: the transport clears the
      // token cache on its way out, so the next poll signs a fresh assertion
      // and recovers on its own. Without the retry it would not get one until
      // some list happened to move.
      const permanent = err instanceof SheetsAccessError && err.status !== 401;
      return await this.record(idle({ status: 'failed', error: message, retry: !permanent }));
    }
  }

  /**
   * The one choke point every terminal path funnels through, which is why the
   * journal append lives here rather than at six call sites. Awaited rather
   * than fired and forgotten: the append cannot throw, and awaiting keeps a
   * test's assertion about the file deterministic.
   *
   * The `sheetSyncMode === 'off'` return in `run()` deliberately does not come
   * through here, so an inert install writes no file at all.
   */
  private async record(result: SheetSyncResult): Promise<SheetSyncResult> {
    this.lastRunAt = nowIso();
    this.lastStatus = result.status;
    await appendSheetRun(
      {
        at: this.lastRunAt,
        status: result.status,
        mode: config.sheetSyncMode,
        edits: result.plan.edits,
        inserts: result.plan.inserts,
        error: result.error,
      },
      { log: this.log },
    );
    return result;
  }

  private async cycle(library: Library | null, signal: AbortSignal | undefined): Promise<SheetSyncResult> {
    const index = indexLibrary(library);
    if (index.size === 0) return idle();

    // Held across attempts so the exhausted path below can report the plan it
    // built rather than an empty one — the run whose detail matters most.
    let record: PlanRecord | undefined;
    let lines: string[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const snapshot = await readSnapshot({ signal });
      const grid = parseGrid(snapshot);

      // One instant for both, threaded rather than defaulted. `planLookups`
      // and `planSync` must agree about which blocks are in scope, and they are
      // separated here by the entire catalogue fetch — letting each default its
      // own `Temporal.Now.instant()` would put that fetch's duration between the
      // two answers, so a block sitting on the activity cut-off could be looked
      // up and then planned as out of scope, or the reverse.
      const now = Temporal.Now.instant();
      const catalogue = await this.catalogueFor(grid, index, signal, now);
      // Second, and it cannot be folded into the first: which seasons need a
      // runtime is a question about which are *completing*, which the episode
      // list above is what answers.
      //
      // First attempt only. A failed lookup is deliberately not recorded, so a
      // re-plan would re-issue exactly the lookups that aged the snapshot past
      // FRESH_MS — and a throttled season can spend a minute apiece obeying
      // `Retry-After`. Three attempts of that ends the run `failed`, losing the
      // `Episode`, `Status` and insert writes the poll had already earned to an
      // optional column. Skipping leaves those seasons pending, which is the
      // outcome they already had this poll.
      const runtimesFailed = attempt === 1 ? await this.runtimesFor(grid, index, catalogue, signal, now) : 0;
      const plan = planSync(grid, index, catalogue, { now });
      lines = describePlan(plan, grid.columns);
      // Once per scope: five separate calls read as five projections a reader
      // has to confirm are the same one.
      record = planRecord(plan);
      // An incomplete catalogue means some season's shape is unknown, and an
      // unknown shape is exactly what makes an end date premature. A deferred
      // row is simpler: the work exists and the cap is the only thing holding
      // it, so ask for another poll rather than waiting on unrelated activity.
      //
      // Only when the deferral can actually drain, which needs a write. Report
      // mode never takes the first row either, so asking for another poll would
      // re-read and re-plan the whole grid forever — in the default mode.
      // A season whose runtimes did not come back is one whose row was left open
      // rather than dated, so this poll has work it could not finish.
      const catalogueRetry = catalogue.failed.length > 0 || runtimesFailed > 0;
      const retry = catalogueRetry || (config.sheetSyncMode === 'apply' && plan.deferred > 0);
      if (plan.deferred) this.log.info(`${plan.deferred} more row(s) to add; the next poll will take the next one`);
      if (catalogue.failed.length) {
        this.log.warn(`${catalogue.failed.length} SIMKL lookups failed; the sheet sync will retry on the next poll`);
      }
      if (runtimesFailed) {
        this.log.warn(`${runtimesFailed} season runtime lookups failed; those rows stay open until the next poll`);
      }

      if (!plan.edits.length && !plan.inserts.length) {
        if (lines.length) this.report('sheet sync: nothing to write', lines);
        return idle({ lines, retry });
      }

      try {
        assertPlanSafe(plan, grid);
      } catch (err) {
        // The refusal itself is not a reason to retry: the same inputs would
        // refuse again. A failed catalogue lookup is, and it is independent of
        // why the plan was refused — the log line above has already promised
        // the next poll will try it.
        if (!(err instanceof UnsafePlanError)) throw err;
        this.report(`sheet sync REFUSED the plan: ${err.message}`, lines, 'error');
        return idle({ status: 'refused', plan: record, lines, error: err.message, retry: catalogueRetry });
      }

      if (config.sheetSyncMode === 'report') {
        this.report(`sheet sync (report mode): ${plan.edits.length} edits, ${plan.inserts.length} inserts — nothing written`, lines);
        return idle({ status: 'reported', plan: record, lines, retry });
      }

      // FRESH. Back to the read, not on to the write: re-planning is the point.
      if (performance.now() - snapshot.readAtMono > FRESH_MS) {
        this.log.warn(`the sheet snapshot aged past ${FRESH_MS / 1000}s while planning; re-reading (attempt ${attempt})`);
        continue;
      }

      return await this.apply(grid, plan, lines, retry, signal);
    }

    const message = `could not plan against a fresh snapshot in ${MAX_ATTEMPTS} attempts`;
    this.log.warn(`sheet sync: ${message}`);
    return idle({ status: 'failed', plan: record, lines, error: message, retry: true });
  }

  /**
   * Re-read the catalogue of every title that moved, and fold the results into
   * what is already held.
   *
   * Stamping happens here rather than at the end of the run, so the FRESH
   * retry loop's second pass asks for nothing: it has already been read.
   */
  private async catalogueFor(grid: Grid, index: Map<number, TitleProgress>, signal: AbortSignal | undefined, now: Temporal.Instant): Promise<CatalogueView> {
    const requests = planLookups(grid, index, { now, stamps: this.stamps, maxAge: CATALOGUE_MAX_AGE });
    const fetched = await fetchCatalogue(requests, { signal });

    // Derive on the way in: the shapes are computed once per title here rather
    // than once per season row inside the planner.
    const entry = (id: number): TitleCatalogue => {
      const existing = this.retained.get(id) ?? { shapes: new Map(), seasonRuntimes: new Map() };
      this.retained.set(id, existing);
      return existing;
    };
    for (const [id, episodes] of fetched.episodes) entry(id).shapes = seasonShapes(episodes);
    for (const [id, detail] of fetched.details) Object.assign(entry(id), {
      status: detail.status,
      runtime: detail.runtime,
      // Withheld without a credential, rather than stored and then ignored: an
      // absent join key is already "no runtime is obtainable for this row" to
      // every rule in the planner, so the planner needs no second switch — and
      // a switch it did have could be set the wrong way and strand every row.
      tvdbId: tvdbConfigured() ? tvdbIdOf(detail) : null,
    });

    // A retryable failure is deliberately not stamped, so the next poll asks
    // again — the same reason the film path withholds its list signature. A
    // `gone` id is stamped: retrying never starts working, and leaving it
    // unstamped would re-request it on every poll forever.
    const stalled = new Set(fetched.failed);
    const at = Temporal.Now.instant();
    for (const { id } of requests) {
      if (stalled.has(id)) continue;
      this.stamps.set(id, { watchedAt: index.get(id)?.lastWatchedAt ?? null, at });
    }

    if (requests.length) {
      // Titles, not requests: a live-action block emits two request records for
      // one id — the episode list and the status lookup — which fetchCatalogue
      // merges. Counting the records reads as twice as many shows as there are.
      const titles = new Set(requests.map((r) => r.id)).size;
      this.log.info(`sheet sync: re-read ${titles} title catalogues in ${fetched.episodes.size + fetched.details.size} calls`);
    }
    if (fetched.unavailable.length) {
      this.log.warn(`${fetched.unavailable.length} SIMKL titles are gone upstream: ${fetched.unavailable.join(', ')}`);
    }

    return { titles: this.retained, failed: fetched.failed, unavailable: fetched.unavailable };
  }

  /**
   * Look up the per-episode runtimes of every season about to be closed, and
   * fold them into the same retained entries. Returns how many lookups failed.
   *
   * Runs after `catalogueFor` and needs to: the TVDB id arrives on the detail
   * call that phase makes, and which seasons are *completing* is a question only
   * the episode list it fetches can answer.
   *
   * Folds by reference into `this.retained`, so `catalogue.titles` is current
   * without a second view to keep in step.
   */
  private async runtimesFor(
    grid: Grid,
    index: Map<number, TitleProgress>,
    catalogue: CatalogueView,
    signal: AbortSignal | undefined,
    now: Temporal.Instant,
  ): Promise<number> {
    // Where the feature costs nothing when it is switched off. Not the switch
    // itself — `catalogueFor` withholds the join key, so the planner already
    // reads every row as settled — just the grid walk this would otherwise do.
    if (!tvdbConfigured()) return 0;

    const requests = planRuntimeLookups(grid, index, catalogue, { now });
    if (!requests.length) return 0;

    let fetched;
    try {
      fetched = await fetchSeasonRuntimes(requests, { signal });
    } catch (err) {
      // An account-level failure escapes the pool by design, because it is not a
      // fact about any one season. It must not escape the *run* either: the grid
      // read and every SIMKL call this poll already made would be thrown away,
      // and the sheet would go a poll without a write, over an optional column.
      //
      // What it does to the rows depends on which kind it is, and the difference
      // matters more than it looks. A rejected key is **settled** — no number of
      // polls will make a typo answer — so those seasons record `null` and close
      // with the cell blank. Left pending instead, every completing season stays
      // open for ever and the sheet quietly stops being dated at all, which is
      // strictly worse than never setting the key. A restart re-reads them, so a
      // corrected key is one restart away rather than lost.
      const settled = classify(err) === 'account';
      this.log.warn(
        settled
          ? `sheet sync: TVDB rejected the credential (${errorMessage(err)}); ${requests.length} season(s) close without a runtime`
          : `sheet sync: TVDB is not answering (${errorMessage(err)}); ${requests.length} season(s) stay open`,
      );
      if (!settled) return requests.length;
      for (const request of requests) catalogue.titles.get(request.id)?.seasonRuntimes.set(request.season, null);
      return 0;
    }

    // Same discipline as the catalogue's stamps. A retryable failure is
    // deliberately left unrecorded, so the next poll asks again and the row
    // stays open in the meantime; anything else — an answer, or an id TVDB says
    // is gone — is recorded, including as null, because a season left unrecorded
    // would be re-requested every poll forever.
    //
    // Reduced here rather than in the source, the way `seasonShapes` is above:
    // the count it checks against is SIMKL's, and one upstream's answer having
    // to agree with another's is a rule about the sheet, not about the call.
    const stalled = new Set(fetched.failed);
    for (const request of requests) {
      const key = runtimeKeyOf(request.tvdbId, request.season);
      if (stalled.has(key)) continue;
      const entry = catalogue.titles.get(request.id);
      const expected = entry?.shapes.get(request.season)?.total ?? 0;
      entry?.seasonRuntimes.set(request.season, averageRuntime(fetched.episodes.get(key), expected));
    }

    this.log.info(`sheet sync: read ${requests.length} season runtime(s) from TVDB`);
    if (fetched.unavailable.length) {
      this.log.warn(`TVDB has no record for ${fetched.unavailable.length} season(s): ${fetched.unavailable.join(', ')}`);
    }
    return fetched.failed.length;
  }

  private async apply(grid: Grid, plan: SheetPlan, lines: string[], retry: boolean, signal: AbortSignal | undefined): Promise<SheetSyncResult> {
    const record = planRecord(plan);
    const name = backupName(Temporal.Now.instant());
    // The snapshot rides at the head of the write batch, so it is taken and the
    // write applied in one atomic request — there is no state in which the
    // sheet changed but nothing recorded what it looked like first.
    const requests = [backupRequest(grid.snapshot.sheetId, name), ...toRequests(plan, grid)];

    let writeError: string | null = null;
    let backupId: number | undefined;
    try {
      const response = await applyRequests(requests, { signal });
      backupId = response.replies?.[0]?.duplicateSheet?.properties?.sheetId;
    } catch (err) {
      // Never retried: batchUpdate is atomic but not idempotent, and a timeout
      // can fire on a request the server already applied. The re-read below is
      // what settles which happened.
      writeError = errorMessage(err);
    }
    // A timeout can hide a batch that landed, so the tab list is the authority
    // on whether a snapshot exists — not the reply we may never have seen. A
    // failure to *list* is not evidence that no snapshot exists, and must not
    // be reported as one: it leaves backupId unset either way, but only one of
    // the two states means "the tab is definitely not there".
    //
    // Caught here rather than allowed to unwind, which would abandon the cycle
    // before the verify read and leave the next poll re-planning against a
    // write nobody ever inspected.
    if (backupId === undefined) backupId = await findBackup(name, this.log, signal);

    // Guarded for the same reason the listing above is, and with more at stake:
    // the batch has already gone out. Unwound, this lands in `run()`'s catch,
    // which reports a run that planned nothing — so a write that did land is
    // recorded as having written nothing, and the snapshot tab is orphaned with
    // no line in the journal pointing at it.
    //
    // There is no safe recovery from here inside this cycle. A rollback needs a
    // read to reason about, and this is the read. So the plan and the lines are
    // reported, the snapshot is deliberately *not* discarded, and the next poll
    // re-reads and re-plans against whatever actually landed.
    let after: SheetSnapshot;
    try {
      after = await readSnapshot({ signal });
    } catch (err) {
      const message = `the sheet could not be read back after the write: ${errorMessage(err)}`;
      this.report(`sheet sync ${message}`, lines, 'error');
      return idle({ status: 'failed', plan: record, lines, error: message, retry: true });
    }
    const verification = verify(grid, after, plan);

    if (verification.ok) {
      if (writeError) this.log.warn(`the sheet write reported "${writeError}" but landed exactly as planned`);
      await sweepBackups(this.log, signal);
      this.report(`sheet sync applied ${plan.edits.length} edits and ${plan.inserts.length} inserts`, lines);
      return idle({ status: 'applied', plan: record, lines, retry });
    }

    // The write errored and none of it is in the sheet: the batch never landed.
    // There is nothing to roll back, and the next poll re-plans from scratch.
    // Asked of the planned writes, not of unplanned changes — a batch that
    // landed and broke a formula moves nothing unplanned, and treating that as
    // "never landed" would skip the rollback *and* discard the only snapshot.
    if (writeError && !verification.landed) {
      this.log.error(`sheet write failed and nothing changed: ${writeError}`);
      // Tidied only when the sheet's own shape agrees nothing happened.
      // `landed` is answered from the planned writes, so a landed insert whose
      // new row a concurrent edit disturbed in this same window reads as false,
      // and the row count is the only independent witness to that. A leftover
      // tab is swept by the next clean run; a discarded snapshot is gone.
      if (after.rows.length === grid.snapshot.rows.length) await discardBackup(backupId, this.log, signal);
      return idle({ status: 'failed', plan: record, lines, error: writeError, retry: true });
    }

    // Stamped here rather than passed in: rollback reports what was planned and
    // never reasons about it, so it has no business taking it as an argument.
    return { ...(await this.rollback(grid, after, verification, lines, backupId, name, retry, signal)), plan: record };
  }

  private async rollback(
    grid: Grid,
    after: SheetSnapshot,
    verification: Verification,
    lines: string[],
    backupId: number | undefined,
    name: string,
    retry: boolean,
    signal: AbortSignal | undefined,
  ): Promise<SheetSyncResult> {
    const detail = verification.problems.join('; ');
    this.log.error(`sheet verify failed, rolling back: ${detail}`);

    try {
      // Before anything is deleted, not after. A delete with no snapshot to
      // restore from is a one-way change made in the exact state where the plan
      // is already known to be wrong about the grid.
      //
      // There is deliberately no cell-level fallback either. Putting cells back
      // individually cannot be made safe alongside the delete that must
      // accompany it, and this — a landed write whose snapshot cannot be found
      // — is the least exercised state in the subsystem. Stopping is better.
      if (backupId === undefined) throw new Error('the write landed but its snapshot tab could not be found');

      let restored = after;

      // Structure first, in its own batch, and before any paste. Deleting the
      // inserted row is what shrinks the grid back — a paste overwrites a
      // range, it does not remove a row, so an extra one would survive
      // underneath. Doing it separately also matters because `deleteDimension`
      // rewrites the relative references in everything it shifts, including
      // anything written earlier in the same batch.
      if (verification.deleteRows.length) {
        await applyRequests(deleteRowRequests(after.sheetId, verification.deleteRows), { signal });
        restored = await readSnapshot({ signal });
      }

      // One server-side paste of the whole tab, at a zero offset. It cannot be
      // off by a row, and its cost does not grow with the number of cells that
      // changed.
      //
      // Wholesale, with a known and accepted cost: a human edit landing inside
      // the seconds-wide window between the batch and the verify read is inside
      // the pasted range, so it is reverted along with ours, and the confirming
      // verify below — which compares against the pre-write grid the restored
      // tab now matches — reports a clean rollback. Closing that window needs a
      // per-cell revert, which is not safe enough to be worth it.
      await applyRequests([restoreRequest(backupId, restored.sheetId, grid.snapshot.rowCount, grid.snapshot.columnCount)], { signal });
      restored = await readSnapshot({ signal });

      const confirmation = verify(grid, restored, { edits: [], inserts: [], skipped: [], notes: [], deferred: 0 });
      if (!confirmation.ok) {
        throw new Error(`${confirmation.problems.length} cells did not go back (${confirmation.problems.slice(0, 5).join('; ')})`);
      }
      await discardBackup(backupId, this.log, signal);
    } catch (err) {
      // The snapshot tab is left in place, and renamed first. It holds the
      // sheet exactly as it was before the write, which makes the manual repair
      // a copy rather than an archaeology exercise in version history — and the
      // rename is what keeps a later clean run's sweep from taking it, since a
      // restart in between forgets that any of this happened.
      const tab = await markForRepair(backupId, name, this.log, signal);
      // Still in the swept namespace, so the safety the rename buys is not
      // there and the user has to be told the deadline they are working to.
      const urgency = isBackupTab(tab)
        ? `It could not be renamed out of the way, so copy it back BEFORE restarting — a later clean run removes it. `
        : '';

      // Nagging on every poll rather than scrolling away once: the repair is
      // manual, and the message carries what is needed to do it.
      this.frozen =
        `FROZEN: the sheet write failed verification and the rollback did not complete (${errorMessage(err)}). ` +
        `No further writes this process. ` +
        `Look for a tab named "${tab}" — it holds the sheet exactly as it was before the write, so copy it back over ` +
        `${grid.snapshot.title}, delete it, then restart. ${urgency}If it is not there, restore from Sheets version history instead. ` +
        `Verify problems: ${detail}. Rows to delete: ${verification.deleteRows.map((r) => r + 1).join(', ') || 'none'}.`;
      this.log.error(this.frozen);
      return idle({ status: 'frozen', lines, error: this.frozen });
    }

    const message = `the write did not verify and was rolled back: ${detail}`;
    this.log.warn(`sheet sync rolled back cleanly`);
    // The rolled-back work is not guaranteed to refuse again — the concurrent
    // edit that triggered this was itself reverted by the restore — so whatever
    // the run wanted another poll for still stands.
    return idle({ status: 'rolled-back', lines, error: message, retry });
  }

  private report(headline: string, lines: string[], level: 'info' | 'error' = 'info'): void {
    this.log[level](headline);
    for (const line of lines) this.log.info(line);
  }
}
