import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { clearTokenCache, getAccessToken, SCOPES } from '../../../src/api/google/auth.ts';
import { clearRequests, recentRequests } from '../../../src/api/requests.ts';
import { jsonResponse, withConfig, withFetch } from '../../helpers.ts';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credential = Buffer.from(
  JSON.stringify({ client_email: 'test@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
).toString('base64');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The scope an exchange asked for, read back out of the signed assertion. */
const scopeOf = (init?: RequestInit): string => {
  const assertion = new URLSearchParams(init?.body as string).get('assertion') ?? '';
  const claims = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString()) as { scope: string };
  return claims.scope;
};

// A Sheets-only deployment must never mint storage rights it cannot use, so
// the two scopes are two assertions, cached apart.
test('each scope is its own exchange, logged under the service it is for', async () => {
  clearTokenCache();
  clearRequests();
  const scopes: string[] = [];
  await withConfig({ googleKeyBase64: credential }, () =>
    withFetch(
      (_url, init) => {
        scopes.push(scopeOf(init));
        return jsonResponse({ access_token: `tok-${scopes.length}`, expires_in: 3600 });
      },
      async (calls) => {
        assert.equal(await getAccessToken(), 'tok-1');
        assert.equal(await getAccessToken({ scope: SCOPES.storage }), 'tok-2');
        assert.equal(await getAccessToken(), 'tok-1', 'the sheets token is reused, not re-signed');
        assert.equal(await getAccessToken({ scope: SCOPES.storage }), 'tok-2');
        assert.deepEqual(calls, [TOKEN_URL, TOKEN_URL]);
        assert.deepEqual(scopes, [SCOPES.spreadsheets, SCOPES.storage]);
        assert.deepEqual(
          recentRequests().map((r) => [r.service, r.component]),
          [
            ['storage', 'auth'],
            ['sheets', 'auth'],
          ],
        );
      },
    ),
  );
  clearTokenCache();
});

// One key signs both assertions, so a 401 on either says both are stale.
test('clearing the cache drops every scope', async () => {
  clearTokenCache();
  await withConfig({ googleKeyBase64: credential }, () =>
    withFetch(
      () => jsonResponse({ access_token: 'tok', expires_in: 3600 }),
      async (calls) => {
        await getAccessToken();
        await getAccessToken({ scope: SCOPES.storage });
        clearTokenCache();
        await getAccessToken();
        await getAccessToken({ scope: SCOPES.storage });
        assert.equal(calls.length, 4);
      },
    ),
  );
  clearTokenCache();
});
