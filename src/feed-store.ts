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

export const saveFeed = async (ics: string): Promise<void> => {
  await mkdir(config.dataDir, { recursive: true });
  // Write-then-rename: rename is atomic, so a process killed mid-write leaves
  // the previous complete feed in place rather than a half-written one.
  const tmp = `${feedPath()}.tmp`;
  await writeFile(tmp, ics);
  await rename(tmp, feedPath());
};
