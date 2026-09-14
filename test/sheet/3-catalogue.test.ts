import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  averageRuntime,
  CatalogueStore,
  needsLookup,
  seasonComplete,
  seasonShapes,
  tmdbIdOf,
  tvdbIdOf,
  episodesAnswered,
} from '../../src/sheet/3-catalogue.ts';
import { certificateFor, runtimeMinutes } from '../../src/sheet/values.ts';
import { indexLibrary } from '../../src/sheet/1-index.ts';
import { libraryOf } from '../helpers.ts';

// --- shapes ----------------------------------------------------------------

test('specials never inflate a numbered season, which would block its end date forever', () => {
  const shapes = seasonShapes([
    { season: 1, episode: 1, type: 'episode', aired: true },
    { season: 1, episode: 2, type: 'episode', aired: true },
    { season: 1, episode: 3, type: 'special', aired: true },
    { season: 0, episode: 1, type: 'episode', aired: true },
  ]);
  assert.deepEqual([...shapes.keys()], [1]);
  assert.equal(shapes.get(1)?.total, 2);
});

// Silo S3: 7 aired of 10, all 7 watched. "Every aired episode watched" stamps
// an end date on a season with three episodes to come — permanent, because a
// dated season is never revisited.
test('a season still airing is not complete, however much of it has been watched', () => {
  const airing = { number: 3, total: 10, aired: 7 };
  assert.equal(seasonComplete(airing, 7), false);
  assert.equal(seasonComplete({ number: 3, total: 10, aired: 10 }, 10), true);
  assert.equal(seasonComplete({ number: 3, total: 10, aired: 10 }, 9), false);
  assert.equal(seasonComplete(undefined, 10), false);
});

// --- runtimes --------------------------------------------------------------

const eps = (...specs: Array<[number, number | null]>) => specs.map(([number, runtime]) => ({ number, runtime }));

test('a season average is the arithmetic mean, in whole minutes', () => {
  assert.equal(averageRuntime(eps([1, 24], [2, 24], [3, 25]), 3), 24);
  // 21 at 22m plus a 44m finale is 506 minutes; 23 x 22 = 506. A median
  // answers 22 and leaves every Runtime cell in the block short by 22 minutes.
  const long = eps(...Array.from({ length: 21 }, (_, i) => [i + 1, 22] as [number, number]), [22, 44]);
  assert.equal(averageRuntime(long, 22), 23);
});

test('a null runtime is unknown, not zero, and refuses the whole season', () => {
  // Counting the null as 0 answers 16 — a wrong-but-plausible number frozen
  // into a cell nothing revisits.
  assert.equal(averageRuntime(eps([1, 24], [2, null], [3, 24]), 3), null);
  assert.equal(averageRuntime(eps([1, 0], [2, 24]), 2), null);
  assert.equal(averageRuntime(eps([1, null], [2, null]), 2), null);
});

// The likelier "no data" path: TVDB answers a season it does not have with a
// 200 and an empty list, not a 404, so this never reaches classify.
test('an empty season is a settled null rather than a throw', () => {
  assert.equal(averageRuntime([], 6), null);
  assert.equal(averageRuntime(undefined, 6), null);
  assert.equal(averageRuntime(null, 6), null);
});

test('a count that disagrees with SIMKL refuses, in either direction', () => {
  assert.equal(averageRuntime(eps([1, 24], [2, 24]), 3), null, 'TVDB has fewer');
  assert.equal(averageRuntime(eps([1, 24], [2, 24], [3, 24]), 2), null, 'TVDB has more');
  assert.equal(averageRuntime(eps([1, 24]), 0), null, 'no SIMKL count is not a match');
});

// A null's refusal is recorded as settled, so preferring it over a real length
// in the same payload forfeits the cell for good.
test('a usable duplicate beats an unusable one, whichever came first', () => {
  assert.equal(averageRuntime([{ number: 1, runtime: null }, { number: 1, runtime: 24 }, { number: 2, runtime: 26 }], 2), 25);
  assert.equal(averageRuntime([{ number: 1, runtime: 24 }, { number: 1, runtime: null }, { number: 2, runtime: 26 }], 2), 25);
});

test('a film inside a numbered season is dropped, and a duplicate counted once', () => {
  // Dropped before the count check, so the season still matches SIMKL's two.
  assert.equal(averageRuntime([{ number: 1, runtime: 24 }, { number: 2, runtime: 24 }, { number: 3, runtime: 120, isMovie: 1 }], 2), 24);
  // Weighted twice, the mean would be 24 rather than 26.
  assert.equal(averageRuntime(eps([1, 24], [1, 24], [2, 28]), 2), 26);
});

test('a mean under half a minute yields no cell rather than a zero one', () => {
  assert.equal(runtimeMinutes(averageRuntime(eps([1, 0.2], [2, 0.2]), 2)), null);
});

test('the tvdb id is read as a number, and anything else is simply absent', () => {
  assert.equal(tvdbIdOf({ ids: { tvdb: '371572' } }), 371572);
  assert.equal(tvdbIdOf({ ids: { tvdb: ' 371572 ' } }), 371572);
  assert.equal(tvdbIdOf({ ids: {} }), null);
  assert.equal(tvdbIdOf({}), null);
  assert.equal(tvdbIdOf(undefined), null);
  assert.equal(tvdbIdOf({ ids: { tvdb: 'not-a-number' } }), null);
  assert.equal(tvdbIdOf({ ids: { tvdb: '0' } }), null);
});

test('the tmdb id is read the same way, off the same record', () => {
  assert.equal(tmdbIdOf({ ids: { tmdb: '95396' } }), 95396);
  assert.equal(tmdbIdOf({ ids: { tmdb: ' 95396 ' } }), 95396);
  assert.equal(tmdbIdOf({ ids: {} }), null);
  assert.equal(tmdbIdOf(undefined), null);
  assert.equal(tmdbIdOf({ ids: { tmdb: 'tt0903747' } }), null);
  assert.equal(tmdbIdOf({ ids: { tmdb: '0' } }), null);
});

// The array arrives in no contracted order and the US entry leads on most
// series, so a positional pick writes the wrong age into a cell nothing
// revisits.
test('the certificate is the GB entry by territory, wherever it sits', () => {
  assert.equal(certificateFor({ content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }, { iso_3166_1: 'GB', rating: '15' }] } }), 15);
  assert.equal(certificateFor({ content_ratings: { results: [{ iso_3166_1: 'GB', rating: 'U' }] } }), 3);
});

test('a series with no GB rating, or one outside the BBFC set, leaves the cell blank', () => {
  assert.equal(certificateFor({ content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-14' }] } }), null);
  assert.equal(certificateFor({ content_ratings: { results: [{ iso_3166_1: 'GB', rating: 'TV-14' }] } }), null);
  assert.equal(certificateFor({ content_ratings: { results: [{ iso_3166_1: 'GB', rating: '' }] } }), null);
  assert.equal(certificateFor({ content_ratings: { results: [] } }), null);
  assert.equal(certificateFor({}), null);
  assert.equal(certificateFor(undefined), null);
});

// --- the store -------------------------------------------------------------

const NOW = Temporal.Instant.from('2026-08-20T12:00:00Z');
const index = () => indexLibrary(libraryOf({ id: 1, lastWatchedAt: '2026-08-19T21:00:00Z', seasons: { 1: ['2026-08-19T21:00:00Z'] } }));

const episodes = [
  { season: 1, episode: 1, type: 'episode', aired: true },
  { season: 1, episode: 2, type: 'episode', aired: true },
];

test('a fold reduces the payloads and stamps the title, so a quiet poll asks nothing', () => {
  const store = new CatalogueStore();
  store.foldCatalogue(
    [{ id: 1, episodes: true, detail: true }],
    { episodes: new Map([[1, episodes]]), details: new Map([[1, { status: 'ended', runtime: 45, ids: { tvdb: '99' } }]]), failed: [], unavailable: [] },
    index(),
    { at: NOW, tvdbEnabled: true },
  );

  const held = store.titles.get(1);
  assert.equal(held?.shapes?.get(1)?.total, 2);
  assert.equal(held?.status, 'ended');
  assert.equal(held?.tvdbId, 99);
  assert.equal(needsLookup(store.stamps.get(1), index().get(1), NOW, null), false, 'stamped, so not due again');
});

// The stamping discipline: a retryable failure is never recorded, so the next
// poll asks again; anything settled always is.
test('a failed lookup is left unstamped so the next poll retries it', () => {
  const store = new CatalogueStore();
  store.foldCatalogue(
    [{ id: 1, episodes: true }],
    { episodes: new Map(), details: new Map(), failed: [1], unavailable: [] },
    index(),
    { at: NOW },
  );
  assert.equal(needsLookup(store.stamps.get(1), index().get(1), NOW, null), true);
});

/**
 * Gone is a settled answer: a title SIMKL no longer serves folds to a present,
 * empty episode map, so its rows close on that rather than wait on a list that
 * is never coming. Only where nothing landed — `unavailable` is per title, and
 * an id whose episodes answered while its detail 404'd keeps its real map.
 */
test('a title SIMKL says is gone folds to an answered, empty episode list', () => {
  const store = new CatalogueStore();
  store.foldCatalogue(
    [{ id: 1, episodes: true, detail: true }, { id: 2, episodes: true, detail: true }, { id: 3, detail: true }],
    { episodes: new Map([[2, episodes]]), details: new Map(), failed: [], unavailable: [1, 2, 3] },
    index(),
    { at: NOW },
  );
  assert.equal(episodesAnswered(store.titles.get(1)), true, 'asked for episodes and gone: answered with nothing');
  assert.equal(store.titles.get(1)?.shapes?.size, 0);
  assert.equal(store.titles.get(2)?.shapes?.get(1)?.total, 2, 'a real list is not clobbered by the detail being gone');
  assert.equal(episodesAnswered(store.titles.get(3)), false, 'a title that asked for no episodes gets no episode answer');
});

// The join key turns the runtime feature on, so without a credential it is
// stored as an explicit null — settled, not pending — and the planner needs no
// second switch.
test('without a TVDB credential the join key folds in as null, not absent', () => {
  const store = new CatalogueStore();
  store.foldCatalogue(
    [{ id: 1, detail: true }],
    { episodes: new Map(), details: new Map([[1, { status: 'ended', ids: { tvdb: '99' } }]]), failed: [], unavailable: [] },
    index(),
    { at: NOW, tvdbEnabled: false },
  );
  assert.equal(store.titles.get(1)?.tvdbId, null);
});

test('a runtime fold records answers and settled nulls, and skips what stalled', () => {
  const store = new CatalogueStore();
  store.foldCatalogue(
    [{ id: 1, episodes: true }],
    { episodes: new Map([[1, episodes]]), details: new Map(), failed: [], unavailable: [] },
    index(),
    { at: NOW },
  );

  store.foldRuntimes(
    [
      { id: 1, tvdbId: 99, season: 1 },
      { id: 1, tvdbId: 99, season: 2 },
    ],
    // Season 1 answers usably; season 2's lookup failed retryably, so its key
    // stays absent and the row stays open.
    { episodes: new Map([['99:1', eps([1, 24], [2, 26])]]), failed: ['99:2'], unavailable: [] },
  );

  const held = store.titles.get(1);
  assert.equal(held?.seasonRuntimes.get(1), 25);
  assert.equal(held?.seasonRuntimes.has(2), false, 'a transient failure is not settled');
});

// The answer to a rejected credential: a typo never starts answering, and
// rows left pending would stop the sheet being dated — silently, for ever.
test('settling seasons as unusable records null for every pending request', () => {
  const store = new CatalogueStore();
  store.foldCatalogue(
    [{ id: 1, episodes: true }],
    { episodes: new Map([[1, episodes]]), details: new Map(), failed: [], unavailable: [] },
    index(),
    { at: NOW },
  );

  store.settleSeasonsUnusable([{ id: 1, tvdbId: 99, season: 1 }]);
  assert.equal(store.titles.get(1)?.seasonRuntimes.get(1), null, 'settled with nothing usable');
});

// --- the facts a new block writes ------------------------------------------

const detailOf = (over: Record<string, unknown> = {}) => ({
  status: 'ended',
  runtime: 45,
  title: 'Severance',
  network: 'BBC One',
  ids: { tvdb: '99', tmdb: '95396' },
  ...over,
});

test('a detail fold carries the title, the network cell and the tmdb join key', () => {
  const store = new CatalogueStore();
  store.foldCatalogue(
    [{ id: 1, detail: true }],
    { episodes: new Map(), details: new Map([[1, detailOf()]]), failed: [], unavailable: [] },
    index(),
    { at: NOW, tvdbEnabled: true },
  );

  const held = store.titles.get(1);
  assert.equal(held?.title, 'Severance');
  assert.equal(held?.network, 'BBC', 'through the spelling map, ready to write');
  assert.equal(held?.tmdbId, 95396);
});

// The two ids take opposite treatments: a null `tvdbId` says "no runtime
// obtainable", which is the right default with no key, where a null `tmdbId`
// would have the planner ask for a block by hand when the fix is setting
// TMDB_API_KEY.
test('the tmdb id folds in whatever the TVDB credential is doing', () => {
  const store = new CatalogueStore();
  store.foldCatalogue(
    [{ id: 1, detail: true }],
    { episodes: new Map(), details: new Map([[1, detailOf()]]), failed: [], unavailable: [] },
    index(),
    { at: NOW, tvdbEnabled: false },
  );
  assert.equal(store.titles.get(1)?.tvdbId, null);
  assert.equal(store.titles.get(1)?.tmdbId, 95396);
});

test('a genre fold maps into the vocabulary and keeps the order TVDB sent', () => {
  const store = new CatalogueStore();
  store.foldGenres([{ id: 1, tvdbId: 99 }], {
    genres: new Map([[1, ['Science Fiction', 'Crime', 'Drama']]]),
    failed: [],
    unavailable: [],
  });
  // Crime has no column to go in; Sci-Fi leads because TVDB sent it first,
  // which is what makes it the block's primary genre.
  assert.deepEqual(store.titles.get(1)?.genres, ['Sci-Fi', 'Drama']);
});

// Three states, and the planner reads all three: a settled empty list lets the
// block land with the cells blank, where an absent key makes it wait a poll.
test('a series TVDB has but files under nothing is settled, not pending', () => {
  const store = new CatalogueStore();
  store.foldGenres([{ id: 1, tvdbId: 99 }], { genres: new Map([[1, ['Reality']]]), failed: [], unavailable: [] });
  assert.deepEqual(store.titles.get(1)?.genres, [], 'answered, nothing in the vocabulary');
});

test('a 404 settles the genres as null and a failed lookup leaves them absent', () => {
  const store = new CatalogueStore();
  store.foldGenres([{ id: 1, tvdbId: 99 }, { id: 2, tvdbId: 98 }], {
    genres: new Map(),
    failed: [2],
    unavailable: [1],
  });
  assert.equal(store.titles.get(1)?.genres, null, 'gone, so asking again never helps');
  assert.equal(store.titles.get(2)?.genres, undefined, 'a transient failure is not settled');
});

// A recorded answer is the answer: a later 404 must not blank a series that
// has already said what it is.
test('an unavailable never overwrites genres already recorded', () => {
  const store = new CatalogueStore();
  store.foldGenres([{ id: 1, tvdbId: 99 }], { genres: new Map([[1, ['Drama']]]), failed: [], unavailable: [] });
  store.foldGenres([{ id: 1, tvdbId: 99 }], { genres: new Map(), failed: [], unavailable: [1] });
  assert.deepEqual(store.titles.get(1)?.genres, ['Drama']);
});

test('a certificate fold records the GB age, and a 404 records the absence of one', () => {
  const store = new CatalogueStore();
  store.foldCertificates([{ id: 1, tmdbId: 95396 }, { id: 2, tmdbId: 95397 }], {
    shows: new Map([[1, { content_ratings: { results: [{ iso_3166_1: 'GB', rating: '15' }] } }]]),
    failed: [],
    unavailable: [2],
  });
  assert.equal(store.titles.get(1)?.certificate, 15);
  assert.equal(store.titles.get(2)?.certificate, null);
});

// The distinction the cell rests on: null lets the block land blank, absent
// makes it wait, and only the second is worth another request.
test('a failed certificate lookup is left absent so the next poll asks again', () => {
  const store = new CatalogueStore();
  store.foldCertificates([{ id: 1, tmdbId: 95396 }], { shows: new Map(), failed: [1], unavailable: [] });
  assert.equal(store.titles.get(1)?.certificate, undefined);
});

// A series TMDB answers for and carries no GB entry is settled with nothing —
// 10 of the 189 blocks measured, and their cells stay blank.
test('a series TMDB has no GB rating for is settled as null, not left pending', () => {
  const store = new CatalogueStore();
  store.foldCertificates([{ id: 1, tmdbId: 95396 }], {
    shows: new Map([[1, { content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] } }]]),
    failed: [],
    unavailable: [],
  });
  assert.equal(store.titles.get(1)?.certificate, null);
});

// A rejection is a fact about the token, so it is held apart from the answers:
// settling the pending blocks would have the planner ask for rows by hand that
// the upstream could build the moment the key is fixed.
test('a rejected credential is recorded by name and settles no title', () => {
  const store = new CatalogueStore();
  store.foldCertificates([{ id: 1, tmdbId: 95396 }], { shows: new Map(), failed: [1], unavailable: [] });
  assert.deepEqual([...store.factsRejected], []);
  store.rejectFacts('tmdb');
  assert.deepEqual([...store.factsRejected], ['tmdb']);
  assert.equal(store.titles.get(1)?.certificate, undefined, 'still pending, not settled blank');
});

// Both keys are read at start-up, so one restart has to be enough: a second
// rejection landing on top of the first would leave the operator fixing one
// key, restarting, and being told about the other.
test('a second rejection joins the first rather than replacing it', () => {
  const store = new CatalogueStore();
  store.rejectFacts('tmdb');
  store.rejectFacts('tvdb');
  assert.deepEqual([...store.factsRejected].sort(), ['tmdb', 'tvdb']);
});

// --- the re-read gate ------------------------------------------------------

test('a title is re-read when its last watch moved, and only then', () => {
  const stamp = { watchedAt: Temporal.Instant.from('2026-08-19T21:00:00Z'), at: NOW };
  assert.equal(needsLookup(stamp, index().get(1), NOW, null), false, 'nothing moved');
  const moved = indexLibrary(libraryOf({ id: 1, lastWatchedAt: '2026-08-20T10:00:00Z', seasons: { 1: ['2026-08-20T10:00:00Z'] } }));
  assert.equal(needsLookup(stamp, moved.get(1), NOW, null), true, 'a watch is the trigger');
  assert.equal(needsLookup(undefined, index().get(1), NOW, null), true, 'never read is always due');
});

// The backstop for the change no watch produces: a renewal flips /tv/{id}
// status with no library activity.
test('the age ceiling re-reads a quiet title once it is stale', () => {
  const stamp = { watchedAt: Temporal.Instant.from('2026-08-19T21:00:00Z'), at: NOW.subtract({ hours: 25 }) };
  assert.equal(needsLookup(stamp, index().get(1), NOW, Temporal.Duration.from({ hours: 24 })), true);
  assert.equal(needsLookup(stamp, index().get(1), NOW, null), false, 'no ceiling, no re-read');
});
