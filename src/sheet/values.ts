/**
 * The sheet's value conventions — how a date and a runtime become a cell — one
 * copy for planner and guard both.
 *
 * The bounds matter most. Refusal is whole-plan, so a planner value the guard
 * rejects stops every unrelated edit for as long as the bad row sits inside
 * the activity window. One copy of each bound makes that gap unrepresentable.
 */

import { plainDateFrom, plainDateIn } from '../shared/dates.ts';

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
