/**
 * How the library is gated, merged and read.
 *
 * The library is the one input both halves consume, but only the orchestrator
 * owns it, so this sits beside the orchestrator rather than in `shared/`.
 * Pure: the calls themselves are in `api/simkl/lists.ts`.
 *
 * One record per SIMKL id. A delta returns each changed item once carrying its
 * current `status`, so a move is a replacement and no stale copy survives to
 * disagree.
 */

import { itemSimklId, itemStatus } from './api/simkl/item.ts';
import type { Activities, AllItemsResponse, CategoryActivity, LibraryItem, SyncType } from './api/simkl/types.ts';
import { instantFrom } from './shared/dates.ts';

/**
 * One library record, and the type it belongs to.
 *
 * `type` is the only thing not derivable from the item: an anime record is a
 * show record plus `anime_type`, and both nest their title under `show`, so
 * the top-level response key it arrived under is the answer. The feed picks a
 * calendar with it; the sheet skips films with it.
 *
 * `status` is *not* copied up here: `itemStatus` reads it from the item, and
 * a second copy can disagree with the payload it was built from.
 */
export interface LibraryEntry {
  type: SyncType;
  item: LibraryItem;
}

/**
 * The user's library: one authoritative record per SIMKL id. An item cannot
 * be present twice, and list membership is not representable — the point.
 */
export type Library = Map<number, LibraryEntry>;


/** The activities payload names the show category `tv_shows`; the sync path uses `shows`. */
const ACTIVITY_CATEGORY: Record<SyncType, keyof Activities> = {
  shows: 'tv_shows',
  anime: 'anime',
  movies: 'movies',
};

const TYPES: SyncType[] = ['shows', 'anime', 'movies'];

/** The statuses an item can hold. `movies` carries no `watching` or `hold`. */
const STATUSES = ['watching', 'plantowatch', 'completed', 'hold', 'dropped'] as const;

/** The named timestamps of every category, joined into one comparable string. */
const signature = (activities: Activities | null | undefined, fields: readonly (keyof CategoryActivity)[]): string =>
  TYPES.map((type) => {
    const source = (activities?.[ACTIVITY_CATEGORY[type]] ?? {}) as CategoryActivity;
    return `${type}:${fields.map((field) => source[field] ?? '').join(',')}`;
  }).join('|');

/**
 * Whether anything worth a pull moved.
 *
 * Not `activities.all`: it rolls up `playback` and `rated_at`, and a
 * scrobbler bumps `playback` continuously, so gating on the roll-up would
 * pull a delta every poll to find nothing the feed or sheet can see. `all` is
 * still what gets *sent* as `date_from` — the trigger and the watermark are
 * different questions.
 */
export const librarySignature = (activities: Activities | null | undefined): string => signature(activities, STATUSES);

/**
 * When each category last had something removed from it.
 *
 * Per category: a removal moves this stamp and nothing else — the item stops
 * existing, so no status timestamp advances and no delta record appears — and
 * *which* category moved is what makes a truncated membership response
 * detectable.
 */
export const removalStamps = (activities: Activities | null | undefined): Record<SyncType, string> =>
  Object.fromEntries(
    TYPES.map((type) => {
      const source = (activities?.[ACTIVITY_CATEGORY[type]] ?? {}) as CategoryActivity;
      return [type, source.removed_from_list ?? ''];
    }),
  ) as Record<SyncType, string>;

/**
 * The watermark to send as `date_from`, from the payload rather than the clock.
 *
 * `activities.all` is the roll-up SIMKL means us to send back. When absent,
 * the newest timestamp in the payload says the same thing — still a server
 * instant, still comparable against the times the items carry. The local
 * clock is neither: it depends on this container agreeing with SIMKL's clock,
 * and if `all` never returns it freezes, so every later delta re-asks for
 * everything since that moment.
 *
 * Null only for a payload with no timestamps at all — a brand-new account,
 * where there is nothing a watermark could miss.
 */
export const watermarkOf = (activities: Activities | null | undefined): string | null => {
  if (activities?.all) return activities.all;
  const stamps = TYPES.flatMap((type) => Object.values((activities?.[ACTIVITY_CATEGORY[type]] ?? {}) as CategoryActivity)).filter(
    (at): at is string => typeof at === 'string' && at.length > 0,
  );
  // ISO instants at a fixed offset, so lexical order is chronological.
  return stamps.length ? stamps.reduce((newest, at) => (at > newest ? at : newest)) : null;
};

/** The categories whose removal stamp has moved since the ones held. */
export const movedRemovals = (
  previous: Record<SyncType, string>,
  current: Record<SyncType, string>,
): Set<SyncType> => new Set(TYPES.filter((type) => previous[type] !== current[type]));

/**
 * The watermark backed off by a second — what `date_from` should ask for.
 *
 * `date_from` is compared strictly greater at one-second granularity: the
 * exact `activities.all` returns nothing at all, and a write committed in the
 * same second just after this poll read it would never be asked for again.
 * Overlapping by a second closes that, at the cost of one re-sent record into
 * an idempotent merge.
 *
 * Returns the input unchanged when it is not a parseable instant: sending
 * back what SIMKL gave is safer than a guess.
 */
export const deltaFrom = (watermark: string | null | undefined): string | null => {
  if (!watermark) return null;
  const at = instantFrom(watermark);
  // `smallestUnit`, not a regex: SIMKL compares `date_from` at one-second
  // granularity, so milliseconds are a precision the endpoint does not have.
  //
  // No `timeZone` option — the default renders `Z`; a named zone would render
  // an offset. This string goes to SIMKL verbatim.
  return at === null ? watermark : at.subtract({ seconds: 1 }).toString({ smallestUnit: 'second' });
};

/** What the poll holds between runs, and compares each new payload against. */
export interface GateState {
  librarySignature: string;
  removalAt: Record<SyncType, string>;
  /** The `activities.all` already merged. Absent means there is nothing to delta from. */
  syncedAll: string | null;
  hasLibrary: boolean;
  /**
   * Set when a membership response would have deleted implausibly much. The
   * full pull is authoritative and settles what the diff could only guess at.
   */
  resyncPending: boolean;
}

/** What one activities payload decided, and what to store once it is acted on. */
export interface GateDecision {
  /** A status timestamp moved — the gate's own answer, before `force`. */
  changed: boolean;
  /** Categories whose `removed_from_list` moved; empty means no reconcile. */
  removedFrom: Set<SyncType>;
  removals: boolean;
  /** Nothing to delta from, or the caller insisted. */
  full: boolean;
  /** Computed here so the branches store what the comparison already derived. */
  signature: string;
  stamps: Record<SyncType, string>;
}

/**
 * Whether this payload is worth a request, and which kind.
 *
 * Pure and separate from the poll: three independent triggers, one of which
 * (`force`) diverges from what the gate observed, and inline it could only be
 * exercised through a fake HTTP layer.
 *
 * `changed` stays the gate's own answer rather than folding into `full`: a
 * forced poll pulls everything while every signature matches, and reporting
 * that as a change would report one that did not happen.
 */
export const evaluateGate = (
  activities: Activities | null | undefined,
  held: GateState,
  { force = false }: { force?: boolean } = {},
): GateDecision => {
  const signature = librarySignature(activities);
  const stamps = removalStamps(activities);
  const removedFrom = movedRemovals(held.removalAt, stamps);
  return {
    changed: held.librarySignature !== signature,
    removedFrom,
    removals: removedFrom.size > 0,
    full: force || !held.hasLibrary || !held.syncedAll || held.resyncPending,
    signature,
    stamps,
  };
};

/** Each item in the response, tagged with the type key it arrived under. */
const entriesOf = function* (response: AllItemsResponse | null | undefined): Generator<[number, SyncType, LibraryItem]> {
  for (const type of TYPES) {
    for (const item of response?.[type] ?? []) {
      const id = itemSimklId(item);
      // An item with no usable id is dropped at the one point it enters the
      // model; everything downstream keys on the id.
      if (id !== null) yield [id, type, item];
    }
  }
};

/** A full pull becomes the library outright — the same upsert, starting from nothing. */
export const toLibrary = (response: AllItemsResponse | null | undefined): Library =>
  mergeDelta(new Map(), response).library;

/**
 * A delta folded into what we already hold.
 *
 * A plain upsert by id: delta records are complete items, not patches — a
 * changed show carries its full `seasons[]` — so there is no field-level
 * merging, and re-merging the same record is a no-op. That idempotence is
 * load-bearing: the poll asks for one second more than it needs and
 * re-receives the newest records by design.
 *
 * Type- and status-blind on purpose. Filtering here — dropping films that
 * come back `completed`, say — would skip the very record that says a film
 * left plan-to-watch, leaving the stale copy and the film in the feed for
 * good. Consumers filter; the merge records what SIMKL said.
 *
 * Returns a new Map, so the orchestrator swaps the library in one assignment
 * and a render holding the old one sees a coherent library, not a half-merged
 * one.
 *
 * `updated` counts every record the delta carried; `reshaped` only those
 * arriving new or under a different `status`. They differ on the most common
 * event there is — watching an episode rewrites a record without moving it —
 * which separates a consumer reading membership from one reading progress.
 * This reports both and decides neither.
 */
export const mergeDelta = (
  previous: Library,
  response: AllItemsResponse | null | undefined,
): { library: Library; updated: number; reshaped: number } => {
  const library: Library = new Map(previous);
  let updated = 0;
  let reshaped = 0;
  for (const [id, type, item] of entriesOf(response)) {
    const before = previous.get(id);
    if (!before || before.type !== type || itemStatus(before.item) !== itemStatus(item)) reshaped += 1;
    library.set(id, { type, item });
    updated += 1;
  }
  return { library, updated, reshaped };
};

/** The ids in a membership response — the whole of what `simkl_ids_only` says. */
export const membershipIds = (response: AllItemsResponse | null | undefined): Set<number> => {
  const ids = new Set<number>();
  for (const [id] of entriesOf(response)) ids.add(id);
  return ids;
};

/**
 * Drop everything the membership set no longer names, within the categories
 * that reported a removal.
 *
 * `within` is the only discriminator there is. An empty category is *omitted*
 * from the response rather than sent empty, so a truncated payload and a
 * category the user emptied are the same bytes. `removed_from_list` separates
 * them: emptying a category moves its stamp; a truncated response moves
 * nothing. A category with no reported removal is left alone entirely.
 *
 * Within one that did report, dropping more than half of what is held is
 * refused — the stamp says *something* went, not everything, and applying a
 * partial payload there empties the feed of that type.
 *
 * Refusing is cheap: the caller answers with a full pull, which is
 * authoritative. That keeps the half threshold safe even for a category
 * holding two items, where the proportion means little — the full pull tells
 * the cases apart instead of a rule that cannot.
 *
 * The refusal lives in the only function that deletes, so no caller reaches
 * the delete without it. Reporting `applied` rather than acting on it keeps
 * what happens next — the log line, the re-pull — in the shell.
 *
 * The same Map comes back when nothing goes, so a quiet reconcile does not
 * churn the library or force a re-render.
 */
export const retainOnly = (
  library: Library,
  keep: Set<number>,
  within: Set<SyncType>,
): { library: Library; removed: number; applied: boolean } => {
  const gone: number[] = [];
  const held = new Map<SyncType, number>();
  const going = new Map<SyncType, number>();
  for (const [id, entry] of library) {
    if (!within.has(entry.type)) continue;
    held.set(entry.type, (held.get(entry.type) ?? 0) + 1);
    if (keep.has(id)) continue;
    going.set(entry.type, (going.get(entry.type) ?? 0) + 1);
    gone.push(id);
  }

  for (const [type, count] of held) {
    if ((going.get(type) ?? 0) > count / 2) return { library, removed: 0, applied: false };
  }
  if (!gone.length) return { library, removed: 0, applied: true };

  const next: Library = new Map(library);
  for (const id of gone) next.delete(id);
  return { library: next, removed: gone.length, applied: true };
};

