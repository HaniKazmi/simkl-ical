import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookCandidates, filmCandidates, showCandidates } from '../../src/artwork/2-candidates.ts';
import type { HardcoverEdition } from '../../src/api/hardcover/types.ts';
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

// --- Book covers ---------------------------------------------------------
//
// One fixture per tier, each shaped so that only that tier can decide it: if a
// tier is deleted the test below it fails and its neighbours do not.

const ed = (over: Partial<HardcoverEdition> & { url?: string; w?: number; h?: number } = {}): HardcoverEdition => {
  const { url = '/x.jpg', w = 400, h = 600, ...rest } = over;
  return { users_count: 1, reading_format_id: 1, language: { code2: 'en' }, country: { code2: 'us' }, image: { url: `https://assets.hardcover.app${url}`, width: w, height: h }, ...rest };
};

const urls = (cands: { url: string }[]): string[] => cands.map((c) => c.url.replace('https://assets.hardcover.app', ''));

test('a cover in English beats a bigger one that is not', () => {
  const got = bookCandidates({ byUsers: [ed({ url: '/de.jpg', w: 2400, h: 3600, language: { code2: 'de' } }), ed({ url: '/en.jpg', w: 300, h: 450 })] });
  assert.deepEqual(urls(got), ['/en.jpg', '/de.jpg']);
});

test('a cover with no language recorded sits between English and another language', () => {
  const got = bookCandidates({
    byUsers: [ed({ url: '/pt.jpg', language: { code2: 'pt' } }), ed({ url: '/none.jpg', language: null }), ed({ url: '/en.jpg' })],
  });
  assert.deepEqual(urls(got), ['/en.jpg', '/none.jpg', '/pt.jpg']);
});

test('a square audiobook cover is not offered at all', () => {
  // Sabriel's only English cover over 600px wide is 2397×2400, and it is not a
  // cover of the book. Dropped rather than ranked last: shown at all, it gets
  // picked.
  const got = bookCandidates({ byUsers: [ed({ url: '/square.jpg', w: 2397, h: 2400 }), ed({ url: '/poster.jpg', w: 600, h: 900 })] });
  assert.deepEqual(urls(got), ['/poster.jpg']);
});

test('the shape window is 1.4 to 1.7 tall, inclusive at both ends', () => {
  const at = (w: number, h: number) => urls(bookCandidates({ byUsers: [ed({ url: '/x.jpg', w, h })] }));
  assert.deepEqual(at(500, 700), ['/x.jpg'], '1.40 exactly');
  assert.deepEqual(at(500, 850), ['/x.jpg'], '1.70 exactly');
  assert.deepEqual(at(500, 699), [], 'just under 1.40');
  assert.deepEqual(at(500, 851), [], 'just over 1.70');
  // What the window is actually keeping out, at either end.
  assert.deepEqual(at(500, 459), [], 'a landscape 0.92');
  assert.deepEqual(at(1500, 1500), [], 'a square');
  assert.deepEqual(at(1465, 2625), [], 'a 1.79 stretch');
});

test('the shape is bucketed, so readers decide between two covers that are both close enough', () => {
  // 0.622 and 0.654 are both inside the near band, so the tier ties and the
  // edition people actually hold wins. Scored on distance instead, the shape
  // would order them completely and no tier below it could ever fire.
  const got = bookCandidates({
    byUsers: [ed({ url: '/near.jpg', w: 933, h: 1500, users_count: 2 }), ed({ url: '/nearer.jpg', w: 327, h: 500, users_count: 400 })],
  });
  assert.deepEqual(urls(got), ['/nearer.jpg', '/near.jpg']);
  // Inside the window but at its tall end, a cover still sorts below one at
  // 2:3 however many readers it has — the tier orders what the filter allowed.
  const tall = bookCandidates({
    byUsers: [ed({ url: '/tall.jpg', w: 500, h: 840, users_count: 900 }), ed({ url: '/right.jpg', w: 333, h: 500, users_count: 1 })],
  });
  assert.deepEqual(urls(tall), ['/right.jpg', '/tall.jpg']);
});

test('resolution does not rank: a big cover nobody holds loses to the edition people read', () => {
  // The larger file is usually the same artwork scanned bigger, not a better
  // picture. Ranked on width, 1984's 1707×2560 led on three readers while the
  // edition three hundred people hold sat below it.
  const got = bookCandidates({
    byUsers: [ed({ url: '/huge.jpg', w: 1707, h: 2560, users_count: 3 }), ed({ url: '/read.jpg', w: 330, h: 500, users_count: 300 })],
  });
  assert.deepEqual(urls(got), ['/read.jpg', '/huge.jpg']);
});

test('a UK edition leads, and the preference is binary so everything else stays equal', () => {
  // The price of the rule: a `gb` 329×500 leads a `us` 1695×2560 held by more
  // readers. Pinned because it is a trade, not an accident.
  const got = bookCandidates({
    byUsers: [ed({ url: '/us-big.jpg', w: 1695, h: 2560, users_count: 500 }), ed({ url: '/gb.jpg', w: 329, h: 500, country: { code2: 'gb' } })],
  });
  assert.deepEqual(urls(got), ['/gb.jpg', '/us-big.jpg']);
  // Binary: `us` and an unrecorded country are one tier, so readers separate
  // them. Ranked three ways an unknown would outrank `us`, which is 164 of the
  // 229 candidates measured.
  const unknown = bookCandidates({
    byUsers: [ed({ url: '/none.jpg', country: null, users_count: 90 }), ed({ url: '/us.jpg', users_count: 4 })],
  });
  assert.deepEqual(urls(unknown), ['/none.jpg', '/us.jpg']);
});

test('the width floor is 300px exactly', () => {
  // The one thing size still decides, so the boundary is worth pinning: it is
  // not the 272px the thumbnail is fetched at, and not a round guess.
  const at = (w: number) => bookCandidates({ byUsers: [ed({ url: '/small.jpg', w: 299, h: 449 }), ed({ url: '/x.jpg', w, h: Math.round(w * 1.5) })] })[0]?.url ?? '';
  assert.match(at(300), /\/x\.jpg$/, '300 is usable');
  assert.match(at(299), /\/small\.jpg$/, '299 is not, so the URL tail decides between two demoted covers');
});

test('a cover under 300px wide loses to a usable one, even a UK cover to a US one', () => {
  // The one thing size still decides. A 128×196 scan is upscaled even in the
  // 272px strip; without the floor, preferring a UK edition hands over
  // Lirael's 128×196 in place of a 347×500.
  const got = bookCandidates({
    byUsers: [ed({ url: '/tiny-gb.jpg', w: 128, h: 196, country: { code2: 'gb' } }), ed({ url: '/usable-us.jpg', w: 347, h: 500 })],
  });
  assert.deepEqual(urls(got), ['/usable-us.jpg', '/tiny-gb.jpg']);
});

test('a book whose covers are all too small still gets them in a sensible order', () => {
  // Demoted, never dropped: sharing one tier, the rest of the order decides,
  // so a strip is still offered rather than an empty row.
  const got = bookCandidates({
    byUsers: [ed({ url: '/small-us.jpg', w: 100, h: 150 }), ed({ url: '/small-gb.jpg', w: 128, h: 196, country: { code2: 'gb' } })],
  });
  assert.deepEqual(urls(got), ['/small-gb.jpg', '/small-us.jpg']);
});

test('readers break a tie on width, and the URL breaks a tie on readers', () => {
  const byReaders = bookCandidates({ byUsers: [ed({ url: '/quiet.jpg', users_count: 2 }), ed({ url: '/popular.jpg', users_count: 90 })] });
  assert.deepEqual(urls(byReaders), ['/popular.jpg', '/quiet.jpg']);
  // Identical on every tier: the order must not depend on arrival, or the
  // strip reshuffles between two opens of one row.
  const identical = [ed({ url: '/b.jpg' }), ed({ url: '/a.jpg' })];
  assert.deepEqual(urls(bookCandidates({ byUsers: identical })), ['/a.jpg', '/b.jpg']);
  assert.deepEqual(urls(bookCandidates({ byUsers: [...identical].reverse() })), ['/a.jpg', '/b.jpg']);
});

test('a TIFF is never offered, however well it would otherwise rank', () => {
  // It passes `fetchImage`'s `image/*` check and uploads happily, and then no
  // browser renders it. The proxy the thumbnails go through does not convert
  // it either.
  const got = bookCandidates({ byUsers: [ed({ url: '/perfect.tiff', w: 1600, h: 2400, country: { code2: 'gb' } }), ed({ url: '/ok.jpg' })] });
  assert.deepEqual(urls(got), ['/ok.jpg']);
});

test('a cover missing a dimension is skipped rather than divided by zero', () => {
  const got = bookCandidates({ byUsers: [{ users_count: 1, image: { url: 'https://assets.hardcover.app/no.jpg', width: 400 } }, ed()] });
  assert.deepEqual(urls(got), ['/x.jpg']);
});

test('the two orderings are merged, and one picture is one tile whichever edition carries it', () => {
  const shared = 'https://assets.hardcover.app/shared.jpg';
  const got = bookCandidates({
    byUsers: [ed({ url: '/shared.jpg', users_count: 3 }), ed({ url: '/a.jpg' })],
    // The same edition again, plus a *different* edition reusing one cover
    // with more readers behind it. Keyed on the edition id both would show.
    byWidth: [ed({ url: '/shared.jpg', users_count: 3 }), ed({ url: '/shared.jpg', users_count: 40 }), ed({ url: '/b.jpg', w: 800, h: 1200 })],
  });
  assert.equal(got.filter((c) => c.url === shared).length, 1);
  assert.deepEqual(got.find((c) => c.url === shared)?.votes, 40);
  assert.deepEqual(urls(got), ['/shared.jpg', '/a.jpg', '/b.jpg']);
});

test('when two editions share a cover, the tile is the one that wins the ranking', () => {
  // The merge is the sort, not a field-by-field patch. Merging fields builds
  // an edition that does not exist — a country from one, a reader count from
  // another — and the badge then names neither.
  const got = bookCandidates({
    // `byUsers` is readers-descending, so the US edition is always seen first.
    byUsers: [ed({ url: '/shared.jpg', users_count: 500 })],
    byWidth: [ed({ url: '/shared.jpg', users_count: 5, country: { code2: 'gb' } })],
  });
  assert.equal(got.length, 1);
  // The UK edition wins its tier, so the tile is the UK one — badge, readers
  // and all. Keeping the first-seen metadata would badge it `us` and drop the
  // country tier for a picture a UK edition genuinely carries.
  assert.equal(got[0]?.country, 'gb');
  assert.equal(got[0]?.votes, 5);
});

test('a shared cover keeps the more-read edition when nothing else separates them', () => {
  const got = bookCandidates({
    byUsers: [ed({ url: '/shared.jpg', users_count: 3 })],
    byWidth: [ed({ url: '/shared.jpg', users_count: 40 })],
  });
  assert.equal(got.length, 1);
  assert.equal(got[0]?.votes, 40);
});

test('a book whose covers are all the wrong shape gets an empty strip, not a wrong one', () => {
  // The accepted cost of filtering. Such a row is left alone or filled in by
  // hand; a demotion would have put an audiobook square at the top of a strip
  // of one.
  assert.deepEqual(bookCandidates({ byUsers: [ed({ url: '/sq.jpg', w: 1500, h: 1500 })] }), []);
});

test('a thumbnail is proxied and narrowed; the full-size URL is the raw asset', () => {
  const [cover] = bookCandidates({ byUsers: [ed({ url: '/c.jpg', w: 1600, h: 2400 })] });
  assert.equal(cover?.url, 'https://assets.hardcover.app/c.jpg');
  assert.equal(cover?.thumb, 'https://wsrv.nl/?url=https%3A%2F%2Fassets.hardcover.app%2Fc.jpg&w=272');
  assert.equal(cover?.source, 'hardcover');
  assert.equal(cover?.country, 'us');
  assert.equal(cover?.format, 'print');
});

test('an absent or empty payload is an empty strip, not a throw', () => {
  assert.deepEqual(bookCandidates(undefined), []);
  assert.deepEqual(bookCandidates({}), []);
  assert.deepEqual(bookCandidates({ byUsers: [], byWidth: [] }), []);
});
