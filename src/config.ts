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
 * Unclamped, every one of these had a way to break the service quietly:
 * GRACE_DAYS=-1 puts the cutoff in the future and empties the feed,
 * GRACE_DAYS=400 pulls fourteen multi-MB archives sequentially every refresh,
 * and CALENDAR_REFRESH_MS=0 turns setInterval into a tight loop against the
 * CDN. Out-of-range values are corrected rather than fatal, because a running
 * feed with a sane default beats a container that will not boot.
 */
const int = (value: string | undefined, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number => {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

/**
 * The version from package.json, which the Dockerfile copies into the image
 * alongside src/ — it is needed at runtime for "type": "module" regardless.
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
}

export const config: Config = {
  clientId: process.env.SIMKL_CLIENT_ID,
  feedToken: process.env.FEED_TOKEN,
  timezone: process.env.TZ || 'Europe/London',
  dataDir: resolve(process.env.DATA_DIR || './data'),
  // Which country's cinema dates to use for film releases. Release dates vary by
  // territory — Dune: Part Three opens 18 Dec in GB and the US but 16 Dec in BE.
  releaseCountry: process.env.RELEASE_COUNTRY || 'GB',
  port: int(process.env.PORT, 3000, { min: 1, max: 65535 }),
  // How long a recently-aired episode lingers in the feed. Deliberately not
  // filtered by watch state: the calendar is a record of what aired, so nothing
  // should vanish the moment it airs.
  // Capped at 90: each extra month in the window is another multi-MB archive
  // fetched sequentially on every refresh.
  graceDays: int(process.env.GRACE_DAYS, 14, { min: 0, max: 90 }),

  appName: 'simkl-ical',
  // Read, not repeated. This was hardcoded '0.1.0' while the repo was tagged
  // v0.2.0, so SIMKL was told the wrong version in every app-version parameter
  // and User-Agent — two sources of truth for one number.
  appVersion: packageVersion(),

  // The CDN files regenerate every 6h; polling at 3h with a conditional GET
  // costs a 304 most of the time and halves worst-case staleness.
  calendarRefreshMs: int(process.env.CALENDAR_REFRESH_MS, 3 * 60 * 60 * 1000, { min: 60_000 }),
  // One tiny request that gates the five expensive library calls. Two hours:
  // list membership changes rarely, and a slightly stale feed is invisible next
  // to a calendar client that polls on its own schedule anyway.
  activitiesPollMs: int(process.env.ACTIVITIES_POLL_MS, 2 * 60 * 60 * 1000, { min: 60_000 }),
  // How often to re-read film release dates regardless of library activity. A
  // studio moving a release changes nothing in your library, so nothing else
  // would ever trigger the re-read. Daily, because the lookups are CDN-cached
  // by id and a plan-to-watch film list is short.
  movieRefreshMs: int(process.env.MOVIE_REFRESH_MS, 24 * 60 * 60 * 1000, { min: 60_000 }),
};

/**
 * Fail loudly at boot on an unusable timezone.
 *
 * Without this a bad TZ only surfaces once a library snapshot exists, so a
 * fresh install starts fine and then crash-loops on its next restart with a
 * bare RangeError from deep inside the join.
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
