import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILM_HORIZON_DAYS, filmDue, pickReleaseDate, reconcileReleases } from '../../src/feed/1-films.ts';
import { fetchMovieReleases } from '../../src/feed/io/movies.ts';
import { releaseLabel } from '../../src/feed/2-join.ts';
import type { MovieDetail } from '../../src/api/simkl/types.ts';
import type { MovieRelease } from '../../src/feed/1-films.ts';
import { clearRequests, recentRequests } from '../../src/api/requests.ts';
import { jsonResponse, withFetch } from '../helpers.ts';
import { plainDateFrom, plainDateIn } from '../../src/shared/dates.ts';

// Shape from a real /movies/2242503 response. `released` really is two days
// earlier than every country's theatrical date — what SIMKL returns, and why
// the field is ignored.
const duneThree: MovieDetail = {
  title: 'Dune: Part Three',
  released: '2026-12-16',
  release_dates: [
    { iso_3166_1: 'BE', results: [{ type: 3, release_date: '2026-12-16' }] },
    { iso_3166_1: 'GB', results: [{ type: 3, release_date: '2026-12-18' }] },
    { iso_3166_1: 'US', results: [{ type: 3, release_date: '2026-12-18' }] },
  ],
};

test('the misleading top-level `released` field is not used', () => {
  const picked = pickReleaseDate(duneThree, 'GB');
  assert.equal(picked!.date.toString(), '2026-12-18');
  assert.notEqual(picked!.date.toString(), duneThree.released);
});

test('the viewer country wins over other territories', () => {
  assert.equal(pickReleaseDate(duneThree, 'BE')!.date.toString(), '2026-12-16');
  assert.equal(pickReleaseDate(duneThree, 'GB')!.date.toString(), '2026-12-18');
});

test('theatrical is preferred over a premiere screening', () => {
  // The Odyssey lists a GB premiere 11 days before it opens to the public.
  const odyssey: MovieDetail = {
    title: 'The Odyssey',
    released: '2026-07-15',
    release_dates: [{ iso_3166_1: 'GB', results: [{ type: 3, release_date: '2026-07-17' }, { type: 1, release_date: '2026-07-06' }] }],
  };
  const picked = pickReleaseDate(odyssey, 'GB');
  assert.equal(picked!.date.toString(), '2026-07-17');
  assert.equal(picked!.type, 3);
});

test('falls back to US when the viewer country is not listed', () => {
  const picked = pickReleaseDate(duneThree, 'NZ');
  assert.equal(picked!.date.toString(), '2026-12-18');
  assert.equal(picked!.country, 'US');
});

test('a premiere is used when nothing better is listed', () => {
  const onlyPremiere: MovieDetail = { title: 'A Film', released: '2026-01-01', release_dates: [{ iso_3166_1: 'GB', results: [{ type: 1, release_date: '2026-03-04' }] }] };
  assert.equal(pickReleaseDate(onlyPremiere, 'GB')!.date.toString(), '2026-03-04');
});

// A premiere is a last resort across all territories, not just within one.
test('a US theatrical date beats a home-country premiere', () => {
  const movie: MovieDetail = {
    title: 'A Film',
    released: '2026-01-01',
    release_dates: [
      { iso_3166_1: 'GB', results: [{ type: 1, release_date: '2026-11-20' }] },
      { iso_3166_1: 'US', results: [{ type: 3, release_date: '2026-12-04' }] },
    ],
  };
  const picked = pickReleaseDate(movie, 'GB');
  assert.equal(picked!.date.toString(), '2026-12-04');
  assert.equal(picked!.type, 3);
  assert.equal(picked!.country, 'US');
});

test('the reported country matches where the date actually came from', () => {
  const premiereOnlyInUS: MovieDetail = {
    title: 'A Film',
    released: '2026-01-01',
    release_dates: [{ iso_3166_1: 'US', results: [{ type: 1, release_date: '2026-05-01' }] }],
  };
  assert.equal(pickReleaseDate(premiereOnlyInUS, 'GB')!.country, 'US');
});

test('falls back to `released` only when there is no per-country data at all', () => {
  const bare: MovieDetail = { title: 'A Film', released: '2026-05-05', release_dates: [] };
  const picked = pickReleaseDate(bare, 'GB');
  assert.equal(picked!.date.toString(), '2026-05-05');
  assert.equal(picked!.type, null);
});

test('returns null when a film has no dates whatsoever', () => {
  assert.equal(pickReleaseDate({ title: 'Nothing', release_dates: [] }, 'GB'), null);
});

test('release types are labelled for the event description', () => {
  assert.equal(releaseLabel(3), 'In cinemas');
  assert.equal(releaseLabel(4), 'Digital release');
  assert.equal(releaseLabel(1), 'Premiere');
  assert.equal(releaseLabel(undefined), 'Release');
});

// --- reconcileReleases ---------------------------------------------------

const release = (id: number): MovieRelease => ({ simkl_id: id, title: `Film ${id}`, date: plainDateFrom('2026-12-18'), releaseType: 3, runtime: null, url: '' });

const lookups = (releases: Array<[number, MovieRelease]>, failed: number[] = [], unavailable: number[] = []) =>
  ({ releases: new Map(releases), failed, unavailable });

test('all lookups resolving reports complete', () => {
  const { releases, complete } = reconcileReleases(new Map(), [1, 2], new Set([1, 2]), lookups([[1, release(1)], [2, release(2)]]));
  assert.equal(complete, true);
  assert.equal(releases.size, 2);
});

test('a failed lookup keeps its previous value and reports incomplete', () => {
  const previous = new Map([[1, release(1)], [2, release(2)]]);
  const { releases, complete } = reconcileReleases(previous, [1, 2], new Set([1, 2]), lookups([[1, release(1)]], [2]));
  assert.equal(complete, false, 'so the list stays stale and retries');
  assert.equal(releases.size, 2, 'the unresolved film is not lost');
  assert.equal(releases.get(2)!.title, 'Film 2');
});

test('a total failure keeps everything and reports incomplete', () => {
  const previous = new Map([[1, release(1)]]);
  const { releases, complete } = reconcileReleases(previous, [1], new Set([1]), lookups([], [1]));
  assert.equal(complete, false);
  assert.equal(releases.get(1)!.title, 'Film 1');
});

// No announced release date is a settled answer, not a failure; treated as
// one, every poll refetches the whole film list forever.
test('a film with no announced date does not mark the round incomplete', () => {
  const { releases, complete } = reconcileReleases(new Map(), [1, 2], new Set([1, 2]), lookups([[1, release(1)]]));
  assert.equal(complete, true, 'the undated film must not cause a permanent refetch loop');
  assert.deepEqual([...releases.keys()], [1]);
});

test('a film that loses its date is dropped rather than kept stale', () => {
  const previous = new Map([[1, release(1)]]);
  const { releases, complete } = reconcileReleases(previous, [1], new Set([1]), lookups([]));
  assert.equal(complete, true);
  assert.equal(releases.size, 0, 'the date genuinely went away');
});

// A round is deliberately partial — a film dated a year out is not re-read
// daily — so anything not asked keeps its date. Conflating "on the list" with
// "asked this round" empties the feed of every film outside the refresh
// window on the first partial round.
test('a film that was not asked about keeps its date', () => {
  const previous = new Map([[1, release(1)], [2, release(2)]]);
  const { releases, complete } = reconcileReleases(previous, [1, 2], new Set([1]), lookups([[1, release(1)]]));
  assert.equal(complete, true);
  assert.equal(releases.size, 2, 'the skipped film is not treated as undated');
  assert.equal(releases.get(2)!.title, 'Film 2');
});

test('films dropped from the list are dropped from the map', () => {
  const previous = new Map([[1, release(1)], [2, release(2)]]);
  const { releases } = reconcileReleases(previous, [1], new Set([1]), lookups([[1, release(1)]]));
  assert.deepEqual([...releases.keys()], [1]);
});

test('an empty film list yields an empty map and counts as complete', () => {
  const { releases, complete } = reconcileReleases(new Map([[1, release(1)]]), [], new Set([]), lookups([]));
  assert.equal(releases.size, 0);
  assert.equal(complete, true);
});

// --- picking among several dates of the same type -------------------------

const NOW = { now: Temporal.Instant.from('2026-08-15T12:00:00Z') };

// An original run must not beat a re-release: the old date falls behind the
// cutoff and the film disappears.
test('a re-release beats an original run that has already happened', () => {
  const movie: MovieDetail = {
    title: 'Star Wars',
    release_dates: [
      {
        iso_3166_1: 'GB',
        results: [
          { type: 3, release_date: '1977-12-27' },
          { type: 3, release_date: '2027-05-25' },
        ],
      },
    ],
  };
  assert.equal(pickReleaseDate(movie, 'GB', NOW)!.date.toString(), '2027-05-25');
});

test('array order does not decide which date is chosen', () => {
  const results = [
    { type: 3, release_date: '2027-05-25' },
    { type: 3, release_date: '1977-12-27' },
  ];
  const forwards: MovieDetail = { title: 'x', release_dates: [{ iso_3166_1: 'GB', results }] };
  const backwards: MovieDetail = { title: 'x', release_dates: [{ iso_3166_1: 'GB', results: [...results].reverse() }] };
  assert.equal(pickReleaseDate(forwards, 'GB', NOW)!.date.toString(), pickReleaseDate(backwards, 'GB', NOW)!.date.toString());
});

test('the soonest upcoming date wins when several are still ahead', () => {
  const movie: MovieDetail = {
    title: 'x',
    release_dates: [
      {
        iso_3166_1: 'GB',
        results: [
          { type: 3, release_date: '2027-01-01' },
          { type: 3, release_date: '2026-09-01' },
        ],
      },
    ],
  };
  assert.equal(pickReleaseDate(movie, 'GB', NOW)!.date.toString(), '2026-09-01');
});

test('a film entirely in the past keeps its most recent date', () => {
  const movie: MovieDetail = {
    title: 'x',
    release_dates: [
      {
        iso_3166_1: 'GB',
        results: [
          { type: 3, release_date: '1977-12-27' },
          { type: 3, release_date: '1997-01-31' },
        ],
      },
    ],
  };
  assert.equal(pickReleaseDate(movie, 'GB', NOW)!.date.toString(), '1997-01-31');
});

// The last resort must choose by type too, not by whichever came first.
test('the last-resort choice is by type, not by position', () => {
  const results = [
    { type: 5, release_date: '2028-01-01' }, // physical
    { type: 1, release_date: '2026-09-01' }, // premiere
  ];
  const forwards: MovieDetail = { title: 'x', release_dates: [{ iso_3166_1: 'GB', results }] };
  const backwards: MovieDetail = { title: 'x', release_dates: [{ iso_3166_1: 'GB', results: [...results].reverse() }] };

  const a = pickReleaseDate(forwards, 'GB', NOW)!;
  const b = pickReleaseDate(backwards, 'GB', NOW)!;
  assert.deepEqual(a, b, 'order must not change the answer');
  assert.equal(a.type, 5, 'physical is a date you can act on; a premiere is a screening');
});

// iso_3166_1 is matched exactly, so a lowercase value would fall through to US.
test('the release country is matched case-insensitively', () => {
  assert.equal(pickReleaseDate(duneThree, 'gb', NOW)!.date.toString(), pickReleaseDate(duneThree, 'GB', NOW)!.date.toString());
  assert.equal(pickReleaseDate(duneThree, 'gb', NOW)!.country, 'GB');
});

// --- permanent versus transient lookup failures ---------------------------

// A 404 fails identically every time; counted as retryable it refetches the
// whole film list every poll.
test('a permanently gone film does not hold the list stale', () => {
  const { releases, complete } = reconcileReleases(new Map(), [1, 2], new Set([1, 2]), lookups([[1, release(1)]], [], [2]));
  assert.equal(complete, true, 'a 4xx is settled, not a retry');
  assert.deepEqual([...releases.keys()], [1]);
});

test('a gone film keeps a date already known for it', () => {
  const previous = new Map([[2, release(2)]]);
  const { releases } = reconcileReleases(previous, [2], new Set([2]), lookups([], [], [2]));
  assert.equal(releases.get(2), previous.get(2), 'a cached date beats no date');
});

test('a transient failure still holds the list stale', () => {
  const { complete } = reconcileReleases(new Map(), [1], new Set([1]), lookups([], [1]));
  assert.equal(complete, false);
});

// --- the lookup pool ------------------------------------------------------

const movieBody = (id: number) => ({
  title: `Film ${id}`,
  runtime: 120,
  release_dates: [{ iso_3166_1: 'GB', results: [{ type: 3, release_date: '2027-05-25' }] }],
});

test('every id is looked up exactly once, whatever the concurrency', async () => {
  await withFetch(
    (url) => jsonResponse(movieBody(Number(url.match(/\/movies\/(\d+)/)![1]))),
    async (calls) => {
      const ids = [1, 2, 3, 4, 5, 6, 7, 1, 2];
      const { releases, failed } = await fetchMovieReleases(ids, { concurrency: 3 });
      assert.equal(releases.size, 7, 'duplicates collapse');
      assert.equal(calls.length, 7, 'and are not fetched twice');
      assert.deepEqual(failed, []);
    },
  );
});

test('a 404 is recorded as gone rather than as a retryable failure', async () => {
  await withFetch(
    (url) => (url.includes('/movies/2') ? new Response('gone', { status: 404 }) : jsonResponse(movieBody(1))),
    async () => {
      const { releases, failed, unavailable } = await fetchMovieReleases([1, 2]);
      assert.deepEqual([...releases.keys()], [1]);
      assert.deepEqual(failed, [], 'retrying a deleted id never starts working');
      assert.deepEqual(unavailable, [2]);
    },
  );
});

test('a server error is retryable, so the list stays stale', async () => {
  await withFetch(
    (url) => (url.includes('/movies/2') ? new Response('boom', { status: 500 }) : jsonResponse(movieBody(1))),
    async () => {
      const { failed, unavailable } = await fetchMovieReleases([1, 2]);
      assert.deepEqual(failed, [2]);
      assert.deepEqual(unavailable, []);
    },
  );
});

test('a film with no announced date is a settled answer, not a failure', async () => {
  await withFetch(
    () => jsonResponse({ title: 'Untitled Sequel' }),
    async () => {
      const { releases, failed, unavailable } = await fetchMovieReleases([1]);
      assert.equal(releases.size, 0);
      assert.deepEqual(failed, []);
      assert.deepEqual(unavailable, []);
    },
  );
});

test('an empty id list makes no requests at all', async () => {
  await withFetch(
    () => jsonResponse({}),
    async (calls) => {
      const { releases, failed } = await fetchMovieReleases([]);
      assert.equal(releases.size, 0);
      assert.deepEqual(failed, []);
      assert.equal(calls.length, 0);
    },
  );
});

// --- what counts as permanently gone --------------------------------------

// These reach the caller only after apiGet exhausts its retries; filed as
// "gone" they would drop every film for a full movieRefresh.
for (const status of [408, 429]) {
  test(`a ${status} stays retryable rather than counting as gone`, async () => {
    await withFetch(
      () => new Response('slow down', { status }),
      async () => {
        const { failed, unavailable } = await fetchMovieReleases([1]);
        assert.deepEqual(unavailable, [], 'apiGet already retried this to exhaustion');
        assert.deepEqual(failed, [1], 'so it must be tried again next poll');
      },
    );
  });
}

for (const status of [404, 410]) {
  test(`a ${status} is genuinely gone`, async () => {
    await withFetch(
      () => new Response('gone', { status }),
      async () => {
        const { failed, unavailable } = await fetchMovieReleases([1]);
        assert.deepEqual(unavailable, [1]);
        assert.deepEqual(failed, []);
      },
    );
  });
}

// An account-wide problem is not a fact about any one film.
for (const status of [401, 403, 412]) {
  test(`a ${status} propagates rather than being filed against a film`, async () => {
    await withFetch(
      () => new Response('nope', { status }),
      async () => {
        await assert.rejects(() => fetchMovieReleases([1, 2]), /401|403|412/);
      },
    );
  });
}

// --- release types we have no name for ------------------------------------

test('an unrecognised release type still beats the unreliable released field', () => {
  const movie: MovieDetail = {
    title: 'x',
    released: '2026-12-16',
    release_dates: [{ iso_3166_1: 'GB', results: [{ type: 7, release_date: '2026-12-18' }] }],
  };
  const picked = pickReleaseDate(movie, 'GB', NOW)!;
  assert.equal(picked.date.toString(), '2026-12-18');
  assert.equal(picked.country, 'GB');
});

test('a known type is still preferred over an unrecognised one', () => {
  const movie: MovieDetail = {
    title: 'x',
    release_dates: [
      {
        iso_3166_1: 'GB',
        results: [
          { type: 7, release_date: '2026-01-01' },
          { type: 3, release_date: '2027-05-25' },
        ],
      },
    ],
  };
  assert.equal(pickReleaseDate(movie, 'GB', NOW)!.type, 3);
});

// "Has this happened yet" is answered in the viewer's zone, as the join does:
// in UTC, a viewer far enough east sits on yesterday's date.
test('whether a date has passed is judged in the viewer timezone, not UTC', () => {
  // 12:00Z is already the 16th in Auckland and still the 15th in UTC.
  const now = { now: Temporal.Instant.from('2026-08-15T12:00:00Z') };
  const movie: MovieDetail = {
    title: 'x',
    release_dates: [
      {
        iso_3166_1: 'NZ',
        results: [
          { type: 3, release_date: '2026-08-15' },
          { type: 3, release_date: '2026-08-20' },
        ],
      },
    ],
  };

  // timezone is a parameter, so this needs no global mutation.
  assert.equal(
    pickReleaseDate(movie, 'NZ', { ...now, timezone: 'Pacific/Auckland' })!.date.toString(),
    '2026-08-20',
    'the 15th is yesterday in Auckland',
  );
  assert.equal(
    pickReleaseDate(movie, 'NZ', { ...now, timezone: 'UTC' })!.date.toString(),
    '2026-08-15',
    'but is still today in UTC',
  );
});

// --- when a film's date is worth re-reading --------------------------------
//
// The floor bounds how often any one film is asked about; only past it does
// the horizon decide whether asking would learn anything.

const DUE_NOW = Temporal.Instant.from('2026-08-15T12:00:00Z');
const DAY = Temporal.Duration.from({ hours: 24 });
const OPTS = { refresh: DAY, timezone: 'Europe/London' };
/** A release `days` from NOW, so a fixture can sit either side of the horizon. */
const dated = (days: number): MovieRelease => ({
  ...release(1),
  date: plainDateIn(DUE_NOW, OPTS.timezone).add({ days }),
});

test('a film never asked about is due', () => {
  assert.equal(filmDue(undefined, undefined, DUE_NOW, OPTS), true);
});

// The poll runs far more often than release dates change.
test('a film asked about within the floor is not due, however imminent', () => {
  const justAsked = DUE_NOW.subtract({ seconds: 1 });
  assert.equal(filmDue(justAsked, dated(1), DUE_NOW, OPTS), false, 'even releasing tomorrow');
  assert.equal(filmDue(justAsked, undefined, DUE_NOW, OPTS), false, 'even with no announced date');
});

// Absent from the release map means resolved with no announced date — worth
// re-asking whatever the calendar says.
test('past the floor, a film with no announced date is due', () => {
  assert.equal(filmDue(DUE_NOW.subtract({ hours: 24, seconds: 1 }), undefined, DUE_NOW, OPTS), true);
});

test('past the floor, the horizon decides', () => {
  const aged = DUE_NOW.subtract({ hours: 24, seconds: 1 });
  assert.equal(filmDue(aged, dated(FILM_HORIZON_DAYS - 1), DUE_NOW, OPTS), true, 'inside the horizon');
  assert.equal(filmDue(aged, dated(FILM_HORIZON_DAYS + 1), DUE_NOW, OPTS), false, 'beyond it');
});

// A date that has passed may have been pushed back, so it stays worth asking.
test('a release already past is still due', () => {
  assert.equal(filmDue(DUE_NOW.subtract({ hours: 24, seconds: 1 }), dated(-30), DUE_NOW, OPTS), true);
});

// A film landing exactly on the horizon is still close enough for a studio to
// move.
test('the horizon boundary is inclusive', () => {
  assert.equal(filmDue(DUE_NOW.subtract({ hours: 24, seconds: 1 }), dated(FILM_HORIZON_DAYS), DUE_NOW, OPTS), true);
});

// The horizon is counted in the viewer's zone, like the join: a UTC instant is
// a different local date for a fifth of the day.
test('the horizon is measured in the viewer\'s timezone', () => {
  const aged = DUE_NOW.subtract({ hours: 24, seconds: 1 });
  const onTheEdge = { ...release(1), date: plainDateFrom('2026-09-14') };
  assert.equal(filmDue(aged, onTheEdge, DUE_NOW, { ...OPTS, horizonDays: 30 }), true);
  assert.equal(filmDue(aged, onTheEdge, DUE_NOW, { ...OPTS, horizonDays: 29 }), false);
});

// The label that actually goes out: a type can force one to be present; only
// this says it is right.
test('a film lookup is recorded against the feed', async () => {
  clearRequests();
  await withFetch(
    () => jsonResponse(duneThree),
    async () => void (await fetchMovieReleases([174094])),
  );
  assert.equal(recentRequests()[0]?.component, 'films');
  assert.equal(recentRequests()[0]?.service, 'simkl');
});
