import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedState } from '../src/refresh.js';
import { config } from '../src/config.js';

const quiet = { info() {}, warn() {}, error() {} };
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const rendered = () => {
  const state = new FeedState({ logger: quiet });
  state.renderedAt = new Date().toISOString();
  state.calendarsAt = new Date().toISOString();
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
  state.lastError = 'AUTH: SIMKL rejected the token (401)';
  assert.equal(state.health.ok, false);
  assert.equal(state.health.stale, true);
});

test('stale calendars go unhealthy', () => {
  const state = rendered();
  state.calendarsAt = ago(config.calendarRefreshMs * 4);
  assert.equal(state.health.ok, false);
});

// With per-list gating libraryAt only advances when something actually changes,
// so an old value is normal and must not be read as a fault.
test('an old library sync time alone does not mean unhealthy', () => {
  const state = rendered();
  state.libraryAt = ago(30 * 24 * 60 * 60 * 1000);
  assert.equal(state.health.ok, true);
});

test('health reports the timestamps a human would want', () => {
  const health = rendered().health;
  for (const key of ['events', 'calendarsRefreshedAt', 'librarySyncedAt', 'lastPolledAt', 'renderedAt', 'timezone']) {
    assert.ok(key in health, `missing ${key}`);
  }
});
