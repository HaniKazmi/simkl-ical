/**
 * MODEL — the running service, reduced to what a page shows. Pure: the clock
 * arrives as `now`; nothing reads `config` or touches io.
 *
 * The state is the shared `Snapshot`; the rest of `StatusInput` is what only
 * this page wants — config labels, the two links, the request ring, the run
 * journal. Plain data rather than an `Orchestrator`, so a test builds one as a
 * literal.
 *
 * Every decision lives here and every wording with it, so `2-html.ts` only
 * places values: which run is open, how long a path may be, which state a
 * subsystem is in, whether it is one insert or two.
 */

import { duration, instantFrom, plainDateIn } from '../shared/dates.ts';

export { duration } from '../shared/dates.ts';
import type { SheetSyncMode } from '../shared/config.ts';
import { totalCount, totalsByType, type LibraryCounts } from '../library-counts.ts';
import { pageHealthy, type Assessment } from '../health.ts';
import type { LibraryMovement, PollOutcome, Snapshot } from '../orchestrator.ts';
import type { EventKind, FeedEvent } from '../feed/2-join.ts';
import type { RequestRecord } from '../api/requests.ts';
import type { SheetRunRecord } from '../sheet/io/journal.ts';
import type { RecordedEdit } from '../sheet/4-plan.ts';
import type { BaselineSummary } from '../sheet/io/baseline.ts';
import type { SheetSyncStatus } from '../sheet/sync.ts';

export interface StatusInput {
  now: Temporal.Instant;
  snapshot: Snapshot;
  assessment: Assessment;
  appName: string;
  version: string;
  timezone: string;
  activitiesPoll: Temporal.Duration;
  calendarRefresh: Temporal.Duration;
  /** Asked of `Feed`, which owns the rule — per-film, so no instant answers it. */
  filmsDue: boolean;
  /**
   * Whether per-episode runtimes can be looked up. Unconfigured makes *zero*
   * requests, so nothing else on the page distinguishes "no credential" from
   * "no season has closed yet" while the Episodes column stays blank.
   */
  runtimesConfigured: boolean;
  /**
   * Whether the films tab is synced at all. Unconfigured it is never read, so
   * nothing else on the page tells "no TMDB token" from "no film has moved" —
   * the same question `runtimesConfigured` answers for TVDB.
   */
  filmsConfigured: boolean;
  sheetMode: SheetSyncMode;
  sheetTab: string;
  /** The films tab's own name, which is a different tab of the same spreadsheet. */
  filmsTab: string;
  /** The feed over http, which is the form you paste into a client that asks for a URL. */
  feedUrl: string;
  /** The same address as `webcal:`, which asks a calendar client to subscribe rather than download. */
  feedSubscribeUrl: string;
  /** The spreadsheet, or null when none is configured. */
  sheetUrl: string | null;
  /**
   * The artwork page: where it is, and what its last index counted. Null when
   * the feature is off; `needing` null until the page has been opened, since
   * the status page fetches nothing and the index is built on demand there.
   */
  artwork: { url: string; needing: number | null; total: number | null; checkedAt: string | null } | null;
  /**
   * The rendered feed's own events, in the order `join` sorted them. Not on
   * the `Snapshot`: that is what `/healthz` answers with, and the feed's
   * titles belong on a page behind the token rather than in a health probe.
   */
  events: readonly FeedEvent[];
  requests: RequestRecord[];
  runs: SheetRunRecord[];
  /**
   * How much of the sheet baseline exists, and how current it is — a count and
   * an instant, never the file's contents. `sheet-runs.json` is the one file
   * this page renders verbatim and so the one to audit for the safe-HTML
   * brand; rendering a second one would make that true of two.
   */
  baseline: BaselineSummary;
}

/** A moment, with the relative wording a reader actually wants. */
export interface Stamp {
  iso: string | null;
  /** `14m ago`, or `never` when there is nothing to describe. */
  label: string;
  /** The same moment, absolute and in the configured zone, for a tooltip. */
  title: string | null;
}

/**
 * When something is next expected. "due in …" rather than "fires at":
 * `schedule()` skips a tick while the previous one is still going, so this is
 * an expectation, not a promise.
 */
export interface Due {
  /** `in 1h 46m`, `overdue by 1h`, or `due now`. Carries its own state — a
   * separate flag would be a styling hook nothing reads. */
  label: string;
}

/** How loudly the page says a thing. The four classes `2-html.ts` styles. */
export type State = 'ok' | 'warn' | 'crit' | 'mute';

/**
 * One half of the service, as its colour and the one thing it does next.
 *
 * The state is the page's only per-subsystem signal — the header pill says
 * something is wrong, a signal says which. What it carries beside that is the
 * page's only forward-looking text: everything in the sections below is what
 * has already happened. It carries no headline, because each half's headline
 * is the pill on its own section an inch below.
 */
export interface Signal {
  name: string;
  state: State;
  /** `gate in 15m`, `calendars in 4h 4m`, `runs with the gate`. */
  next: string;
}

export interface CountRow {
  key: string;
  count: number;
  /** Aligned to `countColumns`. `null` where the type has no such status at all. */
  byStatus: (number | null)[];
}

/**
 * One part of the feed's pipeline. A part carries its own stamp and its own
 * `ok`, which is the page's only per-part failure signal; the names alone say
 * nothing a heading cannot, so they read as one line rather than a row each.
 */
export interface Stage {
  /** `calendars`, `films`, `render`. */
  name: string;
  /** `new airdates`, `5 resolved`, `serving live`. */
  detail: string;
  at: Stamp;
  ok: boolean;
}

/**
 * A run of the feed's events under one heading. A show is a stream of episodes
 * and a film is one or two dates, so a single count over both answers neither
 * question — and the two collapse on their own terms.
 */
export interface UpcomingGroup {
  name: string;
  rows: UpcomingRow[];
  /** `40 events \u00b7 next Thu 27 Aug` — the whole of what a closed group says. */
  summary: string;
  /**
   * Whether the group hides behind a triangle. A short one does not: an
   * expander over five rows reveals what its own summary line already showed,
   * which is why a sheet run of one write gets none either.
   */
  collapsed: boolean;
  /** `12 more, to Fri 18 Jun 2027`. Null when the rows hold everything ahead. */
  more: string | null;
}

/**
 * One line of the feed, as the page prints it. No `episodeTitle`: it is kept
 * out of the ICS `SUMMARY` so a calendar cannot surface a spoiler unasked,
 * and a page that prints it anyway gives that back.
 */
export interface UpcomingRow {
  /** `Wed 12 Aug`, carrying the year where it is not this one. */
  when: string;
  /** The date itself, for the `datetime` attribute. */
  iso: string;
  /** Which half it came from — the row's only marker. */
  kind: EventKind;
  summary: string;
  /** A network for an episode, a release label for a film. */
  detail: string | null;
}

/**
 * The whole of what a run did, when it did one thing. Address, column and
 * wording in the order an expanded row already puts them, so the reader learns
 * the three positions once.
 */
export interface SoleChange {
  /** `F1052`, or `row 610` for an insert — an insert has no single cell. */
  address: string;
  /** The column written, or `insert`. The word is the marker; an insert needs
   * no colour of its own when the cell beside it says what it is. */
  field: string;
  note: string;
}

/** A journal record with its instant made readable and its wording settled. */
export type RunView = Omit<SheetRunRecord, 'at'> & {
  at: Stamp;
  state: State;
  /** The newest run only. The page opens it and collapses the rest. */
  open: boolean;
  /**
   * Set on a run of one change and no error, which is what a real history is
   * nearly all of: the summary line carries the change itself and there is
   * nothing left to expand. One write, or the two a season row's count and its
   * date always come as.
   */
  sole: SoleChange | null;
  /** `15 edits · 1 insert`, or `3 polls` on a sole run that repeated. Null
   * when the line already says everything. */
  count: string | null;
};

export interface MovementView {
  at: Stamp;
  /** `full resync · 743 records read`. What came back, and how it was asked for. */
  pulled: string;
  /** `shows/watching −1`, already ordered and signed. Empty when only progress moved. */
  deltas: string[];
  /** What that entitled the rest of the service to do. */
  consequence: string;
}

export type RequestView = Omit<RequestRecord, 'at' | 'path'> & {
  at: Stamp;
  size: string;
  /** Shortened to fit the column. */
  path: string;
  /** The whole path, for the tooltip. Equal to `path` when it already fit. */
  full: string;
};

export interface StatusModel {
  appName: string;
  version: string;
  timezone: string;
  ok: boolean;
  problems: string[];
  uptime: string | null;
  /** Library, sheet and feed, in the order their sections run. */
  signals: Signal[];
  library: {
    polled: Stamp;
    error: string | null;
    total: number;
    /** The status axis the `byStatus` arrays are aligned to. */
    countColumns: string[];
    /** Totals per type, and how they split by status: the sanity check. */
    counts: CountRow[];
    /** What the last poll did, in one phrase. */
    gate: string;
    /** The last pull that moved anything, and what it meant. */
    movement: MovementView | null;
    due: Due;
  };
  feed: {
    /** Counted off the list the section shows, so the pill cannot contradict it. */
    events: number;
    /** `45 events`, `1 event` — the pill's own text. */
    headline: string;
    rendered: Stamp;
    error: string | null;
    stages: Stage[];
    calendarsDue: Due;
    subscribe: { href: string; url: string };
    /** What the calendar shows next, from today, in groups. Empty when nothing is ahead. */
    upcoming: UpcomingGroup[];
    /**
     * What to say instead of a list. `Feed` restores the last render from disk
     * as an ICS string and never parses it back, so a process serving a saved
     * feed holds no events to show — and "nothing ahead" would deny a feed
     * subscribers are being served. The page says which of the two it is.
     */
    emptyNote: string;
    /**
     * `3 events aired recently, still in the feed` — the grace window, made
     * visible. Null when nothing in the feed is behind today.
     */
    aired: string | null;
  };
  sheet: {
    configured: boolean;
    runtimes: boolean;
    films: boolean;
    filmsTab: string;
    mode: SheetSyncMode;
    tab: string;
    url: string | null;
    status: SheetSyncStatus;
    /** The status as a colour. A freeze outranks it: the message outlives the run that set it. */
    state: State;
    lastRun: Stamp;
    frozen: string | null;
    error: string | null;
    runs: RunView[];
    /**
     * What the sync has recorded SIMKL as saying, and when that last moved.
     *
     * On the page because the record is otherwise invisible: its first run
     * records everything and writes nothing, which is an `idle` run with no
     * edits — indistinguishable from a sync that never armed, at exactly the
     * moment an operator needs to tell those apart.
     */
    baseline: { seasons: number; films: number; movedAt: Stamp };
    /** The artwork page's line, or null when the feature is off. */
    artwork: { url: string; label: string; checkedAt: Stamp | null } | null;
  };
  requests: RequestView[];
  /** The recent failures worth putting in front of a reader, already capped. */
  requestErrors: string[];
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `3 records`, `1 record`. */
const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * Stamps bound to one clock and one zone, so neither is threaded through the
 * dozen call sites in `buildModel`.
 *
 * Never `iso.slice(0, 10)`. The stored value is a UTC instant, and slicing it
 * silently shifts a fifth of them by a day; `plainDateIn` cannot produce a date
 * without being told a zone.
 */
const stamper = (now: Temporal.Instant, timeZone: string) => (iso: string | null): Stamp => {
  const at = instantFrom(iso);
  if (at === null) return { iso, label: 'never', title: null };
  const local = at.toZonedDateTimeISO(timeZone);
  return {
    iso,
    label: `${duration(at.until(now))} ago`,
    title: `${plainDateIn(at, timeZone)} ${pad(local.hour)}:${pad(local.minute)} ${timeZone}`,
  };
};

type Stamped = ReturnType<typeof stamper>;

/**
 * Counted from the last run, not process start, so a skipped tick shows as
 * overdue instead of quietly reporting the next one.
 */
const due = (last: string | null, every: Temporal.Duration, now: Temporal.Instant): Due => {
  const at = instantFrom(last);
  if (at === null) return { label: 'due now' };
  const next = at.add(every);
  return Temporal.Instant.compare(next, now) <= 0
    ? { label: `overdue by ${duration(next.until(now))}` }
    : { label: `in ${duration(now.until(next))}` };
};

/** The row an address sits on, or null where it names none. */
const rowOf = (address: string): string | null => /(\d+)$/.exec(address)?.[1] ?? null;

/**
 * The wording `statusNote` gives a season row's watch note, in
 * `sheet/4-plan.ts`. Recogniser and extractor at once, and it earns the second
 * job: the clear that takes the note away is worded differently and fails this,
 * which leaves a closing batch — End, the clear, and whatever else that batch
 * settles — on the expander it needs to say all of it. A rewording upstream
 * costs the collapse and nothing else, so the rows go back to expanders rather
 * than to anything wrong.
 */
const WATCH_NOTE = / last watched \d{4}-\d{2}-\d{2}$/;

/**
 * A season row's count and the note dating it, as the one change they are: the
 * note's date is appended to the count's own wording, which already names the
 * season.
 *
 * The address is the count's cell. The note's is the `Status` column of that
 * same row by construction, which is not a second place to look.
 *
 * Matched by field and row rather than by position: this is read off disk, and
 * the shared prefix stays rather than being deduped, because a title carries
 * colons of its own — `Frieren: Beyond Journey's End S1` — and no split
 * recovers the label.
 */
const datedCount = (edits: RecordedEdit[]): SoleChange | null => {
  const count = edits.find((e) => e.field === 'Episode');
  const note = edits.find((e) => e.field === 'Status');
  if (!count || !note) return null;
  const row = rowOf(count.address);
  if (row === null || row !== rowOf(note.address)) return null;
  const dated = WATCH_NOTE.exec(note.note);
  if (dated === null) return null;
  return { address: count.address, field: count.field, note: `${count.note},${dated[0]}` };
};

/**
 * A run's whole story, when it is one change. An error is a second thing to
 * say however small the plan was, so a run carrying one keeps its expander.
 *
 * Two edits qualify in exactly one shape, which is the shape most applied runs
 * have: a count and the note dating it are one change described twice, because
 * the note is written only when the count beside it moves and only onto that
 * same row.
 */
const soleChange = (run: SheetRunRecord): SoleChange | null => {
  if (run.error !== null) return null;
  if (run.edits.length === 1 && run.inserts.length === 0) {
    const { address, field, note } = run.edits[0]!;
    return { address, field, note };
  }
  if (run.edits.length === 2 && run.inserts.length === 0) return datedCount(run.edits);
  if (run.inserts.length === 1 && run.edits.length === 0) {
    const { address, note } = run.inserts[0]!;
    return { address, field: 'insert', note };
  }
  return null;
};

/**
 * What is left to say once the line has said what it can. A zero component is
 * dropped rather than printed: `0 edits · 0 inserts` counts what a refused run
 * was stopped from doing, which is not a size at all. `repeats` survives a
 * sole change — `report` mode re-plans the identical run every poll, and how
 * long it has been saying so is the reading.
 */
const runCount = (run: SheetRunRecord, sole: SoleChange | null): string | null => {
  const parts: string[] = [];
  if (sole === null) {
    if (run.edits.length) parts.push(plural(run.edits.length, 'edit'));
    if (run.inserts.length) parts.push(plural(run.inserts.length, 'insert'));
    if (!parts.length) parts.push('no writes');
  }
  if (run.repeats > 1) parts.push(`${run.repeats} polls`);
  return parts.length ? parts.join(' · ') : null;
};

const SHEET_STATE: Record<string, State> = {
  applied: 'ok',
  reported: 'mute',
  idle: 'mute',
  refused: 'warn',
  'rolled-back': 'warn',
  failed: 'crit',
  frozen: 'crit',
};

/**
 * Looked up with `Object.hasOwn`, not `?? 'mute'`: a status read from
 * `sheet-runs.json` saying `"constructor"` resolves through the prototype to a
 * function, so the default would never fire.
 */
export const sheetState = (status: string): State => (Object.hasOwn(SHEET_STATE, status) ? SHEET_STATE[status]! : 'mute');

/**
 * Long enough to hold a SIMKL path whole, short enough that a Google one stops
 * wrapping its row: the 44-character spreadsheet id repeats on every `sheets`
 * call and is the only thing that overruns.
 */
const PATH_BUDGET = 48;

/**
 * Shortened in the middle, never the end, because the tail is what tells the
 * rows apart — `…:batchUpdate` from `…?ranges='Sheet1'`. The rule is by length
 * alone; no upstream's URL shape is known here.
 */
const shorten = (path: string): string => {
  if (path.length <= PATH_BUDGET) return path;
  const head = Math.ceil((PATH_BUDGET - 1) / 2);
  return `${path.slice(0, head)}…${path.slice(head + 1 - PATH_BUDGET)}`;
};

/**
 * What the last calendar fetch achieved. Early returns, not a nested ternary:
 * the branch a reader comes for — why it says *unchanged* — is the one a
 * ternary buries deepest.
 *
 * The `changed === attempted` test is string identity, and holds because
 * `Feed.refreshCalendars` assigns `calendarsChangedAt` the very value it just
 * put in `calendarsAt`.
 */
const calendarDetail = (calendars: Snapshot['feed']['calendars'], at: Stamped): string => {
  // `attemptedAt` is stamped only after a fetch returns, so a failure with
  // none means the CDN has never answered this process and nothing is cached.
  // "Serving cache" there would assert a copy that does not exist.
  if (calendars.error) return calendars.attemptedAt === null ? 'none yet, the CDN has not answered' : 'serving cache';
  if (calendars.changedAt === null) return 'no new airdates yet';
  if (calendars.changedAt === calendars.attemptedAt) return 'new airdates';
  return `unchanged since ${at(calendars.changedAt).label}`;
};

/**
 * What the last poll did, in one phrase. "not polled yet" is a different
 * claim from "nothing moved": before the first successful poll, nothing is
 * known. A refused diff outranks the counts — it is the one outcome that
 * changes what the *next* poll will do.
 */
const gateDetail = (gate: PollOutcome | null): string => {
  if (gate === null) return 'not polled yet';
  if (gate.refusedRemovals) return 'removals refused — next poll pulls whole';
  if (gate.pull === 'full') return 'full resync';
  const parts: string[] = [];
  if (gate.updated) parts.push(`${gate.updated} updated`);
  if (gate.removed) parts.push(`${gate.removed} removed`);
  return parts.length ? parts.join(' · ') : 'nothing moved';
};

/** The status axis, in the order a title moves along it, with the page's labels. */
const STATUS_COLUMNS: Array<{ status: string; label: string }> = [
  { status: 'watching', label: 'watch' },
  { status: 'completed', label: 'done' },
  { status: 'plantowatch', label: 'plan' },
  { status: 'hold', label: 'hold' },
  { status: 'dropped', label: 'drop' },
];

/**
 * The totals, named for a reader. `library-counts.ts` owns the arithmetic and
 * the keys; this owns that the page says "films" where SIMKL says "movies",
 * and that a zero `other` is noise — it exists to keep the rows summing, not
 * to be read.
 *
 * A status a type does not have reads `null`, not zero. `movies` carries no
 * `watching` key at all, and "SIMKL has no such state for films" is a
 * different claim from "no films are being watched".
 */
const countRows = (counts: LibraryCounts): CountRow[] =>
  totalsByType(counts)
    .filter((row) => row.type !== 'other' || row.count > 0)
    .map((row) => ({
      key: row.type === 'movies' ? 'films' : row.type,
      count: row.count,
      byStatus: STATUS_COLUMNS.map(({ status }) => (row.type === 'other' ? null : (counts.byType[row.type][status] ?? null))),
    }));

/** `+1` / `−1`, with a real minus sign rather than a hyphen. */
const signed = (n: number): string => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);

/**
 * The last pull that moved anything, and what it meant.
 *
 * Two numbers, not one. `updated` is how many records the payload carried —
 * the whole library on a full resync — while `reshaped` is how many of them
 * arrived new or under a different status, which is the only part the feed can
 * see. Catching up on a season has a large `updated` and a zero `reshaped`,
 * and the feed is right not to re-render.
 *
 * Whether it did re-render is read off `rendered`, never re-derived: the poll
 * also renders when a film comes into range, which moves no count here, so
 * working the answer back out of the numbers states the opposite.
 */
const movementView = (movement: LibraryMovement | null, at: Stamped): MovementView | null => {
  if (movement === null) return null;

  const read = `${plural(movement.updated, 'record')} read`;
  // `pull` is `none` on a poll where only the membership diff ran: the
  // signature had not moved, so nothing was asked for and titles still left.
  const pulled = [movement.pull === 'none' ? 'membership check' : `${movement.pull === 'full' ? 'full resync' : 'delta'} · ${read}`];
  if (movement.removed) pulled.push(`${plural(movement.removed, 'title')} removed`);

  const moved: string[] = [];
  if (movement.reshaped) moved.push(`${movement.reshaped} changed membership`);
  if (movement.removed) moved.push(`${plural(movement.removed, 'title')} left the library`);
  // A full pull always renders and never sets `reshaped`, so it reaches here
  // with nothing named. Whatever is left rendered because a film reached its
  // release date, which moves no count this section shows.
  if (!moved.length) moved.push(movement.pull === 'full' ? 'the whole library was re-read' : 'a film came into range');

  return {
    at: at(movement.at),
    pulled: pulled.join(' · '),
    deltas: movement.deltas.map((d) => `${d.status === null ? d.type : `${d.type}/${d.status}`} ${signed(d.delta)}`),
    consequence: movement.rendered ? `${moved.join(', ')}, so the feed re-rendered` : 'progress only, so the feed was left alone',
  };
};

/**
 * How many rows a group prints before it starts counting instead. Fifty, the
 * journal's number: it bounds the page without cutting a real feed short — an
 * airing show a night plus the films on plan-to-watch runs to about 45, and
 * the films are the far end of it.
 */
const UPCOMING_LIMIT = 50;

/**
 * Past how many rows a group hides behind a triangle. Below it the expander
 * would reveal what the summary line beside it already showed, which is the
 * rule the sheet's own one-write runs follow.
 */
const UPCOMING_COLLAPSE = 8;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `Wed 12 Aug`, and the year too where it is not the current one: a feed
 * carries dates well over a year out, and `30 Apr` alone reads as four months
 * ago rather than eight ahead.
 *
 * Spelled here rather than through `toLocaleString`: the page is English
 * either way, and the strings this suite pins would otherwise move with the
 * ICU build underneath it.
 */
const dayLabel = (date: Temporal.PlainDate, today: Temporal.PlainDate): string => {
  const label = `${WEEKDAYS[date.dayOfWeek - 1]} ${date.day} ${MONTHS[date.month - 1]}`;
  return date.year === today.year ? label : `${label} ${date.year}`;
};

/**
 * Which heading each kind falls under. A `Record` over `EventKind` rather than
 * a list of kinds per group: a fourth kind then fails `tsc`, which is the only
 * build step there is, instead of vanishing from every group while the count
 * beside them still includes it.
 *
 * Anime sits with shows — it is a separate SIMKL type rather than a genre, but
 * it is still a stream of episodes, and a third group is empty on most feeds.
 * The row's own `kind` still names it.
 */
const GROUP_OF: Record<EventKind, string> = { tv: 'Shows', anime: 'Shows', movie: 'Films' };

/** The order the headings appear in, which `GROUP_OF` does not carry. */
const GROUP_ORDER = ['Shows', 'Films'];

/**
 * The feed, grouped, as far ahead as the page prints it.
 *
 * `events` arrives in the order `join` sorted it — by date, then summary — so
 * one pass preserves it and each group's first row is its next. Sorting again
 * here would be a second copy of that rule, and a looser one: a re-sort on date
 * alone reorders a day's events against the feed a client actually holds.
 *
 * One pass, and a group keeps only the rows it will print: the page is capped
 * at `UPCOMING_LIMIT` rows a group however long the feed is, and this runs
 * synchronously on every request for the page.
 *
 * Events behind today are counted rather than listed. They are in the feed on
 * the grace window and a long one would otherwise fill the list with what has
 * already happened, which is not the question the section asks.
 *
 * A group with nothing ahead is dropped rather than printed empty — a feed
 * with no films on plan-to-watch should not carry a Films heading over a zero.
 */
const upcomingOf = (
  events: readonly FeedEvent[],
  now: Temporal.Instant,
  timeZone: string,
  servingCached: boolean,
): Pick<StatusModel['feed'], 'upcoming' | 'aired' | 'emptyNote'> => {
  const today = plainDateIn(now, timeZone);
  const groups = new Map<string, { rows: UpcomingRow[]; count: number; first: Temporal.PlainDate; last: Temporal.PlainDate }>();
  let behind = 0;

  for (const event of events) {
    if (Temporal.PlainDate.compare(event.date, today) < 0) {
      behind += 1;
      continue;
    }
    const name = GROUP_OF[event.kind];
    const group = groups.get(name);
    if (!group) {
      groups.set(name, { rows: [], count: 0, first: event.date, last: event.date });
    }
    const into = groups.get(name)!;
    into.count += 1;
    into.last = event.date;
    if (into.rows.length < UPCOMING_LIMIT) {
      into.rows.push({
        when: dayLabel(event.date, today),
        iso: event.date.toString(),
        kind: event.kind,
        summary: event.summary,
        detail: event.detail,
      });
    }
  }

  const upcoming = GROUP_ORDER.flatMap((name) => {
    const group = groups.get(name);
    if (!group) return [];
    const hidden = group.count - group.rows.length;
    return [
      {
        name,
        rows: group.rows,
        // Closed, this is the whole of what the group says, so it carries both
        // the size of the list and the one date a reader came for.
        summary: `${plural(group.count, 'event')} \u00b7 next ${dayLabel(group.first, today)}`,
        collapsed: group.count > UPCOMING_COLLAPSE,
        // The furthest date is named, so a reader knows how far the feed reaches
        // without the page printing every row to prove it.
        more: hidden > 0 ? `${hidden} more, to ${dayLabel(group.last, today)}` : null,
      },
    ];
  });

  return {
    upcoming,
    aired: behind > 0 ? `${plural(behind, 'event')} aired recently, still in the feed` : null,
    emptyNote: servingCached
      ? 'Serving the last saved feed — what is in it is not known until the next render.'
      : 'Nothing ahead in the feed.',
  };
};

/** `21K`, `2.4M`, or `—` for a response that carried no body. */
const size = (bytes: number | null): string => {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
};

/**
 * The three signals. Each subsystem's state comes from the problems `assess`
 * already tagged, so one can never light up over something the box below it
 * does not explain.
 *
 * The feed answers to two areas: its own failure is critical, a quiet CDN only
 * a warning, because a stale calendar still renders. That is the ranking
 * `assess` puts the lines in, applied to colour.
 */
const signals = (input: StatusInput, model: Omit<StatusModel, 'signals'>): Signal[] => {
  const has = (area: Assessment['problems'][number]['area']): boolean => input.assessment.problems.some((p) => p.area === area);
  const { library, feed, sheet } = model;

  // The sheet has no timer: it runs on the back of the library poll, so what
  // it does next is whatever the gate beside it decides. Nothing else on the
  // page says that, and `ran 6m ago` is the section's own head.
  const sheetSignal: Signal = sheet.configured
    ? { name: 'sheet', state: sheet.state, next: sheet.lastRun.iso === null ? 'not run yet' : 'runs with the gate' }
    : { name: 'sheet', state: 'mute', next: 'off, no SHEET_ID' };

  // In the order the sections below run, so a signal and its section read as
  // one subject rather than two.
  return [
    { name: 'library', state: has('library') ? 'crit' : 'ok', next: `gate ${library.due.label}` },
    sheetSignal,
    { name: 'feed', state: has('feed') ? 'crit' : has('calendars') ? 'warn' : 'ok', next: `calendars ${feed.calendarsDue.label}` },
  ];
};

export const buildModel = (input: StatusInput): StatusModel => {
  const { now } = input;
  const { library, feed, sheet } = input.snapshot;
  const at = stamper(now, input.timezone);
  const startedAt = instantFrom(input.snapshot.startedAt);
  // Newest first for reading; the journal stores oldest first for appending.
  // Only that newest one opens: fifty runs expanded repeat the same edits and
  // bury every section below.
  const runs: RunView[] = input.runs
    .map((run) => {
      const sole = soleChange(run);
      return { ...run, at: at(run.at), state: sheetState(run.status), open: false, sole, count: runCount(run, sole) };
    })
    .reverse()
    .map((run, index) => ({ ...run, open: index === 0 }));
  // One instant: the join, the render and the section heading describe the
  // same moment.
  const rendered = at(feed.renderedAt);

  const model: Omit<StatusModel, 'signals'> = {
    appName: input.appName,
    version: input.version,
    timezone: input.timezone,
    // `assessment.ok` answers "should this container be restarted", which is
    // narrower — a revoked token and a quiet CDN are real problems restarting
    // cannot fix. Here anything in `problems` makes the page not-healthy.
    ok: pageHealthy(input.assessment),
    problems: input.assessment.problems.map((problem) => problem.message),
    uptime: startedAt === null ? null : duration(startedAt.until(now)),

    library: {
      polled: at(library.polledAt),
      error: library.error,
      total: totalCount(library.counts),
      countColumns: STATUS_COLUMNS.map((column) => column.label),
      counts: countRows(library.counts),
      gate: gateDetail(library.poll),
      movement: movementView(library.movement, at),
      due: due(library.polledAt, input.activitiesPoll, now),
    },

    feed: {
      // Off the list the page shows, not the snapshot's own tally: two counts
      // of one thing can disagree, and only one of them is what the section
      // beneath the pill lists.
      events: input.events.length,
      headline: plural(input.events.length, 'event'),
      rendered,
      error: feed.error,
      // No stage for the join: its whole detail is the event count, and the
      // section states that itself, above the events.
      stages: [
        { name: 'calendars', detail: calendarDetail(feed.calendars, at), at: at(feed.calendars.attemptedAt), ok: feed.calendars.error === null },
        {
          name: 'films',
          // Where the films stand and whether more are wanted, in one phrase:
          // due is per-film, so no stamp plus interval re-derives it.
          detail: input.filmsDue ? `${feed.films.resolved} resolved, more due` : `${feed.films.resolved} resolved`,
          at: at(feed.films.resolvedAt),
          ok: true,
        },
        {
          name: 'render',
          detail: feed.servingCached ? 'serving the last saved feed' : 'serving live',
          at: rendered,
          ok: feed.error === null,
        },
      ],
      calendarsDue: due(feed.calendars.attemptedAt, input.calendarRefresh, now),
      subscribe: { href: input.feedSubscribeUrl, url: input.feedUrl },
      ...upcomingOf(input.events, now, input.timezone, feed.servingCached),
    },

    // No reverse: the request log is already newest first, unlike the run
    // journal below, which is appended to and so stores oldest first.
    requests: input.requests.map((request) => ({
      ...request,
      at: at(request.at),
      size: size(request.bytes),
      path: shorten(request.path),
      full: request.path,
    })),
    // Capped here, not in the template: which failures to show is a decision;
    // the template turns lists into rows.
    requestErrors: input.requests
      .filter((request) => request.error !== null)
      .slice(0, 3)
      .map((request) => `${request.path} — ${request.error}`),

    sheet: {
      configured: sheet.configured,
      runtimes: input.runtimesConfigured,
      films: input.filmsConfigured,
      filmsTab: input.filmsTab,
      mode: input.sheetMode,
      tab: input.sheetTab,
      url: input.sheetUrl,
      status: sheet.status,
      state: sheet.frozen === null ? sheetState(sheet.status) : 'crit',
      lastRun: at(sheet.lastRunAt),
      frozen: sheet.frozen,
      // The live error slot, dropped when something below already prints the
      // same text: the run that recorded it is right there, and the freeze
      // message has its own box.
      error: sheet.error === sheet.frozen || sheet.error === (runs[0]?.error ?? null) ? null : sheet.error,
      runs,
      baseline: { seasons: input.baseline.seasons, films: input.baseline.films, movedAt: at(input.baseline.at) },
      artwork:
        input.artwork === null
          ? null
          : {
              url: input.artwork.url,
              label: input.artwork.needing === null ? 'not checked yet — open the page' : `${input.artwork.needing} of ${input.artwork.total} need artwork`,
              checkedAt: input.artwork.checkedAt === null ? null : at(input.artwork.checkedAt),
            },
    },
  };

  return { ...model, signals: signals(input, model) };
};
