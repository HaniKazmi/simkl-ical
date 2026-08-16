/**
 * MODEL — the running service, reduced to what a page shows. Pure: the clock
 * arrives as `now`, and nothing here reads `config` or touches io.
 *
 * `StatusInput` is plain data rather than an `Orchestrator`, which is what keeps
 * this module from importing upward into root. It restates field names the
 * shell already has; in exchange a test builds one as a literal instead of
 * assembling a live service.
 */

import { instantFrom } from '../shared/dates.ts';
import type { SheetSyncMode } from '../shared/config.ts';
import { totalsByType } from '../library.ts';
import type { RequestRecord } from '../api/requests.ts';
import type { SheetRunRecord } from '../sheet/io/journal.ts';
import type { SheetSyncStatus } from '../sheet/sync.ts';

export interface StatusInput {
  now: Temporal.Instant;
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
  /**
   * How the counts moved on the last poll that moved them, and when. Null until
   * a poll has pulled — and deliberately *not* cleared by a quiet poll, so the
   * line keeps reporting the last thing that happened rather than blanking
   * every half hour.
   */
  movement: { at: string; deltas: Record<string, number>; updated: number; removed: number } | null;
  requests: RequestRecord[];
  activitiesPoll: Temporal.Duration;

  events: number;
  renderedAt: string | null;
  servingCached: boolean;
  renderError: string | null;
  calendarsAt: string | null;
  calendarsChangedAt: string | null;
  calendarError: string | null;
  calendarRefresh: Temporal.Duration;
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
}

export interface Step {
  name: string;
  detail: string;
  at: Stamp;
  ok: boolean;
}

/** A journal record with its instant made readable. */
export type RunView = Omit<SheetRunRecord, 'at'> & { at: Stamp };

export interface MovementView {
  at: Stamp;
  /** `shows/watching −1`, already ordered and signed. Empty when only progress moved. */
  deltas: string[];
  /** `14 records updated, 1 removed` — always present, since a pull always did something. */
  summary: string;
}

export type RequestView = Omit<RequestRecord, 'at'> & { at: Stamp; size: string };

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
    /** Totals per type: the sanity check, in one line rather than fourteen. */
    counts: CountRow[];
    /** What the last poll did, in one phrase. */
    gate: string;
    /** How the library moved when it last moved, or null if it never has. */
    movement: MovementView | null;
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
  requests: RequestView[];
  /** The recent failures worth putting in front of a reader, already capped. */
  requestErrors: string[];
}

/**
 * Coarse on purpose: two units is what a person reads at a glance, and a page
 * that says `4d 6h 12m 3s` is reporting precision the underlying timers do not
 * have.
 *
 * `round` does the unit-splitting, so the only arithmetic left here is choosing
 * which two units to print. Days and below throughout, so no `relativeTo` anchor
 * is needed and a day is exactly 24 hours.
 */
export const duration = (span: Temporal.Duration): string => {
  const total = span.total('milliseconds');
  if (total <= 0) return '0s';
  const { days, hours, minutes, seconds } = span.round({ largestUnit: 'day', smallestUnit: 'second' });
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
};

/**
 * Never `iso.slice(0, 10)`. The stored value is a UTC instant, and this is the
 * layer where slicing it silently shifts a fifth of them by a day.
 */
const stamp = (iso: string | null, now: Temporal.Instant): Stamp => {
  const at = instantFrom(iso);
  return { iso, label: at === null ? 'never' : `${duration(at.until(now))} ago` };
};

/**
 * Counted from the last run rather than from process start, so a skipped tick
 * shows as overdue instead of quietly reporting the next one.
 */
const due = (last: string | null, every: Temporal.Duration, now: Temporal.Instant): Due => {
  const at = instantFrom(last);
  if (at === null) return { label: 'due now' };
  const next = at.add(every);
  return Temporal.Instant.compare(next, now) <= 0
    ? { label: `overdue by ${duration(now.until(next).negated())}` }
    : { label: `in ${duration(now.until(next))}` };
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
const calendarDetail = (input: StatusInput, now: Temporal.Instant): string => {
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

/**
 * The totals, named for a reader.
 *
 * `library.ts` owns the arithmetic and the key scheme; this owns that the page
 * says "films" where SIMKL says "movies", and that a zero `other` is noise
 * rather than news — it exists to keep the rows summing, not to be read.
 */
const countRows = (counts: Record<string, number>): CountRow[] => {
  const { other, ...types } = totalsByType(counts);
  const rows = Object.entries(types).map(([key, count]) => ({ key: key === 'movies' ? 'films' : key, count }));
  return other ? [...rows, { key: 'other', count: other }] : rows;
};

/** `+1` / `−1`, with a real minus sign rather than a hyphen. */
const signed = (n: number): string => (n > 0 ? `+${n}` : `\u2212${Math.abs(n)}`);

/**
 * How the library moved, in the terms the poll actually distinguishes.
 *
 * The two lines say different things and both matter. `deltas` is membership —
 * a title left one status and arrived in another — and is empty on the common
 * poll, because watching an episode moves no counts at all. `summary` is what
 * the delta carried, which is non-zero whenever anything was pulled. Together
 * they are `reshaped` versus `updated` made legible, and that distinction is
 * what the feed's own render gate keys on.
 */
const movementView = (movement: StatusInput['movement'], now: Temporal.Instant): MovementView | null => {
  if (movement === null) return null;
  const deltas = Object.entries(movement.deltas)
    .filter(([, delta]) => delta !== 0)
    .map(([key, delta]) => `${key} ${signed(delta)}`);
  const parts = [`${movement.updated} ${movement.updated === 1 ? 'record' : 'records'} updated`];
  if (movement.removed) parts.push(`${movement.removed} removed`);
  if (!deltas.length) parts.push('nothing moved between statuses');
  return { at: stamp(movement.at, now), deltas, summary: parts.join(', ') };
};

/** `21K`, `2.4M`, or `—` for a response that carried no body. */
const size = (bytes: number | null): string => {
  if (bytes === null) return '\u2014';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
};

export const buildModel = (input: StatusInput): StatusModel => {
  const { now } = input;
  const startedAt = instantFrom(input.startedAt);
  // One instant, three places: the join, the render and the section heading all
  // describe the same moment.
  const rendered = stamp(input.renderedAt, now);

  return {
    appName: input.appName,
    version: input.version,
    timezone: input.timezone,
    // `ok` from `/healthz` answers "should this container be restarted", which
    // is deliberately narrower — a revoked token and a quiet CDN are both real
    // problems that restarting cannot fix. The page reports what a reader sees,
    // so anything in `problems` makes it not-healthy here.
    ok: input.ok && input.problems.length === 0,
    problems: input.problems,
    uptime: startedAt === null ? null : duration(startedAt.until(now)),

    library: {
      polled: stamp(input.polledAt, now),
      error: input.libraryError,
      total: Object.values(input.counts).reduce((sum, n) => sum + n, 0),
      counts: countRows(input.counts),
      gate: gateDetail(input.gate),
      movement: movementView(input.movement, now),
      due: due(input.polledAt, input.activitiesPoll, now),
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
      calendarsDue: due(input.calendarsAt, input.calendarRefresh, now),
      // A boolean, not a countdown: whether a film is due is per-film — a new or
      // undated one is due now, a date most of a year out is not — so no single
      // instant says when the next one falls due.
      filmsDue: input.filmsDue,
    },

    // No reverse: the request log is already newest first, unlike the run
    // journal below, which is a file appended to and so stores oldest first.
    requests: input.requests.map((request) => ({ ...request, at: stamp(request.at, now), size: size(request.bytes) })),
    // Capped here rather than in the template: which failures to show is a
    // decision, and the template's job is turning a list into rows.
    requestErrors: input.requests
      .filter((request) => request.error !== null)
      .slice(0, 3)
      .map((request) => `${request.path} — ${request.error}`),

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
