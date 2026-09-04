import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFilmPlanSafe, EDIT_FIELDS, INSERT_FIELDS, UnsafeFilmPlanError } from '../../../src/sheet/movies/5-guard.ts';
import { FOLLOWED_FIELDS } from '../../../src/sheet/movies/4-plan.ts';
import { ffx, film, filmGrid, filmPlanOf, TODAY } from './fixture.ts';
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
  refuses(filmPlanOf([{ ...edit, row: 500 }]), ffx.grid, /not a film row/);
});

test('the header row is not a film row', () => {
  const edit = ffx.cell(0, 'Score', { numberValue: 9 });
  refuses(filmPlanOf([edit]), ffx.grid, /not a film row/);
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
  refuses(filmPlanOf([ffx.cell('starWars', 'Watch Date', { numberValue: 1000 })]), ffx.grid, /date serial/);
  // Tomorrow is the ceiling; a watch a week out is a payload error.
  refuses(filmPlanOf([ffx.cell('starWars', 'Watch Date', { numberValue: TODAY + 7 })]), ffx.grid, /date serial/);
});

// --- The insert --------------------------------------------------------------

test('a well-formed insert below the last row is allowed', () => {
  allows(filmPlanOf([], ffx.insert()));
});

test('an insert anywhere but below the last row is refused', () => {
  // Its index is pre-write, and every other edit in the plan carries one too:
  // inserting into the middle shifts rows out from under them.
  refuses(filmPlanOf([], ffx.insert({ row: 1 })), ffx.grid, /added below the last one/);
  refuses(filmPlanOf([], ffx.insert({ row: ffx.end + 1 })), ffx.grid, /added below the last one/);
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
