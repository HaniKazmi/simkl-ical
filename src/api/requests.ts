/**
 * What this process asked the internet for, and what came back.
 *
 * Every outbound call lands here — SIMKL, the airdate CDN, Google Sheets — so
 * the status page can show the poll's own conversation, not just its
 * conclusions. Nothing else shows whether the gate works: a column of lone
 * `/sync/activities` calls with the occasional delta beside it is that
 * evidence.
 *
 * It also separates the one failure mode that lies. A burst of uncached sync
 * calls comes back `401 user_token_failed`, which reads as a dead token; the
 * status, retry count and response body tell that from a token actually
 * revoked — the difference between waiting and re-authorising.
 *
 * In memory, and capped: diagnostic state about this process, like the CDN's
 * response cache. Persisting it would mean a fourth file plus schema
 * validation, for data whose value is "what is happening right now".
 */

import { errorMessage } from '../shared/errors.ts';
import { nowIso } from '../shared/dates.ts';

/**
 * Capped per component, not overall: components fire at wildly different rates
 * and a single ring is won by the noisiest one. A cold start on a 337-film
 * library makes hundreds of `films` calls in seconds; under one shared cap the
 * `/sync/activities` and delta rows — the only place the gate is observable —
 * are gone before the first page load. Segmented, no component can evict
 * another, and the page stays bounded at six times this.
 */
const MAX_PER_COMPONENT = 8;

/** A failure body is upstream text of unknown length; the page needs a line, not a page. */
const MAX_ERROR_CHARS = 300;

export type RequestService = 'simkl' | 'cdn' | 'sheets' | 'tvdb';

/**
 * Which part of the service asked — not the same question as which upstream
 * answered. SIMKL serves three of these (the poll, the feed's film dates, the
 * sheet's per-title reads), so `simkl /tv/1649662` says nothing about why
 * without this.
 *
 * `auth` has its own name because a failing token exchange and a rejected
 * spreadsheet read are the same `sheets` service and want opposite fixes.
 * `runtimes` is separate from `catalogue` because one asks SIMKL for an
 * episode list and the other asks TVDB for a season's lengths, and a reader
 * chasing a failure needs to know which upstream to look at.
 *
 * A property of the calling module, so every `io/` module names itself once.
 * Required rather than defaulted: a new call site has to decide, and `tsc`
 * asking is what keeps the label true.
 */
export type RequestComponent = 'poll' | 'calendars' | 'films' | 'catalogue' | 'spreadsheet' | 'runtimes' | 'auth' | 'login';

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
 * Every SIMKL URL carries `client_id`, `app-name` and `app-version` — eighty
 * characters identical on every row that push the part that differs off the
 * end. Dropping them is legibility, not secrecy: the status page is a trusted
 * surface and the feed token is already in its own URL.
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
 * Shared because all three transports assemble the same ten-field record; a
 * copy each would let a new field or the stamping of `at` drift in silence.
 * The attempt bookkeeping genuinely differs, so it stays with each transport.
 */
export const beginRequest = (
  init: { service: RequestService; component: RequestComponent; method: string; url: string | URL },
): ((outcome: { status: number | null; bytes: number | null; error: string | null; attempts?: number }) => void) => {
  // Monotonic: this is a span, not a moment. On wall time an NTP correction or
  // VM resume between the readings renders a negative latency. `at` below is a
  // moment and stays on the wall clock — it is matched against log lines.
  const started = performance.now();
  const path = describeUrl(init.url);
  return ({ status, bytes, error, attempts = 1 }) =>
    recordRequest({
      at: nowIso(),
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
 * Read a response body once, for its content and its size.
 *
 * `res.json()` is `text()` plus `JSON.parse` internally, so reading text first
 * costs nothing and is the only way to know how big the answer was.
 *
 * `failure`: a connection dying mid-download rejects here. Swallowed to `''`
 * it reaches the parser and surfaces as `Unexpected end of JSON input` against
 * a `status: 200`, when what happened is the download never finished.
 *
 * `bytes` counts bytes, not `text.length` (UTF-16 code units). SIMKL titles
 * carry non-ASCII throughout, so the two disagree on every real payload, and
 * the page renders this as a transfer size.
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
 * Newest first — the order it is read in. One array rather than a map of six,
 * so the page gets the interleaving for free: a delta landing between two film
 * lookups is what says the poll did more than one thing.
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
 * Process-global, like the CDN's cache — a test asserting on the log clears it
 * first, the same way `clearCache()` works.
 */
export const clearRequests = (): void => {
  records.length = 0;
};
