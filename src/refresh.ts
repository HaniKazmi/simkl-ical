import { config, sheetSyncConfigured } from './config.ts';
import { errorMessage } from './errors.ts';
import { SheetSync, type SheetSyncStatus } from './sheet-sync.ts';
import { readToken } from './simkl/auth.ts';
import { SimklAuthError } from './simkl/client.ts';
import { anyStale, fetchAllCalendars, payloads, type Calendars } from './sources/calendar.ts';
import { fetchLists, getActivities, listSignatures, staleLists, LISTS } from './sources/library.ts';
import { fetchMovieReleases, reconcileReleases } from './sources/movies.ts';
import { join, idSet, type FeedEvent } from './join.ts';
import { renderIcs } from './ics.ts';
import { loadFeed, saveFeed } from './feed-store.ts';
import type { Library, MovieRelease } from './simkl/types.ts';

/** Age of an ISO timestamp in ms; never-set reads as infinitely old. */
const ageOf = (iso: string | null): number => (iso ? Date.now() - Date.parse(iso) : Infinity);

/** Shown as the calendar's name in every client. */
const FEED_NAME = 'SIMKL – Upcoming';

export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface Health {
  ok: boolean;
  events: number;
  calendarsRefreshedAt: string | null;
  /**
   * Last time the CDN actually answered, as distinct from the last attempt.
   * The two diverge while cached calendars are being served.
   */
  calendarsFreshAt: string | null;
  librarySyncedAt: string | null;
  lastPolledAt: string | null;
  renderedAt: string | null;
  /** True while the feed came off disk and no fresh render has replaced it. */
  servingCached: boolean;
  stale: true | undefined;
  lastError: string | null;
  errors: SubsystemErrors;
  timezone: string;
  sheet: SheetHealth;
}

export interface SheetHealth {
  mode: string;
  configured: boolean;
  lastRunAt: string | null;
  status: SheetSyncStatus;
  frozen: boolean;
}

export interface SubsystemErrors {
  calendar: string | null;
  library: string | null;
  render: string | null;
  /**
   * Fourth slot for the same reason as the other three: the sheet sync shares
   * the library timer, and the two must not clear each other's failures.
   */
  sheet: string | null;
}

/**
 * Holds the rendered feed in memory. Requests never trigger a fetch: a client
 * polling hard cannot amplify into SIMKL traffic, and a SIMKL outage degrades
 * to a stale feed rather than an empty one.
 */
export class FeedState {
  log: Logger;
  ics: string;
  events: FeedEvent[] = [];
  calendars: Calendars | null = null;
  library: Library | null = null;
  movieReleases = new Map<number, MovieRelease>();
  listSignatures: Record<string, string> = {};
  // calendarsAt advances on every attempt, including ones served from cache
  // after a failure; only calendarsFreshAt means the CDN answered.
  calendarsAt: string | null = null;
  calendarsFreshAt: string | null = null;
  libraryAt: string | null = null;
  filmsResolvedAt: string | null = null;
  polledAt: string | null = null;
  renderedAt: string | null = null;
  servingCached = false;
  // One slot per subsystem: the two timers must not clear each other's failures.
  errors: SubsystemErrors = { calendar: null, library: null, render: null, sheet: null };
  /** Null unless a spreadsheet *and* a credential were both supplied. */
  sheetSync: SheetSync | null = null;
  /**
   * Whether the last sheet sync wants another go. A boolean, not an interval:
   * the sheet has no upstream clock of its own — everything it writes derives
   * from watch state, and `staleLists` already detects that. This exists only
   * so a failed write is not stranded until the user next watches something.
   */
  sheetRetryPending = false;
  timers: NodeJS.Timeout[] = [];
  /** Tail of the render chain; see safeRender. Never rejects. */
  private rendering: Promise<void> = Promise.resolve();
  /** Cancels in-flight fetches on stop(). Every source call carries its signal. */
  private aborter = new AbortController();

  constructor({ logger = console as Logger }: { logger?: Logger } = {}) {
    this.log = logger;
    this.ics = renderIcs([], { name: FEED_NAME });
    if (sheetSyncConfigured()) this.sheetSync = new SheetSync({ logger });
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
    const stalePoll = ageOf(this.polledAt) > config.activitiesPollMs * 3;
    const staleCalendars = ageOf(this.calendarsFreshAt) > config.calendarRefreshMs * 3;
    // A render happens on every calendar refresh, so an old renderedAt means
    // rendering has stopped even when nothing reported an error.
    const staleRender = ageOf(this.renderedAt) > config.calendarRefreshMs * 3;

    return {
      ok: this.renderedAt !== null && !stalePoll && !staleCalendars && !staleRender && !this.errors.render,
      events: this.events.length,
      calendarsRefreshedAt: this.calendarsAt,
      calendarsFreshAt: this.calendarsFreshAt,
      librarySyncedAt: this.libraryAt,
      lastPolledAt: this.polledAt,
      renderedAt: this.renderedAt,
      servingCached: this.servingCached,
      stale: stalePoll || staleCalendars || staleRender || undefined,
      // A single headline value; `errors` carries the detail. Library problems
      // outrank calendar ones: a stale calendar still renders, a revoked token
      // eventually will not. The sheet sits last — it cannot affect the feed.
      lastError: this.errors.library ?? this.errors.calendar ?? this.errors.render ?? this.errors.sheet ?? null,
      errors: this.errors,
      timezone: config.timezone,
      // Reported but deliberately excluded from `ok` above: /healthz is the
      // container healthcheck and the CI smoke test, and a frozen sheet sync
      // must not restart the container or fail a deploy.
      sheet: {
        mode: config.sheetSyncMode,
        configured: this.sheetSync !== null,
        lastRunAt: this.sheetSync?.lastRunAt ?? null,
        status: this.sheetSync?.lastStatus ?? 'idle',
        frozen: Boolean(this.sheetSync?.frozen),
      },
    };
  }

  /**
   * Render if both halves of the join are available, containing any failure in
   * errors.render rather than the caller's slot, and persist what was produced.
   *
   * Serialised: both refresh timers end here and coincide every six hours at
   * the default intervals, and overlapping runs would race on the save.
   */
  safeRender(): Promise<void> {
    this.rendering = this.rendering.then(() => this.renderAndSave());
    return this.rendering;
  }

  private async renderAndSave(): Promise<void> {
    let rendered = false;
    try {
      rendered = this.render();
    } catch (err) {
      this.errors.render = errorMessage(err);
      this.log.error(`render failed: ${errorMessage(err)}`);
      return;
    }
    if (!rendered) return;

    this.errors.render = null;
    this.servingCached = false;
    try {
      await saveFeed(this.ics);
    } catch (err) {
      // Losing the saved copy only costs resilience at the next restart.
      this.log.warn(`could not save the feed: ${errorMessage(err)}`);
    }
  }

  /**
   * Returns whether a render happened. The feed is replaced only once both
   * halves are present, so a partial refresh never overwrites a complete feed
   * loaded from disk.
   */
  render(): boolean {
    if (!this.calendars || !this.library) return false;
    this.events = join(payloads(this.calendars), this.library, { movieReleases: this.movieReleases });
    this.ics = renderIcs(this.events, { name: FEED_NAME });
    this.renderedAt = new Date().toISOString();
    this.log.info(`rendered ${this.events.length} events`);
    return true;
  }

  /**
   * Serve the last feed on boot and keep serving it until a complete fresh one
   * is rendered. Nothing else is restored, so no control state outlives the
   * process.
   */
  async hydrate(): Promise<void> {
    const saved = await loadFeed();
    if (saved) {
      this.ics = saved;
      this.servingCached = true;
      this.log.info('serving the last saved feed until a fresh one is ready');
    }
    await this.refreshCalendars();
  }

  async refreshCalendars(): Promise<void> {
    try {
      this.calendars = await fetchAllCalendars({
        signal: this.aborter.signal,
        log: (message) => this.log.warn(message),
      });
      this.calendarsAt = new Date().toISOString();

      if (anyStale(this.calendars)) {
        // Serving the cached copy is right; reporting it as fresh is not.
        const since = this.calendarsFreshAt ?? 'startup';
        this.errors.calendar = `serving cached calendars — the CDN has not answered since ${since}`;
        this.log.warn(this.errors.calendar);
      } else {
        this.calendarsFreshAt = this.calendarsAt;
        this.errors.calendar = null;
      }
    } catch (err) {
      this.errors.calendar = errorMessage(err);
      this.log.error(`calendar refresh failed: ${errorMessage(err)}`);
    }
    // Rendering is guarded separately: a bad timezone throws from inside the
    // join, and that must degrade the feed rather than take the process down.
    await this.safeRender();
  }

  /**
   * Whether the cached film release dates have aged out. Nothing in the library
   * moves when a studio shifts a release, so list changes alone would never
   * trigger a re-read; daily is cheap, as the lookups are CDN-cached by id.
   */
  private filmsDue(): boolean {
    return ageOf(this.filmsResolvedAt) > config.movieRefreshMs;
  }

  /**
   * Re-read every plan-to-watch film's release date. Returns whether the round
   * was complete — an incomplete one must leave the list stale so it retries.
   */
  private async resolveFilms(): Promise<boolean> {
    const filmIds = [...idSet(this.library?.movies_plantowatch)];
    const lookups = await fetchMovieReleases(filmIds, { signal: this.aborter.signal });
    const { releases, complete } = reconcileReleases(this.movieReleases, filmIds, lookups);
    this.movieReleases = releases;

    // Only on a complete round: stamping regardless would defer the retry by a
    // full movieRefreshMs, and the caller's signature rollback cannot help when
    // the round was triggered by age rather than by a list change.
    if (complete) this.filmsResolvedAt = new Date().toISOString();

    if (filmIds.length) this.log.info(`resolved ${lookups.releases.size}/${filmIds.length} film release dates`);
    if (lookups.unavailable.length) {
      this.log.warn(`${lookups.unavailable.length} film ids are gone upstream: ${lookups.unavailable.join(', ')}`);
    }
    return complete;
  }

  /**
   * One cheap request decides whether the library calls are worth making.
   * The signature covers only the timestamps that can move an item between
   * lists — see listSignature in sources/library.ts.
   */
  async refreshLibraryIfChanged({ force = false }: { force?: boolean } = {}): Promise<void> {
    // Whether anything the feed is built from moved. Declared out here because
    // the render below sits outside the try, and a failed poll must not claim it.
    let refetched = false;
    try {
      // Inside the try: readToken only swallows ENOENT, so an unreadable
      // token.json must degrade the feed rather than escape to the timer.
      const token = await readToken();
      if (!token) {
        this.errors.library = 'no token — run `npm run login`';
        this.log.error(this.errors.library);
        return;
      }

      const activities = await getActivities(token, { signal: this.aborter.signal });
      this.polledAt = new Date().toISOString();
      // The poll itself succeeded, so any earlier failure is now history.
      this.errors.library = null;

      const stale = force || !this.library ? LISTS : staleLists(activities, this.listSignatures);
      // Film dates age out on their own schedule, so a poll with no list
      // changes still has work to do once a day.
      const filmsDue = force || this.filmsDue();
      // The retry term is a boolean, and false when the sync is unconfigured,
      // so a quiet poll still makes exactly one request.
      if (!stale.length && !filmsDue && !this.sheetRetryPending) return;
      refetched = stale.length > 0 || filmsDue;

      if (stale.length) {
        this.log.info(`refetching ${stale.length}/${LISTS.length} lists: ${stale.map((l) => l.key).join(', ')}`);
        const library: Library = this.library ?? {};
        Object.assign(library, await fetchLists(token, stale, { signal: this.aborter.signal }));
        this.library = library;
      }

      // Re-read when the film list changed, and otherwise once a day. Marking
      // an episode watched must not drag eleven film lookups along with it.
      const filmsComplete =
        stale.some((l) => l.key === 'movies_plantowatch') || filmsDue ? await this.resolveFilms() : true;

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
      // A revoked token must not empty the feed — keep serving the last render.
      const prefix = err instanceof SimklAuthError ? 'AUTH' : 'library';
      this.errors.library = `${prefix}: ${errorMessage(err)}`;
      this.log.error(
        err instanceof SimklAuthError
          // The `--` matters: npm swallows a bare --force instead of passing it on.
          ? 'SIMKL rejected the token. Re-run `npm run login -- --force`. Serving the last good feed.'
          : `library refresh failed: ${errorMessage(err)}`,
      );
    }

    // Only when something the feed is built from actually moved. A poll that
    // fell through purely to retry the sheet would otherwise re-join, re-render
    // and rewrite an identical feed to disk; the calendar timer still renders
    // on its own schedule, so nothing goes stale.
    if (refetched) await this.safeRender();
    await this.syncSheet();
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
   * would interleave writes to library, movieReleases and listSignatures.
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
   */
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.aborter.abort();
  }
}
