import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { config, requireClientId, requireValidTimezone } from '../src/config.ts';
import { withTimeout } from '../src/signals.ts';

// The clamping lives in a module-private `int`, and config is built once at
// import. Rather than re-export the helper purely for tests, these assert the
// properties that matter through the values the service actually uses.

test('a bad timezone is rejected with an actionable message', () => {
  assert.throws(() => requireValidTimezone('Mars/Olympus_Mons'), /not a valid IANA timezone/);
  assert.throws(() => requireValidTimezone('Europe-London'), /Try e\.g\./);
});

test('a good timezone passes through unchanged', () => {
  assert.equal(requireValidTimezone('America/New_York'), 'America/New_York');
  assert.equal(requireValidTimezone('UTC'), 'UTC');
});

test('a missing client id says which file to fill in', () => {
  const original = config.clientId;
  config.clientId = undefined;
  try {
    assert.throws(() => requireClientId(), /SIMKL_CLIENT_ID is not set.*\.env/s);
  } finally {
    config.clientId = original;
  }
});

// Every one of these had a way to break the service quietly if left unbounded.
test('the intervals cannot be set low enough to hammer the APIs', () => {
  assert.ok(config.calendarRefreshMs >= 60_000, 'a zero interval is a tight loop against the CDN');
  assert.ok(config.activitiesPollMs >= 60_000);
  assert.ok(config.movieRefreshMs >= 60_000);
});

test('the grace window stays in a range the archives can serve', () => {
  assert.ok(config.graceDays >= 0, 'a negative window puts the cutoff in the future and empties the feed');
  assert.ok(config.graceDays <= 90, 'each extra month is another multi-MB archive on every refresh');
});

test('the port is a usable one', () => {
  assert.ok(config.port >= 1 && config.port <= 65535);
});

// This was hardcoded '0.1.0' while the repo was tagged v0.2.0, so SIMKL was
// told the wrong version in every request.
test('the reported version matches package.json', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(config.appVersion, pkg.version);
});

// `signal ?? AbortSignal.timeout(ms)` reads as a default but is an override: a
// caller passing a signal silently gave up the timeout.
test('a caller signal does not disable the request timeout', async () => {
  const combined = withTimeout(new AbortController().signal, 10);
  assert.equal(combined.aborted, false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(combined.aborted, true, 'the timeout must still fire');
});

test('a caller signal still cancels', () => {
  const controller = new AbortController();
  const combined = withTimeout(controller.signal, 60_000);
  controller.abort();
  assert.equal(combined.aborted, true);
});

test('with no caller signal the timeout alone applies', async () => {
  const combined = withTimeout(undefined, 10);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(combined.aborted, true);
});
