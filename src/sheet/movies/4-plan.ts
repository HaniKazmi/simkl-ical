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

import { config } from '../../shared/config.ts';
import { instantFrom, isoOf, plainDateIn } from '../../shared/dates.ts';
import type { ExtendedValue } from '../../api/google/types.ts';
import { isFormula } from '../2-grid.ts';
import {
  bank,
  dateSerial,
  maxSerial,
  movieKey,
  NOT_HELD,
  plausibleRuntime,
  plausibleSerial,
  recordedCount,
  recordedSerial,
  watchedNote,
  watchSerial,
  foldInto,
  recorded as recordedEntry,
  scratchRecording,
  type Baseline,
  type FilmRecord,
  type Recording,
} from '../values.ts';
import { movieAddress, movieCellAt, MOVIE_LABELS, nextFilmRow, type MovieGrid, type MovieHeaderName } from './2-grid.ts';
import { filmIsWatched, type FilmProgress } from './1-index.ts';
import type { FilmFacts } from './3-catalogue.ts';
import { compareWatched, type PlanRecord } from '../4-plan.ts';
// The budget arithmetic, not a guard rule: this half stops short of exactly the
// bound the guard refuses at, and a second copy of the counting is a plan
// refused whole over rows the planner thought it had room for.
import { admitPlan, admitTier, type Rationed } from '../guard-core.ts';
import { formatCell, plausibleReleaseSerial, plausibleScore, releaseCeiling, typeCell, watchedInCinema } from './values.ts';

// --- The plan --------------------------------------------------------------

export interface FilmCellEdit {
  /** Zero-based, in the snapshot the plan was built from. */
  row: number;
  column: number;
  /**
   * The SIMKL id of the film this write is *for*.
   *
   * Carried so the guard can re-derive that the row still holds that film. A
   * row index alone cannot be checked: every blank cell compares equal to
   * every other, so an edit aimed one row off lands on a cell whose `previous`
   * matches and passes alignment without anything noticing.
   */
  id: number;
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
  /** One row: the films tab is flat, so a film is a row and never a block. */
  rows: 1;
  id: number;
  title: string;
  /** No `previous`: the row did not exist. */
  fill: FilmCellEdit[];
  note: string;
}

export type FilmSkipCode = 'duplicate-id' | 'unknown-id' | 'unusable-value' | 'formula-cell' | 'awaiting-lookup' | 'unlinked-row';

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
  /**
   * Whether a film was ready to add and the poll's row budget had no room for
   * it. What the fetch loop stops on: with no room for a row, no pass can plan
   * the insert this loop otherwise stops at, and it would burst TMDB on every
   * pass to the ceiling for rows nothing can add.
   */
  insertHeld: boolean;
  /**
   * Work this run could have done and rationed — films ready for a row beyond
   * the one this run adds, and the rows the poll's budgets had no room for. A
   * lookup the fetch loop had no room for is its `unfetched`, which arms the
   * same retry.
   *
   * Held-back edits included, because the budgets are the **poll's**: the show
   * half runs first and what it sent is taken out of what this half may plan, so
   * a quiet films tab can still meet a full budget. Deferring them is safe for
   * the reason the show half's is — the record keeps a value unrecorded until
   * the write carrying it lands, so the next poll sees the same move — and the
   * alternative is a guard refusal, which is whole-plan and arms no retry. One
   * number either way, because the driver asks both halves the same question.
   */
  deferred: number;
}

export const emptyFilmPlan = (): FilmPlan => ({ edits: [], insert: null, insertHeld: false, skips: [], notes: [], deferred: 0 });

/**
 * Where one candidate's decisions land: the plan it adds to and the two maps
 * it banks and withdraws in. A target of its own, because the admission step
 * builds a candidate into one and keeps it only if the whole run still fits
 * the poll's budgets — the show half's `PlanRun`, less the inputs and the demands this
 * half asks for elsewhere.
 */
interface FilmTarget {
  plan: FilmPlan;
  keep: Recording;
}

/** One film to look up, and the title its answer is filed under. */
export interface FilmDemand {
  id: number;
  tmdbId: number;
  title: string;
}

export interface FilmPlanResult {
  plan: FilmPlan;
  demands: FilmDemand[];
  /**
   * Films the library gives no TMDB id, which no lookup can resolve. Settled
   * by the caller so the note above is written once rather than every poll.
   */
  unidentifiable: FilmProgress[];
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
  /**
   * Every SIMKL id the library holds, whatever its type.
   *
   * A row can hold a title this half does not index — an anime *special*, say,
   * which stays with the show half. Such a row is not unknown, and reporting
   * each as a skip every poll would bury the rows that really are unaccounted
   * for.
   */
  held?: Set<number>;
  /**
   * Every SIMKL id the show grid holds, or null when no show grid was parsed
   * this poll.
   *
   * An anime film may belong on this tab or embedded in a show-tab block, and
   * nothing in the record says which — so the sheet's own placement decides:
   * already on the show tab means leave it there. Null fails closed and inserts
   * no anime film at all, which costs one poll's delay on a newly-completed one
   * against a duplicate row that stands.
   */
  onShowGrid?: Set<number> | null;
  /**
   * Whether TMDB has rejected the credential this process. No lookup will be
   * answered, so the films waiting on one are named once rather than each
   * reported as waiting — and none is filed as a film TMDB has nothing for.
   */
  lookupsRejected?: boolean;
  /**
   * What the **poll** has left of each budget, not what the config allows: the
   * ceiling minus whatever the show half already sent. `SHEET_MAX_EDITS` and
   * `SHEET_MAX_ROWS` are a blast radius for one poll, so a planner reading the
   * config figure would let the two halves write twice it while each reported
   * itself inside budget.
   *
   * Read here so this half can stop short of them rather than be refused at
   * them. A refusal is whole-plan and arms no retry, so a films tab meeting a
   * budget the show half filled would write nothing and wait on the library's
   * next unrelated move; rationed, the same rows land a poll later.
   */
  maxEdits?: number;
  maxRows?: number;
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
export const FOLLOWED_FIELDS = ['Watch Date', 'Score', 'Runtime'] as const satisfies readonly (MovieHeaderName & keyof FilmRecord)[];

export type FollowedField = (typeof FOLLOWED_FIELDS)[number];

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

const edit = (
  grid: MovieGrid,
  row: number,
  id: number,
  field: MovieHeaderName,
  value: ExtendedValue | undefined,
  note: string,
): FilmCellEdit => {
  const column = grid.columns[field];
  return {
    row,
    column,
    id,
    field,
    previous: movieCellAt(grid, row, column)?.userEnteredValue,
    value,
    address: movieAddress(grid, row, field),
    note,
  };
};

/** A cell on a row that does not exist yet, so it has no `previous`. */
const fillCell = (grid: MovieGrid, row: number, id: number, field: MovieHeaderName, value: ExtendedValue, note: string): FilmCellEdit => ({
  row,
  column: grid.columns[field],
  id,
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
}

/**
 * The recorded watch date, keeping the three states apart.
 *
 * `recordedSerial` alone cannot: it answers null both for a value never
 * recorded and for one recorded as absent, and those pull opposite ways — the
 * first must write nothing, the second must write as soon as a date appears.
 * An unparseable entry reads as never recorded, which costs one silent
 * re-adopt and is the right direction for a file that decides whether cells
 * get written.
 */
const recordedDate = (recorded: string | undefined, timezone: string): number | null | undefined => {
  if (recorded === undefined) return undefined;
  if (recorded === NOT_HELD) return null;
  return recordedSerial(recorded, timezone) ?? undefined;
};

const compare = (field: FollowedField, film: FilmProgress, entry: FilmRecord, timezone: string): Comparison => {
  if (field === 'Watch Date') {
    return { wanted: watchSerial(film.watchedAt, timezone), recorded: recordedDate(entry['Watch Date'], timezone) };
  }
  return { wanted: field === 'Score' ? film.rating : film.runtime, recorded: recordedCount(entry[field]) };
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
  {
    now = Temporal.Now.instant(),
    timezone = config.timezone,
    baseline = new Map(),
    seed,
    held,
    onShowGrid = null,
    lookupsRejected = false,
    maxEdits = config.sheetMaxEdits,
    maxRows = config.sheetMaxRows,
  }: PlanFilmsOptions = {},
): FilmPlanResult => {
  const plan = emptyFilmPlan();
  const demands: FilmDemand[] = [];
  // Copied, so a discarded pass leaves no withdrawals in the caller's seed.
  const observed: Baseline = new Map(seed ?? observeFilms(index));
  const writing: Baseline = new Map();
  const ceiling = maxSerial(now, timezone);
  // `spent` is zero because what this planner was handed is already the ceiling
  // minus what the show half sent — see `PlanFilmsOptions.maxEdits`.
  const budgets = { maxEdits, maxRows, spent: { edits: 0, rows: 0 } };
  const room = `this poll has room for ${maxEdits} edit(s) across ${maxRows} row(s)`;

  /**
   * The films half's admission step: a candidate built into a target of its
   * own and taken through `admitPlan` only if the whole run still fits the
   * poll's remaining budgets. What this half merges beyond the plan is what the
   * candidate banked.
   *
   * `observed` is shared with the run rather than scratched, so a rejected
   * row's withdrawals stick: what its build banked is gone from the record,
   * which is exactly the state that makes the next poll see the value as moved.
   * `writing` is fresh, so nothing a rejected row banked is recorded when the
   * batch lands.
   */
  const admit = (build: (out: FilmTarget) => void): boolean => {
    const scratch: FilmTarget = { plan: emptyFilmPlan(), keep: scratchRecording({ observed, writing }) };
    build(scratch);
    if (!admitPlan(plan, scratch.plan, budgets, (insert) => insert)) return false;
    foldInto(writing, scratch.keep.writing);
    return true;
  };

  const skip = (code: FilmSkipCode, row: number | null, reason: string): void => {
    plan.skips.push({ code, row, reason });
  };

  // One candidate per row, so the up-to-three cells a film's row gains are
  // admitted or held back together: a row half written is a row whose remaining
  // fields are recorded as moved and never written.
  const rows: Rationed<FilmTarget>[] = [];

  for (const row of grid.rows) {
    if (row.id === null) continue;

    if (grid.duplicates.has(row.id)) {
      skip('duplicate-id', row.row, `SIMKL id ${row.id} is on more than one row, so which one holds that film is a coin toss`);
      continue;
    }
    const film = index.get(row.id);
    if (!film) {
      // Held under another type — an anime special, say — is not unknown, and
      // the row is simply not this half's to touch.
      if (!held?.has(row.id)) {
        skip('unknown-id', row.row, `SIMKL id ${row.id} is in no list at all, so nothing upstream describes this row`);
      }
      continue;
    }

    const key = movieKey(film.id);
    const entry = recordedEntry(baseline, key) ?? {};

    rows.push({
      write: ({ plan: into, keep: banking }) => {
        for (const field of FOLLOWED_FIELDS) {
          const { wanted, recorded } = compare(field, film, entry, timezone);

          // A first sighting: recorded by the seed, written nothing. This is what
          // keeps the sync to changes from here on rather than a reconciliation of
          // every standing mismatch.
          if (recorded === undefined) continue;
          if (recorded === wanted) continue;

          // SIMKL dropped a value it used to hold. Nothing on this tab is ever
          // emptied, so this is recorded and left: the cell keeps what it has.
          if (wanted === null) {
            into.skips.push({
              code: 'unusable-value',
              row: row.row,
              reason: `${film.title}: SIMKL no longer holds a ${MOVIE_LABELS[field]}, and this tab empties no cell`,
            });
            continue;
          }
          if (!withinBounds(field, wanted, ceiling)) {
            into.skips.push({
              code: 'unusable-value',
              row: row.row,
              reason: `${film.title}: ${MOVIE_LABELS[field]} of ${wanted} is outside the range this column accepts`,
            });
            continue;
          }
          const cell = movieCellAt(grid, row.row, grid.columns[field]);
          if (isFormula(cell)) {
            into.skips.push({
              code: 'formula-cell',
              row: row.row,
              reason: `${movieAddress(grid, row.row, field)} is a formula, so the sync leaves it alone`,
            });
            continue;
          }

          // Both sides as a reader would write them — a date in the viewer's zone,
          // not the serial the cell holds — the way the show grid's note reads.
          const before =
            field === 'Watch Date' ? watchedNote(instantFrom(entry[field]), timezone) : recorded === null ? null : String(recorded);
          const after = field === 'Watch Date' ? watchedNote(film.watchedAt, timezone) : String(wanted);
          into.edits.push(edit(grid, row.row, film.id, field, num(wanted), `${film.title}: ${MOVIE_LABELS[field]} moved from ${before ?? 'none'} to ${after}`));
          bank(banking, key, field, field === 'Watch Date' ? isoOf(film.watchedAt as Temporal.Instant) : String(wanted));
        }
      },
    });
  }

  // The followed cells first, then the run's one insert: a row already on the
  // tab carries a value that moved upstream today, where a film with no row
  // waits on nothing but another poll.
  admitTier(plan, rows, admit, (count) => `${count} film row(s) whose values moved wait for a later poll — ${room}`);

  const unidentifiable: FilmProgress[] = [];
  planInsert(grid, index, facts, onShowGrid, plan, demands, unidentifiable, {
    timezone,
    ceiling,
    releaseTo: releaseCeiling(now, timezone),
    lookupsRejected,
    admit,
    room,
  });

  return { plan, demands, unidentifiable, observed, writing };
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
  onShowGrid: Set<number> | null,
  plan: FilmPlan,
  demands: FilmDemand[],
  unidentifiable: FilmProgress[],
  {
    timezone,
    ceiling,
    releaseTo,
    lookupsRejected,
    admit,
    room,
  }: {
    timezone: string;
    ceiling: number;
    releaseTo: number;
    lookupsRejected: boolean;
    /** The caller's admission step: the row lands only if the poll still has budget for it. */
    admit: (build: (out: FilmTarget) => void) => boolean;
    /** What a budget deferral says about the room this poll had. */
    room: string;
  },
): void => {
  const onTab = new Set(grid.rows.flatMap((row) => (row.id === null ? [] : [row.id])));
  // Rows the sync cannot match by id, by name. A row someone typed by hand
  // carries a title and no id yet, and inserting a second row for that film
  // beneath it is the one thing the parse keeping such rows is meant to
  // prevent — but ids are what rows are matched by, so the name is the only
  // handle. A heuristic, so a film it holds back is reported rather than
  // silently dropped: a hand row titled "Dune" holds back every film of that
  // title until its id is typed, and only the report says so.
  const namedOnTab = new Map(
    grid.rows.flatMap((row) => (row.id === null && row.name !== null ? [[row.name.trim().toLowerCase(), row.row] as const] : [])),
  );

  // Everything past this filter reports: a film reaching the loop below with no
  // TMDB id is either named in a note or handed to the caller, which warns. So
  // a film this tab is not taking is excluded *here* rather than inside — else
  // the show half's "add it by hand" line is not removed but merely moved.
  const missing = [...index.values()]
    .filter((film) => filmIsWatched(film) && !onTab.has(film.id) && !(film.anime && (onShowGrid === null || onShowGrid.has(film.id))))
    .sort((a, b) => compareWatched(a.watchedAt, b.watchedAt, a.id - b.id));

  // The declared grid has to have a row to give, and that is a fact about the
  // grid, so it is asked once and before any lookup: a full tab is a standing
  // state until someone extends it, and paying TMDB for rows that cannot be
  // built would cost a burst of lookups every poll for as long as it stands.
  // Declined here rather than left for the guard for the reason the release
  // date is: a guard refusal is whole-plan, so a full tab would stop every
  // followed-column edit on every other row, on every poll.
  if (missing.length && nextFilmRow(grid) >= grid.snapshot.rowCount) {
    plan.notes.push(`the films tab has no row left for ${missing.length} film(s), ${missing[0]?.title} (${missing[0]?.id}) first; add rows to the tab`);
    return;
  }

  let awaitingCredential = 0;
  // Films ready for a row past the one this run takes, counted apart from the
  // plan's own total: that total also carries the rows the budget held back and
  // the lookups the run did not make, and the note below names only the
  // one-per-run rule.
  let behind = 0;
  let noRoom = 0;
  let awaiting = 0;
  let awaitingFirst: FilmProgress | undefined;
  for (const film of missing) {
    const heldBy = namedOnTab.get(film.title.trim().toLowerCase());
    if (heldBy !== undefined) {
      plan.skips.push({
        code: 'unlinked-row',
        row: heldBy,
        reason: `${film.title} (${film.id}): row ${heldBy + 1} holds that title and no id; type the id to link it, or it is never filled in`,
      });
      continue;
    }

    // Asked before any lookup, because no lookup changes it. An epoch stamp is
    // SIMKL's "watched, never dated"; a row dated 1970 is worse than no row,
    // and there is nothing to fall back to.
    const watched = watchSerial(film.watchedAt, timezone);
    if (watched === null || !plausibleSerial(watched, ceiling)) {
      plan.skips.push({
        code: 'unusable-value',
        row: null,
        reason: `${film.title}: its watch date is ${film.watchedAt ? 'outside the range this column accepts' : 'missing'}`,
      });
      continue;
    }

    const known = facts.get(film.id);
    if (known === null) {
      // Settled: TMDB has nothing for this film and never will, so the row
      // cannot be built. Named once rather than demanded every poll.
      plan.notes.push(`${film.title} (${film.id}) has no TMDB record, so its row has to be added by hand`);
      continue;
    }
    if (known === undefined) {
      if (film.tmdbId === null) {
        // Handed to the caller, which reports it once. No note here: the
        // planner runs several passes a poll and every poll, and this film is
        // re-examined each time — cheaply, since it is never looked up.
        unidentifiable.push(film);
        continue;
      }
      if (lookupsRejected) {
        awaitingCredential += 1;
        continue;
      }
      // Every one, uncapped: how many of them one pass fetches is the fetch
      // loop's question, and a film asked for and not fetched is what arms the
      // retry there. Counted rather than skipped one by one, because a cold
      // store holds every film on the tab and a line per film is a report
      // nobody reads.
      demands.push({ id: film.id, tmdbId: film.tmdbId, title: film.title });
      awaiting += 1;
      awaitingFirst ??= film;
      continue;
    }

    // One per run. A second would land a row high, because plan indices are
    // pre-write and `insertDimension` applies cumulatively.
    if (plan.insert) {
      plan.deferred += 1;
      behind += 1;
      continue;
    }
    // Through admission like every edit above: the row is the poll's, not this
    // tab's, and a plan over the budget is refused *whole* — losing the followed
    // cells beside it and arming no retry. Held back, the same film lands on the
    // poll that has room.
    //
    // Every film behind a held one meets the same full budget, so those are
    // counted rather than built — and counted rather than walked away from,
    // because everything above this point still runs for them: the lookup a
    // film needs is the next poll's to have ready, and a film with no TMDB
    // record or an unlinked row is reported whether or not this poll had room.
    if (noRoom === 0) {
      const built = buildInsert(grid, film, known, watched, timezone, releaseTo);
      if (admit(({ plan: into }) => void (into.insert = built))) continue;
      plan.notes.push(`${film.title} (${film.id}) is ready to add — deferred, ${room}`);
    }
    plan.deferred += 1;
    noRoom += 1;
  }

  if (behind) {
    plan.notes.push(`${behind} more film(s) need a row; one is inserted per run`);
  }
  if (noRoom > 1) {
    plan.notes.push(`${noRoom - 1} more film(s) need a row and wait with it`);
  }
  if (awaiting) {
    plan.notes.push(`${awaiting} film(s) wait on TMDB before a row can be built, ${awaitingFirst?.title} (${awaitingFirst?.id}) first`);
  }
  plan.insertHeld = noRoom > 0;
  if (awaitingCredential) {
    plan.notes.push(`${awaitingCredential} film(s) need a TMDB lookup and TMDB rejected the credential; fix TMDB_API_KEY and restart`);
  }
};

const buildInsert = (
  grid: MovieGrid,
  film: FilmProgress,
  facts: FilmFacts,
  watched: number,
  timezone: string,
  releaseTo: number,
): FilmRowInsert => {
  // Below the last row the tab uses, so nothing shifts under an existing
  // index. `inheritFromBefore` on the request is what carries the number
  // formats down: the blank rows past the data have a different date format on
  // `Watch Date` and none at all on `Release Date`, so a serial written into
  // one renders as `28486`.
  const row = nextFilmRow(grid);
  const note = `${film.title} (${film.id})`;
  const watchedOn = film.watchedAt ? plainDateIn(film.watchedAt, timezone) : null;
  const fill: FilmCellEdit[] = [
    fillCell(grid, row, film.id, 'Name', str(film.title), note),
    fillCell(grid, row, film.id, 'Watch Date', num(watched), note),
    // Text, matching what all 366 rows hold. A number here would compare
    // unequal to every other id cell on the tab.
    fillCell(grid, row, film.id, 'id', str(String(film.id)), note),
    // Both columns are filled on every row the tab holds, so both are written
    // unconditionally: a blank here is an unfinished row, not a "no", and
    // neither cell is ever revisited to say so later.
    fillCell(grid, row, film.id, 'Format', str(formatCell(watchedInCinema(facts.openedInCinemas, watchedOn))), note),
    fillCell(grid, row, film.id, 'Type', str(typeCell(film.anime)), note),
  ];

  if (film.rating !== null && plausibleScore(film.rating)) fill.push(fillCell(grid, row, film.id, 'Score', num(film.rating), note));
  if (film.runtime !== null && plausibleRuntime(film.runtime)) fill.push(fillCell(grid, row, film.id, 'Runtime', num(film.runtime), note));

  if (facts.genre) fill.push(fillCell(grid, row, film.id, 'Genre', str(facts.genre), note));
  if (facts.genres) fill.push(fillCell(grid, row, film.id, 'Genres', str(facts.genres), note));
  if (facts.certificate !== null) fill.push(fillCell(grid, row, film.id, 'Rating', num(facts.certificate), note));
  // Declined here rather than left for the guard: a guard refusal is
  // whole-plan, so one film with an unreadable release date would stop every
  // other film being added for as long as it stayed in the library.
  const released = facts.releaseDate ? dateSerial(facts.releaseDate) : null;
  if (released !== null && plausibleReleaseSerial(released, releaseTo)) fill.push(fillCell(grid, row, film.id, 'Release Date', num(released), note));
  if (facts.franchise) fill.push(fillCell(grid, row, film.id, 'Franchise', str(facts.franchise), note));
  if (facts.director) fill.push(fillCell(grid, row, film.id, 'Director', str(facts.director), note));
  if (facts.banner) fill.push(fillCell(grid, row, film.id, 'Banner', str(facts.banner), note));

  return { row, rows: 1, id: film.id, title: film.title, fill, note: `add ${note}` };
};

// --- What survives ---------------------------------------------------------

/**
 * A plan reduced to what survives the run, in the show half's shape — the
 * journal and the status page ask the same three questions of a films edit as
 * of a show one, and a second shape would be a second rendering path for no
 * gain. `season` is simply absent on a film row.
 */
export const filmPlanRecord = (plan: FilmPlan): PlanRecord => ({
  edits: plan.edits.map(({ address, field, note }) => ({ address, field: MOVIE_LABELS[field], note })),
  inserts:
    plan.insert === null ? [] : [{ address: `row ${plan.insert.row + 1}`, title: plan.insert.title, note: plan.insert.note }],
});

export const describeFilmPlan = (plan: FilmPlan): string[] => [
  // The note carries both sides of the move as a reader would write them, so
  // the cell's own value — a date serial — would only repeat it less legibly.
  ...plan.edits.map((cell) => `  edit   ${cell.address.padEnd(7)} ${cell.note}`),
  ...(plan.insert ? [`  insert row ${plan.insert.row + 1}: ${plan.insert.note} (${plan.insert.fill.length} cells)`] : []),
  ...plan.skips.map((s) => `  skipped (${s.code}): ${s.reason}`),
  ...plan.notes.map((n) => `  ${n}`),
];
