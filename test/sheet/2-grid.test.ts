import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnLetter, duplicateIds, findHeaderRow, GridError, idsFor, parseGrid, parseIds, resolveColumns } from '../../src/sheet/2-grid.ts';
import { cellOf, sheetSnapshot, SHEET_HEADERS, type CellSpec, seasonRow, showRow } from '../helpers.ts';

const H = SHEET_HEADERS;
const show = showRow;
const season = (n: number, episodes: number, start: number, end: number | null, id: number | string | null = null): CellSpec[] =>
  seasonRow(n, episodes, end, { id, start });

// --- base 26 ---------------------------------------------------------------

// String.fromCharCode(65 + i) yields `[` at index 26, and this sheet reaches AE.
test('column letters are real base 26 past Z', () => {
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(26), 'AA');
  assert.equal(columnLetter(27), 'AB');
  assert.equal(columnLetter(30), 'AE');
  assert.equal(columnLetter(51), 'AZ');
  assert.equal(columnLetter(52), 'BA');
});

// --- headers ---------------------------------------------------------------

test('the header row is found by content, so a title row above it is survivable', () => {
  const rows = [['My shows', null], [], H, ...[show('Fargo', 'Ended', 1, 'show')]];
  assert.equal(findHeaderRow(rows.map((r) => r.map(cellOf))), 2);
});

test('headers resolve case-insensitively and on trimmed text', () => {
  const header = ['  SHOW ', 'status', 'Season', 'Episode', 'Start', 'End', 'Episodes', 'Length', 'ID', 'type'];
  const columns = resolveColumns(header.map(cellOf), header.length);
  assert.equal(columns.Show, 0);
  assert.equal(columns.id, 8);
});

// The cheapest proof that nothing depends on position: the same data in a
// different column order must produce the same logical grid.
test('a shuffled column order resolves to the same blocks', () => {
  const shuffled = ['Type', 'id', 'Show', 'End', 'Start', 'Episode', 'Season', 'Status', 'Length', 'Episodes'];
  const pick = (row: CellSpec[]): CellSpec[] => shuffled.map((h) => row[H.indexOf(h)] as CellSpec);
  const rows = [show('Fargo', 'Ended', 3381, 'show'), season(1, 6, 45000, null)];

  const straight = parseGrid(sheetSnapshot([H, ...rows]));
  const mixed = parseGrid(sheetSnapshot([shuffled, ...rows.map(pick)]));

  assert.notDeepEqual(straight.columns, mixed.columns);
  assert.deepEqual(straight.blocks, mixed.blocks);
});

test('a missing, renamed or duplicated header is a hard failure', () => {
  const missing = H.map((h) => (h === 'End' ? 'Finished' : h));
  assert.throws(() => resolveColumns(missing.map(cellOf), missing.length), /End is missing/);

  const duplicated = [...H, 'Episode'];
  assert.throws(() => resolveColumns(duplicated.map(cellOf), duplicated.length), /Episode appears in D and K/);
});

test('the declared width is used, not the widest row', () => {
  // A short read must not present a displaced header as missing, which under
  // the fail-closed rule would disable the sync entirely.
  const snapshot = sheetSnapshot([H, show('Fargo', 'Ended', 1, 'show')], { columnCount: 31 });
  assert.equal(parseGrid(snapshot).columns.Type, 9);
});

// --- blocks ----------------------------------------------------------------

test('a show row starts a block and the rows under it are its seasons', () => {
  const grid = parseGrid(
    sheetSnapshot([H, show('Fargo', 'Ended', 3381, 'show'), season(1, 6, 45000, 45010), season(2, 10, 45100, null), show('Silo', 'Watching', 7, 'show'), season(3, 7, 46000, null)]),
  );
  assert.deepEqual(grid.blocks.map((b) => b.title), ['Fargo', 'Silo']);
  assert.deepEqual(grid.blocks[0]?.seasons.map((s) => s.season), [1, 2]);
  assert.equal(grid.blocks[0]?.seasons[0]?.closed, true);
  assert.equal(grid.blocks[0]?.seasons[1]?.closed, false);
  assert.deepEqual(grid.blocks[1]?.seasons.map((s) => s.row), [5]);
});

test('a season row with no show row above it throws rather than being orphaned', () => {
  assert.throws(() => parseGrid(sheetSnapshot([H, season(1, 6, 45000, null)])), GridError);
});

// The show-row roll-up formulas use MATCH("*", …), which matches text only.
// "24", "1899" and "1923" are real show names, so this is not theoretical.
test('a numeric show title is refused, because the roll-up would merge two blocks', () => {
  assert.throws(() => parseGrid(sheetSnapshot([H, show('Fargo', 'Ended', 1, 'show'), season(1, 6, 45000, null), [1899, 'Ended', 1, 1, 1, 1, 1, 1, 2, 'show']])), /is not text/);
});

test('trailing blank rows are the sheet tail, not data', () => {
  const grid = parseGrid(sheetSnapshot([H, show('Fargo', 'Ended', 1, 'show'), season(1, 6, 45000, null), [null, null, null], [null]]));
  assert.equal(grid.blocks[0]?.seasons.length, 1);
});

test('a fractional season label parses as itself, so callers can refuse it', () => {
  const grid = parseGrid(sheetSnapshot([H, show('Doctor Who', 'Ended', 8530, 'show'), season(13.5, 1, 45000, 45001)]));
  assert.equal(grid.blocks[0]?.seasons[0]?.season, 13.5);
});

// --- ids -------------------------------------------------------------------

test('a split cour reads as an ordered list of ids', () => {
  assert.deepEqual(parseIds(cellOf('522882,581835')), [522882, 581835]);
  assert.deepEqual(parseIds(cellOf(' 522882 , 581835 ')), [522882, 581835]);
  assert.deepEqual(parseIds(cellOf(3381)), [3381]);
  assert.deepEqual(parseIds(cellOf(null)), []);
  assert.deepEqual(parseIds(undefined), []);
});

// Both exceptions exist in the real sheet, and they are independent: Doctor Who
// carries ids in both places, Parasyte carries one only on a season row.
test("a season row's own id wins, and a blank one inherits the show row's", () => {
  const grid = parseGrid(sheetSnapshot([H, show('Doctor Who', 'Ended', 8530, 'show'), season(13, 8, 45000, 45010), season(14, 8, 45500, null, 2463827)]));
  const block = grid.blocks[0]!;
  assert.deepEqual(idsFor(block, block.seasons[0]!), [8530]);
  assert.deepEqual(idsFor(block, block.seasons[1]!), [2463827]);
});

test('a block whose show row has no id still resolves from its season rows', () => {
  const grid = parseGrid(sheetSnapshot([H, show('Parasyte: The Grey', 'Ended', null, 'show'), season(1, 6, 45000, null, 1990183)]));
  const block = grid.blocks[0]!;
  assert.deepEqual(block.ids, []);
  // Type says `show` and SIMKL agrees, so the id's location was never inferable
  // from it — which is exactly why nothing does.
  assert.equal(block.type, 'show');
  assert.deepEqual(idsFor(block, block.seasons[0]!), [1990183]);
});

test('an id claimed by two rows is reported, because neither claimant is safe to write', () => {
  const grid = parseGrid(sheetSnapshot([H, show('A', 'Ended', null, 'anime'), season(1, 6, 45000, null, 99), season(2, 6, 45100, null, 99)]));
  assert.deepEqual([...duplicateIds(grid.blocks)], [99]);
});

// The likeliest duplication in a hand-maintained file, and the one a
// season-rows-only scan misses: every season of both blocks would inherit the
// id, so one title's progress would drive edits in two unrelated places.
test('the same id on two show rows is caught, not just on two season rows', () => {
  const grid = parseGrid(
    sheetSnapshot([H, show('Fargo', 'Ended', 3381, 'show'), season(1, 6, 45000, null), show('Fargo (again)', 'Ended', 3381, 'show'), season(1, 6, 45000, null)]),
  );
  assert.deepEqual([...duplicateIds(grid.blocks)], [3381]);
});

// A row is closed by having anything in End, not by that thing parsing as a
// date — otherwise a hand-typed note reads as open and gets overwritten.
test('a non-numeric End still closes the row', () => {
  const rows = [H, show('Fargo', 'Ended', 1, 'show'), season(1, 6, 45000, null)];
  rows[2]![5] = 'TBD';
  assert.equal(parseGrid(sheetSnapshot(rows)).blocks[0]?.seasons[0]?.closed, true);
});

// The likeliest false positive, and the one that made a block permanently
// inert: the series id belongs on the show row, and a user who also writes it
// on that show's own season row has repeated a true statement, not created a
// conflict. Counted per row it reported every row in the block as clashing.
test('a show row and its own season row naming one id is not a duplicate', () => {
  const grid = parseGrid(sheetSnapshot([H, show('Frieren', 'Watching', 99, 'anime'), season(1, 12, 44000, null, 99)]));
  assert.deepEqual([...duplicateIds(grid.blocks)], []);
});

// A row with an id and nothing else has no season to advance and no shape to
// compare against, but the by-id resolution path never consults `season` — so
// a count would be planned into a row that is not a season row at all.
test('a row carrying only an id is not read as a season row', () => {
  const grid = parseGrid(sheetSnapshot([H, show('Fargo', 'Ended', 100), [null, null, null, null, null, null, null, null, 3381, null]]));
  assert.deepEqual(grid.blocks[0]?.seasons, []);
});
