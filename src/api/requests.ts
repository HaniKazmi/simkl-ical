/**
 * What this process asked the internet for, and what came back.
 *
 * Every outbound call lands here — SIMKL, the airdate CDN, Google Sheets — so
 * the status page can show the poll's own conversation rather than only its
 * conclusions. That is the one thing the page could not show: the feed section
 * reports pipeline steps and the sheet section reports cell edits, but nothing
 * reported whether the gate is doing its job. A column of lone
 * `/sync/activities` calls with the occasional delta beside it *is* that
 * evidence, and it is only visible on a running instance.
 *
 * It is also what separates the one failure mode that lies. A burst of uncached
 * sync calls comes back `401 user_token_failed`, which reads as a dead token; a
 * log carrying the status, the retry count and the response body tells that
 * from a token that was actually revoked — the difference between waiting and
 * re-authorising.
 *
 * In memory, and capped. This is diagnostic state about *this* process, like
 * the CDN's response cache and the last gate outcome; persisting it would mean
 * a fourth file and the schema validation the run journal carries, for data
 * whose value is almost entirely "what is happening right now".
 */

import { errorMessage } from '../shared/errors.ts';

/**
 * Capped *per component*, not overall, because the components fire at wildly
 * different rates and a single ring is won by the noisiest one.
 *
 * `resolveFilms` looks up every due film in one unbounded pass, so a cold start
 * on a 337-film library makes hundreds of `films` calls in a few seconds. Under
 * one shared cap the `/sync/activities` and delta rows — the evidence this
 * module exists for, and the only place the gate is observable — are gone before
 * the first page load. Segmenting means no component can evict another, and the
 * page stays bounded at six times this.
 */
const MAX_PER_COMPONENT = 8;

/** A failure body is upstream text of unknown length; the page needs a line, not a page. */
const MAX_ERROR_CHARS = 300;

export type RequestService = 'simkl' | 'cdn' | 'sheets';

/**
 * Which part of the service asked, which is not the same question as which
 * upstream answered. SIMKL serves three of these — the poll, the feed's film
 * dates and the sheet's per-title reads — so `simkl /tv/1649662` says nothing
 * about *why* without this.
 *
 * `auth` earns a name of its own for the same reason: a failing token exchange
 * and a rejected spreadsheet read are the same `sheets` service and want
 * opposite fixes, and filed under `spreadsheet` the row would point a reader at
 * an endpoint that was never called.
 *
 * A property of the calling module rather than of the request, so every `io/`
 * module names itself once. Required rather than defaulted: a new call site
 * should have to decide, and `tsc` asking is the difference between a label
 * that stays true and one that quietly rots.
 */
export type RequestComponent = 'poll' | 'calendars' | 'films' | 'catalogue' | 'spreadsheet' | 'auth' | 'login';

export interface RequestRecord {
  at: string;
  service: RequestService;
  component: RequestComponent;
  method: string;
  /** Path plus the parameters worth reading — see `describeUrl`. */
  path: string;
  /** Null when the fetch itself threw: a timeout, a reset, DNS. */
  status: number | null;
  ms: number;
  /** Null for a 304, or for a body deliberately never read. */
  bytes: number | null;
  /** 1 unless the transport retried. Both HTTP clients retry silently. */
  attempts: number;
  /** The failure body or message, truncated. Null on success. */
  error: string | null;
}

const records: RequestRecord[] = [];

/**
 * The parameters worth reading, which is not all of them.
 *
 * Every SIMKL URL carries `client_id`, `app-name` and `app-version` — eighty
 * characters of boilerplate that would be identical on every row and push the
 * part that differs off the end. Dropping them is a legibility decision, not a
 * secrecy one: the status page is a trusted surface and the feed token is
 * already in its own URL.
 */
const BORING_PARAMS = new Set(['client_id', 'app-name', 'app-version', 'fields']);

export const describeUrl = (url: string | URL): string => {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return String(url);
  }
  const kept = [...parsed.searchParams.entries()].filter(([key]) => !BORING_PARAMS.has(key));
  const query = kept.map(([key, value]) => `${key}=${value}`).join('&');
  return query ? `${parsed.pathname}?${query}` : parsed.pathname;
};

/**
 * Start timing a call, and get back the one function that records it.
 *
 * Shared because all three transports were assembling the same ten-field record
 * from the same four constants — so a new field, or a different notion of when
 * `at` is stamped, had to be made in three places and would drift in silence.
 * What genuinely differs between them is the attempt bookkeeping, which stays
 * with each.
 */
export const beginRequest = (
  init: { service: RequestService; component: RequestComponent; method: string; url: string | URL },
): ((outcome: { status: number | null; bytes: number | null; error: string | null; attempts?: number }) => void) => {
  // Monotonic, because this is a span rather than a moment. `Date.now()` is wall
  // time, so an NTP correction or a VM resume between the two readings renders a
  // negative latency on the status page. `at` below is a moment and stays on the
  // wall clock — it is what a reader matches against a log line.
  const started = performance.now();
  const path = describeUrl(init.url);
  return ({ status, bytes, error, attempts = 1 }) =>
    recordRequest({
      at: new Date().toISOString(),
      service: init.service,
      component: init.component,
      method: init.method,
      path,
      status,
      ms: Math.round(performance.now() - started),
      bytes,
      attempts,
      error,
    });
};

/**
 * Read a response body once, for its content *and* its size.
 *
 * `res.json()` is `text()` plus `JSON.parse` internally, so reading text first
 * costs nothing and is the only way to know how big the answer was.
 *
 * `failure` is the part worth having. A connection dying partway through a
 * multi-megabyte download rejects here, and swallowed to `''` it reaches the
 * parser instead and surfaces as `Unexpected end of JSON input` against a
 * `status: 200` — a row saying the server answered fine with a body nobody
 * could read, when what happened is that the download never finished.
 *
 * `bytes` counts bytes rather than `text.length`, which is UTF-16 code units.
 * SIMKL titles carry non-ASCII throughout, so the two disagree on every real
 * payload, and the page renders this field as a transfer size.
 */
export const readBody = async (res: Response): Promise<{ text: string; bytes: number; failure: string | null }> => {
  try {
    const text = await res.text();
    return { text, bytes: Buffer.byteLength(text), failure: null };
  } catch (err) {
    return { text: '', bytes: 0, failure: `the response body could not be read: ${errorMessage(err)}` };
  }
};

/**
 * Newest first, because that is the order it is read in. One array rather than
 * a map of six, so the page gets the interleaving for free — which is the whole
 * point, since a delta landing *between* two film lookups is what says the poll
 * did more than one thing.
 */
export const recordRequest = (record: RequestRecord): void => {
  records.unshift({ ...record, error: record.error === null ? null : truncate(record.error) });

  let seen = 0;
  for (let i = 0; i < records.length; i += 1) {
    if (records[i]?.component !== record.component) continue;
    seen += 1;
    if (seen > MAX_PER_COMPONENT) {
      records.splice(i, 1);
      break;
    }
  }
};

const truncate = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_ERROR_CHARS ? `${flat.slice(0, MAX_ERROR_CHARS)}…` : flat;
};

/** A copy, so a caller iterating cannot be surprised by a poll landing mid-render. */
export const recentRequests = (): RequestRecord[] => [...records];

/**
 * Process-global, like the CDN's cache — so a test asserting on the log has to
 * clear it first, the same way `clearCache()` exists for the same reason.
 */
export const clearRequests = (): void => {
  records.length = 0;
};
