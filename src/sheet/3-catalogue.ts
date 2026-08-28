/**
 * CATALOGUE — what the upstreams say exists, reduced and retained across polls.
 *
 * Third because it sits between PARSE and PLAN: the planner reads this view to
 * decide what to write, and the sync folds fetch results into it between
 * planning passes. Stateful but I/O-free — the fetches live in `io/`, and every
 * rule about *what an answer means* lives here.
 *
 * Two sources, answering two different questions the library cannot:
 * `/tv/episodes/{id}` says which episodes exist and have aired, and TVDB says
 * how long they are. The library says only what was watched.
 */

import { config, tvdbConfigured } from '../shared/config.ts';
import type { EpisodeDetail, ShowDetail } from '../api/simkl/types.ts';
import type { TvdbEpisode } from '../api/tvdb/types.ts';
import type { TitleProgress } from './1-index.ts';
import type { Catalogue, CatalogueRequest } from './io/catalogue.ts';
import { runtimeKeyOf, type RuntimeRequest, type SeasonRuntimes } from './io/runtimes.ts';

// --- Reductions of the raw payloads ----------------------------------------

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

// --- What is retained ------------------------------------------------------

/**
 * What one title's catalogue lookups reduce to. Everything the planner reads,
 * and nothing else: the raw `/tv/episodes/{id}` array is only ever fed to
 * `seasonShapes`, and the detail object is only ever asked for `status` and
 * `runtime`. Deriving at fold-in time computes the shapes once per title
 * instead of once per season row, and keeps per-episode descriptions and images
 * out of a map that lives for the life of the process.
 */
export interface TitleCatalogue {
  shapes: Map<number, SeasonShape>;
  status?: string;
  runtime?: number | null;
  /**
   * The join key to per-episode runtimes. Null where there is no path to one at
   * all — SIMKL carries no TVDB id, or there is no credential to ask with. The
   * planner needs no second switch for the feature, because a row it cannot look
   * up and a row there is no point looking up are the same row to every rule
   * there. **Absent** means the detail call has not answered, which is a
   * different state: dating a row on it forfeits the cell on a 503.
   */
  tvdbId?: number | null;
  /**
   * Season number to its average episode runtime in whole minutes, or null for
   * *asked, and there is no usable answer*.
   *
   * The null matters as much as the number. A key that is present says the
   * question is settled and the row may be closed; a key that is **absent** says
   * the lookup has not answered, and closing the row on that would forfeit the
   * cell forever — a dated row is never revisited. Two collections would let
   * those two states be confused; one map with a nullable value cannot.
   *
   * No age ceiling, unlike the stamps: a finished season's runtimes are
   * terminal, where `/tv/{id}`'s `status` flips on a renewal.
   */
  seasonRuntimes: Map<number, number | null>;
}

/** The planner's read surface: the retained titles, plus this run's failures. */
export interface CatalogueView {
  titles: Map<number, TitleCatalogue>;
  /** Ids whose lookup errored in a way worth retrying. */
  failed: number[];
  unavailable: number[];
}

/**
 * What we already hold for one title's catalogue, and how current it is.
 *
 * `watchedAt` is the value `lastWatchedAt` had when the lookup was made, not
 * when it was stored — comparing it against the library's current value is the
 * whole gate.
 */
export interface CatalogueStamp {
  watchedAt: Temporal.Instant | null;
  /** When the lookup was made. */
  at: Temporal.Instant;
}

/**
 * Whether a title's catalogue needs re-reading.
 *
 * Watch activity is the trigger, because it is the trigger for everything this
 * sync writes. A season cannot become complete without being watched, and
 * watching moves `lastWatchedAt` — so the case that matters always fires.
 *
 * The age ceiling is the backstop for the case that does not: `/tv/{id}` status
 * flipping on a renewal, which produces no library activity at all. Same
 * reasoning as `movieRefresh`, and the same daily cadence — a studio moving a
 * release, or a network renewing a show, changes nothing you could gate on.
 */
export const needsLookup = (
  stamp: CatalogueStamp | undefined,
  progress: TitleProgress | undefined,
  now: Temporal.Instant,
  maxAge: Temporal.Duration | null,
): boolean => {
  if (!stamp) return true;
  // A stamp is stale once `now` has passed it by the ceiling. Null means no
  // ceiling at all, which is what a caller that gates purely on watch activity
  // wants.
  if (maxAge && Temporal.Instant.compare(now, stamp.at.add(maxAge)) > 0) return true;
  // By value. Two `Instant`s for the same moment are different objects, so `!==`
  // here would be true forever and every title would be re-read every poll.
  return !sameInstant(stamp.watchedAt, progress?.lastWatchedAt ?? null);
};

const sameInstant = (a: Temporal.Instant | null, b: Temporal.Instant | null): boolean =>
  a === null || b === null ? a === b : a.equals(b);

/**
 * Catalogue results retained across polls, so the planner always sees a
 * complete picture even though only the titles that moved were re-read.
 *
 * The retention lives here rather than in a cache under `io/catalogue.ts`: the
 * re-read decision needs the library, and the source has no business knowing
 * about it. Process-local, so a restart re-reads everything — which is the
 * right answer after a restart anyway.
 *
 * One stamping discipline for both folds: **a retryable failure is never
 * recorded, so the next poll asks again; a settled answer — including "gone",
 * and including null — always is, because a key left unrecorded would be
 * re-requested on every poll forever.**
 */
export class CatalogueStore {
  private retained = new Map<number, TitleCatalogue>();
  private stampsHeld = new Map<number, CatalogueStamp>();

  get titles(): Map<number, TitleCatalogue> {
    return this.retained;
  }

  get stamps(): Map<number, CatalogueStamp> {
    return this.stampsHeld;
  }

  private entry(id: number): TitleCatalogue {
    const existing = this.retained.get(id) ?? { shapes: new Map(), seasonRuntimes: new Map() };
    this.retained.set(id, existing);
    return existing;
  }

  /**
   * Fold a catalogue fetch into what is held. Derives on the way in: the shapes
   * are computed once per title here rather than once per season row inside the
   * planner.
   */
  foldCatalogue(
    requests: CatalogueRequest[],
    fetched: Catalogue,
    index: Map<number, TitleProgress>,
    { at = Temporal.Now.instant(), tvdbEnabled = tvdbConfigured(config) }: { at?: Temporal.Instant; tvdbEnabled?: boolean } = {},
  ): void {
    for (const [id, episodes] of fetched.episodes) this.entry(id).shapes = seasonShapes(episodes);
    for (const [id, detail] of fetched.details) {
      Object.assign(this.entry(id), {
        status: detail.status,
        runtime: detail.runtime,
        // Withheld without a credential, rather than stored and then ignored: an
        // absent join key is already "no runtime is obtainable for this row" to
        // every rule in the planner, so the planner needs no second switch — and
        // a switch it did have could be set the wrong way and strand every row.
        tvdbId: tvdbEnabled ? tvdbIdOf(detail) : null,
      });
    }

    const stalled = new Set(fetched.failed);
    for (const { id } of requests) {
      if (stalled.has(id)) continue;
      this.stampsHeld.set(id, { watchedAt: index.get(id)?.lastWatchedAt ?? null, at });
    }
  }

  /**
   * Fold a runtime fetch into the same entries. The reduction happens here
   * rather than in the source: the count it checks against is SIMKL's, and one
   * upstream's answer having to agree with another's is a rule about the sheet,
   * not about the call.
   */
  foldRuntimes(requests: RuntimeRequest[], fetched: SeasonRuntimes): void {
    const stalled = new Set(fetched.failed);
    for (const request of requests) {
      const key = runtimeKeyOf(request.tvdbId, request.season);
      if (stalled.has(key)) continue;
      const entry = this.retained.get(request.id);
      const expected = entry?.shapes.get(request.season)?.total ?? 0;
      entry?.seasonRuntimes.set(request.season, averageRuntime(fetched.episodes.get(key), expected));
    }
  }

  /**
   * Record every pending season as settled-with-nothing, which closes its row
   * with the cell blank for good.
   *
   * This is the answer to a **rejected credential**: no number of polls makes a
   * typo start answering, and leaving the seasons pending instead means every
   * completing season stays open for ever and the sheet quietly stops being
   * dated at all — strictly worse than never setting the key. A restart
   * re-reads everything, so a corrected key is one restart away rather than
   * lost. An *outage* must never come through here: that is a wait, not an
   * answer.
   */
  settleSeasonsUnusable(requests: RuntimeRequest[]): void {
    for (const request of requests) this.retained.get(request.id)?.seasonRuntimes.set(request.season, null);
  }
}
