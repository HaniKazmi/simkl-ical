import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedState } from '../src/refresh.ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/config.ts';
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

// The bug this guards: `ok` used to be `renderedAt !== null`, which never went
// false again. A revoked token then read as healthy indefinitely.
test('a feed that has stopped polling goes unhealthy', () => {
  const state = rendered();
  state.polledAt = ago(config.activitiesPollMs * 4);
  state.errors.library = 'AUTH: SIMKL rejected the token (401)';
  assert.equal(state.health.ok, false);
  assert.equal(state.health.stale, true);
});

// The two timers are independent. A shared error slot meant each cleared the
// other's failure, leaving health unhealthy with no stated reason.
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

// The bug this guards: fetchCached falls back to its cache on any CDN failure
// and returned it as a success, so refreshCalendars advanced calendarsAt and
// cleared errors.calendar on every cycle. A CDN down for a month therefore read
// as perfectly healthy while the feed quietly emptied out. Health is now keyed
// on when the CDN last actually answered, which the fallback does not advance.
test('a CDN outage is unhealthy even though refreshes keep "succeeding"', () => {
  const state = rendered();
  state.calendarsAt = new Date().toISOString(); // attempts keep happening...
  state.calendarsFreshAt = ago(config.calendarRefreshMs * 4); // ...but nothing fresh
  assert.equal(state.health.ok, false);
  assert.equal(state.health.stale, true);
});

// The other half of the same class: safeRender catches, records the failure and
// returns, leaving the previous feed serving forever. `ok` ignored errors.render
// entirely, so one malformed calendar entry froze the feed behind a green check.
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

// readToken only swallows ENOENT. A truncated token.json threw SyntaxError
// straight out of the method, and from the timer that killed the process.
test('an unreadable token file degrades the feed rather than throwing', async () => {
  await withTempDataDir(async (dir) => {
    await writeFile(join(dir, 'token.json'), '{ truncated');
    const state = new FeedState({ logger: quiet });
    await state.refreshLibraryIfChanged();
    assert.ok(state.errors.library, 'the failure is recorded');
    assert.match(state.errors.library, /library:/);
  });
});

// Asserting on values, not on key presence: `tsc` already proves the Health
// interface has these fields, so checking `key in health` proved nothing that
// the typechecker had not, and passed with every value null or swapped.
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
