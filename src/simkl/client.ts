import { config, requireClientId } from '../config.ts';
import { errorMessage } from '../errors.ts';
import { withTimeout } from '../signals.ts';

const API_BASE = 'https://api.simkl.com';

// 408 is a server-side read timeout, and 520-524 are Cloudflare's own origin
// failures — SIMKL sits behind it, and all of them are transient by definition.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const MAX_ATTEMPTS = 5;

/** Ceiling on a server-requested wait, so a hostile header cannot stall a refresh. */
const MAX_RETRY_AFTER_MS = 60_000;

// Sync responses are small; without this a hung connection stalls a refresh
// cycle until undici's 300s default.
const TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const backoffMs = (attempt: number): number => 2 ** (attempt - 1) * config.retryBaseMs;

/**
 * How long to wait before the next attempt.
 *
 * Cloudflare answers a 429 with `Retry-After`, and retrying sooner than asked
 * can extend the throttle. Both forms are allowed: a delay in seconds, or an
 * HTTP date. Anything unparseable or negative falls back to the usual backoff.
 */
export const retryDelayMs = (res: Response, attempt: number): number => {
  const header = res.headers.get('retry-after');
  // Blank as well as absent: Number('') is 0, so a malformed `Retry-After:`
  // with no value would otherwise mean "retry immediately" against a server
  // that has just asked us to slow down.
  if (header === null || header.trim() === '') return backoffMs(attempt);

  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return backoffMs(attempt);
  return Math.min(ms, MAX_RETRY_AFTER_MS);
};

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
      // Both signals, not one or the other: `signal ?? timeout` meant any
      // caller passing a signal silently gave up the 30s timeout and inherited
      // undici's 300s default instead.
      res = await fetch(url, { headers, signal: withTimeout(signal, TIMEOUT_MS) });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      // Guarded like the HTTP-status path below: sleeping after the last
      // attempt burns 16s of dead wait per call during a network outage.
      if (attempt < MAX_ATTEMPTS) await sleep(backoffMs(attempt));
      continue;
    }

    if (res.ok) {
      try {
        return (await res.json()) as T;
      } catch (err) {
        // A 200 carrying a Cloudflare interstitial used to escape as a bare
        // SyntaxError — unwrapped and unretried, unlike the same case on the
        // CDN path. It is transient, so it belongs in the retry loop.
        lastError = new SimklError(`SIMKL returned unparseable JSON for ${path}: ${errorMessage(err)}`, res.status);
        if (attempt < MAX_ATTEMPTS) await sleep(backoffMs(attempt));
        continue;
      }
    }

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
    if (attempt < MAX_ATTEMPTS) await sleep(retryDelayMs(res, attempt));
  }

  throw lastError;
};
