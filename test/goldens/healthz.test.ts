/**
 * `/healthz` is a container healthcheck and a CI assertion, which makes its key
 * set a contract. The golden pins every key path in the response body so a
 * restructuring of how the state is assembled cannot quietly change what a
 * machine reads.
 */
import { test } from 'node:test';
import { assess, healthResponse } from '../../src/health.ts';
import type { Snapshot } from '../../src/orchestrator.ts';
import { libraryCounts } from '../../src/library-counts.ts';
import { expectGolden } from './golden.ts';

const keyPaths = (value: unknown, prefix = ''): string[] => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.keys(value)
    .sort()
    .flatMap((key) => keyPaths((value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key));
};

test('the /healthz body keeps its key set', async () => {
  const snapshot: Snapshot = {
    startedAt: '2026-08-20T11:00:00.000Z',
    library: {
      polledAt: '2026-08-20T12:00:00.000Z',
      syncedAt: '2026-08-20T11:00:00.000Z',
      error: null,
      counts: libraryCounts(null),
      poll: null,
      movement: null,
    },
    feed: {
      events: 42,
      renderedAt: '2026-08-20T12:00:00.000Z',
      servingCached: false,
      error: null,
      calendars: { attemptedAt: '2026-08-20T09:00:00.000Z', freshAt: '2026-08-20T09:00:00.000Z', changedAt: null, error: null },
      films: { resolved: 3, resolvedAt: '2026-08-20T09:00:00.000Z' },
    },
    sheet: { configured: true, status: 'applied', lastRunAt: '2026-08-20T12:00:00.000Z', frozen: null, error: null },
  };

  const response = healthResponse(snapshot, assess(snapshot));
  await expectGolden('healthz-keys.json', JSON.stringify(keyPaths(response), null, 2) + '\n');
});
