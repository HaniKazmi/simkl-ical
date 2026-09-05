/**
 * DECIDE — what a `Banner` cell holds, and what a pick may do to it. Pure,
 * and the whole of the page's guard: every branch is a named rule, and the
 * io module that writes asks this and nothing else.
 *
 * The sync's planner and guard are not widened to cover this cell. Their
 * whitelists are the poll's, and a page write is one cell on one row that
 * the user just acted on — a different question with a shorter checklist.
 */

import type { CellData } from '../api/google/types.ts';
import { isBlank, isFormula, textOf } from '../sheet/2-grid.ts';
import { artworkKeyFor, artworkKeyOf, artworkLink } from '../sheet/values.ts';

/**
 * The kinds a cell can be. `bucket` links this tab's bucket; `foreign` is an
 * `http(s)` URL anywhere else — the TMDB and TVDB CDNs, a proxy, another
 * bucket; `other` is text that is none of those, which a reader typed and
 * the page cannot interpret.
 */
export type CellKind = 'blank' | 'formula' | 'bucket' | 'foreign' | 'other';

export interface CellReading {
  kind: CellKind;
  /** The URL the cell resolves to: its text, or a formula's computed value. Null for blank and other. */
  url: string | null;
  /** The key the URL addresses in this bucket, when it does. */
  key: string | null;
}

const isHttpUrl = (text: string): boolean => {
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

/**
 * Read a cell against a bucket. A formula is read by its **effective** value,
 * which is the URL the site sees; whether it may be written is the decision
 * below, not the reading.
 */
export const classifyCell = (cell: CellData | undefined, bucket: string): CellReading => {
  if (isBlank(cell)) return { kind: 'blank', url: null, key: null };
  const formula = isFormula(cell);
  const text = formula ? (cell?.effectiveValue?.stringValue ?? null) : textOf(cell);
  const trimmed = text?.trim() ?? '';
  if (!trimmed) return { kind: formula ? 'formula' : 'other', url: null, key: null };
  const key = artworkKeyOf(trimmed, bucket);
  if (formula) return { kind: 'formula', url: trimmed, key };
  if (key !== null) return { kind: 'bucket', url: trimmed, key };
  if (isHttpUrl(trimmed)) return { kind: 'foreign', url: trimmed, key: null };
  return { kind: 'other', url: trimmed, key: null };
};

export type RefusalReason = 'formula' | 'needs-adopt' | 'unrecognised';

/**
 * `write` puts `link` in the cell; `keep` leaves a cell that already
 * addresses this bucket, and says which key it addresses — the cell's, which
 * may differ from the title's; `refuse` writes nothing and says why.
 */
export type LinkDecision =
  | { action: 'write'; key: string; link: string }
  | { action: 'keep'; key: string; link: string }
  | { action: 'refuse'; reason: RefusalReason; key: string; detail: string };

/**
 * The checklist, in order:
 *
 * 1. A **formula** is never written, unconditionally. Kept when its value
 *    already links this bucket — the show tab's 291 `=CONCAT` rows — and
 *    refused otherwise, since the page cannot know what the formula means.
 * 2. **Blank** takes the static link for the title.
 * 3. A link into this bucket is kept, under the key the cell names.
 * 4. A URL on any other host is replaced only when the caller says `adopt`:
 *    the image behind it is what the row shows today, and the pick is
 *    choosing to stop showing it.
 * 5. Anything else is text a reader typed, and the page has no idea what.
 */
export const decideLink = (cell: CellData | undefined, { title, bucket, adopt = false }: { title: string; bucket: string; adopt?: boolean }): LinkDecision => {
  const reading = classifyCell(cell, bucket);
  const key = artworkKeyFor(title);
  const link = artworkLink(bucket, key);
  switch (reading.kind) {
    case 'formula':
      return reading.key !== null
        ? { action: 'keep', key: reading.key, link: reading.url ?? link }
        : { action: 'refuse', reason: 'formula', key, detail: `the cell is a formula${reading.url ? ` resolving to ${reading.url}` : ''}, which is never written` };
    case 'blank':
      return { action: 'write', key, link };
    case 'bucket':
      return { action: 'keep', key: reading.key ?? key, link: reading.url ?? link };
    case 'foreign':
      return adopt ? { action: 'write', key, link } : { action: 'refuse', reason: 'needs-adopt', key, detail: `the cell links ${reading.url}; adopting replaces it` };
    case 'other':
      return { action: 'refuse', reason: 'unrecognised', key, detail: `the cell holds ${JSON.stringify(reading.url ?? '')}, which is not a link` };
  }
};
