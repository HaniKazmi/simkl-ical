/**
 * The snapshot tab's whole life: its name, how it is found, and the three ways
 * it ends.
 *
 * Every write batch copies the tab first, so something has to own removing
 * the copy — which has nothing to do with the plan, the grid or the
 * verification. The naming policy lives here too: what a tab is called is
 * only meaningful next to the code that finds and sweeps by that name.
 *
 * Nothing here throws. A leftover tab is a tidiness problem the next clean
 * run fixes; failing the run over one would make it a real problem.
 */

import { backoffMs, sleep } from '../../api/http.ts';
import { isoOf } from '../../shared/dates.ts';
import { errorMessage } from '../../shared/errors.ts';
import type { Logger } from '../../shared/logger.ts';
import { applyRequests, listSheets } from './spreadsheet.ts';
import { deleteSheetRequest, renameSheetRequest } from '../6-requests.ts';

/**
 * The snapshot namespace, and the one the freeze moves out of it.
 *
 * A frozen run's snapshot must not be swept: a restart clears `frozen`, and
 * the next clean write would delete the one tab the user was told to repair
 * from.
 */
const BACKUP_PREFIX = '_sync-backup-';
const REPAIR_PREFIX = '_sync-REPAIR-';

/**
 * The namespace one tab's snapshots live in: the prefix plus the source tab's
 * `sheetId`.
 *
 * The id is in the name because the name is the only state a snapshot has,
 * and which tab it copies decides who may remove it. A write that verified
 * clean says the sheet is known good — but only the tab it verified. The films
 * tab and the show grid are written by different runs of one poll and are
 * failed, kept and swept independently; a sweep that took every snapshot
 * would let a films write delete the pre-write copy of `Sheet1` that a failed
 * show write left for the operator, without `Sheet1` having been re-read. A
 * latch in the process cannot hold that rule either: it is reset by a
 * restart, and the snapshot is not.
 */
const namespaceOf = (sheetId: number): string => `${BACKUP_PREFIX}${sheetId}-`;

/** Whether a title is a snapshot of the given tab. */
export const isBackupOf = (title: string, sheetId: number): boolean => title.startsWith(namespaceOf(sheetId));

/**
 * Colons and dots are legal in a tab name but awkward to type back.
 *
 * Pinned to milliseconds because a user reads and retypes the shape:
 * `Instant.toString()` omits a zero fractional part, which would give some
 * runs a shorter name than others.
 */
export const backupName = (sheetId: number, now: Temporal.Instant): string =>
  `${namespaceOf(sheetId)}${isoOf(now).replaceAll(':', '-').replace('.', '-')}`;

export const repairName = (backup: string): string => backup.replace(BACKUP_PREFIX, REPAIR_PREFIX);

/**
 * The tab's id, when the caller lost it.
 *
 * "No id" is not "no tab": the reply carrying it can be lost to a timeout on
 * a batch that landed. Undefined means only that this lookup found nothing,
 * so every caller treats it as "cannot act", not "nothing to act on".
 */
const findByName = async (name: string, log: Logger, signal: AbortSignal | undefined): Promise<number | undefined> => {
  try {
    return (await listSheets({ signal })).find((s) => s.title === name)?.sheetId;
  } catch (err) {
    log.warn(`could not list the tabs to find the snapshot: ${errorMessage(err)}`);
    return undefined;
  }
};

export const findBackup = findByName;

/** Remove this run's snapshot, once the sheet is known not to need it. */
export const discardBackup = async (backupId: number | undefined, log: Logger, signal: AbortSignal | undefined): Promise<void> => {
  if (backupId === undefined) return;
  try {
    await applyRequests([deleteSheetRequest(backupId)], { signal });
  } catch (err) {
    log.warn(`could not remove the backup tab (harmless, delete it by hand): ${errorMessage(err)}`);
  }
};

/**
 * Drop every snapshot of this tab, not just this run's.
 *
 * Only reached after a write to it verified clean — the one moment the tab is
 * known good, so an older snapshot describes a state nobody chose to restore.
 * Without this they accumulate: every write batch makes one, and any failure
 * between write and verify read leaves it behind. Each is a full copy of a
 * 1644-row tab, against a 10M-cell ceiling for the whole spreadsheet.
 *
 * Another tab's snapshots are left alone: nothing about this write says that
 * tab is good, and a failed write there kept its copy on purpose.
 */
export const sweepBackups = async (sheetId: number, log: Logger, signal: AbortSignal | undefined): Promise<void> => {
  try {
    const stale = (await listSheets({ signal })).filter((s) => isBackupOf(s.title, sheetId));
    if (!stale.length) return;
    await applyRequests(
      stale.map((s) => deleteSheetRequest(s.sheetId)),
      { signal },
    );
    if (stale.length > 1) log.warn(`removed ${stale.length} snapshot tabs, ${stale.length - 1} left over by an earlier run`);
  } catch (err) {
    log.warn(`could not remove the backup tabs (harmless, delete them by hand): ${errorMessage(err)}`);
  }
};

/**
 * Move a frozen run's snapshot out of the swept namespace and report its
 * final name. `renamed: false` means it is still under the swept name, so the
 * caller's freeze message has to tell the user to hurry — a later clean run's
 * sweep will take it.
 *
 * The id is looked up again when the caller has none: leaving the tab under
 * the swept name hands the user a repair target the next clean run deletes.
 *
 * Worth retrying, which no other write here gets: renaming to a fixed title
 * is idempotent — unlike `insertDimension`, a repeat is the same result — and
 * the tab's survival here is the difference between a copy-paste repair and
 * version-history archaeology.
 */
export const markForRepair = async (
  backupId: number | undefined,
  name: string,
  log: Logger,
  signal: AbortSignal | undefined,
): Promise<{ title: string; renamed: boolean }> => {
  const id = backupId ?? (await findByName(name, log, signal));
  if (id === undefined) return { title: name, renamed: false };

  const title = repairName(name);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await applyRequests([renameSheetRequest(id, title)], { signal });
      return { title, renamed: true };
    } catch (err) {
      if (attempt < 2) await sleep(backoffMs(attempt));
      else log.warn(`could not rename the snapshot tab to "${title}": ${errorMessage(err)}`);
    }
  }
  return { title: name, renamed: false };
};
