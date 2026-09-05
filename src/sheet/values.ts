/**
 * The sheet's value conventions — how a date and a runtime become a cell — one
 * copy for planner and guard both.
 *
 * The bounds matter most. Refusal is whole-plan, so a planner value the guard
 * rejects stops every unrelated edit for as long as the bad row sits inside
 * the activity window. One copy of each bound makes that gap unrepresentable.
 */

import { isBlank, isFormula } from './2-grid.ts';
import { instantFrom, plainDateFrom, plainDateIn } from '../shared/dates.ts';
import type { HeaderName } from './2-grid.ts';
import type { CellData } from '../api/google/types.ts';

/** Sheets counts days from 1899-12-30. */
const SHEET_EPOCH = Temporal.PlainDate.from('1899-12-30');

/**
 * Days since the sheet epoch for a local calendar date. Both operands are
 * `PlainDate` — no zone, no hour, nothing to round or come out fractional.
 */
export const dateSerial = (date: Temporal.PlainDate): number => SHEET_EPOCH.until(date, { largestUnit: 'day' }).days;

/**
 * The inverse: the calendar date a serial stands for. Null for anything that
 * is not a finite number, and for a number no date can stand for — a pasted
 * epoch-millisecond timestamp is a serial of 1.7e12, and `PlainDate` throws
 * past ±271,821 years rather than wrapping. A cell the sync would leave alone
 * must not be able to take a page down.
 */
export const serialDate = (serial: number | null | undefined): Temporal.PlainDate | null => {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null;
  try {
    return SHEET_EPOCH.add({ days: Math.floor(serial) });
  } catch {
    return null;
  }
};

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

/**
 * The bounds of a runtime, in minutes: one whole minute to under a day. Both
 * tabs' runtime columns check against these — a per-episode day fraction on the
 * show grid, whole minutes on the films tab — so a bound exists once.
 */
export const MIN_RUNTIME_MINUTES = 1;
export const MAX_RUNTIME_MINUTES = 1440;

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

// --- Following SIMKL --------------------------------------------------------

/**
 * The fields that follow SIMKL: written whenever the value the sync last
 * recorded has moved, on an open row or a dated one alike.
 *
 * One set rather than a policy enum, because there is exactly one question a
 * caller asks — **may this field be written on a row that already has an end
 * date**. "Never written" and "written once into a blank cell" are not two
 * further states of that question but the absence of it, and the rules that
 * separate them already exist in the shape they need: a field the sync may not
 * write is absent from the guard's `EDIT_FIELDS`, and write-once *is* the blank
 * check in `checkRuntimeEdit`. Re-encoding either here would put a second copy
 * of it in the file whose whole purpose is that there is one.
 *
 * Widening this set is the intended way to make another field follow SIMKL.
 * What it costs is a guard rule for the new field and an entry in the planner's
 * observation, not a change to the stored shape.
 */
const TRACKED = ['Start', 'End'] as const;

/** A column that follows SIMKL. The planner keys its table on this, so a field added here and not taught to the planner is a compile error rather than a guard that quietly stops refusing. */
export type TrackedField = (typeof TRACKED)[number];

/** What the planner walks; `isTracked` is the membership test the guard asks. */
export const TRACKED_FIELDS: readonly TrackedField[] = TRACKED;

export const isTracked = (field: HeaderName): field is TrackedField => (TRACKED as readonly HeaderName[]).includes(field);

/**
 * What one row's recorded upstream values look like, keyed by column name.
 *
 * Keys are text rather than either tab's header union: one file holds both
 * tabs' history — a second file would cost a second load, a second save and a
 * second chance to record a value the sheet never received — and the key
 * namespaces say which tab an entry belongs to. Each planner reads its own
 * columns off an entry and never the other's.
 */
export type BaselineEntry = Partial<Record<string, string>>;

/**
 * What SIMKL last said, per row. Keyed by identity rather than by row index:
 * rows shift under an insert, and a key that moved would compare one row
 * against another's history.
 */
export type Baseline = Map<string, BaselineEntry>;

/** The key both the planner and the store use. */
export const seasonKey = (id: number, season: number): string => `${id}:${season}`;

/**
 * The films tab's key. Prefixed rather than bare, because a film's id and a
 * show's id come from the same SIMKL numbering: `53078` alone would be a
 * season key with its season missing, and the two would silently share an
 * entry the day one collided.
 */
export const MOVIE_PREFIX = 'movie:';

export const movieKey = (id: number): string => `${MOVIE_PREFIX}${id}`;

/**
 * The serial a recorded value stands for — the stored ISO instant, rendered in
 * the viewer's zone exactly as the current one is.
 *
 * Rendering *both* sides is what makes the comparison mean "would the cell
 * change", which is the only question worth writing for. A scrobbler restamping
 * an episode moves `lastWatchedAt` by seconds and moves nothing the sheet can
 * show, so comparing instants would plan a write on every poll. It also keeps a
 * `TZ` change silent, because the recorded instant re-renders in the new zone
 * beside the current one — where storing the rendered day instead would make
 * every row whose watch crosses midnight there differ at once, and there is no
 * adopt-on-differ path to absorb them.
 *
 * Null for absent, and for a stored value that no longer parses. Both mean the
 * same thing to a caller — nothing to compare against, so record and write
 * nothing — and a corrupt entry costing one silent re-adopt is the right
 * direction for a file that decides whether cells get written.
 */
export const recordedSerial = (recorded: string | null | undefined, timezone: string): number | null =>
  watchSerial(instantFrom(recorded), timezone);

// --- Artwork links -----------------------------------------------------------

/**
 * Where both tabs' artwork lives. A `Banner` cell holds a public object URL
 * on this host, and the site uses the cell verbatim as an image source.
 */
export const ARTWORK_HOST = 'https://storage.googleapis.com';

/**
 * An object's key for a title: the title, exactly. No trim, no case-fold, no
 * normalisation — the show tab's 291 formula cells build the link as
 * `prefix & Name` and the objects behind them are named the same way, so any
 * rule but identity would break the link between a key derived here and one
 * the sheet already holds.
 */
export const artworkKeyFor = (title: string): string => title;

/**
 * The static link the sheet holds for a key. Only `%`, `#` and `?` are
 * escaped: `#` and `?` end the path in any URL parser and `%` would start an
 * escape, so those three cannot survive literally, while a space or a `/` is
 * something every browser encodes on its own — and encoding them here would
 * make the link differ from the formula's output for the same key, so that a
 * row written by hand and one written by the sync could point at one object
 * two ways.
 */
export const artworkLink = (bucket: string, key: string): string => `${ARTWORK_HOST}/${bucket}/${key.replace(/[%#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

/**
 * The key a cell's link addresses, or null where it links anything else.
 *
 * The cell decides the key, not the title: 18 show rows hold a hand-written
 * link where the name breaks a URL (`3%` → `3%25`, `Fate/Apocrypha` → `Fate
 * Apocrypha`) or the object was named with a typo the cell reproduces, and
 * every one of them serves an image today. A link on another host, or under
 * another bucket, is not this bucket's and answers null; so does a remainder
 * that does not percent-decode, since no key can be recovered from it.
 */
export const artworkKeyOf = (url: string | null | undefined, bucket: string): string | null => {
  const prefix = `${ARTWORK_HOST}/${bucket}/`;
  if (!url || !url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  if (rest === '') return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
};
