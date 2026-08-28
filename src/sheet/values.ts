/**
 * The sheet's value conventions — how a date and a runtime are written into a
 * cell — in one copy for the planner and the guard both.
 *
 * The bounds matter most: the planner must never emit a value the guard then
 * refuses, because refusal is whole-plan — a single title with bad upstream
 * data would stop every unrelated edit in the run, every poll, for as long as
 * its row sat inside the activity window. One copy of each bound is what makes
 * that gap unrepresentable.
 */

import { plainDateFrom, plainDateIn } from '../shared/dates.ts';

/** Sheets counts days from 1899-12-30. */
const SHEET_EPOCH = Temporal.PlainDate.from('1899-12-30');

/**
 * Days since the sheet epoch for a local calendar date.
 *
 * A count of whole days between two dates, which is what a Sheets serial is —
 * no instants, no zone, and nothing to round. Both operands are `PlainDate`, so
 * there is no hour that could make the difference come out fractional.
 */
export const dateSerial = (date: Temporal.PlainDate): number => SHEET_EPOCH.until(date, { largestUnit: 'day' }).days;

/**
 * The sheet serial for a watch timestamp, in the viewer's zone — never
 * `iso.slice(0, 10)`, which lands a US evening broadcast on the following day.
 * Returns null rather than throwing, because the planner never throws.
 */
export const watchSerial = (at: Temporal.Instant | null | undefined, timezone: string): number | null =>
  at ? dateSerial(plainDateIn(at, timezone)) : null;

/** No serial the sync writes is plausibly before this. */
export const MIN_SERIAL = dateSerial(plainDateFrom('2000-01-01'));

/**
 * The guard's ceiling on a date serial: tomorrow, in the viewer's zone. The
 * zone is the whole point — computed in UTC it is a day late for anyone behind
 * UTC, which makes the bound two days wide instead of one and lets a serial the
 * sync should never write pass.
 */
export const maxSerial = (now: Temporal.Instant, timezone: string): number => dateSerial(plainDateIn(now, timezone).add({ days: 1 }));

/** The bounds of a per-episode runtime, in minutes: one whole minute to under a day. */
const MIN_RUNTIME_MINUTES = 1;
const MAX_RUNTIME_MINUTES = 1440;

/**
 * Per-episode minutes → the day fraction the `Episodes` column holds on a season
 * row, or null where that is not a length an episode has.
 *
 * Bounded at both ends, and the upper one matters: a day or more is not a
 * runtime, and a value at or above 1 written into this column multiplies every
 * `Length` in the block by 1440. An insert writes SIMKL's show-wide runtime
 * through here unrounded, where an average arrives whole — which is why the
 * bound lives here and not only in the guard.
 */
export const runtimeDays = (minutes: number | null | undefined): number | null =>
  typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= MIN_RUNTIME_MINUTES && minutes < MAX_RUNTIME_MINUTES
    ? minutes / MAX_RUNTIME_MINUTES
    : null;

/**
 * The same bounds asked of the day fraction itself — what the guard checks a
 * planned cell against. `runtimeDays` cannot produce a value this refuses.
 */
export const plausibleRuntimeDays = (days: number | undefined): boolean =>
  days !== undefined && days >= MIN_RUNTIME_MINUTES / MAX_RUNTIME_MINUTES && days < 1;
