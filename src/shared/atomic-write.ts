import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write a file without ever exposing a partial or over-permissive version.
 *
 * A fresh inode is created with the mode already set and renamed into place.
 * `writeFile` creates at 0666 & ~umask so narrowing afterwards is too late, and
 * `mode` alone does nothing to a file that already exists; rename handles both.
 */
let writes = 0;

export const writeFileAtomic = async (
  path: string,
  data: string,
  { mode = 0o600, dirMode = 0o700 }: { mode?: number; dirMode?: number } = {},
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: dirMode });
  // Unique per call as well as per process: two writers sharing a temp path
  // race, and the loser's rename fails with ENOENT.
  writes += 1;
  const tmp = `${path}.${process.pid}.${writes}.tmp`;
  await writeFile(tmp, data, { mode });
  try {
    await rename(tmp, path);
  } catch (err) {
    // A failed rename strands the unique temp file rather than overwriting
    // anything — on a full disk, one more file per write. Unlinking is
    // best-effort; the original error is the one worth reporting.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
};

/**
 * Per-path serialisation of the writes above.
 *
 * `writeFileAtomic` stops two writers corrupting each other; it does not stop
 * them finishing out of order, and a write landing second with older content
 * persists a file already moved past. Every caller that can be entered twice
 * before the first finishes needs this — the feed's two refresh timers coincide
 * every six hours, and the sheet's run log and baseline are both written from a
 * poll that can overlap the next.
 *
 * **Queued per path, never globally.** One queue would make a slow multi-hundred
 * -kilobyte feed write delay a baseline write that shares nothing with it.
 *
 * A failed write breaks nothing for the next: the stored link is normalised so
 * the chain continues, while the caller still receives the real outcome. Each
 * path's entry is dropped once it settles with nothing queued behind it, so the
 * map holds an entry per *in-flight* write rather than per path ever written.
 */
const queues = new Map<string, Promise<void>>();

export const writeFileQueued = (
  path: string,
  data: string,
  options?: { mode?: number; dirMode?: number },
): Promise<void> => {
  const write = (): Promise<void> => writeFileAtomic(path, data, options);
  const previous = queues.get(path);
  // One arm suffices because what is stored is `link`, which never rejects —
  // that is what makes a failed write break nothing for the next.
  const next = previous ? previous.then(write) : write();

  const link = next.then(
    () => {},
    () => {},
  );
  queues.set(path, link);
  void link.then(() => {
    if (queues.get(path) === link) queues.delete(path);
  });
  return next;
};
