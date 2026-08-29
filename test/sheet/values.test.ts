import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateSerial, plausibleRuntimeDays, runtimeDays, watchSerial } from '../../src/sheet/values.ts';
import { instantFrom, plainDateFrom } from '../../src/shared/dates.ts';

test('a date serial counts days from the sheet epoch', () => {
  assert.equal(dateSerial(plainDateFrom('1899-12-30')), 0);
  assert.equal(dateSerial(plainDateFrom('1900-01-01')), 2);
  assert.equal(dateSerial(plainDateFrom('2026-08-15')), 46249);
});

// The highest-risk conversion in the project: iso.slice(0, 10) is wrong for any
// US evening broadcast, which is stamped the following day in UTC.
test('a late-evening watch lands on the local date, not the UTC one', () => {
  assert.equal(watchSerial(instantFrom('2026-08-14T23:54:25Z'), 'Europe/London'), dateSerial(plainDateFrom('2026-08-15')));
  assert.equal(watchSerial(instantFrom('2026-08-15T02:54:25Z'), 'America/New_York'), dateSerial(plainDateFrom('2026-08-14')));
});

// The parse is the step that can fail, so it answers null; the conversion
// after it is total. The planner never throws, so an unusable timestamp costs
// that episode's date, not the run.
test('an unusable timestamp is refused at the parse, and never reaches the serial', () => {
  for (const bad of ['not a date', '', '2026', 'March 5', null, undefined]) {
    assert.equal(instantFrom(bad), null, `${bad} should not parse`);
    assert.equal(watchSerial(instantFrom(bad), 'Europe/London'), null);
  }
});

// SIMKL occasionally emits a space where the T belongs, and Date.parse on that
// is implementation-defined.
test('a space-separated timestamp is normalised rather than rejected', () => {
  assert.equal(instantFrom('2026-08-14 21:03:12Z')?.toString(), '2026-08-14T21:03:12Z');
  assert.equal(watchSerial(instantFrom('2026-08-14 21:03:12Z'), 'Europe/London'), dateSerial(plainDateFrom('2026-08-14')));
});

test('a runtime in minutes becomes the day fraction the sheet holds', () => {
  assert.ok(Math.abs((runtimeDays(41) ?? 0) - 0.0284722) < 1e-6);
  assert.equal(runtimeDays(0), null);
  assert.equal(runtimeDays(null), null);
});

// The guard refuses out-of-bounds fractions too, and refusal is whole-plan —
// one title with bad upstream data would stop every unrelated edit. Bounded
// here, it costs one cell.
test('a length no episode has yields no cell rather than a refused plan', () => {
  assert.equal(runtimeDays(1440), null, 'a full day is not a runtime');
  assert.equal(runtimeDays(0.9), null, 'and under a minute is not one either');
  assert.ok(runtimeDays(1), 'a whole minute is the smallest that is');
  assert.equal(runtimeDays(5000), null);
  assert.equal(runtimeDays(1439), 1439 / 1440);
});

// The planner's conversion and the guard's bound are the same numbers in the
// same file, so a value one emits and the other refuses is unrepresentable —
// asserted anyway, because whole-plan-refusal safety rests on the identity.
test('every day fraction the conversion produces is one the guard accepts', () => {
  for (const minutes of [1, 22, 41, 61.5, 1439]) {
    assert.ok(plausibleRuntimeDays(runtimeDays(minutes) ?? undefined), `${minutes} minutes should round-trip`);
  }
  assert.equal(plausibleRuntimeDays(undefined), false);
  assert.equal(plausibleRuntimeDays(1), false, 'a whole day is minutes in the wrong column');
  assert.equal(plausibleRuntimeDays(0.4 / 1440), false, 'under half a minute renders as nothing');
});
