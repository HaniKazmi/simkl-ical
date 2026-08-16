import { backoffMs, HttpError, retryDelayMs, sleep } from '../backoff.ts';
import { beginRequest, readBody, type RequestComponent } from '../requests.ts';
import { config, requireClientId } from '../../shared/config.ts';
import { errorMessage } from '../../shared/errors.ts';
import { withTimeout } from '../../shared/signals.ts';


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
  /** Which part of the service is asking — see `RequestComponent`. */
  component: RequestComponent;
  token?: string | null;
  params?: Record<string, string | number | undefined | null>;
  signal?: AbortSignal;
}

/**
 * GET a SIMKL API path with backoff. `token` makes it an authenticated call.
 * Verified against the live API: omitting client_id entirely returns 412,
 * a valid client_id without a token returns 401.
 */
export const apiGet = async <T>(path: string, { component, token, params = {}, signal }: ApiGetOptions): Promise<T> => {
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries({ ...baseParams(), ...params })) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const headers = baseHeaders();
  if (token) headers.Authorization = `Bearer ${token}`;

  // One record per call rather than per attempt: the retries are the fact worth
  // surfacing, and this loop spends up to five of them without saying so. It is
  // written once on the way out, from whatever the last attempt saw — so a new
  // exit added below cannot forget to record, which six hand-placed calls could.
  const finish = beginRequest({ service: 'simkl', component, method: 'GET', url });
  let attempts = 0;
  let status: number | null = null;
  let bytes: number | null = null;
  let failure: string | null = null;

  let lastError: unknown;
  try {
    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;
      status = null;
      bytes = null;
      failure = null;

      let res: Response;
      try {
        res = await fetch(url, { headers, signal: withTimeout(signal, TIMEOUT_MS) });
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err;
        failure = errorMessage(err);
        // Guarded: sleeping after the final attempt is dead wait.
        if (attempts < MAX_ATTEMPTS) await sleep(backoffMs(attempts));
        continue;
      }

      status = res.status;

      if (res.ok) {
        const read = await readBody(res);
        bytes = read.bytes;
        if (read.failure) {
          // The download died mid-body. Retryable, and named as itself rather
          // than left to reach the parser as a truncation.
          lastError = new SimklError(`SIMKL ${path}: ${read.failure}`, res.status);
          failure = read.failure;
          if (attempts < MAX_ATTEMPTS) await sleep(backoffMs(attempts));
          continue;
        }
        const { text } = read;
        try {
          return JSON.parse(text) as T;
        } catch (err) {
          // A 200 carrying a Cloudflare interstitial. Transient, so it belongs
          // in the retry loop rather than escaping as a bare SyntaxError.
          lastError = new SimklError(`SIMKL returned unparseable JSON for ${path}: ${errorMessage(err)}`, res.status);
          failure = errorMessage(lastError);
          if (attempts < MAX_ATTEMPTS) await sleep(backoffMs(attempts));
          continue;
        }
      }

      const read = await readBody(res);
      const body = read.text;
      bytes = read.bytes;
      // An error body that could not be read still has a status worth the row.
      failure = read.failure ?? (body || `SIMKL ${res.status} for ${path}`);

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
      if (attempts < MAX_ATTEMPTS) await sleep(retryDelayMs(res, attempts));
    }

    throw lastError;
  } finally {
    // A call the caller cancelled is not an outcome worth a row.
    if (!signal?.aborted) finish({ status, bytes, error: failure, attempts });
  }
};
