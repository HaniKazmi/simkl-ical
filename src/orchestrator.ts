/**
 * The running service: one poll driving two consumers.
 *
 * Owns the SIMKL library — the input both halves share — plus the timers, the
 * abort controller and `/healthz`. `Feed` and `SheetSync` know nothing of each
 * other; this file is the only thing that knows both.
 *
 * **Requests never trigger a fetch**: a client polling hard cannot amplify
 * into SIMKL traffic, and a SIMKL outage degrades to a stale feed, not an
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
 * The service's state as one plain value: what `/healthz` assesses and the
 * status page renders. `Orchestrator.snapshot()` is the one export of state,
 * so a new field is added in exactly one place.
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

/**
 * The poll that last moved the library, kept whole, plus how the counts moved.
 *
 * A quiet poll does not reset it: the last real movement tells a reader more
 * than a line that blanks every half hour. It carries the whole `PollOutcome`
 * rather than naming the fields it wants, so `pull` and `reshaped` are there
 * for the asking and there is no hand-written copy to drift.
 */
export type LibraryMovement = PollOutcome & {
  /** Only the counts that moved. Empty when a poll changed progress and nothing else. */
  deltas: CountDelta[];
};

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
// pull, the sync stamp on real movement.

/**
 * Whether anything the feed is built from moved. Not `updated`: watching an
 * episode rewrites a record the feed cannot see any of, and rendering on it
 * rewrites the file for a fresh DTSTAMP and nothing else.
 */
export const feedChanged = (poll: PollOutcome): boolean => poll.pull === 'full' || poll.reshaped > 0 || poll.removed > 0;

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
   * The three watermarks the poll gates on, all in memory. `data/` holds only
   * the token, the rendered feed and an observational journal, so a restart is
   * a cold start — two library requests, plus one per plan-to-watch film.
   *
   * `syncedAll` is the `activities.all` of the poll already merged, and goes
   * out as `date_from` verbatim. It is not the trigger — see
   * `librarySignature`.
   */
  syncedAll: string | null = null;
  librarySignature = '';
  /**
   * Per category: which one moved is what tells a truncated membership
   * response from a category the user emptied — see `retainOnly`.
   */
  removalAt: Record<SyncType, string> = { shows: '', anime: '', movies: '' };
  /**
   * Set when a membership response could not be trusted to delete against.
   * The next poll pulls the whole library: a full pull answers what was
   * removed rather than inferring it. Without this the refusal would stand
   * until restart, re-asking the same unanswerable question every poll.
   */
  resyncPending = false;
  libraryAt: string | null = null;
  polledAt: string | null = null;
  /** The two failures this layer owns; `Feed` holds the other two. */
  errors: OrchestratorErrors = { library: null, sheet: null };
  /**
   * Process start, for uptime. Not used to derive when a timer next fires:
   * that is the last run plus the interval, which stays right across a
   * skipped tick.
   */
  readonly startedAt = nowIso();
  /**
   * What the last poll did, for the status page. Null until the first
   * successful poll — not the same as "nothing moved", and the page says so.
   */
  lastPoll: PollOutcome | null = null;
  /** The last poll that actually moved something, for the status page. */
  lastMovement: LibraryMovement | null = null;
  /**
   * Whether the last sheet sync wants another go. A boolean, not an interval:
   * everything the sheet writes derives from watch state, which the
   * activities gate already detects. This only stops a failed write being
   * stranded until the user next watches something.
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
   * Assembled here because only this object sees all three subsystems. What
   * it *means* — healthy, restart-worthy — is `health.ts`'s business.
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
   * Everything boot does after the server is listening: restore from disk,
   * run the first poll, start the timers.
   *
   * Never throws — the server keeps answering `/healthz`, so a failure here
   * is visible rather than fatal. Filed as a render failure because that is
   * the slot `ok` keys on; the next successful render clears it. Timers start
   * in `finally` so a failed warm-up still leaves a retry scheduled instead
   * of serving a boot-time snapshot forever.
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
   * Restore from disk: the last rendered feed and the sheet's run history —
   * what the status page shows before the first poll finishes. Each half
   * restores its own; this only says when.
   */
  async hydrate(): Promise<void> {
    await this.sheetSync?.hydrate();
    await this.feed.hydrate({ signal: this.aborter.signal });
  }

  /**
   * The calendar timer's job. Public because a test drives it directly: the
   * ordering below is the point.
   *
   * `this.library` is read *after* the fetch, never before. The fetch is
   * several MB and the library poll runs meanwhile, so a library captured
   * before it would overwrite the poll's correct render with a pre-prune one,
   * standing until the next refresh six hours later.
   */
  async refreshCalendars(): Promise<void> {
    await this.feed.refreshCalendars({ signal: this.aborter.signal });
    await this.feed.render(this.library);
  }

  /**
   * The library timer's job: one cheap request decides whether the library
   * call is worth making; a second asks only for what changed.
   *
   * A quiet poll is one request; movement is two; a removal is three. The
   * signature covers only the timestamps that can move an item — see
   * `librarySignature` in library.ts.
   */
  async refreshLibraryIfChanged({ force = false }: { force?: boolean } = {}): Promise<void> {
    const { signal } = this.aborter;
    // Declared out here because the render below sits outside the try, and a
    // failed poll must not claim it.
    let shouldRender = false;
    try {
      // readToken only swallows ENOENT, so an unreadable token.json must
      // degrade the feed rather than escape to the timer.
      const token = await readToken();
      if (!token) {
        this.errors.library = 'no token — run `npm run login`';
        this.log.error(this.errors.library);
        return;
      }

      const activities = await getActivities(token, { signal });
      this.polledAt = nowIso();
      // The poll succeeded, so any earlier failure no longer applies.
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
      // Film dates move on their own schedule, so a poll with no library
      // change still has work when one comes into range. Read once: a second
      // read would come after `resolveFilms` stamped the ids it asked about.
      const filmsDue = force || this.feed.filmsDue(this.library);

      // The retry term is false when the sync is unconfigured, so a quiet
      // poll still makes exactly one request.
      if (!gate.full && !gate.changed && !gate.removals && !filmsDue && !this.sheetRetryPending) {
        // Recorded even so: nothing moving is the healthy steady state, and
        // the page should be able to show it.
        this.lastPoll = quietPoll(this.polledAt, gate.changed);
        return;
      }

      const poll = await this.pull(token, activities, gate, signal);
      this.lastPoll = poll;

      shouldRender = feedChanged(poll) || filmsDue;
      if (filmsNeedResolving(poll) || filmsDue) {
        // A failed lookup needs no flag: it leaves that film's stamp alone,
        // so `filmsDue` is already true next poll for exactly the films that
        // failed.
        const complete = await this.feed.resolveFilms(this.library, { signal });
        if (!complete) this.log.warn('some film lookups failed; will retry on the next poll');
      }
      // Only when the library moved: a poll that ran purely to retry the
      // sheet must not report librarySyncedAt as now.
      if (libraryMoved(poll)) this.libraryAt = poll.at;
    } catch (err) {
      // Shutdown is not a failure: `stop()` aborts every in-flight fetch, and
      // filing that as a library error would be the log's last line.
      if (err instanceof Error && err.name === 'AbortError') return;
      // A revoked token must not empty the feed — keep serving the last render.
      this.errors.library = errorMessage(err);
      this.log.error(
        err instanceof SimklAuthError
          ? // A burst of uncached sync calls gets 401 user_token_failed, not a
            // 429 — it looks like a dead token but is usually a rate limit that
            // clears on its own, so waiting is the advice.
            'SIMKL rejected the token. Usually a rate limit on uncached sync calls rather than a dead token — it clears by itself, so wait a few polls before re-running `npm run login -- --force`. Serving the last good feed.'
          : `library refresh failed: ${errorMessage(err)}`,
      );
    }

    // Only when the feed's inputs moved: a sheet-retry poll would otherwise
    // rewrite an identical feed to disk. The calendar timer still renders on
    // its own schedule, so nothing goes stale.
    if (shouldRender) await this.feed.render(this.library);
    // The sheet derives entirely from the library, so a failed refresh gives
    // the sync nothing new — running anyway means a full grid read, a re-plan
    // and a REFUSED log line on every poll of a SIMKL outage.
    if (!this.errors.library) await this.syncSheet();
  }

  /**
   * Pull what the gate decided — the whole library, a delta, or just the
   * removal diff — and fold it in. Every watermark advances only after the
   * call that consumed it returns; advancing before would skip the change
   * permanently.
   */
  private async pull(token: string, activities: Activities, gate: GateDecision, signal: AbortSignal): Promise<PollOutcome> {
    // Taken before the pull replaces the library; null when there was none —
    // a first load is not movement, and reporting every count arriving from
    // zero says nothing. `libraryCounts` is memoised on the library's
    // identity, so this is a lookup, not a walk.
    const before = this.library && libraryCounts(this.library);
    const poll = quietPoll(nowIso(), gate.changed);

    if (gate.full) {
      this.log.info('pulling the whole library');
      this.library = toLibrary(await fetchAllItems(token, { signal }));
      poll.pull = 'full';
      poll.updated = this.library.size;
      // A full pull *is* the membership set, so removals need no second call
      // — and it answers a refused diff, so the debt clears here.
      this.removalAt = gate.stamps;
      this.resyncPending = false;
      // Never back to null. `full` is partly `!this.syncedAll`, so a null
      // watermark makes every following poll full — the whole library every
      // half hour, the burst SIMKL answers with `401 user_token_failed`. The
      // clock is the last resort, reachable only on an account with no
      // activity at all, where an empty library means a slightly wrong
      // instant misses nothing.
      this.syncedAll = watermarkOf(activities) ?? this.syncedAll ?? nowIso();
      this.librarySignature = gate.signature;
    } else if (gate.changed) {
      // A second behind the watermark: `date_from` is compared strictly
      // greater at one-second granularity, so a change committed in the same
      // second as `activities.all` would otherwise never be asked for again.
      // The merge is an idempotent upsert, so the overlap costs one re-sent
      // record.
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
    // removed goes.
    if (gate.removals && !gate.full) {
      poll.removalsChecked = true;
      const keep = membershipIds(await fetchMembership(token, { signal }));
      const diff = retainOnly(this.library!, keep, gate.removedFrom);
      this.library = diff.library;
      poll.removed = diff.removed;
      if (!diff.applied) {
        // Answered by pulling whole rather than re-asking: a category the
        // user emptied and one the payload lost look the same, and only the
        // full library settles it.
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

    // An empty full pull still records a movement of nothing, so the page's
    // line says what happened rather than holding a stale one.
    if (poll.pull === 'full' || libraryMoved(poll)) {
      const deltas = before === null ? [] : countDeltas(before, libraryCounts(this.library));
      this.lastMovement = { ...poll, deltas };
    }
    return poll;
  }

  /**
   * The sheet write, after the render and outside the library `try`: a
   * Sheets failure is never filed as `errors.library` and never touches the
   * watermarks, and the feed — the service's actual job — is out before a
   * spreadsheet is touched.
   */
  private async syncSheet(): Promise<void> {
    if (!this.sheetSync || !this.library) return;
    const result = await this.sheetSync.run(this.library, { signal: this.aborter.signal });
    this.errors.sheet = result.error;
    this.sheetRetryPending = result.retry;
  }

  /**
   * Run `job` on an interval, skipping a tick while the previous one is still
   * going. setInterval does not wait, and a refresh slower than its period
   * would interleave writes to `library`, the three watermarks, and the
   * feed's `movieReleases` and `filmStamps` — the library timer being their
   * sole writer is what holds that invariant.
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
    // A fresh controller per start: an aborted signal never resets, so
    // reusing it makes every later fetch fail instantly, filed as a library
    // error.
    if (this.aborter.signal.aborted) this.aborter = new AbortController();
    this.schedule('calendar refresh', () => this.refreshCalendars(), config.calendarRefresh);
    this.schedule('library poll', () => this.refreshLibraryIfChanged(), config.activitiesPoll);
  }

  /**
   * Stop refreshing and cancel anything in flight — a calendar refresh can be
   * several MB into a fetch, and shutdown should not wait for it.
   *
   * The abort reaches fetches, not the render chain: a render queued on
   * `Feed` still runs and writes to disk. Harmless — the write is atomic —
   * but not cancellation.
   */
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.aborter.abort();
  }
}
