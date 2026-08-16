import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractItems, itemSimklId, idSet, episodeCode, join } from '../src/join.ts';
import { localDate, releaseDate, shiftDate } from '../src/dates.ts';
import type { CalendarEntry, CalendarFile, CalendarType, Library, MovieRelease } from '../src/simkl/types.ts';
import { calendarOf } from './helpers.ts';

type Cals = Partial<Record<CalendarType, CalendarFile>>;

const show = (simkl: number, title = `Show ${simkl}`) => ({ show: { title, ids: { simkl } } });
const movie = (simkl: number, title = `Film ${simkl}`) => ({ movie: { title, ids: { simkl } } });


// A 9pm Tuesday ET broadcast is stamped 01:00Z Wednesday. Slicing the ISO string
// would put it on Wednesday for everyone, which is wrong for the US audience.
const NINE_PM_ET_TUESDAY = '2026-08-12T01:00:00Z';

test('localDate resolves a US evening airing to the correct day in each zone', () => {
  assert.equal(localDate(NINE_PM_ET_TUESDAY, 'America/New_York'), '2026-08-11');
  assert.equal(localDate(NINE_PM_ET_TUESDAY, 'Europe/London'), '2026-08-12');
  // Naive slicing agrees with London and is wrong for New York.
  assert.equal(NINE_PM_ET_TUESDAY.slice(0, 10), localDate(NINE_PM_ET_TUESDAY, 'Europe/London'));
  assert.notEqual(NINE_PM_ET_TUESDAY.slice(0, 10), localDate(NINE_PM_ET_TUESDAY, 'America/New_York'));
});

test('localDate handles the midnight-UTC boundary', () => {
  assert.equal(localDate('2026-08-12T00:00:00Z', 'America/New_York'), '2026-08-11');
  assert.equal(localDate('2026-08-12T00:00:00Z', 'Europe/London'), '2026-08-12');
});

test('releaseDate normalises to a plain date', () => {
  assert.equal(releaseDate('2026-12-18'), '2026-12-18');
  assert.equal(releaseDate('2026-12-18T04:00:00Z'), '2026-12-18');
});

test('extractItems copes with the shapes the API actually returns', () => {
  assert.deepEqual(extractItems({}), []);          // empty list
  assert.deepEqual(extractItems(null), []);
  assert.deepEqual(extractItems({ shows: [show(1)] }), [show(1)]);
  assert.deepEqual(extractItems({ anime: [show(2)] }), [show(2)]);
  assert.deepEqual(extractItems({ movies: [movie(3)] }), [movie(3)]);
});

test('itemSimklId bridges the library ids.simkl to the calendar simkl_id', () => {
  assert.equal(itemSimklId(show(3407)), 3407);
  assert.equal(itemSimklId(movie(174094)), 174094);
  assert.equal(itemSimklId({ show: { title: 'No ids', ids: {} } }), null);
  assert.equal(idSet({ shows: [show(1)] }).has(1), true);
});

test('episodeCode pads, and omits the season for unseasoned anime', () => {
  assert.equal(episodeCode(4, 3), 'S04E03');
  assert.equal(episodeCode(11, 12), 'S11E12');
  assert.equal(episodeCode(null, 8), 'E08');
});

test('episodeCode returns null rather than formatting a missing episode', () => {
  // The anime calendar carries occasional entries with no `episode` object;
  // formatting those produced "Eundefined" in the summary and the UID.
  assert.equal(episodeCode(null, null), null);
  assert.equal(episodeCode(undefined, undefined), null);
});

// --- join ---------------------------------------------------------------

const NOW = new Date('2026-08-10T12:00:00Z');

const tvEntry = (
  id: number,
  season: number | null,
  episode: number,
  date: string,
  finale: 1 | 2 | 3 | null = null,
): CalendarEntry => ({
  simkl_id: id,
  date,
  finale_type: finale,
  episode: { season, episode, title: `Ep ${episode}`, url: `https://simkl.com/tv/${id}/` },
});

const calendars = (tv: CalendarEntry[] = []): Cals => ({
  tv: calendarOf(tv, {
    100: { title: 'Watched Show', network: 'HBO', runtime: '60m', url: '/tv/100/x' },
    200: { title: 'Planned Show', url: '/tv/200/y' },
    400: { title: 'Completed Show', url: '/tv/400/z' },
  }),
  anime: calendarOf([], {}),
});

const library: Library = {
  shows_watching: { shows: [show(100, 'Watched Show')] },
  shows_plantowatch: { shows: [show(200, 'Planned Show')] },
  shows_completed: { shows: [show(400, 'Completed Show')] },
  anime_watching: {},
  anime_plantowatch: {},
  anime_completed: {},
  movies_plantowatch: { movies: [movie(300, 'Planned Film')] },
};

test('watching shows contribute every upcoming episode', () => {
  const events = join(calendars([tvEntry(100, 4, 3, '2026-08-15T20:00:00Z')]), library, { timezone: 'Europe/London', now: NOW });
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, 'Watched Show – S04E03');
});

test('plan-to-watch contributes premieres only', () => {
  const events = join(
    calendars([tvEntry(200, 1, 1, '2026-08-15T20:00:00Z'), tvEntry(200, 2, 1, '2026-08-16T20:00:00Z')]),
    library,
    { timezone: 'Europe/London', now: NOW },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, 'Planned Show – S01E01');
});

// SIMKL marks an ongoing show completed once everything aired has been watched,
// so a between-seasons show lives here. Excluding it would silently drop the
// next season from the feed.
test('completed shows still contribute upcoming episodes', () => {
  const events = join(calendars([tvEntry(400, 4, 1, '2026-08-15T20:00:00Z')]), library, { timezone: 'Europe/London', now: NOW });
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, 'Completed Show – S04E01');
});

test('completed shows are not limited to premieres the way plan-to-watch is', () => {
  const events = join(
    calendars([tvEntry(400, 4, 5, '2026-08-15T20:00:00Z'), tvEntry(400, 4, 6, '2026-08-22T20:00:00Z')]),
    library,
    { timezone: 'Europe/London', now: NOW },
  );
  assert.equal(events.length, 2);
});

// SIMKL's anime calendar carries no season field at all, so a premiere rule
// requiring season === 1 could never match anything anime.
test('anime plan-to-watch premieres match despite having no season', () => {
  const animeLibrary = { ...library, anime_plantowatch: { anime: [show(500, 'Some Anime')] } };
  const cals: Cals = {
    tv: calendarOf([], {}),
    anime: calendarOf([
      { simkl_id: 500, date: '2026-08-15T15:00:00Z', finale_type: null, episode: { season: null, episode: 1, title: 'a', url: '' } },
      { simkl_id: 500, date: '2026-08-22T15:00:00Z', finale_type: null, episode: { season: null, episode: 2, title: 'b', url: '' } },
    ], { 500: { title: 'Some Anime' } }),
  };
  const events = join(cals, animeLibrary, { timezone: 'Europe/London', now: NOW });
  assert.equal(events.length, 1, 'only the premiere');
  assert.equal(events[0].summary, 'Some Anime – E01');
});

test('an entry with no episode object gets a date-keyed uid, not "Eundefined"', () => {
  const animeLibrary = { ...library, anime_watching: { anime: [show(600, 'Some Anime')] } };
  const cals: Cals = {
    tv: calendarOf([], {}),
    anime: calendarOf([
      { simkl_id: 600, date: '2026-08-27T15:00:00Z', finale_type: null },
      { simkl_id: 600, date: '2026-08-28T15:00:00Z', finale_type: null },
    ], { 600: { title: 'Some Anime' } }),
  };
  const events = join(cals, animeLibrary, { timezone: 'Europe/London', now: NOW });
  assert.equal(events.length, 2, 'two episode-less entries must not collapse onto one uid');
  for (const event of events) {
    assert.ok(!event.uid.includes('undefined'), event.uid);
    assert.ok(!event.summary.includes('undefined'), event.summary);
  }
  assert.equal(events[0].summary, 'Some Anime');
  assert.equal(events[0].uid, 'simkl-600-20260827@simkl-ical');
});

// SIMKL reports a move against the destination list only, and `listSignature`
// advances only for the destination — so the source list is never refetched and
// the show sits in both indefinitely. Membership alone therefore keeps a
// dropped show's *future* episodes coming forever, since a future date is
// always inside the grace window.
test('a show whose status says it moved on contributes nothing, however it is still listed', () => {
  for (const status of ['dropped', 'hold']) {
    const moved: Library = { ...library, shows_watching: { shows: [{ ...show(100, 'Watched Show'), status }] } };
    const events = join(calendars([tvEntry(100, 4, 3, '2026-08-15T20:00:00Z')]), moved, { timezone: 'Europe/London', now: NOW });
    assert.deepEqual(events, [], `status ${status}`);
  }
});

// The counterpart, and the reason `completed` is not on that list: everything a
// completed title contributes is already dated, so it ages out on its own.
test('a completed show is still not treated as having moved on', () => {
  const completed: Library = { ...library, shows_completed: { shows: [{ ...show(400, 'Completed Show'), status: 'completed' }] } };
  const events = join(calendars([tvEntry(400, 4, 1, '2026-08-15T20:00:00Z')]), completed, { timezone: 'Europe/London', now: NOW });
  assert.equal(events.length, 1);
});

test('shows not in any list are excluded', () => {
  const events = join(calendars([tvEntry(999, 1, 1, '2026-08-15T20:00:00Z')]), library, { timezone: 'Europe/London', now: NOW });
  assert.equal(events.length, 0);
});

test('with no grace, past episodes are dropped and today is kept', () => {
  const events = join(
    calendars([tvEntry(100, 1, 1, '2026-08-01T20:00:00Z'), tvEntry(100, 1, 2, '2026-08-10T20:00:00Z')]),
    library,
    { timezone: 'Europe/London', now: NOW, graceDays: 0 },
  );
  assert.deepEqual(events.map((e) => e.date), ['2026-08-10']);
});

test('a recently aired episode lingers for the grace window', () => {
  const events = join(
    calendars([tvEntry(100, 1, 1, '2026-08-05T20:00:00Z')]), // 5 days ago
    library,
    { timezone: 'Europe/London', now: NOW, graceDays: 14 },
  );
  assert.deepEqual(events.map((e) => e.date), ['2026-08-05']);
});

test('an episode older than the grace window is dropped', () => {
  const events = join(
    calendars([tvEntry(100, 1, 1, '2026-07-21T20:00:00Z')]), // 20 days ago
    library,
    { timezone: 'Europe/London', now: NOW, graceDays: 14 },
  );
  assert.equal(events.length, 0);
});

test('the grace boundary is inclusive on its oldest day', () => {
  const onBoundary = join(calendars([tvEntry(100, 1, 1, '2026-07-27T20:00:00Z')]), library, { timezone: 'Europe/London', now: NOW, graceDays: 14 });
  const dayBefore = join(calendars([tvEntry(100, 1, 1, '2026-07-26T20:00:00Z')]), library, { timezone: 'Europe/London', now: NOW, graceDays: 14 });
  assert.equal(onBoundary.length, 1);
  assert.equal(dayBefore.length, 0);
});

// The grace window is independent of watch state: the feed records what aired,
// it is not a to-do list.
test('an already-watched episode still lingers', () => {
  const watchedUpToDate = {
    ...library,
    shows_watching: { shows: [{ ...show(100), last_watched: 'S01E09', next_to_watch: null, watched_episodes_count: 9, total_episodes_count: 9 }] },
  };
  const events = join(
    calendars([tvEntry(100, 1, 1, '2026-08-05T20:00:00Z')]),
    watchedUpToDate,
    { timezone: 'Europe/London', now: NOW, graceDays: 14 },
  );
  assert.equal(events.length, 1, 'watch state must not affect the grace window');
});

test('a recently released film lingers too', () => {
  const events = join(calendars(), library, { timezone: 'Europe/London', now: NOW, graceDays: 14, movieReleases: filmReleases('2026-08-05') });
  assert.equal(events.length, 1);
  assert.equal(events[0].date, '2026-08-05');
});

test('shiftDate crosses month and year boundaries', () => {
  assert.equal(shiftDate('2026-08-10', -14), '2026-07-27');
  assert.equal(shiftDate('2026-01-05', -14), '2025-12-22');
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDate('2026-08-10', 0), '2026-08-10');
});

test('shiftDate is unaffected by DST transitions', () => {
  // BST ends 25 Oct 2026; midnight arithmetic would be at risk here, noon is not.
  assert.equal(shiftDate('2026-10-26', -1), '2026-10-25');
  assert.equal(shiftDate('2026-03-30', -1), '2026-03-29');
});

test('finale type decorates the summary', () => {
  const events = join(calendars([tvEntry(100, 3, 8, '2026-08-15T20:00:00Z', 2)]), library, { timezone: 'Europe/London', now: NOW });
  assert.equal(events[0].summary, 'Watched Show – S03E08 (Season finale)');
});

test('episode titles stay out of the summary', () => {
  const events = join(calendars([tvEntry(100, 4, 3, '2026-08-15T20:00:00Z')]), library, { timezone: 'Europe/London', now: NOW });
  assert.ok(!events[0].summary.includes('Ep 3'));
  assert.equal(events[0].episodeTitle, 'Ep 3');
});

const filmReleases = (date: string): Map<number, MovieRelease> =>
  new Map([[300, { simkl_id: 300, title: 'Planned Film', date, releaseType: 3, runtime: '140m', url: 'https://simkl.com/movies/300' }]]);

test('plan-to-watch films are included by release date', () => {
  const events = join(calendars(), library, { timezone: 'Europe/London', now: NOW, movieReleases: filmReleases('2026-08-20') });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'movie');
  assert.equal(events[0].date, '2026-08-20');
  assert.equal(events[0].summary, 'Planned Film');
  assert.equal(events[0].detail, 'In cinemas');
});

test('films far beyond the 33-day calendar window still appear', () => {
  const events = join(calendars(), library, { timezone: 'Europe/London', now: NOW, movieReleases: filmReleases('2027-04-30') });
  assert.equal(events.length, 1);
  assert.equal(events[0].date, '2027-04-30');
});

test('films already released are dropped', () => {
  const events = join(calendars(), library, { timezone: 'Europe/London', now: NOW, movieReleases: filmReleases('2025-12-17') });
  assert.equal(events.length, 0);
});

test('films with no resolvable release date are skipped', () => {
  const events = join(calendars(), library, { timezone: 'Europe/London', now: NOW, movieReleases: new Map() });
  assert.equal(events.length, 0);
});

test('events are deduplicated by uid and sorted by date', () => {
  const dup = tvEntry(100, 4, 3, '2026-08-15T20:00:00Z');
  const events = join(calendars([dup, dup, tvEntry(100, 4, 2, '2026-08-12T20:00:00Z')]), library, { timezone: 'Europe/London', now: NOW });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.date), ['2026-08-12', '2026-08-15']);
});
