/**
 * The service's state, projected once for two readers.
 *
 * A pure function of flat state, exactly like `status/1-model.ts` — and here
 * rather than on `Orchestrator` for the same reason `library.ts` is: the
 * orchestrator owns the state and drives the halves, and neither job is served
 * by also holding 45 lines of staleness policy and DTO assembly.
 *
 * Two readers, deliberately different slices of one projection:
 *
 * - `/healthz` gets `healthResponse` — state and shape, nothing else. It is a
 *   container healthcheck and a CI assertion, which makes its key set a
 *   contract; free-text that changes wording is a diff in something a machine
 *   parses, for a reader that is not there.
 * - the status page gets the whole `Health`, including `problems`, because it
 *   is the surface a person reads and the place the detail already renders.
 */

import { config } from './shared/config.ts';
import { ageOf } from './shared/dates.ts';
import type { SheetSyncStatus } from './sheet/sync.ts';

/**
 * Everything either reader can ask for. `problems` and the per-subsystem
 * `error` strings are the diagnostic half; the rest is state.
 */
export interface Health {
  /**
   * Whether restarting this container would help — not whether anything is
   * wrong. Deliberately narrower than `problems`: a revoked token is usually a
   * self-clearing rate limit, and a restart cold-starts into the full pull that
   * provokes it. The status page reports the wider question.
   */
  ok: boolean;
  timezone: string;
  /**
   * Everything wrong right now, worst first — library, then calendars, then
   * rendering. Empty when there is nothing to say.
   *
   * `sheet` is deliberately absent: a sheet failure never makes `ok` false, so
   * listing it here would put an entry in front of an operator that the status
   * code disagrees with. It is reported in `sheet.error` instead.
   */
  problems: string[];
  library: LibraryHealth;
  feed: FeedHealth;
  sheet: SheetHealth;
}

export interface LibraryHealth {
  /** The last `/sync/activities` call — what stops when a token is revoked. */
  polledAt: string | null;
  /** The last time the library actually moved. Days old on a correct, quiet system. */
  syncedAt: string | null;
  error: string | null;
}

export interface CalendarHealth {
  /** Every refresh, including ones served from cache after a failure. */
  attemptedAt: string | null;
  /** Only when the CDN actually answered. The two diverge while serving cache. */
  freshAt: string | null;
  error: string | null;
}

export interface FeedHealth {
  events: number;
  renderedAt: string | null;
  /** True while the feed came off disk and no fresh render has replaced it. */
  servingCached: boolean;
  /** A render failure. Not the calendars' — that is one level down. */
  error: string | null;
  calendars: CalendarHealth;
}

export interface SheetHealth {
  configured: boolean;
  mode: string;
  status: SheetSyncStatus;
  lastRunAt: string | null;
  frozen: boolean;
  error: string | null;
}

/**
 * The flat state the projection reads. Named fields rather than an
 * `Orchestrator`, which is what keeps this module from importing upward and
 * lets a test build one as a literal instead of assembling a live service.
 */
export interface HealthInput {
  polledAt: string | null;
  libraryAt: string | null;
  libraryError: string | null;

  events: number;
  renderedAt: string | null;
  servingCached: boolean;
  renderError: string | null;
  calendarsAt: string | null;
  calendarsFreshAt: string | null;
  calendarError: string | null;

  sheetConfigured: boolean;
  sheetStatus: SheetSyncStatus;
  sheetLastRunAt: string | null;
  sheetFrozen: boolean;
  sheetError: string | null;
}

export const buildHealth = (input: HealthInput): Health => {
  const stalePoll = ageOf(input.polledAt) > config.activitiesPollMs * 3;
  const staleCalendars = ageOf(input.calendarsFreshAt) > config.calendarRefreshMs * 3;
  // A render happens on every calendar refresh, so an old renderedAt means
  // rendering has stopped even when nothing reported an error.
  const staleRender = ageOf(input.renderedAt) > config.calendarRefreshMs * 3;

  // Worst first. Each subsystem contributes at most one line: its own error
  // if it has one, otherwise its staleness — an error like "serving cached
  // calendars since X" already says the CDN is quiet, so emitting both would
  // just say it twice. Library outranks calendars because a stale calendar
  // still renders and a revoked token eventually will not.
  const problems = [
    input.libraryError ?? (stalePoll ? `SIMKL has not been polled since ${input.polledAt ?? 'startup'}` : null),
    input.calendarError ?? (staleCalendars ? `the CDN has not answered since ${input.calendarsFreshAt ?? 'startup'}` : null),
    input.renderError ??
      (input.renderedAt === null ? 'nothing has been rendered yet' : staleRender ? `nothing has rendered since ${input.renderedAt}` : null),
  ].filter((p) => p !== null);

  return {
    ok: input.renderedAt !== null && !stalePoll && !staleCalendars && !staleRender && !input.renderError,
    timezone: config.timezone,
    problems,
    library: { polledAt: input.polledAt, syncedAt: input.libraryAt, error: input.libraryError },
    feed: {
      events: input.events,
      renderedAt: input.renderedAt,
      servingCached: input.servingCached,
      error: input.renderError,
      calendars: { attemptedAt: input.calendarsAt, freshAt: input.calendarsFreshAt, error: input.calendarError },
    },
    // Reported but deliberately excluded from `ok` and from `problems`:
    // /healthz is the container healthcheck and the CI smoke test, and a
    // frozen sheet sync must not restart the container or fail a deploy.
    sheet: {
      configured: input.sheetConfigured,
      mode: config.sheetSyncMode,
      status: input.sheetStatus,
      lastRunAt: input.sheetLastRunAt,
      frozen: input.sheetFrozen,
      error: input.sheetError,
    },
  };
};

/** What `/healthz` serialises: the same state, with the prose left out. */
export interface HealthResponse {
  ok: boolean;
  timezone: string;
  library: Omit<LibraryHealth, 'error'>;
  feed: Omit<FeedHealth, 'error' | 'calendars'> & { calendars: Omit<CalendarHealth, 'error'> };
  sheet: Omit<SheetHealth, 'error'>;
}

/**
 * The endpoint's body: state and shape, no free text.
 *
 * A healthcheck is a contract, and a stable key set is the contract. Every
 * field here answers a question a machine can act on — is it up, when did each
 * subsystem last succeed, how many events are being served. The wording of a
 * failure is a question for a person, and the status page renders the whole
 * `Health` including `problems` for exactly that.
 *
 * `ok` still decides the status code, so a probe that reads nothing but the
 * code is unaffected.
 */
export const healthResponse = (health: Health): HealthResponse => ({
  ok: health.ok,
  timezone: health.timezone,
  library: { polledAt: health.library.polledAt, syncedAt: health.library.syncedAt },
  feed: {
    events: health.feed.events,
    renderedAt: health.feed.renderedAt,
    servingCached: health.feed.servingCached,
    calendars: { attemptedAt: health.feed.calendars.attemptedAt, freshAt: health.feed.calendars.freshAt },
  },
  sheet: {
    configured: health.sheet.configured,
    mode: health.sheet.mode,
    status: health.sheet.status,
    lastRunAt: health.sheet.lastRunAt,
    frozen: health.sheet.frozen,
  },
});
