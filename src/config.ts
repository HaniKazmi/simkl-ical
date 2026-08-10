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

const int = (value: string | undefined, fallback: number): number => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
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
}

export const config: Config = {
  clientId: process.env.SIMKL_CLIENT_ID,
  feedToken: process.env.FEED_TOKEN,
  timezone: process.env.TZ || 'Europe/London',
  dataDir: resolve(process.env.DATA_DIR || './data'),
  // Which country's cinema dates to use for film releases. Release dates vary by
  // territory — Dune: Part Three opens 18 Dec in GB and the US but 16 Dec in BE.
  releaseCountry: process.env.RELEASE_COUNTRY || 'GB',
  port: int(process.env.PORT, 3000),
  // How long a recently-aired episode lingers in the feed. Deliberately not
  // filtered by watch state: the calendar is a record of what aired, so nothing
  // should vanish the moment it airs.
  graceDays: int(process.env.GRACE_DAYS, 14),

  appName: 'simkl-ical',
  appVersion: '0.1.0',

  // The CDN files regenerate every 6h; polling at 3h with a conditional GET
  // costs a 304 most of the time and halves worst-case staleness.
  calendarRefreshMs: int(process.env.CALENDAR_REFRESH_MS, 3 * 60 * 60 * 1000),
  // One tiny request that gates the five expensive library calls. Two hours:
  // list membership changes rarely, and a slightly stale feed is invisible next
  // to a calendar client that polls on its own schedule anyway.
  activitiesPollMs: int(process.env.ACTIVITIES_POLL_MS, 2 * 60 * 60 * 1000),
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
