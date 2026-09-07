/**
 * The Hardcover transport. One endpoint is used — the GraphQL one — for the
 * covers the artwork page offers on a book row.
 *
 * There is no `classify` here, and the absence is deliberate: that function
 * exists to sort failures for `lookupPool`, whose three callers are all in the
 * feed and the sheet sync. The artwork page does not pool — it asks for one
 * title's candidates when a reader opens a row, and `artwork.ts` catches
 * whatever throws. A `classify` would be an export with no caller.
 *
 * The credential is a file rather than an environment variable because that is
 * how the token is issued and stored; it goes in a header for the reason
 * `tmdb/client.ts` gives, that `describeUrl` renders request paths onto the
 * status page.
 *
 * One blind spot worth knowing: a query rejected with a 200 (see `graphql`) is
 * recorded in the request log as a success, because the transport finishes its
 * record before this module inspects the envelope. The row's status, bytes and
 * timing are all true; the reason it failed is on the page, not in the log.
 */

import { readFileSync } from 'node:fs';

import { config } from '../../shared/config.ts';
import { errorMessage } from '../../shared/errors.ts';
import { HttpError, requestJson, type HttpSpec } from '../http.ts';
import type { RequestComponent } from '../requests.ts';
import type { GraphqlBody } from './types.ts';

/**
 * One endpoint, so a constant rather than a base to resolve paths against.
 * Everything a query says travels in the POST body, which is why `graphql`
 * takes a `path` label: without one the request log is an unbroken column of
 * `/v1/graphql`.
 */
const API_URL = 'https://api.hardcover.app/v1/graphql';

// 503 is included on Hardcover's own documented word that it is safe to retry.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class HardcoverError extends HttpError {
  constructor(message: string, status?: number, body?: string) {
    super(message, status, body);
    this.name = 'HardcoverError';
  }
}

let cached: string | null = null;

/** Exported for tests, the way `tvdb/auth.ts` exports its cache clear. */
export const clearHardcoverToken = (): void => {
  cached = null;
};

/**
 * The token, read from disk on first use and held for the process. There is no
 * expiry to track — a personal access token is valid until it is revoked or
 * its stated lifetime runs out, and either way a 401 is the only signal, which
 * `SPEC` turns into a re-read.
 */
const readToken = (): string => {
  if (cached) return cached;
  const path = config.hardcoverTokenPath;
  // Thrown before any fetch, so an unconfigured install cannot reach Hardcover
  // even if a caller forgets to gate on `booksArtworkConfigured`.
  if (!path) throw new HardcoverError('HARDCOVER_TOKEN_PATH is not set, so no cover lookup can be made.');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new HardcoverError(`No Hardcover token at ${path}: ${errorMessage(err)}`);
  }
  // A trailing newline is the normal case for a file written by hand. An empty
  // one is a half-finished setup, and sending `Bearer ` earns a 401 that reads
  // as a revoked token rather than as a missing one.
  const token = raw.trim();
  if (!token) throw new HardcoverError(`The Hardcover token at ${path} is empty.`);
  cached = token;
  return token;
};

/**
 * Two attempts and ten seconds. Ten rather than the thirty Hardcover's own
 * timeout allows: this sits inside a request a reader is watching a spinner
 * for, and a query returning eighty editions answers well inside a second —
 * the thirty is their processing ceiling, not a budget for one row. Two
 * attempts rather than three because the limits here are *daily* as well as
 * per-minute, and spending a third request on a row nobody may pick from is
 * the wrong way to run out.
 */
const SPEC: HttpSpec = {
  service: 'hardcover',
  label: 'Hardcover',
  maxAttempts: 2,
  timeoutMs: 10_000,
  errorFor: (message, status, body) => new HardcoverError(message, status, body),
  onStatus: (status, body, path) => {
    if (status === 401) {
      // Retried, and for a different reason than TVDB's: there is no exchange
      // to redo, but the credential is a file, and an operator who has just
      // rotated it wants the second attempt to read the new one rather than
      // re-send the cached old one. A token that really is revoked still fails
      // closed, on that second attempt.
      clearHardcoverToken();
      return 'retry';
    }
    if (RETRYABLE.has(status)) return 'retry';
    // 403 is a missing scope or a query over the five-top-level-field cap.
    // Asking again fixes neither.
    return new HardcoverError(`Hardcover ${status} for ${path}`, status, body);
  },
};

export interface HardcoverQuery {
  /** Names the call in the request log and in failure messages. */
  path: string;
  query: string;
  variables?: Record<string, unknown>;
  component: RequestComponent;
  signal?: AbortSignal;
}

export const graphql = async <T>({ path, query, variables, component, signal }: HardcoverQuery): Promise<T> => {
  // Read here so an unconfigured install throws before any request — a throw
  // from inside `headers` below is caught by the transport and retried, which
  // would turn a missing file into two attempts and a logged row. Read *again*
  // per attempt, because that is the only way the 401 arm below can work: the
  // closure runs once per try, and a token captured here would be re-sent
  // verbatim after the cache was cleared.
  readToken();
  const body = await requestJson<GraphqlBody<T>>(SPEC, new URL(API_URL), {
    component,
    logPath: path,
    path,
    method: 'POST',
    signal,
    body: { query, ...(variables ? { variables } : {}) },
    headers: () => ({
      Authorization: `Bearer ${readToken()}`,
      'User-Agent': `${config.appName}/${config.appVersion}`,
    }),
  });

  // A rejected or malformed query comes back **200** carrying `errors`, and
  // some failures as a top-level `error` string instead. Read as the success
  // its status claims, either one leaves `data` undefined and reaches the page
  // as "this book has no covers", with nothing anywhere saying otherwise.
  if (typeof body.error === 'string') throw new HardcoverError(`Hardcover ${path}: ${body.error}`, 200);
  const failed = (body.errors ?? []).map((e) => e?.message).filter(Boolean).join('; ');
  if (failed) throw new HardcoverError(`Hardcover ${path}: ${failed}`, 200);
  if (!body.data) throw new HardcoverError(`Hardcover ${path}: the response carried no data`, 200);
  return body.data;
};
