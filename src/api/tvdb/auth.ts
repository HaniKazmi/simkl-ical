/**
 * Bearer tokens for the TVDB v4 API.
 *
 * `POST /login` takes the API key — plus a subscriber PIN for a user-supported
 * key — and returns a token TVDB documents as valid for one month.
 *
 * Import-safe: the key is read inside the exchange, never at module load, so
 * importing this from a test cannot reach a credential.
 */

import { config } from '../../shared/config.ts';
import { withTimeout } from '../../shared/signals.ts';
import { beginRequest, readBody } from '../requests.ts';
import { tokenCache } from '../token-cache.ts';
import type { TvdbLoginResponse } from './types.ts';

const LOGIN_URL = 'https://api4.thetvdb.com/v4/login';

const TIMEOUT_MS = 15_000;

/**
 * How long a token is treated as good for.
 *
 * Assumed, not read: the response carries no expiry, only the documented
 * month. Well under it — refreshing early costs one extra login a fortnight;
 * refreshing late costs a whole poll's runtime lookups. The 401 path recovers
 * if the guess is wrong.
 */
const ASSUMED_TTL_MS = 20 * 24 * 60 * 60 * 1000;

export class TvdbAuthError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TvdbAuthError';
    this.status = status;
  }
}

/**
 * Exchange the key for a token.
 *
 * The pin is omitted when unset rather than sent empty: a licensed key logs in
 * alone, and TVDB answers a *wrong* pin with a token rather than a 401, so a
 * blank one would look like it worked and prove nothing.
 */
export const exchangeToken = async (c = config, { signal }: { signal?: AbortSignal } = {}): Promise<string> => {
  if (!c.tvdbApiKey) {
    // Thrown before any fetch, so an unconfigured install cannot reach TVDB
    // even if a caller forgets to gate on `tvdbConfigured`.
    throw new TvdbAuthError('TVDB_API_KEY is not set, so no runtime lookup can be made.');
  }

  const finish = beginRequest({ service: 'tvdb', component: 'auth', method: 'POST', url: LOGIN_URL });
  const response = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The caller's signal only fires on shutdown, so alone it is no bound.
    signal: withTimeout(signal, TIMEOUT_MS),
    body: JSON.stringify(c.tvdbPin ? { apikey: c.tvdbApiKey, pin: c.tvdbPin } : { apikey: c.tvdbApiKey }),
  });

  const read = await readBody(response);
  let body: TvdbLoginResponse = {};
  try {
    body = JSON.parse(read.text) as TvdbLoginResponse;
  } catch {
    // The throw below reports the status and body, which says more than a
    // parser complaint about an error page.
  }
  const token = body.data?.token;
  if (!response.ok || !token) {
    const reason = read.failure ?? read.text.slice(0, 200);
    finish({ status: response.status, bytes: read.bytes, error: reason });
    throw new TvdbAuthError(`TVDB login failed (${response.status}): ${reason}`, response.status);
  }
  finish({ status: response.status, bytes: read.bytes, error: null });
  return token;
};

const cache = tokenCache(async () => ({
  token: await exchangeToken(config),
  expiresAtMs: Date.now() + ASSUMED_TTL_MS,
}));

/**
 * Dropped between tests, and after any 401 — the assumed lifetime is a guess,
 * and this makes a wrong guess cost one poll rather than persist.
 */
export const clearTokenCache = (): void => {
  cache.clear();
};

export const getTvdbToken = (): Promise<string> => cache.get();
