import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSeriesGenres } from '../../../src/sheet/io/tvdb-series.ts';
import { clearTokenCache } from '../../../src/api/tvdb/auth.ts';
import { jsonResponse, withConfig, withFetch, withTvdb } from '../../helpers.ts';

const series = (...names: string[]) =>
  jsonResponse({ data: { genres: names.map((name, i) => ({ id: i + 1, name })) } });

const seriesCalls = (calls: string[]) => calls.filter((c) => c.includes('/series/'));

test('a series resolves to its genre names in the order sent, keyed by the SIMKL id', async () => {
  await withTvdb(
    () => series('Science Fiction', 'Drama', 'Adventure'),
    async (calls) => {
      const out = await fetchSeriesGenres([{ id: 7, tvdbId: 100 }]);
      // Raw names, not the tab's vocabulary: the reduction is a rule about the
      // sheet and happens at fold time.
      assert.deepEqual(out.genres.get(7), ['Science Fiction', 'Drama', 'Adventure']);
      assert.deepEqual(out.failed, []);
      assert.deepEqual(seriesCalls(calls), ['https://api4.thetvdb.com/v4/series/100/extended']);
    },
  );
});

// An empty list is a series TVDB files under nothing — settled, and distinct
// from a lookup that has not answered.
test('a series with no genres answers an empty list rather than an absent key', async () => {
  await withTvdb(
    () => jsonResponse({ data: { genres: [] } }),
    async () => {
      const out = await fetchSeriesGenres([{ id: 7, tvdbId: 100 }]);
      assert.deepEqual(out.genres.get(7), []);
      assert.deepEqual(out.failed, []);
    },
  );
});

test('a 503 leaves the key absent and asks to be retried', async () => {
  await withTvdb(
    () => new Response('busy', { status: 503 }),
    async () => {
      const out = await fetchSeriesGenres([{ id: 7, tvdbId: 100 }]);
      assert.equal(out.genres.has(7), false);
      assert.deepEqual(out.failed, [7]);
    },
  );
});

test('an unknown series is unavailable rather than failed — retrying never helps', async () => {
  await withTvdb(
    () => new Response('nope', { status: 404 }),
    async () => {
      const out = await fetchSeriesGenres([{ id: 7, tvdbId: 100 }]);
      assert.deepEqual(out.unavailable, [7]);
      assert.deepEqual(out.failed, []);
    },
  );
});

// An account failure is no fact about any one series, so it escapes rather
// than filing as "this series has no genres"; the caller classifies it.
test('a rejected credential escapes instead of poisoning one series', async () => {
  clearTokenCache();
  await withConfig({ tvdbApiKey: 'k' }, () =>
    withFetch(
      (url) => {
        assert.ok(url.startsWith('https://api4.thetvdb.com/v4/'), url);
        return new Response(JSON.stringify({ message: 'InvalidAPIKey' }), { status: 401 });
      },
      async () => {
        await assert.rejects(() => fetchSeriesGenres([{ id: 7, tvdbId: 100 }]));
      },
    ),
  );
});

test('two requests for one title cost one call', async () => {
  await withTvdb(
    () => series('Drama'),
    async (calls) => {
      await fetchSeriesGenres([{ id: 7, tvdbId: 100 }, { id: 7, tvdbId: 100 }]);
      assert.equal(seriesCalls(calls).length, 1);
    },
  );
});
