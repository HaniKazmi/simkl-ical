/**
 * What SIMKL says was watched, reduced to the shape the planner needs. Pure.
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

import { localDate, MS_PER_DAY } from '../shared/dates.ts';
import { itemSimklId, itemStatus } from '../simkl/item.ts';
import type { EpisodeDetail, Library, LibraryItem, ListKey } from '../simkl/types.ts';

// --- Timestamps ------------------------------------------------------------

/** Sheets counts days from 1899-12-30. */
const EPOCH_MS = Date.UTC(1899, 11, 30);

/**
 * A usable ISO instant, or null.
 *
 * Validation happens *before* any conversion, not after: `localDate` ends in
 * `Intl.DateTimeFormat.prototype.format`, which **throws RangeError** on an
 * invalid Date rather than returning something a NaN check could catch. SIMKL
 * occasionally emits `"2026-08-14 21:03:12Z"` with a space where the `T`
 * belongs, and `Date.parse` on that is implementation-defined.
 */
export const normaliseInstant = (raw: string | null | undefined): string | null => {
  if (typeof raw !== 'string') return null;
  const iso = raw.trim().replace(' ', 'T');
  if (!iso) return null;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
};

/** Days since the sheet epoch for a local calendar date. */
export const dateSerial = (ymd: string): number => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH_MS) / MS_PER_DAY);
};

/**
 * The sheet serial for a watch timestamp, in the viewer's zone — never
 * `iso.slice(0, 10)`, which lands a US evening broadcast on the following day.
 * Returns null rather than throwing, because the planner never throws.
 */
export const watchSerial = (raw: string | null | undefined, timezone: string): number | null => {
  const iso = normaliseInstant(raw);
  return iso === null ? null : dateSerial(localDate(iso, timezone));
};

/** Per-episode minutes → the day fraction the `Episodes` column holds on a season row. */
export const runtimeDays = (minutes: number | null | undefined): number | null =>
  typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes / 1440 : null;

// --- Library ---------------------------------------------------------------

export interface SeasonProgress {
  number: number;
  /** Episodes with a real `watched_at`. The number the sheet's `Episode` column holds. */
  watched: number;
  firstWatchedAt: string | null;
  lastWatchedAt: string | null;
}

export interface TitleProgress {
  id: number;
  title: string;
  /**
   * `item.status`, never which list it arrived in. List membership goes stale:
   * a move is reported only against the list it moved *to*, so an un-dropped
   * show sits in both `watching` and `dropped` until something else evicts it.
   */
  status: string | null;
  lastWatchedAt: string | null;
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
    let first: string | null = null;
    let last: string | null = null;
    for (const episode of season.episodes ?? []) {
      const at = normaliseInstant(episode.watched_at);
      if (at === null) continue;
      watched += 1;
      if (first === null || at < first) first = at;
      if (last === null || at > last) last = at;
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
 * A title appearing in two lists — which happens, because a move is only
 * reported against its destination — keeps whichever entry has the later
 * `last_watched_at`. On a tie the copy whose list matches the item's own
 * `status` wins, because that is the field that says which list is current.
 * Without that tie-break the first list in `LISTS` order wins, which is
 * `watching`: a watching→dropped move with no new watches leaves both copies
 * carrying the same timestamp, and the sheet keeps saying Watching forever.
 */
export const indexLibrary = (library: Library | null | undefined): Map<number, TitleProgress> => {
  const out = new Map<number, TitleProgress>();
  if (!library) return out;
  const picked = new Map<number, { at: string; authoritative: boolean }>();

  for (const [key, list] of Object.entries(library) as Array<[ListKey, Library[ListKey]]>) {
    if (key.startsWith('movies_')) continue;
    // `shows_dropped` → `dropped`, the status this list *is*.
    const listStatus = key.slice(key.indexOf('_') + 1);

    for (const item of [...(list?.shows ?? []), ...(list?.anime ?? [])]) {
      const id = itemSimklId(item);
      if (id === null) continue;

      const lastWatchedAt = normaliseInstant(item.last_watched_at);
      const status = itemStatus(item);
      const at = lastWatchedAt ?? '';
      const authoritative = status === listStatus;

      const current = picked.get(id);
      if (current && (current.at > at || (current.at === at && (current.authoritative || !authoritative)))) continue;
      picked.set(id, { at, authoritative });

      out.set(id, {
        id,
        title: item.show?.title ?? item.movie?.title ?? String(id),
        status,
        lastWatchedAt,
        watchedCount: item.watched_episodes_count ?? 0,
        totalCount: item.total_episodes_count ?? 0,
        notAiredCount: item.not_aired_episodes_count ?? 0,
        seasons: seasonsOf(item),
      });
    }
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
