/**
 * `catch (err)` binds `unknown` under strict mode, and every catch site here
 * only ever wants the message. One helper beats a dozen instanceof checks.
 */
export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export const errorStack = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);
