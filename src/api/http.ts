/**
 * The one retrying JSON transport, plus the retry timing it runs on.
 *
 * SIMKL, Sheets and TVDB differ only in URL assembly, credential headers and
 * status meanings — all held in each client's `HttpSpec`. The loop exists once,
 * so a fix to the truncated-body path or the abort handling cannot land in one
 * upstream and miss the other two.
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
 * Wait before the next attempt. Cloudflare answers a 429 with `Retry-After`,
 * and retrying sooner can extend the throttle. Accepts seconds or an HTTP
 * date; anything unusable falls back to the exponential backoff.
 */
export const retryDelayMs = (res: Response, attempt: number): number => {
  // Blank as well as absent: Number('') is 0, which would mean "retry now".
  const header = res.headers.get('retry-after');
  if (header === null || header.trim() === '') return backoffMs(attempt);

  const seconds = Number(header);
  // The one `Date.parse` in `src/`: the other form of this header is an RFC
  // 7231 HTTP-date (`Wed, 21 Oct 2015 07:28:00 GMT`), which Temporal cannot
  // parse — it reads ISO 8601 only. The leniency is harmless: the result is
  // range-checked and clamped below, so nonsense falls back to the backoff.
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return backoffMs(attempt);
  return Math.min(ms, MAX_RETRY_AFTER_MS);
};

/**
 * A failed HTTP call, with enough to classify it. Each client subclasses this
 * so `instanceof` separates a SIMKL problem from a Sheets one.
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
   * What a non-ok status means: an error to throw, or `'retry'` (the loop
   * sleeps per `Retry-After`). Side effects tied to a status — clearing a
   * token cache on a 401 — belong here, beside the classification that
   * requires them.
   */
  onStatus: (status: number, body: string, path: string) => Error | 'retry';
}

export interface HttpRequestOptions {
  /** Which part of the service is asking — see `RequestComponent`. */
  component: RequestComponent;
  method?: string;
  /**
   * Re-evaluated on every attempt: re-signing an expired credential per
   * attempt is the point, and a transient failure obtaining one is as
   * retryable as one using it.
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
 * Per call, not per attempt: the retries are the fact worth surfacing, and the
 * loop spends up to five without saying so. Written once on the way out from
 * whatever the last attempt saw, so a new exit cannot forget to record.
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
  // Every retryable outcome funnels through here, so a retry-path fix cannot
  // land on one kind of failure and miss the others.
  const retryWith = async (err: unknown, message: string, delay: number): Promise<void> => {
    lastError = err;
    failure = message;
    // Sleeping after the final attempt is dead wait.
    if (attempts < maxAttempts) await sleep(delay);
  };

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
        await retryWith(err, errorMessage(err), backoffMs(attempts));
        continue;
      }

      status = res.status;

      if (res.ok) {
        const read = await readBody(res);
        bytes = read.bytes;
        if (read.failure) {
          // The download died mid-body. Retryable, and named as itself rather
          // than reaching the parser as a truncation.
          await retryWith(spec.errorFor(`${spec.label} ${path}: ${read.failure}`, res.status), read.failure, backoffMs(attempts));
          continue;
        }
        try {
          return JSON.parse(read.text) as T;
        } catch (err) {
          // A 200 carrying an HTML interstitial. Transient, so it retries
          // rather than escaping as a bare SyntaxError.
          const wrapped = spec.errorFor(`${spec.label} returned unparseable JSON for ${path}: ${errorMessage(err)}`, res.status);
          await retryWith(wrapped, errorMessage(wrapped), backoffMs(attempts));
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

      const err = spec.errorFor(`${spec.label} ${res.status} for ${path}`, res.status, read.text);
      await retryWith(err, read.failure ?? (read.text || err.message), retryDelayMs(res, attempts));
    }

    throw lastError;
  } finally {
    // A call the caller cancelled is not an outcome worth a row.
    if (!signal?.aborted) finish({ status, bytes, error: failure, attempts });
  }
};
