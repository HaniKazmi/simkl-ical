import { backoffMs, HttpError, retryDelayMs, sleep } from '../backoff.ts';
import { config, requireClientId } from '../config.ts';
import { errorMessage } from '../errors.ts';
import { withTimeout } from '../signals.ts';

export { retryDelayMs };

const API_BASE = 'https://api.simkl.com';

// 408 is a server-side read timeout, and 520-524 are Cloudflare's own origin
// failures — SIMKL sits behind it, and all of them are transient by definition.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

/**
 * Statuses meaning the resource will never resolve, however often we ask —
 * typically merged into another id or deleted upstream.
 *
 * Deliberately narrow, and kept beside RETRYABLE: the two answer different
 * questions ("will this ever succeed?" against "retry within this call?") but
 * must stay disjoint, which is only visible with both in one file.
 */
const GONE = new Set([404, 410]);

const MAX_ATTEMPTS = 5;

// Sync responses are small; without this a hung connection stalls a refresh
// cycle until undici's 300s default.
const TIMEOUT_MS = 30_000;

export class SimklError extends HttpError {
  constructor(message: string, status?: number, body?: string) {
    super(message, status, body);
    this.name = 'SimklError';
  }
}

/**
 * A revoked or invalid token, so callers can tell "log in again" from "SIMKL is
 * having a bad day" and keep serving the last good snapshot.
 */
export class SimklAuthError extends SimklError {
  constructor(message: string, status?: number, body?: string) {
    super(message, status, body);
    this.name = 'SimklAuthError';
  }
}

/**
 * How a caller should treat a failure apiGet could not retry away.
 *
 * - `account`: a revoked token or rejected client id, not a fact about the
 *   resource; callers doing per-item work must let it propagate.
 * - `gone`: settled. Retrying never starts working.
 * - `transient`: worth trying again later.
 */
export type FailureKind = 'account' | 'gone' | 'transient';

export const classify = (err: unknown): FailureKind => {
  if (err instanceof SimklAuthError) return 'account';
  if (!(err instanceof SimklError) || err.status === undefined) return 'transient';
  if (err.status === 412) return 'account';
  return GONE.has(err.status) ? 'gone' : 'transient';
};

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
      res = await fetch(url, { headers, signal: withTimeout(signal, TIMEOUT_MS) });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      // Guarded: sleeping after the final attempt is dead wait.
      if (attempt < MAX_ATTEMPTS) await sleep(backoffMs(attempt));
      continue;
    }

    if (res.ok) {
      try {
        return (await res.json()) as T;
      } catch (err) {
        // A 200 carrying a Cloudflare interstitial. Transient, so it belongs in
        // the retry loop rather than escaping as a bare SyntaxError.
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
