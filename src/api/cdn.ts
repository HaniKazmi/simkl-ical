/**
 * Conditional GET against a public CDN file, with a process-lifetime cache.
 *
 * Generic transport: it knows about `Last-Modified`, timeouts, and serving what
 * it already has when the network fails. It knows nothing about what the files
 * contain — the caller supplies `validate`, because only the caller can say
 * whether a parseable payload is a *usable* one.
 *
 * Deliberately not on disk: it makes the 3-hourly conditional GET cheap, while
 * a restart always resyncs from the CDN.
 */

import { config } from '../shared/config.ts';
import { describeUrl, recordRequest } from './requests.ts';
import { errorMessage } from '../shared/errors.ts';
import { withTimeout } from '../shared/signals.ts';

/** Archives run to several MB, so this is generous rather than tight. */
const FETCH_TIMEOUT_MS = 60_000;

interface CachedFile<T> {
  data: T;
  lastModified: string | null;
}

/**
 * Where the bytes came from. Three outcomes, one field: two booleans would make
 * a fourth combination representable that cannot happen, and force every reader
 * to spell "the CDN regenerated" as a double negative.
 *
 * - `fresh` — a body, newer than anything held
 * - `not-modified` — a 304: the CDN answered and has nothing new
 * - `cache` — the CDN did not answer, so the held copy was served instead
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
  /**
   * Why this payload is unusable, or null if it is fine. Parseable is not
   * usable: a 200 carrying `{}` or an error object would otherwise replace a
   * good cache entry.
   */
  validate?: (data: unknown) => string | null;
  signal?: AbortSignal;
}

/**
 * Fetch a JSON file, using the cached copy when the CDN says it hasn't changed.
 *
 * The CDN ignores query strings, so cache-busting is impossible and a
 * conditional GET against the stored `Last-Modified` is the only way to tell
 * whether a regeneration has actually happened.
 */
export const fetchCached = async <T>(url: string, key: string, { validate, signal }: CdnOptions = {}): Promise<CdnResult<T>> => {
  const cached = (cache.get(key) as CachedFile<T> | undefined) ?? null;
  const headers: Record<string, string> = { 'User-Agent': `${config.appName}/${config.appVersion}` };
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  const started = Date.now();
  const log = (status: number | null, bytes: number | null, error: string | null): void =>
    recordRequest({
      at: new Date().toISOString(),
      service: 'cdn',
      method: 'GET',
      path: describeUrl(url),
      status,
      ms: Date.now() - started,
      bytes,
      attempts: 1,
      error,
    });

  // Stale data beats no data, so every failure below serves the cache when
  // there is one — flagged stale rather than passing as a success.
  const fallback = (reason: string, status: number | null = null): CdnResult<T> => {
    log(status, null, reason);
    if (cached) return { ...cached, source: 'cache' };
    throw new Error(`${url} ${reason}`);
  };

  // Without a timeout a hung connection blocks a refresh cycle until undici's
  // 300s default. The throw is caught for the same reason a bad status is: a
  // timeout, a DNS failure or a reset are the *likeliest* ways a CDN fails, and
  // letting one escape past `fallback` discards a perfectly good cached entry.
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
    // Drained rather than dropped. An unread body holds its socket out of
    // undici's pool until GC, and these are the multi-MB files — on exactly
    // the 5xx path where the CDN is already struggling.
    await res.body?.cancel().catch(() => {});
    return fallback(`returned ${res.status}`, res.status);
  }

  // Read as text so the size is known; `res.json()` does the same internally.
  const text = await res.text().catch(() => '');
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch (err) {
    // An HTML interstitial served with a 200 must not discard a good cache.
    return fallback(`returned unparseable JSON: ${errorMessage(err)}`, res.status);
  }

  const problem = validate?.(data);
  if (problem) return fallback(problem, res.status);

  log(res.status, text.length, null);
  const entry: CachedFile<T> = { data, lastModified: res.headers.get('last-modified') };
  cache.set(key, entry);
  return { ...entry, source: 'fresh' };
};
