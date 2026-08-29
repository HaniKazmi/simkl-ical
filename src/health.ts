/**
 * What the service's state *means*: both notions of "healthy", defined once.
 *
 * - `/healthz` asks **would restarting this container help** — `assess().ok`,
 *   which drives the status code. Narrower than "is anything wrong": a
 *   revoked token is usually a self-clearing rate limit, and a restart
 *   cold-starts into the full pull that provokes it.
 * - the status page asks **is everything fine** — `pageHealthy`, false
 *   whenever `problems` has anything to say.
 *
 * The sheet is in neither: `/healthz` is the container healthcheck and the CI
 * smoke test, and a frozen sheet sync must not restart the container or fail
 * a deploy. It is reported in `sheet.error` instead.
 */

import { config } from './shared/config.ts';
import { ageOf } from './shared/dates.ts';
import type { Snapshot } from './orchestrator.ts';
import type { SheetSyncStatus } from './sheet/sync.ts';

/** Which half of the service a problem belongs to. */
export type ProblemArea = 'library' | 'calendars' | 'feed';

/**
 * One thing wrong, and who owns it. The area is what lets the status page
 * colour the subsystem at fault rather than say only that something is.
 */
export interface Problem {
  area: ProblemArea;
  message: string;
}

export interface Assessment {
  /** Whether restarting this container would help — not whether anything is wrong. */
  ok: boolean;
  /**
   * Everything wrong right now, worst first: library, calendars, rendering.
   * Library outranks calendars because a stale calendar still renders and a
   * revoked token eventually will not. At most one entry per area.
   */
  problems: Problem[];
}

const problem = (area: ProblemArea, message: string | null): Problem | null =>
  message === null ? null : { area, message };

export const assess = (snapshot: Snapshot): Assessment => {
  // Three intervals: one missed tick is a retry, three is a stall. `Duration`
  // has no scalar multiply, so the factor applies to milliseconds.
  const stale = (at: string | null, every: Temporal.Duration): boolean => ageOf(at) > every.total('milliseconds') * 3;

  const { library, feed } = snapshot;
  const stalePoll = stale(library.polledAt, config.activitiesPoll);
  const staleCalendars = stale(feed.calendars.freshAt, config.calendarRefresh);
  // A render happens on every calendar refresh, so an old renderedAt means
  // rendering has stopped even with no reported error.
  const staleRender = stale(feed.renderedAt, config.calendarRefresh);

  // At most one line per subsystem: its error, else its staleness — an error
  // like "serving cached calendars since X" already says the CDN is quiet.
  const problems = [
    problem('library', library.error ?? (stalePoll ? `SIMKL has not been polled since ${library.polledAt ?? 'startup'}` : null)),
    problem('calendars', feed.calendars.error ?? (staleCalendars ? `the CDN has not answered since ${feed.calendars.freshAt ?? 'startup'}` : null)),
    problem('feed', feed.error ?? (feed.renderedAt === null ? 'nothing has been rendered yet' : staleRender ? `nothing has rendered since ${feed.renderedAt}` : null)),
  ].filter((p) => p !== null);

  return {
    ok: feed.renderedAt !== null && !stalePoll && !staleCalendars && !staleRender && !feed.error,
    problems,
  };
};

/**
 * The status page's stricter question. Keyed on `problems` alone — every
 * conjunct of `ok` implies a problem line when false — so the page can never
 * claim unhealthy without a line saying why.
 */
export const pageHealthy = ({ problems }: Assessment): boolean => problems.length === 0;

/**
 * What `/healthz` serialises: state and shape, no free text.
 *
 * A stable key set is the contract. Every field answers a question a machine
 * can act on; the wording of a failure is for a person, and the status page
 * renders `problems` for that. `ok` still decides the status code.
 */
export interface HealthResponse {
  ok: boolean;
  timezone: string;
  library: { polledAt: string | null; syncedAt: string | null };
  feed: {
    events: number;
    renderedAt: string | null;
    /** True while the feed came off disk and no fresh render has replaced it. */
    servingCached: boolean;
    calendars: { attemptedAt: string | null; freshAt: string | null };
  };
  sheet: {
    configured: boolean;
    mode: string;
    status: SheetSyncStatus;
    lastRunAt: string | null;
    frozen: boolean;
  };
}

export const healthResponse = (snapshot: Snapshot, { ok }: Assessment): HealthResponse => ({
  ok,
  timezone: config.timezone,
  library: { polledAt: snapshot.library.polledAt, syncedAt: snapshot.library.syncedAt },
  feed: {
    events: snapshot.feed.events,
    renderedAt: snapshot.feed.renderedAt,
    servingCached: snapshot.feed.servingCached,
    calendars: { attemptedAt: snapshot.feed.calendars.attemptedAt, freshAt: snapshot.feed.calendars.freshAt },
  },
  sheet: {
    configured: snapshot.sheet.configured,
    mode: config.sheetSyncMode,
    status: snapshot.sheet.status,
    lastRunAt: snapshot.sheet.lastRunAt,
    // The whole repair message is the page's business; a machine gets the fact.
    frozen: snapshot.sheet.frozen !== null,
  },
});
