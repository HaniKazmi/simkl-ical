/**
 * `/healthz` is a container healthcheck and a CI assertion, which makes its key
 * set a contract. The golden pins every key path in the response body so a
 * restructuring of how the state is assembled cannot quietly change what a
 * machine reads.
 */
import { test } from 'node:test';
import { buildHealth, healthResponse } from '../../src/health.ts';
import { expectGolden } from './golden.ts';

const keyPaths = (value: unknown, prefix = ''): string[] => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.keys(value)
    .sort()
    .flatMap((key) => keyPaths((value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key));
};

test('the /healthz body keeps its key set', async () => {
  const response = healthResponse(
    buildHealth({
      polledAt: '2026-08-20T12:00:00.000Z',
      libraryAt: '2026-08-20T11:00:00.000Z',
      libraryError: null,
      events: 42,
      renderedAt: '2026-08-20T12:00:00.000Z',
      servingCached: false,
      renderError: null,
      calendarsAt: '2026-08-20T09:00:00.000Z',
      calendarsFreshAt: '2026-08-20T09:00:00.000Z',
      calendarError: null,
      sheetConfigured: true,
      sheetStatus: 'applied',
      sheetLastRunAt: '2026-08-20T12:00:00.000Z',
      sheetFrozen: false,
      sheetError: null,
    }),
  );

  await expectGolden('healthz-keys.json', JSON.stringify(keyPaths(response), null, 2) + '\n');
});
