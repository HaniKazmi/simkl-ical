/**
 * What every long-running part of the service logs through.
 *
 * Here rather than beside any one consumer: the orchestrator, the feed and the
 * sheet sync all take one, and hanging the interface off whichever of them
 * happened to declare it first makes the other two import *upward* to reach it.
 * `console` satisfies it, which is why the default costs nothing.
 */
export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}
