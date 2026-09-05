/**
 * The one lock over the spreadsheet: a sync run and an artwork page write
 * never overlap.
 *
 * The sync's protocol is read → plan → write → verify → rollback, and the
 * films verifier inspects every column but `id` — `Banner` included. A page
 * write landing between the sync's read and its verify is a cell the sync
 * did not plan and cannot recognise, so VERIFY rolls the whole tab back to the
 * snapshot, taking the page's write with it and refusing the sync's own. The
 * lock makes that interleaving unrepresentable: a holder has the sheet from
 * its first read to its last verify.
 *
 * Process-local, which is all there is: one process owns the credential.
 * A holder that throws still releases, and a waiter that gives up leaves the
 * chain intact for the holders behind it.
 */

/** Thrown to a waiter whose wait ran out; the holder is unaffected. */
export class SheetBusyError extends Error {
  constructor() {
    super('the spreadsheet is busy: a sync run or a page write holds it');
    this.name = 'SheetBusyError';
  }
}

/** Resolves when every earlier holder has released. Never rejects. */
let tail: Promise<void> = Promise.resolve();

/** How many holders and waiters are ahead of a new arrival. Observational. */
let queued = 0;

/**
 * Run `fn` holding the lock. With `wait` set, a caller that has not acquired
 * it inside that span throws `SheetBusyError` instead — the page's choice, so
 * a pick answers "try again" rather than stalling behind a sync run that may
 * be waiting on an upstream. Without it the caller waits as long as it takes,
 * which is the sync's choice: it runs on a timer and has nowhere better to be.
 */
export const withSheetLock = async <T>(fn: () => Promise<T>, { wait }: { wait?: Temporal.Duration } = {}): Promise<T> => {
  const previous = tail;
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Chained behind `previous` rather than replacing it, so a waiter that
  // gives up can release its own slot without letting anyone past the
  // holders still ahead of it.
  tail = previous.then(() => mine);
  queued += 1;

  if (wait) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), wait.total({ unit: 'millisecond' }));
    });
    try {
      if ((await Promise.race([previous.then(() => 'acquired' as const), expiry])) === 'expired') {
        queued -= 1;
        release();
        throw new SheetBusyError();
      }
    } finally {
      clearTimeout(timer);
    }
  } else {
    await previous;
  }

  try {
    return await fn();
  } finally {
    queued -= 1;
    release();
  }
};

/** Whether anything holds or is waiting for the lock right now. */
export const sheetLockBusy = (): boolean => queued > 0;
