import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseline, baselineSummary, clearBaseline, loadBaseline, saveBaseline } from '../../../src/sheet/io/baseline.ts';
import type { Baseline } from '../../../src/sheet/values.ts';
import { quiet, withTempDataDir } from '../../helpers.ts';

const FILE = 'sheet-baseline.json';

const one = (entry: Record<string, string>, key = '300:1'): Baseline => new Map([[key, entry]]);

/** A temp dir and an empty record: the record is a module-level singleton. */
const fresh = (fn: (dir: string) => Promise<void>): Promise<void> =>
  withTempDataDir(async (dir) => {
    clearBaseline();
    try {
      await fn(dir);
    } finally {
      clearBaseline();
    }
  });

test('a record round-trips through the file', async () => {
  await fresh(async (dir) => {
    await saveBaseline(one({ Start: '2024-01-15T20:14:00.000Z', End: '2024-03-20T22:03:00.000Z' }));
    clearBaseline();
    assert.equal(baseline().size, 0);

    await loadBaseline({ log: quiet });
    assert.deepEqual(baseline().get('300:1'), { Start: '2024-01-15T20:14:00.000Z', End: '2024-03-20T22:03:00.000Z' });
    assert.match(await readFile(join(dir, FILE), 'utf8'), /"version": 1/);
  });
});

/**
 * A merge, per key and per field. `Start` is recorded library-wide but `End`
 * only for the rows a run reached, so replacing would drop every out-of-window
 * `End` on each poll and record it afresh — swallowing the change on the run
 * that finally reached the row.
 */
test('saving folds into what is already recorded rather than replacing it', async () => {
  await fresh(async () => {
    await saveBaseline(one({ Start: '2024-01-15T20:14:00.000Z', End: '2024-03-20T22:03:00.000Z' }));
    await saveBaseline(one({ Start: '2025-01-15T20:14:00.000Z' }));
    assert.deepEqual(baseline().get('300:1'), { Start: '2025-01-15T20:14:00.000Z', End: '2024-03-20T22:03:00.000Z' });
  });
});

/**
 * Every failure here resolves towards silence. Read as nothing observed, the
 * next run records afresh and writes nothing; read as *changed*, it would plan
 * a write for every tracked field in the library at once.
 */
test('a missing file is nothing observed, not a failure', async () => {
  await fresh(async () => {
    await loadBaseline({ log: quiet });
    assert.equal(baseline().size, 0);
  });
});

test('an unreadable or unknown file is nothing observed', async () => {
  await fresh(async (dir) => {
    await writeFile(join(dir, FILE), 'not json at all');
    await loadBaseline({ log: quiet });
    assert.equal(baseline().size, 0);

    await writeFile(join(dir, FILE), JSON.stringify({ version: 99, seasons: { '300:1': { Start: '2024-01-15T20:14:00.000Z' } } }));
    await loadBaseline({ log: quiet });
    assert.equal(baseline().size, 0);
  });
});

/**
 * Per entry rather than all-or-nothing: every entry dropped is a change that
 * goes unwritten, so one malformed season must not cost the rest. Values must
 * be strings, because a number there would parse to no instant and read as
 * absent — silently, for the life of the file.
 */
test('a malformed entry is dropped without costing the others', async () => {
  await fresh(async (dir) => {
    await writeFile(
      join(dir, FILE),
      JSON.stringify({ version: 1, at: null, seasons: { '300:1': { Start: 45000 }, '301:1': { Start: '2024-01-15T20:14:00.000Z' }, '302:1': 'nonsense' } }),
    );
    await loadBaseline({ log: quiet });
    assert.deepEqual([...baseline().keys()], ['301:1']);
  });
});

/**
 * The count and the time the status page shows. An unchanged library must not
 * restamp it, or the page reads "just now" forever and says nothing.
 */
test('the summary counts seasons and only moves when something did', async () => {
  await fresh(async () => {
    assert.deepEqual(baselineSummary(), { seasons: 0, at: null });

    await saveBaseline(one({ Start: '2024-01-15T20:14:00.000Z' }));
    const first = baselineSummary();
    assert.equal(first.seasons, 1);
    assert.notEqual(first.at, null);

    await saveBaseline(one({ Start: '2024-01-15T20:14:00.000Z' }));
    assert.deepEqual(baselineSummary(), first);
  });
});
