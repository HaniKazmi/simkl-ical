import { test } from 'node:test';
import assert from 'node:assert/strict';
import { airingIds, plannedIds, episodeCode, join } from '../../src/feed/2-join.ts';
import { itemSimklId } from '../../src/api/simkl/item.ts';
import { plainDateFrom, releaseDate } from '../../src/shared/dates.ts';
import type { CalendarEntry, CalendarFile, CalendarType, LibraryItem } from '../../src/api/simkl/types.ts';
import type { Library, LibraryEntry } from '../../src/library.ts';
import type { MovieRelease } from '../../src/feed/1-films.ts';
import { calendarOf } from '../helpers.ts';

type Cals = Partial<Record<CalendarType, CalendarFile>>;

const show = (simkl: number, title = `Show ${simkl}`) => ({ show: { title, ids: { simkl } } });
const movie = (simkl: number, title = `Film ${simkl}`) => ({ movie: { title, ids: { simkl } } });


test('releaseDate normalises to a plain date', () => {
  assert.equal(releaseDate('2026-12-18')?.toString(), '2026-12-18');
  assert.equal(releaseDate('2026-12-18T04:00:00Z')?.toString(), '2026-12-18');
});

// A partial date is a shape TMDB-derived records really carry. Throwing would
// escape the per-title lookup, be classified transient, and leave that film
// re-requested on every poll for the life of the process.
test('a release date that is not a date costs the date, not the film', () => {
  for (const bad of ['2013-00-00', '2026-13-01', 'unknown', '']) {
    assert.equal(releaseDate(bad), null, `${bad} should not parse`);
  }
});

test('itemSimklId bridges the library ids.simkl to the calendar simkl_id', () => {
  assert.equal(itemSimklId(show(3407)), 3407);
  assert.equal(itemSimklId(movie(174094)), 174094);
  assert.equal(itemSimklId({ show: { title: 'No ids', ids: {} } }), null);
});

// The library holds every film the user has ever completed, so a negative rule
// here would sweep hundreds of watched films into the feed and into a per-title
// lookup each. A show carrying no status is still one we hold.
test('the airing rule is negative and the planned rule is positive', () => {
  const library: Library = new Map([
    [1, { type: 'shows', item: show(1) }],
    [2, { type: 'movies', item: movie(2) }],
  ]);
  assert.equal(airingIds(library, 'shows').has(1), true, 'no status is still a show we hold');
  assert.equal(plannedIds(library, 'movies').has(2), false, 'no status is not a plan to watch');
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

const NOW = Temporal.Instant.from('2026-08-10T12:00:00Z');

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

const entry = (type: 'shows' | 'anime' | 'movies', item: LibraryItem, status: string): [number, LibraryEntry] => [
  itemSimklId(item)!,
  { type, item: { ...item, status } },
];

const library: Library = new Map([
  entry('shows', show(100, 'Watched Show'), 'watching'),
  entry('shows', show(200, 'Planned Show'), 'plantowatch'),
  entry('shows', show(400, 'Completed Show'), 'completed'),
  entry('movies', movie(300, 'Planned Film'), 'plantowatch'),
]);

/** The library with one record replaced, which is what a delta merge does. */
const withEntry = (base: Library, [id, value]: [number, LibraryEntry]): Library => new Map(base).set(id, value);

// --- what the feed is allowed to depend on ---------------------------------
//
// The feed answers "what airs next for the things you follow". Whether you have
// watched any of it is the sheet's question, not this one — and the poll runs
// on every episode you mark, so a feed that varied with watch progress would
// re-render and rewrite itself all day to produce the same bytes.

/** Everything a watched episode rewrites on a record, and none of it is status. */
const watched = (item: LibraryItem, count: number): LibraryItem => ({
  ...item,
  last_watched: `S01E${String(count).padStart(2, '0')}`,
  next_to_watch: `S01E${String(count + 1).padStart(2, '0')}`,
  last_watched_at: `2026-08-${String(count).padStart(2, '0')}T20:00:00Z`,
  watched_episodes_count: count,
  total_episodes_count: 24,
  seasons: [{ number: 1, episodes: Array.from({ length: count }, (_, i) => ({ number: i + 1, watched_at: '2026-08-01T20:00:00Z' })) }],
});

test('watch progress does not change the feed', () => {
  const cals = calendars([tvEntry(100, 4, 3, '2026-08-15T20:00:00Z'), tvEntry(100, 4, 4, '2026-08-22T20:00:00Z')]);
  const at = (count: number) =>
    join(cals, withEntry(library, [100, { type: 'shows', item: watched(show(100, 'Watched Show'), count) }]), {
      timezone: 'Europe/London',
      now: NOW,
    });

  assert.deepEqual(at(12), at(1), 'eleven more episodes watched, same feed');
  assert.ok(at(1).length > 0, 'and it is not vacuously empty');
});

// SIMKL marks an ongoing show completed the moment you catch up, and back to
// watching when the next episode drops — so this pair moves constantly. Both
// mean "still following it", so the feed must not be able to tell them apart.
test('a move between watching and completed does not change the feed', () => {
  const cals = calendars([tvEntry(100, 4, 3, '2026-08-15T20:00:00Z')]);
  const as = (status: string) =>
    join(cals, withEntry(library, entry('shows', show(100, 'Watched Show'), status)), { timezone: 'Europe/London', now: NOW });

  assert.deepEqual(as('completed'), as('watching'));
  assert.ok(as('watching').length > 0);
});

// A record with no `status` at all is still a title we hold — the reason the
// airing rule is negative rather than positive.
test('a record carrying no status is treated as still followed', () => {
  const cals = calendars([tvEntry(100, 4, 3, '2026-08-15T20:00:00Z')]);
  const stateless = join(cals, withEntry(library, [100, { type: 'shows', item: show(100, 'Watched Show') }]), {
    timezone: 'Europe/London',
    now: NOW,
  });
  assert.deepEqual(stateless, join(cals, library, { timezone: 'Europe/London', now: NOW }));
});

test('watching shows contribute every upcoming episode', () => {
  const events = join(calendars([tvEntry(100, 4, 3, '2026-08-15T20:00:00Z')]), library, { timezone: 'Europe/London', now: NOW });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.summary, 'Watched Show – S04E03');
});

test('plan-to-watch contributes premieres only', () => {
  const events = join(
    calendars([tvEntry(200, 1, 1, '2026-08-15T20:00:00Z'), tvEntry(200, 2, 1, '2026-08-16T20:00:00Z')]),
    library,
    { timezone: 'Europe/London', now: NOW },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.summary, 'Planned Show – S01E01');
});

// SIMKL marks an ongoing show completed once everything aired has been watched,
// so a between-seasons show lives here. Excluding it would silently drop the
// next season from the feed.
test('completed shows still contribute upcoming episodes', () => {
  const events = join(calendars([tvEntry(400, 4, 1, '2026-08-15T20:00:00Z')]), library, { timezone: 'Europe/London', now: NOW });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.summary, 'Completed Show – S04E01');
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
  const animeLibrary = withEntry(library, entry('anime', show(500, 'Some Anime'), 'plantowatch'));
  const cals: Cals = {
    tv: calendarOf([], {}),
    anime: calendarOf([
      { simkl_id: 500, date: '2026-08-15T15:00:00Z', finale_type: null, episode: { season: null, episode: 1, title: 'a', url: '' } },
      { simkl_id: 500, date: '2026-08-22T15:00:00Z', finale_type: null, episode: { season: null, episode: 2, title: 'b', url: '' } },
    ], { 500: { title: 'Some Anime' } }),
  };
  const events = join(cals, animeLibrary, { timezone: 'Europe/London', now: NOW });
  assert.equal(events.length, 1, 'only the premiere');
  assert.equal(events[0]?.summary, 'Some Anime – E01');
});

test('an entry with no episode object gets a date-keyed uid, not "Eundefined"', () => {
  const animeLibrary = withEntry(library, entry('anime', show(600, 'Some Anime'), 'watching'));
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
  assert.equal(events[0]?.summary, 'Some Anime');
  assert.equal(events[0]?.uid, 'simkl-600-20260827@simkl-ical');
});

// A future date is always inside the grace window, so without this a dropped or
// on-hold show keeps generating episodes forever.
test('a show whose status says it moved on contributes nothing', () => {
  for (const status of ['dropped', 'hold']) {
    const moved = withEntry(library, entry('shows', show(100, 'Watched Show'), status));
    const events = join(calendars([tvEntry(100, 4, 3, '2026-08-15T20:00:00Z')]), moved, { timezone: 'Europe/London', now: NOW });
    assert.deepEqual(events, [], `status ${status}`);
  }
});

// The counterpart, and the reason `completed` is not on that list: everything a
// completed title contributes is already dated, so it ages out on its own.
test('a completed show is still not treated as having moved on', () => {
  const completed = withEntry(library, entry('shows', show(400, 'Completed Show'), 'completed'));
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
  assert.deepEqual(events.map((e) => String(e.date)), ['2026-08-10']);
});

test('a recently aired episode lingers for the grace window', () => {
  const events = join(
    calendars([tvEntry(100, 1, 1, '2026-08-05T20:00:00Z')]), // 5 days ago
    library,
    { timezone: 'Europe/London', now: NOW, graceDays: 14 },
  );
  assert.deepEqual(events.map((e) => String(e.date)), ['2026-08-05']);
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
  const watchedUpToDate = withEntry(library, [
    100,
    { type: 'shows', item: { ...show(100), status: 'watching', last_watched: 'S01E09', next_to_watch: null, watched_episodes_count: 9, total_episodes_count: 9 } },
  ]);
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
  assert.equal(String(events[0]?.date), '2026-08-05');
});

test('finale type decorates the summary', () => {
  const events = join(calendars([tvEntry(100, 3, 8, '2026-08-15T20:00:00Z', 2)]), library, { timezone: 'Europe/London', now: NOW });
  assert.equal(events[0]?.summary, 'Watched Show – S03E08 (Season finale)');
});

test('episode titles stay out of the summary', () => {
  const events = join(calendars([tvEntry(100, 4, 3, '2026-08-15T20:00:00Z')]), library, { timezone: 'Europe/London', now: NOW });
  assert.ok(!events[0]?.summary.includes('Ep 3'));
  assert.equal(events[0]?.episodeTitle, 'Ep 3');
});

const filmReleases = (ymd: string): Map<number, MovieRelease> =>
  new Map([[300, { simkl_id: 300, title: 'Planned Film', date: plainDateFrom(ymd), releaseType: 3, runtime: '140m', url: 'https://simkl.com/movies/300' }]]);

test('plan-to-watch films are included by release date', () => {
  const events = join(calendars(), library, { timezone: 'Europe/London', now: NOW, movieReleases: filmReleases('2026-08-20') });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'movie');
  assert.equal(String(events[0]?.date), '2026-08-20');
  assert.equal(events[0]?.summary, 'Planned Film');
  assert.equal(events[0]?.detail, 'In cinemas');
});

test('films far beyond the 33-day calendar window still appear', () => {
  const events = join(calendars(), library, { timezone: 'Europe/London', now: NOW, movieReleases: filmReleases('2027-04-30') });
  assert.equal(events.length, 1);
  assert.equal(String(events[0]?.date), '2027-04-30');
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
  assert.deepEqual(events.map((e) => String(e.date)), ['2026-08-12', '2026-08-15']);
});

// Upstream data, several thousand entries per file, validated on arrival only
// for `Array.isArray(calendar)`. `Intl.DateTimeFormat.format` raises on an
// Invalid Date rather than returning anything a NaN check would catch, so one
// bad `date` field would abort the join, set `errors.render`, and stop the feed
// updating until the CDN fixed itself.
test('a malformed airdate skips its entry rather than aborting the render', () => {
  const cals = calendars([
    { simkl_id: 100, date: 'not a date', finale_type: null, episode: { season: 4, episode: 2, title: 'bad', url: '' } },
    tvEntry(100, 4, 3, '2026-08-15T20:00:00Z'),
  ]);

  const events = join(cals, library, { timezone: 'Europe/London', now: NOW });
  assert.equal(events.length, 1, 'the good entry still renders');
  assert.equal(events[0]?.summary, 'Watched Show – S04E03');
});

test('an entry with no date at all is skipped the same way', () => {
  const cals = calendars([{ simkl_id: 100, date: '', finale_type: null } as never, tvEntry(100, 4, 3, '2026-08-15T20:00:00Z')]);
  assert.equal(join(cals, library, { timezone: 'Europe/London', now: NOW }).length, 1);
});

// --- the zone in the conversion --------------------------------------------

/**
 * The highest-risk conversion in the project, and until now the only one with
 * no test: pinning the join to UTC broke nothing.
 *
 * An airdate is a UTC instant, and a US evening broadcast is stamped the
 * following day in UTC — 20:30 in New York on the 13th is `02:30Z` on the 14th.
 * Reading that as the 14th puts roughly a fifth of entries on the wrong day, and
 * because the UID carries the date for entries with no episode number, it also
 * changes their identity and duplicates them in every subscriber's calendar.
 */
test('an airdate lands on the local calendar day, not the UTC one', () => {
  const lateNight = [tvEntry(100, 5, 1, '2026-08-14T02:30:00Z')];

  const ny = join(calendars(lateNight), library, { timezone: 'America/New_York', now: NOW });
  assert.equal(String(ny[0]?.date), '2026-08-13', '02:30Z is the previous evening in New York');

  const utc = join(calendars(lateNight), library, { timezone: 'UTC', now: NOW });
  assert.equal(String(utc[0]?.date), '2026-08-14', 'and the same instant is the 14th in UTC');
});

// East of UTC the shift goes the other way, so a zone that is merely ignored
// rather than wrong would still pass the New York case alone.
test('a zone ahead of UTC moves the date forward, not back', () => {
  const evening = [tvEntry(100, 5, 2, '2026-08-14T23:30:00Z')];

  assert.equal(String(join(calendars(evening), library, { timezone: 'Pacific/Auckland', now: NOW })[0]?.date), '2026-08-15');
  assert.equal(String(join(calendars(evening), library, { timezone: 'UTC', now: NOW })[0]?.date), '2026-08-14');
});

// The grace cutoff is computed from the local date too, so a zone applied to the
// entry but not to "today" would drop an entry that is still inside the window.
test('the grace cutoff is measured in the same zone as the entries', () => {
  // 02:00Z on the 10th is still the 9th in New York, so the local cutoff is the
  // 8th where a UTC one would be the 9th. The entry is placed exactly between
  // them: 01:00Z on the 9th is the evening of the 8th locally, so it survives a
  // cutoff computed in the same zone and is dropped by one computed in UTC.
  const now = Temporal.Instant.from('2026-08-10T02:00:00Z');
  const entries = [tvEntry(100, 5, 3, '2026-08-09T01:00:00Z')];

  const events = join(calendars(entries), library, { timezone: 'America/New_York', now, graceDays: 1 });
  assert.equal(events.length, 1, 'an entry on the cutoff day itself survives');
  assert.equal(String(events[0]?.date), '2026-08-08');
});
