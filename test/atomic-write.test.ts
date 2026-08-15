import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../src/atomic-write.ts';

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'simkl-ical-atomic-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('the file is written and readable', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'a.txt');
    await writeFileAtomic(path, 'hello');
    assert.equal(await readFile(path, 'utf8'), 'hello');
    assert.deepEqual(await readdir(dir), ['a.txt'], 'no temp file survives');
  });
});

test('missing parent directories are created, and not world-traversable', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'nested', 'deeper', 'a.txt');
    await writeFileAtomic(path, 'hello');
    assert.equal(await readFile(path, 'utf8'), 'hello');
    assert.equal((await stat(join(dir, 'nested', 'deeper'))).mode & 0o777, 0o700);
  });
});

test('the file is created at the requested mode, never wider', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'a.txt');
    await writeFileAtomic(path, 'secret');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

// `mode` does nothing to a file that already exists, so writing in place would
// leave a loose file loose; renaming a fresh inode over it is what holds.
test('replacing a loose file tightens it', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'a.txt');
    await writeFile(path, 'old');
    await chmod(path, 0o644);
    await writeFileAtomic(path, 'new');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await readFile(path, 'utf8'), 'new');
  });
});

// With a shared temp path the loser renames a file the winner has already moved
// away, and fails with ENOENT. saveFeed serialises its own callers, but
// writeToken does not, and this is the primitive underneath both.
test('concurrent writers to one path do not collide', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'a.txt');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => writeFileAtomic(path, `writer-${i}`)),
    );

    assert.deepEqual(
      results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason?.code),
      [],
      'no writer may fail',
    );
    // Whichever landed last, the file is one writer's complete content — never a
    // mixture, and never absent.
    assert.match(await readFile(path, 'utf8'), /^writer-[0-7]$/);
    assert.deepEqual(await readdir(dir), ['a.txt'], 'and every temp file was cleaned up');
  });
});

test('concurrent writers to different paths all land', async () => {
  await withDir(async (dir) => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => writeFileAtomic(join(dir, `f${i}.txt`), String(i))));
    assert.deepEqual((await readdir(dir)).sort(), ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
  });
});
