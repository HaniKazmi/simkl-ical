/**
 * The artwork page's impure shell: reads, caches, the pick flow.
 *
 * The only file under `artwork/` that names `Orchestrator` — for the library
 * and the logger — and the only one that reads the clock or the config.
 * Everything it holds is a cache over what the io modules fetched; nothing
 * here is state the sheet or the buckets do not already hold, so a restart
 * loses nothing but a few seconds.
 *
 * A pick runs in a fixed order, and the order is the safety argument:
 *
 *   1. pre-decide from the cached cell — cheap, no lock — so a cell that
 *      would refuse (a formula, a foreign link with no `adopt`) refuses
 *      before anything is downloaded or uploaded, and no orphan object is
 *      left while the sheet points elsewhere;
 *   2. download, from the candidate record's URL and never the client's;
 *   3. upload, overwriting — the object is what the site shows, and putting
 *      the same bytes twice is harmless;
 *   4. `ensureLink`, the authoritative pass under the sheet lock, which
 *      re-reads and re-decides and is the only step that writes the sheet.
 *
 * A season row's pick is the same four steps against that row's cell, under
 * the season's key, from the posters its show's season panel offered.
 */

import type { Orchestrator } from '../orchestrator.ts';
import { booksArtworkConfigured, config } from '../shared/config.ts';
import { errorMessage } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import { listObjects, uploadObject, type StoredObject, type Uploaded } from '../api/google/storage.ts';
import { allowedImageUrl, fetchImage, type Resolver } from '../api/images.ts';
import { parseGrid, type Grid } from '../sheet/2-grid.ts';
import { parseBookGrid, type BookGrid } from '../sheet/books/2-grid.ts';
import { parseMovieGrid, type MovieGrid } from '../sheet/movies/2-grid.ts';
import { fetchCatalogue } from '../sheet/io/catalogue.ts';
import { sheetRuns } from '../sheet/io/journal.ts';
import { readSnapshot } from '../sheet/io/spreadsheet.ts';
import { tvdbIdOf } from '../sheet/3-catalogue.ts';
import { lookupPool } from '../api/pool.ts';
import { classify } from '../api/tvdb/client.ts';
import { artworkKeyFor } from '../sheet/values.ts';
import { indexArtwork, offersSeasons, summarise, type ArtworkCell, type ArtworkKind, type ArtworkState, type ArtworkSummary, type ArtworkTitle, type SeasonArtwork } from './1-index.ts';
import { bookCandidates, filmCandidates, placeSeasons, seasonPosters, showCandidates, type Candidate, type SeriesPosters } from './2-candidates.ts';
import { decideLink } from './3-decide.ts';
import { fetchFilmImages } from './io/tmdb-images.ts';
import { fetchSeasonPosters, fetchShowPosters } from './io/tvdb-art.ts';
import { fetchBookCovers } from './io/hardcover-covers.ts';
import { bucketsOf, ensureLink, tabOf, type LinkOutcome } from './io/sheet-link.ts';

/** How long an index is served before being rebuilt; `fresh` bypasses it. */
const INDEX_TTL = Temporal.Duration.from({ seconds: 60 });

/** A candidate listing is held this long, and this many, so a pick can name a URL the page was offered. */
const CANDIDATE_TTL = Temporal.Duration.from({ minutes: 15 });
const CANDIDATE_CAP = 200;

/**
 * Five minutes rather than GCS's hour-long default for a public object with
 * no `Cache-Control`: a re-pick should show on the site within minutes, and
 * the cost is a 304 revalidation after five minutes instead of sixty.
 */
export const OBJECT_CACHE_CONTROL = 'public, max-age=300';

export interface ArtworkIndex {
  titles: ArtworkTitle[];
  summary: ArtworkSummary;
  /** Per source: what could not be read, in the reader's words. */
  errors: string[];
  builtAt: Temporal.Instant;
}

export interface CandidateListing {
  kind: ArtworkKind;
  id: number;
  title: string;
  key: string;
  /** The image the row shows today: the cell's URL, and whether an object is behind the link. */
  current: { url: string | null; exists: boolean | null };
  providerId: number | null;
  candidates: Candidate[];
  error: string | null;
}

/** One season row as its show's season panel shows it. */
export interface SeasonRowListing {
  /** The tab's own number: `7.5` for a specials row. */
  season: number;
  /** The row on the tab, one-based, as a reader would find it. */
  rowNumber: number;
  address: string | null;
  key: string;
  state: ArtworkState;
  /** The image the row shows today: the cell's URL, and whether an object is behind the link. */
  current: { url: string | null; exists: boolean | null };
  /** The TVDB series the row's posters come from; null where none could be resolved. */
  tvdbId: number | null;
  /** The group the panel opens for this row, per `groupToOpen`; null to open none. */
  open: string | null;
}

export interface SeasonListing {
  id: number;
  title: string;
  rows: SeasonRowListing[];
  /** One entry per TVDB series the rows belong to: two for a block whose later rows are another series. */
  series: SeriesPosters[];
  /** Per lookup that failed, in the reader's words. */
  errors: string[];
}

/**
 * Why a row has no candidates to offer. A record rather than a ternary so a
 * fourth kind fails `tsc` rather than inheriting a message naming the wrong
 * upstream — books have nothing to do with SIMKL, and a books row reaching
 * this at all means its `ID` cell is unreadable.
 */
/**
 * Which upstream answers for a kind. A record rather than a chain whose last
 * branch catches whatever is left: an `else` here spends another upstream's
 * quota on an id it cannot use, and a fourth kind would reach it in silence.
 */
const COVERS_OF: Record<ArtworkKind, (providerId: number, signal?: AbortSignal) => Promise<Candidate[]>> = {
  movie: async (id, signal) => filmCandidates(await fetchFilmImages(id, { signal })),
  show: async (id, signal) => showCandidates(await fetchShowPosters(id, { signal })),
  book: async (id, signal) => bookCandidates(await fetchBookCovers(id, { signal })),
};

const NO_PROVIDER_ID: Record<ArtworkKind, string> = {
  movie: 'SIMKL holds no TMDB id for this film',
  show: 'SIMKL holds no TVDB id for this show',
  book: 'the books tab holds no Hardcover id for this row',
};

export type PickError = 'unknown-title' | 'not-offered' | 'formula' | 'needs-adopt' | 'unrecognised' | 'no-id' | 'nothing-to-adopt' | 'frozen' | 'no-season';

export class PickRefused extends Error {
  readonly code: PickError;
  constructor(code: PickError, message: string) {
    super(message);
    this.name = 'PickRefused';
    this.code = code;
  }
}

export interface PickResult {
  key: string;
  uploaded: Uploaded;
  link: LinkOutcome;
}

const later = (at: Temporal.Instant, ttl: Temporal.Duration): Temporal.Instant => at.add({ seconds: ttl.total('seconds') });

const cacheKey = (kind: ArtworkKind, id: number): string => `${kind}:${id}`;

export class Artwork {
  private readonly log: Logger;
  private readonly state: Orchestrator;
  private index: ArtworkIndex | null = null;
  private building: Promise<ArtworkIndex> | null = null;
  private readonly listings = new Map<string, { listing: CandidateListing; expires: Temporal.Instant }>();
  /**
   * Each TVDB series' season posters, held like `listings` and for the same
   * reason, and keyed by the series rather than the show: a series that
   * failed is asked again on its own, and one shared by several rows or
   * blocks is fetched once.
   */
  private readonly seriesPosters = new Map<string, { listing: SeriesPosters; expires: Temporal.Instant }>();
  /**
   * Provider ids resolved on demand, kept across index rebuilds: the library
   * record that lacked a TVDB id still lacks it after a rebuild, and asking
   * SIMKL again per open is the burst pattern it answers with a 401.
   */
  private readonly resolved = new Map<string, number | null>();
  /** How long a link write waits for the sheet; the io module's default, shortened by tests. */
  private readonly linkWait: Temporal.Duration | undefined;
  /** How an image host's name becomes addresses; the system's, replaced by tests so none reach DNS. */
  private readonly resolve: Resolver | undefined;

  constructor(state: Orchestrator, { linkWait, resolve }: { linkWait?: Temporal.Duration; resolve?: Resolver } = {}) {
    this.state = state;
    this.log = state.log;
    this.linkWait = linkWait;
    this.resolve = resolve;
  }

  /** The index, rebuilt past its TTL or on demand. Concurrent readers share one build. */
  async load({ fresh = false, signal }: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<ArtworkIndex> {
    const now = Temporal.Now.instant();
    if (!fresh && this.index && Temporal.Instant.compare(now, later(this.index.builtAt, INDEX_TTL)) < 0) return this.index;
    this.building ??= this.build(signal).finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async build(signal?: AbortSignal): Promise<ArtworkIndex> {
    const errors: string[] = [];
    const buckets = bucketsOf();
    // Books are gated separately from the two tabs the page cannot run
    // without, so an install with neither a books tab nor a bucket pays no
    // read for them and lists none.
    const wantBooks = booksArtworkConfigured();
    const booksTab = config.booksSheetName ?? '';
    const [shows, films, books, storedShow, storedMovie, storedBook] = await Promise.all([
      attempt<Grid>(errors, `the ${config.sheetName} tab`, async () => parseGrid(await readSnapshot(config.sheetName, { signal }))),
      attempt<MovieGrid>(errors, `the ${config.moviesSheetName} tab`, async () => parseMovieGrid(await readSnapshot(config.moviesSheetName, { signal }))),
      wantBooks ? attempt<BookGrid>(errors, `the ${booksTab} tab`, async () => parseBookGrid(await readSnapshot(booksTab, { signal }))) : null,
      attempt<Map<string, StoredObject>>(errors, `bucket ${buckets.show}`, () => listObjects(buckets.show, { component: 'artwork', signal })),
      attempt<Map<string, StoredObject>>(errors, `bucket ${buckets.movie}`, () => listObjects(buckets.movie, { component: 'artwork', signal })),
      wantBooks ? attempt<Map<string, StoredObject>>(errors, `bucket ${buckets.book}`, () => listObjects(buckets.book, { component: 'artwork', signal })) : null,
    ]);
    const titles = indexArtwork(
      {
        shows,
        films,
        books,
        library: this.state.library,
        runs: sheetRuns(),
        stored: { movie: storedMovie, show: storedShow, book: storedBook },
        buckets,
      },
      { timezone: config.timezone },
    );
    for (const title of titles) {
      if (title.providerId === null && title.id !== null) title.providerId = this.resolved.get(cacheKey(title.kind, title.id)) ?? null;
    }
    this.index = { titles, summary: summarise(titles), errors, builtAt: Temporal.Now.instant() };
    return this.index;
  }

  /** What the status page shows, without building anything: null until the page has been opened. */
  summary(): { summary: ArtworkSummary; builtAt: Temporal.Instant } | null {
    return this.index ? { summary: this.index.summary, builtAt: this.index.builtAt } : null;
  }

  private titleOf(index: ArtworkIndex, kind: ArtworkKind, id: number): ArtworkTitle | undefined {
    return index.titles.find((t) => t.kind === kind && t.id === id);
  }

  /**
   * The index as it stands, building one only when there is none: the row a
   * caller names was rendered from some index, and a pick re-reads the sheet
   * under the lock, so staleness here costs nothing and a rebuild would cost
   * four to six Google reads on every request past the TTL.
   */
  private current({ signal }: { signal?: AbortSignal } = {}): Promise<ArtworkIndex> {
    return this.index ? Promise.resolve(this.index) : this.load({ signal });
  }

  /** The candidates for a title, cached so a pick can name one by URL. */
  async candidates(kind: ArtworkKind, id: number, { signal }: { signal?: AbortSignal } = {}): Promise<CandidateListing> {
    const now = Temporal.Now.instant();
    const cached = fresh(this.listings, cacheKey(kind, id), now);
    // A listing that failed on the upstream is asked again; one that failed
    // for want of an id is an answer, and asking again cannot change it.
    if (cached && (cached.error === null || cached.providerId === null)) return cached;

    const index = await this.current({ signal });
    const title = this.titleOf(index, kind, id);
    if (!title) throw new PickRefused('unknown-title', `no ${kind} with id ${id} is on the sheet`);

    let providerId = title.providerId;
    let error: string | null = null;
    let candidates: Candidate[] = [];
    try {
      // A show's TVDB id is off the library only under `extended=full`; a
      // title without one is asked for on demand, once, when its row is
      // opened — never for every row at index time.
      if (kind === 'show' && providerId === null) {
        const answer = (await this.tvdbIdsOf([id], signal)).get(id);
        if (answer !== undefined) {
          providerId = answer;
          title.providerId = answer;
        }
      }
      if (providerId === null) {
        error = NO_PROVIDER_ID[kind];
      } else {
        candidates = await COVERS_OF[kind](providerId, signal);
      }
    } catch (err) {
      error = errorMessage(err);
    }

    const listing: CandidateListing = {
      kind,
      id,
      title: title.title,
      key: title.key,
      current: { url: title.cell.url, exists: title.stored.exists },
      providerId,
      candidates,
      error,
    };
    remember(this.listings, cacheKey(kind, id), listing, now);
    return listing;
  }

  /**
   * TVDB ids for SIMKL show ids: the library's where its record carries one,
   * else SIMKL's earlier answer, else asked now, in one batch. Recorded either
   * way, null included: SIMKL answered, and an answer of "no id" is not one
   * to ask for again on every open. A lookup that failed is absent from the
   * result and not recorded, so the next open asks again.
   */
  private async tvdbIdsOf(ids: readonly number[], signal?: AbortSignal): Promise<Map<number, number | null>> {
    const out = new Map<number, number | null>();
    const ask: number[] = [];
    for (const id of new Set(ids)) {
      const known = this.knownTvdbId(id);
      if (known === undefined) ask.push(id);
      else out.set(id, known);
    }
    if (ask.length === 0) return out;
    const detail = await fetchCatalogue(
      ask.map((id) => ({ id, detail: true, anime: this.state.library?.get(id)?.type === 'anime' })),
      { signal },
    );
    for (const id of ask) {
      if (detail.failed.includes(id)) continue;
      const tvdbId = tvdbIdOf(detail.details.get(id));
      this.resolved.set(cacheKey('show', id), tvdbId);
      out.set(id, tvdbId);
    }
    return out;
  }

  /** A SIMKL id's TVDB id where it is known without asking: off the library, or SIMKL's earlier answer. Undefined when it has to be asked. */
  private knownTvdbId(id: number): number | null | undefined {
    const fromLibrary = tvdbIdOf(this.state.library?.get(id)?.item.show);
    if (fromLibrary !== null) return fromLibrary;
    const key = cacheKey('show', id);
    return this.resolved.has(key) ? (this.resolved.get(key) ?? null) : undefined;
  }

  /**
   * What a show's season panel offers: every numbered season row with its
   * state and the group it opens on, and the posters of each TVDB series its
   * rows belong to.
   *
   * A row with its own SIMKL id is its own title, which may be another series
   * on TVDB — Doctor Who's S14 is the 2023 series, Persona 4's *the Golden* is
   * a series of its own — so its posters come from there. A row carrying no
   * id is the block's. The rows and their placement are read on every call,
   * so a pick made since shows as made; only the lookups are cached.
   */
  async seasons(id: number, { signal }: { signal?: AbortSignal } = {}): Promise<SeasonListing> {
    const index = await this.current({ signal });
    const title = this.titleOf(index, 'show', id);
    if (!title) throw new PickRefused('unknown-title', `no show with id ${id} is on the sheet`);
    if (!offersSeasons(title)) throw new PickRefused('no-season', `${title.title} has no season rows to pick posters for`);

    const errors: string[] = [];
    const seriesOf = (await attempt(errors, 'SIMKL', () => this.tvdbIdsOf([id, ...title.seasons.flatMap((s) => (s.ownId === null ? [] : [s.ownId]))], signal))) ?? new Map<number, number | null>();
    const blockSeries = seriesOf.get(id) ?? null;
    if (title.providerId === null && blockSeries !== null) title.providerId = blockSeries;
    const seriesOfRow = (season: SeasonArtwork): number | null => seriesOf.get(season.ownId ?? id) ?? null;

    const wanted = [...new Set(title.seasons.map(seriesOfRow).filter((t): t is number => t !== null))];
    if (wanted.length === 0 && errors.length === 0) errors.push(NO_PROVIDER_ID.show);
    const series = await this.postersOf(wanted, errors, signal);
    const placed = placeSeasons(
      title.seasons.map((season) => ({ season: season.season, series: seriesOfRow(season) })),
      blockSeries,
      (tvdbId) => series.find((s) => s.tvdbId === tvdbId)?.groups ?? [],
    );
    return {
      id,
      title: title.title,
      rows: title.seasons.map((season) => ({
        season: season.season,
        rowNumber: season.row + 1,
        address: season.address,
        key: season.key,
        state: season.state,
        current: { url: season.cell.url, exists: season.stored.exists },
        ...(placed.get(season.season) ?? { tvdbId: null, open: null }),
      })),
      series,
      errors,
    };
  }

  /**
   * Each series' season posters, from the cache or fetched — three series at
   * a time, since a block of eight cours is eight series and each is three
   * calls. A series that fails is reported in `errors` and left out, and is
   * not held, so the next open asks for it again.
   */
  private async postersOf(tvdbIds: readonly number[], errors: string[], signal?: AbortSignal): Promise<SeriesPosters[]> {
    const now = Temporal.Now.instant();
    const found = new Map<number, SeriesPosters>();
    await lookupPool(
      [...tvdbIds],
      (tvdbId) => tvdbId,
      async (tvdbId) => {
        const held = fresh(this.seriesPosters, String(tvdbId), now);
        const posters = held ?? (await attempt(errors, `TVDB series ${tvdbId}`, async () => seasonPosters(tvdbId, await fetchSeasonPosters(tvdbId, { signal }))));
        if (!posters) return;
        if (!held) remember(this.seriesPosters, String(tvdbId), posters, now);
        found.set(tvdbId, posters);
      },
      // `attempt` keeps every failure as a message, so nothing reaches the pool's own split.
      { concurrency: 3, classify },
    );
    return tvdbIds.flatMap((tvdbId) => found.get(tvdbId) ?? []);
  }

  /** A season poster the panel offered for that row, by URL: one of its series' posters. */
  private offeredForSeason(id: number, row: SeasonArtwork, url: string): Candidate | undefined {
    const tvdbId = this.knownTvdbId(row.ownId ?? id);
    if (tvdbId === undefined || tvdbId === null) return undefined;
    return this.seriesPosters
      .get(String(tvdbId))
      ?.listing.groups.flatMap((g) => g.candidates)
      .find((c) => c.url === url);
  }

  /**
   * Put an image behind a title's link. `url` names a candidate the page was
   * offered; absent with `adopt`, the cell's own foreign URL is what gets
   * copied in. Throws `PickRefused` before anything is uploaded, and
   * `SheetBusyError` from the link step when the sheet is held.
   */
  async pick(kind: ArtworkKind, id: number, { url, adopt = false, season, signal }: { url?: string; adopt?: boolean; season?: number; signal?: AbortSignal }): Promise<PickResult> {
    // The sync's freeze latch is process-wide: a rollback did not complete,
    // the tab is in a state nobody has verified, and the repair copies a
    // backup over it — taking any cell written in between with it.
    const frozen = this.state.snapshot().sheet.frozen;
    if (frozen) throw new PickRefused('frozen', `the sheet sync is frozen and no write may be made until it is repaired: ${frozen}`);
    const index = await this.current({ signal });
    const title = this.titleOf(index, kind, id);
    if (!title) throw new PickRefused('unknown-title', `no ${kind} with id ${id} is on the sheet`);
    if (title.id === null || title.state === 'no-id') throw new PickRefused('no-id', `${title.title} has no usable id on its tab`);
    const bucket = tabOf(kind).bucket;
    if (!bucket) throw new PickRefused('unrecognised', `no bucket is configured for ${kind}s`);

    // The cell a pick writes is the title's, or one season row's — a film or
    // a book has none, so a season names nothing there. Everything below
    // reads `target` and never `title.cell`, so a season's pick cannot decide
    // off the show row's cell.
    const row = season === undefined ? undefined : title.seasons.find((s) => s.season === season);
    if (season !== undefined && !row) throw new PickRefused('no-season', `${title.title} has no season ${season} row`);
    const target: ArtworkCell = row ?? title;
    const name = artworkKeyFor(title.title, season);

    // Pre-decide off the cached cell. The authoritative decision is
    // `ensureLink`'s; this one only stops an upload the link step would
    // then refuse.
    const early = decideLink(target.cell.previous, { key: name, bucket, adopt });
    if (early.action === 'refuse') throw new PickRefused(early.reason, early.detail);

    let source: string;
    if (url !== undefined) {
      const offered = row ? this.offeredForSeason(id, row, url) : this.listings.get(cacheKey(kind, id))?.listing.candidates.find((c) => c.url === url);
      if (!offered) throw new PickRefused('not-offered', `that image is not one the page was offered for ${name}; reopen the row`);
      source = offered.url;
    } else if (adopt && target.cell.kind === 'foreign' && target.cell.url && allowedImageUrl(target.cell.url)) {
      source = target.cell.url;
    } else {
      throw new PickRefused('nothing-to-adopt', `${name} has no image to adopt: the cell holds ${target.cell.url ?? 'nothing'}`);
    }

    const image = await fetchImage(source, { component: 'artwork', signal, ...(this.resolve ? { resolve: this.resolve } : {}) });
    const uploaded = await uploadObject(bucket, early.key, image.bytes, {
      component: 'artwork',
      contentType: image.contentType,
      cacheControl: OBJECT_CACHE_CONTROL,
      publicRead: config.artworkPublicAcl,
      signal,
    });
    this.log.info(`artwork: ${uploaded.bucket}/${uploaded.key} ← ${source} (${uploaded.bytes} bytes)`);

    const link = await ensureLink(
      { kind, id, title: title.title, adopt, expectPrevious: target.cell.previous, season, signal },
      { log: this.log, wait: this.linkWait },
    );
    this.settle(target, link);
    return { key: early.key, uploaded, link };
  }

  /** Patch the cached row — a title's or a season's — after a pick, so the page reflects it before the next rebuild. */
  private settle(target: ArtworkCell, link: LinkOutcome): void {
    target.stored = { exists: true, updated: Temporal.Now.instant() };
    // `unverified` and `failed` leave the cached row alone too: whether the
    // cell holds the link is exactly what is not known, and the next rebuild
    // reads it.
    if (link.status === 'written' || link.status === 'kept') {
      target.cell = { kind: 'bucket', url: link.link, previous: { userEnteredValue: { stringValue: link.link }, effectiveValue: { stringValue: link.link } } };
      target.key = link.key;
      target.state = 'done';
    }
    // `reported` and `refused` leave the cell as it was: the object is there,
    // the state still says what the row needs, and the next rebuild agrees.
    if (this.index) this.index.summary = summarise(this.index.titles);
  }
}

/** A held listing, or undefined once it has expired or was never held. */
const fresh = <T>(map: Map<string, { listing: T; expires: Temporal.Instant }>, key: string, now: Temporal.Instant): T | undefined => {
  const held = map.get(key);
  return held && Temporal.Instant.compare(now, held.expires) < 0 ? held.listing : undefined;
};

/** Hold a listing for `CANDIDATE_TTL`, evicting the oldest past `CANDIDATE_CAP`. */
const remember = <T>(map: Map<string, { listing: T; expires: Temporal.Instant }>, key: string, listing: T, now: Temporal.Instant): void => {
  map.delete(key);
  map.set(key, { listing, expires: later(now, CANDIDATE_TTL) });
  // Insertion-ordered, so the first key is the oldest.
  while (map.size > CANDIDATE_CAP) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
};

/** Run a read, keeping its failure as a message in `errors` rather than failing whatever asked for it. */
const attempt = async <T>(errors: string[], what: string, fn: () => Promise<T>): Promise<T | null> => {
  try {
    return await fn();
  } catch (err) {
    errors.push(`${what}: ${errorMessage(err)}`);
    return null;
  }
};
