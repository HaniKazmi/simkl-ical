import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../../src/orchestrator.ts';
import { renderStatus } from '../../src/status/status.ts';
import { ago, calendarOf, libraryOf, quiet, withConfig } from '../helpers.ts';
import { plainDateFrom } from '../../src/shared/dates.ts';

/**
 * The 30-field `Orchestrator → StatusInput` mapping, which both other status
 * suites bypass by building their input by hand.
 *
 * It is the highest risk-to-coverage ratio in the repo: swapping `calendarsAt`
 * for `calendarsChangedAt`, or passing `errors.calendar` where `renderError`
 * belongs, is invisible to every other test *and* to CI's smoke check, because
 * both only assert the page is HTML. So each value here is distinctive, and the
 * assertions are that it reached the page at all.
 */
// `health` reads the real clock through `ageOf`, so the fixture's stamps are
// relative: pinned instants would age past the staleness thresholds and make
// `ok` false for a reason no assertion here is about.
const MINUTE = 60_000;

const wired = (): Orchestrator => {
  const state = new Orchestrator({ logger: quiet });
  state.library = libraryOf({ id: 1, status: 'watching' }, { id: 2, status: 'dropped' });
  state.polledAt = ago(MINUTE);
  state.libraryAt = ago(2 * MINUTE);
  state.lastGate = { changed: true, pull: 'delta', removals: false, updated: 7, removed: 3 };
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
    const page = renderStatus(wired(), { now: Date.now() });
    // Two shows in the fixture, one watching and one dropped — one total, not
    // a row per status.
    assert.match(page, /shows<\/b> 2/);
    assert.match(page, /anime<\/b> 0/);
  });
});

test('what the last gate did reaches the page', async () => {
  await withConfig({ timezone: 'Europe/London' }, () => {
    const page = renderStatus(wired(), { now: Date.now() });
    assert.match(page, /7 updated/);
    assert.match(page, /3 removed/);
  });
});

// The pill and the problems box are rendered from two different fields, and
// disagreed: `ok` is the container-restart signal and stays narrow.
test('a library error makes the page say so rather than showing a healthy pill', async () => {
  await withConfig({ timezone: 'Europe/London' }, () => {
    const healthy = wired();
    assert.equal(healthy.health.ok, true, 'precondition: nothing else is making it degraded');
    assert.match(renderStatus(healthy, { now: Date.now() }), /class="pill ok">healthy/);

    const state = wired();
    state.errors.library = 'AUTH: SIMKL rejected the token';
    assert.equal(state.health.ok, true, 'precondition: `ok` is the restart signal and stays narrow');

    const page = renderStatus(state, { now: Date.now() });
    assert.match(page, /SIMKL rejected the token/, 'the problem is listed');
    assert.match(page, /class="pill warn">degraded/, 'and the page agrees with its own problems box');
  });
});

// Every field is interpolated through the `html` tag, so a value that failed to
// map shows up as one of these rather than as a visible gap.
test('nothing renders as undefined or as an object', async () => {
  await withConfig({ timezone: 'Europe/London' }, () => {
    const page = renderStatus(wired(), { now: Date.now() });
    assert.doesNotMatch(page, /undefined/);
    assert.doesNotMatch(page, /\[object Object\]/);
    assert.doesNotMatch(page, /NaN/);
  });
});

test('the configured timezone and tab reach the page', async () => {
  await withConfig({ timezone: 'America/New_York', sheetName: 'Watchlist' }, () => {
    const page = renderStatus(wired(), { now: Date.now() });
    assert.match(page, /America\/New_York/);
  });
});
