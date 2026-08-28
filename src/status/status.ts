/**
 * The status page's impure shell: MODEL → RENDER, with the live service and the
 * clock read here so the two numbered modules beside it stay pure.
 *
 * This is the only file under `status/` that names `Orchestrator`. The state
 * arrives as one `Snapshot`; what the shell adds is everything the snapshot
 * deliberately does not carry — config labels, the request ring, the run
 * journal, and the one question (`filmsDue`) only `Feed` can answer.
 *
 * Synchronous, deliberately. The run journal is already in memory and nothing
 * here fetches, so a client refreshing the page hard costs a render and nothing
 * else — the same reason requests never trigger a fetch.
 */

import { config, tvdbConfigured } from '../shared/config.ts';
import { recentRequests } from '../api/requests.ts';
import { assess } from '../health.ts';
import { sheetRuns } from '../sheet/io/journal.ts';
import type { Orchestrator } from '../orchestrator.ts';
import { buildModel } from './1-model.ts';
import { renderPage } from './2-html.ts';

export const renderStatus = (state: Orchestrator, { now = Temporal.Now.instant() }: { now?: Temporal.Instant } = {}): string => {
  const snapshot = state.snapshot();

  return renderPage(
    buildModel({
      now,
      snapshot,
      assessment: assess(snapshot),
      appName: config.appName,
      version: config.appVersion,
      timezone: config.timezone,
      activitiesPoll: config.activitiesPoll,
      calendarRefresh: config.calendarRefresh,
      // Asked of `Feed`, which owns the rule. Re-deriving it from
      // `filmsResolvedAt` and an interval would describe the whole-list clock
      // the per-film horizon replaced.
      filmsDue: state.feed.filmsDue(state.library),
      runtimesConfigured: tvdbConfigured(),
      sheetMode: config.sheetSyncMode,
      // The tab name rather than the id, because the name is what a reader can
      // act on: it is the label on the tab in front of them, and the id names
      // nothing they can find without following it.
      sheetTab: config.sheetName,
      requests: recentRequests(),
      runs: sheetRuns(),
    }),
  );
};
