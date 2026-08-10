import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

/**
 * The last known library, persisted so a restart serves immediately instead of
 * waiting on the network. `movieReleases` is a Map in memory and an array on
 * disk; that conversion is the only reason this needs its own module rather
 * than being two JSON calls.
 */
const snapshotPath = () => join(config.dataDir, 'snapshot.json');

export async function loadSnapshot() {
  let raw;
  try {
    raw = JSON.parse(await readFile(snapshotPath(), 'utf8'));
  } catch {
    // Absent or unreadable: first run, or a half-written file. Either way the
    // next poll refetches everything.
    return null;
  }

  return {
    library: raw.library ?? null,
    movieReleases: new Map((raw.movieReleases ?? []).map((m) => [Number(m.simkl_id), m])),
    // Absent on snapshots written before per-list gating, which makes every
    // list read as stale and refetch — correct, if briefly wasteful.
    listSignatures: raw.listSignatures ?? {},
    savedAt: raw.savedAt ?? null,
  };
}

export async function saveSnapshot({ library, movieReleases, listSignatures }) {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(
    snapshotPath(),
    JSON.stringify({
      library,
      movieReleases: [...movieReleases.values()],
      listSignatures,
      savedAt: new Date().toISOString(),
    }),
  );
}
