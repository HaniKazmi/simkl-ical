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
import { errorMessage } from '../shared/errors.ts';
import { withTimeout } from '../shared/signals.ts';

/** Archives run to several MB, so this is generous rather than tight. */
const FETCH_TIMEOUT_MS = 60_000;

interface CachedFile<T> {
  data: T;
  lastModified: string | null;
}

export interface CdnResult<T> extends CachedFile<T> {
  /**
   * The network failed and the cached copy was served instead, so health can
   * tell an outage from a quiet CDN. A 304 is not stale: the CDN answered.
   */
  stale: boolean;
  /**
   * The CDN answered 304 — it has not regenerated since the copy in hand.
   * `stale` cannot answer this: it is false for both a 304 and a fresh body,
   * which is the same value for "nothing changed" and "everything did". False
   * on a cached copy served after a failure, where the CDN said nothing at all.
   */
  notModified: boolean;
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

  // Stale data beats no data, so every failure below serves the cache when
  // there is one — flagged stale rather than passing as a success.
  const fallback = (reason: string): CdnResult<T> => {
    if (cached) return { ...cached, stale: true, notModified: false };
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

  if (res.status === 304 && cached) return { ...cached, stale: false, notModified: true };
  if (!res.ok) return fallback(`returned ${res.status}`);

  let data: T;
  try {
    data = (await res.json()) as T;
  } catch (err) {
    // An HTML interstitial served with a 200 must not discard a good cache.
    return fallback(`returned unparseable JSON: ${errorMessage(err)}`);
  }

  const problem = validate?.(data);
  if (problem) return fallback(problem);

  const entry: CachedFile<T> = { data, lastModified: res.headers.get('last-modified') };
  cache.set(key, entry);
  return { ...entry, stale: false, notModified: false };
};
