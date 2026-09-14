import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseline, baselineSummary, clearBaseline, loadBaseline, saveBaseline } from '../../../src/sheet/io/baseline.ts';
import { movieKey, seasonKey, titleRecordKey, type Baseline } from '../../../src/sheet/values.ts';
import { quiet, withFreshBaseline } from '../../helpers.ts';

const FILE = 'sheet-baseline.json';

const one = (entry: Record<string, string>, key = '300:1'): Baseline => new Map([[key, entry]]);

test('a record round-trips through the file', async () => {
  await withFreshBaseline(async (dir) => {
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
  await withFreshBaseline(async () => {
    await saveBaseline(one({ Start: '2024-01-15T20:14:00.000Z', End: '2024-03-20T22:03:00.000Z' }));
    await saveBaseline(one({ Start: '2025-01-15T20:14:00.000Z' }));
    assert.deepEqual(baseline().get('300:1'), { Start: '2025-01-15T20:14:00.000Z', End: '2024-03-20T22:03:00.000Z' });
  });
});

/**
 * The fold can only add, so a field a run wants read as never observed has to
 * be dropped before it. `at` stands: nothing moved to a value.
 */
test('a forgotten field leaves the record, and the clock stands', async () => {
  await withFreshBaseline(async () => {
    await saveBaseline(one({ Start: '2024-01-15T20:14:00.000Z', Watched: '3' }));
    const at = baselineSummary().at;
    await saveBaseline(new Map(), { forgetting: new Map([['300:1', new Set(['Watched'])]]) });
    assert.deepEqual(baseline().get('300:1'), { Start: '2024-01-15T20:14:00.000Z' });
    assert.equal(baselineSummary().at, at, 'dropping a field is not a move');

    clearBaseline();
    await loadBaseline({ log: quiet });
    assert.deepEqual(baseline().get('300:1'), { Start: '2024-01-15T20:14:00.000Z' }, 'and the drop reached the file');

    await saveBaseline(new Map(), { forgetting: new Map([['300:1', new Set(['End'])], ['300:9', new Set(['Watched'])]]) });
    assert.deepEqual(baseline().get('300:1'), { Start: '2024-01-15T20:14:00.000Z' }, 'a field or a key the record does not hold is nothing to drop');
    assert.equal(baseline().has('300:9'), false);
  });
});

/**
 * A key appearing with no field at all is a row every value of which this run
 * withdrew. The key has to reach the file — it is the whole of what says the row
 * was seen, and `titleKnown` reads nothing else — but it moved no value, and
 * `at` is what the status page renders as when the record last changed.
 */
test('a first-sighting key with no fields is stored without moving the clock', async () => {
  await withFreshBaseline(async (dir) => {
    await saveBaseline(new Map([[titleRecordKey(300), {}]]));
    assert.equal(baselineSummary().at, null, 'nothing moved, so the record has not moved');

    clearBaseline();
    await loadBaseline({ log: quiet });
    assert.deepEqual(baseline().get(titleRecordKey(300)), {}, 'and the key survives the round trip');
    assert.match(await readFile(join(dir, FILE), 'utf8'), /"300": \{\}/);
  });
});

/**
 * Every failure here resolves towards silence. Read as nothing observed, the
 * next run records afresh and writes nothing; read as *changed*, it would plan
 * a write for every tracked field in the library at once.
 */
test('a missing file is nothing observed, not a failure', async () => {
  await withFreshBaseline(async () => {
    await loadBaseline({ log: quiet });
    assert.equal(baseline().size, 0);
  });
});

test('an unreadable or unknown file is nothing observed', async () => {
  await withFreshBaseline(async (dir) => {
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
  await withFreshBaseline(async (dir) => {
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
  await withFreshBaseline(async () => {
    assert.deepEqual(baselineSummary(), { seasons: 0, films: 0, at: null });

    await saveBaseline(one({ Start: '2024-01-15T20:14:00.000Z' }));
    const first = baselineSummary();
    assert.equal(first.seasons, 1);
    assert.notEqual(first.at, null);

    await saveBaseline(one({ Start: '2024-01-15T20:14:00.000Z' }));
    assert.deepEqual(baselineSummary(), first);
  });
});

test('films are counted apart from seasons — one record holds both tabs', async () => {
  // Rolled together, a first films poll adds one entry per film in the library
  // and the season count roughly doubles overnight, on the number whose job is
  // telling a recording-only first run from a sync that never armed.
  await withFreshBaseline(async () => {
    await saveBaseline(new Map([[seasonKey(1, 2), { Start: '2024-01-15T20:14:00.000Z' }]]));
    await saveBaseline(new Map([[movieKey(9), { 'Watch Date': '2024-02-01T20:14:00.000Z' }]]));
    await saveBaseline(new Map([[titleRecordKey(1), { Status: 'watching' }]]));
    const summary = baselineSummary();
    assert.equal(summary.seasons, 1);
    assert.equal(summary.films, 1);
  });
});

/**
 * The file also holds one entry per title, keyed by the bare id. Counted as
 * seasons — or subtracted from the total the way the films are — the show tab's
 * season count would be reported as roughly twice what it is, on the number
 * whose job is telling a recording-only first run from a sync that never armed.
 */
test('a title entry is counted as neither a season nor a film', async () => {
  await withFreshBaseline(async () => {
    await saveBaseline(
      new Map([
        [titleRecordKey(7), { Status: 'watching' }],
        [seasonKey(7, 1), { Watched: '4' }],
      ]),
    );
    assert.deepEqual(baselineSummary().seasons, 1);
    assert.deepEqual(baselineSummary().films, 0);
  });
});
