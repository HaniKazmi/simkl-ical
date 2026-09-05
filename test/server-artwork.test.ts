/**
 * The artwork page's four routes, driven end to end over the fakes: the
 * Sheets double with both tabs, the bucket double in front of it, and the two
 * candidate upstreams. What is pinned is the route contract — gating, the
 * header set, the status codes — and the one invariant every token-carrying
 * page shares.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARTWORK_CSP, buildServer } from '../src/server.ts';
import { Artwork } from '../src/artwork/artwork.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { clearTokenCache } from '../src/api/google/auth.ts';
import { clearTokenCache as clearTvdbTokenCache } from '../src/api/tvdb/auth.ts';
import { withSheetLock } from '../src/sheet/io/lock.ts';
import { SheetSync } from '../src/sheet/sync.ts';
import { filmRow, jsonResponse, libraryOf, MOVIE_SHEET_HEADERS, quiet, SHEET_HEADERS, showRow, withConfig, withFetch, withFreshJournal, type CellSpec } from './helpers.ts';
import { CREDENTIAL, fakeSheets, type FakeSheetsOptions } from './sheet/fake-sheets.ts';
import { fakeBucket, JPEG, type FakeBucketOptions } from './artwork/fake-bucket.ts';

const TOKEN = 'a'.repeat(48);
const BACKDROP = 'https://image.tmdb.org/t/p/w1280/nemo.jpg';
const POSTER = 'https://artworks.thetvdb.com/banners/v4/series/371980/posters/1.jpg';

const MOVIES: CellSpec[][] = [
  MOVIE_SHEET_HEADERS,
  [...filmRow({ name: 'Star Wars', id: '53078' }).slice(0, -1), 'https://image.tmdb.org/t/p/w1280/sw.jpg'],
  filmRow({ name: 'Finding Nemo', id: '53080' }),
];
const SHOWS: CellSpec[][] = [
  [...SHEET_HEADERS, 'Banner'],
  [...showRow('Severance', 'Watching', 3381), null],
  [...showRow('Unmapped', 'Watching', 3382), null],
];

const tmdb = (url: string): Response =>
  url.includes('/movie/12/images')
    ? jsonResponse({ backdrops: [{ file_path: '/nemo.jpg', iso_639_1: 'en', width: 1920, height: 1080, vote_average: 7, vote_count: 9 }] })
    : new Response('{}', { status: 404 });
const tvdb = (url: string): Response =>
  url.includes('/series/371980/artworks')
    ? jsonResponse({ data: { artworks: [{ image: POSTER, thumbnail: POSTER.replace('.jpg', '_t.jpg'), language: 'eng', type: 2, score: 100, width: 680, height: 1000 }] } })
    : new Response('{}', { status: 404 });

interface Case {
  configured?: boolean;
  mode?: 'report' | 'apply';
  sheets?: FakeSheetsOptions;
  bucket?: FakeBucketOptions;
}

const serve = async (
  fn: (app: ReturnType<typeof buildServer>, doubles: { sheet: ReturnType<typeof fakeSheets>; bucket: ReturnType<typeof fakeBucket>; calls: string[]; sync: SheetSync }) => Promise<void>,
  { configured = true, mode = 'apply', sheets = {}, bucket = {} }: Case = {},
): Promise<void> => {
  clearTokenCache();
  clearTvdbTokenCache();
  // The SIMKL detail a show without a library TVDB id is asked for on demand.
  const sheet = fakeSheets({ movies: MOVIES, grid: SHOWS, tmdb, tvdb, detail: { ids: { tvdb: '371980' } }, ...sheets });
  const store = fakeBucket({ buckets: { movies: {}, shows: {} }, images: { [BACKDROP]: { bytes: JPEG, contentType: 'image/jpeg' }, [POSTER]: { bytes: JPEG, contentType: 'image/jpeg' } }, next: sheet.handler, ...bucket });
  await withFreshJournal(() =>
    withConfig(
      {
        feedToken: TOKEN,
        sheetId: 'SID',
        sheetSyncMode: mode,
        googleKeyBase64: CREDENTIAL,
        tmdbApiKey: configured ? 'tmdb-key' : undefined,
        tvdbApiKey: configured ? 'tvdb-key' : undefined,
        artworkMovieBucket: configured ? 'movies' : undefined,
        artworkShowBucket: configured ? 'shows' : undefined,
      },
      () =>
        withFetch(store.handler, async (calls) => {
          const state = new Orchestrator({ logger: quiet });
          state.library = libraryOf({ id: 53080, type: 'movies', title: 'Finding Nemo', tmdb: '12' }, { id: 3381, title: 'Severance', tvdb: '371980' }, { id: 3382, title: 'Unmapped' });
          const sync = new SheetSync({ logger: quiet });
          state.sheetSync = sync;
          const app = buildServer(state, { logger: false, artwork: new Artwork(state, { linkWait: Temporal.Duration.from({ milliseconds: 100 }) }) });
          try {
            await fn(app, { sheet, bucket: store, calls, sync });
          } finally {
            await app.close();
          }
        }),
    ),
  );
};

const ROUTES = ['artwork', 'artwork/app.js', 'artwork/candidates?kind=movie&id=53080'];

test('every artwork route is a uniform 404 on a wrong token, and when the feature is off', async () => {
  await serve(async (app) => {
    for (const route of ROUTES) {
      const res = await app.inject({ method: 'GET', url: `/nope/${route}` });
      assert.equal(res.statusCode, 404, route);
      assert.deepEqual(res.json(), { error: 'Not found' });
    }
    assert.equal((await app.inject({ method: 'POST', url: '/nope/artwork/pick', payload: {} })).statusCode, 404);
  });
  await serve(
    async (app, { calls }) => {
      for (const route of ROUTES) {
        const res = await app.inject({ method: 'GET', url: `/${TOKEN}/${route}` });
        assert.equal(res.statusCode, 404, route);
        assert.deepEqual(res.json(), { error: 'Not found' });
      }
      assert.equal((await app.inject({ method: 'POST', url: `/${TOKEN}/artwork/pick`, payload: { kind: 'movie', id: 53080 } })).statusCode, 404);
      assert.deepEqual(calls, [], 'unconfigured, nothing is read');
    },
    { configured: false },
  );
});

test('the page carries its hardening headers, with the CSP pinned exactly', async () => {
  await serve(async (app) => {
    const res = await app.inject({ method: 'GET', url: `/${TOKEN}/artwork` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['content-security-policy'], ARTWORK_CSP);
    assert.equal(
      ARTWORK_CSP,
      "default-src 'none'; img-src 'self' https://image.tmdb.org https://artworks.thetvdb.com https://assets.fanart.tv https://storage.googleapis.com; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.match(res.body, /^<!doctype html>/);
    assert.match(res.body, /Finding Nemo/);
    assert.match(res.body, /Severance/);
    const script = await app.inject({ method: 'GET', url: `/${TOKEN}/artwork/app.js` });
    assert.equal(script.statusCode, 200);
    assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(script.headers['cache-control'], 'private, no-store');
  });
});

// The page is reached through the token, and every request it makes is
// relative: no absolute URL on it carries the token anywhere.
test('no absolute URL on the page or in its script carries the feed token', async () => {
  await serve(async (app) => {
    const page = await app.inject({ method: 'GET', url: `/${TOKEN}/artwork`, headers: { host: 'simkl.hani.fyi', 'x-forwarded-proto': 'https' } });
    const script = await app.inject({ method: 'GET', url: `/${TOKEN}/artwork/app.js` });
    for (const body of [page.body, script.body]) {
      const carrying = [...body.matchAll(/[a-z]+:\/\/[^"'\s<>]+/g)].map((m) => m[0]).filter((url) => url.includes(TOKEN));
      assert.deepEqual(carrying, []);
      assert.ok(!body.includes(TOKEN), 'the token appears nowhere in the body');
    }
    // What the page does load, it loads relatively or from the hosts the CSP names.
    for (const match of page.body.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const url = match[1] ?? '';
      if (!/^[a-z]+:/.test(url)) continue;
      assert.match(url, /^https:\/\/(image\.tmdb\.org|artworks\.thetvdb\.com|assets\.fanart\.tv|storage\.googleapis\.com)\//, url);
    }
  });
});

test('candidates come back for a film and a show, and a bad query is a 400', async () => {
  await serve(async (app) => {
    const film = await app.inject({ method: 'GET', url: `/${TOKEN}/artwork/candidates?kind=movie&id=53080` });
    assert.equal(film.statusCode, 200);
    assert.equal(film.json().title, 'Finding Nemo');
    assert.deepEqual(film.json().candidates.map((c: { url: string }) => c.url), [BACKDROP]);
    const show = await app.inject({ method: 'GET', url: `/${TOKEN}/artwork/candidates?kind=show&id=3381` });
    assert.equal(show.statusCode, 200);
    assert.deepEqual(show.json().candidates.map((c: { url: string }) => c.url), [POSTER]);
    for (const query of ['kind=book&id=1', 'kind=movie&id=x', 'kind=movie', '']) {
      assert.equal((await app.inject({ method: 'GET', url: `/${TOKEN}/artwork/candidates?${query}` })).statusCode, 400, query);
    }
    assert.equal((await app.inject({ method: 'GET', url: `/${TOKEN}/artwork/candidates?kind=movie&id=999` })).statusCode, 404);
  });
});

test('a pick uploads the offered image and writes the link, in that order', async () => {
  await serve(async (app, { bucket, sheet, calls }) => {
    await app.inject({ method: 'GET', url: `/${TOKEN}/artwork/candidates?kind=movie&id=53080` });
    const res = await app.inject({ method: 'POST', url: `/${TOKEN}/artwork/pick`, payload: { kind: 'movie', id: 53080, url: BACKDROP } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.key, 'Finding Nemo');
    assert.deepEqual(body.uploaded, { bucket: 'movies', key: 'Finding Nemo', bytes: JPEG.byteLength, contentType: 'image/jpeg' });
    assert.deepEqual(body.link, { status: 'written', address: 'N3', key: 'Finding Nemo', link: 'https://storage.googleapis.com/movies/Finding Nemo' });
    assert.deepEqual(bucket.uploads.map((u) => [u.key, u.cacheControl]), [['Finding Nemo', 'public, max-age=300']]);
    assert.equal(sheet.films![2]?.[MOVIE_SHEET_HEADERS.indexOf('Banner')]?.userEnteredValue?.stringValue, 'https://storage.googleapis.com/movies/Finding Nemo');
    const order = calls.filter((c) => c.includes('image.tmdb.org/t/p') || c.includes('/upload/storage') || c.includes(':batchUpdate')).map((c) => (c.includes('batchUpdate') ? 'write' : c.includes('upload') ? 'upload' : 'download'));
    assert.deepEqual(order, ['download', 'upload', 'write']);
    // The page reflects it without a rebuild.
    const page = await app.inject({ method: 'GET', url: `/${TOKEN}/artwork` });
    assert.match(page.body, /data-title="Finding Nemo"[^>]*data-state="done"|data-state="done"[^>]*data-title="Finding Nemo"/);
  });
});

test('a URL the page was not offered is refused before anything is fetched', async () => {
  await serve(async (app, { bucket, calls }) => {
    const before = calls.length;
    const res = await app.inject({ method: 'POST', url: `/${TOKEN}/artwork/pick`, payload: { kind: 'movie', id: 53080, url: 'https://image.tmdb.org/t/p/w1280/other.jpg' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'not-offered');
    assert.deepEqual(bucket.uploads, []);
    assert.ok(!calls.slice(before).some((c) => c.includes('image.tmdb.org/t/p')), 'no download');
  });
});

test('a foreign link needs adopt, and adopting copies the current image in and rewrites the cell', async () => {
  await serve(async (app, { bucket, sheet }) => {
    const refused = await app.inject({ method: 'POST', url: `/${TOKEN}/artwork/pick`, payload: { kind: 'movie', id: 53078, adopt: false } });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, 'needs-adopt');
    assert.deepEqual(bucket.uploads, [], 'nothing uploaded on a refusal');
    // The current image is on the CDN under the URL the cell holds.
    const adopted = await app.inject({ method: 'POST', url: `/${TOKEN}/artwork/pick`, payload: { kind: 'movie', id: 53078, adopt: true } });
    assert.equal(adopted.statusCode, 502, 'the fake CDN has no such image, and the failure is the upstream\'s');
    assert.deepEqual(bucket.uploads, []);
    assert.equal(sheet.films![1]?.[MOVIE_SHEET_HEADERS.indexOf('Banner')]?.userEnteredValue?.stringValue, 'https://image.tmdb.org/t/p/w1280/sw.jpg', 'the cell is untouched');
  });
});

// Fastify's default parsers are the only body parsers: JSON, and plain text,
// which the route reads as no object at all. Anything else is unsupported.
test('a body that is not a JSON object is a 400, and an unsupported type a 415', async () => {
  await serve(async (app) => {
    const form = await app.inject({ method: 'POST', url: `/${TOKEN}/artwork/pick`, payload: 'kind=movie', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.statusCode, 415);
    const text = await app.inject({ method: 'POST', url: `/${TOKEN}/artwork/pick`, payload: 'kind=movie', headers: { 'content-type': 'text/plain' } });
    assert.equal(text.statusCode, 400);
    const empty = await app.inject({ method: 'POST', url: `/${TOKEN}/artwork/pick`, payload: {} });
    assert.equal(empty.statusCode, 400);
  });
});

test('in report mode the object uploads and the link is reported, not written', async () => {
  await serve(
    async (app, { bucket, sheet }) => {
      await app.inject({ method: 'GET', url: `/${TOKEN}/artwork/candidates?kind=show&id=3381` });
      const res = await app.inject({ method: 'POST', url: `/${TOKEN}/artwork/pick`, payload: { kind: 'show', id: 3381, url: POSTER } });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().link.status, 'reported');
      assert.equal(res.json().link.address, 'K2');
      assert.deepEqual(bucket.uploads.map((u) => u.key), ['Severance']);
      assert.equal(sheet.state[1]?.[SHEET_HEADERS.length]?.userEnteredValue, undefined);
    },
    { mode: 'report' },
  );
});

// A sync run holds the sheet; the page answers "try again" rather than
// stalling behind it. The object is already uploaded by then, and the next
// pick puts the same bytes under the same key, so nothing is lost.
test('a pick while the sheet is held answers 503 with Retry-After, after the upload', async () => {
  await serve(async (app, { bucket, sheet }) => {
    await app.inject({ method: 'GET', url: `/${TOKEN}/artwork/candidates?kind=movie&id=53080` });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withSheetLock(() => held);
    const res = await app.inject({ method: 'POST', url: `/${TOKEN}/artwork/pick`, payload: { kind: 'movie', id: 53080, url: BACKDROP } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['retry-after'], '10');
    assert.equal(res.json().error, 'busy');
    assert.equal(bucket.uploads.length, 1, 'the upload went out before the link step waited');
    assert.equal(sheet.films![2]?.[MOVIE_SHEET_HEADERS.indexOf('Banner')]?.userEnteredValue, undefined, 'the cell is untouched');
    release();
    await holder;
    const again = await app.inject({ method: 'POST', url: `/${TOKEN}/artwork/pick`, payload: { kind: 'movie', id: 53080, url: BACKDROP } });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().link.status, 'written');
    assert.equal(bucket.uploads.length, 2);
  });
});

// The freeze latch is the sync's "no further writes this process": the tab
// is in a state nobody has verified, and the repair copies a backup over it.
test('a pick is refused while the sheet sync is frozen, before anything is uploaded', async () => {
  await serve(async (app, { bucket, calls, sync }) => {
    await app.inject({ method: 'GET', url: `/${TOKEN}/artwork/candidates?kind=movie&id=53080` });
    const before = calls.length;
    sync.frozen = 'FROZEN: copy _sync-REPAIR back over Movies';
    try {
      const res = await app.inject({ method: 'POST', url: `/${TOKEN}/artwork/pick`, payload: { kind: 'movie', id: 53080, url: BACKDROP } });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error, 'frozen');
      assert.match(res.json().detail, /_sync-REPAIR/);
      assert.deepEqual(bucket.uploads, []);
      assert.equal(calls.length, before, 'nothing was fetched or written');
    } finally {
      sync.frozen = null;
    }
  });
});

// A show whose library record lacks a TVDB id is asked of SIMKL once, and the
// answer outlives the index: asked per open, the per-title calls are the
// burst SIMKL answers with a 401.
test('a TVDB id resolved on demand survives an index rebuild', async () => {
  await serve(async (app, { calls }) => {
    const detailCalls = () => calls.filter((c) => c.includes('api.simkl.com/tv/')).length;
    const first = await app.inject({ method: 'GET', url: `/${TOKEN}/artwork/candidates?kind=show&id=3382` });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().providerId, 371980);
    assert.equal(detailCalls(), 1);
    await app.inject({ method: 'GET', url: `/${TOKEN}/artwork?fresh=1` });
    const again = await app.inject({ method: 'GET', url: `/${TOKEN}/artwork/candidates?kind=show&id=3382` });
    assert.equal(again.json().providerId, 371980);
    assert.equal(detailCalls(), 1, 'not asked again after the rebuild');
  });
});

// A candidates or pick request past the index TTL must not pay a rebuild:
// the row was rendered from some index, and the pick re-reads under the lock.
test('candidates and picks use the index that stands rather than rebuilding it', async () => {
  await serve(async (app, { calls }) => {
    await app.inject({ method: 'GET', url: `/${TOKEN}/artwork` });
    const reads = () => calls.filter((c) => c.includes('/spreadsheets/') || c.includes('/storage/v1/b/')).length;
    const after = reads();
    await app.inject({ method: 'GET', url: `/${TOKEN}/artwork/candidates?kind=movie&id=53080` });
    await app.inject({ method: 'GET', url: `/${TOKEN}/artwork/candidates?kind=movie&id=53080` });
    assert.equal(reads(), after, 'no tab read and no bucket listing for a candidate request');
  });
});
