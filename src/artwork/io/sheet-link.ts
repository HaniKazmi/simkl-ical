/**
 * WRITE — put the static link in one `Artwork` cell, or say why not.
 *
 * The authoritative pass. The shell pre-decides from its cached index so a
 * refusal costs no upload, but the cell is written only against a snapshot
 * read **now, under the sheet lock**: the row is found again by SIMKL id
 * (rows move; an index is minutes old), the title is checked against the
 * one the reader acted on, `decideLink` runs against the live cell, and the
 * cell must still hold what the page showed. Then one `updateCells`, one
 * verify read, one journal record.
 *
 * No backup tab. The snapshot protocol exists for batches that insert rows;
 * a single cell that was blank, or that the reader chose to replace, is its
 * own undo.
 */

import type { CellData } from '../../api/google/types.ts';
import { config } from '../../shared/config.ts';
import { nowIso } from '../../shared/dates.ts';
import { errorMessage } from '../../shared/errors.ts';
import type { Logger } from '../../shared/logger.ts';
import { a1, duplicateIds, parseGrid, sameValue, textOf } from '../../sheet/2-grid.ts';
import { writeCell } from '../../sheet/6-requests.ts';
import { parseBookGrid } from '../../sheet/books/2-grid.ts';
import { parseMovieGrid } from '../../sheet/movies/2-grid.ts';
import { appendSheetRun, type RunTab } from '../../sheet/io/journal.ts';
import { SheetBusyError, withSheetLock } from '../../sheet/io/lock.ts';
import { applyRequests, readSnapshot, type SheetSnapshot } from '../../sheet/io/spreadsheet.ts';
import { ARTWORK_LABEL } from '../../sheet/values.ts';
import { showBannerColumn, type ArtworkKind } from '../1-index.ts';
import { decideLink, type RefusalReason } from '../3-decide.ts';

export { SheetBusyError };

/** How long a page write waits for a sync run to release the sheet before answering "busy". */
export const LINK_WAIT = Temporal.Duration.from({ seconds: 20 });

export interface LinkRequest {
  kind: ArtworkKind;
  id: number;
  /** The title the reader acted on. The row found by id must still carry it. */
  title: string;
  adopt: boolean;
  /** The `Artwork` cell as the page showed it. The write requires the live cell to match. */
  expectPrevious: CellData | undefined;
  signal?: AbortSignal;
}

export type LinkRefusal = RefusalReason | 'not-found' | 'duplicate' | 'title-moved' | 'no-banner-column' | 'cell-changed';

/**
 * `written`: the cell now holds `link`, verified. `kept`: it already linked
 * the bucket and was left alone. `reported`: it would have been written, and
 * the mode is not `apply`. `refused`: nothing was written, for the reason
 * named. `failed`: the write went out and the verify read did not find it;
 * nothing is reverted, and the address says where to look. `unverified`: the
 * write went out and the read-back itself failed, so whether it landed is
 * unknown — the next index read settles it, and the address says where.
 */
export type LinkOutcome =
  | { status: 'written' | 'kept' | 'reported'; address: string; key: string; link: string }
  | { status: 'refused'; reason: LinkRefusal; address: string | null; key: string | null; detail: string }
  | { status: 'failed' | 'unverified'; address: string; key: string; link: string; detail: string };

interface Located {
  row: number;
  column: number;
  title: string;
}

/**
 * The row for a SIMKL id on either tab, or the reason there is no single one.
 *
 * `no-banner-column` names the state, not the header: the page's client and
 * the tests both branch on the code, so it stays whatever the column is called.
 */
const locateBook = (snapshot: SheetSnapshot, id: number): Located | { refused: LinkRefusal; detail: string } => {
  const grid = parseBookGrid(snapshot);
  if (grid.duplicates.has(id)) return { refused: 'duplicate', detail: `id ${id} is on more than one row of ${snapshot.title}` };
  const row = grid.rows.find((r) => r.id === id);
  if (!row || row.name === null) return { refused: 'not-found', detail: `no row on ${snapshot.title} carries id ${id}` };
  // No `no-banner-column` arm: `Banner` is a required field of `BOOK_HEADERS`,
  // so a tab missing it throws a `GridError` out of the parse above. Only the
  // show tab, whose headers predate the feature, resolves the column
  // separately and can degrade.
  return { row: row.row, column: grid.columns.Banner, title: row.name };
};

const locateFilm = (snapshot: SheetSnapshot, id: number): Located | { refused: LinkRefusal; detail: string } => {
  const grid = parseMovieGrid(snapshot);
  if (grid.duplicates.has(id)) return { refused: 'duplicate', detail: `id ${id} is on more than one row of ${snapshot.title}` };
  const row = grid.rows.find((r) => r.id === id);
  if (!row || row.name === null) return { refused: 'not-found', detail: `no row on ${snapshot.title} carries id ${id}` };
  return { row: row.row, column: grid.columns.Banner, title: row.name };
};

const locateShow = (snapshot: SheetSnapshot, id: number): Located | { refused: LinkRefusal; detail: string } => {
  const grid = parseGrid(snapshot);
  const column = showBannerColumn(grid);
  if (column === null) return { refused: 'no-banner-column', detail: `${snapshot.title} has no ${ARTWORK_LABEL} column` };
  if (duplicateIds(grid.blocks).has(id)) return { refused: 'duplicate', detail: `id ${id} is on more than one block of ${snapshot.title}` };
  const block = grid.blocks.find((b) => b.ids.includes(id) || b.seasons.some((s) => s.ids.includes(id)));
  if (!block) return { refused: 'not-found', detail: `no block on ${snapshot.title} carries id ${id}` };
  return { row: block.row, column, title: block.title };
};

/**
 * The row for an id on its own tab, or the reason there is no single one.
 *
 * A record rather than a chain, because the fallthrough of a chain here is a
 * *write*: a kind that matched no branch would be parsed as the show grid and
 * linked into a show row.
 *
 * `no-banner-column` names the state, not the header: the page's client and
 * the tests both branch on the code, so it stays whatever the column is called.
 */
const LOCATE: Record<ArtworkKind, (snapshot: SheetSnapshot, id: number) => Located | { refused: LinkRefusal; detail: string }> = {
  movie: locateFilm,
  show: locateShow,
  book: locateBook,
};

/**
 * Which tab a kind lives on, what it is called in the run history, and where
 * its objects go.
 *
 * A record rather than a chain of ternaries, and exported so the shell selects
 * a bucket through it too: an `else` branch is what silently hands a new kind
 * another kind's bucket, and this is the value a pick uploads under.
 *
 * The books title falls back to the empty string, which `readSnapshot` cannot
 * match — books are unreachable here without `booksArtworkConfigured`, which
 * requires the name.
 */
/** Every kind's bucket, so the shell and the page read the one table a pick uploads through. */
export const bucketsOf = (): Record<ArtworkKind, string> => ({
  movie: tabOf('movie').bucket ?? '',
  show: tabOf('show').bucket ?? '',
  book: tabOf('book').bucket ?? '',
});

export const tabOf = (kind: ArtworkKind): { title: string; tab: RunTab; bucket: string | undefined } =>
  ({
    movie: { title: config.moviesSheetName, tab: 'films' as const, bucket: config.artworkMovieBucket },
    show: { title: config.sheetName, tab: 'shows' as const, bucket: config.artworkShowBucket },
    book: { title: config.booksSheetName ?? '', tab: 'books' as const, bucket: config.artworkBookBucket },
  })[kind];

/**
 * Ensure the cell links the bucket. Throws `SheetBusyError` when the sheet
 * is held past `LINK_WAIT`; every other outcome is a value.
 */
export const ensureLink = (request: LinkRequest, { log, wait = LINK_WAIT }: { log: Logger; wait?: Temporal.Duration }): Promise<LinkOutcome> =>
  withSheetLock(() => linkUnderLock(request, log), { wait });

const linkUnderLock = async ({ kind, id, title, adopt, expectPrevious, signal }: LinkRequest, log: Logger): Promise<LinkOutcome> => {
  const tab = tabOf(kind);
  if (!tab.bucket) return { status: 'refused', reason: 'unrecognised', address: null, key: null, detail: `no bucket is configured for ${kind}s` };
  const bucket = tab.bucket;

  const snapshot = await readSnapshot(tab.title, { signal });
  const found = LOCATE[kind](snapshot, id);
  if ('refused' in found) return { status: 'refused', reason: found.refused, address: null, key: null, detail: found.detail };
  const address = a1(found.row, found.column);
  if (found.title !== title) {
    return { status: 'refused', reason: 'title-moved', address, key: null, detail: `id ${id} is now on the row titled ${JSON.stringify(found.title)}, not ${JSON.stringify(title)}` };
  }

  const cell = snapshot.rows[found.row]?.[found.column];
  const decision = decideLink(cell, { title, bucket, adopt });
  if (decision.action === 'refuse') return { status: 'refused', reason: decision.reason, address, key: decision.key, detail: decision.detail };
  // Before `keep` as well as `write`: the object was uploaded under the key
  // the page's cell implied, and a cell that changed since may name another
  // key. Kept, that would report done for a link nothing was uploaded to.
  if (!sameValue(cell?.userEnteredValue, expectPrevious?.userEnteredValue)) {
    return { status: 'refused', reason: 'cell-changed', address, key: decision.key, detail: `${address} no longer holds what the page showed (${textOf(cell) ?? 'blank'})` };
  }
  if (decision.action === 'keep') return { status: 'kept', address, key: decision.key, link: decision.link };
  if (config.sheetSyncMode !== 'apply') return { status: 'reported', address, key: decision.key, link: decision.link };

  const at = nowIso();
  // The title alone: the link is derived from it, and the address is its own
  // column on the status page, so repeating either only widens the row.
  const note = `artwork: ${title}`;
  let outcome: LinkOutcome;
  let error: string | null = null;
  try {
    await applyRequests([writeCell(snapshot.sheetId, found.row, found.column, { stringValue: decision.link })], { signal });
  } catch (err) {
    outcome = { status: 'failed', address, key: decision.key, link: decision.link, detail: `the write failed: ${errorMessage(err)}` };
    error = outcome.detail;
    log.error(`artwork: ${address} on ${tab.title}: ${error}`);
    await appendSheetRun(
      { at, status: 'failed', tab: tab.tab, source: 'artwork', mode: config.sheetSyncMode, edits: [{ address, field: ARTWORK_LABEL, note }], inserts: [], error },
      { log },
    );
    return outcome;
  }
  // The batch is out. A read that fails here must not be reported as a
  // write that did not land: the cell may well hold the link, and the next
  // index read is what settles it. Same split the sync's apply protocol
  // makes.
  try {
    const after = await readSnapshot(tab.title, { signal });
    const landed = after.rows[found.row]?.[found.column]?.userEnteredValue?.stringValue === decision.link;
    outcome = landed
      ? { status: 'written', address, key: decision.key, link: decision.link }
      : { status: 'failed', address, key: decision.key, link: decision.link, detail: `${address} does not hold the link after the write; it holds ${textOf(after.rows[found.row]?.[found.column]) ?? 'blank'}` };
  } catch (err) {
    outcome = { status: 'unverified', address, key: decision.key, link: decision.link, detail: `the sheet could not be read back after the write: ${errorMessage(err)}` };
  }
  if (outcome.status === 'failed' || outcome.status === 'unverified') {
    error = outcome.detail;
    log.error(`artwork: ${address} on ${tab.title}: ${error}`);
  }
  await appendSheetRun(
    { at, status: outcome.status === 'written' ? 'applied' : 'failed', tab: tab.tab, source: 'artwork', mode: config.sheetSyncMode, edits: [{ address, field: ARTWORK_LABEL, note }], inserts: [], error },
    { log },
  );
  return outcome;
};
