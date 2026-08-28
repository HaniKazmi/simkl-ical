import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateGate,
  deltaFrom,
  librarySignature,
  membershipIds,
  mergeDelta,
  movedRemovals,
  removalStamps,
  retainOnly,
  toLibrary,
  watermarkOf,
} from '../src/library.ts';
import { libraryItem } from './helpers.ts';
import type { Activities, AllItemsResponse, SyncType } from '../src/api/simkl/types.ts';
import type { Library } from '../src/library.ts';

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
  const before = { library: librarySignature(activities()), removal: removalStamps(activities()) };
  const after = activities();
  after.movies.removed_from_list = '2026-08-11T09:00:00Z';
  assert.equal(librarySignature(after), before.library);
  assert.equal(movedRemovals(before.removal, removalStamps(after)).size, 1);
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

// Second precision, because that is the granularity `date_from` is compared at.
// The fractional input is the case that can tell: a whole-second one renders
// without a fraction anyway, so it would pass whatever the truncation did.
test('the result carries no milliseconds, whatever the watermark had', () => {
  assert.doesNotMatch(deltaFrom('2026-08-15T12:00:00Z')!, /\.\d/);
  assert.equal(deltaFrom('2026-08-15T12:00:00.500Z'), '2026-08-15T11:59:59Z');
  assert.equal(deltaFrom('2026-08-15T12:00:00.001Z'), '2026-08-15T11:59:59Z');
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

const ALL: Set<SyncType> = new Set(['shows', 'anime', 'movies']);

test('reconciling drops exactly what the membership set omits', () => {
  const base = toLibrary(shows(1, 2, 3));
  const { library, removed } = retainOnly(base, new Set([1, 3]), ALL);
  assert.equal(removed, 1);
  assert.deepEqual([...library.keys()], [1, 3]);
});

test('reconciling that removes nothing returns the same library', () => {
  const base = toLibrary(shows(1, 2));
  const { library, removed } = retainOnly(base, new Set([1, 2, 99]), ALL);
  assert.equal(removed, 0);
  assert.equal(library, base, 'so a quiet reconcile does not force a re-render');
});

// A truncated response is indistinguishable from a cleared account, and
// applying one empties the feed. Refusing costs a retry on the next poll.
test('a membership response that would empty a category is refused, and drops nothing', () => {
  const base = toLibrary(shows(1, 2, 3));
  const { library, removed, applied } = retainOnly(base, new Set(), ALL);
  assert.equal(applied, false);
  assert.equal(removed, 0);
  assert.equal(library, base, 'the refusal must not churn the library either');
});

test('a membership response that would drop most of a category is refused', () => {
  const base = toLibrary(shows(1, 2, 3, 4));
  assert.equal(retainOnly(base, new Set([1]), ALL).applied, false);
  assert.equal(retainOnly(base, new Set([1, 2, 3]), ALL).applied, true);
});

// The threshold is `> half`, so losing exactly half is allowed through.
test('dropping exactly half of a category is applied', () => {
  const base = toLibrary(shows(1, 2, 3, 4));
  assert.equal(retainOnly(base, new Set([1, 2]), ALL).applied, true);
});

test('an empty membership response against an empty library is not a fault', () => {
  assert.equal(retainOnly(new Map() as Library, new Set(), ALL).applied, true);
});

// The case a global proportion cannot see. A category omitted from the payload
// reads as "every id in it is gone"; if the other categories are intact it is a
// minority of the library, so a whole-library threshold waves it through and
// the stamp advances, meaning it never retries.
test('a category missing from the response is left alone when it reported no removal', () => {
  const base = toLibrary({
    shows: [libraryItem({ id: 1 }), libraryItem({ id: 2 })],
    anime: [libraryItem({ id: 3 }), libraryItem({ id: 4 })],
    movies: [libraryItem({ id: 5 }), libraryItem({ id: 6 })],
  });
  // Anime omitted entirely, and only movies reported a removal.
  const keep = new Set([1, 2, 5]);
  const { library, removed, applied } = retainOnly(base, keep, new Set<SyncType>(['movies']));

  assert.equal(applied, true, 'the category that did report one still reconciles');
  assert.equal(removed, 1, 'only the film');
  assert.deepEqual([...library.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5], 'every anime survives');
});

// And when the truncated category *is* the one that reported a removal, the
// proportional guard inside it catches the payload instead.
test('a category that reported a removal but came back empty is refused', () => {
  const base = toLibrary({
    shows: [libraryItem({ id: 1 })],
    anime: [libraryItem({ id: 3 }), libraryItem({ id: 4 })],
  });
  const refused = retainOnly(base, new Set([1]), new Set<SyncType>(['anime']));
  assert.equal(refused.applied, false);
  assert.equal(refused.library.size, 3);
});

// --- Removal stamps --------------------------------------------------------

test('a removal in one category is not read as a removal in another', () => {
  const before = removalStamps(activities());
  const after = activities();
  after.movies.removed_from_list = '2026-08-11T09:00:00Z';
  assert.deepEqual([...movedRemovals(before, removalStamps(after))], ['movies']);
});

test('nothing moving means no category to reconcile', () => {
  assert.equal(movedRemovals(removalStamps(activities()), removalStamps(activities())).size, 0);
});

// --- The gate --------------------------------------------------------------
//
// Three independent triggers, one of which deliberately disagrees with what the
// gate observed. Inline in the poll this could only be reached through a fake
// HTTP layer.

const held = (over: Partial<Parameters<typeof evaluateGate>[1]> = {}) => ({
  librarySignature: librarySignature(activities()),
  removalAt: removalStamps(activities()),
  syncedAll: '2026-08-10T11:52:03Z',
  hasLibrary: true,
  resyncPending: false,
  ...over,
});

test('a payload identical to the one held decides nothing', () => {
  const decision = evaluateGate(activities(), held());
  assert.equal(decision.changed, false);
  assert.equal(decision.removals, false);
  assert.equal(decision.full, false);
});

test('a moved status timestamp asks for a delta, not a full pull', () => {
  const after = activities();
  after.tv_shows.watching = '2026-08-11T09:00:00Z';
  const decision = evaluateGate(after, held());
  assert.equal(decision.changed, true);
  assert.equal(decision.full, false);
});

test('no watermark forces a full pull however quiet the payload', () => {
  assert.equal(evaluateGate(activities(), held({ syncedAll: null })).full, true);
});

test('no library forces a full pull', () => {
  assert.equal(evaluateGate(activities(), held({ hasLibrary: false })).full, true);
});

// The distinction the two fields exist for: a forced poll pulls everything
// while the gate itself saw nothing move, and conflating them would report a
// change that did not happen.
test('force pulls whole without claiming anything changed', () => {
  const decision = evaluateGate(activities(), held(), { force: true });
  assert.equal(decision.full, true);
  assert.equal(decision.changed, false);
});

test('only the categories whose removal stamp moved are named', () => {
  const after = activities();
  after.anime.removed_from_list = '2026-08-11T09:00:00Z';
  const decision = evaluateGate(after, held());
  assert.equal(decision.removals, true);
  assert.deepEqual([...decision.removedFrom], ['anime']);
});

// The stored values come back with the decision, so the branches that act on it
// cannot recompute them from a payload that has moved on.
test('the decision carries what the caller must store', () => {
  const after = activities();
  after.tv_shows.watching = '2026-08-11T09:00:00Z';
  const decision = evaluateGate(after, held());
  assert.equal(decision.signature, librarySignature(after));
  assert.deepEqual(decision.stamps, removalStamps(after));
});

// --- The watermark ---------------------------------------------------------

test('the roll-up is the watermark when SIMKL sends one', () => {
  assert.equal(watermarkOf(activities()), '2026-08-10T11:52:03Z');
});

// A local stamp would depend on this container's clock agreeing with SIMKL's,
// and would freeze at that moment for as long as the roll-up stayed absent.
test('with no roll-up the newest timestamp in the payload stands in', () => {
  const undated = { ...activities(), all: undefined };
  undated.tv_shows.watching = '2026-08-12T09:00:00Z';
  assert.equal(watermarkOf(undated), '2026-08-12T09:00:00Z');
});

test('a payload with no timestamps at all has no watermark to offer', () => {
  assert.equal(watermarkOf({ tv_shows: {}, anime: {}, movies: {} }), null);
  assert.equal(watermarkOf(null), null);
});
