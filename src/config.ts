import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Node 20.6+ loads .env with --env-file, but doing it here keeps `node src/x.ts`
// working without callers remembering the flag.
if (!process.env.SIMKL_CLIENT_ID) {
  try {
    process.loadEnvFile(resolve(import.meta.dirname, '../.env'));
  } catch {
    // No .env — rely on real environment variables (the container case).
  }
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
 * The version from package.json, which the Dockerfile copies into the image
 * alongside src/ — it is needed at runtime for "type": "module" anyway.
 */
const packageVersion = (): string => {
  try {
    const raw = readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
};

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

  // The CDN files regenerate every 6h; polling at 3h with a conditional GET
  // costs a 304 most of the time and halves worst-case staleness.
  calendarRefreshMs: int(env.CALENDAR_REFRESH_MS, 3 * 60 * 60 * 1000, { min: 60_000 }),
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

export const requireClientId = (): string => {
  if (!config.clientId) {
    throw new Error('SIMKL_CLIENT_ID is not set. Copy .env.example to .env and fill it in.');
  }
  return config.clientId;
};
