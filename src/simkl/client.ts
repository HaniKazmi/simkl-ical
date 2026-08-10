import { config, requireClientId } from '../config.ts';

const API_BASE = 'https://api.simkl.com';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

// Sync responses are small; without this a hung connection stalls a refresh
// cycle until undici's 300s default.
const TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SimklError extends Error {
  status: number | undefined;
  body: string | undefined;

  constructor(message: string, status?: number, body?: string) {
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
  constructor(message: string, status?: number, body?: string) {
    super(message, status, body);
    this.name = 'SimklAuthError';
  }
}

const baseHeaders = (): Record<string, string> => ({
  'User-Agent': `${config.appName}/${config.appVersion}`,
  'simkl-api-key': requireClientId(),
  Accept: 'application/json',
});

/** Params every request carries, per the SIMKL docs. */
const baseParams = (): Record<string, string> => ({
  client_id: requireClientId(),
  'app-name': config.appName,
  'app-version': config.appVersion,
});

export interface ApiGetOptions {
  token?: string | null;
  params?: Record<string, string | number | undefined | null>;
  signal?: AbortSignal;
}

/**
 * GET a SIMKL API path with backoff. `token` makes it an authenticated call.
 * Verified against the live API: omitting client_id entirely returns 412,
 * a valid client_id without a token returns 401.
 */
export const apiGet = async <T>(path: string, { token, params = {}, signal }: ApiGetOptions = {}): Promise<T> => {
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries({ ...baseParams(), ...params })) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const headers = baseHeaders();
  if (token) headers.Authorization = `Bearer ${token}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      await sleep(2 ** (attempt - 1) * 1000);
      continue;
    }

    if (res.ok) return (await res.json()) as T;

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
};
