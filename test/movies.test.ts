import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMovieReleases, pickReleaseDate, reconcileReleases } from '../src/sources/movies.ts';
import { releaseLabel } from '../src/join.ts';
import type { MovieDetail, MovieRelease } from '../src/simkl/types.ts';
import { jsonResponse, withFetch } from './helpers.ts';
import { config } from '../src/config.ts';

// Shape taken from a real /movies/2242503 response. Note `released` is two days
// earlier than every country's actual theatrical date — this is not a typo in
// the fixture, it is what SIMKL returns, and the reason the field is ignored.
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
  assert.equal(picked!.date, '2026-12-18');
  assert.notEqual(picked!.date, duneThree.released);
});

test('the viewer country wins over other territories', () => {
  assert.equal(pickReleaseDate(duneThree, 'BE')!.date, '2026-12-16');
  assert.equal(pickReleaseDate(duneThree, 'GB')!.date, '2026-12-18');
});

test('theatrical is preferred over a premiere screening', () => {
  // The Odyssey lists a GB premiere 11 days before it opens to the public.
  const odyssey: MovieDetail = {
    title: 'The Odyssey',
    released: '2026-07-15',
    release_dates: [{ iso_3166_1: 'GB', results: [{ type: 3, release_date: '2026-07-17' }, { type: 1, release_date: '2026-07-06' }] }],
  };
  const picked = pickReleaseDate(odyssey, 'GB');
  assert.equal(picked!.date, '2026-07-17');
  assert.equal(picked!.type, 3);
});

test('falls back to US when the viewer country is not listed', () => {
  const picked = pickReleaseDate(duneThree, 'NZ');
  assert.equal(picked!.date, '2026-12-18');
  assert.equal(picked!.country, 'US');
});

test('a premiere is used when nothing better is listed', () => {
  const onlyPremiere: MovieDetail = { title: 'A Film', released: '2026-01-01', release_dates: [{ iso_3166_1: 'GB', results: [{ type: 1, release_date: '2026-03-04' }] }] };
  assert.equal(pickReleaseDate(onlyPremiere, 'GB')!.date, '2026-03-04');
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
  assert.equal(picked!.date, '2026-12-04');
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
  assert.equal(picked!.date, '2026-05-05');
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

const release = (id: number): MovieRelease => ({ simkl_id: id, title: `Film ${id}`, date: '2026-12-18', releaseType: 3, runtime: null, url: '' });

const lookups = (releases: Array<[number, MovieRelease]>, failed: number[] = [], unavailable: number[] = []) =>
  ({ releases: new Map(releases), failed, unavailable });

test('all lookups resolving reports complete', () => {
  const { releases, complete } = reconcileReleases(new Map(), [1, 2], lookups([[1, release(1)], [2, release(2)]]));
  assert.equal(complete, true);
  assert.equal(releases.size, 2);
});

test('a failed lookup keeps its previous value and reports incomplete', () => {
  const previous = new Map([[1, release(1)], [2, release(2)]]);
  const { releases, complete } = reconcileReleases(previous, [1, 2], lookups([[1, release(1)]], [2]));
  assert.equal(complete, false, 'so the list stays stale and retries');
  assert.equal(releases.size, 2, 'the unresolved film is not lost');
  assert.equal(releases.get(2)!.title, 'Film 2');
});

test('a total failure keeps everything and reports incomplete', () => {
  const previous = new Map([[1, release(1)]]);
  const { releases, complete } = reconcileReleases(previous, [1], lookups([], [1]));
  assert.equal(complete, false);
  assert.equal(releases.get(1)!.title, 'Film 1');
});

// A film with no announced release date is a settled answer, not a failure.
// Treating it as one made every poll refetch the whole film list forever.
test('a film with no announced date does not mark the round incomplete', () => {
  const { releases, complete } = reconcileReleases(new Map(), [1, 2], lookups([[1, release(1)]]));
  assert.equal(complete, true, 'the undated film must not cause a permanent refetch loop');
  assert.deepEqual([...releases.keys()], [1]);
});

test('a film that loses its date is dropped rather than kept stale', () => {
  const previous = new Map([[1, release(1)]]);
  const { releases, complete } = reconcileReleases(previous, [1], lookups([]));
  assert.equal(complete, true);
  assert.equal(releases.size, 0, 'the date genuinely went away');
});

test('films dropped from the list are dropped from the map', () => {
  const previous = new Map([[1, release(1)], [2, release(2)]]);
  const { releases } = reconcileReleases(previous, [1], lookups([[1, release(1)]]));
  assert.deepEqual([...releases.keys()], [1]);
});

test('an empty film list yields an empty map and counts as complete', () => {
  const { releases, complete } = reconcileReleases(new Map([[1, release(1)]]), [], lookups([]));
  assert.equal(releases.size, 0);
  assert.equal(complete, true);
});

// --- picking among several dates of the same type -------------------------

const NOW = { now: new Date('2026-08-15T12:00:00Z') };

// The bug this guards: `.find` took whichever entry the API listed first, so a
// 1977 original run beat a 2027 re-release. That date then fell behind the
// join's cutoff and the film silently never appeared at all.
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
  assert.equal(pickReleaseDate(movie, 'GB', NOW)!.date, '2027-05-25');
});

test('array order does not decide which date is chosen', () => {
  const results = [
    { type: 3, release_date: '2027-05-25' },
    { type: 3, release_date: '1977-12-27' },
  ];
  const forwards: MovieDetail = { title: 'x', release_dates: [{ iso_3166_1: 'GB', results }] };
  const backwards: MovieDetail = { title: 'x', release_dates: [{ iso_3166_1: 'GB', results: [...results].reverse() }] };
  assert.equal(pickReleaseDate(forwards, 'GB', NOW)!.date, pickReleaseDate(backwards, 'GB', NOW)!.date);
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
  assert.equal(pickReleaseDate(movie, 'GB', NOW)!.date, '2026-09-01');
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
  assert.equal(pickReleaseDate(movie, 'GB', NOW)!.date, '1997-01-31');
});

// The last-resort loop took the first entry of any remaining type, so whether a
// viewer got a premiere or a DVD date came down to the API's array order.
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

// RELEASE_COUNTRY is compared exactly against iso_3166_1, so a lowercase value
// matched nothing and fell silently through to the US dates.
test('the release country is matched case-insensitively', () => {
  assert.equal(pickReleaseDate(duneThree, 'gb', NOW)!.date, pickReleaseDate(duneThree, 'GB', NOW)!.date);
  assert.equal(pickReleaseDate(duneThree, 'gb', NOW)!.country, 'GB');
});

// --- permanent versus transient lookup failures ---------------------------

// The bug this guards: any thrown error counted as `failed`, which withheld the
// movies signature so the list stayed stale. A 404 — a film merged or deleted
// upstream — fails identically every time, so every poll refetched the whole
// film list and re-looked-up every title, forever.
test('a permanently gone film does not hold the list stale', () => {
  const { releases, complete } = reconcileReleases(new Map(), [1, 2], lookups([[1, release(1)]], [], [2]));
  assert.equal(complete, true, 'a 4xx is settled, not a retry');
  assert.deepEqual([...releases.keys()], [1]);
});

test('a gone film keeps a date already known for it', () => {
  const previous = new Map([[2, release(2)]]);
  const { releases } = reconcileReleases(previous, [2], lookups([], [], [2]));
  assert.equal(releases.get(2), previous.get(2), 'a cached date beats no date');
});

test('a transient failure still holds the list stale', () => {
  const { complete } = reconcileReleases(new Map(), [1], lookups([], [1]));
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

// The bug this guards: the predicate was `status >= 400 && status < 500`, which
// swallowed the statuses apiGet had already retried to exhaustion. A sustained
// 429 filed every film as "gone", reported the round complete, and dropped the
// lot from the feed for a full movieRefreshMs with health still green.
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

// An account-wide problem is not a fact about any one film, and filing it per
// id swallowed the "re-run npm run login" message entirely.
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

// The rewrite enumerated types 1-6 exhaustively, where the code it replaced
// ended with a catch-all over any dated entry. An unrecognised type therefore
// fell through to `released`, which the docstring itself calls unreliable.
test('an unrecognised release type still beats the unreliable released field', () => {
  const movie: MovieDetail = {
    title: 'x',
    released: '2026-12-16',
    release_dates: [{ iso_3166_1: 'GB', results: [{ type: 7, release_date: '2026-12-18' }] }],
  };
  const picked = pickReleaseDate(movie, 'GB', NOW)!;
  assert.equal(picked.date, '2026-12-18');
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

// "Has this happened yet" must be answered in the viewer's timezone, the same
// way the join answers it. Computing it in UTC put a viewer far enough east on
// yesterday's date, so a release that had already passed locally could still be
// chosen as the next one.
test('whether a date has passed is judged in the viewer timezone, not UTC', () => {
  // 12:00Z is already the 16th in Auckland and still the 15th in UTC.
  const now = { now: new Date('2026-08-15T12:00:00Z') };
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

  // timezone is a parameter now, so this needs no global mutation at all.
  assert.equal(
    pickReleaseDate(movie, 'NZ', { ...now, timezone: 'Pacific/Auckland' })!.date,
    '2026-08-20',
    'the 15th is yesterday in Auckland',
  );
  assert.equal(
    pickReleaseDate(movie, 'NZ', { ...now, timezone: 'UTC' })!.date,
    '2026-08-15',
    'but is still today in UTC',
  );
});
