import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveUrl, rollingUrl, monthsBack, mergeCalendars } from '../src/sources/calendar.ts';
import type { CalendarFile } from '../src/simkl/types.ts';

test('archive URLs use an unpadded month', () => {
  // /2026/8/tv.json returns 200; /2026/08/tv.json returns 404. Verified live.
  assert.equal(archiveUrl('tv', 2026, 8), 'https://data.simkl.in/calendar/v2/2026/8/tv.json');
  assert.ok(!archiveUrl('tv', 2026, 8).includes('/08/'));
  assert.equal(archiveUrl('anime', 2025, 12), 'https://data.simkl.in/calendar/v2/2025/12/anime.json');
});

test('rolling URLs point at the top-level files', () => {
  assert.equal(rollingUrl('tv'), 'https://data.simkl.in/calendar/v2/tv.json');
  assert.equal(rollingUrl('anime'), 'https://data.simkl.in/calendar/v2/anime.json');
});

test('monthsBack returns the distinct months a window spans', () => {
  const mid = new Date('2026-08-20T12:00:00Z');
  assert.deepEqual(monthsBack(5, mid), [{ year: 2026, month: 8 }]);

  const crossing = new Date('2026-08-10T12:00:00Z');
  assert.deepEqual(monthsBack(14, crossing), [
    { year: 2026, month: 7 },
    { year: 2026, month: 8 },
  ]);
});

test('monthsBack crosses a year boundary', () => {
  assert.deepEqual(monthsBack(14, new Date('2026-01-05T12:00:00Z')), [
    { year: 2025, month: 12 },
    { year: 2026, month: 1 },
  ]);
});

test('monthsBack never emits a padded month', () => {
  for (const { month } of monthsBack(90, new Date('2026-08-10T12:00:00Z'))) {
    assert.equal(typeof month, 'number');
    assert.ok(month >= 1 && month <= 12);
  }
});

test('merging de-duplicates episodes and unions metadata', () => {
  const archive: CalendarFile = {
    calendar: [{ simkl_id: 1, date: '2026-07-01T20:00:00Z', finale_type: null, episode: { season: 1, episode: 1, title: null, url: '' } }],
    metadata: { 1: { title: 'From archive' }, 2: { title: 'Archive only' } },
  };
  const rolling: CalendarFile = {
    calendar: [
      { simkl_id: 1, date: '2026-07-01T21:00:00Z', finale_type: null, episode: { season: 1, episode: 1, title: null, url: '' } }, // same episode, newer time
      { simkl_id: 3, date: '2026-08-11T20:00:00Z', finale_type: null, episode: { season: 2, episode: 4, title: null, url: '' } },
    ],
    metadata: { 1: { title: 'From rolling' } },
  };

  const merged = mergeCalendars([archive, rolling]);

  assert.equal(merged.calendar.length, 2, 'the duplicate episode should collapse');
  // Rolling is merged last, so it wins on conflict.
  assert.equal(merged.calendar.find((e) => e.simkl_id === 1)!.date, '2026-07-01T21:00:00Z');
  assert.equal(merged.metadata['1']!.title, 'From rolling');
  assert.equal(merged.metadata['2']!.title, 'Archive only');
});

// Entries with no `episode` object exist in the live anime calendar. Keying on
// season/episode alone made every one of them collapse onto a single slot,
// before the join's date-keyed UID ever saw them.
test('episode-less entries are keyed by date, not collapsed together', () => {
  const merged = mergeCalendars([
    {
      calendar: [
        { simkl_id: 600, date: '2026-08-27T15:00:00Z', finale_type: null },
        { simkl_id: 600, date: '2026-08-28T15:00:00Z', finale_type: null },
      ],
      metadata: {},
    },
  ]);
  assert.equal(merged.calendar.length, 2, 'two distinct airings must survive the merge');
});

test('merging tolerates missing or empty parts', () => {
  assert.deepEqual(mergeCalendars([]), { calendar: [], metadata: {} });
  assert.deepEqual(mergeCalendars([null, undefined, { calendar: [], metadata: {} }]), { calendar: [], metadata: {} });
});
