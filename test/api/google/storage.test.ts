import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listObjects, StorageAccessError, StorageError, uploadObject } from '../../../src/api/google/storage.ts';
import { clearTokenCache, getAccessToken, SCOPES } from '../../../src/api/google/auth.ts';
import { clearRequests, recentRequests } from '../../../src/api/requests.ts';
import { withConfig, withFetch } from '../../helpers.ts';
import { CREDENTIAL } from '../../sheet/fake-sheets.ts';
import { fakeBucket, JPEG, type FakeBucketOptions } from '../../artwork/fake-bucket.ts';

const withStorage = async (options: FakeBucketOptions, fn: (bucket: ReturnType<typeof fakeBucket>, calls: string[]) => Promise<void>): Promise<void> => {
  clearTokenCache();
  clearRequests();
  const bucket = fakeBucket(options);
  await withConfig({ googleKeyBase64: CREDENTIAL }, () => withFetch(bucket.handler, (calls) => fn(bucket, calls)));
  clearTokenCache();
};

const UPLOAD = { component: 'artwork' as const, contentType: 'image/jpeg', cacheControl: 'public, max-age=300', publicRead: false };

test('a listing walks every page and keys objects by name', async () => {
  const objects = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((name) => [name, { bytes: JPEG, contentType: 'image/jpeg' }]));
  await withStorage({ buckets: { movies: objects }, pageSize: 2 }, async (bucket) => {
    const listed = await listObjects('movies', { component: 'artwork' });
    assert.deepEqual([...listed.keys()], ['A', 'B', 'C', 'D', 'E']);
    assert.equal(listed.get('A')?.size, JPEG.byteLength);
    assert.equal(listed.get('A')?.updated?.toString(), '2026-08-01T00:00:00Z');
    assert.equal(bucket.listings, 3);
  });
});

test('an upload is multipart with the metadata the site depends on, and checks what was stored', async () => {
  await withStorage({ buckets: { movies: {} } }, async (bucket) => {
    const stored = await uploadObject('movies', 'Finding Nemo', JPEG, UPLOAD);
    assert.deepEqual(stored, { bucket: 'movies', key: 'Finding Nemo', bytes: JPEG.byteLength, contentType: 'image/jpeg' });
    assert.deepEqual(bucket.uploads, [{ bucket: 'movies', key: 'Finding Nemo', contentType: 'image/jpeg', cacheControl: 'public, max-age=300', predefinedAcl: null, bytes: JPEG.byteLength }]);
    assert.deepEqual([...bucket.objects('movies').get('Finding Nemo')!.bytes], [...JPEG]);
    // The storage exchange is its own scope, logged under its own service.
    assert.deepEqual(
      recentRequests().map((r) => [r.service, r.component, r.method]),
      [
        ['storage', 'artwork', 'POST'],
        ['storage', 'auth', 'POST'],
      ],
    );
  });
});

test('public read is asked for on the object only when told to', async () => {
  await withStorage({ buckets: { movies: {} } }, async (bucket) => {
    await uploadObject('movies', 'x', JPEG, { ...UPLOAD, publicRead: true });
    assert.equal(bucket.uploads[0]?.predefinedAcl, 'publicRead');
  });
});

test('a stored object that does not match what was sent is an error, not a success', async () => {
  await withStorage({ buckets: { movies: {} }, corruptMd5: true }, async () => {
    await assert.rejects(() => uploadObject('movies', 'x', JPEG, UPLOAD), (err: unknown) => err instanceof StorageError && /md5/.test(err.message));
  });
});

test('a 403 names the grant, a 404 the bucket, and a 401 drops the token', async () => {
  await withStorage({ storageStatus: 403 }, async () => {
    await assert.rejects(
      () => uploadObject('movies', 'x', JPEG, UPLOAD),
      (err: unknown) => err instanceof StorageAccessError && err.needsHuman && /roles\/storage\.objectAdmin/.test(err.message),
    );
  });
  await withStorage({ buckets: {} }, async () => {
    await assert.rejects(() => listObjects('nope', { component: 'artwork' }), (err: unknown) => err instanceof StorageAccessError && /bucket name/.test(err.message));
  });
  await withStorage({ storageStatus: 401 }, async (_bucket, calls) => {
    await getAccessToken({ scope: SCOPES.storage });
    await assert.rejects(() => listObjects('movies', { component: 'artwork' }), (err: unknown) => err instanceof StorageAccessError && !err.needsHuman);
    await getAccessToken({ scope: SCOPES.storage });
    assert.equal(calls.filter((c) => c.includes('oauth2')).length, 2, 'the 401 dropped the cached token');
  });
});

test('a transient failure on an upload is retried — a re-send puts the same bytes under the same key', async () => {
  await withStorage({ buckets: { movies: {} }, failUpload: { call: 1, status: 503 } }, async (bucket) => {
    await uploadObject('movies', 'x', JPEG, UPLOAD);
    assert.equal(bucket.uploads.length, 2);
    assert.deepEqual([...bucket.objects('movies').keys()], ['x']);
  });
});
