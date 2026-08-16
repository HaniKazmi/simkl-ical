import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, duration } from '../../src/status/1-model.ts';
import { before, input, COLD, DAY, HOUR, MINUTE, runRecord } from './fixtures.ts';

test('duration reads at a glance rather than to the second', () => {
  assert.equal(duration(30_000), '30s');
  assert.equal(duration(14 * MINUTE), '14m');
  assert.equal(duration(HOUR + 46 * MINUTE), '1h 46m');
  assert.equal(duration(6 * HOUR), '6h');
  assert.equal(duration(4 * DAY + 6 * HOUR), '4d 6h');
  assert.equal(duration(-5), '0s', 'a clock that went backwards is not negative time');
});

// The state a fresh container is in, and the state the CI smoke test hits. It
// must model completely rather than throw or print the word "null".
test('the cold state models without throwing', () => {
  const model = buildModel(COLD);

  assert.equal(model.uptime, null);
  assert.equal(model.library.polled.label, 'never');
  assert.equal(model.library.total, 0);
  assert.deepEqual(model.library.counts, []);
  assert.equal(model.feed.rendered.label, 'never');
  assert.deepEqual(model.sheet.runs, []);
  assert.ok(!JSON.stringify(model).includes('NaN'));
  assert.ok(!JSON.stringify(model).includes('Infinity'));
});

test('ages read as relative, and the instant is kept for a machine', () => {
  const model = buildModel(input({ polledAt: before(14 * MINUTE), startedAt: before(4 * DAY + 6 * HOUR) }));
  assert.equal(model.library.polled.label, '14m ago');
  assert.equal(model.library.polled.iso, before(14 * MINUTE));
  assert.equal(model.uptime, '4d 6h');
});

test('next-due counts from the last run, and says so when it has passed', () => {
  assert.equal(buildModel(input({ polledAt: before(14 * MINUTE) })).library.due.label, 'in 1h 46m');

  assert.equal(buildModel(input({ polledAt: before(3 * HOUR) })).library.due.label, 'overdue by 1h');
});

// Not "due in two hours": there is nothing to count from, and claiming a
// countdown from a run that never happened is worse than saying so.
test('something that has never run is due now, not overdue', () => {
  assert.deepEqual(buildModel(COLD).library.due, { label: 'due now' });
});

const GATE = { pull: 'delta' as const, updated: 1, removed: 0 };

test('count rows carry a share of the largest', () => {
  const model = buildModel(
    input({ counts: { 'shows/watching': 47, 'shows/completed': 412, 'shows/dropped': 0 }, gate: GATE }),
  );

  assert.equal(model.library.total, 459);
  assert.deepEqual(model.library.counts.map((c) => c.key), ['shows/watching', 'shows/completed', 'shows/dropped']);
  assert.equal(model.library.counts[1]?.share, 1, 'the largest fills the bar');
  assert.ok(Math.abs((model.library.counts[0]?.share ?? 0) - 47 / 412) < 1e-9);
});

// Before the first poll nothing is known, which is a different claim from
// nothing having moved.
test('with no gate yet the page says so rather than claiming nothing moved', () => {
  const model = buildModel(input({ counts: { 'shows/watching': 3 }, gate: null }));
  assert.equal(model.library.gate, 'not polled yet');
});

test('a gate where nothing moved is still a gate', () => {
  const quietGate = { ...GATE, pull: 'none' as const, updated: 0 };
  const model = buildModel(input({ counts: { 'shows/watching': 3 }, gate: quietGate }));
  assert.equal(model.library.gate, 'nothing moved', 'a gate that ran and found nothing is not "not polled yet"');
});

test('the gate line names what the pull carried', () => {
  assert.equal(buildModel(input({ gate: GATE })).library.gate, '1 updated');
  assert.equal(buildModel(input({ gate: { ...GATE, removed: 2 } })).library.gate, '1 updated · 2 removed');
  assert.equal(buildModel(input({ gate: { ...GATE, pull: 'full' } })).library.gate, 'full resync');
});

// The distinction the notModified plumbing exists for: at an interval matched
// to the CDN's regeneration cycle, "answered" and "regenerated" differ.
test('the fetch step separates a fresh calendar from an unchanged one', () => {
  const at = before(2 * HOUR);
  assert.match(buildModel(input({ calendarsAt: at, calendarsChangedAt: at })).feed.steps[0]!.detail, /new airdates/);

  const unchanged = buildModel(input({ calendarsAt: at, calendarsChangedAt: before(8 * HOUR) }));
  assert.match(unchanged.feed.steps[0]!.detail, /unchanged since 8h ago/);

  const failing = buildModel(input({ calendarsAt: at, calendarsChangedAt: at, calendarError: 'offline' }));
  assert.match(failing.feed.steps[0]!.detail, /serving cache/);
  assert.equal(failing.feed.steps[0]!.ok, false);
});

test('runs are newest first for reading, though the journal appends oldest first', () => {
  const at = (ms: number) => runRecord({ at: before(ms) });
  const model = buildModel(input({ runs: [at(2 * DAY), at(HOUR), at(MINUTE)] }));
  assert.deepEqual(
    model.sheet.runs.map((r) => r.at.label),
    ['1m ago', '1h ago', '2d ago'],
  );
});

// The single highest-value thing on the page: /healthz reduces this to `true`,
// so the tab to copy back and the rows to delete exist nowhere else.
test('the freeze message is carried whole', () => {
  const message = 'FROZEN: copy _sync-repair-1 back over Sheet1 and delete rows 610-611';
  assert.equal(buildModel(input({ sheetFrozen: message })).sheet.frozen, message);
});
