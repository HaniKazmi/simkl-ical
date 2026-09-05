import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedImageUrl, fetchImage, ImageError } from '../../src/api/images.ts';
import { clearRequests, recentRequests } from '../../src/api/requests.ts';
import { withFetch } from '../helpers.ts';
import { fakeBucket, JPEG } from '../artwork/fake-bucket.ts';

const TMDB = 'https://image.tmdb.org/t/p/w1280/abc.jpg';

// The URL can come from a hand-edited cell, so the check runs before any
// request leaves — a refused host makes no fetch at all.
test('a host off the allowlist is refused before any request is made', async () => {
  await withFetch(
    () => {
      throw new Error('should not fetch');
    },
    async (calls) => {
      for (const bad of ['https://example.com/x.jpg', 'http://image.tmdb.org/t/p/w1280/abc.jpg', 'https://wsrv.nl/?url=x', 'not a url', '']) {
        await assert.rejects(() => fetchImage(bad, { component: 'artwork' }), ImageError, bad);
      }
      assert.deepEqual(calls, []);
    },
  );
  assert.equal(allowedImageUrl(TMDB)?.hostname, 'image.tmdb.org');
  assert.equal(allowedImageUrl('https://artworks.thetvdb.com/banners/v4/series/1/posters/2.jpg')?.hostname, 'artworks.thetvdb.com');
  assert.equal(allowedImageUrl('https://image.tmdb.org.evil.example/x'), null);
});

test('an image comes back with the CDN\'s content type, logged under the images service', async () => {
  clearRequests();
  const cdn = fakeBucket({ images: { [TMDB]: { bytes: JPEG, contentType: 'image/jpeg; charset=binary' } } });
  await withFetch(cdn.handler, async () => {
    const got = await fetchImage(TMDB, { component: 'artwork' });
    assert.deepEqual([...got.bytes], [...JPEG]);
    assert.equal(got.contentType, 'image/jpeg');
    assert.deepEqual(recentRequests().map((r) => [r.service, r.component, r.status, r.bytes]), [['images', 'artwork', 200, JPEG.byteLength]]);
  });
});

// A CDN answering a 200 with an HTML error page is the one that would put a
// web page in the bucket under an image's name.
test('a 200 that is not an image is refused', async () => {
  await withFetch(
    () => new Response('<html>nope</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    async () => {
      await assert.rejects(() => fetchImage(TMDB, { component: 'artwork' }), (err: unknown) => err instanceof ImageError && /text\/html, not an image/.test(err.message));
    },
  );
  await withFetch(
    () => new Response(JPEG, { status: 200 }),
    async () => {
      await assert.rejects(() => fetchImage(TMDB, { component: 'artwork' }), /no content type, not an image/);
    },
  );
});

test('a 404 is terminal and a 503 is retried', async () => {
  await withFetch(
    () => new Response('gone', { status: 404 }),
    async (calls) => {
      await assert.rejects(() => fetchImage(TMDB, { component: 'artwork' }), (err: unknown) => err instanceof ImageError && err.status === 404);
      assert.equal(calls.length, 1);
    },
  );
  let n = 0;
  await withFetch(
    () => (++n === 1 ? new Response('busy', { status: 503 }) : new Response(JPEG, { status: 200, headers: { 'content-type': 'image/png' } })),
    async (calls) => {
      assert.equal((await fetchImage(TMDB, { component: 'artwork' })).contentType, 'image/png');
      assert.equal(calls.length, 2);
    },
  );
});

test('an over-size body is refused by the transport, under the caller\'s limit', async () => {
  await withFetch(
    () => new Response(new Uint8Array(100), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '100' } }),
    async () => {
      await assert.rejects(() => fetchImage(TMDB, { component: 'artwork', maxBytes: 50 }), /over the 50 byte limit/);
    },
  );
});
