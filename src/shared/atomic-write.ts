import { mkdir, rename, writeFile } from 'node:fs/promises';
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
  await rename(tmp, path);
};
