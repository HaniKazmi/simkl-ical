/**
 * Bounded-concurrency per-item lookups, with one copy of the failure rule.
 *
 * Every per-item source here — film details, show catalogues, season runtimes,
 * a series' genres and certificate — walks a list calling a per-item endpoint,
 * and all of them need the same three-way split: a missing item must not sink
 * the run, one the upstream says is gone must not hold it back, and an
 * account-level problem is not a fact about the item and has to escape.
 *
 * The last clause is why this is centralised. Copies drift silently: a 401
 * filed as "this film is unavailable" makes an expired token look like a
 * hundred deleted titles.
 *
 * Two shapes of caller, which is why there are two entry points. Most produce
 * exactly one payload per SIMKL id, and `keyedLookup` accumulates that for
 * them. `lookupPool` is for the rest, where the key is not the item's id
 * (`io/runtimes.ts` keys a season by TVDB id and number) or one call fills
 * more than one map (`io/catalogue.ts` splits episodes from details), and a
 * generic accumulator would cost more than it saves.
 *
 * Sits above `simkl/` because the split is shared and the status mapping is
 * not — each upstream passes its own `classify`.
 *
 * Modest parallelism is safe for every caller here and nowhere else in
 * `simkl/`: these endpoints are cached per item; the sync endpoints must stay
 * sequential.
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
 * Run `lookup` over `items` with at most `concurrency` in flight, returning
 * only the failures. The caller keeps its own accumulator; `keyedLookup` below
 * is the one to reach for where that accumulator is a map keyed by the item's
 * own id.
 *
 * `classify` is required, not defaulted. A 404 is `gone` everywhere, but which
 * status means "the credential is wrong" is not shared, and a default would
 * silently apply one upstream's reading to another's errors.
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

/**
 * `lookupPool` where one item answers with one payload, keyed by the item's
 * own `id` — the SIMKL id every caller here folds the answer back onto.
 *
 * Requests are merged by id before anything is fetched, so a title asked about
 * twice in one batch costs one call — a live-action title emits two catalogue
 * records, and a planning pass can ask about one series from two rules. That
 * merge is the other reason this is shared: a caller that forgot it spends an
 * upstream's rate limit on answers it already has.
 *
 * An **absent** key is a lookup that has not answered — a failure of either
 * kind — which every caller reads as "not settled yet" and leaves the row
 * alone on. Only `unavailable` says the upstream answered that there is
 * nothing to have.
 */
export const keyedLookup = async <R extends { id: number }, T>(
  requests: R[],
  fetchOne: (request: R) => Promise<T>,
  { concurrency = 4, classify }: { concurrency?: number; classify: (err: unknown) => FailureKind },
): Promise<{ answers: Map<number, T> } & PoolFailures<number>> => {
  const merged = new Map<number, R>();
  for (const request of requests) merged.set(request.id, request);

  const answers = new Map<number, T>();
  const failures = await lookupPool<R, number>(
    [...merged.values()],
    (request) => request.id,
    async (request) => {
      answers.set(request.id, await fetchOne(request));
    },
    { concurrency, classify },
  );

  return { answers, ...failures };
};
