import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bannerFor,
  bannerOf,
  certificateOf,
  CINEMA_WINDOW_DAYS,
  directorOf,
  franchiseOf,
  isCertificate,
  isGenre,
  mappedGenres,
  openedInCinemas,
  releaseDateOf,
  watchedInCinema,
} from '../../../src/sheet/movies/values.ts';
import type { TmdbMovie } from '../../../src/api/tmdb/types.ts';

const withGenres = (...names: string[]): TmdbMovie => ({ genres: names.map((name) => ({ name })) });

const released = (entries: Array<[string, number, string, string?]>): TmdbMovie => {
  const results = new Map<string, Array<{ type: number; release_date: string; certification?: string }>>();
  for (const [country, type, date, cert] of entries) {
    results.set(country, [...(results.get(country) ?? []), { type, release_date: date, certification: cert }]);
  }
  return { release_dates: { results: [...results].map(([iso_3166_1, release_dates]) => ({ iso_3166_1, release_dates })) } };
};

const day = (ymd: string): Temporal.PlainDate => Temporal.PlainDate.from(ymd);

test('TMDB order is significance order, and the first survivor is the primary', () => {
  assert.deepEqual(mappedGenres(withGenres('Adventure', 'Action', 'Science Fiction')), ['Adventure', 'Action', 'Sci-Fi']);
});

test('genres outside the vocabulary are dropped, not renamed to something near', () => {
  // Finding Nemo: Animation and Family have nowhere to go, so only Adventure
  // survives — which is exactly what its row holds.
  assert.deepEqual(mappedGenres(withGenres('Animation', 'Family', 'Adventure')), ['Adventure']);
  assert.deepEqual(mappedGenres(withGenres('Crime', 'Drama', 'Mystery')), ['Drama', 'Mystery']);
});

test('a documentary is a True Story — the only films the map would otherwise empty', () => {
  assert.deepEqual(mappedGenres(withGenres('Documentary')), ['True Story']);
});

test('History is dropped: 1917 and Oppenheimer carry it and are filed differently', () => {
  assert.deepEqual(mappedGenres(withGenres('War', 'Drama', 'History')), ['Drama']);
});

test('a repeated mapping target appears once', () => {
  assert.deepEqual(mappedGenres(withGenres('Documentary', 'Documentary')), ['True Story']);
});

test('every mapped genre is one the renderer colours', () => {
  for (const genre of mappedGenres(withGenres('Action', 'Science Fiction', 'Documentary'))) assert.ok(isGenre(genre));
  assert.equal(isGenre('Animation'), false);
  // In the vocabulary, and reachable only by hand: nothing maps to it.
  assert.ok(isGenre('Abstract'));
});

test('the release date prefers a GB theatrical run, then US, then a limited one', () => {
  const gbAndUs = released([
    ['US', 3, '2003-08-08'],
    ['GB', 3, '2003-08-20'],
  ]);
  assert.equal(releaseDateOf(gbAndUs)?.toString(), '2003-08-20');
  assert.equal(releaseDateOf(released([['US', 3, '2003-08-08']]))?.toString(), '2003-08-08');
  assert.equal(releaseDateOf(released([['GB', 2, '2003-07-01']]))?.toString(), '2003-07-01');
  assert.equal(releaseDateOf(undefined), null);
});

test('the earliest date of a type wins when a territory lists several', () => {
  assert.equal(
    releaseDateOf(released([
      ['GB', 3, '2003-09-01'],
      ['GB', 3, '2003-08-20'],
    ]))?.toString(),
    '2003-08-20',
  );
});

test('a partial date like 2013-00-00 is no date rather than a throw', () => {
  assert.equal(releaseDateOf(released([['GB', 3, '2013-00-00']])), null);
});

test('only a GB theatrical run opens a cinema window', () => {
  // A US theatrical release is not one; nor is a GB limited run.
  assert.equal(openedInCinemas(released([['US', 3, '2022-05-27']])), null);
  assert.equal(openedInCinemas(released([['GB', 2, '2022-05-27']])), null);
  assert.equal(openedInCinemas(released([['GB', 3, '2022-05-27']]))?.toString(), '2022-05-27');
});

test('a watch inside the window counts as a cinema trip, and one outside does not', () => {
  const opened = day('2022-05-27');
  assert.ok(watchedInCinema(opened, opened));
  assert.ok(watchedInCinema(opened, opened.add({ days: CINEMA_WINDOW_DAYS })));
  assert.equal(watchedInCinema(opened, opened.add({ days: CINEMA_WINDOW_DAYS + 1 })), false);
  // Before it opened: a preview screening is not what this column records, and
  // no row on the tab is dated earlier than its release.
  assert.equal(watchedInCinema(opened, opened.subtract({ days: 1 })), false);
});

test('a film that never opened here is never a cinema trip, however soon it was watched', () => {
  // The case the rule exists for: a streaming premiere watched on release day.
  assert.equal(watchedInCinema(null, day('2022-12-23')), false);
});

test('the certificate belongs to the release the date came from', () => {
  // Both cells are write-once, so pairing one release's date with another's
  // rating is permanent. 28 Days Later is this shape: 18 theatrically, 15 on a
  // later cut, and TMDB contracts no ordering within a type.
  const reRatedTheatrical = released([
    ['GB', 3, '2018-06-01', '15'],
    ['GB', 3, '2002-11-01', '18'],
  ]);
  assert.equal(releaseDateOf(reRatedTheatrical)?.toString(), '2002-11-01');
  assert.equal(certificateOf(reRatedTheatrical), 18, 'the 2002 rating, not the 2018 one');
  // And the same the other way round in the array.
  const reversed = released([
    ['GB', 3, '2002-11-01', '18'],
    ['GB', 3, '2018-06-01', '15'],
  ]);
  assert.equal(certificateOf(reversed), 18);
});

test('a streaming original gets its digital date, not a blank', () => {
  // TMDB carries a Netflix or Prime original as digital only. Without a
  // fallback the row landed with a certificate and a permanently blank date.
  const digitalOnly = released([['GB', 4, '2022-12-23', '15']]);
  assert.equal(releaseDateOf(digitalOnly)?.toString(), '2022-12-23');
  assert.equal(certificateOf(digitalOnly), 15);
  // Still no cinema window: it never opened in one.
  assert.equal(openedInCinemas(digitalOnly), null);
});

test('a GB release TMDB sends with no type still yields its certificate', () => {
  const untyped: TmdbMovie = { release_dates: { results: [{ iso_3166_1: 'GB', release_dates: [{ release_date: '2010-01-01', certification: '12A' }] }] } };
  assert.equal(certificateOf(untyped), 12);
});

test('the theatrical certificate wins over a later re-rating', () => {
  // 166 of the 347 films on the tab carry more than one GB certificate and 8
  // disagree — a re-rating attached to a digital or physical release. TMDB
  // contracts no ordering, so picking by position made a write-once cell
  // depend on the order a response happened to arrive in.
  const reRated = released([
    ['GB', 5, '2003-02-01', '18'],
    ['GB', 4, '2003-01-01', '18'],
    ['GB', 3, '2002-11-01', '15'],
  ]);
  assert.equal(certificateOf(reRated), 15);
  // With no theatrical entry, a limited run answers before a home release.
  assert.equal(certificateOf(released([['GB', 5, '2003-02-01', '18'], ['GB', 2, '2002-11-01', '15']])), 15);
  // And with neither, whatever GB carries is better than a blank.
  assert.equal(certificateOf(released([['GB', 5, '2003-02-01', '18']])), 18);
});

test('the certificate is the BBFC age, and an unknown one leaves the cell blank', () => {
  assert.equal(certificateOf(released([['GB', 3, '2003-08-20', 'PG']])), 7);
  assert.equal(certificateOf(released([['GB', 3, '1977-12-27', 'U']])), 3);
  assert.equal(certificateOf(released([['GB', 3, '2008-07-24', '12A']])), 12);
  // A US rating is not a BBFC one, and neither is an unrated release.
  assert.equal(certificateOf(released([['US', 3, '2008-07-18', 'PG-13']])), null);
  assert.equal(certificateOf(released([['GB', 3, '2008-07-24', '']])), null);
  for (const age of [3, 7, 12, 15, 18]) assert.ok(isCertificate(age));
  assert.equal(isCertificate(13), false);
});

test('the first credited director is the one the column names', () => {
  const movie: TmdbMovie = { credits: { crew: [{ job: 'Writer', name: 'Nobody' }, { job: 'Director', name: 'Anthony Russo' }, { job: 'Director', name: 'Joe Russo' }] } };
  assert.equal(directorOf(movie), 'Anthony Russo');
  assert.equal(directorOf({ credits: { crew: [{ job: 'Writer', name: 'Nobody' }] } }), null);
});

test('a collection names the franchise, without its suffix', () => {
  assert.equal(franchiseOf({ belongs_to_collection: { name: 'The Dark Knight Collection' } }, 'The Dark Knight'), 'The Dark Knight');
  assert.equal(franchiseOf({ belongs_to_collection: { name: 'Star Wars Collection' } }, 'Star Wars'), 'Star Wars');
});

test('a film in no collection is its own franchise', () => {
  assert.equal(franchiseOf({ belongs_to_collection: null }, '1917'), '1917');
  assert.equal(franchiseOf(undefined, 'Primer'), 'Primer');
});

test('the banner is the highest-voted English backdrop, at the width the tab uses', () => {
  const movie: TmdbMovie = {
    images: {
      backdrops: [
        { file_path: '/low.jpg', iso_639_1: 'en', vote_average: 5 },
        { file_path: '/best.jpg', iso_639_1: 'en', vote_average: 8 },
        { file_path: '/foreign.jpg', iso_639_1: 'de', vote_average: 9 },
      ],
    },
  };
  assert.equal(bannerOf(movie), 'https://image.tmdb.org/t/p/w1280/best.jpg');
});

test('a film with no English backdrop gets no banner rather than a foreign one', () => {
  assert.equal(bannerOf({ images: { backdrops: [{ file_path: '/x.jpg', iso_639_1: null, vote_average: 9 }] } }), null);
  assert.equal(bannerOf({ images: { backdrops: [] } }), null);
  assert.equal(bannerOf(undefined), null);
});

// The row is written once and never revisited, so the cell has to hold the
// address a later upload will land at rather than whatever TMDB ranks first
// today.
test('with a bucket the banner is the static link for the title, whatever TMDB offers', () => {
  const movie: TmdbMovie = { images: { backdrops: [{ file_path: '/best.jpg', iso_639_1: 'en', vote_average: 8 }] } };
  assert.equal(bannerFor(movie, 'Finding Nemo', { movieBucket: 'bucket' }), 'https://storage.googleapis.com/bucket/Finding Nemo');
  assert.equal(bannerFor(undefined, 'What If...?', { movieBucket: 'bucket' }), 'https://storage.googleapis.com/bucket/What If...%3F');
});

test('without a bucket the banner is the TMDB backdrop, and blank where there is none', () => {
  const movie: TmdbMovie = { images: { backdrops: [{ file_path: '/best.jpg', iso_639_1: 'en', vote_average: 8 }] } };
  assert.equal(bannerFor(movie, 'Finding Nemo', { movieBucket: null }), 'https://image.tmdb.org/t/p/w1280/best.jpg');
  assert.equal(bannerFor(undefined, 'Finding Nemo', { movieBucket: null }), null);
});
