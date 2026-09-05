/**
 * WRITE — put the static link in one `Banner` cell, or say why not.
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
import { parseMovieGrid } from '../../sheet/movies/2-grid.ts';
import { appendSheetRun } from '../../sheet/io/journal.ts';
import { SheetBusyError, withSheetLock } from '../../sheet/io/lock.ts';
import { applyRequests, readSnapshot, type SheetSnapshot } from '../../sheet/io/spreadsheet.ts';
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
  /** The `Banner` cell as the page showed it. The write requires the live cell to match. */
  expectPrevious: CellData | undefined;
  signal?: AbortSignal;
}

export type LinkRefusal = RefusalReason | 'not-found' | 'duplicate' | 'title-moved' | 'no-banner-column' | 'cell-changed';

/**
 * `written`: the cell now holds `link`, verified. `kept`: it already linked
 * the bucket and was left alone. `reported`: it would have been written, and
 * the mode is not `apply`. `refused`: nothing was written, for the reason
 * named. `failed`: the write went out and the verify read did not find it;
 * nothing is reverted, and the address says where to look.
 */
export type LinkOutcome =
  | { status: 'written' | 'kept' | 'reported'; address: string; key: string; link: string }
  | { status: 'refused'; reason: LinkRefusal; address: string | null; key: string | null; detail: string }
  | { status: 'failed'; address: string; key: string; link: string; detail: string };

interface Located {
  row: number;
  column: number;
  title: string;
}

/** The row for a SIMKL id on either tab, or the reason there is no single one. */
const locate = (kind: ArtworkKind, snapshot: SheetSnapshot, id: number): Located | { refused: LinkRefusal; detail: string } => {
  if (kind === 'movie') {
    const grid = parseMovieGrid(snapshot);
    if (grid.duplicates.has(id)) return { refused: 'duplicate', detail: `id ${id} is on more than one row of ${snapshot.title}` };
    const row = grid.rows.find((r) => r.id === id);
    if (!row || row.name === null) return { refused: 'not-found', detail: `no row on ${snapshot.title} carries id ${id}` };
    return { row: row.row, column: grid.columns.Banner, title: row.name };
  }
  const grid = parseGrid(snapshot);
  const column = showBannerColumn(grid);
  if (column === null) return { refused: 'no-banner-column', detail: `${snapshot.title} has no Banner column` };
  if (duplicateIds(grid.blocks).has(id)) return { refused: 'duplicate', detail: `id ${id} is on more than one block of ${snapshot.title}` };
  const block = grid.blocks.find((b) => b.ids.includes(id) || b.seasons.some((s) => s.ids.includes(id)));
  if (!block) return { refused: 'not-found', detail: `no block on ${snapshot.title} carries id ${id}` };
  return { row: block.row, column, title: block.title };
};

const tabOf = (kind: ArtworkKind): { title: string; tab: 'shows' | 'films'; bucket: string | undefined } =>
  kind === 'movie'
    ? { title: config.moviesSheetName, tab: 'films', bucket: config.artworkMovieBucket }
    : { title: config.sheetName, tab: 'shows', bucket: config.artworkShowBucket };

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
  const found = locate(kind, snapshot, id);
  if ('refused' in found) return { status: 'refused', reason: found.refused, address: null, key: null, detail: found.detail };
  const address = a1(found.row, found.column);
  if (found.title !== title) {
    return { status: 'refused', reason: 'title-moved', address, key: null, detail: `id ${id} is now on the row titled ${JSON.stringify(found.title)}, not ${JSON.stringify(title)}` };
  }

  const cell = snapshot.rows[found.row]?.[found.column];
  const decision = decideLink(cell, { title, bucket, adopt });
  if (decision.action === 'refuse') return { status: 'refused', reason: decision.reason, address, key: decision.key, detail: decision.detail };
  if (decision.action === 'keep') return { status: 'kept', address, key: decision.key, link: decision.link };

  if (!sameValue(cell?.userEnteredValue, expectPrevious?.userEnteredValue)) {
    return { status: 'refused', reason: 'cell-changed', address, key: decision.key, detail: `${address} no longer holds what the page showed (${textOf(cell) ?? 'blank'})` };
  }
  if (config.sheetSyncMode !== 'apply') return { status: 'reported', address, key: decision.key, link: decision.link };

  const at = nowIso();
  const note = `artwork: ${title} → ${decision.link}`;
  let outcome: LinkOutcome;
  let error: string | null = null;
  try {
    await applyRequests([writeCell(snapshot.sheetId, found.row, found.column, { stringValue: decision.link })], { signal });
    const after = await readSnapshot(tab.title, { signal });
    const landed = after.rows[found.row]?.[found.column]?.userEnteredValue?.stringValue === decision.link;
    outcome = landed
      ? { status: 'written', address, key: decision.key, link: decision.link }
      : { status: 'failed', address, key: decision.key, link: decision.link, detail: `${address} does not hold the link after the write; it holds ${textOf(after.rows[found.row]?.[found.column]) ?? 'blank'}` };
  } catch (err) {
    outcome = { status: 'failed', address, key: decision.key, link: decision.link, detail: errorMessage(err) };
  }
  if (outcome.status === 'failed') {
    error = outcome.detail;
    log.error(`artwork: ${address} on ${tab.title}: ${error}`);
  }
  await appendSheetRun(
    { at, status: outcome.status === 'written' ? 'applied' : 'failed', tab: tab.tab, mode: config.sheetSyncMode, edits: [{ address, field: 'Banner', note }], inserts: [], error },
    { log },
  );
  return outcome;
};
