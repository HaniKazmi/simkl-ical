import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filmCandidates, showCandidates } from '../../src/artwork/2-candidates.ts';
import type { TmdbImage } from '../../src/api/tmdb/types.ts';
import type { TvdbArtwork } from '../../src/api/tvdb/types.ts';

const backdrop = (over: Partial<TmdbImage> = {}): TmdbImage => ({ file_path: '/x.jpg', iso_639_1: 'en', width: 1920, height: 1080, vote_average: 5, vote_count: 2, ...over });

test('film candidates are 16:9 backdrops at the tab\'s width, English first', () => {
  const got = filmCandidates({
    backdrops: [
      backdrop({ file_path: '/textless.jpg', iso_639_1: null, vote_count: 9 }),
      backdrop({ file_path: '/en.jpg' }),
      backdrop({ file_path: '/de.jpg', iso_639_1: 'de', vote_count: 50 }),
      backdrop({ file_path: '/poster-crop.jpg', width: 1000, height: 1500 }),
      backdrop({ file_path: '/nearly.jpg', width: 1280, height: 721 }),
      backdrop({ file_path: '/nodims.jpg', width: undefined }),
    ],
  });
  assert.deepEqual(
    got.map((c) => [c.url, c.thumb, c.language]),
    [
      ['https://image.tmdb.org/t/p/w1280/en.jpg', 'https://image.tmdb.org/t/p/w300/en.jpg', 'en'],
      ['https://image.tmdb.org/t/p/w1280/nearly.jpg', 'https://image.tmdb.org/t/p/w300/nearly.jpg', 'en'],
      ['https://image.tmdb.org/t/p/w1280/textless.jpg', 'https://image.tmdb.org/t/p/w300/textless.jpg', null],
    ],
  );
  assert.equal(got[0]?.source, 'tmdb');
});

// Ranked by average alone, a one-vote ten leads every list.
test('film candidates rank by how many voted before how they voted', () => {
  const got = filmCandidates({
    backdrops: [
      backdrop({ file_path: '/one-ten.jpg', vote_average: 10, vote_count: 1 }),
      backdrop({ file_path: '/many-sevens.jpg', vote_average: 7, vote_count: 40 }),
      backdrop({ file_path: '/many-eights.jpg', vote_average: 8, vote_count: 40 }),
      backdrop({ file_path: '/wider.jpg', vote_average: 8, vote_count: 40, width: 3840, height: 2160 }),
    ],
  });
  assert.deepEqual(
    got.map((c) => c.url.split('/').at(-1)),
    ['wider.jpg', 'many-eights.jpg', 'many-sevens.jpg', 'one-ten.jpg'],
  );
});

const poster = (over: Partial<TvdbArtwork> = {}): TvdbArtwork => ({
  image: 'https://artworks.thetvdb.com/banners/v4/series/1/posters/a.jpg',
  thumbnail: 'https://artworks.thetvdb.com/banners/v4/series/1/posters/a_t.jpg',
  language: 'eng',
  type: 2,
  score: 100,
  width: 680,
  height: 1000,
  ...over,
});

test('show candidates are posters, English first, the authored size next, then by score', () => {
  const got = showCandidates({
    data: {
      artworks: [
        poster({ image: 'https://artworks.thetvdb.com/p/big.jpg', width: 1360, height: 2000, score: 900 }),
        poster({ image: 'https://artworks.thetvdb.com/p/low.jpg', score: 10 }),
        poster({ image: 'https://artworks.thetvdb.com/p/high.jpg', score: 500 }),
        poster({ image: 'https://artworks.thetvdb.com/p/banner.jpg', type: 1, width: 758, height: 140 }),
        poster({ image: 'https://artworks.thetvdb.com/p/jpn.jpg', language: 'jpn', score: 1000 }),
        poster({ image: 'https://artworks.thetvdb.com/p/wide.jpg', width: 1000, height: 1000 }),
      ],
    },
  });
  assert.deepEqual(
    got.map((c) => c.url.split('/').at(-1)),
    ['high.jpg', 'low.jpg', 'big.jpg', 'jpn.jpg'],
  );
  assert.equal(got[0]?.thumb, 'https://artworks.thetvdb.com/banners/v4/series/1/posters/a_t.jpg');
  assert.equal(got[0]?.votes, null);
  assert.equal(got[0]?.source, 'tvdb');
});

test('an empty or absent listing is an empty list, not an error', () => {
  assert.deepEqual(filmCandidates(undefined), []);
  assert.deepEqual(filmCandidates({}), []);
  assert.deepEqual(showCandidates(undefined), []);
  assert.deepEqual(showCandidates({ data: {} }), []);
});
