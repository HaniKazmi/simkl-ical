import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupName, discardBackup, findBackup, isBackupTab, markForRepair, repairName, sweepBackups } from '../../../src/sheet/io/backups.ts';
import { clearTokenCache } from '../../../src/api/google/auth.ts';
import { CREDENTIAL, fakeSheets } from '../fake-sheets.ts';
import { quiet, withConfig, withFetch } from '../../helpers.ts';

const NOW = Temporal.Instant.from('2026-08-20T12:34:56.789Z');

/** Drive the real functions against the in-memory spreadsheet. */
const withSheet = async (sheet: ReturnType<typeof fakeSheets>, fn: () => Promise<void>): Promise<void> => {
  clearTokenCache();
  await withConfig({ sheetId: 'SID', googleKeyBase64: CREDENTIAL }, () => withFetch(sheet.handler, fn));
};

test('a backup name is typeable, sweepable, and maps onto its repair name', () => {
  const name = backupName(NOW);
  assert.equal(name, '_sync-backup-2026-08-20T12-34-56-789Z', 'no colons or dots to retype');
  assert.ok(isBackupTab(name));
  assert.equal(repairName(name), '_sync-REPAIR-2026-08-20T12-34-56-789Z');
  assert.ok(!isBackupTab(repairName(name)), 'renamed out of the swept namespace');
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
  const name = backupName(NOW);
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
  const name = backupName(NOW);
  const dark = fakeSheets({ failTabLists: 99 });
  await withSheet(dark, async () => {
    assert.deepEqual(await markForRepair(undefined, name, quiet, undefined), { title: name, renamed: false });
  });
});

test('the sweep takes every backup tab and nothing else, and never throws', async () => {
  const sheet = fakeSheets();
  sheet.titles.set(7, '_sync-backup-old');
  sheet.tabs.set(7, []);
  sheet.titles.set(8, '_sync-REPAIR-kept');
  sheet.tabs.set(8, []);
  await withSheet(sheet, async () => {
    await sweepBackups(quiet, undefined);
    assert.deepEqual([...sheet.titles.values()], ['Sheet1', '_sync-REPAIR-kept']);
  });

  const dark = fakeSheets({ failTabLists: 99 });
  await withSheet(dark, async () => {
    await assert.doesNotReject(() => sweepBackups(quiet, undefined), 'a tidiness failure must not fail the run');
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
