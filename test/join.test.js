import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDate, releaseDate, extractItems, itemSimklId, idSet, episodeCode, join } from '../src/join.js';

// A 9pm Tuesday ET broadcast is stamped 01:00Z Wednesday. Slicing the ISO string
// would put it on Wednesday for everyone, which is wrong for the US audience.
const NINE_PM_ET_TUESDAY = '2026-08-12T01:00:00Z';

test('localDate resolves a US evening airing to the correct day in each zone', () => {
  assert.equal(localDate(NINE_PM_ET_TUESDAY, 'America/New_York'), '2026-08-11');
  assert.equal(localDate(NINE_PM_ET_TUESDAY, 'Europe/London'), '2026-08-12');
  // The naive approach, kept here to document what we are avoiding.
  assert.notEqual(NINE_PM_ET_TUESDAY.slice(0, 10), '2026-08-11');
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
  assert.deepEqual(extractItems({ shows: [1] }), [1]);
  assert.deepEqual(extractItems({ anime: [2] }), [2]);
  assert.deepEqual(extractItems({ movies: [3] }), [3]);
});

test('itemSimklId bridges the library ids.simkl to the calendar simkl_id', () => {
  assert.equal(itemSimklId({ show: { ids: { simkl: 3407 } } }), 3407);
  assert.equal(itemSimklId({ movie: { ids: { simkl: 174094 } } }), 174094);
  assert.equal(itemSimklId({ show: { ids: {} } }), null);
  assert.equal(idSet({ shows: [{ show: { ids: { simkl: 1 } } }] }).has(1), true);
});

test('episodeCode pads, and omits the season for unseasoned anime', () => {
  assert.equal(episodeCode(4, 3), 'S04E03');
  assert.equal(episodeCode(11, 12), 'S11E12');
  assert.equal(episodeCode(null, 8), 'E08');
});

// --- join ---------------------------------------------------------------

const NOW = new Date('2026-08-10T12:00:00Z');

const tvEntry = (id, season, episode, date, finale = null) => ({
  simkl_id: id,
  date,
  finale_type: finale,
  episode: { season, episode, title: `Ep ${episode}`, url: `https://simkl.com/tv/${id}/` },
});

const calendars = (tv = []) => ({
  tv: { calendar: tv, metadata: { 100: { title: 'Watched Show', network: 'HBO', runtime: '60m', url: '/tv/100/x' }, 200: { title: 'Planned Show', url: '/tv/200/y' } } },
  anime: { calendar: [], metadata: {} },
});

const library = {
  shows_watching: { shows: [{ show: { ids: { simkl: 100 } } }] },
  shows_plantowatch: { shows: [{ show: { ids: { simkl: 200 } } }] },
  anime_watching: {},
  anime_plantowatch: {},
  movies_plantowatch: { movies: [{ movie: { ids: { simkl: 300 } } }] },
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

test('shows not in any list are excluded', () => {
  const events = join(calendars([tvEntry(999, 1, 1, '2026-08-15T20:00:00Z')]), library, { timezone: 'Europe/London', now: NOW });
  assert.equal(events.length, 0);
});

test('past episodes are dropped, today is kept', () => {
  const events = join(
    calendars([tvEntry(100, 1, 1, '2026-08-01T20:00:00Z'), tvEntry(100, 1, 2, '2026-08-10T20:00:00Z')]),
    library,
    { timezone: 'Europe/London', now: NOW },
  );
  assert.deepEqual(events.map((e) => e.date), ['2026-08-10']);
});

test('finale type decorates the summary', () => {
  const events = join(calendars([tvEntry(100, 3, 8, '2026-08-15T20:00:00Z', 2)]), library, { timezone: 'Europe/London', now: NOW });
  assert.equal(events[0].summary, 'Watched Show – S03E08 (Season finale)');
  assert.equal(events[0].finale, 'Season finale');
});

test('episode titles stay out of the summary', () => {
  const events = join(calendars([tvEntry(100, 4, 3, '2026-08-15T20:00:00Z')]), library, { timezone: 'Europe/London', now: NOW });
  assert.ok(!events[0].summary.includes('Ep 3'));
  assert.equal(events[0].episodeTitle, 'Ep 3');
});

const filmReleases = (date) =>
  new Map([[300, { simkl_id: 300, title: 'Planned Film', date, releaseType: 3, runtime: '140m', url: 'https://simkl.com/movies/300' }]]);

test('plan-to-watch films are included by release date', () => {
  const events = join(calendars(), library, { timezone: 'Europe/London', now: NOW, movieReleases: filmReleases('2026-08-20') });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'movie');
  assert.equal(events[0].date, '2026-08-20');
  assert.equal(events[0].summary, 'Planned Film');
  assert.equal(events[0].network, 'In cinemas');
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
