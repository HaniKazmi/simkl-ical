import { HttpError, requestJson, type HttpSpec } from '../http.ts';
import type { RequestComponent } from '../requests.ts';
import { config, requireClientId } from '../../shared/config.ts';
import type { FailureKind } from '../pool.ts';

const API_BASE = 'https://api.simkl.com';

// 408 is a server-side read timeout, and 520-524 are Cloudflare's own origin
// failures — SIMKL sits behind it, and all of them are transient by definition.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

/**
 * Statuses meaning the resource will never resolve, however often we ask —
 * typically merged into another id or deleted upstream.
 *
 * Deliberately narrow, and kept beside RETRYABLE: the two answer different
 * questions ("will this ever succeed?" against "retry within this call?") but
 * must stay disjoint, which is only visible with both in one file.
 */
const GONE = new Set([404, 410]);

export class SimklError extends HttpError {
  constructor(message: string, status?: number, body?: string) {
    super(message, status, body);
    this.name = 'SimklError';
  }
}

/**
 * A revoked or invalid token, so callers can tell "log in again" from "SIMKL is
 * having a bad day" and keep serving the last good snapshot.
 */
export class SimklAuthError extends SimklError {
  constructor(message: string, status?: number, body?: string) {
    super(message, status, body);
    this.name = 'SimklAuthError';
  }
}

/** SIMKL's status mapping onto the shared three-way split. */
export const classify = (err: unknown): FailureKind => {
  if (err instanceof SimklAuthError) return 'account';
  if (!(err instanceof SimklError) || err.status === undefined) return 'transient';
  if (err.status === 412) return 'account';
  return GONE.has(err.status) ? 'gone' : 'transient';
};

// Sync responses are small; without the timeout a hung connection stalls a
// refresh cycle until undici's 300s default.
const SPEC: HttpSpec = {
  service: 'simkl',
  label: 'SIMKL',
  maxAttempts: 5,
  timeoutMs: 30_000,
  errorFor: (message, status, body) => new SimklError(message, status, body),
  onStatus: (status, body, path) => {
    if (status === 401 || status === 403) return new SimklAuthError(`SIMKL rejected the token (${status})`, status, body);
    if (status === 412) return new SimklError('client_id rejected or throttled (412)', status, body);
    if (RETRYABLE.has(status)) return 'retry';
    return new SimklError(`SIMKL ${status} for ${path}`, status, body);
  },
};

/** Params every request carries, per the SIMKL docs. */
const baseParams = (): Record<string, string> => ({
  client_id: requireClientId(),
  'app-name': config.appName,
  'app-version': config.appVersion,
});

export interface ApiGetOptions {
  /** Which part of the service is asking — see `RequestComponent`. */
  component: RequestComponent;
  token?: string | null;
  params?: Record<string, string | number | undefined | null>;
  signal?: AbortSignal;
}

/**
 * GET a SIMKL API path with backoff. `token` makes it an authenticated call.
 * Verified against the live API: omitting client_id entirely returns 412,
 * a valid client_id without a token returns 401.
 */
export const apiGet = async <T>(path: string, { component, token, params = {}, signal }: ApiGetOptions): Promise<T> => {
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries({ ...baseParams(), ...params })) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = {
    'User-Agent': `${config.appName}/${config.appVersion}`,
    'simkl-api-key': requireClientId(),
    Accept: 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  return requestJson<T>(SPEC, url, { component, headers: () => headers, path, signal });
};
