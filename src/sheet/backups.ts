/**
 * The snapshot tab's whole life: what it is called, how it is found, and the
 * three ways it ends.
 *
 * Every write batch copies the tab first, so something has to own removing the
 * copy again — and that has nothing to do with the plan, the grid or the
 * verification, which is what the write protocol beside this is about. The
 * naming policy lives here too rather than with the request builders: what a
 * tab is called is only meaningful next to the code that finds and sweeps by
 * that name.
 *
 * Nothing here throws. A leftover tab is a tidiness problem the next clean run
 * fixes; failing the run over one would turn it into a real one.
 */

import { backoffMs, sleep } from '../api/http.ts';
import { isoOf } from '../shared/dates.ts';
import { errorMessage } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import { applyRequests, listSheets } from './io/spreadsheet.ts';
import { deleteSheetRequest, renameSheetRequest } from './5-requests.ts';

/**
 * The snapshot namespace, and the one the freeze moves out of it.
 *
 * A frozen run's snapshot must not be swept: a restart clears `frozen`, and the
 * next clean write would otherwise delete the one tab the user was told to
 * repair from.
 */
export const BACKUP_PREFIX = '_sync-backup-';
export const REPAIR_PREFIX = '_sync-REPAIR-';

export const isBackupTab = (title: string): boolean => title.startsWith(BACKUP_PREFIX);

/**
 * Colons and dots are legal in a tab name but awkward to type back.
 *
 * Pinned to milliseconds because the shape is what a user reads and retypes:
 * `Instant.toString()` omits a zero fractional part, which would silently give
 * some runs a shorter name than others.
 */
export const backupName = (now: Temporal.Instant): string =>
  `${BACKUP_PREFIX}${isoOf(now).replaceAll(':', '-').replace('.', '-')}`;

export const repairName = (backup: string): string => backup.replace(BACKUP_PREFIX, REPAIR_PREFIX);

/**
 * The tab's id, when the caller lost it.
 *
 * "No id" is not "no tab": the reply carrying it can be lost to a timeout on a
 * batch that landed. Undefined here means only that this lookup did not find
 * one, which is why every caller treats it as "cannot act" rather than "nothing
 * to act on".
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
 * Drop every snapshot tab, not just this run's.
 *
 * Only reached after a write verified clean, which is the one moment the sheet
 * is known good — so an older snapshot describes a state nobody chose to
 * restore. Without this they only accumulate: the write batch always makes one,
 * and any failure between the write and the verify read leaves it behind with
 * nothing to remove it. Each is a full copy of a 1644-row tab, against a
 * 10M-cell ceiling for the whole spreadsheet.
 */
export const sweepBackups = async (log: Logger, signal: AbortSignal | undefined): Promise<void> => {
  try {
    const stale = (await listSheets({ signal })).filter((s) => isBackupTab(s.title));
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
 * Move a frozen run's snapshot out of the swept namespace, and report what it
 * ended up called — the original name if it could not be moved.
 *
 * The id is looked up again when the caller has none, because leaving the tab
 * under the swept name hands the user a repair target the next clean run
 * deletes.
 *
 * Worth retrying, which no other write here gets: renaming a tab to a fixed
 * title is idempotent — unlike `insertDimension`, a repeat is the same result —
 * and this is the one moment the tab's survival is the difference between a
 * copy-paste repair and version-history archaeology.
 */
export const markForRepair = async (
  backupId: number | undefined,
  name: string,
  log: Logger,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const id = backupId ?? (await findByName(name, log, signal));
  if (id === undefined) return name;

  const title = repairName(name);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await applyRequests([renameSheetRequest(id, title)], { signal });
      return title;
    } catch (err) {
      if (attempt < 2) await sleep(backoffMs(attempt));
      else log.warn(`could not rename the snapshot tab to "${title}": ${errorMessage(err)}`);
    }
  }
  return name;
};
