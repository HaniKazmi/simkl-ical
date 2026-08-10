import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickReleaseDate } from '../src/sources/movies.ts';
import { releaseLabel } from '../src/join.ts';
import { reconcileReleases } from '../src/sources/movies.ts';
import type { MovieDetail, MovieRelease } from '../src/simkl/types.ts';

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

const release = (id: number): MovieRelease => ({ simkl_id: id, title: `Film ${id}`, date: '2026-12-18', releaseType: 3, country: 'GB', runtime: null, url: '' });

const lookups = (releases: Array<[number, MovieRelease]>, failed: number[] = []) =>
  ({ releases: new Map(releases), failed });

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
