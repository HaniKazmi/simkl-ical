import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { appendSheetRun, loadSheetRuns, sheetRuns, type NewSheetRun } from '../../../src/sheet/io/journal.ts';
import { config } from '../../../src/shared/config.ts';
import { quiet, recorder, withFreshJournal } from '../../helpers.ts';

const FILE = 'sheet-runs.json';

const run = (overrides: Partial<NewSheetRun> = {}): NewSheetRun => ({
  at: '2026-08-16T14:02:00.000Z',
  status: 'applied',
  mode: 'apply',
  edits: [{ address: 'D609', field: 'Episode', note: 'Fargo S2: 3 -> 4 episodes' }],
  inserts: [],
  error: null,
  ...overrides,
});

// The guard in helpers.ts, asserted rather than assumed. A journal write is the
// first thing in the suite that persists outside a temp-dir block, and it wrote
// into the real ./data — passing green — before this was added.
test('the suite never points config.dataDir at the repo checkout', () => {
  assert.notEqual(resolve(config.dataDir), resolve('./data'));
});

test('a run round-trips through the file, oldest first', async () => {
  await withFreshJournal(async (dir) => {
    await appendSheetRun(run({ at: 'first' }));
    await appendSheetRun(run({ at: 'second', status: 'reported' }));

    const raw = JSON.parse(await readFile(join(dir, FILE), 'utf8'));
    assert.equal(raw.version, 1);
    assert.deepEqual(
      raw.runs.map((r: { at: string }) => r.at),
      ['first', 'second'],
    );

    // Re-read from disk, not from the cache the appends left behind.
    await loadSheetRuns();
    assert.deepEqual(
      sheetRuns().map((r) => r.at),
      ['first', 'second'],
    );
    assert.equal(sheetRuns()[0]?.edits[0]?.note, 'Fargo S2: 3 -> 4 episodes');
  });
});

// The notes name the user's shows, which the README treats as a credential —
// the same reason feed.ics is 0600.
test('the file is written 0600', async () => {
  await withFreshJournal(async (dir) => {
    await appendSheetRun(run());
    assert.equal((await stat(join(dir, FILE))).mode & 0o777, 0o600);
  });
});

test('the history is capped, keeping the newest', async () => {
  await withFreshJournal(async () => {
    for (let i = 0; i < 60; i += 1) await appendSheetRun(run({ at: `run-${i}`, error: `distinct ${i}` }));

    const kept = sheetRuns();
    assert.equal(kept.length, 50);
    assert.equal(kept[0]?.at, 'run-10', 'the oldest ten are gone');
    assert.equal(kept.at(-1)?.at, 'run-59');
  });
});

// A quiet poll on an unchanged sheet is the overwhelmingly common outcome. At
// one every two hours it would evict fifty real entries inside four days.
test('a run that says nothing is not recorded at all', async () => {
  await withFreshJournal(async (dir) => {
    await appendSheetRun(run({ status: 'idle', edits: [], inserts: [], error: null }));

    assert.deepEqual(sheetRuns(), []);
    await assert.rejects(readFile(join(dir, FILE), 'utf8'), 'and nothing is written');
  });
});

test('an idle run that still errored is recorded', async () => {
  await withFreshJournal(async () => {
    await appendSheetRun(run({ status: 'idle', edits: [], inserts: [], error: 'the tab is gone' }));
    assert.equal(sheetRuns().length, 1);
  });
});

// `frozen` is re-reported on every poll for the life of the process. Without
// collapsing, one freeze fills all fifty slots with the same message and every
// run that led up to it is lost — which is the history an operator wants most.
test('a repeated identical run collapses instead of filling the history', async () => {
  await withFreshJournal(async () => {
    const frozen = run({ status: 'frozen', error: 'FROZEN: copy _sync-1 back' });
    for (let i = 0; i < 37; i += 1) await appendSheetRun({ ...frozen, at: `poll-${i}` });

    assert.equal(sheetRuns().length, 1, 'thirty-seven polls, one row');
    assert.equal(sheetRuns()[0]?.repeats, 37);
    assert.equal(sheetRuns()[0]?.at, 'poll-36', 'stamped with the most recent');
  });
});

test('a different message on the same status does not collapse', async () => {
  await withFreshJournal(async () => {
    await appendSheetRun(run({ status: 'failed', error: 'first failure' }));
    await appendSheetRun(run({ status: 'failed', error: 'a different failure' }));
    assert.equal(sheetRuns().length, 2);
  });
});

test('a different plan on the same status does not collapse', async () => {
  await withFreshJournal(async () => {
    await appendSheetRun(run());
    await appendSheetRun(run({ edits: [{ address: 'D144', field: 'Episode', note: 'Severance S1: 9 -> 10 episodes' }] }));
    assert.equal(sheetRuns().length, 2);
  });
});

// Every degradation below has to leave the sync running: this sits on six
// return paths inside the refresh path, where nothing may be fatal.
test('a missing file is a first run, not an error', async () => {
  await withFreshJournal(async () => {
    const log = recorder();
    await loadSheetRuns({ log });
    assert.deepEqual(sheetRuns(), []);
    assert.deepEqual(log.lines, [], 'and it is not worth a warning');
  });
});

test('an unreadable file degrades to an empty history with one warning', async () => {
  for (const [label, body] of [
    ['truncated JSON', '{"version":1,"runs":[{"at":'],
    ['an unknown version', '{"version":99,"runs":[]}'],
    ['runs that is not an array', '{"version":1,"runs":"nope"}'],
    ['a bare array from some older shape', '[]'],
  ] as const) {
    await withFreshJournal(async (dir) => {
      await writeFile(join(dir, FILE), body);
      const log = recorder();
      await loadSheetRuns({ log });

      assert.deepEqual(sheetRuns(), [], label);
      assert.equal(log.lines.length, 1, `${label}: says so once`);
      assert.match(log.lines[0] ?? '', /^warn:/);
    });
  }
});

// One bad entry should not cost the rest, which is the part that would be
// missed. All-or-nothing here throws away a good history over a single record.
test('a malformed record is dropped and the rest of the history kept', async () => {
  await withFreshJournal(async (dir) => {
    const good = run({ at: 'good' });
    await writeFile(join(dir, FILE), JSON.stringify({ version: 1, runs: [null, 42, { at: 'no status' }, good, { status: 'applied' }] }));
    await loadSheetRuns({ log: quiet });

    assert.deepEqual(
      sheetRuns().map((r) => r.at),
      ['good'],
    );
  });
});

// The run's own result must be unaffected: the history is observational, and
// losing it costs only what survives the next restart.
test('a write that cannot land is warned about, never thrown', async () => {
  await withFreshJournal(async (dir) => {
    // A file where the directory needs to be, so mkdir fails with ENOTDIR.
    await writeFile(join(dir, 'blocked'), 'not a directory');
    const original = config.dataDir;
    config.dataDir = join(dir, 'blocked', 'nested');
    const log = recorder();
    try {
      await appendSheetRun(run(), { log });
      assert.equal(sheetRuns().length, 1, 'the in-memory history still advanced');
      assert.equal(log.lines.length, 1);
      assert.match(log.lines[0] ?? '', /^warn: could not save the sheet run log/);
    } finally {
      config.dataDir = original;
    }
  });
});
