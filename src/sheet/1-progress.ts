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

import { instantFrom, plainDateIn } from '../shared/dates.ts';
import { itemStatus } from '../api/simkl/item.ts';
import type { EpisodeDetail, LibraryItem, ShowDetail } from '../api/simkl/types.ts';
import type { TvdbEpisode } from '../api/tvdb/types.ts';
import type { Library } from '../library.ts';

// --- Timestamps ------------------------------------------------------------

/** Sheets counts days from 1899-12-30. */
const SHEET_EPOCH = Temporal.PlainDate.from('1899-12-30');

/**
 * Days since the sheet epoch for a local calendar date.
 *
 * A count of whole days between two dates, which is what a Sheets serial is —
 * no instants, no zone, and nothing to round. Both operands are `PlainDate`, so
 * there is no hour that could make the difference come out fractional.
 */
export const dateSerial = (date: Temporal.PlainDate): number => SHEET_EPOCH.until(date, { largestUnit: 'day' }).days;

/**
 * The sheet serial for a watch timestamp, in the viewer's zone — never
 * `iso.slice(0, 10)`, which lands a US evening broadcast on the following day.
 * Returns null rather than throwing, because the planner never throws.
 */
export const watchSerial = (at: Temporal.Instant | null | undefined, timezone: string): number | null =>
  at ? dateSerial(plainDateIn(at, timezone)) : null;

/**
 * Per-episode minutes → the day fraction the `Episodes` column holds on a season
 * row, or null where that is not a length an episode has.
 *
 * Bounded at both ends, and the upper one matters: a day or more is not a
 * runtime, and a value at or above 1 written into this column multiplies every
 * `Length` in the block by 1440. The guard refuses one too, but refusal is
 * whole-plan — so a single title with bad upstream data would stop every
 * unrelated edit in the run, every poll, for as long as its row sat inside the
 * activity window. Returning null here makes it one skipped cell instead.
 *
 * The lower bound is a whole minute rather than anything above zero, and it is
 * the guard's bound exactly. Any gap between the two is a value the planner
 * emits and the guard then refuses, which is the whole-plan refusal this
 * function exists to avoid — reachable because an insert writes SIMKL's
 * show-wide runtime through here unrounded, where an average arrives whole.
 */
export const runtimeDays = (minutes: number | null | undefined): number | null =>
  typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 1 && minutes < 1440 ? minutes / 1440 : null;

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
      const at = instantFrom(episode.watched_at);
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
      lastWatchedAt: instantFrom(item.last_watched_at),
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
 * Whether a season has finished *airing* — nothing about who has watched it.
 *
 * Split out because the two halves of `seasonComplete` answer questions that are
 * not the same question. How long the episodes are is settled the moment the
 * last one airs, and stays settled however little of it anyone has seen; when
 * the row may be dated depends on the watching. Asking the airing question with
 * the watching one attached is what leaves a finished season's runtime unasked
 * for as long as it sits part-watched.
 *
 * It is also the exact gate the runtime average needs: `averageRuntime` checks
 * TVDB's episode count against SIMKL's, and SIMKL's is only settled once the
 * season has stopped gaining episodes.
 */
export const seasonAired = (shape: SeasonShape | undefined): shape is SeasonShape =>
  shape !== undefined && shape.total > 0 && shape.aired === shape.total;

/**
 * Whether a season is finished and finished being watched.
 *
 * `aired === total` is not optional. "Every aired episode watched" is the
 * tempting test and it is actively dangerous: a season 7 aired of 10 and all 7
 * watched — Silo S3, mid-run — takes a permanent end date with three episodes
 * still to come. Permanent, because a dated season is never touched again.
 */
export const seasonComplete = (shape: SeasonShape | undefined, watched: number): boolean =>
  seasonAired(shape) && watched >= shape.total;

/**
 * The same question for anime, where the catalogue lookup does not apply: one
 * SIMKL anime entry is one cour, so its own counters describe the whole season.
 */
export const courComplete = (progress: TitleProgress): boolean =>
  progress.totalCount > 0 && progress.notAiredCount === 0 && progress.watchedCount >= progress.totalCount;

// --- Runtimes --------------------------------------------------------------

/**
 * The TVDB id off a SIMKL detail record, or null.
 *
 * SIMKL sends it as a string. A non-numeric or absent one is "no TVDB id", never
 * an error: the runtime lookup is additive, and a title without one simply keeps
 * its `Episodes` cell blank.
 */
export const tvdbIdOf = (detail: ShowDetail | undefined): number | null => {
  const raw = detail?.ids?.tvdb;
  if (typeof raw !== 'string') return null;
  const id = Number(raw.trim());
  return Number.isInteger(id) && id > 0 ? id : null;
};

/**
 * A season's average episode runtime in whole minutes, or null if there is no
 * usable answer.
 *
 * **The arithmetic mean, and that is forced rather than chosen.** The sheet
 * computes `Length = Episodes x Episode`, where `Episode` is the count watched,
 * so for a season's total to come out right `Episodes` has to be total minutes
 * divided by the count — which is the mean and nothing else. 21 episodes at 22m
 * plus a 44m finale is 506 minutes; the mean is exactly 23, and 23 x 22 = 506.
 * A median would be robust to that finale and would make the total wrong.
 *
 * `expected` is SIMKL's own count for the season, from `seasonShapes`. Requiring
 * it to match is the cheap evidence that TVDB's season *n* is the same season
 * the sheet's row means, and it is also what keeps the mean-times-count identity
 * exact. It is a backstop against future drift rather than the main protection:
 * on anime it agrees 12 times in 29 while describing a different season
 * entirely, which is why the planner never asks about an anime row at all.
 */
export const averageRuntime = (episodes: TvdbEpisode[] | null | undefined, expected: number): number | null => {
  // A film filed inside a numbered season is the one contaminant asking for a
  // single season does not exclude. Deduplicated on `number` because TVDB
  // occasionally lists a record twice, which would weight that episode double.
  const byNumber = new Map<number, number | null | undefined>();
  for (const episode of episodes ?? []) {
    if (episode.isMovie) continue;
    if (typeof episode.number !== 'number') continue;
    // A usable duplicate wins over an unusable one, whichever came first. One
    // missing runtime refuses the whole season below, and that refusal is
    // recorded as settled — so taking the null when a real length was sitting in
    // the same payload forfeits the cell permanently.
    const held = byNumber.get(episode.number);
    if (typeof held === 'number' && held > 0) continue;
    byNumber.set(episode.number, episode.runtime);
  }
  // Season counts must agree before anything is averaged, so a season that is
  // not the one the row means is refused rather than averaged confidently. This
  // also covers the empty list a season TVDB does not have comes back as.
  if (expected <= 0 || byNumber.size !== expected) return null;

  let total = 0;
  for (const runtime of byNumber.values()) {
    // Null is "TVDB does not know", never a zero-length episode — averaging it
    // in as zero drags the mean down. Same filter as `seasonsOf` on a null
    // `watched_at`, and for the same reason.
    //
    // One missing runtime refuses the season outright. It has finished airing —
    // that is the only reason an end date is being written — so a hole is not a
    // season still filling in, and extrapolating over it would be a guess frozen
    // into a cell nothing revisits.
    if (typeof runtime !== 'number' || !Number.isFinite(runtime) || runtime <= 0) return null;
    total += runtime;
  }

  // Whole minutes, so the cell holds the same kind of number every other row
  // does and a reader can check it against TVDB by eye. Rounding here also fails
  // closed for free: a mean under 30 seconds rounds to 0, and `runtimeDays`
  // returns null for anything not above zero.
  return Math.round(total / byNumber.size);
};
