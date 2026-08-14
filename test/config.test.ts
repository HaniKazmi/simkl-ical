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

// config is built once at import from process.env, so the parsing can only be
// exercised in a fresh process. Cheap enough, and it tests the real path rather
// than a re-implementation of it.
const configWith = async (env: Record<string, string>): Promise<Record<string, number>> => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', "const {config} = await import(process.env.CONFIG_PATH); console.log(JSON.stringify(config));"],
    { env: { ...process.env, ...env, CONFIG_PATH: new URL('../src/config.ts', import.meta.url).href }, encoding: 'utf8' },
  );
  return JSON.parse(out);
};

// PORT=0 is the standard "bind an ephemeral port" idiom. Clamping the minimum
// to 1 silently rewrote it to a port the unprivileged container user cannot
// bind — a crash loop on EACCES with no hint that the value had been changed.
test('PORT=0 is preserved, not clamped up to 1', async () => {
  assert.equal((await configWith({ PORT: '0' })).port, 0);
});

test('out-of-range numbers are corrected rather than fatal', async () => {
  assert.equal((await configWith({ GRACE_DAYS: '-5' })).graceDays, 0);
  assert.equal((await configWith({ GRACE_DAYS: '400' })).graceDays, 90);
  assert.equal((await configWith({ CALENDAR_REFRESH_MS: '0' })).calendarRefreshMs, 60_000);
  assert.equal((await configWith({ PORT: '99999' })).port, 65535);
});

test('an unparseable number falls back to the default', async () => {
  assert.equal((await configWith({ GRACE_DAYS: 'soon' })).graceDays, 14);
  assert.equal((await configWith({ GRACE_DAYS: '' })).graceDays, 14);
});
