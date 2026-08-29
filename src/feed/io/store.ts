/**
 * SAVE — the rendered feed on disk, and back on boot. Last of FETCH → JOIN →
 * RENDER → **SAVE**, in `io/` because it touches something outside the process.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../shared/atomic-write.ts';
import { config } from '../../shared/config.ts';

/**
 * The only derived thing kept on disk. Storing the output rather than the
 * inputs means the persisted and the served feed cannot disagree; control
 * state stays in memory, so a restart resyncs.
 */
const feedPath = (): string => join(config.dataDir, 'feed.ics');

const looksLikeCalendar = (text: string): boolean =>
  text.startsWith('BEGIN:VCALENDAR') && text.trimEnd().endsWith('END:VCALENDAR');

export const loadFeed = async (): Promise<string | null> => {
  let text: string;
  try {
    text = await readFile(feedPath(), 'utf8');
  } catch (err) {
    // Only a missing file is a first run. A permission error read as a cold
    // start leaves the operator a silently empty feed and nothing in the log.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  // Unlike JSON, a truncated ICS still reads as a string and would be served
  // verbatim. Check both ends.
  if (!looksLikeCalendar(text)) return null;
  return text;
};

// Queued as well as atomic: writeFileAtomic stops two writers corrupting each
// other, not finishing out of order — a save landing second with older
// content would persist a feed already moved past.
let queue: Promise<void> = Promise.resolve();

export const saveFeed = (ics: string): Promise<void> => {
  queue = queue.then(
    () => writeFeed(ics),
    () => writeFeed(ics),
  );
  return queue;
};

const writeFeed = (ics: string): Promise<void> =>
  // 0600: the feed is the user's watchlist, which the README treats as a
  // credential.
  writeFileAtomic(feedPath(), ics);
