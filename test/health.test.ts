import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../src/orchestrator.ts';
import { assess, healthResponse } from '../src/health.ts';
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

/** One snapshot, assessed — the exact pair `/healthz` is served from. */
const healthOf = (state: Orchestrator) => {
  const snapshot = state.snapshot();
  return { snapshot, ...assess(snapshot) };
};

test('a freshly rendered feed is healthy, and says nothing is wrong', () => {
  const health = healthOf(rendered());
  assert.equal(health.ok, true);
  assert.deepEqual(health.problems, []);
});

test('nothing rendered yet is unhealthy, and says why', () => {
  const health = healthOf(new Orchestrator({ logger: quiet }));
  assert.equal(health.ok, false);
  assert.ok(health.problems.includes('nothing has been rendered yet'));
});

// A revoked token must eventually read as unhealthy.
test('a feed that has stopped polling goes unhealthy', () => {
  const state = rendered();
  state.polledAt = ago(config.activitiesPoll.total('milliseconds') * 4);
  state.errors.library = 'SIMKL rejected the token (401)';
  const health = healthOf(state);
  assert.equal(health.ok, false);
  assert.deepEqual(health.problems, ['SIMKL rejected the token (401)']);
});

// The two halves own their own error slots, so neither can clear the other's.
test('a calendar success does not erase a library failure', () => {
  const state = rendered();
  state.errors.library = 'SIMKL rejected the token (401)';
  state.feed.errors.calendar = null; // as if a calendar refresh just succeeded

  const { snapshot } = healthOf(state);
  assert.equal(snapshot.library.error, 'SIMKL rejected the token (401)');
  assert.equal(snapshot.feed.calendars.error, null);
});

// Worst first: a stale calendar still renders, a revoked token eventually
// will not, so the library's problem reads first.
test('problems are ordered library, then calendars, then rendering', () => {
  const state = rendered();
  state.errors.library = 'library boom';
  state.feed.errors.calendar = 'calendar boom';
  state.feed.errors.render = 'render boom';

  assert.deepEqual(healthOf(state).problems, ['library boom', 'calendar boom', 'render boom']);
});

// Each subsystem contributes at most one line: the calendar error already
// says the CDN is quiet, so the staleness line would say it twice.
test('a subsystem with an error does not also report its staleness', () => {
  const state = rendered();
  state.feed.calendarsFreshAt = ago(config.calendarRefresh.total('milliseconds') * 4);
  assert.deepEqual(healthOf(state).problems, [`the CDN has not answered since ${state.feed.calendarsFreshAt}`]);

  state.feed.errors.calendar = 'serving cached calendars — the CDN has not answered since startup';
  assert.deepEqual(healthOf(state).problems, ['serving cached calendars — the CDN has not answered since startup']);
});

test('stale calendars go unhealthy', () => {
  const state = rendered();
  state.feed.calendarsFreshAt = ago(config.calendarRefresh.total('milliseconds') * 4);
  assert.equal(healthOf(state).ok, false);
});

// fetchCached serves its cache on any CDN failure, so refreshes keep
// "succeeding". Health keys on when the CDN last actually answered — why
// `attemptedAt` and `freshAt` are separate fields.
test('a CDN outage is unhealthy even though refreshes keep "succeeding"', () => {
  const state = rendered();
  state.feed.calendarsAt = nowIso(); // attempts keep happening...
  state.feed.calendarsFreshAt = ago(config.calendarRefresh.total('milliseconds') * 4); // ...but nothing fresh
  const { ok, snapshot } = healthOf(state);
  assert.equal(ok, false);
  assert.notEqual(snapshot.feed.calendars.attemptedAt, snapshot.feed.calendars.freshAt);
});

// render() records a failure and returns, leaving the previous feed serving,
// so `ok` must consult the render error.
test('a render that keeps failing is unhealthy', () => {
  const state = rendered();
  assert.equal(healthOf(state).ok, true, 'precondition');
  state.feed.errors.render = 'Invalid time value';
  assert.equal(healthOf(state).ok, false);
  assert.deepEqual(healthOf(state).problems, ['Invalid time value']);
});

// Renders happen on every calendar refresh, so a stalled renderedAt means
// rendering stopped even when nothing reported an error.
test('a feed that has stopped rendering is unhealthy', () => {
  const state = rendered();
  state.feed.renderedAt = ago(config.calendarRefresh.total('milliseconds') * 4);
  assert.equal(healthOf(state).ok, false);
  assert.deepEqual(healthOf(state).problems, [`nothing has rendered since ${state.feed.renderedAt}`]);
});

// syncedAt only advances when something changes, so an old value is normal,
// not a fault.
test('an old library sync time alone does not mean unhealthy', () => {
  const state = rendered();
  state.libraryAt = ago(30 * 24 * 60 * 60 * 1000);
  assert.equal(healthOf(state).ok, true);
  assert.deepEqual(healthOf(state).problems, []);
});

// /healthz is the container healthcheck. A frozen sheet must not restart the
// container, so it appears in `sheet.error` and nowhere that reads as "the
// feed is broken".
test('a sheet failure is reported but never makes the service unhealthy', () => {
  const state = rendered();
  state.errors.sheet = 'FROZEN: the sheet write failed verification';
  const { ok, problems, snapshot } = healthOf(state);
  assert.equal(ok, true);
  assert.deepEqual(problems, []);
  assert.equal(snapshot.sheet.error, 'FROZEN: the sheet write failed verification');
});

// readToken only swallows ENOENT, so a truncated token.json throws — from a
// timer, that takes the process down.
test('an unreadable token file degrades the feed rather than throwing', async () => {
  await withTempDataDir(async (dir) => {
    await writeFile(join(dir, 'token.json'), '{ truncated');
    const state = new Orchestrator({ logger: quiet });
    // Wrapped even though `readToken` throws before any request: the guard
    // makes that a property of the test, not of incidental ordering.
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
test('the response reports the timestamps a human would want', () => {
  const state = rendered();
  state.feed.events = [];
  const { snapshot, ...assessment } = healthOf(state);
  const response = healthResponse(snapshot, assessment);

  assert.equal(response.feed.events, 0);
  assert.equal(response.timezone, config.timezone);
  assert.equal(response.feed.calendars.attemptedAt, state.feed.calendarsAt);
  assert.equal(response.feed.calendars.freshAt, state.feed.calendarsFreshAt);
  assert.equal(response.library.syncedAt, state.libraryAt);
  assert.equal(response.library.polledAt, state.polledAt);
  assert.equal(response.feed.renderedAt, state.feed.renderedAt);
  assert.equal(response.feed.servingCached, false);
});

// JSON.stringify emits insertion order and tsc never checks it, so nothing
// else notices a reordered literal changing what operators read.
test('the payload keys are in a stable, documented order', () => {
  const state = rendered();
  const { snapshot, ...assessment } = healthOf(state);
  const response = healthResponse(snapshot, assessment);
  assert.deepEqual(Object.keys(response), ['ok', 'timezone', 'library', 'feed', 'sheet']);
  assert.deepEqual(Object.keys(response.library), ['polledAt', 'syncedAt']);
  assert.deepEqual(Object.keys(response.feed), ['events', 'renderedAt', 'servingCached', 'calendars']);
  assert.deepEqual(Object.keys(response.feed.calendars), ['attemptedAt', 'freshAt']);
  assert.deepEqual(Object.keys(response.sheet), ['configured', 'mode', 'status', 'lastRunAt', 'frozen']);
});

test('the event count reflects what was actually joined', async () => {
  const state = rendered();
  state.feed.calendars = emptyCalendars();
  state.library = new Map();
  await state.feed.render(state.library);
  assert.equal(state.snapshot().feed.events, 0);
});
