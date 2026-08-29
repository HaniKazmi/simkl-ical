import { config, requireClientId, requireValidTimezone } from './shared/config.ts';
import { errorMessage } from './shared/errors.ts';
import { Orchestrator } from './orchestrator.ts';
import { buildServer } from './server.ts';

try {
  requireClientId();
  requireValidTimezone();
} catch (err) {
  console.error(errorMessage(err));
  process.exit(1);
}

if (!config.feedToken) {
  console.error('FEED_TOKEN is not set. Generate one with: openssl rand -hex 24');
  process.exit(1);
}

const service = new Orchestrator({ logger: console });
const app = buildServer(service);

// Listen before hydrating: the first fetch pulls several MB of calendar JSON,
// and refusing connections that long makes the container look dead to a
// healthcheck; answering 503 with a reason does not.
await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(`listening on :${config.port} in ${config.timezone}, warming up`);

// The URLs this process answers, early in the log, complete enough to paste
// straight into a calendar client — which is why the token is printed in
// full. `buildServer` still redacts `req.url` so the same string does not
// repeat once per request.
for (const [name, path] of [
  ['feed  ', `/${config.feedToken}/feed.ics`],
  ['status', `/${config.feedToken}/status`],
  ['health', '/healthz'],
] as const) {
  app.log.info(`  ${name}  http://localhost:${config.port}${path}`);
}

// Fire-and-forget: warm-up never throws, files its own failure, and always
// leaves the timers running.
void service.warmUp();

// Guarded so a second signal does not start a second close; exit in finally
// so a close rejection still exits cleanly.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} received, shutting down`);
    try {
      service.stop();
      await app.close();
    } catch (err) {
      app.log.error(`error during shutdown: ${errorMessage(err)}`);
    } finally {
      process.exit(0);
    }
  });
}
