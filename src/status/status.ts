/**
 * The status page's impure shell: MODEL → RENDER, with the live service and the
 * clock read here so the two numbered modules beside it stay pure.
 *
 * This is the only file under `status/` that names `Orchestrator`. Flattening
 * its state into `StatusInput` restates field names, which is the price of the
 * split — and what lets `1-model.ts` be tested from an object literal instead of
 * an assembled service.
 *
 * Synchronous, deliberately. The run journal is already in memory and nothing
 * here fetches, so a client refreshing the page hard costs a render and nothing
 * else — the same reason requests never trigger a fetch.
 */

import { config } from '../shared/config.ts';
import { recentRequests } from '../api/requests.ts';
import { libraryCounts } from '../library.ts';
import { sheetRuns } from '../sheet/io/journal.ts';
import type { Orchestrator } from '../orchestrator.ts';
import { buildModel } from './1-model.ts';
import { renderPage } from './2-html.ts';

export const renderStatus = (state: Orchestrator, { now = Temporal.Now.instant() }: { now?: Temporal.Instant } = {}): string => {
  const { feed, sheetSync } = state;
  const health = state.health;

  return renderPage(
    buildModel({
      now,
      appName: config.appName,
      version: config.appVersion,
      timezone: config.timezone,
      startedAt: state.startedAt,
      ok: health.ok,
      problems: health.problems,

      polledAt: state.polledAt,
      libraryError: state.errors.library,
      counts: libraryCounts(state.library),
      gate: state.lastGate,
      movement: state.lastMovement,
      activitiesPoll: config.activitiesPoll,

      events: feed.events.length,
      renderedAt: feed.renderedAt,
      servingCached: feed.servingCached,
      renderError: feed.errors.render,
      calendarsAt: feed.calendarsAt,
      calendarsChangedAt: feed.calendarsChangedAt,
      calendarError: feed.errors.calendar,
      calendarRefresh: config.calendarRefresh,
      films: feed.movieReleases.size,
      filmsResolvedAt: feed.filmsResolvedAt,
      // Asked of `Feed`, which owns the rule. Re-deriving it here from
      // `filmsResolvedAt` and an interval would describe the whole-list clock
      // the per-film horizon replaced.
      filmsDue: feed.filmsDue(state.library),

      sheetConfigured: sheetSync !== null,
      sheetMode: config.sheetSyncMode,
      // The tab name rather than the id, because the name is what a reader can
      // act on: it is the label on the tab in front of them, and the id names
      // nothing they can find without following it.
      sheetTab: config.sheetName,
      sheetStatus: sheetSync?.lastStatus ?? 'idle',
      sheetLastRunAt: sheetSync?.lastRunAt ?? null,
      // The whole message. `/healthz` reduces it to a boolean, so this is the
      // only place the tab to copy back and the rows to delete are readable.
      sheetFrozen: sheetSync?.frozen ?? null,
      sheetError: state.errors.sheet,
      runs: sheetRuns(),
      requests: recentRequests(),
    }),
  );
};
