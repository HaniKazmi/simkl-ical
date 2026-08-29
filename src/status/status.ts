/**
 * The status page's impure shell: MODEL → RENDER, with the live service and
 * the clock read here so the two numbered modules stay pure.
 *
 * The only file under `status/` that names `Orchestrator`. The state arrives
 * as one `Snapshot`; the shell adds what the snapshot does not carry — config
 * labels, the request ring, the run journal, and `filmsDue`, which only
 * `Feed` can answer.
 *
 * Synchronous: the journal is already in memory and nothing here fetches, so
 * a hard page refresh costs a render and nothing else.
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
      // Asked of `Feed`, which owns the rule. Due is per-film, so no
      // timestamp plus interval can re-derive it.
      filmsDue: state.feed.filmsDue(state.library),
      runtimesConfigured: tvdbConfigured(),
      sheetMode: config.sheetSyncMode,
      // The tab name, not the id: the name is the label on the tab in front
      // of the reader, and the id names nothing they can find.
      sheetTab: config.sheetName,
      requests: recentRequests(),
      runs: sheetRuns(),
    }),
  );
};
