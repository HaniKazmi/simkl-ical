import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { apiGet, SimklAuthError, SimklError } from '../src/simkl/client.ts';
import { jsonResponse, withFetch } from './helpers.ts';

// apiGet requires a client id; the real one is irrelevant to these tests.
config.clientId ??= 'test-client-id';

// Backoff is real time, so the tests that exercise it use a status that fails
// fast (one attempt) unless they are specifically about retrying. The retrying
// ones stub a success on the second attempt, costing a single 1s sleep.

test('a successful call returns the parsed body', async () => {
  await withFetch(
    () => jsonResponse({ hello: 'world' }),
    async (calls) => {
      assert.deepEqual(await apiGet('/sync/activities'), { hello: 'world' });
      assert.equal(calls.length, 1);
    },
  );
});

test('every request carries the client id, app name and version', async () => {
  await withFetch(
    () => jsonResponse({}),
    async (calls) => {
      await apiGet('/movies/1');
      const url = new URL(calls[0]!);
      assert.equal(url.searchParams.get('client_id'), config.clientId);
      assert.equal(url.searchParams.get('app-name'), config.appName);
      assert.equal(url.searchParams.get('app-version'), config.appVersion);
    },
  );
});

test('the api key header is sent, and a token becomes a bearer', async () => {
  await withFetch(
    (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('simkl-api-key'), config.clientId);
      assert.equal(headers.get('authorization'), 'Bearer tok');
      return jsonResponse({});
    },
    async () => {
      await apiGet('/sync/activities', { token: 'tok' });
    },
  );
});

test('an anonymous call sends no authorization header', async () => {
  await withFetch(
    (_url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      return jsonResponse({});
    },
    async () => {
      await apiGet('/movies/1');
    },
  );
});

test('extra params are appended, and null or undefined ones are dropped', async () => {
  await withFetch(
    () => jsonResponse({}),
    async (calls) => {
      await apiGet('/movies/1', { params: { extended: 'full', missing: undefined, empty: null } });
      const url = new URL(calls[0]!);
      assert.equal(url.searchParams.get('extended'), 'full');
      assert.equal(url.searchParams.has('missing'), false);
      assert.equal(url.searchParams.has('empty'), false);
    },
  );
});

// --- error classification -------------------------------------------------

// Callers distinguish "you need to log in again" from "SIMKL is having a bad
// day" so a revoked token keeps serving the last good feed instead of emptying
// it. Getting this wrong in either direction is a user-visible failure.
for (const status of [401, 403]) {
  test(`a ${status} is an auth error and is not retried`, async () => {
    await withFetch(
      () => new Response('nope', { status }),
      async (calls) => {
        await assert.rejects(() => apiGet('/sync/activities', { token: 'stale' }), SimklAuthError);
        assert.equal(calls.length, 1, 'retrying a revoked token is pointless');
      },
    );
  });
}

test('a 412 is a plain SimklError, not an auth error', async () => {
  await withFetch(
    () => new Response('rejected', { status: 412 }),
    async (calls) => {
      const err = await apiGet('/sync/activities').catch((e: unknown) => e);
      assert.ok(err instanceof SimklError, 'is a SimklError');
      assert.ok(!(err instanceof SimklAuthError), 'but not an auth error');
      assert.equal(calls.length, 1);
    },
  );
});

test('a 404 fails immediately rather than burning the retry budget', async () => {
  await withFetch(
    () => new Response('gone', { status: 404 }),
    async (calls) => {
      await assert.rejects(() => apiGet('/movies/999'), SimklError);
      assert.equal(calls.length, 1);
    },
  );
});

test('an error carries the status and body for the log', async () => {
  await withFetch(
    () => new Response('the reason', { status: 404 }),
    async () => {
      const err = (await apiGet('/movies/999').catch((e: unknown) => e)) as SimklError;
      assert.equal(err.status, 404);
      assert.equal(err.body, 'the reason');
    },
  );
});

// --- retrying -------------------------------------------------------------

test('a retryable status is retried and can succeed', async () => {
  let calls = 0;
  await withFetch(
    () => (++calls === 1 ? new Response('busy', { status: 503 }) : jsonResponse({ ok: true })),
    async () => {
      assert.deepEqual(await apiGet('/sync/activities'), { ok: true });
      assert.equal(calls, 2);
    },
  );
});

test('a network failure is retried and can succeed', async () => {
  let calls = 0;
  await withFetch(
    () => {
      if (++calls === 1) throw new TypeError('fetch failed');
      return jsonResponse({ ok: true });
    },
    async () => {
      assert.deepEqual(await apiGet('/sync/activities'), { ok: true });
      assert.equal(calls, 2);
    },
  );
});

test('a caller-supplied abort is not retried', async () => {
  const controller = new AbortController();
  controller.abort();
  await withFetch(
    () => {
      throw new DOMException('aborted', 'AbortError');
    },
    async (calls) => {
      await assert.rejects(() => apiGet('/sync/activities', { signal: controller.signal }));
      assert.equal(calls.length, 1, 'an intentional abort must not be retried');
    },
  );
});

// A 200 carrying an HTML interstitial used to escape the retry loop as a bare
// SyntaxError, unwrapped and unretried, unlike the equivalent CDN path.
test('an unparseable success is wrapped as a SimklError and retried', async () => {
  let calls = 0;
  await withFetch(
    () => (++calls === 1 ? new Response('<html>maintenance</html>', { status: 200 }) : jsonResponse({ ok: true })),
    async () => {
      assert.deepEqual(await apiGet('/sync/activities'), { ok: true });
      assert.equal(calls, 2);
    },
  );
});

test('an unparseable success that never recovers throws a SimklError', async () => {
  await withFetch(
    () => new Response('<html>maintenance</html>', { status: 200 }),
    async () => {
      const err = (await apiGet('/sync/activities').catch((e: unknown) => e)) as SimklError;
      assert.ok(err instanceof SimklError, `expected a SimklError, got ${String(err)}`);
      assert.match(err.message, /unparseable/i);
    },
  );
});

// SIMKL sits behind Cloudflare, which uses 429 with a Retry-After. Ignoring it
// and retrying on our own schedule can extend the throttle.
test('Retry-After on a 429 is honoured over the default backoff', async () => {
  let calls = 0;
  const started = Date.now();
  await withFetch(
    () => (++calls === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }) : jsonResponse({ ok: true })),
    async () => {
      assert.deepEqual(await apiGet('/sync/activities'), { ok: true });
      assert.equal(calls, 2);
      // The default first backoff is 1s; Retry-After: 0 should beat it.
      assert.ok(Date.now() - started < 500, `waited ${Date.now() - started}ms, should have honoured Retry-After: 0`);
    },
  );
});
