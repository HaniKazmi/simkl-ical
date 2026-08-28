/**
 * Bounded-concurrency per-item lookups, with one copy of the failure rule.
 *
 * Three per-item sources — film release dates, show catalogues and season
 * runtimes — walk a list calling a per-item endpoint, and all three need exactly
 * the same three-way split of an error: one missing item must not sink the run,
 * one the upstream says is gone must not hold it back either, and an
 * account-level problem is not a fact about that item at all and has to escape.
 *
 * That last clause is the one worth centralising. Copies of it drift, and the
 * drift is silent: a 401 filed as "this film is unavailable" makes an expired
 * token look like a hundred deleted titles.
 *
 * Sits above `simkl/` rather than inside it because the split is the shared
 * rule while the status mapping is not — each upstream passes its own
 * `classify`. Defaulting it to SIMKL's would couple this file to one of them.
 *
 * Modest parallelism is safe for every caller here and nowhere else in
 * `simkl/`: these endpoints are cached per item, unlike the sync endpoints,
 * which must stay sequential.
 */

/**
 * How a caller should treat a failure the transport could not retry away.
 *
 * - `account`: a rejected credential, not a fact about the item; callers doing
 *   per-item work must let it propagate.
 * - `gone`: settled. Retrying never starts working.
 * - `transient`: worth trying again later.
 */
export type FailureKind = 'account' | 'gone' | 'transient';

export interface PoolFailures<K> {
  /** Keys whose lookup errored in a way worth retrying — the run is incomplete. */
  failed: K[];
  /** Keys the upstream says are gone. Retrying never helps, so these must not hold the run back. */
  unavailable: K[];
}

/**
 * Run `lookup` over `items` with at most `concurrency` in flight, collecting
 * results wherever the caller wants them and returning only the failures.
 *
 * The caller keeps its own accumulator on purpose: what a lookup produces
 * differs (a release, an episode list *and* a detail, a season's runtimes), and
 * threading that through a generic return type would cost more than it saves.
 *
 * `classify` is required rather than defaulted. Each upstream maps its own
 * statuses — a 404 is `gone` everywhere, but which status means "the credential
 * is wrong" is not shared — and a default would silently apply one upstream's
 * reading to another's errors.
 */
export const lookupPool = async <T, K = number>(
  items: T[],
  idOf: (item: T) => K,
  lookup: (item: T) => Promise<void>,
  { concurrency = 4, classify }: { concurrency?: number; classify: (err: unknown) => FailureKind },
): Promise<PoolFailures<K>> => {
  const queue = [...items];
  const failed: K[] = [];
  const unavailable: K[] = [];

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
