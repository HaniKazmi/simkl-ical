import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../src/orchestrator.ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/shared/config.ts';
import { ago, emptyCalendars, quiet, withFetch, withTempDataDir } from './helpers.ts';
import { nowIso } from '../src/shared/dates.ts';

const rendered = () => {
  const state = new Orchestrator({ logger: quiet });
  const now = nowIso();
  state.feed.renderedAt = now;
  state.feed.calendarsAt = now;
  state.feed.calendarsFreshAt = now;
  state.polledAt = now;
  return state;
};

test('a freshly rendered feed is healthy, and says nothing is wrong', () => {
  const health = rendered().health;
  assert.equal(health.ok, true);
  assert.deepEqual(health.problems, []);
});

test('nothing rendered yet is unhealthy, and says why', () => {
  const health = new Orchestrator({ logger: quiet }).health;
  assert.equal(health.ok, false);
  assert.ok(health.problems.includes('nothing has been rendered yet'));
});

// A revoked token must eventually read as unhealthy.
test('a feed that has stopped polling goes unhealthy', () => {
  const state = rendered();
  state.polledAt = ago(config.activitiesPoll.total('milliseconds') * 4);
  state.errors.library = 'AUTH: SIMKL rejected the token (401)';
  assert.equal(state.health.ok, false);
  assert.deepEqual(state.health.problems, ['AUTH: SIMKL rejected the token (401)']);
});

// The two halves own their own error slots, so neither can clear the other's.
test('a calendar success does not erase a library failure', () => {
  const state = rendered();
  state.errors.library = 'AUTH: SIMKL rejected the token (401)';
  state.feed.errors.calendar = null; // as if a calendar refresh just succeeded

  assert.equal(state.health.library.error, 'AUTH: SIMKL rejected the token (401)');
  assert.equal(state.health.feed.calendars.error, null);
});

// Worst first: a stale calendar still renders, a revoked token eventually will
// not, so the library's problem has to be the one an operator reads first.
test('problems are ordered library, then calendars, then rendering', () => {
  const state = rendered();
  state.errors.library = 'library boom';
  state.feed.errors.calendar = 'calendar boom';
  state.feed.errors.render = 'render boom';

  assert.deepEqual(state.health.problems, ['library boom', 'calendar boom', 'render boom']);
});

// Each subsystem contributes at most one line. The calendar error already says
// the CDN is quiet, so emitting the staleness line too would say it twice.
test('a subsystem with an error does not also report its staleness', () => {
  const state = rendered();
  state.feed.calendarsFreshAt = ago(config.calendarRefresh.total('milliseconds') * 4);
  assert.deepEqual(state.health.problems, [`the CDN has not answered since ${state.feed.calendarsFreshAt}`]);

  state.feed.errors.calendar = 'serving cached calendars — the CDN has not answered since startup';
  assert.deepEqual(state.health.problems, ['serving cached calendars — the CDN has not answered since startup']);
});

test('stale calendars go unhealthy', () => {
  const state = rendered();
  state.feed.calendarsFreshAt = ago(config.calendarRefresh.total('milliseconds') * 4);
  assert.equal(state.health.ok, false);
});

// fetchCached serves its cache on any CDN failure, so refresh attempts keep
// "succeeding". Health is keyed on when the CDN last actually answered — which
// is the entire reason `attemptedAt` and `freshAt` are separate fields.
test('a CDN outage is unhealthy even though refreshes keep "succeeding"', () => {
  const state = rendered();
  state.feed.calendarsAt = nowIso(); // attempts keep happening...
  state.feed.calendarsFreshAt = ago(config.calendarRefresh.total('milliseconds') * 4); // ...but nothing fresh
  assert.equal(state.health.ok, false);
  assert.notEqual(state.health.feed.calendars.attemptedAt, state.health.feed.calendars.freshAt);
});

// safeRender records a failure and returns, leaving the previous feed serving.
// One malformed calendar entry is enough, so `ok` must consult the render error.
test('a render that keeps failing is unhealthy', () => {
  const state = rendered();
  assert.equal(state.health.ok, true, 'precondition');
  state.feed.errors.render = 'Invalid time value';
  assert.equal(state.health.ok, false);
  assert.deepEqual(state.health.problems, ['Invalid time value']);
});

// Renders happen on every calendar refresh, so a renderedAt that stops advancing
// means rendering has stopped even when nothing reported an error.
test('a feed that has stopped rendering is unhealthy', () => {
  const state = rendered();
  state.feed.renderedAt = ago(config.calendarRefresh.total('milliseconds') * 4);
  assert.equal(state.health.ok, false);
  assert.deepEqual(state.health.problems, [`nothing has rendered since ${state.feed.renderedAt}`]);
});

// With per-list gating syncedAt only advances when something actually changes,
// so an old value is normal and must not be read as a fault.
test('an old library sync time alone does not mean unhealthy', () => {
  const state = rendered();
  state.libraryAt = ago(30 * 24 * 60 * 60 * 1000);
  assert.equal(state.health.ok, true);
  assert.deepEqual(state.health.problems, []);
});

// /healthz is the container healthcheck and the CI smoke test. A frozen sheet
// must not restart the container, so it appears in `sheet.error` and nowhere
// that an operator would read as "the feed is broken".
test('a sheet failure is reported but never makes the service unhealthy', () => {
  const state = rendered();
  state.errors.sheet = 'FROZEN: the sheet write failed verification';
  assert.equal(state.health.ok, true);
  assert.deepEqual(state.health.problems, []);
  assert.equal(state.health.sheet.error, 'FROZEN: the sheet write failed verification');
});

// readToken only swallows ENOENT, so a truncated token.json throws — from a
// timer, that would take the process down.
test('an unreadable token file degrades the feed rather than throwing', async () => {
  await withTempDataDir(async (dir) => {
    await writeFile(join(dir, 'token.json'), '{ truncated');
    const state = new Orchestrator({ logger: quiet });
    // Wrapped even though `readToken` throws before any request: the guard is
    // what makes that a property of the test rather than of the order two
    // unrelated functions happen to run in.
    await withFetch(
      (url) => {
        throw new Error(`no request should have been made, got ${url}`);
      },
      () => state.refreshLibraryIfChanged(),
    );
    assert.ok(state.errors.library, 'the failure is recorded');
  });
});

// On values, not key presence — tsc already proves the fields exist.
test('health reports the timestamps a human would want', () => {
  const state = rendered();
  state.feed.events = [];
  const health = state.health;

  assert.equal(health.feed.events, 0);
  assert.equal(health.timezone, config.timezone);
  assert.equal(health.feed.calendars.attemptedAt, state.feed.calendarsAt);
  assert.equal(health.feed.calendars.freshAt, state.feed.calendarsFreshAt);
  assert.equal(health.library.syncedAt, state.libraryAt);
  assert.equal(health.library.polledAt, state.polledAt);
  assert.equal(health.feed.renderedAt, state.feed.renderedAt);
  assert.equal(health.feed.servingCached, false);
});

// JSON.stringify emits insertion order and tsc checks keys but never their
// order, so nothing else would notice a reordered literal changing what
// operators read.
test('the payload keys are in a stable, documented order', () => {
  const health = rendered().health;
  assert.deepEqual(Object.keys(health), ['ok', 'timezone', 'problems', 'library', 'feed', 'sheet']);
  assert.deepEqual(Object.keys(health.library), ['polledAt', 'syncedAt', 'error']);
  assert.deepEqual(Object.keys(health.feed), ['events', 'renderedAt', 'servingCached', 'error', 'calendars']);
  assert.deepEqual(Object.keys(health.feed.calendars), ['attemptedAt', 'freshAt', 'error']);
  assert.deepEqual(Object.keys(health.sheet), ['configured', 'mode', 'status', 'lastRunAt', 'frozen', 'error']);
});

test('the event count reflects what was actually joined', () => {
  const state = rendered();
  state.feed.calendars = emptyCalendars();
  state.library = new Map();
  state.feed.render(state.library);
  assert.equal(state.health.feed.events, 0);
});
