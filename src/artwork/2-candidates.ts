/**
 * CANDIDATES — an upstream's image listing, reduced to what the page offers.
 * Pure: an upstream's payload in, one candidate shape out, in the order the
 * page shows them.
 *
 * Films *filter* on shape: a film tile is 16:9, authored at that shape
 * upstream, so a backdrop of another shape would be cropped on display and is
 * not offered. Posters — a show's and a season's — are all offered, larger
 * first: TVDB authors them at 680×1000 and at an older 400×578, and the reader
 * would rather see a 400×578 than nothing. Books filter on a **window** rather
 * than a size: nothing authors a book cover to a standard, so the question is
 * not "is this the site's shape" but "is this the shape of a book at all".
 * Inside the window the shape tier reorders; outside it nothing is shown.
 *
 * The order is a starting point, not a verdict — the page exists because the
 * top-ranked image is the right one perhaps a third of the time.
 */

import type { HardcoverEditions } from '../api/hardcover/types.ts';
import type { TmdbImages } from '../api/tmdb/types.ts';
import type { TvdbArtwork, TvdbArtworksResponse, TvdbSeason, TvdbSeriesResponse } from '../api/tvdb/types.ts';

export interface Candidate {
  /** Full size, and what is downloaded on a pick. */
  url: string;
  /** What the page's tile shows. */
  thumb: string;
  width: number;
  height: number;
  /** The upstream's own ranking figure — TMDB's vote average, TVDB's score. */
  score: number;
  /** TMDB's vote count; null for TVDB, which has none. */
  votes: number | null;
  /** `en`, `eng`, or null for an image carrying no text. */
  language: string | null;
  /**
   * Where the edition was published, `gb` for the UK. Books only — TMDB and
   * TVDB publish nothing equivalent for an image, and a film's country is the
   * production's rather than the artwork's.
   */
  country: string | null;
  /**
   * `print`, `ebook` or `audio` — which edition this is the cover of. Books
   * only, shown beside the tile and never ranked on.
   */
  format: string | null;
  source: 'tmdb' | 'tvdb' | 'hardcover';
}

/** TMDB's CDN. `w1280` is the width every banner on the tab uses; `w300` is the tile. */
const TMDB_IMAGE = 'https://image.tmdb.org/t/p';
const TMDB_FULL = 'w1280';
const TMDB_THUMB = 'w300';

const FILM_RATIO = 16 / 9;
const RATIO_TOLERANCE = 0.01;

/** TVDB artwork type 2 is a series poster. */
export const TVDB_POSTER = 2;

/** TVDB artwork type 7 is a season poster. */
export const TVDB_SEASON_POSTER = 7;

const near = (ratio: number, target: number): boolean => Math.abs(ratio - target) <= RATIO_TOLERANCE;

/**
 * English backdrops first, ranked by how many people voted before how they
 * voted — ranked by average alone, a one-vote ten leads every list. Textless
 * backdrops (`null` language) follow, since a landscape tile can carry either
 * and the choice is the reader's.
 */
export const filmCandidates = (images: TmdbImages | undefined): Candidate[] => {
  const out: Candidate[] = [];
  for (const image of images?.backdrops ?? []) {
    if (!image.file_path || !image.width || !image.height) continue;
    if (image.iso_639_1 !== 'en' && image.iso_639_1 !== null && image.iso_639_1 !== undefined) continue;
    if (!near(image.width / image.height, FILM_RATIO)) continue;
    out.push({
      url: `${TMDB_IMAGE}/${TMDB_FULL}${image.file_path}`,
      thumb: `${TMDB_IMAGE}/${TMDB_THUMB}${image.file_path}`,
      width: image.width,
      height: image.height,
      score: image.vote_average ?? 0,
      votes: image.vote_count ?? 0,
      language: image.iso_639_1 ?? null,
      country: null,
      format: null,
      source: 'tmdb',
    });
  }
  return out.sort((a, b) => Number(b.language === 'en') - Number(a.language === 'en') || (b.votes ?? 0) - (a.votes ?? 0) || b.score - a.score || b.width - a.width);
};

/** A TVDB artwork carrying the three fields a candidate cannot do without. */
type SizedArtwork = TvdbArtwork & { image: string; width: number; height: number };

const posterCandidate = (art: SizedArtwork): Candidate => ({
  url: art.image,
  thumb: art.thumbnail ?? art.image,
  width: art.width,
  height: art.height,
  score: art.score ?? 0,
  votes: null,
  language: art.language ?? null,
  country: null,
  format: null,
  source: 'tvdb',
});

/**
 * English before any other language, then the larger image, then TVDB's
 * score. Other languages are offered rather than dropped because for an anime
 * the Japanese poster is often the only one there is, and a Japanese release
 * often carries an English logo; the choice is the reader's.
 *
 * Size is a tier rather than a filter: a season's posters are 400×578 more
 * often than 680×1000 (1,904 of 2,828 measured), and a season whose only
 * English poster is the smaller one still gets offered it. Compared by area,
 * so a portrait of another shape cannot outrank a larger one by being taller.
 */
const comparePosters = (a: Candidate, b: Candidate): number =>
  Number(b.language === 'eng') - Number(a.language === 'eng') || b.width * b.height - a.width * a.height || b.score - a.score || a.url.localeCompare(b.url);

/** The posters in a listing that are of the wanted type and carry a usable size. */
const postersOf = (artworks: TvdbArtworksResponse | undefined, type: number): SizedArtwork[] =>
  (artworks?.data?.artworks ?? []).filter((art): art is SizedArtwork => Boolean(art.image && art.width && art.height) && art.type === type);

/** A series' posters, every one TVDB lists, in the order above. */
export const showCandidates = (artworks: TvdbArtworksResponse | undefined): Candidate[] => postersOf(artworks, TVDB_POSTER).map(posterCandidate).sort(comparePosters);

/**
 * One heading in a series' season panel: one season in one ordering, or the
 * series' own posters.
 */
export interface PosterGroup {
  /**
   * `official:3`, `dvd:3`, `series` — what a season row names as the group it
   * opens on. An ordering and a number together, because a number alone names
   * a season in each of TVDB's orderings at once.
   */
  key: string;
  /** What the panel heads the group with: `Season 3`, `Specials`, `DVD Order season 3`, `Series posters`. */
  label: string;
  /** TVDB's default poster for the season, when it names one: the URL of one of `candidates`. */
  preferred: string | null;
  candidates: Candidate[];
}

/** Everything a season panel offers from one TVDB series. */
export interface SeriesPosters {
  tvdbId: number;
  /** TVDB's name for the series, which for an anime is often Japanese. */
  name: string | null;
  groups: PosterGroup[];
}

const OFFICIAL = 'official';

/**
 * A group's key, its heading, and where it sits in the panel: aired order
 * first, by number, with the specials after the numbered seasons rather than
 * before them; then every other ordering, by name and number; then posters on
 * a season TVDB does not number. The series' own posters come last.
 */
const describeGroup = (season: TvdbSeason | undefined): { key: string; label: string; rank: [number, string, number] } => {
  const order = season?.type?.type;
  const number = season?.number;
  if (order === undefined || number === undefined) return { key: 'unnumbered', label: 'Seasons TVDB does not number', rank: [3, '', 0] };
  if (order !== OFFICIAL) return { key: `${order}:${number}`, label: `${season?.type?.name ?? order} season ${number}`, rank: [2, order, number] };
  return number === 0 ? { key: `${OFFICIAL}:0`, label: 'Specials', rank: [1, '', 0] } : { key: `${OFFICIAL}:${number}`, label: `Season ${number}`, rank: [0, '', number] };
};

/**
 * A series' season posters grouped by the season TVDB files each under, and
 * its series posters as a group of their own. Every poster TVDB lists is in
 * one group; each group is in poster order.
 *
 * The groups are keyed by ordering as well as number. A series carries a
 * season list per ordering — Doctor Who's 374 season posters hang off 42
 * seasons, 892 of the 2,828 measured on DVD-order seasons — and a DVD season
 * 3 is a different set of episodes from an aired season 3.
 */
export const seasonPosters = (
  tvdbId: number,
  { seasons, posters, series }: { seasons: TvdbSeriesResponse | undefined; posters: TvdbArtworksResponse | undefined; series: TvdbArtworksResponse | undefined },
): SeriesPosters => {
  const byId = new Map((seasons?.data?.seasons ?? []).flatMap((s) => (s.id === undefined ? [] : [[s.id, s] as const])));
  const groups = new Map<string, { group: PosterGroup; rank: [number, string, number] }>();
  for (const art of postersOf(posters, TVDB_SEASON_POSTER)) {
    const season = art.seasonId === undefined ? undefined : byId.get(art.seasonId);
    const { key, label, rank } = describeGroup(season);
    let entry = groups.get(key);
    if (!entry) {
      entry = { group: { key, label, preferred: season?.image ?? null, candidates: [] }, rank };
      groups.set(key, entry);
    }
    entry.group.candidates.push(posterCandidate(art));
  }
  const ordered = [...groups.values()]
    .sort(({ rank: [ra, oa, na] }, { rank: [rb, ob, nb] }) => ra - rb || oa.localeCompare(ob) || na - nb)
    .map(({ group }) => {
      group.candidates.sort(comparePosters);
      // A default TVDB names but does not list is no default the panel can show.
      if (group.preferred !== null && !group.candidates.some((c) => c.url === group.preferred)) group.preferred = null;
      return group;
    });
  const own = showCandidates(series);
  if (own.length) ordered.push({ key: 'series', label: 'Series posters', preferred: null, candidates: own });
  return { tvdbId, name: seasons?.data?.name ?? null, groups: ordered };
};

/**
 * Which group a season row opens on, or null to open none. A suggestion of
 * where to look, never a pick: a wrong one costs a click.
 *
 * - A specials row (`7.5`) opens the series' specials, the only season 0
 *   holds; TVDB files every special there rather than between seasons.
 * - A row of the block's own series opens the aired season with its number.
 *   That is the row's number addressing a TVDB season, which holds for 211 of
 *   216 numbered season rows sampled.
 * - A row of another series — one carrying its own SIMKL id that maps
 *   elsewhere, Doctor Who's S14 or Persona 4's *the Golden* — opens by its
 *   place among the block's rows of that series: the first is that series'
 *   season 1. Its number counts the block's seasons, not that series'.
 *   Where that series has no such season it opens on the series' own
 *   posters, which for a row of its own series are its season's: *the
 *   Golden* has no season posters on TVDB, and two series posters.
 */
export const groupToOpen = (
  { season, sameSeries, ordinal }: { season: number; sameSeries: boolean; ordinal: number },
  groups: readonly PosterGroup[],
): string | null => {
  const has = (key: string): boolean => groups.some((g) => g.key === key);
  const want = !Number.isInteger(season) ? `${OFFICIAL}:0` : sameSeries ? `${OFFICIAL}:${season}` : `${OFFICIAL}:${ordinal}`;
  if (has(want)) return want;
  return !sameSeries && has('series') ? 'series' : null;
};

/**
 * Where each season row of a block finds its posters: the TVDB series its row
 * belongs to, and the group it opens on. `series` is each row's series in tab
 * order, null where none is known; `blockSeries` is the block's own.
 *
 * A row of another series is placed by its count among the block's numbered
 * rows of that series — Doctor Who's S14 and S15 are the 2023 series' first
 * and second — and a specials row counts for nothing there, being no season
 * of anything.
 */
export const placeSeasons = (
  rows: readonly { season: number; series: number | null }[],
  blockSeries: number | null,
  groupsOf: (tvdbId: number) => readonly PosterGroup[],
): Map<number, { tvdbId: number | null; open: string | null }> => {
  const placed = new Map<number, { tvdbId: number | null; open: string | null }>();
  const counted = new Map<number, number>();
  for (const { season, series } of rows) {
    if (series === null) {
      placed.set(season, { tvdbId: null, open: null });
      continue;
    }
    const ordinal = (counted.get(series) ?? 0) + (Number.isInteger(season) ? 1 : 0);
    counted.set(series, ordinal);
    placed.set(season, { tvdbId: series, open: groupToOpen({ season, sameSeries: series === blockSeries, ordinal }, groupsOf(series)) });
  }
  return placed;
};

/**
 * A book cover is 2:3, which in the height-over-width the window and the tile
 * both speak is 1.50 — the shape 241 of the 401 rows on the tab already hold.
 */
const BOOK_IDEAL_RATIO = 1.5;

/**
 * How far from 1.50 a cover may be and still count as the right shape.
 *
 * Bucketed rather than scored, because a score orders every candidate
 * completely and no tier below it could then fire — and the trade a score
 * forces has to be made somewhere: measured, it takes a 1465×2625 (1.79) over
 * a 333×500 (1.50) for God Emperor of Dune.
 *
 * The band is symmetric but the window is not, so in practice only the tall
 * side is ever demoted: the filter below already excludes everything under
 * 1.40, and 1.40 is inside this band. That is a property of the two numbers,
 * not a second rule — widen the window and this band demotes both ends.
 */
const BOOK_SHAPE_NEAR = 0.1;

/**
 * The window a cover has to be in to be offered at all, as height ÷ width —
 * the form the tile prints, where 2:3 reads as 1.50.
 *
 * A filter, where the tier above only reorders. Outside this the image is not
 * a cover of this book: a square is an audiobook's, a landscape one is a
 * spread or a banner, and offering either invites picking it. The cost is real
 * and is the point — a book whose editions carry nothing inside the window
 * gets an empty strip and is left alone, where a demotion would have offered
 * something wrong.
 */
const BOOK_MIN_RATIO = 1.4;
const BOOK_MAX_RATIO = 1.7;

const shaped = (width: number, height: number): boolean => {
  const ratio = height / width;
  return ratio >= BOOK_MIN_RATIO && ratio <= BOOK_MAX_RATIO;
};

/**
 * Hardcover serves no thumbnail variant, and a strip of covers at up to 2400px
 * is tens of megabytes. The tile goes through the same public image proxy the
 * tab's own cells already use, at twice the tile's CSS width — 18.9 kB against
 * a 1600px original's 142 kB. The full-size `url` stays the raw asset, because
 * the download on a pick is server-side and needs no proxy.
 *
 * The page's CSP is `img-src 'self' https:`, which admits it, and the route's
 * `Referrer-Policy: no-referrer` is what keeps the feed token out of the
 * proxy's logs.
 */
const WSRV = 'https://wsrv.nl/';
const BOOK_THUMB_WIDTH = 272;

/**
 * The one part of size that still decides anything. Resolution is not a
 * preference here — between two covers a reader can see, the larger file is
 * the same artwork scanned bigger — but below this a cover is a placeholder
 * rather than a choice: it is upscaled even in the 272px strip, and 300 is
 * where the tab's own covers begin, 263 of the 401 sitting in the 300–399 band.
 *
 * Demoted rather than dropped, because a book whose covers are *all* small
 * still needs a strip: they share one tier and the rest of the order decides.
 *
 * It sits above the country tier because that tier is a preference between two
 * usable covers. Without it a UK 128×196 leads a US 347×500 — measured on 2 of
 * 35 books, Lirael and Sir Thursday among them — which is not what preferring a
 * UK edition was meant to buy.
 */
const BOOK_MIN_WIDTH = 300;

const usableTier = (width: number): number => (width >= BOOK_MIN_WIDTH ? 0 : 1);

/**
 * Dropped by URL suffix rather than by content type, because the page never
 * fetches the bytes to find out. A `.tiff` serves `image/tiff`, which passes
 * `fetchImage`'s `image/*` check and would upload happily — and then no `<img>`
 * in Chrome or Firefox renders it, so the tile is blank in the strip and the
 * cover is blank on the site. One in 247 candidates measured. The proxy above
 * is not a way out: asked for that file it answers `image/tiff` too.
 */
const UNRENDERABLE = /\.tiff?(?:[?#]|$)/i;

const languageTier = (code: string | null): number => (code === 'en' ? 0 : code === null ? 1 : 2);

const shapeTier = (width: number, height: number): number => (Math.abs(height / width - BOOK_IDEAL_RATIO) <= BOOK_SHAPE_NEAR ? 0 : 1);

/**
 * The shelf is a UK one, so a UK edition's cover is the one the book was
 * bought as. Binary rather than a three-way `gb`/absent/rest: ranked three
 * ways, an edition with no country recorded outranks a US one, and since `us`
 * is 164 of 229 candidates that demotes the majority below unknowns — measured,
 * it cost a 331×500 for a 262×400 and a 962×1347 for a 348×500.
 */
const countryTier = (code: string | null): number => (code === 'gb' ? 0 : 1);

/**
 * Hardcover's `reading_formats`: 1 Read, 2 Listened, 3 Both, 4 Ebook. Shown on
 * the tile, never ranked on — a paperback and an ebook of one edition often
 * carry the same picture, and which of them a cover came from is context for
 * the reader rather than a reason to prefer it.
 */
const FORMAT_OF: Record<number, string> = { 1: 'print', 2: 'audio', 3: 'print', 4: 'ebook' };

/** A candidate plus the figures its order is made of, so the sort reads as its own rule. */
interface RankedCover {
  candidate: Candidate;
  language: number;
  shape: number;
  usable: number;
  country: number;
}

/**
 * The reader's priority order, as tiers rather than one weighted number.
 *
 * 1. **English.** A cover carrying its title in another language is the wrong
 *    cover for this shelf however good the picture is.
 * 2. **Shape**, bucketed, ordering what survived the window: nearest 2:3
 *    first, then the taller end of what is allowed.
 * 3. **Big enough to be a cover at all**, per `usableTier`.
 * 4. **The UK edition.** A US cover of the same book is a different picture,
 *    and 5 of 10 books measured had a `gb` edition to prefer.
 * 5. **How many readers hold that edition**, the closest thing Hardcover
 *    publishes to a judgement about a cover.
 *
 * **Resolution is deliberately not a tier.** Between two covers a reader can
 * see, the larger file is not the better picture — it is usually the same
 * artwork scanned at a different size — and ranking on it puts a 1707×2560 that
 * three readers hold above the edition three hundred of them read.
 * `usableTier` keeps the one part of size that is a real question: whether the
 * image is big enough to be a cover at all.
 *
 * That leaves readers deciding inside a tier, which is why the shape question
 * stays **bucketed**. Scored, it would order every candidate completely and no
 * tier below it could ever fire.
 *
 * The URL is the stable tail. Two covers equal on everything above must come
 * back in the same order every time, or the strip reshuffles under the reader
 * between two opens of one row.
 */
const compareCovers = (a: RankedCover, b: RankedCover): number =>
  a.language - b.language ||
  a.shape - b.shape ||
  a.usable - b.usable ||
  a.country - b.country ||
  (b.candidate.votes ?? 0) - (a.candidate.votes ?? 0) ||
  a.candidate.url.localeCompare(b.candidate.url);

export const bookCandidates = (editions: HardcoverEditions | undefined): Candidate[] => {
  // Keyed on the image URL, which dedupes two things at once: an edition
  // returned by both orderings, and two different editions reusing one cover.
  // Keyed on the edition id it would catch only the first, and the strip would
  // show the same picture twice.
  const seen = new Map<string, RankedCover>();
  for (const edition of [...(editions?.byUsers ?? []), ...(editions?.byWidth ?? [])]) {
    const url = edition?.image?.url;
    const width = edition?.image?.width;
    const height = edition?.image?.height;
    if (!url || !width || !height) continue;
    if (UNRENDERABLE.test(url)) continue;
    if (!shaped(width, height)) continue;

    const language = edition.language?.code2 ?? null;
    const country = edition.country?.code2 ?? null;
    const ranked: RankedCover = {
      candidate: {
        url,
        thumb: `${WSRV}?url=${encodeURIComponent(url)}&w=${BOOK_THUMB_WIDTH}`,
        width,
        height,
        // Hardcover publishes no rating for a cover, only a count of the
        // readers whose edition it is — the mirror of TVDB, which publishes a
        // score and no count.
        score: 0,
        votes: edition.users_count ?? 0,
        language,
        country,
        format: edition.reading_format_id === undefined ? null : (FORMAT_OF[edition.reading_format_id] ?? null),
        source: 'hardcover',
      },
      language: languageTier(language),
      shape: shapeTier(width, height),
      usable: usableTier(width),
      country: countryTier(country),
    };

    // One picture is one tile, and the tile is the best edition carrying it —
    // decided by the same comparator that orders the strip. Merging fields
    // instead would build an edition that does not exist: a country from one,
    // a reader count from another, and a badge naming neither.
    const already = seen.get(url);
    if (!already || compareCovers(ranked, already) < 0) seen.set(url, ranked);
  }
  return [...seen.values()].sort(compareCovers).map((ranked) => ranked.candidate);
};
