/**
 * What SIMKL last said about the fields that follow it, on disk so it survives
 * a restart.
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
import { writeFileAtomic } from '../../shared/atomic-write.ts';
import { config } from '../../shared/config.ts';
import { errorMessage } from '../../shared/errors.ts';
import { instantFrom, nowIso } from '../../shared/dates.ts';
import type { Logger } from '../../shared/logger.ts';
import type { Baseline, BaselineEntry } from '../values.ts';

interface BaselineFile {
  version: number;
  /** When the record last moved. Read by the status page, never by the sync. */
  at: string | null;
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

/** What SIMKL last said, keyed by `seasonKey`. */
export const baseline = (): Baseline => seasons;

/** Exported for tests, exactly as `clearSheetRuns` is. */
export const clearBaseline = (): void => {
  seasons = new Map();
  movedAt = null;
};

/** What the status page shows: that the record exists, and how current it is. */
export interface BaselineSummary {
  seasons: number;
  at: string | null;
}

export const baselineSummary = (): BaselineSummary => ({ seasons: seasons.size, at: movedAt });

/**
 * Enough that every later read is total. Values must be strings, because
 * `recordedSerial` parses them and a number or an object there would read as
 * absent — silently, and for the life of the file.
 *
 * The key set is deliberately not policed against `HEADERS`: an entry for a
 * column nothing tracks is never looked up, and dropping it would only make
 * narrowing `TRACKED_FIELDS` and widening it again lose observations in
 * between.
 */
const isEntry = (value: unknown): value is BaselineEntry =>
  typeof value === 'object' && value !== null && Object.values(value).every((v) => typeof v === 'string');

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
 */
export const saveBaseline = (observed: Baseline, { log }: { log?: Logger } = {}): Promise<void> => {
  let moved = false;
  for (const [key, entry] of observed) {
    const before = seasons.get(key);
    // Asked of the incoming fields rather than of the merge: since `after` is
    // `before` plus `entry`, "did the merge change anything" is exactly "did
    // every incoming field already match". Compared at all so an unchanged
    // library does not restamp `at` on every poll, which would render as "just
    // now" forever and say nothing.
    if (before && Object.entries(entry).every(([field, value]) => before[field as keyof BaselineEntry] === value)) continue;
    seasons.set(key, { ...before, ...entry });
    moved = true;
  }
  if (!moved) return Promise.resolve();

  movedAt = nowIso();
  return save(log);
};

// Queued as well as individually atomic, for the reason `io/journal.ts` gives:
// writeFileAtomic stops two writers corrupting each other but not finishing out
// of order, and a write landing second with older content would persist a
// record already moved past — here costing the changes in between.
let queue: Promise<void> = Promise.resolve();

const save = (log?: Logger): Promise<void> => {
  queue = queue.then(() => write(log));
  return queue;
};

const write = async (log?: Logger): Promise<void> => {
  const file: BaselineFile = { version: VERSION, at: movedAt, seasons: Object.fromEntries(seasons) };
  try {
    // 0600 for the same reason the run log is: the keys name the user's shows.
    await writeFileAtomic(baselinePath(), `${JSON.stringify(file, null, 2)}\n`);
  } catch (err) {
    // The in-memory record is already updated, so this run behaves correctly.
    // What is lost is the next restart's view: anything observed since the last
    // good write is re-recorded, and the changes in it go unwritten.
    log?.warn(`could not save the sheet baseline: ${errorMessage(err)}`);
  }
};
