/**
 * Retry timing shared by every HTTP transport here.
 *
 * Extracted rather than copied: `retryDelayMs` in particular encodes two
 * things that are easy to get subtly wrong — a blank `Retry-After` is not zero,
 * and the header may be an HTTP date rather than seconds — and a second copy
 * means fixing one and not the other. What varies per API (base URL, auth,
 * which statuses retry, how a status maps to an error) stays in each client.
 */

import { config } from './shared/config.ts';

/** Ceiling on a server-requested wait, so a hostile header cannot stall a refresh. */
export const MAX_RETRY_AFTER_MS = 60_000;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const backoffMs = (attempt: number): number => 2 ** (attempt - 1) * config.retryBaseMs;

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
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return backoffMs(attempt);
  return Math.min(ms, MAX_RETRY_AFTER_MS);
};

/**
 * A failed HTTP call, carrying enough to classify it. Each transport subclasses
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
