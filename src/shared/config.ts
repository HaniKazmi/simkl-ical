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
 * The same, as a duration.
 *
 * The environment still speaks milliseconds — `ACTIVITIES_POLL_MS=1800000` is
 * documented in the README and `.env.example`, and an ISO-8601 duration there
 * would be a breaking change for no gain. Only the field this produces is a
 * `Duration`, so the unit stops living in the field's name.
 *
 * Built from milliseconds alone, which keeps it inside the rule every duration
 * here obeys: no years, months or weeks, so `compare`, `total` and `round` need
 * no `relativeTo` anchor.
 */
const ms = (value: string | undefined, fallback: number, range: { min?: number; max?: number } = {}): Temporal.Duration =>
  Temporal.Duration.from({ milliseconds: int(value, fallback, range) });

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
  calendarRefresh: Temporal.Duration;
  activitiesPoll: Temporal.Duration;
  movieRefresh: Temporal.Duration;
  retryBase: Temporal.Duration;

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
  calendarRefresh: ms(env.CALENDAR_REFRESH_MS, 6 * 60 * 60 * 1000, { min: 60_000 }),
  // One tiny request that gates the library pull, and on a quiet poll the only
  // request made at all. Half an hour: a poll where something moved costs one
  // small delta rather than the whole library, so polling often is cheaper here
  // than polling rarely was, and the feed tracks what you watch far more
  // closely. `/healthz` keys its staleness alarm off this at three intervals.
  activitiesPoll: ms(env.ACTIVITIES_POLL_MS, 30 * 60 * 1000, { min: 60_000 }),
  // The floor on how often any one film's release date is re-read. A studio
  // moving a release changes nothing in your library, so nothing else would ever
  // trigger the re-read; but the poll runs far more often than dates change, so
  // this bounds it per film. Which films are due past that floor is a separate
  // question, and the rule that answers it is `filmDue` in feed/io/movies.ts.
  movieRefresh: ms(env.MOVIE_REFRESH_MS, 24 * 60 * 60 * 1000, { min: 60_000 }),
  // First step of the API retry backoff, doubling each attempt: 1s, 2s, 4s, 8s.
  // Configurable mainly for tests; lowering it in production only makes a
  // struggling API struggle harder.
  retryBase: ms(env.RETRY_BASE_MS, 1000, { min: 1 }),

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
    Temporal.Now.zonedDateTimeISO(timeZone);
  } catch {
    throw new Error(`TZ is not a valid IANA timezone: ${timeZone}. Try e.g. Europe/London or America/New_York.`);
  }
  return timeZone;
};

/**
 * Fail loudly at boot when the runtime has no Temporal.
 *
 * Every date and duration in this codebase is a Temporal value, so a runtime
 * without it does not degrade — it throws `ReferenceError` from wherever the
 * first date is touched, which on a warm start is inside a render and reads as
 * a corrupt feed rather than a wrong runtime.
 *
 * Worth its own check because the version number does not answer the question.
 * Temporal is enabled at *build* time, not by a runtime flag: `--harmony-temporal`
 * already defaults on in V8 and is not the gate. Homebrew's `node` 26 reports
 * `v8_enable_temporal_support: 0` and has no `Temporal`; the nodejs.org binaries
 * of the same version, and `node:26-alpine`, report 1 and do.
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
