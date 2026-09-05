/**
 * The shared transport engine, tested through a local spec. The per-upstream
 * suites cover their own status mappings; what is pinned here is the loop's own
 * contract — the parts every client inherits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, requestBytes, requestJson, type HttpSpec } from '../../src/api/http.ts';
import { clearRequests, recentRequests } from '../../src/api/requests.ts';
import { jsonResponse, withFetch } from '../helpers.ts';

class TestError extends HttpError {}

const spec = (overrides: Partial<HttpSpec> = {}): HttpSpec => ({
  service: 'simkl',
  label: 'TEST',
  maxAttempts: 3,
  timeoutMs: 1_000,
  errorFor: (message, status, body) => new TestError(message, status, body),
  onStatus: (status) => (status === 503 ? 'retry' : new TestError(`terminal ${status}`, status)),
  ...overrides,
});

const URL_UNDER_TEST = new URL('https://api.example.com/thing');

test('a per-call maxAttempts of one makes a retryable status terminal', async () => {
  await withFetch(
    () => new Response('busy', { status: 503 }),
    async (calls) => {
      await assert.rejects(
        () => requestJson(spec(), URL_UNDER_TEST, { component: 'poll', maxAttempts: 1 }),
        (err: unknown) => err instanceof TestError && err.status === 503,
      );
      assert.equal(calls.length, 1, 'the override wins over the spec budget');
    },
  );
});

test('headers are re-evaluated on every attempt', async () => {
  let evaluations = 0;
  let calls = 0;
  await withFetch(
    () => (++calls < 3 ? new Response('busy', { status: 503 }) : jsonResponse({ ok: true })),
    async () => {
      await requestJson(spec(), URL_UNDER_TEST, {
        component: 'poll',
        headers: () => ({ 'X-Attempt': String(++evaluations) }),
      });
      assert.equal(evaluations, 3, 'a credential that expires mid-loop must be re-obtained, not reused');
    },
  );
});

test('a failure obtaining headers is as retryable as one using them', async () => {
  let calls = 0;
  await withFetch(
    () => jsonResponse({ ok: true }),
    async () => {
      const result = await requestJson(spec(), URL_UNDER_TEST, {
        component: 'poll',
        headers: () => {
          if (++calls === 1) throw new Error('token exchange failed');
          return {};
        },
      });
      assert.deepEqual(result, { ok: true });
    },
  );
});

test('a terminal status records the body as the row error', async () => {
  clearRequests();
  await withFetch(
    () => new Response('the upstream reason', { status: 400 }),
    async () => {
      await assert.rejects(() => requestJson(spec(), URL_UNDER_TEST, { component: 'poll' }));
      const row = recentRequests()[0];
      assert.equal(row?.status, 400);
      assert.match(row?.error ?? '', /the upstream reason/);
      assert.equal(row?.attempts, 1);
    },
  );
});

test('a body is JSON-encoded and stamped with its content type', async () => {
  await withFetch(
    (_url, init) => {
      assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
      assert.equal(init?.body, JSON.stringify({ requests: [] }));
      return jsonResponse({});
    },
    async () => {
      await requestJson(spec(), URL_UNDER_TEST, { component: 'poll', method: 'POST', body: { requests: [] } });
    },
  );
});

test('a raw body is sent verbatim under its own content type', async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  await withFetch(
    (_url, init) => {
      assert.equal(new Headers(init?.headers).get('content-type'), 'multipart/related; boundary=x');
      assert.equal(init?.body, bytes);
      return jsonResponse({});
    },
    async () => {
      await requestJson(spec(), URL_UNDER_TEST, { component: 'artwork', method: 'POST', rawBody: { bytes, contentType: 'multipart/related; boundary=x' } });
    },
  );
});

/** A streaming response whose body dies after `good` chunks. */
const dyingStream = (good: Uint8Array[]): Response =>
  new Response(
    new ReadableStream({
      pull(controller) {
        const next = good.shift();
        if (next) controller.enqueue(next);
        else controller.error(new Error('connection reset'));
      },
    }),
    { status: 200, headers: { 'content-type': 'image/jpeg' } },
  );

test('bytes come back with their content type, and the row counts them', async () => {
  clearRequests();
  await withFetch(
    () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    async () => {
      const got = await requestBytes(spec(), URL_UNDER_TEST, { component: 'artwork', maxBytes: 10 });
      assert.deepEqual([...got.bytes], [1, 2, 3]);
      assert.equal(got.contentType, 'image/jpeg');
      assert.equal(recentRequests()[0]?.bytes, 3);
    },
  );
});

// The same split the JSON path makes: the transfer's failure retries, the
// payload's does not.
test('a download that dies mid-body is retried', async () => {
  let calls = 0;
  await withFetch(
    () => (++calls < 2 ? dyingStream([new Uint8Array([1])]) : new Response(new Uint8Array([1, 2]), { status: 200 })),
    async () => {
      const got = await requestBytes(spec(), URL_UNDER_TEST, { component: 'artwork', maxBytes: 10 });
      assert.deepEqual([...got.bytes], [1, 2]);
      assert.equal(calls, 2);
    },
  );
});

test('a body over the limit is refused without retrying, by header or by stream', async () => {
  clearRequests();
  await withFetch(
    () => new Response(new Uint8Array(20), { status: 200, headers: { 'content-length': '20' } }),
    async (calls) => {
      await assert.rejects(
        () => requestBytes(spec(), URL_UNDER_TEST, { component: 'artwork', maxBytes: 10 }),
        (err: unknown) => err instanceof TestError && /over the 10 byte limit/.test(err.message),
      );
      assert.equal(calls.length, 1, 'asking again cannot make it smaller');
      assert.match(recentRequests()[0]?.error ?? '', /over the 10 byte limit/);
    },
  );
  await withFetch(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(8));
          },
        }),
        { status: 200 },
      ),
    async (calls) => {
      await assert.rejects(() => requestBytes(spec(), URL_UNDER_TEST, { component: 'artwork', maxBytes: 10 }), /over the 10 byte limit/);
      assert.equal(calls.length, 1, 'an undeclared length is caught as the stream crosses the limit');
    },
  );
});
