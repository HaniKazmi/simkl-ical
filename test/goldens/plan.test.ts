/**
 * The reference grid × reference library must plan the identical write set
 * before and after the refactor: same addresses, same fields, same insert.
 *
 * The golden is the `PlanRecord` — the structured projection that survives the
 * run — not `describePlan`'s strings, whose wording is allowed to drift. The
 * plan is also pushed through the guard, so the golden additionally pins that a
 * realistic plan stays guard-clean.
 */
import { test } from 'node:test';
import { parseGrid } from '../../src/sheet/2-grid.ts';
import { indexLibrary } from '../../src/sheet/1-index.ts';
import { planRecord, planSync } from '../../src/sheet/4-plan.ts';
import type { CatalogueView } from '../../src/sheet/3-catalogue.ts';
import { assertPlanSafe } from '../../src/sheet/5-guard.ts';
import { libraryOf, seasonRow, sheetSnapshot, SHEET_HEADERS, showRow } from '../helpers.ts';
import { expectGolden } from './golden.ts';

const NOW = Temporal.Instant.from('2026-08-20T12:00:00Z');
const TZ = 'Europe/London';

/** Season 2 of Fargo, watched out: eight evenings, the last on 8 August. */
const fargoS2 = Array.from({ length: 8 }, (_, i) => `2026-08-0${i + 1}T20:00:00Z`);

test('the reference grid plans the committed write set', async () => {
  const grid = parseGrid(
    sheetSnapshot([
      SHEET_HEADERS,
      showRow('Fargo', 'Watching', 1),
      seasonRow(1, 6, 44000),
      // The open season about to close: Episodes blank, so the runtime write
      // has a cell to fill in the same batch that dates the row.
      seasonRow(2, 3, null, { episodes: null }),
      showRow('Alien', 'Watching', 2),
      seasonRow(1, 2, null),
    ]),
  );

  const library = libraryOf(
    {
      id: 1,
      title: 'Fargo',
      status: 'completed',
      seasons: {
        1: Array.from({ length: 6 }, () => '2024-01-05T20:00:00Z'),
        2: fargoS2,
      },
    },
    {
      id: 2,
      title: 'Alien',
      status: 'watching',
      total: 20,
      seasons: {
        1: Array.from({ length: 5 }, (_, i) => `2026-08-0${i + 1}T21:00:00Z`),
        // Watched into a season the sheet has no row for: the insert candidate.
        2: Array.from({ length: 4 }, (_, i) => `2026-08-1${i}T21:00:00Z`),
      },
    },
  );

  const catalogue: CatalogueView = {
    titles: new Map([
      [
        1,
        {
          shapes: new Map([
            [1, { number: 1, total: 6, aired: 6 }],
            [2, { number: 2, total: 8, aired: 8 }],
          ]),
          status: 'ended',
          runtime: 45,
          tvdbId: 111,
          seasonRuntimes: new Map([[2, 43]]),
        },
      ],
      [
        2,
        {
          shapes: new Map([
            [1, { number: 1, total: 10, aired: 10 }],
            // Still airing, so the inserted row goes in open with no runtime.
            [2, { number: 2, total: 10, aired: 6 }],
          ]),
          status: 'airing',
          runtime: 40,
          tvdbId: 900,
          seasonRuntimes: new Map(),
        },
      ],
    ]),
    failed: [],
    unavailable: [],
  };

  const plan = planSync(grid, indexLibrary(library), catalogue, { now: NOW, timezone: TZ, sinceDays: 90 });
  assertPlanSafe(plan, grid, { now: NOW, timezone: TZ });

  await expectGolden('plan.json', JSON.stringify(planRecord(plan), null, 2) + '\n');
});
