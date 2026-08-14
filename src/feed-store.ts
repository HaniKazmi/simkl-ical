import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.ts';
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

// Saves are queued as well as individually atomic. Unique temp names stop two
// writers corrupting each other, but not from finishing out of order — and a
// save that lands second with older content persists a feed the service has
// already moved past. Ordering the writes makes "the last call wins" true
// regardless of how the callers are scheduled.
let queue: Promise<void> = Promise.resolve();

export const saveFeed = (ics: string): Promise<void> => {
  queue = queue.then(
    () => writeFeed(ics),
    () => writeFeed(ics),
  );
  return queue;
};

const writeFeed = (ics: string): Promise<void> =>
  // 0600 because the feed is the user's watchlist, which the README rightly
  // treats as a credential.
  writeFileAtomic(feedPath(), ics);
