/**
 * Transport for the Sheets API. Modelled on `simkl/client.ts`, with one
 * deliberate difference: **retry is opt-in per call**.
 *
 * A retried write is not a retried read. `batchUpdate` is atomic but not
 * idempotent — a retried `insertDimension` inserts two rows, and a timeout can
 * fire on a request the server already applied. So reads pass `retry: true` and
 * writes never do.
 */

import { backoffMs, HttpError, retryDelayMs, sleep } from '../backoff.ts';
import { config } from '../../shared/config.ts';
import { errorMessage } from '../../shared/errors.ts';
import { withTimeout } from '../../shared/signals.ts';
import { clearTokenCache, getAccessToken } from './auth.ts';

const API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const MAX_ATTEMPTS = 4;

// The grid read is a megabyte or so; generous, but bounded, so a hung
// connection cannot stall a poll until undici's 300s default.
const TIMEOUT_MS = 60_000;

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

export interface SheetsRequestOptions {
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
  { method = 'GET', params = {}, body, retry = false, signal }: SheetsRequestOptions = {},
): Promise<T> => {
  // Concatenated, not `new URL(path, API_BASE)`: the batchUpdate path is
  // `${id}:batchUpdate`, and the URL parser reads that leading `id:` as a
  // scheme and discards the base entirely.
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }

  const attempts = retry ? MAX_ATTEMPTS : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const token = await getAccessToken({ signal });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': `${config.appName}/${config.appVersion}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: withTimeout(signal, TIMEOUT_MS),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      if (attempt < attempts) await sleep(backoffMs(attempt));
      continue;
    }

    if (res.ok) {
      try {
        return (await res.json()) as T;
      } catch (err) {
        lastError = new SheetsError(`Sheets returned unparseable JSON for ${path}: ${errorMessage(err)}`, res.status);
        if (attempt < attempts) await sleep(backoffMs(attempt));
        continue;
      }
    }

    const text = await res.text().catch(() => '');

    if (res.status === 401) {
      // Almost always an expired assertion rather than a revoked key. Dropping
      // the cache means the next poll signs a fresh one and recovers by itself.
      clearTokenCache();
      throw new SheetsAccessError(`Google rejected the credential (${describe(res.status, text)})`, res.status, text);
    }
    if (res.status === 403 || res.status === 404) {
      throw new SheetsAccessError(
        `${describe(res.status, text)} — share the spreadsheet with the service account as Editor, and check SHEET_ID.`,
        res.status,
        text,
      );
    }
    if (!RETRYABLE.has(res.status)) {
      throw new SheetsError(`Sheets ${describe(res.status, text)} for ${path}`, res.status, text);
    }

    lastError = new SheetsError(`Sheets ${describe(res.status, text)} for ${path}`, res.status, text);
    if (attempt < attempts) await sleep(retryDelayMs(res, attempt));
  }

  throw lastError;
};
