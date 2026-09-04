/**
 * PLAN — grid + library + catalogue + baseline → what to write on the films
 * tab, and what still needs looking up. Pure: no clock of its own, no network,
 * no config read mid-body.
 *
 * Two things happen here and they answer to different rules.
 *
 * A film **already on the tab** is revisited only through the three columns
 * that follow SIMKL, and only where SIMKL's value has moved away from what
 * this service last recorded — never from what the cell holds. A cell may have
 * disagreed since before the sync first ran, and adopting those would turn a
 * first poll into a reconciliation of every standing mismatch.
 *
 * A film **not on the tab** gets one row, built in a single batch. Every other
 * column is written there and never again, so each has to be right in that one
 * batch or not written at all — which is why a film whose TMDB lookup has not
 * answered waits a poll rather than landing with eight blank cells.
 *
 * Like the show planner, this never throws: an unresolvable row becomes a skip.
 */

import { isoOf, plainDateIn } from '../../shared/dates.ts';
import type { ExtendedValue } from '../../api/google/types.ts';
import { isFormula } from '../2-grid.ts';
import { maxSerial, movieKey, plausibleSerial, recordedSerial, watchSerial, type Baseline } from '../values.ts';
import { movieAddress, movieCellAt, type MovieGrid, type MovieHeaderName } from './2-grid.ts';
import { filmIsWatched, type FilmProgress } from './1-index.ts';
import type { FilmFacts } from './3-catalogue.ts';
import type { PlanRecord } from '../4-plan.ts';
import { plausibleRuntime, plausibleScore, serialOf, watchedInCinema } from './values.ts';

// --- The plan --------------------------------------------------------------

export interface FilmCellEdit {
  /** Zero-based, in the snapshot the plan was built from. */
  row: number;
  column: number;
  field: MovieHeaderName;
  /** The snapshot's `userEnteredValue`, for the guard and the rollback. */
  previous: ExtendedValue | undefined;
  value: ExtendedValue | undefined;
  /** A1, for the report. Never sent — writes are index-based. */
  address: string;
  note: string;
}

export interface FilmRowInsert {
  row: number;
  id: number;
  title: string;
  /** No `previous`: the row did not exist. */
  fill: FilmCellEdit[];
  note: string;
}

export type FilmSkipCode = 'duplicate-id' | 'unknown-id' | 'unusable-value' | 'formula-cell' | 'awaiting-lookup' | 'not-in-tmdb';

export interface FilmSkip {
  code: FilmSkipCode;
  row: number | null;
  reason: string;
}

export interface FilmPlan {
  edits: FilmCellEdit[];
  /**
   * At most one per run, carried by the type. Plan indices are pre-write and
   * `insertDimension` applies cumulatively, so a second insert would land a
   * row high.
   */
  insert: FilmRowInsert | null;
  skips: FilmSkip[];
  notes: string[];
  deferredInserts: number;
}

export const emptyFilmPlan = (): FilmPlan => ({ edits: [], insert: null, skips: [], notes: [], deferredInserts: 0 });

/** One film to look up, and the title its answer is filed under. */
export interface FilmDemand {
  id: number;
  tmdbId: number;
  title: string;
}

export interface FilmPlanResult {
  plan: FilmPlan;
  demands: FilmDemand[];
  /** Seen but not written: first sightings, unmoved values, declined moves. */
  observed: Baseline;
  /** Values an edit was planned for. Recordable only once that edit lands. */
  writing: Baseline;
}

export interface PlanFilmsOptions {
  now?: Temporal.Instant;
  timezone?: string;
  baseline?: Baseline;
  /** `observeFilms(index)`, hoisted so the fixpoint loop does not rebuild it per pass. */
  seed?: Baseline;
}

// --- Recording -------------------------------------------------------------

/**
 * The three columns that follow SIMKL for the life of the row.
 *
 * They qualify on the show grid's test for `TRACKED_FIELDS`: what they hold is
 * not the row's judgement but SIMKL's, so freezing them would preserve no
 * decision, only a stale copy of an upstream fact. Every other column on this
 * tab is a judgement — which backdrop, which genre is primary, whether a
 * franchise is "Pixar" — and is written once.
 *
 * `Name` is not among them though it is 95% derivable: the 18 rows that
 * disagree carry hand titles, and following it would overwrite each one the
 * day SIMKL renamed anything.
 */
export const FOLLOWED_FIELDS = ['Watch Date', 'Score', 'Runtime'] as const satisfies readonly MovieHeaderName[];

export type FollowedField = (typeof FOLLOWED_FIELDS)[number];

const FOLLOWED = new Set<MovieHeaderName>(FOLLOWED_FIELDS);

export const isFollowed = (field: MovieHeaderName): field is FollowedField => FOLLOWED.has(field);

/**
 * What a baseline entry records for a field SIMKL holds no value for.
 *
 * A recorded absence, not an absent record. SIMKL holds no score for 102 of
 * the films already on the tab, and leaving those unrecorded would make rating
 * one later a *first sighting* — recorded, written nothing, and silent from
 * then on. Recording the absence makes none → 8 a move, which is what
 * following SIMKL means.
 *
 * A character no score or runtime can be, so it can never be read back as one.
 */
export const NOT_HELD = '-';

/**
 * What SIMKL currently says, per film and per followed field, for the whole
 * library.
 *
 * Recorded wide because recording is not writing and costs nothing: a film
 * whose row this run never reaches still has its values recorded, so the poll
 * that does reach it compares against something rather than treating a real
 * move as a first sighting.
 */
export const observeFilms = (index: Map<number, FilmProgress>): Baseline => {
  const out: Baseline = new Map();
  for (const film of index.values()) {
    out.set(movieKey(film.id), {
      'Watch Date': film.watchedAt ? isoOf(film.watchedAt) : NOT_HELD,
      Score: film.rating === null ? NOT_HELD : String(film.rating),
      Runtime: film.runtime === null ? NOT_HELD : String(film.runtime),
    });
  }
  return out;
};

// --- Cell construction -----------------------------------------------------

const str = (value: string): ExtendedValue => ({ stringValue: value });
const num = (value: number): ExtendedValue => ({ numberValue: value });
const bool = (value: boolean): ExtendedValue => ({ boolValue: value });

const edit = (
  grid: MovieGrid,
  row: number,
  field: MovieHeaderName,
  value: ExtendedValue | undefined,
  note: string,
): FilmCellEdit => {
  const column = grid.columns[field];
  return {
    row,
    column,
    field,
    previous: movieCellAt(grid, row, column)?.userEnteredValue,
    value,
    address: movieAddress(grid, row, field),
    note,
  };
};

/** A cell on a row that does not exist yet, so it has no `previous`. */
const fillCell = (grid: MovieGrid, row: number, field: MovieHeaderName, value: ExtendedValue, note: string): FilmCellEdit => ({
  row,
  column: grid.columns[field],
  field,
  previous: undefined,
  value,
  address: movieAddress(grid, row, field),
  note,
});

// --- Following SIMKL -------------------------------------------------------

/**
 * What a followed field currently is, on both sides of the comparison.
 *
 * `null` on the SIMKL side means "holds none", which is recordable but never
 * writable — this tab empties no cell. `undefined` on the recorded side means
 * never observed, which is a first sighting.
 */
interface Comparison {
  /** What the cell should hold, or null where SIMKL holds nothing. */
  wanted: number | null;
  /** What was last recorded: a number, null for a recorded absence, undefined for never. */
  recorded: number | null | undefined;
  value: ExtendedValue | undefined;
}

const recordedNumber = (recorded: string | undefined): number | null | undefined => {
  if (recorded === undefined) return undefined;
  if (recorded === NOT_HELD) return null;
  const n = Number(recorded);
  return Number.isFinite(n) ? n : undefined;
};

const compare = (field: FollowedField, film: FilmProgress, entry: Partial<Record<string, string>>, timezone: string): Comparison => {
  if (field === 'Watch Date') {
    const wanted = watchSerial(film.watchedAt, timezone);
    return { wanted, recorded: recordedSerial(entry['Watch Date'], timezone), value: wanted === null ? undefined : num(wanted) };
  }
  const wanted = field === 'Score' ? film.rating : film.runtime;
  return { wanted, recorded: recordedNumber(entry[field]), value: wanted === null ? undefined : num(wanted) };
};

const withinBounds = (field: FollowedField, value: number, ceiling: number): boolean => {
  if (field === 'Watch Date') return plausibleSerial(value, ceiling);
  return field === 'Score' ? plausibleScore(value) : plausibleRuntime(value);
};

// --- The walk --------------------------------------------------------------

export const planFilms = (
  grid: MovieGrid,
  index: Map<number, FilmProgress>,
  facts: Map<number, FilmFacts | null>,
  { now = Temporal.Now.instant(), timezone = 'UTC', baseline = new Map(), seed }: PlanFilmsOptions = {},
): FilmPlanResult => {
  const plan = emptyFilmPlan();
  const demands: FilmDemand[] = [];
  // Copied, so a discarded pass leaves no withdrawals in the caller's seed.
  const observed: Baseline = new Map(seed ?? observeFilms(index));
  const writing: Baseline = new Map();
  const ceiling = maxSerial(now, timezone);

  const skip = (code: FilmSkipCode, row: number | null, reason: string): void => {
    plan.skips.push({ code, row, reason });
  };

  /** Move a field out of "seen" and into "planned to write". */
  const willWrite = (key: string, field: MovieHeaderName, recorded: string): void => {
    writing.set(key, { ...writing.get(key), [field]: recorded });
    const seen = observed.get(key);
    if (seen) {
      const { [field]: _dropped, ...rest } = seen;
      observed.set(key, rest);
    }
  };

  const onTab = new Set<number>();

  for (const row of grid.rows) {
    if (row.id === null) continue;
    onTab.add(row.id);

    if (grid.duplicates.has(row.id)) {
      skip('duplicate-id', row.row, `SIMKL id ${row.id} is on more than one row, so which one holds that film is a coin toss`);
      continue;
    }
    const film = index.get(row.id);
    if (!film) {
      skip('unknown-id', row.row, `SIMKL id ${row.id} is in no film list, so nothing upstream describes this row`);
      continue;
    }

    const key = movieKey(film.id);
    const entry = baseline.get(key) ?? {};

    for (const field of FOLLOWED_FIELDS) {
      const { wanted, recorded, value } = compare(field, film, entry, timezone);

      // A first sighting: recorded by the seed, written nothing. This is what
      // keeps the sync to changes from here on rather than a reconciliation of
      // every standing mismatch.
      if (recorded === undefined) continue;
      if (recorded === wanted) continue;

      // SIMKL dropped a value it used to hold. Nothing on this tab is ever
      // emptied, so this is recorded and left: the cell keeps what it has.
      if (wanted === null || value === undefined) {
        skip('unusable-value', row.row, `${film.title}: SIMKL no longer holds a ${field}, and this tab empties no cell`);
        continue;
      }
      if (!withinBounds(field, wanted, ceiling)) {
        skip('unusable-value', row.row, `${film.title}: ${field} of ${wanted} is outside the range this column accepts`);
        continue;
      }
      const cell = movieCellAt(grid, row.row, grid.columns[field]);
      if (isFormula(cell)) {
        skip('formula-cell', row.row, `${movieAddress(grid, row.row, field)} is a formula, so the sync leaves it alone`);
        continue;
      }

      plan.edits.push(edit(grid, row.row, field, value, `${film.title}: ${field} moved to ${wanted}`));
      willWrite(key, field, field === 'Watch Date' ? isoOf(film.watchedAt as Temporal.Instant) : String(wanted));
    }
  }

  planInsert(grid, index, facts, onTab, plan, demands, { timezone, ceiling });

  return { plan, demands, observed, writing };
};

/**
 * The one film this run adds, and the lookups the rest still need.
 *
 * Ordered by watch date so a backlog drains oldest-first: the tab reads as a
 * history, and filling it out of order would put last night's film above one
 * from a fortnight ago until the backlog cleared.
 */
const planInsert = (
  grid: MovieGrid,
  index: Map<number, FilmProgress>,
  facts: Map<number, FilmFacts | null>,
  onTab: Set<number>,
  plan: FilmPlan,
  demands: FilmDemand[],
  { timezone, ceiling }: { timezone: string; ceiling: number },
): void => {
  const missing = [...index.values()]
    .filter((film) => filmIsWatched(film) && !onTab.has(film.id))
    .sort((a, b) => {
      if (!a.watchedAt) return 1;
      if (!b.watchedAt) return -1;
      return Temporal.Instant.compare(a.watchedAt, b.watchedAt);
    });

  for (const film of missing) {
    const known = facts.get(film.id);

    if (known === null) {
      // Settled: TMDB has nothing for this film and never will, so the row
      // cannot be built. Named once rather than demanded every poll.
      plan.notes.push(`${film.title} (${film.id}) has no TMDB record, so its row has to be added by hand`);
      continue;
    }
    if (known === undefined) {
      if (film.tmdbId === null) {
        plan.skips.push({ code: 'not-in-tmdb', row: null, reason: `${film.title}: SIMKL carries no TMDB id for this film` });
        continue;
      }
      demands.push({ id: film.id, tmdbId: film.tmdbId, title: film.title });
      plan.skips.push({ code: 'awaiting-lookup', row: null, reason: `${film.title}: waiting on TMDB before its row can be built` });
      continue;
    }

    const watched = watchSerial(film.watchedAt, timezone);
    if (watched === null || !plausibleSerial(watched, ceiling)) {
      // An epoch stamp is SIMKL's "watched, never dated". A row dated 1970
      // is worse than no row, and there is nothing to fall back to.
      plan.skips.push({
        code: 'unusable-value',
        row: null,
        reason: `${film.title}: its watch date is ${film.watchedAt ? 'outside the range this column accepts' : 'missing'}`,
      });
      continue;
    }

    // One per run. A second would land a row high, because plan indices are
    // pre-write and `insertDimension` applies cumulatively.
    if (plan.insert) {
      plan.deferredInserts += 1;
      continue;
    }
    plan.insert = buildInsert(grid, film, known, watched, timezone);
  }

  if (plan.deferredInserts) {
    plan.notes.push(`${plan.deferredInserts} more film(s) need a row; one is inserted per run`);
  }
};

const buildInsert = (
  grid: MovieGrid,
  film: FilmProgress,
  facts: FilmFacts,
  watched: number,
  timezone: string,
): FilmRowInsert => {
  // Below the last row the tab uses, so nothing shifts under an existing
  // index. `inheritFromBefore` on the request is what carries the number
  // formats down: the blank rows past the data have a different date format on
  // `Watch Date` and none at all on `Release Date`, so a serial written into
  // one renders as `28486`.
  const row = (grid.rows.at(-1)?.row ?? 0) + 1;
  const note = `${film.title} (${film.id})`;
  const fill: FilmCellEdit[] = [
    fillCell(grid, row, 'Name', str(film.title), note),
    fillCell(grid, row, 'Watch Date', num(watched), note),
    // Text, matching what all 348 rows hold. A number here would compare
    // unequal to every other id cell on the tab.
    fillCell(grid, row, 'id', str(String(film.id)), note),
  ];

  if (film.rating !== null && plausibleScore(film.rating)) fill.push(fillCell(grid, row, 'Score', num(film.rating), note));
  if (film.runtime !== null && plausibleRuntime(film.runtime)) fill.push(fillCell(grid, row, 'Runtime', num(film.runtime), note));

  // Only ever `true`. The tab spells "no" as an absent cell, never as FALSE.
  const watchedOn = film.watchedAt ? plainDateIn(film.watchedAt, timezone) : null;
  if (watchedInCinema(facts.openedInCinemas, watchedOn)) fill.push(fillCell(grid, row, 'Cinema', bool(true), note));

  if (facts.genre) fill.push(fillCell(grid, row, 'Genre', str(facts.genre), note));
  if (facts.genres) fill.push(fillCell(grid, row, 'Genres', str(facts.genres), note));
  if (facts.certificate !== null) fill.push(fillCell(grid, row, 'Rating', num(facts.certificate), note));
  if (facts.releaseDate) fill.push(fillCell(grid, row, 'Release Date', num(serialOf(facts.releaseDate)), note));
  if (facts.franchise) fill.push(fillCell(grid, row, 'Franchise', str(facts.franchise), note));
  if (facts.director) fill.push(fillCell(grid, row, 'Director', str(facts.director), note));
  if (facts.banner) fill.push(fillCell(grid, row, 'Banner', str(facts.banner), note));

  return { row, id: film.id, title: film.title, fill, note: `add ${note}` };
};

// --- What survives ---------------------------------------------------------

const rendered = (value: ExtendedValue | undefined): string | null => {
  if (value === undefined) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.numberValue !== undefined) return String(value.numberValue);
  if (value.boolValue !== undefined) return String(value.boolValue);
  return value.formulaValue ?? null;
};

/**
 * A plan reduced to what survives the run, in the show half's shape — the
 * journal and the status page ask the same three questions of a films edit as
 * of a show one, and a second shape would be a second rendering path for no
 * gain. `season` is simply absent on a film row.
 */
export const filmPlanRecord = (plan: FilmPlan): PlanRecord => ({
  edits: plan.edits.map(({ address, field, note }) => ({ address, field, note })),
  inserts:
    plan.insert === null ? [] : [{ address: `row ${plan.insert.row + 1}`, title: plan.insert.title, note: plan.insert.note }],
});

export const describeFilmPlan = (plan: FilmPlan): string[] => [
  ...plan.edits.map((cell) => `  ${cell.address} ${cell.field} = ${rendered(cell.value) ?? '(blank)'} — ${cell.note}`),
  ...(plan.insert ? [`  insert row ${plan.insert.row + 1}: ${plan.insert.note} (${plan.insert.fill.length} cells)`] : []),
  ...plan.skips.map((s) => `  skipped (${s.code}): ${s.reason}`),
  ...plan.notes.map((n) => `  ${n}`),
];
