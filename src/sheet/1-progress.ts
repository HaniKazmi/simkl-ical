/**
 * INDEX — what SIMKL says was watched, reduced to the shape the planner needs.
 * Pure.
 *
 * First, and before the spreadsheet is even read: `sync.ts` indexes the library
 * as its cheap early-out — an empty index means there is nothing this run could
 * write, so the grid read never happens. `2-grid.ts` parses the sheet, and
 * `3-plan.ts` needs both.
 *
 * Two sources, answering two different questions. The library says what was
 * *watched* and never what *exists*; `/tv/episodes/{id}` says what exists and
 * never what was watched. Season completeness needs both, which is why neither
 * can be dropped.
 *
 * Season 0 is excluded from both sides of every comparison. It is specials, the
 * user maintains those by hand, and including it makes a complete season look
 * incomplete forever — South Park's episode list holds 338 against a watched
 * count of 331, and season 0 holds exactly 7.
 */

import { instantFrom, MS_PER_DAY, plainDateIn } from '../shared/dates.ts';
import { itemStatus } from '../api/simkl/item.ts';
import type { EpisodeDetail, LibraryItem } from '../api/simkl/types.ts';
import type { Library } from '../library.ts';

// --- Timestamps ------------------------------------------------------------

/** Sheets counts days from 1899-12-30. */
const EPOCH_MS = Date.UTC(1899, 11, 30);

/**
 * A usable instant, or null.
 *
 * Thin over `instantFrom`, which owns the parse and SIMKL's one quirk — a space
 * where the `T` belongs. Kept as a name here because "what the sheet accepts
 * from a watch record" is a question about this pipeline, and the planner never
 * throws: an unusable timestamp costs that episode's date, not the run.
 */
export const normaliseInstant = (raw: string | null | undefined): Temporal.Instant | null => instantFrom(raw);

/**
 * Days since the sheet epoch for a local calendar date.
 *
 * Still arithmetic on a UTC instant rather than a Temporal duration: the output
 * is a Sheets serial, a number of whole days since 1899-12-30, and `PlainDate`
 * offers no epoch-day accessor that would shorten this.
 */
export const dateSerial = (date: Temporal.PlainDate): number =>
  Math.round((Date.UTC(date.year, date.month - 1, date.day) - EPOCH_MS) / MS_PER_DAY);

/**
 * The sheet serial for a watch timestamp, in the viewer's zone — never
 * `iso.slice(0, 10)`, which lands a US evening broadcast on the following day.
 * Returns null rather than throwing, because the planner never throws.
 */
export const watchSerial = (at: Temporal.Instant | null | undefined, timezone: string): number | null =>
  at ? dateSerial(plainDateIn(at, timezone)) : null;

/** Per-episode minutes → the day fraction the `Episodes` column holds on a season row. */
export const runtimeDays = (minutes: number | null | undefined): number | null =>
  typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes / 1440 : null;

// --- Library ---------------------------------------------------------------

export interface SeasonProgress {
  number: number;
  /** Episodes with a real `watched_at`. The number the sheet's `Episode` column holds. */
  watched: number;
  firstWatchedAt: Temporal.Instant | null;
  lastWatchedAt: Temporal.Instant | null;
}

export interface TitleProgress {
  id: number;
  title: string;
  /** `item.status` — the only membership there is, one record per title. */
  status: string | null;
  lastWatchedAt: Temporal.Instant | null;
  watchedCount: number;
  totalCount: number;
  notAiredCount: number;
  seasons: Map<number, SeasonProgress>;
}

/**
 * Watched episodes per numbered season, with their first and last timestamps.
 *
 * Counted with a null filter on `watched_at`. SIMKL's reference says
 * `include_all_episodes=yes` can fill in virtual rows stamped with the show's
 * last-watched time. Live data does not appear to do it, but the filter is free
 * and the entire value of the sync rests on this number.
 */
export const seasonsOf = (item: LibraryItem): Map<number, SeasonProgress> => {
  const out = new Map<number, SeasonProgress>();
  for (const season of item.seasons ?? []) {
    if (!Number.isInteger(season.number) || season.number <= 0) continue;
    let watched = 0;
    let first: Temporal.Instant | null = null;
    let last: Temporal.Instant | null = null;
    for (const episode of season.episodes ?? []) {
      const at = normaliseInstant(episode.watched_at);
      if (at === null) continue;
      watched += 1;
      // Instants, so this is a comparison of values rather than of the strings
      // they happened to arrive as.
      if (first === null || Temporal.Instant.compare(at, first) < 0) first = at;
      if (last === null || Temporal.Instant.compare(at, last) > 0) last = at;
    }
    out.set(season.number, { number: season.number, watched, firstWatchedAt: first, lastWatchedAt: last });
  }
  return out;
};

/**
 * Every show and anime in the library, keyed by SIMKL id.
 *
 * Films are skipped: they have no seasons, so the whole block model is
 * inapplicable.
 *
 * One record per title, so there is nothing to reconcile here: a status move
 * arrives as a replacement of the record, not as a second copy alongside it.
 */
export const indexLibrary = (library: Library | null | undefined): Map<number, TitleProgress> => {
  const out = new Map<number, TitleProgress>();
  for (const [id, { type, item }] of library ?? []) {
    if (type === 'movies') continue;
    out.set(id, {
      id,
      title: item.show?.title ?? item.movie?.title ?? String(id),
      status: itemStatus(item),
      lastWatchedAt: normaliseInstant(item.last_watched_at),
      watchedCount: item.watched_episodes_count ?? 0,
      totalCount: item.total_episodes_count ?? 0,
      notAiredCount: item.not_aired_episodes_count ?? 0,
      seasons: seasonsOf(item),
    });
  }
  return out;
};

// --- Catalogue -------------------------------------------------------------

export interface SeasonShape {
  number: number;
  /** Episodes SIMKL knows about, specials excluded. */
  total: number;
  /** Of those, ones that have aired. `aired < total` means the season is still running. */
  aired: number;
}

/**
 * Per-season counts from `/tv/episodes/{id}`.
 *
 * Specials are dropped rather than counted into season 0, because a special
 * filed under a numbered season would inflate that season's `total` and block
 * its end date forever — a failure indistinguishable from correctly declining
 * to write.
 */
export const seasonShapes = (episodes: EpisodeDetail[] | null | undefined): Map<number, SeasonShape> => {
  const out = new Map<number, SeasonShape>();
  for (const episode of episodes ?? []) {
    if (episode.type && episode.type.toLowerCase() !== 'episode') continue;
    const number = episode.season;
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) continue;
    const shape = out.get(number) ?? { number, total: 0, aired: 0 };
    shape.total += 1;
    if (episode.aired) shape.aired += 1;
    out.set(number, shape);
  }
  return out;
};

/**
 * Whether a season is finished and finished being watched.
 *
 * `aired === total` is not optional. "Every aired episode watched" is the
 * tempting test and it is actively dangerous: a season 7 aired of 10 and all 7
 * watched — Silo S3, mid-run — takes a permanent end date with three episodes
 * still to come. Permanent, because a dated season is never touched again.
 */
export const seasonComplete = (shape: SeasonShape | undefined, watched: number): boolean =>
  shape !== undefined && shape.total > 0 && shape.aired === shape.total && watched >= shape.total;

/**
 * The same question for anime, where the catalogue lookup does not apply: one
 * SIMKL anime entry is one cour, so its own counters describe the whole season.
 */
export const courComplete = (progress: TitleProgress): boolean =>
  progress.totalCount > 0 && progress.notAiredCount === 0 && progress.watchedCount >= progress.totalCount;
