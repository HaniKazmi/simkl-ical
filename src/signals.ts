/**
 * Combine a caller's cancellation with a request timeout.
 *
 * Both apply. `signal ?? AbortSignal.timeout(ms)` reads as a default but is an
 * override — it drops the timeout entirely whenever a caller passes a signal.
 */
export const withTimeout = (signal: AbortSignal | undefined, ms: number): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
