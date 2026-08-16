/**
 * Bounded-concurrency per-title lookups, with one copy of the failure rule.
 *
 * Both per-title sources — film release dates and show catalogues — walk a list
 * of ids calling a CDN-cached, unauthenticated endpoint, and both need exactly
 * the same three-way split of an error: one missing title must not sink the
 * run, an id SIMKL says is gone must not hold it back either, and an
 * account-level problem is not a fact about this title at all and has to escape.
 *
 * That last clause is the one worth centralising. Two copies of it drift, and
 * the drift is silent: a 401 filed as "this film is unavailable" makes an
 * expired token look like a hundred deleted titles.
 *
 * Modest parallelism is safe here and nowhere else in `simkl/`: these endpoints
 * are Cloudflare-cached by id, unlike the sync endpoints, which must stay
 * sequential.
 */

import { classify } from './client.ts';

export interface PoolFailures {
  /** Ids whose lookup errored in a way worth retrying — the run is incomplete. */
  failed: number[];
  /** Ids SIMKL says are gone. Retrying never helps, so these must not hold the run back. */
  unavailable: number[];
}

/**
 * Run `lookup` over `items` with at most `concurrency` in flight, collecting
 * results wherever the caller wants them and returning only the failures.
 *
 * The caller keeps its own accumulator on purpose: what a lookup produces
 * differs (a release, or an episode list *and* a detail), and threading that
 * through a generic return type would cost more than it saves.
 */
export const lookupPool = async <T>(
  items: T[],
  idOf: (item: T) => number,
  lookup: (item: T) => Promise<void>,
  { concurrency = 4 }: { concurrency?: number } = {},
): Promise<PoolFailures> => {
  const queue = [...items];
  const failed: number[] = [];
  const unavailable: number[] = [];

  const worker = async (): Promise<void> => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) return;
      try {
        await lookup(item);
      } catch (err) {
        const kind = classify(err);
        if (kind === 'account') throw err;
        (kind === 'gone' ? unavailable : failed).push(idOf(item));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { failed, unavailable };
};
