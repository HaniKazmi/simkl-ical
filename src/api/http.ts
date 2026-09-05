/**
 * The one retrying transport, plus the retry timing it runs on.
 *
 * SIMKL, Sheets, TVDB, TMDB and Cloud Storage differ only in URL assembly,
 * credential headers and status meanings — all held in each client's
 * `HttpSpec`. The loop exists once, so a fix to the truncated-body path or
 * the abort handling cannot land in one upstream and miss the others. What a
 * body *is* — JSON to parse, or bytes to keep — is the one thing the loop
 * delegates, to a consumer that says whether what it read is worth a retry.
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
  /**
   * Sent verbatim under its own content type, for the one caller whose body
   * is not JSON: a multipart upload carrying image bytes. Exclusive with
   * `body`.
   */
  rawBody?: { bytes: Uint8Array<ArrayBuffer>; contentType: string };
  /**
   * What to do with a 3xx. `follow` everywhere but the image download, which
   * passes `manual` so a redirect surfaces as its own status and is judged by
   * `onStatus` rather than silently fetched from wherever it points.
   */
  redirect?: RequestRedirect;
  /** Per-call override: a non-idempotent write passes 1 rather than the spec's budget. */
  maxAttempts?: number;
  /** Names the call in failure messages; defaults to the URL's path. */
  path?: string;
  signal?: AbortSignal;
}

/**
 * What a consumer made of an ok response's body. `retry` says whether the
 * failure is the transfer's — a download that died, a 200 carrying an HTML
 * interstitial — or the payload's, which asking again cannot change.
 */
type Consumed<T> = { value: T; bytes: number } | { error: HttpError; failure: string; bytes: number | null; retry: boolean };

type Consumer<T> = (res: Response, describe: { spec: HttpSpec; path: string }) => Promise<Consumed<T>>;

/**
 * Make a request with backoff, one request-log record per call.
 *
 * Per call, not per attempt: the retries are the fact worth surfacing, and the
 * loop spends up to five without saying so. Written once on the way out from
 * whatever the last attempt saw, so a new exit cannot forget to record.
 */
const request = async <T>(
  spec: HttpSpec,
  url: URL,
  { component, method = 'GET', headers, body, rawBody, redirect = 'follow', maxAttempts = spec.maxAttempts, path = url.pathname, signal }: HttpRequestOptions,
  consume: Consumer<T>,
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
        if (rawBody) requestHeaders['Content-Type'] = rawBody.contentType;
        res = await fetch(url, {
          method,
          headers: requestHeaders,
          body: rawBody ? rawBody.bytes : body === undefined ? undefined : JSON.stringify(body),
          redirect,
          signal: withTimeout(signal, spec.timeoutMs),
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        await retryWith(err, errorMessage(err), backoffMs(attempts));
        continue;
      }

      status = res.status;

      if (res.ok) {
        const consumed = await consume(res, { spec, path });
        bytes = consumed.bytes;
        if ('value' in consumed) return consumed.value;
        if (!consumed.retry) {
          failure = consumed.failure;
          throw consumed.error;
        }
        await retryWith(consumed.error, consumed.failure, backoffMs(attempts));
        continue;
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

/** An ok body as JSON. A dead download and an unparseable body are both transient. */
const consumeJson =
  <T>(): Consumer<T> =>
  async (res, { spec, path }) => {
    const read = await readBody(res);
    if (read.failure) {
      // The download died mid-body. Retryable, and named as itself rather
      // than reaching the parser as a truncation.
      return { error: spec.errorFor(`${spec.label} ${path}: ${read.failure}`, res.status), failure: read.failure, bytes: read.bytes, retry: true };
    }
    try {
      return { value: JSON.parse(read.text) as T, bytes: read.bytes };
    } catch (err) {
      // A 200 carrying an HTML interstitial. Transient, so it retries
      // rather than escaping as a bare SyntaxError.
      const wrapped = spec.errorFor(`${spec.label} returned unparseable JSON for ${path}: ${errorMessage(err)}`, res.status);
      return { error: wrapped, failure: errorMessage(wrapped), bytes: read.bytes, retry: true };
    }
  };

/** GET/POST a JSON endpoint with backoff. */
export const requestJson = <T>(spec: HttpSpec, url: URL, options: HttpRequestOptions): Promise<T> => request(spec, url, options, consumeJson<T>());

export interface RawResponse {
  bytes: Uint8Array;
  /** The `Content-Type` header verbatim, or null when the upstream sent none. */
  contentType: string | null;
}

/**
 * An ok body as bytes, refused past `maxBytes` **before** the rest is
 * downloaded — the header when the upstream sends a length, the stream when
 * it does not. Over-size is the payload's fault and terminal; a stream that
 * dies is the transfer's and retries, the same split `consumeJson` makes.
 */
const consumeBytes =
  (maxBytes: number): Consumer<RawResponse> =>
  async (res, { spec, path }) => {
    const tooLarge = (size: number): Consumed<RawResponse> => ({
      error: spec.errorFor(`${spec.label} ${path}: body is ${size} bytes, over the ${maxBytes} byte limit`, res.status),
      failure: `body over the ${maxBytes} byte limit`,
      bytes: null,
      retry: false,
    });
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return tooLarge(declared);

    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (res.body) {
        for await (const chunk of res.body) {
          size += chunk.byteLength;
          if (size > maxBytes) {
            await res.body.cancel().catch(() => {});
            return tooLarge(size);
          }
          chunks.push(chunk);
        }
      }
    } catch (err) {
      const failure = `the response body could not be read: ${errorMessage(err)}`;
      return { error: spec.errorFor(`${spec.label} ${path}: ${failure}`, res.status), failure, bytes: size, retry: true };
    }
    return { value: { bytes: Buffer.concat(chunks), contentType: res.headers.get('content-type') }, bytes: size };
  };

/** GET a binary endpoint with backoff, bounded in size. */
export const requestBytes = (spec: HttpSpec, url: URL, { maxBytes, ...options }: HttpRequestOptions & { maxBytes: number }): Promise<RawResponse> =>
  request(spec, url, options, consumeBytes(maxBytes));
