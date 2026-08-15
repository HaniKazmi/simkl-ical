import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveUrl,
  rollingUrl,
  monthsBack,
  mergeCalendars,
  fetchCalendar,
  fetchRolling,
  cachedKeys,
  clearCache,
} from '../src/sources/calendar.ts';
import type { CalendarFile } from '../src/simkl/types.ts';
import { calendarFile, jsonResponse, withFetch } from './helpers.ts';

test('archive URLs use an unpadded month', () => {
  // /2026/8/tv.json returns 200; /2026/08/tv.json returns 404. Verified live.
  assert.equal(archiveUrl('tv', 2026, 8), 'https://data.simkl.in/calendar/v2/2026/8/tv.json');
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

// A 90-day window spans exactly the four months it touches, in order, with no
// padding in the URLs they build.
test('a long window spans every month it touches, oldest first', () => {
  const months = monthsBack(90, new Date('2026-08-10T12:00:00Z'));
  assert.deepEqual(months, [
    { year: 2026, month: 5 },
    { year: 2026, month: 6 },
    { year: 2026, month: 7 },
    { year: 2026, month: 8 },
  ]);
  for (const { year, month } of months) {
    assert.ok(archiveUrl('tv', year, month).includes(`/${year}/${month}/`), `${year}/${month} must not be padded`);
  }
});

test('a zero-day window is still the current month, not nothing', () => {
  assert.deepEqual(monthsBack(0, new Date('2026-08-10T12:00:00Z')), [{ year: 2026, month: 8 }]);
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

// --- fetching, caching and the staleness signal ---------------------------

// The cache is module state shared by every test in this file.
beforeEach(clearCache);

const entry = (id: number, date: string) => ({ simkl_id: id, date, finale_type: null });
const GOOD = calendarFile([entry(1, '2026-08-01T20:00:00Z')]);

// A failure must be distinguishable from a real fetch, or an outage reports as
// a success on every cycle.
test('a CDN failure serves the cached copy but reports it as stale', async () => {
  let calls = 0;
  await withFetch(
    () => (++calls === 1 ? jsonResponse(GOOD) : new Response('upstream down', { status: 503 })),
    async () => {
      const first = await fetchRolling('tv');
      assert.equal(first.stale, false, 'a real fetch is not stale');

      for (let i = 0; i < 3; i += 1) {
        const again = await fetchRolling('tv');
        assert.equal(again.data.calendar.length, 1, 'the cached copy is still served');
        assert.equal(again.stale, true, 'and every failed refresh says so');
      }
    },
  );
});

test('a 304 is fresh, not stale — the CDN answered', async () => {
  let calls = 0;
  await withFetch(
    () => (++calls === 1 ? jsonResponse(GOOD, { lastModified: 'Sat, 01 Aug 2026 00:00:00 GMT' }) : new Response(null, { status: 304 })),
    async () => {
      await fetchRolling('tv');
      const cached = await fetchRolling('tv');
      assert.equal(cached.stale, false);
      assert.equal(cached.data.calendar.length, 1);
    },
  );
});

test('a conditional GET is sent once a Last-Modified is known', async () => {
  const seen: Array<string | undefined> = [];
  await withFetch(
    (_url, init) => {
      seen.push(new Headers(init?.headers).get('if-modified-since') ?? undefined);
      return jsonResponse(GOOD, { lastModified: 'Sat, 01 Aug 2026 00:00:00 GMT' });
    },
    async () => {
      await fetchRolling('tv');
      await fetchRolling('tv');
      assert.deepEqual(seen, [undefined, 'Sat, 01 Aug 2026 00:00:00 GMT']);
    },
  );
});

// A 200 is not a usable payload: `{}` would replace a good cache entry and
// render a near-empty feed.
test('a parseable 200 with no calendar array falls back instead of replacing the cache', async () => {
  let calls = 0;
  await withFetch(
    () => (++calls === 1 ? jsonResponse(GOOD) : jsonResponse({ error: 'nope' })),
    async () => {
      await fetchRolling('tv');
      const bad = await fetchRolling('tv');
      assert.equal(bad.data.calendar.length, 1, 'the good calendar survived');
      assert.equal(bad.stale, true, 'and the caller is told it is not fresh');
    },
  );
});

test('a first fetch with nothing cached still throws rather than inventing a feed', async () => {
  await withFetch(
    () => new Response('upstream down', { status: 503 }),
    async () => {
      await assert.rejects(() => fetchRolling('tv'), /returned 503/);
    },
  );
});

// Keyed per archive month, so without eviction every month the process
// survives retains two more multi-MB parsed calendars.
test('archives outside the grace window are evicted from the cache', async () => {
  await withFetch(
    () => jsonResponse(GOOD),
    async () => {
      await fetchCalendar('tv', { graceDays: 14, now: new Date('2026-08-01T12:00:00Z') });
      assert.deepEqual(
        cachedKeys().sort(),
        ['calendar-tv', 'calendar-tv-2026-7', 'calendar-tv-2026-8'],
        'July and August span the window on 1 August',
      );

      // A month later July is out of the window and must not be retained.
      await fetchCalendar('tv', { graceDays: 14, now: new Date('2026-09-20T12:00:00Z') });
      assert.deepEqual(cachedKeys().sort(), ['calendar-tv', 'calendar-tv-2026-9']);
    },
  );
});

test('evicting one calendar type leaves the other alone', async () => {
  await withFetch(
    () => jsonResponse(GOOD),
    async () => {
      const now = new Date('2026-08-20T12:00:00Z');
      await fetchCalendar('tv', { graceDays: 14, now });
      await fetchCalendar('anime', { graceDays: 14, now });
      assert.ok(cachedKeys().includes('calendar-tv-2026-8'), 'tv archive kept');
      assert.ok(cachedKeys().includes('calendar-anime-2026-8'), 'anime archive kept');
    },
  );
});

// A missing archive narrows the grace window, which looks identical to a feed
// with nothing old to show.
test('an unavailable archive is reported rather than swallowed', async () => {
  const logged: string[] = [];
  await withFetch(
    (url) => (url.includes('/2026/') ? new Response('gone', { status: 404 }) : jsonResponse(GOOD)),
    async () => {
      const { data: merged, stale } = await fetchCalendar('tv', {
        graceDays: 14,
        now: new Date('2026-08-20T12:00:00Z'),
        log: (m) => void logged.push(m),
      });
      assert.equal(merged.calendar.length, 1, 'the rolling file still carries the feed');
      assert.equal(stale, false, 'a failed archive is not rolling-file staleness');
      assert.ok(logged.some((l) => /archive .* unavailable/.test(l)), logged.join('\n'));
    },
  );
});
