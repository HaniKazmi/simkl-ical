import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// Node 20.6+ loads .env with --env-file, but doing it here keeps `node src/x.ts`
// working without callers remembering the flag.
//
// Unconditional, because `loadEnvFile` leaves anything already in the
// environment alone: there is nothing for a guard to protect, and any guard on
// a single variable skips the whole file — FEED_TOKEN, SHEET_ID, TZ — for an
// environment that happens to set that one.
try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../.env'));
} catch {
  // No .env — rely on real environment variables (the container case).
}

/**
 * An integer from the environment, clamped to a range it makes sense in.
 *
 * Unclamped these break the service quietly — a negative GRACE_DAYS empties the
 * feed, a zero interval is a tight loop against the CDN. Out-of-range values
 * are corrected rather than fatal: a running feed beats a container that will
 * not boot.
 */
const int = (value: string | undefined, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number => {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

/**
 * A value from a closed set, falling back rather than throwing — same posture
 * as `int`, and for the same reason. No enum: Node strips the types, so an enum
 * is not erasable syntax.
 */
const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T => {
  const candidate = value?.trim().toLowerCase();
  return allowed.find((a) => a === candidate) ?? fallback;
};

/**
 * `~/x` → `$HOME/x`. A shell expands this before the process ever sees it, but
 * a value read from `.env` or a compose file arrives verbatim — and
 * `.env.example` suggests a `~/` path for the credential, which would otherwise
 * be an ENOENT once per sheet run.
 */
const expandHome = (path: string): string => (path === '~' || path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path);

/**
 * The version from package.json, which the Dockerfile copies into the image
 * alongside src/ — it is needed at runtime for "type": "module" anyway.
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
 * `report` plans and logs without writing; `apply` writes. Unrecognised clamps
 * to `report` — never to `apply`, because the failure of a typo must be an
 * inert run, not an unintended one.
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
  calendarRefreshMs: number;
  activitiesPollMs: number;
  movieRefreshMs: number;
  retryBaseMs: number;

  sheetId: string | undefined;
  sheetName: string;
  sheetSyncMode: SheetSyncMode;
  sheetSinceDays: number;
  sheetMaxEdits: number;
  sheetMaxRows: number;
  /** Base64 of the whole service-account JSON. The container path. */
  googleKeyBase64: string | undefined;
  googleCredentialsPath: string;
  /**
   * Whether GOOGLE_APPLICATION_CREDENTIALS was actually set, as opposed to
   * defaulted. `googleCredentialsPath` always has a value, so testing it for
   * truthiness would say "a credential was supplied" on every machine.
   */
  googleCredentialsExplicit: boolean;
}

/**
 * Build the config from an environment. Separate from the singleton below so
 * the parsing and clamping can be tested without a fresh process.
 */
export const buildConfig = (env: NodeJS.ProcessEnv): Config => ({
  clientId: env.SIMKL_CLIENT_ID,
  feedToken: env.FEED_TOKEN,
  timezone: env.TZ || 'Europe/London',
  dataDir: resolve(env.DATA_DIR || './data'),
  // Which country's cinema dates to use for film releases. Release dates vary by
  // territory — Dune: Part Three opens 18 Dec in GB and the US but 16 Dec in BE.
  releaseCountry: env.RELEASE_COUNTRY || 'GB',
  // min 0: PORT=0 is the standard "bind an ephemeral port" idiom.
  port: int(env.PORT, 3000, { min: 0, max: 65535 }),
  // How long a recently-aired episode lingers. Deliberately not filtered by
  // watch state: the calendar records what aired. Capped at 90 because each
  // extra month in the window is another multi-MB archive per refresh.
  graceDays: int(env.GRACE_DAYS, 14, { min: 0, max: 90 }),

  appName: 'simkl-ical',
  // Read rather than repeated: SIMKL is told this in every request.
  appVersion: packageVersion(),

  // Matched to the CDN, which regenerates every 6h: asking more often mostly
  // buys 304s and a re-merge of several MB, and asking less often means seeing
  // only some regenerations. `/healthz` keys its staleness alarms off this, so
  // raising it also raises how long a wedged render stays invisible.
  calendarRefreshMs: int(env.CALENDAR_REFRESH_MS, 6 * 60 * 60 * 1000, { min: 60_000 }),
  // One tiny request that gates the five expensive library calls. Two hours:
  // list membership changes rarely, and a slightly stale feed is invisible next
  // to a calendar client that polls on its own schedule anyway.
  activitiesPollMs: int(env.ACTIVITIES_POLL_MS, 2 * 60 * 60 * 1000, { min: 60_000 }),
  // How often to re-read film release dates regardless of library activity. A
  // studio moving a release changes nothing in your library, so nothing else
  // would ever trigger the re-read. Daily, because the lookups are CDN-cached
  // by id and a plan-to-watch film list is short.
  movieRefreshMs: int(env.MOVIE_REFRESH_MS, 24 * 60 * 60 * 1000, { min: 60_000 }),
  // First step of the API retry backoff, doubling each attempt: 1s, 2s, 4s, 8s.
  // Configurable mainly for tests; lowering it in production only makes a
  // struggling API struggle harder.
  retryBaseMs: int(env.RETRY_BASE_MS, 1000, { min: 1 }),

  // --- Google Sheet sync. Absent SHEET_ID, the whole feature is inert.
  sheetId: env.SHEET_ID,
  sheetName: env.SHEET_NAME || 'Sheet1',
  sheetSyncMode: oneOf(env.SHEET_SYNC_MODE, SHEET_SYNC_MODES, 'report'),
  // Nothing is touched without watch activity this recent. The rule is what
  // stops a run retro-editing years of history, so it gates everything.
  sheetSinceDays: int(env.SHEET_SINCE_DAYS, 90, { min: 1, max: 3650 }),
  // Circuit breakers. Set below the theoretical ceiling on purpose: a run
  // wanting this many cells is likelier a bug than a legitimate binge, and
  // refusing the whole plan is the safe answer.
  sheetMaxEdits: int(env.SHEET_MAX_EDITS, 30, { min: 1 }),
  sheetMaxRows: int(env.SHEET_MAX_ROWS, 20, { min: 1 }),
  googleKeyBase64: env.GOOGLE_SA_KEY_B64,
  googleCredentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS ? expandHome(env.GOOGLE_APPLICATION_CREDENTIALS) : resolve(homedir(), '.config/plot-device/sa.json'),
  googleCredentialsExplicit: Boolean(env.GOOGLE_APPLICATION_CREDENTIALS),
});

export const config: Config = buildConfig(process.env);

/**
 * Fail loudly at boot on an unusable timezone. Otherwise a bad TZ surfaces as a
 * bare RangeError from deep inside the join, on the first render.
 */
export const requireValidTimezone = (timeZone: string = config.timezone): string => {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  } catch {
    throw new Error(`TZ is not a valid IANA timezone: ${timeZone}. Try e.g. Europe/London or America/New_York.`);
  }
  return timeZone;
};

/**
 * Whether the sheet sync should exist at all: a target *and* a credential that
 * was actually supplied.
 *
 * Testing the credentials path alone is vacuous — it has a default — so a
 * container given SHEET_ID and no key would activate against a nonexistent file
 * and file an ENOENT on every poll.
 */
export const sheetSyncConfigured = (c: Config = config): boolean =>
  Boolean(c.sheetId) && c.sheetSyncMode !== 'off' && Boolean(c.googleKeyBase64 || c.googleCredentialsExplicit);

export const requireClientId = (): string => {
  if (!config.clientId) {
    throw new Error('SIMKL_CLIENT_ID is not set. Copy .env.example to .env and fill it in.');
  }
  return config.clientId;
};
