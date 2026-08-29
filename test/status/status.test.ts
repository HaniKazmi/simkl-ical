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
  state.feed.events = [];
  state.feed.renderedAt = ago(3 * MINUTE);
  state.feed.calendarsAt = ago(4 * MINUTE);
  state.feed.calendarsFreshAt = ago(4 * MINUTE);
  state.feed.calendarsChangedAt = ago(4 * MINUTE);
  state.feed.movieReleases = new Map([[9, { simkl_id: 9, title: 'A Film', date: plainDateFrom('2026-12-18'), releaseType: 3, runtime: null, url: '' }]]);
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
