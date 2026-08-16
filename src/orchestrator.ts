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
import { ageOf } from './shared/dates.ts';
import { errorMessage } from './shared/errors.ts';
import type { Logger } from './shared/logger.ts';
import { fetchLists, getActivities } from './api/simkl/lists.ts';
import { listSignatures, pruneSuperseded, staleLists, LISTS } from './library.ts';
import { readToken } from './api/simkl/auth.ts';
import { SimklAuthError } from './api/simkl/client.ts';
import type { Library } from './api/simkl/types.ts';
import { Feed } from './feed/feed.ts';
import { SheetSync, type SheetSyncStatus } from './sheet/sync.ts';

/**
 * One block per subsystem, each carrying its own timestamps **and its own
 * error**, so the error sits beside the thing it is about rather than in a
 * parallel bag you correlate by eye. The shape mirrors who owns what: `feed`
 * comes from `Feed`, `library` from here, `sheet` from `SheetSync`.
 */
export interface Health {
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
  /** The last time a list actually moved. Days old on a correct, quiet system. */
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
  listSignatures: Record<string, string> = {};
  libraryAt: string | null = null;
  polledAt: string | null = null;
  /** The two failures this layer owns; `Feed` holds the other two. */
  errors: OrchestratorErrors = { library: null, sheet: null };
  /**
   * Whether the last sheet sync wants another go. A boolean, not an interval:
   * the sheet has no upstream clock of its own — everything it writes derives
   * from watch state, and `staleLists` already detects that. This exists only
   * so a failed write is not stranded until the user next watches something.
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
   * Healthy means rendered recently, rendering successfully, and still hearing
   * from both SIMKL and the CDN.
   *
   * `libraryAt` is deliberately not consulted: with per-list gating it only
   * advances when something changes, so it can be days old on a correct system.
   * `polledAt` tracks the activities call, which is what stops when a token is
   * revoked.
   */
  get health(): Health {
    const { feed } = this;
    const stalePoll = ageOf(this.polledAt) > config.activitiesPollMs * 3;
    const staleCalendars = ageOf(feed.calendarsFreshAt) > config.calendarRefreshMs * 3;
    // A render happens on every calendar refresh, so an old renderedAt means
    // rendering has stopped even when nothing reported an error.
    const staleRender = ageOf(feed.renderedAt) > config.calendarRefreshMs * 3;

    // Worst first. Each subsystem contributes at most one line: its own error
    // if it has one, otherwise its staleness — an error like "serving cached
    // calendars since X" already says the CDN is quiet, so emitting both would
    // just say it twice. Library outranks calendars because a stale calendar
    // still renders and a revoked token eventually will not.
    const problems = [
      this.errors.library ?? (stalePoll ? `SIMKL has not been polled since ${this.polledAt ?? 'startup'}` : null),
      feed.errors.calendar ?? (staleCalendars ? `the CDN has not answered since ${feed.calendarsFreshAt ?? 'startup'}` : null),
      feed.errors.render ??
        (feed.renderedAt === null ? 'nothing has been rendered yet' : staleRender ? `nothing has rendered since ${feed.renderedAt}` : null),
    ].filter((p) => p !== null);

    return {
      ok: feed.renderedAt !== null && !stalePoll && !staleCalendars && !staleRender && !feed.errors.render,
      timezone: config.timezone,
      problems,
      library: { polledAt: this.polledAt, syncedAt: this.libraryAt, error: this.errors.library },
      feed: {
        events: feed.events.length,
        renderedAt: feed.renderedAt,
        servingCached: feed.servingCached,
        error: feed.errors.render,
        calendars: { attemptedAt: feed.calendarsAt, freshAt: feed.calendarsFreshAt, error: feed.errors.calendar },
      },
      // Reported but deliberately excluded from `ok` and from `problems`:
      // /healthz is the container healthcheck and the CI smoke test, and a
      // frozen sheet sync must not restart the container or fail a deploy.
      sheet: {
        configured: this.sheetSync !== null,
        mode: config.sheetSyncMode,
        status: this.sheetSync?.lastStatus ?? 'idle',
        lastRunAt: this.sheetSync?.lastRunAt ?? null,
        frozen: Boolean(this.sheetSync?.frozen),
        error: this.errors.sheet,
      },
    };
  }

  hydrate(): Promise<void> {
    return this.feed.hydrate(this.library, { signal: this.aborter.signal });
  }

  private refreshCalendars(): Promise<void> {
    return this.feed.refreshCalendars(this.library, { signal: this.aborter.signal });
  }

  /**
   * One cheap request decides whether the library calls are worth making.
   * The signature covers only the timestamps that can move an item between
   * lists — see listSignature in library.ts.
   */
  async refreshLibraryIfChanged({ force = false }: { force?: boolean } = {}): Promise<void> {
    const { signal } = this.aborter;
    // Whether anything the feed is built from moved. Declared out here because
    // the render below sits outside the try, and a failed poll must not claim it.
    let refetched = false;
    let libraryFailed = false;
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

      const stale = force || !this.library ? LISTS : staleLists(activities, this.listSignatures);
      // Film dates age out on their own schedule, so a poll with no list
      // changes still has work to do once a day. Read once: the second read
      // would come after `resolveFilms` had stamped `filmsResolvedAt`.
      const filmsDue = force || this.feed.filmsDue();
      // The retry term is a boolean, and false when the sync is unconfigured,
      // so a quiet poll still makes exactly one request.
      if (!stale.length && !filmsDue && !this.sheetRetryPending) return;
      refetched = stale.length > 0 || filmsDue;

      if (stale.length) {
        this.log.info(`refetching ${stale.length}/${LISTS.length} lists: ${stale.map((l) => l.key).join(', ')}`);
        const library: Library = this.library ?? {};
        Object.assign(library, await fetchLists(token, stale, { signal }));
        // Which lists are fresh is known here and nowhere else, and it is the
        // only thing that can tell a stale copy of a moved title from the
        // current one — see pruneSuperseded.
        //
        // This *reassigns* `this.library`, so every read of it below must stay
        // where it is. Hoisting one to the top of the method would hand the feed
        // the pre-fetch library: a feed one poll behind, intermittently, and
        // only when a list moved.
        this.library = pruneSuperseded(library, stale);
      }

      // Re-read when the film list changed, and otherwise once a day. Marking
      // an episode watched must not drag eleven film lookups along with it.
      const filmsComplete =
        stale.some((l) => l.key === 'movies_plantowatch') || filmsDue
          ? await this.feed.resolveFilms(this.library, { signal })
          : true;

      const signatures = listSignatures(activities);
      if (!filmsComplete) {
        // Leave the film list stale: recording the current signature would mark
        // it current despite unresolved lookups, and nothing would retry until
        // the user next added or removed a title.
        signatures.movies_plantowatch = this.listSignatures.movies_plantowatch;
        this.log.warn('some film lookups failed; will retry on the next poll');
      }
      this.listSignatures = signatures;
      // Only when a list actually moved. A poll that fell through purely to
      // retry the sheet would otherwise report librarySyncedAt as now, which
      // contradicts what that field means.
      if (stale.length) this.libraryAt = new Date().toISOString();
    } catch (err) {
      libraryFailed = true;
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
    if (refetched) await this.feed.safeRender(this.library);
    // The sheet is built entirely from the library, so if the library refresh
    // threw there is nothing new for the sync to see — and running it anyway
    // means a full grid read and re-plan on every poll of a SIMKL outage, plus
    // a REFUSED line in the log for each one.
    if (!libraryFailed) await this.syncSheet();
  }

  /**
   * The sheet write, after the render and outside the library `try`.
   *
   * Outside, so a Sheets failure is never filed as `errors.library`, never
   * touches `listSignatures`, and never holds the feed up. After, so the feed —
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
   * would interleave writes to `library` and `listSignatures` here, and to
   * `movieReleases` and `filmsResolvedAt` on the feed — a cross-object
   * invariant now, held by the fact that the library timer is the sole writer
   * of all four.
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
