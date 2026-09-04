/**
 * The films tab's value conventions — one copy for the planner and the guard.
 *
 * Everything here answers "what does this column hold", and every rule was
 * measured against the 348 rows the tab already carries. Where a rule cannot
 * reproduce those rows it says so and says by how much: they are hand
 * curation, and the point is that a new row lands somewhere sensible, not that
 * history is reproduced.
 */

import { plainDateIn, releaseDate } from '../../shared/dates.ts';
import { dateSerial } from '../values.ts';
import type { TmdbBackdrop, TmdbMovie, TmdbRelease } from '../../api/tmdb/types.ts';

// --- Genres ----------------------------------------------------------------

/**
 * The renderer's closed set. A value outside it colours as nothing, so the
 * guard refuses one rather than letting it reach the sheet.
 *
 * `Abstract` is in the vocabulary and nothing maps to it: no TMDB genre means
 * it, and no row on the tab uses it. It stays hand-only.
 */
const GENRE_VOCABULARY = [
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

/**
 * TMDB's nineteen film genres onto ours. Anything absent is dropped.
 *
 * `Documentary` is the one rename that is not a spelling: all three
 * documentaries on the tab are filed `True Story`, and they are also the only
 * films the map would otherwise leave with no genre at all.
 *
 * `History` is *not* mapped, though 8 of the 10 films carrying it are filed
 * `True Story` — 1917 and The Other Boleyn Girl are fiction set in the past,
 * and nothing in the payload separates those from Oppenheimer. It could not
 * pick a primary in any case: TMDB never lists `History` first.
 *
 * `Animation`, `Crime`, `Family`, `Music`, `TV Movie`, `War` and `Western` are
 * dropped because the vocabulary has nowhere to put them.
 */
const TMDB_GENRES: Record<string, string> = {
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
  Thriller: 'Thriller',
};

/**
 * The tab holds at most three secondary genres — measured, with no row
 * carrying four. A film mapping to more is truncated rather than refused: the
 * extras are the least significant in TMDB's own ordering.
 */
export const MAX_SECONDARY_GENRES = 3;

export const isGenre = (value: string): boolean => VOCABULARY.has(value);

/**
 * TMDB's list, mapped and deduped, **in TMDB's own order** — which is
 * significance order, and the reason this reads TMDB rather than SIMKL, whose
 * genres arrive sorted alphabetically with that signal gone.
 *
 * The first survivor is the row's `Genre` and the rest are its `Genres`. That
 * reproduces 45% of the tab's existing primaries; no rule does better, because
 * they are judgements — a fixed priority order tuned against the data reaches
 * 67%, and 11 of 87 primaries are not in TMDB's mapped list at all.
 */
export const mappedGenres = (movie: TmdbMovie | undefined): string[] => {
  const out: string[] = [];
  for (const genre of movie?.genres ?? []) {
    const mapped = genre.name ? TMDB_GENRES[genre.name] : undefined;
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
};

/** The `Genres` cell: the secondaries, comma-separated the way the tab spells it. */
export const genresCell = (secondary: readonly string[]): string => secondary.join(', ');

// --- Release dates and the cinema window -----------------------------------

const THEATRICAL = 3;
const LIMITED = 2;
const DIGITAL = 4;

const releasesIn = (movie: TmdbMovie | undefined, country: string): TmdbRelease[] =>
  movie?.release_dates?.results?.find((group) => group.iso_3166_1 === country)?.release_dates ?? [];

/** The earliest date of one release type in one territory, as a `PlainDate`. */
const earliest = (releases: readonly TmdbRelease[], type: number): Temporal.PlainDate | null => {
  let best: Temporal.PlainDate | null = null;
  for (const release of releases) {
    if (release.type !== type) continue;
    // TMDB really carries partial dates like `2013-00-00`; `releaseDate`
    // answers null rather than throwing, and a film with only one of those
    // simply has no date here.
    const date = release.release_date ? releaseDate(release.release_date) : null;
    if (date === null) continue;
    if (best === null || Temporal.PlainDate.compare(date, best) < 0) best = date;
  }
  return best;
};

/**
 * The date the `Release Date` column holds: the theatrical release, GB before
 * US, falling back to a limited one in either. Matches 305 of 347 rows.
 *
 * Not TMDB's own `release_date` field, which is the film's earliest release
 * anywhere and matches only 80 — a US festival premiere for most of them.
 */
export const releaseDateOf = (movie: TmdbMovie | undefined): Temporal.PlainDate | null => {
  const gb = releasesIn(movie, 'GB');
  const us = releasesIn(movie, 'US');
  return (
    earliest(gb, THEATRICAL) ??
    earliest(us, THEATRICAL) ??
    earliest(gb, LIMITED) ??
    earliest(us, LIMITED) ??
    // A film that never opened in a cinema still has a release date, and this
    // column wants one for every film. Without this a streaming original — any
    // Netflix or Prime title, which TMDB carries as digital only — lands with a
    // certificate and a blank date, and the cell is never revisited.
    earliest(gb, DIGITAL) ??
    earliest(us, DIGITAL)
  );
};

/**
 * How long after a film opens a watch still counts as having been in a cinema.
 *
 * Every one of the 63 rows ticked `Cinema` was watched 0-39 days after the
 * theatrical release and none before it. Thirty days catches 60 of them and
 * mis-ticks 3; widening to 45 catches all 63 and mis-ticks 12, most of them
 * streaming-first titles watched in the first month.
 */
export const CINEMA_WINDOW_DAYS = 30;

/**
 * The day the film opened in GB cinemas, or null if it never did.
 *
 * A **GB theatrical** release specifically: no US fallback and no limited-run
 * fallback, both of which only add false ticks. A film with no date here never
 * opened in a cinema in this country, which is the fact that separates a
 * Netflix premiere watched on release week from a real cinema trip.
 *
 * Kept separate from `releaseDateOf`, which falls back until it finds
 * something: the `Release Date` column wants a date for every film, and this
 * wants the absence to survive.
 */
export const openedInCinemas = (movie: TmdbMovie | undefined): Temporal.PlainDate | null =>
  earliest(releasesIn(movie, 'GB'), THEATRICAL);

/** Whether a watch falls inside the window that film's opening opened. */
export const watchedInCinema = (
  opened: Temporal.PlainDate | null,
  watched: Temporal.PlainDate | null,
  windowDays: number = CINEMA_WINDOW_DAYS,
): boolean => {
  if (opened === null || watched === null) return false;
  // Days and below, so the span is exact and needs no `relativeTo` anchor.
  const since = opened.until(watched, { largestUnit: 'day' }).days;
  return since >= 0 && since <= windowDays;
};

// --- Certificate -----------------------------------------------------------

/**
 * The `Rating` column is the BBFC certificate as a minimum age. `12A` and `12`
 * are the same age; the letters differ only in whether an adult must come too.
 *
 * Agrees with 332 of the 338 rows TMDB carries a GB certificate for.
 */
const CERTIFICATE_AGES: Record<string, number> = { U: 3, PG: 7, '12A': 12, '12': 12, '15': 15, '18': 18 };

const CERTIFICATE_VALUES: readonly number[] = [3, 7, 12, 15, 18];

const RATINGS = new Set(CERTIFICATE_VALUES);

export const isCertificate = (value: number): boolean => RATINGS.has(value);

/**
 * The GB certificate, or null when TMDB carries none or one outside the BBFC
 * set. Null leaves the cell blank: a blank reads as unfinished, and a guessed
 * age does not.
 *
 * Preferred by release type, the way `releaseDateOf` picks a date, rather than
 * by position in the array. 166 of the 347 films on the tab carry more than one
 * GB certificate and 8 of those disagree — 28 Days Later lists 18 and 15, The
 * Silence of the Lambs 15 and 18 — usually a re-rating attached to a later
 * digital or physical release. TMDB contracts no ordering, so taking the first
 * made a write-once cell depend on the order a response happened to arrive in.
 */
export const certificateOf = (movie: TmdbMovie | undefined): number | null => {
  const releases = releasesIn(movie, 'GB');
  /**
   * The certificate on the *earliest* release of a type, which is the one
   * `releaseDateOf` dates the row from. Taking the first in the array instead
   * pairs one release's date with another's rating: 28 Days Later carries 18
   * theatrically and 15 on a later cut, and TMDB contracts no ordering.
   */
  const rated = (matches: (type: number | undefined) => boolean): number | null => {
    let best: { date: Temporal.PlainDate; age: number } | null = null;
    for (const release of releases) {
      if (!matches(release.type)) continue;
      const age = CERTIFICATE_AGES[release.certification?.trim() ?? ''];
      if (age === undefined) continue;
      const date = release.release_date ? releaseDate(release.release_date) : null;
      // Undated but rated still beats nothing, and loses to anything dated.
      if (date === null) best ??= { date: Temporal.PlainDate.from('9999-12-31'), age };
      else if (best === null || Temporal.PlainDate.compare(date, best.date) < 0) best = { date, age };
    }
    return best?.age ?? null;
  };
  const is = (want: number) => (type: number | undefined) => type === want;
  // Theatrical, then a limited run, then anything else that carries one —
  // including a release TMDB sends with no type at all.
  return rated(is(THEATRICAL)) ?? rated(is(LIMITED)) ?? rated(() => true);
};

// --- Director, franchise, banner -------------------------------------------

/**
 * The first credited director. Matches 324 of 347 rows; joining every director
 * with a comma instead drops that to 299, so the tab names one even where two
 * directed.
 */
export const directorOf = (movie: TmdbMovie | undefined): string | null =>
  movie?.credits?.crew?.find((member) => member.job === 'Director')?.name?.trim() || null;

/** `The Dark Knight Collection` and `Dark Knight` are the same franchise to a reader. */
const normaliseFranchise = (value: string): string =>
  value
    .replace(/\s+Collection$/i, '')
    .trim();

/**
 * The `Franchise` cell: TMDB's collection name with its ` Collection` suffix
 * removed, and the film's own title where TMDB knows no collection.
 *
 * Together those reproduce 221 of 347 rows — 108 of the 212 films that have a
 * collection, and 113 of the 135 that do not. The 104 that miss are one
 * systematic case rather than noise: the cell holds a studio or a universe
 * where TMDB holds a series, so Finding Nemo is filed `Pixar`, The Dark Knight
 * `DC`, and Stand by Me `Stephen King`. Nothing TMDB serves carries that, so a
 * franchise release lands here needing a one-cell correction.
 */
export const franchiseOf = (movie: TmdbMovie | undefined, title: string): string => {
  const collection = movie?.belongs_to_collection?.name?.trim();
  return collection ? normaliseFranchise(collection) : title;
};

/** The width every `image.tmdb.org` banner on the tab already uses. */
const BANNER_WIDTH = 'w1280';

/**
 * The highest-voted English backdrop.
 *
 * English specifically: a null-language backdrop is a frame carrying no text,
 * which is often a poster crop, and a foreign-language one carries the wrong
 * title across it. One film of 347 has no English backdrop, and that cell is
 * better left blank.
 *
 * Which backdrop is "the" one is not recoverable — the tab's existing TMDB
 * banners match today's top-voted English image on 40 of 161 rows, because
 * votes move. Highest-voted is a choice, not a derivation.
 */
export const bannerOf = (movie: TmdbMovie | undefined): string | null => {
  let best: TmdbBackdrop | undefined;
  for (const backdrop of movie?.images?.backdrops ?? []) {
    if (backdrop.iso_639_1 !== 'en' || !backdrop.file_path) continue;
    if (!best || (backdrop.vote_average ?? 0) > (best.vote_average ?? 0)) best = backdrop;
  }
  return best?.file_path ? `https://image.tmdb.org/t/p/${BANNER_WIDTH}${best.file_path}` : null;
};

// --- Bounds ----------------------------------------------------------------

/** SIMKL's own scale. A value off it is a payload the guard should refuse, not round. */
export const plausibleScore = (score: number): boolean => Number.isInteger(score) && score >= 1 && score <= 10;

/**
 * The `Runtime` column is whole minutes — the same bounds the show grid's
 * per-episode runtime uses, for the same reason: a film under a minute or over
 * a day is a payload error, not a film.
 */
export const plausibleRuntime = (minutes: number): boolean => Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;

/**
 * `Release Date` needs bounds of its own, at both ends.
 *
 * The floor is not `MIN_SERIAL` (2000-01-01), which is right for a *watch*
 * date — the sheet records nothing watched before then — and wrong for a
 * release: The Wizard of Oz sits on the tab at 1939 and Star Wars at 1977, and
 * South Park's 1999 is below it too. 1900 rather than something tighter
 * because the question is "is this a date at all", not "is this a plausible
 * film".
 *
 * The ceiling is not a watch date's either. A watch cannot be in the future; a
 * release can, and routinely is for a film seen at a preview or festival
 * screening before it opens here. Sharing the watch ceiling dropped that cell
 * silently, and `Release Date` is written once and never revisited, so the
 * blank was permanent. A decade is the same kind of bound as the floor: wide
 * enough that only a payload error crosses it.
 */
const MIN_RELEASE_SERIAL = dateSerial(Temporal.PlainDate.from('1900-01-01'));

const RELEASE_HORIZON_DAYS = 3653;

export const releaseCeiling = (now: Temporal.Instant, timezone: string): number =>
  dateSerial(plainDateIn(now, timezone).add({ days: RELEASE_HORIZON_DAYS }));

export const plausibleReleaseSerial = (serial: number | null | undefined, ceiling: number): boolean =>
  typeof serial === 'number' && serial >= MIN_RELEASE_SERIAL && serial <= ceiling;
