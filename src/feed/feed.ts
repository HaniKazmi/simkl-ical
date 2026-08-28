/**
 * The iCal half, end to end: FETCH → JOIN → RENDER → SAVE.
 *
 * Owns everything the feed is built from and everything it produces — the
 * calendars, the film release dates, the events, the rendered ICS — and nothing
 * else. The library is deliberately *not* here: it is the one input both halves
 * share, so `Orchestrator` owns it and passes it in. One owner per piece of
 * state is what keeps a poll from having two copies that can disagree.
 */

import { errorMessage } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import type { Library } from '../library.ts';
import type { MovieRelease } from './1-films.ts';
// The pipeline, in the order this file runs it.
import { anyChanged, anyStale, fetchAllCalendars, payloads, type Calendars } from './io/calendar.ts';
import { filmDue, reconcileReleases } from './1-films.ts';
import { fetchMovieReleases } from './io/movies.ts';
import { join, plannedFilmIds, type FeedEvent } from './2-join.ts';
import { renderIcs } from './3-ics.ts';
import { loadFeed, saveFeed } from './io/store.ts';
import { isoOf, nowIso } from '../shared/dates.ts';

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
  /**
   * Film id → when it was last looked up, so a partial round can tell "asked
   * recently" from "never asked". A retryably-failed lookup does not refresh the
   * stamp, so the film stays past the floor and due — which is what makes the
   * next poll retry exactly the films that failed, with no flag to carry.
   */
  filmStamps = new Map<number, Temporal.Instant>();
  // calendarsAt advances on every attempt, including ones served from cache
  // after a failure; only calendarsFreshAt means the CDN answered.
  calendarsAt: string | null = null;
  calendarsFreshAt: string | null = null;
  /**
   * When the CDN last sent new bytes, as opposed to answering 304. The interval
   * is matched to how often the CDN regenerates, so "it answered" and "it
   * changed" are different questions and only this one says a refresh did any
   * work. Deliberately not in `/healthz`: a run of 304s is the healthy outcome,
   * not a condition, and the payload's key order is pinned.
   */
  calendarsChangedAt: string | null = null;
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
  /** Tail of the render chain; see render(). Never rejects. */
  private rendering: Promise<void> = Promise.resolve();

  constructor({ logger = console as Logger }: { logger?: Logger } = {}) {
    this.log = logger;
    this.ics = renderIcs([], { name: FEED_NAME });
  }

  /**
   * Serve the last feed on boot and keep serving it until a complete fresh one
   * is rendered, and warm the calendars. Nothing else is restored, so no
   * control state outlives the process — and nothing renders here, because at
   * boot there is no library yet and the render gate would decline anyway.
   */
  async hydrate({ signal }: { signal: AbortSignal }): Promise<void> {
    // Contained here rather than allowed to unwind. `loadFeed` distinguishes a
    // missing file from an unreadable one so the second is visible, but visible
    // is the whole point of it — escaping would skip the calendar fetch and the
    // first library poll after it, leaving the service to wait out a full timer
    // interval over a file it only ever reads as a fallback.
    const saved = await loadFeed().catch((err: unknown) => {
      this.log.warn(`could not read the saved feed, starting from empty: ${errorMessage(err)}`);
      return null;
    });
    if (saved) {
      this.ics = saved;
      this.servingCached = true;
      this.log.info('serving the last saved feed until a fresh one is ready');
    }
    await this.refreshCalendars({ signal });
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
      this.calendarsAt = nowIso();

      if (anyChanged(this.calendars)) this.calendarsChangedAt = this.calendarsAt;

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

  /** Which films are worth asking about — the rule itself is `filmDue`. */
  private filmsToResolve(ids: number[], now: Temporal.Instant): number[] {
    return ids.filter((id) => filmDue(this.filmStamps.get(id), this.movieReleases.get(id), now));
  }

  /**
   * Whether any film needs a lookup, answered from memory alone.
   *
   * Public, and asked by `Orchestrator` rather than decided here: the quiet-poll
   * early return needs the answer *before* it knows whether it will resolve
   * anything. The state and the work live here; the decision does not.
   */
  filmsDue(library: Library | null): boolean {
    return this.filmsToResolve(plannedFilmIds(library), Temporal.Now.instant()).length > 0;
  }

  /**
   * FETCH, per film. Returns whether the round was complete — an incomplete one
   * must arm the caller's retry.
   *
   * Deliberately *not* wrapped in a try/catch, which looks like an obvious
   * tidy-up now that films live here. These are SIMKL calls, so an account-level
   * failure belongs in `errors.library` and must reach the caller: swallowing it
   * would make a revoked token during film lookups report nothing at all.
   */
  async resolveFilms(library: Library | null, { signal }: { signal: AbortSignal }): Promise<boolean> {
    const now = Temporal.Now.instant();
    const filmIds = plannedFilmIds(library);
    const due = this.filmsToResolve(filmIds, now);
    const requested = new Set(due);
    const lookups = await fetchMovieReleases(due, { signal });
    const { releases, complete } = reconcileReleases(this.movieReleases, filmIds, requested, lookups);
    this.movieReleases = releases;

    // Stamped per id, and only where retrying cannot help: a film whose stamp is
    // not refreshed stays due, which is the whole retry mechanism.
    // `unavailable` is stamped because it is a settled answer — the id is gone
    // upstream and fails identically forever, so leaving it unstamped would ask
    // about it on every poll for good.
    const retryable = new Set(lookups.failed);
    for (const id of due) if (!retryable.has(id)) this.filmStamps.set(id, now);
    // Films off the list must not hold their stamps, or re-adding one would find
    // it fresh and never look it up. Still being planned is the whole test — a
    // planned film with no announced date is absent from `releases` and has to
    // keep its stamp, or the refresh floor would never hold for it.
    const planned = new Set(filmIds);
    for (const id of this.filmStamps.keys()) if (!planned.has(id)) this.filmStamps.delete(id);

    // The threaded instant, not a fresh read: the round is stamped with when it
    // started, which is what `filmDue` measures its floor from.
    if (complete) this.filmsResolvedAt = isoOf(now);

    if (due.length) this.log.info(`resolved ${lookups.releases.size}/${due.length} film release dates`);
    if (lookups.unavailable.length) {
      this.log.warn(`${lookups.unavailable.length} film ids are gone upstream: ${lookups.unavailable.join(', ')}`);
    }
    return complete;
  }

  /**
   * JOIN → RENDER → SAVE, with any failure contained in `errors.render` rather
   * than the caller's slot.
   *
   * Serialised: both refresh timers end here, and at the default intervals the
   * library polls twelve times to each calendar refresh — so every calendar tick
   * lands on a poll, and overlapping runs are the norm rather than an edge case.
   * Unserialised they would race on the disk save. The library is captured when
   * this is *called* rather than when the queued render runs, so a render
   * renders what its caller had.
   */
  render(library: Library | null): Promise<void> {
    this.rendering = this.rendering.then(() => this.renderAndSave(library));
    return this.rendering;
  }

  private async renderAndSave(library: Library | null): Promise<void> {
    let rendered = false;
    try {
      rendered = this.renderNow(library);
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
  private renderNow(library: Library | null): boolean {
    if (!this.calendars || !library) return false;
    this.events = join(payloads(this.calendars), library, { movieReleases: this.movieReleases });
    this.ics = renderIcs(this.events, { name: FEED_NAME });
    this.renderedAt = nowIso();
    this.log.info(`rendered ${this.events.length} events`);
    return true;
  }
}
