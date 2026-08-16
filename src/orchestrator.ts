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
import { buildHealth, type Health } from './health.ts';
import { errorMessage } from './shared/errors.ts';
import type { Logger } from './shared/logger.ts';
import { fetchAllItems, fetchMembership, getActivities } from './api/simkl/lists.ts';
import { deltaFrom, evaluateGate, membershipIds, mergeDelta, retainOnly, toLibrary } from './library.ts';
import { readToken } from './api/simkl/auth.ts';
import { SimklAuthError } from './api/simkl/client.ts';
import type { SyncType } from './api/simkl/types.ts';
import type { Library } from './library.ts';
import { Feed } from './feed/feed.ts';
import { SheetSync } from './sheet/sync.ts';

/** What one activities gate decided. */
export interface GateOutcome {
  /** The status signature differed — what the gate itself said. */
  changed: boolean;
  /** What was actually pulled. Wider than `changed` on a cold or forced poll. */
  pull: 'none' | 'delta' | 'full';
  /** Whether the membership diff ran, which `removed_from_list` gates on its own. */
  removals: boolean;
  /** Records the pull added or replaced. */
  updated: number;
  /** Records the membership diff dropped. */
  removed: number;
}

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
  readonly startedAt = new Date().toISOString();
  /**
   * What the last activities gate decided, for the status page. Null until the
   * first successful poll — which is not the same as "nothing moved", and the
   * page says so.
   */
  lastGate: GateOutcome | null = null;
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
   * The state both readers project from. Assembled here because this is the
   * only object that can see all three subsystems; what it *means* is
   * `buildHealth`'s business.
   */
  get health(): Health {
    const { feed } = this;
    return buildHealth({
      polledAt: this.polledAt,
      libraryAt: this.libraryAt,
      libraryError: this.errors.library,

      events: feed.events.length,
      renderedAt: feed.renderedAt,
      servingCached: feed.servingCached,
      renderError: feed.errors.render,
      calendarsAt: feed.calendarsAt,
      calendarsFreshAt: feed.calendarsFreshAt,
      calendarError: feed.errors.calendar,

      sheetConfigured: this.sheetSync !== null,
      sheetStatus: this.sheetSync?.lastStatus ?? 'idle',
      sheetLastRunAt: this.sheetSync?.lastRunAt ?? null,
      sheetFrozen: Boolean(this.sheetSync?.frozen),
      sheetError: this.errors.sheet,
    });
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
    await this.feed.hydrate(this.library, { signal: this.aborter.signal });
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
    await this.feed.safeRender(this.library);
  }

  /**
   * One cheap request decides whether the library call is worth making, and a
   * second one asks only for what changed.
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
      this.polledAt = new Date().toISOString();
      // The poll itself succeeded, so any earlier failure is now history.
      this.errors.library = null;

      const { changed, removals, removedFrom, full, signature, stamps } = evaluateGate(
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

      // Above the early return below, which a quiet poll takes. Recorded after
      // it, the page could only ever show a gate where something moved — exactly
      // backwards, since nothing moving is the healthy steady state. The counts
      // are written into it where they are produced, so there is one gate object
      // and no second literal to keep in step with this one.
      const gate: GateOutcome = { changed, pull: full ? 'full' : changed ? 'delta' : 'none', removals, updated: 0, removed: 0 };
      this.lastGate = gate;
      // Records that arrived new or under a different status, as opposed to
      // every record the delta carried. The feed reads membership and nothing
      // else, so this is what tells it whether there is anything to re-render —
      // and marking an episode watched moves `updated` without moving this.
      let reshaped = 0;
      let pulled = false;
      // The retry term is a boolean, and false when the sync is unconfigured,
      // so a quiet poll still makes exactly one request.
      if (!full && !changed && !removals && !filmsDue && !this.sheetRetryPending) return;

      // Each watermark advances only once the call that consumed it has
      // returned. Advancing before would skip the change permanently, since
      // nothing else will ever report it again.
      //
      // Both branches *reassign* `this.library`, so every read of it below must
      // stay where it is. Hoisting one to the top of the method would hand the
      // feed the pre-pull library: a feed one poll behind, intermittently, and
      // only when something moved.
      if (full) {
        this.log.info('pulling the whole library');
        this.library = toLibrary(await fetchAllItems(token, { signal }));
        gate.updated = this.library.size;
        // Not the size: a genuinely empty library is still a pull that
        // succeeded, and leaving it unrendered means `renderedAt` stays null
        // and the container reports unhealthy until the six-hour calendar
        // timer renders on its own.
        pulled = true;
        // A full pull *is* the membership set, so removals need no second call
        // — and it is the answer to a refused diff, so the debt clears here.
        this.removalAt = stamps;
        this.resyncPending = false;
        // Never back to null. `full` is partly `!this.syncedAll`, so a null
        // watermark makes the next poll full too, and the one after that —
        // the whole library every half hour, which is the burst SIMKL answers
        // with `401 user_token_failed`. A local stamp is safe because the
        // delta asks from a second behind it.
        this.syncedAll = activities.all ?? this.syncedAll ?? new Date().toISOString();
        this.librarySignature = signature;
      } else if (changed) {
        // A second behind the watermark, because `date_from` is compared
        // strictly greater at one-second granularity: a change written in the
        // same second as `activities.all` but committed after this poll read it
        // would otherwise never be asked for again. The merge is an idempotent
        // upsert, so the overlap costs a re-sent record and nothing else.
        const dateFrom = deltaFrom(this.syncedAll);
        ({ library: this.library, updated: gate.updated, reshaped } = mergeDelta(
          this.library!,
          await fetchAllItems(token, { dateFrom, signal }),
        ));
        this.log.info(`${gate.updated} ${gate.updated === 1 ? 'record' : 'records'} changed since ${dateFrom}`);
        this.syncedAll = activities.all ?? this.syncedAll;
        this.librarySignature = signature;
      }

      // After the delta, never before: the membership response is then the
      // fresher of the two, so a title added between the calls survives and one
      // removed between them goes.
      if (removals && !full) {
        const keep = membershipIds(await fetchMembership(token, { signal }));
        const diff = retainOnly(this.library!, keep, removedFrom);
        this.library = diff.library;
        gate.removed = diff.removed;
        if (!diff.applied) {
          // Answered by pulling whole rather than by asking again: the response
          // is genuinely ambiguous — a category the user emptied and one the
          // payload lost look the same — and only the full library settles it.
          this.resyncPending = true;
          this.log.warn('membership response would drop most of a category; re-pulling the whole library next poll');
        } else {
          this.removalAt = stamps;
          if (diff.removed) {
            this.log.info(`${diff.removed} ${diff.removed === 1 ? 'title' : 'titles'} removed from the library`);
          }
        }
      }

      // Deliberately not `gate.updated`: watching an episode rewrites a record
      // the feed cannot see any of, so rendering on it re-joins to the identical
      // event set and rewrites the file for a fresh DTSTAMP and nothing else.
      shouldRender = pulled || reshaped > 0 || gate.removed > 0 || filmsDue;

      // Re-read when the film list changed, and otherwise when one comes into
      // range. Marking an episode watched must not drag every film lookup along.
      //
      // A failed lookup needs no flag here: it does not refresh that film's
      // stamp, so `filmsDue` is already true on the next poll for exactly the
      // films that failed.
      // Same reasoning: a film enters or leaves plan-to-watch by changing
      // status, never by a watch count moving.
      if (pulled || reshaped > 0 || filmsDue) {
        const complete = await this.feed.resolveFilms(this.library, { signal });
        if (!complete) this.log.warn('some film lookups failed; will retry on the next poll');
      }
      // Only when the library actually moved. A poll that fell through purely
      // to retry the sheet would otherwise report librarySyncedAt as now, which
      // contradicts what that field means.
      if (gate.updated > 0 || gate.removed > 0) this.libraryAt = new Date().toISOString();
    } catch (err) {
      // Shutdown is not a failure: `stop()` aborts every in-flight fetch, and
      // reporting that as a library error is the last thing written to the log.
      if (err instanceof Error && err.name === 'AbortError') return;
      // A revoked token must not empty the feed — keep serving the last render.
      const prefix = err instanceof SimklAuthError ? 'AUTH' : 'library';
      this.errors.library = `${prefix}: ${errorMessage(err)}`;
      this.log.error(
        err instanceof SimklAuthError
          // A burst of uncached sync calls is answered with 401 user_token_failed
          // rather than a 429, so this looks like a dead token and is usually a
          // rate limit that clears on its own. Re-authorising fixes nothing the
          // wait would not, so waiting is the advice.
          ? 'SIMKL rejected the token. Usually a rate limit on uncached sync calls rather than a dead token — it clears by itself, so wait a few polls before re-running `npm run login -- --force`. Serving the last good feed.'
          : `library refresh failed: ${errorMessage(err)}`,
      );
    }

    // Only when something the feed is built from actually moved. A poll that
    // fell through purely to retry the sheet would otherwise re-join, re-render
    // and rewrite an identical feed to disk; the calendar timer still renders
    // on its own schedule, so nothing goes stale.
    if (shouldRender) await this.feed.safeRender(this.library);
    // The sheet is built entirely from the library, so if the library refresh
    // threw there is nothing new for the sync to see — and running it anyway
    // means a full grid read and re-plan on every poll of a SIMKL outage, plus
    // a REFUSED line in the log for each one.
    if (!this.errors.library) await this.syncSheet();
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
  private schedule(name: string, job: () => Promise<void>, everyMs: number): void {
    let running = false;
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
    }, everyMs);
    timer.unref?.();
    this.timers.push(timer);
  }

  start(): void {
    // A fresh controller per start: `stop()` aborts the old one, and an aborted
    // signal never resets, so reusing it makes every later fetch fail instantly
    // with the failure filed as a library error.
    if (this.aborter.signal.aborted) this.aborter = new AbortController();
    this.schedule('calendar refresh', () => this.refreshCalendars(), config.calendarRefreshMs);
    this.schedule('library poll', () => this.refreshLibraryIfChanged(), config.activitiesPollMs);
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
