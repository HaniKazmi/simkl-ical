/**
 * Service-account access tokens for the Sheets API.
 *
 * Zero dependencies: the RS256 assertion is signed with `node:crypto` and
 * exchanged for a bearer token, which is all the Sheets endpoints need.
 *
 * Import-safe on purpose — the key is read inside `readServiceAccountKey`,
 * never at module load, so importing this file from a test cannot touch a
 * credential.
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from '../../shared/config.ts';
import { withTimeout } from '../../shared/signals.ts';
import { errorMessage } from '../../shared/errors.ts';
import { beginRequest, readBody } from '../requests.ts';

const TIMEOUT_MS = 30_000;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Read-write, unlike the mapping tool this was ported from. The narrower
 * `spreadsheets.readonly` cannot batchUpdate, and the sheet must also be
 * re-shared with the service account as Editor — the scope alone is not enough.
 */
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Assertions last an hour; refresh early so a long poll cannot expire mid-run. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/**
 * The key, from base64 in the environment or a JSON file on disk.
 *
 * Base64 first because that is the container path: `/data` is a named Docker
 * volume with no host side to place a file into, and the private key is a
 * 29-line PEM passing through three parsers that disagree about quoting.
 */
export const readServiceAccountKey = (c = config): ServiceAccountKey => {
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
    // Named rather than re-thrown: a truncated base64 var and a wrong file path
    // produce very different fixes, and the JSON parser cannot tell you which.
    throw new Error(`The Google credential is not JSON — check it decoded intact: ${errorMessage(err)}`);
  }
  if (!key.client_email || !key.private_key) {
    throw new Error('The Google credential is not a service account key — no client_email/private_key.');
  }
  return { client_email: key.client_email, private_key: key.private_key };
};

/** Split out from the signing so the claims can be asserted without an RSA key. */
export const claimSet = (clientEmail: string, now: Date = new Date()): Record<string, string | number> => {
  const issued = Math.floor(now.getTime() / 1000);
  return { iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: issued, exp: issued + 3600 };
};

const base64url = (input: string): string => Buffer.from(input).toString('base64url');

export const exchangeToken = async (key: ServiceAccountKey, { signal }: { signal?: AbortSignal } = {}): Promise<{ token: string; expiresIn: number }> => {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify(claimSet(key.client_email)));
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key.private_key, 'base64url');

  // Logged like every other outbound call: this one's failure — a bad key, clock
  // skew — is what has to be told apart from a credential the sheet rejected.
  const finish = beginRequest({ service: 'sheets', component: 'auth', method: 'POST', url: TOKEN_URL });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${signature}`,
    }),
    // The caller's signal is the orchestrator's, which only fires on shutdown,
    // so on its own it is no bound at all. Every other fetch here carries one
    // for the same reason: a hung connection otherwise stalls the sheet run —
    // and with it the library poll it sits inside — until undici's 300s
    // default.
    signal: withTimeout(signal, TIMEOUT_MS),
  });

  const read = await readBody(response);
  let body: { access_token?: string; expires_in?: number; error_description?: string } = {};
  try {
    body = JSON.parse(read.text) as typeof body;
  } catch {
    // Left empty: the throw below reports the status and the raw body, which is
    // more use than a parser complaint about Google's error page.
  }
  if (!response.ok || !body.access_token) {
    const reason = read.failure ?? body.error_description ?? JSON.stringify(body);
    finish({ status: response.status, bytes: read.bytes, error: reason });
    throw new Error(`Google token exchange failed (${response.status}): ${reason}`);
  }
  finish({ status: response.status, bytes: read.bytes, error: null });
  // Google says an hour today. Taking it from the response rather than assuming
  // means a shorter-lived token is never served past its expiry. Note what the
  // margin does at the short end: anything at or under five minutes is written
  // to the cache and then never read, so every request re-signs rather than
  // serving something already stale.
  const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  return { token: body.access_token, expiresIn };
};

let cached: { token: string; expiresAt: number } | null = null;

/** Dropped between tests, and after any 401 — a stale token outlives its usefulness silently. */
export const clearTokenCache = (): void => {
  cached = null;
};

/** A bearer token, reused until it is close enough to expiry to be worth replacing. */
export const getAccessToken = async ({ signal }: { signal?: AbortSignal } = {}): Promise<string> => {
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token;
  const { token, expiresIn } = await exchangeToken(readServiceAccountKey(), { signal });
  cached = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
};
