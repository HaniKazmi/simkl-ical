/**
 * Combine a caller's cancellation with a request timeout.
 *
 * Both call sites used to write `signal ?? AbortSignal.timeout(ms)`, which
 * reads as a default but is really an override: any caller passing a signal
 * silently gave up the timeout and inherited undici's 300s default, so a hung
 * connection would block a refresh cycle for five minutes.
 */
export const withTimeout = (signal: AbortSignal | undefined, ms: number): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
