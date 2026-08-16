import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { sheetsRequest } from '../../../src/api/google/client.ts';
import { clearTokenCache } from '../../../src/api/google/auth.ts';
import { clearRequests, recentRequests } from '../../../src/api/requests.ts';
import { jsonResponse, withConfig, withFetch } from '../../helpers.ts';

/**
 * A real RSA key, because `exchangeToken` signs before it fetches and no stub
 * short of one reaches the transport at all. Generated once: 2048 bits is
 * ~100ms, which is the whole reason this file has a shared key rather than one
 * per test.
 */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credential = Buffer.from(
  JSON.stringify({ client_email: 'test@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
).toString('base64');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Answers the token exchange, and hands everything else to `onApi`. */
const withSheets = async (onApi: (url: string, init?: RequestInit) => Response | Promise<Response>, fn: () => Promise<void>): Promise<void> => {
  clearTokenCache();
  clearRequests();
  await withConfig({ googleKeyBase64: credential }, () =>
    withFetch((url, init) => (String(url) === TOKEN_URL ? jsonResponse({ access_token: 'tok', expires_in: 3600 }) : onApi(String(url), init)), fn),
  );
  clearTokenCache();
};

const failure = (status: number, body = 'upstream said no'): Response => new Response(body, { status });

test('a read records one row, not one per attempt', async () => {
  let calls = 0;
  await withSheets(
    () => {
      calls += 1;
      return calls < 3 ? failure(503) : jsonResponse({ ok: true });
    },
    async () => {
      await sheetsRequest('sid', { component: 'spreadsheet', retry: true });
      const rows = recentRequests().filter((r) => r.component === 'spreadsheet');
      assert.equal(rows.length, 1, 'three attempts, one row');
      assert.equal(rows[0]?.attempts, 3, 'and the retries are the fact worth surfacing');
      assert.equal(rows[0]?.status, 200);
    },
  );
});

// The only transport that writes, and a write is never retried — so `method` is
// the field that says which of the two happened.
test('a write records its method and does not retry', async () => {
  let calls = 0;
  await withSheets(
    () => {
      calls += 1;
      return failure(503);
    },
    async () => {
      await assert.rejects(() => sheetsRequest('sid:batchUpdate', { component: 'spreadsheet', method: 'POST', body: { requests: [] } }));
      assert.equal(calls, 1, 'a failed write is not repeated');
      const rows = recentRequests().filter((r) => r.component === 'spreadsheet');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.method, 'POST');
      assert.equal(rows[0]?.attempts, 1);
    },
  );
});

test('a failure carries the status and the upstream body', async () => {
  await withSheets(
    () => failure(403, 'The caller does not have permission'),
    async () => {
      await assert.rejects(() => sheetsRequest('sid', { component: 'spreadsheet' }));
      const row = recentRequests().find((r) => r.component === 'spreadsheet');
      assert.equal(row?.status, 403);
      assert.match(row?.error ?? '', /does not have permission/);
    },
  );
});

// A row with no status is a call that never got an answer, which is a different
// fix from one that got a bad answer.
test('a fetch that throws records a status-less row', async () => {
  await withSheets(
    () => {
      throw new Error('socket hang up');
    },
    async () => {
      await assert.rejects(() => sheetsRequest('sid', { component: 'spreadsheet' }));
      const row = recentRequests().find((r) => r.component === 'spreadsheet');
      assert.equal(row?.status, null);
      assert.match(row?.error ?? '', /socket hang up/);
    },
  );
});

// A body that dies mid-download must not be reported as a 200 carrying nonsense:
// the fixes are opposite, and only the message tells them apart.
test('a body that cannot be read is reported as itself, not as a parse failure', async () => {
  await withSheets(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('terminated'));
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    async () => {
      await assert.rejects(() => sheetsRequest('sid', { component: 'spreadsheet' }));
      const row = recentRequests().find((r) => r.component === 'spreadsheet');
      assert.equal(row?.status, 200);
      assert.match(row?.error ?? '', /body could not be read/);
      assert.doesNotMatch(row?.error ?? '', /JSON/, 'and not blamed on the parser');
    },
  );
});

// The token exchange is a different endpoint from the spreadsheet, and its
// failure — a bad key, clock skew — wants a different fix from a rejected read.
test('the token exchange is logged under its own component', async () => {
  clearTokenCache();
  clearRequests();
  await withConfig({ googleKeyBase64: credential }, () =>
    withFetch(
      (url) => (String(url) === TOKEN_URL ? jsonResponse({ access_token: 'tok', expires_in: 3600 }) : jsonResponse({ ok: true })),
      async () => {
        await sheetsRequest('sid', { component: 'spreadsheet' });
        const auth = recentRequests().find((r) => r.component === 'auth');
        assert.equal(auth?.service, 'sheets');
        assert.equal(auth?.method, 'POST');
        assert.equal(auth?.status, 200);
        assert.equal(auth?.path, '/token');
      },
    ),
  );
  clearTokenCache();
});

test('a rejected credential is logged against the token endpoint, not the spreadsheet', async () => {
  clearTokenCache();
  clearRequests();
  await withConfig({ googleKeyBase64: credential }, () =>
    withFetch(
      (url) => (String(url) === TOKEN_URL ? new Response(JSON.stringify({ error_description: 'Invalid JWT Signature.' }), { status: 400 }) : jsonResponse({ ok: true })),
      async () => {
        await assert.rejects(() => sheetsRequest('sid', { component: 'spreadsheet' }));
        const auth = recentRequests().find((r) => r.component === 'auth');
        assert.equal(auth?.status, 400);
        assert.match(auth?.error ?? '', /Invalid JWT Signature/);
      },
    ),
  );
  clearTokenCache();
});
