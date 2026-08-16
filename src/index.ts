import { config, requireClientId, requireValidTimezone } from './shared/config.ts';
import { errorMessage, errorStack } from './shared/errors.ts';
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

// Listen before hydrating. The first fetch pulls several MB of calendar JSON,
// and refusing connections for the whole of it makes the container look dead to
// a healthcheck; answering 503 with a reason does not.
await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(`listening on :${config.port} in ${config.timezone}, warming up`);

// What this process answers, early in the log, complete enough to paste
// straight into a calendar client.
//
// The token is printed in full, which is why `buildServer` still redacts
// `req.url`: the difference that matters is one line at boot against a line per
// request for the life of the process, and only the second turns a log tail or
// a shipped log volume into a rolling disclosure.
for (const [name, path] of [
  ['feed  ', `/${config.feedToken}/feed.ics`],
  ['status', `/${config.feedToken}/status`],
  ['health', '/healthz'],
] as const) {
  app.log.info(`  ${name}  http://localhost:${config.port}${path}`);
}

void (async () => {
  try {
    await service.hydrate();
    await service.refreshLibraryIfChanged();
    app.log.info(`ready: serving ${service.feed.events.length} events`);
  } catch (err) {
    // Never fatal: the server keeps answering /healthz so the failure is
    // visible. Filed as a render failure because that is the slot `ok` keys on,
    // and the next successful render clears it.
    service.feed.errors.render = `startup: ${errorMessage(err)}`;
    app.log.error(`warm-up failed: ${errorStack(err)}`);
  } finally {
    // In `finally` on purpose: a failed warm-up must still leave something
    // scheduled to retry, rather than serving a boot-time snapshot forever.
    service.start();
  }
})();

// Guarded, so a second signal does not start a second concurrent close, and in
// a finally, so a close rejection still exits cleanly.
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
