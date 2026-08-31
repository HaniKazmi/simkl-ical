/**
 * The sheet's value conventions — how a date and a runtime become a cell — one
 * copy for planner and guard both.
 *
 * The bounds matter most. Refusal is whole-plan, so a planner value the guard
 * rejects stops every unrelated edit for as long as the bad row sits inside
 * the activity window. One copy of each bound makes that gap unrepresentable.
 */

import { isBlank, isFormula } from './2-grid.ts';
import { plainDateFrom, plainDateIn } from '../shared/dates.ts';
import type { CellData } from '../api/google/types.ts';

/** Sheets counts days from 1899-12-30. */
const SHEET_EPOCH = Temporal.PlainDate.from('1899-12-30');

/**
 * Days since the sheet epoch for a local calendar date. Both operands are
 * `PlainDate` — no zone, no hour, nothing to round or come out fractional.
 */
export const dateSerial = (date: Temporal.PlainDate): number => SHEET_EPOCH.until(date, { largestUnit: 'day' }).days;

/**
 * The sheet serial for a watch timestamp, in the viewer's zone — never
 * `iso.slice(0, 10)`, which lands a US evening broadcast on the next day.
 * Returns null rather than throwing; the planner never throws.
 */
export const watchSerial = (at: Temporal.Instant | null | undefined, timezone: string): number | null =>
  at ? dateSerial(plainDateIn(at, timezone)) : null;

/** No serial the sync writes is plausibly before this. */
export const MIN_SERIAL = dateSerial(plainDateFrom('2000-01-01'));

/**
 * Whether a serial is one the sync could have meant, between the floor above
 * and a ceiling the caller computes with `maxSerial`. Every date the sync
 * writes is checked against this pair, whichever column it lands in.
 */
export const plausibleSerial = (serial: number | null | undefined, ceiling: number): boolean =>
  typeof serial === 'number' && serial >= MIN_SERIAL && serial <= ceiling;

/**
 * A season row's `Status` note: when it was last watched, as text.
 *
 * Text rather than a serial, because `Status` is a text column — a serial there
 * renders as `46265`, and giving the write a number format would mean sending
 * `fields` beyond `userEnteredValue`, which is what keeps every hand-set format
 * on the sheet intact.
 */
export const watchedNote = (at: Temporal.Instant | null | undefined, timezone: string): string | null =>
  at ? plainDateIn(at, timezone).toString() : null;

/** Exactly what `watchedNote` produces, and nothing a hand types loosely. */
const WATCHED_NOTE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The serial a `Status` cell's text stands for, or null where the cell holds
 * anything else.
 *
 * This is what separates the sync's own note from a hand-typed one, and both
 * the planner and the guard ask it before overwriting or clearing the cell: a
 * note the user typed is theirs, and the row closes around it rather than
 * through it.
 */
export const watchedNoteSerial = (text: string | null | undefined): number | null => {
  if (!text || !WATCHED_NOTE.test(text)) return null;
  try {
    return dateSerial(plainDateFrom(text));
  } catch {
    // A well-shaped string can still name no date — `2025-02-31`.
    return null;
  }
};

/**
 * Whether the sync may put its note in this cell: **blank, or holding a note of
 * its own**. The `Status` column on a season row is otherwise free space, and
 * what a reader typed there is not reconstructible, so the row closes around a
 * hand-typed note rather than through it.
 *
 * A formula is declined by the same predicate: `text` is the cell's *result*,
 * so a formula rendering a date would read as the sync's own note. The guard
 * refuses a formula target unconditionally and refusal is whole-plan, so one
 * such cell would stop every unrelated edit for as long as its row sits inside
 * the activity window.
 *
 * One copy for planner and guard, like the bounds above: a planner that widened
 * what counts as its own and a guard that did not would refuse whole plans over
 * rows the planner thought were fine.
 */
export const ownsNote = (cell: CellData | undefined, text: string | null | undefined): boolean =>
  !isFormula(cell) && (isBlank(cell) || watchedNoteSerial(text) !== null);

/**
 * The guard's ceiling on a date serial: tomorrow, in the viewer's zone.
 * Computed in UTC it is a day late for anyone behind UTC, so the bound would
 * be two days wide and pass serials the sync should never write.
 */
export const maxSerial = (now: Temporal.Instant, timezone: string): number => dateSerial(plainDateIn(now, timezone).add({ days: 1 }));

/** The bounds of a per-episode runtime, in minutes: one whole minute to under a day. */
const MIN_RUNTIME_MINUTES = 1;
const MAX_RUNTIME_MINUTES = 1440;

/**
 * Per-episode minutes → the day fraction the `Episodes` column holds on a
 * season row, or null where that is not a length an episode has.
 *
 * The upper bound matters: a value at or above 1 in this column multiplies
 * every `Length` in the block by 1440. An insert writes SIMKL's show-wide
 * runtime through here unrounded, so the bound lives here, not only in the
 * guard.
 */
export const runtimeDays = (minutes: number | null | undefined): number | null =>
  typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= MIN_RUNTIME_MINUTES && minutes < MAX_RUNTIME_MINUTES
    ? minutes / MAX_RUNTIME_MINUTES
    : null;

/**
 * The same bounds asked of the day fraction — what the guard checks a planned
 * cell against. `runtimeDays` cannot produce a value this refuses.
 */
export const plausibleRuntimeDays = (days: number | undefined): boolean =>
  days !== undefined && days >= MIN_RUNTIME_MINUTES / MAX_RUNTIME_MINUTES && days < 1;
