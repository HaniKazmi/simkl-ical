/**
 * Loaded by `node --test --import`, so it runs for every test file whether or
 * not that file imports `helpers.ts`.
 *
 * The guards in `helpers.ts` were opt-in by import, which meant a file that
 * happened not to need a fixture also silently opted out of the safety net —
 * and `node --test` runs each file in its own process, so nothing would notice.
 * On a real checkout `./data` holds a live OAuth token and `.env` holds a live
 * `SHEET_ID` and `FEED_TOKEN`.
 */
import './helpers.ts';
