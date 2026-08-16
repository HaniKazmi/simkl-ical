/**
 * The iCal half, end to end: FETCH → JOIN → RENDER → SAVE.
 *
 * Owns everything the feed is built from and everything it produces — the
 * calendars, the film release dates, the events, the rendered ICS — and nothing
 * else. The library is deliberately *not* here: it is the one input both halves
 * share, so `Orchestrator` owns it and passes it in. One owner per piece of
 * state is what keeps a poll from having two copies that can disagree.
 */

import { config } from '../shared/config.ts';
import { ageOf } from '../shared/dates.ts';
import { errorMessage } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import type { Library, MovieRelease } from '../api/simkl/types.ts';
// The pipeline, in the order this file runs it.
import { anyStale, fetchAllCalendars, payloads, type Calendars } from './io/calendar.ts';
import { fetchMovieReleases, reconcileReleases } from './io/movies.ts';
import { join, idSet, type FeedEvent } from './1-join.ts';
import { renderIcs } from './2-ics.ts';
import { loadFeed, saveFeed } from './io/store.ts';

/** Shown as the calendar's name in every client. */
const FEED_NAME = 'SIMKL – Upcoming';

export interface FeedErrors {
  calendar: string | null;
  render: string | null;
}

export class Feed {
  log: Logger;
  ics: string;
  events: FeedEvent[] = [];
  calendars: Calendars | null = null;
  movieReleases = new Map<number, MovieRelease>();
  // calendarsAt advances on every attempt, including ones served from cache
  // after a failure; only calendarsFreshAt means the CDN answered.
  calendarsAt: string | null = null;
  calendarsFreshAt: string | null = null;
  filmsResolvedAt: string | null = null;
  renderedAt: string | null = null;
  servingCached = false;
  /**
   * The two failures this half can have. Owned here rather than in one flat bag
   * shared with the library and the sheet, so "the timers must not clear each
   * other's failures" is a property of who holds the field rather than a rule
   * someone has to remember.
   */
  errors: FeedErrors = { calendar: null, render: null };
  /** Tail of the render chain; see safeRender. Never rejects. */
  private rendering: Promise<void> = Promise.resolve();

  constructor({ logger = console as Logger }: { logger?: Logger } = {}) {
    this.log = logger;
    this.ics = renderIcs([], { name: FEED_NAME });
  }

  /**
   * Serve the last feed on boot and keep serving it until a complete fresh one
   * is rendered. Nothing else is restored, so no control state outlives the
   * process.
   */
  async hydrate(library: Library | null, { signal }: { signal: AbortSignal }): Promise<void> {
    const saved = await loadFeed();
    if (saved) {
      this.ics = saved;
      this.servingCached = true;
      this.log.info('serving the last saved feed until a fresh one is ready');
    }
    await this.refreshCalendars({ signal });
    // Rendering is guarded separately: a bad timezone throws from inside the
    // join, and that must degrade the feed rather than take the process down.
    await this.safeRender(library);
  }

  /**
   * FETCH, and nothing else. Rendering is deliberately the caller's.
   *
   * This fetch is several MB and takes seconds to minutes, and the library poll
   * runs on its own timer throughout. If a render were queued here it would
   * carry a library read *before* the fetch — and because it is queued when the
   * fetch finishes, it lands after the poll's own render and overwrites it.
   * The caller reads the library after this returns, so it renders what is
   * current rather than what was current when the fetch began.
   */
  async refreshCalendars({ signal }: { signal: AbortSignal }): Promise<void> {
    try {
      this.calendars = await fetchAllCalendars({ signal, log: (message) => this.log.warn(message) });
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
  }

  /**
   * Whether the cached film release dates have aged out. Nothing in the library
   * moves when a studio shifts a release, so list changes alone would never
   * trigger a re-read; daily is cheap, as the lookups are CDN-cached by id.
   *
   * Public, and asked by `Orchestrator` rather than decided here: the quiet-poll
   * early return needs the answer *before* it knows whether it will resolve
   * anything. The state and the work live here; the decision does not.
   */
  filmsDue(): boolean {
    return ageOf(this.filmsResolvedAt) > config.movieRefreshMs;
  }

  /**
   * FETCH, per film. Returns whether the round was complete — an incomplete one
   * must leave the list stale so it retries.
   *
   * Deliberately *not* wrapped in a try/catch, which looks like an obvious
   * tidy-up now that films live here. These are SIMKL calls, so an account-level
   * failure belongs in `errors.library` and must reach the caller: swallowing it
   * would make a revoked token during film lookups report nothing at all.
   */
  async resolveFilms(library: Library | null, { signal }: { signal: AbortSignal }): Promise<boolean> {
    const filmIds = [...idSet(library?.movies_plantowatch)];
    const lookups = await fetchMovieReleases(filmIds, { signal });
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
   * JOIN → RENDER → SAVE, with any failure contained in `errors.render` rather
   * than the caller's slot.
   *
   * Serialised: both refresh timers end here and coincide every six hours at
   * the default intervals, and overlapping runs would race on the save. The
   * library is captured when this is *called* rather than when the queued render
   * runs, so a render renders what its caller had.
   */
  safeRender(library: Library | null): Promise<void> {
    this.rendering = this.rendering.then(() => this.renderAndSave(library));
    return this.rendering;
  }

  private async renderAndSave(library: Library | null): Promise<void> {
    let rendered = false;
    try {
      rendered = this.render(library);
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
  render(library: Library | null): boolean {
    if (!this.calendars || !library) return false;
    this.events = join(payloads(this.calendars), library, { movieReleases: this.movieReleases });
    this.ics = renderIcs(this.events, { name: FEED_NAME });
    this.renderedAt = new Date().toISOString();
    this.log.info(`rendered ${this.events.length} events`);
    return true;
  }
}
