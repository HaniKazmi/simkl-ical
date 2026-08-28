/**
 * Transport for the Sheets API, with one deliberate difference from the other
 * clients: **retry is opt-in per call**.
 *
 * A retried write is not a retried read. `batchUpdate` is atomic but not
 * idempotent — a retried `insertDimension` inserts two rows, and a timeout can
 * fire on a request the server already applied. So reads pass `retry: true` and
 * writes never do.
 */

import { HttpError, requestJson, type HttpSpec } from '../http.ts';
import { config } from '../../shared/config.ts';
import type { RequestComponent } from '../requests.ts';
import { clearTokenCache, getAccessToken } from './auth.ts';

const API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const MAX_ATTEMPTS = 4;

export class SheetsError extends HttpError {
  constructor(message: string, status?: number, body?: string) {
    super(message, status, body);
    this.name = 'SheetsError';
  }
}

/**
 * Google reports both "the service account is not on this sheet" and "the sheet
 * does not exist" as 403/404, and both need a human. Separated so the sync can
 * say so once rather than retry an access problem for a week.
 */
export class SheetsAccessError extends SheetsError {
  constructor(message: string, status?: number, body?: string) {
    super(message, status, body);
    this.name = 'SheetsAccessError';
  }
}

/** Google's error envelope, which is more useful than the status alone. */
const describe = (status: number, body: string): string => {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } };
    if (parsed.error?.message) return `${status} ${parsed.error.status ?? ''} ${parsed.error.message}`.trim();
  } catch {
    // Not JSON — an HTML error page from a proxy. The status is all there is.
  }
  return `${status}`;
};

// The grid read is a megabyte or so; the timeout is generous but bounded, so a
// hung connection cannot stall a poll until undici's 300s default.
const SPEC: HttpSpec = {
  service: 'sheets',
  label: 'Sheets',
  maxAttempts: MAX_ATTEMPTS,
  timeoutMs: 60_000,
  errorFor: (message, status, body) => new SheetsError(message, status, body),
  onStatus: (status, body, path) => {
    if (status === 401) {
      // Almost always an expired assertion rather than a revoked key. Dropping
      // the cache means the next poll signs a fresh one and recovers by itself.
      clearTokenCache();
      return new SheetsAccessError(`Google rejected the credential (${describe(status, body)})`, status, body);
    }
    if (status === 403 || status === 404) {
      return new SheetsAccessError(
        `${describe(status, body)} — share the spreadsheet with the service account as Editor, and check SHEET_ID.`,
        status,
        body,
      );
    }
    if (RETRYABLE.has(status)) return 'retry';
    return new SheetsError(`Sheets ${describe(status, body)} for ${path}`, status, body);
  },
};

export interface SheetsRequestOptions {
  /** Which part of the service is asking — see `RequestComponent`. */
  component: RequestComponent;
  method?: 'GET' | 'POST';
  params?: Record<string, string | undefined>;
  body?: unknown;
  /**
   * Off by default, and never set for a write. See the header comment: this is
   * the single most consequential option in the file.
   */
  retry?: boolean;
  signal?: AbortSignal;
}

/**
 * One Sheets call. `path` is relative to the spreadsheets collection, e.g.
 * `${id}` or `${id}:batchUpdate`.
 */
export const sheetsRequest = async <T>(
  path: string,
  { component, method = 'GET', params = {}, body, retry = false, signal }: SheetsRequestOptions,
): Promise<T> => {
  // Concatenated, not `new URL(path, API_BASE)`: the batchUpdate path is
  // `${id}:batchUpdate`, and the URL parser reads that leading `id:` as a
  // scheme and discards the base entirely.
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }

  return requestJson<T>(SPEC, url, {
    component,
    method,
    body,
    maxAttempts: retry ? MAX_ATTEMPTS : 1,
    path,
    signal,
    // Re-signed per attempt, inside the engine's retry: a transient failure
    // obtaining the token is exactly as retryable as one using it.
    headers: async (attemptSignal) => ({
      Authorization: `Bearer ${await getAccessToken({ signal: attemptSignal })}`,
      Accept: 'application/json',
      'User-Agent': `${config.appName}/${config.appVersion}`,
    }),
  });
};
