/**
 * Conditional GET against a public CDN file, with a process-lifetime cache.
 *
 * Generic transport: `Last-Modified`, timeouts, and serving what it holds when
 * the network fails. It knows nothing about the files' contents — the caller
 * supplies `validate`, because only the caller can say whether a parseable
 * payload is usable.
 *
 * Not on disk: the cache makes the 3-hourly conditional GET cheap, and a
 * restart always resyncs from the CDN.
 */

import { config } from '../shared/config.ts';
import { beginRequest, readBody, type RequestComponent } from './requests.ts';
import { errorMessage } from '../shared/errors.ts';
import { withTimeout } from '../shared/signals.ts';

/** Archives run to several MB, so this is generous rather than tight. */
const FETCH_TIMEOUT_MS = 60_000;

interface CachedFile<T> {
  data: T;
  lastModified: string | null;
}

/**
 * Where the bytes came from. One field, not two booleans, which would make a
 * fourth impossible combination representable.
 *
 * - `fresh` — a body, newer than anything held
 * - `not-modified` — a 304: the CDN answered and has nothing new
 * - `cache` — the CDN did not answer, so the held copy was served
 *
 * Only `cache` is a fault. A 304 is the expected answer at an interval matched
 * to how often the file regenerates.
 */
export type CdnSource = 'fresh' | 'not-modified' | 'cache';

export interface CdnResult<T> extends CachedFile<T> {
  source: CdnSource;
}

const cache = new Map<string, CachedFile<unknown>>();

/** Cache keys currently held. Exported for tests; nothing in src/ reads it. */
export const cachedKeys = (): string[] => [...cache.keys()];

/** Drop everything. Exported for tests, which must not share a cache. */
export const clearCache = (): void => cache.clear();

/** Drop everything the caller no longer wants held. */
export const evictCache = (keep: (key: string) => boolean): void => {
  for (const key of cache.keys()) {
    if (!keep(key)) cache.delete(key);
  }
};

export interface CdnOptions {
  /** Which part of the service is asking — see `RequestComponent`. */
  component: RequestComponent;
  /**
   * Why this payload is unusable, or null if it is fine. Parseable is not
   * usable: a 200 carrying `{}` would otherwise replace a good cache entry.
   */
  validate?: (data: unknown) => string | null;
  signal?: AbortSignal;
}

/**
 * Fetch a JSON file, using the cached copy when the CDN says it hasn't changed.
 *
 * The CDN ignores query strings, so a conditional GET against the stored
 * `Last-Modified` is the only way to tell whether a regeneration happened.
 */
export const fetchCached = async <T>(url: string, key: string, { component, validate, signal }: CdnOptions): Promise<CdnResult<T>> => {
  const cached = (cache.get(key) as CachedFile<T> | undefined) ?? null;
  const headers: Record<string, string> = { 'User-Agent': `${config.appName}/${config.appVersion}` };
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  const finish = beginRequest({ service: 'cdn', component, method: 'GET', url });
  // A cancelled call is not worth a row. `Orchestrator.stop()` aborts in-flight
  // calendar fetches, so without this every shutdown files an error row.
  const log = (status: number | null, bytes: number | null, error: string | null): void => {
    if (!signal?.aborted) finish({ status, bytes, error });
  };

  // Stale beats nothing: every failure below serves the cache when there is
  // one, flagged stale rather than passing as a success.
  const fallback = (reason: string, status: number | null = null, bytes: number | null = null): CdnResult<T> => {
    log(status, bytes, reason);
    if (cached) return { ...cached, source: 'cache' };
    throw new Error(`${url} ${reason}`);
  };

  // Without a timeout a hung connection blocks a refresh cycle until undici's
  // 300s default. The throw is caught like a bad status: a timeout, DNS
  // failure or reset are the likeliest CDN failures, and letting one escape
  // past `fallback` discards a good cached entry.
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: withTimeout(signal, FETCH_TIMEOUT_MS) });
  } catch (err) {
    return fallback(`could not be fetched: ${errorMessage(err)}`);
  }

  // A 304 carries no body, which is the point of asking conditionally.
  if (res.status === 304 && cached) {
    log(res.status, null, null);
    return { ...cached, source: 'not-modified' };
  }
  if (!res.ok) {
    // Drained, not dropped: an unread body holds its socket out of undici's
    // pool until GC, and these are multi-MB files on the 5xx path where the
    // CDN is already struggling.
    await res.body?.cancel().catch(() => {});
    return fallback(`returned ${res.status}`, res.status);
  }

  const { text, bytes, failure } = await readBody(res);
  if (failure) return fallback(failure, res.status);

  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch (err) {
    // An HTML interstitial served with a 200 must not discard a good cache.
    // The size is the tell: a 2 KB interstitial against the multi-megabyte
    // file expected.
    return fallback(`returned unparseable JSON: ${errorMessage(err)}`, res.status, bytes);
  }

  const problem = validate?.(data);
  if (problem) return fallback(problem, res.status, bytes);

  log(res.status, bytes, null);
  const entry: CachedFile<T> = { data, lastModified: res.headers.get('last-modified') };
  cache.set(key, entry);
  return { ...entry, source: 'fresh' };
};
