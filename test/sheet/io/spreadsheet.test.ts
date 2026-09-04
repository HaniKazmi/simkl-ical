/**
 * The grid read. The tab it asks for is a parameter, because the two tabs this
 * reads have different shapes and a default would let a caller that forgot plan
 * one tab's rules against the other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSnapshot } from '../../../src/sheet/io/spreadsheet.ts';
import { SheetsAccessError } from '../../../src/api/google/client.ts';
import { clearTokenCache } from '../../../src/api/google/auth.ts';
import { CREDENTIAL } from '../fake-sheets.ts';
import { jsonResponse, withConfig, withFetch } from '../../helpers.ts';

test('a tab the spreadsheet does not have needs a human, not another poll', async () => {
  // The tab is named by configuration, so no amount of retrying conjures it.
  // Reported as retryable it arms the poll's retry on every tick, and the
  // orchestrator's quiet-poll early-out never fires again.
  //
  // What Sheets actually answers for a `ranges` naming a tab it lacks is a 400
  // `Unable to parse range`, before any body carrying `sheets` arrives. A
  // response that resolves the range and still omits the title is the other
  // way there — a case mismatch — and both have to reach the same answer.
  clearTokenCache();
  await withConfig({ sheetId: 'SID', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(
      (url) =>
        url.includes('oauth2')
          ? jsonResponse({ access_token: 't', expires_in: 3600 })
          : new Response(JSON.stringify({ error: { code: 400, message: 'Unable to parse range: Movies', status: 'INVALID_ARGUMENT' } }), { status: 400 }),
      async () => {
        await assert.rejects(
          () => readSnapshot('Movies'),
          (err: unknown) => {
            assert.ok(err instanceof SheetsAccessError, `expected a SheetsAccessError, got ${String(err)}`);
            assert.equal(err.needsHuman, true);
            assert.match(err.message, /MOVIES_SHEET_NAME/);
            return true;
          },
        );
      },
    ),
  );
  clearTokenCache();
  await withConfig({ sheetId: 'SID', googleKeyBase64: CREDENTIAL }, () =>
    withFetch(
      (url) =>
        url.includes('oauth2')
          ? jsonResponse({ access_token: 't', expires_in: 3600 })
          : jsonResponse({ sheets: [{ properties: { sheetId: 1, title: 'Sheet1' }, data: [{ rowData: [] }] }] }),
      async () => {
        await assert.rejects(
          () => readSnapshot('Movies'),
          (err: unknown) => {
            assert.ok(err instanceof SheetsAccessError, `expected a SheetsAccessError, got ${String(err)}`);
            assert.equal(err.needsHuman, true);
            return true;
          },
        );
      },
    ),
  );
});
