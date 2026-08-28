/**
 * APPLY — the write, and everything that can go wrong after it: verify,
 * rollback, freeze. The one module that turns a checked plan into requests
 * against the real spreadsheet.
 *
 * The protocol, in order:
 *
 *   1. one atomic batch: snapshot the tab, then the write
 *   2. re-read the grid — the only authority on what actually happened
 *   3. verify the read against the plan
 *   4. on a failed verify: delete any inserted row, paste the snapshot back
 *      wholesale, confirm, and discard the snapshot
 *   5. if the rollback itself fails: rename the snapshot for manual repair and
 *      freeze — the caller must make no further writes this process
 *
 * Returns an outcome, never throws: every failure past the first request has
 * already changed, or may have changed, the sheet — so it must be reported
 * with the detail intact rather than unwound into a generic catch.
 */

import { errorMessage } from '../../shared/errors.ts';
import type { Logger } from '../../shared/logger.ts';
import { applyRequests, readSnapshot, type SheetSnapshot } from './spreadsheet.ts';
import type { Grid } from '../2-grid.ts';
import { describePlan, emptyPlan, type SheetPlan } from '../4-plan.ts';
import { backupRequest, deleteRowRequests, restoreRequest, toRequests } from '../6-requests.ts';
import { backupName, discardBackup, findBackup, markForRepair, sweepBackups } from './backups.ts';
import { verify, type Verification } from '../7-verify.ts';

export interface ApplyOutcome {
  status: 'applied' | 'failed' | 'rolled-back' | 'frozen';
  /** The failure, or for `frozen` the full repair message. Null only when applied. */
  error: string | null;
}

export interface ApplyOptions {
  log: Logger;
  signal?: AbortSignal;
}

export const applyPlan = async (grid: Grid, plan: SheetPlan, { log, signal }: ApplyOptions): Promise<ApplyOutcome> => {
  const report = (headline: string, level: 'info' | 'error' = 'info'): void => {
    log[level](headline);
    for (const line of describePlan(plan, grid.columns)) log.info(line);
  };

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
  if (backupId === undefined) backupId = await findBackup(name, log, signal);

  // The batch has already gone out, so this read failing must not unwind: a
  // write that did land would be recorded as having written nothing, and the
  // snapshot tab orphaned with no line in the journal pointing at it.
  //
  // There is no safe recovery from here inside this run. A rollback needs a
  // read to reason about, and this is the read. So the snapshot is
  // deliberately *not* discarded, and the next poll re-reads and re-plans
  // against whatever actually landed.
  let after: SheetSnapshot;
  try {
    after = await readSnapshot({ signal });
  } catch (err) {
    const message = `the sheet could not be read back after the write: ${errorMessage(err)}`;
    report(`sheet sync ${message}`, 'error');
    return { status: 'failed', error: message };
  }
  const verification = verify(grid, after, plan);

  if (verification.ok) {
    if (writeError) log.warn(`the sheet write reported "${writeError}" but landed exactly as planned`);
    await sweepBackups(log, signal);
    report(`sheet sync applied ${plan.edits.length} edits and ${plan.insert ? 1 : 0} inserts`);
    return { status: 'applied', error: null };
  }

  // The write errored and none of it is in the sheet: the batch never landed.
  // There is nothing to roll back, and the next poll re-plans from scratch.
  // Asked of the planned writes, not of unplanned changes — a batch that
  // landed and broke a formula moves nothing unplanned, and treating that as
  // "never landed" would skip the rollback *and* discard the only snapshot.
  if (writeError && !verification.landed) {
    log.error(`sheet write failed and nothing changed: ${writeError}`);
    // Tidied only when the sheet's own shape agrees nothing happened.
    // `landed` is answered from the planned writes, so a landed insert whose
    // new row a concurrent edit disturbed in this same window reads as false,
    // and the row count is the only independent witness to that. A leftover
    // tab is swept by the next clean run; a discarded snapshot is gone.
    if (after.rows.length === grid.snapshot.rows.length) await discardBackup(backupId, log, signal);
    return { status: 'failed', error: writeError };
  }

  return rollback(grid, after, verification, backupId, name, { log, signal });
};

const rollback = async (
  grid: Grid,
  after: SheetSnapshot,
  verification: Verification,
  backupId: number | undefined,
  name: string,
  { log, signal }: ApplyOptions,
): Promise<ApplyOutcome> => {
  const detail = verification.problems.join('; ');
  log.error(`sheet verify failed, rolling back: ${detail}`);

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

    const confirmation = verify(grid, restored, emptyPlan());
    if (!confirmation.ok) {
      throw new Error(`${confirmation.problems.length} cells did not go back (${confirmation.problems.slice(0, 5).join('; ')})`);
    }
    await discardBackup(backupId, log, signal);
  } catch (err) {
    // The snapshot tab is left in place, and renamed first. It holds the
    // sheet exactly as it was before the write, which makes the manual repair
    // a copy rather than an archaeology exercise in version history — and the
    // rename is what keeps a later clean run's sweep from taking it, since a
    // restart in between forgets that any of this happened.
    const tab = await markForRepair(backupId, name, log, signal);
    // Still in the swept namespace, so the safety the rename buys is not
    // there and the user has to be told the deadline they are working to.
    const urgency = tab.renamed ? '' : `It could not be renamed out of the way, so copy it back BEFORE restarting — a later clean run removes it. `;

    // The full repair message, carried as the error so the caller can nag on
    // every poll rather than letting it scroll away once: the repair is
    // manual, and the message carries what is needed to do it.
    const freeze =
      `FROZEN: the sheet write failed verification and the rollback did not complete (${errorMessage(err)}). ` +
      `No further writes this process. ` +
      `Look for a tab named "${tab.title}" — it holds the sheet exactly as it was before the write, so copy it back over ` +
      `${grid.snapshot.title}, delete it, then restart. ${urgency}If it is not there, restore from Sheets version history instead. ` +
      `Verify problems: ${detail}. Rows to delete: ${verification.deleteRows.map((r) => r + 1).join(', ') || 'none'}.`;
    return { status: 'frozen', error: freeze };
  }

  log.warn(`sheet sync rolled back cleanly`);
  return { status: 'rolled-back', error: `the write did not verify and was rolled back: ${detail}` };
};
