/**
 * The one retrying JSON transport, plus the retry timing it runs on.
 *
 * SIMKL, Sheets and TVDB differ in how a URL is assembled, what headers carry
 * the credential, and what each status means — and in nothing else. Those
 * differences live in each client's `HttpSpec`; the loop itself exists once, so
 * a fix to the truncated-body path or the abort handling cannot be made in one
 * upstream and missed in two.
 */

import { config } from '../shared/config.ts';
import { errorMessage } from '../shared/errors.ts';
import { withTimeout } from '../shared/signals.ts';
import { beginRequest, readBody, type RequestComponent, type RequestService } from './requests.ts';

/** Ceiling on a server-requested wait, so a hostile header cannot stall a refresh. */
const MAX_RETRY_AFTER_MS = 60_000;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const backoffMs = (attempt: number): number => 2 ** (attempt - 1) * config.retryBase.total('milliseconds');

/**
 * How long to wait before the next attempt. Cloudflare answers a 429 with
 * `Retry-After` and retrying sooner can extend the throttle. Both forms are
 * accepted — seconds or an HTTP date — and anything unusable falls back to the
 * exponential backoff.
 */
export const retryDelayMs = (res: Response, attempt: number): number => {
  // Blank as well as absent: Number('') is 0, which would mean "retry now"
  // against a server that just asked us to slow down.
  const header = res.headers.get('retry-after');
  if (header === null || header.trim() === '') return backoffMs(attempt);

  const seconds = Number(header);
  // The one `Date.parse` in `src/`, and it has to be: the other form of this
  // header is an RFC 7231 HTTP-date (`Wed, 21 Oct 2015 07:28:00 GMT`), which
  // Temporal does not parse — it reads ISO 8601 and nothing else. The leniency
  // is harmless here because the result is range-checked below and clamped, so
  // a header that parses to nonsense falls back to the backoff.
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return backoffMs(attempt);
  return Math.min(ms, MAX_RETRY_AFTER_MS);
};

/**
 * A failed HTTP call, carrying enough to classify it. Each client subclasses
 * this so `instanceof` still separates a SIMKL problem from a Sheets one.
 */
export class HttpError extends Error {
  status: number | undefined;
  body: string | undefined;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/** What one upstream is: everything about it that the shared loop cannot know. */
export interface HttpSpec {
  service: RequestService;
  /** Names the upstream in transport-level failure messages: 'SIMKL', 'Sheets', 'TVDB'. */
  label: string;
  maxAttempts: number;
  timeoutMs: number;
  /** Wraps a failure the loop itself detects — a dead download, unparseable JSON, an exhausted retry. */
  errorFor: (message: string, status?: number, body?: string) => HttpError;
  /**
   * What a non-ok status means: the error to throw, or `'retry'` to hand it to
   * the loop, which sleeps per `Retry-After`. Side effects that must accompany
   * a terminal status — clearing a token cache on a 401 — belong in here, so
   * they cannot be separated from the classification that requires them.
   */
  onStatus: (status: number, body: string, path: string) => Error | 'retry';
}

export interface HttpRequestOptions {
  /** Which part of the service is asking — see `RequestComponent`. */
  component: RequestComponent;
  method?: string;
  /**
   * Re-evaluated on every attempt, inside the retry: re-signing an expired
   * credential per attempt is the point, and a transient failure *obtaining*
   * one is exactly as retryable as a transient failure using it.
   */
  headers?: (signal?: AbortSignal) => Promise<Record<string, string>> | Record<string, string>;
  /** JSON-encoded when present. */
  body?: unknown;
  /** Per-call override: a non-idempotent write passes 1 rather than the spec's budget. */
  maxAttempts?: number;
  /** Names the call in failure messages; defaults to the URL's path. */
  path?: string;
  signal?: AbortSignal;
}

/**
 * GET/POST a JSON endpoint with backoff, one request-log record per call.
 *
 * One record per call rather than per attempt: the retries are the fact worth
 * surfacing, and the loop spends up to five of them without saying so. It is
 * written once on the way out, from whatever the last attempt saw — so a new
 * exit added below cannot forget to record, which hand-placed calls could.
 */
export const requestJson = async <T>(
  spec: HttpSpec,
  url: URL,
  { component, method = 'GET', headers, body, maxAttempts = spec.maxAttempts, path = url.pathname, signal }: HttpRequestOptions,
): Promise<T> => {
  const finish = beginRequest({ service: spec.service, component, method, url });
  let attempts = 0;
  let status: number | null = null;
  let bytes: number | null = null;
  let failure: string | null = null;

  let lastError: unknown;
  try {
    while (attempts < maxAttempts) {
      attempts += 1;
      status = null;
      bytes = null;
      failure = null;

      let res: Response;
      try {
        const requestHeaders = { ...(await headers?.(signal)) };
        if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
        res = await fetch(url, {
          method,
          headers: requestHeaders,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: withTimeout(signal, spec.timeoutMs),
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err;
        failure = errorMessage(err);
        // Guarded: sleeping after the final attempt is dead wait.
        if (attempts < maxAttempts) await sleep(backoffMs(attempts));
        continue;
      }

      status = res.status;

      if (res.ok) {
        const read = await readBody(res);
        bytes = read.bytes;
        if (read.failure) {
          // The download died mid-body. Retryable, and named as itself rather
          // than left to reach the parser as a truncation.
          lastError = spec.errorFor(`${spec.label} ${path}: ${read.failure}`, res.status);
          failure = read.failure;
          if (attempts < maxAttempts) await sleep(backoffMs(attempts));
          continue;
        }
        try {
          return JSON.parse(read.text) as T;
        } catch (err) {
          // A 200 carrying an HTML interstitial. Transient, so it belongs in
          // the retry loop rather than escaping as a bare SyntaxError.
          lastError = spec.errorFor(`${spec.label} returned unparseable JSON for ${path}: ${errorMessage(err)}`, res.status);
          failure = errorMessage(lastError);
          if (attempts < maxAttempts) await sleep(backoffMs(attempts));
          continue;
        }
      }

      const read = await readBody(res);
      bytes = read.bytes;

      const outcome = spec.onStatus(res.status, read.text, path);
      if (outcome !== 'retry') {
        // An error body that could not be read still has a status worth the row.
        failure = read.failure ?? (read.text || outcome.message);
        throw outcome;
      }

      lastError = spec.errorFor(`${spec.label} ${res.status} for ${path}`, res.status, read.text);
      failure = read.failure ?? (read.text || (lastError as HttpError).message);
      if (attempts < maxAttempts) await sleep(retryDelayMs(res, attempts));
    }

    throw lastError;
  } finally {
    // A call the caller cancelled is not an outcome worth a row.
    if (!signal?.aborted) finish({ status, bytes, error: failure, attempts });
  }
};
