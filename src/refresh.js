import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { config } from './config.js';
import { readToken } from './simkl/auth.js';
import { SimklAuthError } from './simkl/client.js';
import { fetchAllCalendars } from './sources/calendar.js';
import { fetchLibrary, getActivities } from './sources/library.js';
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
    this.activitySignature = null;
    this.calendarsAt = null;
    this.libraryAt = null;
    this.renderedAt = null;
    this.lastError = null;
    this.timers = [];
  }

  get health() {
    return {
      ok: this.events.length > 0 || this.renderedAt !== null,
      events: this.events.length,
      calendarsRefreshedAt: this.calendarsAt,
      libraryRefreshedAt: this.libraryAt,
      renderedAt: this.renderedAt,
      lastError: this.lastError,
      timezone: config.timezone,
    };
  }

  render() {
    if (!this.calendars || !this.library) return;
    this.events = join(this.calendars, this.library, {
      timezone: config.timezone,
      movieReleases: this.movieReleases,
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
        activitySignature: this.activitySignature,
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
      this.activitySignature = snap.activitySignature;
      this.libraryAt = snap.savedAt;
    } catch {
      // No snapshot yet — first run.
    }
    try {
      this.calendars = await fetchAllCalendars();
      this.calendarsAt = new Date().toISOString();
    } catch (err) {
      this.log.warn?.(`calendar hydrate failed: ${err.message}`);
    }
    this.render();
  }

  async refreshCalendars() {
    try {
      this.calendars = await fetchAllCalendars();
      this.calendarsAt = new Date().toISOString();
      this.lastError = null;
      this.render();
    } catch (err) {
      this.lastError = `calendar: ${err.message}`;
      this.log.error?.(`calendar refresh failed: ${err.message}`);
    }
  }

  /**
   * One cheap request decides whether the five library calls are worth making.
   * The signature is the full activities payload: any change to any timestamp
   * we care about produces a different string.
   */
  async refreshLibraryIfChanged({ force = false } = {}) {
    const token = await readToken();
    if (!token) {
      this.lastError = 'no token — run `npm run login`';
      this.log.error?.(this.lastError);
      return;
    }

    try {
      const activities = await getActivities(token);
      const signature = JSON.stringify([activities.tv_shows, activities.anime, activities.movies]);
      if (!force && signature === this.activitySignature && this.library) return;

      this.library = await fetchLibrary(token);

      // Release dates only need re-reading when the film list itself changes;
      // they are stable and the lookups are CDN-cached by id.
      const filmIds = [...idSet(this.library.movies_plantowatch)];
      if (filmIds.length) {
        const releases = await fetchMovieReleases(filmIds);
        if (releases.size) this.movieReleases = releases;
        this.log.info?.(`resolved ${releases.size}/${filmIds.length} film release dates`);
      } else {
        this.movieReleases = new Map();
      }

      this.activitySignature = signature;
      this.libraryAt = new Date().toISOString();
      this.lastError = null;
      await this.persist();
      this.render();
    } catch (err) {
      // A revoked token must not empty the feed — keep serving the last render.
      const prefix = err instanceof SimklAuthError ? 'AUTH' : 'library';
      this.lastError = `${prefix}: ${err.message}`;
      this.log.error?.(
        err instanceof SimklAuthError
          ? `SIMKL rejected the token. Re-run \`npm run login --force\`. Serving the last good feed.`
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
