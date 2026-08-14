import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write a file without ever exposing a partial or over-permissive version.
 *
 * A fresh inode is created with the mode already set and renamed into place, so
 * there is no window where the content is half-written or the permissions are
 * wider than asked for — `writeFile` creates at 0666 & ~umask and narrowing
 * afterwards is too late, while `mode` alone does nothing to a file that
 * already exists. rename over the destination handles both.
 *
 * Both callers had grown their own copy of this and they had already drifted:
 * one carried a per-call counter in the temp name and no directory mode, the
 * other the reverse.
 */
let writes = 0;

export const writeFileAtomic = async (
  path: string,
  data: string,
  { mode = 0o600, dirMode = 0o700 }: { mode?: number; dirMode?: number } = {},
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: dirMode });
  // Unique per call as well as per process: two overlapping writes to one temp
  // path race, and the loser's rename fails with ENOENT after the winner has
  // already moved the file away.
  writes += 1;
  const tmp = `${path}.${process.pid}.${writes}.tmp`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, path);
};
