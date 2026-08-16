import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { buildConfig, config, requireClientId, requireValidTimezone, sheetSyncConfigured } from '../../src/shared/config.ts';
import { withTimeout } from '../../src/shared/signals.ts';
import { withConfig } from '../helpers.ts';

test('a bad timezone is rejected with an actionable message', () => {
  assert.throws(() => requireValidTimezone('Mars/Olympus_Mons'), /not a valid IANA timezone/);
  assert.throws(() => requireValidTimezone('Europe-London'), /Try e\.g\./);
});

test('a good timezone passes through unchanged', () => {
  assert.equal(requireValidTimezone('America/New_York'), 'America/New_York');
  assert.equal(requireValidTimezone('UTC'), 'UTC');
});

test('a missing client id says which file to fill in', async () => {
  await withConfig({ clientId: undefined }, () => {
    assert.throws(() => requireClientId(), /SIMKL_CLIENT_ID is not set.*\.env/s);
  });
});

// --- parsing and clamping -------------------------------------------------

// Through buildConfig directly, so no child process is needed. Every one of
// these breaks the service quietly if left unbounded.
test('the intervals cannot be set low enough to hammer the APIs', () => {
  const c = buildConfig({ CALENDAR_REFRESH_MS: '0', ACTIVITIES_POLL_MS: '-1', MOVIE_REFRESH_MS: '10' });
  assert.equal(c.calendarRefreshMs, 60_000, 'a zero interval is a tight loop against the CDN');
  assert.equal(c.activitiesPollMs, 60_000);
  assert.equal(c.movieRefreshMs, 60_000);
});

test('the grace window stays in a range the archives can serve', () => {
  assert.equal(buildConfig({ GRACE_DAYS: '-5' }).graceDays, 0, 'a negative window empties the feed');
  assert.equal(buildConfig({ GRACE_DAYS: '400' }).graceDays, 90, 'each extra month is another multi-MB archive');
});

// PORT=0 is the standard "bind an ephemeral port" idiom; clamping it to 1
// would give the container a port its unprivileged user cannot bind.
test('PORT=0 is preserved, not clamped up to 1', () => {
  assert.equal(buildConfig({ PORT: '0' }).port, 0);
  assert.equal(buildConfig({ PORT: '99999' }).port, 65535);
});

test('an unparseable number falls back to the default', () => {
  assert.equal(buildConfig({ GRACE_DAYS: 'soon' }).graceDays, 14);
  assert.equal(buildConfig({ GRACE_DAYS: '' }).graceDays, 14);
});

test('an unset environment yields the documented defaults', () => {
  const c = buildConfig({});
  assert.equal(c.timezone, 'Europe/London');
  assert.equal(c.releaseCountry, 'GB');
  assert.equal(c.graceDays, 14);
  assert.equal(c.port, 3000);
});

// A shell expands `~` before the process sees it; a value read from .env or a
// compose file arrives verbatim, and .env.example suggests exactly that path.
test('a leading ~ in the credential path is expanded', () => {
  const home = homedir();
  assert.equal(buildConfig({ GOOGLE_APPLICATION_CREDENTIALS: '~/keys/sa.json' }).googleCredentialsPath, resolve(home, 'keys/sa.json'));
  assert.equal(buildConfig({ GOOGLE_APPLICATION_CREDENTIALS: '~' }).googleCredentialsPath, home);
  // Only a leading one, and only as a path segment.
  assert.equal(buildConfig({ GOOGLE_APPLICATION_CREDENTIALS: '/etc/~/sa.json' }).googleCredentialsPath, '/etc/~/sa.json');
});

// SIMKL is told this in every request, so it must not drift from the package.
test('the reported version matches package.json', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(config.appVersion, pkg.version);
});

// --- cancellation ---------------------------------------------------------

// `signal ?? AbortSignal.timeout(ms)` reads as a default but is an override,
// dropping the timeout whenever a caller passes a signal.
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

// --- the sheet sync -------------------------------------------------------

test('an unrecognised sheet sync mode clamps to report, never to apply', () => {
  assert.equal(buildConfig({ SHEET_SYNC_MODE: 'apply' }).sheetSyncMode, 'apply');
  assert.equal(buildConfig({ SHEET_SYNC_MODE: ' APPLY ' }).sheetSyncMode, 'apply');
  assert.equal(buildConfig({}).sheetSyncMode, 'report');
  // The failure of a typo must be an inert run, not an unintended one.
  for (const typo of ['aply', 'write', 'yes', '']) {
    assert.equal(buildConfig({ SHEET_SYNC_MODE: typo }).sheetSyncMode, 'report', typo);
  }
});

// The credentials path has a default, so testing it for truthiness would report
// "a credential was supplied" on every machine — and file an ENOENT per poll.
test('the sync needs a target and a credential that was actually supplied', () => {
  const on = (env: NodeJS.ProcessEnv) => sheetSyncConfigured(buildConfig({ SHEET_ID: 'SID', ...env }));
  assert.equal(on({}), false, 'a default credentials path is not a supplied credential');
  assert.equal(on({ GOOGLE_SA_KEY_B64: 'x' }), true);
  assert.equal(on({ GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa.json' }), true);
  assert.equal(on({ GOOGLE_SA_KEY_B64: 'x', SHEET_SYNC_MODE: 'off' }), false);
  assert.equal(sheetSyncConfigured(buildConfig({ GOOGLE_SA_KEY_B64: 'x' })), false, 'no SHEET_ID');
});

test('the sheet limits are clamped rather than fatal', () => {
  assert.equal(buildConfig({ SHEET_MAX_EDITS: '0' }).sheetMaxEdits, 1);
  assert.equal(buildConfig({ SHEET_SINCE_DAYS: '-5' }).sheetSinceDays, 1);
  assert.equal(buildConfig({ SHEET_SINCE_DAYS: 'soon' }).sheetSinceDays, 90);
});
