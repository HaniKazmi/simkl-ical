import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic, writeFileQueued } from '../../src/shared/atomic-write.ts';

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

// --- writeFileQueued -------------------------------------------------------

/**
 * The property the queue adds over the primitive: writes to one path land in
 * call order. `writeFileAtomic` alone leaves the last *rename* the winner,
 * which is not the last caller, so a save landing second with older content
 * would persist a file already moved past.
 */
test('queued writes to one path land in the order they were called', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'a.txt');
    // The first is far larger, so unqueued it would finish last and win.
    const results = await Promise.allSettled([writeFileQueued(path, 'A'.repeat(400_000)), writeFileQueued(path, 'last')]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled']);
    assert.equal(await readFile(path, 'utf8'), 'last');
    assert.deepEqual(await readdir(dir), ['a.txt']);
  });
});

/**
 * Queued **per path, never globally**. One queue would make a slow feed write
 * delay a baseline write that shares nothing with it — and, worse, a failing
 * path would drag an unrelated one behind it.
 */
test('a path that cannot be written blocks neither itself nor another path', async () => {
  await withDir(async (dir) => {
    // A file where the parent directory must go, so mkdir fails for this path
    // and only this one.
    await writeFile(join(dir, 'blocked'), 'in the way');
    const doomed = join(dir, 'blocked', 'a.txt');
    const fine = join(dir, 'fine.txt');

    await assert.rejects(writeFileQueued(doomed, 'nope'), 'the caller still sees the real failure');
    // The chain continues for the same path: a later write is attempted, not
    // skipped because the one before it threw.
    await assert.rejects(writeFileQueued(doomed, 'nope again'));
    await writeFileQueued(fine, 'unaffected');
    assert.equal(await readFile(fine, 'utf8'), 'unaffected');
  });
});

/**
 * Per path, never one queue for all of them. A global queue still lands every
 * write, so the property is only visible in the order they *finish*: behind one
 * queue a small write waits for a large unrelated one, which is what would make
 * a multi-hundred-kilobyte feed write delay a baseline write.
 */
test('a large write to one path does not hold up a small write to another', async () => {
  await withDir(async (dir) => {
    const done: string[] = [];
    await Promise.all([
      writeFileQueued(join(dir, 'big.txt'), 'A'.repeat(8_000_000)).then(() => void done.push('big')),
      writeFileQueued(join(dir, 'small.txt'), 'b').then(() => void done.push('small')),
    ]);
    assert.deepEqual(done, ['small', 'big'], 'the small write finished first, so it never queued behind the large one');
  });
});
