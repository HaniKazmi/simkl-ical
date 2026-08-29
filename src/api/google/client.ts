/**
 * Transport for the Sheets API. One difference from the other clients:
 * **retry is opt-in per call**.
 *
 * `batchUpdate` is atomic but not idempotent — a retried `insertDimension`
 * inserts two rows, and a timeout can fire on a request the server already
 * applied. So reads pass `retry: true` and writes never do.
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
 * Google reports "the service account is not on this sheet" and "the sheet
 * does not exist" both as 403/404, and both need a human. Separated so the
 * sync can say so once rather than retry an access problem for a week.
 */
export class SheetsAccessError extends SheetsError {
  /**
   * Whether retrying can never help. Decided beside the status mapping: a 401
   * is almost always an expired assertion the cleared token cache heals on the
   * next poll; a 403/404 stays wrong until a person re-shares the sheet or
   * fixes SHEET_ID.
   */
  readonly needsHuman: boolean;

  constructor(message: string, status?: number, body?: string, { needsHuman = true }: { needsHuman?: boolean } = {}) {
    super(message, status, body);
    this.name = 'SheetsAccessError';
    this.needsHuman = needsHuman;
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
      // Almost always an expired assertion, not a revoked key. Dropping the
      // cache lets the next poll sign a fresh one and recover by itself.
      clearTokenCache();
      return new SheetsAccessError(`Google rejected the credential (${describe(status, body)})`, status, body, { needsHuman: false });
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
   * Off by default, and never set for a write — see the header comment.
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
  // `${id}:batchUpdate`, and the parser reads the leading `id:` as a scheme
  // and discards the base.
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
    // Re-signed per attempt: a transient failure obtaining the token is as
    // retryable as one using it.
    headers: async () => ({
      Authorization: `Bearer ${await getAccessToken()}`,
      Accept: 'application/json',
      'User-Agent': `${config.appName}/${config.appVersion}`,
    }),
  });
};
