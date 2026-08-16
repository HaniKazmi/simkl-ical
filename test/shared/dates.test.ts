import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instantFrom, plainDateFrom, plainDateIn } from '../../src/shared/dates.ts';

// --- instantFrom -----------------------------------------------------------

test('an ISO instant parses', () => {
  assert.equal(instantFrom('2026-08-14T02:30:00Z')?.toString(), '2026-08-14T02:30:00Z');
});

// The whole reason for routing every parse through here. `Date.parse` accepts
// all three of these and yields a plausible-looking instant, so a validation
// gate built on it admits exactly what it means to reject.
test('what Date.parse would wave through is refused', () => {
  for (const lenient of ['2026', 'March 5', 'Dec 25 1995', 'not a date']) {
    assert.ok(Number.isFinite(Date.parse(lenient)) || lenient === 'not a date', `precondition: Date.parse tolerates ${lenient}`);
    assert.equal(instantFrom(lenient), null, `${lenient} should not parse as an instant`);
  }
});

// A known upstream quirk rather than a malformed value: rejecting it would drop
// real watch history.
test("SIMKL's space where the T belongs is repaired", () => {
  assert.equal(instantFrom('2026-08-14 21:03:12Z')?.toString(), '2026-08-14T21:03:12Z');
});

test('absent, blank and non-string values are null rather than a throw', () => {
  for (const empty of [null, undefined, '', '   ', 42 as unknown as string]) {
    assert.equal(instantFrom(empty), null);
  }
});

// --- plainDateFrom ---------------------------------------------------------

test('a calendar date parses', () => {
  assert.equal(plainDateFrom('2026-08-14').toString(), '2026-08-14');
});

// A shifted event is worse than a skipped one: it announces a day nobody
// published. The ISO grammar is what refuses these — `overflow` governs property
// bags, not strings, so there is no option here to get wrong.
test('a date that does not exist is refused, not shifted onto a real one', () => {
  for (const impossible of ['2026-02-30', '2026-13-01', '2026-02-29']) {
    assert.throws(() => plainDateFrom(impossible), RangeError, `${impossible} should not parse`);
  }
});

test('a malformed date throws rather than returning something', () => {
  for (const bad of ['2026-8-1', 'not a date', '2026']) {
    assert.throws(() => plainDateFrom(bad), RangeError, `${bad} should not parse`);
  }
});

// --- plainDateIn -----------------------------------------------------------

// The conversion the project's comments keep warning about. Slicing the ISO
// string gives the 14th; the instant falls on the 13th in New York, and this is
// every US evening broadcast.
test('an instant lands on the local calendar date, not the UTC one', () => {
  const at = instantFrom('2026-08-14T02:30:00Z')!;
  assert.equal(plainDateIn(at, 'America/New_York').toString(), '2026-08-13');
  assert.equal(plainDateIn(at, 'UTC').toString(), '2026-08-14');
  assert.equal('2026-08-14T02:30:00Z'.slice(0, 10), '2026-08-14', 'what the slice would have said');
});

test('the zone is applied rather than the offset assumed', () => {
  const at = instantFrom('2026-08-14T23:30:00Z')!;
  assert.equal(plainDateIn(at, 'Europe/London').toString(), '2026-08-15', 'BST puts it past midnight');
  assert.equal(plainDateIn(at, 'America/Los_Angeles').toString(), '2026-08-14');
});

// --- the Duration constraint -----------------------------------------------

/**
 * Every span in this codebase is a `Temporal.Duration` built only from days and
 * below, and that restriction is load-bearing rather than stylistic: `compare`,
 * `total` and `round` need a `relativeTo` anchor exactly when years, months or
 * weeks are involved, because those have no fixed length. Below that a day is
 * exactly 24 hours and the operations are total.
 *
 * Asserted here because it is the assumption the vocabulary rests on, and it
 * cannot be read off the type signatures — `relativeTo` is optional in all of
 * them.
 */
test('days and below need no relativeTo anchor', () => {
  const span = Temporal.Duration.from({ days: 1, hours: 2, minutes: 3, seconds: 4, milliseconds: 5 });
  assert.equal(Temporal.Duration.compare(span, { hours: 1 }), 1);
  assert.equal(span.round({ largestUnit: 'day', smallestUnit: 'second' }).toString(), 'P1DT2H3M4S');
  assert.equal(Temporal.Duration.from({ days: 1 }).total('hours'), 24, 'a day is exactly 24 hours');
});

// The prohibition is a rule rather than a preference because this is what
// breaking it costs: a throw from a comparison that reads as total.
test('months without an anchor throw, which is why they are never constructed', () => {
  assert.throws(() => Temporal.Duration.compare(Temporal.Duration.from({ months: 1 }), { days: 1 }), RangeError);
});

// `sheetSinceDays` is an exact span today (`sinceDays * MS_PER_DAY`), and the
// recency window it drives must not start drifting by an hour twice a year.
test('a day-based span stays exact, so the sheet cutoff does not drift with DST', () => {
  assert.equal(Temporal.Duration.from({ days: 90 }).total('milliseconds'), 90 * 86_400_000);
});
