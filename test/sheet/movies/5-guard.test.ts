import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFilmPlanSafe, EDIT_FIELDS, INSERT_FIELDS, UnsafeFilmPlanError } from '../../../src/sheet/movies/5-guard.ts';
import { FOLLOWED_FIELDS } from '../../../src/sheet/movies/4-plan.ts';
import { ffx, film, filmGrid, filmPlanOf, TODAY } from './fixture.ts';
import { nextFilmRow, parseMovieGrid } from '../../../src/sheet/movies/2-grid.ts';
import { MOVIE_SHEET_HEADERS, sheetSnapshot } from '../../helpers.ts';
import { cellOf, withConfig } from '../../helpers.ts';
import type { MovieHeaderName } from '../../../src/sheet/movies/2-grid.ts';
import type { ExtendedValue } from '../../../src/api/google/types.ts';

const refuses = (plan: Parameters<typeof assertFilmPlanSafe>[0], grid = ffx.grid, pattern?: RegExp): void => {
  assert.throws(() => assertFilmPlanSafe(plan, grid), (err: unknown) => {
    assert.ok(err instanceof UnsafeFilmPlanError, `expected a refusal, got ${String(err)}`);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
};

const allows = (plan: Parameters<typeof assertFilmPlanSafe>[0], grid = ffx.grid): void => {
  assert.doesNotThrow(() => assertFilmPlanSafe(plan, grid));
};

// --- What may be written to a row that already exists ------------------------

test('the three columns that follow SIMKL may be written to an existing row', () => {
  allows(filmPlanOf([ffx.cell('starWars', 'Watch Date', { numberValue: TODAY - 1 })]));
  allows(filmPlanOf([ffx.cell('starWars', 'Score', { numberValue: 9 })]));
  allows(filmPlanOf([ffx.cell('starWars', 'Runtime', { numberValue: 125 })]));
});

test('every write-once column is refused on a row that already exists', () => {
  // The guard's own copy of the insert-only rule. Each of these is a column
  // the planner never edits, so a plan carrying one is a planner that lost
  // track of which rule it was applying.
  const cases: Array<[MovieHeaderName, ExtendedValue]> = [
    ['Name', { stringValue: 'Renamed' }],
    ['Cinema', { boolValue: true }],
    ['Genre', { stringValue: 'Drama' }],
    ['Genres', { stringValue: 'Action' }],
    ['Rating', { numberValue: 15 }],
    ['Release Date', { numberValue: TODAY - 5000 }],
    ['Franchise', { stringValue: 'Star Wars' }],
    ['Director', { stringValue: 'George Lucas' }],
    ['Banner', { stringValue: 'https://image.tmdb.org/t/p/w1280/a.jpg' }],
    ['id', { stringValue: '999' }],
  ];
  for (const [field, value] of cases) {
    refuses(filmPlanOf([ffx.cell('starWars', field, value)]), ffx.grid, /follow SIMKL|may write/);
  }
});

test('no cell on this tab may be emptied', () => {
  for (const field of ['Watch Date', 'Score', 'Runtime'] as MovieHeaderName[]) {
    refuses(filmPlanOf([ffx.cell('starWars', field, undefined)]), ffx.grid, /may empty/);
  }
});

// --- Alignment: the class that produces real writes in wrong places ----------

test('a cell holding something other than what the plan was built on is refused', () => {
  const edit = ffx.cell('starWars', 'Score', { numberValue: 9 });
  refuses(filmPlanOf([{ ...edit, previous: { numberValue: 3 } }]), ffx.grid, /no longer holds/);
});

test('a column index disagreeing with the resolved header is refused', () => {
  const edit = ffx.cell('starWars', 'Score', { numberValue: 9 });
  refuses(filmPlanOf([{ ...edit, column: edit.column + 1 }]), ffx.grid, /does not match the resolved position/);
});

test('a row outside the snapshot is refused before its value is compared', () => {
  // Past the end both sides read as undefined, so a value comparison would
  // agree with itself and pass. The row-set test catches it first and is
  // strictly stronger: it also refuses an in-bounds row the parse found no
  // film on.
  const edit = ffx.cell('starWars', 'Score', { numberValue: 9 });
  refuses(filmPlanOf([{ ...edit, row: 500 }]), ffx.grid, /not a row this sync can identify/);
});

test('the header row is not a film row', () => {
  const edit = ffx.cell(0, 'Score', { numberValue: 9 });
  refuses(filmPlanOf([edit]), ffx.grid, /not a row this sync can identify/);
});

test('an edit aimed at another film row is refused, blank cell or not', () => {
  // Alignment alone cannot catch this: both Score cells are blank, so
  // `previous` matches whichever row the write lands on and the wrong film
  // silently takes the value.
  const fx = filmGrid(film('starWars', { id: 53078, score: null }), film('nemo', { id: 53080, score: null }));
  const misaimed = fx.cell('nemo', 'Score', { numberValue: 9 }, undefined, 53078);
  refuses(filmPlanOf([misaimed]), fx.grid, /the plan is for film 53078 but that row holds 53080/);
});

test('a row carrying no id is never written to', () => {
  // A hand-typed footer or a row someone started: the sync cannot say which
  // film it is, so it may not touch it.
  const fx = filmGrid(film('a', { id: 1, score: null }), film('totals', { id: null, name: 'TOTALS', score: null }));
  refuses(filmPlanOf([fx.cell('totals', 'Score', { numberValue: 9 }, undefined, 1)]), fx.grid, /not a row this sync can identify/);
});

test('a row whose id the tab repeats is never written to', () => {
  // Which of the two rows holds that film is a coin toss, and the guard says
  // so on its own rather than trusting the planner to have declined.
  const fx = filmGrid(film('a', { id: 42, score: null }), film('b', { id: 42, score: null }));
  refuses(filmPlanOf([fx.cell('a', 'Score', { numberValue: 9 })]), fx.grid, /not a row this sync can identify/);
});

test('a formula target is refused unconditionally', () => {
  // The tab carries no formula today; the copy people read carries one in
  // Banner, so this must hold rather than be assumed.
  const fx = filmGrid(film('a', { id: 1, score: 5 }));
  const withFormula = { ...fx.grid, snapshot: { ...fx.grid.snapshot, rows: fx.grid.snapshot.rows.map((r) => [...r]) } };
  withFormula.snapshot.rows[1]![fx.grid.columns.Score] = cellOf({ formula: '=1+1', value: 5 });
  const edit = { ...fx.cell('a', 'Score', { numberValue: 9 }), previous: { formulaValue: '=1+1' } };
  refuses(filmPlanOf([edit]), withFormula, /is a formula/);
});

// --- Value conventions -------------------------------------------------------

test('a score outside SIMKL scale is refused rather than rounded', () => {
  for (const score of [0, 11, 7.5, Number.NaN]) {
    refuses(filmPlanOf([ffx.cell('starWars', 'Score', { numberValue: score })]), ffx.grid, /score|finite/);
  }
});

test('an implausible runtime or watch date is refused', () => {
  refuses(filmPlanOf([ffx.cell('starWars', 'Runtime', { numberValue: 0 })]), ffx.grid, /runtime/);
  refuses(filmPlanOf([ffx.cell('starWars', 'Runtime', { numberValue: 1441 })]), ffx.grid, /runtime/);
  refuses(filmPlanOf([ffx.cell('starWars', 'Watch Date', { numberValue: 1000 })]), ffx.grid, /watch date/);
  // Tomorrow is the ceiling; a watch a week out is a payload error.
  refuses(filmPlanOf([ffx.cell('starWars', 'Watch Date', { numberValue: TODAY + 7 })]), ffx.grid, /watch date/);
});

test('a release date is bounded at both ends, and neither is a watch date bound', () => {
  // A watch date floors at 2000-01-01 and ceilings at tomorrow. A release does
  // neither: the tab carries films from 1939, and a film can be watched at a
  // preview before it opens here.
  const wizardOfOz = 14482; // 1939-08-25
  allows(filmPlanOf([], ffx.insert({ extra: [['Release Date', { numberValue: wizardOfOz }]] })));
  allows(filmPlanOf([], ffx.insert({ extra: [['Release Date', { numberValue: TODAY + 7 }]] })));
  // Still bounded, at a width only a payload error crosses.
  refuses(filmPlanOf([], ffx.insert({ extra: [['Release Date', { numberValue: -100 }]] })), ffx.grid, /release date/);
  refuses(filmPlanOf([], ffx.insert({ extra: [['Release Date', { numberValue: TODAY + 4000 }]] })), ffx.grid, /release date/);
});

// --- The insert --------------------------------------------------------------

test('a well-formed insert below the last row is allowed', () => {
  allows(filmPlanOf([], ffx.insert()));
});

test('an insert anywhere but the next free row is refused', () => {
  // Its index is pre-write, and every other edit in the plan carries one too:
  // inserting into the middle shifts rows out from under them.
  refuses(filmPlanOf([], ffx.insert({ row: 1 })), ffx.grid, /only ever added at row/);
  refuses(filmPlanOf([], ffx.insert({ row: ffx.end + 1 })), ffx.grid, /only ever added at row/);
});

test('a films tab holding no rows yet can take its first', () => {
  // "Below the last one" has no answer here, so the floor is the header row.
  // Anchored separately, the planner and the guard disagreed by one and the
  // tab could never gain a row at all.
  const empty = filmGrid();
  allows(filmPlanOf([], empty.insert({ row: 1 })), empty.grid);
  refuses(filmPlanOf([], empty.insert({ row: 0 })), empty.grid, /only ever added at row 2/);
});

test('the first row goes under the header, wherever the header is', () => {
  // A title row above the header is survivable — `findHeaderRow` looks down
  // five rows for it — so "row 0" is not the floor, the header is. With no
  // film rows to count back from, that is the only thing that says where the
  // first one goes.
  const titled = parseMovieGrid(sheetSnapshot([['Films', null], MOVIE_SHEET_HEADERS]));
  assert.equal(titled.headerRow, 1);
  assert.equal(nextFilmRow(titled), 2);
});

test('a tab whose declared grid is full has no row to add', () => {
  // `rowCount` is a count, so the last usable 0-based index is one below it.
  // A tab trimmed to exactly its data has nowhere for the next film to go.
  const full = filmGrid(film('a', { id: 1 }), film('b', { id: 2 }));
  full.grid.snapshot.rowCount = full.grid.rows.length + 1;
  refuses(filmPlanOf([], full.insert()), full.grid, /no row to add/);
});

test('an inserted row must carry its id, as text, and it must be the film planned', () => {
  refuses(filmPlanOf([], ffx.insert({ without: 'id' })), ffx.grid, /must carry its SIMKL id/);
  const wrong = ffx.insert({ id: 999 });
  const idCell = wrong.fill.find((c) => c.field === 'id')!;
  idCell.value = { stringValue: '1000' };
  refuses(filmPlanOf([], wrong), ffx.grid, /the plan is for 999/);
});

test('an id written as a number is refused: every other id cell on the tab is text', () => {
  const insert = ffx.insert();
  insert.fill.find((c) => c.field === 'id')!.value = { numberValue: 999 };
  refuses(filmPlanOf([], insert), ffx.grid, /id must be the SIMKL id as text/);
});

test('an inserted row must carry a name and a watch date', () => {
  refuses(filmPlanOf([], ffx.insert({ without: 'Name' })), ffx.grid, /must carry a name/);
  refuses(filmPlanOf([], ffx.insert({ without: 'Watch Date' })), ffx.grid, /must carry a watch date/);
});

test('a film already on the tab is never inserted again', () => {
  refuses(filmPlanOf([], ffx.insert({ id: 53078 })), ffx.grid, /already on the tab/);
});

test('a fill cell off the inserted row, or carrying a previous value, is refused', () => {
  const stray = ffx.insert();
  stray.fill[0]!.row = 1;
  refuses(filmPlanOf([], stray), ffx.grid, /must sit on the inserted row/);

  const claimed = ffx.insert();
  claimed.fill[0]!.previous = { stringValue: 'was here' };
  refuses(filmPlanOf([], claimed), ffx.grid, /no previous value/);
});

test('a column filled twice is refused', () => {
  const twice = ffx.insert({ extra: [['Name', { stringValue: 'Again' }]] });
  refuses(filmPlanOf([], twice), ffx.grid, /Name is filled twice/);
});

test('Anime is in neither whitelist — the sync never sets it', () => {
  refuses(filmPlanOf([], ffx.insert({ extra: [['Anime' as MovieHeaderName, { boolValue: true }]] })), ffx.grid, /not a field this sync may write/);
});

test('Cinema is only ever written TRUE — the tab spells no as an absent cell', () => {
  allows(filmPlanOf([], ffx.insert({ extra: [['Cinema', { boolValue: true }]] })));
  refuses(filmPlanOf([], ffx.insert({ extra: [['Cinema', { boolValue: false }]] })), ffx.grid, /only ever written as TRUE/);
});

test('a genre outside the renderer vocabulary is refused', () => {
  allows(filmPlanOf([], ffx.insert({ extra: [['Genre', { stringValue: 'Sci-Fi' }]] })));
  refuses(filmPlanOf([], ffx.insert({ extra: [['Genre', { stringValue: 'Animation' }]] })), ffx.grid, /genres the renderer colours/);
  refuses(filmPlanOf([], ffx.insert({ extra: [['Genres', { stringValue: 'Action, Crime' }]] })), ffx.grid, /genres the renderer colours/);
});

test('no secondary genres is a state the column holds, not an unknown genre', () => {
  // 27 rows on the tab carry it. `''.split(',')` is `['']`, which is not a
  // genre — refusing that would make the planner's decision to omit the cell
  // load-bearing for the guard's correctness, which is the coupling these
  // rules exist to avoid.
  allows(filmPlanOf([], ffx.insert({ extra: [['Genres', { stringValue: '' }]] })));
});

test('more secondary genres than the column holds is refused', () => {
  allows(filmPlanOf([], ffx.insert({ extra: [['Genres', { stringValue: 'Action, Adventure, Drama' }]] })));
  refuses(
    filmPlanOf([], ffx.insert({ extra: [['Genres', { stringValue: 'Action, Adventure, Drama, Comedy' }]] })),
    ffx.grid,
    /exceeds the 3/,
  );
});

test('a rating outside the BBFC set is refused', () => {
  allows(filmPlanOf([], ffx.insert({ extra: [['Rating', { numberValue: 12 }]] })));
  refuses(filmPlanOf([], ffx.insert({ extra: [['Rating', { numberValue: 13 }]] })), ffx.grid, /BBFC certificate/);
});

test('an empty name, franchise, director or banner is refused', () => {
  for (const field of ['Name', 'Franchise', 'Director', 'Banner'] as MovieHeaderName[]) {
    refuses(filmPlanOf([], ffx.insert({ extra: [[field, { stringValue: '  ' }]] })), ffx.grid, /non-empty text/);
  }
});

// --- Budgets -----------------------------------------------------------------

test('over budget refuses the whole plan rather than truncating it', async () => {
  await withConfig({ sheetMaxEdits: 1 }, () => {
    refuses(
      filmPlanOf([ffx.cell('starWars', 'Score', { numberValue: 9 }), ffx.cell('nemo', 'Score', { numberValue: 7 })]),
      ffx.grid,
      /exceeds SHEET_MAX_EDITS/,
    );
  });
  await withConfig({ sheetMaxRows: 1 }, () => {
    refuses(
      filmPlanOf([ffx.cell('starWars', 'Score', { numberValue: 9 }), ffx.cell('nemo', 'Score', { numberValue: 7 })]),
      ffx.grid,
      /exceeds SHEET_MAX_ROWS/,
    );
  });
});

test('what another tab already planned this poll counts against the same budget', () => {
  // The budget is a blast radius for the poll, not an allowance per tab:
  // counted per tab, one poll writes twice SHEET_MAX_EDITS while each half
  // reports itself inside budget.
  const one = filmPlanOf([ffx.cell('starWars', 'Score', { numberValue: 9 })]);
  assert.doesNotThrow(() => assertFilmPlanSafe(one, ffx.grid, { maxEdits: 2, spent: { edits: 1, rows: 1 } }));
  assert.throws(
    () => assertFilmPlanSafe(one, ffx.grid, { maxEdits: 2, spent: { edits: 2, rows: 1 } }),
    /3 edits this poll exceeds SHEET_MAX_EDITS=2/,
  );
  assert.throws(
    () => assertFilmPlanSafe(one, ffx.grid, { maxRows: 2, spent: { edits: 0, rows: 2 } }),
    /3 distinct rows this poll exceeds SHEET_MAX_ROWS=2/,
  );
});

test('an empty plan is safe', () => {
  allows(filmPlanOf());
});

test('the guard whitelist and the planner followed set say the same thing', () => {
  // Pinned rather than derived. The whitelist is the guard's own spec — if it
  // were `FOLLOWED_FIELDS`, widening the planner would widen the guard with
  // it, and the guard would stop being a second opinion. Equal today, and this
  // is what makes changing one without the other a failing test.
  assert.deepEqual([...EDIT_FIELDS].sort(), [...FOLLOWED_FIELDS].sort());
  // And every followed field is insertable, since a new row carries them too.
  for (const field of FOLLOWED_FIELDS) assert.ok(INSERT_FIELDS.has(field));
  assert.equal(INSERT_FIELDS.has('Anime' as MovieHeaderName), false);
});
