import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, duration } from '../../src/status/1-model.ts';
import type { SheetSyncStatus } from '../../src/sheet/sync.ts';
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
    { key: 'shows', count: 0, byStatus: [0, 0, 0, 0, 0] },
    { key: 'anime', count: 0, byStatus: [0, 0, 0, 0, 0] },
    { key: 'films', count: 0, byStatus: [null, 0, 0, null, 0] },
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
  // Aligned to `countColumns` — watch, done, plan, hold, drop. `films` reads
  // null where SIMKL has no such status at all, which is not a zero.
  assert.deepEqual(model.library.countColumns, ['watch', 'done', 'plan', 'hold', 'drop']);
  assert.deepEqual(model.library.counts, [
    { key: 'shows', count: 459, byStatus: [47, 412, 0, 0, 0] },
    { key: 'anime', count: 200, byStatus: [0, 200, 0, 0, 0] },
    { key: 'films', count: 11, byStatus: [null, 0, 11, null, 0] },
  ]);
});

// `other` keeps the rows summing to the total; it shows only when SIMKL sends
// a status nothing here knows.
test('an unrecognised status appears only when it is not zero', () => {
  const model = buildModel(input({ counts: countsWith({ shows: { watching: 3 } }, 2), gate: GATE }));
  assert.deepEqual(model.library.counts.at(-1), { key: 'other', count: 2, byStatus: [null, null, null, null, null] });
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
  assert.match(model.library.movement?.pulled ?? '', /delta · 14 records read/);
  assert.match(model.library.movement?.consequence ?? '', /progress only, so the feed was left alone/);
});

// The number that made the old single line unreadable: a full resync carries
// the whole library, so `updated` says nothing about what changed. Only the
// pull kind beside it tells this apart from a delta that moved 743 records.
test('a full resync says so, so its record count is not read as change', () => {
  const model = buildModel(input({ movement: moved({ pull: 'full', updated: 743 }) }));
  assert.match(model.library.movement?.pulled ?? '', /full resync · 743 records read/);
});

// `reshaped`, not `updated`, is what the feed can see, and the page names the
// consequence rather than leaving a reader to infer it from a count.
test('records that changed membership report the render they caused', () => {
  const model = buildModel(input({ movement: moved({ updated: 14, reshaped: 2, rendered: true }) }));
  assert.match(model.library.movement?.consequence ?? '', /2 changed membership, so the feed re-rendered/);
});

// A full pull renders unconditionally and sets no `reshaped`, so it reaches the
// consequence with nothing named. Every cold start is one of these.
test('a full resync says what it re-read rather than blaming a film', () => {
  const model = buildModel(input({ movement: moved({ pull: 'full', updated: 743, rendered: true }) }));
  assert.match(model.library.movement?.consequence ?? '', /the whole library was re-read, so the feed re-rendered/);
});

// The poll renders on `feedChanged(poll) || filmsDue`, and a film reaching its
// release date moves no count here. Reading the answer back out of the counts
// alone reports the opposite of what happened.
test('a render a film caused is reported, though no count moved', () => {
  const model = buildModel(input({ movement: moved({ updated: 3, reshaped: 0, rendered: true }) }));
  assert.match(model.library.movement?.consequence ?? '', /a film came into range, so the feed re-rendered/);
});

test('a poll that rendered nothing says so', () => {
  const model = buildModel(input({ movement: moved({ updated: 14, reshaped: 0, rendered: false }) }));
  assert.match(model.library.movement?.consequence ?? '', /progress only, so the feed was left alone/);
});

test('a status move reports the pair of counts shifting', () => {
  const model = buildModel(input({ movement: moved({ updated: 1, deltas: [{ type: 'shows', status: 'watching', delta: -1 }, { type: 'shows', status: 'completed', delta: 1 }] }) }));
  assert.deepEqual(model.library.movement?.deltas, ['shows/watching \u22121', 'shows/completed +1']);
});

test('a removal reports its count falling', () => {
  const model = buildModel(input({ movement: moved({ updated: 0, removed: 1, rendered: true, deltas: [{ type: 'movies', status: 'plantowatch', delta: -1 }] }) }));
  assert.deepEqual(model.library.movement?.deltas, ['movies/plantowatch \u22121']);
  assert.match(model.library.movement?.pulled ?? '', /1 title removed/);
  assert.match(model.library.movement?.consequence ?? '', /1 title left the library, so the feed re-rendered/);
});

// Before the first pull there is nothing to report — not the same as
// reporting that nothing moved.
// A poll where the signature had not moved but titles left: the removal diff
// runs on its own gate, so nothing was asked for and yet the library shrank.
test('a poll that only checked membership does not claim to have read records', () => {
  const model = buildModel(input({ movement: moved({ pull: 'none', updated: 0, removed: 2, rendered: true }) }));
  assert.match(model.library.movement?.pulled ?? '', /^membership check · 2 titles removed$/);
});

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

// --- the tiles -------------------------------------------------------------
//
// The header pill says something is wrong; the tiles say which half. Their
// state comes from the areas `assess` tags, so a tile cannot light up over
// something the problems box does not explain.

test('all three tiles are quiet when nothing is wrong', () => {
  const model = buildModel(input({ problems: [] }));
  assert.deepEqual(
    model.tiles.map((t) => [t.name, t.state]),
    [
      ['library', 'ok'],
      ['feed', 'ok'],
      ['sheet', 'mute'],
    ],
    'the sheet is muted rather than green: unconfigured is not a fault',
  );
});

test('a problem colours its own tile and leaves the others alone', () => {
  const model = buildModel(input({ problems: [{ area: 'library', message: 'SIMKL rejected the token (401)' }] }));
  assert.deepEqual(
    model.tiles.map((t) => t.state),
    ['crit', 'ok', 'mute'],
  );
});

// A stale CDN still renders yesterday's feed, so it warns where a render
// failure is critical — the same ranking `assess` puts the lines in.
test('a quiet CDN warns the feed tile where a render failure is critical', () => {
  const warned = buildModel(input({ problems: [{ area: 'calendars', message: 'the CDN has not answered' }] }));
  assert.equal(warned.tiles[1]?.state, 'warn');

  const failed = buildModel(input({ problems: [{ area: 'feed', message: 'nothing has been rendered yet' }] }));
  assert.equal(failed.tiles[1]?.state, 'crit');
});

test('a frozen sheet is critical however its last run ended', () => {
  const model = buildModel(input({ sheetConfigured: true, sheetStatus: 'applied', sheetFrozen: 'FROZEN: copy Backup back' }));
  assert.equal(model.sheet.state, 'crit');
  assert.equal(model.tiles[2]?.state, 'crit', 'and the tile agrees with the section');
});

// A status read off disk could be any string, and one naming a prototype
// member would resolve through it if the lookup were a plain index.
test('an unknown run status is muted rather than resolving through the prototype', () => {
  const model = buildModel(input({ sheetConfigured: true, runs: [runRecord({ status: 'constructor' as SheetSyncStatus })] }));
  assert.equal(model.sheet.runs[0]?.state, 'mute');
});

// --- what the page decides for the template --------------------------------

test('only the newest run is open; the rest collapse', () => {
  const model = buildModel(
    input({
      sheetConfigured: true,
      runs: [runRecord({ at: before(3 * MINUTE) }), runRecord({ at: before(2 * MINUTE) }), runRecord({ at: before(MINUTE) })],
    }),
  );
  assert.deepEqual(
    model.sheet.runs.map((r) => r.open),
    [true, false, false],
    'newest first, and it is the one that stands open',
  );
});

test('a run of one edit says edit, not edits', () => {
  const model = buildModel(input({ sheetConfigured: true, runs: [runRecord({ edits: [{ address: 'B2', field: 'Status', note: 'x' }], inserts: [] })] }));
  assert.equal(model.sheet.runs[0]?.count, '1 edit · 0 inserts');
});

// The 44-character spreadsheet id repeats on every Google call and is the only
// thing that overruns the column. The tail has to survive it: that is what
// tells one call from another.
test('a long path is shortened in the middle, keeping both ends', () => {
  const full = `/v4/spreadsheets/${'i'.repeat(44)}:batchUpdate`;
  const model = buildModel(input({ requests: [request({ path: full })] }));
  const view = model.requests[0]!;

  assert.equal(view.full, full, 'the whole path is kept for the tooltip');
  assert.ok(view.path.length < full.length);
  assert.ok(view.path.startsWith('/v4/spreadsheets/'), 'the head says which API');
  assert.ok(view.path.endsWith(':batchUpdate'), 'and the tail says which call');
});

test('a path that already fits is left exactly as it is', () => {
  const model = buildModel(input({ requests: [request({ path: '/sync/activities' })] }));
  assert.equal(model.requests[0]?.path, '/sync/activities');
  assert.equal(model.requests[0]?.full, '/sync/activities');
});

// Relative reads at a glance; the absolute time is what pins "12d 17h ago" to
// a date without opening the logs.
test('a stamp carries the absolute time in the configured zone', () => {
  const model = buildModel(input({ polledAt: '2026-08-16T13:16:00.000Z' }));
  assert.equal(model.library.polled.title, '2026-08-16 14:16 Europe/London');
});

test('a stamp with no instant has no absolute time either', () => {
  assert.equal(buildModel(input({ polledAt: null })).library.polled.title, null);
});

// The one poll outcome that changes what the *next* poll will do, and the page
// had nowhere to say it.
test('a refused removal diff outranks the counts in the gate line', () => {
  const model = buildModel(input({ gate: { pull: 'delta', updated: 4, refusedRemovals: true } }));
  assert.match(model.library.gate, /removals refused/);
});

// The section's error slot and the newest run's error are usually the same
// string, and printing both puts the same paragraph on the page twice.
test('an error the newest run already carries is not repeated above it', () => {
  const boom = 'The Google credential is not JSON';
  const model = buildModel(input({ sheetConfigured: true, sheetError: boom, runs: [runRecord({ status: 'failed', error: boom })] }));

  assert.equal(model.sheet.error, null, 'the run card below says it');
  assert.equal(model.sheet.runs[0]?.error, boom);
});

test('an error no run recorded still reaches the reader', () => {
  const model = buildModel(input({ sheetConfigured: true, sheetError: 'the spreadsheet is not readable', runs: [] }));
  assert.equal(model.sheet.error, 'the spreadsheet is not readable');
});

// `sheet-runs.json` is read off disk and rendered verbatim, so a timestamp in
// it may be a string that will not parse. That is not the same as no timestamp,
// and the page must not print it as if it were a date.
test('a timestamp that will not parse reads as never, with no absolute time', () => {
  const model = buildModel(input({ polledAt: 'not a date' }));
  assert.equal(model.library.polled.label, 'never');
  assert.equal(model.library.polled.title, null);
});
