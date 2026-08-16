import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedState } from '../src/refresh.ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/shared/config.ts';
import { ago, emptyCalendars, quiet, withTempDataDir } from './helpers.ts';

const rendered = () => {
  const state = new FeedState({ logger: quiet });
  state.renderedAt = new Date().toISOString();
  state.calendarsAt = new Date().toISOString();
  state.calendarsFreshAt = new Date().toISOString();
  state.polledAt = new Date().toISOString();
  return state;
};

test('a freshly rendered feed is healthy', () => {
  assert.equal(rendered().health.ok, true);
});

test('nothing rendered yet is unhealthy', () => {
  assert.equal(new FeedState({ logger: quiet }).health.ok, false);
});

// A revoked token must eventually read as unhealthy.
test('a feed that has stopped polling goes unhealthy', () => {
  const state = rendered();
  state.polledAt = ago(config.activitiesPollMs * 4);
  state.errors.library = 'AUTH: SIMKL rejected the token (401)';
  assert.equal(state.health.ok, false);
  assert.equal(state.health.stale, true);
});

// The two timers are independent, so neither may clear the other's failure.
test('a calendar success does not erase a library failure', () => {
  const state = rendered();
  state.errors.library = 'AUTH: SIMKL rejected the token (401)';
  state.errors.calendar = null; // as if a calendar refresh just succeeded

  assert.equal(state.health.lastError, 'AUTH: SIMKL rejected the token (401)');
  assert.equal(state.health.errors.library, 'AUTH: SIMKL rejected the token (401)');
});

test('a library failure outranks a calendar one in the headline error', () => {
  const state = rendered();
  state.errors.calendar = 'calendar boom';
  assert.equal(state.health.lastError, 'calendar boom');
  state.errors.library = 'library boom';
  assert.equal(state.health.lastError, 'library boom');
});

test('stale calendars go unhealthy', () => {
  const state = rendered();
  state.calendarsFreshAt = ago(config.calendarRefreshMs * 4);
  assert.equal(state.health.ok, false);
});

// fetchCached serves its cache on any CDN failure, so refresh attempts keep
// "succeeding". Health is keyed on when the CDN last actually answered.
test('a CDN outage is unhealthy even though refreshes keep "succeeding"', () => {
  const state = rendered();
  state.calendarsAt = new Date().toISOString(); // attempts keep happening...
  state.calendarsFreshAt = ago(config.calendarRefreshMs * 4); // ...but nothing fresh
  assert.equal(state.health.ok, false);
  assert.equal(state.health.stale, true);
});

// safeRender records a failure and returns, leaving the previous feed serving.
// One malformed calendar entry is enough, so `ok` must consult errors.render.
test('a render that keeps failing is unhealthy', () => {
  const state = rendered();
  assert.equal(state.health.ok, true, 'precondition');
  state.errors.render = 'Invalid time value';
  assert.equal(state.health.ok, false);
  assert.equal(state.health.lastError, 'Invalid time value');
});

// Renders happen on every calendar refresh, so a renderedAt that stops advancing
// means rendering has stopped even when nothing reported an error.
test('a feed that has stopped rendering is unhealthy', () => {
  const state = rendered();
  state.renderedAt = ago(config.calendarRefreshMs * 4);
  assert.equal(state.health.ok, false);
  assert.equal(state.health.stale, true);
});

// With per-list gating libraryAt only advances when something actually changes,
// so an old value is normal and must not be read as a fault.
test('an old library sync time alone does not mean unhealthy', () => {
  const state = rendered();
  state.libraryAt = ago(30 * 24 * 60 * 60 * 1000);
  assert.equal(state.health.ok, true);
});

// readToken only swallows ENOENT, so a truncated token.json throws — from a
// timer, that would take the process down.
test('an unreadable token file degrades the feed rather than throwing', async () => {
  await withTempDataDir(async (dir) => {
    await writeFile(join(dir, 'token.json'), '{ truncated');
    const state = new FeedState({ logger: quiet });
    await state.refreshLibraryIfChanged();
    assert.ok(state.errors.library, 'the failure is recorded');
    assert.match(state.errors.library, /library:/);
  });
});

// On values, not key presence — tsc already proves the fields exist.
test('health reports the timestamps a human would want', () => {
  const state = rendered();
  state.events = [];
  const health = state.health;

  assert.equal(health.events, 0);
  assert.equal(health.timezone, config.timezone);
  assert.equal(health.calendarsRefreshedAt, state.calendarsAt);
  assert.equal(health.calendarsFreshAt, state.calendarsFreshAt);
  assert.equal(health.librarySyncedAt, state.libraryAt);
  assert.equal(health.lastPolledAt, state.polledAt);
  assert.equal(health.renderedAt, state.renderedAt);
  assert.equal(health.servingCached, false);
});

test('the event count reflects what was actually joined', () => {
  const state = rendered();
  state.calendars = emptyCalendars();
  state.library = { shows_watching: {} };
  state.render();
  assert.equal(state.health.events, 0);
});
