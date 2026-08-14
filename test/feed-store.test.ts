import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadFeed, saveFeed } from '../src/feed-store.ts';
import { FeedState } from '../src/refresh.ts';
import { quiet, withTempDataDir } from './helpers.ts';

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR';

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

// The bug this guards: the temp path was a fixed `feed.ics.tmp`. Both refresh
// timers end in saveFeed and coincide every six hours, so two overlapping saves
// raced on one path — the second rename failed with ENOENT and the *first*
// writer's content was left on disk, not the newer one.
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

// safeRender is the only caller in production, and both timers reach it.
test('overlapping renders are serialised rather than racing', async () => {
  await withTempDataDir(async () => {
    const state = new FeedState({ logger: quiet });
    state.calendars = {
      tv: { type: 'tv', calendar: [], metadata: {}, stale: false },
      anime: { type: 'anime', calendar: [], metadata: {}, stale: false },
    };
    state.library = { shows_watching: {} };

    await Promise.all([state.safeRender(), state.safeRender(), state.safeRender()]);

    assert.ok(state.renderedAt);
    assert.equal(await loadFeed(), state.ics);
  });
});

// --- serving the saved feed across a restart ------------------------------

test('the saved feed is served on boot', async () => {
  await withTempDataDir(async () => {
    await saveFeed(ICS);
    const state = new FeedState({ logger: quiet });
    const before = state.ics;

    const saved = await loadFeed();
    state.ics = saved!;
    state.servingCached = true;

    assert.notEqual(state.ics, before);
    assert.equal(state.ics, ICS);
    assert.equal(state.health.servingCached, true);
  });
});

// The whole point: a half-available refresh must not replace a complete feed.
test('a render with only calendars does not overwrite the served feed', async () => {
  await withTempDataDir(async () => {
    const state = new FeedState({ logger: quiet });
    state.ics = ICS;
    state.servingCached = true;
    state.calendars = { tv: { type: 'tv', calendar: [], metadata: {}, stale: false }, anime: { type: 'anime', calendar: [], metadata: {}, stale: false } };
    // library still null — the join cannot run

    await state.safeRender();

    assert.equal(state.ics, ICS, 'the loaded feed must survive');
    assert.equal(state.renderedAt, null);
    assert.equal(state.health.servingCached, true);
  });
});

test('a render with only a library does not overwrite the served feed', async () => {
  await withTempDataDir(async () => {
    const state = new FeedState({ logger: quiet });
    state.ics = ICS;
    state.servingCached = true;
    state.library = { shows_watching: {} };

    await state.safeRender();

    assert.equal(state.ics, ICS);
    assert.equal(state.health.servingCached, true);
  });
});

test('a complete render replaces the feed and persists it', async () => {
  await withTempDataDir(async () => {
    const state = new FeedState({ logger: quiet });
    state.ics = ICS;
    state.servingCached = true;
    state.calendars = { tv: { type: 'tv', calendar: [], metadata: {}, stale: false }, anime: { type: 'anime', calendar: [], metadata: {}, stale: false } };
    state.library = { shows_watching: {} };

    await state.safeRender();

    assert.notEqual(state.ics, ICS, 'a fresh render took over');
    assert.match(state.ics, /BEGIN:VCALENDAR/);
    assert.ok(state.renderedAt);
    assert.equal(state.health.servingCached, false);
    assert.equal(await loadFeed(), state.ics, 'and was written to disk');
  });
});
