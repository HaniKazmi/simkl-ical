/**
 * Service-account access tokens for the Sheets API.
 *
 * Zero dependencies: the RS256 assertion is signed with `node:crypto` and
 * exchanged for a bearer token, all the Sheets endpoints need.
 *
 * Import-safe: the key is read inside `readServiceAccountKey`, never at module
 * load, so importing this from a test cannot touch a credential.
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from '../../shared/config.ts';
import { withTimeout } from '../../shared/signals.ts';
import { errorMessage } from '../../shared/errors.ts';
import { beginRequest, readBody } from '../requests.ts';
import { tokenCache } from '../token-cache.ts';

const TIMEOUT_MS = 30_000;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Read-write: the narrower `spreadsheets.readonly` cannot batchUpdate. The
 * sheet must also be shared with the service account as Editor — the scope
 * alone is not enough.
 */
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Assertions last an hour; refresh early so a long poll cannot expire mid-run. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/**
 * The key, from base64 in the environment or a JSON file on disk.
 *
 * Base64 first because it is the container path: `/data` is a named Docker
 * volume with no host side to place a file into, and the private key is a
 * 29-line PEM passing through three parsers that disagree about quoting.
 */
const readServiceAccountKey = (c = config): ServiceAccountKey => {
  let raw: string;
  if (c.googleKeyBase64) {
    raw = Buffer.from(c.googleKeyBase64, 'base64').toString('utf8');
  } else if (c.googleCredentialsExplicit) {
    try {
      raw = readFileSync(c.googleCredentialsPath, 'utf8');
    } catch (err) {
      throw new Error(`No service account key at ${c.googleCredentialsPath}: ${errorMessage(err)}`);
    }
  } else {
    throw new Error(
      'No Google credentials. Set GOOGLE_SA_KEY_B64 to base64 of the service account JSON ' +
        '(`base64 -w0 sa.json`, or `base64 -i sa.json` on macOS), or GOOGLE_APPLICATION_CREDENTIALS to its path.',
    );
  }

  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(raw) as Partial<ServiceAccountKey>;
  } catch (err) {
    // Named rather than re-thrown: a truncated base64 var and a wrong file
    // path want different fixes, and the JSON parser cannot say which.
    throw new Error(`The Google credential is not JSON — check it decoded intact: ${errorMessage(err)}`);
  }
  if (!key.client_email || !key.private_key) {
    throw new Error('The Google credential is not a service account key — no client_email/private_key.');
  }
  return { client_email: key.client_email, private_key: key.private_key };
};

const claimSet = (clientEmail: string, now: Temporal.Instant = Temporal.Now.instant()): Record<string, string | number> => {
  // Unix seconds, per RFC 7519's NumericDate. Not a shared helper: this is
  // the only wire format in the project that counts in seconds.
  const issued = Math.floor(now.epochMilliseconds / 1000);
  return { iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: issued, exp: issued + 3600 };
};

const base64url = (input: string): string => Buffer.from(input).toString('base64url');

const exchangeToken = async (key: ServiceAccountKey, { signal }: { signal?: AbortSignal } = {}): Promise<{ token: string; expiresIn: number }> => {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify(claimSet(key.client_email)));
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key.private_key, 'base64url');

  // Logged like every other outbound call: this failure — a bad key, clock
  // skew — has to be told apart from a credential the sheet rejected.
  const finish = beginRequest({ service: 'sheets', component: 'auth', method: 'POST', url: TOKEN_URL });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${signature}`,
    }),
    // The caller's signal only fires on shutdown, so alone it is no bound. A
    // hung connection would otherwise stall the sheet run — and the library
    // poll it sits inside — until undici's 300s default.
    signal: withTimeout(signal, TIMEOUT_MS),
  });

  const read = await readBody(response);
  let body: { access_token?: string; expires_in?: number; error_description?: string } = {};
  try {
    body = JSON.parse(read.text) as typeof body;
  } catch {
    // The throw below reports the status and raw body, which says more than a
    // parser complaint about Google's error page.
  }
  if (!response.ok || !body.access_token) {
    const reason = read.failure ?? body.error_description ?? JSON.stringify(body);
    finish({ status: response.status, bytes: read.bytes, error: reason });
    throw new Error(`Google token exchange failed (${response.status}): ${reason}`);
  }
  finish({ status: response.status, bytes: read.bytes, error: null });
  // Google says an hour today; reading it from the response means a
  // shorter-lived token is never served past expiry. At the short end the
  // margin means a token good for five minutes or less is cached but never
  // read, so every request re-signs rather than serving something stale.
  const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  return { token: body.access_token, expiresIn };
};

// The refresh margin is folded into the stored expiry: a token within five
// minutes of expiring is treated as gone and re-signed.
const cache = tokenCache(async () => {
  const { token, expiresIn } = await exchangeToken(readServiceAccountKey());
  return { token, expiresAtMs: Date.now() + expiresIn * 1000 - REFRESH_MARGIN_MS };
});

/** Dropped between tests, and after any 401 — a stale token outlives its usefulness silently. */
export const clearTokenCache = (): void => {
  cache.clear();
};

/** A bearer token, reused until it is close enough to expiry to be worth replacing. */
export const getAccessToken = (): Promise<string> => cache.get();
