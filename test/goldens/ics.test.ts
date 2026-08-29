/**
 * The reference library × reference calendars must render the identical ICS
 * before and after the refactor. Everything time-dependent is pinned: the
 * clock, the zone, the grace window. DTSTAMP is the render's own wall-clock
 * stamp, so it is normalised out.
 */
import { test } from 'node:test';
import { join as joinFeed } from '../../src/feed/2-join.ts';
import { renderIcs } from '../../src/feed/3-ics.ts';
import { calendarOf, libraryOf } from '../helpers.ts';
import type { CalendarEpisode } from '../../src/api/simkl/types.ts';
import type { MovieRelease } from '../../src/feed/1-films.ts';
import { expectGolden } from './golden.ts';

const NOW = Temporal.Instant.from('2026-08-20T12:00:00Z');
const TZ = 'Europe/London';

const ep = (season: number | null, episode: number, title: string | null = null, url = ''): CalendarEpisode => ({ season, episode, title, url });

test('the reference library renders the committed feed byte-for-byte', async () => {
  const library = libraryOf(
    { id: 1, title: 'Watching Show', status: 'watching' },
    { id: 2, title: 'Planned Show', status: 'plantowatch' },
    { id: 3, title: 'Dropped Show', status: 'dropped' },
    { id: 4, type: 'anime', title: 'Airing Anime', status: 'watching' },
    { id: 5, type: 'movies', title: 'Planned Film', status: 'plantowatch' },
    { id: 6, type: 'movies', title: 'Watched Film', status: 'completed' },
  );

  const tv = calendarOf(
    [
      // Inside the grace window, so it stays; the summary carries the finale label.
      { simkl_id: 1, date: '2026-08-18T02:00:00Z', finale_type: null, episode: ep(4, 2, 'Recently Aired', 'https://simkl.com/tv/1/e2') },
      { simkl_id: 1, date: '2026-08-22T00:30:00Z', finale_type: null, episode: ep(4, 3, 'Upcoming', 'https://simkl.com/tv/1/e3') },
      { simkl_id: 1, date: '2026-09-05T00:30:00Z', finale_type: 2, episode: ep(4, 10, 'The End', 'https://simkl.com/tv/1/e10') },
      // Aged out of the grace window.
      { simkl_id: 1, date: '2026-08-01T00:30:00Z', finale_type: null, episode: ep(4, 1, 'Too Old', 'https://simkl.com/tv/1/e1') },
      // Plan-to-watch contributes premieres only.
      { simkl_id: 2, date: '2026-09-01T01:00:00Z', finale_type: null, episode: ep(1, 1, 'Pilot', 'https://simkl.com/tv/2/e1') },
      { simkl_id: 2, date: '2026-09-08T01:00:00Z', finale_type: null, episode: ep(1, 2, 'Not A Premiere', 'https://simkl.com/tv/2/e2') },
      // Dropped and unknown titles contribute nothing.
      { simkl_id: 3, date: '2026-08-25T01:00:00Z', finale_type: null, episode: ep(2, 5) },
      { simkl_id: 99, date: '2026-08-25T01:00:00Z', finale_type: null, episode: ep(1, 1) },
    ],
    {
      '1': { title: 'Watching Show', network: 'FX', runtime: '45m', url: '/tv/1/watching-show' },
      '2': { title: 'Planned Show', network: null, runtime: '30m' },
    },
  );

  const anime = calendarOf(
    [
      // SIMKL numbers anime without a season, and some entries carry no episode at all.
      { simkl_id: 4, date: '2026-08-21T15:00:00Z', finale_type: null, episode: ep(null, 8, 'Cour Midpoint', 'https://simkl.com/anime/4/e8') },
      { simkl_id: 4, date: '2026-08-28T15:00:00Z', finale_type: null },
    ],
    { '4': { title: 'Airing Anime', network: 'Tokyo MX', runtime: '24m' } },
  );

  const movieReleases = new Map<number, MovieRelease>([
    [5, { simkl_id: 5, title: 'Planned Film', date: Temporal.PlainDate.from('2026-09-12'), releaseType: 3, runtime: '110m', url: 'https://simkl.com/movies/5' }],
    // Held for a film that is not planned: the join must not emit it.
    [6, { simkl_id: 6, title: 'Watched Film', date: Temporal.PlainDate.from('2026-09-20'), releaseType: 4, runtime: '95m', url: 'https://simkl.com/movies/6' }],
  ]);

  const events = joinFeed({ tv, anime }, library, { timezone: TZ, now: NOW, graceDays: 7, movieReleases });
  const ics = renderIcs(events, { name: 'SIMKL', timezone: TZ }).replace(/DTSTAMP:[0-9TZ]+/g, 'DTSTAMP:19700101T000000Z');

  await expectGolden('feed.ics', ics);
});
