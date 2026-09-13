import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTWORK_HOST,
  SHOW_TYPE,
  artworkFormula,
  artworkKeyFor,
  artworkKeyOf,
  artworkLink,
  blockEnd,
  blockFranchise,
  compareFranchise,
  dateSerial,
  franchiseKeyFor,
  isGenre,
  isStatus,
  mappedTvdbGenres,
  networkCell,
  placeBlock,
  plausibleRuntime,
  runtimeMinutes,
  serialDate,
  showRowFormulas,
  titleCell,
  titleKey,
  watchSerial,
} from '../../src/sheet/values.ts';
import { HEADERS, SHOW_LABELS } from '../../src/sheet/2-grid.ts';
import { SHEET_COLUMNS, SHEET_HEADERS, col } from '../helpers.ts';
import { instantFrom, plainDateFrom } from '../../src/shared/dates.ts';
import type { ColumnMap, ShowBlock } from '../../src/sheet/2-grid.ts';
import type { PlaceableBlock } from '../../src/sheet/values.ts';

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

test('a runtime rounds to the nearest whole minute the cell holds', () => {
  assert.equal(runtimeMinutes(41), 41);
  assert.equal(runtimeMinutes(41.4), 41);
  assert.equal(runtimeMinutes(41.6), 42);
  assert.equal(runtimeMinutes(null), null);
});

// The guard refuses an out-of-bounds figure too, and refusal is whole-plan —
// one title with bad upstream data would stop every unrelated edit. Bounded
// here, it costs one cell.
test('a length no episode has yields no cell rather than a refused plan', () => {
  assert.equal(runtimeMinutes(1440), null, 'a full day is not a runtime');
  assert.equal(runtimeMinutes(0), null, 'and nothing is not one either');
  assert.equal(runtimeMinutes(0.9), null, 'under a minute is refused on the raw figure, never rounded up to one');
  assert.equal(runtimeMinutes(1), 1, 'a whole minute is the smallest that is');
  assert.equal(runtimeMinutes(-5), null);
  assert.equal(runtimeMinutes(1439), 1439);
});

// A fraction of a day is refused outright: the column holds whole minutes, so
// `49/1440` (49 minutes, as a day fraction) is not a value this column can
// mean.
test('plausibleRuntime accepts whole minutes only, never a day fraction', () => {
  assert.equal(plausibleRuntime(49 / 1440), false);
  assert.equal(plausibleRuntime(1), true);
  assert.equal(plausibleRuntime(1439), true);
  assert.equal(plausibleRuntime(0), false);
  assert.equal(plausibleRuntime(1440), false);
  assert.equal(plausibleRuntime(-1), false);
  assert.equal(plausibleRuntime(1.5), false);
});

// The planner's conversion and the guard's bound are the same numbers in the
// same file, so a value one emits and the other refuses is unrepresentable —
// asserted anyway, because whole-plan-refusal safety rests on the identity.
test('every whole minute the conversion produces is one the guard accepts', () => {
  for (const minutes of [1, 22, 41, 62, 1439]) {
    assert.ok(plausibleRuntime(runtimeMinutes(minutes) ?? -1), `${minutes} minutes should round-trip`);
  }
  assert.equal(plausibleRuntime(1440), false, 'a full day is minutes in the wrong column');
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

test('a serial round-trips to the date it stands for', () => {
  assert.equal(serialDate(46249)?.toString(), '2026-08-15');
  assert.equal(serialDate(0)?.toString(), '1899-12-30');
  assert.equal(serialDate(46249.5)?.toString(), '2026-08-15');
  assert.equal(serialDate(null), null);
  assert.equal(serialDate(Number.NaN), null);
});

// A pasted epoch-millisecond timestamp is a serial of 1.7e12, past what a
// calendar date can stand for; the cell the sync leaves alone must not be
// able to take a page down.
test('a serial no date can stand for answers null rather than throwing', () => {
  assert.equal(serialDate(1.7e12), null);
  assert.equal(serialDate(1e9), null);
  assert.equal(serialDate(-1e9), null);
  assert.equal(serialDate(46249)?.toString(), '2026-08-15');
});

// --- The show row a block insert writes --------------------------------------

// One shape on all 309 blocks, and the shape the fixture's show rows already
// carry: what a new block writes has to be byte-identical to what the rows
// above it hold, or the roll-ups disagree about how they count.
test('the five roll-ups are the text the live show rows carry', () => {
  assert.deepEqual(showRowFormulas(SHEET_COLUMNS, 1), {
    Season: '=IF($O2=0,"",OFFSET($I2,$O2,0))',
    Episode: '=IF($O2=0,"",SUM(OFFSET($K2,1,0,$O2)))',
    Start: '=IF($O2=0,"",LET(r,OFFSET($M2,1,0,$O2),IF(COUNT(r)=0,"",MIN(r))))',
    End: '=IF($O2=0,"",LET(r,OFFSET($N2,1,0,$O2),IF(COUNT(r)=0,"",MAX(r))))',
    Note: '=IFERROR(MATCH("*",OFFSET($A2,1,0,40),0)-1,COUNTA(OFFSET($I2,1,0,40)))',
  });
});

test('the A1 number is the row, one-based', () => {
  assert.equal(showRowFormulas(SHEET_COLUMNS, 0).Season, '=IF($O1=0,"",OFFSET($I1,$O1,0))');
  assert.equal(showRowFormulas(SHEET_COLUMNS, 1105).Season, '=IF($O1106=0,"",OFFSET($I1106,$O1106,0))');
});

// Columns are resolved by label and the user rearranges them. A hardcoded `$O`
// would keep counting the block's height off whatever column now sits there,
// and every roll-up on the row would be wrong for the life of the row.
test('a shuffled header order re-letters every reference', () => {
  const shuffled = [
    'Seasons / Last Watched',
    'Season',
    'Title',
    'Episodes',
    'Start Date',
    'End Date',
    'Franchise',
    'Genre',
    'Other Genres',
    'Network',
    'Certificate',
    'Type',
    'Status',
    'Subtitle',
    'Episode Length (min)',
    'ID',
    'Artwork',
  ];
  const columns = Object.fromEntries(HEADERS.map((name) => [name, col(shuffled, SHOW_LABELS[name])])) as ColumnMap;
  const formulas = showRowFormulas(columns, 1);
  assert.deepEqual(formulas, {
    Season: '=IF($A2=0,"",OFFSET($B2,$A2,0))',
    Episode: '=IF($A2=0,"",SUM(OFFSET($D2,1,0,$A2)))',
    Start: '=IF($A2=0,"",LET(r,OFFSET($E2,1,0,$A2),IF(COUNT(r)=0,"",MIN(r))))',
    End: '=IF($A2=0,"",LET(r,OFFSET($F2,1,0,$A2),IF(COUNT(r)=0,"",MAX(r))))',
    Note: '=IFERROR(MATCH("*",OFFSET($C2,1,0,40),0)-1,COUNTA(OFFSET($B2,1,0,40)))',
  });
});

test('the artwork formula concatenates the bucket prefix with the title cell beside it', () => {
  assert.equal(artworkFormula(col(SHEET_HEADERS, 'Title'), 4, BUCKET), `=CONCAT("${ARTWORK_HOST}/${BUCKET}/",A5)`);
  assert.equal(artworkFormula(col(SHEET_HEADERS, 'Title'), 4, BUCKET), '=CONCAT("https://storage.googleapis.com/hanikazmi_plotdevice_show/",A5)');
});

// The reference is to whatever column the title is in, not to a literal A.
test('the artwork formula points at the title column, wherever it sits', () => {
  assert.equal(artworkFormula(2, 0, BUCKET), `=CONCAT("${ARTWORK_HOST}/${BUCKET}/",C1)`);
});

// `Cancelled` is never produced by `deriveStatus` and is still in the
// vocabulary: the tab holds it, and a guard that refused it would refuse a row
// a reader set by hand.
test('the status vocabulary is the five values the tab holds', () => {
  for (const status of ['Ended', 'Abandoned', 'Cancelled', 'Up To Date', 'Watching']) assert.ok(isStatus(status), status);
  assert.equal(isStatus('Completed'), false);
  assert.equal(isStatus('watching'), false, 'the column is title-cased');
  assert.equal(isStatus(''), false);
});

test('a series is typed in the lowercase the tab uses', () => {
  assert.equal(SHOW_TYPE, 'show');
});

// --- Where a block goes ------------------------------------------------------

test('a leading article is not part of the franchise', () => {
  assert.equal(franchiseKeyFor('The Bear'), 'Bear');
  assert.equal(franchiseKeyFor('A Discovery of Witches'), 'Discovery of Witches');
  assert.equal(franchiseKeyFor('An Idiot Abroad'), 'Idiot Abroad');
  assert.equal(franchiseKeyFor('the wire'), 'wire');
});

// The article has to be a whole word, or every title starting with those
// letters loses them.
test('a word that merely starts with an article keeps it', () => {
  assert.equal(franchiseKeyFor('Theodore'), 'Theodore');
  assert.equal(franchiseKeyFor('Andor'), 'Andor');
  assert.equal(franchiseKeyFor('Alone'), 'Alone');
});

test('only the first article goes', () => {
  assert.equal(franchiseKeyFor('The A Team'), 'A Team');
});

test('a remake marker is not part of the title the tab holds', () => {
  assert.equal(titleCell('The Office (US)'), 'The Office');
  assert.equal(titleCell('Skins (UK)'), 'Skins');
});

// A rule loose enough to strip a parenthesised year would take this one too,
// and the tab holds it verbatim.
test('a parenthesised year is part of the title', () => {
  assert.equal(titleCell('V (2009)'), 'V (2009)');
  assert.equal(titleCell('Doctor Who (2005)'), 'Doctor Who (2005)');
  assert.equal(titleCell('The Office (us)'), 'The Office (us)', 'the marker is spelled in capitals');
});

// `sensitivity: 'base'` alone puts `13 Reasons Why` first; `numeric` is what
// reads the leading digits as numbers and settles it, and all 309 blocks are
// in order under the pair.
test('numbers in a franchise sort as numbers', () => {
  assert.ok(compareFranchise('3%', '13 Reasons Why') < 0);
  assert.ok(compareFranchise('13 Reasons Why', '3%') > 0);
});

test('two franchises differing only in case are the same franchise', () => {
  assert.equal(compareFranchise('the bear', 'The Bear'), 0);
  assert.equal(compareFranchise('SEVERANCE', 'Severance'), 0);
});

// The tab's titles differ from SIMKL's by an article, a `(US)` suffix and
// casing; a hand-typed block has to hold the upstream title back rather than
// be duplicated beside it.
test('a title the tab spells differently is still the same title', () => {
  assert.equal(titleKey('Last Of Us'), titleKey('The Last of Us'));
  assert.equal(titleKey('The Office (US)'), titleKey('office'));
  assert.notEqual(titleKey('The Bear'), titleKey('The Bears'));
});

// The structural type exists so placement can be re-derived from less than a
// parsed block; a `ShowBlock` still has to satisfy it, or the planner and the
// guard would be re-deriving over two different shapes. Written as a call
// rather than a type alias so `tsc` checks the assignment.
test('a parsed block is something placement can be asked about', () => {
  const parsed = { row: 3, title: 'The Bear', status: 'Watching', type: 'show', ids: [1], seasons: [{ row: 4 }] } as ShowBlock;
  assert.equal(blockFranchise(parsed), 'Bear');
  assert.equal(blockEnd(parsed), 4);
});

const block = (row: number, title: string, seasons: number, franchise?: string | null): PlaceableBlock => ({
  row,
  title,
  ...(franchise === undefined ? {} : { franchise }),
  seasons: Array.from({ length: seasons }, (_, i) => ({ row: row + 1 + i })),
});

test('a block with no franchise cell sorts under its title, minus the article', () => {
  assert.equal(blockFranchise(block(0, 'The Bear', 1)), 'Bear');
  assert.equal(blockFranchise(block(0, 'The Bear', 1, 'Bear Universe')), 'Bear Universe');
  assert.equal(blockFranchise(block(0, 'The Bear', 1, null)), 'Bear', 'a blank cell falls back the same way');
});

test('a block ends at its last season row, and at its show row when it has none', () => {
  assert.equal(blockEnd(block(4, 'Fargo', 3)), 7);
  assert.equal(blockEnd(block(4, 'Fargo', 0)), 4);
});

// Within a franchise the tab's order is loose — 15 inversions across 309
// blocks — so there is no position inside the group a comparison could find,
// and the new block goes after the last of them.
test('a block sharing a franchise lands after the last block of it', () => {
  const blocks = [block(1, 'Alien', 1, 'Alien'), block(3, 'Aliens', 2, 'Alien'), block(6, 'Fargo', 1, 'Fargo')];
  assert.equal(placeBlock(blocks, 'Alien'), 6);
});

test('a new franchise lands above the first one that sorts after it', () => {
  const blocks = [block(1, 'Alien', 1, 'Alien'), block(3, 'Fargo', 2, 'Fargo'), block(6, 'Severance', 1, 'Severance')];
  assert.equal(placeBlock(blocks, 'Bear'), 3);
});

test('a franchise sorting past everything lands below the last block', () => {
  const blocks = [block(1, 'Alien', 1, 'Alien'), block(3, 'Fargo', 2, 'Fargo')];
  assert.equal(placeBlock(blocks, 'Severance'), 6);
});

// The tab is never empty in practice, and the answer still has to be "nowhere"
// rather than a row: with no block above it there is no season row to inherit
// formats from, and the header's formats are not a show row's.
test('a tab with no block has nowhere to put one', () => {
  assert.equal(placeBlock([], 'Bear'), null);
});

// --- The upstream tables -----------------------------------------------------

// TVDB's own genre-id order is the priority the first survivor picks by, so
// the order the payload arrives in is the order that survives.
test('TVDB genres map to the vocabulary in the order they arrive', () => {
  assert.deepEqual(mappedTvdbGenres(['Science Fiction', 'Drama', 'Adventure']), ['Sci-Fi', 'Drama', 'Adventure']);
  assert.deepEqual(mappedTvdbGenres(['Drama', 'Science Fiction']), ['Drama', 'Sci-Fi']);
  for (const genre of mappedTvdbGenres(['Science Fiction', 'Suspense', 'Documentary'])) assert.ok(isGenre(genre), genre);
});

// `Suspense` and `Thriller` are both Thriller, and a series carrying both must
// not spend two of its three secondary slots on one word.
test('two TVDB genres meaning the same thing yield one', () => {
  assert.deepEqual(mappedTvdbGenres(['Suspense', 'Thriller']), ['Thriller']);
  assert.deepEqual(mappedTvdbGenres(['Thriller', 'Suspense']), ['Thriller']);
});

// The vocabulary has nowhere to put these, and `History` is fiction as often
// as fact — a dropped genre leaves the cell to the next one, which is better
// than a word the renderer colours as nothing.
test('a genre the vocabulary has no place for is dropped, not approximated', () => {
  assert.deepEqual(mappedTvdbGenres(['Animation', 'Crime', 'History', 'Mini-Series', 'Comedy']), ['Comedy']);
  assert.deepEqual(mappedTvdbGenres(['Reality', 'Talk Show']), []);
  assert.deepEqual(mappedTvdbGenres([]), []);
});

test('a broadcaster the tab spells differently is written the tab\'s way', () => {
  assert.equal(networkCell('BBC One'), 'BBC');
  assert.equal(networkCell('BBC Four'), 'BBC');
  assert.equal(networkCell('STARZ'), 'Starz');
  assert.equal(networkCell('FOX'), 'Fox');
  assert.equal(networkCell('HBO Max'), 'HBO');
  assert.equal(networkCell('Max'), 'HBO');
  assert.equal(networkCell('CBS All Access'), 'CBS');
  assert.equal(networkCell('Paramount+ with Showtime'), 'Paramount+');
  assert.equal(networkCell('AMC+'), 'AMC');
});

// The map holds only the names that disagree, so anything else is written as
// it arrives — 185 of 189 blocks agree with SIMKL through it.
test('a broadcaster not in the map is written as it arrives', () => {
  assert.equal(networkCell('Netflix'), 'Netflix');
  assert.equal(networkCell(' AMC '), 'AMC');
});

test('no name is no cell, rather than an empty one', () => {
  assert.equal(networkCell(null), null);
  assert.equal(networkCell(undefined), null);
  assert.equal(networkCell('   '), null);
});
