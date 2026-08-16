/**
 * MODEL — the running service, reduced to what a page shows. Pure: the clock
 * arrives as `now`, and nothing here reads `config` or touches io.
 *
 * `StatusInput` is plain data rather than an `Orchestrator`, which is what keeps
 * this module from importing upward into root. It restates field names the
 * shell already has; in exchange a test builds one as a literal instead of
 * assembling a live service.
 */

import type { SheetRunRecord } from '../sheet/io/journal.ts';

export interface StatusInput {
  now: number;
  appName: string;
  version: string;
  timezone: string;
  startedAt: string | null;
  ok: boolean;
  problems: string[];

  polledAt: string | null;
  librarySyncedAt: string | null;
  libraryError: string | null;
  /** Every list, including the empty ones — see `listCounts`. */
  counts: Record<string, number>;
  gate: { moved: string[]; refetched: string[] } | null;
  activitiesPollMs: number;

  events: number;
  renderedAt: string | null;
  servingCached: boolean;
  renderError: string | null;
  calendarsAt: string | null;
  calendarsFreshAt: string | null;
  calendarsChangedAt: string | null;
  calendarError: string | null;
  calendarRefreshMs: number;
  films: number;
  filmsResolvedAt: string | null;
  movieRefreshMs: number;

  sheetConfigured: boolean;
  sheetMode: string;
  sheetTab: string;
  sheetStatus: string;
  sheetLastRunAt: string | null;
  /** The whole repair message, which `/healthz` reduces to a boolean. */
  sheetFrozen: string | null;
  sheetError: string | null;
  runs: SheetRunRecord[];
}

/** A moment, with the relative wording a reader actually wants. */
export interface Stamp {
  iso: string | null;
  /** `14m ago`, or `never` when there is nothing to describe. */
  label: string;
}

/**
 * When something is next expected. `label` is deliberately "due in …" rather
 * than "fires at": `schedule()` runs on a fixed interval and skips a tick while
 * the previous one is still going, so this is an expectation, not a promise.
 */
export interface Due {
  label: string;
  overdue: boolean;
}

export interface ListRow {
  key: string;
  count: number;
  /** Share of the largest list, for a bar. 0 when everything is empty. */
  share: number;
  state: 'refetched' | 'unchanged' | 'unknown';
}

export interface Step {
  name: string;
  detail: string;
  at: Stamp;
  ok: boolean;
}

export interface RunView {
  at: Stamp;
  status: string;
  mode: string;
  edits: SheetRunRecord['edits'];
  inserts: SheetRunRecord['inserts'];
  error: string | null;
  repeats: number;
}

export interface StatusModel {
  appName: string;
  version: string;
  timezone: string;
  ok: boolean;
  problems: string[];
  uptime: string | null;
  library: {
    polled: Stamp;
    synced: Stamp;
    error: string | null;
    total: number;
    lists: ListRow[];
    moved: number;
    gated: boolean;
    due: Due;
  };
  feed: {
    events: number;
    rendered: Stamp;
    servingCached: boolean;
    error: string | null;
    steps: Step[];
    calendarsDue: Due;
    filmsDue: Due;
  };
  sheet: {
    configured: boolean;
    mode: string;
    tab: string;
    status: string;
    lastRun: Stamp;
    frozen: string | null;
    error: string | null;
    runs: RunView[];
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Coarse on purpose: two units is what a person reads at a glance, and a page
 * that says `4d 6h 12m 3s` is reporting precision the underlying timers do not
 * have.
 */
export const duration = (ms: number): string => {
  const abs = Math.max(0, Math.round(ms));
  if (abs < MINUTE) return `${Math.round(abs / 1000)}s`;
  if (abs < HOUR) return `${Math.floor(abs / MINUTE)}m`;
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    const m = Math.floor((abs % HOUR) / MINUTE);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
};

/**
 * Never `iso.slice(0, 10)`. The stored value is a UTC instant, and this is the
 * layer where slicing it silently shifts a fifth of them by a day.
 */
const stamp = (iso: string | null, now: number): Stamp => ({
  iso,
  label: iso === null ? 'never' : `${duration(now - Date.parse(iso))} ago`,
});

/**
 * Counted from the last run rather than from process start, so a skipped tick
 * shows as overdue instead of quietly reporting the next one.
 */
const due = (last: string | null, everyMs: number, now: number): Due => {
  if (last === null) return { label: 'due now', overdue: false };
  const remaining = Date.parse(last) + everyMs - now;
  return remaining <= 0 ? { label: `overdue by ${duration(-remaining)}`, overdue: true } : { label: `in ${duration(remaining)}`, overdue: false };
};

export const buildModel = (input: StatusInput): StatusModel => {
  const { now } = input;
  const counts = Object.entries(input.counts);
  const largest = Math.max(1, ...counts.map(([, n]) => n));
  const refetched = new Set(input.gate?.refetched ?? []);

  return {
    appName: input.appName,
    version: input.version,
    timezone: input.timezone,
    ok: input.ok,
    problems: input.problems,
    uptime: input.startedAt === null ? null : duration(now - Date.parse(input.startedAt)),

    library: {
      polled: stamp(input.polledAt, now),
      synced: stamp(input.librarySyncedAt, now),
      error: input.libraryError,
      total: counts.reduce((sum, [, n]) => sum + n, 0),
      lists: counts.map(([key, count]) => ({
        key,
        count,
        share: count / largest,
        // Unknown until the first successful poll, which is not the same claim
        // as "nothing moved" — and on a cold page it is the honest one.
        state: input.gate === null ? 'unknown' : refetched.has(key) ? 'refetched' : 'unchanged',
      })),
      moved: input.gate?.moved.length ?? 0,
      gated: input.gate !== null,
      due: due(input.polledAt, input.activitiesPollMs, now),
    },

    feed: {
      events: input.events,
      rendered: stamp(input.renderedAt, now),
      servingCached: input.servingCached,
      error: input.renderError,
      steps: [
        {
          name: 'fetch',
          // `calendarsChangedAt` is what separates "the CDN answered" from "the
          // CDN had something new" — at an interval matched to its regeneration
          // cycle, unchanged is the expected answer, not a fault.
          detail: input.calendarError
            ? 'airdate calendars — serving cache'
            : input.calendarsChangedAt === null
              ? 'airdate calendars'
              : input.calendarsChangedAt === input.calendarsAt
                ? 'airdate calendars — new airdates'
                : `airdate calendars — unchanged since ${stamp(input.calendarsChangedAt, now).label}`,
          at: stamp(input.calendarsAt, now),
          ok: input.calendarError === null,
        },
        { name: 'fetch', detail: `film releases — ${input.films} resolved`, at: stamp(input.filmsResolvedAt, now), ok: true },
        { name: 'join', detail: `${input.events} events`, at: stamp(input.renderedAt, now), ok: input.renderError === null },
        {
          name: 'render',
          detail: input.servingCached ? 'serving the last saved feed' : 'serving live',
          at: stamp(input.renderedAt, now),
          ok: input.renderError === null,
        },
      ],
      calendarsDue: due(input.calendarsAt, input.calendarRefreshMs, now),
      // Films have no timer of their own: the gate checks their age and acts on
      // it, so this is when the next gate will find them due, not a countdown.
      filmsDue: due(input.filmsResolvedAt, input.movieRefreshMs, now),
    },

    sheet: {
      configured: input.sheetConfigured,
      mode: input.sheetMode,
      tab: input.sheetTab,
      status: input.sheetStatus,
      lastRun: stamp(input.sheetLastRunAt, now),
      frozen: input.sheetFrozen,
      error: input.sheetError,
      // Newest first for reading; the journal stores oldest first for appending.
      runs: input.runs
        .map((run) => ({
          at: stamp(run.at, now),
          status: run.status,
          mode: run.mode,
          edits: run.edits,
          inserts: run.inserts,
          error: run.error,
          repeats: run.repeats,
        }))
        .reverse(),
    },
  };
};
