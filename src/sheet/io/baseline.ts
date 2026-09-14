/**
 * What SIMKL last said, on disk so it survives a restart.
 *
 * This is the record that makes "changed" a question with an answer. SIMKL has
 * no per-field revision and the sheet cannot supply one — a cell that disagrees
 * may have disagreed since before the sync existed — so the only thing a change
 * can be measured against is what this service itself last observed. Absent
 * means *not yet observed*, which is why a first sighting records and writes
 * nothing.
 *
 * **Control, unlike `io/journal.ts`.** The run history next to it is
 * observational by rule and nothing may read it to decide behaviour; this file
 * decides whether cells get written. Every failure here therefore resolves
 * towards silence: an unreadable file reads as nothing observed, so the sync
 * re-records and writes nothing, rather than treating the whole library as
 * changed.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileQueued } from '../../shared/atomic-write.ts';
import { config } from '../../shared/config.ts';
import { errorMessage } from '../../shared/errors.ts';
import { instantFrom, nowIso } from '../../shared/dates.ts';
import type { Logger } from '../../shared/logger.ts';
import { parseBaselineKey, type Baseline, type BaselineEntry, type Forgetting } from '../values.ts';

interface BaselineFile {
  version: number;
  /** When the record last moved. Read by the status page, never by the sync. */
  at: string | null;
  /**
   * Every entry, whatever it names: a season, a film, or a title. One key shape
   * each — `seasonKey`, `movieKey` and `titleRecordKey` in `../values.ts` — and
   * `parseBaselineKey` is the one reader of which shape a key has.
   *
   * One map rather than a section per shape, and not because a second map would
   * cost a version bump: an optional one reads as absent on a file written
   * before it, which is the same first-sighting state a new field already has.
   * What one map buys is that `Baseline` is a single value — the planners take
   * it, `PlanResult` returns it, `saveBaseline` merges it — so neither half can
   * be handed the map the other half's entries are in.
   */
  seasons: Record<string, BaselineEntry>;
}

/**
 * Bumped when the stored shape changes, so an older file is dropped rather than
 * half-read into fields that mean something else.
 *
 * Adding a column to `TRACKED_FIELDS` is not such a change: entries are keyed by
 * column name, so a new field is simply one no stored entry has yet — which is
 * exactly the absent state, and exactly the behaviour wanted for a field the
 * sync has not observed before.
 *
 * Nor is a new key shape beside the season keys: an entry no reader looks up is
 * never read, and a season entry means what it always did. A bump would cost
 * one move of every tracked field — dropped, each `Start` and `End` is a first
 * sighting again, so the next move of one is recorded and not written, and only
 * the move after that reaches the cell.
 */
const VERSION = 1;

const baselinePath = (): string => join(config.dataDir, 'sheet-baseline.json');

/**
 * Held in memory: the sync reads it every poll and the status page renders a
 * count off it, and neither should touch disk to do so. This module is the
 * owner; everything goes through the functions below.
 */
let seasons: Baseline = new Map();
let movedAt: string | null = null;

/** What SIMKL last said, keyed by `seasonKey`, `movieKey` or `titleRecordKey`. */
export const baseline = (): Baseline => seasons;

/** Exported for tests, exactly as `clearSheetRuns` is. */
export const clearBaseline = (): void => {
  seasons = new Map();
  movedAt = null;
};

/** What the status page shows: that the record exists, and how current it is. */
export interface BaselineSummary {
  seasons: number;
  films: number;
  at: string | null;
}

/**
 * Counted apart, because one file now holds both tabs and the page names what
 * it shows. Rolled together, a first films poll adds one entry per film in the
 * library and the season count roughly doubles overnight — on the very number
 * whose job is telling a recording-only first run from a sync that never armed.
 *
 * Counted *in*, never subtracted from the total: the file also holds one entry
 * per title, so `size` minus the films would report the show tab's season count
 * as roughly twice what it is. `parseBaselineKey` is the one reader of what
 * shape a key has.
 */
export const baselineSummary = (): BaselineSummary => {
  let films = 0;
  let counted = 0;
  for (const key of seasons.keys()) {
    const named = parseBaselineKey(key);
    if (named.kind === 'movie') films += 1;
    else if (named.kind === 'season') counted += 1;
  }
  return { seasons: counted, films, at: movedAt };
};

/**
 * Enough that every later read is total. Values must be strings, because
 * `recordedSerial` parses them and a number or an object there would read as
 * absent — silently, and for the life of the file.
 *
 * An array is rejected explicitly: it satisfies every other clause, and one
 * merged into an entry would persist as `{"0": …}`.
 *
 * The key set is deliberately not policed against `HEADERS`: an entry for a
 * column nothing tracks is never looked up, and dropping it would only make
 * narrowing `TRACKED_FIELDS` and widening it again lose observations in
 * between.
 */
const isEntry = (value: unknown): value is BaselineEntry =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string');

/**
 * Read the record into memory. Never throws: a missing file is a first run, and
 * an unreadable one is nothing observed rather than a failed boot.
 */
export const loadBaseline = async ({ log }: { log?: Logger } = {}): Promise<void> => {
  clearBaseline();

  let text: string;
  try {
    text = await readFile(baselinePath(), 'utf8');
  } catch {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log?.warn('the sheet baseline is not readable JSON; every tracked field will be recorded afresh and nothing written');
    return;
  }

  const file = parsed as Partial<BaselineFile>;
  if (file?.version !== VERSION || typeof file.seasons !== 'object' || file.seasons === null) {
    log?.warn('the sheet baseline is of an unknown shape; every tracked field will be recorded afresh and nothing written');
    return;
  }

  // Per-entry rather than all-or-nothing: one bad season must not cost the
  // rest, since every entry dropped is a change that goes unwritten.
  for (const [key, entry] of Object.entries(file.seasons)) {
    if (isEntry(entry)) seasons.set(key, entry);
  }
  movedAt = typeof file.at === 'string' && instantFrom(file.at) !== null ? file.at : null;
};

/**
 * Fold this run's observations in and persist. Never throws — it sits inside
 * the refresh path, where nothing may be fatal.
 *
 * A **merge**, per key and per field, not a replacement. `Start` is observed
 * library-wide but `End` only for the rows a run reached, so replacing would
 * drop every out-of-window `End` on each poll and re-record it — silently
 * swallowing the change on the run that finally reached the row.
 *
 * Nothing is ever removed. The record grows with the seasons the library has
 * ever held, which is the same order as the library itself; a title that leaves
 * and returns is worth re-observing anyway, since what happened while it was
 * gone is not knowable.
 *
 * **Persisting a key and moving `at` are two questions.** A key appearing for
 * the first time carrying no field at all — a row every one of whose values this
 * run withdrew — has to be stored, because the key *is* the record that the row
 * was seen and `titleKnown` reads nothing else. It moved no value, so it does
 * not restamp `at`, which the status page renders as when the record last
 * changed: a poll that observed nothing would otherwise read as "just now"
 * forever.
 */
export const saveBaseline = (
  observed: Baseline,
  { forgetting = new Map(), log }: { forgetting?: Forgetting; log?: Logger } = {},
): Promise<void> => {
  let wrote = false;
  let moved = false;
  // Dropped before the fold, since the fold can only add: a forgotten field is
  // one the run wants read as never observed, and `at` stands because nothing
  // moved to a value.
  for (const [key, fields] of forgetting) {
    const before = seasons.get(key);
    if (!before) continue;
    const next = { ...before };
    let dropped = false;
    for (const field of fields) {
      if (!(field in next)) continue;
      delete next[field];
      dropped = true;
    }
    if (!dropped) continue;
    seasons.set(key, next);
    wrote = true;
  }
  for (const [key, entry] of observed) {
    const before = seasons.get(key);
    const fields = Object.entries(entry);
    // Asked of the incoming fields rather than of the merge: since `after` is
    // `before` plus `entry`, "did the merge change anything" is exactly "did
    // every incoming field already match". An entry with no fields matches
    // vacuously, so a key already stored and withdrawn to `{}` this run keeps
    // what it holds.
    if (before && fields.every(([field, value]) => before[field as keyof BaselineEntry] === value)) continue;
    seasons.set(key, { ...before, ...entry });
    wrote = true;
    if (fields.length) moved = true;
  }
  if (!wrote) return Promise.resolve();

  if (moved) movedAt = nowIso();
  return save(log);
};

/**
 * Serialised per path, and here the ordering costs more than elsewhere: a write
 * landing second with older content persists a record already moved past, which
 * is the changes in between lost. See `writeFileQueued`.
 *
 * 0600 for the same reason the run log is: the keys name the user's shows.
 */
const save = (log?: Logger): Promise<void> => {
  const file: BaselineFile = { version: VERSION, at: movedAt, seasons: Object.fromEntries(seasons) };
  return writeFileQueued(baselinePath(), `${JSON.stringify(file, null, 2)}\n`).catch((err: unknown) => {
    // The in-memory record is already updated, so this run behaves correctly.
    // What is lost is the next restart's view: anything observed since the last
    // good write is re-recorded, and the changes in it go unwritten.
    log?.warn(`could not save the sheet baseline: ${errorMessage(err)}`);
  });
};
