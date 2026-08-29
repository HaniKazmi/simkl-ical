/**
 * The status page's impure shell: MODEL → RENDER, with the live service, the
 * clock and the config read here so the two numbered modules stay pure.
 *
 * The only file under `status/` that names `Orchestrator`. The state arrives
 * as one `Snapshot`; the shell adds what the snapshot does not carry — config
 * labels, the two links, the request ring, the run journal, and `filmsDue`,
 * which only `Feed` can answer.
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

/** Where the spreadsheet lives, or null when there is none to link to. */
const spreadsheetUrl = (): string | null =>
  config.sheetId ? `https://docs.google.com/spreadsheets/d/${config.sheetId}/edit` : null;

export interface RenderOptions {
  now?: Temporal.Instant;
  /**
   * The origin the reader reached this page on, which both feed links are
   * built from. `webcal:` needs a full authority, so unlike the rest of the
   * page this is a click target and not only text.
   */
  origin?: string;
}

export const renderStatus = (
  state: Orchestrator,
  { now = Temporal.Now.instant(), origin = `http://localhost:${config.port}` }: RenderOptions = {},
): string => {
  const snapshot = state.snapshot();
  // Only reachable behind the route's token check, so the token is set; the
  // fallback keeps the link a valid path rather than the string "undefined".
  const feedUrl = `${origin}/${config.feedToken ?? ''}/feed.ics`;

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
      // The tab name is the label on the tab in front of the reader; the id
      // is only useful as the link below.
      sheetTab: config.sheetName,
      feedUrl,
      // Same address, handed to the calendar client instead of the browser:
      // following the http one downloads a snapshot, which imports once and
      // never updates. `webcal:` is what asks a client to subscribe.
      feedSubscribeUrl: feedUrl.replace(/^https?:/, 'webcal:'),
      sheetUrl: spreadsheetUrl(),
      requests: recentRequests(),
      runs: sheetRuns(),
    }),
  );
};
