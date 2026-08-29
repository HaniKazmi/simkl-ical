/**
 * What every long-running part of the service logs through.
 *
 * In `shared/` because the orchestrator, the feed and the sheet sync all take
 * one, and declaring it beside any one of them makes the other two import
 * *upward* to reach it. `console` satisfies it, so the default costs nothing.
 */
export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}
