/**
 * `catch (err)` binds `unknown` under strict mode, and every catch site here
 * only ever wants the message. One helper beats a dozen instanceof checks.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function errorStack(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
