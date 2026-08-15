/**
 * The write protocol. The only thing in the project that writes to the sheet.
 *
 * READ → PLAN → GUARD → FRESH → APPLY → VERIFY → ROLLBACK → FROZEN, in that
 * order, with the whole cycle inside one poll so that what was planned and what
 * was written describe the same grid.
 *
 * `run()` never rejects: it is called from the refresh path, where nothing may
 * be fatal. Failures land in the returned result and, through it, in
 * `errors.sheet` and `/healthz`.
 */

import { config } from './config.ts';
import { errorMessage } from './errors.ts';
import { parseGrid, type Grid } from './sheet/grid.ts';
import { describePlan, planLookups, planSync, type CatalogueStamp, type CatalogueView, type SheetPlan, type TitleCatalogue } from './sheet/plan.ts';
import { indexLibrary, seasonShapes, type TitleProgress } from './sheet/progress.ts';
import { assertPlanSafe, backupName, backupRequest, deleteRowRequests, deleteSheetRequest, isBackupTab, restoreRequest, toRequests, UnsafePlanError } from './sheet/safety.ts';
import { verify, type Verification } from './sheet/verify.ts';
import { applyRequests, listSheets, readSnapshot, type SheetSnapshot } from './sources/sheet.ts';
import { fetchCatalogue } from './sources/shows.ts';
import type { Logger } from './refresh.ts';
import type { Library } from './simkl/types.ts';

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
 * prompt a re-read. Daily, for the reason `movieRefreshMs` is daily: a network
 * renewing a show produces nothing in your library to gate on.
 */
const CATALOGUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type SheetSyncStatus = 'idle' | 'reported' | 'applied' | 'refused' | 'failed' | 'rolled-back' | 'frozen';

export interface SheetSyncResult {
  status: SheetSyncStatus;
  edits: number;
  inserts: number;
  /** The report: every proposed edit, skip and note, one per line. */
  lines: string[];
  /** For `errors.sheet`; null when the run was clean. */
  error: string | null;
  /** Whether the next poll should try again even if no list moved. */
  retry: boolean;
}

const idle = (overrides: Partial<SheetSyncResult> = {}): SheetSyncResult => ({
  status: 'idle',
  edits: 0,
  inserts: 0,
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

  async run(library: Library | null, { signal }: { signal?: AbortSignal } = {}): Promise<SheetSyncResult> {
    if (config.sheetSyncMode === 'off') return idle();
    if (this.frozen) {
      this.log.error(this.frozen);
      return this.record(idle({ status: 'frozen', error: this.frozen }));
    }

    try {
      return this.record(await this.cycle(library, signal));
    } catch (err) {
      const message = errorMessage(err);
      this.log.error(`sheet sync failed: ${message}`);
      return this.record(idle({ status: 'failed', error: message, retry: true }));
    }
  }

  private record(result: SheetSyncResult): SheetSyncResult {
    this.lastRunAt = new Date().toISOString();
    this.lastStatus = result.status;
    return result;
  }

  private async cycle(library: Library | null, signal: AbortSignal | undefined): Promise<SheetSyncResult> {
    const index = indexLibrary(library);
    if (index.size === 0) return idle();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const snapshot = await readSnapshot({ signal });
      const grid = parseGrid(snapshot);

      const catalogue = await this.catalogueFor(grid, index, signal);
      const plan = planSync(grid, index, catalogue);
      const lines = describePlan(plan, grid.columns);
      // An incomplete catalogue means some season's shape is unknown, and an
      // unknown shape is exactly what makes an end date premature.
      const retry = catalogue.failed.length > 0;
      if (catalogue.failed.length) {
        this.log.warn(`${catalogue.failed.length} SIMKL lookups failed; the sheet sync will retry on the next poll`);
      }

      if (!plan.edits.length && !plan.inserts.length) {
        if (lines.length) this.report('sheet sync: nothing to write', lines);
        return idle({ lines, retry });
      }

      try {
        assertPlanSafe(plan, grid);
      } catch (err) {
        // A refused plan is not retried: the same inputs would refuse again.
        // The report names every proposed edit so it can be applied by hand or
        // the cap raised for one run.
        if (!(err instanceof UnsafePlanError)) throw err;
        this.report(`sheet sync REFUSED the plan: ${err.message}`, lines, 'error');
        return idle({ status: 'refused', edits: plan.edits.length, inserts: plan.inserts.length, lines, error: err.message });
      }

      if (config.sheetSyncMode === 'report') {
        this.report(`sheet sync (report mode): ${plan.edits.length} edits, ${plan.inserts.length} inserts — nothing written`, lines);
        return idle({ status: 'reported', edits: plan.edits.length, inserts: plan.inserts.length, lines, retry });
      }

      // FRESH. Back to the read, not on to the write: re-planning is the point.
      if (Date.now() - snapshot.readAt > FRESH_MS) {
        this.log.warn(`the sheet snapshot aged past ${FRESH_MS / 1000}s while planning; re-reading (attempt ${attempt})`);
        continue;
      }

      return await this.apply(grid, plan, lines, signal);
    }

    const message = `could not plan against a fresh snapshot in ${MAX_ATTEMPTS} attempts`;
    this.log.warn(`sheet sync: ${message}`);
    return idle({ status: 'failed', error: message, retry: true });
  }

  /**
   * Re-read the catalogue of every title that moved, and fold the results into
   * what is already held.
   *
   * Stamping happens here rather than at the end of the run, so the FRESH
   * retry loop's second pass asks for nothing: it has already been read.
   */
  private async catalogueFor(grid: Grid, index: Map<number, TitleProgress>, signal: AbortSignal | undefined): Promise<CatalogueView> {
    const requests = planLookups(grid, index, { stamps: this.stamps, maxAgeMs: CATALOGUE_MAX_AGE_MS });
    const fetched = await fetchCatalogue(requests, { signal });

    // Derive on the way in: the shapes are computed once per title here rather
    // than once per season row inside the planner.
    const entry = (id: number): TitleCatalogue => {
      const existing = this.retained.get(id) ?? { shapes: new Map() };
      this.retained.set(id, existing);
      return existing;
    };
    for (const [id, episodes] of fetched.episodes) entry(id).shapes = seasonShapes(episodes);
    for (const [id, detail] of fetched.details) Object.assign(entry(id), { status: detail.status, runtime: detail.runtime });

    // A retryable failure is deliberately not stamped, so the next poll asks
    // again — the same reason the film path withholds its list signature. A
    // `gone` id is stamped: retrying never starts working, and leaving it
    // unstamped would re-request it on every poll forever.
    const stalled = new Set(fetched.failed);
    const at = Date.now();
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

  private async apply(grid: Grid, plan: SheetPlan, lines: string[], signal: AbortSignal | undefined): Promise<SheetSyncResult> {
    const name = backupName(new Date());
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
    if (backupId === undefined) {
      backupId = (await listSheets({ signal })).find((s) => s.title === name)?.sheetId;
    }

    const after = await readSnapshot({ signal });
    const verification = verify(grid, after, plan);

    if (verification.ok) {
      if (writeError) this.log.warn(`the sheet write reported "${writeError}" but landed exactly as planned`);
      await this.sweepBackups(signal);
      this.report(`sheet sync applied ${plan.edits.length} edits and ${plan.inserts.length} inserts`, lines);
      return idle({ status: 'applied', edits: plan.edits.length, inserts: plan.inserts.length, lines });
    }

    // The write errored and none of it is in the sheet: the batch never landed.
    // There is nothing to roll back, and the next poll re-plans from scratch.
    // Asked of the planned writes, not of unplanned changes — a batch that
    // landed and broke a formula moves nothing unplanned, and treating that as
    // "never landed" would skip the rollback *and* discard the only snapshot.
    if (writeError && !verification.landed) {
      this.log.error(`sheet write failed and nothing changed: ${writeError}`);
      await this.discardBackup(backupId, signal);
      return idle({ status: 'failed', lines, error: writeError, retry: true });
    }

    return await this.rollback(grid, after, verification, lines, backupId, name, signal);
  }

  /** Best effort: a leftover snapshot tab is untidy, never dangerous. */
  private async discardBackup(backupId: number | undefined, signal: AbortSignal | undefined): Promise<void> {
    if (backupId === undefined) return;
    try {
      await applyRequests([deleteSheetRequest(backupId)], { signal });
    } catch (err) {
      this.log.warn(`could not remove the backup tab (harmless, delete it by hand): ${errorMessage(err)}`);
    }
  }

  /**
   * Drop every snapshot tab, not just this run's.
   *
   * Only reached after a write verified clean, which is the one moment the
   * sheet is known good — so an older snapshot describes a state nobody chose
   * to restore. Without this they only accumulate: the write batch always makes
   * one, and any failure between the write and the verify read leaves it behind
   * with nothing to remove it. Each is a full copy of a 1644-row tab, against a
   * 10M-cell ceiling for the whole spreadsheet.
   */
  private async sweepBackups(signal: AbortSignal | undefined): Promise<void> {
    try {
      const stale = (await listSheets({ signal })).filter((s) => isBackupTab(s.title));
      if (!stale.length) return;
      await applyRequests(stale.map((s) => deleteSheetRequest(s.sheetId)), { signal });
      if (stale.length > 1) this.log.warn(`removed ${stale.length} snapshot tabs, ${stale.length - 1} left over by an earlier run`);
    } catch (err) {
      this.log.warn(`could not remove the backup tabs (harmless, delete them by hand): ${errorMessage(err)}`);
    }
  }

  private async rollback(
    grid: Grid,
    after: SheetSnapshot,
    verification: Verification,
    lines: string[],
    backupId: number | undefined,
    name: string,
    signal: AbortSignal | undefined,
  ): Promise<SheetSyncResult> {
    const detail = verification.problems.join('; ');
    this.log.error(`sheet verify failed, rolling back: ${detail}`);

    try {
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
      // changed. There is deliberately no cell-level fallback: putting cells
      // back individually is the mechanism that produced a one-row misalignment
      // once already, and running it in the one state nobody has exercised —
      // a landed write whose snapshot cannot be found — is worse than stopping.
      if (backupId === undefined) throw new Error('the write landed but its snapshot tab could not be found');
      await applyRequests([restoreRequest(backupId, restored.sheetId, grid.snapshot.rowCount, grid.snapshot.columnCount)], { signal });
      restored = await readSnapshot({ signal });

      const confirmation = verify(grid, restored, { edits: [], inserts: [], skipped: [], notes: [] });
      if (!confirmation.ok) {
        throw new Error(`${confirmation.problems.length} cells did not go back (${confirmation.problems.slice(0, 5).join('; ')})`);
      }
      await this.discardBackup(backupId, signal);
    } catch (err) {
      // Nagging on every poll rather than scrolling away once: the repair is
      // manual, and the message carries what is needed to do it.
      // The snapshot tab is deliberately left in place. It holds the sheet
      // exactly as it was before the write, which makes the manual repair a
      // copy rather than an archaeology exercise in version history.
      this.frozen =
        `FROZEN: the sheet write failed verification and the rollback did not complete (${errorMessage(err)}). ` +
        `No further writes this process. ` +
        `Look for a tab named "${name}" — it holds the sheet exactly as it was before the write, so copy it back over ` +
        `${grid.snapshot.title}, delete it, then restart. If it is not there, restore from Sheets version history instead. ` +
        `Verify problems: ${detail}. Rows to delete: ${verification.deleteRows.map((r) => r + 1).join(', ') || 'none'}.`;
      this.log.error(this.frozen);
      return idle({ status: 'frozen', lines, error: this.frozen });
    }

    const message = `the write did not verify and was rolled back: ${detail}`;
    this.log.warn(`sheet sync rolled back cleanly`);
    return idle({ status: 'rolled-back', lines, error: message, retry: false });
  }

  private report(headline: string, lines: string[], level: 'info' | 'error' = 'info'): void {
    this.log[level](headline);
    for (const line of lines) this.log.info(line);
  }
}
