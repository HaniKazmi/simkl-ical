import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiGet, classify, TmdbError } from '../../../src/api/tmdb/client.ts';
import { jsonResponse, withConfig, withFetch } from '../../helpers.ts';

const get = (handler: Parameters<typeof withFetch>[0], fn: (calls: string[]) => Promise<void>) =>
  withConfig({ tmdbApiKey: 'v4-read-token' }, () => withFetch(handler, fn));

test('the credential rides in a header, never the query string', async () => {
  // `describeUrl` renders request paths onto the status page and the request
  // log, so a credential in the query would be printed there.
  await get(
    (url, init) => {
      assert.equal(new URL(url).searchParams.get('api_key'), null);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer v4-read-token');
      return jsonResponse({ title: 'Dune' });
    },
    async (calls) => {
      await apiGet('/movie/438631', { component: 'movie-catalogue' });
      assert.equal(calls.length, 1);
      assert.ok(!calls[0]?.includes('v4-read-token'));
    },
  );
});

test('the appended sub-resources ride in the query, so a row costs one request', async () => {
  await get(
    (url) => {
      const params = new URL(url).searchParams;
      assert.equal(params.get('append_to_response'), 'release_dates,credits,images');
      assert.equal(params.get('include_image_language'), 'en');
      return jsonResponse({});
    },
    async () => {
      await apiGet('/movie/1', {
        component: 'movie-catalogue',
        params: { append_to_response: 'release_dates,credits,images', include_image_language: 'en' },
      });
    },
  );
});

test('no token means no request at all, not a rejected one', async () => {
  await withConfig({ tmdbApiKey: undefined }, () =>
    withFetch(
      () => {
        throw new Error('should not have been called');
      },
      async (calls) => {
        await assert.rejects(() => apiGet('/movie/1', { component: 'movie-catalogue' }), /TMDB_API_KEY is not set/);
        assert.deepEqual(calls, []);
      },
    ),
  );
});

test('a 503 is retried and then reported', async () => {
  let attempts = 0;
  await get(
    () => {
      attempts += 1;
      return new Response('{"status_message":"boom"}', { status: 503 });
    },
    async () => {
      await assert.rejects(() => apiGet('/movie/1', { component: 'movie-catalogue' }), TmdbError);
      // Two attempts, below the other clients' budgets: this phase sits inside
      // a sheet run whose snapshot goes stale at 120s.
      assert.equal(attempts, 2);
    },
  );
});

test('a 404 is not retried — TMDB not knowing a film is a settled answer', async () => {
  let attempts = 0;
  await get(
    () => {
      attempts += 1;
      return new Response('{"status_message":"not found"}', { status: 404 });
    },
    async () => {
      await assert.rejects(() => apiGet('/movie/1', { component: 'movie-catalogue' }), TmdbError);
      assert.equal(attempts, 1);
    },
  );
});

test('the failure classes separate a dead film from a dead credential', () => {
  assert.equal(classify(new TmdbError('gone', 404)), 'gone');
  assert.equal(classify(new TmdbError('bad token', 401)), 'account');
  // Not `account`: TMDB answers a throttled or blocked request with 403, and
  // `account` settles every pending film as permanently unbuildable for the
  // life of the process.
  assert.equal(classify(new TmdbError('forbidden', 403)), 'transient');
  assert.equal(classify(new TmdbError('boom', 503)), 'transient');
  // A transport failure carries no status, and settling every film on one
  // would strand three hundred rows over one bad minute.
  assert.equal(classify(new Error('socket hang up')), 'transient');
});
