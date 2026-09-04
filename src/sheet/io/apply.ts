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
 * changed, or may have changed, the sheet, so it must be reported with detail
 * intact rather than unwound into a generic catch.
 */

import { errorMessage } from '../../shared/errors.ts';
import type { Logger } from '../../shared/logger.ts';
import { applyRequests, readSnapshot, type SheetSnapshot } from './spreadsheet.ts';
import type { SheetRequest } from '../../api/google/types.ts';
import { backupRequest, deleteRowRequests, restoreRequest } from '../6-requests.ts';
import { backupName, discardBackup, findBackup, markForRepair, sweepBackups } from './backups.ts';
import type { Verification } from '../7-verify.ts';

export interface ApplyOutcome {
  status: 'applied' | 'failed' | 'rolled-back' | 'frozen';
  /** The failure, or for `frozen` the full repair message. Null only when applied. */
  error: string | null;
}

export interface ApplyOptions {
  log: Logger;
  signal?: AbortSignal;
}

/**
 * Everything this protocol needs to know about a plan, and nothing about which
 * pipeline built it. The two tabs have different grids, different field
 * vocabularies and different structural checks, but exactly one write-and-
 * recover protocol — and a second copy of it is a second place the rollback
 * can be wrong.
 */
export interface ApplySpec {
  /** The tab as it was when the plan was built. Its title is what gets re-read. */
  snapshot: SheetSnapshot;
  /**
   * Whether a clean write may tidy away every snapshot tab it finds.
   *
   * False once another tab has been written this poll: a failed write leaves
   * its snapshot in place on the reasoning that "a leftover tab is swept by the
   * next clean run", which held while one poll wrote one tab. Sweeping here
   * would take the operator's copy of the other tab's pre-write grid before
   * they had seen the error that produced it.
   */
  maySweep: boolean;
  /** The plan's writes, already ordered. The backup is prepended here. */
  requests: SheetRequest[];
  /** Log lines describing the plan, rendered only when something is reported. */
  describe: () => string[];
  /** One line naming what was written, for the applied log. */
  summary: string;
  /** Did the write do exactly what was planned. */
  verify: (after: SheetSnapshot) => Verification;
  /**
   * Did the tab go back to exactly how it was — the same check against a plan
   * that writes nothing. Separate because only the pipeline knows what an
   * empty plan of its own shape is.
   */
  verifyRestored: (after: SheetSnapshot) => Verification;
}

export const applyPlan = async (spec: ApplySpec, { log, signal }: ApplyOptions): Promise<ApplyOutcome> => {
  const { snapshot } = spec;
  const report = (headline: string, level: 'info' | 'error' = 'info'): void => {
    log[level](headline);
    for (const line of spec.describe()) log.info(line);
  };

  const name = backupName(Temporal.Now.instant());
  // The snapshot rides at the head of the write batch — taken and applied in
  // one atomic request, so there is no state where the sheet changed but
  // nothing recorded what it looked like first.
  const requests = [backupRequest(snapshot.sheetId, name), ...spec.requests];

  let writeError: string | null = null;
  let backupId: number | undefined;
  try {
    const response = await applyRequests(requests, { signal });
    backupId = response.replies?.[0]?.duplicateSheet?.properties?.sheetId;
  } catch (err) {
    // Never retried: batchUpdate is atomic but not idempotent, and a timeout
    // can fire on a request the server already applied. The re-read below
    // settles which happened.
    writeError = errorMessage(err);
  }
  // A timeout can hide a batch that landed, so the tab list — not the reply
  // we may never have seen — is the authority on whether a snapshot exists.
  // A failure to *list* is not evidence that none exists: it leaves backupId
  // unset either way, but only one state means "the tab is definitely not
  // there".
  if (backupId === undefined) backupId = await findBackup(name, log, signal);

  // The batch is already out, so this read failing must not unwind: a write
  // that landed would be recorded as having written nothing, the snapshot tab
  // orphaned with no journal line pointing at it.
  //
  // No safe recovery exists inside this run — a rollback needs a read to
  // reason about, and this is the read. So the snapshot is *not* discarded,
  // and the next poll re-reads and re-plans against whatever landed.
  let after: SheetSnapshot;
  try {
    after = await readSnapshot(snapshot.title, { signal });
  } catch (err) {
    const message = `the sheet could not be read back after the write: ${errorMessage(err)}`;
    report(`sheet sync ${message}`, 'error');
    return { status: 'failed', error: message };
  }
  const verification = spec.verify(after);

  if (verification.ok) {
    if (writeError) log.warn(`the sheet write reported "${writeError}" but landed exactly as planned`);
    // Sweeping takes every snapshot tab in the spreadsheet, including one the
    // other half left standing on purpose. Barred from that, this run still
    // has to remove its *own*, or a poll that cannot sweep leaves a full-tab
    // copy behind every time it writes.
    if (spec.maySweep) await sweepBackups(log, signal);
    else await discardBackup(backupId, log, signal);
    report(`sheet sync applied ${spec.summary}`);
    return { status: 'applied', error: null };
  }

  // The write errored and none of it is in the sheet: the batch never landed,
  // nothing to roll back, and the next poll re-plans from scratch. Asked of
  // the planned writes, not of unplanned changes — a batch that landed and
  // broke a formula moves nothing unplanned, and treating that as "never
  // landed" would skip the rollback *and* discard the only snapshot.
  if (writeError && !verification.landed) {
    log.error(`sheet write failed and nothing changed: ${writeError}`);
    // Tidied only when the sheet's own shape agrees nothing happened.
    // `landed` is answered from the planned writes, so a landed insert whose
    // new row a concurrent edit disturbed reads as false; the row count is
    // the only independent witness. A leftover tab is swept by the next clean
    // run; a discarded snapshot is gone.
    if (after.rows.length === snapshot.rows.length) await discardBackup(backupId, log, signal);
    return { status: 'failed', error: writeError };
  }

  return rollback(spec, after, verification, backupId, name, { log, signal });
};

const rollback = async (
  spec: ApplySpec,
  after: SheetSnapshot,
  verification: Verification,
  backupId: number | undefined,
  name: string,
  { log, signal }: ApplyOptions,
): Promise<ApplyOutcome> => {
  const { snapshot } = spec;
  const detail = verification.problems.join('; ');
  log.error(`sheet verify failed, rolling back: ${detail}`);

  try {
    // Checked before anything is deleted. A delete with no snapshot to
    // restore from is a one-way change made exactly when the plan is known to
    // be wrong about the grid.
    //
    // No cell-level fallback either: putting cells back individually cannot
    // be made safe alongside the delete that must accompany it, and a landed
    // write whose snapshot cannot be found is the least exercised state in
    // the subsystem. Stopping is better.
    if (backupId === undefined) throw new Error('the write landed but its snapshot tab could not be found');

    let restored = after;

    // Structure first, in its own batch, before any paste. Deleting the
    // inserted row is what shrinks the grid back — a paste overwrites a range
    // but removes no row, so an extra one would survive underneath. Separate
    // also because `deleteDimension` rewrites the relative references in
    // everything it shifts, including anything written earlier in the same
    // batch.
    if (verification.deleteRows.length) {
      await applyRequests(deleteRowRequests(after.sheetId, verification.deleteRows), { signal });
      restored = await readSnapshot(snapshot.title, { signal });
    }

    // One server-side paste of the whole tab at zero offset: it cannot be off
    // by a row, and its cost does not grow with the cells changed.
    //
    // Wholesale, with an accepted cost: a human edit landing in the
    // seconds-wide window between batch and verify read is inside the pasted
    // range and is reverted along with ours — the confirming verify below
    // compares against the pre-write grid the restored tab now matches, so it
    // reports a clean rollback. Closing that window needs a per-cell revert,
    // which is not safe enough to be worth it.
    await applyRequests([restoreRequest(backupId, restored.sheetId, snapshot.rowCount, snapshot.columnCount)], { signal });
    restored = await readSnapshot(snapshot.title, { signal });

    const confirmation = spec.verifyRestored(restored);
    if (!confirmation.ok) {
      throw new Error(`${confirmation.problems.length} cells did not go back (${confirmation.problems.slice(0, 5).join('; ')})`);
    }
    await discardBackup(backupId, log, signal);
  } catch (err) {
    // The snapshot tab is left in place, renamed first. It holds the sheet
    // exactly as it was before the write, making the repair a copy rather
    // than version-history archaeology — and the rename keeps a later clean
    // run's sweep from taking it, since a restart forgets any of this
    // happened.
    const tab = await markForRepair(backupId, name, log, signal);
    // Still in the swept namespace: the rename's safety is absent, so the
    // user has to be told the deadline they are working to.
    const urgency = tab.renamed ? '' : `It could not be renamed out of the way, so copy it back BEFORE restarting — a later clean run removes it. `;

    // Carried as the error so the caller can nag on every poll rather than
    // letting it scroll away once: the repair is manual, and the message
    // carries what is needed to do it.
    const freeze =
      `FROZEN: the sheet write failed verification and the rollback did not complete (${errorMessage(err)}). ` +
      `No further writes this process. ` +
      `Look for a tab named "${tab.title}" — it holds the sheet exactly as it was before the write, so copy it back over ` +
      `${snapshot.title}, delete it, then restart. ${urgency}If it is not there, restore from Sheets version history instead. ` +
      `Verify problems: ${detail}. Rows to delete: ${verification.deleteRows.map((r) => r + 1).join(', ') || 'none'}.`;
    return { status: 'frozen', error: freeze };
  }

  log.warn(`sheet sync rolled back cleanly`);
  return { status: 'rolled-back', error: `the write did not verify and was rolled back: ${detail}` };
};
