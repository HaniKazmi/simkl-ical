import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchShowCertificates } from '../../../src/sheet/io/tmdb-tv.ts';
import { jsonResponse, withConfig, withFetch } from '../../helpers.ts';

/**
 * A configured TMDB. Host-qualified: `/tv/` alone matches SIMKL's per-title
 * endpoint and TVDB's, and answering one upstream with another's body makes a
 * test assert nothing.
 */
const withTmdb = (
  respond: (url: string, init?: RequestInit) => Response,
  fn: (calls: string[]) => Promise<void>,
): Promise<void> =>
  withConfig({ tmdbApiKey: 'v4-token' }, () =>
    withFetch((url, init) => {
      if (!url.startsWith('https://api.themoviedb.org/3/tv/')) throw new Error(`unexpected request: ${url}`);
      return respond(url, init);
    }, fn));

const ratings = (...results: { iso_3166_1: string; rating: string }[]) =>
  jsonResponse({ name: 'Severance', content_ratings: { results } });

test('a series resolves to its payload, keyed by the SIMKL id', async () => {
  await withTmdb(
    () => ratings({ iso_3166_1: 'GB', rating: '15' }),
    async (calls) => {
      const out = await fetchShowCertificates([{ id: 7, tmdbId: 95396 }]);
      assert.equal(out.shows.get(7)?.content_ratings?.results?.[0]?.rating, '15');
      assert.deepEqual(out.failed, []);
      // The ratings are appended rather than fetched separately: a row's
      // certificate costs one request, not two.
      assert.deepEqual(calls, ['https://api.themoviedb.org/3/tv/95396?append_to_response=content_ratings']);
    },
  );
});

// The v4 read access token is a bearer. As `?api_key=` it would land in the
// paths `describeUrl` prints onto the status page.
test('the credential travels as a bearer header, never in the path', async () => {
  let authorization: string | null = null;
  await withTmdb(
    (_url, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      return ratings({ iso_3166_1: 'GB', rating: '15' });
    },
    async (calls) => {
      await fetchShowCertificates([{ id: 7, tmdbId: 95396 }]);
      assert.equal(authorization, 'Bearer v4-token');
      assert.ok(!calls.some((call) => call.includes('v4-token')), calls.join(' '));
    },
  );
});

test('a 503 leaves the key absent and asks to be retried', async () => {
  await withTmdb(
    () => new Response('busy', { status: 503 }),
    async () => {
      const out = await fetchShowCertificates([{ id: 7, tmdbId: 95396 }]);
      assert.equal(out.shows.has(7), false);
      assert.deepEqual(out.failed, [7]);
    },
  );
});

test('a series TMDB does not know is unavailable rather than failed', async () => {
  await withTmdb(
    () => new Response('nope', { status: 404 }),
    async () => {
      const out = await fetchShowCertificates([{ id: 7, tmdbId: 95396 }]);
      assert.deepEqual(out.unavailable, [7]);
      assert.deepEqual(out.failed, []);
    },
  );
});

// A rejected token is no fact about any one series, so it escapes rather than
// filing as "this series has no certificate"; the caller classifies it.
test('a rejected credential escapes instead of poisoning one series', async () => {
  await withTmdb(
    () => new Response(JSON.stringify({ status_message: 'Invalid API key' }), { status: 401 }),
    async () => {
      await assert.rejects(() => fetchShowCertificates([{ id: 7, tmdbId: 95396 }]));
    },
  );
});

test('two requests for one title cost one call', async () => {
  await withTmdb(
    () => ratings({ iso_3166_1: 'GB', rating: '15' }),
    async (calls) => {
      await fetchShowCertificates([{ id: 7, tmdbId: 95396 }, { id: 7, tmdbId: 95396 }]);
      assert.equal(calls.length, 1);
    },
  );
});
