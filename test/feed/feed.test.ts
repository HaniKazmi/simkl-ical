import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFeed, saveFeed } from '../../src/feed/io/store.ts';
import { Feed } from '../../src/feed/feed.ts';
import { Orchestrator } from '../../src/orchestrator.ts';
import { calendarFile, emptyCalendars, jsonResponse, quiet, withFetch, withTempDataDir } from '../helpers.ts';
import type { Library } from '../../src/api/simkl/types.ts';

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR';

/** Every fetch a Feed makes carries a signal; nothing here cancels. */
const live = () => new AbortController().signal;

/** Enough of a library for the join to run. Passed in — Feed never holds one. */
const LIBRARY: Library = { shows_watching: {} };

// safeRender is the only caller in production, and both timers reach it.
test('overlapping renders are serialised rather than racing', async () => {
  await withTempDataDir(async () => {
    const feed = new Feed({ logger: quiet });
    feed.calendars = emptyCalendars();

    await Promise.all([feed.safeRender(LIBRARY), feed.safeRender(LIBRARY), feed.safeRender(LIBRARY)]);

    assert.ok(feed.renderedAt);
    assert.equal(await loadFeed(), feed.ics);
  });
});

// --- serving the saved feed across a restart ------------------------------

// Calls the real hydrate, with the CDN stubbed so it stays off the network.
test('the saved feed is served on boot', async () => {
  await withTempDataDir(async () => {
    await saveFeed(ICS);
    const feed = new Feed({ logger: quiet });
    const before = feed.ics;

    await withFetch(
      () => jsonResponse(calendarFile()),
      async () => {
        await feed.hydrate(null, { signal: live() });
      },
    );

    assert.notEqual(feed.ics, before, 'the constructor default was replaced');
    assert.equal(feed.ics, ICS, 'by the feed from disk');
    assert.equal(feed.servingCached, true);
  });
});

test('hydrating warms the calendars but renders nothing without a library', async () => {
  await withTempDataDir(async () => {
    const feed = new Feed({ logger: quiet });
    await withFetch(
      () => jsonResponse(calendarFile()),
      async (calls) => {
        await feed.hydrate(null, { signal: live() });
        assert.ok(calls.length > 0, 'hydrate must fetch the calendars');
      },
    );
    assert.ok(feed.calendars, 'calendars are loaded');
    assert.equal(feed.renderedAt, null, 'but no render happened yet');
  });
});

// The other half of that claim, and the only place it can be made now that the
// library lives one level up: hydrate must not go and fetch one.
test('hydrating is not the library’s job', async () => {
  await withTempDataDir(async () => {
    const service = new Orchestrator({ logger: quiet });
    await withFetch(
      () => jsonResponse(calendarFile()),
      async () => {
        await service.hydrate();
      },
    );
    assert.ok(service.feed.calendars, 'calendars are loaded');
    assert.equal(service.library, null, 'the library is untouched');
  });
});

test('with nothing saved, boot serves the empty calendar rather than failing', async () => {
  await withTempDataDir(async () => {
    const feed = new Feed({ logger: quiet });
    await withFetch(
      () => jsonResponse(calendarFile()),
      async () => {
        await feed.hydrate(null, { signal: live() });
      },
    );
    assert.equal(feed.servingCached, false);
    assert.match(feed.ics, /BEGIN:VCALENDAR/);
  });
});

// The whole point: a half-available refresh must not replace a complete feed.
test('a render with only calendars does not overwrite the served feed', async () => {
  await withTempDataDir(async () => {
    const feed = new Feed({ logger: quiet });
    feed.ics = ICS;
    feed.servingCached = true;
    feed.calendars = emptyCalendars();

    await feed.safeRender(null); // no library — the join cannot run

    assert.equal(feed.ics, ICS, 'the loaded feed must survive');
    assert.equal(feed.renderedAt, null);
    assert.equal(feed.servingCached, true);
    // safeRender leaves identical state whether render declined or threw; only
    // this distinguishes the two.
    assert.equal(feed.errors.render, null, 'declining to render is not a failure');
  });
});

test('a render with only a library does not overwrite the served feed', async () => {
  await withTempDataDir(async () => {
    const feed = new Feed({ logger: quiet });
    feed.ics = ICS;
    feed.servingCached = true;

    await feed.safeRender(LIBRARY); // no calendars

    assert.equal(feed.ics, ICS);
    assert.equal(feed.servingCached, true);
    assert.equal(feed.errors.render, null, 'declining to render is not a failure');
  });
});

test('a complete render replaces the feed and persists it', async () => {
  await withTempDataDir(async () => {
    const feed = new Feed({ logger: quiet });
    feed.ics = ICS;
    feed.servingCached = true;
    feed.calendars = emptyCalendars();

    await feed.safeRender(LIBRARY);

    assert.notEqual(feed.ics, ICS, 'a fresh render took over');
    assert.match(feed.ics, /BEGIN:VCALENDAR/);
    assert.ok(feed.renderedAt);
    assert.equal(feed.servingCached, false);
    assert.equal(await loadFeed(), feed.ics, 'and was written to disk');
  });
});
