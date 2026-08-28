/**
 * The TVDB v4 transport. One endpoint is used: a season's episode list, for the
 * per-episode runtimes SIMKL's API does not carry.
 *
 * The credential goes in a header rather than the query: `describeUrl` renders
 * request paths onto the status page and into the request log, and keeping a
 * credential off a rendered page by denylisting its parameter name is exactly
 * the fragility the feed token's rule warns about.
 */

import { HttpError, requestJson, type HttpSpec } from '../http.ts';
import type { RequestComponent } from '../requests.ts';
import { clearTokenCache, getTvdbToken, TvdbAuthError } from './auth.ts';
import type { FailureKind } from '../pool.ts';

const API_BASE = 'https://api4.thetvdb.com/v4/';

// 429 is in here as well as the 5xx range: TVDB answers a throttle with
// `Retry-After`, which is the header `retryDelayMs` exists to read, and honouring
// it is what stops a retry extending the throttle.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class TvdbError extends HttpError {
  constructor(message: string, status?: number, body?: string) {
    super(message, status, body);
    this.name = 'TvdbError';
  }
}

/**
 * TVDB's statuses against the shared split.
 *
 * A 404 is the *series* being unknown. A season the series does not have is not
 * an error at all — it comes back 200 with an empty episode list — so the
 * commonest "no data" case never reaches this function, and it is
 * `averageRuntime` returning null that settles it.
 */
export const classify = (err: unknown): FailureKind => {
  // Read the status even on an auth error. `exchangeToken` raises one for *any*
  // non-ok login, so a 503 from the login endpoint arrives as the same class as
  // a rejected key — and calling that `account` would settle every season on a
  // TVDB outage, while calling a rejected key `transient` retries a typo for
  // ever. Only the status separates them.
  const status = err instanceof TvdbAuthError || err instanceof TvdbError ? err.status : undefined;
  if (status === undefined) return 'transient';
  if (status === 401 || status === 403) return 'account';
  return status === 404 ? 'gone' : 'transient';
};

/**
 * Two attempts, deliberately below the other clients' budgets.
 *
 * This phase sits inside a sheet run whose snapshot goes stale at `FRESH_MS`
 * (120s), and blowing that budget re-reads the whole grid and re-plans. Nothing
 * here is load-bearing — an unanswered season just stays open for a poll — so it
 * should be the first thing to give up, not the thing that costs the run its
 * snapshot.
 */
const SPEC: HttpSpec = {
  service: 'tvdb',
  label: 'TVDB',
  maxAttempts: 2,
  timeoutMs: 10_000,
  errorFor: (message, status, body) => new TvdbError(message, status, body),
  onStatus: (status, body, path) => {
    if (status === 401 || status === 403) {
      // The lifetime in `auth.ts` is assumed rather than read, so a token can
      // in principle outlive its welcome. Dropping the cache here is what
      // makes that cost one poll: the next run logs in again.
      clearTokenCache();
      return new TvdbError(`TVDB rejected the token (${status})`, status, body);
    }
    if (RETRYABLE.has(status)) return 'retry';
    return new TvdbError(`TVDB ${status} for ${path}`, status, body);
  },
};

export interface TvdbGetOptions {
  component: RequestComponent;
  params?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

export const apiGet = async <T>(path: string, { component, params = {}, signal }: TvdbGetOptions): Promise<T> => {
  const url = new URL(path.replace(/^\//, ''), API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  // Outside the engine's request record: a failed login is its own row, under
  // `auth`, and filing it as a failed season read would point a reader at the
  // wrong fix.
  const token = await getTvdbToken({ signal });

  return requestJson<T>(SPEC, url, { component, headers: () => ({ Authorization: `Bearer ${token}` }), path, signal });
};
