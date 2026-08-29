import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, duration } from '../../src/status/1-model.ts';
import { before, countsWith, input, moved, request, COLD, DAY, HOUR, MINUTE, runRecord } from './fixtures.ts';

test('duration reads at a glance rather than to the second', () => {
  assert.equal(duration(Temporal.Duration.from({ milliseconds: 30_000 })), '30s');
  assert.equal(duration(Temporal.Duration.from({ milliseconds: 14 * MINUTE })), '14m');
  assert.equal(duration(Temporal.Duration.from({ milliseconds: HOUR + 46 * MINUTE })), '1h 46m');
  assert.equal(duration(Temporal.Duration.from({ milliseconds: 6 * HOUR })), '6h');
  assert.equal(duration(Temporal.Duration.from({ milliseconds: 4 * DAY + 6 * HOUR })), '4d 6h');
  assert.equal(duration(Temporal.Duration.from({ milliseconds: -5 })), '0s', 'a clock that went backwards is not negative time');
});

// A fresh container's state, and what the CI smoke test hits: it must model
// completely rather than throw or print "null".
test('the cold state models without throwing', () => {
  const model = buildModel(COLD);

  // A process always has a start time, so even a cold page has an uptime.
  assert.equal(model.uptime, '1m');
  assert.equal(model.library.polled.label, 'never');
  assert.equal(model.library.total, 0);
  // The three type rows are a fixed shape, so a cold page keeps a warm one's
  // skeleton rather than a gap where the totals go.
  assert.deepEqual(model.library.counts, [
    { key: 'shows', count: 0 },
    { key: 'anime', count: 0 },
    { key: 'films', count: 0 },
  ]);
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

// Not "due in two hours": a countdown from a run that never happened is worse
// than saying so.
test('something that has never run is due now, not overdue', () => {
  assert.deepEqual(buildModel(COLD).library.due, { label: 'due now' });
});

const GATE = { pull: 'delta' as const, updated: 1, removed: 0 };

// Fourteen per-status rows that barely move answer nothing; three totals
// answer the real question — is the library the size I expect.
test('the counts collapse to one total per type', () => {
  const model = buildModel(
    input({
      counts: countsWith({ shows: { watching: 47, completed: 412 }, anime: { completed: 200 }, movies: { plantowatch: 11 } }),
      gate: GATE,
    }),
  );

  assert.equal(model.library.total, 670);
  assert.deepEqual(model.library.counts, [
    { key: 'shows', count: 459 },
    { key: 'anime', count: 200 },
    { key: 'films', count: 11 },
  ]);
});

// `other` keeps the rows summing to the total; it shows only when SIMKL sends
// a status nothing here knows.
test('an unrecognised status appears only when it is not zero', () => {
  const model = buildModel(input({ counts: countsWith({ shows: { watching: 3 } }, 2), gate: GATE }));
  assert.deepEqual(model.library.counts.at(-1), { key: 'other', count: 2 });
});

// Before the first poll nothing is known — a different claim from nothing
// having moved.
test('with no gate yet the page says so rather than claiming nothing moved', () => {
  const model = buildModel(input({ counts: countsWith({ shows: { watching: 3 } }), gate: null }));
  assert.equal(model.library.gate, 'not polled yet');
});

test('a gate where nothing moved is still a gate', () => {
  const quietGate = { ...GATE, pull: 'none' as const, updated: 0 };
  const model = buildModel(input({ counts: countsWith({ shows: { watching: 3 } }), gate: quietGate }));
  assert.equal(model.library.gate, 'nothing moved', 'a gate that ran and found nothing is not "not polled yet"');
});

test('the gate line names what the pull carried', () => {
  assert.equal(buildModel(input({ gate: GATE })).library.gate, '1 updated');
  assert.equal(buildModel(input({ gate: { ...GATE, removed: 2 } })).library.gate, '1 updated · 2 removed');
  assert.equal(buildModel(input({ gate: { ...GATE, pull: 'full' } })).library.gate, 'full resync');
});

// What the notModified plumbing is for: at an interval matched to the CDN's
// regeneration cycle, "answered" and "regenerated" differ.
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

// The highest-value line on the page: /healthz reduces this to `true`, so the
// tab to copy back and the rows to delete exist nowhere else.
test('the freeze message is carried whole', () => {
  const message = 'FROZEN: copy _sync-repair-1 back over Sheet1 and delete rows 610-611';
  assert.equal(buildModel(input({ sheetFrozen: message })).sheet.frozen, message);
});

// --- how the library moved -------------------------------------------------
//
// The two halves answer different questions, and the commonest poll makes
// them disagree: watching an episode updates records and moves no counts —
// `updated` versus `reshaped`, made visible to a reader.


test('watching episodes reports work done and no movement between statuses', () => {
  const model = buildModel(input({ movement: moved({ updated: 14 }) }));
  assert.deepEqual(model.library.movement?.deltas, [], 'no count moved, because progress is not membership');
  assert.match(model.library.movement?.summary ?? '', /14 records updated/);
  assert.match(model.library.movement?.summary ?? '', /nothing moved between statuses/);
});

test('a status move reports the pair of counts shifting', () => {
  const model = buildModel(input({ movement: moved({ updated: 1, deltas: [{ type: 'shows', status: 'watching', delta: -1 }, { type: 'shows', status: 'completed', delta: 1 }] }) }));
  assert.deepEqual(model.library.movement?.deltas, ['shows/watching \u22121', 'shows/completed +1']);
});

test('a removal reports its count falling', () => {
  const model = buildModel(input({ movement: moved({ updated: 0, removed: 1, deltas: [{ type: 'movies', status: 'plantowatch', delta: -1 }] }) }));
  assert.deepEqual(model.library.movement?.deltas, ['movies/plantowatch \u22121']);
  assert.match(model.library.movement?.summary ?? '', /1 removed/);
});

// Before the first pull there is nothing to report — not the same as
// reporting that nothing moved.
test('a library that has never moved says so rather than showing an empty change', () => {
  assert.equal(buildModel(input({ movement: null })).library.movement, null);
});

// --- the request log -------------------------------------------------------


test('a size reads at a glance rather than in bytes', () => {
  const model = buildModel(input({ requests: [request({ bytes: 900 }), request({ bytes: 21_504 }), request({ bytes: 2_516_582 })] }));
  assert.deepEqual(
    model.requests.map((r) => r.size),
    ['900B', '21K', '2.4M'],
  );
});

// A 304 is the healthy outcome of a conditional GET; the absent body is its
// point.
test('a response carrying no body shows a dash, not a zero', () => {
  const model = buildModel(input({ requests: [request({ status: 304, bytes: null })] }));
  assert.equal(model.requests[0]?.size, '\u2014');
});

test('a request keeps its instant for a machine and its age for a reader', () => {
  const model = buildModel(input({ requests: [request()] }));
  assert.match(model.requests[0]?.at.label ?? '', /ago$/);
  assert.equal(model.requests[0]?.at.iso, before(2 * MINUTE));
});

// An unconfigured runtime lookup makes zero requests, so nothing else on the
// page separates "no credential" from "no season closed yet" — while the
// Episodes column silently stays blank. This line is the only signal.
test('the page says when runtime lookups are off, and stays quiet when they work', () => {
  assert.equal(buildModel(input({ sheetConfigured: true, runtimesConfigured: false })).sheet.runtimes, false);
  assert.equal(buildModel(input({ sheetConfigured: true, runtimesConfigured: true })).sheet.runtimes, true);
});

// The request log carries this for free: a TVDB failure needs no new plumbing
// to reach the reader.
test('a failing TVDB lookup reaches the promoted errors', () => {
  const model = buildModel(
    input({
      requests: [
        request({
          service: 'tvdb',
          component: 'runtimes',
          path: '/v4/series/269613/episodes/official?season=2',
          status: 500,
          attempts: 4,
          error: 'boom',
        }),
      ],
    }),
  );
  assert.equal(model.requests[0]?.service, 'tvdb');
  assert.equal(model.requests[0]?.component, 'runtimes');
  assert.match(model.requestErrors.join(' '), /episodes\/official.*boom/);
});
