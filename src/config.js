import { resolve } from 'node:path';

// Node 20.6+ loads .env with --env-file, but doing it here keeps `node src/x.js`
// working without callers remembering the flag.
if (!process.env.SIMKL_CLIENT_ID) {
  try {
    process.loadEnvFile(resolve(import.meta.dirname, '../.env'));
  } catch {
    // No .env — rely on real environment variables (the container case).
  }
}

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  clientId: process.env.SIMKL_CLIENT_ID,
  feedToken: process.env.FEED_TOKEN,
  timezone: process.env.TZ || 'Europe/London',
  dataDir: resolve(process.env.DATA_DIR || './data'),
  port: int(process.env.PORT, 3000),
  horizonDays: int(process.env.HORIZON_DAYS, 33),

  appName: 'simkl-ical',
  appVersion: '0.1.0',

  // The CDN files regenerate every 6h; polling at 3h with a conditional GET
  // costs a 304 most of the time and halves worst-case staleness.
  calendarRefreshMs: int(process.env.CALENDAR_REFRESH_MS, 3 * 60 * 60 * 1000),
  // One tiny request that gates the five expensive library calls.
  activitiesPollMs: int(process.env.ACTIVITIES_POLL_MS, 15 * 60 * 1000),
};

export function requireClientId() {
  if (!config.clientId) {
    throw new Error('SIMKL_CLIENT_ID is not set. Copy .env.example to .env and fill it in.');
  }
  return config.clientId;
}
