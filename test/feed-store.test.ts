import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadFeed, saveFeed } from '../src/feed-store.ts';
import { FeedState } from '../src/refresh.ts';
import { calendarFile, emptyCalendars, jsonResponse, quiet, withFetch, withTempDataDir } from './helpers.ts';

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

// safeRender is the only caller in production, and both timers reach it.
test('overlapping renders are serialised rather than racing', async () => {
  await withTempDataDir(async () => {
    const state = new FeedState({ logger: quiet });
    state.calendars = emptyCalendars();
    state.library = { shows_watching: {} };

    await Promise.all([state.safeRender(), state.safeRender(), state.safeRender()]);

    assert.ok(state.renderedAt);
    assert.equal(await loadFeed(), state.ics);
  });
});

// --- serving the saved feed across a restart ------------------------------

// Calls the real hydrate, with the CDN stubbed so it stays off the network.
test('the saved feed is served on boot', async () => {
  await withTempDataDir(async () => {
    await saveFeed(ICS);
    const state = new FeedState({ logger: quiet });
    const before = state.ics;

    await withFetch(
      () => jsonResponse(calendarFile()),
      async () => {
        await state.hydrate();
      },
    );

    assert.notEqual(state.ics, before, 'the constructor default was replaced');
    assert.equal(state.ics, ICS, 'by the feed from disk');
    assert.equal(state.health.servingCached, true);
  });
});

test('hydrating also warms the calendars, so only the library is left', async () => {
  await withTempDataDir(async () => {
    const state = new FeedState({ logger: quiet });
    await withFetch(
      () => jsonResponse(calendarFile()),
      async (calls) => {
        await state.hydrate();
        assert.ok(calls.length > 0, 'hydrate must fetch the calendars');
      },
    );
    assert.ok(state.calendars, 'calendars are loaded');
    assert.equal(state.library, null, 'the library is not hydrate’s job');
    assert.equal(state.renderedAt, null, 'so no render happened yet');
  });
});

test('with nothing saved, boot serves the empty calendar rather than failing', async () => {
  await withTempDataDir(async () => {
    const state = new FeedState({ logger: quiet });
    await withFetch(
      () => jsonResponse(calendarFile()),
      async () => {
        await state.hydrate();
      },
    );
    assert.equal(state.servingCached, false);
    assert.match(state.ics, /BEGIN:VCALENDAR/);
  });
});

// The whole point: a half-available refresh must not replace a complete feed.
test('a render with only calendars does not overwrite the served feed', async () => {
  await withTempDataDir(async () => {
    const state = new FeedState({ logger: quiet });
    state.ics = ICS;
    state.servingCached = true;
    state.calendars = emptyCalendars();
    // library still null — the join cannot run

    await state.safeRender();

    assert.equal(state.ics, ICS, 'the loaded feed must survive');
    assert.equal(state.renderedAt, null);
    assert.equal(state.health.servingCached, true);
    // safeRender leaves identical state whether render declined or threw; only
    // this distinguishes the two.
    assert.equal(state.errors.render, null, 'declining to render is not a failure');
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
    assert.equal(state.errors.render, null, 'declining to render is not a failure');
  });
});

test('a complete render replaces the feed and persists it', async () => {
  await withTempDataDir(async () => {
    const state = new FeedState({ logger: quiet });
    state.ics = ICS;
    state.servingCached = true;
    state.calendars = emptyCalendars();
    state.library = { shows_watching: {} };

    await state.safeRender();

    assert.notEqual(state.ics, ICS, 'a fresh render took over');
    assert.match(state.ics, /BEGIN:VCALENDAR/);
    assert.ok(state.renderedAt);
    assert.equal(state.health.servingCached, false);
    assert.equal(await loadFeed(), state.ics, 'and was written to disk');
  });
});
