/**
 * The reference films tab × reference library must always plan the identical
 * write set: same addresses, same fields, same insert fill. The golden is the
 * `PlanRecord` plus the insert's cells — the projection that survives the run,
 * and the ten columns a row gets exactly once, which is where a silent drift
 * would be most expensive. The plan also runs through the guard, so the golden
 * pins that a realistic films plan stays guard-clean.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMovieGrid } from '../../src/sheet/movies/2-grid.ts';
import { indexFilms } from '../../src/sheet/movies/1-index.ts';
import { filmFacts, type FilmFacts } from '../../src/sheet/movies/3-catalogue.ts';
import { filmPlanRecord, observeFilms, planFilms } from '../../src/sheet/movies/4-plan.ts';
import { assertFilmPlanSafe } from '../../src/sheet/movies/5-guard.ts';
import { movieKey, type Baseline } from '../../src/sheet/values.ts';
import { columnLetter } from '../../src/sheet/2-grid.ts';
import { filmRow, libraryOf, MOVIE_SHEET_HEADERS, sheetSnapshot } from '../helpers.ts';
import { expectGolden } from './golden.ts';

const NOW = Temporal.Instant.from('2026-08-20T12:00:00Z');
const TZ = 'Europe/London';

/** A payload complete enough to fill every column a film row can carry. */
const TMDB = {
  genres: [{ name: 'Adventure' }, { name: 'Animation' }, { name: 'Science Fiction' }, { name: 'Comedy' }, { name: 'Drama' }],
  belongs_to_collection: { name: 'A Reference Collection' },
  release_dates: {
    results: [{ iso_3166_1: 'GB', release_dates: [{ type: 3, release_date: '2026-08-07', certification: '12A' }] }],
  },
  credits: { crew: [{ job: 'Writer', name: 'Not This One' }, { job: 'Director', name: 'A Director' }] },
  images: {
    backdrops: [
      { file_path: '/quiet.jpg', iso_639_1: 'en', vote_average: 4 },
      { file_path: '/chosen.jpg', iso_639_1: 'en', vote_average: 9 },
    ],
  },
};

test('the reference films tab plans the committed write set', async () => {
  const grid = parseMovieGrid(
    sheetSnapshot([
      MOVIE_SHEET_HEADERS,
      // Unchanged since it was recorded: nothing to write.
      filmRow({ name: 'Star Wars', id: 53078, watched: 39487, score: 8, runtime: 121, genre: 'Sci-Fi' }),
      // Its score moved on SIMKL, so the row follows.
      filmRow({ name: 'Finding Nemo', id: 53080, watched: 38395, score: 6, runtime: 100, genre: 'Adventure' }),
    ]),
  );

  const library = libraryOf(
    { id: 53078, type: 'movies', status: 'completed', title: 'Star Wars', lastWatchedAt: '2008-02-09T19:00:00Z', rating: 8, runtime: 121 },
    { id: 53080, type: 'movies', status: 'completed', title: 'Finding Nemo', lastWatchedAt: '2005-02-12T19:00:00Z', rating: 9, runtime: 100 },
    // The new film: watched inside its GB theatrical window, so it is a cinema trip.
    { id: 62344, type: 'movies', status: 'completed', title: 'A Reference Film', lastWatchedAt: '2026-08-14T20:00:00Z', rating: 7, runtime: 81 },
    // Never inserted, and never looked up.
    { id: 70000, type: 'movies', status: 'plantowatch', title: 'Not Yet Watched' },
  );

  const index = indexFilms(library);
  const baseline: Baseline = new Map([
    [movieKey(53078), { 'Watch Date': '2008-02-09T19:00:00.000Z', Score: '8', Runtime: '121' }],
    [movieKey(53080), { 'Watch Date': '2005-02-12T19:00:00.000Z', Score: '6', Runtime: '100' }],
  ]);
  const facts = new Map<number, FilmFacts | null>([[62344, filmFacts(TMDB, 'A Reference Film')]]);

  const { plan } = planFilms(grid, index, facts, { now: NOW, timezone: TZ, baseline, seed: observeFilms(index) });

  assert.doesNotThrow(() => assertFilmPlanSafe(plan, grid, { now: NOW, timezone: TZ }));

  const golden = {
    ...filmPlanRecord(plan),
    // The fill is the whole point of the golden: ten of these columns are
    // written once and never revisited, so a drift here is a drift nothing
    // downstream would ever correct.
    fill:
      plan.insert?.fill.map((cell) => ({
        column: columnLetter(cell.column),
        field: cell.field,
        value: cell.value?.stringValue ?? cell.value?.numberValue ?? cell.value?.boolValue ?? null,
      })) ?? [],
  };
  await expectGolden('film-plan.json', JSON.stringify(golden, null, 2) + '\n');
});
