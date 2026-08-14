import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.ts';

/**
 * The last rendered feed, and the only derived thing kept on disk.
 *
 * Storing the output rather than the inputs means what is persisted and what is
 * served cannot disagree — there is no re-derivation between them. It also
 * keeps all control state (list signatures, cached calendars) in memory, so a
 * restart is always a clean resync and an inconsistency can never outlive the
 * process.
 */
const feedPath = (): string => join(config.dataDir, 'feed.ics');

const looksLikeCalendar = (text: string): boolean =>
  text.startsWith('BEGIN:VCALENDAR') && text.trimEnd().endsWith('END:VCALENDAR');

export const loadFeed = async (): Promise<string | null> => {
  let text: string;
  try {
    text = await readFile(feedPath(), 'utf8');
  } catch {
    return null; // First run, or no feed saved yet.
  }

  // Unlike JSON, a truncated ICS still parses as a string, so it would be
  // served verbatim. Check both ends before trusting it.
  if (!looksLikeCalendar(text)) return null;
  return text;
};

let writes = 0;
// Saves are queued rather than merely made individually atomic. Unique temp
// names stop two writers corrupting each other, but not from finishing out of
// order — and a save that lands second with older content persists a feed the
// service has already moved past. Ordering the writes makes "the last call
// wins" true regardless of how the callers are scheduled.
let queue: Promise<void> = Promise.resolve();

export const saveFeed = (ics: string): Promise<void> => {
  queue = queue.then(
    () => writeFeed(ics),
    () => writeFeed(ics),
  );
  return queue;
};

const writeFeed = async (ics: string): Promise<void> => {
  await mkdir(config.dataDir, { recursive: true });
  // Write-then-rename: rename is atomic, so a process killed mid-write leaves
  // the previous complete feed in place rather than a half-written one.
  //
  // The temp name must be unique per call. It used to be a fixed `.tmp`, and
  // the two refresh timers coincide every six hours — two overlapping saves
  // then raced on one path, so the second rename failed with ENOENT and the
  // *first* writer's content was what survived, not the newer one.
  writes += 1;
  const tmp = `${feedPath()}.${process.pid}.${writes}.tmp`;
  // The feed is the user's watchlist, which the README rightly calls a
  // credential. token.json is written 0600; this had been left at the default.
  await writeFile(tmp, ics, { mode: 0o600 });
  await rename(tmp, feedPath());
};
