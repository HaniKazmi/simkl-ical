/**
 * INDEX — both tabs, the library, the run history and the two bucket
 * listings, reduced to one row per title with a state the page can act on.
 * Pure: every input is handed in, and the shell decides how stale each may be.
 *
 * A title's state is read off its `Banner` cell against its bucket, the way
 * `decideLink` will read it when a pick lands, so what the page shows as
 * "needs artwork" is exactly what a pick can fix. The key is the cell's where
 * the cell has one and the title's where it does not — the same rule.
 */

import type { CellData } from '../api/google/types.ts';
import type { StoredObject } from '../api/google/storage.ts';
import type { Library } from '../library.ts';
import { a1, duplicateIds, findHeaderRow, numberOf, resolveColumns, type Grid, type ShowBlock } from '../sheet/2-grid.ts';
import { tvdbIdOf } from '../sheet/3-catalogue.ts';
import { tmdbIdOf } from '../sheet/movies/1-index.ts';
import { movieCellAt, type MovieGrid } from '../sheet/movies/2-grid.ts';
import type { SheetRunRecord } from '../sheet/io/journal.ts';
import { artworkKeyFor, serialDate } from '../sheet/values.ts';
import { instantFrom } from '../shared/dates.ts';
import { classifyCell, type CellKind } from './3-decide.ts';

export type ArtworkKind = 'movie' | 'show';

/**
 * What a row needs, if anything.
 *
 * - `done`: the cell links this bucket and the object is there.
 * - `missing-object`: the cell links this bucket and nothing is behind it —
 *   a row the sync inserted, or an object never uploaded.
 * - `unlinked`: a blank cell; a pick writes the link.
 * - `adopt`: a URL on another host; a pick may replace it, or adopt it.
 * - `no-id`: no SIMKL id, or one shared with another row; nothing can be
 *   looked up or written safely.
 * - `unrecognised`: a formula that does not resolve to this bucket, or text
 *   that is not a link; a person has to look.
 */
export type ArtworkState = 'done' | 'missing-object' | 'unlinked' | 'adopt' | 'no-id' | 'unrecognised';

/** The states a pick can change. */
export const NEEDS_ARTWORK: readonly ArtworkState[] = ['missing-object', 'unlinked', 'adopt'];

export interface ArtworkTitle {
  kind: ArtworkKind;
  id: number | null;
  /** TMDB for a film, TVDB for a show; null until the library or a lookup supplies it. */
  providerId: number | null;
  title: string;
  /** Zero-based row in the tab's snapshot. */
  row: number;
  /** The `Banner` cell, A1. Null when the tab has no such column. */
  address: string | null;
  cell: { kind: CellKind; url: string | null; previous: CellData | undefined };
  /** The object key a pick uploads to: the cell's where it links this bucket, else the title's. */
  key: string;
  stored: { exists: boolean | null; updated: Temporal.Instant | null };
  state: ArtworkState;
  /** When the sync inserted this row, from the run history; null if it never did or the history does not say. */
  addedBySync: Temporal.Instant | null;
  lastWatchedAt: Temporal.Instant | null;
  /** The later of the two above; what the page sorts by. */
  recentAt: Temporal.Instant | null;
  /** A film's `Franchise` cell, a show's `Status`; shown beside the title and searched with it. */
  context: string | null;
}

export interface ArtworkSummary {
  total: number;
  needing: number;
  adoptable: number;
  /** Inserted by the sync inside the recency window. */
  addedRecently: number;
  noId: number;
  shows: number;
  films: number;
}

export interface IndexInput {
  /** The show tab, parsed; null when it could not be read. */
  shows: Grid | null;
  films: MovieGrid | null;
  library: Library | null;
  runs: readonly SheetRunRecord[];
  /** Each bucket's listing; null when it could not be listed. */
  stored: { movie: Map<string, StoredObject> | null; show: Map<string, StoredObject> | null };
  buckets: { movie: string; show: string };
}

export interface IndexOptions {
  /** For a film with no library stamp, whose `Watch Date` is a calendar day. */
  timezone: string;
}

/**
 * The show tab's `Banner` column, resolved on its own: it is not one of the
 * sync's headers, and a tab without it degrades to "link writes off for
 * shows" rather than a page that will not render.
 */
export const showBannerColumn = (grid: Grid): number | null => {
  const { rows, columnCount } = grid.snapshot;
  try {
    const headerRow = findHeaderRow(rows, ['Show', 'Season']);
    const width = Math.max(columnCount, ...rows.map((r) => r.length));
    return resolveColumns(rows[headerRow] ?? [], width, ['Banner'] as const).Banner;
  } catch {
    return null;
  }
};

/** The id a block is keyed by: the show row's, else the first season row's (a cour block). */
const blockId = (block: ShowBlock): number | null => block.ids[0] ?? block.seasons.flatMap((s) => s.ids)[0] ?? null;

const later = (a: Temporal.Instant | null, b: Temporal.Instant | null): Temporal.Instant | null =>
  a === null ? b : b === null ? a : Temporal.Instant.compare(a, b) >= 0 ? a : b;

/**
 * When the sync last inserted a row for a title on a tab, off the journal.
 * Observational: the journal is never read to decide behaviour, and this
 * decides only the order the page lists rows in.
 */
const insertedAt = (runs: readonly SheetRunRecord[], tab: 'shows' | 'films', title: string): Temporal.Instant | null => {
  let newest: Temporal.Instant | null = null;
  for (const run of runs) {
    if ((run.tab ?? 'shows') !== tab) continue;
    if (!run.inserts.some((insert) => insert.title === title)) continue;
    newest = later(newest, instantFrom(run.at));
  }
  return newest;
};

const stateOf = (
  cell: { kind: CellKind; key: string | null },
  id: number | null,
  stored: Map<string, StoredObject> | null,
  key: string,
): { state: ArtworkState; exists: boolean | null } => {
  const exists = stored === null ? null : stored.has(key);
  if (id === null) return { state: 'no-id', exists };
  switch (cell.kind) {
    case 'bucket':
      return { state: exists === false ? 'missing-object' : 'done', exists };
    case 'formula':
      return cell.key !== null ? { state: exists === false ? 'missing-object' : 'done', exists } : { state: 'unrecognised', exists };
    case 'blank':
      return { state: 'unlinked', exists };
    case 'foreign':
      return { state: 'adopt', exists };
    case 'other':
      return { state: 'unrecognised', exists };
  }
};

const entry = (
  base: Pick<ArtworkTitle, 'kind' | 'id' | 'providerId' | 'title' | 'row' | 'address' | 'lastWatchedAt' | 'context'>,
  cellData: CellData | undefined,
  bucket: string,
  stored: Map<string, StoredObject> | null,
  addedBySync: Temporal.Instant | null,
): ArtworkTitle => {
  const reading = classifyCell(cellData, bucket);
  const key = reading.key ?? artworkKeyFor(base.title);
  const { state, exists } = stateOf(reading, base.id, stored, key);
  return {
    ...base,
    cell: { kind: reading.kind, url: reading.url, previous: cellData },
    key,
    stored: { exists, updated: stored?.get(key)?.updated ?? null },
    state,
    addedBySync,
    recentAt: later(addedBySync, base.lastWatchedAt),
  };
};

const NEEDS = new Set<ArtworkState>(NEEDS_ARTWORK);

/** Needs-artwork first, then most recently touched, then by title — the order a reader wants to work in. */
const compare = (a: ArtworkTitle, b: ArtworkTitle): number => {
  const needs = Number(NEEDS.has(b.state)) - Number(NEEDS.has(a.state));
  if (needs) return needs;
  if (a.recentAt && b.recentAt) {
    const byRecent = Temporal.Instant.compare(b.recentAt, a.recentAt);
    if (byRecent) return byRecent;
  } else if (a.recentAt || b.recentAt) {
    return a.recentAt ? -1 : 1;
  }
  return a.title.localeCompare(b.title);
};

export const indexArtwork = (input: IndexInput, { timezone }: IndexOptions): ArtworkTitle[] => {
  const { shows, films, library, runs, stored, buckets } = input;
  const out: ArtworkTitle[] = [];

  if (shows) {
    const banner = showBannerColumn(shows);
    const dupes = duplicateIds(shows.blocks);
    for (const block of shows.blocks) {
      const candidate = blockId(block);
      const id = candidate !== null && !dupes.has(candidate) ? candidate : null;
      const item = id === null ? undefined : library?.get(id)?.item;
      out.push(
        entry(
          {
            kind: 'show',
            id,
            providerId: tvdbIdOf(item?.show),
            title: block.title,
            row: block.row,
            address: banner === null ? null : a1(block.row, banner),
            lastWatchedAt: instantFrom(item?.last_watched_at),
            context: block.status,
          },
          banner === null ? undefined : shows.snapshot.rows[block.row]?.[banner],
          buckets.show,
          stored.show,
          insertedAt(runs, 'shows', block.title),
        ),
      );
    }
  }

  if (films) {
    for (const row of films.rows) {
      if (row.name === null) continue;
      const id = row.id !== null && !films.duplicates.has(row.id) ? row.id : null;
      const item = id === null ? undefined : library?.get(id)?.item;
      // The library's stamp where it has one; the tab's own `Watch Date`
      // otherwise, at the start of that day in the viewer's zone, so a film
      // watched before the library was pulled still sorts by when.
      const watchDate = serialDate(numberOf(movieCellAt(films, row.row, films.columns['Watch Date'])));
      const lastWatchedAt = instantFrom(item?.last_watched_at) ?? watchDate?.toZonedDateTime({ timeZone: timezone }).toInstant() ?? null;
      const franchise = films.snapshot.rows[row.row]?.[films.columns.Franchise];
      out.push(
        entry(
          {
            kind: 'movie',
            id,
            // An anime film nests its title under `show`, the way `indexFilms` reads it.
            providerId: tmdbIdOf((item?.movie ?? item?.show)?.ids.tmdb),
            title: row.name,
            row: row.row,
            address: a1(row.row, films.columns.Banner),
            lastWatchedAt,
            context: franchise?.effectiveValue?.stringValue ?? franchise?.userEnteredValue?.stringValue ?? null,
          },
          movieCellAt(films, row.row, films.columns.Banner),
          buckets.movie,
          stored.movie,
          insertedAt(runs, 'films', row.name),
        ),
      );
    }
  }

  return out.sort(compare);
};

/** The counts the page's chips and the status page's line show. */
export const summarise = (
  titles: readonly ArtworkTitle[],
  { now = Temporal.Now.instant(), recentWindow = Temporal.Duration.from({ days: 30 }) }: { now?: Temporal.Instant; recentWindow?: Temporal.Duration } = {},
): ArtworkSummary => {
  // An instant cannot subtract a day unit; the window is days and below, so
  // its total in seconds is exact and needs no anchor.
  const since = now.subtract({ seconds: recentWindow.total('seconds') });
  const recent = (t: ArtworkTitle): boolean => t.addedBySync !== null && Temporal.Instant.compare(t.addedBySync, since) >= 0;
  return {
    total: titles.length,
    needing: titles.filter((t) => NEEDS.has(t.state)).length,
    adoptable: titles.filter((t) => t.state === 'adopt').length,
    addedRecently: titles.filter(recent).length,
    noId: titles.filter((t) => t.state === 'no-id').length,
    shows: titles.filter((t) => t.kind === 'show').length,
    films: titles.filter((t) => t.kind === 'movie').length,
  };
};
