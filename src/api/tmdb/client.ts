/**
 * The TMDB v3 transport. One endpoint is used: a film's detail, with the
 * release dates, credits and English backdrops appended, for the eight columns
 * on the sheet's `Movies` tab SIMKL does not carry.
 *
 * The credential goes in a header, not the query, for the reason `tvdb/client.ts`
 * gives: `describeUrl` renders request paths onto the status page and the
 * request log. TMDB's own v3 convention is `?api_key=`, which would put the
 * credential there; the v4 read-access token this takes is a bearer, so there
 * is nothing to denylist. There is no token exchange and so no `auth.ts` — the
 * token is issued once in TMDB's dashboard and does not expire.
 *
 * The choice of TMDB here does not reverse the one `.env.example` records
 * against it. That rejection is about *per-episode runtimes*, where TVDB wins
 * because it is what simkl.com itself shows. A film's genres, certificate,
 * backdrop and collection have no TVDB equivalent at all.
 */

import { HttpError, requestJson, type HttpSpec } from '../http.ts';
import type { FailureKind } from '../pool.ts';
import type { RequestComponent } from '../requests.ts';
import { config } from '../../shared/config.ts';

const API_BASE = 'https://api.themoviedb.org/3/';

// 429 included: TMDB answers a throttle with `Retry-After`, the header
// `retryDelayMs` reads, and honouring it stops a retry extending the throttle.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class TmdbError extends HttpError {
  constructor(message: string, status?: number, body?: string) {
    super(message, status, body);
    this.name = 'TmdbError';
  }
}

/**
 * TMDB's statuses against the shared split.
 *
 * A 404 is the film being unknown to TMDB, which is a settled answer: that
 * film's row can never be built, and re-asking every poll would never change
 * it. A 401 is the token, and settling every pending film on one is the point
 * — `lookupPool` rethrows `account` so a rejected key cannot be filed as three
 * hundred dead films.
 */
export const classify = (err: unknown): FailureKind => {
  const status = err instanceof TmdbError ? err.status : undefined;
  if (status === undefined) return 'transient';
  // 401 only. TVDB counts a 403 as `account` too, but there the cost is one
  // runtime cell left blank for a poll; here `account` settles every pending
  // film as permanently unbuildable for the life of the process, and TMDB
  // answers a throttled or WAF-blocked request with 403 as readily as a
  // rejected token. A wrong token still fails closed, one poll later, through
  // the 401 its next request gets.
  if (status === 401) return 'account';
  return status === 404 ? 'gone' : 'transient';
};

/**
 * Two attempts, matching TVDB's budget and for the same reason: this phase
 * sits inside a sheet run whose snapshot goes stale at `FRESH_MS` (120s), and
 * blowing that budget re-reads the whole grid and re-plans. An unanswered film
 * waits a poll, which costs nothing.
 */
const SPEC: HttpSpec = {
  service: 'tmdb',
  label: 'TMDB',
  maxAttempts: 2,
  timeoutMs: 10_000,
  errorFor: (message, status, body) => new TmdbError(message, status, body),
  onStatus: (status, body, path) => {
    if (RETRYABLE.has(status)) return 'retry';
    return new TmdbError(`TMDB ${status} for ${path}`, status, body);
  },
};

export interface TmdbGetOptions {
  component: RequestComponent;
  params?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

export const apiGet = async <T>(path: string, { component, params = {}, signal }: TmdbGetOptions): Promise<T> => {
  // Read inside the call, never at module load, so importing this from a test
  // cannot reach a credential.
  const token = config.tmdbApiKey;
  // Thrown before any fetch, so an unconfigured install cannot reach TMDB even
  // if a caller forgets to gate on `tmdbConfigured`.
  if (!token) throw new TmdbError('TMDB_API_KEY is not set, so no film lookup can be made.');

  const url = new URL(path.replace(/^\//, ''), API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  return requestJson<T>(SPEC, url, {
    component,
    path,
    signal,
    headers: () => ({ Authorization: `Bearer ${token}` }),
  });
};
