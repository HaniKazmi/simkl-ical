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
 */

import type { Orchestrator } from '../orchestrator.ts';
import { config } from '../shared/config.ts';
import { errorMessage } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import { listObjects, uploadObject, type StoredObject, type Uploaded } from '../api/google/storage.ts';
import { allowedImageUrl, fetchImage } from '../api/images.ts';
import { parseGrid, type Grid } from '../sheet/2-grid.ts';
import { parseMovieGrid, type MovieGrid } from '../sheet/movies/2-grid.ts';
import { fetchCatalogue } from '../sheet/io/catalogue.ts';
import { sheetRuns } from '../sheet/io/journal.ts';
import { readSnapshot } from '../sheet/io/spreadsheet.ts';
import { tvdbIdOf } from '../sheet/3-catalogue.ts';
import { indexArtwork, summarise, type ArtworkKind, type ArtworkSummary, type ArtworkTitle } from './1-index.ts';
import { filmCandidates, showCandidates, type Candidate } from './2-candidates.ts';
import { decideLink } from './3-decide.ts';
import { fetchFilmImages } from './io/tmdb-images.ts';
import { fetchShowPosters } from './io/tvdb-art.ts';
import { ensureLink, type LinkOutcome } from './io/sheet-link.ts';

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

export type PickError = 'unknown-title' | 'not-offered' | 'formula' | 'needs-adopt' | 'unrecognised' | 'no-id' | 'nothing-to-adopt';

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
  /** How long a link write waits for the sheet; the io module's default, shortened by tests. */
  private readonly linkWait: Temporal.Duration | undefined;

  constructor(state: Orchestrator, { linkWait }: { linkWait?: Temporal.Duration } = {}) {
    this.state = state;
    this.log = state.log;
    this.linkWait = linkWait;
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
    const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        errors.push(`${what}: ${errorMessage(err)}`);
        return null;
      }
    };
    const buckets = { movie: config.artworkMovieBucket ?? '', show: config.artworkShowBucket ?? '' };
    const [shows, films, storedShow, storedMovie] = await Promise.all([
      attempt<Grid>(`the ${config.sheetName} tab`, async () => parseGrid(await readSnapshot(config.sheetName, { signal }))),
      attempt<MovieGrid>(`the ${config.moviesSheetName} tab`, async () => parseMovieGrid(await readSnapshot(config.moviesSheetName, { signal }))),
      attempt<Map<string, StoredObject>>(`bucket ${buckets.show}`, () => listObjects(buckets.show, { component: 'artwork', signal })),
      attempt<Map<string, StoredObject>>(`bucket ${buckets.movie}`, () => listObjects(buckets.movie, { component: 'artwork', signal })),
    ]);
    const titles = indexArtwork(
      { shows, films, library: this.state.library, runs: sheetRuns(), stored: { movie: storedMovie, show: storedShow }, buckets },
      { timezone: config.timezone },
    );
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

  /** The candidates for a title, cached so a pick can name one by URL. */
  async candidates(kind: ArtworkKind, id: number, { signal }: { signal?: AbortSignal } = {}): Promise<CandidateListing> {
    const index = await this.load({ signal });
    const title = this.titleOf(index, kind, id);
    if (!title) throw new PickRefused('unknown-title', `no ${kind} with id ${id} is on the sheet`);

    const now = Temporal.Now.instant();
    const cached = this.listings.get(cacheKey(kind, id));
    if (cached && Temporal.Instant.compare(now, cached.expires) < 0 && cached.listing.error === null) return cached.listing;

    let providerId = title.providerId;
    let error: string | null = null;
    let candidates: Candidate[] = [];
    try {
      // A show's TVDB id is off the library only under `extended=full`; a
      // title without one is asked for on demand, once, when its row is
      // opened — never for every row at index time.
      if (kind === 'show' && providerId === null) {
        const detail = await fetchCatalogue([{ id, detail: true, anime: this.state.library?.get(id)?.type === 'anime' }], { signal });
        providerId = tvdbIdOf(detail.details.get(id));
        if (providerId !== null) title.providerId = providerId;
      }
      if (providerId === null) {
        error = kind === 'movie' ? 'SIMKL holds no TMDB id for this film' : 'SIMKL holds no TVDB id for this show';
      } else {
        candidates = kind === 'movie' ? filmCandidates(await fetchFilmImages(providerId, { signal })) : showCandidates(await fetchShowPosters(providerId, { signal }));
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
    this.remember(cacheKey(kind, id), listing, now);
    return listing;
  }

  private remember(key: string, listing: CandidateListing, now: Temporal.Instant): void {
    this.listings.delete(key);
    this.listings.set(key, { listing, expires: later(now, CANDIDATE_TTL) });
    // Insertion-ordered, so the first key is the oldest.
    while (this.listings.size > CANDIDATE_CAP) {
      const oldest = this.listings.keys().next().value;
      if (oldest === undefined) break;
      this.listings.delete(oldest);
    }
  }

  /**
   * Put an image behind a title's link. `url` names a candidate the page was
   * offered; absent with `adopt`, the cell's own foreign URL is what gets
   * copied in. Throws `PickRefused` before anything is uploaded, and
   * `SheetBusyError` from the link step when the sheet is held.
   */
  async pick(kind: ArtworkKind, id: number, { url, adopt = false, signal }: { url?: string; adopt?: boolean; signal?: AbortSignal }): Promise<PickResult> {
    const index = await this.load({ signal });
    const title = this.titleOf(index, kind, id);
    if (!title) throw new PickRefused('unknown-title', `no ${kind} with id ${id} is on the sheet`);
    if (title.id === null || title.state === 'no-id') throw new PickRefused('no-id', `${title.title} has no usable SIMKL id`);
    const bucket = kind === 'movie' ? config.artworkMovieBucket : config.artworkShowBucket;
    if (!bucket) throw new PickRefused('unrecognised', `no bucket is configured for ${kind}s`);

    // Pre-decide off the cached cell. The authoritative decision is
    // `ensureLink`'s; this one only stops an upload the link step would
    // then refuse.
    const early = decideLink(title.cell.previous, { title: title.title, bucket, adopt });
    if (early.action === 'refuse') throw new PickRefused(early.reason, early.detail);

    let source: string;
    if (url !== undefined) {
      const offered = this.listings.get(cacheKey(kind, id))?.listing.candidates.find((c) => c.url === url);
      if (!offered) throw new PickRefused('not-offered', 'that image is not one the page was offered for this title; reopen the row');
      source = offered.url;
    } else if (adopt && title.cell.kind === 'foreign' && title.cell.url && allowedImageUrl(title.cell.url)) {
      source = title.cell.url;
    } else {
      throw new PickRefused('nothing-to-adopt', `${title.title} has no image to adopt: the cell holds ${title.cell.url ?? 'nothing'}`);
    }

    const image = await fetchImage(source, { component: 'artwork', signal });
    const uploaded = await uploadObject(bucket, early.key, image.bytes, {
      component: 'artwork',
      contentType: image.contentType,
      cacheControl: OBJECT_CACHE_CONTROL,
      publicRead: config.artworkPublicAcl,
      signal,
    });
    this.log.info(`artwork: ${uploaded.bucket}/${uploaded.key} ← ${source} (${uploaded.bytes} bytes)`);

    const link = await ensureLink({ kind, id, title: title.title, adopt, expectPrevious: title.cell.previous, signal }, { log: this.log, wait: this.linkWait });
    this.settle(title, link);
    return { key: early.key, uploaded, link };
  }

  /** Patch the cached row after a pick, so the page reflects it before the next rebuild. */
  private settle(title: ArtworkTitle, link: LinkOutcome): void {
    title.stored = { exists: true, updated: Temporal.Now.instant() };
    if (link.status === 'written' || link.status === 'kept') {
      title.cell = { kind: 'bucket', url: link.link, previous: { userEnteredValue: { stringValue: link.link }, effectiveValue: { stringValue: link.link } } };
      title.key = link.key;
      title.state = 'done';
    }
    // `reported` and `refused` leave the cell as it was: the object is there,
    // the state still says what the row needs, and the next rebuild agrees.
    if (this.index) this.index.summary = summarise(this.index.titles);
  }
}
