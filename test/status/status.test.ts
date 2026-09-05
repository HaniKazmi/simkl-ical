import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../../src/orchestrator.ts';
import { renderStatus } from '../../src/status/status.ts';
import { assess } from '../../src/health.ts';
import { ago, calendarOf, libraryOf, quiet, withConfig } from '../helpers.ts';
import { plainDateFrom } from '../../src/shared/dates.ts';

/**
 * The 30-field `Orchestrator → StatusInput` mapping, which the other status
 * suites bypass by building input by hand. Swapping `calendarsAt` for
 * `calendarsChangedAt`, or passing `errors.calendar` where `renderError`
 * belongs, is invisible to every other test and to CI's smoke check — both
 * only assert the page is HTML. So each value here is distinctive, and the
 * assertion is that it reached the page at all.
 */
// `health` reads the real clock through `ageOf`, so the stamps are relative:
// pinned instants would age past the staleness thresholds and fail `ok` for a
// reason no assertion here is about.
const MINUTE = 60_000;

const wired = (): Orchestrator => {
  const state = new Orchestrator({ logger: quiet });
  state.library = libraryOf({ id: 1, status: 'watching' }, { id: 2, status: 'dropped' });
  state.polledAt = ago(MINUTE);
  state.libraryAt = ago(2 * MINUTE);
  state.lastPoll = { at: ago(MINUTE), changed: true, pull: 'delta', removalsChecked: true, refusedRemovals: false, updated: 7, reshaped: 0, removed: 3, rendered: true };
  state.feed.calendars = { tv: { data: calendarOf(), source: 'fresh' }, anime: { data: calendarOf(), source: 'fresh' } };
  // Real events, because this is the one suite that drives the shell: the
  // wiring that hands them to the model answers to nothing else, and an empty
  // list here lets a page that lost the feed entirely pass.
  state.feed.events = [
    { uid: 'a@simkl-ical', kind: 'tv', date: plainDateFrom('2099-08-20'), summary: 'Wired Show – S01E01', episodeTitle: 'Spoiler', detail: 'FX', runtime: '45m', url: null },
  ];
  state.feed.renderedAt = ago(3 * MINUTE);
  state.feed.calendarsAt = ago(4 * MINUTE);
  state.feed.calendarsFreshAt = ago(4 * MINUTE);
  state.feed.calendarsChangedAt = ago(4 * MINUTE);
  state.feed.movieReleases = new Map([[9, { simkl_id: 9, title: 'A Film', runtime: null, url: '', dates: [{ date: plainDateFrom('2026-12-18'), type: 3, country: 'GB', stage: 'cinema' as const }] }]]);
  return state;
};

test('the counts the library holds reach the page, totalled by type', async () => {
  await withConfig({ timezone: 'Europe/London' }, () => {
    const page = renderStatus(wired(), { now: Temporal.Now.instant() });
    // Two shows, one watching and one dropped: the row carries the total and
    // the split that makes it up.
    assert.match(page, /<td>shows<\/td><td class="total">2<\/td>/);
    assert.match(page, /<td>anime<\/td><td class="total">0<\/td>/);
  });
});

// The link is built from `config.sheetId`, and every other test supplies the
// URL as a fixture literal — so nothing else would notice the shell mapping
// the wrong config field into it.
test('the spreadsheet link is built from the configured id', async () => {
  const configured = { sheetId: 'THE-SHEET-ID', sheetName: 'Progress', sheetSyncMode: 'report' as const, googleKeyBase64: 'stub' };
  await withConfig({ timezone: 'Europe/London', ...configured }, () => {
    const page = renderStatus(wired(), { now: Temporal.Now.instant() });
    assert.match(page, /href="https:\/\/docs\.google\.com\/spreadsheets\/d\/THE-SHEET-ID\/edit"/);
  });
});

test('what the last gate did reaches the page', async () => {
  await withConfig({ timezone: 'Europe/London' }, () => {
    const page = renderStatus(wired(), { now: Temporal.Now.instant() });
    assert.match(page, /7 updated/);
    assert.match(page, /3 removed/);
  });
});

// The pill and the problems box render from different fields and can
// disagree: `ok` is the container-restart signal and stays narrow.
test('a library error makes the page say so rather than showing a healthy pill', async () => {
  await withConfig({ timezone: 'Europe/London' }, () => {
    const healthy = wired();
    assert.equal(assess(healthy.snapshot()).ok, true, 'precondition: nothing else is making it degraded');
    assert.match(renderStatus(healthy, { now: Temporal.Now.instant() }), /class="pill ok">healthy/);

    const state = wired();
    state.errors.library = 'AUTH: SIMKL rejected the token';
    assert.equal(assess(state.snapshot()).ok, true, 'precondition: `ok` is the restart signal and stays narrow');

    const page = renderStatus(state, { now: Temporal.Now.instant() });
    assert.match(page, /SIMKL rejected the token/, 'the problem is listed');
    assert.match(page, /class="pill warn">degraded/, 'and the page agrees with its own problems box');
  });
});

// Every field goes through the `html` tag, so a value that failed to map
// shows up as one of these rather than as a visible gap.
test('nothing renders as undefined or as an object', async () => {
  await withConfig({ timezone: 'Europe/London' }, () => {
    const page = renderStatus(wired(), { now: Temporal.Now.instant() });
    assert.doesNotMatch(page, /undefined/);
    assert.doesNotMatch(page, /\[object Object\]/);
    assert.doesNotMatch(page, /NaN/);
  });
});

test('the configured timezone and tab reach the page', async () => {
  await withConfig({ timezone: 'America/New_York', sheetName: 'Watchlist' }, () => {
    const page = renderStatus(wired(), { now: Temporal.Now.instant() });
    assert.match(page, /America\/New_York/);
  });
});

// The shell's job is the mapping; a field it stops passing is invisible to
// every model and render test, which build their input by hand.
test('the rendered feed reaches the page through the shell', async () => {
  await withConfig({ timezone: 'Europe/London' }, () => {
    const page = renderStatus(wired(), { now: Temporal.Now.instant() });
    assert.match(page, /Wired Show – S01E01/, 'the event itself');
    assert.match(page, /1 event</, 'counted off the list rather than a second tally');
    assert.ok(!page.includes('Spoiler'), 'but never the episode title');
  });
});

// `Feed` restores the last render as an ICS string and never parses it back,
// so a process serving a saved feed holds no events — and "nothing ahead"
// would deny a feed subscribers are being served.
test('a feed served from disk is not reported as an empty one', async () => {
  await withConfig({ timezone: 'Europe/London' }, () => {
    const state = wired();
    state.feed.events = [];
    state.feed.servingCached = true;
    const page = renderStatus(state, { now: Temporal.Now.instant() });
    assert.ok(!page.includes('Nothing ahead in the feed.'), 'the feed is not known to be empty');
    assert.match(page, /not known until the next render/);
  });
});

test('the library total is on the page, not left to be added up', async () => {
  await withConfig({ timezone: 'Europe/London' }, () => {
    assert.match(renderStatus(wired(), { now: Temporal.Now.instant() }), /2 items/);
  });
});
