/**
 * Golden-file comparison for the refactor's fixed points.
 *
 * A golden pins an output byte-for-byte where a unit test would only pin the
 * properties someone thought to assert. `UPDATE_GOLDENS=1 npm test` rewrites
 * the files; a bare run compares against what is committed.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const expectGolden = async (name: string, actual: string): Promise<void> => {
  const path = join(import.meta.dirname, name);
  if (process.env.UPDATE_GOLDENS) {
    await writeFile(path, actual);
    return;
  }
  let expected: string;
  try {
    expected = await readFile(path, 'utf8');
  } catch {
    assert.fail(`golden ${name} is missing — run UPDATE_GOLDENS=1 npm test to create it`);
  }
  assert.equal(actual, expected, `${name} drifted from the committed golden`);
};
