import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { config } from './config.js';
import { readToken } from './simkl/auth.js';
import { SimklAuthError } from './simkl/client.js';
import { fetchAllCalendars } from './sources/calendar.js';
import { fetchLists, getActivities, listSignatures, staleLists, LISTS } from './sources/library.js';
import { fetchMovieReleases } from './sources/movies.js';
import { join, idSet } from './join.js';
import { renderIcs } from './ics.js';

const snapshotPath = () => joinPath(config.dataDir, 'snapshot.json');

/**
 * Holds the rendered feed in memory. Requests never trigger a fetch: a client
 * polling hard cannot amplify into SIMKL traffic, and a SIMKL outage degrades
 * to a stale feed rather than an empty one.
 */
export class FeedState {
  constructor({ logger = console } = {}) {
    this.log = logger;
    this.ics = renderIcs([], { name: 'SIMKL – Upcoming' });
    this.events = [];
    this.calendars = null;
    this.library = null;
    this.movieReleases = new Map();
    this.listSignatures = {};
    this.calendarsAt = null;
    this.libraryAt = null;
    this.polledAt = null;
    this.renderedAt = null;
    // One slot per subsystem. A single shared slot meant the calendar timer and
    // the library timer cleared each other's failures on success, so a revoked
    // token showed as unhealthy with no stated reason.
    this.errors = { calendar: null, library: null, render: null };
    this.timers = [];
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
  get health() {
    const ageOf = (iso) => (iso ? Date.now() - Date.parse(iso) : Infinity);
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

  render() {
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

  async persist() {
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(
      snapshotPath(),
      JSON.stringify({
        library: this.library,
        movieReleases: [...this.movieReleases.values()],
        listSignatures: this.listSignatures,
        savedAt: new Date().toISOString(),
      }),
    );
  }

  /** Serve something immediately on boot, before any network call returns. */
  async hydrate() {
    try {
      const snap = JSON.parse(await readFile(snapshotPath(), 'utf8'));
      this.library = snap.library;
      this.movieReleases = new Map((snap.movieReleases ?? []).map((m) => [Number(m.simkl_id), m]));
      // Absent on snapshots written before per-list gating: every list then
      // reads as stale and the next poll refetches the lot, which is correct.
      this.listSignatures = snap.listSignatures ?? {};
      this.libraryAt = snap.savedAt;
    } catch {
      // No snapshot yet — first run.
    }
    try {
      this.calendars = await fetchAllCalendars({ graceDays: config.graceDays });
      this.calendarsAt = new Date().toISOString();
    } catch (err) {
      this.log.warn?.(`calendar hydrate failed: ${err.message}`);
    }
    // Guarded like the other two call sites: a render failure must degrade the
    // feed, not take the process down during startup.
    try {
      this.render();
    } catch (err) {
      this.errors.render = err.message;
      this.log.error?.(`render failed during hydrate: ${err.message}`);
    }
  }

  async refreshCalendars() {
    try {
      this.calendars = await fetchAllCalendars({ graceDays: config.graceDays });
      this.calendarsAt = new Date().toISOString();
      this.errors.calendar = null;
      this.render();
    } catch (err) {
      this.errors.calendar = err.message;
      this.log.error?.(`calendar refresh failed: ${err.message}`);
    }
  }

  /**
   * One cheap request decides whether the five library calls are worth making.
   * The signature covers only the timestamps that can move an item between
   * lists — see membershipSignature.
   */
  async refreshLibraryIfChanged({ force = false } = {}) {
    const token = await readToken();
    if (!token) {
      this.errors.library = 'no token — run `npm run login`';
      this.log.error?.(this.errors.library);
      return;
    }

    try {
      const activities = await getActivities(token);
      this.polledAt = new Date().toISOString();

      const stale = force || !this.library ? LISTS : staleLists(activities, this.listSignatures);
      if (!stale.length) return;

      this.log.info?.(`refetching ${stale.length}/${LISTS.length} lists: ${stale.map((l) => l.key).join(', ')}`);
      Object.assign(this.library ?? (this.library = {}), await fetchLists(token, stale));

      // Release dates only need re-reading when the film list itself changed;
      // they are stable and the lookups are CDN-cached by id. Marking an episode
      // watched must not drag eleven film lookups along with it.
      let filmsComplete = true;
      if (stale.some((l) => l.key === 'movies_plantowatch')) {
        const filmIds = [...idSet(this.library.movies_plantowatch)];
        if (filmIds.length) {
          const releases = await fetchMovieReleases(filmIds);
          // Carry over anything that failed this time rather than dropping it,
          // and drop anything no longer on the list.
          const merged = new Map();
          for (const id of filmIds) {
            const release = releases.get(id) ?? this.movieReleases.get(id);
            if (release) merged.set(id, release);
          }
          this.movieReleases = merged;
          filmsComplete = releases.size === filmIds.length;
          this.log.info?.(`resolved ${releases.size}/${filmIds.length} film release dates`);
        } else {
          this.movieReleases = new Map();
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
      await this.persist();
      this.render();
    } catch (err) {
      // A revoked token must not empty the feed — keep serving the last render.
      const prefix = err instanceof SimklAuthError ? 'AUTH' : 'library';
      this.errors.library = `${prefix}: ${err.message}`;
      this.log.error?.(
        err instanceof SimklAuthError
          // The `--` matters: npm swallows a bare --force instead of passing it on.
          ? `SIMKL rejected the token. Re-run \`npm run login -- --force\`. Serving the last good feed.`
          : `library refresh failed: ${err.message}`,
      );
    }
  }

  start() {
    this.timers.push(setInterval(() => this.refreshCalendars(), config.calendarRefreshMs));
    this.timers.push(setInterval(() => this.refreshLibraryIfChanged(), config.activitiesPollMs));
    for (const t of this.timers) t.unref?.();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
