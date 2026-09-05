import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedImageUrl, fetchImage, ImageError, isPublicAddress } from '../../src/api/images.ts';
import { clearRequests, recentRequests } from '../../src/api/requests.ts';
import { withFetch } from '../helpers.ts';
import { fakeBucket, JPEG } from '../artwork/fake-bucket.ts';

const TMDB = 'https://image.tmdb.org/t/p/w1280/abc.jpg';

/** A resolver that answers every name with public addresses, so no test reaches DNS. */
const publicDns = async () => ['203.0.113.10', '2001:db8::10'];

// The URL can come from a hand-edited cell, so the shape is checked before
// any request leaves — and the resolver's answer too, since the point of
// adopting is to copy whatever the sheet links, and what the sheet must not
// be able to do is point this process at its own network.
test('a URL that is not https, or names a private address, is refused before any request', async () => {
  await withFetch(
    () => {
      throw new Error('should not fetch');
    },
    async (calls) => {
      for (const bad of ['http://image.tmdb.org/t/p/w1280/abc.jpg', 'https://127.0.0.1/x.jpg', 'https://10.1.2.3/x.jpg', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x.jpg', 'not a url', '']) {
        await assert.rejects(() => fetchImage(bad, { component: 'artwork', resolve: publicDns }), ImageError, bad);
      }
      await assert.rejects(() => fetchImage('https://internal.example/x.jpg', { component: 'artwork', resolve: async () => ['192.168.1.5'] }), /private or local address/);
      await assert.rejects(() => fetchImage('https://internal.example/x.jpg', { component: 'artwork', resolve: async () => ['203.0.113.1', '10.0.0.1'] }), /private or local address/, 'one private answer among public ones is enough to refuse');
      await assert.rejects(() => fetchImage('https://nowhere.example/x.jpg', { component: 'artwork', resolve: async () => [] }), /private or local address/);
      await assert.rejects(
        () =>
          fetchImage('https://gone.example/x.jpg', {
            component: 'artwork',
            resolve: async () => {
              throw new Error('ENOTFOUND');
            },
          }),
        /does not resolve/,
      );
      assert.deepEqual(calls, []);
    },
  );
  assert.equal(allowedImageUrl(TMDB)?.hostname, 'image.tmdb.org');
  assert.equal(allowedImageUrl('https://any.public.example/poster.png')?.hostname, 'any.public.example');
  assert.equal(allowedImageUrl('https://203.0.113.9/x.jpg')?.hostname, '203.0.113.9', 'a public literal address is allowed');
  assert.equal(allowedImageUrl('https://192.168.0.1/x.jpg'), null);
  assert.equal(allowedImageUrl('http://any.example/x.jpg'), null);
});

test('the public-address test knows the private, local and reserved ranges', () => {
  for (const ip of ['8.8.8.8', '203.0.113.1', '2001:db8::1', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'garbage']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress('172.32.0.1'), true, 'the private block ends at 172.31');
});

test('an image comes back with the host\'s content type, logged under the images service', async () => {
  clearRequests();
  const cdn = fakeBucket({ images: { [TMDB]: { bytes: JPEG, contentType: 'image/jpeg; charset=binary' } } });
  await withFetch(cdn.handler, async () => {
    const got = await fetchImage(TMDB, { component: 'artwork', resolve: publicDns });
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
      await assert.rejects(() => fetchImage(TMDB, { component: 'artwork', resolve: publicDns }), (err: unknown) => err instanceof ImageError && /text\/html, not an image/.test(err.message));
    },
  );
  await withFetch(
    () => new Response(JPEG, { status: 200 }),
    async () => {
      await assert.rejects(() => fetchImage(TMDB, { component: 'artwork', resolve: publicDns }), /no content type, not an image/);
    },
  );
});

test('a 404 is terminal and a 503 is retried', async () => {
  await withFetch(
    () => new Response('gone', { status: 404 }),
    async (calls) => {
      await assert.rejects(() => fetchImage(TMDB, { component: 'artwork', resolve: publicDns }), (err: unknown) => err instanceof ImageError && err.status === 404);
      assert.equal(calls.length, 1);
    },
  );
  let n = 0;
  await withFetch(
    () => (++n === 1 ? new Response('busy', { status: 503 }) : new Response(JPEG, { status: 200, headers: { 'content-type': 'image/png' } })),
    async (calls) => {
      assert.equal((await fetchImage(TMDB, { component: 'artwork', resolve: publicDns })).contentType, 'image/png');
      assert.equal(calls.length, 2);
    },
  );
});

test('an over-size body is refused by the transport, under the caller\'s limit', async () => {
  await withFetch(
    () => new Response(new Uint8Array(100), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '100' } }),
    async () => {
      await assert.rejects(() => fetchImage(TMDB, { component: 'artwork', maxBytes: 50, resolve: publicDns }), /over the 50 byte limit/);
    },
  );
});

// A redirect is judged by its status rather than followed: followed, the
// bytes would come from wherever the listed host pointed, and the allowlist
// would have covered the first hop only.
test('a redirect from an allowlisted host is refused rather than followed', async () => {
  await withFetch(
    (_url, init) => {
      assert.equal(init?.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/x.jpg' } });
    },
    async (calls) => {
      await assert.rejects(() => fetchImage(TMDB, { component: 'artwork', resolve: publicDns }), (err: unknown) => err instanceof ImageError && err.status === 302 && /redirect/.test(err.message));
      assert.equal(calls.length, 1, 'neither followed nor retried');
    },
  );
});
