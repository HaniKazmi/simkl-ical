/**
 * INDEX — what SIMKL says was watched, reduced to the shape the planner needs.
 * Pure.
 *
 * Runs before the spreadsheet is read: `sync.ts` uses an empty index as its
 * early-out, so the grid read never happens when there is nothing to write.
 *
 * The library says what was *watched*, never what *exists*; what exists comes
 * from the catalogue (`3-catalogue.ts`). Season completeness needs both.
 *
 * Season 0 is excluded: it is specials, maintained by hand, and including it
 * makes a complete season look incomplete forever — South Park's episode list
 * holds 338 against a watched count of 331, and season 0 holds exactly 7.
 */

import { instantFrom } from '../shared/dates.ts';
import { itemStatus } from '../api/simkl/item.ts';
import type { LibraryItem } from '../api/simkl/types.ts';
import type { Library } from '../library.ts';

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
 * Counted with a null filter on `watched_at`: SIMKL's reference says
 * `include_all_episodes=yes` can fill in virtual rows stamped with the show's
 * last-watched time. Live data does not appear to, but the filter is free and
 * the sync's whole value rests on this number.
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
      // Instants: compared as values, not as the strings they arrived as.
      if (first === null || Temporal.Instant.compare(at, first) < 0) first = at;
      if (last === null || Temporal.Instant.compare(at, last) > 0) last = at;
    }
    out.set(season.number, { number: season.number, watched, firstWatchedAt: first, lastWatchedAt: last });
  }
  return out;
};

/**
 * Every show and anime in the library, keyed by SIMKL id. Films are skipped:
 * no seasons, so the block model does not apply.
 *
 * One record per title, so nothing to reconcile: a status move arrives as a
 * replacement, not a second copy.
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

/**
 * Whether an anime entry is finished and finished being watched, from its own
 * counters: one SIMKL anime entry is one cour, so no catalogue lookup applies.
 */
export const courComplete = (progress: TitleProgress): boolean =>
  progress.totalCount > 0 && progress.notAiredCount === 0 && progress.watchedCount >= progress.totalCount;
