/**
 * MODEL — the running service, reduced to what a page shows. Pure: the clock
 * arrives as `now`, and nothing here reads `config` or touches io.
 *
 * `StatusInput` is plain data rather than an `Orchestrator`, which is what keeps
 * this module from importing upward into root. It restates field names the
 * shell already has; in exchange a test builds one as a literal instead of
 * assembling a live service.
 */

import { MS_PER_DAY } from '../shared/dates.ts';
import type { SheetSyncMode } from '../shared/config.ts';
import type { SheetRunRecord } from '../sheet/io/journal.ts';
import type { SheetSyncStatus } from '../sheet/sync.ts';

export interface StatusInput {
  now: number;
  appName: string;
  version: string;
  timezone: string;
  startedAt: string | null;
  ok: boolean;
  problems: string[];

  polledAt: string | null;
  libraryError: string | null;
  /** Every type and status, including the empty ones — see `libraryCounts`. */
  counts: Record<string, number>;
  gate: { pull: 'none' | 'delta' | 'full'; updated: number; removed: number } | null;
  activitiesPollMs: number;

  events: number;
  renderedAt: string | null;
  servingCached: boolean;
  renderError: string | null;
  calendarsAt: string | null;
  calendarsChangedAt: string | null;
  calendarError: string | null;
  calendarRefreshMs: number;
  films: number;
  /** The last round that completed — not a countdown; films have no timer. */
  filmsResolvedAt: string | null;
  filmsDue: boolean;

  sheetConfigured: boolean;
  sheetMode: SheetSyncMode;
  sheetTab: string;
  sheetStatus: SheetSyncStatus;
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
  /** `in 1h 46m`, `overdue by 1h`, or `due now`. Carries its own state — a
   * separate flag would be a styling hook nothing reads. */
  label: string;
}

export interface CountRow {
  key: string;
  count: number;
  /** Share of the largest row, for a bar. 0 when everything is empty. */
  share: number;
}

export interface Step {
  name: string;
  detail: string;
  at: Stamp;
  ok: boolean;
}

/** A journal record with its instant made readable. */
export type RunView = Omit<SheetRunRecord, 'at'> & { at: Stamp };

export interface StatusModel {
  appName: string;
  version: string;
  timezone: string;
  ok: boolean;
  problems: string[];
  uptime: string | null;
  library: {
    polled: Stamp;
    error: string | null;
    total: number;
    counts: CountRow[];
    /** What the last poll did, in one phrase. */
    gate: string;
    due: Due;
  };
  feed: {
    events: number;
    rendered: Stamp;
    error: string | null;
    steps: Step[];
    calendarsDue: Due;
    filmsDue: boolean;
  };
  sheet: {
    configured: boolean;
    mode: SheetSyncMode;
    tab: string;
    status: SheetSyncStatus;
    lastRun: Stamp;
    frozen: string | null;
    error: string | null;
    runs: RunView[];
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = MS_PER_DAY;

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
  if (last === null) return { label: 'due now' };
  const remaining = Date.parse(last) + everyMs - now;
  return { label: remaining <= 0 ? `overdue by ${duration(-remaining)}` : `in ${duration(remaining)}` };
};

/**
 * What the last calendar fetch actually achieved. Early returns rather than a
 * nested ternary, because the branch a reader comes here for — why it says
 * *unchanged* — is the one a ternary buries deepest.
 *
 * The `changed === attempted` test is string identity, and holds because
 * `Feed.refreshCalendars` assigns `calendarsChangedAt` the very value it just
 * put in `calendarsAt`.
 */
const calendarDetail = (input: StatusInput, now: number): string => {
  const prefix = 'airdate calendars';
  // `calendarsAt` is stamped only after a fetch returns, so a failure with none
  // means the CDN has never answered this process and there is nothing cached
  // to fall back on. Saying "serving cache" there asserts a copy that does not
  // exist, on exactly the boot where the page is being read to find that out.
  if (input.calendarError) return input.calendarsAt === null ? `${prefix} — none yet, the CDN has not answered` : `${prefix} — serving cache`;
  if (input.calendarsChangedAt === null) return prefix;
  if (input.calendarsChangedAt === input.calendarsAt) return `${prefix} — new airdates`;
  return `${prefix} — unchanged since ${stamp(input.calendarsChangedAt, now).label}`;
};

/**
 * What the last poll did, in one phrase.
 *
 * "not polled yet" is a different claim from "nothing moved" — until the first
 * successful poll, nothing is known, and on a cold page that is the honest
 * thing to say.
 */
const gateDetail = (gate: StatusInput['gate']): string => {
  if (gate === null) return 'not polled yet';
  if (gate.pull === 'full') return 'full resync';
  const parts: string[] = [];
  if (gate.updated) parts.push(`${gate.updated} updated`);
  if (gate.removed) parts.push(`${gate.removed} removed`);
  return parts.length ? parts.join(' · ') : 'nothing moved';
};

export const buildModel = (input: StatusInput): StatusModel => {
  const { now } = input;
  const counts = Object.entries(input.counts);
  const largest = Math.max(1, ...counts.map(([, n]) => n));
  // One instant, three places: the join, the render and the section heading all
  // describe the same moment.
  const rendered = stamp(input.renderedAt, now);

  return {
    appName: input.appName,
    version: input.version,
    timezone: input.timezone,
    ok: input.ok,
    problems: input.problems,
    uptime: input.startedAt === null ? null : duration(now - Date.parse(input.startedAt)),

    library: {
      polled: stamp(input.polledAt, now),
      error: input.libraryError,
      total: counts.reduce((sum, [, n]) => sum + n, 0),
      counts: counts.map(([key, count]) => ({ key, count, share: count / largest })),
      gate: gateDetail(input.gate),
      due: due(input.polledAt, input.activitiesPollMs, now),
    },

    feed: {
      events: input.events,
      rendered,
      error: input.renderError,
      steps: [
        { name: 'fetch', detail: calendarDetail(input, now), at: stamp(input.calendarsAt, now), ok: input.calendarError === null },
        { name: 'fetch', detail: `film releases — ${input.films} resolved`, at: stamp(input.filmsResolvedAt, now), ok: true },
        { name: 'join', detail: `${input.events} events`, at: rendered, ok: input.renderError === null },
        {
          name: 'render',
          detail: input.servingCached ? 'serving the last saved feed' : 'serving live',
          at: rendered,
          ok: input.renderError === null,
        },
      ],
      calendarsDue: due(input.calendarsAt, input.calendarRefreshMs, now),
      // A boolean, not a countdown: whether a film is due is per-film — a new or
      // undated one is due now, a date most of a year out is not — so no single
      // instant says when the next one falls due.
      filmsDue: input.filmsDue,
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
      runs: input.runs.map((run) => ({ ...run, at: stamp(run.at, now) })).reverse(),
    },
  };
};
