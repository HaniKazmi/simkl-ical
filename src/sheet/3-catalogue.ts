/**
 * CATALOGUE — what the upstreams say exists, reduced and retained across polls.
 *
 * Sits between PARSE and PLAN: the planner reads this view, and the sync folds
 * fetch results into it between planning passes. Stateful but I/O-free — the
 * fetches live in `io/`; every rule about what an answer *means* lives here.
 *
 * Four sources answer what the library cannot, which says only what was
 * watched: `/tv/episodes/{id}` says which episodes exist and have aired,
 * `/tv/{id}` how long one runs and who broadcasts it, TVDB how long a season's
 * episodes are and which genres a series is filed under, TMDB what it is
 * certificated at.
 */

import { config, tvdbConfigured } from '../shared/config.ts';
import { certificateFor, mappedTvdbGenres, networkCell } from './values.ts';
import type { EpisodeDetail } from '../api/simkl/types.ts';
import type { TvdbEpisode } from '../api/tvdb/types.ts';
import type { TitleProgress } from './1-index.ts';
import type { Catalogue, CatalogueRequest } from './io/catalogue.ts';
import { runtimeKeyOf, type RuntimeRequest, type SeasonRuntimes } from './io/runtimes.ts';
import type { SeriesGenres, SeriesRequest } from './io/tvdb-series.ts';
import type { CertificateRequest, ShowCertificates } from './io/tmdb-tv.ts';

/**
 * Which upstream a show-facts lookup asked. Named because a rejection is
 * reported by name — "fix `TVDB_API_KEY` and restart" is the whole of what the
 * operator can do about one.
 */
export type FactsCredential = 'tvdb' | 'tmdb';

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
 * Specials are dropped: one filed under a numbered season would inflate that
 * season's `total` and block its end date forever — indistinguishable from
 * correctly declining to write.
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
 * Split from `seasonComplete` because the halves answer different questions:
 * episode lengths settle the moment the last one airs, however little anyone
 * has seen; when the row may be dated depends on the watching. Bundling them
 * leaves a finished season's runtime unasked while it sits part-watched.
 *
 * Also the exact gate `averageRuntime` needs: it checks TVDB's episode count
 * against SIMKL's, and SIMKL's only settles once the season stops gaining
 * episodes.
 */
export const seasonAired = (shape: SeasonShape | undefined): shape is SeasonShape =>
  shape !== undefined && shape.total > 0 && shape.aired === shape.total;

/**
 * Whether a season is finished and finished being watched.
 *
 * `aired === total` is not optional. "Every aired episode watched" is the
 * tempting test and it is dangerous: a season 7 aired of 10 and all 7 watched
 * — Silo S3, mid-run — takes a permanent end date with three episodes still
 * to come. Permanent, because a dated season is never touched again.
 */
export const seasonComplete = (shape: SeasonShape | undefined, watched: number): boolean =>
  seasonAired(shape) && watched >= shape.total;

/**
 * SIMKL sends every external id as a string. Anything that is not a positive
 * whole number is "no id", never an error — every lookup keyed on one is
 * additive, and a title without one leaves a cell blank rather than failing.
 *
 * Exported for the films half, which reads the same field off a film record.
 * One parse, so a value one half files as an id cannot be one the other files
 * as no id at all.
 */
export const externalId = (raw: string | undefined): number | null => {
  if (typeof raw !== 'string') return null;
  const id = Number(raw.trim());
  return Number.isInteger(id) && id > 0 ? id : null;
};

/**
 * The TVDB id off a SIMKL record — a detail, or a library title — or null. The
 * join key to the per-episode runtimes.
 */
export const tvdbIdOf = (detail: { ids?: { tvdb?: string } } | undefined): number | null => externalId(detail?.ids?.tvdb);

/**
 * The TMDB id off the same record, or null. The join key to a series'
 * certificate. Present on all 189 TV shows measured.
 */
export const tmdbIdOf = (detail: { ids?: { tmdb?: string } } | undefined): number | null => externalId(detail?.ids?.tmdb);

/**
 * Whether `/tv/{id}` has answered for a title: the one question every rule
 * that waits on the detail asks, spelled once.
 *
 * Read off `tvdbId` because `foldCatalogue` stamps it as a number or an
 * explicit null the moment the detail lands, and never before — so absent
 * reliably means the call is still outstanding, where `status` or `title` can
 * be absent on an answered record. `tmdbId` lands in the same assignment, so
 * one field answers for both keys. Spelled per site, a change to what the fold
 * stamps would leave some readers holding a title in scope, at a lookup a day,
 * for an answer that had already come back.
 */
export const detailAnswered = (entry: TitleCatalogue | undefined): entry is AnsweredCatalogue => entry?.tvdbId !== undefined;

/** A title whose detail has landed: both join keys present, as a number or a settled null. */
export type AnsweredCatalogue = TitleCatalogue & { tvdbId: number | null; tmdbId: number | null };

/**
 * A season's average episode runtime in whole minutes, or null with no usable
 * answer.
 *
 * **The arithmetic mean, forced rather than chosen.** The runtime sits beside
 * the episode count, and a season's total is the two multiplied — so for that
 * total to come out right the cell must be total minutes divided by the count,
 * which is the mean and nothing else. 21 episodes at 22m plus a 44m finale is
 * 506 minutes; the mean is exactly 23, and 23 x 22 = 506. A median would be
 * robust to that finale and make the total wrong.
 *
 * `expected` is SIMKL's own count for the season, from `seasonShapes`.
 * Requiring a match is cheap evidence that TVDB's season *n* is the season the
 * row means, and keeps the mean-times-count identity exact. A backstop, not
 * the main protection: on anime it agrees 12 times in 29 while describing a
 * different season entirely, so the planner never asks about an anime row.
 */
export const averageRuntime = (episodes: TvdbEpisode[] | null | undefined, expected: number): number | null => {
  // A film filed inside a numbered season is the one contaminant a
  // single-season request does not exclude. Deduplicated on `number`: TVDB
  // occasionally lists a record twice, which would weight that episode double.
  const byNumber = new Map<number, number | null | undefined>();
  for (const episode of episodes ?? []) {
    if (episode.isMovie) continue;
    if (typeof episode.number !== 'number') continue;
    // A usable duplicate wins over an unusable one, whichever came first. One
    // missing runtime refuses the whole season below, recorded as settled —
    // taking the null when a real length sat in the same payload forfeits the
    // cell permanently.
    const held = byNumber.get(episode.number);
    if (typeof held === 'number' && held > 0) continue;
    byNumber.set(episode.number, episode.runtime);
  }
  // Counts must agree before anything is averaged: a season that is not the
  // one the row means is refused, not averaged confidently. Also covers the
  // empty list a season TVDB does not have comes back as.
  if (expected <= 0 || byNumber.size !== expected) return null;

  let total = 0;
  for (const runtime of byNumber.values()) {
    // Null is "TVDB does not know", never a zero-length episode — averaged in
    // as zero it drags the mean down. Same filter as `seasonsOf` on a null
    // `watched_at`.
    //
    // One missing runtime refuses the season outright. The season has finished
    // airing — the only reason an end date is being written — so a hole is not
    // a season still filling in, and extrapolating over it freezes a guess
    // into a cell nothing revisits.
    if (typeof runtime !== 'number' || !Number.isFinite(runtime) || runtime <= 0) return null;
    total += runtime;
  }

  // Whole minutes, so the cell matches every other row and a reader can check
  // it against TVDB by eye. Rounding also fails closed for free: a mean under
  // 30 seconds rounds to 0, which `plausibleRuntime` refuses.
  return Math.round(total / byNumber.size);
};

// --- What is retained ------------------------------------------------------

/**
 * What one title's catalogue lookups reduce to — everything the planner reads
 * and nothing else. Deriving at fold-in time computes the shapes once per
 * title instead of once per season row, and keeps per-episode descriptions
 * and images out of a map that lives for the life of the process.
 */
export interface TitleCatalogue {
  shapes: Map<number, SeasonShape>;
  status?: string;
  runtime?: number | null;
  /**
   * The join key to per-episode runtimes. Null where no path to one exists —
   * SIMKL carries no TVDB id, or there is no credential to ask with — so the
   * planner needs no second feature switch: a row it cannot look up and one
   * not worth looking up are the same row to every rule. **Absent** means the
   * detail call has not answered — a different state: dating a row on it
   * forfeits the cell on a 503.
   */
  tvdbId?: number | null;
  /**
   * The join key to a series' certificate. Folded **unconditionally**, where
   * `tvdbId` is withheld without a credential, because the two nulls reach the
   * planner as different sentences. No TVDB id means a runtime cell stays
   * blank, which is the right silent default on an install with no key; no TMDB
   * id means "add this block by hand", which is the wrong instruction when the
   * fix is setting `TMDB_API_KEY`. The planner gates the block on the
   * credential instead, and says so.
   */
  tmdbId?: number | null;
  /**
   * SIMKL's own title for the show, which a new block's `Show` cell is written
   * from — 166 of 189 exact against the tab, 183 ignoring case and a leading
   * `The`. Absent until the detail answers.
   */
  title?: string;
  /**
   * The `Network` cell, already in the tab's spelling. Null where SIMKL names
   * no broadcaster, which leaves the cell blank.
   */
  network?: string | null;
  /**
   * TVDB's genres reduced to the tab's vocabulary, in the order TVDB sent
   * them: the first is the block's `Genre` and the rest its `Genres`.
   *
   * Three states, and the planner reads all three. **Absent**: the lookup has
   * not answered, so the block waits a poll. **Null**: it answered that nothing
   * is obtainable — no TVDB id, or a 404 — so the block may land with the cells
   * blank. An **empty array**: TVDB has the series and none of its genres is in
   * the vocabulary, which is settled the same way.
   */
  genres?: string[] | null;
  /**
   * The `Certificate` cell — the GB rating as a minimum age. Same three states
   * as `genres`: absent is unanswered, null is settled with nothing to write,
   * which is a series TMDB carries no GB entry for as well as a 404.
   */
  certificate?: number | null;
  /**
   * Season number → average episode runtime in whole minutes, or null for
   * *asked, no usable answer*.
   *
   * The null matters as much as the number. A present key says the question is
   * settled and the row may close; an **absent** key says the lookup has not
   * answered, and closing on that forfeits the cell forever — a dated row is
   * never revisited. One map with a nullable value cannot confuse the two
   * states; two collections could.
   *
   * No age ceiling, unlike the stamps: a finished season's runtimes are
   * terminal, where `/tv/{id}`'s `status` flips on a renewal.
   */
  seasonRuntimes: Map<number, number | null>;
}

/**
 * How long a title's catalogue is trusted without watch activity to prompt a
 * re-read. Daily, like `movieRefresh`: a network renewing a show produces
 * nothing in your library to gate on.
 */
export const CATALOGUE_MAX_AGE = Temporal.Duration.from({ hours: 24 });

/**
 * What is held for one title's catalogue, and how current it is.
 *
 * `watchedAt` is the value `lastWatchedAt` had when the lookup was made;
 * comparing it against the library's current value is the whole gate.
 */
export interface CatalogueStamp {
  watchedAt: Temporal.Instant | null;
  /** When the lookup was made. */
  at: Temporal.Instant;
}

/**
 * Whether a title's catalogue needs re-reading.
 *
 * Watch activity is the trigger: a season cannot become complete without being
 * watched, and watching moves `lastWatchedAt`, so the case that matters always
 * fires.
 *
 * The age ceiling backstops the case that does not: `/tv/{id}` status flipping
 * on a renewal, which produces no library activity at all. Same daily cadence
 * as `movieRefresh`.
 */
export const needsLookup = (
  stamp: CatalogueStamp | undefined,
  progress: TitleProgress | undefined,
  now: Temporal.Instant,
  maxAge: Temporal.Duration | null,
): boolean => {
  if (!stamp) return true;
  // Stale once `now` has passed the stamp by the ceiling. Null means no
  // ceiling — for a caller that gates purely on watch activity.
  if (maxAge && Temporal.Instant.compare(now, stamp.at.add(maxAge)) > 0) return true;
  // By value: two `Instant`s for the same moment are different objects, so
  // `!==` would be true forever and every title re-read every poll.
  return !sameInstant(stamp.watchedAt, progress?.lastWatchedAt ?? null);
};

const sameInstant = (a: Temporal.Instant | null, b: Temporal.Instant | null): boolean =>
  a === null || b === null ? a === b : a.equals(b);

/**
 * Catalogue results retained across polls, so the planner sees a complete
 * picture even though only the titles that moved were re-read.
 *
 * Retention lives here rather than in a cache under `io/catalogue.ts`: the
 * re-read decision needs the library, which the source has no business
 * knowing. Process-local, so a restart re-reads everything — the right answer
 * after a restart anyway.
 *
 * One stamping discipline for every fold: **a retryable failure is never
 * recorded, so the next poll asks again; a settled answer — "gone" and null
 * included — always is, because an unrecorded key would be re-requested every
 * poll forever.**
 */
export class CatalogueStore {
  readonly titles = new Map<number, TitleCatalogue>();
  readonly stamps = new Map<number, CatalogueStamp>();

  private entry(id: number): TitleCatalogue {
    const existing = this.titles.get(id) ?? { shapes: new Map(), seasonRuntimes: new Map() };
    this.titles.set(id, existing);
    return existing;
  }

  /**
   * Fold a catalogue fetch into what is held. Derives on the way in: shapes
   * are computed once per title, not once per season row in the planner.
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
        title: detail.title,
        network: networkCell(detail.network),
        // Withheld without a credential rather than stored and ignored: a null
        // join key already means "no runtime obtainable" to every planner
        // rule, so no second switch exists to be set wrong and strand every
        // row.
        tvdbId: tvdbEnabled ? tvdbIdOf(detail) : null,
        tmdbId: tmdbIdOf(detail),
      });
    }

    const stalled = new Set(fetched.failed);
    for (const { id } of requests) {
      if (stalled.has(id)) continue;
      this.stamps.set(id, { watchedAt: index.get(id)?.lastWatchedAt ?? null, at });
    }
  }

  /**
   * Fold a runtime fetch into the same entries. The reduction happens here,
   * not in the source: the count it checks is SIMKL's, and one upstream
   * agreeing with another is a rule about the sheet, not the call.
   */
  foldRuntimes(requests: RuntimeRequest[], fetched: SeasonRuntimes): void {
    const stalled = new Set(fetched.failed);
    for (const request of requests) {
      const key = runtimeKeyOf(request.tvdbId, request.season);
      if (stalled.has(key)) continue;
      const entry = this.titles.get(request.id);
      const expected = entry?.shapes.get(request.season)?.total ?? 0;
      entry?.seasonRuntimes.set(request.season, averageRuntime(fetched.episodes.get(key), expected));
    }
  }

  /**
   * Fold one show-fact lookup in, reducing each answer to the cell it becomes.
   * The reduction happens here, not in the source: which names the sheet has a
   * column for and which territory rates a series are rules about the sheet,
   * and the source's job is one HTTP call.
   *
   * `foldCatalogue`'s stamping rule, with the entry's own key as the record
   * rather than a stamp: a **settled** answer is always recorded — a 404
   * included — because an unrecorded key is re-requested every poll forever; a
   * **retryable** failure is never recorded, so the next poll asks again.
   */
  private foldFact<T, F extends 'genres' | 'certificate'>(
    requests: readonly { id: number }[],
    answers: Map<number, T>,
    unavailable: readonly number[],
    field: F,
    reduce: (answer: T) => TitleCatalogue[F],
  ): void {
    for (const request of requests) {
      const answer = answers.get(request.id);
      if (answer !== undefined) this.entry(request.id)[field] = reduce(answer);
    }
    // A 404 is the upstream not knowing this series, which no amount of asking
    // changes. Never over an answer already held: a series that answered once
    // is answered.
    for (const id of unavailable) {
      const entry = this.entry(id);
      if (entry[field] === undefined) entry[field] = null;
    }
  }

  foldGenres(requests: readonly SeriesRequest[], { genres, unavailable }: SeriesGenres): void {
    this.foldFact(requests, genres, unavailable, 'genres', mappedTvdbGenres);
  }

  foldCertificates(requests: readonly CertificateRequest[], { shows, unavailable }: ShowCertificates): void {
    this.foldFact(requests, shows, unavailable, 'certificate', certificateFor);
  }

  /**
   * Which show-facts credentials have been rejected this process.
   *
   * `FilmStore.rejected`'s reason, and its lifetime: a rejection is a fact
   * about the token and not about any series, so settling the pending blocks
   * would have the planner tell the operator to add by hand rows the upstream
   * could build the moment the key is fixed. Both keys are read at start-up, so
   * a fixed one arrives with a restart — and every poll in between would
   * otherwise spend its lookups on the same 401.
   *
   * Every rejection, accumulated: a block needs both upstreams, so the note the
   * planner writes has to name every key standing between the operator and a
   * restart that works. A single slot the second rejection overwrote would name
   * one key, send the operator round, and name the other.
   */
  readonly factsRejected = new Set<FactsCredential>();

  rejectFacts(which: FactsCredential): void {
    this.factsRejected.add(which);
  }

  /**
   * Record every pending season as settled-with-nothing, closing its row with
   * the cell blank for good.
   *
   * The answer to a **rejected credential**: no number of polls makes a typo
   * start answering, and leaving the seasons pending keeps every completing
   * season open forever — strictly worse than never setting the key. A restart
   * re-reads everything, so a corrected key is one restart away. An *outage*
   * must never come through here: that is a wait, not an answer.
   */
  settleSeasonsUnusable(requests: RuntimeRequest[]): void {
    for (const request of requests) this.titles.get(request.id)?.seasonRuntimes.set(request.season, null);
  }
}
