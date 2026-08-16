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

/** Enough to see the pattern across several polls without holding a session. */
const MAX_RECORDS = 30;

/** A failure body is upstream text of unknown length; the page needs a line, not a page. */
const MAX_ERROR_CHARS = 300;

export type RequestService = 'simkl' | 'cdn' | 'sheets';

/**
 * Which part of the service asked, which is not the same question as which
 * upstream answered. SIMKL serves three of these — the poll, the feed's film
 * dates and the sheet's per-title reads — so `simkl /tv/1649662` says nothing
 * about *why* without this.
 *
 * A property of the calling module rather than of the request, so every `io/`
 * module names itself once. Required rather than defaulted: a new call site
 * should have to decide, and `tsc` asking is the difference between a label
 * that stays true and one that quietly rots.
 */
export type RequestComponent = 'poll' | 'calendars' | 'films' | 'catalogue' | 'spreadsheet' | 'login';

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

/** Newest first, because that is the order it is read in. */
export const recordRequest = (record: RequestRecord): void => {
  records.unshift({ ...record, error: record.error === null ? null : truncate(record.error) });
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
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
