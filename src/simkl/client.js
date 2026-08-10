import { config, requireClientId } from '../config.js';

const API_BASE = 'https://api.simkl.com';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SimklError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'SimklError';
    this.status = status;
    this.body = body;
  }
}

/**
 * A revoked or invalid token surfaces as this, so callers can distinguish
 * "you need to log in again" from "SIMKL is having a bad day" and keep
 * serving the last good snapshot instead of emptying the feed.
 */
export class SimklAuthError extends SimklError {
  constructor(message, status, body) {
    super(message, status, body);
    this.name = 'SimklAuthError';
  }
}

export function baseHeaders() {
  return {
    'User-Agent': `${config.appName}/${config.appVersion}`,
    'simkl-api-key': requireClientId(),
    Accept: 'application/json',
  };
}

/** Params every request carries, per the SIMKL docs. */
export function baseParams() {
  return {
    client_id: requireClientId(),
    'app-name': config.appName,
    'app-version': config.appVersion,
  };
}

/**
 * GET a SIMKL API path with backoff. `token` makes it an authenticated call.
 * Verified against the live API: omitting client_id entirely returns 412,
 * a valid client_id without a token returns 401.
 */
export async function apiGet(path, { token, params = {}, signal } = {}) {
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries({ ...baseParams(), ...params })) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const headers = baseHeaders();
  if (token) headers.Authorization = `Bearer ${token}`;

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { headers, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      await sleep(2 ** (attempt - 1) * 1000);
      continue;
    }

    if (res.ok) return res.json();

    const body = await res.text().catch(() => '');

    if (res.status === 401 || res.status === 403) {
      throw new SimklAuthError(`SIMKL rejected the token (${res.status})`, res.status, body);
    }
    if (res.status === 412) {
      throw new SimklError('client_id rejected or throttled (412)', res.status, body);
    }
    if (!RETRYABLE.has(res.status)) {
      throw new SimklError(`SIMKL ${res.status} for ${path}`, res.status, body);
    }

    lastError = new SimklError(`SIMKL ${res.status} for ${path}`, res.status, body);
    if (attempt < MAX_ATTEMPTS) await sleep(2 ** (attempt - 1) * 1000);
  }

  throw lastError;
}
