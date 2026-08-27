import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSeasonRuntimes, runtimeKeyOf } from '../../../src/sheet/io/runtimes.ts';
import { clearTokenCache } from '../../../src/api/tvdb/auth.ts';
import { jsonResponse, withConfig, withFetch } from '../../helpers.ts';

const season = (...runtimes: Array<number | null>) =>
  jsonResponse({ data: { episodes: runtimes.map((runtime, i) => ({ number: i + 1, runtime })) } });

const withKey = (fn: () => Promise<void>) => withConfig({ tvdbApiKey: 'k' }, fn);
const req = (over: Partial<{ id: number; tvdbId: number; season: number; expected: number }> = {}) =>
  ({ id: 1, tvdbId: 100, season: 2, expected: 3, ...over });

test('a season resolves to its mean, keyed by tvdb id and season', async () => {
  clearTokenCache();
  await withKey(() =>
    withFetch(
      (url) => (url.endsWith('/login') ? jsonResponse({ data: { token: 't' } }) : season(24, 24, 27)),
      async (calls) => {
        const out = await fetchSeasonRuntimes([req()]);
        assert.deepEqual([...out.runtimes], [[runtimeKeyOf(100, 2), 25]]);
        assert.deepEqual(out.failed, []);
        assert.equal(
          calls.find((c) => !c.endsWith('/login')),
          'https://api4.thetvdb.com/v4/series/100/episodes/official?season=2&page=0',
        );
      },
    ),
  );
});

// TVDB answers a season it does not have with a 200 and no episodes, so this is
// the commonest "no data" path and it must settle rather than defer.
test('an empty season records a settled null rather than a failure', async () => {
  clearTokenCache();
  await withKey(() =>
    withFetch(
      (url) => (url.endsWith('/login') ? jsonResponse({ data: { token: 't' } }) : jsonResponse({ data: { episodes: [] } })),
      async () => {
        const out = await fetchSeasonRuntimes([req()]);
        assert.equal(out.runtimes.get(runtimeKeyOf(100, 2)), null);
        assert.deepEqual(out.failed, [], 'settled, so nothing to retry');
      },
    ),
  );
});

test('a count disagreeing with SIMKL settles as null rather than averaging anyway', async () => {
  clearTokenCache();
  await withKey(() =>
    withFetch(
      (url) => (url.endsWith('/login') ? jsonResponse({ data: { token: 't' } }) : season(24, 24)),
      async () => {
        const out = await fetchSeasonRuntimes([req({ expected: 11 })]);
        assert.equal(out.runtimes.get(runtimeKeyOf(100, 2)), null);
      },
    ),
  );
});

// A retryable failure leaves the key *absent*, which is what the planner reads
// as "asked and did not get an answer" and defers the row on.
test('a 500 leaves the key absent and asks to be retried', async () => {
  clearTokenCache();
  await withKey(() =>
    withFetch(
      (url) => (url.endsWith('/login') ? jsonResponse({ data: { token: 't' } }) : new Response('boom', { status: 500 })),
      async () => {
        const out = await fetchSeasonRuntimes([req()]);
        assert.equal(out.runtimes.has(runtimeKeyOf(100, 2)), false);
        assert.deepEqual(out.failed, [runtimeKeyOf(100, 2)]);
      },
    ),
  );
});

test('an unknown series is unavailable rather than failed — retrying never helps', async () => {
  clearTokenCache();
  await withKey(() =>
    withFetch(
      (url) => (url.endsWith('/login') ? jsonResponse({ data: { token: 't' } }) : new Response('nope', { status: 404 })),
      async () => {
        const out = await fetchSeasonRuntimes([req()]);
        assert.deepEqual(out.unavailable, [runtimeKeyOf(100, 2)]);
        assert.deepEqual(out.failed, []);
      },
    ),
  );
});

// An account failure is not a fact about any one season, so it escapes rather
// than being filed as "this season is unavailable".
test('a rejected credential escapes instead of poisoning one season', async () => {
  clearTokenCache();
  await withKey(() =>
    withFetch(
      () => new Response(JSON.stringify({ message: 'InvalidAPIKey' }), { status: 401 }),
      async () => {
        await assert.rejects(() => fetchSeasonRuntimes([req()]));
      },
    ),
  );
});

test('two rows naming the same title and season cost one call', async () => {
  clearTokenCache();
  await withKey(() =>
    withFetch(
      (url) => (url.endsWith('/login') ? jsonResponse({ data: { token: 't' } }) : season(24, 24, 24)),
      async (calls) => {
        await fetchSeasonRuntimes([req(), req({ id: 2 })]);
        assert.equal(calls.filter((c) => !c.endsWith('/login')).length, 1);
      },
    ),
  );
});
