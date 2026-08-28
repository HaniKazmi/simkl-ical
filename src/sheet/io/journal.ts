/**
 * The sheet's own history of what it wrote, on disk so it survives a restart.
 *
 * In `io/` because it talks outside the process, and under `sheet/` because the
 * half that produces a run owns the record of it. `status/` only reads this.
 *
 * **Observational, never control.** Nothing in `src/` may read this file to
 * decide what to do — not to skip a run, not to arm a retry, not to remember a
 * freeze. A restart still resyncs everything from a fresh read, because no
 * decision consults it. Reading it to make one would make a corrupt or deleted
 * file change behaviour, which is exactly what the rest of the design avoids.
 *
 * The type-only import from `../sync.ts` is erased by Node's type stripping, so
 * the cycle with `sync.ts` importing this module exists at build time only.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../shared/atomic-write.ts';
import { config } from '../../shared/config.ts';
import { errorMessage } from '../../shared/errors.ts';
import type { Logger } from '../../shared/logger.ts';
import type { SheetSyncMode } from '../../shared/config.ts';
import type { RecordedEdit, RecordedInsert } from '../4-plan.ts';
import type { SheetSyncStatus } from '../sync.ts';
import { instantFrom } from '../../shared/dates.ts';

/** One finished run, as an operator would want it after a restart. */
export interface SheetRunRecord {
  /** ISO, when the run finished. */
  at: string;
  status: SheetSyncStatus;
  /** The mode at the time: a `reported` run wrote nothing by design. */
  mode: SheetSyncMode;
  edits: RecordedEdit[];
  inserts: RecordedInsert[];
  /**
   * `errors.sheet` verbatim, including the whole FROZEN repair message.
   * Deliberately uncapped: `/healthz` reduces that message to a boolean, so
   * this is the only place the tab to copy back and the rows to delete survive
   * the process that learned them.
   */
  error: string | null;
  /** How many consecutive identical runs this record stands for. */
  repeats: number;
}

/** A run as its producer knows it — `repeats` is the journal's to count. */
export type NewSheetRun = Omit<SheetRunRecord, 'repeats'>;

interface JournalFile {
  version: number;
  runs: SheetRunRecord[];
}

/**
 * Fifty is months of real activity at a few hundred bytes a record. Capped by
 * count alone — the collapse in `appendSheetRun` bounds the one case that could
 * otherwise grow without limit.
 */
const MAX_RUNS = 50;

/**
 * Bumped when the record shape changes, so an older file is *dropped* rather
 * than half-read into fields that no longer mean what they did.
 */
const VERSION = 1;

const journalPath = (): string => join(config.dataDir, 'sheet-runs.json');

/**
 * Held for the life of the process so rendering the page touches no disk — a
 * client polling it hard must cost nothing, the same reason requests never
 * trigger a fetch. This module is the owner; everything goes through the four
 * functions below.
 */
let runs: SheetRunRecord[] = [];

/** Oldest first, matching the file. */
export const sheetRuns = (): SheetRunRecord[] => runs;

/** Exported for tests, exactly as `api/cdn.ts` exports its cache clear. */
export const clearSheetRuns = (): void => {
  runs = [];
};

/**
 * Enough that every later use is total. `at` must be a real instant, not merely
 * a string — an unusable one renders `NaNd ago` on the status page — and
 * `repeats` must be a real number, or `previous.repeats + 1` is `NaN`, persists
 * as `null`, and the count silently stops working for the life of the file.
 *
 * Strict, which `Date.parse` was not: it accepts `2026`, `March 5` and
 * `Dec 25 1995`, so the gate admitted exactly the values it exists to reject and
 * the page rendered whatever came through. This file is read back off disk and
 * rendered verbatim, so it is the one place that has to be sure.
 */
const isRecord = (value: unknown): value is SheetRunRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<SheetRunRecord>;
  return (
    typeof r.at === 'string' &&
    instantFrom(r.at) !== null &&
    typeof r.status === 'string' &&
    Number.isFinite(r.repeats) &&
    Array.isArray(r.edits) &&
    Array.isArray(r.inserts)
  );
};

/**
 * Read the history into memory. Never throws: a missing file is a first run,
 * and an unreadable one is no history rather than a failed boot.
 */
export const loadSheetRuns = async ({ log }: { log?: Logger } = {}): Promise<void> => {
  let text: string;
  try {
    text = await readFile(journalPath(), 'utf8');
  } catch {
    runs = [];
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log?.warn('the sheet run log is not readable JSON; starting a fresh history');
    runs = [];
    return;
  }

  const file = parsed as Partial<JournalFile>;
  if (file?.version !== VERSION || !Array.isArray(file.runs)) {
    log?.warn('the sheet run log is of an unknown shape; starting a fresh history');
    runs = [];
    return;
  }

  // Per-record rather than all-or-nothing: one bad entry should not cost the
  // rest of the history, which is the part that would be missed.
  runs = file.runs.filter(isRecord).slice(-MAX_RUNS);
};

/** Whether a run said anything worth a line in the history. */
const saysSomething = (record: NewSheetRun): boolean =>
  record.status !== 'idle' || record.edits.length > 0 || record.inserts.length > 0 || record.error !== null;

/**
 * How far apart two identical runs can be and still be the same episode.
 *
 * The repetition worth collapsing is a stuck state re-reported every poll. The
 * history survives a restart, so without a bound a sheet hand-reverted and
 * re-applied days later folds into the record from the first time — losing the
 * second write entirely, which is the history this file exists to keep.
 */
const SAME_EPISODE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether two records are close enough in time to be one episode.
 *
 * Unparseable reads as *not* close, so the runs stay separate — which is the
 * safe direction, and stated rather than arrived at through `NaN` comparing
 * false against everything.
 */
const within = (from: string, to: string): boolean => {
  const a = instantFrom(from);
  const b = instantFrom(to);
  return a !== null && b !== null && b.epochMilliseconds - a.epochMilliseconds < SAME_EPISODE_MS;
};

/** Same outcome, same plan, same message, and close enough in time to be one run of it. */
const sameAs = (a: SheetRunRecord, b: NewSheetRun): boolean =>
  a.status === b.status &&
  a.mode === b.mode &&
  a.error === b.error &&
  within(a.at, b.at) &&
  JSON.stringify(a.edits) === JSON.stringify(b.edits) &&
  JSON.stringify(a.inserts) === JSON.stringify(b.inserts);

/**
 * Record a finished run. Never throws — this sits on six return paths inside
 * the refresh path, where nothing may be fatal, so it swallows its own failures
 * rather than trusting a caller's try/catch.
 *
 * Two runs never reach the file. A quiet poll on an unchanged sheet says
 * nothing and is the overwhelmingly common outcome, so recording it would evict
 * every real entry within days. And a `frozen` run repeats on *every* poll for
 * the life of the process, so without collapsing it the cap fills with one
 * message — "frozen, 37 polls, since 14:02" is what an operator needs, not
 * thirty-seven copies of it. Collapsing is bounded in time as well as by
 * equality; see `SAME_EPISODE_MS`.
 */
export const appendSheetRun = (run: NewSheetRun, { log }: { log?: Logger } = {}): Promise<void> => {
  if (!saysSomething(run)) return Promise.resolve();

  const previous = runs[runs.length - 1];
  // Only this module can know a run repeated, so only this module sets it. The
  // *first* `at` is kept, not the latest: "frozen, 37 polls, since 14:02" needs
  // when the state began, and that it is still happening is what the count says.
  if (previous && sameAs(previous, run)) {
    runs[runs.length - 1] = { ...run, at: previous.at, repeats: previous.repeats + 1 };
  } else {
    runs.push({ ...run, repeats: 1 });
    if (runs.length > MAX_RUNS) runs = runs.slice(-MAX_RUNS);
  }

  return save(log);
};

// Queued as well as individually atomic, for the reason `io/store.ts` gives:
// writeFileAtomic stops two writers corrupting each other but not from
// finishing out of order, and a write landing second with older content would
// persist a history already moved past.
//
// One arm rather than the two `io/store.ts` needs: `write` swallows everything,
// so the chain has nothing to recover from.
let queue: Promise<void> = Promise.resolve();

const save = (log?: Logger): Promise<void> => {
  queue = queue.then(() => write(log));
  return queue;
};

const write = async (log?: Logger): Promise<void> => {
  const file: JournalFile = { version: VERSION, runs };
  try {
    // 0600 because the notes name the user's shows, which the README rightly
    // treats as a credential.
    await writeFileAtomic(journalPath(), `${JSON.stringify(file, null, 2)}\n`);
  } catch (err) {
    // The in-memory history is already updated and the run's own result is
    // unaffected; losing the file costs only what survives the next restart.
    log?.warn(`could not save the sheet run log: ${errorMessage(err)}`);
  }
};
