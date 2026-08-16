import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveUrl,
  rollingUrl,
  monthsBack,
  mergeCalendars,
  fetchCalendar,
  fetchRolling,
} from '../../../src/feed/io/calendar.ts';
import { cachedKeys, clearCache } from '../../../src/api/cdn.ts';
import type { CalendarFile } from '../../../src/api/simkl/types.ts';
import { clearRequests, recentRequests } from '../../../src/api/requests.ts';
import { calendarFile, jsonResponse, withFetch } from '../../helpers.ts';

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
  const mid = Temporal.Instant.from('2026-08-20T12:00:00Z');
  assert.deepEqual(monthsBack(5, mid), [{ year: 2026, month: 8 }]);

  const crossing = Temporal.Instant.from('2026-08-10T12:00:00Z');
  assert.deepEqual(monthsBack(14, crossing), [
    { year: 2026, month: 7 },
    { year: 2026, month: 8 },
  ]);
});

test('monthsBack crosses a year boundary', () => {
  assert.deepEqual(monthsBack(14, Temporal.Instant.from('2026-01-05T12:00:00Z')), [
    { year: 2025, month: 12 },
    { year: 2026, month: 1 },
  ]);
});

// A 90-day window spans exactly the four months it touches, in order, with no
// padding in the URLs they build.
test('a long window spans every month it touches, oldest first', () => {
  const months = monthsBack(90, Temporal.Instant.from('2026-08-10T12:00:00Z'));
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
  assert.deepEqual(monthsBack(0, Temporal.Instant.from('2026-08-10T12:00:00Z')), [{ year: 2026, month: 8 }]);
});

// The window has to be measured in the same zone the join's cutoff is, or the
// two disagree about which months the grace period reaches. Behind UTC, near a
// month boundary, an entry that passes the join's filter would live in an
// archive nothing ever fetched.
test('the window is counted from the local date, not the UTC one', () => {
  const now = Temporal.Instant.from('2026-03-15T02:00:00Z'); // 14 March, 22:00 in New York
  assert.deepEqual(monthsBack(14, now, 'America/New_York'), [
    { year: 2026, month: 2 },
    { year: 2026, month: 3 },
  ]);
  // The same instant in a zone where it is already the 15th reaches March only.
  assert.deepEqual(monthsBack(14, now, 'Europe/London'), [{ year: 2026, month: 3 }]);
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
      assert.equal(first.source, 'fresh', 'a real fetch is not from cache');

      for (let i = 0; i < 3; i += 1) {
        const again = await fetchRolling('tv');
        assert.equal(again.data.calendar.length, 1, 'the cached copy is still served');
        assert.equal(again.source, 'cache', 'and every failed refresh says so');
      }
    },
  );
});

// A timeout, a DNS failure or a reset are the likeliest ways the CDN fails, and
// they arrive as a throw rather than a status. One escaping past the fallback
// discarded a perfectly good cached month — silently, because the caller reads
// staleness off the rolling file alone.
test('a network throw serves the cached copy, exactly as a bad status does', async () => {
  let calls = 0;
  await withFetch(
    () => {
      if (++calls === 1) return jsonResponse(GOOD);
      throw new TypeError('fetch failed');
    },
    async () => {
      await fetchRolling('tv');
      const again = await fetchRolling('tv');
      assert.equal(again.data.calendar.length, 1, 'the cached copy is still served');
      assert.equal(again.source, 'cache');
    },
  );
});

test('a network throw with nothing cached still fails rather than inventing a feed', async () => {
  await withFetch(
    () => {
      throw new TypeError('fetch failed');
    },
    async () => {
      await assert.rejects(() => fetchRolling('tv'), /could not be fetched/);
    },
  );
});

test('a 304 reports the CDN answered with nothing new', async () => {
  let calls = 0;
  await withFetch(
    () => (++calls === 1 ? jsonResponse(GOOD, { lastModified: 'Sat, 01 Aug 2026 00:00:00 GMT' }) : new Response(null, { status: 304 })),
    async () => {
      const first = await fetchRolling('tv');
      assert.equal(first.source, 'fresh', 'a body is not a 304');
      const cached = await fetchRolling('tv');
      assert.equal(cached.data.calendar.length, 1);
      // Not `cache`: a 304 means the CDN answered and had nothing new, which is
      // the healthy outcome and must not read as an outage.
      assert.equal(cached.source, 'not-modified');
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
      assert.equal(bad.source, 'cache', 'and the caller is told it is not fresh');
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
      await fetchCalendar('tv', { graceDays: 14, now: Temporal.Instant.from('2026-08-01T12:00:00Z') });
      assert.deepEqual(
        cachedKeys().sort(),
        ['calendar-tv', 'calendar-tv-2026-7', 'calendar-tv-2026-8'],
        'July and August span the window on 1 August',
      );

      // A month later July is out of the window and must not be retained.
      await fetchCalendar('tv', { graceDays: 14, now: Temporal.Instant.from('2026-09-20T12:00:00Z') });
      assert.deepEqual(cachedKeys().sort(), ['calendar-tv', 'calendar-tv-2026-9']);
    },
  );
});

test('evicting one calendar type leaves the other alone', async () => {
  await withFetch(
    () => jsonResponse(GOOD),
    async () => {
      const now = Temporal.Instant.from('2026-08-20T12:00:00Z');
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
      const { data: merged, source } = await fetchCalendar('tv', {
        graceDays: 14,
        now: Temporal.Instant.from('2026-08-20T12:00:00Z'),
        log: (m) => void logged.push(m),
      });
      assert.equal(merged.calendar.length, 1, 'the rolling file still carries the feed');
      assert.equal(source, 'fresh', 'a failed archive is not the rolling file falling back to cache');
      assert.ok(logged.some((l) => /archive .* unavailable/.test(l)), logged.join('\n'));
    },
  );
});

// The third outcome, and the only one that is a fault: a cache served after a
// failure must not read as "the CDN said nothing changed" — it said nothing.
test('a cache served after a failure is neither fresh nor a 304', async () => {
  let calls = 0;
  await withFetch(
    () => (++calls === 1 ? jsonResponse(GOOD, { lastModified: 'Sat, 01 Aug 2026 00:00:00 GMT' }) : Promise.reject(new Error('offline'))),
    async () => {
      await fetchRolling('tv');
      const fallback = await fetchRolling('tv');
      assert.equal(fallback.source, 'cache');
    },
  );
});

// --- what the status page is shown -----------------------------------------

// The 304 row is the one that proves the conditional GET is doing its job: the
// CDN answered, and there was nothing to download.
test('a 304 is recorded as an answer carrying no body', async () => {
  clearCache();
  clearRequests();
  let calls = 0;
  await withFetch(
    () => (++calls === 1 ? jsonResponse(GOOD, { lastModified: 'Sat, 01 Aug 2026 00:00:00 GMT' }) : new Response(null, { status: 304 })),
    async () => {
      await fetchRolling('tv');
      await fetchRolling('tv');
    },
  );

  const log = recentRequests();
  assert.equal(log.length, 2);
  assert.equal(log[0]?.status, 304);
  assert.equal(log[0]?.bytes, null, 'nothing came down, and the row says so');
  assert.equal(log[1]?.status, 200);
  assert.ok((log[1]?.bytes ?? 0) > 0, 'the first fetch did download a body');
  assert.equal(log[0]?.service, 'cdn');
  assert.equal(log[0]?.component, 'calendars', 'and says which part of the service asked');
});

// Serving a stale cache is a success to the caller and a failure upstream. The
// row is the only place that distinction survives.
test('a CDN failure served from cache is still recorded as a failure', async () => {
  clearCache();
  clearRequests();
  let calls = 0;
  await withFetch(
    () => (++calls === 1 ? jsonResponse(GOOD) : new Response('nope', { status: 503 })),
    async () => {
      await fetchRolling('tv');
      const stale = await fetchRolling('tv');
      assert.equal(stale.source, 'cache', 'the caller still got data');
    },
  );

  const log = recentRequests();
  assert.equal(log[0]?.status, 503);
  assert.match(log[0]?.error ?? '', /503/);
});

// `Orchestrator.stop()` aborts in-flight calendar fetches, so a shutdown would
// otherwise file an error row per calendar and feed them to the page's error
// summary — a clean stop reading as three CDN failures.
test('a fetch the caller cancelled is not recorded as a failure', async () => {
  clearCache();
  clearRequests();
  const controller = new AbortController();
  controller.abort();

  await withFetch(
    () => {
      // What undici does with an aborted signal, which the stub does not model
      // on its own — and without the rejection the guard is never reached.
      throw new DOMException('This operation was aborted', 'AbortError');
    },
    async () => {
      await assert.rejects(() => fetchRolling('tv', { signal: controller.signal }));
    },
  );

  assert.deepEqual(recentRequests(), [], 'a cancelled call is not an outcome worth a row');
});
