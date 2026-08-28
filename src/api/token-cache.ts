/**
 * A cached bearer token around an exchange function.
 *
 * Epoch milliseconds on purpose: a token lifetime is a countdown with both
 * endpoints inside this process — no zone and no calendar in it — which is the
 * documented `Date` exception.
 *
 * The in-flight exchange is held as well as the token, because callers can
 * arrive in parallel: `lookupPool` starts four workers at once, and on a cold
 * cache each would otherwise miss and log in separately.
 */

export interface TokenCache {
  get(opts?: { signal?: AbortSignal }): Promise<string>;
  /** Drops both the token and any in-flight exchange — a failed one must not be handed to the next caller. */
  clear(): void;
}

export const tokenCache = (
  exchange: (opts: { signal?: AbortSignal }) => Promise<{ token: string; expiresAtMs: number }>,
): TokenCache => {
  let cached: { token: string; expiresAtMs: number } | null = null;
  let pending: Promise<string> | null = null;

  return {
    get({ signal }: { signal?: AbortSignal } = {}): Promise<string> {
      if (cached && cached.expiresAtMs > Date.now()) return Promise.resolve(cached.token);
      pending ??= exchange({ signal })
        .then((result) => {
          cached = result;
          return result.token;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    clear(): void {
      cached = null;
      pending = null;
    },
  };
};
