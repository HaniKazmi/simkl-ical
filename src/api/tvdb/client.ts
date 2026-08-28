/**
 * The TVDB v4 transport. One endpoint is used: a season's episode list, for the
 * per-episode runtimes SIMKL's API does not carry.
 *
 * Same shape as `simkl/client.ts` — one request record per call, the shared
 * backoff, and a status mapping onto the pool's three-way split — with two
 * differences that matter. It is bearer-authenticated with a token that has to
 * be fetched first, and the credential goes in a header rather than the query:
 * `describeUrl` renders request paths onto the status page and into the request
 * log, and keeping a credential off a rendered page by denylisting its
 * parameter name is exactly the fragility the feed token's rule warns about.
 */

import { HttpError, backoffMs, retryDelayMs, sleep } from '../backoff.ts';
import { beginRequest, readBody, type RequestComponent } from '../requests.ts';
import { clearTokenCache, getTvdbToken, TvdbAuthError } from './auth.ts';
import { errorMessage } from '../../shared/errors.ts';
import { withTimeout } from '../../shared/signals.ts';
import type { FailureKind } from '../pool.ts';

const API_BASE = 'https://api4.thetvdb.com/v4/';

// 429 is in here as well as the 5xx range: TVDB answers a throttle with
// `Retry-After`, which is the header `retryDelayMs` exists to read, and honouring
// it is what stops a retry extending the throttle.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Deliberately below the other clients' five.
 *
 * This phase sits inside a sheet run whose snapshot goes stale at `FRESH_MS`
 * (120s), and blowing that budget re-reads the whole grid and re-plans. Nothing
 * here is load-bearing — an unanswered season just stays open for a poll — so it
 * should be the first thing to give up, not the thing that costs the run its
 * snapshot. Two attempts against a 10s timeout is 21s of *timeout*; a throttled
 * season can still spend `MAX_RETRY_AFTER_MS` on top, which is why `sync.ts`
 * runs this phase on the first planning attempt only.
 */
const MAX_ATTEMPTS = 2;

const TIMEOUT_MS = 10_000;

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

  // Outside the record below: a failed login is its own row, under `auth`, and
  // filing it as a failed season read would point a reader at the wrong fix.
  const token = await getTvdbToken({ signal });

  // One record per call rather than per attempt, written on the way out — so a
  // new exit added below cannot forget to record. Same reasoning as the SIMKL
  // client, and the same shape.
  const finish = beginRequest({ service: 'tvdb', component, method: 'GET', url });
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
        res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: withTimeout(signal, TIMEOUT_MS) });
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err;
        failure = errorMessage(err);
        if (attempts < MAX_ATTEMPTS) await sleep(backoffMs(attempts));
        continue;
      }

      status = res.status;

      if (res.ok) {
        const read = await readBody(res);
        bytes = read.bytes;
        if (read.failure) {
          lastError = new TvdbError(`TVDB ${path}: ${read.failure}`, res.status);
          failure = read.failure;
          if (attempts < MAX_ATTEMPTS) await sleep(backoffMs(attempts));
          continue;
        }
        try {
          return JSON.parse(read.text) as T;
        } catch (err) {
          lastError = new TvdbError(`TVDB returned unparseable JSON for ${path}: ${errorMessage(err)}`, res.status);
          failure = errorMessage(lastError);
          if (attempts < MAX_ATTEMPTS) await sleep(backoffMs(attempts));
          continue;
        }
      }

      const read = await readBody(res);
      const body = read.text;
      bytes = read.bytes;
      failure = read.failure ?? (body || `TVDB ${res.status} for ${path}`);

      if (res.status === 401 || res.status === 403) {
        // The lifetime in `auth.ts` is assumed rather than read, so a token can
        // in principle outlive its welcome. Dropping the cache here is what
        // makes that cost one poll: the next run logs in again.
        clearTokenCache();
        throw new TvdbError(`TVDB rejected the token (${res.status})`, res.status, body);
      }
      if (!RETRYABLE.has(res.status)) {
        throw new TvdbError(`TVDB ${res.status} for ${path}`, res.status, body);
      }

      lastError = new TvdbError(`TVDB ${res.status} for ${path}`, res.status, body);
      if (attempts < MAX_ATTEMPTS) await sleep(retryDelayMs(res, attempts));
    }

    throw lastError;
  } finally {
    if (!signal?.aborted) finish({ status, bytes, error: failure, attempts });
  }
};
