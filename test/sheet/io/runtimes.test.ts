import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSeasonRuntimes, runtimeKeyOf } from '../../../src/sheet/io/runtimes.ts';
import { clearTokenCache } from '../../../src/api/tvdb/auth.ts';
import { jsonResponse, withConfig, withFetch } from '../../helpers.ts';

const season = (...runtimes: Array<number | null>) =>
  jsonResponse({ data: { episodes: runtimes.map((runtime, i) => ({ number: i + 1, runtime })) } });

/**
 * A configured TVDB with the login answered, so each test writes only the
 * season response it is about. The one test that wants the login to fail
 * keeps its own handler.
 */
const withTvdb = (respond: (url: string) => Response, fn: (calls: string[]) => Promise<void>): Promise<void> => {
  clearTokenCache();
  return withConfig({ tvdbApiKey: 'k' }, () =>
    withFetch((url) => (url.endsWith('/login') ? jsonResponse({ data: { token: 't' } }) : respond(url)), fn));
};

const req = (over: Partial<{ id: number; tvdbId: number; season: number }> = {}) => ({ id: 1, tvdbId: 100, season: 2, ...over });
const KEY = runtimeKeyOf(100, 2);

test('a season resolves to its episode list, keyed by tvdb id and season', async () => {
  await withTvdb(
    () => season(24, 24, 27),
    async (calls) => {
      const out = await fetchSeasonRuntimes([req()]);
      assert.deepEqual(out.episodes.get(KEY)?.map((e) => e.runtime), [24, 24, 27]);
      assert.deepEqual(out.failed, []);
      assert.equal(
        calls.find((c) => !c.endsWith('/login')),
        'https://api4.thetvdb.com/v4/series/100/episodes/official?season=2&page=0',
      );
    },
  );
});

// TVDB answers a season it does not have with a 200 and no episodes — the
// commonest "no data" path, and it must settle rather than defer.
test('an empty season is a successful answer, not a failure', async () => {
  await withTvdb(
    () => jsonResponse({ data: { episodes: [] } }),
    async () => {
      const out = await fetchSeasonRuntimes([req()]);
      assert.deepEqual(out.episodes.get(KEY), []);
      assert.deepEqual(out.failed, [], 'settled, so nothing to retry');
    },
  );
});

// A retryable failure leaves the key *absent* — what the caller reads as
// "asked, no answer" and leaves the row open on.
test('a 500 leaves the key absent and asks to be retried', async () => {
  await withTvdb(
    () => new Response('boom', { status: 500 }),
    async () => {
      const out = await fetchSeasonRuntimes([req()]);
      assert.equal(out.episodes.has(KEY), false);
      assert.deepEqual(out.failed, [KEY]);
    },
  );
});

test('an unknown series is unavailable rather than failed — retrying never helps', async () => {
  await withTvdb(
    () => new Response('nope', { status: 404 }),
    async () => {
      const out = await fetchSeasonRuntimes([req()]);
      assert.deepEqual(out.unavailable, [KEY]);
      assert.deepEqual(out.failed, []);
    },
  );
});

// An account failure is no fact about any one season, so it escapes rather
// than filing as "this season is unavailable"; `SheetSync` catches it.
test('a rejected credential escapes instead of poisoning one season', async () => {
  clearTokenCache();
  await withConfig({ tvdbApiKey: 'k' }, () =>
    withFetch(
      () => new Response(JSON.stringify({ message: 'InvalidAPIKey' }), { status: 401 }),
      async () => {
        await assert.rejects(() => fetchSeasonRuntimes([req()]));
      },
    ),
  );
});

test('two rows naming the same title and season cost one call', async () => {
  await withTvdb(
    () => season(24, 24, 24),
    async (calls) => {
      await fetchSeasonRuntimes([req(), req({ id: 2 })]);
      assert.equal(calls.filter((c) => !c.endsWith('/login')).length, 1);
    },
  );
});

// Four workers start at once; without the shared login each would log in
// separately before its own season read.
test('a cold cache logs in once however many seasons are read at once', async () => {
  await withTvdb(
    () => season(24, 24, 24),
    async (calls) => {
      await fetchSeasonRuntimes([1, 2, 3, 4, 5, 6].map((n) => req({ id: n, tvdbId: 100 + n })));
      assert.equal(calls.filter((c) => c.endsWith('/login')).length, 1);
    },
  );
});
