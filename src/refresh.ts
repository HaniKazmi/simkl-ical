import { config } from './config.ts';
import { errorMessage } from './errors.ts';
import { readToken } from './simkl/auth.ts';
import { SimklAuthError } from './simkl/client.ts';
import { fetchAllCalendars, type Calendars } from './sources/calendar.ts';
import { fetchLists, getActivities, listSignatures, staleLists, LISTS } from './sources/library.ts';
import { fetchMovieReleases, reconcileReleases } from './sources/movies.ts';
import { join, idSet, type FeedEvent } from './join.ts';
import { renderIcs } from './ics.ts';
import { loadSnapshot, saveSnapshot } from './snapshot.ts';
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
  librarySyncedAt: string | null;
  lastPolledAt: string | null;
  renderedAt: string | null;
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
  libraryAt: string | null = null;
  polledAt: string | null = null;
  renderedAt: string | null = null;
  // One slot per subsystem. A single shared slot meant the calendar timer and
  // the library timer cleared each other's failures on success, so a revoked
  // token showed as unhealthy with no stated reason.
  errors: SubsystemErrors = { calendar: null, library: null, render: null };
  timers: NodeJS.Timeout[] = [];

  constructor({ logger = console as Logger }: { logger?: Logger } = {}) {
    this.log = logger;
    this.ics = renderIcs([], { name: 'SIMKL – Upcoming' });
  }

  /**
   * Healthy means "rendered, and still hearing from SIMKL".
   *
   * `libraryAt` deliberately is not used: with per-list gating it only advances
   * when something actually changes, so it can be days old on a correct system.
   * `polledAt` tracks the activities call itself, which is what stops if a token
   * is revoked — otherwise the endpoint reported healthy forever once it had
   * rendered even once.
   */
  get health(): Health {
    const ageOf = (iso: string | null): number => (iso ? Date.now() - Date.parse(iso) : Infinity);
    const stalePoll = ageOf(this.polledAt) > config.activitiesPollMs * 3;
    const staleCalendars = ageOf(this.calendarsAt) > config.calendarRefreshMs * 3;

    return {
      ok: this.renderedAt !== null && !stalePoll && !staleCalendars,
      events: this.events.length,
      calendarsRefreshedAt: this.calendarsAt,
      librarySyncedAt: this.libraryAt,
      lastPolledAt: this.polledAt,
      renderedAt: this.renderedAt,
      stale: stalePoll || staleCalendars || undefined,
      // Kept as a single headline value for the common case; `errors` carries
      // the detail. Library problems outrank calendar ones — a stale calendar
      // still renders, a revoked token eventually will not.
      lastError: this.errors.library ?? this.errors.calendar ?? this.errors.render ?? null,
      errors: this.errors,
      timezone: config.timezone,
    };
  }

  /** Render, containing any failure in errors.render rather than the caller's slot. */
  safeRender(): void {
    try {
      this.render();
    } catch (err) {
      this.errors.render = errorMessage(err);
      this.log.error?.(`render failed: ${errorMessage(err)}`);
    }
  }

  render(): void {
    if (!this.calendars || !this.library) return;
    this.events = join(this.calendars, this.library, {
      timezone: config.timezone,
      movieReleases: this.movieReleases,
      graceDays: config.graceDays,
    });
    this.ics = renderIcs(this.events, { name: 'SIMKL – Upcoming' });
    this.renderedAt = new Date().toISOString();
    this.log.info?.(`rendered ${this.events.length} events`);
  }

  /** Serve something immediately on boot, before any network call returns. */
  async hydrate(): Promise<void> {
    const snapshot = await loadSnapshot();
    if (snapshot) {
      this.library = snapshot.library;
      this.movieReleases = snapshot.movieReleases;
      this.listSignatures = snapshot.listSignatures;
      this.libraryAt = snapshot.savedAt;
    }
    await this.refreshCalendars();
  }

  async refreshCalendars(): Promise<void> {
    try {
      this.calendars = await fetchAllCalendars({ graceDays: config.graceDays });
      this.calendarsAt = new Date().toISOString();
      this.errors.calendar = null;
    } catch (err) {
      this.errors.calendar = errorMessage(err);
      this.log.error?.(`calendar refresh failed: ${errorMessage(err)}`);
    }
    // Rendering is guarded separately: a bad timezone throws from inside the
    // join, and that must degrade the feed rather than take the process down.
    this.safeRender();
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

      const activities = await getActivities(token);
      this.polledAt = new Date().toISOString();
      // The poll itself succeeded, so any earlier failure is now history.
      this.errors.library = null;

      const stale = force || !this.library ? LISTS : staleLists(activities, this.listSignatures);
      if (!stale.length) return;

      this.log.info?.(`refetching ${stale.length}/${LISTS.length} lists: ${stale.map((l) => l.key).join(', ')}`);
      const library: Library = this.library ?? {};
      Object.assign(library, await fetchLists(token, stale));
      this.library = library;

      // Release dates only need re-reading when the film list itself changed;
      // they are stable and the lookups are CDN-cached by id. Marking an episode
      // watched must not drag eleven film lookups along with it.
      let filmsComplete = true;
      if (stale.some((l) => l.key === 'movies_plantowatch')) {
        const filmIds = [...idSet(this.library.movies_plantowatch)];
        const lookups = filmIds.length
          ? await fetchMovieReleases(filmIds)
          : { releases: new Map<number, MovieRelease>(), failed: [] };
        ({ releases: this.movieReleases, complete: filmsComplete } = reconcileReleases(
          this.movieReleases,
          filmIds,
          lookups,
        ));
        if (filmIds.length) {
          this.log.info?.(`resolved ${lookups.releases.size}/${filmIds.length} film release dates`);
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
      await saveSnapshot({
        library: this.library,
        movieReleases: this.movieReleases,
        listSignatures: this.listSignatures,
      });
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

    this.safeRender();
  }

  start(): void {
    const swallow = (err: unknown): void => this.log.error?.(`unexpected refresh failure: ${errorMessage(err)}`);
    this.timers.push(setInterval(() => void this.refreshCalendars().catch(swallow), config.calendarRefreshMs));
    this.timers.push(setInterval(() => void this.refreshLibraryIfChanged().catch(swallow), config.activitiesPollMs));
    for (const t of this.timers) t.unref?.();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
