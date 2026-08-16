import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNT_KEYS,
  deltaFrom,
  libraryCounts,
  librarySignature,
  membershipIds,
  mergeDelta,
  removalSignature,
  retainOnly,
  toLibrary,
} from '../src/library.ts';
import { libraryItem } from './helpers.ts';
import type { Activities, AllItemsResponse, Library } from '../src/api/simkl/types.ts';

/** The fixture always populates every category, so tests can mutate them freely. */
type FullActivities = Activities & Required<Pick<Activities, 'tv_shows' | 'anime' | 'movies'>>;

// Shape taken from a real /sync/activities response.
const activities = (): FullActivities => ({
  all: '2026-08-10T11:52:03Z',
  settings: { all: '2026-07-26T13:06:36Z' },
  tv_shows: {
    all: '2026-08-10T11:52:03Z',
    rated_at: '2026-07-12T21:48:41Z',
    playback: '2026-08-08T22:59:34Z',
    plantowatch: '2026-07-12T22:46:29Z',
    watching: '2026-08-10T11:52:03Z',
    completed: '2026-08-01T14:34:35Z',
    hold: '2026-07-12T19:05:00Z',
    dropped: '2026-07-26T13:03:25Z',
    removed_from_list: '2026-07-12T22:46:29Z',
  },
  anime: { all: '2026-08-09T22:17:35Z', playback: null, watching: '2026-08-08T11:32:04Z', plantowatch: '2026-07-26T10:48:53Z', completed: '2026-08-09T22:17:35Z', removed_from_list: '2026-08-01T14:49:38Z' },
  // movies carries no `watching` or `hold` key at all.
  movies: { all: '2026-08-01T14:44:43Z', rated_at: '2026-08-01T14:25:00Z', plantowatch: '2026-07-25T14:17:58Z', completed: '2026-08-01T14:44:43Z', removed_from_list: '2026-07-26T11:01:42Z' },
});

const shows = (...ids: number[]): AllItemsResponse => ({ shows: ids.map((id) => libraryItem({ id })) });

// --- Signatures ------------------------------------------------------------

test('nothing moved means an unchanged signature', () => {
  assert.equal(librarySignature(activities()), librarySignature(activities()));
});

// The reason the trigger is not `activities.all`, which rolls both of these up.
test('playback progress moves no signature', () => {
  const before = librarySignature(activities());
  const after = activities();
  after.tv_shows.playback = '2026-08-10T20:00:00Z';
  after.tv_shows.all = '2026-08-10T20:00:00Z';
  after.all = '2026-08-10T20:00:00Z';
  assert.equal(librarySignature(after), before, 'a scrobbler must not pull a delta');
});

test('rating something moves no signature', () => {
  const before = librarySignature(activities());
  const after = activities();
  after.tv_shows.rated_at = '2026-08-10T20:00:00Z';
  after.all = '2026-08-10T20:00:00Z';
  assert.equal(librarySignature(after), before);
});

test('marking an episode watched moves the signature', () => {
  const before = librarySignature(activities());
  const after = activities();
  after.tv_shows.watching = '2026-08-10T20:00:00Z';
  assert.notEqual(librarySignature(after), before);
});

test('a status timestamp in one category is distinguishable from the same one in another', () => {
  const a = activities();
  const b = activities();
  a.anime.watching = '2026-08-10T20:00:00Z';
  b.tv_shows.watching = '2026-08-10T20:00:00Z';
  assert.notEqual(librarySignature(a), librarySignature(b), 'otherwise the categories gate together');
});

// A removal moves this and nothing else, which is why it is gated on its own.
test('a removal moves the removal signature and leaves the library signature alone', () => {
  const before = { library: librarySignature(activities()), removal: removalSignature(activities()) };
  const after = activities();
  after.movies.removed_from_list = '2026-08-11T09:00:00Z';
  assert.equal(librarySignature(after), before.library);
  assert.notEqual(removalSignature(after), before.removal);
});

// --- The watermark ---------------------------------------------------------

// `date_from` is compared strictly greater at one-second granularity, so asking
// from the watermark itself returns nothing at all, and a write committed in
// that same second after the activities read would never be asked for again.
test('the delta is asked for from one second behind the watermark', () => {
  assert.equal(deltaFrom('2026-08-15T12:00:00Z'), '2026-08-15T11:59:59Z');
});

test('the backoff crosses a minute, an hour and a day cleanly', () => {
  assert.equal(deltaFrom('2026-08-15T12:00:00Z'), '2026-08-15T11:59:59Z');
  assert.equal(deltaFrom('2026-08-15T00:00:00Z'), '2026-08-14T23:59:59Z');
  assert.equal(deltaFrom('2026-01-01T00:00:00Z'), '2025-12-31T23:59:59Z');
});

// Second precision, because that is the granularity the comparison uses and a
// fractional part is not something SIMKL ever sent us.
test('the result carries no milliseconds', () => {
  assert.doesNotMatch(deltaFrom('2026-08-15T12:00:00Z')!, /\.\d/);
});

// Sending back what SIMKL gave us beats sending a guess.
test('an unparseable watermark is passed through untouched', () => {
  assert.equal(deltaFrom('not a date'), 'not a date');
});

test('no watermark asks for no delta', () => {
  assert.equal(deltaFrom(null), null);
  assert.equal(deltaFrom(undefined), null);
  assert.equal(deltaFrom(''), null, 'an empty watermark is not a timestamp either');
});

// --- Merging ---------------------------------------------------------------

test('a full pull keys every item by its simkl id, tagged with the type it arrived under', () => {
  const library = toLibrary({
    shows: [libraryItem({ id: 1 })],
    anime: [libraryItem({ id: 2 })],
    movies: [libraryItem({ id: 3 })],
  });
  assert.deepEqual([...library.keys()].sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual([1, 2, 3].map((id) => library.get(id)?.type), ['shows', 'anime', 'movies']);
});

// An anime record is a show record plus `anime_type`, and both nest under
// `show` — the response key is the only witness to which one it is.
test('the type comes from the response key, not the record', () => {
  const item = libraryItem({ id: 7 });
  assert.equal(toLibrary({ shows: [item] }).get(7)?.type, 'shows');
  assert.equal(toLibrary({ anime: [item] }).get(7)?.type, 'anime');
});

test('an item with no usable id never enters the library', () => {
  const library = toLibrary({ shows: [{ show: { title: 'No ids', ids: {} }, status: 'watching' }, libraryItem({ id: 4 })] });
  assert.deepEqual([...library.keys()], [4]);
});

// The poll asks for one second more than it needs, so the newest records arrive
// twice by design. Merging the same delta twice must be indistinguishable from
// merging it once.
test('merging the same delta twice is the same as merging it once', () => {
  const base = toLibrary(shows(1, 2));
  const delta = shows(2, 3);
  const once = mergeDelta(base, delta).library;
  const twice = mergeDelta(once, delta).library;
  assert.deepEqual([...twice.entries()], [...once.entries()]);
  assert.equal(twice.size, 3);
});

test('a delta leaves the records it does not mention untouched', () => {
  const base = toLibrary(shows(1, 2, 3));
  const untouched = base.get(1);
  const { library } = mergeDelta(base, shows(3));
  assert.equal(library.size, 3);
  assert.equal(library.get(1), untouched, 'the same object, not a rebuilt copy');
});

// What a quiet `date_from` poll returns, all two bytes of it.
test('an empty delta changes nothing', () => {
  const base = toLibrary(shows(1, 2));
  const { library, updated } = mergeDelta(base, {});
  assert.equal(updated, 0);
  assert.deepEqual([...library.entries()], [...base.entries()]);
});

test('a delta never mutates the library it merged into', () => {
  const base = toLibrary(shows(1));
  mergeDelta(base, shows(2));
  assert.deepEqual([...base.keys()], [1], 'the orchestrator swaps in one assignment');
});

// The move arrives as a replacement of the record, so no second copy of the
// title can exist to be reconciled against the first.
test('a watching to dropped move leaves exactly one record', () => {
  const base = toLibrary({ shows: [libraryItem({ id: 9, status: 'watching' })] });
  const { library } = mergeDelta(base, { shows: [libraryItem({ id: 9, status: 'dropped' })] });
  assert.equal(library.size, 1);
  assert.equal(library.get(9)?.item.status, 'dropped');
});

// The case that breaks if the merge filters films by status: the record saying
// the film left plan-to-watch is the one that would be dropped.
test('a film moving to completed replaces its plan-to-watch record', () => {
  const base = toLibrary({ movies: [libraryItem({ id: 5, status: 'plantowatch' })] });
  const { library } = mergeDelta(base, { movies: [libraryItem({ id: 5, status: 'completed' })] });
  assert.equal(library.size, 1);
  assert.equal(library.get(5)?.item.status, 'completed');
});

test('an item reclassified between types follows the response key', () => {
  const base = toLibrary({ shows: [libraryItem({ id: 6 })] });
  const { library } = mergeDelta(base, { anime: [libraryItem({ id: 6 })] });
  assert.equal(library.size, 1, 'one record, not one per type');
  assert.equal(library.get(6)?.type, 'anime');
});

// --- What the delta reshaped -----------------------------------------------
//
// `updated` counts what arrived; `reshaped` counts what moved. The feed reads
// membership only, so it needs the second — and the two diverge on the most
// common event there is.

test('a record that only changed watch progress is updated but not reshaped', () => {
  const base = toLibrary({ shows: [libraryItem({ id: 1, status: 'watching', watched: 3 })] });
  const { updated, reshaped } = mergeDelta(base, { shows: [libraryItem({ id: 1, status: 'watching', watched: 4 })] });
  assert.equal(updated, 1, 'the record did arrive');
  assert.equal(reshaped, 0, 'but nothing the feed can see moved');
});

test('a status change is reshaped', () => {
  const base = toLibrary({ shows: [libraryItem({ id: 1, status: 'watching' })] });
  assert.equal(mergeDelta(base, { shows: [libraryItem({ id: 1, status: 'dropped' })] }).reshaped, 1);
});

test('a record arriving for the first time is reshaped', () => {
  assert.equal(mergeDelta(new Map() as Library, shows(1)).reshaped, 1);
});

// The top-level key is the classification, and it decides which calendar the
// title joins against — so a reclassification is a change the feed can see.
test('a reclassification between types is reshaped', () => {
  const base = toLibrary({ shows: [libraryItem({ id: 1 })] });
  assert.equal(mergeDelta(base, { anime: [libraryItem({ id: 1 })] }).reshaped, 1);
});

// The second-overlap re-sends the newest records every poll; none of them moved.
test('re-merging an unchanged record reshapes nothing', () => {
  const base = toLibrary(shows(1, 2));
  assert.equal(mergeDelta(base, shows(1, 2)).reshaped, 0);
});

// --- Removals --------------------------------------------------------------

test('membership ids read every type of a simkl_ids_only response', () => {
  const ids = membershipIds({
    shows: [{ show: { ids: { simkl: 1 } } }],
    anime: [{ show: { ids: { simkl: 2 } } }],
    movies: [{ movie: { ids: { simkl: 3 } } }],
  });
  assert.deepEqual([...ids].sort((a, b) => a - b), [1, 2, 3]);
});

test('reconciling drops exactly what the membership set omits', () => {
  const base = toLibrary(shows(1, 2, 3));
  const { library, removed } = retainOnly(base, new Set([1, 3]));
  assert.equal(removed, 1);
  assert.deepEqual([...library.keys()], [1, 3]);
});

test('reconciling that removes nothing returns the same library', () => {
  const base = toLibrary(shows(1, 2));
  const { library, removed } = retainOnly(base, new Set([1, 2, 99]));
  assert.equal(removed, 0);
  assert.equal(library, base, 'so a quiet reconcile does not force a re-render');
});

// A truncated response is indistinguishable from a cleared account, and
// applying one empties the feed. Refusing costs a retry on the next poll.
test('a membership response that would empty the library is refused, and drops nothing', () => {
  const base = toLibrary(shows(1, 2, 3));
  const { library, removed, applied } = retainOnly(base, new Set());
  assert.equal(applied, false);
  assert.equal(removed, 0);
  assert.equal(library, base, 'the refusal must not churn the library either');
});

test('a membership response that would drop most of the library is refused', () => {
  const base = toLibrary(shows(1, 2, 3, 4));
  assert.equal(retainOnly(base, new Set([1])).applied, false);
  assert.equal(retainOnly(base, new Set([1, 2, 3])).applied, true);
});

test('an empty membership response against an empty library is not a fault', () => {
  assert.equal(retainOnly(new Map() as Library, new Set()).applied, true);
});

// --- Counts ----------------------------------------------------------------

test('counts name every type and status, including the empty ones', () => {
  const counts = libraryCounts(new Map() as Library);
  assert.deepEqual(Object.keys(counts), COUNT_KEYS);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 0);
});

// movies carries no watching or hold status at all.
test('the film statuses are only the three films can hold', () => {
  assert.deepEqual(COUNT_KEYS.filter((key) => key.startsWith('movies/')), [
    'movies/plantowatch',
    'movies/completed',
    'movies/dropped',
  ]);
});

test('counts split by type and status', () => {
  const library = toLibrary({
    shows: [libraryItem({ id: 1, status: 'watching' }), libraryItem({ id: 2, status: 'dropped' })],
    anime: [libraryItem({ id: 3, status: 'watching' })],
    movies: [libraryItem({ id: 4, status: 'plantowatch' })],
  });
  const counts = libraryCounts(library);
  assert.equal(counts['shows/watching'], 1);
  assert.equal(counts['shows/dropped'], 1);
  assert.equal(counts['anime/watching'], 1);
  assert.equal(counts['movies/plantowatch'], 1);
  assert.equal(counts.other, 0);
});

// So the rows always sum to the library total, whatever SIMKL adds later.
test('an unrecognised status lands in other rather than vanishing', () => {
  const library = toLibrary({ shows: [libraryItem({ id: 1, status: 'rewatching' })] });
  const counts = libraryCounts(library);
  assert.equal(counts.other, 1);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), library.size);
});

test('a library that was never fetched counts as zero, not as missing rows', () => {
  assert.deepEqual(Object.keys(libraryCounts(null)), COUNT_KEYS);
});
