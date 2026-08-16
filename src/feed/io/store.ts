/**
 * SAVE — the rendered feed on disk, and back on boot.
 *
 * Last of FETCH → JOIN → RENDER → **SAVE**, and in `io/` because it is the step
 * that touches something outside the process.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../shared/atomic-write.ts';
import { config } from '../../shared/config.ts';

/**
 * The last rendered feed, and the only derived thing kept on disk. Storing the
 * output rather than the inputs means what is persisted and what is served
 * cannot disagree; all control state stays in memory, so a restart resyncs.
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

  // Unlike JSON, a truncated ICS still reads as a string, so it would be served
  // verbatim. Check both ends before trusting it.
  if (!looksLikeCalendar(text)) return null;
  return text;
};

// Queued as well as individually atomic: writeFileAtomic stops two writers
// corrupting each other but not from finishing out of order, and a save landing
// second with older content would persist a feed already moved past.
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
