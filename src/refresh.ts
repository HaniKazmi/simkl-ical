import { config } from './config.ts';
import { errorMessage } from './errors.ts';
import { readToken } from './simkl/auth.ts';
import { SimklAuthError } from './simkl/client.ts';
import { anyStale, fetchAllCalendars, type Calendars } from './sources/calendar.ts';
import { fetchLists, getActivities, listSignatures, staleLists, LISTS } from './sources/library.ts';
import { fetchMovieReleases, reconcileReleases } from './sources/movies.ts';
import { join, idSet, type FeedEvent } from './join.ts';
import { renderIcs } from './ics.ts';
import { loadFeed, saveFeed } from './feed-store.ts';
import type { Library, MovieRelease } from './simkl/types.ts';

export interface Logger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface Health {
  ok: boolean;
  events: number;
  calendarsRefreshedAt: string | null;
  /**
   * Last time the CDN actually answered, as distinct from the last refresh
   * attempt. These diverge exactly when the CDN is down and cached calendars
   * are being served, which is the case `calendarsRefreshedAt` alone hides.
   */
  calendarsFreshAt: string | null;
  librarySyncedAt: string | null;
  lastPolledAt: string | null;
  renderedAt: string | null;
  /** True while the feed came off disk and no fresh render has replaced it. */
  servingCached: boolean;
  stale: boolean | undefined;
  lastError: string | null;
  errors: SubsystemErrors;
  timezone: string;
}

export interface SubsystemErrors {
  calendar: string | null;
  library: string | null;
  render: string | null;
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
  calendarsAt: string | null = null;
  // Only advanced when the CDN actually answered. calendarsAt advances on every
  // attempt, including the ones served from cache after a failure, so it cannot
  // be used to detect an outage — which is what it was previously asked to do.
  calendarsFreshAt: string | null = null;
  libraryAt: string | null = null;
  filmsResolvedAt: string | null = null;
  polledAt: string | null = null;
  renderedAt: string | null = null;
  servingCached = false;
  // One slot per subsystem. A single shared slot meant the calendar timer and
  // the library timer cleared each other's failures on success, so a revoked
  // token showed as unhealthy with no stated reason.
  errors: SubsystemErrors = { calendar: null, library: null, render: null };
  timers: NodeJS.Timeout[] = [];
  /** Tail of the render chain; see safeRender. Never rejects. */
  private rendering: Promise<void> = Promise.resolve();
  /** Cancels in-flight fetches on stop(). Every source call carries its signal. */
  private aborter = new AbortController();

  constructor({ logger = console as Logger }: { logger?: Logger } = {}) {
    this.log = logger;
    this.ics = renderIcs([], { name: 'SIMKL – Upcoming' });
  }

  /**
   * Healthy means "rendered recently, rendering successfully, and still hearing
   * from both SIMKL and the CDN".
   *
   * `libraryAt` deliberately is not used: with per-list gating it only advances
   * when something actually changes, so it can be days old on a correct system.
   * `polledAt` tracks the activities call itself, which is what stops if a token
   * is revoked — otherwise the endpoint reported healthy forever once it had
   * rendered even once.
   *
   * `errors.render` and the age of `renderedAt` are both folded in. Without
   * them a render that throws on every cycle — one malformed calendar entry is
   * enough — served a frozen feed behind a green healthcheck indefinitely.
   */
  get health(): Health {
    const ageOf = (iso: string | null): number => (iso ? Date.now() - Date.parse(iso) : Infinity);
    const stalePoll = ageOf(this.polledAt) > config.activitiesPollMs * 3;
    // Keyed on freshness, not on the attempt: see calendarsFreshAt above.
    const staleCalendars = ageOf(this.calendarsFreshAt) > config.calendarRefreshMs * 3;
    // A render happens on every calendar refresh, so anything older than a few
    // cycles means renders have stopped even if none of them reported an error.
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
      // Kept as a single headline value for the common case; `errors` carries
      // the detail. Library problems outrank calendar ones — a stale calendar
      // still renders, a revoked token eventually will not.
      lastError: this.errors.library ?? this.errors.calendar ?? this.errors.render ?? null,
      errors: this.errors,
      timezone: config.timezone,
    };
  }

  /**
   * Render if both halves of the join are available, containing any failure in
   * errors.render rather than the caller's slot, and persist what was produced.
   *
   * Serialised through a promise chain. Both refresh timers end here, and at the
   * default 3h/2h intervals they coincide every six hours; overlapping runs
   * raced on the save and could leave the older render on disk.
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
      this.log.error?.(`render failed: ${errorMessage(err)}`);
      return;
    }
    if (!rendered) return;

    this.errors.render = null;
    this.servingCached = false;
    try {
      await saveFeed(this.ics);
    } catch (err) {
      // Losing the saved copy only costs resilience at the next restart.
      this.log.warn?.(`could not save the feed: ${errorMessage(err)}`);
    }
  }

  /**
   * Returns whether a render actually happened. A feed is only replaced once
   * both the calendars and the library are present, so a partial refresh never
   * overwrites a complete feed loaded from disk.
   */
  render(): boolean {
    if (!this.calendars || !this.library) return false;
    this.events = join(this.calendars, this.library, {
      timezone: config.timezone,
      movieReleases: this.movieReleases,
      graceDays: config.graceDays,
    });
    this.ics = renderIcs(this.events, { name: 'SIMKL – Upcoming' });
    this.renderedAt = new Date().toISOString();
    this.log.info?.(`rendered ${this.events.length} events`);
    return true;
  }

  /**
   * Serve the last feed immediately on boot, and keep serving it until a
   * complete fresh one is rendered. Nothing else is restored: every restart
   * resyncs from scratch, so no stale control state can outlive the process.
   */
  async hydrate(): Promise<void> {
    const saved = await loadFeed();
    if (saved) {
      this.ics = saved;
      this.servingCached = true;
      this.log.info?.('serving the last saved feed until a fresh one is ready');
    }
    await this.refreshCalendars();
  }

  async refreshCalendars(): Promise<void> {
    try {
      this.calendars = await fetchAllCalendars({
        graceDays: config.graceDays,
        signal: this.aborter.signal,
        log: (message) => this.log.warn?.(message),
      });
      this.calendarsAt = new Date().toISOString();

      if (anyStale(this.calendars)) {
        // Deliberately not treated as a success. Serving the cached copy is the
        // right behaviour, but reporting it as fresh is what let a month-long
        // CDN outage pass as healthy while the feed emptied out.
        const since = this.calendarsFreshAt ?? 'startup';
        this.errors.calendar = `serving cached calendars — the CDN has not answered since ${since}`;
        this.log.warn?.(this.errors.calendar);
      } else {
        this.calendarsFreshAt = this.calendarsAt;
        this.errors.calendar = null;
      }
    } catch (err) {
      this.errors.calendar = errorMessage(err);
      this.log.error?.(`calendar refresh failed: ${errorMessage(err)}`);
    }
    // Rendering is guarded separately: a bad timezone throws from inside the
    // join, and that must degrade the feed rather than take the process down.
    await this.safeRender();
  }

  /**
   * Whether the cached film release dates have aged out.
   *
   * Nothing in the library moves when a studio shifts a release, so gating film
   * lookups purely on list changes meant a delayed film kept its old date until
   * that date fell behind the join's cutoff — at which point it disappeared
   * from the feed and never came back short of a restart. Once a day is cheap:
   * the lookups are CDN-cached by id and the list is short.
   */
  private filmsDue(now: number = Date.now()): boolean {
    if (!this.filmsResolvedAt) return true;
    return now - Date.parse(this.filmsResolvedAt) > config.movieRefreshMs;
  }

  /**
   * One cheap request decides whether the library calls are worth making.
   * The signature covers only the timestamps that can move an item between
   * lists — see listSignature in sources/library.ts.
   */
  async refreshLibraryIfChanged({ force = false }: { force?: boolean } = {}): Promise<void> {
    try {
      // Inside the try: readToken only swallows ENOENT, so a truncated or
      // unreadable token.json threw straight out of this method and, from the
      // timer, took the process down with it.
      const token = await readToken();
      if (!token) {
        this.errors.library = 'no token — run `npm run login`';
        this.log.error?.(this.errors.library);
        return;
      }

      const activities = await getActivities(token, { signal: this.aborter.signal });
      this.polledAt = new Date().toISOString();
      // The poll itself succeeded, so any earlier failure is now history.
      this.errors.library = null;

      const stale = force || !this.library ? LISTS : staleLists(activities, this.listSignatures);
      // Film dates age out on their own schedule, so a poll with no list changes
      // still has work to do once a day — see filmsDue.
      const filmsDue = force || this.filmsDue();
      if (!stale.length && !filmsDue) return;

      if (stale.length) {
        this.log.info?.(`refetching ${stale.length}/${LISTS.length} lists: ${stale.map((l) => l.key).join(', ')}`);
        const library: Library = this.library ?? {};
        Object.assign(library, await fetchLists(token, stale, { signal: this.aborter.signal }));
        this.library = library;
      }

      // Release dates are re-read when the film list itself changed, and
      // otherwise only once a day. Marking an episode watched must not drag
      // eleven film lookups along with it — but the dates are not the "stable"
      // the old comment claimed either: a studio delaying a film produces no
      // library activity at all, so the feed kept the old date until it fell
      // behind the cutoff and the film silently vanished until a restart.
      let filmsComplete = true;
      if (stale.some((l) => l.key === 'movies_plantowatch') || filmsDue) {
        const filmIds = [...idSet(this.library?.movies_plantowatch)];
        const lookups = filmIds.length
          ? await fetchMovieReleases(filmIds, { signal: this.aborter.signal })
          : { releases: new Map<number, MovieRelease>(), failed: [] };
        ({ releases: this.movieReleases, complete: filmsComplete } = reconcileReleases(
          this.movieReleases,
          filmIds,
          lookups,
        ));
        // Only on a complete round. Stamping regardless meant a failed daily
        // re-read pushed the next attempt out another full movieRefreshMs — the
        // signature rollback below cannot help when the round was triggered by
        // age rather than by a list change, because the signature never moved.
        if (filmsComplete) this.filmsResolvedAt = new Date().toISOString();
        if (filmIds.length) {
          this.log.info?.(`resolved ${lookups.releases.size}/${filmIds.length} film release dates`);
        }
        if (lookups.unavailable?.length) {
          this.log.warn?.(`${lookups.unavailable.length} film ids are gone upstream: ${lookups.unavailable.join(', ')}`);
        }
      }

      const signatures = listSignatures(activities);
      if (!filmsComplete) {
        // Recording the current signature here would mark the film list current
        // despite unresolved lookups, and nothing would retry until the user
        // next added or removed a title. Leave it stale instead.
        signatures.movies_plantowatch = this.listSignatures.movies_plantowatch;
        this.log.warn?.('some film lookups failed; will retry on the next poll');
      }
      this.listSignatures = signatures;
      this.libraryAt = new Date().toISOString();
      this.errors.library = null;
    } catch (err) {
      // A revoked token must not empty the feed — keep serving the last render.
      const prefix = err instanceof SimklAuthError ? 'AUTH' : 'library';
      this.errors.library = `${prefix}: ${errorMessage(err)}`;
      this.log.error?.(
        err instanceof SimklAuthError
          // The `--` matters: npm swallows a bare --force instead of passing it on.
          ? 'SIMKL rejected the token. Re-run `npm run login -- --force`. Serving the last good feed.'
          : `library refresh failed: ${errorMessage(err)}`,
      );
    }

    await this.safeRender();
  }

  /**
   * Run `job` on an interval, skipping a tick if the previous one is still
   * going. setInterval does not wait, so a refresh slower than its own period —
   * seven sequential list calls during a SIMKL brownout will do it — would
   * otherwise overlap itself and interleave writes to library, movieReleases
   * and listSignatures, letting an older run overwrite a newer signature set.
   */
  private schedule(name: string, job: () => Promise<void>, everyMs: number): void {
    let running = false;
    const timer = setInterval(() => {
      if (running) {
        this.log.warn?.(`${name} is still running from the last tick; skipping this one`);
        return;
      }
      running = true;
      void job()
        .catch((err: unknown) => this.log.error?.(`unexpected refresh failure: ${errorMessage(err)}`))
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
   * Stop refreshing and cancel anything in flight.
   *
   * Aborting matters on shutdown: a calendar refresh can be several MB into a
   * multi-minute fetch, and without this the process waits for it before the
   * server can close.
   */
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.aborter.abort();
  }
}
