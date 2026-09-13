/**
 * The reference grid × a TV show it has no block for must always plan the
 * identical block: the same span, the same cells, the same formula text.
 *
 * The fill is the whole point of this golden. Every cell on a show row is
 * written once in the batch that creates it and nothing revisits it, so a
 * drift here is a drift nothing downstream would ever correct — and the five
 * roll-ups and the artwork link are *formulas*, the one place the sync writes
 * one, where a wrong reference is a silently frozen number rather than an
 * error. A bucket is configured so the artwork formula is pinned too.
 *
 * Every input is fixed: a relative watch date would move the `Start` serial
 * and the last-watched note daily, and the golden would fail on a clean
 * checkout tomorrow. The plan also runs through the guard, so this pins that a
 * realistic block stays guard-clean.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnLetter } from '../../src/sheet/2-grid.ts';
import { planRecord, planSync } from '../../src/sheet/4-plan.ts';
import { assertPlanSafe } from '../../src/sheet/5-guard.ts';
import { blockLibrary, fx } from '../sheet/fixture.ts';
import { expectGolden } from './golden.ts';

const NOW = Temporal.Instant.from('2026-08-20T12:00:00Z');
const TZ = 'Europe/London';
const BUCKET = 'reference-shows';

test('a reference block plans the committed rows', async () => {
  // Two evenings of a nine-episode season that has finished airing: the row
  // goes in open, with the note that dates its count, and carries the season's
  // own runtime.
  const { index, titles } = blockLibrary({}, { seasons: { 1: ['2026-08-10T20:00:00Z', '2026-08-17T20:00:00Z'] } });

  const { plan, demands } = planSync(fx.grid, index, titles, {
    now: NOW,
    timezone: TZ,
    facts: { tvdb: true, tmdb: true },
    showBucket: BUCKET,
  });

  assert.deepEqual(demands.genres, [], 'every fact the block needs is already in hand');
  assert.deepEqual(demands.certificates, []);
  assert.doesNotThrow(() => assertPlanSafe(plan, fx.grid, { now: NOW, timezone: TZ, showBucket: BUCKET }));

  const golden = {
    ...planRecord(plan),
    fill:
      plan.insert?.fill.map((cell) => ({
        // The sheet's own row number, so the show row and the season row under
        // it read as the two rows they are.
        row: cell.row + 1,
        column: columnLetter(cell.column),
        field: cell.field,
        value: cell.value?.stringValue ?? cell.value?.numberValue ?? cell.value?.formulaValue ?? null,
      })) ?? [],
  };
  await expectGolden('block-plan.json', JSON.stringify(golden, null, 2) + '\n');
});
