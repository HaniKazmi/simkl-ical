/**
 * The sheet's value conventions — how a date, a runtime, a genre and a whole
 * show row become cells — one copy for planner, guard and the test fixture.
 *
 * The bounds matter most. Refusal is whole-plan, so a planner value the guard
 * rejects stops every unrelated edit for as long as the bad row sits inside
 * the activity window. One copy of each bound makes that gap unrepresentable.
 *
 * The vocabularies below the bounds are shared by both tabs for the same
 * reason, one step further out: the films tab's genre and certificate sets are
 * the show tab's conditional-format sets, so two copies would be two closed
 * sets drifting apart with nothing to notice.
 */

import { columnLetter, isBlank, isFormula } from './2-grid.ts';
import { instantFrom, plainDateFrom, plainDateIn } from '../shared/dates.ts';
import type { ColumnMap, HeaderName } from './2-grid.ts';
import type { CellData } from '../api/google/types.ts';

/** Sheets counts days from 1899-12-30. */
const SHEET_EPOCH = Temporal.PlainDate.from('1899-12-30');

/**
 * Days since the sheet epoch for a local calendar date. Both operands are
 * `PlainDate` — no zone, no hour, nothing to round or come out fractional.
 */
export const dateSerial = (date: Temporal.PlainDate): number => SHEET_EPOCH.until(date, { largestUnit: 'day' }).days;

/**
 * The inverse: the calendar date a serial stands for. Null for anything that
 * is not a finite number, and for a number no date can stand for — a pasted
 * epoch-millisecond timestamp is a serial of 1.7e12, and `PlainDate` throws
 * past ±271,821 years rather than wrapping. A cell the sync would leave alone
 * must not be able to take a page down.
 */
export const serialDate = (serial: number | null | undefined): Temporal.PlainDate | null => {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null;
  try {
    return SHEET_EPOCH.add({ days: Math.floor(serial) });
  } catch {
    return null;
  }
};

/**
 * The sheet serial for a watch timestamp, in the viewer's zone — never
 * `iso.slice(0, 10)`, which lands a US evening broadcast on the next day.
 * Returns null rather than throwing; the planner never throws.
 */
export const watchSerial = (at: Temporal.Instant | null | undefined, timezone: string): number | null =>
  at ? dateSerial(plainDateIn(at, timezone)) : null;

/** No serial the sync writes is plausibly before this. */
export const MIN_SERIAL = dateSerial(plainDateFrom('2000-01-01'));

/**
 * Whether a serial is one the sync could have meant, between the floor above
 * and a ceiling the caller computes with `maxSerial`. Every date the sync
 * writes is checked against this pair, whichever column it lands in.
 */
export const plausibleSerial = (serial: number | null | undefined, ceiling: number): boolean =>
  typeof serial === 'number' && serial >= MIN_SERIAL && serial <= ceiling;

/**
 * A season row's `Note`: when it was last watched, as text.
 *
 * Text rather than a serial, because `Note` is a text column — a serial there
 * renders as `46265`, and giving the write a number format would mean sending
 * `fields` beyond `userEnteredValue`, which is what keeps every hand-set format
 * on the sheet intact.
 */
export const watchedNote = (at: Temporal.Instant | null | undefined, timezone: string): string | null =>
  at ? plainDateIn(at, timezone).toString() : null;

/** Exactly what `watchedNote` produces, and nothing a hand types loosely. */
const WATCHED_NOTE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The serial a `Note` cell's text stands for, or null where the cell holds
 * anything else.
 *
 * This is what separates the sync's own note from a hand-typed one, and both
 * the planner and the guard ask it before overwriting or clearing the cell: a
 * note the user typed is theirs, and the row closes around it rather than
 * through it.
 */
export const watchedNoteSerial = (text: string | null | undefined): number | null => {
  if (!text || !WATCHED_NOTE.test(text)) return null;
  try {
    return dateSerial(plainDateFrom(text));
  } catch {
    // A well-shaped string can still name no date — `2025-02-31`.
    return null;
  }
};

/**
 * Whether the sync may put its note in this cell: **blank, or holding a note of
 * its own**. The `Note` column on a season row is otherwise free space, and
 * what a reader typed there is not reconstructible, so the row closes around a
 * hand-typed note rather than through it.
 *
 * A formula is declined by the same predicate: `text` is the cell's *result*,
 * so a formula rendering a date would read as the sync's own note. The guard
 * refuses a formula target unconditionally and refusal is whole-plan, so one
 * such cell would stop every unrelated edit for as long as its row sits inside
 * the activity window.
 *
 * One copy for planner and guard, like the bounds above: a planner that widened
 * what counts as its own and a guard that did not would refuse whole plans over
 * rows the planner thought were fine.
 */
export const ownsNote = (cell: CellData | undefined, text: string | null | undefined): boolean =>
  !isFormula(cell) && (isBlank(cell) || watchedNoteSerial(text) !== null);

/**
 * The guard's ceiling on a date serial: tomorrow, in the viewer's zone.
 * Computed in UTC it is a day late for anyone behind UTC, so the bound would
 * be two days wide and pass serials the sync should never write.
 */
export const maxSerial = (now: Temporal.Instant, timezone: string): number => dateSerial(plainDateIn(now, timezone).add({ days: 1 }));

/**
 * The bounds of a runtime, in minutes: one whole minute to under a day. Both
 * tabs' runtime columns hold whole minutes and check against these, so a bound
 * exists once — a film or an episode under a minute or a day long is a payload
 * error, not a running time.
 */
export const MIN_RUNTIME_MINUTES = 1;
export const MAX_RUNTIME_MINUTES = 1440;

/**
 * What the guard checks a planned runtime cell against, on either tab.
 * `runtimeMinutes` cannot produce a value this refuses.
 */
export const plausibleRuntime = (minutes: number): boolean =>
  Number.isInteger(minutes) && minutes >= MIN_RUNTIME_MINUTES && minutes < MAX_RUNTIME_MINUTES;

/**
 * A measured runtime → the whole minutes a runtime cell holds, or null where
 * that is not a length anything has.
 *
 * Rounded for SIMKL's show-wide figure: `averageRuntime` is whole already,
 * and the fallback beside it is whatever SIMKL sends. The floor is checked on
 * the raw figure, before rounding, so anything under a minute is refused
 * rather than rounded up to one — the fail-closed direction, since a blank
 * cell is the state a later poll can still fill.
 */
export const runtimeMinutes = (minutes: number | null | undefined): number | null => {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < MIN_RUNTIME_MINUTES) return null;
  const whole = Math.round(minutes);
  return plausibleRuntime(whole) ? whole : null;
};

// --- Following SIMKL --------------------------------------------------------

/**
 * The fields that follow SIMKL: written whenever the value the sync last
 * recorded has moved, on an open row or a dated one alike.
 *
 * One set rather than a policy enum, because there is exactly one question a
 * caller asks — **may this field be written on a row that already has an end
 * date**. "Never written" and "written once into a blank cell" are not two
 * further states of that question but the absence of it, and the rules that
 * separate them already exist in the shape they need: a field the sync may not
 * write is absent from the guard's `EDIT_FIELDS`, and write-once *is* the blank
 * check in `checkRuntimeEdit`. Re-encoding either here would put a second copy
 * of it in the file whose whole purpose is that there is one.
 *
 * Widening this set is the intended way to make another field follow SIMKL.
 * What it costs is a guard rule for the new field and an entry in the planner's
 * observation, not a change to the stored shape.
 */
const TRACKED = ['Start', 'End'] as const;

/** A column that follows SIMKL. The planner keys its table on this, so a field added here and not taught to the planner is a compile error rather than a guard that quietly stops refusing. */
export type TrackedField = (typeof TRACKED)[number];

/** What the planner walks; `isTracked` is the membership test the guard asks. */
export const TRACKED_FIELDS: readonly TrackedField[] = TRACKED;

export const isTracked = (field: HeaderName): field is TrackedField => (TRACKED as readonly HeaderName[]).includes(field);

/**
 * What one row's recorded upstream values look like, keyed by column name.
 *
 * Keys are text rather than either tab's header union: one file holds both
 * tabs' history — a second file would cost a second load, a second save and a
 * second chance to record a value the sheet never received — and the key
 * namespaces say which tab an entry belongs to. Each planner reads its own
 * columns off an entry and never the other's.
 */
export type BaselineEntry = Partial<Record<string, string>>;

/**
 * What SIMKL last said, per row. Keyed by identity rather than by row index:
 * rows shift under an insert, and a key that moved would compare one row
 * against another's history.
 */
export type Baseline = Map<string, BaselineEntry>;

/** The key both the planner and the store use. */
export const seasonKey = (id: number, season: number): string => `${id}:${season}`;

/**
 * The films tab's key. Prefixed rather than bare, because a film's id and a
 * show's id come from the same SIMKL numbering: `53078` alone would be a
 * season key with its season missing, and the two would silently share an
 * entry the day one collided.
 */
export const MOVIE_PREFIX = 'movie:';

export const movieKey = (id: number): string => `${MOVIE_PREFIX}${id}`;

/**
 * The serial a recorded value stands for — the stored ISO instant, rendered in
 * the viewer's zone exactly as the current one is.
 *
 * Rendering *both* sides is what makes the comparison mean "would the cell
 * change", which is the only question worth writing for. A scrobbler restamping
 * an episode moves `lastWatchedAt` by seconds and moves nothing the sheet can
 * show, so comparing instants would plan a write on every poll. It also keeps a
 * `TZ` change silent, because the recorded instant re-renders in the new zone
 * beside the current one — where storing the rendered day instead would make
 * every row whose watch crosses midnight there differ at once, and there is no
 * adopt-on-differ path to absorb them.
 *
 * Null for absent, and for a stored value that no longer parses. Both mean the
 * same thing to a caller — nothing to compare against, so record and write
 * nothing — and a corrupt entry costing one silent re-adopt is the right
 * direction for a file that decides whether cells get written.
 */
export const recordedSerial = (recorded: string | null | undefined, timezone: string): number | null =>
  watchSerial(instantFrom(recorded), timezone);

// --- Artwork links -----------------------------------------------------------

/**
 * What both tabs call the artwork column. One copy, because the films grid
 * resolves it as a field and the artwork page resolves it on the show tab by
 * label alone.
 */
export const ARTWORK_LABEL = 'Artwork';

/**
 * Where both tabs' artwork lives. An `Artwork` cell holds a public object URL
 * on this host, and the site uses the cell verbatim as an image source.
 */
export const ARTWORK_HOST = 'https://storage.googleapis.com';

/**
 * An object's key for a title: the title, exactly. No trim, no case-fold, no
 * normalisation — the show tab's 291 formula cells build the link by
 * concatenating a literal bucket prefix with the title cell, and the objects
 * behind them are named the same way, so any rule but identity would break the
 * link between a key derived here and one the sheet already holds.
 */
export const artworkKeyFor = (title: string): string => title;

/**
 * The static link the sheet holds for a key. Only `%`, `#` and `?` are
 * escaped: `#` and `?` end the path in any URL parser and `%` would start an
 * escape, so those three cannot survive literally, while a space or a `/` is
 * something every browser encodes on its own — and encoding them here would
 * make the link differ from the formula's output for the same key, so that a
 * row written by hand and one written by the sync could point at one object
 * two ways.
 */
export const artworkLink = (bucket: string, key: string): string => `${ARTWORK_HOST}/${bucket}/${key.replace(/[%#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

/**
 * The key a cell's link addresses, or null where it links anything else.
 *
 * The cell decides the key, not the title: 18 show rows hold a hand-written
 * link where the name breaks a URL (`3%` → `3%25`, `Fate/Apocrypha` → `Fate
 * Apocrypha`) or the object was named with a typo the cell reproduces, and
 * every one of them serves an image today. A link on another host, or under
 * another bucket, is not this bucket's and answers null; so does a remainder
 * that does not percent-decode, since no key can be recovered from it.
 */
export const artworkKeyOf = (url: string | null | undefined, bucket: string): string | null => {
  const prefix = `${ARTWORK_HOST}/${bucket}/`;
  if (!url || !url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  if (rest === '') return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
};

// --- Vocabularies both tabs share -------------------------------------------

/**
 * The renderer's closed set of genres. A value outside it colours as nothing
 * on either tab, so the guard refuses one rather than letting it reach the
 * sheet.
 *
 * One set for films and shows because it *is* one set: the twelve words are
 * the show tab's conditional-format vocabulary and the films tab's alike, and
 * a second copy would be a second closed set free to drift.
 *
 * `Abstract` is in the vocabulary and nothing maps to it: no TMDB or TVDB
 * genre means it, and no row uses it. It stays hand-only.
 */
export const GENRE_VOCABULARY = [
  'Abstract',
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Fantasy',
  'Horror',
  'Mystery',
  'Romance',
  'Sci-Fi',
  'Thriller',
  'True Story',
] as const;

const VOCABULARY = new Set<string>(GENRE_VOCABULARY);

export const isGenre = (value: string): boolean => VOCABULARY.has(value);

/**
 * Either tab holds at most three secondary genres — measured, with no row
 * carrying four. A title mapping to more is truncated rather than refused: the
 * extras are the least significant in the upstream's own ordering.
 */
export const MAX_SECONDARY_GENRES = 3;

/** The `Genres` cell: the secondaries, comma-separated the way both tabs spell it. */
export const genresCell = (secondary: readonly string[]): string => secondary.join(', ');

/**
 * The `Certificate` column is the BBFC certificate as a minimum age. `12A` and
 * `12` are the same age; the letters differ only in whether an adult must come
 * too.
 *
 * Agrees with 332 of the 338 film rows TMDB carries a GB certificate for, and
 * with 161 of the 189 show blocks; 10 of those blocks have no GB rating at all
 * and stay blank.
 */
export const CERTIFICATE_AGES: Record<string, number> = { U: 3, PG: 7, '12A': 12, '12': 12, '15': 15, '18': 18 };

const CERTIFICATES = new Set<number>([3, 7, 12, 15, 18]);

export const isCertificate = (value: number): boolean => CERTIFICATES.has(value);

/**
 * TVDB's genre names onto the vocabulary. Anything absent is dropped.
 *
 * `Documentary` → `True Story` is the one rename that is not a spelling, and
 * it is the rename the films map already makes.
 *
 * `History` is dropped for the reason the films map drops it: it is fiction as
 * often as fact — a series set in the past carries it beside one that
 * happened — and nothing in the payload separates the two.
 *
 * `Animation`, `Anime`, `Crime`, `Mini-Series`, `Family`, `Children`, `War`,
 * `Western`, `Martial Arts`, `Sport`, `Musical`, `Soap`, `Reality`, `Talk
 * Show`, `Game Show`, `Travel` and `Food` are dropped because the vocabulary
 * has nowhere to put them.
 */
const TVDB_GENRES: Record<string, string> = {
  Action: 'Action',
  Adventure: 'Adventure',
  Comedy: 'Comedy',
  Documentary: 'True Story',
  Drama: 'Drama',
  Fantasy: 'Fantasy',
  Horror: 'Horror',
  Mystery: 'Mystery',
  Romance: 'Romance',
  'Science Fiction': 'Sci-Fi',
  Suspense: 'Thriller',
  Thriller: 'Thriller',
};

/**
 * TVDB's list, mapped and deduped, **in the order TVDB sent it** — which is
 * TVDB's own genre-id order on all 189 show records measured (Science Fiction
 * 2, Horror 6, Drama 12, Crime 14, Comedy 15, Documentary 16, Adventure 18,
 * Action 19, Fantasy 21, Suspense 22, Thriller 24, Romance 27, Mystery 31).
 * A fixed priority rather than a per-series judgement, and it is close to the
 * priority the tab itself picks by: the first survivor reproduces 128 of 189
 * primaries, where every TMDB-ordered rule measured reaches 108 to 120.
 *
 * The first survivor is the block's `Genre` and the rest are its `Genres` —
 * the shape `mappedGenres` gives a film, with TVDB as the ordered source.
 */
export const mappedTvdbGenres = (names: readonly string[]): string[] => {
  const out: string[] = [];
  for (const name of names) {
    const mapped = TVDB_GENRES[name];
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
};

/**
 * How the `Network` column spells a broadcaster SIMKL names differently. An
 * absent entry is the identity: the map holds only the names that disagree.
 *
 * The four BBC channels collapse because the column names the broadcaster, not
 * the channel; `STARZ` and `FOX` are the same name in the tab's own casing;
 * `HBO Max` and `Max` are both HBO, which is what the tab files those titles
 * under. Through this map SIMKL's `network` agrees with 185 of the 189 blocks
 * measured — the same 185 TVDB's `originalNetwork` gives, where TMDB gives 144.
 */
const NETWORKS: Record<string, string> = {
  'BBC One': 'BBC',
  'BBC Two': 'BBC',
  'BBC Three': 'BBC',
  'BBC Four': 'BBC',
  STARZ: 'Starz',
  FOX: 'Fox',
  'HBO Max': 'HBO',
  Max: 'HBO',
  'CBS All Access': 'CBS',
  'Paramount+ with Showtime': 'Paramount+',
  'AMC+': 'AMC',
};

/** The `Network` cell for an upstream name, or null where there is no name to write. */
export const networkCell = (name: string | null | undefined): string | null => {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return NETWORKS[trimmed] ?? trimmed;
};

// --- The show row a block insert writes --------------------------------------

/**
 * How the `Type` column spells a series. Lowercase, as every show row on the
 * tab holds it, and beside the films tab's `film`/`anime` so a reader
 * filtering on `anime` gets both.
 *
 * Only `show` is ever written: an anime block uses the cour model, where a new
 * cour is a separate SIMKL title, so the sync inserts no anime block.
 */
export const SHOW_TYPE = 'show';

/**
 * The `Status` column's closed set — the five values the 189 blocks hold.
 * `Cancelled` is never produced by `deriveStatus`, because SIMKL cannot tell
 * "axed" from "ended"; it is in the vocabulary because the tab holds it, and a
 * value the guard refuses is a value the sheet cannot keep.
 */
export const STATUS_VOCABULARY = ['Ended', 'Abandoned', 'Cancelled', 'Up To Date', 'Watching'] as const;

const STATUSES = new Set<string>(STATUS_VOCABULARY);

export const isStatus = (value: string): boolean => STATUSES.has(value);

/**
 * The show-row cells that roll up from the season rows beneath them. Every one
 * is a formula, which is why the batch that creates a block is the single
 * exception to never writing one: it writes the formula that will do the
 * rolling up, and nothing revisits the cell afterwards.
 */
const ROLLUP = ['Season', 'Episode', 'Start', 'End', 'Note'] as const;

/** A show-row roll-up column. `showRowFormulas` answers a `Record` over this, so a sixth field is a compile error rather than a cell silently left blank. */
export type RollupField = (typeof ROLLUP)[number];

export const ROLLUP_FIELDS: readonly RollupField[] = ROLLUP;

/**
 * How far down the block-height helper looks for the next show row. Part of
 * the one formula shape all 309 blocks carry, so it is the sheet's number
 * rather than a choice made here: a different value in a new row's formula
 * would count a block's height by a different rule than every row above it.
 */
const BLOCK_SCAN_ROWS = 40;

/**
 * The five roll-up formulas for a show row, in the live text — one shape on
 * all 309 blocks.
 *
 * `row` is zero-based and the A1 number in the formula is one higher. Every
 * column letter comes off the *resolved* map rather than a literal, because
 * columns are resolved by label and the user rearranges them: a hardcoded `$O`
 * would go on counting a block's height off whatever column now sits there,
 * and the four cells that read it would be quietly wrong for the life of the
 * row.
 *
 * `Note` is the helper the other four read — the number of season rows under
 * this one — which is why it appears inside each of them.
 */
export const showRowFormulas = (columns: ColumnMap, row: number): Record<RollupField, string> => {
  const n = row + 1;
  const at = (field: HeaderName): string => `$${columnLetter(columns[field])}${n}`;
  const height = at('Note');
  return {
    Season: `=IF(${height}=0,"",OFFSET(${at('Season')},${height},0))`,
    Episode: `=IF(${height}=0,"",SUM(OFFSET(${at('Episode')},1,0,${height})))`,
    Start: `=IF(${height}=0,"",LET(r,OFFSET(${at('Start')},1,0,${height}),IF(COUNT(r)=0,"",MIN(r))))`,
    End: `=IF(${height}=0,"",LET(r,OFFSET(${at('End')},1,0,${height}),IF(COUNT(r)=0,"",MAX(r))))`,
    Note: `=IFERROR(MATCH("*",OFFSET(${at('Show')},1,0,${BLOCK_SCAN_ROWS}),0)-1,COUNTA(OFFSET(${at('Season')},1,0,${BLOCK_SCAN_ROWS})))`,
  };
};

/**
 * The `Artwork` cell a new show row takes: the static link for whatever the
 * title cell beside it holds, as a formula rather than a literal.
 *
 * The formula is the shape 291 of the 309 rows carry, and `artworkLink`
 * produces its output byte for byte for the same title — so `artworkKeyOf` and
 * the artwork page read a row the sync wrote and one written by hand the same
 * way. The reference is relative, so Sheets rewrites it under a later insert,
 * which is exactly the case the verifier compares formulas for still being
 * formulas rather than for their text.
 */
export const artworkFormula = (showColumn: number, row: number, bucket: string): string =>
  `=CONCAT("${ARTWORK_HOST}/${bucket}/",${columnLetter(showColumn)}${row + 1})`;

// --- Where a block goes ------------------------------------------------------

/**
 * The `Title` cell for an upstream title: the title minus one trailing
 * ` (US)`/` (UK)`. The marker is SIMKL's way of separating two records of one
 * name, and the block holding one of them needs no disambiguation from a
 * remake that is not on the tab.
 *
 * Those two suffixes exactly, and case-sensitively: `V (2009)` is a title the
 * tab holds verbatim, and a rule loose enough to take a parenthesised year
 * would take it too.
 *
 * The rule reproduces 166 of the 189 titles the tab holds exactly; `titleKey`
 * below is what covers the rest.
 */
export const titleCell = (title: string): string => title.replace(/ \((?:US|UK)\)$/, '').trim();

/**
 * The `Franchise` cell for a title: the title minus one leading article.
 *
 * That reproduces 247 of the 309 blocks — 215 where the franchise is the title
 * exactly, and 32 more where it is the title minus its article. The other 62
 * are hand judgements no rule reaches (`Agatha Christie`, `DC`, `Arthurian`),
 * so a new block lands one cell short of right rather than in the wrong place.
 *
 * The article has to be a whole word: `Theodore` starts with `The` and is not
 * an article away from `odore`.
 */
export const franchiseKeyFor = (title: string): string =>
  title
    .trim()
    .replace(/^(?:the|an|a)\s+/i, '')
    .trim();

/**
 * How two franchises sort — the tab's own order, and the order a new block is
 * placed in.
 *
 * The locale is pinned rather than left to the host's: a Mac and the container
 * image do not default to the same one, and a comparator that changes under
 * the process would place a block where the guard then re-derives a different
 * row.
 *
 * Under exactly these options all 309 blocks are in order, with no inversions.
 * Both options earn their place: `sensitivity: 'base'` alone puts `13 Reasons
 * Why` before `3%`, one inversion, and `numeric` is what settles it; adding
 * `ignorePunctuation` introduces five.
 */
export const compareFranchise = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

/**
 * The key that decides whether the tab already holds a title — the same
 * normalisation placement uses, case-folded.
 *
 * The tab's titles differ from SIMKL's by a leading article, a `(US)` suffix
 * and casing: 162 of 189 agree with the raw title and 183 under this key. A
 * hand-typed block `Last Of Us` has to hold `The Last of Us` back, and what a
 * false match costs is one note asking for the id, where a missed one costs a
 * duplicate block.
 */
export const titleKey = (title: string): string => franchiseKeyFor(titleCell(title)).toLowerCase();

/**
 * What placement needs of a block, structurally: a parsed `ShowBlock`
 * satisfies it, and so does a guard's own re-derivation built from less.
 */
export interface PlaceableBlock {
  row: number;
  title: string;
  /** The `Franchise` cell's text, where the tab carries that column. */
  franchise?: string | null;
  seasons: readonly { row: number }[];
}

/**
 * The franchise a block sorts under: its own cell, and the title rule where
 * the cell is blank or the column is not on the tab. A blank cell sorts the
 * block where its title puts it, which is where the reader left it.
 */
export const blockFranchise = (block: PlaceableBlock): string => block.franchise ?? franchiseKeyFor(block.title);

/** The last row a block occupies: its final season row, or the show row itself for a block with none. */
export const blockEnd = (block: PlaceableBlock): number => block.seasons.at(-1)?.row ?? block.row;

/**
 * The row a new block's show row goes on, or null when the tab holds no block
 * to place it against.
 *
 * Three rules in order, and the first is why this is a walk rather than a
 * binary search: a block sharing a franchise goes **after the last** block of
 * it, because within a franchise the tab's order is loose — 15 inversions
 * across 309 blocks — so no comparison can find a position inside the group.
 * Failing that the block goes above the first franchise that sorts after it,
 * and failing that below everything.
 *
 * The row is pre-write, like every other plan index.
 */
export const placeBlock = (blocks: readonly PlaceableBlock[], franchise: string): number | null => {
  const last = blocks.at(-1);
  if (!last) return null;
  let sameFranchise: PlaceableBlock | undefined;
  for (const block of blocks) if (compareFranchise(blockFranchise(block), franchise) === 0) sameFranchise = block;
  if (sameFranchise) return blockEnd(sameFranchise) + 1;
  const after = blocks.find((block) => compareFranchise(blockFranchise(block), franchise) > 0);
  return after ? after.row : blockEnd(last) + 1;
};
