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
import { describePlan, planLookups, planSync, type SheetPlan } from './sheet/plan.ts';
import { indexLibrary } from './sheet/progress.ts';
import { assertPlanSafe, toRequests, toRollbackRequests, UnsafePlanError } from './sheet/safety.ts';
import { verify } from './sheet/verify.ts';
import { applyRequests, readSnapshot, type SheetSnapshot } from './sources/sheet.ts';
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

      const catalogue = await fetchCatalogue(planLookups(grid, index), { signal });
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

  private async apply(grid: Grid, plan: SheetPlan, lines: string[], signal: AbortSignal | undefined): Promise<SheetSyncResult> {
    const requests = toRequests(plan, grid);
    let writeError: string | null = null;
    try {
      await applyRequests(requests, { signal });
    } catch (err) {
      // Never retried: batchUpdate is atomic but not idempotent, and a timeout
      // can fire on a request the server already applied. The re-read below is
      // what settles which happened.
      writeError = errorMessage(err);
    }

    const after = await readSnapshot({ signal });
    const verification = verify(grid, after, plan);

    if (verification.ok) {
      if (writeError) this.log.warn(`the sheet write reported "${writeError}" but landed exactly as planned`);
      this.report(`sheet sync applied ${plan.edits.length} edits and ${plan.inserts.length} inserts`, lines);
      return idle({ status: 'applied', edits: plan.edits.length, inserts: plan.inserts.length, lines });
    }

    // Nothing moved at all, and the write errored: the batch never landed.
    // There is nothing to roll back, and the next poll re-plans from scratch.
    if (writeError && !verification.restores.length && !verification.deleteRows.length && after.rows.length === grid.snapshot.rows.length) {
      this.log.error(`sheet write failed and nothing changed: ${writeError}`);
      return idle({ status: 'failed', lines, error: writeError, retry: true });
    }

    return await this.rollback(grid, after, verification, lines, signal);
  }

  private async rollback(
    grid: Grid,
    after: SheetSnapshot,
    verification: ReturnType<typeof verify>,
    lines: string[],
    signal: AbortSignal | undefined,
  ): Promise<SheetSyncResult> {
    const detail = verification.problems.join('; ');
    this.log.error(`sheet verify failed, rolling back: ${detail}`);

    try {
      await applyRequests(toRollbackRequests(after.sheetId, verification.restores, verification.deleteRows), { signal });
      const restored = await readSnapshot({ signal });
      const outstanding = verification.restores.filter((r) => {
        // Post-rollback the inserted rows are gone, so a restore below one has
        // shifted back up by however many were deleted above it.
        const row = r.row - verification.deleteRows.filter((at) => at < r.row).length;
        const now = restored.rows[row]?.[r.column]?.userEnteredValue;
        return JSON.stringify(now ?? null) !== JSON.stringify(r.value ?? null);
      });
      if (outstanding.length || restored.rows.length !== grid.snapshot.rows.length) {
        throw new Error(`${outstanding.length} cells did not go back, and the sheet has ${restored.rows.length} rows against ${grid.snapshot.rows.length} before the write`);
      }
    } catch (err) {
      // Nagging on every poll rather than scrolling away once: the repair is
      // manual, and the message carries what is needed to do it.
      this.frozen =
        `FROZEN: the sheet write failed verification and the rollback did not complete (${errorMessage(err)}). ` +
        `No further writes this process. Restore by hand from Sheets version history, then restart. ` +
        `Verify problems: ${detail}. Cells to restore: ${verification.restores.map((r) => `${r.row + 1}:${r.column}`).join(', ') || 'none'}. ` +
        `Rows to delete: ${verification.deleteRows.map((r) => r + 1).join(', ') || 'none'}.`;
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
