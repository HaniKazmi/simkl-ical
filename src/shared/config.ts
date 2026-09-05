import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// Node 20.6+ loads .env with --env-file; doing it here keeps `node src/x.ts`
// working without the flag.
//
// Unconditional: `loadEnvFile` leaves existing environment variables alone,
// and a guard on any one variable would skip the whole file — FEED_TOKEN,
// SHEET_ID, TZ — for an environment that sets that one.
try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../.env'));
} catch {
  // No .env — rely on real environment variables (the container case).
}

/**
 * An integer from the environment, clamped to a sensible range.
 *
 * Unclamped these break quietly — a negative GRACE_DAYS empties the feed, a
 * zero interval is a tight loop against the CDN. Out-of-range corrects rather
 * than throws: a running feed beats a container that will not boot.
 */
const int = (value: string | undefined, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number => {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

/**
 * The same, as a duration.
 *
 * The environment still speaks milliseconds — `ACTIVITIES_POLL_MS=1800000` is
 * in the README and `.env.example`, and an ISO-8601 duration there would be a
 * breaking change for no gain.
 *
 * Built from milliseconds alone: no years, months or weeks, so `compare`,
 * `total` and `round` need no `relativeTo` anchor.
 */
const ms = (value: string | undefined, fallback: number, range: { min?: number; max?: number } = {}): Temporal.Duration =>
  Temporal.Duration.from({ milliseconds: int(value, fallback, range) });

/**
 * A value from a closed set, falling back rather than throwing — same posture
 * as `int`. No enum: Node strips the types, and an enum is not erasable
 * syntax.
 */
const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T => {
  const candidate = value?.trim().toLowerCase();
  return allowed.find((a) => a === candidate) ?? fallback;
};

/** A switch from the environment: `1`, `true` or `yes`, and off for anything else. */
const flag = (value: string | undefined): boolean => ['1', 'true', 'yes'].includes(value?.trim().toLowerCase() ?? '');

/**
 * `~/x` → `$HOME/x`. A shell expands this, but a value from `.env` or a
 * compose file arrives verbatim — and `.env.example` suggests a `~/` path for
 * the credential, which would otherwise ENOENT once per sheet run.
 */
const expandHome = (path: string): string => (path === '~' || path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path);

/**
 * The version from package.json, which the Dockerfile copies into the image —
 * it is needed at runtime for "type": "module" anyway.
 */
const packageVersion = (): string => {
  try {
    const raw = readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
};

/**
 * `report` plans and logs without writing; `apply` writes. Unrecognised
 * clamps to `report`, never `apply`: a typo must yield an inert run, not an
 * unintended one.
 */
export type SheetSyncMode = 'off' | 'report' | 'apply';

const SHEET_SYNC_MODES: readonly SheetSyncMode[] = ['off', 'report', 'apply'];

export interface Config {
  clientId: string | undefined;
  feedToken: string | undefined;
  timezone: string;
  dataDir: string;
  releaseCountry: string;
  port: number;
  graceDays: number;
  appName: string;
  appVersion: string;
  calendarRefresh: Temporal.Duration;
  activitiesPoll: Temporal.Duration;
  movieRefresh: Temporal.Duration;
  retryBase: Temporal.Duration;

  sheetId: string | undefined;
  sheetName: string;
  /**
   * The films tab. A second name rather than a list, because the two tabs have
   * different shapes and different rules — nothing iterates them.
   */
  moviesSheetName: string;
  sheetSyncMode: SheetSyncMode;
  sheetSinceDays: number;
  sheetMaxEdits: number;
  sheetMaxRows: number;
  /** Base64 of the whole service-account JSON. The container path. */
  googleKeyBase64: string | undefined;
  googleCredentialsPath: string;
  /**
   * Whether GOOGLE_APPLICATION_CREDENTIALS was set rather than defaulted.
   * `googleCredentialsPath` always has a value, so truthiness would say "a
   * credential was supplied" on every machine.
   */
  googleCredentialsExplicit: boolean;

  /** TVDB v4, for per-episode runtimes. Absent, no runtime is ever looked up. */
  tvdbApiKey: string | undefined;
  /** Only a user-supported key needs one; a licensed key logs in without it. */
  tvdbPin: string | undefined;

  /**
   * TMDB v4 read-access token, for a film's genres, certificate, backdrop,
   * dates and director. Absent, the films tab is never read: eight of its
   * fourteen columns come from here, and a row inserted with those blank is
   * worse than no row.
   */
  tmdbApiKey: string | undefined;

  /**
   * The Cloud Storage buckets the artwork page uploads into — one per tab,
   * because the site reads them as two separate prefixes and an object's key
   * is the title alone. Absent either, the page is inert.
   */
  artworkMovieBucket: string | undefined;
  artworkShowBucket: string | undefined;
  /**
   * Whether an upload asks for `allUsers` read on the object. Needed on a
   * bucket with legacy ACLs, where a new object is otherwise private; a 400
   * on one with uniform bucket-level access, where the bucket's own policy
   * already makes every object public. Off by default: a bucket created in
   * the console has uniform access, and the wrong setting there fails loudly
   * where the other direction fails silently.
   */
  artworkPublicAcl: boolean;
}

/**
 * Build the config from an environment. Separate from the singleton so
 * parsing and clamping are testable without a fresh process.
 */
export const buildConfig = (env: NodeJS.ProcessEnv): Config => ({
  clientId: env.SIMKL_CLIENT_ID,
  feedToken: env.FEED_TOKEN,
  timezone: env.TZ || 'Europe/London',
  dataDir: resolve(env.DATA_DIR || './data'),
  // Which country's cinema dates to use. Release dates vary by territory —
  // Dune: Part Three opens 18 Dec in GB and the US but 16 Dec in BE.
  releaseCountry: env.RELEASE_COUNTRY || 'GB',
  // min 0: PORT=0 is the standard "bind an ephemeral port" idiom.
  port: int(env.PORT, 3000, { min: 0, max: 65535 }),
  // How long a recently-aired episode lingers. Not filtered by watch state:
  // the calendar records what aired. Capped at 90 — each extra month in the
  // window is another multi-MB archive per refresh.
  graceDays: int(env.GRACE_DAYS, 14, { min: 0, max: 90 }),

  appName: 'simkl-ical',
  // Read rather than repeated: SIMKL is told this in every request.
  appVersion: packageVersion(),

  // Matched to the CDN, which regenerates every 6h: asking more often mostly
  // buys 304s, asking less misses regenerations. `/healthz` keys its
  // staleness alarms off this, so raising it hides a wedged render longer.
  calendarRefresh: ms(env.CALENDAR_REFRESH_MS, 6 * 60 * 60 * 1000, { min: 60_000 }),
  // One tiny request gating the library pull — on a quiet poll the only
  // request at all. Half an hour: movement costs one small delta, not the
  // whole library, so frequent polling is cheap and the feed tracks watches
  // closely. `/healthz` alarms at three intervals of this.
  activitiesPoll: ms(env.ACTIVITIES_POLL_MS, 30 * 60 * 1000, { min: 60_000 }),
  // The floor on how often one film's release date is re-read. A studio
  // moving a release changes nothing in the library, so nothing else would
  // trigger the re-read; the poll runs far more often than dates change, so
  // this bounds it per film. Which films are due is `filmDue` in
  // feed/1-films.ts.
  movieRefresh: ms(env.MOVIE_REFRESH_MS, 24 * 60 * 60 * 1000, { min: 60_000 }),
  // First step of the retry backoff, doubling each attempt: 1s, 2s, 4s, 8s.
  // Configurable mainly for tests; lowering it in production only makes a
  // struggling API struggle harder.
  retryBase: ms(env.RETRY_BASE_MS, 1000, { min: 1 }),

  // --- Google Sheet sync. Absent SHEET_ID, the whole feature is inert.
  sheetId: env.SHEET_ID,
  sheetName: env.SHEET_NAME || 'Sheet1',
  moviesSheetName: env.MOVIES_SHEET_NAME || 'Movies',
  sheetSyncMode: oneOf(env.SHEET_SYNC_MODE, SHEET_SYNC_MODES, 'report'),
  // Nothing is touched without watch activity this recent — the rule that
  // stops a run retro-editing years of history, so it gates everything.
  sheetSinceDays: int(env.SHEET_SINCE_DAYS, 90, { min: 1, max: 3650 }),
  // Circuit breakers, set below the theoretical ceiling: a run wanting this
  // many cells is likelier a bug than a binge, and refusing the whole plan is
  // the safe answer.
  sheetMaxEdits: int(env.SHEET_MAX_EDITS, 30, { min: 1 }),
  sheetMaxRows: int(env.SHEET_MAX_ROWS, 20, { min: 1 }),
  googleKeyBase64: env.GOOGLE_SA_KEY_B64,
  googleCredentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS ? expandHome(env.GOOGLE_APPLICATION_CREDENTIALS) : resolve(homedir(), '.config/plot-device/sa.json'),
  googleCredentialsExplicit: Boolean(env.GOOGLE_APPLICATION_CREDENTIALS),

  // --- Per-episode runtimes. Absent TVDB_API_KEY, a closing season still gets
  // its End date and count, and the Episodes cell is left alone. Additive, so
  // nothing to clamp and no default to pick.
  tvdbApiKey: env.TVDB_API_KEY,
  tvdbPin: env.TVDB_PIN,

  // --- Film metadata. Absent TMDB_API_KEY, the films tab is left entirely
  // alone; the show grid is unaffected.
  tmdbApiKey: env.TMDB_API_KEY,

  // --- Artwork. Absent either bucket, the page is not served at all.
  artworkMovieBucket: env.ARTWORK_MOVIE_BUCKET || undefined,
  artworkShowBucket: env.ARTWORK_SHOW_BUCKET || undefined,
  artworkPublicAcl: flag(env.ARTWORK_PUBLIC_ACL),
});

/**
 * Fail loudly at boot when the runtime has no Temporal.
 *
 * Every date here is a Temporal value, so a runtime without it throws
 * `ReferenceError` from wherever the first date is touched — on a warm start,
 * inside a render, reading as a corrupt feed rather than a wrong runtime.
 *
 * The version number does not answer the question: Temporal is enabled at
 * *build* time, not by a runtime flag. Homebrew's `node` 26 reports
 * `v8_enable_temporal_support: 0` and has no `Temporal`; the nodejs.org
 * binaries of the same version, and `node:26-alpine`, report 1 and do.
 *
 * The global is a parameter so a test can pass a runtime that lacks it.
 */
export const requireTemporal = (globals: { Temporal?: unknown } = globalThis): void => {
  if (typeof globals.Temporal !== 'undefined') return;
  throw new Error(
    'This runtime has no Temporal. It is a build-time option, not a flag, so the version alone ' +
      'does not settle it — check with `node -p "typeof Temporal"`, which must print `object`. ' +
      'Homebrew\'s node is built without it; use nodejs.org, fnm or nvm.',
  );
};

/**
 * Before the first `Temporal` value this process constructs — `buildConfig`,
 * on the line below.
 *
 * It cannot sit in `index.ts`: `import` is hoisted, so this module fully
 * evaluates before any statement there runs, and a runtime without Temporal
 * would die with a bare `ReferenceError` instead of the message saying what
 * to install. Every entry point — server, login CLI, tests — reaches config,
 * so guarding here covers them all.
 */
requireTemporal();

export const config: Config = buildConfig(process.env);

/**
 * Fail loudly at boot on an unusable timezone. Otherwise a bad TZ surfaces as a
 * bare RangeError from deep inside the join, on the first render.
 */
export const requireValidTimezone = (timeZone: string = config.timezone): string => {
  try {
    Temporal.Now.zonedDateTimeISO(timeZone);
  } catch {
    throw new Error(`TZ is not a valid IANA timezone: ${timeZone}. Try e.g. Europe/London or America/New_York.`);
  }
  return timeZone;
};

/**
 * Whether the sheet sync should exist at all: a target *and* a credential
 * actually supplied. The credentials path alone is vacuous — it has a default
 * — so SHEET_ID with no key would activate against a nonexistent file and
 * file an ENOENT every poll.
 */
export const sheetSyncConfigured = (c: Config = config): boolean =>
  Boolean(c.sheetId) && c.sheetSyncMode !== 'off' && Boolean(c.googleKeyBase64 || c.googleCredentialsExplicit);

/**
 * Whether per-episode runtimes can be looked up at all. A single test, unlike
 * `sheetSyncConfigured`: the credential has no target to pair with. The pin
 * is excluded — a licensed key logs in without one, and TVDB accepts a wrong
 * pin rather than rejecting it, so requiring one would disable a working key.
 */
export const tvdbConfigured = (c: Config = config): boolean => Boolean(c.tvdbApiKey);

/**
 * Whether the films tab can be synced: the sheet sync itself, plus a TMDB
 * token — the one switch, since eight of that tab's fourteen columns come from
 * TMDB and a row inserted with them blank is worse than no row.
 *
 * `moviesSheetName` is not tested: it always has a value, so the test would say
 * "a tab was named" on every machine, the way `googleCredentialsPath` would.
 */
export const moviesSyncConfigured = (c: Config = config): boolean => sheetSyncConfigured(c) && Boolean(c.tmdbApiKey);

/**
 * Whether the artwork page can be served: both tabs syncable (it reads and
 * writes both), TVDB for show posters, and a bucket for each tab. All-or-
 * nothing rather than per-kind, because a page listing shows it cannot act on
 * would read as broken rather than as half-configured.
 */
export const artworkConfigured = (c: Config = config): boolean =>
  moviesSyncConfigured(c) && tvdbConfigured(c) && Boolean(c.artworkMovieBucket) && Boolean(c.artworkShowBucket);

export const requireClientId = (): string => {
  if (!config.clientId) {
    throw new Error('SIMKL_CLIENT_ID is not set. Copy .env.example to .env and fill it in.');
  }
  return config.clientId;
};
