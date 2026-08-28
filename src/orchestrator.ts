/**
 * The running service: one poll driving two consumers.
 *
 * Owns the SIMKL library — the input both halves share — plus the timers, the
 * abort controller and `/healthz`. Everything the feed needs lives in `Feed`;
 * everything the spreadsheet needs lives in `SheetSync`. Neither knows about
 * the other, and this file is the only thing that knows about both.
 *
 * **Requests never trigger a fetch**: a client polling hard cannot amplify into
 * SIMKL traffic, and a SIMKL outage degrades to a stale feed rather than an
 * empty one.
 */

import { config, sheetSyncConfigured } from './shared/config.ts';
import { errorMessage, errorStack } from './shared/errors.ts';
import type { Logger } from './shared/logger.ts';
import { fetchAllItems, fetchMembership, getActivities } from './api/simkl/lists.ts';
import { deltaFrom, evaluateGate, membershipIds, mergeDelta, retainOnly, toLibrary, watermarkOf, type GateDecision } from './library.ts';
import { countDeltas, libraryCounts, type CountDelta, type LibraryCounts } from './library-counts.ts';
import { readToken } from './api/simkl/auth.ts';
import { SimklAuthError } from './api/simkl/client.ts';
import type { Library } from './library.ts';
import type { Activities, SyncType } from './api/simkl/types.ts';
import { Feed } from './feed/feed.ts';
import { SheetSync, type SheetSyncStatus } from './sheet/sync.ts';
import { nowIso } from './shared/dates.ts';

/**
 * The service's state, as one plain value: what `/healthz` assesses and the
 * status page renders. Produced by `Orchestrator.snapshot()` — the one export
 * of state, so neither reader has to know which of three objects holds a
 * field, and a new field is added in exactly one place.
 */
export interface Snapshot {
  startedAt: string;
  library: {
    /** The last `/sync/activities` call — what stops when a token is revoked. */
    polledAt: string | null;
    /** The last time the library actually moved. Days old on a correct, quiet system. */
    syncedAt: string | null;
    error: string | null;
    counts: LibraryCounts;
    poll: PollOutcome | null;
    movement: LibraryMovement | null;
  };
  feed: {
    events: number;
    renderedAt: string | null;
    /** True while the feed came off disk and no fresh render has replaced it. */
    servingCached: boolean;
    /** A render failure. Not the calendars' — that is one level down. */
    error: string | null;
    calendars: {
      /** Every refresh, including ones served from cache after a failure. */
      attemptedAt: string | null;
      /** Only when the CDN actually answered. The two diverge while serving cache. */
      freshAt: string | null;
      /** When the CDN last sent new bytes, as opposed to answering 304. */
      changedAt: string | null;
      error: string | null;
    };
    films: {
      resolved: number;
      /** The last round that completed — not a countdown; films have no timer. */
      resolvedAt: string | null;
    };
  };
  sheet: {
    configured: boolean;
    status: SheetSyncStatus;
    lastRunAt: string | null;
    /** The whole repair message; `/healthz` reduces it to a boolean. */
    frozen: string | null;
    error: string | null;
  };
}

/**
 * How the library's shape changed on a poll that changed it.
 *
 * Kept beside `lastPoll` and updated on the same polls, so the two cannot drift
 * — and deliberately *not* reset by a quiet poll, because a page that blanks
 * every half hour tells a reader less than one still showing the last real
 * movement.
 */
export interface LibraryMovement {
  at: string;
  /** Only the counts that moved. */
  deltas: CountDelta[];
  updated: number;
  removed: number;
}

/**
 * What one poll did, complete at assignment: a page rendered mid-poll shows the
 * previous outcome, never a half-filled one.
 */
export interface PollOutcome {
  at: string;
  /** The status signature differed — the gate's own answer, distinct from `pull` on a forced poll. */
  changed: boolean;
  /** What was actually pulled. Wider than `changed` on a cold or forced poll. */
  pull: 'none' | 'delta' | 'full';
  /** Whether the membership diff ran, which `removed_from_list` gates on its own. */
  removalsChecked: boolean;
  /** The diff would have deleted implausibly much, so the next poll pulls whole. */
  refusedRemovals: boolean;
  /** Records the pull added or replaced. */
  updated: number;
  /** Of those, records that arrived new or under a different status — what the feed can see. */
  reshaped: number;
  /** Records the membership diff dropped. */
  removed: number;
}

const quietPoll = (at: string, changed: boolean): PollOutcome => ({
  at,
  changed,
  pull: 'none',
  removalsChecked: false,
  refusedRemovals: false,
  updated: 0,
  reshaped: 0,
  removed: 0,
});

// The poll's consequences, as named questions over one outcome. Each reader
// keys on a different slice — the feed on membership, the movement line on the
// pull, the sync stamp on real movement — and naming them is what keeps five
// overlapping conditions from being five anonymous boolean expressions.

/**
 * Whether anything the feed is built from moved. Deliberately not `updated`:
 * watching an episode rewrites a record the feed cannot see any of, and
 * rendering on it re-joins to the identical event set and rewrites the file
 * for a fresh DTSTAMP and nothing else.
 */
const feedChanged = (poll: PollOutcome): boolean => poll.pull === 'full' || poll.reshaped > 0 || poll.removed > 0;

/**
 * Whether the film list needs re-resolving: a film enters or leaves
 * plan-to-watch by changing status, never by a watch count moving.
 */
const filmsNeedResolving = (poll: PollOutcome): boolean => poll.pull === 'full' || poll.reshaped > 0;

/** Whether the library actually moved — what `librarySyncedAt` means. */
const libraryMoved = (poll: PollOutcome): boolean => poll.updated > 0 || poll.removed > 0;

export interface OrchestratorErrors {
  library: string | null;
  sheet: string | null;
}

export class Orchestrator {
  log: Logger;
  /** The iCal half. Given the library per call; never holds its own copy. */
  feed: Feed;
  /** Null unless a spreadsheet *and* a credential were both supplied. */
  sheetSync: SheetSync | null = null;
  library: Library | null = null;
  /**
   * The three watermarks the poll gates on, all in memory. Nothing here is
   * persisted: `data/` holds the token, the rendered feed and an observational
   * journal, so a restart is a cold start — two library requests, plus one
   * per plan-to-watch film.
   *
   * `syncedAll` is the `activities.all` of the poll whose data is already
   * merged, and is what `date_from` gets, verbatim. It is deliberately not the
   * trigger — see `librarySignature`.
   */
  syncedAll: string | null = null;
  librarySignature = '';
  /**
   * Per category, because which one moved is what tells a truncated membership
   * response from a category the user emptied — see `retainOnly`.
   */
  removalAt: Record<SyncType, string> = { shows: '', anime: '', movies: '' };
  /**
   * Set when a membership response could not be trusted to delete against. The
   * next poll pulls the whole library instead of diffing, because a full pull
   * is authoritative — it answers what was removed rather than inferring it.
   * Without this the refusal would stand until the process restarted, and every
   * poll in between would re-ask the same unanswerable question.
   */
  resyncPending = false;
  libraryAt: string | null = null;
  polledAt: string | null = null;
  /** The two failures this layer owns; `Feed` holds the other two. */
  errors: OrchestratorErrors = { library: null, sheet: null };
  /**
   * Process start, for uptime. Deliberately not used to derive when a timer
   * next fires: that comes from the last run plus the interval, which needs no
   * state and stays right across a skipped tick.
   */
  readonly startedAt = nowIso();
  /**
   * What the last poll did, for the status page. Null until the first
   * successful poll — which is not the same as "nothing moved", and the page
   * says so.
   */
  lastPoll: PollOutcome | null = null;
  /** The last poll that actually moved something, for the status page. */
  lastMovement: LibraryMovement | null = null;
  /**
   * Whether the last sheet sync wants another go. A boolean, not an interval:
   * the sheet has no upstream clock of its own — everything it writes derives
   * from watch state, and the activities gate already detects that. This exists
   * only so a failed write is not stranded until the user next watches
   * something.
   */
  sheetRetryPending = false;
  timers: NodeJS.Timeout[] = [];
  /** Cancels in-flight fetches on stop(). Every source call carries its signal. */
  private aborter = new AbortController();

  constructor({ logger = console as Logger }: { logger?: Logger } = {}) {
    this.log = logger;
    this.feed = new Feed({ logger });
    if (sheetSyncConfigured()) this.sheetSync = new SheetSync({ logger });
  }

  /** The rendered feed. The one thing `server.ts` needs from this layer. */
  get ics(): string {
    return this.feed.ics;
  }

  /**
   * The state both readers project from, assembled here because this is the
   * only object that can see all three subsystems. What it *means* — healthy,
   * restart-worthy — is `health.ts`'s business.
   */
  snapshot(): Snapshot {
    const { feed } = this;
    return {
      startedAt: this.startedAt,
      library: {
        polledAt: this.polledAt,
        syncedAt: this.libraryAt,
        error: this.errors.library,
        counts: libraryCounts(this.library),
        poll: this.lastPoll,
        movement: this.lastMovement,
      },
      feed: {
        events: feed.events.length,
        renderedAt: feed.renderedAt,
        servingCached: feed.servingCached,
        error: feed.errors.render,
        calendars: {
          attemptedAt: feed.calendarsAt,
          freshAt: feed.calendarsFreshAt,
          changedAt: feed.calendarsChangedAt,
          error: feed.errors.calendar,
        },
        films: { resolved: feed.movieReleases.size, resolvedAt: feed.filmsResolvedAt },
      },
      sheet: {
        configured: this.sheetSync !== null,
        status: this.sheetSync?.lastStatus ?? 'idle',
        lastRunAt: this.sheetSync?.lastRunAt ?? null,
        frozen: this.sheetSync?.frozen ?? null,
        error: this.errors.sheet,
      },
    };
  }

  /**
   * Everything boot does after the server is listening: restore what disk
   * holds, run the first poll, and start the timers.
   *
   * Never throws — the server keeps answering `/healthz` so a failure here is
   * visible rather than fatal. Filed as a render failure because that is the
   * slot `ok` keys on, and the next successful render clears it. The timers
   * start in `finally` on purpose: a failed warm-up must still leave something
   * scheduled to retry, rather than serving a boot-time snapshot forever.
   */
  async warmUp(): Promise<void> {
    try {
      await this.hydrate();
      await this.refreshLibraryIfChanged();
      this.log.info(`ready: serving ${this.feed.events.length} events`);
    } catch (err) {
      this.feed.errors.render = `startup: ${errorMessage(err)}`;
      this.log.error(`warm-up failed: ${errorStack(err)}`);
    } finally {
      this.start();
    }
  }

  /**
   * Restore what can be restored from disk: the last rendered feed, and the
   * sheet's run history. Both are what the status page shows before this
   * process has finished its first poll.
   *
   * Each half restores its own — this only says when.
   */
  async hydrate(): Promise<void> {
    await this.sheetSync?.hydrate();
    await this.feed.hydrate({ signal: this.aborter.signal });
  }

  /**
   * The calendar timer's job. Public because a test drives it directly: the
   * ordering below is the whole point and nothing else would catch it changing.
   *
   * `this.library` is read *after* the fetch, never before. The fetch is several
   * MB, the library poll runs on its own timer meanwhile, and this render is
   * queued last — so a library captured before the fetch would overwrite the
   * poll's correct render with a pre-prune one, and stand until the next
   * refresh six hours later.
   */
  async refreshCalendars(): Promise<void> {
    await this.feed.refreshCalendars({ signal: this.aborter.signal });
    await this.feed.render(this.library);
  }

  /**
   * The library timer's job: one cheap request decides whether the library call
   * is worth making, and a second one asks only for what changed.
   *
   * A quiet poll is one request; a poll where something moved is two; one where
   * something was also removed is three. The signature covers only the
   * timestamps that can move an item — see `librarySignature` in library.ts.
   */
  async refreshLibraryIfChanged({ force = false }: { force?: boolean } = {}): Promise<void> {
    const { signal } = this.aborter;
    // Whether anything the feed is built from moved. Declared out here because
    // the render below sits outside the try, and a failed poll must not claim it.
    let shouldRender = false;
    try {
      // Inside the try: readToken only swallows ENOENT, so an unreadable
      // token.json must degrade the feed rather than escape to the timer.
      const token = await readToken();
      if (!token) {
        this.errors.library = 'no token — run `npm run login`';
        this.log.error(this.errors.library);
        return;
      }

      const activities = await getActivities(token, { signal });
      this.polledAt = nowIso();
      // The poll itself succeeded, so any earlier failure is now history.
      this.errors.library = null;

      const gate = evaluateGate(
        activities,
        {
          librarySignature: this.librarySignature,
          removalAt: this.removalAt,
          syncedAll: this.syncedAll,
          hasLibrary: this.library !== null,
          resyncPending: this.resyncPending,
        },
        { force },
      );
      // Film dates move on their own schedule, so a poll with no library change
      // still has work to do when one comes into range. Read once: the second
      // read would come after `resolveFilms` had stamped the ids it asked about.
      const filmsDue = force || this.feed.filmsDue(this.library);

      // The retry term is a boolean, and false when the sync is unconfigured,
      // so a quiet poll still makes exactly one request.
      if (!gate.full && !gate.changed && !gate.removals && !filmsDue && !this.sheetRetryPending) {
        // Recorded even so: nothing moving is the healthy steady state, and a
        // page that could only ever show a gate where something moved would be
        // exactly backwards.
        this.lastPoll = quietPoll(this.polledAt, gate.changed);
        return;
      }

      const poll = await this.pull(token, activities, gate, signal);
      this.lastPoll = poll;

      shouldRender = feedChanged(poll) || filmsDue;
      if (filmsNeedResolving(poll) || filmsDue) {
        // A failed lookup needs no flag: it does not refresh that film's stamp,
        // so `filmsDue` is already true on the next poll for exactly the films
        // that failed.
        const complete = await this.feed.resolveFilms(this.library, { signal });
        if (!complete) this.log.warn('some film lookups failed; will retry on the next poll');
      }
      // Only when the library actually moved. A poll that fell through purely
      // to retry the sheet would otherwise report librarySyncedAt as now, which
      // contradicts what that field means.
      if (libraryMoved(poll)) this.libraryAt = poll.at;
    } catch (err) {
      // Shutdown is not a failure: `stop()` aborts every in-flight fetch, and
      // reporting that as a library error is the last thing written to the log.
      if (err instanceof Error && err.name === 'AbortError') return;
      // A revoked token must not empty the feed — keep serving the last render.
      this.errors.library = errorMessage(err);
      this.log.error(
        err instanceof SimklAuthError
          ? // A burst of uncached sync calls is answered with 401 user_token_failed
            // rather than a 429, so this looks like a dead token and is usually a
            // rate limit that clears on its own. Re-authorising fixes nothing the
            // wait would not, so waiting is the advice.
            'SIMKL rejected the token. Usually a rate limit on uncached sync calls rather than a dead token — it clears by itself, so wait a few polls before re-running `npm run login -- --force`. Serving the last good feed.'
          : `library refresh failed: ${errorMessage(err)}`,
      );
    }

    // Only when something the feed is built from actually moved. A poll that
    // fell through purely to retry the sheet would otherwise re-join, re-render
    // and rewrite an identical feed to disk; the calendar timer still renders
    // on its own schedule, so nothing goes stale.
    if (shouldRender) await this.feed.render(this.library);
    // The sheet is built entirely from the library, so if the library refresh
    // threw there is nothing new for the sync to see — and running it anyway
    // means a full grid read and re-plan on every poll of a SIMKL outage, plus
    // a REFUSED line in the log for each one.
    if (!this.errors.library) await this.syncSheet();
  }

  /**
   * Pull what the gate decided is worth pulling — the whole library, a delta,
   * or nothing but the removal diff — and fold it in. Returns the complete
   * outcome; every watermark it holds advances only once the call that
   * consumed it has returned, because advancing before would skip the change
   * permanently.
   */
  private async pull(token: string, activities: Activities, gate: GateDecision, signal: AbortSignal): Promise<PollOutcome> {
    // Taken before the pull replaces the library, and null when there was no
    // library to move: a first load is not movement, and a cold start would
    // otherwise report every count arriving from zero — true, and saying
    // nothing. `libraryCounts` is memoised on the library's identity, so this
    // is a lookup rather than a walk.
    const before = this.library && libraryCounts(this.library);
    const poll = quietPoll(nowIso(), gate.changed);

    if (gate.full) {
      this.log.info('pulling the whole library');
      this.library = toLibrary(await fetchAllItems(token, { signal }));
      poll.pull = 'full';
      poll.updated = this.library.size;
      // A full pull *is* the membership set, so removals need no second call
      // — and it is the answer to a refused diff, so the debt clears here.
      this.removalAt = gate.stamps;
      this.resyncPending = false;
      // Never back to null. `full` is partly `!this.syncedAll`, so a null
      // watermark makes the next poll full too, and the one after that — the
      // whole library every half hour, which is the burst SIMKL answers with
      // `401 user_token_failed`. The clock is the last resort and only
      // reachable on an account with no activity of any kind, where an empty
      // library means there is nothing for a slightly wrong instant to miss.
      this.syncedAll = watermarkOf(activities) ?? this.syncedAll ?? nowIso();
      this.librarySignature = gate.signature;
    } else if (gate.changed) {
      // A second behind the watermark, because `date_from` is compared
      // strictly greater at one-second granularity: a change written in the
      // same second as `activities.all` but committed after this poll read it
      // would otherwise never be asked for again. The merge is an idempotent
      // upsert, so the overlap costs a re-sent record and nothing else.
      const dateFrom = deltaFrom(this.syncedAll);
      const merged = mergeDelta(this.library!, await fetchAllItems(token, { dateFrom, signal }));
      this.library = merged.library;
      poll.pull = 'delta';
      poll.updated = merged.updated;
      poll.reshaped = merged.reshaped;
      this.log.info(`${merged.updated} ${merged.updated === 1 ? 'record' : 'records'} changed since ${dateFrom}`);
      this.syncedAll = watermarkOf(activities) ?? this.syncedAll;
      this.librarySignature = gate.signature;
    }

    // After the delta, never before: the membership response is then the
    // fresher of the two, so a title added between the calls survives and one
    // removed between them goes.
    if (gate.removals && !gate.full) {
      poll.removalsChecked = true;
      const keep = membershipIds(await fetchMembership(token, { signal }));
      const diff = retainOnly(this.library!, keep, gate.removedFrom);
      this.library = diff.library;
      poll.removed = diff.removed;
      if (!diff.applied) {
        // Answered by pulling whole rather than by asking again: the response
        // is genuinely ambiguous — a category the user emptied and one the
        // payload lost look the same — and only the full library settles it.
        poll.refusedRemovals = true;
        this.resyncPending = true;
        this.log.warn('membership response would drop most of a category; re-pulling the whole library next poll');
      } else {
        this.removalAt = gate.stamps;
        if (diff.removed) {
          this.log.info(`${diff.removed} ${diff.removed === 1 ? 'title' : 'titles'} removed from the library`);
        }
      }
    }

    // An empty full pull is still a poll that pulled, so it records a movement
    // of nothing — the page's line then says what happened rather than holding
    // a stale one.
    if (poll.pull === 'full' || libraryMoved(poll)) {
      const deltas = before === null ? [] : countDeltas(before, libraryCounts(this.library));
      this.lastMovement = { at: poll.at, deltas, updated: poll.updated, removed: poll.removed };
    }
    return poll;
  }

  /**
   * The sheet write, after the render and outside the library `try`.
   *
   * Outside, so a Sheets failure is never filed as `errors.library`, never
   * touches the watermarks, and never holds the feed up. After, so the feed —
   * which is the service's actual job — is already out before a spreadsheet is
   * touched.
   */
  private async syncSheet(): Promise<void> {
    if (!this.sheetSync || !this.library) return;
    const result = await this.sheetSync.run(this.library, { signal: this.aborter.signal });
    this.errors.sheet = result.error;
    this.sheetRetryPending = result.retry;
  }

  /**
   * Run `job` on an interval, skipping a tick while the previous one is still
   * going. setInterval does not wait, and a refresh slower than its own period
   * would interleave writes to `library` and the three watermarks here, and to
   * `movieReleases` and `filmStamps` on the feed — a cross-object invariant now,
   * held by the fact that the library timer is the sole writer of all of them.
   */
  private schedule(name: string, job: () => Promise<void>, every: Temporal.Duration): void {
    let running = false;
    // `setInterval` takes a number; this is the boundary the span crosses.
    const timer = setInterval(() => {
      if (running) {
        this.log.warn(`${name} is still running from the last tick; skipping this one`);
        return;
      }
      running = true;
      void job()
        .catch((err: unknown) => this.log.error(`unexpected refresh failure: ${errorMessage(err)}`))
        .finally(() => {
          running = false;
        });
    }, every.total('milliseconds'));
    timer.unref?.();
    this.timers.push(timer);
  }

  start(): void {
    // A fresh controller per start: `stop()` aborts the old one, and an aborted
    // signal never resets, so reusing it makes every later fetch fail instantly
    // with the failure filed as a library error.
    if (this.aborter.signal.aborted) this.aborter = new AbortController();
    this.schedule('calendar refresh', () => this.refreshCalendars(), config.calendarRefresh);
    this.schedule('library poll', () => this.refreshLibraryIfChanged(), config.activitiesPoll);
  }

  /**
   * Stop refreshing and cancel anything in flight — a calendar refresh can be
   * several MB into a fetch, and shutdown should not wait for it.
   *
   * The abort reaches fetches, not the render chain: a render already queued on
   * `Feed` still runs and still writes the feed to disk. Harmless, since the
   * process is going away and the write is atomic, but it is not cancellation.
   */
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.aborter.abort();
  }
}
