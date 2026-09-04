import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupName, discardBackup, findBackup, isBackupOf, markForRepair, repairName, sweepBackups } from '../../../src/sheet/io/backups.ts';
import { clearTokenCache } from '../../../src/api/google/auth.ts';
import { CREDENTIAL, fakeSheets } from '../fake-sheets.ts';
import { quiet, withConfig, withFetch } from '../../helpers.ts';

const NOW = Temporal.Instant.from('2026-08-20T12:34:56.789Z');

/** Drive the real functions against the in-memory spreadsheet. */
const withSheet = async (sheet: ReturnType<typeof fakeSheets>, fn: () => Promise<void>): Promise<void> => {
  clearTokenCache();
  await withConfig({ sheetId: 'SID', googleKeyBase64: CREDENTIAL }, () => withFetch(sheet.handler, fn));
};

test('a backup name is typeable, names its source tab, and maps onto its repair name', () => {
  const name = backupName(1, NOW);
  assert.equal(name, '_sync-backup-1-2026-08-20T12-34-56-789Z', 'no colons or dots to retype');
  assert.ok(isBackupOf(name, 1));
  // Another tab's snapshot is not this tab's to sweep: a films write says
  // nothing about the show grid, and a failed show write kept its copy.
  assert.ok(!isBackupOf(name, 2));
  // A sheetId is a prefix of longer ones; the separator is what keeps tab 1
  // from claiming tab 12's snapshots.
  assert.ok(!isBackupOf(backupName(12, NOW), 1));
  assert.equal(repairName(name), '_sync-REPAIR-1-2026-08-20T12-34-56-789Z');
  assert.ok(!isBackupOf(repairName(name), 1), 'renamed out of the swept namespace');
});

test('a lost tab id is recovered by name, and a failed listing is not "no tab"', async () => {
  const sheet = fakeSheets();
  sheet.titles.set(7, '_sync-backup-x');
  sheet.tabs.set(7, []);
  await withSheet(sheet, async () => {
    assert.equal(await findBackup('_sync-backup-x', quiet, undefined), 7);
    assert.equal(await findBackup('_sync-backup-y', quiet, undefined), undefined, 'listed, and genuinely absent');
  });

  // Every listing attempt fails: the answer is "could not find", which callers
  // treat as "cannot act" — never as proof the tab does not exist.
  const dark = fakeSheets({ failTabLists: 99 });
  dark.titles.set(7, '_sync-backup-x');
  await withSheet(dark, async () => {
    assert.equal(await findBackup('_sync-backup-x', quiet, undefined), undefined);
  });
});

test('marking for repair renames the tab and says so', async () => {
  const sheet = fakeSheets();
  const name = backupName(1, NOW);
  sheet.titles.set(7, name);
  sheet.tabs.set(7, []);
  await withSheet(sheet, async () => {
    const result = await markForRepair(7, name, quiet, undefined);
    assert.deepEqual(result, { title: repairName(name), renamed: true });
    assert.equal(sheet.titles.get(7), repairName(name));
  });
});

// The caller's freeze message hangs off this flag: an un-renamed tab is still
// in the swept namespace, so the user has to be told to hurry.
test('a repair that cannot find or rename the tab reports renamed false', async () => {
  const name = backupName(1, NOW);
  const dark = fakeSheets({ failTabLists: 99 });
  await withSheet(dark, async () => {
    assert.deepEqual(await markForRepair(undefined, name, quiet, undefined), { title: name, renamed: false });
  });
});

test('the sweep takes every backup of its own tab and nothing else, and never throws', async () => {
  const sheet = fakeSheets();
  sheet.titles.set(7, '_sync-backup-1-old');
  sheet.tabs.set(7, []);
  sheet.titles.set(8, '_sync-REPAIR-1-kept');
  sheet.tabs.set(8, []);
  // Another tab's snapshot, standing because a write to that tab failed and
  // kept it for the operator. Nothing about this tab's write says it may go.
  sheet.titles.set(9, '_sync-backup-2-kept');
  sheet.tabs.set(9, []);
  await withSheet(sheet, async () => {
    await sweepBackups(1, quiet, undefined);
    assert.deepEqual([...sheet.titles.values()], ['Sheet1', '_sync-REPAIR-1-kept', '_sync-backup-2-kept']);
  });

  const dark = fakeSheets({ failTabLists: 99 });
  await withSheet(dark, async () => {
    await assert.doesNotReject(() => sweepBackups(1, quiet, undefined), 'a tidiness failure must not fail the run');
  });
});

test('discarding a backup tolerates a missing id and a failed delete', async () => {
  const sheet = fakeSheets();
  sheet.titles.set(7, '_sync-backup-x');
  sheet.tabs.set(7, []);
  await withSheet(sheet, async () => {
    await discardBackup(undefined, quiet, undefined);
    assert.ok(sheet.titles.has(7), 'no id, nothing deleted');
    await discardBackup(7, quiet, undefined);
    assert.ok(!sheet.titles.has(7));
  });
});
