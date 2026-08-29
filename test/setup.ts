/**
 * Loaded by `node --test --import`, so it runs for every test file whether or
 * not that file imports `helpers.ts`. Without this, a file needing no fixture
 * silently opts out of the safety net — and `node --test` runs each file in
 * its own process, so nothing would notice. On a real checkout `./data` holds
 * a live OAuth token and `.env` a live `SHEET_ID` and `FEED_TOKEN`.
 */
import './helpers.ts';
