/**
 * The page's read shell: the index, the clock and the config into the pure
 * model, and the model into the page. `server.ts` is its only caller.
 */

import { config } from '../shared/config.ts';
import type { Artwork } from './artwork.ts';
import { RECENT_WINDOW } from './1-index.ts';
import { artworkModel, renderArtworkPage } from './4-html.ts';

export const renderArtwork = async (artwork: Artwork, { fresh = false, now = Temporal.Now.instant() }: { fresh?: boolean; now?: Temporal.Instant } = {}): Promise<string> => {
  const index = await artwork.load({ fresh });
  return renderArtworkPage(
    artworkModel(index, {
      now,
      timezone: config.timezone,
      recentWindow: RECENT_WINDOW,
      appName: config.appName,
      version: config.appVersion,
      mode: config.sheetSyncMode,
      buckets: { movie: config.artworkMovieBucket ?? '', show: config.artworkShowBucket ?? '' },
    }),
  );
};
