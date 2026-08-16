import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadFeed, saveFeed } from '../../../src/feed/io/store.ts';
import { ICS, withTempDataDir } from '../../helpers.ts';

test('a saved feed round-trips', async () => {
  await withTempDataDir(async () => {
    await saveFeed(ICS);
    assert.equal(await loadFeed(), ICS);
  });
});

test('a missing feed is null rather than an error', async () => {
  await withTempDataDir(async () => {
    assert.equal(await loadFeed(), null);
  });
});

// Unlike JSON, a truncated ICS still reads as a string, so it would be served
// verbatim unless both ends are checked.
test('a truncated feed is rejected rather than served', async () => {
  await withTempDataDir(async (dir) => {
    await writeFile(join(dir, 'feed.ics'), 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEV');
    assert.equal(await loadFeed(), null);
  });
});

test('a file that is not a calendar at all is rejected', async () => {
  await withTempDataDir(async (dir) => {
    await writeFile(join(dir, 'feed.ics'), '<html>504 Gateway Timeout</html>');
    assert.equal(await loadFeed(), null);
  });
});

test('saving leaves no temporary file behind', async () => {
  await withTempDataDir(async (dir) => {
    await saveFeed(ICS);
    assert.deepEqual(await readdir(dir), ['feed.ics']);
  });
});

// Both refresh timers end in saveFeed and coincide every six hours.
test('concurrent saves both succeed and the last writer wins', async () => {
  await withTempDataDir(async (dir) => {
    const big = `BEGIN:VCALENDAR\r\n${'A'.repeat(200_000)}\r\nEND:VCALENDAR`;
    const small = 'BEGIN:VCALENDAR\r\nB\r\nEND:VCALENDAR';

    const results = await Promise.allSettled([saveFeed(big), saveFeed(small)]);
    assert.deepEqual(
      results.map((r) => r.status),
      ['fulfilled', 'fulfilled'],
      'neither save may fail',
    );

    assert.equal(await loadFeed(), small, 'the later save is the one on disk');
    assert.deepEqual(await readdir(dir), ['feed.ics'], 'and no temp file survives');
  });
});

// The feed is the user's watchlist, which the README treats as a credential.
test('the saved feed is not world-readable', async () => {
  await withTempDataDir(async (dir) => {
    await saveFeed(ICS);
    assert.equal((await stat(join(dir, 'feed.ics'))).mode & 0o777, 0o600);
  });
});
