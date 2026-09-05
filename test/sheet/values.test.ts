import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTWORK_HOST,
  artworkKeyFor,
  artworkKeyOf,
  artworkLink,
  dateSerial,
  plausibleRuntimeDays,
  runtimeDays,
  watchSerial,
} from '../../src/sheet/values.ts';
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

// --- Artwork links -----------------------------------------------------------

const BUCKET = 'hanikazmi_plotdevice_show';

// The show tab's formula is `prefix & Name`, so the link for an ordinary title
// must be byte-identical to what that formula produces: spaces and slashes
// literal, nothing else touched.
test('a link is the prefix plus the key verbatim, as the formula cells produce it', () => {
  assert.equal(artworkLink(BUCKET, 'Finding Nemo'), `${ARTWORK_HOST}/${BUCKET}/Finding Nemo`);
  assert.equal(artworkLink(BUCKET, 'Fate/Apocrypha'), `${ARTWORK_HOST}/${BUCKET}/Fate/Apocrypha`);
  assert.equal(artworkLink(BUCKET, 'Pokémon: Mewtwo Returns'), `${ARTWORK_HOST}/${BUCKET}/Pokémon: Mewtwo Returns`);
});

// The three characters that cannot survive literally in a path: `#` and `?`
// end it, `%` starts an escape.
test('a link escapes only the characters a URL parser would consume', () => {
  assert.equal(artworkLink(BUCKET, '3%'), `${ARTWORK_HOST}/${BUCKET}/3%25`);
  assert.equal(artworkLink(BUCKET, 'What If...?'), `${ARTWORK_HOST}/${BUCKET}/What If...%3F`);
  assert.equal(artworkLink(BUCKET, 'Show #1'), `${ARTWORK_HOST}/${BUCKET}/Show %231`);
});

test('a key is the title exactly, with nothing normalised', () => {
  assert.equal(artworkKeyFor(' Trailing '), ' Trailing ');
  // Composed and decomposed forms are different keys — the bucket keys on
  // bytes, and so must this.
  assert.notEqual(artworkKeyFor('Pokémon'), artworkKeyFor('Pokémon'));
});

test('the key round-trips through the link, for the formula and the hand-written cells alike', () => {
  for (const key of ['Finding Nemo', '3%', 'Fate/Apocrypha', 'What If...?', 'Pokémon: Mewtwo Returns', 'Aquarian Evol']) {
    assert.equal(artworkKeyOf(artworkLink(BUCKET, key), BUCKET), key, key);
  }
  // A hand-written cell that percent-encodes more than the link would.
  assert.equal(artworkKeyOf(`${ARTWORK_HOST}/${BUCKET}/Fate%20Apocrypha`, BUCKET), 'Fate Apocrypha');
  assert.equal(artworkKeyOf(`${ARTWORK_HOST}/${BUCKET}/Inside%20No%209`, BUCKET), 'Inside No 9');
});

test('a link on another host, another bucket, or with no key is not this bucket\'s', () => {
  assert.equal(artworkKeyOf(`${ARTWORK_HOST}/hanikazmi_plotdevice_movie/Finding Nemo`, BUCKET), null);
  assert.equal(artworkKeyOf('https://image.tmdb.org/t/p/w1280/abc.jpg', BUCKET), null);
  assert.equal(artworkKeyOf(`${ARTWORK_HOST}/${BUCKET}/`, BUCKET), null);
  assert.equal(artworkKeyOf(`${ARTWORK_HOST}/${BUCKET}`, BUCKET), null);
  assert.equal(artworkKeyOf(`${ARTWORK_HOST}/${BUCKET}_other/x`, BUCKET), null);
  assert.equal(artworkKeyOf('', BUCKET), null);
  assert.equal(artworkKeyOf(null, BUCKET), null);
});

// A `=CONCAT` over `3%` yields a remainder no key can be recovered from;
// answering null rather than throwing is what lets the page report the row.
test('a remainder that does not percent-decode answers null', () => {
  assert.equal(artworkKeyOf(`${ARTWORK_HOST}/${BUCKET}/3%`, BUCKET), null);
  assert.equal(artworkKeyOf(`${ARTWORK_HOST}/${BUCKET}/100%zz`, BUCKET), null);
});
