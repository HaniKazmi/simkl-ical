import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SheetBusyError, sheetLockBusy, withSheetLock } from '../../../src/sheet/io/lock.ts';

/** A promise the test resolves by hand, to hold the lock for exactly as long as it wants. */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a second holder runs only after the first has released', async () => {
  const order: string[] = [];
  const first = gate();
  const a = withSheetLock(async () => {
    order.push('a:start');
    await first.opened;
    order.push('a:end');
  });
  const b = withSheetLock(async () => {
    order.push('b');
  });
  await tick();
  assert.deepEqual(order, ['a:start']);
  assert.ok(sheetLockBusy());
  first.open();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b']);
  assert.equal(sheetLockBusy(), false);
});

test('a holder that throws still releases', async () => {
  await assert.rejects(
    withSheetLock(async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await withSheetLock(async () => 'next'), 'next');
});

test('a bounded wait gives up with SheetBusyError and leaves the holder undisturbed', async () => {
  const held = gate();
  let holderDone = false;
  const holder = withSheetLock(async () => {
    await held.opened;
    holderDone = true;
    return 'held';
  });
  await tick();
  await assert.rejects(withSheetLock(async () => 'never', { wait: Temporal.Duration.from({ milliseconds: 5 }) }), SheetBusyError);
  assert.equal(holderDone, false);
  held.open();
  assert.equal(await holder, 'held');
  assert.equal(holderDone, true);
});

// The waiter that gave up sat in the chain between the holder and a later
// arrival; its slot releasing must not let that later arrival past the holder.
test('a waiter giving up does not let the one behind it jump the holder', async () => {
  const order: string[] = [];
  const held = gate();
  const holder = withSheetLock(async () => {
    await held.opened;
    order.push('holder');
  });
  await tick();
  const gaveUp = withSheetLock(async () => order.push('gave-up'), { wait: Temporal.Duration.from({ milliseconds: 5 }) });
  const patient = withSheetLock(async () => order.push('patient'));
  await assert.rejects(gaveUp, SheetBusyError);
  assert.deepEqual(order, []);
  held.open();
  await Promise.all([holder, patient]);
  assert.deepEqual(order, ['holder', 'patient']);
});

test('a bounded wait that is met runs normally', async () => {
  assert.equal(await withSheetLock(async () => 'ran', { wait: Temporal.Duration.from({ seconds: 1 }) }), 'ran');
});
